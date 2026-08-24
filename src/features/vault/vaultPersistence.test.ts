import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultNote } from "./vaultData";
import {
  backfillVaultEntryNameClaim,
  createEncryptedVaultAsset,
  createEncryptedVaultEntry,
  createMarkdownVaultNote,
  migrateLegacyVaultEntryIdentity,
  moveOnlyEncryptedVaultEntry,
  saveAndMoveEncryptedVaultEntry,
  saveEncryptedVaultEntry
} from "./vaultPersistence";
import { resolveVaultEntryNameCollision } from "./vaultEntryCollisionRecovery";

const mocks = vi.hoisted(() => ({
  backfillRevisionedVaultNameClaim: vi.fn(),
  createRevisionedEncryptedNote: vi.fn(),
  encryptText: vi.fn(),
  fingerprint: vi.fn(),
  generateNoteKey: vi.fn(),
  migrateLegacyVaultNote: vi.fn(),
  resolveRevisionedVaultNameCollision: vi.fn(),
  unwrapNoteKey: vi.fn(),
  updateRevisionedEncryptedNote: vi.fn(),
  updateRevisionedEncryptedNoteAndFolder: vi.fn(),
  updateRevisionedNoteFolder: vi.fn(),
  wrapNoteKey: vi.fn()
}));

vi.mock("../../lib/crypto", () => ({
  base64ToBytes: (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  bytesToBase64: (value: Uint8Array) => btoa(String.fromCharCode(...value)),
  encryptText: mocks.encryptText,
  generateNoteKey: mocks.generateNoteKey,
  unwrapNoteKey: mocks.unwrapNoteKey,
  wrapNoteKey: mocks.wrapNoteKey
}));

vi.mock("../../services/notes", () => ({
  backfillRevisionedVaultNameClaim: mocks.backfillRevisionedVaultNameClaim,
  createRevisionedEncryptedNote: mocks.createRevisionedEncryptedNote,
  migrateLegacyVaultNote: mocks.migrateLegacyVaultNote,
  resolveRevisionedVaultNameCollision: mocks.resolveRevisionedVaultNameCollision,
  updateRevisionedEncryptedNote: mocks.updateRevisionedEncryptedNote,
  updateRevisionedEncryptedNoteAndFolder: mocks.updateRevisionedEncryptedNoteAndFolder,
  updateRevisionedNoteFolder: mocks.updateRevisionedNoteFolder
}));

vi.mock("./vaultIntegrity", async (importOriginal) => ({
  ...await importOriginal<typeof import("./vaultIntegrity")>(),
  vaultNameFingerprint: mocks.fingerprint
}));

const noteKey = { kind: "note-key" } as unknown as CryptoKey;
const privateKey = { kind: "private-key" } as unknown as CryptoKey;
const vaultIntegrityKey = { kind: "vault-integrity-key" } as unknown as CryptoKey;
const vaultClaimId = "C".repeat(43);
const changedVaultClaimId = "D".repeat(43);
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
const profile = {
  uid: "user-a",
  publicKeyJwk: { e: "AQAB", kty: "RSA", n: "public-key" }
};

function markdownNote(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "# 이전\n",
    contentFormat: "markdown-v1",
    encryptedBody: encryptedPayload,
    encryptedTitle: encryptedPayload,
    entryKind: "markdown",
    folderId: null,
    id: "note-a",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 7,
    title: "이전 제목",
    type: "personal",
    updatedBy: "user-a",
    vaultNameClaimId: vaultClaimId,
    vaultNameIndexVersion: 1,
    wrappedKeys: { "user-a": wrappedKey },
    ...overrides
  };
}

