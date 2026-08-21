import { describe, expect, it } from "vitest";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";
import {
  buildVaultPaths,
  decryptVaultFolders,
  resolvedNoteContentFormat,
  resolvedVaultEntryKind,
  vaultEntryPath,
  vaultNotePath
} from "./vaultData";

describe("vaultData", () => {
  it("treats historical notes as legacy HTML", () => {
    expect(resolvedNoteContentFormat({})).toBe("legacy-html-v1");
    expect(resolvedNoteContentFormat({ contentFormat: "markdown-v1" })).toBe("markdown-v1");
    expect(resolvedVaultEntryKind({ contentFormat: "json-canvas-v1" })).toBe("canvas");
    expect(resolvedVaultEntryKind({ contentFormat: "asset-v1" })).toBe("asset");
  });

  it("builds nested paths without persisting decrypted names", () => {
    const folders = [
      { id: "a", ownerUid: "u", name: "암호화 폴더", color: "#000", displayName: "자료" },
      { id: "b", ownerUid: "u", name: "암호화 폴더", color: "#000", displayName: "연구", parentId: "a" }
    ] as DecryptedVaultFolder[];
    const paths = buildVaultPaths(folders);
    expect(paths.get("b")).toBe("자료/연구");

    const note = { title: "그래프", folderId: "b" } as DecryptedVaultNote;
    expect(vaultNotePath(note, paths)).toBe("자료/연구/그래프.md");
    expect(vaultEntryPath({ ...note, entryKind: "canvas" }, paths)).toBe("자료/연구/그래프.canvas");
    expect(vaultEntryPath({ ...note, entryKind: "asset", title: "설계.pdf" }, paths)).toBe("자료/연구/설계.pdf");
  });

  it("does not recurse forever for malformed folder cycles", () => {
    const folders = [
      { id: "a", ownerUid: "u", name: "a", color: "#000", displayName: "A", parentId: "b" },
      { id: "b", ownerUid: "u", name: "b", color: "#000", displayName: "B", parentId: "a" }
    ] as DecryptedVaultFolder[];
    expect(buildVaultPaths(folders).get("a")).toBeTruthy();
  });

  it("filters foreign folders before legacy plaintext enters the decryption pipeline", async () => {
    const folders = [{
      id: "foreign",
      ownerUid: "other-user",
      name: "다른 사용자의 평문 폴더",
      color: "#000"
    }] as DecryptedVaultFolder[];

    await expect(decryptVaultFolders(
      folders,
      "user-a",
      {} as CryptoKey
    )).resolves.toEqual([]);
  });
});
