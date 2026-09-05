import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../vault/vaultData";
import { usePrivateWikiData } from "./usePrivateWikiData";

const mocks = vi.hoisted(() => ({
  session: { clear: vi.fn() } as { clear: ReturnType<typeof vi.fn> } | null,
  subscribeNotes: vi.fn(), subscribeFolders: vi.fn(),
  stopNotes: vi.fn(), stopFolders: vi.fn(),
  decryptNotes: vi.fn(), decryptFolders: vi.fn(),
  nextNotes: null as ((notes: NoteSnapshot[]) => void) | null,
  nextFolders: null as ((folders: NoteFolderSnapshot[]) => void) | null,
  noteError: null as (() => void) | null,
  folderError: null as (() => void) | null
}));
vi.mock("../../context/VaultDecryptionContext", () => ({ useVaultDecryptionSession: () => mocks.session }));
vi.mock("../../services/notes", () => ({ subscribeVisibleNotes: mocks.subscribeNotes, subscribeNoteFolders: mocks.subscribeFolders }));
vi.mock("../vault/vaultData", async (importOriginal) => ({
  ...await importOriginal<typeof import("../vault/vaultData")>(),
  decryptVaultNotes: mocks.decryptNotes,
  decryptVaultFolders: mocks.decryptFolders
}));

const key = {} as CryptoKey;
const note = (id: string, extra = {}) => ({ id, ownerUid: "owner", isDeleted: false, wrappedKeys: { owner: {} }, title: id, body: "비밀 본문", contentFormat: "markdown-v1", entryKind: "markdown", ...extra }) as unknown as DecryptedVaultNote;
const folder = (id: string, extra = {}) => ({ id, ownerUid: "owner", displayName: id, name: id, parentId: null, ...extra }) as unknown as DecryptedVaultFolder;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { clear: vi.fn() };
  mocks.subscribeNotes.mockImplementation((_uid, _owners, callback, error) => {
    mocks.nextNotes = callback; mocks.noteError = error; return mocks.stopNotes;
  });
  mocks.subscribeFolders.mockImplementation((_uid, callback, error) => {
    mocks.nextFolders = callback; mocks.folderError = error; return mocks.stopFolders;
  });
  mocks.decryptNotes.mockImplementation(async (notes) => notes);
  mocks.decryptFolders.mockImplementation(async (folders) => folders);
});

