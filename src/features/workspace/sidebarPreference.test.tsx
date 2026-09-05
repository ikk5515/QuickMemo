import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { readSidebarPreference, useLocalSidebarPreference } from "./sidebarPreference";

beforeEach(() => localStorage.clear());
describe("non-sensitive local sidebar preferences", () => {
  it("rejects malformed preferences and extracts only bounded width and collapsed state", () => {
    localStorage.setItem("pref", '{"width":9999,"collapsed":true,"body":"discard"}');
    expect(readSidebarPreference("pref")).toEqual({ width: 520, collapsed: true });
    localStorage.setItem("pref", "broken"); expect(readSidebarPreference("pref")).toEqual({ width: 280, collapsed: false });
  });
  it("flushes the final resize on pagehide and immediate unmount before the debounce expires", () => {
    const { result, unmount } = renderHook(() => useLocalSidebarPreference("wiki", "owner"));
    act(() => result.current.onChange({ width: 410, collapsed: true }));
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(JSON.parse(localStorage.getItem("quickmemo:sidebar:v1:wiki:owner")!)).toEqual({ width: 410, collapsed: true });
    act(() => result.current.onChange({ width: 430, collapsed: false })); unmount();
    expect(JSON.parse(localStorage.getItem("quickmemo:sidebar:v1:wiki:owner")!)).toEqual({ width: 430, collapsed: false });
  });
  it("isolates identity changes and never writes an old preference into a new scope", () => {
    const view = renderHook(({ identity }) => useLocalSidebarPreference("wiki", identity), { initialProps: { identity: "first" } });
    act(() => view.result.current.onChange({ width: 420, collapsed: true }));
    view.rerender({ identity: "second" });
    expect(view.result.current.width).toBe(280);
    act(() => view.result.current.onChange({ width: 300, collapsed: false })); view.unmount();
    expect(JSON.parse(localStorage.getItem("quickmemo:sidebar:v1:wiki:first")!)).toEqual({ width: 420, collapsed: true });
    expect(JSON.parse(localStorage.getItem("quickmemo:sidebar:v1:wiki:second")!)).toEqual({ width: 300, collapsed: false });
  });
});
