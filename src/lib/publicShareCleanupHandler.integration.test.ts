import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cleanupHandler, {
  type CleanupHttpRequest,
  type CleanupHttpResponse
} from "../../api/cleanup-public-shares.js";
import {
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  vaultInventoryManifestContract,
  vaultInventoryManifestMarkerPath,
  vaultInventoryManifestShardIndexFromEntryKey,
  vaultInventoryManifestShardPath
} from "../../shared/vault-inventory-manifest.js";

type FirestoreValue = {
  arrayValue?: { values?: FirestoreValue[] };
  booleanValue?: boolean;
  integerValue?: number | string;
  mapValue?: { fields?: Record<string, FirestoreValue> };
  nullValue?: null;
  stringValue?: string;
  timestampValue?: string;
};

interface FirestoreDocument {
  fields: Record<string, FirestoreValue>;
  name: string;
  updateTime: string;
}

interface CronResponse {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

const testProjectId = "quickmemo-cleanup-handler-test";
const documentRoot = `projects/${testProjectId}/databases/(default)/documents`;
const cronSecret = "cleanup-handler-integration-secret";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const cleanupEnvironmentKeys = [
  "CRON_SECRET",
  "FIREBASE_CLEANUP_CLIENT_EMAIL",
  "FIREBASE_CLEANUP_PRIVATE_KEY",
  "FIREBASE_CLEANUP_PROJECT_ID",
  "FIREBASE_STORAGE_BUCKET",
  "LEGACY_FIREBASE_STORAGE_ENABLED",
  "LEGACY_NOTE_BACKFILL_MAX_SCANNED",
  "LEGACY_NOTE_BACKFILL_PAGE_SIZE",
  "PUBLIC_SHARE_CLEANUP_BATCH_SIZE",
  "PUBLIC_SHARE_CLEANUP_MAX_DELETES",
  "PUBLIC_SHARE_CLEANUP_MAX_RUNTIME_SECONDS"
] as const;
const originalEnvironment = new Map(
  cleanupEnvironmentKeys.map((key) => [key, process.env[key]])
);

function stringValue(value: string): FirestoreValue {
  return { stringValue: value };
}

function integerValue(value: number): FirestoreValue {
  return { integerValue: String(value) };
}

function booleanValue(value: boolean): FirestoreValue {
  return { booleanValue: value };
}

function timestampValue(value: string): FirestoreValue {
  return { timestampValue: value };
}

function stringArrayValue(values: string[]): FirestoreValue {
  return {
    arrayValue: {
      values: values.map((value) => stringValue(value))
    }
  };
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function fieldPrimitive(value: FirestoreValue | undefined, documentName: string) {
  if (!value) {
    return undefined;
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue;
  }
  if (typeof value.timestampValue === "string") {
    return value.timestampValue;
  }
  if (typeof value.booleanValue === "boolean") {
    return value.booleanValue;
  }
  if (value.integerValue !== undefined) {
    return Number(value.integerValue);
  }
  return documentName;
}

function filterMatches(
  document: FirestoreDocument,
  filter: Record<string, unknown> | undefined
): boolean {
  if (!filter) {
    return true;
  }

  const compositeFilter = filter.compositeFilter as {
    filters?: Array<Record<string, unknown>>;
  } | undefined;

  if (compositeFilter) {
    return (compositeFilter.filters ?? []).every((child) =>
      filterMatches(document, child)
    );
  }

  const fieldFilter = filter.fieldFilter as {
    field?: { fieldPath?: string };
    op?: string;
    value?: FirestoreValue;
  } | undefined;

  if (!fieldFilter) {
    return true;
  }

  const fieldPath = fieldFilter.field?.fieldPath ?? "";
  const actual = fieldPath === "__name__"
    ? document.name
    : fieldPrimitive(document.fields[fieldPath], document.name);
  const expected = fieldPrimitive(fieldFilter.value, document.name);

  if (fieldFilter.op === "EQUAL") {
    return actual === expected;
  }
  if (fieldFilter.op === "LESS_THAN_OR_EQUAL") {
    return typeof actual === typeof expected
      && actual !== undefined
      && expected !== undefined
      && actual <= expected;
  }

  throw new Error(`Unsupported fake Firestore operator: ${fieldFilter.op}`);
}

function collectionMatches(
  documentName: string,
  collectionId: string,
  allDescendants: boolean
) {
  const relativeName = documentName.slice(`${documentRoot}/`.length);
  const segments = relativeName.split("/");

  if (allDescendants) {
    return segments.length >= 2 && segments.at(-2) === collectionId;
  }

  return segments.length === 2 && segments[0] === collectionId;
}

class FakeFirestoreRest {
  readonly documents = new Map<string, FirestoreDocument>();
  requests = 0;
  beforeNextRunQuery: (() => Promise<void>) | null = null;
  failCommitContainingOnce = "";
  raceAbortDocumentOnce = "";
  raceCleanupClaimHeartbeatDocumentOnce = "";
  raceEmailQuotaDocumentOnce = "";
  raceEmailTreeDeliveryOnce = "";
  raceManifestBootstrapMarkerOnce = "";
  raceCleanupClaimReadyUploadOnce: {
    attachmentName: string;
    noteName: string;
  } | null = null;
  private updateSequence = 0;

  add(relativePath: string, fields: Record<string, FirestoreValue>) {
    const name = `${documentRoot}/${relativePath}`;
    this.documents.set(name, {
      fields: deepClone(fields),
      name,
      updateTime: this.nextUpdateTime()
    });
    return name;
  }

  get(relativePath: string) {
    return this.documents.get(`${documentRoot}/${relativePath}`);
  }

  has(relativePath: string) {
    return this.documents.has(`${documentRoot}/${relativePath}`);
  }

  pathsStartingWith(relativePrefix: string) {
    const prefix = `${documentRoot}/${relativePrefix}`;
    return [...this.documents.keys()].filter((name) => name.startsWith(prefix));
  }

  async fetch(input: string | URL | Request, init?: RequestInit) {
    this.requests += 1;
    const url = new URL(String(input));

    if (url.origin !== "https://firestore.googleapis.com") {
      throw new Error(`Unexpected network target: ${url.origin}`);
    }

    const resource = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ""));

    if (resource.endsWith("/documents:runQuery")) {
      return this.runQuery(init);
    }
    if (resource.endsWith("/documents:commit")) {
      return this.commit(init);
    }
    if (url.searchParams.has("pageSize")) {
      return this.listDocuments(resource, url);
    }

    const document = this.documents.get(resource);
    return document
      ? this.json(document)
      : this.json({ error: { status: "NOT_FOUND" } }, 404);
  }

