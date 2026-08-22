import { describe, expect, it, vi } from "vitest";
import {
  registerPrivateKeyAutoLockGuard,
  shouldDelayPrivateKeyAutoLock
} from "./privateKeyAutoLockGuard";

describe("private-key auto-lock guards", () => {
  it("waits while any mounted encrypted surface reports pending work", () => {
    const unregisterIdle = registerPrivateKeyAutoLockGuard(() => false);
    const unregisterPending = registerPrivateKeyAutoLockGuard(() => true);

    try {
      expect(shouldDelayPrivateKeyAutoLock()).toBe(true);
      unregisterPending();
      expect(shouldDelayPrivateKeyAutoLock()).toBe(false);
    } finally {
      unregisterIdle();
      unregisterPending();
    }
  });

  it("fails closed for a throwing guard but releases it on unmount", () => {
    const guard = vi.fn(() => {
      throw new Error("state unavailable");
    });
    const unregister = registerPrivateKeyAutoLockGuard(guard);

    expect(shouldDelayPrivateKeyAutoLock()).toBe(true);
    expect(guard).toHaveBeenCalledOnce();
    unregister();
    expect(shouldDelayPrivateKeyAutoLock()).toBe(false);
  });
});
