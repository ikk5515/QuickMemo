import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultImportManifest } from "../features/vault/importRollback";
import {
  cleanupTerminalVaultImportJob,
  commitVaultImportJob,
  ensureVaultImportJob,
  listRecoverableVaultImportJobs,
  rollbackVaultImportJob
} from "./vaultImportJobs";

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
    ref: reference(path),
    exists: () => documents.has(path),
    data: () => documents.get(path)
  });
  const transaction = {
    get: vi.fn(async (target: { path: string }) => snapshot(target.path)),
    delete: vi.fn((target: { path: string }) => {
      documents.delete(target.path);
    }),
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
    deleteDoc: vi.fn(async (target: { path: string }) => {
      documents.delete(target.path);
    }),
    doc: vi.fn((...parts: unknown[]) => reference(pathFrom(parts))),
    documents,
    getDocFromServer: vi.fn(async (target: { path: string }) => snapshot(target.path)),
    getDocsFromServer: vi.fn(async (target: {
      constraints?: Array<{ field?: string; operation?: string; type: string; value?: unknown }>;
      path: string;
    }) => {
      const prefix = `${target.path}/`;
      let docs = [...documents.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .sort()
        .map(snapshot);
      for (const constraint of target.constraints ?? []) {
        if (constraint.type === "where" && constraint.field) {
          if (constraint.operation === "in") {
            docs = docs.filter((item) => (constraint.value as unknown[]).includes(item.data()?.[constraint.field!]));
          } else if (constraint.operation === "==") {
            docs = docs.filter((item) => item.data()?.[constraint.field!] === constraint.value);
          }
        }
        if (constraint.type === "limit") docs = docs.slice(0, constraint.value as number);
      }
      return { docs, size: docs.length };
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
      type: "where",
      value
    })),
    writeBatch: vi.fn(() => {
      const pending: Array<{ operation: "delete" | "set"; path: string; value?: Record<string, unknown> }> = [];
      return {
        delete: (target: { path: string }) => pending.push({ operation: "delete", path: target.path }),
        set: (target: { path: string }, value: Record<string, unknown>) => pending.push({
          operation: "set", path: target.path, value
        }),
        commit: async () => {
          await batchCommit();
          for (const item of pending) {
            if (item.operation === "delete") documents.delete(item.path);
            else documents.set(item.path, item.value ?? {});
          }
        }
      };
    })
  };
});

const cryptoMocks = vi.hoisted(() => {
  const keyByWrappedValue = new Map<string, { id: string }>();
  let keyCounter = 0;
  return {
    decryptText: vi.fn(async (payload: { cipherText: string }) => atob(payload.cipherText)),
    encryptText: vi.fn(async (value: string) => ({
      version: 1 as const,
      algorithm: "AES-GCM" as const,
      cipherText: btoa(value),
      iv: "test-iv"
    })),
    generateNoteKey: vi.fn(async () => ({ id: `import-key-${++keyCounter}` })),
    keyByWrappedValue,
    unwrapNoteKey: vi.fn(async (wrapped: { wrappedKey: string }) => {
      const key = keyByWrappedValue.get(wrapped.wrappedKey);
      if (!key) throw new Error("missing job key");
      return key;
    }),
    wrapNoteKey: vi.fn(async (key: { id: string }) => {
      const wrappedKey = `wrapped-${key.id}`;
      keyByWrappedValue.set(wrappedKey, key);
      return { version: 1 as const, algorithm: "RSA-OAEP" as const, wrappedKey };
    })
  };
});

const noteMocks = vi.hoisted(() => ({
  deleteRevisionedNote: vi.fn(),
  trashRevisionedEncryptedFolderSubtree: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: firestoreMocks.db }));
vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  deleteDoc: firestoreMocks.deleteDoc,
  doc: firestoreMocks.doc,
  getDocFromServer: firestoreMocks.getDocFromServer,
  getDocsFromServer: firestoreMocks.getDocsFromServer,
  limit: firestoreMocks.limit,
  query: firestoreMocks.query,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  where: firestoreMocks.where,
  writeBatch: firestoreMocks.writeBatch
}));
vi.mock("../lib/crypto", () => ({
  decryptText: cryptoMocks.decryptText,
  encryptText: cryptoMocks.encryptText,
  generateNoteKey: cryptoMocks.generateNoteKey,
  unwrapNoteKey: cryptoMocks.unwrapNoteKey,
  wrapNoteKey: cryptoMocks.wrapNoteKey
}));
vi.mock("./notes", () => ({
  deleteRevisionedNote: noteMocks.deleteRevisionedNote,
  maxNoteFoldersPerOwner: 5_000,
  trashRevisionedEncryptedFolderSubtree: noteMocks.trashRevisionedEncryptedFolderSubtree
}));

const uid = "user-a";
const jobId = `vi1_${"J".repeat(43)}`;
const profile = { uid, publicKeyJwk: { kty: "RSA", n: "public", e: "AQAB" } };
const privateKey = { id: "private-key" } as unknown as CryptoKey;
const claim = (fill: string) => fill.repeat(43);
const manifest = createVaultImportManifest({
  ownerUid: uid,
  folders: [{ targetId: "folder-a", claimId: claim("A"), parentId: null }],
  entries: [{
    targetId: "entry-a",
    claimId: claim("B"),
    folderId: "folder-a",
    contentFormat: "markdown-v1",
    entryKind: "markdown"
  }]
});

beforeEach(() => {
  vi.clearAllMocks();
  firestoreMocks.documents.clear();
  cryptoMocks.keyByWrappedValue.clear();
  firestoreMocks.batchCommit.mockResolvedValue(undefined);
  noteMocks.deleteRevisionedNote.mockImplementation(async ({ noteId }: { noteId: string }) => {
    const path = `notes/${noteId}`;
    const current = firestoreMocks.documents.get(path) ?? {};
    firestoreMocks.documents.set(path, { ...current, isDeleted: true, revision: 2 });
  });
  noteMocks.trashRevisionedEncryptedFolderSubtree.mockImplementation(async ({ folderId }: { folderId: string }) => {
    const path = `noteFolders/${folderId}`;
    const current = firestoreMocks.documents.get(path) ?? {};
    firestoreMocks.documents.set(path, { ...current, isDeleted: true, revision: 2 });
  });
});

