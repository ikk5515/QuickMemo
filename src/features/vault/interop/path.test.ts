import { describe, expect, it } from "vitest";
import {
  classifyObsidianVaultPath,
  normalizeVaultPath,
  renamedDuplicateVaultPath,
  vaultParentFolders,
  vaultPathCollisionKey
} from "./path";
import { VaultInteropError } from "./types";

describe("vault interoperability paths", () => {
  it("normalizes separators and Unicode without flattening folders", () => {
    expect(normalizeVaultPath("자료\\연구\\Cafe\u0301.md")).toBe("자료/연구/Café.md");
    expect(vaultParentFolders("자료/연구/노트.md")).toEqual(["자료", "자료/연구"]);
  });

  it.each([
    "../secret.md",
    "folder/../secret.md",
    "/absolute.md",
    "C:\\vault\\note.md",
    "\\\\server\\share\\note.md",
    "folder//note.md",
    "folder/./note.md",
    "folder/%2e%2e/note.md",
    "folder/%252e%252e/note.md",
    "folder%2fnote.md",
    "nul\u0000.md"
  ])("rejects an unsafe path: %s", (path) => {
    expect(() => normalizeVaultPath(path)).toThrow(VaultInteropError);
  });

  it("enforces UTF-8 byte limits rather than JavaScript character counts", () => {
    expect(() => normalizeVaultPath("한글.md", { maxPathBytes: 8 })).toThrowError(
      expect.objectContaining({ code: "invalid-path" })
    );
    expect(normalizeVaultPath("a.md", { maxPathBytes: 8 })).toBe("a.md");
  });

  it("uses a case-insensitive NFC collision key for portable ZIPs", () => {
    expect(vaultPathCollisionKey("Folder/Cafe\u0301.MD")).toBe(
      vaultPathCollisionKey("folder/café.md")
    );
  });

  it("renames duplicates before the final extension", () => {
    expect(renamedDuplicateVaultPath("Folder/Note.md", 2)).toBe("Folder/Note 2.md");
    expect(renamedDuplicateVaultPath("LICENSE", 3)).toBe("LICENSE 3");
  });

  it("classifies canonical Obsidian file types by extension", () => {
    expect(classifyObsidianVaultPath("Note.MD")).toBe("markdown");
    expect(classifyObsidianVaultPath("Board.canvas")).toBe("canvas");
    expect(classifyObsidianVaultPath("Database.BASE")).toBe("base");
    expect(classifyObsidianVaultPath("attachments/photo.png")).toBe("asset");
  });
});
