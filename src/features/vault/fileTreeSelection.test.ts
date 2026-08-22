import { describe, expect, it } from "vitest";
import {
  MAXIMUM_VAULT_TREE_SELECTION,
  canonicalVaultTreeBulkTargets,
  createVaultTreeSelectionState,
  reconcileVaultTreeSelection,
  updateVaultTreeSelection,
  vaultTreeTargetKey,
  type VaultTreeTarget
} from "./fileTreeSelection";

describe("Vault file tree multi-selection", () => {
  const visible = ["entry:a", "folder:b", "entry:c", "entry:d", "folder:e"];

  it("clears the previous selection on an ordinary click", () => {
    let state = updateVaultTreeSelection(createVaultTreeSelectionState(), visible, "entry:a", { range: false, toggle: false });
    state = updateVaultTreeSelection(state, visible, "entry:c", { range: false, toggle: true });
    state = updateVaultTreeSelection(state, visible, "folder:e", { range: false, toggle: false });
    expect([...state.selectedKeys]).toEqual(["folder:e"]);
    expect(state.anchorKey).toBe("folder:e");
  });

  it("toggles Cmd/Ctrl targets without opening a range", () => {
    let state = updateVaultTreeSelection(createVaultTreeSelectionState(), visible, "entry:a", { range: false, toggle: true });
    state = updateVaultTreeSelection(state, visible, "entry:c", { range: false, toggle: true });
    expect([...state.selectedKeys]).toEqual(["entry:a", "entry:c"]);
    state = updateVaultTreeSelection(state, visible, "entry:a", { range: false, toggle: true });
    expect([...state.selectedKeys]).toEqual(["entry:c"]);
  });

  it("selects a contiguous visible range in either direction", () => {
    let state = updateVaultTreeSelection(createVaultTreeSelectionState(), visible, "entry:d", { range: false, toggle: false });
    state = updateVaultTreeSelection(state, visible, "folder:b", { range: true, toggle: false });
    expect([...state.selectedKeys]).toEqual(["entry:d", "entry:c", "folder:b"]);
    expect(state.anchorKey).toBe("entry:d");
  });

  it("enforces the bounded selection limit", () => {
    const many = Array.from({ length: MAXIMUM_VAULT_TREE_SELECTION + 20 }, (_, index) => `entry:${index}`);
    let state = updateVaultTreeSelection(createVaultTreeSelectionState(), many, many[0], { range: false, toggle: false });
    state = updateVaultTreeSelection(state, many, many.at(-1)!, { range: true, toggle: false });
    expect(state.selectedKeys.size).toBe(MAXIMUM_VAULT_TREE_SELECTION);
    expect(state.limitReached).toBe(true);
  });

  it("reconciles revoked/deleted targets without selecting replacements", () => {
    const state = {
      anchorKey: "entry:a",
      limitReached: true,
      selectedKeys: new Set(["entry:a", "entry:c"])
    };
    expect(reconcileVaultTreeSelection(state, new Set(["entry:c"]))).toEqual({
      anchorKey: null,
      limitReached: false,
      selectedKeys: new Set(["entry:c"])
    });
  });

  it("drops descendant targets covered by a selected folder subtree", () => {
    const targets: VaultTreeTarget[] = [
      { id: "root", key: vaultTreeTargetKey("folder", "root"), kind: "folder", parentFolderId: null },
      { id: "child", key: vaultTreeTargetKey("folder", "child"), kind: "folder", parentFolderId: "root" },
      { id: "inside", key: vaultTreeTargetKey("entry", "inside"), kind: "entry", parentFolderId: "child" },
      { id: "outside", key: vaultTreeTargetKey("entry", "outside"), kind: "entry", parentFolderId: null }
    ];
    const parents = new Map<string, string | null>([["root", null], ["child", "root"]]);
    expect(canonicalVaultTreeBulkTargets(targets, parents).map((target) => target.key))
      .toEqual(["folder:root", "entry:outside"]);
  });
});
