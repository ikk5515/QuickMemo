import { afterEach, describe, expect, it, vi } from "vitest";
import handler, {
  issueAccessSession,
  participantIdentityHash
} from "../../api/public-shares-v2.js";

const oldShareUpdateTime = "2026-07-29T00:00:01.000000Z";
const oldPolicyUpdateTime = "2026-07-29T00:00:02.000000Z";
const newShareUpdateTime = "2026-07-29T00:00:03.000000Z";
const newPolicyUpdateTime = "2026-07-29T00:00:04.000000Z";

type MutationMode = "none" | "policy_change" | "revoke";

interface TestResponse {
  body: string;
  destroyed: boolean;
  headers: Map<string, string | string[]>;
  headersSent: boolean;
  statusCode: number;
  destroy(): void;
  end(value?: unknown): void;
  setHeader(name: string, value: string | string[]): void;
}

interface FirestoreWrite {
  currentDocument?: {
    exists?: boolean;
    updateTime?: string;
  };
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

interface RaceHarnessOptions {
  consumed: boolean;
  mutationMode: MutationMode;
  participant?: {
    identityHash: string;
    identityType: string;
    participantId: string;
    participantTokenDigest: string;
  };
  permissionLevel: "comment" | "view";
}

function testResponse(): TestResponse {
  return {
    body: "",
    destroyed: false,
    headers: new Map(),
    headersSent: false,
    statusCode: 0,
    destroy() {
      this.destroyed = true;
    },
    end(value) {
      this.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    }
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

function sessionCreateCount(body: CommitBody) {
  return body.writes.filter((write) =>
    write.currentDocument?.exists === false
    && write.update?.name.includes("/publicShareAccessSessions/")
  ).length;
}

function sessionCommitBodies(bodies: CommitBody[]) {
  return bodies.filter((body) => sessionCreateCount(body) > 0);
}

function stubCoreEnvironment(participantEnabled: boolean) {
  vi.stubEnv("SECURE_SHARE_V2_ENABLED", "true");
  vi.stubEnv(
    "SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED",
    participantEnabled ? "true" : "false"
  );
  vi.stubEnv("SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED", "false");
  vi.stubEnv("SHARE_SESSION_HMAC_KEY", "s".repeat(48));
  vi.stubEnv("SHARE_COOKIE_NAME_HMAC_KEY", "k".repeat(48));
  vi.stubEnv("SHARE_CSRF_HMAC_KEY", "c".repeat(48));
  vi.stubEnv("SHARE_RATE_LIMIT_HMAC_KEY", "r".repeat(48));
  vi.stubEnv("SHARE_PARTICIPANT_HMAC_KEY", "p".repeat(48));
  vi.stubEnv("SHARE_ONE_TIME_GRACE_SECONDS", "120");
}

function createRaceHarness(options: RaceHarnessOptions) {
  let status = options.consumed ? "consumed" : "active";
  let policyVersion = 7;
  let shareUpdateTime = oldShareUpdateTime;
  let policyUpdateTime = oldPolicyUpdateTime;
  let revokedAt: Date | undefined;
  let mutationApplied = false;
  let transactionSequence = 0;
  const transactionSnapshots = new Map<string, {
    policyUpdateTime: string;
    shareUpdateTime: string;
  }>();
  const transactionReads: TransactionReadBody[] = [];
  const commitAttempts: CommitBody[] = [];
  const successfulCommits: CommitBody[] = [];
  const rollbacks: string[] = [];
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const shareDocument = () => firestoreDocument(
    "publicNoteShares/share-a",
    {
      schemaVersion: 2,
      ownerUid: "owner-a",
      sourceNoteId: "note-a",
      sourceRevision: 9,
      sourceAttachmentRevision: 4,
      ready: status !== "revoked",
      status,
      expiresAt,
      policyVersion,
      successfulAccessCount: options.consumed ? 1 : 0,
      consumedAt: options.consumed ? new Date() : undefined,
      revokedAt
    },
    shareUpdateTime
  );
  const policyDocument = () => firestoreDocument(
    "publicSharePolicies/share-a",
    {
      schemaVersion: 2,
      shareId: "share-a",
      ownerUid: "owner-a",
      policyVersion,
      accessMode: "anyone_with_link",
      passwordEnabled: false,
      emailVerificationRequired: false,
      oneTimeEnabled: options.consumed,
      permissionLevel: options.permissionLevel,
      showCommenterIpPrefix: false,
      downloadAllowed: false,
      quickCopyButtonVisible: true,
      consumedAt: options.consumed ? new Date() : undefined
    },
    policyUpdateTime
  );

  const documentForPath = (path: string) => {
    if (path === "publicNoteShares/share-a") {
      return shareDocument();
    }
    if (path === "publicSharePolicies/share-a") {
      return policyDocument();
    }
    if (path === "notes/note-a") {
      return firestoreDocument("notes/note-a", {
        ownerUid: "owner-a",
        revision: 9,
        attachmentRevision: 4,
        isDeleted: false,
        isPurged: false
      }, oldShareUpdateTime);
    }
    if (path === "users/owner-a") {
      return firestoreDocument("users/owner-a", {
        isActive: true,
        displayName: "Owner",
        featureAccess: { notes: true }
      }, oldShareUpdateTime);
    }
    if (path === "publicShareUnlockGrants/attempt-grace-0001") {
      return firestoreDocument(path, {
        shareId: "share-a",
        ownerUid: "owner-a",
        identityHash: "identity-a",
        browserBindingHash: "browser-binding-a",
        policyVersion: 7,
        status: "active",
        activeSessionDigest: "",
        graceExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
        expiresAt
      }, oldPolicyUpdateTime);
    }
    if (
      options.participant
      && path === `publicShareParticipants/share-a/items/${options.participant.participantId}`
    ) {
      return firestoreDocument(path, {
        schemaVersion: 1,
        shareId: "share-a",
        ownerUid: "owner-a",
        participantId: options.participant.participantId,
        guestNumber: 1,
        systemDefaultName: "guest1",
        displayName: "guest1",
        normalizedDisplayName: "guest1",
        identityType: options.participant.identityType,
        identityHash: options.participant.identityHash,
        participantTokenDigest: options.participant.participantTokenDigest,
        status: "active",
        lastSeenAt: new Date(),
        updatedAt: new Date()
      }, oldPolicyUpdateTime);
    }
    return null;
  };

  const applyConcurrentOwnerMutation = () => {
    if (mutationApplied || options.mutationMode === "none") {
      return;
    }
    mutationApplied = true;
    policyVersion = 8;
    shareUpdateTime = newShareUpdateTime;
    policyUpdateTime = newPolicyUpdateTime;
    if (options.mutationMode === "revoke") {
      status = "revoked";
      revokedAt = new Date();
    }
  };

  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = decodeURIComponent(String(input));

    if (url.includes("/accounts:lookup")) {
      return fetchResponse(200, {
        users: [{
          localId: "owner-a",
          email: "owner@example.com",
          emailVerified: true,
          displayName: "Owner",
          providerUserInfo: [{ providerId: "password" }]
        }]
      });
    }

    if (url.endsWith("/documents:batchGet")) {
      const body = JSON.parse(String(init?.body)) as TransactionReadBody;
      transactionReads.push(body);
      const rows: Array<
        | { found: ReturnType<typeof firestoreDocument> }
        | { missing: string }
        | { transaction: string }
      > = body.documents.map((name) => {
        const document = documentForPath(documentPath(name));
        return document ? { found: document } : { missing: name };
      });
      if (body.newTransaction) {
        transactionSequence += 1;
        const transaction = `transaction-${String(transactionSequence).padStart(4, "0")}`;
        transactionSnapshots.set(transaction, {
          policyUpdateTime,
          shareUpdateTime
        });
        rows.push({ transaction });
      }
      return fetchResponse(200, rows);
    }

    if (url.endsWith("/documents:commit")) {
      const body = JSON.parse(String(init?.body)) as CommitBody;
      commitAttempts.push(body);
      if (sessionCreateCount(body) > 0) {
        applyConcurrentOwnerMutation();
      }
      const snapshot = body.transaction
        ? transactionSnapshots.get(body.transaction)
        : undefined;
      if (
        snapshot
        && (
          snapshot.shareUpdateTime !== shareUpdateTime
          || snapshot.policyUpdateTime !== policyUpdateTime
        )
      ) {
        return fetchResponse(409, { error: { status: "ABORTED" } });
      }
      successfulCommits.push(body);
      return fetchResponse(200, { commitTime: new Date().toISOString() });
    }

    if (url.endsWith("/documents:rollback")) {
      const body = JSON.parse(String(init?.body)) as { transaction: string };
      rollbacks.push(body.transaction);
      return fetchResponse(200);
    }

    const marker = "/documents/";
    const path = url.includes(marker)
      ? (url.split(marker)[1]?.split("?")[0] ?? "")
      : "";
    const document = documentForPath(path);
    return document ? fetchResponse(200, document) : fetchResponse(404);
  });

  return {
    commitAttempts,
    fetchMock,
    rollbacks,
    successfulCommits,
    transactionReads
  };
}

function oneTimeIdentity(participantEnabled: boolean) {
  const token = "participant-token-0001";
  const identityHash = participantEnabled
    ? participantIdentityHash("share-a", "browser", token)
    : "";
  const participantId = identityHash ? `p_${identityHash.slice(0, 48)}` : "";
  return {
    identity: {
      authorUid: "",
      challenge: null,
      displayName: "Guest",
      identityHash: "identity-a",
      identityType: "browser",
      participantIdentityHash: identityHash,
      participantToken: participantEnabled ? token : "",
      participantTokenDigest: participantEnabled ? "participant-token-digest-a" : "",
      setParticipantCookie: participantEnabled
    },
    participant: participantEnabled
      ? {
          identityHash,
          identityType: "browser",
          participantId,
          participantTokenDigest: "participant-token-digest-a"
        }
      : undefined
  };
}

async function requestOwnerPreview(harness: ReturnType<typeof createRaceHarness>) {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
  vi.stubEnv("GCLOUD_PROJECT", "test-project");
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  vi.stubEnv("FIREBASE_APP_CHECK_ENFORCEMENT", "off");
  vi.stubGlobal("fetch", harness.fetchMock);

  const metadataResponse = testResponse();
  await handler({
    method: "GET",
    url: "/api/public-shares-v2?action=metadata&shareId=share-a",
    headers: {
      host: "localhost:3000",
      "user-agent": "secure-share-race-test"
    }
  }, metadataResponse);
  expect(metadataResponse.statusCode).toBe(200);
  const setCookies = metadataResponse.headers.get("set-cookie");
  const browserBindingCookie = (Array.isArray(setCookies) ? setCookies[0] : setCookies)
    ?.split(";")[0] ?? "";
  expect(browserBindingCookie).toMatch(/^qmsb_[A-Za-z0-9_-]+=[A-Za-z0-9_-]{40,200}$/u);

  const accessResponse = testResponse();
  await handler({
    method: "POST",
    url: "/api/public-shares-v2?action=access&shareId=share-a",
    headers: {
      authorization: "Bearer owner-id-token-00000001",
      cookie: browserBindingCookie,
      "content-type": "application/json",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "user-agent": "secure-share-race-test"
    },
    body: {
      ownerPreview: true,
      unlockAttemptId: "owner-preview-attempt-0001"
    }
  }, accessResponse);
  return accessResponse;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Secure Share v2 revoke serialization", () => {
  it.each([
    {
      label: "participant flags off",
      mutationMode: "revoke" as const,
      participantEnabled: false,
      expectedCode: "share_unavailable"
    },
    {
      label: "reusable participant fast path",
      mutationMode: "policy_change" as const,
      participantEnabled: true,
      expectedCode: "policy_changed"
    }
  ])(
    "does not commit a one-time grace session after a concurrent owner change ($label)",
    async ({ expectedCode, mutationMode, participantEnabled }) => {
      stubCoreEnvironment(participantEnabled);
      const { identity, participant } = oneTimeIdentity(participantEnabled);
      const harness = createRaceHarness({
        consumed: true,
        mutationMode,
        participant,
        permissionLevel: participantEnabled ? "comment" : "view"
      });
      vi.stubGlobal("fetch", harness.fetchMock);

      await expect(issueAccessSession(
        { headers: { "user-agent": "secure-share-race-test" } },
        { accessToken: "management-token", projectId: "test-project" },
        "share-a",
        7,
        identity,
        "browser-binding-a",
        "attempt-grace-0001",
        "network-hash-a",
        "request-race-0001"
      )).rejects.toMatchObject({ code: expectedCode });

      expect(harness.transactionReads).toHaveLength(1);
      expect(harness.transactionReads[0]?.documents.map(documentPath)).toEqual([
        "publicNoteShares/share-a",
        "publicSharePolicies/share-a"
      ]);
      const sessionAttempts = sessionCommitBodies(harness.commitAttempts);
      expect(sessionAttempts).toHaveLength(1);
      expect(sessionAttempts[0]?.transaction).toMatch(/^transaction-/u);
      expect(sessionCreateCount(sessionAttempts[0] as CommitBody)).toBe(1);
      expect(sessionCommitBodies(harness.successfulCommits)).toHaveLength(0);
      expect(harness.rollbacks).toEqual([sessionAttempts[0]?.transaction]);
    }
  );

  it.each([
    { label: "revoke", mutationMode: "revoke" as const },
    { label: "policy change", mutationMode: "policy_change" as const }
  ])(
    "does not commit an owner-preview session after a concurrent $label",
    async ({ mutationMode }) => {
      stubCoreEnvironment(false);
      const harness = createRaceHarness({
        consumed: false,
        mutationMode,
        permissionLevel: "view"
      });

      const response = await requestOwnerPreview(harness);

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        error: "request_conflict"
      });
      expect(harness.transactionReads).toHaveLength(1);
      const sessionAttempts = sessionCommitBodies(harness.commitAttempts);
      expect(sessionAttempts).toHaveLength(1);
      expect(sessionAttempts[0]?.transaction).toMatch(/^transaction-/u);
      expect(sessionCreateCount(sessionAttempts[0] as CommitBody)).toBe(1);
      expect(sessionCommitBodies(harness.successfulCommits)).toHaveLength(0);
      expect(harness.rollbacks).toEqual([sessionAttempts[0]?.transaction]);
    }
  );

  it("keeps normal one-time grace and owner-preview issuance working", async () => {
    stubCoreEnvironment(false);
    const { identity } = oneTimeIdentity(false);
    const graceHarness = createRaceHarness({
      consumed: true,
      mutationMode: "none",
      permissionLevel: "view"
    });
    vi.stubGlobal("fetch", graceHarness.fetchMock);

    await expect(issueAccessSession(
      { headers: { "user-agent": "secure-share-race-test" } },
      { accessToken: "management-token", projectId: "test-project" },
      "share-a",
      7,
      identity,
      "browser-binding-a",
      "attempt-grace-0001",
      "network-hash-a",
      "request-normal-0001"
    )).resolves.toMatchObject({
      participantIdentityEnabled: false,
      policy: { policyVersion: 7 }
    });
    const graceSessionCommits = sessionCommitBodies(graceHarness.successfulCommits);
    expect(graceSessionCommits).toHaveLength(1);
    expect(graceSessionCommits[0]?.transaction).toMatch(/^transaction-/u);
    expect(sessionCreateCount(graceSessionCommits[0] as CommitBody)).toBe(1);

    const ownerHarness = createRaceHarness({
      consumed: false,
      mutationMode: "none",
      permissionLevel: "view"
    });
    const ownerResponse = await requestOwnerPreview(ownerHarness);

    expect(ownerResponse.statusCode).toBe(200);
    expect(JSON.parse(ownerResponse.body)).toMatchObject({
      ok: true,
      ownerPreview: true
    });
    const ownerSessionCommits = sessionCommitBodies(ownerHarness.successfulCommits);
    expect(ownerSessionCommits).toHaveLength(1);
    expect(ownerSessionCommits[0]?.transaction).toMatch(/^transaction-/u);
    expect(sessionCreateCount(ownerSessionCommits[0] as CommitBody)).toBe(1);
  });
});
