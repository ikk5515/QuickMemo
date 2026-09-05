import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getAsset: vi.fn(), decode: vi.fn() }));
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiAsset: mocks.getAsset }));
vi.mock("../vault/vaultAsset", async (original) => {
  const actual = await original<typeof import("../vault/vaultAsset")>();
  mocks.decode.mockImplementation(actual.decodeVaultAsset); return { ...actual, decodeVaultAsset: mocks.decode };
});
import { encodeVaultAsset } from "../vault/vaultAsset";
import { PublishedWikiAssetReader, usePublishedWikiAssetReader } from "./publishedWikiAssetReader";
import type { PublishedWikiContent, PublishedWikiManifest } from "./publishedWikiTypes";
const entries = Array.from({ length: 12 }, (_, index) => ({ id: `image-${index}`, folderId: "root", title: `image-${index}.png`, path: `Public/image-${index}.png`, kind: "asset" as const }));
const manifest: PublishedWikiManifest = { wikiId: "wiki-one", revision: 1, title: "Public", updatedAt: "2026-09-05", expiresAt: null, folders: [{ id: "root", name: "Public", parentId: null, path: "Public" }], entries };
const caller = () => new AbortController();
function pngBytes() {
  const bytes = new Uint8Array(57); const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12); view.setUint32(16, 80); view.setUint32(20, 60); bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set(new TextEncoder().encode("IDAT"), 37); bytes.set(new TextEncoder().encode("IEND"), 49); return bytes;
}
const body = encodeVaultAsset(pngBytes(), "image/png");
function content(id = "image-0"): PublishedWikiContent { return { ...entries.find((entry) => entry.id === id)!, body }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => { mocks.getAsset.mockReset(); mocks.decode.mockClear(); mocks.getAsset.mockImplementation(async (_wikiId: string, id: string) => content(id)); });
describe("a public page's bounded asset reader", () => {
  it("coalesces 192 simultaneous references into one request and one decode", async () => {
    const scope = caller(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    const pending = deferred<PublishedWikiContent>(); mocks.getAsset.mockReturnValue(pending.promise);
    const reads = Array.from({ length: 6 * 32 }, () => reader.load("image-0", caller().signal));
    expect(mocks.getAsset).toHaveBeenCalledTimes(1); pending.resolve(content());
    const decoded = await Promise.all(reads); expect(decoded.every((value) => value === decoded[0])).toBe(true);
    expect(mocks.decode).toHaveBeenCalledTimes(1); expect(await reader.load("image-0", caller().signal)).toBe(decoded[0]);
    expect(mocks.getAsset).toHaveBeenCalledTimes(1); scope.abort();
  });
  it("limits distinct active requests to four and starts queued reads as slots finish", async () => {
    const scope = caller(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    const waiting = new Map<string, ReturnType<typeof deferred<PublishedWikiContent>>>();
    mocks.getAsset.mockImplementation((_wiki: string, id: string) => { const task = deferred<PublishedWikiContent>(); waiting.set(id, task); return task.promise; });
    const reads = Array.from({ length: 10 }, (_, index) => reader.load(`image-${index}`, caller().signal));
    expect(mocks.getAsset).toHaveBeenCalledTimes(4);
    waiting.get("image-0")!.resolve(content("image-0")); await reads[0]; expect(mocks.getAsset).toHaveBeenCalledTimes(5);
    for (let index = 1; index < 10; index += 1) { waiting.get(`image-${index}`)!.resolve(content(`image-${index}`)); await reads[index]; }
    expect(mocks.decode).toHaveBeenCalledTimes(10); scope.abort();
  });
  it("keeps exactly eight decoded entries with recent-use LRU eviction", async () => {
    const scope = caller(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    const first = await reader.load("image-0", caller().signal);
    for (let index = 1; index < 8; index += 1) await reader.load(`image-${index}`, caller().signal);
    expect(await reader.load("image-0", caller().signal)).toBe(first);
    await reader.load("image-8", caller().signal); expect(mocks.getAsset).toHaveBeenCalledTimes(9);
    expect(await reader.load("image-0", caller().signal)).toBe(first); expect(mocks.getAsset).toHaveBeenCalledTimes(9);
    await reader.load("image-1", caller().signal); expect(mocks.getAsset).toHaveBeenCalledTimes(10); scope.abort();
  });
  it("cancelling one pane does not cancel another pane's shared request", async () => {
    const scope = caller(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    const waiting = deferred<PublishedWikiContent>(); mocks.getAsset.mockReturnValue(waiting.promise);
    const one = caller(); const first = reader.load("image-0", one.signal); const second = reader.load("image-0", caller().signal);
    const firstResult = expect(first).rejects.toMatchObject({ name: "AbortError" }); one.abort(); await firstResult;
    expect(mocks.getAsset.mock.calls[0][3].aborted).toBe(false); waiting.resolve(content()); await second;
    expect(mocks.decode).toHaveBeenCalledTimes(1); scope.abort();
  });
  it("aborts the request when its last pane disappears and ignores a late response", async () => {
    const reader = new PublishedWikiAssetReader(manifest, caller().signal); const consumer = caller();
    const waiting = deferred<PublishedWikiContent>(); mocks.getAsset.mockReturnValueOnce(waiting.promise);
    const read = reader.load("image-0", consumer.signal); const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    consumer.abort(); await rejected; expect(mocks.getAsset.mock.calls[0][3].aborted).toBe(true);
    waiting.resolve(content()); await Promise.resolve(); expect(mocks.decode).not.toHaveBeenCalled();
    await reader.load("image-0", caller().signal); expect(mocks.getAsset).toHaveBeenCalledTimes(2); reader.dispose();
  });
  it("scope abort cancels queued and running reads, clears cache, and cannot be reused", async () => {
    const scope = caller(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    await reader.load("image-0", caller().signal);
    mocks.getAsset.mockImplementation(() => new Promise(() => undefined));
    const reads = Array.from({ length: 8 }, (_, index) => reader.load(`image-${index + 1}`, caller().signal));
    const settled = Promise.allSettled(reads); scope.abort();
    expect((await settled).every((result) => result.status === "rejected" && result.reason.name === "AbortError")).toBe(true);
    expect(mocks.getAsset.mock.calls.slice(1).every((call) => call[3].aborted)).toBe(true);
    expect(mocks.getAsset).toHaveBeenCalledTimes(5);
    await expect(reader.load("image-0", caller().signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("cannot request IDs absent from the fixed manifest or from an aborted scope", async () => {
    const scope = caller(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    await expect(reader.load("private-asset", caller().signal)).rejects.toThrow();
    await expect(reader.load("image-0", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    const ended = new PublishedWikiAssetReader(manifest, AbortSignal.abort());
    await expect(ended.load("image-0", caller().signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getAsset).not.toHaveBeenCalled(); scope.abort();
  });
  it.each(["image/svg+xml", "text/html", "image/png"])("rejects active bytes declared as %s before caching", async (mime) => {
    const reader = new PublishedWikiAssetReader(manifest, caller().signal);
    mocks.getAsset.mockResolvedValueOnce({ ...content(), body: encodeVaultAsset(Uint8Array.from(new TextEncoder().encode("<svg onload='bad()'></svg>")), mime) });
    await expect(reader.load("image-0", caller().signal)).rejects.toThrow();
    await reader.load("image-0", caller().signal); expect(mocks.getAsset).toHaveBeenCalledTimes(2); reader.dispose();
  });
  it("does not accept response metadata from a different scope even with the same ID", async () => {
    const reader = new PublishedWikiAssetReader(manifest, caller().signal);
    mocks.getAsset.mockResolvedValue({ ...content(), path: "Private/image.png" });
    await expect(reader.load("image-0", caller().signal)).rejects.toThrow(); expect(mocks.decode).not.toHaveBeenCalled(); reader.dispose();
  });
  it("captures the wiki ID and revision at construction even if its caller mutates metadata", async () => {
    const input = { ...manifest }; const reader = new PublishedWikiAssetReader(input, caller().signal);
    input.wikiId = "different-wiki"; input.revision = 9;
    await reader.load("image-0", caller().signal);
    expect(mocks.getAsset).toHaveBeenCalledWith("wiki-one", "image-0", 1, expect.any(AbortSignal)); reader.dispose();
  });
  it("never shares caches between wiki IDs, revisions, or lifetime signals", async () => {
    const scopes = [caller(), caller(), caller()];
    const readers = [new PublishedWikiAssetReader(manifest, scopes[0].signal), new PublishedWikiAssetReader({ ...manifest, revision: 2 }, scopes[1].signal), new PublishedWikiAssetReader({ ...manifest, wikiId: "wiki-two" }, scopes[2].signal)];
    const values = await Promise.all(readers.map((reader) => reader.load("image-0", caller().signal)));
    expect(new Set(values).size).toBe(3); expect(mocks.getAsset).toHaveBeenCalledTimes(3); scopes.forEach((scope) => scope.abort());
  });
  it("page hook preserves an unchanged scope and disposes on manifest replacement/unmount", async () => {
    const scope = caller(); const { result, rerender, unmount } = renderHook(({ data, signal }) => usePublishedWikiAssetReader(data, signal), { initialProps: { data: manifest, signal: scope.signal } });
    const original = result.current!; await original.load("image-0", caller().signal);
    rerender({ data: manifest, signal: scope.signal }); expect(result.current).toBe(original);
    const next = { ...manifest, entries: [] }; rerender({ data: next, signal: scope.signal });
    expect(original.signal.aborted).toBe(true); expect(result.current?.manifest).toBe(next);
    await expect(result.current!.load("image-0", caller().signal)).rejects.toThrow();
    const final = result.current!; act(unmount); expect(final.signal.aborted).toBe(true);
  });
});
