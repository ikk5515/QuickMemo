import { describe, expect, it } from "vitest";
import { vaultUnlockErrorMessage } from "./UnlockPanel";

describe("vaultUnlockErrorMessage", () => {
  it("distinguishes invalid credentials from a retryable transport failure", () => {
    expect(vaultUnlockErrorMessage({ code: "auth/invalid-credential" })).toBe("비밀번호를 확인해주세요.");
    expect(vaultUnlockErrorMessage({ code: "firestore/unavailable" })).toBe(
      "네트워크 연결이 불안정합니다. 연결을 확인한 뒤 다시 열어주세요."
    );
  });

  it("does not misreport unknown failures as a wrong password", () => {
    expect(vaultUnlockErrorMessage(new Error("unexpected"))).toBe(
      "암호화 키를 열지 못했습니다. 잠시 후 다시 시도해주세요."
    );
  });
});
