import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NoteFolderLimitError,
  NoteRevisionConflictError,
  abortSecureShareCopyingNote,
  activateSecureShareCopyingNote,
  createEncryptedNoteFolder,
  createNoteFolder,
  createNoteAttachment,
  createRevisionedEncryptedNote,
  createSecureShareCopyingNote,
  deleteNote,
  getNoteRevisionState,
  getVisibleNotesByIds,
  isLegacyHtmlNoteDocument,
  listStaleSecureShareCopyingNotes,
  migrateLegacyNoteFolder,
  purgeNote,
  restoreRevisionedNote,
  subscribeMyNoteStates,
  subscribeNoteFolders,
  subscribeNoteHistory,
  subscribeVisibleNotes,
  updateRevisionedEncryptedNote,
  updateEncryptedNoteFolder,
  updateRevisionedNoteAccess,
  updateRevisionedNoteFolder
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
    getCountFromServer: vi.fn(),
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
    startAfter: vi.fn((snapshot: unknown) => ({ snapshot, type: "startAfter" })),
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
  getLegacyStorage: () => mocks.storage
}));

vi.mock("firebase/firestore", () => ({
  addDoc: mocks.addDoc,
  collection: mocks.collection,
  deleteDoc: mocks.deleteDoc,
  deleteField: mocks.deleteField,
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  getCountFromServer: mocks.getCountFromServer,
  getDocs: mocks.getDocs,
  limit: mocks.limit,
  onSnapshot: mocks.onSnapshot,
  orderBy: mocks.orderBy,
  query: mocks.query,
  runTransaction: mocks.runTransaction,
  serverTimestamp: mocks.serverTimestamp,
  setDoc: mocks.setDoc,
  startAfter: mocks.startAfter,
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

const legacyStorageIdentity = {
  expectedContentFormat: "legacy-html-v1" as const,
  expectedEntryKind: "legacy-html" as const
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

  it("recognizes only historical or explicit legacy HTML storage identities", () => {
    expect(isLegacyHtmlNoteDocument({})).toBe(true);
    expect(isLegacyHtmlNoteDocument({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    })).toBe(true);
    expect(isLegacyHtmlNoteDocument({ contentFormat: "legacy-html-v1" })).toBe(false);
    expect(isLegacyHtmlNoteDocument({ entryKind: "legacy-html" })).toBe(false);
    expect(isLegacyHtmlNoteDocument({
      contentFormat: "markdown-v1",
      entryKind: "markdown"
    })).toBe(false);
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

  it("rejects oversized encrypted note payloads before issuing a write", async () => {
    await expect(createRevisionedEncryptedNote({
      encryptedBody: { ...encryptedPayload, cipherText: "A".repeat(700_001) },
      encryptedTitle: encryptedPayload,
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    })).rejects.toThrow("노트 본문 암호문");

    expect(mocks.batch.set).not.toHaveBeenCalled();
    expect(mocks.batch.commit).not.toHaveBeenCalled();
  });

  it("creates an invisible copying note with durable zeroed counters", async () => {
    const result = await createSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedAttachmentCount: 2,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });

    expect(mocks.batch.set).toHaveBeenNthCalledWith(
      1,
      result.noteRef,
      expect.objectContaining({
        secureShareCopyExpectedAttachmentCount: 2,
        secureShareCopyJobId: "copy_job_1234567890",
        secureShareCopyReadyAttachmentCount: 0,
        secureShareCopyReservedAttachmentCount: 0,
        secureShareCopyStartedAt: mocks.timestamp,
        secureShareCopyState: "copying",
        secureShareCopyUpdatedAt: mocks.timestamp
      })
    );
  });

  it("forwards the caller AbortSignal to the Blob attachment upload", async () => {
    const controller = new AbortController();
    mocks.uploadNoteAttachmentBlob.mockResolvedValue(undefined);

    await expect(createNoteAttachment({
      encryptedBlob: new Blob([new Uint8Array([1, 2, 3, 4])]),
      encryption: {
        algorithm: "AES-GCM",
        encryptedSize: 20,
        iv: new Uint8Array(12),
        version: 1
      },
      extension: "pdf",
      fileName: "copy.pdf",
      mimeType: "application/pdf",
      noteId: "note-copy",
      originalSize: 4,
      secureShareCopyJobId: "copy_job_1234567890",
      signal: controller.signal,
      uploadedBy: "user-a"
    })).resolves.toEqual(expect.objectContaining({ id: "generated-1" }));

    expect(mocks.uploadNoteAttachmentBlob).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: "generated-1",
      noteId: "note-copy",
      secureShareCopyJobId: "copy_job_1234567890",
      signal: controller.signal
    }));
  });

  it("atomically activates only a fully reserved and ready copying note", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        ownerUid: "user-a",
        revision: 1,
        isDeleted: false,
        secureShareCopyState: "copying",
        secureShareCopyJobId: "copy_job_1234567890",
        secureShareCopyExpectedAttachmentCount: 2,
        secureShareCopyReservedAttachmentCount: 2,
        secureShareCopyReadyAttachmentCount: 2
      }),
      exists: () => true,
      id: "note-copy"
    });

    await expect(activateSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy",
      uid: "user-a"
    })).resolves.toEqual({ noteId: "note-copy", state: "active" });

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-copy" }),
      expect.objectContaining({
        secureShareCopyFinishedAt: mocks.timestamp,
        secureShareCopyState: "active",
        secureShareCopyUpdatedAt: mocks.timestamp
      })
    );
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("refuses activation while a reserved attachment is not ready", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        ownerUid: "user-a",
        revision: 1,
        isDeleted: false,
        secureShareCopyState: "copying",
        secureShareCopyJobId: "copy_job_1234567890",
        secureShareCopyExpectedAttachmentCount: 2,
        secureShareCopyReservedAttachmentCount: 2,
        secureShareCopyReadyAttachmentCount: 1
      }),
      exists: () => true,
      id: "note-copy"
    });

    await expect(activateSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy",
      uid: "user-a"
    })).rejects.toThrow("모두 준비되지 않았습니다");
    expect(mocks.transaction.update).not.toHaveBeenCalled();
  });

  it("pairs a stale copying-note abort with revision history", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        ownerUid: "user-a",
        revision: 1,
        secureShareCopyState: "copying",
        secureShareCopyJobId: "copy_job_1234567890",
        secureShareCopyReadyAttachmentCount: 0
      }),
      exists: () => true,
      id: "note-copy"
    });

    await abortSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy",
      uid: "user-a"
    });

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-copy" }),
      expect.objectContaining({
        isDeleted: true,
        secureShareCopyState: "aborted",
        revision: 2
      })
    );
    expect(mocks.transaction.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "delete", revision: 2 })
    );
  });

  it("queries only owner-scoped stale copying jobs through the recovery index", async () => {
    mocks.getDocs.mockResolvedValueOnce({
      docs: [{
        data: () => ({
          ownerUid: "user-a",
          secureShareCopyState: "copying"
        }),
        id: "note-copy"
      }]
    });
    const cutoff = new Date("2026-07-27T00:00:00.000Z");

    await expect(listStaleSecureShareCopyingNotes("user-a", cutoff, 20))
      .resolves.toEqual([expect.objectContaining({ id: "note-copy" })]);

    expect(mocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
    expect(mocks.where).toHaveBeenCalledWith("secureShareCopyState", "==", "copying");
    expect(mocks.where).toHaveBeenCalledWith("secureShareCopyUpdatedAt", "<=", cutoff);
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
      ...legacyStorageIdentity,
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

  it("rejects content writes when the stored entry format differs from the caller expectation", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        revision: 4
      }),
      exists: () => true,
      id: "vault-note"
    });

    await expect(updateRevisionedEncryptedNote({
      ...legacyStorageIdentity,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 4,
      noteId: "vault-note",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toThrow("현재 노트 상태");

    expect(mocks.transaction.update).not.toHaveBeenCalled();
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("reports a conflict before writing when the expected revision is stale", async () => {
    await expect(
      updateRevisionedEncryptedNote({
        ...legacyStorageIdentity,
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

  it("rejects a revision increment beyond the Rules maximum", async () => {
    mocks.transaction.get.mockResolvedValueOnce(noteSnapshot(999_999_999_999));

    await expect(updateRevisionedEncryptedNote({
      ...legacyStorageIdentity,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 999_999_999_999,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toThrow("안전한 저장 범위");

    expect(mocks.transaction.update).not.toHaveBeenCalled();
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("treats a legacy note without revision as revision 0", async () => {
    mocks.transaction.get.mockResolvedValueOnce(noteSnapshot(undefined));

    await updateRevisionedEncryptedNote({
      ...legacyStorageIdentity,
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
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        folderId: "folder-a",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        revision: 4,
        type: "personal",
        wrappedKeys: { "user-a": wrappedKey }
      }),
      exists: () => true,
      id: "note-a"
    });
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
        changedFields: ["participants", "folder"],
        readerUids: ["user-a", "user-b"],
        revision: 5
      })
    );
  });

  it("moves an owned personal note with a revisioned folder history record", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        folderId: null,
        ownerUid: "user-a",
        revision: 4,
        type: "personal"
      }),
      exists: () => true,
      id: "note-a"
    });

    await updateRevisionedNoteFolder({
      expectedRevision: 4,
      folderId: "folder-a",
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ folderId: "folder-a", revision: 5 })
    );
    expect(mocks.transaction.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "share",
        changedFields: ["folder"],
        readerUids: ["user-a"],
        revision: 5
      })
    );
  });

  it("rejects encrypted folder creation below an unmigrated legacy parent", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({ ownerUid: "user-a", name: "평문 폴더" }),
      exists: () => true,
      id: "legacy-parent"
    });

    await expect(createEncryptedNoteFolder({
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      order: 1,
      ownerUid: "user-a",
      parentId: "legacy-parent",
      wrappedKey
    })).rejects.toThrow("먼저 암호화");
    expect(mocks.transaction.set).not.toHaveBeenCalled();
  });

  it("rejects a folder move when the transaction ancestor chain reaches itself", async () => {
    mocks.transaction.get
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          ownerUid: "user-a",
          parentId: null,
          revision: 1,
          wrappedKey
        }),
        exists: () => true,
        id: "folder-a"
      })
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          ownerUid: "user-a",
          parentId: "folder-a",
          revision: 1,
          wrappedKey
        }),
        exists: () => true,
        id: "folder-b"
      });

    await expect(updateEncryptedNoteFolder({
      expectedRevision: 1,
      folderId: "folder-a",
      ownerUid: "user-a",
      parentId: "folder-b"
    })).rejects.toThrow("하위 폴더");
    expect(mocks.transaction.update).not.toHaveBeenCalled();
  });

  it("rejects a three-node folder cycle inside the revision-aware transaction", async () => {
    const folderSnapshot = (id: string, parentId: string | null) => ({
      data: () => ({
        encryptedName: encryptedPayload,
        ownerUid: "user-a",
        parentId,
        revision: 1,
        wrappedKey
      }),
      exists: () => true,
      id
    });
    mocks.transaction.get
      .mockResolvedValueOnce(folderSnapshot("folder-a", null))
      .mockResolvedValueOnce(folderSnapshot("folder-b", "folder-c"))
      .mockResolvedValueOnce(folderSnapshot("folder-c", "folder-a"));

    await expect(updateEncryptedNoteFolder({
      expectedRevision: 1,
      folderId: "folder-a",
      ownerUid: "user-a",
      parentId: "folder-b"
    })).rejects.toThrow("하위 폴더");

    expect(mocks.transaction.get).toHaveBeenCalledTimes(3);
    expect(mocks.transaction.update).not.toHaveBeenCalled();
  });

  it("keeps legacy folder migration idempotent but rejects a stale plaintext name", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        encryptedName: encryptedPayload,
        name: "암호화 폴더",
        ownerUid: "user-a",
        revision: 2,
        wrappedKey
      }),
      exists: () => true,
      id: "folder-a"
    });
    await expect(migrateLegacyNoteFolder({
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      expectedName: "이전 이름",
      folderId: "folder-a",
      order: 1,
      ownerUid: "user-a",
      parentId: null,
      wrappedKey
    })).resolves.toEqual({ folderId: "folder-a", revision: 2 });
    expect(mocks.transaction.update).not.toHaveBeenCalled();

    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({ name: "다른 탭 이름", ownerUid: "user-a" }),
      exists: () => true,
      id: "folder-b"
    });
    await expect(migrateLegacyNoteFolder({
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      expectedName: "이전 이름",
      folderId: "folder-b",
      order: 2,
      ownerUid: "user-a",
      parentId: null,
      wrappedKey
    })).rejects.toThrow("다른 탭");
    expect(mocks.transaction.update).not.toHaveBeenCalled();
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
    const activeQueries = mocks.query.mock.calls.filter((call) =>
      call.some((constraint) => {
        const candidate = constraint as { count?: number; type?: string };
        return candidate.type === "limit" && candidate.count === 80;
      })
    );
    expect(activeQueries).toHaveLength(2);
    expect(activeQueries.every((call) => call.some((constraint) => {
      const candidate = constraint as { parts?: unknown[]; type?: string };
      return candidate.type === "where"
        && candidate.parts?.[0] === "isDeleted"
        && candidate.parts[2] === false;
    }))).toBe(true);
  });

  it("paginates owner-safe legacy normalization beyond the visible-note limit", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      data: () => ({
        ...(index === 0 ? {} : { isDeleted: index % 2 === 0 }),
        ownerUid: "legacy-owner",
        participantUids: ["legacy-owner"],
        updatedAt: { toMillis: () => 1_000 - index }
      }),
      id: `recent-${index}`
    }));
    const olderLegacyDocument = {
      data: () => ({
        ownerUid: "legacy-owner",
        participantUids: ["legacy-owner"],
        updatedAt: { toMillis: () => 1 }
      }),
      id: "older-legacy"
    };
    mocks.getDocs
      .mockResolvedValueOnce({ docs: firstPage })
      .mockResolvedValueOnce({ docs: [olderLegacyDocument] });
    mocks.updateDoc.mockResolvedValue(undefined);

    subscribeVisibleNotes("legacy-owner", ["legacy-owner"], vi.fn(), vi.fn(), 10);

    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(2));
    expect(mocks.startAfter).toHaveBeenCalledWith(firstPage[99]);
    expect(mocks.updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ id: "older-legacy" }),
      { isDeleted: false }
    );
  });

  it("retries a transient legacy normalization failure on a later subscription", async () => {
    const legacyDocument = {
      data: () => ({
        ownerUid: "retry-owner",
        participantUids: ["retry-owner"],
        updatedAt: { toMillis: () => 1 }
      }),
      id: "retry-legacy"
    };
    mocks.getDocs.mockResolvedValue({ docs: [legacyDocument] });
    mocks.updateDoc
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(undefined);

    subscribeVisibleNotes("retry-owner", ["retry-owner"], vi.fn(), vi.fn(), 10);
    await vi.waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(1));

    subscribeVisibleNotes("retry-owner", ["retry-owner"], vi.fn(), vi.fn(), 10);

    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledTimes(2));
  });

  it("awaits a direct-read legacy repair before advancing the migration cursor", async () => {
    let rejectRepair!: (error: Error) => void;
    const legacyDocument = {
      data: () => ({
        ownerUid: "race-owner",
        participantUids: ["race-owner"],
        updatedAt: { toMillis: () => 1 }
      }),
      exists: () => true,
      id: "race-legacy"
    };
    mocks.getDoc.mockResolvedValue(legacyDocument);
    mocks.getDocs.mockResolvedValue({ docs: [legacyDocument] });
    mocks.updateDoc
      .mockReturnValueOnce(new Promise<void>((_resolve, reject) => {
        rejectRepair = reject;
      }))
      .mockResolvedValue(undefined);

    await getVisibleNotesByIds("race-owner", ["race-legacy"]);
    await vi.waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledTimes(1));

    subscribeVisibleNotes("race-owner", ["race-owner"], vi.fn(), vi.fn(), 10);
    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(1));
    expect(mocks.startAfter).not.toHaveBeenCalled();

    rejectRepair(new Error("temporarily unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscribeVisibleNotes("race-owner", ["race-owner"], vi.fn(), vi.fn(), 10);

    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledTimes(2));
    expect(mocks.startAfter).not.toHaveBeenCalled();
  });

  it("resumes after the per-run legacy scan cap and does not rescan a completed scope", async () => {
    const pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 100 }, (_, index) => ({
      data: () => ({
        isDeleted: false,
        ownerUid: "cursor-owner",
        participantUids: ["cursor-owner"],
        updatedAt: { toMillis: () => 10_000 - page * 100 - index }
      }),
      id: `page-${page}-note-${index}`
    })));
    const olderLegacyDocument = {
      data: () => ({
        ownerUid: "cursor-owner",
        participantUids: ["cursor-owner"],
        updatedAt: { toMillis: () => 1 }
      }),
      id: "cursor-older-legacy"
    };
    pages.forEach((page) => mocks.getDocs.mockResolvedValueOnce({ docs: page }));
    mocks.getDocs.mockResolvedValueOnce({ docs: [olderLegacyDocument] });
    mocks.updateDoc.mockResolvedValue(undefined);

    subscribeVisibleNotes("cursor-owner", ["cursor-owner"], vi.fn(), vi.fn(), 10);
    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(5));

    subscribeVisibleNotes("cursor-owner", ["cursor-owner"], vi.fn(), vi.fn(), 10);
    await vi.waitFor(() => expect(mocks.getDocs).toHaveBeenCalledTimes(6));
    expect(mocks.startAfter).toHaveBeenLastCalledWith(pages[4][99]);
    await vi.waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cursor-older-legacy" }),
      { isDeleted: false }
    ));

    subscribeVisibleNotes("cursor-owner", ["cursor-owner"], vi.fn(), vi.fn(), 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.getDocs).toHaveBeenCalledTimes(6);
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

  it("does not expose copying or aborted saga notes through visible direct reads", async () => {
    mocks.getDoc
      .mockResolvedValueOnce({
        data: () => ({
          isDeleted: false,
          ownerUid: "user-a",
          participantUids: ["user-a"],
          secureShareCopyState: "copying",
          updatedAt: { toMillis: () => 100 }
        }),
        exists: () => true,
        id: "copying-note"
      })
      .mockResolvedValueOnce({
        data: () => ({
          isDeleted: true,
          ownerUid: "user-a",
          participantUids: ["user-a"],
          secureShareCopyState: "aborted",
          updatedAt: { toMillis: () => 90 }
        }),
        exists: () => true,
        id: "aborted-note"
      });

    await expect(getVisibleNotesByIds("user-a", ["copying-note", "aborted-note"]))
      .resolves.toEqual({
        notes: [],
        resolvedNoteIds: ["copying-note", "aborted-note"]
      });
    expect(mocks.updateDoc).not.toHaveBeenCalled();
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

describe("note folder subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one bounded sentinel document and never emits a truncated folder list", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
    }) => void) | undefined;
    const unsubscribe = vi.fn();
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listener = args[1] as typeof listener;
      return unsubscribe;
    });

    const cleanup = subscribeNoteFolders("user-a", callback, onError);

    expect(mocks.limit).toHaveBeenCalledWith(5_001);

    listener?.({
      docs: Array.from({ length: 5_001 }, (_, index) => ({
        data: () => ({ name: `folder-${index}` }),
        id: `folder-${index}`
      }))
    });

    expect(callback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(NoteFolderLimitError));

    const error = onError.mock.calls[0][0] as NoteFolderLimitError;
    expect(error.code).toBe("note-folder/resource-limit-exceeded");
    expect(error.context).toBe("subscription");
    expect(error.message).toContain("전체 목록을 표시하지 않았습니다");
    expect(error.maxFolders).toBe(5_000);

    listener?.({
      docs: Array.from({ length: 5_001 }, (_, index) => ({
        data: () => ({ name: `folder-${index}` }),
        id: `folder-${index}`
      }))
    });

    expect(callback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resumes complete, sorted snapshots after the folder count returns below the limit", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
    }) => void) | undefined;
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listener = args[1] as typeof listener;
      return vi.fn();
    });

    subscribeNoteFolders("user-a", callback, onError);
    listener?.({
      docs: Array.from({ length: 5_001 }, (_, index) => ({
        data: () => ({ name: `folder-${index}` }),
        id: `folder-${index}`
      }))
    });
    listener?.({
      docs: [
        { data: () => ({ name: "나중", order: 2 }), id: "folder-b" },
        { data: () => ({ name: "먼저", order: 1 }), id: "folder-a" }
      ]
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ id: "folder-a", name: "먼저", order: 1 }),
      expect.objectContaining({ id: "folder-b", name: "나중", order: 2 })
    ]);
  });

  it("still emits the complete snapshot at the supported 5,000-folder boundary", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
    }) => void) | undefined;
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listener = args[1] as typeof listener;
      return vi.fn();
    });

    subscribeNoteFolders("user-a", callback, onError);
    listener?.({
      docs: Array.from({ length: 5_000 }, (_, index) => ({
        data: () => ({ name: `folder-${index}`, order: index }),
        id: `folder-${index}`
      }))
    });

    expect(onError).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toHaveLength(5_000);
  });
});

