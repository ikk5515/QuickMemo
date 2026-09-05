import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedWikiManifest } from "./publishedWikiTypes";
import { usePublishedWikiData } from "./usePublishedWikiData";
const api = vi.hoisted(() => ({ manifest: vi.fn(), contents: vi.fn() }));
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiManifest: api.manifest, getPublishedWikiContents: api.contents }));
function manifest(id = "wiki", count = 18): PublishedWikiManifest {
  return { wikiId: id, revision: 1, title: "공개 폴더", expiresAt: null, updatedAt: "2026-09-05", folders: [{ id: "folder", parentId: null, name: "공개 폴더", path: "공개 폴더" }], entries: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, folderId: "folder", title: `메모${index}`, path: `공개 폴더/메모${index}.md`, kind: "markdown" })) };
}
beforeEach(() => { vi.clearAllMocks(); api.manifest.mockResolvedValue(manifest()); api.contents.mockImplementation(async (_id: string, ids: string[], revision: number) => ({ revision, entries: manifest().entries.filter((entry) => ids.includes(entry.id)).map((entry) => ({ ...entry, body: `공개 본문 ${entry.id}` })) })); });
afterEach(() => vi.useRealTimers());

describe("public wiki scoped in-memory reads", () => {
  it("prioritizes a deep link, batches remaining notes and does not reload on navigation", async () => {
    const { result, rerender } = renderHook(({ ids }) => usePublishedWikiData("wiki", ids, 0), { initialProps: { ids: ["n17"] } });
    await waitFor(() => expect(result.current.data?.contents.size).toBe(18));
    expect(api.contents.mock.calls[0][1][0]).toBe("n17");
    expect(api.contents).toHaveBeenCalledTimes(3);
    expect(api.contents.mock.calls.every((call) => call[1].length <= 8)).toBe(true);
    const signal = result.current.data!.signal;
    rerender({ ids: ["n2"] });
    expect(api.manifest).toHaveBeenCalledTimes(1);
    expect(result.current.data!.signal).toBe(signal);
  });

  it("discards all plaintext and aborts images when public access is revoked", async () => {
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(result.current.data?.contents.size).toBe(18));
    const scope = result.current.data!.signal;
    api.manifest.mockRejectedValueOnce(new Error("공개가 중지되었습니다."));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(scope.aborted).toBe(true);
    expect(result.current.error).toContain("공개가 중지");
  });

  it("removes a moved source and invalidates the old asset scope on manifest contraction", async () => {
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(result.current.data?.contents.size).toBe(18));
    const scope = result.current.data!.signal;
    api.manifest.mockResolvedValueOnce(manifest("wiki", 1));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(result.current.data?.contents.size).toBe(1));
    expect(scope.aborted).toBe(true);
    expect(result.current.data!.contents.has("n17")).toBe(false);
  });

  it("does not accept a stale response after changing public wiki URLs", async () => {
    let finish!: (value: unknown) => void;
    api.contents.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ id }) => usePublishedWikiData(id, [], 0), { initialProps: { id: "old" } });
    await waitFor(() => expect(api.contents).toHaveBeenCalledTimes(1));
    const oldSignal = result.current.data!.signal;
    api.manifest.mockResolvedValueOnce(manifest("new", 1));
    rerender({ id: "new" });
    await waitFor(() => expect(result.current.data?.contents.size).toBe(1));
    await act(async () => finish({ revision: 1, entries: manifest().entries.map((entry) => ({ ...entry, body: "old secret" })) }));
    expect(oldSignal.aborted).toBe(true);
    expect(result.current.data?.wikiId).toBe("new");
    expect(result.current.data?.contents.get("n0")?.body).not.toContain("old secret");
  });

  it("fails closed when a source disappears between manifest and content reads", async () => {
    api.contents.mockResolvedValue({ revision: 1, entries: [] });
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(result.current.error).toContain("공개 범위가 변경"));
    expect(result.current.data).toBeNull();
  });

  it("retains its completed projection on unchanged manifest refreshes", async () => {
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(result.current.data?.contents.size).toBe(18));
    const data = result.current.data;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(result.current.data).toBe(data);
    expect(api.contents).toHaveBeenCalledTimes(3);
  });
});

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
function page(source: PublishedWikiManifest, ids: string[]) { return { revision: source.revision, entries: source.entries.filter((entry) => ids.includes(entry.id)).map((entry) => ({ ...entry, body: `revision ${source.revision}` })) }; }
describe("public manifest verification remains live during slow content", () => {
  it.each(["first", "background"])("revalidates and revokes access while the %s content request never settles", async (position) => {
    const pending = deferred<unknown>();
    if (position === "first") api.contents.mockImplementation(() => pending.promise);
    else api.contents.mockImplementation((_id: string, ids: string[]) => ids.includes("n0") ? Promise.resolve(page(manifest(), ids)) : pending.promise);
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(api.contents).toHaveBeenCalledTimes(position === "first" ? 1 : 3));
    const scope = result.current.data!.signal;
    expect(result.current.data?.contents.size).toBe(position === "first" ? 0 : 8);
    api.manifest.mockRejectedValueOnce(new Error("공개가 중지되었습니다."));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(api.manifest).toHaveBeenCalledTimes(2); expect(scope.aborted).toBe(true);
    expect(result.current.data).toBeNull(); expect(result.current.error).toContain("공개가 중지");
  });
  it.each(["resolve", "reject"])("an old content %s cannot overwrite or discard a new revision", async (outcome) => {
    const old = deferred<unknown>(); const previous = manifest("wiki", 1);
    const next = { ...previous, revision: 2 };
    api.manifest.mockResolvedValueOnce(previous).mockResolvedValue(next);
    api.contents.mockImplementationOnce(() => old.promise).mockImplementation(async (_id: string, ids: string[]) => page(next, ids));
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(api.contents).toHaveBeenCalledTimes(1));
    const oldSignal = result.current.data!.signal;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(result.current.data?.contents.get("n0")?.body).toBe("revision 2"));
    const current = result.current.data;
    await act(async () => { if (outcome === "resolve") old.resolve(page(previous, ["n0"])); else old.reject(new Error("old failure")); });
    expect(result.current.data).toBe(current); expect(result.current.error).toBe(""); expect(oldSignal.aborted).toBe(true);
  });
  it("refreshes unchanged manifests without restarting a pending first chunk", async () => {
    const pending = deferred<unknown>(); api.contents.mockReturnValue(pending.promise);
    const { result } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await waitFor(() => expect(api.contents).toHaveBeenCalledTimes(1));
    const scope = result.current.data!.signal;
    for (let index = 0; index < 3; index += 1) await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(api.manifest).toHaveBeenCalledTimes(4); expect(api.contents).toHaveBeenCalledTimes(1);
    expect(scope.aborted).toBe(false); expect(result.current.data?.signal).toBe(scope);
  });
  it("runs interval revalidation while body loading is stalled", async () => {
    vi.useFakeTimers(); api.contents.mockReturnValue(new Promise(() => undefined));
    const { result, unmount } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.contents).toHaveBeenCalledTimes(1);
    api.manifest.mockRejectedValueOnce(new Error("revoked"));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(api.manifest).toHaveBeenCalledTimes(2); expect(result.current.data).toBeNull();
    unmount();
  });
  it("fails closed after a bounded manifest timeout and ignores its late result", async () => {
    vi.useFakeTimers(); const pending = deferred<PublishedWikiManifest>();
    const { result, unmount } = renderHook(() => usePublishedWikiData("wiki", [], 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.data?.contents.size).toBe(18); const scope = result.current.data!.signal;
    api.manifest.mockReturnValueOnce(pending.promise);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current.data).toBeNull(); expect(scope.aborted).toBe(true);
    expect(api.manifest.mock.calls[1][1].aborted).toBe(true);
    expect(result.current.error).toContain("공개 상태를 확인하지 못했습니다");
    await act(async () => pending.resolve(manifest())); expect(result.current.data).toBeNull(); unmount();
  });
});
