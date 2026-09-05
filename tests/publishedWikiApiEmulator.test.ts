import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiHeaders, clearSecureShareEmulators, configureSecureShareApiEmulatorEnvironment, createEmulatorOwner,
  listEmulatorCollection, readEmulatorDocument, type SecureShareApiHarness, writeEmulatorDocuments
} from "./helpers/secureShareApiEmulator.js";

const describeEmulator = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST ? describe : describe.skip;
type Owner = Awaited<ReturnType<typeof createEmulatorOwner>>;
type Reply = { body: Record<string, unknown>; response: Response };

describeEmulator("Published wiki fixed root, slug CAS and public authority", () => {
  let harness: SecureShareApiHarness;
  let owner: Owner;
  let other: Owner;
  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    const moduleUrl = new URL("../api/published-wikis.js", import.meta.url);
    moduleUrl.searchParams.set("integration-instance", String(Date.now()));
    const module = await import(/* @vite-ignore */ moduleUrl.href);
    const server = createServer((request, response) => { void module.default(request, response); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    harness = { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
  });
  beforeEach(async () => {
    await clearSecureShareEmulators();
    owner = await createEmulatorOwner("wiki-owner@example.test", "emulator-test-password");
    other = await createEmulatorOwner("wiki-other@example.test", "emulator-test-password");
    await writeEmulatorDocuments([owner, other].map((account) => ({ path: `users/${account.localId}`, fields: { uid: account.localId, isActive: true, isAdmin: false, featureAccess: { notes: true } } })));
  });
  afterAll(async () => harness?.close());
  async function post(body: Record<string, unknown>, token = owner.idToken): Promise<Reply> {
    const response = await fetch(`${harness.origin}/api/published-wikis`, { method: "POST", headers: {
      ...apiHeaders(harness.origin, { authorization: token }), "x-quickmemo-published-wiki": "1"
    }, body: JSON.stringify(body) });
    return { body: await response.json(), response };
  }
  async function get(query: Record<string, string>): Promise<Reply> {
    const response = await fetch(`${harness.origin}/api/published-wikis?${new URLSearchParams(query)}`, {
      headers: { "sec-fetch-site": "same-origin", "x-quickmemo-published-wiki": "1", "x-vercel-forwarded-for": "198.51.100.42" }
    });
    return { body: await response.json(), response };
  }
  const claim = (slug: string, expectedRevision = 0, token = owner.idToken) => post({ action: "set-slug", slug, expectedRevision }, token);
  async function publishRootNote(expectedRevision = 1) {
    await writeEmulatorDocuments([{ path: "notes/selected-note", fields: { ownerUid: owner.localId, type: "personal", participantUids: [owner.localId], folderId: null,
      revision: 1, contentFormat: "markdown-v1", entryKind: "markdown", encryptedBody: { cipherText: "private-encrypted-body" } } }]);
    const manifest = { rootFolderId: null, selection: { folderIds: [], noteIds: ["selected-note"] }, title: "Guide", expiresAt: null, folders: [],
      entries: [{ sourceNoteId: "selected-note", sourceFolderId: null, parentSourceFolderId: null, sourceRevision: 1, title: "Root note", kind: "markdown" }] };
    const begin = await post({ action: "begin", expectedRevision, manifest }); expect(begin.response.status).toBe(200);
    const upload = await post({ action: "upload", ...begin.body, contents: [{ sourceNoteId: "selected-note", body: "# Explicit public copy" }] }); expect(upload.response.status).toBe(200);
    const active = await post({ action: "activate", ...begin.body }); expect(active.response.status).toBe(200); return active;
  }
  it("arbitrates concurrent slug claims atomically across distinct authenticated owners", async () => {
    const results = await Promise.all([claim("ingi"), claim("ingi", 0, other.idToken)]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    expect(results.find(({ response }) => response.status === 409)?.body.error).toBe("slug_taken");
    expect(await listEmulatorCollection("publishedWikiOwners")).toHaveLength(1);
    expect(await listEmulatorCollection("publishedWikiSlugs")).toHaveLength(1);
    expect(await listEmulatorCollection("publishedWikis")).toHaveLength(1);
  });
  it("does not create two roots when the same owner concurrently claims different slugs", async () => {
    const results = await Promise.all([claim("ingi"), claim("ingi-tech")]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    expect(await listEmulatorCollection("publishedWikiOwners")).toHaveLength(1);
    expect(await listEmulatorCollection("publishedWikis")).toHaveLength(1);
    expect(await listEmulatorCollection("publishedWikiSlugs")).toHaveLength(1);
  });
  it("publishes under one slug, keeps encrypted originals, renames and revokes without an authenticated public reader", async () => {
    const created = await claim(" InGi "); expect(created.response.status).toBe(200); expect(created.body.slug).toBe("ingi");
    const active = await publishRootNote(); expect(active.body.wikiId).toBe(created.body.wikiId);
    const manifests = await Promise.all([get({ action: "manifest", slug: "ingi" }), get({ action: "manifest", slug: "ingi" })]);
    expect(manifests.map(({ response }) => response.status)).toEqual([200, 200]);
    const entry = (manifests[0].body.entries as Array<{ id: string; folderId: string | null }>)[0]; expect(entry.folderId).toBeNull();
    const content = await get({ action: "content", wikiId: String(active.body.wikiId), ids: entry.id, revision: "2" });
    expect(content.response.status).toBe(200); expect(JSON.stringify(content.body)).toContain("Explicit public copy");
    expect(content.response.headers.get("cache-control")).toContain("no-store");
    expect((await readEmulatorDocument("notes/selected-note"))?.encryptedBody).toEqual({ cipherText: "private-encrypted-body" });
    const renamed = await claim("ingi-tech", 2); expect(renamed.response.status).toBe(200); expect(renamed.body.wikiId).toBe(active.body.wikiId);
    expect((await get({ action: "manifest", slug: "ingi" })).response.status).toBe(404);
    expect((await get({ action: "manifest", slug: "ingi-tech" })).response.status).toBe(200);
    expect((await claim("ingi", 0, other.idToken)).body.error).toBe("slug_taken");
    const stopped = await post({ action: "unpublish", rootFolderId: null, expectedRevision: 3 }); expect(stopped.response.status).toBe(200);
    expect((await get({ action: "manifest", slug: "ingi-tech" })).response.status).toBe(404);
    expect(await listEmulatorCollection("publishedWikis")).toHaveLength(1);
  });
  it("rejects unauthenticated mutation, owner-ID tampering and public reads of private sibling IDs", async () => {
    expect((await post({ action: "set-slug", slug: "ingi", expectedRevision: 0 }, "")).response.status).toBe(401);
    expect((await claim("public")).response.status).toBe(400);
    await claim("ingi"); const active = await publishRootNote();
    const stolen = await post({ action: "set-slug", slug: "stolen", expectedRevision: 2, legacyWikiId: active.body.wikiId }, other.idToken);
    expect(stolen.response.status).toBe(404);
    expect((await get({ action: "content", wikiId: String(active.body.wikiId), ids: `e_${"0".repeat(32)}`, revision: "2" })).response.status).toBe(404);
    await writeEmulatorDocuments([{ path: "notes/selected-note", fields: { ownerUid: other.localId, type: "personal", participantUids: [other.localId], folderId: null, revision: 1, contentFormat: "markdown-v1" } }]);
    const reduced = await get({ action: "manifest", slug: "ingi" }); expect(reduced.response.status).toBe(200); expect(reduced.body.entries).toEqual([]);
    await writeEmulatorDocuments([{ path: `users/${owner.localId}`, fields: { isActive: false } }]);
    expect((await get({ action: "manifest", slug: "ingi" })).response.status).toBe(404);
  });
});
