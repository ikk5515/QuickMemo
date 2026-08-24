import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareVaultPathRewriteJob, type PreparedVaultPathRewriteJob } from "../features/vault/pathRewriteJob";
import {
  activateVaultPathRewriteJob,
  beginTerminalVaultPathRewriteCleanupSession,
  cleanupRetainedTerminalVaultPathRewriteJobs,
  drainTerminalVaultPathRewriteJobs,
  ensureVaultPathRewriteJob,
  listRecoverableVaultPathRewriteJobs,
  listResumableVaultPathRewriteJobs,
  loadVaultPathRewriteJob,
  recoverPreparedVaultPathRewriteJob,
  resumeVaultPathRewriteJob,
  scanRecoverableVaultPathRewriteJobs,
  scheduleTerminalVaultPathRewriteCleanup
} from "./vaultPathRewriteJobs";

const firestoreMocks = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const clock = { now: Date.now() };
  const db = { __type: "firestore" };
  const pathFrom = (parts: unknown[]) => parts
    .filter((part) => part !== db)
    .map((part) => typeof part === "object" && part && "path" in part
      ? String((part as { path: unknown }).path)
      : String(part))
    .join("/");
  const reference = (path: string) => ({ id: path.split("/").at(-1), path });
  const snapshot = (path: string) => ({
    id: path.split("/").at(-1),
    ref: reference(path),
    exists: () => documents.has(path),
    data: () => documents.get(path)
  });
  const transaction = {
    get: vi.fn(async (target: { path: string }) => snapshot(target.path)),
    set: vi.fn((target: { path: string }, value: Record<string, unknown>) => {
      documents.set(target.path, value);
    }),
    update: vi.fn((target: { path: string }, value: Record<string, unknown>) => {
      const next = { ...documents.get(target.path), ...value };
      for (const [key, candidate] of Object.entries(next)) {
        if ((candidate as { __type?: unknown })?.__type === "deleteField") delete next[key];
      }
      documents.set(target.path, next);
    }),
    delete: vi.fn((target: { path: string }) => {
      documents.delete(target.path);
    })
  };
  const batchCommit = vi.fn();
  return {
    batchCommit,
    collection: vi.fn((...parts: unknown[]) => reference(pathFrom(parts))),
    db,
    deleteDoc: vi.fn(async (target: { path: string }) => {
      documents.delete(target.path);
    }),
    deleteField: vi.fn(() => ({ __type: "deleteField" })),
    doc: vi.fn((...parts: unknown[]) => reference(pathFrom(parts))),
    documents,
    getDoc: vi.fn(async (target: { path: string }) => snapshot(target.path)),
    getDocs: vi.fn(async (target: {
      constraints?: Array<{ field?: string; type: string; value?: unknown }>;
      path: string;
    }) => {
      const prefix = `${target.path}/`;
      let docs = [...documents.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .sort()
        .map(snapshot);
      for (const constraint of target.constraints ?? []) {
        if (constraint.type === "where-in" && constraint.field) {
          docs = docs.filter((item) => (constraint.value as unknown[]).includes(item.data()?.[constraint.field!]));
        }
        if (constraint.type === "where-eq" && constraint.field) {
          docs = docs.filter((item) => item.data()?.[constraint.field!] === constraint.value);
        }
        if (constraint.type === "order-by" && constraint.field) {
          docs.sort((left, right) => {
            const leftValue = left.data()?.[constraint.field!];
            const rightValue = right.data()?.[constraint.field!];
            const leftMillis = typeof (leftValue as { toMillis?: unknown })?.toMillis === "function"
              ? (leftValue as { toMillis: () => number }).toMillis()
              : 0;
            const rightMillis = typeof (rightValue as { toMillis?: unknown })?.toMillis === "function"
              ? (rightValue as { toMillis: () => number }).toMillis()
              : 0;
            return leftMillis - rightMillis;
          });
        }
        if (constraint.type === "limit") {
          docs = docs.slice(0, constraint.value as number);
        }
      }
      return { docs, size: docs.length, forEach: (visit: (item: ReturnType<typeof snapshot>) => void) => docs.forEach(visit) };
    }),
    limit: vi.fn((value: number) => ({ type: "limit", value })),
    orderBy: vi.fn((field: string, direction: string) => ({ direction, field, type: "order-by" })),
    query: vi.fn((target: { path: string }, ...constraints: Array<{ type: string }>) => ({
      ...target,
      constraints
    })),
    runTransaction: vi.fn(async (_db: unknown, operation: (value: typeof transaction) => unknown) => operation(transaction)),
    serverTimestamp: vi.fn(() => {
      const writtenAt = clock.now;
      return { __type: "serverTimestamp", toMillis: () => writtenAt };
    }),
    transaction,
    where: vi.fn((field: string, operation: string, value: unknown) => ({
      field,
      operation,
      type: operation === "in" ? "where-in" : operation === "==" ? "where-eq" : "where",
      value
    })),
    writeBatch: vi.fn(() => {
      const pending: Array<
        | { action: "delete"; path: string }
        | { action: "set"; path: string; value: Record<string, unknown> }
      > = [];
      return {
        delete: (target: { path: string }) => pending.push({ action: "delete", path: target.path }),
        set: (target: { path: string }, value: Record<string, unknown>) => pending.push({
          action: "set",
          path: target.path,
          value
        }),
        commit: async () => {
          await batchCommit();
          for (const item of pending) {
            if (item.action === "delete") documents.delete(item.path);
            else documents.set(item.path, item.value);
          }
        }
      };
    }),
    clock
  };
});

