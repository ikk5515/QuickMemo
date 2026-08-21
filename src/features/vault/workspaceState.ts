import {
  GRAPH_SETTING_RANGES,
  createDefaultGlobalGraphSettings,
  createDefaultLocalGraphSettings,
  type GlobalGraphViewSettings,
  type GraphCommonSettings,
  type GraphGroup,
  type GraphSettingsSectionId,
  type GraphViewport,
  type LocalGraphViewSettings
} from "../graph";

export type VaultLeftPanelMode = "files" | "search" | "tags";
export type VaultRightPanelMode = "backlinks" | "outgoing" | "properties" | "local-graph";
export type VaultMarkdownViewMode = "source" | "live-preview" | "reading";

export type PersistedVaultTab =
  | { kind: "entry"; entryId: string }
  | { kind: "global-graph" };

export interface PersistedGraphPaneState<TSettings> {
  settings: TSettings;
  viewport: GraphViewport;
  collapsedSections: GraphSettingsSectionId[];
}

export interface PersistedGraphBookmark {
  createdAt: number;
  id: string;
  label: string;
  settings: GlobalGraphViewSettings;
  viewport: GraphViewport;
}

export interface VaultPersistedWorkspaceState {
  version: 1;
  tabs: PersistedVaultTab[];
  activeTab: PersistedVaultTab | null;
  left: { open: boolean; mode: VaultLeftPanelMode };
  right: { open: boolean; mode: VaultRightPanelMode };
  selectedFolderId: string | null;
  expandedFolderIds: string[];
  searchQuery: string;
  viewMode: VaultMarkdownViewMode;
  graphBookmarks: PersistedGraphBookmark[];
  globalGraph: PersistedGraphPaneState<GlobalGraphViewSettings>;
  localGraph: PersistedGraphPaneState<LocalGraphViewSettings>;
}

const defaultViewport: GraphViewport = { centerX: 0, centerY: 0, zoom: 1 };
const graphSections = new Set<GraphSettingsSectionId>(["filters", "groups", "display", "forces", "local"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function safeId(value: unknown): string | undefined {
  const id = safeString(value, 160);
  return id && id.trim() === id && !id.includes("/") ? id : undefined;
}

function finiteInRange(value: unknown, fallback: number, range: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function safeColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
}

function normalizeGroups(value: unknown): GraphGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  const groups: GraphGroup[] = [];
  for (const item of value.slice(0, 64)) {
    if (!isRecord(item)) {
      continue;
    }
    const id = safeId(item.id);
    const query = safeString(item.query, 2_000);
    const color = safeColor(item.color);
    if (!id || query === undefined || !color || ids.has(id)) {
      continue;
    }
    ids.add(id);
    groups.push({ id, query, color, order: groups.length });
  }
  return groups;
}

function normalizeCommon(value: unknown, fallback: GraphCommonSettings): GraphCommonSettings {
  const source = isRecord(value) ? value : {};
  return {
    query: safeString(source.query, 2_000) ?? fallback.query,
    showTags: booleanOr(source.showTags, fallback.showTags),
    showAttachments: booleanOr(source.showAttachments, fallback.showAttachments),
    existingFilesOnly: booleanOr(source.existingFilesOnly, fallback.existingFilesOnly),
    groups: normalizeGroups(source.groups),
    arrows: booleanOr(source.arrows, fallback.arrows),
    textFadeThreshold: finiteInRange(source.textFadeThreshold, fallback.textFadeThreshold, GRAPH_SETTING_RANGES.textFadeThreshold),
    nodeSize: finiteInRange(source.nodeSize, fallback.nodeSize, GRAPH_SETTING_RANGES.nodeSize),
    linkThickness: finiteInRange(source.linkThickness, fallback.linkThickness, GRAPH_SETTING_RANGES.linkThickness),
    centerForce: finiteInRange(source.centerForce, fallback.centerForce, GRAPH_SETTING_RANGES.centerForce),
    repelForce: finiteInRange(source.repelForce, fallback.repelForce, GRAPH_SETTING_RANGES.repelForce),
    linkForce: finiteInRange(source.linkForce, fallback.linkForce, GRAPH_SETTING_RANGES.linkForce),
    linkDistance: finiteInRange(source.linkDistance, fallback.linkDistance, GRAPH_SETTING_RANGES.linkDistance)
  };
}

function normalizeGlobalSettings(value: unknown): GlobalGraphViewSettings {
  const fallback = createDefaultGlobalGraphSettings();
  const source = isRecord(value) ? value : {};
  return {
    scope: "global",
    common: normalizeCommon(source.common, fallback.common),
    showOrphans: booleanOr(source.showOrphans, fallback.showOrphans),
    animate: booleanOr(source.animate, fallback.animate)
  };
}

function normalizeLocalSettings(value: unknown): LocalGraphViewSettings {
  const fallback = createDefaultLocalGraphSettings();
  const source = isRecord(value) ? value : {};
  const rootSource = source.root;
  const rootId = isRecord(rootSource) ? safeId(rootSource.entryId) : undefined;
  const rawDepth = finiteInRange(source.depth, fallback.depth, GRAPH_SETTING_RANGES.depth);
  const depth = Math.round(rawDepth) as LocalGraphViewSettings["depth"];
  return {
    scope: "local",
    common: normalizeCommon(source.common, fallback.common),
    root: rootId ? { entryId: rootId } : "follow-active",
    depth,
    incoming: booleanOr(source.incoming, fallback.incoming),
    outgoing: booleanOr(source.outgoing, fallback.outgoing),
    neighborLinks: booleanOr(source.neighborLinks, fallback.neighborLinks)
  };
}

function normalizeViewport(value: unknown): GraphViewport {
  const source = isRecord(value) ? value : {};
  return {
    centerX: finiteInRange(source.centerX, 0, { min: -10_000_000, max: 10_000_000 }),
    centerY: finiteInRange(source.centerY, 0, { min: -10_000_000, max: 10_000_000 }),
    zoom: finiteInRange(source.zoom, 1, GRAPH_SETTING_RANGES.zoom)
  };
}

function normalizeCollapsedSections(value: unknown): GraphSettingsSectionId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is GraphSettingsSectionId => (
    typeof item === "string" && graphSections.has(item as GraphSettingsSectionId)
  )))];
}

