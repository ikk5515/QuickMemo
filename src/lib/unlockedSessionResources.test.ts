import { afterEach, describe, expect, it, vi } from "vitest";
import { clearUnlockedSessionResources, registerUnlockedSessionResource } from "./unlockedSessionResources";

afterEach(clearUnlockedSessionResources);
describe("unlocked resource cleanup", () => {
  it("continues clearing every resource synchronously even if one cleanup fails", () => {
    const released = vi.fn();
    const removed = vi.fn();
    registerUnlockedSessionResource(() => { throw new Error("cleanup failed"); });
    registerUnlockedSessionResource(released);
    const unregister = registerUnlockedSessionResource(removed);
    unregister();
    clearUnlockedSessionResources();
    expect(released).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    clearUnlockedSessionResources();
    expect(released).toHaveBeenCalledOnce();
  });
});
