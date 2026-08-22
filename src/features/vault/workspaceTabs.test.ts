import { describe, expect, it } from "vitest";
import {
  activateWorkspaceTabGroup,
  createDefaultWorkspaceTabGroups,
  openWorkspaceTabInGroup,
  planWorkspaceTabClose,
  reconcileWorkspaceTabGroups,
  removeWorkspaceTabFromGroups,
  toggleWorkspaceTabPinned,
} from "./workspaceTabs";

describe("workspace tab groups", () => {
  it("creates a right group with a distinct tab instance and keeps group-local activation", () => {
    const primary = openWorkspaceTabInGroup(createDefaultWorkspaceTabGroups(), "entry:a", "primary");
    const split = openWorkspaceTabInGroup(primary.groups, "entry:a:secondary", "secondary");
    expect(split).toEqual({
      activeTabGroupId: "secondary",
      activeTabId: "entry:a:secondary",
      groups: [
        { id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" },
        { id: "secondary", tabIds: ["entry:a:secondary"], activeTabId: "entry:a:secondary" }
      ]
    });
    expect(activateWorkspaceTabGroup(split.groups, "primary")).toMatchObject({
      activeTabGroupId: "primary",
      activeTabId: "entry:a"
    });
  });

  it("reconciles legacy flat tabs into primary and preserves a valid secondary group", () => {
    const result = reconcileWorkspaceTabGroups(
      [
        { id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" },
        { id: "secondary", tabIds: ["entry:b"], activeTabId: "entry:b" }
      ],
      ["entry:a", "entry:b", "entry:c"],
      "secondary",
      "entry:b"
    );
    expect(result.groups).toEqual([
      { id: "primary", tabIds: ["entry:a", "entry:c"], activeTabId: "entry:a" },
      { id: "secondary", tabIds: ["entry:b"], activeTabId: "entry:b" }
    ]);
    expect(result.activeTabGroupId).toBe("secondary");
  });

  it("keeps up to eight dynamically ordered groups without flattening their tab instances", () => {
    const groups = [
      { id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" },
      { id: "pane_three", tabIds: ["entry:c:pane_three"], activeTabId: "entry:c:pane_three" },
      { id: "secondary", tabIds: ["entry:b:secondary"], activeTabId: "entry:b:secondary" }
    ];
    const result = reconcileWorkspaceTabGroups(
      groups,
      ["entry:a", "entry:b:secondary", "entry:c:pane_three"],
      "pane_three",
      "entry:c:pane_three",
      ["primary", "secondary", "pane_three"]
    );
    expect(result.groups.map((group) => group.id)).toEqual(["primary", "secondary", "pane_three"]);
    expect(result.activeTabGroupId).toBe("pane_three");
  });

  it("closes within one group and removes an empty secondary group without losing primary", () => {
    const result = removeWorkspaceTabFromGroups([
      { id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" },
      { id: "secondary", tabIds: ["entry:b"], activeTabId: "entry:b" }
    ], "entry:b", "secondary");
    expect(result).toEqual({
      activeTabGroupId: "primary",
      activeTabId: "entry:a",
      groups: [{ id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" }]
    });
  });

  it("focuses the remaining secondary pane after closing the last primary tab", () => {
    const result = removeWorkspaceTabFromGroups([
      { id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" },
      { id: "secondary", tabIds: ["entry:b:secondary"], activeTabId: "entry:b:secondary" }
    ], "entry:a", "primary");
    expect(result.activeTabGroupId).toBe("secondary");
    expect(result.activeTabId).toBe("entry:b:secondary");
  });

  it("collapses an empty middle pane while preserving the other dynamic panes", () => {
    const result = removeWorkspaceTabFromGroups([
      { id: "primary", tabIds: ["entry:a"], activeTabId: "entry:a" },
      { id: "pane_middle", tabIds: ["entry:b:pane_middle"], activeTabId: "entry:b:pane_middle" },
      { id: "pane_last", tabIds: ["entry:c:pane_last"], activeTabId: "entry:c:pane_last" }
    ], "entry:b:pane_middle", "pane_middle");
    expect(result.groups.map((group) => group.id)).toEqual(["primary", "pane_last"]);
    expect(result.activeTabGroupId).toBe("primary");
  });
});

describe("workspace tab pinning", () => {
  it("blocks closing a pinned tab without changing active selection", () => {
    const tabs = [{ id: "a", pinned: true }, { id: "b" }];
    expect(planWorkspaceTabClose(tabs, "a", "a")).toEqual({
      blocked: true,
      nextActiveTabId: "a",
      tabs
    });
  });

  it("allows an explicit unpin followed by close and selects the neighbor", () => {
    const pinned = [{ id: "a", pinned: true }, { id: "b" }];
    const unpinned = toggleWorkspaceTabPinned(pinned, "a");
    const plan = planWorkspaceTabClose(unpinned, "a", "a");
    expect(unpinned[0].pinned).toBe(false);
    expect(plan).toEqual({ blocked: false, nextActiveTabId: "b", tabs: [{ id: "b" }] });
  });

  it("does not disturb the active tab when closing a background tab", () => {
    expect(planWorkspaceTabClose([{ id: "a" }, { id: "b" }], "b", "a")).toEqual({
      blocked: false,
      nextActiveTabId: "a",
      tabs: [{ id: "a" }]
    });
  });
});
