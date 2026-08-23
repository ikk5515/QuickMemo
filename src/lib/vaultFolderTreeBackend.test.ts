import { describe, expect, it } from "vitest";
import {
  VAULT_FOLDER_TREE_MAX_DEPTH,
  assertVaultFolderId,
  buildVaultFolderTree,
  createVaultFolderNode,
  moveVaultFolderNode,
  setVaultFolderLifecycle,
  validateVaultFolderTree,
  vaultFolderAncestors,
  vaultFolderTreeFirestoreFields
} from "../../api/_vault-folder-tree.js";

const encryptedName = {
  algorithm: "AES-GCM",
  cipherText: "cipher",
  iv: "iv",
  version: 1
};
const wrappedKey = {
  algorithm: "RSA-OAEP",
  version: 1,
  wrappedKey: "wrapped"
};

function storedFolder(id: string, parentId: string | null, isDeleted = false) {
  return { __id: id, encryptedName, isDeleted, parentId, wrappedKey };
}

describe("server-authoritative Vault folder tree", () => {
  it("rejects prototype-polluting dynamic map ids", () => {
    for (const folderId of ["__proto__", "constructor", "prototype"]) {
      expect(() => assertVaultFolderId(folderId)).toThrow(/folderId/i);
    }
  });

  it("supports Obsidian-like deep nesting through the documented hard cap", () => {
    const folders = Array.from({ length: VAULT_FOLDER_TREE_MAX_DEPTH + 1 }, (_, index) =>
      storedFolder(`folder-${index}`, index === 0 ? null : `folder-${index - 1}`));
    const tree = buildVaultFolderTree(folders);

    expect(vaultFolderAncestors(tree, `folder-${VAULT_FOLDER_TREE_MAX_DEPTH}`))
      .toHaveLength(VAULT_FOLDER_TREE_MAX_DEPTH);
    expect(() => createVaultFolderNode(tree, {
      folderId: "too-deep",
      parentId: `folder-${VAULT_FOLDER_TREE_MAX_DEPTH}`
    })).toThrow(/depth/i);
  });

  it("rejects forged active state, missing parents, and cycles", () => {
    const tree = buildVaultFolderTree([
      storedFolder("root", null),
      storedFolder("child", "root")
    ]);
    expect(() => validateVaultFolderTree({
      ...tree,
      nodes: { ...tree.nodes, child: { ...tree.nodes.child, active: false } }
    })).toThrow(/active state/i);
    expect(() => validateVaultFolderTree({
      ...tree,
      nodes: { ...tree.nodes, child: { ...tree.nodes.child, parentId: "missing" } }
    })).toThrow(/parent/i);
    expect(() => validateVaultFolderTree({
      ...tree,
      nodes: {
        ...tree.nodes,
        child: { ...tree.nodes.child, parentId: "root" },
        root: { ...tree.nodes.root, parentId: "child" }
      }
    })).toThrow(/cycle/i);
  });

  it("fails the complete subtree closed and preserves independent tombstones", () => {
    let tree = buildVaultFolderTree([
      storedFolder("root", null),
      storedFolder("child", "root"),
      storedFolder("deleted-child", "root", true),
      storedFolder("grandchild", "child")
    ]);
    tree = setVaultFolderLifecycle(tree, { active: false, folderId: "root" });
    expect(tree.nodes.root.active).toBe(false);
    expect(tree.nodes.child.active).toBe(false);
    expect(tree.nodes.grandchild.active).toBe(false);

    tree = setVaultFolderLifecycle(tree, { active: true, folderId: "root" });
    expect(tree.nodes.child.active).toBe(true);
    expect(tree.nodes.grandchild.active).toBe(true);
    expect(tree.nodes["deleted-child"].selfActive).toBe(false);
    expect(tree.nodes["deleted-child"].active).toBe(false);
  });

  it("rejects moves into a descendant and serializes digit-leading opaque ids", () => {
    const tree = buildVaultFolderTree([
      storedFolder("1root", null),
      storedFolder("child", "1root")
    ]);
    expect(() => moveVaultFolderNode(tree, { folderId: "1root", parentId: "child" }))
      .toThrow(/cycle/i);
    const fields = vaultFolderTreeFirestoreFields(
      "owner-a",
      tree,
      new Date("2026-08-23T00:00:00.000Z"),
      new Date("2026-08-23T00:00:01.000Z")
    );
    expect(fields.nodes.mapValue.fields["1root"]).toBeDefined();
  });
});
