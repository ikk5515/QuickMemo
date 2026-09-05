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
  getVisibleNotesByIdsFromServer: mocks.getVisibleNotesByIdsFromServer,
  VaultNameConflictError: class VaultNameConflictError extends Error {
    readonly claimId: string;

    constructor(claimId: string) {
      super("같은 위치에 동일한 이름의 Vault 항목이 있습니다.");
      this.claimId = claimId;
    }
  }
}));

vi.mock("./vaultPersistence", () => ({
  createEncryptedVaultAsset: mocks.createEncryptedVaultAsset
}));

import {
  beginVaultClipboardPastePendingGuard,
  commitVaultClipboardSourceWithConfirmation,
  pasteVaultClipboardImages,
  waitForVaultClipboardSourceReadiness,
  VAULT_CLIPBOARD_SOURCE_READY_TIMEOUT_MS,
  withVaultClipboardSourceReadDeadline
} from "./vaultClipboardPasteFlow";
import { VaultNameConflictError } from "../../services/notes";
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

function flowInput(files: readonly File[], sourceTitle = "Source") {
  const assertAssetDestinationCurrent = vi.fn();
  const commitSource = vi.fn().mockResolvedValue(true);
  const confirmAssetDestination = vi.fn().mockResolvedValue(undefined);
  const notes = [sourceNote];
  const pendingAssetTitleKeyById = new Map<string, string>();
  const pendingAssetTitleKeys = new Map();
  const pendingClipboardAssetIds = new Set<string>();
  const pendingCreatedEntryIds = new Set<string>();
  const setError = vi.fn();
  const setStatus = vi.fn();
  const resolveAssetDestination = vi.fn().mockResolvedValue({
    folderId: "pasted-images-folder",
    folderPath: "붙여넣은 이미지",
    folderRevision: 1,
    holderId: "holder-a",
    lockId: `vpl1_${"A".repeat(43)}`
  });
  const releaseAssetDestination = vi.fn().mockResolvedValue(undefined);
  const rollbackSource = vi.fn().mockReturnValue(true);
  return {
    input: {
      assertAssetDestinationCurrent,
      commitSource,
      confirmAssetDestination,
      files,
      getNotes: () => notes,
      integrityKey: {} as CryptoKey,
      note: sourceNote,
      pendingAssetTitleKeyById,
      pendingAssetTitleKeys,
      pendingClipboardAssetIds,
      pendingCreatedEntryIds,
      profile,
      releaseAssetDestination,
      resolveAssetDestination,
      rollbackSource,
      setError,
      setStatus,
      signal: new AbortController().signal,
      sourceFolderId: null,
      sourceTitle
    },
    pendingAssetTitleKeyById,
    pendingAssetTitleKeys,
    pendingClipboardAssetIds,
    pendingCreatedEntryIds,
    notes,
    commitSource,
    confirmAssetDestination,
    releaseAssetDestination,
    resolveAssetDestination,
    rollbackSource,
    assertAssetDestinationCurrent,
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

  it("releases concurrent paste guards once and resumes a dirty draft after the last one", async () => {
    const counts = new Map<string, number>();
    const resumeSave = vi.fn();
    const input = {
      counts,
      entryId: "note-a",
      hasDirtyDraft: () => true,
      resumeSave
    };
    const releaseFirst = beginVaultClipboardPastePendingGuard(input);
    const releaseSecond = beginVaultClipboardPastePendingGuard(input);

    releaseFirst();
    releaseFirst();
    expect(counts.get("note-a")).toBe(1);
    expect(resumeSave).not.toHaveBeenCalled();

    releaseSecond();
    await Promise.resolve();
    expect(counts.has("note-a")).toBe(false);
    expect(resumeSave).toHaveBeenCalledOnce();
  });

  it("retries source confirmation only while the latest draft remains dirty", async () => {
    let confirmed = false;
    const commit = vi.fn(async () => {
      confirmed = commit.mock.calls.length === 2;
    });

    await expect(commitVaultClipboardSourceWithConfirmation(
      commit,
      () => confirmed,
      () => true
    )).resolves.toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("waits through a transient subscription gate before committing the image link", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let ready = false;
    let confirmed = false;
    const commit = vi.fn(async () => { confirmed = true; });
    const assertCurrent = vi.fn();
    const pending = commitVaultClipboardSourceWithConfirmation(async () => {
      await waitForVaultClipboardSourceReadiness({
        isReady: () => ready, assertCurrent,
        signal: new AbortController().signal, sessionSignal: new AbortController().signal
      });
      await commit();
    }, () => confirmed, () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect(commit).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(assertCurrent.mock.calls.length).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["signal", "sessionSignal"] as const)("cancels a pending readiness wait immediately on %s without starting a write", async (field) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const commit = vi.fn();
    const pending = waitForVaultClipboardSourceReadiness({
      isReady: () => false, assertCurrent: () => undefined,
      signal: new AbortController().signal, sessionSignal: new AbortController().signal,
      [field]: controller.signal
    }).then(commit);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await rejected;
    expect(commit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks access scope after waiting even when the subscription becomes ready", async () => {
    vi.useFakeTimers();
    let ready = false;
    let current = true;
    const commit = vi.fn();
    const pending = waitForVaultClipboardSourceReadiness({
      isReady: () => ready,
      assertCurrent: () => { if (!current) throw new DOMException("revoked", "AbortError"); },
      signal: new AbortController().signal, sessionSignal: new AbortController().signal
    }).then(commit);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    current = false;
    ready = true;
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(commit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a permanently unavailable subscription without ever accepting the source", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const commit = vi.fn();
    const pending = waitForVaultClipboardSourceReadiness({
      isReady: () => false, assertCurrent: () => undefined,
      signal: new AbortController().signal, sessionSignal: new AbortController().signal
    }).then(commit);
    const rejected = expect(pending).rejects.toThrow("서버 준비 상태");
    await vi.advanceTimersByTimeAsync(VAULT_CLIPBOARD_SOURCE_READY_TIMEOUT_MS);
    await rejected;
    expect(commit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not delay an already-ready source or weaken exact confirmation", async () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const result = await commitVaultClipboardSourceWithConfirmation(async () => {
      await waitForVaultClipboardSourceReadiness({
        isReady: () => true, assertCurrent: () => undefined,
        signal: new AbortController().signal, sessionSignal: new AbortController().signal
      });
      await commit();
    }, () => false, () => false);
    expect(result).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards cancellation and current destination guards into asset encryption", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    const state = flowInput([clipboardFile(pngBytes())]);
    mocks.createEncryptedVaultAsset.mockImplementation(async (_profile, _key, _draft, options) => {
      expect(options.signal).toBe(state.input.signal);
      state.assertAssetDestinationCurrent.mockImplementation(() => { throw new DOMException("Scope ended", "AbortError"); });
      options.assertCurrent();
      throw new Error("unreachable");
    });
    expect(await pasteVaultClipboardImages(state.input)).toBeNull();
    expect(state.commitSource).not.toHaveBeenCalled();
    expect(mocks.deleteRevisionedNote).not.toHaveBeenCalled();
    expect(state.pendingClipboardAssetIds.size).toBe(0);
  });

  it("keeps a create receipt returned after cancellation available for exact asset rollback", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.deleteRevisionedNote.mockResolvedValue(undefined);
    let finish!: (value: { noteId: string; revision: number }) => void;
    mocks.createEncryptedVaultAsset.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const state = flowInput([clipboardFile(pngBytes())]);
    const controller = new AbortController(); state.input.signal = controller.signal;
    const pending = pasteVaultClipboardImages(state.input);
    await vi.waitFor(() => expect(mocks.createEncryptedVaultAsset).toHaveBeenCalled());
    controller.abort(); finish({ noteId: "late-asset", revision: 1 });
    expect(await pending).toBeNull();
    expect(mocks.deleteRevisionedNote).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 1, noteId: "late-asset", readerUids: [profile.uid], uid: profile.uid, vaultPasteLockId: `vpl1_${"A".repeat(43)}` });
    expect(state.commitSource).not.toHaveBeenCalled();
    expect(state.pendingClipboardAssetIds.size).toBe(0); expect(state.pendingCreatedEntryIds.size).toBe(0);
  });

  it("creates one encrypted asset only after two private source checks succeed", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    const state = flowInput([clipboardFile(pngBytes())], "현재 작업중인 노트 이름");

    const result = await pasteVaultClipboardImages(state.input);

    expect(mocks.getVisibleNotesByIdsFromServer).toHaveBeenCalledTimes(2);
    expect(mocks.createEncryptedVaultAsset).toHaveBeenCalledOnce();
    expect(mocks.createEncryptedVaultAsset).toHaveBeenCalledWith(
      profile,
      expect.anything(),
      expect.objectContaining({
        folderId: "pasted-images-folder",
        vaultPasteLockId: `vpl1_${"A".repeat(43)}`
      }),
      { signal: state.input.signal, assertCurrent: expect.any(Function) }
    );
    expect(mocks.deleteRevisionedNote).not.toHaveBeenCalled();
    expect(result?.source).toBe("\n\n![[붙여넣은 이미지/현재 작업중인 노트 이름 -1.png]]\n\n");
    expect(state.resolveAssetDestination).toHaveBeenCalledOnce();
    expect(state.assertAssetDestinationCurrent).toHaveBeenCalledTimes(2);
    expect(state.pendingCreatedEntryIds).toContain("asset-a");
    expect(state.pendingClipboardAssetIds).toContain("asset-a");
    await result?.onCommit?.();
    expect(state.confirmAssetDestination).toHaveBeenCalledOnce();
    expect(state.assertAssetDestinationCurrent).toHaveBeenCalledTimes(4);
    expect(state.pendingClipboardAssetIds).toContain("asset-a");
    expect(state.commitSource).toHaveBeenCalledWith(
      result?.source,
      expect.objectContaining({
        folderId: "pasted-images-folder",
        folderRevision: 1,
        lockId: `vpl1_${"A".repeat(43)}`
      })
    );
    expect(state.releaseAssetDestination).toHaveBeenCalledOnce();
    expect(state.setStatus).toHaveBeenLastCalledWith("이미지를 asset-v1로 암호화해 붙여넣었습니다.");
  });

  it("retries only an explicit cross-tab name conflict with the next note ordinal", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.createEncryptedVaultAsset
      .mockRejectedValueOnce(new VaultNameConflictError("A".repeat(43)))
      .mockResolvedValueOnce({ noteId: "asset-b", revision: 1 });
    const state = flowInput([clipboardFile(pngBytes())], "동시 작업 노트");

    const result = await pasteVaultClipboardImages(state.input);

    expect(mocks.createEncryptedVaultAsset).toHaveBeenCalledTimes(2);
    expect(mocks.createEncryptedVaultAsset.mock.calls.map((call) => call[2].title)).toEqual([
      "동시 작업 노트 -1.png",
      "동시 작업 노트 -2.png"
    ]);
    expect(result?.source).toBe("\n\n![[붙여넣은 이미지/동시 작업 노트 -2.png]]\n\n");
  });

  it("reconciles a subscription acknowledgement that beats the create response", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    const state = flowInput([clipboardFile(pngBytes())], "빠른 구독 노트");
    mocks.createEncryptedVaultAsset.mockImplementation(async (_profile, _key, draft) => {
      state.notes.push({
        ...sourceNote,
        entryKind: "asset",
        folderId: draft.folderId,
        id: "asset-fast",
        title: draft.title
      } as DecryptedVaultNote);
      return { noteId: "asset-fast", revision: 1 };
    });

    const result = await pasteVaultClipboardImages(state.input);

    expect(result?.source).toContain("빠른 구독 노트 -1.png");
    expect(state.pendingAssetTitleKeyById.size).toBe(0);
    expect(state.pendingAssetTitleKeys.size).toBe(0);
    expect(state.pendingCreatedEntryIds).not.toContain("asset-fast");
    expect(state.pendingClipboardAssetIds).not.toContain("asset-fast");
  });

  it("restores the editor source and releases the lease when source persistence is not confirmed", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    const state = flowInput([clipboardFile(pngBytes())]);
    state.commitSource.mockResolvedValue(false);

    const result = await pasteVaultClipboardImages(state.input);
    const accepted = await result?.onCommit?.();

    expect(accepted).toBe(false);
    expect(state.pendingClipboardAssetIds).toContain("asset-a");
    expect(state.pendingCreatedEntryIds).toContain("asset-a");
    expect(state.pendingAssetTitleKeyById.size).toBe(1);
    expect(state.pendingAssetTitleKeys.size).toBe(1);
    expect(mocks.deleteRevisionedNote).not.toHaveBeenCalled();
    expect(state.releaseAssetDestination).toHaveBeenCalledOnce();
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("방금 넣은 링크를 되돌렸습니다"));
    const source = "\n\n![[붙여넣은 이미지/Source -1.png]]\n\n";
    expect(result?.source).toBe(source);
    expect(result?.onRollback?.({ replacementText: "원문", source: source.trim() })).toBe(false);
    expect(state.rollbackSource).not.toHaveBeenCalled();
    expect(result?.onRollback?.({ replacementText: "원문", source })).toBe(true);
    expect(state.rollbackSource).toHaveBeenCalledExactlyOnceWith({ replacementText: "원문", source });
  });

  it("never starts a source write when the destination lease cannot be reconfirmed", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    const state = flowInput([clipboardFile(pngBytes())]);
    state.confirmAssetDestination.mockRejectedValue(new Error("lease expired"));

    const result = await pasteVaultClipboardImages(state.input);
    const accepted = await result?.onCommit?.();

    expect(accepted).toBe(false);
    expect(state.commitSource).not.toHaveBeenCalled();
    expect(state.releaseAssetDestination).toHaveBeenCalledOnce();
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
      uid: "user-a",
      vaultPasteLockId: `vpl1_${"A".repeat(43)}`
    });
    expect(state.pendingCreatedEntryIds).not.toContain("asset-a");
    expect(state.pendingAssetTitleKeyById.size).toBe(0);
    expect(state.pendingAssetTitleKeys.size).toBe(0);
    expect(state.pendingClipboardAssetIds.size).toBe(0);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("서버에서 개인 Markdown 노트 상태"));
  });

  it("deletes a created asset when the dedicated folder path changes mid-flight", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockResolvedValue(successfulServerRead());
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    mocks.deleteRevisionedNote.mockResolvedValue({ noteId: "asset-a", revision: 2 });
    const state = flowInput([clipboardFile(pngBytes())]);
    state.assertAssetDestinationCurrent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("이미지를 저장하는 동안 붙여넣은 이미지 폴더 경로가 변경되었습니다.");
      });

    const result = await pasteVaultClipboardImages(state.input);

    expect(result).toBeNull();
    expect(mocks.deleteRevisionedNote).toHaveBeenCalledWith({
      expectedRevision: 1,
      noteId: "asset-a",
      readerUids: ["user-a"],
      uid: "user-a",
      vaultPasteLockId: `vpl1_${"A".repeat(43)}`
    });
    expect(state.pendingClipboardAssetIds.size).toBe(0);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("폴더 경로가 변경"));
  });

  it("releases the transient asset lock when automatic discard needs manual cleanup", async () => {
    const sharedAfterCreate = {
      ...sourceNote,
      participantUids: ["user-a", "user-b"],
      type: "shared"
    } as DecryptedVaultNote;
    mocks.getVisibleNotesByIdsFromServer
      .mockResolvedValueOnce(successfulServerRead())
      .mockResolvedValueOnce(successfulServerRead(sharedAfterCreate));
    mocks.createEncryptedVaultAsset.mockResolvedValue({ noteId: "asset-a", revision: 1 });
    mocks.deleteRevisionedNote.mockRejectedValue(new Error("cleanup failed"));
    const state = flowInput([clipboardFile(pngBytes())]);

    const result = await pasteVaultClipboardImages(state.input);

    expect(result).toBeNull();
    expect(state.pendingClipboardAssetIds.size).toBe(0);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("직접 확인"));
  });

  it("preserves an invalid-image failure while aborting a stalled ACL preflight", async () => {
    mocks.getVisibleNotesByIdsFromServer.mockImplementation(() => new Promise<never>(() => undefined));
    const state = flowInput([
      clipboardFile(new TextEncoder().encode("not a png"))
    ]);

    const result = await pasteVaultClipboardImages(state.input);

    expect(result).toBeNull();
    expect(mocks.createEncryptedVaultAsset).not.toHaveBeenCalled();
    expect(state.resolveAssetDestination).not.toHaveBeenCalled();
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
    expect(state.resolveAssetDestination).not.toHaveBeenCalled();
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
    expect(state.resolveAssetDestination).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining("이미지 배치 준비 시간이 초과"));
  });
});
