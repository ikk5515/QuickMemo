import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareVaultPathRewriteJob, type PreparedVaultPathRewriteJob } from "../features/vault/pathRewriteJob";
import {
  activateVaultPathRewriteJob,
  ensureVaultPathRewriteJob,
  listRecoverableVaultPathRewriteJobs,
  listResumableVaultPathRewriteJobs,
  loadVaultPathRewriteJob,
  recoverPreparedVaultPathRewriteJob,
  resumeVaultPathRewriteJob
} from "./vaultPathRewriteJobs";

const firestoreMocks = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
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
    exists: () => documents.has(path),
    data: () => documents.get(path)
  });
  const transaction = {
    get: vi.fn(async (target: { path: string }) => snapshot(target.path)),
    set: vi.fn((target: { path: string }, value: Record<string, unknown>) => {
      documents.set(target.path, value);
    }),
    update: vi.fn((target: { path: string }, value: Record<string, unknown>) => {
      documents.set(target.path, { ...documents.get(target.path), ...value });
    })
  };
  const batchCommit = vi.fn();
  return {
    batchCommit,
    collection: vi.fn((...parts: unknown[]) => reference(pathFrom(parts))),
    db,
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
        if (constraint.type === "limit") {
          docs = docs.slice(0, constraint.value as number);
        }
      }
      return { docs, size: docs.length, forEach: (visit: (item: ReturnType<typeof snapshot>) => void) => docs.forEach(visit) };
    }),
    limit: vi.fn((value: number) => ({ type: "limit", value })),
    query: vi.fn((target: { path: string }, ...constraints: Array<{ type: string }>) => ({
      ...target,
      constraints
    })),
    runTransaction: vi.fn(async (_db: unknown, operation: (value: typeof transaction) => unknown) => operation(transaction)),
    serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
    transaction,
    where: vi.fn((field: string, operation: string, value: unknown) => ({
      field,
      operation,
      type: operation === "in" ? "where-in" : "where",
      value
    })),
    writeBatch: vi.fn(() => {
      const pending: Array<{ path: string; value: Record<string, unknown> }> = [];
      return {
        set: (target: { path: string }, value: Record<string, unknown>) => pending.push({ path: target.path, value }),
        commit: async () => {
          await batchCommit();
          for (const item of pending) documents.set(item.path, item.value);
        }
      };
    })
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
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  getDocs: firestoreMocks.getDocs,
  limit: firestoreMocks.limit,
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

async function preparedJob(stepCount = 2): Promise<PreparedVaultPathRewriteJob> {
  return prepareVaultPathRewriteJob(integrityKey, {
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
});

describe("encrypted durable Vault path rewrite persistence", () => {
  it("prepares every encrypted step before ready and stores no plaintext path, title, or source", async () => {
    const prepared = await preparedJob();

    const created = await ensureVaultPathRewriteJob(profile, privateKey, prepared);

    expect(created).toMatchObject({ status: "prepared", stepCount: 2, cursor: 0, revision: 2 });
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
      expect.objectContaining({ jobId: prepared.jobId, status: "prepared" })
    ]);
  });

  it("bounds only incomplete jobs so completed retention cannot lock future recovery", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    for (let index = 0; index < 60; index += 1) {
      firestoreMocks.documents.set(
        `vaultMaintenanceJobs/user-a/pathRewrites/pr1_${String(index).padStart(43, "0")}`,
        { status: "completed" }
      );
    }

    await expect(listRecoverableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([
      expect.objectContaining({ jobId: prepared.jobId, status: "prepared" })
    ]);
    expect(firestoreMocks.where).toHaveBeenCalledWith(
      "status",
      "in",
      ["preparing", "prepared", "ready", "running", "blocked"]
    );
    expect(firestoreMocks.limit).toHaveBeenCalledWith(51);
  });

  it("activates a prepared zero-source operation as completed without exposing a runnable gap", async () => {
    const prepared = await preparedJob(0);
    await expect(ensureVaultPathRewriteJob(profile, privateKey, prepared)).resolves.toMatchObject({
      status: "prepared",
      stepCount: 0
    });
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);
    await expect(activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId)).resolves.toMatchObject({
      status: "completed",
      cursor: 0,
      stepCount: 0
    });
  });

  it("recovers the crash gap by activating only when every current path is at newPath", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths: async (entryIds) => entryIds.map((entryId) => ({
        entryId,
        path: "Archive/New.md"
      }))
    })).resolves.toMatchObject({ recovery: "activated", job: { status: "ready" } });
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([
      expect.objectContaining({ jobId: prepared.jobId, status: "ready" })
    ]);
  });

  it("keeps all-old jobs inert and blocks mixed path snapshots from normal resume", async () => {
    const prepared = await prepareVaultPathRewriteJob(integrityKey, {
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

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths: async () => [
        { entryId: "target-a", path: "Old/A.md" },
        { entryId: "target-b", path: "Old/B.md" }
      ]
    })).resolves.toMatchObject({ recovery: "not-applied", job: { status: "prepared" } });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths: async () => [
        { entryId: "target-a", path: "New/A.md" },
        { entryId: "target-b", path: "Old/B.md" }
      ]
    })).resolves.toMatchObject({
      recovery: "conflict",
      job: { status: "blocked", lastErrorCode: "path-state-conflict" }
    });
    await expect(listResumableVaultPathRewriteJobs("user-a", privateKey)).resolves.toEqual([]);
    await expect(resumeVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readSource: vi.fn(),
      applyStep: vi.fn()
    })).rejects.toMatchObject({ code: "not-ready" });

    await expect(recoverPreparedVaultPathRewriteJob({
      uid: "user-a",
      privateKey,
      jobId: prepared.jobId,
      readCurrentPaths: async () => [
        { entryId: "target-a", path: "New/A.md" },
        { entryId: "target-b", path: "New/B.md" }
      ]
    })).resolves.toMatchObject({ recovery: "activated", job: { status: "ready" } });
  });

  it("advances the cursor only after exact confirmation and resumes after a fresh load", async () => {
    const prepared = await preparedJob();
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId);
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
    await activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId);
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
    await activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId);
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

  it("fails closed when a callback cannot prove the exact source revision and digest", async () => {
    const prepared = await preparedJob(1);
    await ensureVaultPathRewriteJob(profile, privateKey, prepared);
    await activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId);
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
    await activateVaultPathRewriteJob("user-a", privateKey, prepared.jobId);
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
