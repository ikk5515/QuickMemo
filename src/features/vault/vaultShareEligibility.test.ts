import { describe, expect, it } from "vitest";
import type { DecryptedVaultNote } from "./vaultData";
import { embeddedVaultAssetIdsForShare } from "./vaultShareEligibility";

function note(body: string): DecryptedVaultNote {
  return {
    body,
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: "folder-a",
    id: "note-a",
    isDeleted: false,
    ownerUid: "owner-a",
    participantUids: ["owner-a"],
    revision: 3,
    title: "노트.md",
    type: "personal",
    updatedBy: "owner-a",
    wrappedKeys: {}
  };
}

const entries = [
  { id: "note-a", kind: "markdown" as const, path: "folder/노트.md", content: "" },
  { id: "asset-a", kind: "asset" as const, path: "folder/붙여넣은 이미지.png" },
  { id: "note-b", kind: "markdown" as const, path: "folder/다른 노트.md", content: "" }
];

describe("Vault share eligibility", () => {
  it("finds only resolved embedded asset entries and deduplicates them", () => {
    expect(embeddedVaultAssetIdsForShare(
      note("![[붙여넣은 이미지.png]]\n![[붙여넣은 이미지.png]]\n![[다른 노트]]"),
      "folder/노트.md",
      entries
    )).toEqual(["asset-a"]);
  });

  it("does not block ordinary links, code examples, or unresolved embeds", () => {
    expect(embeddedVaultAssetIdsForShare(
      note("[[붙여넣은 이미지.png]]\n`![[붙여넣은 이미지.png]]`\n![[없는 이미지.png]]"),
      "folder/노트.md",
      entries
    )).toEqual([]);
  });
});
