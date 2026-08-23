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

  it.each([
    { code: "unavailable" },
    { code: "firestore/unavailable" },
    new Error("The network connection was lost."),
    new Error("Failed to get document because the client is offline.")
  ])("keeps post-authentication transport failures distinct from a wrong password", (error) => {
    expect(firebaseAuthErrorMessage(error, "비밀번호를 확인해주세요.")).toContain("네트워크 연결");
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
