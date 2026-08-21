import { describe, expect, it } from "vitest";
import { createDefaultVaultWorkspaceState, normalizeVaultWorkspaceState } from "./workspaceState";

describe("vault workspace state", () => {
  it("creates Obsidian-compatible graph and panel defaults", () => {
    const state = createDefaultVaultWorkspaceState();
    expect(state).toMatchObject({
      version: 1,
      left: { open: true, mode: "files" },
      right: { open: true, mode: "backlinks" },
      viewMode: "live-preview",
      graphBookmarks: [],
      globalGraph: { settings: { scope: "global", showOrphans: true, animate: false } },
      localGraph: {
        settings: { scope: "local", depth: 1, incoming: true, outgoing: true, neighborLinks: false }
      }
    });
  });

  it("normalizes valid encrypted state while removing duplicates and unknown fields", () => {
    const state = normalizeVaultWorkspaceState({
      version: 1,
      tabs: [
        { kind: "entry", entryId: "note-a" },
        { kind: "entry", entryId: "note-a" },
        { kind: "global-graph" },
        { kind: "other", secret: "discard" }
      ],
      activeTab: { kind: "entry", entryId: "note-a" },
      left: { open: false, mode: "tags" },
      right: { open: true, mode: "local-graph" },
      selectedFolderId: "folder-a",
      expandedFolderIds: ["folder-a", "folder-a", "folder-b"],
      searchQuery: "tag:project",
      viewMode: "reading",
      graphBookmarks: [
        {
          id: "graph-a",
          label: "프로젝트 그래프",
          createdAt: 123,
          settings: { common: { query: "tag:project", nodeSize: 99 } },
          viewport: { centerX: 7, centerY: 8, zoom: 2 }
        },
        { id: "graph-a", label: "중복", settings: {}, viewport: {} },
        { id: "bad/id", label: "제외", settings: {}, viewport: {} }
      ],
      globalGraph: {
        settings: {
          scope: "anything",
          common: {
            query: "tag:project",
            groups: [
              { id: "group-a", query: "tag:a", color: "#7c5cff", order: 99 },
              { id: "group-a", query: "tag:b", color: "#fff", order: 2 },
              { id: "bad-color", query: "", color: "url(javascript:1)", order: 3 }
            ],
            centerForce: 3,
            repelForce: -2
          },
          showOrphans: false,
          animate: true
        },
        viewport: { centerX: 14, centerY: -20, zoom: 99 },
        collapsedSections: ["filters", "filters", "forces", "unknown"]
      },
      localGraph: {
        settings: { depth: 9, root: { entryId: "note-a" } },
        viewport: { zoom: 0 },
        collapsedSections: []
      }
    });

    expect(state.tabs).toEqual([{ kind: "entry", entryId: "note-a" }, { kind: "global-graph" }]);
    expect(state.expandedFolderIds).toEqual(["folder-a", "folder-b"]);
    expect(state.searchQuery).toBe("tag:project");
    expect(state.graphBookmarks).toHaveLength(1);
    expect(state.graphBookmarks[0]).toMatchObject({
      id: "graph-a",
      label: "프로젝트 그래프",
      createdAt: 123,
      settings: { scope: "global", common: { query: "tag:project", nodeSize: 5 } },
      viewport: { centerX: 7, centerY: 8, zoom: 2 }
    });
    expect(state.globalGraph.settings.common.groups).toEqual([
      { id: "group-a", query: "tag:a", color: "#7c5cff", order: 0 }
    ]);
    expect(state.globalGraph.settings.common.centerForce).toBe(1);
    expect(state.globalGraph.settings.common.repelForce).toBe(0);
    expect(state.globalGraph.viewport.zoom).toBe(8);
    expect(state.globalGraph.collapsedSections).toEqual(["filters", "forces"]);
    expect(state.localGraph.settings).toMatchObject({ depth: 5, root: { entryId: "note-a" } });
    expect(state.localGraph.viewport.zoom).toBe(1 / 128);
  });

  it("fails closed to defaults for unsupported versions and malformed values", () => {
    expect(normalizeVaultWorkspaceState({ version: 2, tabs: [{ kind: "entry", entryId: "secret" }] }))
      .toEqual(createDefaultVaultWorkspaceState());
    const state = normalizeVaultWorkspaceState({
      version: 1,
      tabs: [{ kind: "entry", entryId: "bad/id" }],
      activeTab: { kind: "entry", entryId: "x".repeat(300) },
      left: { open: "yes", mode: "unknown" },
      right: null,
      expandedFolderIds: [null, "bad/id"],
      globalGraph: { settings: { common: { query: "x".repeat(3_000) } } }
    });
    expect(state.tabs).toEqual([]);
    expect(state.activeTab).toBeNull();
    expect(state.left).toEqual({ open: true, mode: "files" });
    expect(state.expandedFolderIds).toEqual([]);
    expect(state.globalGraph.settings.common.query).toBe("");
  });
});
