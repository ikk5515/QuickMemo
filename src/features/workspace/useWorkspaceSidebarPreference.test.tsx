import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock("../../services/workspacePreferences", () => ({ fetchWorkspacePreferences: mocks.fetch, saveWorkspaceSidebarPreference: mocks.save }));
import { useWorkspaceSidebarPreference } from "./useWorkspaceSidebarPreference";
import type { WorkspacePreferences } from "../../services/workspacePreferences";
const defaults = { memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } };
const key = (uid = "owner", kind = "memo") => `quickmemo:sidebar:pending:v1:${uid}:${kind}`;
const readPending = (uid = "owner", kind = "memo") => JSON.parse(localStorage.getItem(key(uid, kind)) ?? "null");
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function ack(width: number, collapsed = false): WorkspacePreferences { return { ...defaults, memo: { width, collapsed } }; }
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); mocks.fetch.mockReset().mockResolvedValue(defaults);
  mocks.save.mockReset().mockImplementation(async (_uid, kind, value) => ({ ...defaults, [kind]: value }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
describe("workspace sidebar preference lifetimes and recoverable write queue", () => {
  it("applies server defaults before interaction but never overwrites a local resize with a late read", async () => {
    const server = deferred<WorkspacePreferences>(); mocks.fetch.mockReturnValueOnce(server.promise);
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner"));
    act(() => result.current.onChange({ width: 340, collapsed: true }));
    await act(async () => server.resolve(ack(220)));
    expect(result.current.width).toBe(340); expect(result.current.collapsed).toBe(true);
    await tick(500); expect(mocks.save).toHaveBeenLastCalledWith("owner", "memo", { width: 340, collapsed: true }, expect.any(AbortSignal));
  });
  it("isolates UID changes and ignores old callbacks/read responses while re-fetching a revisited account", async () => {
    const old = deferred<WorkspacePreferences>(); mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ack(410)).mockResolvedValueOnce(ack(225));
    const { result, rerender } = renderHook(({ uid }) => useWorkspaceSidebarPreference("memo", uid), { initialProps: { uid: "owner" } });
    const oldChange = result.current.onChange;
    act(() => result.current.onChange({ width: 300, collapsed: false })); await tick(500);
    rerender({ uid: "other" }); await tick(); expect(result.current.width).toBe(410);
    act(() => oldChange({ width: 500, collapsed: true }));
    await act(async () => old.resolve(ack(200))); expect(result.current.width).toBe(410); expect(readPending("owner")).toBeNull();
    rerender({ uid: "owner" }); await tick(); expect(result.current.width).toBe(225);
  });
  it("serializes in-flight writes and coalesces queued intermediate resize values", async () => {
    const first = deferred<WorkspacePreferences>(); mocks.save.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => result.current.onChange({ width: 300, collapsed: false })); await tick(500);
    act(() => result.current.onChange({ width: 320, collapsed: false })); await tick(500);
    act(() => result.current.onChange({ width: 350, collapsed: true })); await tick(500);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(ack(300))); await tick();
    expect(mocks.save.mock.calls.map((call) => call[2])).toEqual([{ width: 300, collapsed: false }, { width: 350, collapsed: true }]);
    expect(readPending()).toBeNull();
  });
  it("keeps the newer recovery record when an old save resolves before React flushes the newer resize", async () => {
    const first = deferred<WorkspacePreferences>(); const second = deferred<WorkspacePreferences>(); mocks.save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => result.current.onChange({ width: 300, collapsed: false })); await tick(500);
    await act(async () => {
      result.current.onChange({ width: 360, collapsed: true });
      first.resolve(ack(300)); await first.promise; await Promise.resolve();
      // The response runs while React still batches the updated state.
      expect(readPending()).toEqual({ width: 360, collapsed: true });
    });
    await tick(500); expect(readPending()).toEqual({ width: 360, collapsed: true });
    await act(async () => second.resolve(ack(360, true))); expect(readPending()).toBeNull();
  });
  it("persists pending synchronously and recovers it after immediate refresh before debounce", async () => {
    const first = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => first.result.current.onChange({ width: 377, collapsed: true })); expect(readPending()).toEqual({ width: 377, collapsed: true });
    first.unmount(); expect(mocks.save).not.toHaveBeenCalled();
    const recovered = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    expect(recovered.result.current.width).toBe(377); expect(recovered.result.current.collapsed).toBe(true);
    await tick(500); expect(mocks.save).toHaveBeenCalledTimes(1); expect(readPending()).toBeNull();
  });
  it("retains unsynced values on server mismatch and retries without accepting the wrong acknowledgement", async () => {
    mocks.save.mockResolvedValueOnce(ack(220));
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => result.current.onChange({ width: 330, collapsed: true })); await tick(500);
    expect(readPending()).toEqual({ width: 330, collapsed: true }); expect(result.current.width).toBe(330);
    await tick(4000); expect(mocks.save).toHaveBeenCalledTimes(2); expect(readPending()).toBeNull();
  });
  it("bounds offline backoff and resumes after online even when automatic attempts were exhausted", async () => {
    mocks.save.mockRejectedValue(new TypeError("offline"));
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => result.current.onChange({ width: 320, collapsed: false })); await tick(500); await tick(4000); await tick(8000); await tick(16000); await tick(60000);
    expect(mocks.save).toHaveBeenCalledTimes(4); expect(readPending()).toEqual({ width: 320, collapsed: false });
    mocks.save.mockResolvedValueOnce(ack(320)); act(() => window.dispatchEvent(new Event("online"))); await tick();
    expect(mocks.save).toHaveBeenCalledTimes(5); expect(readPending()).toBeNull();
  });
  it("aborts old UID operations and preserves pending recovery against late success after unmount", async () => {
    const save = deferred<WorkspacePreferences>(); mocks.save.mockReturnValueOnce(save.promise);
    const { result, unmount } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => result.current.onChange({ width: 390, collapsed: false })); await tick(500);
    const signal = mocks.save.mock.calls[0][3] as AbortSignal; unmount(); expect(signal.aborted).toBe(true);
    await act(async () => save.resolve(ack(390))); expect(readPending()).toEqual({ width: 390, collapsed: false });
    act(() => window.dispatchEvent(new Event("online"))); await tick(60000); expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("does not clear a newer recovery record written by another mounted tab", async () => {
    const save = deferred<WorkspacePreferences>(); mocks.save.mockReturnValueOnce(save.promise);
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    act(() => result.current.onChange({ width: 300, collapsed: false })); await tick(500);
    localStorage.setItem(key(), JSON.stringify({ width: 420, collapsed: true }));
    await act(async () => save.resolve(ack(300))); expect(readPending()).toEqual({ width: 420, collapsed: true });
  });
  it("keeps anonymous preferences local", async () => {
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", null));
    act(() => result.current.onChange({ width: 340, collapsed: true })); await tick(1000);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(result.current.width).toBe(340);
  });
  it("ignores malformed recovery values and strips extra fields from valid recovery", async () => {
    localStorage.setItem(key(), JSON.stringify({ width: 9999, collapsed: "false", content: "discard" }));
    mocks.fetch.mockResolvedValueOnce(ack(260));
    const invalid = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick(500);
    expect(invalid.result.current.width).toBe(260); expect(mocks.save).not.toHaveBeenCalled(); invalid.unmount();
    localStorage.setItem(key(), JSON.stringify({ width: 335, collapsed: true, content: "discard" }));
    renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick(500);
    expect(mocks.save).toHaveBeenLastCalledWith("owner", "memo", { width: 335, collapsed: true }, expect.any(AbortSignal));
  });
  it("keeps the local setting usable when initial server read is offline", async () => {
    localStorage.setItem("quickmemo:sidebar:v1:memo:owner", JSON.stringify({ width: 312, collapsed: true }));
    mocks.fetch.mockRejectedValueOnce(new TypeError("offline"));
    const { result } = renderHook(() => useWorkspaceSidebarPreference("memo", "owner")); await tick();
    expect(result.current.width).toBe(312); expect(result.current.collapsed).toBe(true); expect(mocks.save).not.toHaveBeenCalled();
  });

});
