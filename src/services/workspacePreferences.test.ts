import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null as null | { uid: string; getIdToken: () => Promise<string> } }, appCheck: {} as object | null, getToken: vi.fn(), fetch: vi.fn() }));
vi.mock("../lib/firebase", () => ({ auth: mocks.auth, get appCheck() { return mocks.appCheck; } }));
vi.mock("firebase/app-check", () => ({ getToken: mocks.getToken }));
import { fetchWorkspacePreferences, saveWorkspaceSidebarPreference } from "./workspacePreferences";
const preferences = { memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } };
function response(value: unknown, ok = true) { return { ok, text: async () => JSON.stringify(value) }; }
beforeEach(() => {
  mocks.auth.currentUser = { uid: "owner", getIdToken: vi.fn(async () => "fixture-id-token") };
  mocks.appCheck = {}; mocks.getToken.mockReset().mockResolvedValue({ token: "fixture-app-check" });
  mocks.fetch.mockReset().mockResolvedValue(response(preferences)); vi.stubGlobal("fetch", mocks.fetch);
});
describe("workspace preference service isolation and projection", () => {
  it("sends only UI dimensions, without document identifiers, cookies or durable cache", async () => {
    await saveWorkspaceSidebarPreference("owner", "memo", { width: 300.6, collapsed: true });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/vault-integrity?resource=workspace-preferences", expect.objectContaining({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      body: JSON.stringify({ action: "set", kind: "memo", value: { width: 301, collapsed: true } }), headers: expect.objectContaining({ authorization: "Bearer fixture-id-token", "X-Firebase-AppCheck": "fixture-app-check" }) }));
  });
  it("projects allowed fields only even inside nested server objects", async () => {
    mocks.fetch.mockResolvedValue(response({ ...preferences, privateKey: "unexpected", memo: { ...preferences.memo, content: "unexpected" } }));
    expect(await fetchWorkspacePreferences("owner")).toEqual(preferences);
  });
  it.each([null, { ...preferences, wiki: { width: 521, collapsed: false } }, { ...preferences, memo: { width: 200, collapsed: "false" } }, { ...preferences, memo: { width: 250.5, collapsed: false } }])("rejects malformed server preferences", async (value) => {
    mocks.fetch.mockResolvedValue(response(value)); await expect(fetchWorkspacePreferences("owner")).rejects.toThrow();
  });
  it("rejects missing/mismatched UID and cancellation before authentication/network work", async () => {
    await expect(fetchWorkspacePreferences("other")).rejects.toMatchObject({ name: "AbortError" });
    await expect(fetchWorkspacePreferences("owner", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    mocks.auth.currentUser = null; await expect(fetchWorkspacePreferences("owner")).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it("stops after ID-token resolution when the authentication identity changes", async () => {
    mocks.auth.currentUser!.getIdToken = async () => { mocks.auth.currentUser = { uid: "other", getIdToken: async () => "other" }; return "old"; };
    await expect(fetchWorkspacePreferences("owner")).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getToken).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects an old auth instance even when a new login has the same UID", async () => {
    mocks.getToken.mockImplementation(async () => { mocks.auth.currentUser = { uid: "owner", getIdToken: async () => "new" }; return { token: "old-app" }; });
    await expect(fetchWorkspacePreferences("owner")).rejects.toMatchObject({ name: "AbortError" }); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("ignores a late response after logout and a late body after signal cancellation", async () => {
    mocks.fetch.mockImplementationOnce(async () => { mocks.auth.currentUser = null; return response(preferences); });
    await expect(fetchWorkspacePreferences("owner")).rejects.toMatchObject({ name: "AbortError" });
    mocks.auth.currentUser = { uid: "owner", getIdToken: async () => "fixture" }; const controller = new AbortController();
    mocks.fetch.mockResolvedValueOnce({ ok: true, text: async () => { controller.abort(); return JSON.stringify(preferences); } });
    await expect(fetchWorkspacePreferences("owner", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("propagates offline/errors and rejects oversized server bodies", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("offline")); await expect(fetchWorkspacePreferences("owner")).rejects.toThrow("offline");
    mocks.fetch.mockResolvedValueOnce(response(preferences, false)); await expect(fetchWorkspacePreferences("owner")).rejects.toThrow();
    mocks.fetch.mockResolvedValueOnce({ ok: true, text: async () => "x".repeat(2049) }); await expect(fetchWorkspacePreferences("owner")).rejects.toThrow();
  });
});
