import { describe, expect, it } from "vitest";
import { shouldReleaseVaultEntryCreation } from "./vaultEntryCreationLock";

describe("Vault entry creation lock", () => {
  it("keeps the previous entry locked until the created entry is active and decrypted", () => {
    const pending = { entryId: "created-base", kind: "base" } as const;

    expect(shouldReleaseVaultEntryCreation(pending, {
      activeEntryId: "previous-note",
      hasActiveDraft: true,
      hasActiveNote: true
    })).toBe(false);
    expect(shouldReleaseVaultEntryCreation(pending, {
      activeEntryId: "created-base",
      hasActiveDraft: false,
      hasActiveNote: true
    })).toBe(false);
    expect(shouldReleaseVaultEntryCreation(pending, {
      activeEntryId: "created-base",
      hasActiveDraft: true,
      hasActiveNote: false
    })).toBe(false);
  });

  it("releases only when the created entry is the active editable draft", () => {
    expect(shouldReleaseVaultEntryCreation({ entryId: "created-base", kind: "base" }, {
      activeEntryId: "created-base",
      hasActiveDraft: true,
      hasActiveNote: true
    })).toBe(true);
  });

  it("does not release a create request before the server returns its entry id", () => {
    expect(shouldReleaseVaultEntryCreation({ entryId: null, kind: "markdown" }, {
      activeEntryId: "previous-note",
      hasActiveDraft: true,
      hasActiveNote: true
    })).toBe(false);
  });
});