  private nextUpdateTime() {
    this.updateSequence += 1;
    return new Date(Date.UTC(2026, 6, 28, 0, 0, 0, this.updateSequence)).toISOString();
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status
    });
  }

  private async requestBody(init?: RequestInit) {
    return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  }

  private async runQuery(init?: RequestInit) {
    const beforeRunQuery = this.beforeNextRunQuery;
    this.beforeNextRunQuery = null;
    await beforeRunQuery?.();

    const body = await this.requestBody(init);
    const query = body.structuredQuery as {
      from?: Array<{ allDescendants?: boolean; collectionId?: string }>;
      limit?: number;
      orderBy?: Array<{ field?: { fieldPath?: string }; direction?: string }>;
      where?: Record<string, unknown>;
    };
    const collection = query.from?.[0];
    const collectionId = collection?.collectionId ?? "";
    const allDescendants = collection?.allDescendants === true;
    const documents = [...this.documents.values()]
      .filter((document) =>
        collectionMatches(document.name, collectionId, allDescendants)
        && filterMatches(document, query.where)
      )
      .sort((left, right) => {
        for (const ordering of query.orderBy ?? []) {
          const fieldPath = ordering.field?.fieldPath ?? "";
          const leftValue = fieldPath === "__name__"
            ? left.name
            : fieldPrimitive(left.fields[fieldPath], left.name);
          const rightValue = fieldPath === "__name__"
            ? right.name
            : fieldPrimitive(right.fields[fieldPath], right.name);
          const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));

          if (comparison !== 0) {
            return ordering.direction === "DESCENDING" ? -comparison : comparison;
          }
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, Math.max(0, query.limit ?? 300));

    return this.json(documents.map((document) => ({ document })));
  }

  private listDocuments(resource: string, url: URL) {
    const prefix = `${resource}/`;
    const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? 300));
    const documents = [...this.documents.values()]
      .filter((document) => {
        if (!document.name.startsWith(prefix)) {
          return false;
        }
        return !document.name.slice(prefix.length).includes("/");
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, pageSize);

    return this.json({ documents });
  }

  private writeDocumentName(write: Record<string, unknown>) {
    const update = write.update as { name?: string } | undefined;
    return typeof write.delete === "string"
      ? write.delete
      : typeof write.verify === "string" ? write.verify : update?.name ?? "";
  }

  private validatePrecondition(write: Record<string, unknown>) {
    const name = this.writeDocumentName(write);
    const current = this.documents.get(name);
    const precondition = write.currentDocument as {
      exists?: boolean;
      updateTime?: string;
    } | undefined;

    if (precondition?.exists === false && current) {
      return false;
    }
    if (precondition?.exists === true && !current) {
      return false;
    }
    if (precondition?.updateTime && current?.updateTime !== precondition.updateTime) {
      return false;
    }
    return true;
  }

  private applyTransform(
    fields: Record<string, FirestoreValue>,
    transform: { fieldPath?: string; setToServerValue?: string }
  ) {
    if (transform.fieldPath && transform.setToServerValue === "REQUEST_TIME") {
      fields[transform.fieldPath] = timestampValue(new Date().toISOString());
    }
  }

  private async commit(init?: RequestInit) {
    const body = await this.requestBody(init);
    const writes = (body.writes ?? []) as Array<Record<string, unknown>>;
    const cleanupClaimWrite = writes.find((write) => {
      const update = write.update as {
        fields?: Record<string, FirestoreValue>;
        name?: string;
      } | undefined;
      return Boolean(update?.fields?.secureShareCopyCleanupClaimId?.stringValue);
    });
    const cleanupClaimDocumentName = this.writeDocumentName(cleanupClaimWrite ?? {});

    if (
      this.raceCleanupClaimHeartbeatDocumentOnce
      && cleanupClaimDocumentName === this.raceCleanupClaimHeartbeatDocumentOnce
    ) {
      const racingDocument = this.documents.get(
        this.raceCleanupClaimHeartbeatDocumentOnce
      );
      if (racingDocument) {
        racingDocument.fields.secureShareCopyUpdatedAt = timestampValue(
          new Date().toISOString()
        );
        racingDocument.updateTime = this.nextUpdateTime();
      }
      this.raceCleanupClaimHeartbeatDocumentOnce = "";
    }

    if (
      this.raceCleanupClaimReadyUploadOnce
      && cleanupClaimDocumentName === this.raceCleanupClaimReadyUploadOnce.noteName
    ) {
      const racingNote = this.documents.get(
        this.raceCleanupClaimReadyUploadOnce.noteName
      );
      const racingAttachment = this.documents.get(
        this.raceCleanupClaimReadyUploadOnce.attachmentName
      );
      if (racingNote && racingAttachment) {
        racingNote.fields.secureShareCopyReadyAttachmentCount = integerValue(1);
        racingNote.fields.secureShareCopyReservedAttachmentCount = integerValue(1);
        racingNote.fields.secureShareCopyUpdatedAt = timestampValue(
          new Date().toISOString()
        );
        racingNote.updateTime = this.nextUpdateTime();
        racingAttachment.fields.isReady = booleanValue(true);
        racingAttachment.updateTime = this.nextUpdateTime();
      }
      this.raceCleanupClaimReadyUploadOnce = null;
    }

    if (
      this.raceAbortDocumentOnce
      && writes.some((write) => {
        const update = write.update as {
          fields?: Record<string, FirestoreValue>;
          name?: string;
        } | undefined;
        return update?.name === this.raceAbortDocumentOnce
          && update.fields?.secureShareCopyState?.stringValue === "aborted";
      })
    ) {
      const racingDocument = this.documents.get(this.raceAbortDocumentOnce);
      if (racingDocument) {
        racingDocument.fields.secureShareCopyState = stringValue("active");
        racingDocument.updateTime = this.nextUpdateTime();
      }
      this.raceAbortDocumentOnce = "";
    }

    if (
      this.raceEmailQuotaDocumentOnce
      && writes.some((write) =>
        this.writeDocumentName(write) === this.raceEmailQuotaDocumentOnce
      )
    ) {
      const racingDocument = this.documents.get(this.raceEmailQuotaDocumentOnce);
      if (racingDocument) {
        racingDocument.updateTime = this.nextUpdateTime();
      }
      this.raceEmailQuotaDocumentOnce = "";
    }

    if (
      this.raceEmailTreeDeliveryOnce
      && writes.some((write) => write.delete === this.raceEmailTreeDeliveryOnce)
    ) {
      const racingDocument = this.documents.get(this.raceEmailTreeDeliveryOnce);
      if (racingDocument) {
        racingDocument.fields.status = stringValue("reserved");
        racingDocument.updateTime = this.nextUpdateTime();
      }
      this.raceEmailTreeDeliveryOnce = "";
    }

    if (
      this.failCommitContainingOnce
      && writes.some((write) =>
        this.writeDocumentName(write).includes(this.failCommitContainingOnce)
      )
    ) {
      this.failCommitContainingOnce = "";
      return this.json({ error: { status: "UNAVAILABLE" } }, 503);
    }

    if (
      this.raceManifestBootstrapMarkerOnce
      && writes.some((write) =>
        write.verify === this.raceManifestBootstrapMarkerOnce
        && (write.currentDocument as { exists?: boolean } | undefined)?.exists === false
      )
    ) {
      const name = this.raceManifestBootstrapMarkerOnce;
      this.documents.set(name, {
        fields: {},
        name,
        updateTime: this.nextUpdateTime()
      });
      this.raceManifestBootstrapMarkerOnce = "";
    }

    if (!writes.every((write) => this.validatePrecondition(write))) {
      return this.json({ error: { status: "ABORTED" } }, 409);
    }

    const nextDocuments = new Map(
      [...this.documents.entries()].map(([name, document]) => [name, deepClone(document)])
    );

    for (const write of writes) {
      if (typeof write.delete === "string") {
        nextDocuments.delete(write.delete);
        continue;
      }
      if (typeof write.verify === "string") {
        continue;
      }

      const update = write.update as {
        fields?: Record<string, FirestoreValue>;
        name?: string;
      } | undefined;
      const name = update?.name ?? "";
      const existing = nextDocuments.get(name);
      const fields = existing ? deepClone(existing.fields) : {};
      const fieldPaths = (
        write.updateMask as { fieldPaths?: string[] } | undefined
      )?.fieldPaths ?? [];

      Object.assign(fields, deepClone(update?.fields ?? {}));
      for (const fieldPath of fieldPaths) {
        if (!Object.hasOwn(update?.fields ?? {}, fieldPath)) {
          delete fields[fieldPath];
        }
      }
      for (const transform of (write.updateTransforms ?? []) as Array<{
        fieldPath?: string;
        setToServerValue?: string;
      }>) {
        this.applyTransform(fields, transform);
      }

      nextDocuments.set(name, {
        fields,
        name,
        updateTime: this.nextUpdateTime()
      });
    }

    this.documents.clear();
    for (const [name, document] of nextDocuments) {
      this.documents.set(name, document);
    }
    return this.json({ writeResults: writes.map(() => ({})) });
  }
}

function completedBackfillCursor(backend: FakeFirestoreRest) {
  backend.add("systemMaintenance/legacyNoteDeletionBackfillV1", {
    completed: booleanValue(true),
    lastDocumentName: stringValue(""),
    version: integerValue(1)
  });
}

function secureShareCopyNote(
  noteId: string,
  state: "active" | "copying",
  updatedAt: string,
  overrides: Partial<Record<
    | "expected"
    | "ownerUid"
    | "ready"
    | "reserved"
    | "revision",
    number | string
  >> & { participantUids?: string[] } = {}
): Record<string, FirestoreValue> {
  const ownerUid = String(overrides.ownerUid ?? "owner-a");
  const claimId = noteId.slice(0, 43).padEnd(43, "_");
  return {
    contentFormat: stringValue("legacy-html-v1"),
    entryKind: stringValue("legacy-html"),
    folderId: { nullValue: null },
    isDeleted: booleanValue(false),
    ownerUid: stringValue(ownerUid),
    participantUids: stringArrayValue(overrides.participantUids ?? [ownerUid]),
    revision: integerValue(Number(overrides.revision ?? 1)),
    secureShareCopyExpectedAttachmentCount: integerValue(Number(overrides.expected ?? 1)),
    secureShareCopyJobId: stringValue("copy_job_handler_test_1234"),
    secureShareCopyReadyAttachmentCount: integerValue(Number(overrides.ready ?? 0)),
    secureShareCopyReservedAttachmentCount: integerValue(Number(overrides.reserved ?? 0)),
    secureShareCopyState: stringValue(state),
    secureShareCopyUpdatedAt: timestampValue(updatedAt),
    type: stringValue("personal"),
    vaultNameClaimId: stringValue(claimId),
    vaultNameIndexVersion: integerValue(1)
  };
}

function addSecureShareCopyNote(
  backend: FakeFirestoreRest,
  noteId: string,
  state: "active" | "copying",
  updatedAt: string,
  overrides: Parameters<typeof secureShareCopyNote>[3] = {}
) {
  const ownerUid = String(overrides.ownerUid ?? "owner-a");
  const claimId = noteId.slice(0, 43).padEnd(43, "_");
  const noteName = backend.add(
    `notes/${noteId}`,
    secureShareCopyNote(noteId, state, updatedAt, overrides)
  );
  backend.add(`vaultIntegrity/${ownerUid}/nameClaims/${claimId}`, {
    indexVersion: integerValue(1),
    ownerUid: stringValue(ownerUid),
    parentId: { nullValue: null },
    targetId: stringValue(noteId),
    targetType: stringValue("entry")
  });
  return noteName;
}

