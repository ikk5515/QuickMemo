import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NoteFolderLimitError,
  NoteRevisionConflictError,
  VaultNameConflictError,
  backfillRevisionedVaultNameClaim,
  abortSecureShareCopyingNote,
  activateSecureShareCopyingNote,
  createEncryptedNoteFolder,
  createEncryptedNoteFolderAtId,
  createNoteFolder,
  createNoteAttachment,
  createRevisionedEncryptedNote,
  createRevisionedEncryptedNoteAtId,
  createSecureShareCopyingNote,
  deleteNote,
  deleteRevisionedNote,
  getNoteRevisionState,
  loadOwnedVaultCutoverInventory,
  loadOwnedVaultCutoverNotes,
  getVisibleNotesByIds,
  getVisibleNotesByIdsFromServer,
  isLegacyHtmlNoteDocument,
  listStaleSecureShareCopyingNotes,
  migrateLegacyNoteFolder,
  migrateLegacyVaultNote,
  purgeNote,
  resolveEncryptedNoteFolderCollision,
  resolveRevisionedVaultNameCollision,
  restoreRevisionedNote,
  restoreRevisionedEncryptedFolderSubtree,
  subscribeDeletedNoteFolders,
  subscribeMyNoteStates,
  subscribeNoteFolders,
  subscribeNoteHistory,
  subscribeVisibleNotes,
  trashRevisionedEncryptedFolderSubtree,
  updateRevisionedEncryptedNote,
  updateEncryptedNoteFolder,
  updateRevisionedNoteAccess,
  updateRevisionedNoteFolder,
  vaultNameClaimReservationMatches
} from "./notes";
import { VaultNoteApiError } from "./vaultNoteMutations";

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
    delete: vi.fn(),
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
    getDocFromServer: vi.fn(),
    getDocs: vi.fn(),
    getDocsFromServer: vi.fn(),
    limit: vi.fn((count: number) => ({ count, type: "limit" })),
    ensureVaultFolderTree: vi.fn().mockResolvedValue({ status: "ready" }),
    mutateVaultNote: vi.fn(),
    mutateVaultFolder: vi.fn(),
    repairVaultFolderTree: vi.fn().mockResolvedValue({ status: "created" }),
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
  getDocFromServer: mocks.getDocFromServer,
  getCountFromServer: mocks.getCountFromServer,
  getDocs: mocks.getDocs,
  getDocsFromServer: mocks.getDocsFromServer,
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

vi.mock("./vaultFolderMutations", () => ({
  ensureVaultFolderTree: mocks.ensureVaultFolderTree,
  mutateVaultFolder: mocks.mutateVaultFolder,
  repairVaultFolderTree: mocks.repairVaultFolderTree
}));

