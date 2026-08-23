import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAULT_RIGHT_PANEL_WIDTH,
  MAX_VAULT_RIGHT_PANEL_WIDTH,
  MIN_VAULT_RIGHT_PANEL_WIDTH,
  captureVaultWorkspaceLayout,
  clampVaultRightPanelWidth,
  clampVaultRightPanelWidthForViewport,
  createDefaultVaultWorkspaceState,
  flushLatestWorkspaceState,
  normalizeVaultWorkspaceState,
  maxVaultRightPanelWidthForViewport,
  restoreVaultWorkspaceLayout,
  vaultWorkspaceLayoutFitsEncryptedDocument,
  vaultWorkspaceStateFitsEncryptedDocument
} from "./workspaceState";

describe("vault workspace state", () => {
  it("flushes a newer layout created while an earlier exit save is in flight", async () => {
    let current = { tab: "first" };
    let lastSaved = "";
    const saved: string[] = [];
    const result = await flushLatestWorkspaceState({
      getCurrentState: () => current,
      getLastSavedSerialization: () => lastSaved,
      save: async (_state, serialization) => {
        saved.push(serialization);
        lastSaved = serialization;
        if (saved.length === 1) current = { tab: "newer" };
      }
    });

    expect(result).toEqual({ passes: 2, stable: true });
    expect(saved).toEqual([
      JSON.stringify({ tab: "first" }),
      JSON.stringify({ tab: "newer" })
    ]);
  });

  it("stops navigation flush when the layout never becomes stable", async () => {
    let version = 0;
    let lastSaved = "";
    const result = await flushLatestWorkspaceState({
      getCurrentState: () => ({ version }),
      getLastSavedSerialization: () => lastSaved,
      maxPasses: 3,
      save: async (_state, serialization) => {
        lastSaved = serialization;
        version += 1;
      }
    });

    expect(result).toEqual({ passes: 3, stable: false });
  });

  it("creates Obsidian-compatible graph and panel defaults", () => {
    const state = createDefaultVaultWorkspaceState();
    expect(state).toMatchObject({
      version: 1,
      activeTabGroupId: "primary",
      layout: { type: "pane", groupId: "primary" },
      tabGroups: [{ id: "primary", tabs: [], activeTab: null }],
      left: { open: true, mode: "files" },
      right: { open: true, mode: "backlinks", width: DEFAULT_VAULT_RIGHT_PANEL_WIDTH },
      viewMode: "live-preview",
      bookmarks: [],
      searchBookmarks: [],
      plugins: {
        calendar: {
          folderId: null,
          open: true,
          templateEntryId: null
        }
      },
      graphBookmarks: [],
      namedWorkspaces: [],
      globalGraph: { settings: { scope: "global", showOrphans: true, animate: false } },
      localGraph: {
        settings: { scope: "local", depth: 1, incoming: true, outgoing: true, neighborLinks: false }
      }
    });
  });

  it("normalizes and restores a bounded recursive pane layout", () => {
    const nested = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      layout: {
        type: "split",
        id: "split_root",
        direction: "vertical",
        ratio: 0.72,
        first: { type: "pane", groupId: "primary" },
        second: {
          type: "split",
          id: "split_nested",
          direction: "horizontal",
          ratio: 0.64,
          first: { type: "pane", groupId: "secondary" },
          second: { type: "pane", groupId: "pane_third" }
        }
      },
      tabs: [
        { kind: "entry", entryId: "left" },
        { kind: "entry", entryId: "right", instanceId: "secondary" },
        { kind: "entry", entryId: "third", instanceId: "pane_third" }
      ],
      activeTab: { kind: "entry", entryId: "third", instanceId: "pane_third" },
      activeTabGroupId: "pane_third",
      tabGroups: [
        { id: "primary", tabs: [{ kind: "entry", entryId: "left" }], activeTab: { kind: "entry", entryId: "left" } },
        { id: "secondary", tabs: [{ kind: "entry", entryId: "right", instanceId: "secondary" }], activeTab: { kind: "entry", entryId: "right", instanceId: "secondary" } },
        { id: "pane_third", tabs: [{ kind: "entry", entryId: "third", instanceId: "pane_third" }], activeTab: { kind: "entry", entryId: "third", instanceId: "pane_third" } }
      ]
    });
    expect(nested.layout).toMatchObject({
      type: "split",
      direction: "vertical",
      ratio: 0.72,
      second: { type: "split", direction: "horizontal", ratio: 0.64 }
    });

    const restored = restoreVaultWorkspaceLayout(
      createDefaultVaultWorkspaceState(),
      captureVaultWorkspaceLayout(nested),
      new Set(["left", "right", "third"])
    );
    expect(restored.layout).toEqual(nested.layout);
    expect(restored.activeTabGroupId).toBe("pane_third");

    const migratedLegacy = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      layout: undefined,
      split: { direction: "horizontal", ratio: 0.72 },
      tabGroups: [
        { id: "primary", tabs: [{ kind: "entry", entryId: "left" }] },
        { id: "secondary", tabs: [{ kind: "entry", entryId: "right", instanceId: "secondary" }] }
      ]
    });
    expect(migratedLegacy.layout).toMatchObject({ type: "split", direction: "horizontal", ratio: 0.72 });
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
      searchBookmarks: [
        { id: "search-a", label: "프로젝트", query: "tag:project", createdAt: 456 },
        { id: "search-a", label: "중복", query: "ignored", createdAt: 999 },
        { id: "bad/id", label: "제외", query: "path:secret", createdAt: 123 },
        { id: "empty", label: "빈 검색", query: "   ", createdAt: 1 }
      ],
      viewMode: "reading",
      plugins: {
        calendar: {
          cursorMonth: "2026-08",
          folderId: "daily-notes",
          open: false,
          templateEntryId: "daily-template"
        }
      },
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
    expect(state.tabGroups).toEqual([{
      id: "primary",
      tabs: [{ kind: "entry", entryId: "note-a" }, { kind: "global-graph" }],
      activeTab: { kind: "entry", entryId: "note-a" }
    }]);
    expect(state.expandedFolderIds).toEqual(["folder-a", "folder-b"]);
    expect(state.searchQuery).toBe("tag:project");
    expect(state.searchBookmarks).toEqual([
      { id: "search-a", label: "프로젝트", query: "tag:project", createdAt: 456 }
    ]);
    expect(state.plugins.calendar).toEqual({
      cursorMonth: "2026-08",
      folderId: "daily-notes",
      open: false,
      templateEntryId: "daily-template"
    });
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

  it("normalizes two encrypted tab groups and migrates legacy flat workspaces into primary", () => {
    const defaults = createDefaultVaultWorkspaceState();
    const split = normalizeVaultWorkspaceState({
      ...defaults,
      tabs: [
        { kind: "entry", entryId: "left" },
        { kind: "entry", entryId: "right", pinned: true }
      ],
      activeTab: { kind: "entry", entryId: "right", pinned: true },
      activeTabGroupId: "secondary",
      layout: {
        type: "split",
        id: "split_two",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", groupId: "primary" },
        second: { type: "pane", groupId: "secondary" }
      },
      tabGroups: [
        {
          id: "primary",
          tabs: [{ kind: "entry", entryId: "left" }],
          activeTab: { kind: "entry", entryId: "left" }
        },
        {
          id: "secondary",
          tabs: [{ kind: "entry", entryId: "right", pinned: true }],
          activeTab: { kind: "entry", entryId: "right", pinned: true }
        }
      ]
    });
    expect(split.activeTabGroupId).toBe("secondary");
    expect(split.activeTab).toEqual({ kind: "entry", entryId: "right", pinned: true });
    expect(split.tabGroups).toEqual([
      {
        id: "primary",
        tabs: [{ kind: "entry", entryId: "left" }],
        activeTab: { kind: "entry", entryId: "left" }
      },
      {
        id: "secondary",
        tabs: [{ kind: "entry", entryId: "right", pinned: true }],
        activeTab: { kind: "entry", entryId: "right", pinned: true }
      }
    ]);

    const legacy = normalizeVaultWorkspaceState({
      ...defaults,
      tabGroups: undefined,
      activeTabGroupId: undefined,
      tabs: [{ kind: "entry", entryId: "legacy" }],
      activeTab: { kind: "entry", entryId: "legacy" }
    });
    expect(legacy.activeTabGroupId).toBe("primary");
    expect(legacy.tabGroups).toEqual([{
      id: "primary",
      tabs: [{ kind: "entry", entryId: "legacy" }],
      activeTab: { kind: "entry", entryId: "legacy" }
    }]);
  });

  it("preserves separate tab instances when the same entry is open in both panes", () => {
    const defaults = createDefaultVaultWorkspaceState();
    const state = normalizeVaultWorkspaceState({
      ...defaults,
      tabs: [
        { kind: "entry", entryId: "shared" },
        { kind: "entry", entryId: "shared", instanceId: "secondary" }
      ],
      activeTab: { kind: "entry", entryId: "shared", instanceId: "secondary" },
      activeTabGroupId: "secondary",
      layout: {
        type: "split",
        id: "split_shared",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", groupId: "primary" },
        second: { type: "pane", groupId: "secondary" }
      },
      tabGroups: [
        {
          id: "primary",
          tabs: [{ kind: "entry", entryId: "shared" }],
          activeTab: { kind: "entry", entryId: "shared" }
        },
        {
          id: "secondary",
          tabs: [{ kind: "entry", entryId: "shared", instanceId: "secondary" }],
          activeTab: { kind: "entry", entryId: "shared", instanceId: "secondary" }
        }
      ]
    });
    expect(state.tabs).toHaveLength(2);
    expect(state.tabGroups[0].tabs[0]).toEqual({ kind: "entry", entryId: "shared" });
    expect(state.tabGroups[1].tabs[0]).toEqual({
      kind: "entry",
      entryId: "shared",
      instanceId: "secondary"
    });
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

  it("clamps the encrypted right-panel width and migrates older workspaces", () => {
    expect(clampVaultRightPanelWidth(Number.NaN)).toBe(DEFAULT_VAULT_RIGHT_PANEL_WIDTH);
    expect(clampVaultRightPanelWidth(MIN_VAULT_RIGHT_PANEL_WIDTH - 200)).toBe(MIN_VAULT_RIGHT_PANEL_WIDTH);
    expect(clampVaultRightPanelWidth(MAX_VAULT_RIGHT_PANEL_WIDTH + 200)).toBe(MAX_VAULT_RIGHT_PANEL_WIDTH);
    expect(clampVaultRightPanelWidth(337.6)).toBe(338);

    const migrated = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      right: { open: true, mode: "outline" }
    });
    expect(migrated.right.width).toBe(DEFAULT_VAULT_RIGHT_PANEL_WIDTH);

    const bounded = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      right: { open: true, mode: "properties", width: 9_999 }
    });
    expect(bounded.right.width).toBe(MAX_VAULT_RIGHT_PANEL_WIDTH);
  });

  it("preserves a 280px editor while clamping the desktop right panel", () => {
    expect(maxVaultRightPanelWidthForViewport(761, true)).toBe(267);
    expect(maxVaultRightPanelWidthForViewport(900, true)).toBe(406);
    expect(maxVaultRightPanelWidthForViewport(901, true)).toBe(347);
    expect(maxVaultRightPanelWidthForViewport(761, false)).toBe(437);
    expect(maxVaultRightPanelWidthForViewport(1_440, true)).toBe(MAX_VAULT_RIGHT_PANEL_WIDTH);
    expect(clampVaultRightPanelWidthForViewport(480, 761, true)).toBe(267);
    expect(clampVaultRightPanelWidthForViewport(200, 761, true)).toBe(MIN_VAULT_RIGHT_PANEL_WIDTH);
    expect(maxVaultRightPanelWidthForViewport(390, true)).toBe(MAX_VAULT_RIGHT_PANEL_WIDTH);
  });

  it("keeps Daily Notes settings independent of the selected folder and normalizes invalid ids", () => {
    const state = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      selectedFolderId: "currently-selected",
      plugins: {
        calendar: {
          cursorMonth: "2026-08",
          folderId: 42,
          open: true,
          templateEntryId: "bad/id"
        }
      }
    });

    expect(state.selectedFolderId).toBe("currently-selected");
    expect(state.plugins.calendar).toEqual({
      cursorMonth: "2026-08",
      folderId: null,
      open: true,
      templateEntryId: null
    });

    const legacyState = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      plugins: { calendar: { cursorMonth: "2026-08", open: false } }
    });
    expect(legacyState.plugins.calendar).toEqual({
      cursorMonth: "2026-08",
      folderId: null,
      open: false,
      templateEntryId: null
    });
    expect(legacyState.plugins.templates).toEqual({
      folderPath: null,
      includeDescendants: true
    });
  });

  it("normalizes encrypted Templates folder settings without accepting traversal paths", () => {
    const state = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      plugins: {
        calendar: { cursorMonth: "2026-08", open: true },
        templates: { folderPath: "Knowledge/Templates", includeDescendants: false }
      }
    });
    expect(state.plugins.templates).toEqual({
      folderPath: "Knowledge/Templates",
      includeDescendants: false
    });

    const unsafe = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      plugins: {
        calendar: { cursorMonth: "2026-08", open: true },
        templates: { folderPath: "../Private", includeDescendants: "yes" }
      }
    });
    expect(unsafe.plugins.templates).toEqual({
      folderPath: null,
      includeDescendants: true
    });
  });

  it("restores the outline right-panel mode", () => {
    const state = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      right: { open: true, mode: "outline" }
    });

    expect(state.right).toEqual({
      open: true,
      mode: "outline",
      width: DEFAULT_VAULT_RIGHT_PANEL_WIDTH
    });
  });

  it("restores the encrypted File Recovery right-panel mode", () => {
    const state = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      right: { open: true, mode: "history" }
    });

    expect(state.right).toEqual({
      open: true,
      mode: "history",
      width: DEFAULT_VAULT_RIGHT_PANEL_WIDTH
    });
  });

  it("normalizes pinned tabs and general bookmarks while migrating legacy bookmark arrays", () => {
    const state = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      tabs: [
        { kind: "entry", entryId: "note-a", pinned: true },
        { kind: "global-graph", pinned: false }
      ],
      bookmarks: [
        { kind: "entry", id: "entry-a", entryId: "note-a", label: "중요 노트", path: "Project/중요.md", createdAt: 1 },
        { kind: "entry", id: "bad-path", entryId: "note-b", label: "제외", path: "bad\u0000path", createdAt: 2 },
        { kind: "search", id: "shared-id", label: "검색", query: "tag:project", createdAt: 3 }
      ],
      graphBookmarks: [{
        id: "shared-id",
        label: "그래프",
        createdAt: 4,
        settings: { scope: "global" },
        viewport: { centerX: 0, centerY: 0, zoom: 1 }
      }],
      searchBookmarks: [{ id: "legacy-search", label: "기존 검색", query: "path:Archive", createdAt: 5 }]
    });

    expect(state.tabs).toEqual([
      { kind: "entry", entryId: "note-a", pinned: true },
      { kind: "global-graph" }
    ]);
    expect(state.bookmarks.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      "entry:entry-a",
      "search:shared-id",
      "graph:shared-id",
      "search:legacy-search"
    ]);
    expect(state.searchBookmarks.map(({ id }) => id)).toEqual(["shared-id", "legacy-search"]);
    expect(state.graphBookmarks.map(({ id }) => id)).toEqual(["shared-id"]);
  });

  it("captures bounded named workspace layouts without drafts, keys, or nested workspace records", () => {
    const state = normalizeVaultWorkspaceState({
      ...createDefaultVaultWorkspaceState(),
      tabs: [{ kind: "entry", entryId: "note-a", pinned: true }],
      activeTab: { kind: "entry", entryId: "note-a", pinned: true },
      bookmarks: [{ kind: "entry", id: "bookmark-a", entryId: "note-a", label: "노트", path: "Folder/노트.md", createdAt: 1 }],
      namedWorkspaces: []
    });
    const snapshot = captureVaultWorkspaceLayout(state);

    expect(vaultWorkspaceLayoutFitsEncryptedDocument(snapshot)).toBe(true);
    expect(snapshot.tabs).toEqual([{ kind: "entry", entryId: "note-a", pinned: true }]);
    expect(snapshot.bookmarks).toHaveLength(1);
    expect(snapshot).not.toHaveProperty("namedWorkspaces");
    expect(JSON.stringify(snapshot)).not.toMatch(/encryptedBody|wrappedKey|markdown/iu);
  });

  it("restores a named layout fail closed for ACL-missing entry ids", () => {
    const current = createDefaultVaultWorkspaceState();
    current.namedWorkspaces = [{
      id: "workspace-a",
      label: "업무",
      createdAt: 1,
      updatedAt: 1,
      snapshot: captureVaultWorkspaceLayout(current)
    }];
    const requested = normalizeVaultWorkspaceState({
      ...current,
      tabs: [
        { kind: "entry", entryId: "allowed", pinned: true },
        { kind: "entry", entryId: "revoked" },
        { kind: "global-graph" }
      ],
      activeTab: { kind: "entry", entryId: "revoked" },
      selectedFolderId: "missing-folder",
      expandedFolderIds: ["allowed-folder", "missing-folder"],
      bookmarks: [{ kind: "entry", id: "revoked-bookmark", entryId: "revoked", label: "이전 제목", path: "Private/이전.md", createdAt: 2 }],
      plugins: {
        calendar: { cursorMonth: "2026-08", folderId: "missing-folder", open: true, templateEntryId: "revoked" },
        templates: { folderPath: "Knowledge/Templates", includeDescendants: false }
      },
      localGraph: {
        ...current.localGraph,
        settings: { ...current.localGraph.settings, root: { entryId: "revoked" } }
      }
    });
    const restored = restoreVaultWorkspaceLayout(
      current,
      captureVaultWorkspaceLayout(requested),
      new Set(["allowed"]),
      new Set(["allowed-folder"])
    );

    expect(restored.tabs).toEqual([
      { kind: "entry", entryId: "allowed", pinned: true },
      { kind: "global-graph" }
    ]);
    expect(restored.tabGroups).toEqual([{
      id: "primary",
      tabs: [
        { kind: "entry", entryId: "allowed", pinned: true },
        { kind: "global-graph" }
      ],
      activeTab: { kind: "entry", entryId: "allowed", pinned: true }
    }]);
    expect(restored.activeTab).toEqual({ kind: "entry", entryId: "allowed", pinned: true });
    expect(restored.selectedFolderId).toBeNull();
    expect(restored.expandedFolderIds).toEqual(["allowed-folder"]);
    expect(restored.plugins.calendar).toMatchObject({ folderId: null, templateEntryId: null });
    expect(restored.plugins.templates).toEqual({ folderPath: "Knowledge/Templates", includeDescendants: false });
    expect(restored.localGraph.settings.root).toBe("follow-active");
    expect(restored.bookmarks[0]).toMatchObject({ kind: "entry", entryId: "revoked" });
    expect(restored.namedWorkspaces).toHaveLength(1);
  });

  it("drops an ACL-empty secondary pane and restores the primary group atomically", () => {
    const current = createDefaultVaultWorkspaceState();
    const requested = normalizeVaultWorkspaceState({
      ...current,
      tabs: [
        { kind: "entry", entryId: "allowed" },
        { kind: "entry", entryId: "revoked" }
      ],
      activeTab: { kind: "entry", entryId: "revoked" },
      activeTabGroupId: "secondary",
      layout: {
        type: "split",
        id: "split_acl",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", groupId: "primary" },
        second: { type: "pane", groupId: "secondary" }
      },
      tabGroups: [
        {
          id: "primary",
          tabs: [{ kind: "entry", entryId: "allowed" }],
          activeTab: { kind: "entry", entryId: "allowed" }
        },
        {
          id: "secondary",
          tabs: [{ kind: "entry", entryId: "revoked" }],
          activeTab: { kind: "entry", entryId: "revoked" }
        }
      ]
    });
    const restored = restoreVaultWorkspaceLayout(
      current,
      captureVaultWorkspaceLayout(requested),
      new Set(["allowed"])
    );
    expect(restored.activeTabGroupId).toBe("primary");
    expect(restored.activeTab).toEqual({ kind: "entry", entryId: "allowed" });
    expect(restored.tabGroups).toEqual([{
      id: "primary",
      tabs: [{ kind: "entry", entryId: "allowed" }],
      activeTab: { kind: "entry", entryId: "allowed" }
    }]);
    expect(restored.layout).toEqual({ type: "pane", groupId: "primary" });
  });

  it("drops oversized or duplicate named workspace records during normalization", () => {
    const fallback = createDefaultVaultWorkspaceState();
    const normalSnapshot = captureVaultWorkspaceLayout(fallback);
    const oversizedSnapshot = {
      ...normalSnapshot,
      globalGraph: {
        ...normalSnapshot.globalGraph,
        settings: {
          ...normalSnapshot.globalGraph.settings,
          common: {
            ...normalSnapshot.globalGraph.settings.common,
            groups: Array.from({ length: 20 }, (_, index) => ({
              id: `group-${index}`,
              query: `${index}-${"x".repeat(1_995)}`,
              color: "#7c5cff",
              order: index
            }))
          }
        }
      }
    };
    const state = normalizeVaultWorkspaceState({
      ...fallback,
      namedWorkspaces: [
        { id: "workspace-a", label: "첫 번째", createdAt: 1, updatedAt: 2, snapshot: normalSnapshot },
        { id: "workspace-a", label: "중복", createdAt: 3, updatedAt: 3, snapshot: normalSnapshot },
        { id: "workspace-b", label: "너무 큼", createdAt: 4, updatedAt: 4, snapshot: oversizedSnapshot }
      ]
    });

    expect(state.namedWorkspaces).toHaveLength(1);
    expect(state.namedWorkspaces[0]).toMatchObject({ id: "workspace-a", label: "첫 번째" });
  });

  it("measures snapshot limits in UTF-8 bytes instead of JavaScript character count", () => {
    const fallback = createDefaultVaultWorkspaceState();
    const snapshot = {
      ...captureVaultWorkspaceLayout(fallback),
      searchQuery: "한".repeat(2_000),
      globalGraph: {
        ...fallback.globalGraph,
        settings: {
          ...fallback.globalGraph.settings,
          common: {
            ...fallback.globalGraph.settings.common,
            groups: [{ id: "korean", query: "가".repeat(2_000), color: "#7c5cff", order: 0 }]
          }
        }
      }
    };

    expect(JSON.stringify(snapshot).length).toBeLessThan(12_000);
    expect(vaultWorkspaceLayoutFitsEncryptedDocument(snapshot)).toBe(false);
  });

  it("enforces an aggregate UTF-8 budget across otherwise valid named snapshots", () => {
    const fallback = createDefaultVaultWorkspaceState();
    const snapshot = {
      ...captureVaultWorkspaceLayout(fallback),
      searchQuery: "한".repeat(1_000),
      globalGraph: {
        ...fallback.globalGraph,
        settings: {
          ...fallback.globalGraph.settings,
          common: {
            ...fallback.globalGraph.settings.common,
            groups: [{ id: "korean", query: "가".repeat(1_700), color: "#7c5cff", order: 0 }]
          }
        }
      }
    };
    expect(vaultWorkspaceLayoutFitsEncryptedDocument(snapshot)).toBe(true);
    const state = normalizeVaultWorkspaceState({
      ...fallback,
      namedWorkspaces: Array.from({ length: 32 }, (_, index) => ({
        id: `workspace-${index}`,
        label: `한글 워크스페이스 ${index}`,
        createdAt: index,
        updatedAt: index,
        snapshot
      }))
    });

    expect(state.namedWorkspaces.length).toBeGreaterThan(0);
    expect(state.namedWorkspaces.length).toBeLessThan(32);
    expect(vaultWorkspaceStateFitsEncryptedDocument(state)).toBe(true);
  });

  it("fails closed when the normalized encrypted workspace plaintext exceeds the total budget", () => {
    const fallback = createDefaultVaultWorkspaceState();
    const hugeGraphBookmarks = Array.from({ length: 64 }, (_, index) => ({
      kind: "graph",
      id: `graph-${index}`,
      label: `그래프 ${index}`,
      createdAt: index,
      settings: {
        ...fallback.globalGraph.settings,
        common: {
          ...fallback.globalGraph.settings.common,
          groups: Array.from({ length: 4 }, (__, groupIndex) => ({
            id: `group-${groupIndex}`,
            query: "한".repeat(2_000),
            color: "#7c5cff",
            order: groupIndex
          }))
        }
      },
      viewport: fallback.globalGraph.viewport
    }));
    const state = normalizeVaultWorkspaceState({ ...fallback, bookmarks: hugeGraphBookmarks });

    expect(state).toEqual(fallback);
    expect(vaultWorkspaceStateFitsEncryptedDocument(state)).toBe(true);
  });
});
