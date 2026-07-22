import { describe, expect, it } from "vitest";
import type { NewUserPayload } from "../types";
import { profileDocument } from "./adminFunctions";

function newUserPayload(overrides: Partial<NewUserPayload> = {}): NewUserPayload {
  return {
    displayName: "사용자",
    avatarText: "U",
    color: "#2f7d70",
    quickKey: 7,
    password: "password",
    isAdmin: false,
    keyBundle: {
      publicKeyJwk: { kty: "RSA" },
      encryptedPrivateKeyJwk: {
        version: 1,
        algorithm: "AES-GCM",
        cipherText: "encrypted",
        iv: "iv"
      },
      kdfSalt: "salt",
      kdfIterations: 210_000
    },
    ...overrides
  };
}

describe("managed user feature access persistence", () => {
  it("stores all features for new legacy-compatible users when no selection is provided", () => {
    const profile = profileDocument("user-a", "user-a@quickmemo.local", newUserPayload(), 1);

    expect(profile.featureAccess).toEqual({ notes: true, library: true, schedule: true });
  });

  it("stores a regular user's explicit feature selection", () => {
    const profile = profileDocument("user-a", "user-a@quickmemo.local", newUserPayload({
      featureAccess: { notes: true, library: false, schedule: true }
    }), 1);

    expect(profile.featureAccess).toEqual({ notes: true, library: false, schedule: true });
  });

  it("forces every administrator feature on even if a stale caller submits disabled values", () => {
    const profile = profileDocument("admin-a", "admin-a@quickmemo.local", newUserPayload({
      isAdmin: true,
      featureAccess: { notes: false, library: false, schedule: false }
    }), 1);

    expect(profile.featureAccess).toEqual({ notes: true, library: true, schedule: true });
  });
});