const cryptoMocks = vi.hoisted(() => {
  let keyCounter = 0;
  const keyByWrappedValue = new Map<string, { id: string }>();
  return {
    decryptText: vi.fn(async (payload: { cipherText: string }) => atob(payload.cipherText)),
    encryptText: vi.fn(async (value: string) => ({
      version: 1 as const,
      algorithm: "AES-GCM" as const,
      cipherText: btoa(value),
      iv: "test-iv"
    })),
    generateNoteKey: vi.fn(async () => ({ id: `job-key-${++keyCounter}` })),
    keyByWrappedValue,
    unwrapNoteKey: vi.fn(async (wrapped: { wrappedKey: string }) => {
      const key = keyByWrappedValue.get(wrapped.wrappedKey);
      if (!key) throw new Error("missing test job key");
      return key;
    }),
    wrapNoteKey: vi.fn(async (key: { id: string }) => {
      const wrappedKey = `wrapped-${key.id}`;
      keyByWrappedValue.set(wrappedKey, key);
      return { version: 1 as const, algorithm: "RSA-OAEP" as const, wrappedKey };
    })
  };
});

vi.mock("../lib/firebase", () => ({ db: firestoreMocks.db }));
vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  deleteField: firestoreMocks.deleteField,
  deleteDoc: firestoreMocks.deleteDoc,
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  getDocs: firestoreMocks.getDocs,
  limit: firestoreMocks.limit,
  orderBy: firestoreMocks.orderBy,
  query: firestoreMocks.query,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  where: firestoreMocks.where,
  writeBatch: firestoreMocks.writeBatch
}));
vi.mock("../lib/crypto", () => ({
  bytesToBase64: (value: ArrayBuffer | Uint8Array) => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return btoa(String.fromCharCode(...bytes));
  },
  decryptText: cryptoMocks.decryptText,
  encryptText: cryptoMocks.encryptText,
  generateNoteKey: cryptoMocks.generateNoteKey,
  unwrapNoteKey: cryptoMocks.unwrapNoteKey,
  wrapNoteKey: cryptoMocks.wrapNoteKey
}));

const profile = { uid: "user-a", publicKeyJwk: { kty: "RSA", n: "public", e: "AQAB" } };
const privateKey = { id: "private-key" } as unknown as CryptoKey;
let integrityKey: CryptoKey;
const inventoryFingerprint = "I".repeat(43);

async function preparedJob(stepCount = 2): Promise<PreparedVaultPathRewriteJob> {
  return prepareVaultPathRewriteJob(integrityKey, {
    inventoryFingerprint,
    mutationTarget: {
      expectedRevision: 4,
      id: "target-a",
      kind: "entry"
    },
    ownerUid: "user-a",
    pathChanges: [{ entryId: "target-a", oldPath: "Private/Old.md", newPath: "Archive/New.md" }],
    sourcePlans: Array.from({ length: stepCount }, (_, index) => ({
      sourceEntryId: `source-${index}`,
      sourceKind: index % 2 ? "canvas" as const : "markdown" as const,
      expectedRevision: index + 3,
      originalSource: `private original ${index} [[Private/Old]]`,
      rewrittenSource: `private rewritten ${index} [[Archive/New]]`,
      changeCount: 1
    }))
  });
}

async function preparedManifestJob(stepCount = 1): Promise<PreparedVaultPathRewriteJob> {
  return prepareVaultPathRewriteJob(integrityKey, {
    inventoryManifest: {
      version: 1,
      epoch: 7,
      shardCount: 32,
      root: "M".repeat(43)
    },
    mutationTarget: {
      expectedRevision: 4,
      id: "target-a",
      kind: "entry"
    },
    ownerUid: "user-a",
    pathChanges: [{ entryId: "target-a", oldPath: "Private/Old.md", newPath: "Archive/New.md" }],
    sourcePlans: Array.from({ length: stepCount }, (_, index) => ({
      sourceEntryId: `manifest-source-${index}`,
      sourceKind: "markdown" as const,
      expectedRevision: index + 3,
      originalSource: `manifest original ${index} [[Private/Old]]`,
      rewrittenSource: `manifest rewritten ${index} [[Archive/New]]`,
      changeCount: 1
    }))
  });
}

function atomicallyCommitPreparedJob(prepared: PreparedVaultPathRewriteJob) {
  const path = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
  const stored = firestoreMocks.documents.get(path);
  if (!stored || stored.status !== "prepared") throw new Error("test job is not prepared");
  const timestamp = firestoreMocks.serverTimestamp();
  firestoreMocks.documents.set(path, {
    ...stored,
    activatedAt: timestamp,
    revision: Number(stored.revision) + 1,
    status: "ready",
    updatedAt: timestamp
  });
}

