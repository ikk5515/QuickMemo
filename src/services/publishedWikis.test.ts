import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null as null | { uid: string; getIdToken: () => Promise<string> } }, getToken: vi.fn(), fetch: vi.fn() }));
vi.mock("../lib/firebase", () => ({ auth: mocks.auth, appCheck: null }));
vi.mock("firebase/app-check", () => ({ getToken: mocks.getToken }));
import { getPublishedWikiAsset, getPublishedWikiContents, getPublishedWikiManifest, getPublishedWikiOwnerStatus, publishPreparedWiki, unpublishWiki } from "./publishedWikis";
import type { PreparedWikiPublication } from "../features/wiki/publishedWikiTypes";
const wikiId = `pw1_${"a".repeat(32)}`;
const entryId = `e_${"a".repeat(32)}`;
const folderId = `f_${"b".repeat(32)}`;
const stage = { wikiId, generation: `pwg1_${"b".repeat(32)}`, expectedRevision: 0 };
const status = { wikiId, revision: 1, published: true, title: "Guide", expiresAt: null, updatedAt: "2026-09-05T00:00:00Z", noteCount: 1, assetCount: 0 };
const entry = { id: entryId, folderId, title: "Start", path: "Guide/Start.md", kind: "markdown" };
const manifest = { wikiId, revision: 1, title: "Guide", expiresAt: null, updatedAt: "2026-09-05T00:00:00Z", folders: [{ id: folderId, parentId: null, name: "Guide", path: "Guide" }], entries: [entry] };
const prepared: PreparedWikiPublication = { manifest: { rootFolderId: "root", title: "Guide", expiresAt: null, folders: [{ sourceFolderId: "root", parentSourceFolderId: null, name: "Guide" }], entries: [{ sourceNoteId: "note", sourceFolderId: "root", sourceRevision: 1, title: "Start", kind: "markdown" }] }, contents: [{ sourceNoteId: "note", body: "# Hello" }], omittedEntryCount: 0, redactedLinkCount: 0, totalBytes: 7 };
function response(value: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }; }
function action(call: unknown[]) { return JSON.parse((call[1] as RequestInit).body as string).action; }
beforeEach(() => {
  mocks.auth.currentUser = { uid: "owner", getIdToken: vi.fn(async () => "fixture-id-token") };
  mocks.fetch.mockReset(); vi.stubGlobal("fetch", mocks.fetch);
});
describe("published wiki client authority and bounded requests", () => {
  it("reads public manifests without Firebase login, cookies, or durable cache and strips unknown fields", async () => {
    mocks.auth.currentUser = null; mocks.fetch.mockResolvedValue(response({ ...manifest, ownerUid: "must-not-propagate" }));
    expect(await getPublishedWikiManifest(wikiId)).toEqual(manifest);
    expect(mocks.fetch).toHaveBeenCalledWith(`/api/published-wikis?action=manifest&wikiId=${wikiId}`, expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store", headers: { "x-quickmemo-published-wiki": "1" } }));
  });
  it("pins owner auth before and after token awaits", async () => {
    mocks.auth.currentUser!.getIdToken = async () => { mocks.auth.currentUser = { uid: "other", getIdToken: async () => "other" }; return "old"; };
    await expect(getPublishedWikiOwnerStatus("root")).rejects.toMatchObject({ name: "AbortError" }); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects explicit mismatched sessions and pre-aborted calls before network", async () => {
    await expect(unpublishWiki("root", 1, { expectedUid: "other" })).rejects.toMatchObject({ name: "AbortError" });
    await expect(getPublishedWikiManifest(wikiId, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" }); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects late owner plaintext after logout", async () => {
    mocks.fetch.mockImplementation(async () => { mocks.auth.currentUser = null; return response(status); });
    await expect(getPublishedWikiOwnerStatus("root")).rejects.toMatchObject({ name: "AbortError" });
  });
  it("uploads staged bounded chunks before atomic activation and reports exact progress", async () => {
    const progress = vi.fn();
    mocks.fetch.mockImplementation(async (_url, request: RequestInit) => { const body = JSON.parse(request.body as string); return response(body.action === "begin" ? stage : body.action === "activate" ? status : { uploadedCount: 1 }); });
    const large = { ...prepared, contents: Array.from({ length: 10 }, (_, index) => ({ sourceNoteId: `note-${index}`, body: "가".repeat(40_000) })) };
    expect(await publishPreparedWiki(large, 0, { expectedUid: "owner", onProgress: progress })).toEqual(status);
    const calls = mocks.fetch.mock.calls; expect(action(calls[0])).toBe("begin"); expect(action(calls.at(-1)!)).toBe("activate");
    const uploads = calls.filter((call) => action(call) === "upload"); expect(uploads).toHaveLength(2);
    for (const call of uploads) expect(new TextEncoder().encode(JSON.stringify(JSON.parse(call[1].body).contents)).length).toBeLessThanOrEqual(1024 * 1024);
    expect(progress).toHaveBeenLastCalledWith(10, 10);
    for (const call of calls) expect(call[1].headers.authorization).toBe("Bearer fixture-id-token");
  });
  it("cancels staged publication and cleans up using a fresh bounded signal after UI lock", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async (_url, request: RequestInit) => {
      const body = JSON.parse(request.body as string);
      if (body.action === "begin") return response(stage);
      if (body.action === "upload") { controller.abort(); return response({ uploadedCount: 1 }); }
      return response(status);
    });
    await expect(publishPreparedWiki(prepared, 0, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch.mock.calls.map(action)).toEqual(["begin", "upload", "abort"]);
    expect(mocks.fetch.mock.calls[2][1].signal).not.toBe(controller.signal);
  });
  it("never sends cleanup or activation under a switched account", async () => {
    mocks.fetch.mockImplementation(async (_url, request: RequestInit) => {
      const body = JSON.parse(request.body as string); if (body.action === "begin") return response(stage);
      mocks.auth.currentUser = { uid: "other", getIdToken: async () => "other" }; return response({ uploadedCount: 1 });
    });
    await expect(publishPreparedWiki(prepared, 0)).rejects.toMatchObject({ name: "AbortError" }); expect(mocks.fetch.mock.calls.map(action)).toEqual(["begin", "upload"]);
  });
  it("stops activation on upload rejection, preserves API code and presents Korean guidance", async () => {
    mocks.fetch.mockImplementation(async (_url, request: RequestInit) => { const body = JSON.parse(request.body as string); return body.action === "begin" ? response(stage) : body.action === "abort" ? response(status) : response({ error: "source_changed" }, 409); });
    await expect(publishPreparedWiki(prepared, 0)).rejects.toMatchObject({ code: "source_changed", status: 409, message: "메모가 변경되었습니다. 내용을 다시 확인해 주세요." });
    expect(mocks.fetch.mock.calls.map(action)).toEqual(["begin", "upload", "abort"]);
  });
  it("refuses oversized single chunks before exposing any publication", async () => {
    await expect(publishPreparedWiki({ ...prepared, contents: [{ sourceNoteId: "note", body: "x".repeat(1024 * 1024) }] }, 0)).rejects.toMatchObject({ code: "publication_too_large" }); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong revision", { revision: 2, entries: [{ ...entry, body: "private" }] }],
    ["wrong public ID", { revision: 1, entries: [{ ...entry, id: `e_${"b".repeat(32)}`, body: "wrong" }] }],
    ["wrong content kind", { revision: 1, entries: [{ ...entry, kind: "asset", body: "unsafe" }] }],
    ["oversized body", { revision: 1, entries: [{ ...entry, body: "x".repeat(128 * 1024 + 1) }] }]
  ])("rejects %s in public content responses", async (_label, payload) => { mocks.fetch.mockResolvedValue(response(payload)); await expect(getPublishedWikiContents(wikiId, [entryId], 1)).rejects.toThrow(); });
  it("requests asset bodies separately with the current revision", async () => {
    mocks.fetch.mockResolvedValue(response({ revision: 1, entries: [{ ...entry, kind: "asset", body: "{}" }] }));
    expect(await getPublishedWikiAsset(wikiId, entryId, 1)).toMatchObject({ kind: "asset", body: "{}" });
    expect(mocks.fetch.mock.calls[0][0]).toContain("action=asset");
  });
  it("rejects too many or duplicate content IDs without network", async () => {
    await expect(getPublishedWikiContents(wikiId, Array(9).fill(entryId), 1)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(getPublishedWikiContents(wikiId, [entryId, entryId], 1)).rejects.toMatchObject({ code: "invalid_request" }); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed manifest identity and missing parent folders", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ ...manifest, wikiId: `pw1_${"b".repeat(32)}` })).mockResolvedValueOnce(response({ ...manifest, folders: [] }));
    await expect(getPublishedWikiManifest(wikiId)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(getPublishedWikiManifest(wikiId)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
