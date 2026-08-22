import { describe, expect, it } from "vitest";
import {
  clampWorkspaceSplitRatio,
  createDefaultWorkspaceLayout,
  normalizeWorkspaceLayout,
  removeWorkspacePane,
  resizeWorkspaceSplit,
  splitWorkspacePane,
  workspaceLayoutGroupIds
} from "./workspaceLayout";

describe("workspace pane layout", () => {
  it("creates nested horizontal and vertical splits and keeps deterministic order", () => {
    const first = splitWorkspacePane({
      direction: "vertical",
      layout: createDefaultWorkspaceLayout(),
      newGroupId: "secondary",
      splitId: "split_root",
      targetGroupId: "primary"
    });
    const nested = splitWorkspacePane({
      direction: "horizontal",
      layout: first,
      newGroupId: "pane_notes",
      placement: "before",
      splitId: "split_nested",
      targetGroupId: "secondary"
    });

    expect(workspaceLayoutGroupIds(nested)).toEqual(["primary", "pane_notes", "secondary"]);
    expect(nested).toMatchObject({
      type: "split",
      direction: "vertical",
      second: { type: "split", direction: "horizontal" }
    });
  });

  it("collapses a parent split when a pane closes", () => {
    const split = splitWorkspacePane({
      direction: "vertical",
      layout: createDefaultWorkspaceLayout(),
      newGroupId: "secondary",
      splitId: "split_root",
      targetGroupId: "primary"
    });
    expect(removeWorkspacePane(split, "secondary")).toEqual({ type: "pane", groupId: "primary" });
    expect(() => removeWorkspacePane({ type: "pane", groupId: "primary" }, "primary"))
      .toThrow("workspace-layout-last-pane");
  });

  it("clamps persisted and interactive split ratios", () => {
    expect(clampWorkspaceSplitRatio(-4)).toBe(0.2);
    expect(clampWorkspaceSplitRatio(7)).toBe(0.8);
    const split = splitWorkspacePane({
      direction: "vertical",
      layout: createDefaultWorkspaceLayout(),
      newGroupId: "secondary",
      splitId: "split_root",
      targetGroupId: "primary"
    });
    expect(resizeWorkspaceSplit(split, "split_root", 0.73)).toMatchObject({ ratio: 0.73 });
  });

  it("fails closed for duplicate, malformed, over-deep, or over-limit persisted layouts", () => {
    expect(normalizeWorkspaceLayout({ type: "pane", groupId: "../../secret" }))
      .toEqual(createDefaultWorkspaceLayout());
    expect(normalizeWorkspaceLayout({
      type: "split",
      id: "split_root",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "pane", groupId: "primary" },
      second: { type: "pane", groupId: "primary" }
    })).toEqual(createDefaultWorkspaceLayout());

    let overDeep: unknown = { type: "pane", groupId: "primary" };
    for (let depth = 0; depth < 6; depth += 1) {
      overDeep = {
        type: "split",
        id: `split_deep_${depth}`,
        direction: "vertical",
        ratio: 0.5,
        first: overDeep,
        second: { type: "pane", groupId: depth === 0 ? "secondary" : `pane_deep_${depth}` }
      };
    }
    expect(normalizeWorkspaceLayout(overDeep)).toEqual(createDefaultWorkspaceLayout());
  });

  it("enforces the bounded pane count", () => {
    let layout = createDefaultWorkspaceLayout();
    const splitTargets = ["primary"];
    for (let index = 1; index < 8; index += 1) {
      const targetGroupId = splitTargets.shift()!;
      const newGroupId = index === 1 ? "secondary" : `pane_${index}`;
      layout = splitWorkspacePane({
        direction: index % 2 ? "vertical" : "horizontal",
        layout,
        newGroupId,
        splitId: `split_${index}`,
        targetGroupId
      });
      splitTargets.push(targetGroupId, newGroupId);
    }
    expect(workspaceLayoutGroupIds(layout)).toHaveLength(8);
    expect(() => splitWorkspacePane({
      direction: "vertical",
      layout,
      newGroupId: "pane_9",
      splitId: "split_9",
      targetGroupId: "primary"
    })).toThrow("workspace-layout-pane-limit");
  });
});
