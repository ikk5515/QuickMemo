import { afterEach, describe, expect, it, vi } from "vitest";

const guestUpdateTime = "2026-07-29T00:00:01.000000Z";
const aliceUpdateTime = "2026-07-29T00:00:02.000000Z";
const aliceRegistryUpdateTime = "2026-07-29T00:00:03.000000Z";
const shareUpdateTime = "2026-07-29T00:00:04.000000Z";
const policyUpdateTime = "2026-07-29T00:00:05.000000Z";

interface FirestoreWrite {
  currentDocument?: {
    exists?: boolean;
    updateTime?: string;
  };
  delete?: string;
  update?: {
    fields?: Record<string, unknown>;
    name: string;
  };
}

interface CommitBody {
  transaction?: string;
  writes: FirestoreWrite[];
}

interface TransactionReadBody {
  documents: string[];
  newTransaction?: {
    readWrite?: Record<string, never>;
  };
}

function firestoreValue(value: unknown): Record<string, unknown> {
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    return { integerValue: String(value) };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).flatMap(([key, child]) =>
            child === undefined ? [] : [[key, firestoreValue(child)]]
          )
        )
      }
    };
  }
  throw new TypeError("Unsupported test Firestore value");
}

function firestoreDocument(
  path: string,
  fields: Record<string, unknown>,
  updateTime: string
) {
  return {
    name: `projects/test-project/databases/(default)/documents/${path}`,
    updateTime,
    fields: Object.fromEntries(
      Object.entries(fields).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, firestoreValue(value)]]
      )
    )
  };
}

