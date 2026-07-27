import { describe, expect, it } from "vitest";
import { isLegacyPublicNoteShare } from "./publicShares";

describe("legacy public-share boundary", () => {
  it("accepts only legacy v1 documents", () => {
    expect(isLegacyPublicNoteShare({ version: 1 })).toBe(true);
    expect(isLegacyPublicNoteShare({ schemaVersion: 1, version: 1 })).toBe(true);
  });

  it("keeps Secure Share v2 out of legacy Firestore mutation paths", () => {
    expect(isLegacyPublicNoteShare({ schemaVersion: 2, version: 2 })).toBe(false);
    expect(isLegacyPublicNoteShare({ schemaVersion: 2, version: 1 })).toBe(false);
    expect(isLegacyPublicNoteShare({ version: 2 })).toBe(false);
  });
});
