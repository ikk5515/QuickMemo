import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NoteRevisionConflictError,
  createRevisionedEncryptedNote,
  deleteNote,
  getNoteRevisionState,
  getVisibleNotesByIds,
  purgeNote,
  restoreRevisionedNote,
  subscribeMyNoteStates,
  subscribeNoteHistory,
  subscribeVisibleNotes,
  updateRevisionedEncryptedNote,
  updateRevisionedNoteAccess
} from "./notes";

const mocks = vi.hoisted(() => {
  const timestamp = { __type: "serverTimestamp" };
  const deletedField = { __type: "deleteField" };
  const batch = {
    commit: vi.fn(),
    delete: vi.fn(),
    set: vi.fn(),
    update: vi.fn()
  };
  const transaction = {
    get: vi.fn(),
    set: vi.fn(),
    update: vi.fn()
  };
  let generatedId = 0;

  return {
    addDoc: vi.fn(),
    batch,
    collection: vi.fn((...parts: unknown[]) => ({ parts, type: "collection" })),
    db: { __type: "firestore" },
    deleteBlobAttachment: vi.fn(),
    deleteDoc: vi.fn(),
    deletedField,
    deleteField: vi.fn(() => deletedField),
    deleteObject: vi.fn(),
    doc: vi.fn((...parts: unknown[]) => {
      if (parts.length === 1) {
        generatedId += 1;
        return { id: `generated-${generatedId}`, parts: [parts[0], `generated-${generatedId}`], type: "doc" };
      }

      return { id: String(parts.at(-1) ?? ""), parts, type: "doc" };
    }),
    fetchBlobAttachmentBytes: vi.fn(),
    fetchBlobAttachmentResponse: vi.fn(),
    getBytes: vi.fn(),
    getDoc: vi.fn(),
    getDocs: vi.fn(),
    limit: vi.fn((count: number) => ({ count, type: "limit" })),
    onSnapshot: vi.fn((...args: unknown[]) => {
      void args;
      return vi.fn();
    }),
    orderBy: vi.fn((...parts: unknown[]) => ({ parts, type: "orderBy" })),
    query: vi.fn((...parts: unknown[]) => ({ parts, type: "query" })),
    ref: vi.fn(),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => timestamp),
    setDoc: vi.fn(),
    storage: { __type: "storage" },
    timestamp,
    transaction,
    updateDoc: vi.fn(),
    uploadNoteAttachmentBlob: vi.fn(),
    where: vi.fn((...parts: unknown[]) => ({ parts, type: "where" })),
    writeBatch: vi.fn(() => batch),
    resetGeneratedId() {
      generatedId = 0;
    }
  };
});

vi.mock("../lib/firebase", () => ({
  db: mocks.db,
  storage: mocks.storage
}));

vi.mock("firebase/firestore", () => ({
  addDoc: mocks.addDoc,
  collection: mocks.collection,
  deleteDoc: mocks.deleteDoc,
  deleteField: mocks.deleteField,
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  getDocs: mocks.getDocs,
  limit: mocks.limit,
  onSnapshot: mocks.onSnapshot,
  orderBy: mocks.orderBy,
  query: mocks.query,
  runTransaction: mocks.runTransaction,
  serverTimestamp: mocks.serverTimestamp,
  setDoc: mocks.setDoc,
  updateDoc: mocks.updateDoc,
  where: mocks.where,
  writeBatch: mocks.writeBatch
}));

vi.mock("firebase/storage", () => ({
  deleteObject: mocks.deleteObject,
  getBytes: mocks.getBytes,
  ref: mocks.ref
}));

vi.mock("./blobAttachments", () => ({
  deleteBlobAttachment: mocks.deleteBlobAttachment,
  fetchBlobAttachmentBytes: mocks.fetchBlobAttachmentBytes,
  fetchBlobAttachmentResponse: mocks.fetchBlobAttachmentResponse,
  uploadNoteAttachmentBlob: mocks.uploadNoteAttachmentBlob
}));

function noteSnapshot(revision: number | undefined) {
  return {
    data: () => ({ revision }),
    exists: () => true,
    id: "note-a"
  };
}

const encryptedPayload = {
  algorithm: "AES-GCM" as const,
  cipherText: "cipher",
  iv: "iv",
  version: 1 as const
};

const wrappedKey = {
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: "wrapped-key"
};

