import { describe, expect, it } from "vitest";
import { firebaseAuthErrorMessage } from "./firebaseErrors";

describe("Firebase error messages", () => {
  it("explains missing Auth configuration", () => {
    expect(firebaseAuthErrorMessage({ code: "auth/configuration-not-found" }, "fallback")).toContain(
      "Firebase Authentication"
    );
  });

  it("detects REST configuration errors in wrapped messages", () => {
    expect(firebaseAuthErrorMessage(new Error("CONFIGURATION_NOT_FOUND"), "fallback")).toContain("Email/Password");
  });

  it("does not expose an unknown provider error message", () => {
    expect(
      firebaseAuthErrorMessage(
        new Error("internal endpoint /projects/example/databases/(default) failed"),
        "fallback"
      )
    ).toBe("fallback");
  });
});
