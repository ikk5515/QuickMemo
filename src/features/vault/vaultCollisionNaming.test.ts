import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";
import {
  promptCollisionEntryTitle,
  suggestedCollisionEntryTitle,
  suggestedCollisionFolderName
} from "./vaultCollisionNaming";

function note(overrides: Partial<DecryptedVaultNote>): DecryptedVaultNote {
  return {
    body: "",
    contentFormat: "markdown-v1",
    createdAt: 0,
    entryKind: "markdown",
    folderId: null,
    id: "note",
    isDeleted: false,
    ownerUid: "owner",
    participantUids: ["owner"],
    revision: 1,
    title: "기록",
    type: "personal",
    updatedAt: 0,
    wrappedKeys: {},
    ...overrides
  } as DecryptedVaultNote;
}

function folder(overrides: Partial<DecryptedVaultFolder>): DecryptedVaultFolder {
  return {
    displayName: "자료",
    id: "folder",
    order: 0,
    ownerUid: "owner",
    parentId: null,
    revision: 1,
    ...overrides
  } as DecryptedVaultFolder;
}

describe("Vault collision name suggestions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves an asset extension and skips occupied suggestions", () => {
    const target = note({ entryKind: "asset", id: "asset-a", title: "photo.png" });
    const occupied = note({ entryKind: "asset", id: "asset-b", title: "photo (중복).png" });
    expect(suggestedCollisionEntryTitle([target, occupied], target))
      .toBe("photo (중복) 2.png");
  });

  it("normalizes Markdown extensions when choosing a unique title", () => {
    const target = note({ id: "note-a", title: "기록.md" });
    const occupied = note({ id: "note-b", title: "기록 (중복).md" });
    expect(suggestedCollisionEntryTitle([target, occupied], target))
      .toBe("기록 (중복) 2");
  });

  it("chooses a unique sibling folder name without considering another parent", () => {
    const target = folder({ id: "folder-a" });
    const occupied = folder({ id: "folder-b", displayName: "자료 (중복)" });
    const elsewhere = folder({ id: "folder-c", displayName: "자료 (중복) 2", parentId: "other" });
    expect(suggestedCollisionFolderName([target, occupied, elsewhere], target))
      .toBe("자료 (중복) 2");
  });

  it("discloses the root move before repairing a historical shared-folder target", () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    const target = note({ folderId: "legacy-folder", type: "shared" });
    promptCollisionEntryTitle([target], target);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("Vault 루트로 이동"),
      "기록 (중복)"
    );
  });

  it("keeps maximum-length Markdown and asset suggestions within 180 code units", () => {
    const markdown = note({ id: "long-md", title: "가".repeat(180) });
    const asset = note({ entryKind: "asset", id: "long-asset", title: `${"a".repeat(176)}.png` });
    const markdownSuggestion = suggestedCollisionEntryTitle([markdown], markdown);
    const assetSuggestion = suggestedCollisionEntryTitle([asset], asset);
    expect(markdownSuggestion.length).toBeLessThanOrEqual(180);
    expect(markdownSuggestion).toMatch(/ \(중복\)$/u);
    expect(assetSuggestion.length).toBeLessThanOrEqual(180);
    expect(assetSuggestion).toMatch(/ \(중복\)\.png$/u);
  });

  it("keeps occupied maximum-length suggestions and folders within their limits", () => {
    const target = note({ id: "long", title: "나".repeat(180) });
    const first = suggestedCollisionEntryTitle([target], target);
    const occupied = note({ id: "occupied", title: first });
    const next = suggestedCollisionEntryTitle([target, occupied], target);
    const targetFolder = folder({ displayName: "다".repeat(120), id: "long-folder" });
    const folderSuggestion = suggestedCollisionFolderName([targetFolder], targetFolder);
    expect(next.length).toBeLessThanOrEqual(180);
    expect(next).toMatch(/ \(중복\) 2$/u);
    expect(folderSuggestion.length).toBeLessThanOrEqual(120);
    expect(folderSuggestion).toMatch(/ \(중복\)$/u);
  });

  it("does not leave a dangling UTF-16 surrogate when truncating", () => {
    const target = note({ id: "emoji", title: `${"가".repeat(174)}😀` });
    const suggestion = suggestedCollisionEntryTitle([target], target);
    const lastStemCodeUnit = suggestion.charCodeAt(suggestion.indexOf(" (중복)") - 1);
    expect(lastStemCodeUnit < 0xd800 || lastStemCodeUnit > 0xdbff).toBe(true);
    expect(suggestion.length).toBeLessThanOrEqual(180);
  });

  it("preserves an extremely long asset extension while compacting the marker", () => {
    const extension = `.${"x".repeat(178)}`;
    const target = note({ entryKind: "asset", id: "long-extension", title: `a${extension}` });
    const first = suggestedCollisionEntryTitle([target], target);
    const occupied = note({ entryKind: "asset", id: "occupied-extension", title: first });
    const second = suggestedCollisionEntryTitle([target, occupied], target);
    expect(first).toBe(`~${extension}`);
    expect(second).toBe(`2${extension}`);
    expect(first.endsWith(extension)).toBe(true);
    expect(second.endsWith(extension)).toBe(true);
    expect(first.length).toBe(180);
    expect(second.length).toBe(180);
  });
});
