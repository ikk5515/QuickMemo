import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";

const mocks = vi.hoisted(() => ({
  createEncryptedVaultAsset: vi.fn(),
  deleteRevisionedNote: vi.fn(),
  getVisibleNotesByIdsFromServer: vi.fn()
}));

vi.mock("../../services/notes", () => ({
  deleteRevisionedNote: mocks.deleteRevisionedNote,
  getVisibleNotesByIdsFromServer: mocks.getVisibleNotesByIdsFromServer
}));

vi.mock("./vaultPersistence", () => ({
  createEncryptedVaultAsset: mocks.createEncryptedVaultAsset
}));

import {
  pasteVaultClipboardImages,
  withVaultClipboardSourceReadDeadline
} from "./vaultClipboardPasteFlow";
import { MAX_VAULT_CLIPBOARD_TRANSCODE_MS } from "./clipboardImagePaste";

function pngBytes(width = 2, height = 2) {
  const bytes = new Uint8Array(57);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, 0);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  view.setUint32(45, 0);
  bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}

function clipboardFile(bytes: Uint8Array, type = "image/png") {
  const source = bytes.slice().buffer as ArrayBuffer;
  const file = new File([source], "clipboard.png", { type });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => source.slice(0)
  });
  return file;
}

const sourceNote = {
  body: "# source",
  contentFormat: "markdown-v1",
  encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
  encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
  entryKind: "markdown",
  folderId: null,
  id: "note-a",
  isDeleted: false,
  ownerUid: "user-a",
  participantUids: ["user-a"],
  revision: 3,
  title: "Source",
  type: "personal",
  updatedBy: "user-a",
  wrappedKeys: {}
} as unknown as DecryptedVaultNote;

const profile = {
  publicKeyJwk: {},
  uid: "user-a"
} as UserProfile;

function successfulServerRead(note: DecryptedVaultNote = sourceNote) {
  return {
    notes: [note],
    resolvedNoteIds: [note.id]
  };
}

function flowInput(files: readonly File[]) {
  const pendingAssetTitleKeyById = new Map<string, string>();
  const pendingAssetTitleKeys = new Map();
  const pendingCreatedEntryIds = new Set<string>();
  const setError = vi.fn();
  const setStatus = vi.fn();
  return {
    input: {
      files,
      getNotes: () => [sourceNote],
      integrityKey: {} as CryptoKey,
      note: sourceNote,
      pendingAssetTitleKeyById,
      pendingAssetTitleKeys,
      pendingCreatedEntryIds,
      profile,
      setError,
      setStatus,
      signal: new AbortController().signal,
      sourceFolderId: null
    },
    pendingAssetTitleKeyById,
    pendingAssetTitleKeys,
    pendingCreatedEntryIds,
    setError,
    setStatus
  };
}

describe("Vault clipboard source read deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("releases a stalled server source check at the configured deadline", async () => {
    vi.useFakeTimers();
    const pending = withVaultClipboardSourceReadDeadline(
      new Promise<never>(() => undefined),
      new AbortController().signal,
      25
    );
    const rejected = expect(pending).rejects.toThrow("서버의 원본 노트 확인이 지연");

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });

  it("stops waiting immediately when the editor paste is cancelled", async () => {
    const controller = new AbortController();
    const pending = withVaultClipboardSourceReadDeadline(
      new Promise<never>(() => undefined),
      controller.signal,
      1_000
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    controller.abort(new DOMException("cancelled", "AbortError"));
    await rejected;
  });

  it("creates one encrypted asset only after two private source checks succeed", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    const state = flowInput([clipboardFile(pngBytes())]);

    const result = await pasteVaultClipboardImages(state.input);

    expect(mocks.getVisibleNotesByIdsFromServer).toHaveBeenCalledTimes(2);
    expect(mocks.createEncryptedVaultAsset).toHaveBeenCalledOnce();
    expect(mocks.deleteRevisionedNote).not.toHaveBeenCalled();
    expect(result?.source).toMatch(/^!\[\[붙여넣은 이미지 .+\.png\]\]$/u);
    expect(state.pendingCreatedEntryIds).toContain("asset-a");
    result?.onCommit?.();
    expect(state.setStatus).toHaveBeenLastCalledWith("이미지를 asset-v1로 암호화해 붙여넣었습니다.");
  });

  it("deletes a created asset and returns no embed when the post-create ACL check fails", async () => {
    const sharedAfterCreate = {
      ...sourceNote,
      participantUids: ["user-a", "user-b"],
      type: "shared"
    } as DecryptedVaultNote;
    mocks.getVisibleNotesByIdsFromServer
      .mockResolvedValueOnce(successfulServerRead())
      .mockResolvedValueOnce(successfulServerRead(sharedAfterCreate));
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    mocks.deleteRevisionedNote.mockResolvedValue({ noteId: "asset-a", revision: 2 });
    const state = flowInput([clipboardFile(pngBytes())]);

    const result = await pasteVaultClipboardImages(state.input);

    expect(result).toBeNull();
    expect(mocks.getVisibleNotesByIdsFromServer).toHaveBeenCalledTimes(2);
    expect(mocks.deleteRevisionedNote).toHaveBeenCalledWith({
      expectedRevision: 1,
      noteId: "asset-a",
      readerUids: ["user-a"],
      uid: "user-a"
    });
    expect(state.pendingCreatedEntryIds).not.toContain("asset-a");
    expect(state.pendingAssetTitleKeyById.size).toBe(0);
    expect(state.pendingAssetTitleKeys.size).toBe(0);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("서버에서 개인 Markdown 노트 상태"));
  });

  it("preserves an invalid-image failure while aborting a stalled ACL preflight", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockImplementation(() => new Promise<never>(() => undefined));
    const state = flowInput([
      clipboardFile(new TextEncoder().encode("not a png"))
    ]);

    const result = await pasteVaultClipboardImages(state.input);

    expect(result).toBeNull();
    expect(mocks.createEncryptedVaultAsset).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("서명과 해상도"));
  });

  it("preserves an ACL failure while aborting a stalled file read", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue({
      notes: [],
      resolvedNoteIds: [sourceNote.id]
    });
    const stalledFile = clipboardFile(pngBytes());
    Object.defineProperty(stalledFile, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>(() => undefined)
    });
    const state = flowInput([stalledFile]);

    const result = await pasteVaultClipboardImages(state.input);

    expect(result).toBeNull();
    expect(mocks.createEncryptedVaultAsset).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("서버에서 개인 Markdown 노트 상태"));
  });

  it("bounds a stalled file read after the ACL preflight succeeds", async () => {
    vi.useFakeTimers();
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    const stalledFile = clipboardFile(pngBytes());
    Object.defineProperty(stalledFile, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>(() => undefined)
    });
    const state = flowInput([stalledFile]);
    const pending = pasteVaultClipboardImages(state.input);

    await vi.advanceTimersByTimeAsync(MAX_VAULT_CLIPBOARD_TRANSCODE_MS);
    const result = await pending;

    expect(result).toBeNull();
    expect(mocks.createEncryptedVaultAsset).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("이미지 배치 준비 시간이 초과"));
  });
});