describe("revision-aware note persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetGeneratedId();
    mocks.batch.commit.mockResolvedValue(undefined);
    mocks.getDocs.mockResolvedValue({ docs: [] });
    mocks.transaction.get.mockResolvedValue(noteSnapshot(4));
    mocks.runTransaction.mockImplementation(async (_db, updateFunction) => updateFunction(mocks.transaction));
  });

  it("creates revision 1 with an independent paired history document", async () => {
    const result = await createRevisionedEncryptedNote({
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });

    expect(result).toMatchObject({
      lastMutationId: "generated-2",
      noteId: "generated-1",
      revision: 1
    });
    expect(mocks.batch.set).toHaveBeenNthCalledWith(
      1,
      result.noteRef,
      expect.objectContaining({
        attachmentRevision: 0,
        lastMutationId: "generated-2",
        revision: 1
      })
    );
    expect(mocks.batch.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "generated-2" }),
      expect.objectContaining({
        action: "create",
        noteId: "generated-1",
        revision: 1
      })
    );
  });

  it("reads content and attachment revisions with legacy zero defaults", async () => {
    mocks.getDoc
      .mockResolvedValueOnce({
        data: () => ({ attachmentRevision: 7, revision: 4 }),
        exists: () => true
      })
      .mockResolvedValueOnce({
        data: () => ({}),
        exists: () => true
      });

    await expect(getNoteRevisionState("note-a")).resolves.toEqual({ attachmentRevision: 7, revision: 4 });
    await expect(getNoteRevisionState("legacy-note")).resolves.toEqual({ attachmentRevision: 0, revision: 0 });
  });

  it("updates only when the expected revision matches and pairs history in the transaction", async () => {
    const result = await updateRevisionedEncryptedNote({
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(result).toEqual({
      lastMutationId: "generated-1",
      noteId: "note-a",
      revision: 5
    });
    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-a" }),
      expect.objectContaining({ lastMutationId: "generated-1", revision: 5 })
    );
    expect(mocks.transaction.set).toHaveBeenCalledWith(
      expect.objectContaining({ id: "generated-1" }),
      expect.objectContaining({ action: "content", revision: 5 })
    );
  });

  it("reports a conflict before writing when the expected revision is stale", async () => {
    await expect(
      updateRevisionedEncryptedNote({
        encryptedBody: encryptedPayload,
        encryptedTitle: encryptedPayload,
        expectedRevision: 3,
        noteId: "note-a",
        readerUids: ["user-a"],
        uid: "user-a"
      })
    ).rejects.toEqual(expect.objectContaining<Partial<NoteRevisionConflictError>>({
      actualRevision: 4,
      code: "note/revision-conflict",
      expectedRevision: 3
    }));
    expect(mocks.transaction.update).not.toHaveBeenCalled();
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("treats a legacy note without revision as revision 0", async () => {
    mocks.transaction.get.mockResolvedValueOnce(noteSnapshot(undefined));

    await updateRevisionedEncryptedNote({
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 0,
      noteId: "legacy-note",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lastMutationId: "generated-1", revision: 1 })
    );
  });

  it("increments access changes and records the normalized participant set", async () => {
    await updateRevisionedNoteAccess({
      expectedRevision: 4,
      folderId: "ignored-for-shared",
      noteId: "note-a",
      participantUids: ["user-a", "user-b", "user-b"],
      type: "shared",
      uid: "user-a",
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        folderId: null,
        participantUids: ["user-a", "user-b"],
        revision: 5
      })
    );
    expect(mocks.transaction.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "share",
        readerUids: ["user-a", "user-b"],
        revision: 5
      })
    );
  });

  it("soft-deletes without reading or deleting attachment documents", async () => {
    await deleteNote("note-a", "user-a", ["user-a"]);

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        isDeleted: true,
        lastMutationId: "generated-1",
        revision: 5
      })
    );
    expect(mocks.transaction.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "delete", revision: 5 })
    );
    expect(mocks.getDocs).not.toHaveBeenCalled();
    expect(mocks.deleteBlobAttachment).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it("atomically redacts a purged note and enqueues durable server cleanup", async () => {
    await purgeNote({
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      noteId: "note-a",
      ownerUid: "user-a",
      uid: "user-a",
      wrappedKey
    });

    expect(mocks.batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-a", parts: [mocks.db, "notes", "note-a"] }),
      expect.objectContaining({ isDeleted: true, isPurged: true })
    );
    expect(mocks.batch.set).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-a", parts: [mocks.db, "notePurgeCleanupQueue", "note-a"] }),
      expect.objectContaining({ noteId: "note-a", ownerUid: "user-a" })
    );
    expect(mocks.batch.commit).toHaveBeenCalledTimes(1);
    expect(mocks.getDocs).not.toHaveBeenCalled();
    expect(mocks.deleteBlobAttachment).not.toHaveBeenCalled();
  });

  it("restores with an expected revision and a paired independent history document", async () => {
    await restoreRevisionedNote({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deletedAt: mocks.deletedField,
        deletedBy: mocks.deletedField,
        isDeleted: false,
        revision: 5
      })
    );
    expect(mocks.transaction.set).toHaveBeenCalledWith(
      expect.objectContaining({ id: "generated-1" }),
      expect.objectContaining({ action: "restore", revision: 5 })
    );
  });

});