vi.mock("./vaultNoteMutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vaultNoteMutations")>();
  return {
    ...actual,
    mutateVaultNote: mocks.mutateVaultNote
  };
});

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
const vaultClaimId = "C".repeat(43);
const vaultImportJobId = `vi1_${"J".repeat(43)}`;
const vaultNameClaim = (parentId: string | null) => ({
  claimId: vaultClaimId,
  indexVersion: 1 as const,
  parentId
});
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
    mocks.getDocsFromServer.mockResolvedValue({ docs: [] });
    mocks.transaction.get.mockReset().mockResolvedValue(noteSnapshot(4));
    mocks.mutateVaultNote.mockReset().mockImplementation(async (
      _uid: string,
      payload: { action: string; expectedRevision?: number; noteId?: string }
    ) => ({
      lastMutationId: "server-mutation-1",
      noteId: payload.noteId ?? "server-note-a",
      ok: true,
      revision: typeof payload.expectedRevision === "number" ? payload.expectedRevision + 1 : 1,
      ...(payload.action === "secure-copy-activate" ? { state: "active" } : {})
    }));
    mocks.mutateVaultFolder.mockReset().mockImplementation(async (
      _uid: string,
      payload: { expectedRevision?: number; folderId?: string }
    ) => ({
      folderId: payload.folderId,
      revision: typeof payload.expectedRevision === "number" ? payload.expectedRevision + 1 : 1,
      treeRevision: 1
    }));
    mocks.repairVaultFolderTree.mockReset().mockResolvedValue({ status: "created" });
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

  it("keeps missing legacy deletion metadata in the cutover inventory without a browser write", async () => {
    const legacy = {
      id: "legacy-active",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      secureShareCopyState: undefined,
      isPurged: false
    };
    mocks.getDocsFromServer.mockResolvedValueOnce({
      docs: [{
        id: legacy.id,
        data: () => Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "id"))
      }]
    });

    await expect(loadOwnedVaultCutoverNotes("user-a")).resolves.toEqual([
      expect.objectContaining({ id: "legacy-active" })
    ]);
    expect(mocks.batch.update).not.toHaveBeenCalled();
    expect(mocks.batch.commit).not.toHaveBeenCalled();
    expect(mocks.getDocsFromServer).toHaveBeenCalledOnce();
  });

  it("returns a bounded server inventory split into active and deleted notes", async () => {
    const documents = [
      { id: "active", isDeleted: false },
      { id: "deleted", isDeleted: true },
      { id: "copying", isDeleted: false, secureShareCopyState: "copying" },
      { id: "aborted", isDeleted: true, secureShareCopyState: "aborted" },
      { id: "purged", isDeleted: true, isPurged: true }
    ].map((value) => ({
      id: value.id,
      data: () => ({
        ownerUid: "user-a",
        participantUids: ["user-a"],
        ...value
      })
    }));
    mocks.getDocsFromServer.mockResolvedValueOnce({ docs: documents });

    await expect(loadOwnedVaultCutoverInventory("user-a")).resolves.toEqual({
      allNotes: expect.arrayContaining(documents.map((document) => expect.objectContaining({ id: document.id }))),
      activeNotes: [expect.objectContaining({ id: "active" })],
      deletedNotes: [expect.objectContaining({ id: "deleted" })]
    });
    expect(mocks.getDocsFromServer).toHaveBeenCalledOnce();
    expect(mocks.batch.commit).not.toHaveBeenCalled();
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

  it("creates a versioned Vault note through the server-authoritative contract", async () => {
    const result = await createRevisionedEncryptedNote({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });

    expect(result).toMatchObject({
      lastMutationId: "server-mutation-1",
      noteId: "server-note-a",
      revision: 1
    });
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "create",
      contentFormat: "markdown-v1",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      entryKind: "markdown",
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });
    expect(mocks.batch.set).not.toHaveBeenCalled();
  });

  it("delegates preallocated Vault creation to the server without an owner field", async () => {
    const input = {
      contentFormat: "markdown-v1" as const,
      entryKind: "markdown" as const,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal" as const,
      wrappedKeys: { "user-a": wrappedKey }
    };

    const result = await createRevisionedEncryptedNoteAtId(
      input,
      "import-note-a",
      vaultImportJobId
    );

    expect(result).toMatchObject({
      lastMutationId: "server-mutation-1",
      noteId: "import-note-a",
      revision: 1
    });
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "import-create",
      contentFormat: "markdown-v1",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      entryKind: "markdown",
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      importJobId: vaultImportJobId,
      nameClaim: vaultNameClaim(null),
      noteId: "import-note-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("returns the server's exact idempotent response-loss retry result", async () => {
    mocks.mutateVaultNote.mockResolvedValueOnce({
      lastMutationId: "history-original",
      noteId: "import-note-a",
      ok: true,
      revision: 1
    });

    await expect(createRevisionedEncryptedNoteAtId({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    }, "import-note-a", vaultImportJobId)).resolves.toMatchObject({
      lastMutationId: "history-original",
      noteId: "import-note-a",
      revision: 1
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("propagates a server-detected encrypted import history conflict", async () => {
    const conflict = new VaultNoteApiError("vault_import_history_conflict", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(conflict);

    await expect(createRevisionedEncryptedNoteAtId({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    }, "import-note-a", vaultImportJobId)).rejects.toBe(conflict);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("propagates a server-detected encrypted import after-state conflict", async () => {
    const conflict = new VaultNoteApiError("vault_import_state_conflict", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(conflict);

    await expect(createRevisionedEncryptedNoteAtId({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    }, "import-note-a", vaultImportJobId)).rejects.toBe(conflict);
  });

  it("maps an import name reservation conflict to the public Vault error", async () => {
    mocks.mutateVaultNote.mockRejectedValueOnce(
      new VaultNoteApiError("vault_name_conflict", 409)
    );

    await expect(createRevisionedEncryptedNoteAtId({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    }, "import-note-a", vaultImportJobId)).rejects.toEqual(
      expect.objectContaining<Partial<VaultNameConflictError>>({
        claimId: vaultClaimId,
        code: "vault/name-conflict"
      })
    );
  });

  it("rejects malformed import provenance before contacting the server", async () => {
    await expect(createRevisionedEncryptedNoteAtId({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    }, "import-note-a", "invalid-job-id")).rejects.toThrow("가져오기 작업 식별자");
    expect(mocks.mutateVaultNote).not.toHaveBeenCalled();
  });

  it("leaves import claim ownership validation to the authoritative endpoint", async () => {
    const conflict = new VaultNoteApiError("vault_name_conflict", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(conflict);

    await expect(createRevisionedEncryptedNoteAtId({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    }, "import-note-a", vaultImportJobId)).rejects.toMatchObject({
      code: "vault/name-conflict"
    });
    expect(mocks.transaction.get).not.toHaveBeenCalled();
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

  it("creates an invisible copying note through the server-owned counter boundary", async () => {
    const result = await createSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      contentFormat: "legacy-html-v1",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      entryKind: "legacy-html",
      expectedAttachmentCount: 2,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      noteId: "copy-note-a",
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });

    expect(result).toMatchObject({ noteId: "copy-note-a", revision: 1 });
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "secure-copy-create",
      copyJobId: "copy_job_1234567890",
      contentFormat: "legacy-html-v1",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      entryKind: "legacy-html",
      expectedAttachmentCount: 2,
      historySnapshot: encryptedPayload,
      historySummary: encryptedPayload,
      noteId: "copy-note-a",
      nameClaim: vaultNameClaim(null),
      participantUids: ["user-a"],
      type: "personal",
      wrappedKeys: { "user-a": wrappedKey }
    });
    expect(mocks.batch.set).not.toHaveBeenCalled();
  });

  it("retries a response-loss secure-copy create with the same preallocated note id", async () => {
    mocks.mutateVaultNote
      .mockRejectedValueOnce(new VaultNoteApiError("network_error", 0))
      .mockResolvedValueOnce({
        lastMutationId: "server-mutation-1",
        noteId: "copy-note-retry",
        ok: true,
        revision: 1
      });
    const input = {
      copyJobId: "copy_job_retry_1234",
      contentFormat: "legacy-html-v1" as const,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      entryKind: "legacy-html" as const,
      expectedAttachmentCount: 0,
      noteId: "copy-note-retry",
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      participantUids: ["user-a"],
      type: "personal" as const,
      wrappedKeys: { "user-a": wrappedKey }
    };

    await expect(createSecureShareCopyingNote(input)).resolves.toMatchObject({
      noteId: "copy-note-retry",
      revision: 1
    });
    expect(mocks.mutateVaultNote).toHaveBeenCalledTimes(2);
    expect(mocks.mutateVaultNote.mock.calls[0]).toEqual(mocks.mutateVaultNote.mock.calls[1]);
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

  it("delegates atomic copying-note activation without sending the caller uid", async () => {
    await expect(activateSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy",
      uid: "user-a"
    })).resolves.toEqual({ noteId: "note-copy", state: "active" });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "secure-copy-activate",
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy"
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("propagates the server's refusal when a reserved attachment is not ready", async () => {
    const notReady = new VaultNoteApiError("secure_copy_not_ready", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(notReady);

    await expect(activateSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy",
      uid: "user-a"
    })).rejects.toBe(notReady);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("delegates stale copying-note abort and revision history atomically", async () => {
    await abortSecureShareCopyingNote({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy",
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "secure-copy-abort",
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy"
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
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

  it("sends an exact revisioned content update to the authoritative endpoint", async () => {
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
      lastMutationId: "server-mutation-1",
      noteId: "note-a",
      ok: true,
      revision: 5
    });
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "update",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"]
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("backfills only claim metadata through the server contract without ciphertext fields", async () => {
    await backfillRevisionedVaultNameClaim({
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 4,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      noteId: "vault-note",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "backfill-claim",
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 4,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      noteId: "vault-note",
      readerUids: ["user-a"]
    });
    expect(mocks.mutateVaultNote.mock.calls[0]?.[1]).not.toHaveProperty("encryptedBody");
    expect(mocks.mutateVaultNote.mock.calls[0]?.[1]).not.toHaveProperty("encryptedTitle");
  });

  it("migrates legacy storage identity through the owner-only server contract", async () => {
    mocks.mutateVaultNote.mockResolvedValueOnce({
      claimState: "reserved",
      lastMutationId: "legacy-migration",
      noteId: "legacy-note",
      ok: true,
      revision: 5
    });

    await expect(migrateLegacyVaultNote({
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 4,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      noteId: "legacy-note",
      readerUids: ["user-a"],
      uid: "user-a"
    })).resolves.toEqual({
      claimState: "reserved",
      lastMutationId: "legacy-migration",
      noteId: "legacy-note",
      revision: 5
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 4,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      noteId: "legacy-note",
      readerUids: ["user-a"]
    });
  });

  it("resolves an unclaimed collision without sending the stored body", async () => {
    await resolveRevisionedVaultNameCollision({
      changedFields: ["title", "name-claim"],
      encryptedTitle: { ...encryptedPayload, cipherText: "replacement-title" },
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 4,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      noteId: "collision-note",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "resolve-collision",
      changedFields: ["title", "name-claim"],
      encryptedTitle: { ...encryptedPayload, cipherText: "replacement-title" },
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 4,
      historySummary: encryptedPayload,
      nameClaim: vaultNameClaim(null),
      noteId: "collision-note",
      readerUids: ["user-a"]
    });
    expect(mocks.mutateVaultNote.mock.calls[0]?.[1]).not.toHaveProperty("encryptedBody");
  });

  it("propagates a server rejection when the stored entry format differs", async () => {
    const mismatch = new VaultNoteApiError("vault_storage_identity_mismatch", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(mismatch);

    await expect(updateRevisionedEncryptedNote({
      ...legacyStorageIdentity,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 4,
      noteId: "vault-note",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toBe(mismatch);

    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("maps the endpoint's stale revision to NoteRevisionConflictError", async () => {
    mocks.mutateVaultNote.mockRejectedValueOnce(
      new VaultNoteApiError("revision_conflict", 409, 4)
    );
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
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("repairs a stale folder tree and retries a note mutation exactly once", async () => {
    mocks.mutateVaultNote
      .mockRejectedValueOnce(new VaultNoteApiError("vault_tree_repair_required", 409))
      .mockResolvedValueOnce({
        lastMutationId: "mutation-a",
        noteId: "note-a",
        ok: true,
        revision: 5
      });

    await expect(updateRevisionedNoteFolder({
      expectedRevision: 4,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).resolves.toMatchObject({ revision: 5 });

    expect(mocks.repairVaultFolderTree).toHaveBeenCalledWith("user-a", undefined);
    expect(mocks.mutateVaultNote).toHaveBeenCalledTimes(2);
    expect(mocks.mutateVaultNote.mock.calls[0]?.[1]).toEqual(mocks.mutateVaultNote.mock.calls[1]?.[1]);
  });

  it("does not loop when a repaired-tree retry is rejected", async () => {
    const first = new VaultNoteApiError("vault_tree_repair_required", 409);
    const second = new VaultNoteApiError("vault_parent_unavailable", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(first).mockRejectedValueOnce(second);

    await expect(updateRevisionedNoteFolder({
      expectedRevision: 4,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toBe(second);

    expect(mocks.mutateVaultNote).toHaveBeenCalledTimes(2);
    expect(mocks.repairVaultFolderTree).toHaveBeenCalledOnce();
  });

  it("repairs a stale parent index before retrying a note mutation exactly once", async () => {
    mocks.mutateVaultNote
      .mockRejectedValueOnce(new VaultNoteApiError("vault_parent_unavailable", 409))
      .mockResolvedValueOnce({
        lastMutationId: "mutation-parent",
        noteId: "note-a",
        ok: true,
        revision: 5
      });

    await expect(updateRevisionedNoteFolder({
      expectedRevision: 4,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).resolves.toMatchObject({ revision: 5 });

    expect(mocks.repairVaultFolderTree).toHaveBeenCalledWith("user-a", undefined);
    expect(mocks.mutateVaultNote).toHaveBeenCalledTimes(2);
  });

  it("propagates the server's rejection at the maximum revision", async () => {
    const limitReached = new VaultNoteApiError("revision_limit", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(limitReached);

    await expect(updateRevisionedEncryptedNote({
      ...legacyStorageIdentity,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 999_999_999_999,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toBe(limitReached);

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", expect.objectContaining({
      action: "update",
      expectedRevision: 999_999_999_999
    }));
  });

  it("preserves expected revision zero for a legacy cutover note", async () => {
    await updateRevisionedEncryptedNote({
      ...legacyStorageIdentity,
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 0,
      noteId: "legacy-note",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "update",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 0,
      noteId: "legacy-note",
      readerUids: ["user-a"]
    });
  });

  it("sends access changes to the endpoint for atomic normalization and history", async () => {
    await updateRevisionedNoteAccess({
      expectedRevision: 4,
      folderId: "ignored-for-shared",
      noteId: "note-a",
      participantUids: ["user-a", "user-b", "user-b"],
      type: "shared",
      uid: "user-a",
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "access",
      expectedRevision: 4,
      folderId: "ignored-for-shared",
      noteId: "note-a",
      participantUids: ["user-a", "user-b", "user-b"],
      type: "shared",
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });
  });

  it("moves an owned personal note through the revisioned server contract", async () => {
    await updateRevisionedNoteFolder({
      expectedRevision: 4,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "move",
      expectedRevision: 4,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"]
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("forwards the atomic rewrite binding and maps a concurrent note name claim", async () => {
    const activation = { expectedRevision: 7, jobId: `pr2_${"N".repeat(43)}` };
    mocks.mutateVaultNote.mockRejectedValueOnce(new VaultNoteApiError("vault_name_conflict", 409));
    await expect(updateRevisionedNoteFolder({
      expectedRevision: 4,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      pathRewriteActivation: activation,
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toMatchObject({
      code: "vault/name-conflict",
      claimId: vaultClaimId
    });
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", expect.objectContaining({
      action: "move",
      pathRewriteActivation: activation
    }));
  });

  it("delegates encrypted folder creation and parent validation to the authoritative server tree", async () => {
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
      nameClaim: vaultNameClaim("legacy-parent"),
      wrappedKey
    })).resolves.toMatchObject({ id: "generated-1" });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({
        action: "create",
        folderId: "generated-1",
        parentId: "legacy-parent"
      })
    );
  });

  it("creates and idempotently recognizes an untouched preallocated encrypted folder", async () => {
    mocks.transaction.get
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({ exists: () => false });
    const input = {
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      order: 1,
      ownerUid: "user-a",
      parentId: null,
      nameClaim: vaultNameClaim(null),
      wrappedKey
    };

    await expect(createEncryptedNoteFolderAtId(input, "import-folder-a", vaultImportJobId))
      .resolves.toMatchObject({ id: "import-folder-a" });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({
        action: "create",
        folderId: "import-folder-a",
        importJobId: vaultImportJobId,
        nameClaim: expect.objectContaining({ claimId: vaultClaimId })
      })
    );

    vi.clearAllMocks();
    mocks.runTransaction.mockImplementation(async (_db, updateFunction) => updateFunction(mocks.transaction));
    mocks.transaction.get
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          encryptedName: encryptedPayload,
          isDeleted: false,
          ownerUid: "user-a",
          parentId: null,
          revision: 1,
          vaultNameClaimId: vaultClaimId,
          vaultNameIndexVersion: 1,
          vaultImportJobId,
          vaultAncestorIds: [],
          vaultLineageDepth: 0,
          vaultLineageGeneration: 1,
          vaultLineageVersion: 1,
          wrappedKey
        })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          indexVersion: 1,
          ownerUid: "user-a",
          parentId: null,
          targetId: "import-folder-a",
          targetType: "folder"
        })
      });
    await expect(createEncryptedNoteFolderAtId(input, "import-folder-a", vaultImportJobId))
      .resolves.toMatchObject({ id: "import-folder-a" });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledOnce();
  });

  it("delegates cycle-safe folder moves to the authoritative server tree", async () => {
    mocks.transaction.get
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          ownerUid: "user-a",
          parentId: "root-x",
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
      nameClaim: vaultNameClaim("folder-b"),
      ownerUid: "user-a",
      parentId: "folder-b"
    })).resolves.toMatchObject({ folderId: "folder-a", revision: 2 });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith("user-a", {
      action: "move",
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-b"),
      parentId: "folder-b"
    });
  });

  it("repairs a stale server tree and retries a folder move exactly once", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        encryptedName: encryptedPayload,
        ownerUid: "user-a",
        parentId: null,
        revision: 1,
        wrappedKey
      }),
      exists: () => true,
      id: "folder-a"
    });
    mocks.mutateVaultFolder
      .mockRejectedValueOnce(Object.assign(new Error("stale tree"), {
        code: "vault_tree_stale"
      }))
      .mockResolvedValueOnce({ folderId: "folder-a", revision: 2, treeRevision: 4 });

    await expect(updateEncryptedNoteFolder({
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-b"),
      ownerUid: "user-a",
      parentId: "folder-b"
    })).resolves.toMatchObject({ folderId: "folder-a", revision: 2 });

    expect(mocks.repairVaultFolderTree).toHaveBeenCalledWith("user-a", undefined);
    expect(mocks.mutateVaultFolder).toHaveBeenCalledTimes(2);
    expect(mocks.mutateVaultFolder.mock.calls[0]?.[1])
      .toEqual(mocks.mutateVaultFolder.mock.calls[1]?.[1]);
  });

  it("uses the dedicated folder collision recovery action", async () => {
    await expect(resolveEncryptedNoteFolderCollision({
      encryptedName: encryptedPayload,
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a"
    })).resolves.toMatchObject({ folderId: "folder-a", revision: 2 });

    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith("user-a", {
      action: "resolve-collision",
      encryptedName: encryptedPayload,
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim(null)
    });
  });

  it("forwards atomic rewrite activation for folder moves and collision recovery", async () => {
    const activation = { expectedRevision: 9, jobId: `pr2_${"F".repeat(43)}` };
    await updateEncryptedNoteFolder({
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-b"),
      ownerUid: "user-a",
      parentId: "folder-b",
      pathRewriteActivation: activation
    });
    expect(mocks.mutateVaultFolder).toHaveBeenLastCalledWith("user-a", expect.objectContaining({
      action: "move",
      pathRewriteActivation: activation
    }));

    await resolveEncryptedNoteFolderCollision({
      encryptedName: encryptedPayload,
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim(null),
      ownerUid: "user-a",
      pathRewriteActivation: activation
    });
    expect(mocks.mutateVaultFolder).toHaveBeenLastCalledWith("user-a", expect.objectContaining({
      action: "resolve-collision",
      pathRewriteActivation: activation
    }));
  });

  it("delegates deep folder moves without a client-side depth-one ceiling", async () => {
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
      .mockResolvedValueOnce(folderSnapshot("folder-a", "root-x"))
      .mockResolvedValueOnce(folderSnapshot("folder-b", "folder-c"));

    await expect(updateEncryptedNoteFolder({
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-b"),
      ownerUid: "user-a",
      parentId: "folder-b"
    })).resolves.toMatchObject({ folderId: "folder-a", revision: 2 });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ action: "move", folderId: "folder-a", parentId: "folder-b" })
    );
  });

  it("allows the server authority to validate moving an existing root below another folder", async () => {
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        encryptedName: encryptedPayload,
        ownerUid: "user-a",
        parentId: null,
        revision: 1,
        wrappedKey
      }),
      exists: () => true,
      id: "folder-a"
    });

    await expect(updateEncryptedNoteFolder({
      expectedRevision: 1,
      folderId: "folder-a",
      nameClaim: vaultNameClaim("folder-b"),
      ownerUid: "user-a",
      parentId: "folder-b"
    })).resolves.toMatchObject({ folderId: "folder-a", revision: 2 });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ action: "move", folderId: "folder-a", parentId: "folder-b" })
    );
  });

  it("keeps legacy folder migration idempotent but rejects a stale plaintext name", async () => {
    mocks.mutateVaultFolder.mockResolvedValueOnce({
      folderId: "folder-a",
      revision: 2,
      treeRevision: 1
    });
    mocks.transaction.get.mockResolvedValueOnce({
      data: () => ({
        encryptedName: encryptedPayload,
        name: "암호화 폴더",
        ownerUid: "user-a",
        revision: 2,
        vaultNameClaimId: vaultClaimId,
        vaultNameIndexVersion: 1,
        vaultAncestorIds: [],
        vaultLineageDepth: 0,
        vaultLineageGeneration: 1,
        vaultLineageVersion: 1,
        wrappedKey
      }),
      exists: () => true,
      id: "folder-a"
    }).mockResolvedValueOnce({
      data: () => ({
        indexVersion: 1,
        ownerUid: "user-a",
        parentId: null,
        targetId: "folder-a",
        targetType: "folder"
      }),
      exists: () => true,
      id: vaultClaimId
    });
    await expect(migrateLegacyNoteFolder({
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      expectedName: "이전 이름",
      folderId: "folder-a",
      order: 1,
      ownerUid: "user-a",
      parentId: null,
      nameClaim: vaultNameClaim(null),
      wrappedKey
    })).resolves.toEqual({ folderId: "folder-a", revision: 2, treeRevision: 1 });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({
        action: "migrate",
        expectedName: "이전 이름",
        folderId: "folder-a"
      })
    );

    mocks.mutateVaultFolder.mockRejectedValueOnce(new Error("다른 탭에서 폴더 이름이 변경되었습니다."));
    mocks.transaction.get
      .mockResolvedValueOnce({
        data: () => ({ name: "다른 탭 이름", ownerUid: "user-a" }),
        exists: () => true,
        id: "folder-b"
      })
      .mockResolvedValueOnce({ exists: () => false });
    await expect(migrateLegacyNoteFolder({
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      expectedName: "이전 이름",
      folderId: "folder-b",
      order: 2,
      ownerUid: "user-a",
      parentId: null,
      nameClaim: vaultNameClaim(null),
      wrappedKey
    })).rejects.toThrow("다른 탭");
  });

  it("tombstones an encrypted folder subtree with one revision-aware folder write and retains its claim", async () => {
    const lifecycleFolder = {
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      id: "folder-a",
      isDeleted: false,
      name: "암호화 폴더",
      ownerUid: "user-a",
      parentId: null,
      revision: 4,
      vaultNameClaimId: vaultClaimId,
      vaultNameIndexVersion: 1 as const,
      wrappedKey
    };
    mocks.transaction.get
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          isDeleted: false,
          ownerUid: "user-a",
          parentId: null,
          revision: 4,
          vaultNameClaimId: vaultClaimId,
          vaultNameIndexVersion: 1,
          wrappedKey
        }),
        exists: () => true,
        id: "folder-a"
      })
      .mockResolvedValueOnce({
        data: () => ({
          indexVersion: 1,
          ownerUid: "user-a",
          parentId: null,
          targetId: "folder-a",
          targetType: "folder"
        }),
        exists: () => true,
        id: vaultClaimId
      });

    await expect(trashRevisionedEncryptedFolderSubtree({
      expectedRevision: 4,
      folderId: "folder-a",
      folders: [lifecycleFolder],
      ownerUid: "user-a"
    })).resolves.toEqual({ folderId: "folder-a", revision: 5, treeRevision: 1 });

    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith("user-a", {
      action: "trash",
      expectedRevision: 4,
      folderId: "folder-a"
    });
  });

  it("restores a nested subtree only when its parent and retained claim are server-confirmed", async () => {
    const parent = {
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      id: "parent",
      isDeleted: false,
      name: "암호화 폴더",
      ownerUid: "user-a",
      parentId: null,
      revision: 2,
      vaultNameClaimId: "P".repeat(43),
      vaultNameIndexVersion: 1 as const,
      wrappedKey
    };
    const lifecycleFolder = {
      ...parent,
      id: "folder-a",
      isDeleted: true,
      parentId: "parent",
      revision: 4,
      vaultNameClaimId: vaultClaimId
    };
    mocks.transaction.get
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          isDeleted: true,
          ownerUid: "user-a",
          parentId: "parent",
          revision: 4,
          vaultNameClaimId: vaultClaimId,
          vaultNameIndexVersion: 1,
          wrappedKey
        }),
        exists: () => true,
        id: "folder-a"
      })
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          isDeleted: false,
          ownerUid: "user-a",
          parentId: null,
          revision: 2,
          wrappedKey
        }),
        exists: () => true,
        id: "parent"
      });

    await restoreRevisionedEncryptedFolderSubtree({
      expectedRevision: 4,
      folderId: "folder-a",
      folders: [parent, lifecycleFolder],
      ownerUid: "user-a"
    });

    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith("user-a", {
      action: "restore",
      expectedRevision: 4,
      folderId: "folder-a"
    });
  });

  it("reacquires the stored deterministic claim when restoring a deleted root folder", async () => {
    const lifecycleFolder = {
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      id: "folder-a",
      isDeleted: true,
      name: "암호화 폴더",
      ownerUid: "user-a",
      parentId: null,
      revision: 4,
      vaultNameClaimId: vaultClaimId,
      vaultNameIndexVersion: 1 as const,
      wrappedKey
    };
    mocks.transaction.get
      .mockResolvedValueOnce({
        data: () => ({
          encryptedName: encryptedPayload,
          isDeleted: true,
          ownerUid: "user-a",
          parentId: null,
          revision: 4,
          vaultNameClaimId: vaultClaimId,
          vaultNameIndexVersion: 1,
          wrappedKey
        }),
        exists: () => true,
        id: "folder-a"
      })
      .mockResolvedValueOnce({ exists: () => false });

    await expect(restoreRevisionedEncryptedFolderSubtree({
      expectedRevision: 4,
      folderId: "folder-a",
      folders: [lifecycleFolder],
      ownerUid: "user-a"
    })).resolves.toEqual({ folderId: "folder-a", revision: 5, treeRevision: 1 });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith("user-a", {
      action: "restore",
      expectedRevision: 4,
      folderId: "folder-a"
    });
  });

  it("fails closed when a deleted root folder claim is now occupied by another target", async () => {
    mocks.mutateVaultFolder.mockRejectedValueOnce(Object.assign(new Error("폴더 이름이 이미 사용 중입니다."), {
      code: "vault_name_conflict"
    }));
    const lifecycleFolder = {
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      id: "folder-a",
      isDeleted: true,
      name: "암호화 폴더",
      ownerUid: "user-a",
      parentId: null,
      revision: 4,
      vaultNameClaimId: vaultClaimId,
      vaultNameIndexVersion: 1 as const,
      wrappedKey
    };
    mocks.transaction.get
      .mockResolvedValueOnce({ data: () => lifecycleFolder, exists: () => true, id: "folder-a" })
      .mockResolvedValueOnce({
        data: () => ({
          indexVersion: 1,
          ownerUid: "user-a",
          parentId: null,
          targetId: "replacement-folder",
          targetType: "folder"
        }),
        exists: () => true,
        id: vaultClaimId
      });

    await expect(restoreRevisionedEncryptedFolderSubtree({
      expectedRevision: 4,
      folderId: "folder-a",
      folders: [lifecycleFolder],
      ownerUid: "user-a"
    })).rejects.toMatchObject({ code: "vault/name-conflict" });
    expect(mocks.mutateVaultFolder).toHaveBeenCalledWith("user-a", {
      action: "restore",
      expectedRevision: 4,
      folderId: "folder-a"
    });
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

  it("delegates name-claim release and revisioned trash atomically", async () => {
    await deleteRevisionedNote({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "trash",
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"]
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("matches only the exact owner, target, type, parent and index in a blinded claim document", async () => {
    mocks.getDoc.mockResolvedValueOnce({
      data: () => ({
        indexVersion: 1,
        ownerUid: "user-a",
        parentId: "folder-a",
        targetId: "note-a",
        targetType: "entry"
      }),
      exists: () => true
    });
    await expect(vaultNameClaimReservationMatches({
      claimId: vaultClaimId,
      ownerUid: "user-a",
      parentId: "folder-a",
      targetId: "note-a",
      targetType: "entry"
    })).resolves.toBe(true);

    mocks.getDoc.mockResolvedValueOnce({
      data: () => ({
        indexVersion: 1,
        ownerUid: "user-b",
        parentId: "folder-a",
        targetId: "note-a",
        targetType: "entry"
      }),
      exists: () => true
    });
    await expect(vaultNameClaimReservationMatches({
      claimId: vaultClaimId,
      ownerUid: "user-a",
      parentId: "folder-a",
      targetId: "note-a",
      targetType: "entry"
    })).resolves.toBe(false);
  });

  it("atomically redacts a purged note and enqueues durable server cleanup", async () => {
    await purgeNote({
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 4,
      noteId: "note-a",
      ownerUid: "user-a",
      uid: "user-a",
      wrappedKey
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "purge",
      encryptedBody: encryptedPayload,
      encryptedTitle: encryptedPayload,
      expectedRevision: 4,
      noteId: "note-a",
      wrappedKey
    });
    expect(mocks.batch.commit).not.toHaveBeenCalled();
    expect(mocks.getDocs).not.toHaveBeenCalled();
    expect(mocks.deleteBlobAttachment).not.toHaveBeenCalled();
  });

  it("restores with an expected revision through the paired server mutation", async () => {
    await restoreRevisionedNote({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "restore",
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"]
    });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("returns the server result after atomically reacquiring a stored name claim", async () => {
    await expect(restoreRevisionedNote({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).resolves.toEqual({
      lastMutationId: "server-mutation-1",
      noteId: "note-a",
      ok: true,
      revision: 5
    });
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "restore",
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"]
    });
  });

  it("fails closed when the server reports missing reservation metadata", async () => {
    const missingClaim = new VaultNoteApiError("vault_name_claim_missing", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(missingClaim);

    await expect(restoreRevisionedNote({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toBe(missingClaim);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("atomically claims and restores a pre-cutover Vault entry through the endpoint", async () => {
    await restoreRevisionedNote({
      expectedRevision: 4,
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });

    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-a", {
      action: "restore",
      expectedRevision: 4,
      nameClaim: vaultNameClaim("folder-a"),
      noteId: "note-a",
      readerUids: ["user-a"]
    });
  });

  it("propagates server authorization rejection for a forged restore claim", async () => {
    const forbidden = new VaultNoteApiError("forbidden", 403);
    mocks.mutateVaultNote.mockRejectedValueOnce(forbidden);

    await expect(restoreRevisionedNote({
      expectedRevision: 4,
      nameClaim: vaultNameClaim(null),
      noteId: "note-a",
      readerUids: ["user-a", "user-b"],
      uid: "user-b"
    })).rejects.toBe(forbidden);
    expect(mocks.mutateVaultNote).toHaveBeenCalledWith("user-b", {
      action: "restore",
      expectedRevision: 4,
      nameClaim: vaultNameClaim(null),
      noteId: "note-a",
      readerUids: ["user-a", "user-b"]
    });
    expect(mocks.repairVaultFolderTree).not.toHaveBeenCalled();
  });

  it("rejects restore when another target acquired the released claim", async () => {
    const conflict = new VaultNoteApiError("vault_name_conflict", 409);
    mocks.mutateVaultNote.mockRejectedValueOnce(conflict);

    await expect(restoreRevisionedNote({
      expectedRevision: 4,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    })).rejects.toBe(conflict);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
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

  it("marks a cached first snapshot incomplete until the server snapshot arrives", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
      metadata: { fromCache: boolean; hasPendingWrites?: boolean };
    }) => void) | undefined;
    const callback = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      expect(args[1]).toEqual({ includeMetadataChanges: true });
      listener = args[2] as typeof listener;
      return vi.fn();
    });

    subscribeVisibleNotes("admin-a", null, callback, vi.fn(), 80);
    const document = {
      data: () => ({
        isDeleted: false,
        ownerUid: "owner-a",
        participantUids: ["admin-a"],
        updatedAt: { toMillis: () => 100 }
      }),
      id: "note-a"
    };

    listener?.({ docs: [document], metadata: { fromCache: true } });
    listener?.({ docs: [document], metadata: { fromCache: false, hasPendingWrites: true } });
    listener?.({ docs: [document], metadata: { fromCache: false, hasPendingWrites: false } });

    expect(callback).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ id: "note-a" })],
      { fromCache: true, hasPendingWrites: false, serverComplete: false }
    );
    expect(callback).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ id: "note-a" })],
      { fromCache: false, hasPendingWrites: true, serverComplete: false }
    );
    expect(callback).toHaveBeenNthCalledWith(
      3,
      [expect.objectContaining({ id: "note-a" })],
      { fromCache: false, hasPendingWrites: false, serverComplete: true }
    );
  });

  it("clears a single-query note snapshot when its listener loses authorization", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
      metadata: { fromCache: boolean; hasPendingWrites?: boolean };
    }) => void) | undefined;
    let errorListener: ((error: Error) => void) | undefined;
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listener = args[2] as typeof listener;
      errorListener = args[3] as typeof errorListener;
      return vi.fn();
    });

    subscribeVisibleNotes("admin-a", null, callback, onError, 80);
    listener?.({
      docs: [{
        data: () => ({
          isDeleted: false,
          ownerUid: "owner-a",
          participantUids: ["admin-a"],
          updatedAt: { toMillis: () => 100 }
        }),
        id: "private-note"
      }],
      metadata: { fromCache: false, hasPendingWrites: false }
    });
    expect(callback).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "private-note" })],
      { fromCache: false, hasPendingWrites: false, serverComplete: true }
    );

    const permissionError = new Error("permission-denied");
    errorListener?.(permissionError);
    expect(callback).toHaveBeenLastCalledWith(
      [],
      { fromCache: false, hasPendingWrites: false, serverComplete: false }
    );
    expect(onError).toHaveBeenCalledWith(permissionError);

    listener?.({
      docs: [{
        data: () => ({
          isDeleted: false,
          ownerUid: "owner-a",
          participantUids: ["admin-a"],
          updatedAt: { toMillis: () => 200 }
        }),
        id: "stale-private-note"
      }],
      metadata: { fromCache: false, hasPendingWrites: false }
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("requires every owner query to emit a non-cache snapshot before reporting server completeness", () => {
    const listeners: Array<(snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
      metadata: { fromCache: boolean; hasPendingWrites?: boolean };
    }) => void> = [];
    const callback = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      expect(args[1]).toEqual({ includeMetadataChanges: true });
      listeners.push(args[2] as (typeof listeners)[number]);
      return vi.fn();
    });

    subscribeVisibleNotes("user-a", ["user-a", "owner-b"], callback, vi.fn(), 80);
    const document = (id: string, ownerUid: string, updatedAt: number) => ({
      data: () => ({
        isDeleted: false,
        ownerUid,
        participantUids: ["user-a"],
        updatedAt: { toMillis: () => updatedAt }
      }),
      id
    });

    listeners[0]({
      docs: [document("note-a", "user-a", 100)],
      metadata: { fromCache: false }
    });
    expect(callback).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "note-a" })],
      { fromCache: false, hasPendingWrites: false, serverComplete: false }
    );

    listeners[1]({
      docs: [document("note-b", "owner-b", 200)],
      metadata: { fromCache: true }
    });
    expect(callback).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({ id: "note-b" }),
        expect.objectContaining({ id: "note-a" })
      ],
      { fromCache: true, hasPendingWrites: false, serverComplete: false }
    );

    listeners[1]({
      docs: [document("note-b", "owner-b", 200)],
      metadata: { fromCache: false }
    });
    expect(callback).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({ id: "note-b" }),
        expect.objectContaining({ id: "note-a" })
      ],
      { fromCache: false, hasPendingWrites: false, serverComplete: true }
    );
  });

  it("keeps a multi-owner subscription incomplete after any owner listener fails", () => {
    const listeners: Array<(snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
      metadata: { fromCache: boolean; hasPendingWrites?: boolean };
    }) => void> = [];
    const errorListeners: Array<(error: Error) => void> = [];
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listeners.push(args[2] as (typeof listeners)[number]);
      errorListeners.push(args[3] as (typeof errorListeners)[number]);
      return vi.fn();
    });

    subscribeVisibleNotes("user-a", ["user-a", "owner-b"], callback, onError, 80);
    const document = (id: string, ownerUid: string, updatedAt: number) => ({
      data: () => ({
        isDeleted: false,
        ownerUid,
        participantUids: ["user-a"],
        updatedAt: { toMillis: () => updatedAt }
      }),
      id
    });

    listeners[0]({
      docs: [document("note-a", "user-a", 100)],
      metadata: { fromCache: false, hasPendingWrites: false }
    });
    listeners[1]({
      docs: [document("note-b", "owner-b", 200)],
      metadata: { fromCache: false, hasPendingWrites: false }
    });
    expect(callback).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({ id: "note-b" }),
        expect.objectContaining({ id: "note-a" })
      ],
      { fromCache: false, hasPendingWrites: false, serverComplete: true }
    );

    const ownerError = new Error("owner query failed");
    errorListeners[1](ownerError);
    expect(onError).toHaveBeenCalledWith(ownerError);
    expect(callback).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "note-a" })],
      { fromCache: false, hasPendingWrites: false, serverComplete: false }
    );

    listeners[0]({
      docs: [document("note-a-next", "user-a", 300)],
      metadata: { fromCache: false, hasPendingWrites: false }
    });
    listeners[1]({
      docs: [document("stale-note-b", "owner-b", 400)],
      metadata: { fromCache: false, hasPendingWrites: false }
    });
    expect(callback).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "note-a-next" })],
      { fromCache: false, hasPendingWrites: false, serverComplete: false }
    );
  });

  it("skips the legacy deletion scan for the server-sealed Vault subscription", async () => {
    subscribeVisibleNotes(
      "sealed-owner",
      ["sealed-owner"],
      vi.fn(),
      vi.fn(),
      undefined,
      { repairLegacyDeletionMetadata: false }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.getDocs).not.toHaveBeenCalled();
    expect(mocks.updateDoc).not.toHaveBeenCalled();
    expect(mocks.onSnapshot).toHaveBeenCalledOnce();
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

  it("does not fall back to cached direct notes for durable maintenance reads", async () => {
    mocks.getDoc.mockResolvedValue({
      data: () => ({
        isDeleted: false,
        ownerUid: "user-a",
        participantUids: ["user-a"],
        updatedAt: { toMillis: () => 100 }
      }),
      exists: () => true,
      id: "cached-note"
    });
    mocks.getDocFromServer.mockRejectedValue(new Error("unavailable"));

    await expect(getVisibleNotesByIdsFromServer("user-a", ["cached-note"]))
      .resolves.toEqual({ notes: [], resolvedNoteIds: [] });
    expect(mocks.getDocFromServer).toHaveBeenCalledTimes(1);
    expect(mocks.getDoc).not.toHaveBeenCalled();
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
      listener = args[2] as typeof listener;
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
      listener = args[2] as typeof listener;
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
    expect(callback).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: "folder-a", name: "먼저", order: 1 }),
        expect.objectContaining({ id: "folder-b", name: "나중", order: 2 })
      ],
      { fromCache: false, hasPendingWrites: false, serverComplete: true }
    );
  });

  it("still emits the complete snapshot at the supported 5,000-folder boundary", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
    }) => void) | undefined;
    const callback = vi.fn();
    const onError = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listener = args[2] as typeof listener;
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

  it("reports cache and server completeness without opening another query", () => {
    let listener: ((snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
      metadata: { fromCache: boolean; hasPendingWrites?: boolean };
    }) => void) | undefined;
    const callback = vi.fn();

    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      expect(args[1]).toEqual({ includeMetadataChanges: true });
      listener = args[2] as typeof listener;
      return vi.fn();
    });

    subscribeNoteFolders("user-a", callback, vi.fn());
    const snapshotDocument = {
      data: () => ({ name: "업무", order: 1 }),
      id: "folder-a"
    };
    listener?.({ docs: [snapshotDocument], metadata: { fromCache: true } });
    listener?.({ docs: [snapshotDocument], metadata: { fromCache: false, hasPendingWrites: true } });
    listener?.({ docs: [snapshotDocument], metadata: { fromCache: false, hasPendingWrites: false } });

    expect(callback).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ id: "folder-a", name: "업무" })],
      { fromCache: true, hasPendingWrites: false, serverComplete: false }
    );
    expect(callback).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ id: "folder-a", name: "업무" })],
      { fromCache: false, hasPendingWrites: true, serverComplete: false }
    );
    expect(callback).toHaveBeenNthCalledWith(
      3,
      [expect.objectContaining({ id: "folder-a", name: "업무" })],
      { fromCache: false, hasPendingWrites: false, serverComplete: true }
    );
    expect(mocks.onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps tombstoned descendants out of active folders and emits them only to the deleted subscription", () => {
    const listeners: Array<(snapshot: {
      docs: Array<{ data: () => unknown; id: string }>;
      metadata?: { fromCache?: boolean; hasPendingWrites?: boolean };
    }) => void> = [];
    const activeCallback = vi.fn();
    const deletedCallback = vi.fn();
    mocks.onSnapshot.mockImplementation((...args: unknown[]) => {
      listeners.push(args[2] as typeof listeners[number]);
      return vi.fn();
    });

    subscribeNoteFolders("user-a", activeCallback, vi.fn());
    subscribeDeletedNoteFolders("user-a", deletedCallback, vi.fn());
    const docs = [
      { data: () => ({ isDeleted: true, name: "암호화 폴더", parentId: null }), id: "trashed" },
      { data: () => ({ name: "암호화 폴더", parentId: "trashed" }), id: "hidden-child" },
      { data: () => ({ name: "암호화 폴더", parentId: null }), id: "active" }
    ];
    listeners.forEach((listener) => listener({ docs, metadata: { fromCache: false } }));

    expect(activeCallback.mock.calls[0][0].map(({ id }: { id: string }) => id)).toEqual(["active"]);
    expect(deletedCallback.mock.calls[0][0].map(({ id }: { id: string }) => id)).toEqual([
      "trashed",
      "hidden-child"
    ]);
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