describe("vaultPersistence encrypted revision contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateNoteKey.mockResolvedValue(noteKey);
    mocks.migrateLegacyVaultNote.mockResolvedValue({
      claimState: "reserved",
      lastMutationId: "mutation",
      noteId: "note-a",
      revision: 8
    });
    mocks.unwrapNoteKey.mockResolvedValue(noteKey);
    mocks.wrapNoteKey.mockResolvedValue(wrappedKey);
    mocks.fingerprint.mockImplementation(async (_key: CryptoKey, input: { name: string; parentId: string | null }) => (
      input.name === "이전 제목" && input.parentId === null ? vaultClaimId : changedVaultClaimId
    ));
    mocks.encryptText.mockImplementation(async (plainText: string) => ({
      ...encryptedPayload,
      cipherText: `encrypted:${plainText.length}`
    }));
    mocks.createRevisionedEncryptedNote.mockResolvedValue({ noteId: "created", revision: 1 });
    mocks.resolveRevisionedVaultNameCollision.mockResolvedValue({ noteId: "note-a", revision: 8 });
    mocks.backfillRevisionedVaultNameClaim.mockResolvedValue({ noteId: "note-a", revision: 8 });
    mocks.updateRevisionedEncryptedNote.mockResolvedValue({ noteId: "note-a", revision: 8 });
    mocks.updateRevisionedEncryptedNoteAndFolder.mockResolvedValue({ noteId: "note-a", revision: 8 });
    mocks.updateRevisionedNoteFolder.mockResolvedValue({ noteId: "note-a", revision: 8 });
  });

  it("keeps original Markdown unchanged and stores only encrypted title, body and history payloads", async () => {
    const body = "# 제목\n\n\t들여쓰기\n\n[[연결|표시]]\n";

    await createMarkdownVaultNote(profile, vaultIntegrityKey, { body, folderId: "folder-a", title: "  원본 노트  " });

    expect(mocks.encryptText).toHaveBeenCalledWith(body, noteKey);
    expect(mocks.createRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      folderId: "folder-a",
      historySnapshot: expect.objectContaining({ cipherText: expect.stringMatching(/^encrypted:/) }),
      historySummary: expect.objectContaining({ cipherText: expect.stringMatching(/^encrypted:/) }),
      participantUids: ["user-a"],
      wrappedKeys: { "user-a": wrappedKey }
    }));
    const persisted = mocks.createRevisionedEncryptedNote.mock.calls[0][0];
    expect(JSON.stringify(persisted)).not.toContain(body);
    expect(JSON.stringify(persisted)).not.toContain("원본 노트");
  });

  it.each(["bad/name", "bad\\name", "bad%2Fname", "bad%252Fname", "bad\u0000name"])(
    "rejects a Vault title that would collapse to an unsafe path: %s",
    async (title) => {
      await expect(createMarkdownVaultNote(profile, vaultIntegrityKey, {
        body: "# safe body",
        folderId: null,
        title
      })).rejects.toThrow("Vault 이름");
      expect(mocks.generateNoteKey).not.toHaveBeenCalled();
    }
  );

  it("normalizes a stored title to NFC before encryption", async () => {
    await createMarkdownVaultNote(profile, vaultIntegrityKey, {
      body: "# normalized",
      folderId: null,
      title: "RE\u0301SUME\u0301"
    });

    expect(mocks.encryptText).toHaveBeenCalledWith("RÉSUMÉ", noteKey);
  });

  it("persists Canvas and Base kinds with their matching canonical formats", async () => {
    await createEncryptedVaultEntry(profile, vaultIntegrityKey, {
      body: "{\"nodes\":[],\"edges\":[]}",
      contentFormat: "json-canvas-v1",
      entryKind: "canvas",
      folderId: null,
      title: "흐름"
    });
    await createEncryptedVaultEntry(profile, vaultIntegrityKey, {
      body: "views: []",
      contentFormat: "base-v1",
      entryKind: "base",
      folderId: null,
      title: "프로젝트"
    });

    expect(mocks.createRevisionedEncryptedNote).toHaveBeenNthCalledWith(1, expect.objectContaining({
      contentFormat: "json-canvas-v1",
      entryKind: "canvas"
    }));
    expect(mocks.createRevisionedEncryptedNote).toHaveBeenNthCalledWith(2, expect.objectContaining({
      contentFormat: "base-v1",
      entryKind: "base"
    }));
  });

  it("stores a binary asset only inside the encrypted asset-v1 envelope", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const vaultPasteLockId = `vpl1_${"L".repeat(43)}`;

    await createEncryptedVaultAsset(profile, vaultIntegrityKey, {
      bytes,
      folderId: "folder-a",
      mimeType: "application/pdf",
      title: "설계.pdf",
      vaultPasteLockId
    });

    expect(mocks.createRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      contentFormat: "asset-v1",
      entryKind: "asset",
      folderId: "folder-a",
      vaultPasteLockId
    }));
    const persisted = JSON.stringify(mocks.createRevisionedEncryptedNote.mock.calls[0][0]);
    expect(persisted).not.toContain("application/pdf");
    expect(persisted).not.toContain("설계.pdf");
  });

  it("rejects malformed paste leases and never attaches one to a non-asset entry", async () => {
    await expect(createEncryptedVaultAsset(profile, vaultIntegrityKey, {
      bytes: new Uint8Array([1]),
      folderId: "folder-a",
      title: "image.png",
      vaultPasteLockId: "predictable-lock"
    })).rejects.toThrow("잠금 식별자");
    await expect(createEncryptedVaultEntry(profile, vaultIntegrityKey, {
      body: "# note",
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      folderId: "folder-a",
      title: "note.md",
      vaultPasteLockId: `vpl1_${"L".repeat(43)}`
    })).rejects.toThrow("잠금 식별자");
    expect(mocks.generateNoteKey).not.toHaveBeenCalled();
  });

  it("rejects a malformed asset body before generating a key", async () => {
    await expect(createEncryptedVaultEntry(profile, vaultIntegrityKey, {
      body: "not-an-asset",
      contentFormat: "asset-v1",
      entryKind: "asset",
      folderId: null,
      title: "bad.bin"
    })).rejects.toThrow("첨부 데이터 형식");

    expect(mocks.generateNoteKey).not.toHaveBeenCalled();
  });

  it("saves against the expected revision and encrypts a recoverable snapshot", async () => {
    const body = "---\ntags: [project]\n---\n\n# 변경\n";

    await saveEncryptedVaultEntry(markdownNote(), "user-a", privateKey, vaultIntegrityKey, {
      body,
      folderId: null,
      title: "변경 제목"
    });

    expect(mocks.unwrapNoteKey).toHaveBeenCalledWith(wrappedKey, privateKey);
    expect(mocks.encryptText).toHaveBeenCalledWith(body, noteKey);
    expect(mocks.updateRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["title", "body", "name-claim"],
      expectedRevision: 7,
      historySnapshot: expect.objectContaining({ cipherText: expect.stringMatching(/^encrypted:/) }),
      historySummary: expect.objectContaining({ cipherText: expect.stringMatching(/^encrypted:/) }),
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    }));
    expect(JSON.stringify(mocks.updateRevisionedEncryptedNote.mock.calls[0][0])).not.toContain(body);
  });

  it("does not re-encrypt unchanged fields and records the exact changed field", async () => {
    const note = markdownNote();

    await saveEncryptedVaultEntry(note, "user-a", privateKey, vaultIntegrityKey, {
      body: "# 본문만 변경\n",
      folderId: null,
      title: note.title
    });

    expect(mocks.encryptText).not.toHaveBeenCalledWith(note.title, noteKey);
    expect(mocks.updateRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["body"],
      encryptedTitle: note.encryptedTitle
    }));
    expect(mocks.updateRevisionedEncryptedNote.mock.calls[0][0]).not.toHaveProperty("nameClaim");
  });

  it("binds a pasted-image Markdown body save to the exact destination lease", async () => {
    const note = markdownNote();
    const credential = {
      vaultPasteFolderId: "pasted-images-folder",
      vaultPasteFolderRevision: 4,
      vaultPasteLockId: `vpl1_${"P".repeat(43)}`
    };

    await saveEncryptedVaultEntry(note, "user-a", privateKey, vaultIntegrityKey, {
      body: `${note.body}\n![[붙여넣은 이미지/이전 제목 -1.png]]`,
      folderId: null,
      title: note.title
    }, undefined, credential);

    expect(mocks.updateRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["body"],
      ...credential
    }));
  });

  it("lets a shared participant save body-only content without deriving an owner claim", async () => {
    const shared = markdownNote({
      ownerUid: "user-a",
      participantUids: ["user-a", "user-b"],
      type: "shared",
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    await saveEncryptedVaultEntry(shared, "user-b", privateKey, vaultIntegrityKey, {
      body: "# participant body\n",
      folderId: null,
      title: shared.title
    });

    expect(mocks.fingerprint).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["body"],
      noteId: shared.id,
      readerUids: ["user-a", "user-b"],
      uid: "user-b"
    }));
    expect(mocks.updateRevisionedEncryptedNote.mock.calls[0][0]).not.toHaveProperty("nameClaim");
  });

  it("blocks participant title changes and claim-less shared saves", async () => {
    const shared = markdownNote({
      ownerUid: "user-a",
      participantUids: ["user-a", "user-b"],
      type: "shared",
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    await expect(saveEncryptedVaultEntry(shared, "user-b", privateKey, vaultIntegrityKey, {
      body: shared.body,
      folderId: null,
      title: "participant rename"
    })).rejects.toThrow("소유자만");
    await expect(saveEncryptedVaultEntry({
      ...shared,
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined
    }, "user-b", privateKey, vaultIntegrityKey, {
      body: "# participant body\n",
      folderId: null,
      title: shared.title
    })).rejects.toThrow("소유자가");

    expect(mocks.fingerprint).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("skips encryption and Firestore writes for an unchanged draft", async () => {
    const note = markdownNote();

    await expect(saveEncryptedVaultEntry(note, "user-a", privateKey, vaultIntegrityKey, {
      body: note.body,
      folderId: null,
      title: note.title
    })).resolves.toEqual({
      encryptedBody: note.encryptedBody,
      encryptedTitle: note.encryptedTitle,
      noteId: note.id,
      revision: note.revision,
      vaultNameClaimId: note.vaultNameClaimId,
      vaultNameIndexVersion: note.vaultNameIndexVersion
    });

    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.encryptText).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("returns the exact persisted cipher generation for an immediate follow-up mutation", async () => {
    const note = markdownNote();
    const result = await saveEncryptedVaultEntry(note, "user-a", privateKey, vaultIntegrityKey, {
      body: "# 저장 직후 이름 변경\n",
      folderId: null,
      title: note.title
    });

    const request = mocks.updateRevisionedEncryptedNote.mock.calls[0][0];
    expect(request.changedFields).toEqual(["body"]);
    expect(result).toEqual({
      encryptedBody: request.encryptedBody,
      encryptedTitle: request.encryptedTitle,
      noteId: note.id,
      revision: 8,
      vaultNameClaimId: note.vaultNameClaimId,
      vaultNameIndexVersion: note.vaultNameIndexVersion
    });
    expect(result.encryptedBody).not.toEqual(note.encryptedBody);
  });

  it("requires folder moves to use the audited revisioned move path", async () => {
    await expect(saveEncryptedVaultEntry(markdownNote(), "user-a", privateKey, vaultIntegrityKey, {
      body: "# 변경\n",
      folderId: "folder-b",
      title: "이전 제목"
    })).rejects.toThrow("이력과 revision");

    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("encrypts content and folder movement into one revisioned mutation", async () => {
    const body = "# 이동하며 수정\n";

    await saveAndMoveEncryptedVaultEntry(markdownNote(), "user-a", privateKey, vaultIntegrityKey, {
      body,
      folderId: "folder-b",
      title: "이전 제목"
    });

    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNoteAndFolder).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["body", "folder", "name-claim"],
      expectedRevision: 7,
      folderId: "folder-b",
      noteId: "note-a"
    }));
    expect(JSON.stringify(mocks.updateRevisionedEncryptedNoteAndFolder.mock.calls[0][0])).not.toContain(body);
  });

  it("moves legacy HTML without rewriting its encrypted title or body", async () => {
    const legacy = markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    });
    mocks.encryptText.mockResolvedValueOnce({ ...encryptedPayload, cipherText: "history-only" });

    await moveOnlyEncryptedVaultEntry(
      legacy,
      "user-a",
      privateKey,
      vaultIntegrityKey,
      { body: legacy.body, folderId: "folder-b", title: legacy.title }
    );

    expect(mocks.updateRevisionedNoteFolder).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 7,
      folderId: "folder-b",
      historySummary: { ...encryptedPayload, cipherText: "history-only" },
      noteId: "note-a"
    }));
    expect(mocks.encryptText).toHaveBeenCalledTimes(1);
    expect(mocks.updateRevisionedEncryptedNoteAndFolder).not.toHaveBeenCalled();
  });

  it("moves oversized historical legacy HTML without resending or snapshotting its content", async () => {
    const historicalBody = `<section>${"x".repeat(800_000)}</section>`;
    const legacy = markdownNote({
      body: historicalBody,
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    });

    await moveOnlyEncryptedVaultEntry(
      legacy,
      "user-a",
      privateKey,
      vaultIntegrityKey,
      { body: historicalBody, folderId: "folder-b", title: legacy.title }
    );

    expect(mocks.encryptText).toHaveBeenCalledTimes(1);
    expect(mocks.encryptText).toHaveBeenCalledWith("폴더 변경", noteKey);
    expect(mocks.updateRevisionedNoteFolder).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: legacy.revision,
      folderId: "folder-b",
      historySummary: expect.objectContaining({ cipherText: expect.stringMatching(/^encrypted:/) }),
      nameClaim: expect.objectContaining({ parentId: "folder-b" }),
      noteId: legacy.id,
      readerUids: legacy.participantUids,
      uid: legacy.ownerUid
    }));
    const mutation = mocks.updateRevisionedNoteFolder.mock.calls[0][0];
    expect(mutation).not.toHaveProperty("encryptedBody");
    expect(mutation).not.toHaveProperty("encryptedTitle");
    expect(mutation).not.toHaveProperty("historySnapshot");
    expect(JSON.stringify(mutation)).not.toContain(historicalBody);
    expect(JSON.stringify(mutation)).not.toContain(legacy.title);
    expect(mocks.updateRevisionedEncryptedNoteAndFolder).not.toHaveBeenCalled();
  });

  it("refuses a move-only operation that would also change legacy content", async () => {
    const legacy = markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    });

    await expect(moveOnlyEncryptedVaultEntry(
      legacy,
      "user-a",
      privateKey,
      vaultIntegrityKey,
      { body: "<p>changed</p>", folderId: "folder-b", title: legacy.title }
    )).rejects.toThrow("내용 또는 이름 변경");

    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedNoteFolder).not.toHaveBeenCalled();
  });

  it("does not normalize an unsaved title change into a move-only mutation", async () => {
    const legacy = markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    });

    await expect(moveOnlyEncryptedVaultEntry(
      legacy,
      "user-a",
      privateKey,
      vaultIntegrityKey,
      { body: legacy.body, folderId: "folder-b", title: ` ${legacy.title} ` }
    )).rejects.toThrow("내용 또는 이름 변경");

    expect(mocks.fingerprint).not.toHaveBeenCalled();
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedNoteFolder).not.toHaveBeenCalled();
  });

  it("rejects a runtime-mismatched Vault kind before generating a key", async () => {
    await expect(createEncryptedVaultEntry(profile, vaultIntegrityKey, {
      body: "# 잘못된 형식",
      contentFormat: "markdown-v1",
      entryKind: "canvas",
      folderId: null,
      title: "잘못된 항목"
    })).rejects.toThrow("저장 형식이 일치");

    expect(mocks.generateNoteKey).not.toHaveBeenCalled();
    expect(mocks.createRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("refuses to overwrite legacy HTML entries", async () => {
    await expect(saveEncryptedVaultEntry(markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html"
    }), "user-a", privateKey, vaultIntegrityKey, {
      body: "# 변환",
      folderId: null,
      title: "변환"
    })).rejects.toThrow("Markdown 복사본");
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("backfills a legacy HTML name claim without changing its encrypted content", async () => {
    const legacy = markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined
    });

    await backfillVaultEntryNameClaim(legacy, "user-a", privateKey, vaultIntegrityKey);

    expect(mocks.backfillRevisionedVaultNameClaim).toHaveBeenCalledWith(expect.objectContaining({
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      nameClaim: expect.objectContaining({ claimId: vaultClaimId, indexVersion: 1, parentId: null })
    }));
    expect(mocks.encryptText).not.toHaveBeenCalledWith(legacy.body, noteKey);
    expect(mocks.encryptText).not.toHaveBeenCalledWith(legacy.title, noteKey);
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("seals a missing legacy identity and reserves the exact deterministic claim atomically", async () => {
    const legacy = markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined
    });

    await migrateLegacyVaultEntryIdentity(legacy, "user-a", vaultIntegrityKey, true);

    expect(mocks.migrateLegacyVaultNote).toHaveBeenCalledWith({
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 7,
      nameClaim: {
        claimId: vaultClaimId,
        indexVersion: 1,
        parentId: null
      },
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });
    expect(mocks.encryptText).not.toHaveBeenCalled();
  });

  it("seals a deferred or deleted legacy identity without sending a claim", async () => {
    const legacy = markdownNote({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined
    });
    mocks.migrateLegacyVaultNote.mockResolvedValue({
      claimState: "deferred",
      lastMutationId: "mutation",
      noteId: legacy.id,
      revision: 8
    });

    await migrateLegacyVaultEntryIdentity(legacy, "user-a", vaultIntegrityKey, false);

    expect(mocks.migrateLegacyVaultNote).toHaveBeenCalledWith({
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 7,
      noteId: "note-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });
    expect(mocks.migrateLegacyVaultNote.mock.calls[0][0]).not.toHaveProperty("nameClaim");
  });

  it("backfills an oversized historical body without snapshotting or revalidating it", async () => {
    const historical = markdownNote({
      body: "x".repeat(800_000),
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined
    });

    await backfillVaultEntryNameClaim(historical, "user-a", privateKey, vaultIntegrityKey);

    expect(mocks.backfillRevisionedVaultNameClaim).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 7,
      historySummary: expect.anything(),
      noteId: historical.id
    }));
    expect(mocks.backfillRevisionedVaultNameClaim.mock.calls[0][0]).not.toHaveProperty("historySnapshot");
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("recovers a legacy HTML collision without rewriting or validating its body", async () => {
    const legacy = markdownNote({
      body: "x".repeat(800_000),
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined
    });

    await resolveVaultEntryNameCollision(legacy, "user-a", privateKey, vaultIntegrityKey, {
      folderId: null,
      title: "Recovered legacy"
    });

    expect(mocks.resolveRevisionedVaultNameCollision).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["title", "name-claim"],
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 7,
      nameClaim: expect.objectContaining({ claimId: changedVaultClaimId, parentId: null }),
      noteId: legacy.id
    }));
    const recovery = mocks.resolveRevisionedVaultNameCollision.mock.calls[0][0];
    expect(recovery).not.toHaveProperty("encryptedBody");
    expect(recovery).not.toHaveProperty("historySnapshot");
  });

  it("repairs a historical shared note folder by moving it only to Vault root", async () => {
    const shared = markdownNote({
      folderId: "legacy-folder",
      participantUids: ["user-a", "user-b"],
      type: "shared",
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined,
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    await resolveVaultEntryNameCollision(shared, "user-a", privateKey, vaultIntegrityKey, {
      folderId: null,
      title: shared.title
    });

    expect(mocks.resolveRevisionedVaultNameCollision).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["folder", "name-claim"],
      folderId: null,
      nameClaim: expect.objectContaining({ parentId: null }),
      noteId: shared.id
    }));
    await expect(resolveVaultEntryNameCollision(shared, "user-a", privateKey, vaultIntegrityKey, {
      folderId: "different-folder",
      title: shared.title
    })).rejects.toThrow("공유 노트는 폴더로 이동");
  });

  it("renames a historical shared collision and moves it to Vault root atomically", async () => {
    const shared = markdownNote({
      body: "unsaved local draft must not replace ciphertext",
      folderId: "legacy-folder",
      participantUids: ["user-a", "user-b"],
      type: "shared",
      vaultNameClaimId: undefined,
      vaultNameIndexVersion: undefined,
      wrappedKeys: { "user-a": wrappedKey, "user-b": wrappedKey }
    });

    await resolveVaultEntryNameCollision(shared, "user-a", privateKey, vaultIntegrityKey, {
      folderId: null,
      title: "Recovered shared"
    });

    expect(mocks.resolveRevisionedVaultNameCollision).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["title", "folder", "name-claim"],
      folderId: null,
      nameClaim: expect.objectContaining({ parentId: null }),
      noteId: shared.id
    }));
    const recovery = mocks.resolveRevisionedVaultNameCollision.mock.calls[0][0];
    expect(recovery).not.toHaveProperty("encryptedBody");
    expect(recovery).not.toHaveProperty("historySnapshot");
  });

  it("repairs a missing reservation document even when the deterministic claim metadata is unchanged", async () => {
    const current = markdownNote();

    await backfillVaultEntryNameClaim(current, "user-a", privateKey, vaultIntegrityKey, true);

    expect(mocks.backfillRevisionedVaultNameClaim).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 7,
      nameClaim: {
        claimId: vaultClaimId,
        indexVersion: 1,
        parentId: null
      }
    }));
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("rejects multibyte bodies that would exceed Firestore after base64 encryption", async () => {
    const oversizedKoreanBody = "한".repeat(200_000);

    await expect(createMarkdownVaultNote(profile, vaultIntegrityKey, {
      body: oversizedKoreanBody,
      folderId: null,
      title: "큰 노트"
    })).rejects.toThrow("UTF-8 기준 500KB");
    expect(mocks.generateNoteKey).not.toHaveBeenCalled();
    expect(mocks.createRevisionedEncryptedNote).not.toHaveBeenCalled();
  });
});