function sha256Base64Url(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function manifestNoteDocument(
  noteId: string,
  fields: Record<string, FirestoreValue>
) {
  return {
    contentFormat: fields.contentFormat?.stringValue,
    entryKind: fields.entryKind?.stringValue,
    folderId: fields.folderId?.nullValue === null
      ? null
      : fields.folderId?.stringValue,
    id: noteId,
    isDeleted: fields.isDeleted?.booleanValue,
    isPurged: fields.isPurged?.booleanValue,
    ownerUid: fields.ownerUid?.stringValue,
    revision: Number(fields.revision?.integerValue),
    secureShareCopyState: fields.secureShareCopyState?.stringValue,
    type: fields.type?.stringValue,
    vaultImportJobId: fields.vaultImportJobId?.stringValue,
    vaultNameClaimId: fields.vaultNameClaimId?.stringValue,
    vaultNameIndexVersion: fields.vaultNameIndexVersion?.integerValue === undefined
      ? undefined
      : Number(fields.vaultNameIndexVersion.integerValue)
  };
}

function addEmptyVaultInventoryManifest(
  backend: FakeFirestoreRest,
  ownerUid = "owner-a"
) {
  const epoch = 1;
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  backend.add(vaultInventoryManifestMarkerPath(ownerUid), {
    createdAt: timestampValue(createdAt),
    epoch: integerValue(epoch),
    ownerUid: stringValue(ownerUid),
    shardCount: integerValue(vaultInventoryManifestContract.shardCount),
    updatedAt: timestampValue(createdAt),
    version: integerValue(vaultInventoryManifestContract.version)
  });
  for (
    let shardIndex = 0;
    shardIndex < vaultInventoryManifestContract.shardCount;
    shardIndex += 1
  ) {
    const revision = 1;
    const root = sha256Base64Url(canonicalVaultInventoryManifestShard({
      entries: {},
      epoch,
      revision,
      shardIndex,
      uid: ownerUid
    }));
    backend.add(vaultInventoryManifestShardPath(ownerUid, shardIndex), {
      createdAt: timestampValue(createdAt),
      entries: { mapValue: { fields: {} } },
      epoch: integerValue(epoch),
      ownerUid: stringValue(ownerUid),
      revision: integerValue(revision),
      root: stringValue(root),
      shardIndex: integerValue(shardIndex),
      updatedAt: timestampValue(createdAt),
      version: integerValue(vaultInventoryManifestContract.version)
    });
  }
}

function manifestEntryForNote(
  backend: FakeFirestoreRest,
  noteId: string,
  nextState: "active" | "aborted"
) {
  const note = backend.get(`notes/${noteId}`);
  if (!note) throw new Error(`Missing test note: ${noteId}`);
  const document = manifestNoteDocument(noteId, note.fields);
  const ownerUid = String(document.ownerUid);
  const entryKey = sha256Base64Url(canonicalVaultInventoryManifestEntryKey({
    document,
    kind: "note",
    uid: ownerUid
  }));
  const nextDocument = {
    ...document,
    secureShareCopyState: nextState,
    ...(nextState === "aborted" ? {
      isDeleted: true,
      revision: Number(document.revision) + 1
    } : {})
  };
  const tokenPreimage = canonicalVaultInventoryManifestEntryToken({
    document: nextDocument,
    kind: "note",
    uid: ownerUid
  });
  return {
    entryKey,
    ownerUid,
    shardIndex: vaultInventoryManifestShardIndexFromEntryKey(entryKey),
    token: tokenPreimage === null ? null : sha256Base64Url(tokenPreimage)
  };
}

function legacySecureShareCopyNote(
  state: "active" | "copying",
  updatedAt: string,
  overrides: Parameters<typeof secureShareCopyNote>[3] = {}
) {
  const fields = secureShareCopyNote("legacy-copy", state, updatedAt, overrides);
  delete fields.contentFormat;
  delete fields.entryKind;
  delete fields.vaultNameClaimId;
  delete fields.vaultNameIndexVersion;
  return fields;
}

function emailQuotaBucketFields(
  bucketId: string,
  expiresAt: string,
  overrides: {
    ambiguous?: number;
    failed?: number;
    reserved?: number;
    sent?: number;
  } = {}
) {
  const scope = bucketId.startsWith("minute_")
    ? "minute"
    : bucketId.startsWith("hour_")
      ? "hourly"
      : "monthly";
  const periodKey = bucketId.slice(bucketId.indexOf("_") + 1);
  const softLimit = scope === "monthly" ? 500 : scope === "minute" ? 3 : 20;
  const hardLimit = scope === "monthly" ? 700 : scope === "minute" ? 3 : 20;
  return {
    ambiguousCount: integerValue(overrides.ambiguous ?? 0),
    expiresAt: timestampValue(expiresAt),
    failedCount: integerValue(overrides.failed ?? 2),
    hardLimit: integerValue(hardLimit),
    periodKey: stringValue(periodKey),
    reservedCount: integerValue(overrides.reserved ?? 1),
    scope: stringValue(scope),
    sentCount: integerValue(overrides.sent ?? 4),
    softLimit: integerValue(softLimit),
    softLimitReached: booleanValue(false),
    updatedAt: timestampValue(new Date().toISOString())
  };
}

async function callHandler(authorization?: string): Promise<CronResponse> {
  const server = createServer((request, response) => {
    void cleanupHandler(
      request as unknown as CleanupHttpRequest,
      response as unknown as CleanupHttpResponse
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Cleanup test server did not expose a TCP address");
    }

    return await new Promise<CronResponse>((resolve, reject) => {
      const request = httpRequest({
        headers: authorization ? { authorization } : {},
        host: "127.0.0.1",
        method: "POST",
        path: "/api/cleanup-public-shares",
        port: address.port
      }, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: JSON.parse(text) as Record<string, unknown>,
            headers: response.headers,
            status: response.statusCode ?? 0
          });
        });
      });
      request.once("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function callHandlerDirect(authorization?: string): Promise<CronResponse> {
  const headers: Record<string, string> = {};
  let responseBody = "";
  const response: CleanupHttpResponse = {
    end(body = "") {
      responseBody = body;
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    statusCode: 0
  };
  await cleanupHandler({
    headers: authorization ? { authorization } : {},
    method: "POST"
  } as CleanupHttpRequest, response);

  return {
    body: JSON.parse(responseBody) as Record<string, unknown>,
    headers,
    status: response.statusCode
  };
}

function installBackend(backend: FakeFirestoreRest) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.href === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({
        access_token: "owner",
        expires_in: 3600,
        token_type: "Bearer"
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    if (url.origin === "https://firestore.googleapis.com") {
      return backend.fetch(input, init);
    }

    throw new Error(`Cleanup integration test blocked external request: ${url.origin}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", webcrypto);
  return fetchMock;
}

describe.sequential("public share cleanup HTTP handler integration", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = cronSecret;
    process.env.FIREBASE_CLEANUP_CLIENT_EMAIL = "cleanup-handler@test.invalid";
    process.env.FIREBASE_CLEANUP_PRIVATE_KEY = privateKey;
    process.env.FIREBASE_CLEANUP_PROJECT_ID = testProjectId;
    process.env.FIREBASE_STORAGE_BUCKET = `${testProjectId}.appspot.com`;
    process.env.LEGACY_FIREBASE_STORAGE_ENABLED = "false";
    process.env.LEGACY_NOTE_BACKFILL_MAX_SCANNED = "10";
    process.env.LEGACY_NOTE_BACKFILL_PAGE_SIZE = "10";
    process.env.PUBLIC_SHARE_CLEANUP_BATCH_SIZE = "50";
    process.env.PUBLIC_SHARE_CLEANUP_MAX_DELETES = "1000";
    process.env.PUBLIC_SHARE_CLEANUP_MAX_RUNTIME_SECONDS = "240";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of cleanupEnvironmentKeys) {
      const original = originalEnvironment.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("rejects a forged cron request before credentials or data are touched", async () => {
    const backend = new FakeFirestoreRest();
    const fetchMock = installBackend(backend);

    await expect(callHandler()).resolves.toMatchObject({
      body: { error: "unauthorized", ok: false },
      status: 401
    });
    await expect(callHandler("Bearer wrong-secret")).resolves.toMatchObject({
      body: { error: "unauthorized", ok: false },
      status: 401
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(backend.requests).toBe(0);
  });

  it("serializes concurrent handlers with a Firestore lease and returns a neutral skip", async () => {
    const backend = new FakeFirestoreRest();
    completedBackfillCursor(backend);
    let releaseRunQuery!: () => void;
    let reportRunQueryStarted!: () => void;
    const runQueryStarted = new Promise<void>((resolve) => {
      reportRunQueryStarted = resolve;
    });
    const runQueryGate = new Promise<void>((resolve) => {
      releaseRunQuery = resolve;
    });
    backend.beforeNextRunQuery = async () => {
      reportRunQueryStarted();
      await runQueryGate;
    };
    installBackend(backend);

    const firstRun = callHandler(`Bearer ${cronSecret}`);
    await runQueryStarted;

    const concurrentRun = await callHandler(`Bearer ${cronSecret}`);
    expect(concurrentRun).toMatchObject({
      body: {
        ok: true,
        reason: "already_running",
        skipped: true
      },
      status: 200
    });
    expect(backend.has("systemMaintenance/secureShareCleanupLockV1")).toBe(true);

    releaseRunQuery();
    const completedRun = await firstRun;
    expect(completedRun.status).toBe(200);
    expect(completedRun.body).toMatchObject({ ok: true, deadlineReached: false });
    expect(backend.has("systemMaintenance/secureShareCleanupLockV1")).toBe(false);
  });

  it("takes over a stale cleanup lease and releases only the acquired run", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();

    completedBackfillCursor(backend);
    backend.add("systemMaintenance/secureShareCleanupLockV1", {
      leaseExpiresAt: timestampValue(expired),
      runId: stringValue("cleanup_run_stale_owner"),
      startedAt: timestampValue(expired)
    });
    backend.add("publicShareAccessSessions/expired-after-stale-lease", {
      expiresAt: timestampValue(expired)
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      secureShareAccessSessionsDeleted: 1
    });
    expect(response.body).not.toHaveProperty("skipped");
    expect(backend.has("publicShareAccessSessions/expired-after-stale-lease")).toBe(false);
    expect(backend.has("systemMaintenance/secureShareCleanupLockV1")).toBe(false);
  });

  it("stops scheduling cleanup work when the 240 second run deadline is reached", async () => {
    const backend = new FakeFirestoreRest();
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    completedBackfillCursor(backend);
    backend.beforeNextRunQuery = async () => {
      clock += 240_001;
    };
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      deadlineReached: true,
      documentDeletesAttempted: 0,
      ok: true
    });
    expect(backend.has("systemMaintenance/secureShareCleanupLockV1")).toBe(false);
  });

  it("gives each secure-share retention collection a bounded fair delete share", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();

    process.env.PUBLIC_SHARE_CLEANUP_BATCH_SIZE = "7";
    completedBackfillCursor(backend);
    for (let index = 0; index < 20; index += 1) {
      backend.add(`publicShareAccessSessions/expired-session-${index}`, {
        expiresAt: timestampValue(expired)
      });
    }
    backend.add("publicShareEmailChallenges/expired-challenge", {
      expiresAt: timestampValue(expired)
    });
    backend.add("publicShareSourceGuards/expired-guard", {
      expiresAt: timestampValue(expired)
    });
    backend.add("publicShareUnlockGrants/expired-grant", {
      expiresAt: timestampValue(expired)
    });
    backend.add("publicShareRateLimits/expired-rate", {
      expiresAt: timestampValue(expired)
    });
    backend.add("publicShareEmailDeliveries/expired-delivery", {
      expiresAt: timestampValue(expired),
      status: stringValue("sent")
    });
    backend.add("publicShareEmailQuotaBuckets/expired-day", {
      expiresAt: timestampValue(expired),
      reservedCount: integerValue(0)
    });
    backend.add("publicShareAuditEvents/share-fair/items/expired-audit", {
      retentionExpiresAt: timestampValue(expired)
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentDeletesAttempted: 8,
      secureShareAccessSessionsDeleted: 1,
      secureShareAuditEventsDeleted: 1,
      secureShareEmailChallengesDeleted: 1,
      secureShareEmailDeliveriesDeleted: 1,
      secureShareEmailQuotaBucketsDeleted: 1,
      secureShareRateLimitsDeleted: 1,
      secureShareSourceGuardsDeleted: 1,
      secureShareUnlockGrantsDeleted: 1
    });
    expect(
      backend.pathsStartingWith("publicShareAccessSessions/expired-session-")
    ).toHaveLength(19);
    expect(backend.has("publicShareSourceGuards/expired-guard")).toBe(false);
    expect(backend.has("publicShareAuditEvents/share-fair/items/expired-audit")).toBe(false);
  });

  it("atomically converts an expired reserved email delivery to ambiguous quota usage", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const challengeId = "challenge_cleanup_reserved_0001";
    const shareId = "share_cleanup_reserved_0001";
    const bucketIds = [
      "minute_2026-07-30T12:34",
      "hour_2026-07-30T12",
      "month_2026-07"
    ];

    completedBackfillCursor(backend);
    backend.add("publicShareEmailDeliveries/reserved-delivery", {
      challengeId: stringValue(challengeId),
      expiresAt: timestampValue(expired),
      quotaBucketIds: stringArrayValue(bucketIds),
      shareId: stringValue(shareId),
      status: stringValue("reserved")
    });
    backend.add("publicShareEmailSendAttempts/reserved-attempt", {
      challengeId: stringValue(challengeId),
      expiresAt: timestampValue(expired),
      shareId: stringValue(shareId),
      state: stringValue("reserved")
    });
    for (const bucketId of bucketIds) {
      backend.add(
        `publicShareEmailQuotaBuckets/${bucketId}`,
        emailQuotaBucketFields(bucketId, future, { sent: 0 })
      );
    }
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentDeletesAttempted: 2,
      ok: true,
      secureShareEmailDeliveriesDeleted: 1,
      secureShareEmailReservationsReconciled: 1,
      secureShareEmailSendAttemptsDeleted: 1
    });
    expect(backend.has("publicShareEmailDeliveries/reserved-delivery")).toBe(false);
    expect(backend.has("publicShareEmailSendAttempts/reserved-attempt")).toBe(false);
    for (const bucketId of bucketIds) {
      const fields = backend.get(`publicShareEmailQuotaBuckets/${bucketId}`)?.fields;
      expect(fields?.reservedCount).toEqual(integerValue(0));
      expect(fields?.ambiguousCount).toEqual(integerValue(1));
      expect(fields?.sentCount).toEqual(integerValue(0));
      expect(fields?.failedCount).toEqual(integerValue(2));
      expect(fields?.softLimitReached).toEqual(
        booleanValue(bucketId.startsWith("minute_"))
      );
    }
  });

  it("expires an already-ambiguous delivery without counting it twice", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const challengeId = "challenge_cleanup_ambiguous_0001";
    const shareId = "share_cleanup_ambiguous_0001";
    const bucketId = "month_2026-07";

    completedBackfillCursor(backend);
    backend.add("publicShareEmailDeliveries/ambiguous-delivery", {
      challengeId: stringValue(challengeId),
      expiresAt: timestampValue(expired),
      quotaBucketIds: stringArrayValue([bucketId]),
      shareId: stringValue(shareId),
      status: stringValue("ambiguous")
    });
    backend.add("publicShareEmailSendAttempts/ambiguous-attempt", {
      challengeId: stringValue(challengeId),
      expiresAt: timestampValue(expired),
      shareId: stringValue(shareId),
      state: stringValue("ambiguous")
    });
    backend.add(
      `publicShareEmailQuotaBuckets/${bucketId}`,
      emailQuotaBucketFields(bucketId, future, { ambiguous: 1, reserved: 0 })
    );
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentDeletesAttempted: 2,
      secureShareEmailDeliveriesDeleted: 1,
      secureShareEmailReservationsReconciled: 0,
      secureShareEmailSendAttemptsDeleted: 1
    });
    const quotaFields = backend.get(
      `publicShareEmailQuotaBuckets/${bucketId}`
    )?.fields;
    expect(quotaFields?.reservedCount).toEqual(integerValue(0));
    expect(quotaFields?.ambiguousCount).toEqual(integerValue(1));
  });

  it("retains the full reservation when a quota precondition conflicts", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const challengeId = "challenge_cleanup_conflict_0001";
    const shareId = "share_cleanup_conflict_0001";
    const bucketIds = [
      "minute_2026-07-30T12:35",
      "hour_2026-07-30T12",
      "month_2026-07"
    ];

    completedBackfillCursor(backend);
    backend.add("publicShareEmailDeliveries/conflicted-delivery", {
      challengeId: stringValue(challengeId),
      expiresAt: timestampValue(expired),
      quotaBucketIds: stringArrayValue(bucketIds),
      shareId: stringValue(shareId),
      status: stringValue("reserved")
    });
    backend.add("publicShareEmailSendAttempts/conflicted-attempt", {
      challengeId: stringValue(challengeId),
      expiresAt: timestampValue(expired),
      shareId: stringValue(shareId),
      state: stringValue("reserved")
    });
    for (const bucketId of bucketIds) {
      backend.add(
        `publicShareEmailQuotaBuckets/${bucketId}`,
        emailQuotaBucketFields(bucketId, future)
      );
    }
    backend.raceEmailQuotaDocumentOnce =
      `${documentRoot}/publicShareEmailQuotaBuckets/${bucketIds[1]}`;
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response).toMatchObject({
      body: { error: "cleanup_failed", ok: false },
      status: 500
    });
    expect(backend.has("publicShareEmailDeliveries/conflicted-delivery")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/conflicted-attempt")).toBe(true);
    for (const bucketId of bucketIds) {
      const fields = backend.get(`publicShareEmailQuotaBuckets/${bucketId}`)?.fields;
      expect(fields?.reservedCount).toEqual(integerValue(1));
      expect(fields?.ambiguousCount).toEqual(integerValue(0));
    }
  });

  it("deletes only finalized expired email deliveries and send attempts", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();

    completedBackfillCursor(backend);
    backend.add("publicShareEmailDeliveries/expired-unknown-delivery", {
      expiresAt: timestampValue(expired),
      status: stringValue("future_status")
    });
    backend.add("publicShareEmailDeliveries/expired-missing-delivery-status", {
      expiresAt: timestampValue(expired)
    });
    for (const state of ["sent", "failed", "reserved", "ambiguous", "future_state"]) {
      backend.add(`publicShareEmailSendAttempts/expired-${state}-attempt`, {
        expiresAt: timestampValue(expired),
        state: stringValue(state)
      });
    }
    backend.add("publicShareEmailSendAttempts/expired-missing-attempt-state", {
      expiresAt: timestampValue(expired)
    });
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentDeletesAttempted: 2,
      secureShareEmailDeliveriesDeleted: 0,
      secureShareEmailSendAttemptsDeleted: 2
    });
    expect(backend.has("publicShareEmailDeliveries/expired-unknown-delivery")).toBe(true);
    expect(backend.has("publicShareEmailDeliveries/expired-missing-delivery-status")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/expired-sent-attempt")).toBe(false);
    expect(backend.has("publicShareEmailSendAttempts/expired-failed-attempt")).toBe(false);
    expect(backend.has("publicShareEmailSendAttempts/expired-reserved-attempt")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/expired-ambiguous-attempt")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/expired-future_state-attempt")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/expired-missing-attempt-state")).toBe(true);
  });

  it("deletes an expired email quota bucket only when no reservation remains", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();

    completedBackfillCursor(backend);
    backend.add("publicShareEmailQuotaBuckets/expired-unreserved", {
      expiresAt: timestampValue(expired),
      reservedCount: integerValue(0)
    });
    backend.add("publicShareEmailQuotaBuckets/expired-reserved", {
      expiresAt: timestampValue(expired),
      reservedCount: integerValue(1)
    });
    backend.add("publicShareEmailQuotaBuckets/expired-missing-reserved-count", {
      expiresAt: timestampValue(expired)
    });
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentDeletesAttempted: 1,
      secureShareEmailQuotaBucketsDeleted: 1
    });
    expect(backend.has("publicShareEmailQuotaBuckets/expired-unreserved")).toBe(false);
    expect(backend.has("publicShareEmailQuotaBuckets/expired-reserved")).toBe(true);
    expect(
      backend.has("publicShareEmailQuotaBuckets/expired-missing-reserved-count")
    ).toBe(true);
  });

  it("deletes delivery and copy-request roots with their expired secure share tree", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    backend.add("publicNoteShares/expired-secure-tree", {
      expiresAt: timestampValue(expired),
      schemaVersion: integerValue(2),
      status: stringValue("active")
    });
    backend.add("publicShareEmailDeliveries/tree-delivery", {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-tree"),
      shareId: stringValue("expired-secure-tree"),
      status: stringValue("sent")
    });
    backend.add("publicShareCopyGrantRequests/tree-copy-request", {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-tree"),
      requesterUid: stringValue("requester-tree"),
      shareId: stringValue("expired-secure-tree")
    });
    backend.add("publicShareParticipantCounters/expired-secure-tree", {
      nextGuestNumber: integerValue(2),
      participantCount: integerValue(1),
      shareId: stringValue("expired-secure-tree")
    });
    backend.add("publicShareParticipants/expired-secure-tree/items/participant-a", {
      displayName: stringValue("guest1"),
      participantId: stringValue("participant-a"),
      shareId: stringValue("expired-secure-tree")
    });
    backend.add("publicShareParticipantNames/expired-secure-tree/items/name-a", {
      participantId: stringValue("participant-a"),
      shareId: stringValue("expired-secure-tree")
    });
    backend.add("publicShareParticipantRenameRequests/expired-secure-tree/items/request-a", {
      participantId: stringValue("participant-a"),
      shareId: stringValue("expired-secure-tree"),
      status: stringValue("succeeded")
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      secureShareCopyGrantRequestsDeleted: 1,
      secureShareEmailDeliveriesDeleted: 1,
      secureShareParticipantCountersDeleted: 1,
      secureShareParticipantNamesDeleted: 1,
      secureShareParticipantRenameRequestsDeleted: 1,
      secureShareParticipantsDeleted: 1,
      sharesDeleted: 1
    });
    expect(backend.has("publicNoteShares/expired-secure-tree")).toBe(false);
    expect(backend.has("publicShareEmailDeliveries/tree-delivery")).toBe(false);
    expect(backend.has("publicShareCopyGrantRequests/tree-copy-request")).toBe(false);
    expect(backend.has("publicShareParticipantCounters/expired-secure-tree")).toBe(false);
    expect(
      backend.has("publicShareParticipants/expired-secure-tree/items/participant-a")
    ).toBe(false);
    expect(
      backend.has("publicShareParticipantNames/expired-secure-tree/items/name-a")
    ).toBe(false);
    expect(
      backend.has("publicShareParticipantRenameRequests/expired-secure-tree/items/request-a")
    ).toBe(false);
  });

  it("deletes only finalized email state and blocks tree deletion for all other states", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const shareId = "expired-tree-with-unresolved-email";

    completedBackfillCursor(backend);
    backend.add(`publicNoteShares/${shareId}`, {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-email-tree"),
      schemaVersion: integerValue(2),
      status: stringValue("active")
    });
    backend.add(`publicShareCleanupQueue/${shareId}`, {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-email-tree"),
      shareId: stringValue(shareId)
    });
    backend.add("publicShareEmailDeliveries/tree-reserved-delivery", {
      challengeId: stringValue("challenge_tree_reserved_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      status: stringValue("reserved")
    });
    backend.add("publicShareEmailSendAttempts/tree-reserved-attempt", {
      challengeId: stringValue("challenge_tree_reserved_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      state: stringValue("reserved")
    });
    backend.add("publicShareEmailDeliveries/tree-ambiguous-delivery", {
      challengeId: stringValue("challenge_tree_ambiguous_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      status: stringValue("ambiguous")
    });
    backend.add("publicShareEmailSendAttempts/tree-ambiguous-attempt", {
      challengeId: stringValue("challenge_tree_ambiguous_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      state: stringValue("ambiguous")
    });
    backend.add("publicShareEmailDeliveries/tree-sent-delivery", {
      challengeId: stringValue("challenge_tree_sent_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      status: stringValue("sent")
    });
    backend.add("publicShareEmailSendAttempts/tree-sent-attempt", {
      challengeId: stringValue("challenge_tree_sent_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      state: stringValue("sent")
    });
    backend.add("publicShareEmailDeliveries/tree-failed-delivery", {
      challengeId: stringValue("challenge_tree_failed_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      status: stringValue("failed")
    });
    backend.add("publicShareEmailSendAttempts/tree-failed-attempt", {
      challengeId: stringValue("challenge_tree_failed_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      state: stringValue("failed")
    });
    backend.add("publicShareEmailDeliveries/tree-unknown-delivery", {
      challengeId: stringValue("challenge_tree_unknown_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      status: stringValue("future_status")
    });
    backend.add("publicShareEmailSendAttempts/tree-unknown-attempt", {
      challengeId: stringValue("challenge_tree_unknown_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      state: stringValue("future_state")
    });
    backend.add("publicShareEmailDeliveries/tree-missing-delivery-state", {
      challengeId: stringValue("challenge_tree_missing_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId)
    });
    backend.add("publicShareEmailSendAttempts/tree-missing-attempt-state", {
      challengeId: stringValue("challenge_tree_missing_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId)
    });
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      secureShareEmailDeliveriesDeleted: 2,
      secureShareEmailSendAttemptsDeleted: 2,
      shareQueuesDeleted: 0,
      sharesDeleted: 0
    });
    expect(backend.has("publicShareEmailDeliveries/tree-reserved-delivery")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/tree-reserved-attempt")).toBe(true);
    expect(backend.has("publicShareEmailDeliveries/tree-ambiguous-delivery")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/tree-ambiguous-attempt")).toBe(true);
    expect(backend.has("publicShareEmailDeliveries/tree-sent-delivery")).toBe(false);
    expect(backend.has("publicShareEmailSendAttempts/tree-sent-attempt")).toBe(false);
    expect(backend.has("publicShareEmailDeliveries/tree-failed-delivery")).toBe(false);
    expect(backend.has("publicShareEmailSendAttempts/tree-failed-attempt")).toBe(false);
    expect(backend.has("publicShareEmailDeliveries/tree-unknown-delivery")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/tree-unknown-attempt")).toBe(true);
    expect(backend.has("publicShareEmailDeliveries/tree-missing-delivery-state")).toBe(true);
    expect(backend.has("publicShareEmailSendAttempts/tree-missing-attempt-state")).toBe(true);
    expect(backend.has(`publicNoteShares/${shareId}`)).toBe(true);
    expect(backend.has(`publicShareCleanupQueue/${shareId}`)).toBe(true);
  });

  it("fails closed when a finalized delivery becomes reserved during tree cleanup", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const shareId = "expired-tree-email-state-race";
    const deliveryPath = "publicShareEmailDeliveries/tree-racing-delivery";

    completedBackfillCursor(backend);
    backend.add(`publicNoteShares/${shareId}`, {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-email-race"),
      schemaVersion: integerValue(2),
      status: stringValue("active")
    });
    backend.add(`publicShareCleanupQueue/${shareId}`, {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-email-race"),
      shareId: stringValue(shareId)
    });
    backend.add(deliveryPath, {
      challengeId: stringValue("challenge_tree_racing_0001"),
      expiresAt: timestampValue(future),
      shareId: stringValue(shareId),
      status: stringValue("sent")
    });
    backend.raceEmailTreeDeliveryOnce = `${documentRoot}/${deliveryPath}`;
    installBackend(backend);

    const response = await callHandlerDirect(`Bearer ${cronSecret}`);

    expect(response).toMatchObject({
      body: { error: "cleanup_failed", ok: false },
      status: 500
    });
    expect(backend.get(deliveryPath)?.fields.status).toEqual(
      stringValue("reserved")
    );
    expect(backend.has(`publicNoteShares/${shareId}`)).toBe(true);
    expect(backend.has(`publicShareCleanupQueue/${shareId}`)).toBe(true);
  });

  it("retains a renewed share tree when an expired cleanup queue is stale", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const shareId = "renewed-share-stale-queue";

    completedBackfillCursor(backend);
    backend.add(`publicNoteShares/${shareId}`, {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-renewed"),
      schemaVersion: integerValue(2),
      status: stringValue("active")
    });
    backend.add(`publicShareCleanupQueue/${shareId}`, {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-renewed"),
      shareId: stringValue(shareId)
    });
    backend.add(`publicShareParticipantCounters/${shareId}`, {
      nextGuestNumber: integerValue(2),
      participantCount: integerValue(1),
      shareId: stringValue(shareId)
    });
    backend.add(`publicShareParticipants/${shareId}/items/participant-a`, {
      displayName: stringValue("guest1"),
      participantId: stringValue("participant-a"),
      shareId: stringValue(shareId)
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      secureShareParticipantCountersDeleted: 0,
      secureShareParticipantsDeleted: 0,
      sharesDeleted: 0
    });
    expect(backend.has(`publicNoteShares/${shareId}`)).toBe(true);
    expect(backend.has(`publicShareCleanupQueue/${shareId}`)).toBe(true);
    expect(backend.has(`publicShareParticipantCounters/${shareId}`)).toBe(true);
    expect(
      backend.has(`publicShareParticipants/${shareId}/items/participant-a`)
    ).toBe(true);
  });

  it("retains stale child and attachment expiries after their parent share is renewed", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const shareId = "renewed-share-stale-children";

    completedBackfillCursor(backend);
    backend.add(`publicNoteShares/${shareId}`, {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-renewed"),
      schemaVersion: integerValue(2),
      status: stringValue("active")
    });
    backend.add(`publicShareComments/${shareId}/items/comment-a`, {
      body: stringValue("must remain"),
      expiresAt: timestampValue(expired),
      shareId: stringValue(shareId)
    });
    backend.add(`publicNoteShares/${shareId}/attachments/attachment-a`, {
      expiresAt: timestampValue(expired),
      isReady: booleanValue(true),
      ownerUid: stringValue("owner-renewed")
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      attachmentsDeleted: 0,
      secureShareCommentsDeleted: 0,
      sharesDeleted: 0
    });
    expect(
      backend.has(`publicShareComments/${shareId}/items/comment-a`)
    ).toBe(true);
    expect(
      backend.has(`publicNoteShares/${shareId}/attachments/attachment-a`)
    ).toBe(true);
    expect(backend.has(`publicNoteShares/${shareId}`)).toBe(true);
  });

  it("skips disabled legacy Storage I/O and atomically releases valid global Blob usage", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();

    completedBackfillCursor(backend);
    backend.add("systemUsage/blobAttachmentsV1", {
      accountingMode: stringValue("ready_and_pending_reservations"),
      attachmentCount: integerValue(1),
      schemaVersion: integerValue(1),
      usedBytes: integerValue(100)
    });
    backend.add("userAttachmentUsage/owner-storage", {
      attachmentCount: integerValue(1),
      usedBytes: integerValue(100)
    });
    backend.add("notes/storage-cleanup/attachments/legacy-object", {
      encryptedSize: integerValue(100),
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-storage"),
      quotaReserved: booleanValue(true),
      reservationExpiresAt: timestampValue(expired),
      storagePath: stringValue("legacy/private/object.bin")
    });
    installBackend(backend);

    const first = await callHandler(`Bearer ${cronSecret}`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      attachmentsDeleted: 1,
      storageBytesReleased: 100,
      storageObjectsDeleted: 0
    });
    expect(backend.has("notes/storage-cleanup/attachments/legacy-object")).toBe(false);
    expect(backend.get("userAttachmentUsage/owner-storage")?.fields).toMatchObject({
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
    expect(backend.get("systemUsage/blobAttachmentsV1")?.fields).toMatchObject({
      attachmentCount: integerValue(0),
      schemaVersion: integerValue(1),
      usedBytes: integerValue(0)
    });

    const duplicate = await callHandler(`Bearer ${cronSecret}`);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ attachmentsDeleted: 0 });
    expect(backend.get("systemUsage/blobAttachmentsV1")?.fields).toMatchObject({
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
  });

  it("continues deletion when the optional global Blob usage document is invalid", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();

    completedBackfillCursor(backend);
    backend.add("systemUsage/blobAttachmentsV1", {
      attachmentCount: integerValue(10),
      schemaVersion: integerValue(999),
      usedBytes: integerValue(10_000)
    });
    backend.add("notes/invalid-usage/attachments/pending-object", {
      encryptedSize: integerValue(50),
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-invalid-usage"),
      quotaReserved: booleanValue(true),
      reservationExpiresAt: timestampValue(expired)
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ attachmentsDeleted: 1 });
    expect(backend.has("notes/invalid-usage/attachments/pending-object")).toBe(false);
    expect(backend.get("systemUsage/blobAttachmentsV1")?.fields).toMatchObject({
      attachmentCount: integerValue(10),
      schemaVersion: integerValue(999),
      usedBytes: integerValue(10_000)
    });
  });

  it("preserves a schema-valid global counter instead of underflowing it", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    completedBackfillCursor(backend);
    backend.add("systemUsage/blobAttachmentsV1", {
      attachmentCount: integerValue(0),
      schemaVersion: integerValue(1),
      usedBytes: integerValue(10)
    });
    backend.add("userAttachmentUsage/owner-underflow", {
      attachmentCount: integerValue(1),
      usedBytes: integerValue(100)
    });
    backend.add("notes/underflow/attachments/pending-object", {
      encryptedSize: integerValue(100),
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-underflow"),
      quotaReserved: booleanValue(true),
      reservationExpiresAt: timestampValue(expired)
    });
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ attachmentsDeleted: 1 });
    expect(backend.has("notes/underflow/attachments/pending-object")).toBe(false);
    expect(backend.get("systemUsage/blobAttachmentsV1")?.fields).toMatchObject({
      attachmentCount: integerValue(0),
      schemaVersion: integerValue(1),
      usedBytes: integerValue(10)
    });
    expect(warning).toHaveBeenCalledWith(
      "blob storage counter release skipped",
      { reason: "counter_underflow_guard" }
    );
  });

  it("returns 200 and cleans expired state plus stale copy jobs without touching active or racing data", async () => {
    const backend = new FakeFirestoreRest();
    const now = Date.now();
    const expired = new Date(now - 60_000).toISOString();
    const future = new Date(now + 60 * 60 * 1000).toISOString();
    const stale = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now - 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    backend.add("publicShareEmailChallenges/expired-otp", { expiresAt: timestampValue(expired) });
    backend.add("publicShareEmailChallenges/active-otp", { expiresAt: timestampValue(future) });
    backend.add("publicShareAccessSessions/expired-session", { expiresAt: timestampValue(expired) });
    backend.add("publicShareAccessSessions/active-session", { expiresAt: timestampValue(future) });
    backend.add("publicShareRateLimits/expired-rate", { expiresAt: timestampValue(expired) });
    backend.add("publicShareRateLimits/active-rate", { expiresAt: timestampValue(future) });
    backend.add("publicShareCopyGrantRequests/expired-copy-request", {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-a"),
      requesterUid: stringValue("requester-a"),
      shareId: stringValue("share-a")
    });
    backend.add("publicShareCopyGrantRequests/active-copy-request", {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-a"),
      requesterUid: stringValue("requester-a"),
      shareId: stringValue("share-a")
    });
    backend.add("publicShareSourceGuards/expired-guard", {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-a"),
      shareId: stringValue("share-a")
    });
    backend.add("publicShareSourceGuards/active-guard", {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-a"),
      shareId: stringValue("share-a")
    });
    backend.add("publicShareEmailDeliveries/expired-delivery", {
      expiresAt: timestampValue(expired),
      ownerUid: stringValue("owner-a"),
      shareId: stringValue("share-a"),
      status: stringValue("sent")
    });
    backend.add("publicShareEmailDeliveries/active-delivery", {
      expiresAt: timestampValue(future),
      ownerUid: stringValue("owner-a"),
      shareId: stringValue("share-a")
    });
    backend.add("publicShareEmailQuotaBuckets/expired-day", {
      expiresAt: timestampValue(expired),
      reservedCount: integerValue(0)
    });
    backend.add("publicShareEmailQuotaBuckets/active-month", {
      expiresAt: timestampValue(future)
    });
    backend.add(
      "publicShareAuditEvents/share-a/items/expired-audit",
      { retentionExpiresAt: timestampValue(expired) }
    );
    backend.add(
      "publicShareAuditEvents/share-a/items/active-audit",
      { retentionExpiresAt: timestampValue(future) }
    );
    backend.add("publicNoteShares/active-share", {
      expiresAt: timestampValue(future),
      status: stringValue("active")
    });
    addSecureShareCopyNote(backend, "stale-incomplete", "copying", stale, {
      reserved: 1
    });
    backend.add("notes/stale-incomplete/attachments/pending-copy", {
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-a"),
      quotaReserved: booleanValue(false),
      secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
    });
    addSecureShareCopyNote(backend, "stale-complete", "copying", stale, {
      expected: 1,
      ready: 1,
      reserved: 1
    });
    addSecureShareCopyNote(backend, "fresh-copy", "copying", fresh);
    addSecureShareCopyNote(backend, "other-participant-copy", "copying", stale, {
      participantUids: ["owner-a", "owner-b"]
    });
    addSecureShareCopyNote(backend, "foreign-attachment-copy", "copying", stale, {
      reserved: 1
    });
    backend.add("notes/foreign-attachment-copy/attachments/foreign-copy", {
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-b"),
      quotaReserved: booleanValue(false),
      secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
    });
    const racingName = addSecureShareCopyNote(backend, "racing-copy", "copying", stale);
    addSecureShareCopyNote(backend, "already-active", "active", stale);
    backend.raceAbortDocumentOnce = racingName;
    installBackend(backend);

    const first = await callHandler(`Bearer ${cronSecret}`);

    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body).toMatchObject({
      ok: true,
      attachmentsDeleted: 1,
      secureShareAccessSessionsDeleted: 1,
      secureShareAuditEventsDeleted: 1,
      secureShareEmailChallengesDeleted: 1,
      secureShareCopyGrantRequestsDeleted: 1,
      secureShareEmailDeliveriesDeleted: 1,
      secureShareEmailQuotaBucketsDeleted: 1,
      secureShareRateLimitsDeleted: 1,
      secureShareSourceGuardsDeleted: 1,
      staleSecureShareCopyJobsAborted: 1,
      staleSecureShareCopyJobsActivated: 1,
      staleSecureShareCopyJobsRetained: 3,
      staleSecureShareCopyJobsScanned: 5
    });
    expect(backend.has("publicShareEmailChallenges/expired-otp")).toBe(false);
    expect(backend.has("publicShareAccessSessions/expired-session")).toBe(false);
    expect(backend.has("publicShareRateLimits/expired-rate")).toBe(false);
    expect(backend.has("publicShareCopyGrantRequests/expired-copy-request")).toBe(false);
    expect(backend.has("publicShareSourceGuards/expired-guard")).toBe(false);
    expect(backend.has("publicShareEmailDeliveries/expired-delivery")).toBe(false);
    expect(backend.has("publicShareEmailQuotaBuckets/expired-day")).toBe(false);
    expect(backend.has("publicShareAuditEvents/share-a/items/expired-audit")).toBe(false);
    expect(backend.has("publicShareEmailChallenges/active-otp")).toBe(true);
    expect(backend.has("publicShareAccessSessions/active-session")).toBe(true);
    expect(backend.has("publicShareRateLimits/active-rate")).toBe(true);
    expect(backend.has("publicShareCopyGrantRequests/active-copy-request")).toBe(true);
    expect(backend.has("publicShareSourceGuards/active-guard")).toBe(true);
    expect(backend.has("publicShareEmailDeliveries/active-delivery")).toBe(true);
    expect(backend.has("publicShareEmailQuotaBuckets/active-month")).toBe(true);
    expect(backend.has("publicShareAuditEvents/share-a/items/active-audit")).toBe(true);
    expect(backend.has("publicNoteShares/active-share")).toBe(true);
    expect(backend.get("notes/stale-incomplete")?.fields.secureShareCopyState).toEqual(
      stringValue("aborted")
    );
    expect(backend.get("notes/stale-incomplete")?.fields.isDeleted).toEqual(
      booleanValue(true)
    );
    expect(backend.pathsStartingWith("notes/stale-incomplete/history/")).toHaveLength(1);
    expect(backend.has("notes/stale-incomplete/attachments/pending-copy")).toBe(false);
    expect(backend.has(
      `vaultIntegrity/owner-a/nameClaims/${"stale-incomplete".padEnd(43, "_")}`
    )).toBe(false);
    expect(backend.get("notes/stale-complete")?.fields.secureShareCopyState).toEqual(
      stringValue("active")
    );
    expect(backend.get("notes/stale-complete")?.fields.isDeleted).toEqual(
      booleanValue(false)
    );
    expect(backend.has(
      `vaultIntegrity/owner-a/nameClaims/${"stale-complete".padEnd(43, "_")}`
    )).toBe(true);
    expect(backend.get("notes/fresh-copy")?.fields.secureShareCopyState).toEqual(
      stringValue("copying")
    );
    expect(backend.get("notes/other-participant-copy")?.fields.secureShareCopyState).toEqual(
      stringValue("copying")
    );
    expect(backend.get("notes/foreign-attachment-copy")?.fields.secureShareCopyState).toEqual(
      stringValue("copying")
    );
    expect(backend.has("notes/foreign-attachment-copy/attachments/foreign-copy")).toBe(true);
    expect(backend.get("notes/racing-copy")?.fields.secureShareCopyState).toEqual(
      stringValue("active")
    );
    expect(backend.get("notes/already-active")?.fields.secureShareCopyState).toEqual(
      stringValue("active")
    );

    const second = await callHandler(`Bearer ${cronSecret}`);

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      documentDeletesAttempted: 0,
      secureShareAccessSessionsDeleted: 0,
      secureShareAuditEventsDeleted: 0,
      secureShareEmailChallengesDeleted: 0,
      secureShareCopyGrantRequestsDeleted: 0,
      secureShareEmailDeliveriesDeleted: 0,
      secureShareEmailQuotaBucketsDeleted: 0,
      secureShareRateLimitsDeleted: 0,
      secureShareSourceGuardsDeleted: 0,
      staleSecureShareCopyJobsAborted: 0,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 2,
      staleSecureShareCopyJobsScanned: 2
    });
    expect(backend.pathsStartingWith("notes/stale-incomplete/history/")).toHaveLength(1);
    expect(backend.has("publicNoteShares/active-share")).toBe(true);
  });

  it("honors the configured batch limit across repeatable HTTP invocations", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    process.env.PUBLIC_SHARE_CLEANUP_BATCH_SIZE = "2";
    completedBackfillCursor(backend);
    for (let index = 0; index < 5; index += 1) {
      backend.add(`publicShareEmailChallenges/expired-${index}`, {
        expiresAt: timestampValue(expired)
      });
    }
    backend.add("publicShareEmailChallenges/active", {
      expiresAt: timestampValue(future)
    });
    installBackend(backend);

    const deletedPerRun: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await callHandler(`Bearer ${cronSecret}`);
      expect(response.status).toBe(200);
      deletedPerRun.push(Number(response.body.secureShareEmailChallengesDeleted));
      expect(Number(response.body.documentDeletesAttempted)).toBeLessThanOrEqual(2);
    }

    expect(deletedPerRun).toEqual([2, 2, 1, 0]);
    expect(backend.has("publicShareEmailChallenges/active")).toBe(true);
    expect(
      backend.pathsStartingWith("publicShareEmailChallenges/expired-")
    ).toHaveLength(0);
  });

  it("updates initialized Vault inventory shards atomically for copy activation and abort", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    addSecureShareCopyNote(
      backend,
      "manifest-active-copy",
      "copying",
      stale,
      { expected: 1, ready: 1, reserved: 1 }
    );
    addSecureShareCopyNote(
      backend,
      "manifest-aborted-copy",
      "copying",
      stale,
      { expected: 1, ready: 0, reserved: 1 }
    );
    backend.add("notes/manifest-aborted-copy/attachments/pending-copy", {
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-a"),
      quotaReserved: booleanValue(false),
      secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
    });
    addEmptyVaultInventoryManifest(backend);
    const activatedEntry = manifestEntryForNote(
      backend,
      "manifest-active-copy",
      "active"
    );
    const abortedEntry = manifestEntryForNote(
      backend,
      "manifest-aborted-copy",
      "aborted"
    );
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      staleSecureShareCopyJobsAborted: 1,
      staleSecureShareCopyJobsActivated: 1,
      staleSecureShareCopyJobsRetained: 0,
      staleSecureShareCopyJobsScanned: 2
    });
    expect(backend.get("notes/manifest-active-copy")?.fields.secureShareCopyState)
      .toEqual(stringValue("active"));
    expect(backend.get("notes/manifest-aborted-copy")?.fields.secureShareCopyState)
      .toEqual(stringValue("aborted"));

    const activatedShard = backend.get(vaultInventoryManifestShardPath(
      activatedEntry.ownerUid,
      activatedEntry.shardIndex
    ));
    const activatedEntries = activatedShard?.fields.entries?.mapValue?.fields ?? {};
    expect(activatedEntries[activatedEntry.entryKey]).toEqual(
      stringValue(String(activatedEntry.token))
    );

    const abortedShard = backend.get(vaultInventoryManifestShardPath(
      abortedEntry.ownerUid,
      abortedEntry.shardIndex
    ));
    const abortedEntries = abortedShard?.fields.entries?.mapValue?.fields ?? {};
    expect(abortedEntry.token).toBeNull();
    expect(abortedEntries[abortedEntry.entryKey]).toBeUndefined();

    for (const shard of new Set([activatedShard, abortedShard])) {
      if (!shard) throw new Error("Missing test inventory shard");
      const entries = Object.fromEntries(Object.entries(
        shard.fields.entries?.mapValue?.fields ?? {}
      ).map(([key, value]) => [key, String(value.stringValue)]));
      const epoch = Number(shard.fields.epoch?.integerValue);
      const revision = Number(shard.fields.revision?.integerValue);
      const shardIndex = Number(shard.fields.shardIndex?.integerValue);
      expect(shard.fields.root).toEqual(stringValue(sha256Base64Url(
        canonicalVaultInventoryManifestShard({
          entries,
          epoch,
          revision,
          shardIndex,
          uid: "owner-a"
        })
      )));
    }
  });

  it("fails closed when the initialized Vault inventory target shard is malformed", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    addSecureShareCopyNote(
      backend,
      "manifest-malformed-copy",
      "copying",
      stale,
      { expected: 1, ready: 1, reserved: 1 }
    );
    addEmptyVaultInventoryManifest(backend);
    const entry = manifestEntryForNote(backend, "manifest-malformed-copy", "active");
    const shard = backend.get(vaultInventoryManifestShardPath(
      entry.ownerUid,
      entry.shardIndex
    ));
    if (!shard) throw new Error("Missing test inventory shard");
    shard.fields.root = stringValue("A".repeat(43));
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      staleSecureShareCopyJobsAborted: 0,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 1,
      staleSecureShareCopyJobsScanned: 1
    });
    expect(backend.get("notes/manifest-malformed-copy")?.fields.secureShareCopyState)
      .toEqual(stringValue("copying"));
    expect(shard.fields.root).toEqual(stringValue("A".repeat(43)));
  });

  it("lets concurrent manifest bootstrap win without partially activating a copy", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    addSecureShareCopyNote(
      backend,
      "manifest-bootstrap-race-copy",
      "copying",
      stale,
      { expected: 1, ready: 1, reserved: 1 }
    );
    backend.raceManifestBootstrapMarkerOnce = `${documentRoot}/${
      vaultInventoryManifestMarkerPath("owner-a")
    }`;
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      staleSecureShareCopyJobsAborted: 0,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 1,
      staleSecureShareCopyJobsScanned: 1
    });
    expect(backend.get("notes/manifest-bootstrap-race-copy")?.fields.secureShareCopyState)
      .toEqual(stringValue("copying"));
    expect(backend.pathsStartingWith(
      `vaultMaintenanceJobs/owner-a/${vaultInventoryManifestContract.collectionId}/shard-`
    )).toHaveLength(0);
  });

  it("bounds global stale-copy recovery to twenty jobs per cron invocation", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    for (let index = 0; index < 21; index += 1) {
      const noteId = `stale-complete-${String(index).padStart(2, "0")}`;
      addSecureShareCopyNote(
        backend,
        noteId,
        "copying",
        stale,
        { expected: 1, ready: 1, reserved: 1 }
      );
    }
    installBackend(backend);

    const first = await callHandler(`Bearer ${cronSecret}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      staleSecureShareCopyJobsActivated: 20,
      staleSecureShareCopyJobsScanned: 20
    });
    expect(
      [...backend.documents.values()].filter((document) =>
        document.fields.secureShareCopyState?.stringValue === "copying"
      )
    ).toHaveLength(1);

    const second = await callHandler(`Bearer ${cronSecret}`);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      staleSecureShareCopyJobsActivated: 1,
      staleSecureShareCopyJobsScanned: 1
    });
    expect(
      [...backend.documents.values()].filter((document) =>
        document.fields.secureShareCopyState?.stringValue === "copying"
      )
    ).toHaveLength(0);
  });

  it("lets a fresh heartbeat and resumed ready upload win before cleanup claims the job", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    const heartbeatNoteName = addSecureShareCopyNote(
      backend,
      "stale-heartbeat-race",
      "copying",
      stale
    );
    const readyNoteName = addSecureShareCopyNote(
      backend,
      "stale-ready-race",
      "copying",
      stale,
      { reserved: 1 }
    );
    const readyAttachmentName = backend.add(
      "notes/stale-ready-race/attachments/resumed-upload",
      {
        isReady: booleanValue(false),
        ownerUid: stringValue("owner-a"),
        quotaReserved: booleanValue(false),
        secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
      }
    );
    backend.raceCleanupClaimHeartbeatDocumentOnce = heartbeatNoteName;
    backend.raceCleanupClaimReadyUploadOnce = {
      attachmentName: readyAttachmentName,
      noteName: readyNoteName
    };
    installBackend(backend);

    const raced = await callHandler(`Bearer ${cronSecret}`);

    expect(raced.status).toBe(200);
    expect(raced.body).toMatchObject({
      attachmentsDeleted: 0,
      staleSecureShareCopyJobsAborted: 0,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 2,
      staleSecureShareCopyJobsScanned: 2
    });
    expect(
      backend.get("notes/stale-heartbeat-race")?.fields.secureShareCopyState
    ).toEqual(stringValue("copying"));
    expect(
      backend.get("notes/stale-ready-race")?.fields.secureShareCopyState
    ).toEqual(stringValue("copying"));
    expect(
      backend.get("notes/stale-ready-race")?.fields.secureShareCopyReadyAttachmentCount
    ).toEqual(integerValue(1));
    expect(
      backend.get("notes/stale-ready-race/attachments/resumed-upload")?.fields.isReady
    ).toEqual(booleanValue(true));
    expect(
      backend.get("notes/stale-heartbeat-race")?.fields
        .secureShareCopyCleanupClaimId
    ).toBeUndefined();
    expect(
      backend.get("notes/stale-ready-race")?.fields
        .secureShareCopyCleanupClaimId
    ).toBeUndefined();

    const freshRun = await callHandler(`Bearer ${cronSecret}`);
    expect(freshRun.status).toBe(200);
    expect(freshRun.body).toMatchObject({
      staleSecureShareCopyJobsAborted: 0,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 0,
      staleSecureShareCopyJobsScanned: 0
    });
  });

  it("terminally aborts an exact legacy copying job without creating or requiring a Vault claim", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    backend.add(
      "notes/stale-legacy-copy",
      legacySecureShareCopyNote("copying", stale, { expected: 0, ready: 0, reserved: 0 })
    );
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      staleSecureShareCopyJobsAborted: 1,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 0,
      staleSecureShareCopyJobsScanned: 1
    });
    expect(backend.get("notes/stale-legacy-copy")?.fields).toMatchObject({
      isDeleted: booleanValue(true),
      secureShareCopyState: stringValue("aborted")
    });
    expect(backend.pathsStartingWith("vaultIntegrity/owner-a/nameClaims/")).toHaveLength(0);
  });

  it("resumes an exact cleanup claim after a crash and removes it on abort", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    completedBackfillCursor(backend);
    addSecureShareCopyNote(
      backend,
      "stale-claimed-retry",
      "copying",
      stale,
      { reserved: 1 }
    );
    backend.add(
      "notes/stale-claimed-retry/attachments/pending-copy",
      {
        isReady: booleanValue(false),
        ownerUid: stringValue("owner-a"),
        quotaReserved: booleanValue(false),
        secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
      }
    );
    backend.failCommitContainingOnce =
      "notes/stale-claimed-retry/attachments/pending-copy";
    installBackend(backend);

    const failed = await callHandler(`Bearer ${cronSecret}`);

    expect(failed).toMatchObject({
      body: { error: "cleanup_failed", ok: false },
      status: 500
    });
    expect(
      backend.get("notes/stale-claimed-retry")?.fields
        .secureShareCopyCleanupClaimId?.stringValue
    ).toMatch(/^copy_cleanup_claim_[a-f0-9]{32}$/u);
    expect(
      backend.get("notes/stale-claimed-retry")?.fields
        .secureShareCopyCleanupClaimedAt?.timestampValue
    ).toBeTruthy();
    expect(
      backend.has("notes/stale-claimed-retry/attachments/pending-copy")
    ).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "public share cleanup failed",
      expect.objectContaining({ statusCode: 503 })
    );

    const retried = await callHandler(`Bearer ${cronSecret}`);

    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      attachmentsDeleted: 1,
      staleSecureShareCopyJobsAborted: 1,
      staleSecureShareCopyJobsRetained: 0,
      staleSecureShareCopyJobsScanned: 1
    });
    expect(
      backend.get("notes/stale-claimed-retry")?.fields.secureShareCopyState
    ).toEqual(stringValue("aborted"));
    expect(
      backend.get("notes/stale-claimed-retry")?.fields
        .secureShareCopyCleanupClaimId
    ).toBeUndefined();
    expect(
      backend.get("notes/stale-claimed-retry")?.fields
        .secureShareCopyCleanupClaimedAt
    ).toBeUndefined();
    expect(
      backend.pathsStartingWith("notes/stale-claimed-retry/history/")
    ).toHaveLength(1);
  });

  it("fails closed on a malformed cleanup claim without deleting its attachment", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    addSecureShareCopyNote(
      backend,
      "stale-malformed-claim",
      "copying",
      stale,
      { reserved: 1 }
    );
    backend.add("notes/stale-malformed-claim", {
      ...backend.get("notes/stale-malformed-claim")?.fields,
      secureShareCopyCleanupClaimId: stringValue("wrong-cleanup-claim"),
      secureShareCopyCleanupClaimedAt: timestampValue(stale)
    });
    backend.add(
      "notes/stale-malformed-claim/attachments/pending-copy",
      {
        isReady: booleanValue(false),
        ownerUid: stringValue("owner-a"),
        quotaReserved: booleanValue(false),
        secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
      }
    );
    installBackend(backend);

    const response = await callHandler(`Bearer ${cronSecret}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      attachmentsDeleted: 0,
      staleSecureShareCopyJobsAborted: 0,
      staleSecureShareCopyJobsActivated: 0,
      staleSecureShareCopyJobsRetained: 1,
      staleSecureShareCopyJobsScanned: 1
    });
    expect(
      backend.get("notes/stale-malformed-claim")?.fields.secureShareCopyState
    ).toEqual(stringValue("copying"));
    expect(
      backend.has("notes/stale-malformed-claim/attachments/pending-copy")
    ).toBe(true);
  });

  it("fails closed on a partial backend outage and safely resumes on retry", async () => {
    const backend = new FakeFirestoreRest();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    completedBackfillCursor(backend);
    backend.add("publicShareAccessSessions/expired-session", {
      expiresAt: timestampValue(expired)
    });
    backend.add("publicShareRateLimits/expired-rate", {
      expiresAt: timestampValue(expired)
    });
    backend.add("publicNoteShares/active-share", {
      expiresAt: timestampValue(future),
      status: stringValue("active")
    });
    backend.failCommitContainingOnce = "publicShareRateLimits/expired-rate";
    installBackend(backend);

    const failed = await callHandler(`Bearer ${cronSecret}`);

    expect(failed).toMatchObject({
      body: { error: "cleanup_failed", ok: false },
      status: 500
    });
    expect(backend.has("publicShareAccessSessions/expired-session")).toBe(false);
    expect(backend.has("publicShareRateLimits/expired-rate")).toBe(true);
    expect(backend.has("publicNoteShares/active-share")).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "public share cleanup failed",
      expect.objectContaining({ statusCode: 503 })
    );

    const retried = await callHandler(`Bearer ${cronSecret}`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      secureShareAccessSessionsDeleted: 0,
      secureShareRateLimitsDeleted: 1
    });
    expect(backend.has("publicShareRateLimits/expired-rate")).toBe(false);
    expect(backend.has("publicNoteShares/active-share")).toBe(true);

    const idempotent = await callHandler(`Bearer ${cronSecret}`);
    expect(idempotent.status).toBe(200);
    expect(idempotent.body).toMatchObject({
      documentDeletesAttempted: 0,
      secureShareAccessSessionsDeleted: 0,
      secureShareRateLimitsDeleted: 0
    });
  });
});