describe("legacy note folder creation limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCountFromServer.mockResolvedValue({ data: () => ({ count: 0 }) });
    mocks.addDoc.mockResolvedValue({ id: "folder-new" });
  });

  it("fails closed before writing when the bounded server count reaches 5,000", async () => {
    mocks.getCountFromServer.mockResolvedValueOnce({ data: () => ({ count: 5_000 }) });

    await expect(createNoteFolder("user-a", "새 폴더", "#123456"))
      .rejects.toMatchObject({
        code: "note-folder/resource-limit-exceeded",
        context: "create",
        maxFolders: 5_000
      });

    expect(mocks.limit).toHaveBeenCalledWith(5_000);
    expect(mocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
    expect(mocks.addDoc).not.toHaveBeenCalled();
  });

  it("creates after a bounded server count confirms capacity", async () => {
    mocks.getCountFromServer.mockResolvedValueOnce({ data: () => ({ count: 4_999 }) });

    await expect(createNoteFolder("user-a", "새 폴더", "#123456"))
      .resolves.toEqual({ id: "folder-new" });

    expect(mocks.getCountFromServer).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledWith(5_000);
    expect(mocks.addDoc).toHaveBeenCalledTimes(1);
  });

  it("does not write when the server preflight cannot be completed", async () => {
    mocks.getCountFromServer.mockRejectedValueOnce(new Error("unavailable"));

    await expect(createNoteFolder("user-a", "새 폴더", "#123456"))
      .rejects.toThrow("unavailable");

    expect(mocks.addDoc).not.toHaveBeenCalled();
  });
});