function normalizeTab(value: unknown): PersistedVaultTab | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "global-graph") {
    return { kind: "global-graph" };
  }
  const entryId = value.kind === "entry" ? safeId(value.entryId) : undefined;
  return entryId ? { kind: "entry", entryId } : null;
}

function normalizeGraphBookmarks(value: unknown): PersistedGraphBookmark[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  const bookmarks: PersistedGraphBookmark[] = [];
  for (const item of value.slice(0, 64)) {
    if (!isRecord(item)) {
      continue;
    }
    const id = safeId(item.id);
    const label = safeString(item.label, 120)?.trim();
    if (!id || !label || ids.has(id)) {
      continue;
    }
    ids.add(id);
    bookmarks.push({
      createdAt: finiteInRange(item.createdAt, 0, { min: 0, max: 9_000_000_000_000_000 }),
      id,
      label,
      settings: normalizeGlobalSettings(item.settings),
      viewport: normalizeViewport(item.viewport)
    });
  }
  return bookmarks;
}

function normalizePanelMode<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function createDefaultVaultWorkspaceState(): VaultPersistedWorkspaceState {
  return {
    version: 1,
    tabs: [],
    activeTab: null,
    left: { open: true, mode: "files" },
    right: { open: true, mode: "backlinks" },
    selectedFolderId: null,
    expandedFolderIds: [],
    searchQuery: "",
    viewMode: "live-preview",
    graphBookmarks: [],
    globalGraph: {
      settings: createDefaultGlobalGraphSettings(),
      viewport: { ...defaultViewport },
      collapsedSections: []
    },
    localGraph: {
      settings: createDefaultLocalGraphSettings(),
      viewport: { ...defaultViewport },
      collapsedSections: []
    }
  };
}

export function normalizeVaultWorkspaceState(value: unknown): VaultPersistedWorkspaceState {
  const fallback = createDefaultVaultWorkspaceState();
  if (!isRecord(value) || value.version !== 1) {
    return fallback;
  }
  const left = isRecord(value.left) ? value.left : {};
  const right = isRecord(value.right) ? value.right : {};
  const globalGraph = isRecord(value.globalGraph) ? value.globalGraph : {};
  const localGraph = isRecord(value.localGraph) ? value.localGraph : {};
  const tabs = Array.isArray(value.tabs)
    ? value.tabs.slice(0, 64).map(normalizeTab).filter((tab): tab is PersistedVaultTab => tab !== null)
    : [];
  const deduplicatedTabs = tabs.filter((tab, index) => tabs.findIndex((candidate) => (
    candidate.kind === tab.kind && (tab.kind === "global-graph" || candidate.kind === "entry" && candidate.entryId === tab.entryId)
  )) === index);
  const activeTab = normalizeTab(value.activeTab);
  const selectedFolderId = value.selectedFolderId === null ? null : safeId(value.selectedFolderId) ?? null;
  const expandedFolderIds = Array.isArray(value.expandedFolderIds)
    ? [...new Set(value.expandedFolderIds.slice(0, 5_000).map(safeId).filter((id): id is string => Boolean(id)))]
    : [];

  return {
    version: 1,
    tabs: deduplicatedTabs,
    activeTab,
    left: {
      open: booleanOr(left.open, fallback.left.open),
      mode: normalizePanelMode(left.mode, ["files", "search", "tags"], fallback.left.mode)
    },
    right: {
      open: booleanOr(right.open, fallback.right.open),
      mode: normalizePanelMode(right.mode, ["backlinks", "outgoing", "properties", "local-graph"], fallback.right.mode)
    },
    selectedFolderId,
    expandedFolderIds,
    searchQuery: safeString(value.searchQuery, 2_000) ?? "",
    viewMode: normalizePanelMode(value.viewMode, ["source", "live-preview", "reading"], fallback.viewMode),
    graphBookmarks: normalizeGraphBookmarks(value.graphBookmarks),
    globalGraph: {
      settings: normalizeGlobalSettings(globalGraph.settings),
      viewport: normalizeViewport(globalGraph.viewport),
      collapsedSections: normalizeCollapsedSections(globalGraph.collapsedSections)
    },
    localGraph: {
      settings: normalizeLocalSettings(localGraph.settings),
      viewport: normalizeViewport(localGraph.viewport),
      collapsedSections: normalizeCollapsedSections(localGraph.collapsedSections)
    }
  };
}
