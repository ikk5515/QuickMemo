import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultNote } from "./vaultData";
import {
  createEncryptedVaultAsset,
  createEncryptedVaultEntry,
  createMarkdownVaultNote,
  saveEncryptedVaultEntry
} from "./vaultPersistence";

const mocks = vi.hoisted(() => ({
  createRevisionedEncryptedNote: vi.fn(),
  encryptText: vi.fn(),
  generateNoteKey: vi.fn(),
  unwrapNoteKey: vi.fn(),
  updateRevisionedEncryptedNote: vi.fn(),
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
  createRevisionedEncryptedNote: mocks.createRevisionedEncryptedNote,
  updateRevisionedEncryptedNote: mocks.updateRevisionedEncryptedNote
}));

const noteKey = { kind: "note-key" } as unknown as CryptoKey;
const privateKey = { kind: "private-key" } as unknown as CryptoKey;
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
    wrappedKeys: { "user-a": wrappedKey },
    ...overrides
  };
}

describe("vaultPersistence encrypted revision contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateNoteKey.mockResolvedValue(noteKey);
    mocks.unwrapNoteKey.mockResolvedValue(noteKey);
    mocks.wrapNoteKey.mockResolvedValue(wrappedKey);
    mocks.encryptText.mockImplementation(async (plainText: string) => ({
      ...encryptedPayload,
      cipherText: `encrypted:${plainText.length}`
    }));
    mocks.createRevisionedEncryptedNote.mockResolvedValue({ noteId: "created", revision: 1 });
    mocks.updateRevisionedEncryptedNote.mockResolvedValue({ noteId: "note-a", revision: 8 });
  });

  it("keeps original Markdown unchanged and stores only encrypted title, body and history payloads", async () => {
    const body = "# 제목\n\n\t들여쓰기\n\n[[연결|표시]]\n";

    await createMarkdownVaultNote(profile, { body, folderId: "folder-a", title: "  원본 노트  " });

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
      await expect(createMarkdownVaultNote(profile, {
        body: "# safe body",
        folderId: null,
        title
      })).rejects.toThrow("Vault 이름");
      expect(mocks.generateNoteKey).not.toHaveBeenCalled();
    }
  );

  it("normalizes a stored title to NFC before encryption", async () => {
    await createMarkdownVaultNote(profile, {
      body: "# normalized",
      folderId: null,
      title: "RE\u0301SUME\u0301"
    });

    expect(mocks.encryptText).toHaveBeenCalledWith("RÉSUMÉ", noteKey);
  });

  it("persists Canvas and Base kinds with their matching canonical formats", async () => {
    await createEncryptedVaultEntry(profile, {
      body: "{\"nodes\":[],\"edges\":[]}",
      contentFormat: "json-canvas-v1",
      entryKind: "canvas",
      folderId: null,
      title: "흐름"
    });
    await createEncryptedVaultEntry(profile, {
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

    await createEncryptedVaultAsset(profile, {
      bytes,
      folderId: "folder-a",
      mimeType: "application/pdf",
      title: "설계.pdf"
    });

    expect(mocks.createRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      contentFormat: "asset-v1",
      entryKind: "asset",
      folderId: "folder-a"
    }));
    const persisted = JSON.stringify(mocks.createRevisionedEncryptedNote.mock.calls[0][0]);
    expect(persisted).not.toContain("application/pdf");
    expect(persisted).not.toContain("설계.pdf");
  });

  it("rejects a malformed asset body before generating a key", async () => {
    await expect(createEncryptedVaultEntry(profile, {
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

    await saveEncryptedVaultEntry(markdownNote(), "user-a", privateKey, {
      body,
      folderId: null,
      title: "변경 제목"
    });

    expect(mocks.unwrapNoteKey).toHaveBeenCalledWith(wrappedKey, privateKey);
    expect(mocks.encryptText).toHaveBeenCalledWith(body, noteKey);
    expect(mocks.updateRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["title", "body"],
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

    await saveEncryptedVaultEntry(note, "user-a", privateKey, {
      body: "# 본문만 변경\n",
      folderId: null,
      title: note.title
    });

    expect(mocks.encryptText).not.toHaveBeenCalledWith(note.title, noteKey);
    expect(mocks.updateRevisionedEncryptedNote).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ["body"],
      encryptedTitle: note.encryptedTitle
    }));
  });

  it("skips encryption and Firestore writes for an unchanged draft", async () => {
    const note = markdownNote();

    await expect(saveEncryptedVaultEntry(note, "user-a", privateKey, {
      body: note.body,
      folderId: null,
      title: note.title
    })).resolves.toEqual({ noteId: note.id, revision: note.revision });

    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.encryptText).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("requires folder moves to use the audited revisioned move path", async () => {
    await expect(saveEncryptedVaultEntry(markdownNote(), "user-a", privateKey, {
      body: "# 변경\n",
      folderId: "folder-b",
      title: "이전 제목"
    })).rejects.toThrow("이력과 revision");

    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("rejects a runtime-mismatched Vault kind before generating a key", async () => {
    await expect(createEncryptedVaultEntry(profile, {
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
    }), "user-a", privateKey, {
      body: "# 변환",
      folderId: null,
      title: "변환"
    })).rejects.toThrow("Markdown 복사본");
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.updateRevisionedEncryptedNote).not.toHaveBeenCalled();
  });

  it("rejects multibyte bodies that would exceed Firestore after base64 encryption", async () => {
    const oversizedKoreanBody = "한".repeat(200_000);

    await expect(createMarkdownVaultNote(profile, {
      body: oversizedKoreanBody,
      folderId: null,
      title: "큰 노트"
    })).rejects.toThrow("UTF-8 기준 500KB");
    expect(mocks.generateNoteKey).not.toHaveBeenCalled();
    expect(mocks.createRevisionedEncryptedNote).not.toHaveBeenCalled();
  });
});