function fetchResponse(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function documentPath(documentName: string) {
  return documentName.split("/documents/")[1] ?? "";
}

function createRenameRaceHarness(
  aliceRegistryPath: string,
  bobRegistryPath: string
) {
  const participantPath = "publicShareParticipants/share-a/items/participant-a";
  const renameRequestPath =
    "publicShareParticipantRenameRequests/share-a/items/participant-a";
  const nowMilliseconds = Date.now();
  const hourStartMilliseconds =
    Math.floor(nowMilliseconds / 3_600_000) * 3_600_000;
  const dayStartMilliseconds =
    Math.floor(nowMilliseconds / 86_400_000) * 86_400_000;
  const participantFields = {
    schemaVersion: 1,
    shareId: "share-a",
    ownerUid: "owner-a",
    participantId: "participant-a",
    guestNumber: 1,
    systemDefaultName: "guest1",
    identityType: "browser",
    identityHash: "identity-a",
    participantTokenDigest: "participant-token-digest-a",
    status: "active"
  };
  const guestParticipant = firestoreDocument(participantPath, {
    ...participantFields,
    displayName: "guest1",
    normalizedDisplayName: "guest1",
    renameCount: 0,
    lastSeenAt: new Date(nowMilliseconds - 5_000),
    updatedAt: new Date(nowMilliseconds - 5_000)
  }, guestUpdateTime);
  const aliceParticipant = firestoreDocument(participantPath, {
    ...participantFields,
    displayName: "Alice",
    normalizedDisplayName: "alice",
    renameCount: 1,
    lastRenamedAt: new Date(nowMilliseconds - 61_000),
    renameHourWindowStart: new Date(hourStartMilliseconds),
    renameHourCount: 1,
    renameDayWindowStart: new Date(dayStartMilliseconds),
    renameDayCount: 1,
    lastSeenAt: new Date(nowMilliseconds - 5_000),
    updatedAt: new Date(nowMilliseconds - 61_000)
  }, aliceUpdateTime);
  const share = firestoreDocument("publicNoteShares/share-a", {
    schemaVersion: 2,
    ownerUid: "owner-a",
    sourceNoteId: "note-a",
    sourceRevision: 1,
    sourceAttachmentRevision: 0,
    ready: true,
    status: "active",
    expiresAt: new Date(nowMilliseconds + 60 * 60 * 1000),
    policyVersion: 7
  }, shareUpdateTime);
  const policy = firestoreDocument("publicSharePolicies/share-a", {
    schemaVersion: 2,
    shareId: "share-a",
    ownerUid: "owner-a",
    policyVersion: 7,
    accessMode: "anyone_with_link",
    passwordEnabled: false,
    emailVerificationRequired: false,
    oneTimeEnabled: false,
    permissionLevel: "comment",
    showCommenterIpPrefix: false,
    downloadAllowed: false,
    quickCopyButtonVisible: true
  }, policyUpdateTime);
  const ownerProfile = firestoreDocument("users/owner-a", {
    displayName: "Owner",
    isActive: true,
    isAdmin: false,
    featureAccess: { notes: true }
  }, shareUpdateTime);
  const aliceRegistry = firestoreDocument(aliceRegistryPath, {
    schemaVersion: 1,
    shareId: "share-a",
    ownerUid: "owner-a",
    participantId: "participant-a",
    createdAt: new Date(nowMilliseconds - 61_000),
    updatedAt: new Date(nowMilliseconds - 61_000)
  }, aliceRegistryUpdateTime);

  let participantPreReadCount = 0;
  let transactionReadCount = 0;
  const transactionReads: TransactionReadBody[] = [];
  const rollbacks: string[] = [];
  const commitAttempts: CommitBody[] = [];
  const registryPaths = new Set([aliceRegistryPath]);

  const transactionalDocument = (path: string) => {
    if (path === "publicNoteShares/share-a") {
      return share;
    }
    if (path === "publicSharePolicies/share-a") {
      return policy;
    }
    if (path === "users/owner-a") {
      return ownerProfile;
    }
    if (path === participantPath) {
      return aliceParticipant;
    }
    if (path === aliceRegistryPath) {
      return aliceRegistry;
    }
    if (path === bobRegistryPath || path === renameRequestPath) {
      return null;
    }
    throw new Error(`Unexpected transaction read: ${path}`);
  };

  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = decodeURIComponent(String(input));
    if (url.endsWith("/documents:batchGet")) {
      const body = JSON.parse(String(init?.body)) as TransactionReadBody;
      transactionReads.push(body);
      transactionReadCount += 1;
      const rows: Array<
        | { found: ReturnType<typeof firestoreDocument> }
        | { missing: string }
        | { transaction: string }
      > = body.documents.map((name) => {
        const document = transactionalDocument(documentPath(name));
        return document ? { found: document } : { missing: name };
      });
      rows.push({
        transaction:
          `rename-transaction-${String(transactionReadCount).padStart(4, "0")}`
      });
      return fetchResponse(200, rows);
    }

    if (url.endsWith("/documents:rollback")) {
      const body = JSON.parse(String(init?.body)) as { transaction: string };
      rollbacks.push(body.transaction);
      return fetchResponse(200);
    }

    if (url.endsWith("/documents:commit")) {
      const body = JSON.parse(String(init?.body)) as CommitBody;
      commitAttempts.push(body);
      for (const write of body.writes) {
        const updatedPath = write.update ? documentPath(write.update.name) : "";
        const deletedPath = write.delete ? documentPath(write.delete) : "";
        if (updatedPath.startsWith("publicShareParticipantNames/")) {
          registryPaths.add(updatedPath);
        }
        if (deletedPath.startsWith("publicShareParticipantNames/")) {
          registryPaths.delete(deletedPath);
        }
      }
      return fetchResponse(200, { commitTime: new Date().toISOString() });
    }

    const marker = "/documents/";
    const path = url.includes(marker)
      ? (url.split(marker)[1]?.split("?")[0] ?? "")
      : "";
    if (path === participantPath) {
      participantPreReadCount += 1;
      return fetchResponse(
        200,
        participantPreReadCount === 1 ? guestParticipant : aliceParticipant
      );
    }
    return fetchResponse(404);
  });

  return {
    commitAttempts,
    fetchMock,
    registryPaths,
    rollbacks,
    transactionReads
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Secure Share participant rename serialization", () => {
  it("re-reads a changed participant basis before replacing its name registry", async () => {
    vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "p".repeat(48));
    vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
    const {
      participantNameRegistryId,
      participantRenameSnapshotMatches,
      renameParticipant
    } = await vi.importActual<{
      participantNameRegistryId(
        shareId: string,
        normalizedDisplayName: string
      ): string;
      participantRenameSnapshotMatches(
        preReadParticipant: Record<string, unknown>,
        transactionParticipant: Record<string, unknown>
      ): boolean;
      renameParticipant(...args: unknown[]): Promise<Record<string, unknown>>;
    }>("../../api/public-shares-v2.js");
    const aliceRegistryPath =
      "publicShareParticipantNames/share-a/items/"
      + participantNameRegistryId("share-a", "alice");
    const bobRegistryPath =
      "publicShareParticipantNames/share-a/items/"
      + participantNameRegistryId("share-a", "bob");
    const harness = createRenameRaceHarness(
      aliceRegistryPath,
      bobRegistryPath
    );
    vi.stubGlobal("fetch", harness.fetchMock);

    expect(participantRenameSnapshotMatches(
      {
        __updateTime: guestUpdateTime,
        displayName: "guest1",
        normalizedDisplayName: "guest1"
      },
      {
        __updateTime: aliceUpdateTime,
        displayName: "Alice",
        normalizedDisplayName: "alice"
      }
    )).toBe(false);

    await expect(renameParticipant(
      { headers: { "user-agent": "secure-share-rename-race-test" } },
      { accessToken: "management-token", projectId: "test-project" },
      {
        share: {
          __id: "share-a",
          __updateTime: shareUpdateTime,
          schemaVersion: 2,
          ownerUid: "owner-a",
          policyVersion: 7,
          ready: true,
          status: "active",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000)
        },
        policy: {
          __id: "share-a",
          __updateTime: policyUpdateTime,
          schemaVersion: 2,
          ownerUid: "owner-a",
          policyVersion: 7,
          permissionLevel: "comment"
        }
      },
      {
        policyVersion: 7,
        identityType: "browser",
        identityHash: "identity-a"
      },
      "participant-a",
      "Bob",
      "rename-race-request-0001",
      { digest: "network-hash-a", prefix: null },
      "request-rename-race-0001"
    )).resolves.toMatchObject({
      displayName: "Bob",
      normalizedDisplayName: "bob",
      renameCount: 2
    });

    expect(harness.transactionReads).toHaveLength(2);
    expect(harness.transactionReads[0]?.documents.map(documentPath))
      .not.toContain(aliceRegistryPath);
    expect(harness.transactionReads[1]?.documents.map(documentPath))
      .toContain(aliceRegistryPath);
    expect(harness.rollbacks).toEqual(["rename-transaction-0001"]);
    expect(harness.commitAttempts).toHaveLength(1);
    expect(harness.commitAttempts[0]?.transaction)
      .toBe("rename-transaction-0002");
    expect(harness.commitAttempts[0]?.writes.some((write) =>
      write.delete
      && documentPath(write.delete) === aliceRegistryPath
      && write.currentDocument?.updateTime === aliceRegistryUpdateTime
    )).toBe(true);
    expect(harness.commitAttempts[0]?.writes.some((write) =>
      write.update
      && documentPath(write.update.name) === bobRegistryPath
      && write.currentDocument?.exists === false
    )).toBe(true);
    expect([...harness.registryPaths]).toEqual([bobRegistryPath]);
  });
});