describe("durable encrypted Vault import jobs", () => {
  it("persists encrypted bounded chunks before staging and leaks no path/title", async () => {
    const created = await ensureVaultImportJob({ profile, privateKey, jobId, manifest });

    expect(created).toMatchObject({ status: "staging", itemCount: 2, chunkCount: 1 });
    const persisted = JSON.stringify([...firestoreMocks.documents]);
    expect(persisted).not.toContain("Private/Journal.md");
    expect(persisted).not.toContain("Journal");
    expect(persisted).toContain(jobId);
    await expect(ensureVaultImportJob({ profile, privateKey, jobId, manifest }))
      .resolves.toMatchObject({ status: "staging" });
    await expect(listRecoverableVaultImportJobs(uid, privateKey)).resolves.toEqual([
      expect.objectContaining({ jobId, status: "staging" })
    ]);
  });

  it("confirms an idempotent committed retry and removes terminal ciphertext retention", async () => {
    await ensureVaultImportJob({ profile, privateKey, jobId, manifest });
    await expect(commitVaultImportJob(uid, jobId)).resolves.toMatchObject({ status: "committed" });
    await expect(commitVaultImportJob(uid, jobId)).resolves.toMatchObject({ status: "committed" });
    await expect(cleanupTerminalVaultImportJob(uid, jobId)).resolves.toEqual({
      cleaned: true,
      removedChunks: 1
    });
    expect([...firestoreMocks.documents.keys()].some((path) => path.includes(jobId))).toBe(false);
  });

  it("resumes terminal cleanup after a committed chunk transaction response is lost", async () => {
    await ensureVaultImportJob({ profile, privateKey, jobId, manifest });
    await commitVaultImportJob(uid, jobId);
    firestoreMocks.runTransaction.mockImplementationOnce(async (
      _db: unknown,
      operation: (value: typeof firestoreMocks.transaction) => unknown
    ) => {
      await operation(firestoreMocks.transaction);
      throw new Error("response lost after commit");
    });

    await expect(cleanupTerminalVaultImportJob(uid, jobId)).rejects.toThrow("response lost after commit");
    await expect(cleanupTerminalVaultImportJob(uid, jobId)).resolves.toEqual({
      cleaned: true,
      removedChunks: 0
    });
    expect([...firestoreMocks.documents.keys()].some((path) => path.includes(jobId))).toBe(false);
  });

  it("soft-deletes exact provenance entries before trashing only imported roots", async () => {
    await ensureVaultImportJob({ profile, privateKey, jobId, manifest });
    firestoreMocks.documents.set("notes/entry-a", {
      ownerUid: uid,
      folderId: "folder-a",
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      isDeleted: false,
      revision: 1,
      vaultNameClaimId: claim("B"),
      vaultNameIndexVersion: 1,
      vaultImportJobId: jobId
    });
    firestoreMocks.documents.set("noteFolders/folder-a", {
      ownerUid: uid,
      parentId: null,
      encryptedName: { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" },
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped" },
      isDeleted: false,
      revision: 1,
      vaultNameClaimId: claim("A"),
      vaultNameIndexVersion: 1,
      vaultImportJobId: jobId
    });

    await expect(rollbackVaultImportJob({ uid, privateKey, jobId })).resolves.toMatchObject({
      status: "rolled-back",
      entrySoftDeleted: 1,
      folderRootsTrashed: 1
    });
    expect(noteMocks.deleteRevisionedNote).toHaveBeenCalledWith(expect.objectContaining({ noteId: "entry-a" }));
    expect(noteMocks.trashRevisionedEncryptedFolderSubtree).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "folder-a" })
    );
  });

  it("confirms exact note and folder tombstones after committed responses are lost", async () => {
    await ensureVaultImportJob({ profile, privateKey, jobId, manifest });
    firestoreMocks.documents.set("notes/entry-a", {
      ownerUid: uid,
      folderId: "folder-a",
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      isDeleted: false,
      revision: 1,
      vaultNameClaimId: claim("B"),
      vaultNameIndexVersion: 1,
      vaultImportJobId: jobId
    });
    firestoreMocks.documents.set("noteFolders/folder-a", {
      ownerUid: uid,
      parentId: null,
      encryptedName: { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" },
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped" },
      isDeleted: false,
      revision: 1,
      vaultNameClaimId: claim("A"),
      vaultNameIndexVersion: 1,
      vaultImportJobId: jobId
    });
    noteMocks.deleteRevisionedNote.mockImplementationOnce(async ({ noteId }: { noteId: string }) => {
      const path = `notes/${noteId}`;
      const current = firestoreMocks.documents.get(path) ?? {};
      firestoreMocks.documents.set(path, { ...current, isDeleted: true, revision: 2 });
      throw new Error("note response lost after commit");
    });
    noteMocks.trashRevisionedEncryptedFolderSubtree.mockImplementationOnce(async (
      { folderId }: { folderId: string }
    ) => {
      const path = `noteFolders/${folderId}`;
      const current = firestoreMocks.documents.get(path) ?? {};
      firestoreMocks.documents.set(path, { ...current, isDeleted: true, revision: 2 });
      throw new Error("folder response lost after commit");
    });

    await expect(rollbackVaultImportJob({ uid, privateKey, jobId })).resolves.toMatchObject({
      status: "rolled-back",
      entrySoftDeleted: 1,
      folderRootsTrashed: 1
    });
  });
});
