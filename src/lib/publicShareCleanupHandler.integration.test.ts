import { generateKeyPairSync, webcrypto } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cleanupHandler, {
  type CleanupHttpRequest,
  type CleanupHttpResponse
} from "../../api/cleanup-public-shares.js";

type FirestoreValue = {
  arrayValue?: { values?: FirestoreValue[] };
  booleanValue?: boolean;
  integerValue?: number | string;
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
  "LEGACY_NOTE_BACKFILL_MAX_SCANNED",
  "LEGACY_NOTE_BACKFILL_PAGE_SIZE",
  "PUBLIC_SHARE_CLEANUP_BATCH_SIZE",
  "PUBLIC_SHARE_CLEANUP_MAX_DELETES"
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
  failCommitContainingOnce = "";
  raceAbortDocumentOnce = "";
  raceCleanupClaimHeartbeatDocumentOnce = "";
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
    return typeof write.delete === "string" ? write.delete : update?.name ?? "";
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
      this.failCommitContainingOnce
      && writes.some((write) =>
        this.writeDocumentName(write).includes(this.failCommitContainingOnce)
      )
    ) {
      this.failCommitContainingOnce = "";
      return this.json({ error: { status: "UNAVAILABLE" } }, 503);
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
) {
  const ownerUid = String(overrides.ownerUid ?? "owner-a");
  return {
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
    type: stringValue("personal")
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
    process.env.LEGACY_NOTE_BACKFILL_MAX_SCANNED = "10";
    process.env.LEGACY_NOTE_BACKFILL_PAGE_SIZE = "10";
    process.env.PUBLIC_SHARE_CLEANUP_BATCH_SIZE = "50";
    process.env.PUBLIC_SHARE_CLEANUP_MAX_DELETES = "1000";
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
    backend.add("notes/stale-incomplete", secureShareCopyNote("copying", stale, {
      reserved: 1
    }));
    backend.add("notes/stale-incomplete/attachments/pending-copy", {
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-a"),
      quotaReserved: booleanValue(false),
      secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
    });
    backend.add("notes/stale-complete", secureShareCopyNote("copying", stale, {
      expected: 1,
      ready: 1,
      reserved: 1
    }));
    backend.add("notes/fresh-copy", secureShareCopyNote("copying", fresh));
    backend.add("notes/other-participant-copy", secureShareCopyNote("copying", stale, {
      participantUids: ["owner-a", "owner-b"]
    }));
    backend.add("notes/foreign-attachment-copy", secureShareCopyNote("copying", stale, {
      reserved: 1
    }));
    backend.add("notes/foreign-attachment-copy/attachments/foreign-copy", {
      isReady: booleanValue(false),
      ownerUid: stringValue("owner-b"),
      quotaReserved: booleanValue(false),
      secureShareCopyJobId: stringValue("copy_job_handler_test_1234")
    });
    const racingName = backend.add("notes/racing-copy", secureShareCopyNote("copying", stale));
    backend.add("notes/already-active", secureShareCopyNote("active", stale));
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
      secureShareRateLimitsDeleted: 1,
      staleSecureShareCopyJobsAborted: 1,
      staleSecureShareCopyJobsActivated: 1,
      staleSecureShareCopyJobsRetained: 3,
      staleSecureShareCopyJobsScanned: 5
    });
    expect(backend.has("publicShareEmailChallenges/expired-otp")).toBe(false);
    expect(backend.has("publicShareAccessSessions/expired-session")).toBe(false);
    expect(backend.has("publicShareRateLimits/expired-rate")).toBe(false);
    expect(backend.has("publicShareAuditEvents/share-a/items/expired-audit")).toBe(false);
    expect(backend.has("publicShareEmailChallenges/active-otp")).toBe(true);
    expect(backend.has("publicShareAccessSessions/active-session")).toBe(true);
    expect(backend.has("publicShareRateLimits/active-rate")).toBe(true);
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
    expect(backend.get("notes/stale-complete")?.fields.secureShareCopyState).toEqual(
      stringValue("active")
    );
    expect(backend.get("notes/stale-complete")?.fields.isDeleted).toEqual(
      booleanValue(false)
    );
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
      secureShareRateLimitsDeleted: 0,
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

  it("bounds global stale-copy recovery to twenty jobs per cron invocation", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    completedBackfillCursor(backend);
    for (let index = 0; index < 21; index += 1) {
      backend.add(`notes/stale-complete-${String(index).padStart(2, "0")}`, secureShareCopyNote(
        "copying",
        stale,
        { expected: 1, ready: 1, reserved: 1 }
      ));
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
    const heartbeatNoteName = backend.add(
      "notes/stale-heartbeat-race",
      secureShareCopyNote("copying", stale)
    );
    const readyNoteName = backend.add(
      "notes/stale-ready-race",
      secureShareCopyNote("copying", stale, { reserved: 1 })
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

  it("resumes an exact cleanup claim after a crash and removes it on abort", async () => {
    const backend = new FakeFirestoreRest();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    completedBackfillCursor(backend);
    backend.add(
      "notes/stale-claimed-retry",
      secureShareCopyNote("copying", stale, { reserved: 1 })
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
    backend.add("notes/stale-malformed-claim", {
      ...secureShareCopyNote("copying", stale, { reserved: 1 }),
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
