// @vitest-environment node
/* global structuredClone */
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ docs: new Map(), writes: 0, conflicts: 0 }));
vi.mock("../../api/_secure-share-common.js", async (original) => {
  const actual = await original();
  return { ...actual,
    createFirestoreContext: vi.fn(async () => ({ projectId: "demo-workspace" })),
    verifySecureShareAppCheck: vi.fn(async () => ({ enforced: false })),
    activeUserFromRequest: vi.fn(async request => {
      if (request.headers.authorization !== "Bearer fixture-owner") throw new actual.HttpError(401, "authentication_required");
      return { uid: "owner-a" };
    }),
    firestoreGet: vi.fn(async (_context, path) => structuredClone(state.docs.get(path) ?? null)),
    firestoreCommit: vi.fn(async (_context, writes) => {
      if (state.conflicts-- > 0) throw Object.assign(new Error("precondition"), { statusCode: 400, upstreamCode: "FAILED_PRECONDITION" });
      for (const write of writes) {
        const path = write.update.name.split("/documents/")[1];
        state.docs.set(path, { ...actual.fromFirestoreFields(write.update.fields), __updateTime: String(++state.writes) });
      }
    })
  };
});
import handler from "../../api/vault-integrity.js";
import { workspacePreferenceAction as action, __workspacePreferencesTesting as api } from "../../api/_workspace-preferences.js";
import { activeUserFromRequest, verifySecureShareAppCheck, HttpError, sha256Digest } from "../../api/_secure-share-common.js";
const context = { projectId: "demo-workspace" };
const patch = (kind, width, collapsed = false) => ({ action: "set", kind, value: { width, collapsed } });
beforeEach(() => { state.docs.clear(); state.writes = 0; state.conflicts = 0; vi.clearAllMocks(); });
describe("owner workspace UI preferences", () => {
  it("keeps users and independent memo/wiki settings isolated", async () => {
    await action(context, "owner-a", patch("memo", 222, true));
    await action(context, "owner-b", patch("wiki", 410));
    await action(context, "owner-a", patch("wiki", 330));
    expect(await action(context, "owner-a", { action: "get" })).toEqual({ memo: { width: 222, collapsed: true }, wiki: { width: 330, collapsed: false } });
    expect(await action(context, "owner-b", { action: "get" })).toEqual({ memo: { width: 244, collapsed: false }, wiki: { width: 410, collapsed: false } });
  });
  it("validates dimensions, types, and rejects owner/path/document injection", async () => {
    for (const value of [179, 521, 240.5, NaN, "240"]) await expect(action(context, "owner-a", patch("memo", value))).rejects.toMatchObject({ statusCode: 400 });
    for (const body of [{ ...patch("memo", 240), uid: "owner-b" }, patch("../../users", 240), { action: "get", path: "users/owner-b" }, { ...patch("memo", 240), value: { width: 240, collapsed: false, content: "private text" } }]) await expect(action(context, "owner-a", body)).rejects.toMatchObject({ statusCode: 400 });
    expect(state.writes).toBe(0);
  });
  it("rejects malformed collapse values and never returns unexpected stored data", () => {
    expect(() => api.sidebar({ width: 240, collapsed: "false" })).toThrow();
    expect(api.projection({ memo: { width: 240, collapsed: false }, wiki: { width: 5000, collapsed: false }, privateText: "secret" })).toEqual({ memo: { width: 240, collapsed: false }, wiki: { width: 280, collapsed: false } });
  });
  it("retries CAS preconditions and deduplicates identical updates", async () => {
    state.conflicts = 2;
    await action(context, "owner-a", patch("memo", 300));
    await action(context, "owner-a", patch("memo", 300));
    expect(state.writes).toBe(1);
  });
  it("bounds writes per user per minute", async () => {
    for (let n = 0; n < 60; n++) await action(context, "owner-a", patch("memo", 220 + n));
    await expect(action(context, "owner-a", patch("memo", 400))).rejects.toMatchObject({ statusCode: 429 });
    await expect(action(context, "owner-b", patch("memo", 400))).resolves.toBeDefined();
  });
  it("fails closed if stored ownership is inconsistent", async () => {
    state.docs.set(`workspaceUiPreferences/${sha256Digest("owner-a")}`, { ownerUid: "owner-b" });
    await expect(action(context, "owner-a", { action: "get" })).rejects.toMatchObject({ statusCode: 403 });
  });
});
async function call(overrides = {}) {
  const response = { headers: {}, statusCode: 0, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = JSON.parse(body); } };
  await handler({ url: "/api/vault-integrity?resource=workspace-preferences", method: "POST", headers: { host: "localhost:4174", origin: "http://localhost:4174", authorization: "Bearer fixture-owner", "x-quickmemo-workspace-preferences": "1", "content-type": "application/json" }, body: { action: "get" }, ...overrides }, response);
  return response;
}
describe("preferences HTTP authorization", () => {
  it("requires an exact resource and its distinct marker without routing to integrity actions", async () => {
    expect((await call({ url: "/api/vault-integrity" })).statusCode).toBe(403);
    for (const url of ["/api/vault-integrity?resource=other", "/api/vault-integrity?resource=workspace-preferences&resource=workspace-preferences", "/api/vault-integrity?resource=workspace-preferences&action=seal-ready"])
      expect((await call({ url })).statusCode).toBe(400);
    const headers = { host: "localhost:4174", origin: "http://localhost:4174", authorization: "Bearer fixture-owner", "x-quickmemo-vault-integrity": "1", "content-type": "application/json" };
    expect((await call({ headers })).statusCode).toBe(403);
    expect((await call({ body: { action: "seal-ready" } })).statusCode).toBe(400);
    expect(state.writes).toBe(0);
  });
  it("retains the metadata branch App Check, active-user, and body-size enforcement", async () => {
    vi.mocked(verifySecureShareAppCheck).mockResolvedValueOnce({ enforced: true, valid: false });
    expect((await call()).statusCode).toBe(403);
    vi.mocked(activeUserFromRequest).mockRejectedValueOnce(new HttpError(403, "permission_denied"));
    expect((await call()).statusCode).toBe(403);
    expect((await call({ body: { action: "get", extra: "x".repeat(2048) } })).statusCode).toBe(413);
    expect(state.writes).toBe(0);
  });
  it("rejects an anonymous request before reading private settings", async () => {
    vi.mocked(activeUserFromRequest).mockRejectedValueOnce(new HttpError(401, "authentication_required"));
    expect((await call()).statusCode).toBe(401);
  });
  it("rejects a cross-site request and unsafe methods", async () => {
    expect((await call({ headers: { host: "quickmemo.test", origin: "https://attacker.test" } })).statusCode).toBe(403);
    expect((await call({ method: "GET" })).statusCode).toBe(405);
  });
  it("returns only the authenticated owner's metadata with secure no-store headers", async () => {
    const result = await call();
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } });
    expect(result.headers["cache-control"]).toContain("no-store");
  });
});
