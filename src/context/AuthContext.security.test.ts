import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const authContextSource = readFileSync(join(process.cwd(), "src/context/AuthContext.tsx"), "utf8");

describe("AuthContext session boundary", () => {
  it("enforces an app-level Firebase auth session deadline separately from private-key locking", () => {
    expect(authContextSource).toContain("readAuthSession");
    expect(authContextSource).toContain("startAuthSession");
    expect(authContextSource).toContain("clearAuthSession");
    expect(authContextSource).toContain("expireFirebaseSession");
    expect(authContextSource).toContain("window.setTimeout");
    expect(authContextSource).toContain("firebaseSignOut(auth)");
  });

  it("gives pending encrypted saves a bounded grace and treats wheel zoom as activity", () => {
    expect(authContextSource).toContain("shouldDelayPrivateKeyAutoLock()");
    expect(authContextSource).toContain("privateKeyAutoLockSaveGraceMs = 5_000");
    expect(authContextSource).toContain("activityGeneration !== expectedActivityGeneration");
    expect(authContextSource).toContain('window.addEventListener("wheel", refreshSessionFromActivity');
    expect(authContextSource).toContain('window.removeEventListener("wheel", refreshSessionFromActivity');
  });
});
