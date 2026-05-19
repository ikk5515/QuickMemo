import { afterEach, describe, expect, it } from "vitest";
import { clearAuthSession, firebaseAuthSessionDurationMs, readAuthSession, startAuthSession } from "./authSession";

describe("Firebase auth app session", () => {
  afterEach(() => {
    clearAuthSession();
  });

  it("keeps only a non-sensitive fixed deadline in session storage", () => {
    const session = startAuthSession("user-a", 1_000);

    expect(session.expiresAt).toBe(1_000 + firebaseAuthSessionDurationMs);
    expect(sessionStorage.getItem("quickmemo-auth-session")).toContain('"uid":"user-a"');
    expect(sessionStorage.getItem("quickmemo-auth-session")).not.toContain("privateKey");
  });

  it("rejects missing, mismatched, expired, and malformed sessions", () => {
    expect(readAuthSession("user-a", 1_000)).toBeNull();

    startAuthSession("user-a", 1_000);
    expect(readAuthSession("user-b", 1_001)).toBeNull();

    startAuthSession("user-a", 1_000);
    expect(readAuthSession("user-a", 1_000 + firebaseAuthSessionDurationMs - 1)?.uid).toBe("user-a");
    expect(readAuthSession("user-a", 1_000 + firebaseAuthSessionDurationMs)).toBeNull();

    sessionStorage.setItem("quickmemo-auth-session", "{");
    expect(readAuthSession("user-a", 1_000)).toBeNull();
  });
});
