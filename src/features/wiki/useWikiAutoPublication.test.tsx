import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), publish: vi.fn() }));
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiWorkspaceStatus: mocks.status, publishPreparedWiki: mocks.publish }));
import { publicationManifestSignature, publicationSourceIds, useWikiAutoPublication } from "./useWikiAutoPublication";
import type { PreparedWikiPublication, PublishedWikiOwnerStatus, WikiPublicationInput, WikiPublicationSelection } from "./publishedWikiTypes";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../vault/vaultData";
const wikiId = `pw1_${"a".repeat(32)}`;
const selection = { folderIds: ["root"], noteIds: [] };
function folder(id: string, parentId: string | null = null, extra = {}): DecryptedVaultFolder {
  return { id, ownerUid: "owner", parentId, displayName: id, ...extra } as DecryptedVaultFolder;
}
function note(id = "note", revision = 1, folderId: string | null = "root", extra = {}): DecryptedVaultNote {
  return { id, revision, folderId, ownerUid: "owner", participantUids: ["owner"], title: id, body: `saved ${revision}`, entryKind: "markdown", contentFormat: "markdown-v1", ...extra } as DecryptedVaultNote;
}
function manifest(revision = 1): WikiPublicationInput {
  return { rootFolderId: null, selection: { folderIds: ["root"], noteIds: [] }, title: "Wiki", expiresAt: null,
    folders: [{ sourceFolderId: "root", parentSourceFolderId: null, name: "root" }],
    entries: [{ sourceNoteId: "note", sourceRevision: revision, sourceFolderId: "root", parentSourceFolderId: "root", title: "note", kind: "markdown" }] };
}
function prepared(revision = 1): PreparedWikiPublication {
  return { manifest: manifest(revision), contents: [{ sourceNoteId: "note", body: `saved ${revision}` }], totalBytes: 7, omittedEntryCount: 0, redactedLinkCount: 0 };
}
function status(revision = 1, extra: Partial<PublishedWikiOwnerStatus> = {}): PublishedWikiOwnerStatus {
  return { wikiId, slug: "ingi", revision, published: true, title: "Wiki", expiresAt: null, updatedAt: "2026-09-05T00:00:00Z", noteCount: 1, assetCount: 0, selection, manifest: manifest(), ...extra };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const prepare = vi.fn<(grants: WikiPublicationSelection, signal: AbortSignal) => Promise<PreparedWikiPublication>>();
let defaultSignal = new AbortController().signal;
function options(extra = {}) { return { uid: "owner", signal: defaultSignal, ready: true, paused: false, notes: [note()], folders: [folder("root")], prepare, ...extra }; }
async function tick(ms = 0) { await act(async () => { await Promise.resolve(); }); await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); defaultSignal = new AbortController().signal; mocks.status.mockReset().mockResolvedValue(status()); prepare.mockReset().mockResolvedValue(prepared());
  mocks.publish.mockReset().mockImplementation(async (next: PreparedWikiPublication, revision: number) => status(revision + 1, { manifest: next.manifest, selection: next.manifest.selection }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("automatic publication source and canonical metadata boundaries", () => {
  it("detects the same manifest independently of property insertion order and source row order", () => {
    const first = manifest();
    const second: WikiPublicationInput = { folders: first.folders.map((row) => ({ name: row.name, sourceFolderId: row.sourceFolderId, parentSourceFolderId: row.parentSourceFolderId })),
      entries: first.entries.map((row) => ({ kind: row.kind, title: row.title, sourceFolderId: row.sourceFolderId, sourceNoteId: row.sourceNoteId, parentSourceFolderId: row.parentSourceFolderId, sourceRevision: row.sourceRevision })),
      title: first.title, expiresAt: first.expiresAt, selection: first.selection, rootFolderId: first.rootFolderId };
    expect(publicationManifestSignature(first)).toBe(publicationManifestSignature(second));
    expect(publicationManifestSignature(first)).not.toBe(publicationManifestSignature(manifest(2)));
  });
  it("includes only owned live explicit notes and chosen descendants, without following outside links", () => {
    const result = publicationSourceIds("owner", { folderIds: ["root"], noteIds: ["loose", "foreign"] }, [
      note(), note("child-note", 1, "child"), note("outside", 1, "outside", { body: "[[root/note]]" }), note("loose", 1, null),
      note("foreign", 1, "root", { ownerUid: "other" }), note("deleted", 1, "root", { isDeleted: true }), note("purged", 1, "root", { isPurged: true })
    ], [folder("root"), folder("child", "root"), folder("outside"), folder("foreign-child", "root", { ownerUid: "other" })]);
    expect(result.notes.map((row) => row.id)).toEqual(["note", "child-note", "loose"]);
    expect([...result.folderIds]).toEqual(["root", "child"]);
  });
});
describe("automatic publication scoped saved-source queue", () => {
  it("keeps an address-only adopted legacy snapshot unchanged across edits, focus and remount", async () => {
    const legacyManifest = { ...manifest(), rootFolderId: "root", selection: undefined };
    mocks.status.mockResolvedValue(status(3, { manifest: legacyManifest }));
    prepare.mockResolvedValue(prepared(3));
    const initial = options({ notes: [note("note", 2)] });
    const view = renderHook((props) => useWikiAutoPublication(props), { initialProps: initial });
    await tick(1200);
    view.rerender({ ...initial, notes: [note("note", 3)] });
    act(() => window.dispatchEvent(new Event("focus"))); await tick(20_000);
    expect(prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    view.unmount(); renderHook(() => useWikiAutoPublication(initial)); await tick(1200);
    expect(prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("enables automatic updates only after a migrated site's explicit workspace publication receipt", async () => {
    mocks.status.mockResolvedValue(status(0, { wikiId: null, slug: null, published: false, manifest: null }));
    prepare.mockResolvedValue(prepared(3));
    const initial = options({ paused: true, notes: [note("note", 3)] });
    const { result, rerender } = renderHook((props) => useWikiAutoPublication(props), { initialProps: initial });
    await tick();
    act(() => result.current.updateStatus(status(3, { manifest: { ...manifest(), rootFolderId: "root", selection: undefined } })));
    rerender({ ...initial, paused: false }); await tick(1200);
    expect(prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    act(() => result.current.updateStatus(status(4, { manifest: manifest(2) })));
    await tick(1200);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ rootFolderId: null, selection }) }), 4, expect.objectContaining({ expectedUid: "owner" }));
  });
  it("skips upload when server and prepared manifests are equal, including after remount", async () => {
    const first = renderHook(() => useWikiAutoPublication(options())); await tick(1200);
    expect(prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled(); first.unmount();
    renderHook(() => useWikiAutoPublication(options())); await tick(1200);
    expect(prepare).toHaveBeenCalledTimes(2); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("debounces saved metadata and never schedules for an unrelated note or unsaved body-only change", async () => {
    const initial = options(); const { rerender } = renderHook((props) => useWikiAutoPublication(props), { initialProps: initial }); await tick(1200);
    rerender({ ...initial, notes: [note("note", 1, "root", { body: "unsaved-looking change, same saved revision" }), note("private", 50, "outside")] }); await tick(5000);
    expect(prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    prepare.mockResolvedValue(prepared(3));
    rerender({ ...initial, notes: [note("note", 2)] }); await tick(700);
    rerender({ ...initial, notes: [note("note", 3)] }); await tick(1199); expect(mocks.publish).not.toHaveBeenCalled();
    await tick(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ entries: expect.arrayContaining([expect.objectContaining({ sourceRevision: 3 })]) }) }), 1, expect.objectContaining({ expectedUid: "owner" }));
  });
  it("uses the last confirmed public title and expiry during a saved-content update", async () => {
    const expiry = "2027-01-01T00:00:00Z"; mocks.status.mockResolvedValue(status(7, { title: "Confirmed wiki", expiresAt: expiry }));
    prepare.mockResolvedValue(prepared(2)); const input = options({ notes: [note("note", 2)] });
    renderHook(() => useWikiAutoPublication(input)); await tick(1200);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ title: "Confirmed wiki", expiresAt: expiry }) }), 7, expect.any(Object));
  });
  it("refuses preparation that adds an unapproved folder or individual-note grant", async () => {
    for (const added of [{ folderIds: ["root", "private"], noteIds: [] }, { folderIds: ["root"], noteIds: ["private-note"] }]) {
      const next = prepared(2); next.manifest.selection = added; prepare.mockResolvedValueOnce(next);
      const view = renderHook(() => useWikiAutoPublication(options({ notes: [note("note", 2)] }))); await tick(1200);
      expect(mocks.publish).not.toHaveBeenCalled(); expect(view.result.current.message).toBe("위키 반영 대기 중"); view.unmount();
    }
  });
  it("does not let preparation mutate the captured approved grant list", async () => {
    prepare.mockImplementationOnce(async (grants) => { grants.noteIds.push("private-note"); return { ...prepared(2), manifest: { ...manifest(2), selection: grants } }; });
    renderHook(() => useWikiAutoPublication(options({ notes: [note("note", 2)] }))); await tick(1200);
    expect(mocks.publish).not.toHaveBeenCalled(); expect(selection.noteIds).toEqual([]);
  });
  it("pauses dialog work, aborts a pending preparation, and resumes with the latest saved source", async () => {
    const pending = deferred<PreparedWikiPublication>(); prepare.mockReturnValueOnce(pending.promise).mockResolvedValue(prepared(2));
    const initial = options({ notes: [note("note", 2)] }); const { rerender } = renderHook((props) => useWikiAutoPublication(props), { initialProps: initial }); await tick(1200);
    const signal = prepare.mock.calls[0][1]; rerender({ ...initial, paused: true }); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(prepared(2))); await tick(2000); expect(mocks.publish).not.toHaveBeenCalled();
    rerender({ ...initial, paused: false }); await tick(1200); expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("does not republish after dialog revocation while preparation is pending", async () => {
    const pending = deferred<PreparedWikiPublication>(); prepare.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useWikiAutoPublication(options({ notes: [note("note", 2)] }))); await tick(1200);
    act(() => result.current.updateStatus(status(2, { published: false, manifest: null, selection: { folderIds: [], noteIds: [] } })));
    await act(async () => pending.resolve(prepared(2))); await tick(20000); expect(mocks.publish).not.toHaveBeenCalled(); expect(result.current.status?.published).toBe(false);
  });
  it("ignores an older metadata response that arrives after a newer dialog commit", async () => {
    const pending = deferred<PublishedWikiOwnerStatus>(); mocks.status.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useWikiAutoPublication(options()));
    act(() => result.current.updateStatus(status(4, { published: false, manifest: null, selection: { folderIds: [], noteIds: [] } })));
    await act(async () => pending.resolve(status(1))); await tick(3000);
    expect(result.current.status?.revision).toBe(4); expect(result.current.status?.published).toBe(false); expect(prepare).not.toHaveBeenCalled();
  });
  it("refreshes after a CAS conflict and respects a server-side unpublish", async () => {
    mocks.status.mockResolvedValueOnce(status()).mockResolvedValueOnce(status(2, { published: false, manifest: null, selection: { folderIds: [], noteIds: [] } }));
    prepare.mockResolvedValue(prepared(2)); mocks.publish.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "publication_changed" }));
    const { result } = renderHook(() => useWikiAutoPublication(options({ notes: [note("note", 2)] }))); await tick(1200); await tick(20000);
    expect(mocks.publish).toHaveBeenCalledTimes(1); expect(result.current.status?.published).toBe(false); expect(result.current.message).toBe("");
  });
  it("retries saved-only preparation failures after 15 seconds without polling on every keystroke", async () => {
    prepare.mockRejectedValueOnce(new Error("draft is dirty/composing")).mockResolvedValueOnce(prepared(2));
    const initial = options({ notes: [note("note", 2)] }); const { result, rerender } = renderHook((props) => useWikiAutoPublication(props), { initialProps: initial }); await tick(1200);
    expect(result.current.message).toBe("위키 반영 대기 중"); expect(mocks.publish).not.toHaveBeenCalled();
    rerender({ ...initial, notes: [note("note", 2, "root", { body: "more typing" })] }); await tick(14999); expect(prepare).toHaveBeenCalledTimes(1);
    await tick(1); await tick(1200); expect(prepare).toHaveBeenCalledTimes(2); expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("drops old UID status and callbacks immediately and never starts a new account using old grants", async () => {
    const pending = deferred<PublishedWikiOwnerStatus>(); mocks.status.mockResolvedValueOnce(status()).mockReturnValueOnce(pending.promise);
    const first = options(); const { result, rerender } = renderHook((props) => useWikiAutoPublication(props), { initialProps: first }); await tick(1200);
    const oldUpdate = result.current.updateStatus;
    rerender({ ...first, uid: "other", signal: new AbortController().signal, notes: [note("note", 2, "root", { ownerUid: "other" })] });
    expect(result.current.status).toBeNull(); act(() => oldUpdate(status(9))); await tick(3000);
    expect(result.current.status).toBeNull(); expect(mocks.publish).not.toHaveBeenCalled();
    await act(async () => pending.resolve(status(0, { wikiId: null, slug: null, published: false, manifest: null })));
    expect(result.current.status?.published).toBe(false);
  });
  it("aborts/clears status on lock and ignores late preparation after unlock-scope disposal", async () => {
    const pending = deferred<PreparedWikiPublication>(); prepare.mockReturnValueOnce(pending.promise); const controller = new AbortController();
    const { result } = renderHook(() => useWikiAutoPublication(options({ signal: controller.signal, notes: [note("note", 2)] }))); await tick(1200);
    act(() => controller.abort()); expect(result.current.status).toBeNull();
    await act(async () => pending.resolve(prepared(2))); await tick(20000); expect(mocks.publish).not.toHaveBeenCalled(); expect(result.current.message).toBe("");
  });
  it("starts only when unlocked server data is ready and recovers status reads on online", async () => {
    mocks.status.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(status()); prepare.mockResolvedValue(prepared(2));
    const initial = options({ ready: false, notes: [note("note", 2)] }); const { rerender } = renderHook((props) => useWikiAutoPublication(props), { initialProps: initial }); await tick(5000);
    act(() => window.dispatchEvent(new Event("online"))); await tick(1200); expect(prepare).not.toHaveBeenCalled();
    rerender({ ...initial, ready: true }); await tick(1200); expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
