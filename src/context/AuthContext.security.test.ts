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
});
