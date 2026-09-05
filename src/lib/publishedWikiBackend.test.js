// @vitest-environment node
/* global structuredClone, URL */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildVaultFolderTree } from "../../api/_vault-folder-tree.js";
const state = vi.hoisted(() => ({ docs: new Map(), reads: [], queries: [], writes: [], time: 0 }));
vi.mock("../../api/_secure-share-common.js", async (importOriginal) => {
  const actual = await importOriginal();
  const read = (paths) => paths.map((path) => { state.reads.push(path); return structuredClone(state.docs.get(path) ?? null); });
  return { ...actual,
    createFirestoreContext: vi.fn(async () => ({ projectId: "demo-published-wiki", accessToken: "fixture" })),
    verifySecureShareAppCheck: vi.fn(async () => ({ enforced: false, valid: null })),
    activeUserFromRequest: vi.fn(async (request) => { if (request.headers.authorization !== "Bearer owner") throw new actual.HttpError(401, "unauthorized"); return { uid: "owner" }; }),
    rateLimitBucketDigest: (type, parts) => actual.sha256Digest(`${type}:${parts.join(":")}`),
    clientNetworkDigest: () => "fixture-network",
    firestoreGet: vi.fn(async (_context, path) => read([path])[0]),
    firestoreBatchGet: vi.fn(async (_context, paths) => { if (!paths.length || paths.length > 100) throw Error("unbounded read"); return read(paths); }),
    firestoreBatchGetNewTransaction: vi.fn(async (_context, paths) => ({ documents: read(paths), transaction: "transaction" })),
    firestoreRollback: vi.fn(async () => undefined),
    firestoreRunQuery: vi.fn(async (_context, query, parent = "") => {
      state.queries.push({ query, parent });
      const collection = query.from[0].collectionId;
      const prefix = parent ? `${parent}/${collection}/` : `${collection}/`;
      let values = [...state.docs.entries()].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
      if (query.where?.fieldFilter.op === "IN") {
        const allowed = new Set(query.where.fieldFilter.value.arrayValue.values.map((value) => value.referenceValue.split("/documents/")[1]));
        values = values.filter(([path]) => allowed.has(path));
      } else if (query.where?.fieldFilter.op === "EQUAL") {
        values = values.filter(([, value]) => value[query.where.fieldFilter.field.fieldPath] === query.where.fieldFilter.value.stringValue);
      } else if (query.where?.fieldFilter.field.fieldPath === "cleanupAt") {
        values = values.filter(([, value]) => value.cleanupAt && new Date(value.cleanupAt).getTime() <= Date.now());
      }
      return values.slice(0, query.limit).map(([, value]) => {
        const projected = { __id: value.__id, __updateTime: value.__updateTime };
        for (const { fieldPath } of query.select.fields) {
          if (fieldPath in value) projected[fieldPath] = value[fieldPath];
          if (fieldPath === "active.title" && value.active) projected.active = { title: value.active.title };
        }
        return structuredClone(projected);
      });
    }),
    firestoreCommit: vi.fn(async (_context, writes) => {
      if (writes.length > 500) throw Error("write limit");
      state.writes.push(writes);
      for (const write of writes) {
        if (write.delete) continue;
        const path = write.update.name.split("/documents/")[1];
        if ((write.currentDocument?.exists === false && state.docs.has(path))
          || (write.currentDocument?.updateTime && write.currentDocument.updateTime !== state.docs.get(path)?.__updateTime)) {
          throw Object.assign(new Error("precondition conflict"), { name: "UpstreamError",
            statusCode: write.currentDocument?.exists === false ? 409 : 400,
            upstreamCode: write.currentDocument?.exists === false ? "ALREADY_EXISTS" : "FAILED_PRECONDITION" });
        }
      }
      for (const write of writes) {
        if (write.delete) { state.docs.delete(write.delete.split("/documents/")[1]); continue; }
        const path = write.update.name.split("/documents/")[1];
        const fields = actual.fromFirestoreFields(write.update.fields);
        expect(Object.keys(fields).some((key) => key.startsWith("__"))).toBe(false);
        state.docs.set(path, { ...fields, __id: path.split("/").pop(), __name: write.update.name, __updateTime: `time-${++state.time}` });
      }
    })
  };
});
import { firestoreBatchGetNewTransaction, firestoreCommit, firestoreRollback } from "../../api/_secure-share-common.js";
import handler, { __publishedWikiTesting as api, cleanupExpiredPublishedWikis } from "../../api/published-wikis.js";
const context = { projectId: "demo-published-wiki", accessToken: "fixture" };
const uid = "owner";
function put(path, fields) { state.docs.set(path, { ...fields, __id: path.split("/").pop(), __name: path, __updateTime: `time-${++state.time}` }); }
function change(path, fields) { put(path, { ...state.docs.get(path), ...fields }); }
function rebuildTree() {
  const folders = [...state.docs.entries()].filter(([path]) => path.startsWith("noteFolders/")).map(([, value]) => value);
  put(`vaultFolderTrees/${uid}`, { ...buildVaultFolderTree(folders), ownerUid: uid });
}
function manifest() {
  return { rootFolderId: "selected", title: "Published guide", expiresAt: null,
    folders: [{ sourceFolderId: "selected", parentSourceFolderId: null, name: "Guide" }, { sourceFolderId: "child", parentSourceFolderId: "selected", name: "Chapter" }],
    entries: [ { sourceNoteId: "note-a", sourceFolderId: "selected", sourceRevision: 1, title: "Start", kind: "markdown" },
      { sourceNoteId: "note-b", sourceFolderId: "child", sourceRevision: 2, title: "Details", kind: "markdown" },
      { sourceNoteId: "asset-c", sourceFolderId: "child", sourceRevision: 1, title: "image.png", kind: "asset" } ] };
}
async function stage(input = manifest(), expectedRevision = 0) { return api.ownerAction(context, uid, { action: "begin", manifest: input, expectedRevision }); }
async function publish(input = manifest(), expectedRevision = 0) {
  const staging = await stage(input, expectedRevision);
  if (input.entries.length) await api.ownerAction(context, uid, { action: "upload", ...staging, contents: input.entries.map((entry) => ({ sourceNoteId: entry.sourceNoteId, body: `published:${entry.sourceNoteId}` })) });
  return api.ownerAction(context, uid, { action: "activate", ...staging });
}
async function read(status, action = "manifest", ids = [], revision = null) { return api.publicAction(context, action, status.wikiId, ids, revision); }
beforeEach(() => {
  state.docs.clear(); state.reads.length = 0; state.queries.length = 0; state.writes.length = 0;
  put(`users/${uid}`, { isActive: true, featureAccess: { notes: true } });
  for (const [id, parentId] of [["private-ancestor", null], ["selected", "private-ancestor"], ["child", "selected"], ["outside", null]]) put(`noteFolders/${id}`, { ownerUid: uid, parentId, isDeleted: false, encryptedName: {}, wrappedKey: {} });
  rebuildTree();
  // Existing schema-1 empty publication fixture: new folder-based creation is now forbidden.
  const legacyId = `pw1_${"l".repeat(32)}`;
  put(api.rootPath(uid, "selected"), { ownerUid: uid, rootFolderId: "selected", wikiId: legacyId });
  put(`publishedWikis/${legacyId}`, { schemaVersion: 1, wikiId: legacyId, ownerUid: uid, rootFolderId: "selected", revision: 0, published: false, active: null, pending: null, updatedAt: null });
  for (const entry of manifest().entries) put(`notes/${entry.sourceNoteId}`, { ownerUid: uid, type: "personal", participantUids: [uid], folderId: entry.sourceFolderId, revision: entry.sourceRevision,
    contentFormat: entry.kind === "asset" ? "asset-v1" : "markdown-v1", entryKind: entry.kind, encryptedBody: { cipherText: "private encrypted original" } });
});
describe("published wiki isolated copies and authority", () => {
  it("keeps staged copies invisible, activates atomically and returns only public identities/root-relative paths", async () => {
    const staging = await stage();
    await expect(read(staging)).rejects.toMatchObject({ statusCode: 404 });
    await expect(api.ownerAction(context, uid, { action: "activate", ...staging })).rejects.toMatchObject({ code: "publication_incomplete" });
    await api.ownerAction(context, uid, { action: "upload", ...staging, contents: manifest().entries.map((entry) => ({ sourceNoteId: entry.sourceNoteId, body: "snapshot" })) });
    const status = await api.ownerAction(context, uid, { action: "activate", ...staging });
    const result = await read(status);
    expect(result.entries.map((entry) => entry.path)).toEqual(["Guide/Start.md", "Guide/Chapter/Details.md", "Guide/Chapter/image.png"]);
    expect(result.folders[0]).toMatchObject({ parentId: null, path: "Guide", name: "Guide" });
    const serialized = JSON.stringify(result);
    for (const secret of ["note-a", "note-b", "asset-c", "private-ancestor", "ownerUid", "sourceNoteId", "encryptedBody", "wrappedKey", "snapshot"]) expect(serialized).not.toContain(secret);
    expect(state.docs.get("notes/note-a").encryptedBody.cipherText).toBe("private encrypted original");
    const projectedSourceQueries = state.queries.filter(({ query }) => ["notes", "noteFolders"].includes(query.from[0].collectionId));
    expect(projectedSourceQueries.every(({ query }) => query.select.fields.every(({ fieldPath }) => !["encryptedBody", "encryptedTitle", "wrappedKey"].includes(fieldPath)))).toBe(true);
  });
  it("reads only requested copied bodies and only their ancestor folders", async () => {
    const status = await publish(); state.reads.length = 0; state.queries.length = 0;
    const id = api.entryId(status.wikiId, "note-a");
    const result = await read(status, "content", [id], 1);
    expect(result.entries).toHaveLength(1); expect(result.entries[0].body).toBe("published:note-a");
    expect(state.reads.filter((path) => path.includes("/entries/"))).toHaveLength(1);
    const folderQuery = state.queries.find(({ query }) => query.from[0].collectionId === "noteFolders").query;
    expect(folderQuery.where.fieldFilter.value.arrayValue.values).toHaveLength(1);
    expect(state.reads).not.toContain("notes/note-a");
  });
  it("keeps source body/revision edits private until explicit update, with stable URL and revision", async () => {
    const first = await publish(); change("notes/note-a", { revision: 3, encryptedBody: { cipherText: "changed private" } });
    expect((await read(first, "content", [api.entryId(first.wikiId, "note-a")], 1)).entries[0].body).toBe("published:note-a");
    const next = manifest(); next.entries[0].sourceRevision = 3;
    const second = await publish(next, 1); expect(second.wikiId).toBe(first.wikiId); expect(second.revision).toBe(2);
    await expect(read(first, "content", [api.entryId(first.wikiId, "note-a")], 1)).rejects.toMatchObject({ code: "publication_changed" });
  });
  it.each([
    ["inactive owner", () => change("users/owner", { isActive: false })],
    ["notes access removed", () => change("users/owner", { featureAccess: { notes: false } })],
    ["root deleted", () => { change("noteFolders/selected", { isDeleted: true }); rebuildTree(); }],
    ["private ancestor deleted", () => { change("noteFolders/private-ancestor", { isDeleted: true }); rebuildTree(); }],
    ["root owner changed", () => change("noteFolders/selected", { ownerUid: "other" })],
    ["missing tree", () => state.docs.delete("vaultFolderTrees/owner")]
  ])("fails closed on %s", async (_label, mutate) => { const status = await publish(); mutate(); await expect(read(status)).rejects.toThrow(); });
  it.each([
    ["note outside", () => change("notes/note-b", { folderId: "outside" })],
    ["note deleted", () => change("notes/note-b", { isDeleted: true })],
    ["note purged", () => change("notes/note-b", { isPurged: true })],
    ["note owner changed", () => change("notes/note-b", { ownerUid: "other" })],
    ["owner participant removed", () => change("notes/note-b", { participantUids: ["other"] })],
    ["malformed participant string", () => change("notes/note-b", { participantUids: "owner" })],
    ["wrong format", () => change("notes/note-b", { contentFormat: "canvas-v1", entryKind: "canvas" })],
    ["child moved outside", () => { change("noteFolders/child", { parentId: "outside" }); rebuildTree(); }]
  ])("removes public entries immediately after %s and denies direct body reads", async (_label, mutate) => {
    const status = await publish(); mutate();
    expect((await read(status)).entries.map((entry) => entry.id)).not.toContain(api.entryId(status.wikiId, "note-b"));
    await expect(read(status, "content", [api.entryId(status.wikiId, "note-b")], 1)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("accepts existing unversioned legacy sources as revision zero without changing their originals", async () => {
    change("notes/note-a", { contentFormat: undefined, entryKind: undefined, revision: undefined });
    const input = manifest(); input.entries[0].kind = "legacy-html"; input.entries[0].sourceRevision = 0;
    const status = await publish(input);
    const result = await read(status, "content", [api.entryId(status.wikiId, "note-a")], 1);
    expect(result.entries[0].kind).toBe("legacy-html"); expect(state.docs.get("notes/note-a").revision).toBeUndefined();
  });
  it("requires source revision again at upload and activation", async () => {
    const staging = await stage(); change("notes/note-a", { revision: 5 });
    await expect(api.ownerAction(context, uid, { action: "upload", ...staging, contents: [{ sourceNoteId: "note-a", body: "stale" }] })).rejects.toMatchObject({ code: "source_changed" });
    await expect(api.ownerAction(context, uid, { action: "activate", ...staging })).rejects.toMatchObject({ code: "source_changed" });
  });
  it("rejects foreign ownership, fake parent chains, and stale publication writes", async () => {
    const status = await publish();
    await expect(api.ownerAction(context, "other", { action: "activate", wikiId: status.wikiId, generation: `pwg1_${"a".repeat(32)}`, expectedRevision: 1 })).rejects.toMatchObject({ statusCode: 404 });
    const fake = manifest(); fake.folders[1].parentSourceFolderId = "child";
    await expect(stage(fake, 1)).rejects.toMatchObject({ code: "source_changed" });
    await expect(stage(manifest(), 0)).rejects.toMatchObject({ code: "publication_changed" });
  });
  it("allows owner status and unpublish after root deletion, revokes before future reads", async () => {
    const status = await publish(); state.docs.delete("noteFolders/selected");
    expect(await api.ownerAction(context, uid, { action: "status", rootFolderId: "selected" })).toMatchObject({ published: true });
    const stopped = await api.ownerAction(context, uid, { action: "unpublish", rootFolderId: "selected", expectedRevision: 1 });
    expect(stopped).toMatchObject({ published: false, revision: 2 }); await expect(read(status)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("isolates asset bodies from note requests and denies unknown public IDs", async () => {
    const status = await publish(); const assetId = api.entryId(status.wikiId, "asset-c");
    await expect(read(status, "content", [assetId], 1)).rejects.toThrow();
    expect((await read(status, "asset", [assetId], 1)).entries[0].kind).toBe("asset");
    await expect(read(status, "content", [`e_${"0".repeat(32)}`], 1)).rejects.toThrow();
  });
});
describe("publication resource limits and cleanup", () => {
  it("rejects oversized/unsafe manifests and oversized copy uploads", async () => {
    const oversized = manifest(); oversized.entries = Array.from({ length: 201 }, (_, i) => ({ ...oversized.entries[0], sourceNoteId: `note-${i}` }));
    expect(() => api.assertManifest(oversized)).toThrow();
    for (const title of ["../secret", "a\\b", "x\u0000", "a".repeat(513)]) expect(() => api.assertManifest({ ...manifest(), title })).toThrow();
    const staging = await stage();
    await expect(api.ownerAction(context, uid, { action: "upload", ...staging, contents: [{ sourceNoteId: "note-a", body: "x".repeat(128 * 1024 + 1) }] })).rejects.toMatchObject({ statusCode: 413 });
  });
  it("reclaims expired staging while keeping active snapshot copies", async () => {
    const status = await publish(); const staging = await stage(manifest(), 1);
    await api.ownerAction(context, uid, { action: "upload", ...staging, contents: [{ sourceNoteId: "note-a", body: "unpublished" }] });
    const path = `publishedWikis/${status.wikiId}`; const site = state.docs.get(path);
    change(path, { pending: { ...site.pending, deadline: new Date(Date.now() - 1000).toISOString() }, cleanupAt: new Date(Date.now() - 1000) });
    expect(await cleanupExpiredPublishedWikis(context, Date.now() + 5000)).toBe(1);
    expect(state.docs.get(path).pending).toBeNull(); expect((await read(status)).entries).toHaveLength(3);
    expect([...state.docs.values()].some((row) => row.body === "unpublished")).toBe(false);
  });
  it("expires public reads immediately and removes expired published copies in the existing cron", async () => {
    const status = await publish({ ...manifest(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const path = `publishedWikis/${status.wikiId}`; const site = state.docs.get(path);
    change(path, { active: { ...site.active, expiresAt: new Date(Date.now() - 1000).toISOString() }, cleanupAt: new Date(Date.now() - 1000) });
    await expect(read(status)).rejects.toThrow(); expect(await cleanupExpiredPublishedWikis(context, Date.now() + 5000)).toBe(3);
    expect(state.docs.get(path)).toMatchObject({ published: false, active: null, revision: 2 });
  });
});

function requestResponse(method, url, headers = {}, body) {
  const request = { method, url, body, headers: { host: "localhost:4174", "x-quickmemo-published-wiki": "1", "sec-fetch-site": "same-origin", ...headers } };
  const response = { statusCode: 0, headers: {}, body: "", setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
  return { request, response };
}
describe("public API transport and release boundaries", () => {
  it("accepts a real same-origin GET without Origin and emits no-store hardened JSON", async () => {
    const status = await publish();
    const pair = requestResponse("GET", `/api/published-wikis?action=manifest&wikiId=${status.wikiId}`);
    await handler(pair.request, pair.response);
    expect(pair.response.statusCode).toBe(200);
    expect(JSON.parse(pair.response.body).entries).toHaveLength(3);
    expect(pair.response.headers).toMatchObject({ "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "x-robots-tag": "noindex, nofollow, noarchive" });
    expect(pair.response.headers["content-security-policy"]).toContain("default-src 'none'");
  });
  it.each([
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    ["missing fetch metadata", { "sec-fetch-site": "" }],
    ["missing marker", { "x-quickmemo-published-wiki": "" }],
    ["foreign explicit origin", { origin: "https://foreign.invalid" }]
  ])("denies %s before reading private source state", async (_label, headers) => {
    const pair = requestResponse("GET", `/api/published-wikis?action=manifest&wikiId=pw1_${"a".repeat(32)}`, headers);
    await handler(pair.request, pair.response); expect(pair.response.statusCode).toBe(403); expect(state.reads).toHaveLength(0);
  });
  it("preserves authenticated same-origin POST requirement for every owner action", async () => {
    for (const headers of [{ origin: "http://localhost:4174" }, { authorization: "Bearer owner" }]) {
      const pair = requestResponse("POST", "/api/published-wikis", { "content-type": "application/json", ...headers }, { action: "status", rootFolderId: "selected" });
      await handler(pair.request, pair.response); expect([401, 403]).toContain(pair.response.statusCode);
    }
    const pair = requestResponse("POST", "/api/published-wikis", { "content-type": "application/json", origin: "http://localhost:4174", authorization: "Bearer owner" }, { action: "status", rootFolderId: "selected" });
    await handler(pair.request, pair.response); expect(pair.response.statusCode).toBe(200);
  });
  it("rate limits repeated public requests with retry guidance and existing cleanup-compatible buckets", async () => {
    await api.consumeLimit(context, "limited", 2); await api.consumeLimit(context, "limited", 2);
    await expect(api.consumeLimit(context, "limited", 2)).rejects.toMatchObject({ statusCode: 429, retryAfter: 60 });
    expect([...state.docs.entries()].filter(([path]) => path.startsWith("publicShareRateLimits/"))).toHaveLength(1);
  });
  it("keeps public copies denied to direct Firestore clients and uses existing API routing/no-store and cron", () => {
    const rules = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
    expect(rules).not.toContain("match /publishedWikis/"); expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/u);
    const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
    expect(vercel.headers.find((entry) => entry.source === "/api/(.*)").headers).toContainEqual({ key: "Cache-Control", value: "no-store, private" });
    expect(vercel.crons).toEqual([{ path: "/api/cleanup-public-shares", schedule: "0 3 * * *" }]);
    const server = readFileSync(new URL("../../tests/e2e/server.mjs", import.meta.url), "utf8"); expect(server).toContain("/api/published-wikis");
  });
});

describe("published wiki optimistic counter contention", () => {
  it("rechecks concurrent counts using preconditions without a read/write transaction lock", async () => {
    await api.consumeLimit(context, "contended", 3);
    const path = [...state.docs.keys()].find((key) => key.startsWith("publicShareRateLimits/"));
    const original = firestoreCommit.getMockImplementation();
    const transactionsBefore = firestoreBatchGetNewTransaction.mock.calls.length;
    firestoreCommit.mockImplementationOnce(async (...args) => { change(path, { count: 2 }); return original(...args); });
    await api.consumeLimit(context, "contended", 3);
    expect(state.docs.get(path).count).toBe(3);
    expect(firestoreBatchGetNewTransaction.mock.calls.length).toBe(transactionsBefore);
    await expect(api.consumeLimit(context, "contended", 3)).rejects.toMatchObject({ statusCode: 429 });
    expect(state.docs.get(path).count).toBe(3);
  });
  it("does not exceed the maximum when a concurrent request consumes the last slot", async () => {
    await api.consumeLimit(context, "last-slot", 2);
    const path = [...state.docs.keys()].find((key) => key.startsWith("publicShareRateLimits/"));
    const original = firestoreCommit.getMockImplementation();
    firestoreCommit.mockImplementationOnce(async (...args) => { change(path, { count: 2 }); return original(...args); });
    await expect(api.consumeLimit(context, "last-slot", 2)).rejects.toMatchObject({ statusCode: 429 });
    expect(state.docs.get(path).count).toBe(2);
  });
  it("retries the Firestore REST 400 FAILED_PRECONDITION response and revalidates the latest counter", async () => {
    const start = firestoreCommit.mock.calls.length;
    firestoreCommit.mockRejectedValueOnce(Object.assign(new Error("stored version does not match required base version"), { name: "UpstreamError", statusCode: 400, upstreamCode: "FAILED_PRECONDITION" }));
    await api.consumeLimit(context, "rest-precondition", 1);
    expect(firestoreCommit.mock.calls.length - start).toBe(2);
    await expect(api.consumeLimit(context, "rest-precondition", 1)).rejects.toMatchObject({ statusCode: 429 });
  });
  it("does not retry an ordinary HTTP 400 or treat it as a successful counter write", async () => {
    const start = firestoreCommit.mock.calls.length;
    firestoreCommit.mockRejectedValueOnce(Object.assign(new Error("invalid query"), { name: "UpstreamError", statusCode: 400, upstreamCode: "INVALID_ARGUMENT" }));
    await expect(api.consumeLimit(context, "bad-request", 1)).rejects.toMatchObject({ statusCode: 400, upstreamCode: "INVALID_ARGUMENT" });
    expect(firestoreCommit.mock.calls.length - start).toBe(1);
    expect([...state.docs.keys()].some((path) => path.startsWith("publicShareRateLimits/"))).toBe(false);
  });
  it("retries transaction initialization conflicts before source authorization begins", async () => {
    const before = firestoreRollback.mock.calls.length;
    firestoreBatchGetNewTransaction.mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { name: "UpstreamError", statusCode: 409, upstreamCode: "ABORTED" }));
    const staged = await stage(); expect(staged.wikiId).toMatch(/^pw1_/u);
    expect(firestoreRollback.mock.calls.length).toBe(before);
  });
  it("fails closed after bounded counter conflict retries", async () => {
    const start = firestoreCommit.mock.calls.length;
    for (let count = 0; count < 4; count += 1) firestoreCommit.mockRejectedValueOnce(Object.assign(new Error("conflict"), { name: "UpstreamError", statusCode: 412 }));
    await expect(api.consumeLimit(context, "bounded", 3)).rejects.toMatchObject({ statusCode: 503, retryAfter: 1 });
    expect(firestoreCommit.mock.calls.length - start).toBe(4);
    expect([...state.docs.keys()].some((path) => path.startsWith("publicShareRateLimits/"))).toBe(false);
  });
});

describe("one owner workspace and globally unique public slugs", () => {
  const claim = (slug, expectedRevision = 0, owner = uid, extra = {}) => api.ownerAction(context, owner, { action: "set-slug", slug, expectedRevision, ...extra });
  function workspace() {
    const legacy = manifest();
    return { ...legacy, rootFolderId: null, selection: { folderIds: ["selected"], noteIds: [] },
      entries: legacy.entries.map((entry) => ({ ...entry, parentSourceFolderId: entry.sourceFolderId })) };
  }
  it.each(["a", "ab", "a".repeat(41), "admin", "PUBLIC", "schedule", "../ingi", "a/b", "a?b", "a#b", "a%b", "a b", "a\u0000b", "\ud800bad", "ｉｎｇｉ", "한글", "-ingi", "ingi-"])("rejects malformed/reserved slug %s on the server", async (slug) => {
    await expect(claim(slug)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("normalizes spacing/ASCII case, creates an empty owner root and never creates another root for a folder", async () => {
    const status = await claim("  InGi  "); expect(status).toMatchObject({ slug: "ingi", published: false, revision: 1 });
    expect(state.docs.get(api.ownerPath(uid)).wikiId).toBe(status.wikiId);
    const first = await publish(workspace(), 1); expect(first.wikiId).toBe(status.wikiId);
    const next = workspace(); next.selection.folderIds.push("outside"); next.folders.push({ sourceFolderId: "outside", parentSourceFolderId: null, name: "Linux" });
    const second = await publish(next, 2); expect(second.wikiId).toBe(status.wikiId);
    const result = await api.publicAction(context, "manifest", "ingi", [], null);
    expect(result.slug).toBe("ingi"); expect(result.folders.map((folder) => folder.path)).toContain("Linux");
    expect([...state.docs.keys()].filter((path) => /^publishedWikiOwners\/[^/]+$/u.test(path))).toHaveLength(1);
    expect(state.docs.has(api.rootPath(uid, "outside"))).toBe(false);
  });
  it("allows only one winner when two users concurrently claim the same slug", async () => {
    put("users/other", { isActive: true, featureAccess: { notes: true } });
    const results = await Promise.allSettled([claim("ingi"), claim("ingi", 0, "other")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ code: "slug_taken", statusCode: 409 });
    expect([...state.docs.keys()].filter((path) => path.startsWith("publishedWikiOwners/"))).toHaveLength(1);
  });
  it("cannot register two independent roots concurrently for one owner", async () => {
    const results = await Promise.allSettled([claim("ingi"), claim("ingi-tech")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([...state.docs.keys()].filter((path) => path.startsWith("publishedWikiOwners/"))).toHaveLength(1);
    expect([...state.docs.keys()].filter((path) => path.startsWith("publishedWikiSlugs/"))).toHaveLength(1);
  });
  it("renames atomically, invalidates old URL and in-flight stages, reserves tombstones against impersonation", async () => {
    await claim("ingi"); const first = await publish(workspace(), 1); const pending = await stage(workspace(), 2);
    const renamed = await claim("ingi-tech", 2); expect(renamed).toMatchObject({ wikiId: first.wikiId, revision: 3 });
    await expect(api.publicAction(context, "manifest", "ingi", [], null)).rejects.toMatchObject({ statusCode: 404 });
    expect((await api.publicAction(context, "manifest", "ingi-tech", [], null)).wikiId).toBe(first.wikiId);
    await expect(api.ownerAction(context, uid, { action: "activate", ...pending })).rejects.toMatchObject({ code: "publication_changed" });
    put("users/other", { isActive: true }); await expect(claim("ingi", 0, "other")).rejects.toMatchObject({ code: "slug_taken" });
    expect(await api.ownerAction(context, uid, { action: "slug-availability", slug: "ingi" })).toEqual({ slug: "ingi", available: true });
    expect((await claim("ingi", 3)).wikiId).toBe(first.wikiId);
  });
  it("migrates an owned legacy identity without replacing copies or deleting other legacy publications", async () => {
    const old = await publish(); const before = (await read(old, "content", [api.entryId(old.wikiId, "note-a")], 1)).entries[0].body;
    const result = await claim("ingi", 1, uid, { legacyWikiId: old.wikiId });
    expect(result.wikiId).toBe(old.wikiId); expect(result.published).toBe(true);
    expect((await read(result, "content", [api.entryId(old.wikiId, "note-a")], 2)).entries[0].body).toBe(before);
    expect((await api.publicAction(context, "manifest", "ingi", [], null)).slug).toBe("ingi");
    put("users/other", { isActive: true });
    await expect(claim("stolen", 2, "other", { legacyWikiId: old.wikiId })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("exposes only bounded owner metadata and rejects unapproved root-folder creation", async () => {
    const old = await publish();
    const status = await api.ownerAction(context, uid, { action: "owner-status" });
    expect(status.legacyPublications).toEqual([{ wikiId: old.wikiId, rootFolderId: "selected", title: "Published guide", revision: 1, published: true }]);
    expect(JSON.stringify(status)).not.toContain("encryptedBody"); expect(JSON.stringify(status)).not.toContain("published:note-a");
    state.docs.delete(api.rootPath(uid, "selected"));
    await expect(stage()).rejects.toMatchObject({ code: "slug_required" });
  });
  it("publishes individually selected root notes without exposing their private parent names and denies private sibling IDs", async () => {
    await claim("ingi");
    const original = manifest().entries[0];
    const input = { ...workspace(), selection: { folderIds: [], noteIds: [original.sourceNoteId] }, folders: [], entries: [{ ...original, parentSourceFolderId: null }] };
    const status = await publish(input, 1); const result = await api.publicAction(context, "manifest", "ingi", [], null);
    expect(result.folders).toEqual([]); expect(result.entries[0]).toMatchObject({ folderId: null, path: "Start.md" });
    expect(JSON.stringify(result)).not.toContain("selected");
    await expect(read(status, "content", [api.entryId(status.wikiId, "note-b")], 2)).rejects.toMatchObject({ statusCode: 404 });
    change("notes/note-a", { folderId: "outside" });
    expect((await api.publicAction(context, "manifest", "ingi", [], null)).entries).toHaveLength(0);
  });
  it("keeps unfiled selected notes readable while excluding a deleted selected folder subtree", async () => {
    await claim("ingi"); put("notes/unfiled", { ownerUid: uid, type: "personal", participantUids: [uid], folderId: null, revision: 1, contentFormat: "markdown-v1" });
    const input = workspace(); input.selection.noteIds.push("unfiled"); input.entries.push({ sourceNoteId: "unfiled", sourceFolderId: null, parentSourceFolderId: null, sourceRevision: 1, kind: "markdown", title: "Root note" });
    const status = await publish(input, 1); change("noteFolders/selected", { isDeleted: true }); rebuildTree();
    expect((await read(status)).entries.map((entry) => entry.title)).toEqual(["Root note"]);
    change("users/owner", { isActive: false }); await expect(read(status)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("rejects forged placements, outside grants, foreign notes and stale source revisions", async () => {
    await claim("ingi");
    const input = workspace(); input.entries[0].parentSourceFolderId = null;
    await expect(stage(input, 1)).rejects.toMatchObject({ code: "publication_scope_denied" });
    const foreign = workspace(); change("notes/note-a", { ownerUid: "other" });
    await expect(stage(foreign, 1)).rejects.toMatchObject({ code: "source_changed" });
  });
});