describe("usePrivateWikiData", () => {
  it("keeps owner asset envelopes outside the main crypto path and preserves their identity on text updates", async () => {
    const asset = note("image", { contentFormat: "asset-v1", entryKind: "asset" });
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => {
      mocks.nextNotes!([note("text"), asset,
        note("other-image", { contentFormat: "asset-v1", entryKind: "asset", ownerUid: "other" }),
        note("hidden-image", { contentFormat: "asset-v1", entryKind: "asset", folderId: "gone" })]);
      mocks.nextFolders!([]);
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.decryptNotes.mock.calls[0][0].map((item: NoteSnapshot) => item.id)).toEqual(["text"]);
    expect(result.current.assetSnapshots).toEqual([asset]);
    const assets = result.current.assetSnapshots;
    const folders = result.current.folders;
    act(() => { mocks.nextNotes!([note("text", { body: "new" }), asset]); });
    await waitFor(() => expect(result.current.notes[0].body).toBe("new"));
    expect(result.current.assetSnapshots).toBe(assets);
    expect(result.current.folders).toBe(folders);
    expect(mocks.decryptFolders).toHaveBeenCalledOnce();
  });

  it.each(["removal", "owner", "wrapped-key"])("invalidates image authority immediately on %s before a pending text decrypt", async (change) => {
    const asset = note("image", { contentFormat: "asset-v1", entryKind: "asset" });
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => { mocks.nextNotes!([note("text"), asset]); mocks.nextFolders!([]); });
    await waitFor(() => expect(result.current.assetSnapshots).toHaveLength(1));
    mocks.decryptNotes.mockReturnValue(new Promise(() => undefined));
    act(() => { mocks.nextNotes!([note("text"), ...(change === "removal" ? [] : [{ ...asset,
      ...(change === "owner" ? { ownerUid: "other" } : { wrappedKeys: { owner: { wrappedKey: "new" } } })
    } as unknown as NoteSnapshot])]); });
    expect(result.current.assetSnapshots).toEqual([]);
    expect(result.current.notes).toEqual([]);
    expect(result.current.ready).toBe(false);
    expect(mocks.session!.clear).toHaveBeenCalledOnce();
  });

  it("uses owner-only subscriptions with every implicit write disabled", async () => {
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => {
      mocks.nextNotes!([note("own"), note("other", { ownerUid: "other" }), note("deleted", { isDeleted: true }), note("no-key", { wrappedKeys: {} }), note("hidden", { folderId: "hidden" }), note("canvas", { entryKind: "canvas" })]);
      mocks.nextFolders!([folder("visible"), folder("other", { ownerUid: "other" })]);
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.notes.map((item) => item.id)).toEqual(["own"]);
    expect(result.current.folders.map((item) => item.id)).toEqual(["visible"]);
    expect(mocks.subscribeNotes).toHaveBeenCalledWith("owner", ["owner"], expect.any(Function), expect.any(Function), undefined, { repairLegacyDeletionMetadata: false });
    expect(mocks.subscribeFolders).toHaveBeenCalledWith("owner", expect.any(Function), expect.any(Function), undefined, { prepareVaultFolderTree: false });
    expect(mocks.decryptNotes.mock.calls[0][3]).toEqual({ session: mocks.session, signal: expect.any(AbortSignal) });
  });

  it("does not subscribe until the matching unlocked session is ready", () => {
    mocks.session = null;
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    expect(result.current.ready).toBe(false);
    expect(mocks.subscribeNotes).not.toHaveBeenCalled();
    expect(mocks.subscribeFolders).not.toHaveBeenCalled();
  });

  it("excludes asset, Base, and Canvas bodies before crypto while retaining legacy storage identities", async () => {
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => {
      mocks.nextNotes!([
        note("markdown"),
        note("legacy", { entryKind: "legacy-html", contentFormat: "legacy-html-v1" }),
        note("legacy-missing", { entryKind: undefined, contentFormat: undefined }),
        note("markdown-missing-kind", { entryKind: undefined, contentFormat: "markdown-v1" }),
        note("binary", { entryKind: "asset", contentFormat: "asset-v1" }),
        note("base", { entryKind: "base", contentFormat: "base-v1" }),
        note("canvas", { entryKind: "canvas", contentFormat: "json-canvas-v1" }),
        note("binary-missing-kind", { entryKind: undefined, contentFormat: "asset-v1" }),
        note("base-missing-kind", { entryKind: undefined, contentFormat: "base-v1" }),
        note("canvas-missing-kind", { entryKind: undefined, contentFormat: "json-canvas-v1" })
      ]);
      mocks.nextFolders!([]);
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.decryptNotes).toHaveBeenCalledOnce();
    expect(mocks.decryptNotes.mock.calls[0][0].map((item: NoteSnapshot) => item.id)).toEqual([
      "markdown", "legacy", "legacy-missing", "markdown-missing-kind"
    ]);
  });

  it("hides plaintext and cancels a delayed decrypt when the key locks", async () => {
    let resolve: (notes: DecryptedVaultNote[]) => void = () => undefined;
    mocks.decryptNotes.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { result, rerender } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => { mocks.nextNotes!([note("own")]); mocks.nextFolders!([]); });
    const signal = mocks.decryptNotes.mock.calls[0][3].signal as AbortSignal;
    mocks.session = null;
    rerender();
    expect(signal.aborted).toBe(true);
    expect(mocks.stopNotes).toHaveBeenCalled();
    expect(mocks.stopFolders).toHaveBeenCalled();
    await act(async () => { resolve([note("late")]); });
    expect(result.current.notes).toEqual([]);
    expect(result.current.ready).toBe(false);
  });

  it("clears all plaintext on listener failure and ignores later callbacks", async () => {
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => { mocks.nextNotes!([note("own")]); mocks.nextFolders!([]); });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { mocks.folderError!(); });
    expect(result.current.notes).toEqual([]);
    expect(result.current.error).toBeTruthy();
    expect(mocks.session!.clear).toHaveBeenCalledOnce();
    const count = mocks.decryptNotes.mock.calls.length;
    act(() => { mocks.nextNotes!([note("late")]); mocks.nextFolders!([]); });
    expect(mocks.decryptNotes).toHaveBeenCalledTimes(count);
  });

  it("removes deleted-folder plaintext before replacement decryption completes", async () => {
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => { mocks.nextNotes!([note("own", { folderId: "folder" })]); mocks.nextFolders!([folder("folder")]); });
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    let resolve: (notes: DecryptedVaultNote[]) => void = () => undefined;
    mocks.decryptNotes.mockImplementation(() => new Promise((done) => { resolve = done; }));
    act(() => { mocks.nextFolders!([]); });
    expect(result.current.notes).toEqual([]);
    expect(mocks.decryptNotes.mock.calls.at(-1)![0]).toEqual([]);
    await act(async () => { resolve([]); });
    expect(result.current.ready).toBe(true);
  });

  it("never retains the old account or key projection during replacement", async () => {
    const { result, rerender } = renderHook(({ uid, privateKey }) => usePrivateWikiData(uid, privateKey), { initialProps: { uid: "owner", privateKey: key } });
    act(() => { mocks.nextNotes!([note("own")]); mocks.nextFolders!([]); });
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    rerender({ uid: "other", privateKey: {} as CryptoKey });
    expect(result.current.notes).toEqual([]);
    expect(result.current.ready).toBe(false);
    expect(mocks.subscribeNotes.mock.calls.at(-1)!.slice(0, 2)).toEqual(["other", ["other"]]);
  });

  it("keeps the reader ready during a same-authority body update", async () => {
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => { mocks.nextNotes!([note("own")]); mocks.nextFolders!([]); });
    await waitFor(() => expect(result.current.ready).toBe(true));
    let resolve: (notes: DecryptedVaultNote[]) => void = () => undefined;
    mocks.decryptNotes.mockImplementation(() => new Promise((done) => { resolve = done; }));
    act(() => { mocks.nextNotes!([note("own", { revision: 2, body: "새 본문" })]); });
    expect(result.current.ready).toBe(true);
    expect(result.current.notes[0].body).toBe("비밀 본문");
    expect(mocks.session!.clear).not.toHaveBeenCalled();
    await act(async () => { resolve([note("own", { revision: 2, body: "새 본문" })]); });
    expect(result.current.notes[0].body).toBe("새 본문");
  });

  it("hides plaintext immediately when the wrapped key changes", async () => {
    const { result } = renderHook(() => usePrivateWikiData("owner", key));
    act(() => { mocks.nextNotes!([note("own")]); mocks.nextFolders!([]); });
    await waitFor(() => expect(result.current.ready).toBe(true));
    mocks.decryptNotes.mockImplementation(() => new Promise(() => undefined));
    act(() => { mocks.nextNotes!([note("own", { wrappedKeys: { owner: { wrappedKey: "replacement" } } })]); });
    expect(result.current.ready).toBe(false);
    expect(result.current.notes).toEqual([]);
    expect(mocks.session!.clear).toHaveBeenCalledOnce();
  });
});