async function activatePreparedAtomicJob(prepared: PreparedVaultPathRewriteJob) {
  atomicallyCommitPreparedJob(prepared);
  return activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId);
}

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  }
  integrityKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  firestoreMocks.documents.clear();
  cryptoMocks.keyByWrappedValue.clear();
  firestoreMocks.batchCommit.mockResolvedValue(undefined);
  firestoreMocks.clock.now = Date.now();
  beginTerminalVaultPathRewriteCleanupSession("user-a");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("encrypted durable Vault path rewrite persistence", () => {
  it("persists and recovers pr3 jobs with an exact encrypted manifest binding", async () => {
    const prepared = await preparedManifestJob(0);
    expect(prepared.jobId).toMatch(/^pr3_[A-Za-z0-9_-]{43}$/u);

    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({
      jobId: prepared.jobId,
      status: "prepared",
      stepCount: 0
    });
    const storedPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    expect(firestoreMocks.documents.get(storedPath)).toMatchObject({
      activationMode: "atomic-manifest-v1",
      inventoryManifestVersion: 1,
      inventoryManifestEpoch: 7,
      inventoryManifestShardCount: 32,
      inventoryManifestRoot: "M".repeat(43)
    });
    expect(firestoreMocks.documents.get(storedPath)).not.toHaveProperty("inventoryFingerprint");
    await expect(activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId))
      .rejects.toMatchObject({ code: "not-ready" });

    atomicallyCommitPreparedJob(prepared);
    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: vi.fn(),
      applyStep: vi.fn()
    })).resolves.toMatchObject({ status: "completed", processedSteps: 0 });
  });

  it("rejects a pr3 root that no longer matches its encrypted manifest", async () => {
    const prepared = await preparedManifestJob(0);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const storedPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    firestoreMocks.documents.set(storedPath, {
      ...firestoreMocks.documents.get(storedPath),
      inventoryManifestRoot: "N".repeat(43)
    });
    await expect(loadVaultPathRewriteJob("user-a", privateKey, prepared.jobId))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("prepares every encrypted step before ready and stores no plaintext path, title, or source", async () => {
    const prepared = await preparedJob();

    const created = await ensureVaultPathRewriteJob(profile, privateKey, prepared);

    expect(created).toMatchObject({ status: "prepared", stepCount: 2, cursor: 0, revision: 3 });
    const persisted = JSON.stringify([...firestoreMocks.documents]);
    expect(persisted).not.toContain("Private/Old.md");
    expect(persisted).not.toContain("Archive/New.md");
    expect(persisted).not.toContain("private original");
    expect(persisted).not.toContain("private rewritten");
    expect(persisted).toContain(prepared.jobId);

    const firstWriteCount = firestoreMocks.documents.size;
    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({ status: "prepared" });
    expect(firestoreMocks.documents.size).toBe(firstWriteCount);
  });

  it("creates a zero-step atomic job directly as prepared without a redundant transition", async () => {
    const prepared = await preparedJob(0);

    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({
      revision: 1,
      status: "prepared",
      stepCount: 0
    });
    expect(firestoreMocks.documents.get(
      `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`
    )).toMatchObject({ preparedStepCount: 0, revision: 1, status: "prepared" });
    // One bounded root-capacity query is required for a new job. No empty
    // child-step enumeration or final preparation transaction is needed.
    expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves interrupted preparation non-runnable and fills missing steps on a deterministic retry", async () => {
    const prepared = await preparedJob();
    firestoreMocks.batchCommit.mockRejectedValueOnce(new Error("offline"));

    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).rejects.toThrow("offline");
    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => null,
      applyStep: vi.fn()
    })).rejects.toMatchObject({ code: "not-ready" });

    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({ status: "prepared" });
    expect([...firestoreMocks.documents.values()].filter((value) => "encryptedStep" in value)).toHaveLength(2);
    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => null,
      applyStep: vi.fn()
    })).rejects.toMatchObject({ code: "not-ready" });
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);
    await expect(listRecoverableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([
      expect.objectContaining({
        jobId: prepared.jobId,
        status: "prepared",
        recoveryAfterMs: expect.any(Number)
      })
    ]);
  });

  it("preserves the legacy 50-job recovery contract while capping new atomic jobs separately", async () => {
    const first = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, first);
    const firstPath = `vaultMaintenanceJobs/user-a/pathRewrites/${first.jobId}`;
    const template = firestoreMocks.documents.get(firstPath)!;
    firestoreMocks.documents.clear();
    for (let index = 0; index < 50; index += 1) {
      const legacyId = `pr1_${`legacy-${String(index).padStart(2, "0")}-`.padEnd(43, "0")}`;
      const legacy = { ...template };
      delete legacy.activationMode;
      delete legacy.inventoryFingerprint;
      delete legacy.preparedStepCount;
      delete legacy.mutationExpectedRevision;
      delete legacy.mutationTargetId;
      delete legacy.mutationTargetKind;
      const legacyManifest = JSON.parse(atob(String(
        (legacy.encryptedManifest as { cipherText: string }).cipherText
      ))) as Record<string, unknown>;
      delete legacyManifest.inventoryFingerprint;
      legacy.encryptedManifest = {
        ...(legacy.encryptedManifest as Record<string, unknown>),
        cipherText: btoa(JSON.stringify(legacyManifest))
      };
      firestoreMocks.documents.set(`vaultMaintenanceJobs/user-a/pathRewrites/${legacyId}`, {
        ...legacy,
        planFingerprint: legacyId,
        recoveryCheckCount: 1,
        lastRecoveryCheckAt: firestoreMocks.serverTimestamp(),
        status: "not-applied"
      });
    }
    const next = await preparedJob(2);
    await expect(ensureVaultPathRewriteJob(profile, privateKey, next)).resolves.toMatchObject({
      jobId: next.jobId,
      status: "prepared"
    });
    expect(firestoreMocks.limit).toHaveBeenCalledWith(59);

    const atomicTemplate = firestoreMocks.documents.get(
      `vaultMaintenanceJobs/user-a/pathRewrites/${next.jobId}`
    )!;
    for (let index = 0; index < 7; index += 1) {
      const atomicId = `pr2_${`atomic-${index}`.padEnd(43, "0")}`;
      firestoreMocks.documents.set(`vaultMaintenanceJobs/user-a/pathRewrites/${atomicId}`, {
        ...atomicTemplate,
        planFingerprint: atomicId
      });
    }
    const third = await prepareVaultPathRewriteJob(integrityKey, {
      inventoryFingerprint,
      mutationTarget: { expectedRevision: 9, id: "target-b", kind: "entry" },
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-b", oldPath: "Old.md", newPath: "New.md" }],
      sourcePlans: []
    });
    await expect(ensureVaultPathRewriteJob(profile, privateKey, third)).rejects.toMatchObject({ code: "conflict" });

    // A ninth atomic job can appear when several tabs pass the advisory count
    // before any of their create transactions commit. Recovery remains a
    // bounded continuation instead of classifying this valid backlog corrupt.
    const overflowAtomicId = `pr2_${"concurrent-overflow".padEnd(43, "0")}`;
    firestoreMocks.documents.set(`vaultMaintenanceJobs/user-a/pathRewrites/${overflowAtomicId}`, {
      ...atomicTemplate,
      planFingerprint: overflowAtomicId
    });
    await expect(scanRecoverableVaultPathRewriteJobs("user-a", privateKey)).resolves.toMatchObject({
      hasMore: true,
      jobs: expect.arrayContaining([
        expect.objectContaining({ status: "not-applied" }),
        expect.objectContaining({ status: "prepared" })
      ])
    });
  });

  it("defers a fresh legacy preparing job then abandons and cleans it after the wider stale fence", async () => {
    const prepared = await preparedJob(0);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const atomicPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    const legacyJobId = `pr1_${"legacy-preparing".padEnd(43, "0")}`;
    const legacyPath = `vaultMaintenanceJobs/user-a/pathRewrites/${legacyJobId}`;
    const legacy = { ...firestoreMocks.documents.get(atomicPath) };
    delete legacy.activationMode;
    delete legacy.inventoryFingerprint;
    delete legacy.preparedStepCount;
    delete legacy.mutationExpectedRevision;
    delete legacy.mutationTargetId;
    delete legacy.mutationTargetKind;
    const legacyManifest = JSON.parse(atob(String(
      (legacy.encryptedManifest as { cipherText: string }).cipherText
    ))) as Record<string, unknown>;
    delete legacyManifest.inventoryFingerprint;
    legacy.encryptedManifest = {
      ...(legacy.encryptedManifest as Record<string, unknown>),
      cipherText: btoa(JSON.stringify(legacyManifest))
    };
    firestoreMocks.documents.clear();
    firestoreMocks.documents.set(legacyPath, {
      ...legacy,
      planFingerprint: legacyJobId,
      status: "preparing"
    });

    const readCurrentPaths = vi.fn();
    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: legacyJobId,
      readCurrentPaths
    })).resolves.toMatchObject({
      recovery: "deferred",
      job: { recoveryAfterMs: expect.any(Number), status: "preparing" }
    });
    expect(readCurrentPaths).not.toHaveBeenCalled();

    firestoreMocks.documents.set(legacyPath, {
      ...firestoreMocks.documents.get(legacyPath),
      updatedAt: { toMillis: () => Date.now() - 15 * 60_000 - 1 }
    });
    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: legacyJobId,
      readCurrentPaths
    })).resolves.toMatchObject({ recovery: "not-applied", job: { status: "abandoned" } });
    expect(readCurrentPaths).not.toHaveBeenCalled();
    await scheduleTerminalVaultPathRewriteCleanup("user-a");
    expect(firestoreMocks.documents.has(legacyPath)).toBe(false);
  });

  it("keeps zero-source activation as durable ready proof until the client acknowledges completion", async () => {
    vi.useFakeTimers();
    const prepared = await preparedJob(0);
    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({
      status: "prepared",
      stepCount: 0
    });
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);
    await expect(activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId))
      .rejects.toMatchObject({ code: "not-ready" });
    await expect(activatePreparedAtomicJob(prepared)).resolves.toMatchObject({
      status: "ready",
      cursor: 0,
      stepCount: 0
    });
    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: vi.fn(),
      applyStep: vi.fn()
    })).resolves.toMatchObject({
      status: "completed",
      cursor: 0,
      processedSteps: 0
    });
    const retained = await cleanupRetainedTerminalVaultPathRewriteJobs("user-a");
    expect(retained).toMatchObject({ cleanedJobs: 0, hasMore: true });
    expect(retained.retryAfterMs).toBeGreaterThan(0);
    expect(retained.retryAfterMs).toBeLessThanOrEqual(2 * 60_000);
    expect(firestoreMocks.documents.has(
      `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`
    )).toBe(true);
    firestoreMocks.clock.now += 2 * 60_000;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await drainTerminalVaultPathRewriteJobs("user-a");
    expect(firestoreMocks.documents.has(
      `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`
    )).toBe(false);
  });

  it("recovers a lost HTTP response from the atomically committed ready job without rereading paths", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    atomicallyCommitPreparedJob(prepared);
    const readCurrentPaths = vi.fn();
    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths
    })).resolves.toMatchObject({ recovery: "activated", job: { status: "ready" } });
    expect(readCurrentPaths).not.toHaveBeenCalled();
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([
      expect.objectContaining({ jobId: prepared.jobId, status: "ready" })
    ]);
  });

  it("preserves an atomic ready receipt that wins the recovery transaction race", async () => {
    const prepared = await preparedJob(0);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const storedPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    firestoreMocks.documents.set(storedPath, {
      ...firestoreMocks.documents.get(storedPath),
      updatedAt: { toMillis: () => Date.now() - 2 * 60_000 - 1 }
    });
    firestoreMocks.transaction.get.mockImplementationOnce(async (target: { path: string }) => {
      const current = firestoreMocks.documents.get(target.path)!;
      const activated = {
        ...current,
        revision: Number(current.revision) + 1,
        status: "ready",
        updatedAt: firestoreMocks.serverTimestamp()
      };
      firestoreMocks.documents.set(target.path, activated);
      return {
        data: () => activated,
        exists: () => true,
        id: target.path.split("/").at(-1),
        ref: { ...target, id: target.path.split("/").at(-1) }
      };
    });
    const readCurrentPaths = vi.fn();

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths
    })).resolves.toMatchObject({ recovery: "activated", job: { status: "ready" } });
    expect(readCurrentPaths).not.toHaveBeenCalled();
  });

  it("abandons a due atomic plan without mutable path reads and lets the exact deterministic retry prepare again", async () => {
    const prepared = await prepareVaultPathRewriteJob(integrityKey, {
      inventoryFingerprint,
      mutationTarget: {
        expectedRevision: 4,
        id: "target-a",
        kind: "entry"
      },
      ownerUid: "user-a",
      pathChanges: [
        { entryId: "target-a", oldPath: "Old/A.md", newPath: "New/A.md" },
        { entryId: "target-b", oldPath: "Old/B.md", newPath: "New/B.md" }
      ],
      sourcePlans: [{
        sourceEntryId: "source-0",
        sourceKind: "markdown",
        expectedRevision: 3,
        originalSource: "[[Old/A]] and [[Old/B]]",
        rewrittenSource: "[[New/A]] and [[New/B]]",
        changeCount: 2
      }]
    });
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);

    const readCurrentPaths = vi.fn(async () => [
      { entryId: "target-a", path: "Old/A.md" },
      { entryId: "target-b", path: "Old/B.md" }
    ]);
    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths
    })).resolves.toMatchObject({ recovery: "deferred", job: { status: "prepared" } });
    expect(readCurrentPaths).not.toHaveBeenCalled();
    await expect(listRecoverableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([
      expect.objectContaining({ jobId: prepared.jobId, recoveryAfterMs: expect.any(Number) })
    ]);

    // A preparation tab that disappears stops heartbeating. Only after the
    // server-timestamp lease expires may another tab abandon its unactivated
    // atomic receipt without consulting paths that may have since changed.
    const storedPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    firestoreMocks.documents.set(storedPath, {
      ...firestoreMocks.documents.get(storedPath),
      updatedAt: { toMillis: () => Date.now() - 2 * 60_000 - 1 }
    });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths
    })).resolves.toMatchObject({ recovery: "not-applied", job: { status: "abandoned" } });
    expect(readCurrentPaths).not.toHaveBeenCalled();
    await expect(listRecoverableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);

    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({
      status: "prepared"
    });
    firestoreMocks.documents.set(storedPath, {
      ...firestoreMocks.documents.get(storedPath),
      updatedAt: { toMillis: () => Date.now() - 2 * 60_000 - 1 }
    });

    const obsoletePathRead = vi.fn(async () => [
      { entryId: "target-a", path: "New/A.md" },
      { entryId: "target-b", path: "Old/B.md" }
    ]);
    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths: obsoletePathRead
    })).resolves.toMatchObject({
      recovery: "not-applied",
      job: { status: "abandoned", lastErrorCode: null }
    });
    expect(obsoletePathRead).not.toHaveBeenCalled();
    await expect(listRecoverableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);
  });

  it("converges an already blocked atomic zero-step receipt without another path read", async () => {
    const prepared = await preparedJob(0);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const storedPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    firestoreMocks.documents.set(storedPath, {
      ...firestoreMocks.documents.get(storedPath),
      attemptCount: 5,
      lastErrorCode: "path-state-conflict",
      retryCount: 5,
      revision: 6,
      status: "blocked"
    });
    const readCurrentPaths = vi.fn(async () => {
      throw { code: "firestore/unavailable" };
    });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths
    })).resolves.toMatchObject({
      recovery: "not-applied",
      job: { lastErrorCode: null, retryCount: 5, status: "abandoned", stepCount: 0 }
    });
    expect(readCurrentPaths).not.toHaveBeenCalled();
  });

  it("preserves an activated atomic path conflict instead of abandoning committed rewrite work", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const storedPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    firestoreMocks.documents.set(storedPath, {
      ...firestoreMocks.documents.get(storedPath),
      activatedAt: firestoreMocks.serverTimestamp(),
      attemptCount: 1,
      lastErrorCode: "path-state-conflict",
      preparedStepCount: 1,
      retryCount: 1,
      revision: 3,
      status: "blocked"
    });
    const readCurrentPaths = vi.fn();

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths
    })).resolves.toMatchObject({
      recovery: "conflict",
      job: { lastErrorCode: "path-state-conflict", status: "blocked" }
    });
    expect(readCurrentPaths).not.toHaveBeenCalled();
    expect(firestoreMocks.documents.get(storedPath)).toMatchObject({
      activatedAt: expect.anything(),
      lastErrorCode: "path-state-conflict",
      status: "blocked"
    });
  });

  it("keeps legacy read failures transient and blocks only a complete conflicting snapshot", async () => {
    const prepared = await prepareVaultPathRewriteJob(integrityKey, {
      inventoryFingerprint,
      mutationTarget: { expectedRevision: 4, id: "target-a", kind: "entry" },
      ownerUid: "user-a",
      pathChanges: [
        { entryId: "target-a", oldPath: "Old/A.md", newPath: "New/A.md" },
        { entryId: "target-b", oldPath: "Old/B.md", newPath: "New/B.md" }
      ],
      sourcePlans: []
    });
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const atomicPath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    const legacyJobId = `pr1_${"legacy-path-state".padEnd(43, "0")}`;
    const legacyPath = `vaultMaintenanceJobs/user-a/pathRewrites/${legacyJobId}`;
    const legacy = { ...firestoreMocks.documents.get(atomicPath) };
    delete legacy.activationMode;
    delete legacy.inventoryFingerprint;
    delete legacy.preparedStepCount;
    delete legacy.mutationExpectedRevision;
    delete legacy.mutationTargetId;
    delete legacy.mutationTargetKind;
    const legacyManifest = JSON.parse(atob(String(
      (legacy.encryptedManifest as { cipherText: string }).cipherText
    ))) as Record<string, unknown>;
    delete legacyManifest.inventoryFingerprint;
    legacy.encryptedManifest = {
      ...(legacy.encryptedManifest as Record<string, unknown>),
      cipherText: btoa(JSON.stringify(legacyManifest))
    };
    firestoreMocks.documents.clear();
    firestoreMocks.documents.set(legacyPath, {
      ...legacy,
      planFingerprint: legacyJobId,
      status: "prepared"
    });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: legacyJobId,
      readCurrentPaths: async () => { throw { code: "firestore/unavailable" }; }
    })).rejects.toMatchObject({ code: "firestore/unavailable" });
    await expect(loadVaultPathRewriteJob("user-a", privateKey, legacyJobId)).resolves.toMatchObject({
      retryCount: 0,
      status: "prepared"
    });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: legacyJobId,
      readCurrentPaths: async () => [
        { entryId: "target-a", path: "New/A.md" },
        { entryId: "target-b", path: "Old/B.md" }
      ]
    })).resolves.toMatchObject({
      recovery: "conflict",
      job: { lastErrorCode: "path-state-conflict", retryCount: 1, status: "blocked" }
    });
  });

  it("caps automatic session cleanup and leaves partial encrypted steps durably resumable", async () => {
    const prepared = await preparedJob(121);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const path = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    firestoreMocks.documents.set(path, {
      ...firestoreMocks.documents.get(path),
      preparedStepCount: 40,
      status: "preparing"
    });
    for (let ordinal = 40; ordinal < 121; ordinal += 1) {
      firestoreMocks.documents.delete(`${path}/steps/step-${String(ordinal).padStart(6, "0")}`);
    }
    firestoreMocks.documents.set(path, {
      ...firestoreMocks.documents.get(path),
      updatedAt: { toMillis: () => Date.now() - 2 * 60_000 - 1 }
    });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths: vi.fn()
    })).resolves.toMatchObject({ recovery: "not-applied", job: { status: "abandoned" } });
    await scheduleTerminalVaultPathRewriteCleanup("user-a");
    expect([...firestoreMocks.documents.keys()].filter((key) => key.includes(`${prepared.jobId}/steps/`)))
      .toHaveLength(32);
    expect(firestoreMocks.documents.has(path)).toBe(true);

    // Repeated completion hooks in the same unlocked session cannot create a
    // second free-tier write burst. The explicit helper can still drain the
    // durable remainder when a test or operator intentionally requests it.
    await scheduleTerminalVaultPathRewriteCleanup("user-a");
    expect([...firestoreMocks.documents.keys()].filter((key) => key.includes(`${prepared.jobId}/steps/`)))
      .toHaveLength(32);
    await drainTerminalVaultPathRewriteJobs("user-a");
    expect([...firestoreMocks.documents.keys()].some((key) => key.includes(prepared.jobId))).toBe(false);
  });

  it("cleans completed ciphertext immediately with a single-field status query", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    const path = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    const timestamp = firestoreMocks.serverTimestamp();
    firestoreMocks.documents.set(path, {
      ...firestoreMocks.documents.get(path),
      activatedAt: timestamp,
      completedAt: timestamp,
      confirmedCount: 1,
      cursor: 1,
      revision: 3,
      status: "completed",
      updatedAt: timestamp
    });

    await expect(cleanupRetainedTerminalVaultPathRewriteJobs("user-a")).resolves.toEqual({
      cleanedJobs: 1,
      hasMore: false,
      removedSteps: 1,
      retryAfterMs: 0
    });
    expect(firestoreMocks.where).toHaveBeenCalledWith("status", "in", ["completed", "abandoned"]);
    expect(firestoreMocks.orderBy).not.toHaveBeenCalled();
    expect([...firestoreMocks.documents.keys()].some((key) => key.includes(prepared.jobId))).toBe(false);
  });

  it("requeries a full terminal page so more than the query limit converges to zero", async () => {
    const prepared = await preparedJob(0);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    atomicallyCommitPreparedJob(prepared);
    const sourcePath = `vaultMaintenanceJobs/user-a/pathRewrites/${prepared.jobId}`;
    const completedAt = { toMillis: () => Date.now() - 2 * 60_000 - 1 };
    const template = {
      ...firestoreMocks.documents.get(sourcePath),
      completedAt,
      status: "completed",
      updatedAt: completedAt
    };
    firestoreMocks.documents.delete(sourcePath);
    for (let index = 0; index < 18; index += 1) {
      const jobId = `pr2_${`terminal-${index}`.padEnd(43, "0")}`;
      firestoreMocks.documents.set(`vaultMaintenanceJobs/user-a/pathRewrites/${jobId}`, {
        ...template,
        planFingerprint: jobId
      });
    }

    await expect(cleanupRetainedTerminalVaultPathRewriteJobs("user-a")).resolves.toMatchObject({
      cleanedJobs: 3,
      hasMore: true
    });
    await drainTerminalVaultPathRewriteJobs("user-a");
    expect([...firestoreMocks.documents.keys()].filter((key) => key.includes("/pathRewrites/"))).toEqual([]);
  });

  it("advances the cursor only after exact confirmation and resumes after a fresh load", async () => {
    const prepared = await preparedJob();
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    const sources = new Map(prepared.steps.map((step, index) => [step.sourceEntryId, {
      sourceEntryId: step.sourceEntryId,
      sourceKind: step.sourceKind,
      revision: step.expectedRevision,
      source: `private original ${index} [[Private/Old]]`
    }]));
    const readSource = vi.fn(async (sourceEntryId: string) => sources.get(sourceEntryId) ?? null);
    const applyStep = vi.fn(async (step: PreparedVaultPathRewriteJob["steps"][number]) => {
      sources.set(step.sourceEntryId, {
        sourceEntryId: step.sourceEntryId,
        sourceKind: step.sourceKind,
        revision: step.expectedRevision + 1,
        source: step.rewrittenSource
      });
    });

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      maxSteps: 1,
      readSource,
      applyStep
    })).resolves.toMatchObject({ status: "running", cursor: 1, confirmedCount: 1, processedSteps: 1 });
    await expect(loadVaultPathRewriteJob("user-a", privateKey, prepared.jobId)).resolves.toMatchObject({
      status: "running",
      cursor: 1
    });
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([
      expect.objectContaining({ jobId: prepared.jobId, cursor: 1 })
    ]);

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource,
      applyStep
    })).resolves.toMatchObject({ status: "completed", cursor: 2, confirmedCount: 2, processedSteps: 1 });
    expect(applyStep.mock.calls.map(([step]) => step.ordinal)).toEqual([0, 1]);
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);
  });

  it("retains a blocked cursor and safe retry metadata without persisting an error message", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    let source: {
      sourceEntryId: string;
      sourceKind: "markdown" | "canvas";
      revision: number;
      source: string;
    } | null = null;

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => source,
      applyStep: vi.fn()
    })).resolves.toMatchObject({
      status: "blocked",
      cursor: 0,
      retryCount: 1,
      lastErrorCode: "missing-source"
    });
    expect(JSON.stringify([...firestoreMocks.documents.values()])).not.toContain("stack");
    source = {
      sourceEntryId: prepared.steps[0].sourceEntryId,
      sourceKind: prepared.steps[0].sourceKind,
      revision: prepared.steps[0].expectedRevision,
      source: "private original 0 [[Private/Old]]"
    };

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => source,
      applyStep: async (step) => {
        source = {
          sourceEntryId: step.sourceEntryId,
          sourceKind: step.sourceKind,
          revision: step.expectedRevision + 1,
          source: step.rewrittenSource
        };
      }
    })).resolves.toMatchObject({ status: "completed", cursor: 1, retryCount: 1, attemptCount: 2 });
  });

  it("confirms an already rewritten source after reload without writing it a second time", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    const step = prepared.steps[0];
    const applyStep = vi.fn();

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => ({
        sourceEntryId: step.sourceEntryId,
        sourceKind: step.sourceKind,
        revision: step.expectedRevision + 1,
        source: step.rewrittenSource
      }),
      applyStep
    })).resolves.toMatchObject({ status: "completed", cursor: 1, processedSteps: 1 });
    expect(applyStep).not.toHaveBeenCalled();
  });

  it("contains transient source reads and confirms a lost apply response without a duplicate write", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    const step = prepared.steps[0];
    let source = {
      sourceEntryId: step.sourceEntryId,
      sourceKind: step.sourceKind,
      revision: step.expectedRevision,
      source: "private original 0 [[Private/Old]]"
    };
    const readSource = vi.fn(async () => {
      if (readSource.mock.calls.length === 1) throw { code: "firestore/unavailable" };
      return source;
    });
    const applyStep = vi.fn(async () => {
      source = {
        sourceEntryId: step.sourceEntryId,
        sourceKind: step.sourceKind,
        revision: step.expectedRevision + 1,
        source: step.rewrittenSource
      };
      throw { code: "network_error" };
    });

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource,
      applyStep
    })).resolves.toMatchObject({
      status: "completed",
      cursor: 1,
      lastErrorCode: null
    });
    expect(readSource).toHaveBeenCalledTimes(3);
    expect(applyStep).toHaveBeenCalledOnce();
  });

  it("retries an idempotent apply only when a transport failure left the source pending", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    const step = prepared.steps[0];
    let source = {
      sourceEntryId: step.sourceEntryId,
      sourceKind: step.sourceKind,
      revision: step.expectedRevision,
      source: "private original 0 [[Private/Old]]"
    };
    const applyStep = vi.fn(async () => {
      if (applyStep.mock.calls.length === 1) throw { code: "network_timeout" };
      source = {
        sourceEntryId: step.sourceEntryId,
        sourceKind: step.sourceKind,
        revision: step.expectedRevision + 1,
        source: step.rewrittenSource
      };
    });

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => source,
      applyStep
    })).resolves.toMatchObject({ status: "completed", cursor: 1 });
    expect(applyStep).toHaveBeenCalledTimes(2);
  });

  it("keeps a source retryable when every transient apply attempt leaves it pending", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    const step = prepared.steps[0];
    const source = {
      sourceEntryId: step.sourceEntryId,
      sourceKind: step.sourceKind,
      revision: step.expectedRevision,
      source: "private original 0 [[Private/Old]]"
    };
    const applyStep = vi.fn(async () => {
      throw { code: "network_error" };
    });

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => source,
      applyStep
    })).resolves.toMatchObject({
      status: "blocked",
      cursor: 0,
      lastErrorCode: "write-failed"
    });
    expect(applyStep).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a callback cannot prove the exact source revision and digest", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    let source = {
      sourceEntryId: prepared.steps[0].sourceEntryId,
      sourceKind: prepared.steps[0].sourceKind,
      revision: prepared.steps[0].expectedRevision,
      source: "private original 0 [[Private/Old]]"
    };

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: async () => source,
      applyStep: async (step) => {
        source = {
          sourceEntryId: step.sourceEntryId,
          sourceKind: step.sourceKind,
          revision: step.expectedRevision + 2,
          source: step.rewrittenSource
        };
      }
    })).resolves.toMatchObject({
      status: "blocked",
      cursor: 0,
      lastErrorCode: "revision-conflict"
    });
  });

  it("marks a missing or corrupted encrypted step blocked instead of skipping it", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activatePreparedAtomicJob(prepared);
    const stepPath = [...firestoreMocks.documents.keys()].find((path) => path.endsWith("/step-000000"));
    expect(stepPath).toBeTruthy();
    firestoreMocks.documents.delete(stepPath!);

    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: vi.fn(),
      applyStep: vi.fn()
    })).resolves.toMatchObject({ status: "blocked", cursor: 0, lastErrorCode: "job-corrupt" });
  });
});
