import { describe, expect, it } from "vitest";
import { MAX_VAULT_FOLDER_DEPTH, VaultFolderIntegrityError } from "./vaultIntegrity";
import { requireValidProposedVaultFolderTree } from "./vaultFolderPreflight";

function proposedPath(depth: number) {
  const segments = Array.from({ length: depth + 1 }, (_, index) => `f${index}`);
  return segments.map((_, index) => ({
    parentPath: index === 0 ? null : segments.slice(0, index).join("/"),
    path: segments.slice(0, index + 1).join("/")
  }));
}

describe("requireValidProposedVaultFolderTree", () => {
  it("accepts a proposed folder at the server-verifiable maximum depth", () => {
    expect(() => requireValidProposedVaultFolderTree([], proposedPath(MAX_VAULT_FOLDER_DEPTH)))
      .not.toThrow();
  });

  it("rejects a path above the server-verifiable depth before any folder write", () => {
    expect(() => requireValidProposedVaultFolderTree([], proposedPath(MAX_VAULT_FOLDER_DEPTH + 1)))
      .toThrow(VaultFolderIntegrityError);
  });

  it("audits existing parent relations together with proposed children", () => {
    expect(() => requireValidProposedVaultFolderTree([
      { id: "root", parentId: null, path: "Root" },
      { id: "child", parentId: "wrong", path: "Root/Child" }
    ], [])).toThrow("상위 폴더 관계");

    expect(() => requireValidProposedVaultFolderTree([
      { id: "root", parentId: null, path: "Root" }
    ], [
      { parentPath: "Missing", path: "Missing/Child" }
    ])).toThrow("상위 경로");
  });
});
