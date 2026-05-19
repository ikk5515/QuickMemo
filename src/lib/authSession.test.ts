import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFirebaseAuthSession,
  ensureFirebaseAuthSession,
  firebaseAuthSessionDurationMs,
  firebaseAuthSessionExpired,
  firebaseAuthSessionRemainingMs,
  startFirebaseAuthSession
} from "./authSession";

describe("Firebase auth session marker", () => {
  beforeEach(() => {
    const store = new Map<string, string>();

    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => {
          store.delete(key);
        },
        setItem: (key: string, value: string) => {
          store.set(key, value);
        }
      }
    });
  });

  afterEach(() => {
    clearFirebaseAuthSession("user-a");
    vi.unstubAllGlobals();
  });

  it("tracks a 60 minute app session without storing note private keys", () => {
    const now = 1_000;
    const expiresAt = startFirebaseAuthSession("user-a", now + firebaseAuthSessionDurationMs);

    expect(expiresAt).toBe(now + 60 * 60 * 1000);
    expect(firebaseAuthSessionRemainingMs("user-a", now + 10_000)).toBe(firebaseAuthSessionDurationMs - 10_000);
    expect(firebaseAuthSessionExpired("user-a", now + firebaseAuthSessionDurationMs)).toBe(true);
  });

  it("starts a new marker only when the current tab has none", () => {
    expect(ensureFirebaseAuthSession("user-a", 2_000)).toBe(2_000 + firebaseAuthSessionDurationMs);
    expect(ensureFirebaseAuthSession("user-a", 5_000)).toBe(2_000 + firebaseAuthSessionDurationMs);

    clearFirebaseAuthSession("user-a");

    expect(firebaseAuthSessionRemainingMs("user-a", 5_000)).toBeNull();
  });
});