describe("note history subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orders and limits participant history on the server", () => {
    subscribeNoteHistory("note-a", "user-b", false, vi.fn());

    expect(mocks.where).toHaveBeenCalledWith("readerUids", "array-contains", "user-b");
    expect(mocks.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(mocks.limit).toHaveBeenCalledWith(80);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "where" }),
      expect.objectContaining({ type: "orderBy" }),
      expect.objectContaining({ count: 80, type: "limit" })
    );
  });
});

describe("bounded library note reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fans out bounded recent reads by authorized owner before applying a global limit", () => {
    subscribeVisibleNotes("user-a", ["user-a", "owner-b"], vi.fn(), vi.fn(), 80);

    expect(mocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
    expect(mocks.where).toHaveBeenCalledWith("ownerUid", "==", "owner-b");
    expect(mocks.where).toHaveBeenCalledWith("isDeleted", "==", false);
    expect(mocks.where).toHaveBeenCalledWith("participantUids", "array-contains", "user-a");
    expect(mocks.orderBy).toHaveBeenCalledWith("updatedAt", "desc");
    expect(mocks.limit).toHaveBeenCalledTimes(2);
    expect(mocks.limit).toHaveBeenNthCalledWith(1, 80);
    expect(mocks.limit).toHaveBeenNthCalledWith(2, 80);
  });

  it("bounds the admin-wide query to active notes", () => {
    subscribeVisibleNotes("admin-a", null, vi.fn(), vi.fn(), 80);

    expect(mocks.where).toHaveBeenCalledWith("isDeleted", "==", false);
    expect(mocks.orderBy).toHaveBeenCalledWith("updatedAt", "desc");
    expect(mocks.limit).toHaveBeenCalledWith(80);
  });

  it("keeps readable direct sources when another source is deleted or denied", async () => {
    mocks.getDoc
      .mockResolvedValueOnce({
        data: () => ({
          isDeleted: false,
          participantUids: ["user-a"],
          updatedAt: { toMillis: () => 100 }
        }),
        exists: () => true,
        id: "note-readable"
      })
      .mockRejectedValueOnce(new Error("permission-denied"))
      .mockResolvedValueOnce({ exists: () => false, id: "note-missing" });

    await expect(getVisibleNotesByIds("user-a", ["note-readable", "note-denied", "note-missing"]))
      .resolves.toEqual({
        notes: [expect.objectContaining({ id: "note-readable" })],
        resolvedNoteIds: expect.arrayContaining(["note-readable", "note-missing"])
      });
    expect(mocks.getDoc).toHaveBeenCalledTimes(3);
  });
});

describe("personal note state subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onSnapshot.mockImplementation(() => vi.fn());
  });

  it("coalesces synchronous initial snapshots into one immutable callback payload", async () => {
    const listeners: Array<(snapshot: { data: () => unknown; exists: () => boolean; id: string }) => void> = [];
    const callback = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listeners.push(args[1] as (snapshot: { data: () => unknown; exists: () => boolean; id: string }) => void);
      return vi.fn();
    });

    subscribeMyNoteStates("user-a", ["note-a", "note-b", "note-a", ""], callback);

    expect(listeners).toHaveLength(2);
    listeners[0]({ data: () => ({ isPinned: true }), exists: () => true, id: "user-a" });
    listeners[1]({ data: () => ({ isPinned: false }), exists: () => true, id: "user-a" });
    expect(callback).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      "note-a": { id: "user-a", isPinned: true },
      "note-b": { id: "user-a", isPinned: false }
    });

    const firstPayload = callback.mock.calls[0][0];
    listeners[0]({ data: () => ({ isPinned: false }), exists: () => true, id: "user-a" });
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(firstPayload["note-a"].isPinned).toBe(true);
    expect(callback.mock.calls[1][0]["note-a"].isPinned).toBe(false);
  });

  it("cancels a queued callback and ignores late errors after cleanup", async () => {
    let listener: ((snapshot: { data: () => unknown; exists: () => boolean; id: string }) => void) | undefined;
    let errorListener: ((error: Error) => void) | undefined;
    const unsubscribe = vi.fn();
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listener = args[1] as (snapshot: { data: () => unknown; exists: () => boolean; id: string }) => void;
      errorListener = args[2] as (error: Error) => void;
      return unsubscribe;
    });

    const cleanup = subscribeMyNoteStates("user-a", ["note-a"], callback, onError);
    listener?.({ data: () => ({ isPinned: true }), exists: () => true, id: "user-a" });
    cleanup();
    errorListener?.(new Error("late subscription error"));
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("retains the immediate empty-state behavior without opening listeners", () => {
    const callback = vi.fn();

    const cleanup = subscribeMyNoteStates("user-a", ["", ""], callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({});
    expect(mocks.onSnapshot).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
  });
});
