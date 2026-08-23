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
import { localMonthKey, normalizeDailyMonth } from "../calendar/dailyNotes";
import {
  createDefaultWorkspaceLayout,
  isWorkspacePaneGroupId,
  normalizeWorkspaceLayout,
  reconcileWorkspaceLayoutGroups,
  resizeWorkspaceSplit,
  splitWorkspacePane,
  workspaceLayoutGroupIds,
  type VaultWorkspacePaneNode
} from "./workspaceLayout";

export type VaultLeftPanelMode = "files" | "search" | "tags" | "bookmarks";
export type VaultRightPanelMode = "backlinks" | "outgoing" | "properties" | "outline" | "local-graph" | "history";
export type VaultMarkdownViewMode = "source" | "live-preview" | "reading";

export type PersistedVaultTab =
  | { kind: "entry"; entryId: string; instanceId?: PersistedVaultTabGroupId; pinned?: true }
  | { kind: "global-graph"; pinned?: true };

export type PersistedVaultTabGroupId = string;
export type VaultWorkspaceSplitDirection = "vertical" | "horizontal";

export interface VaultWorkspaceSplitState {
  direction: VaultWorkspaceSplitDirection;
  ratio: number;
}

export interface PersistedVaultTabGroup {
  activeTab: PersistedVaultTab | null;
  id: PersistedVaultTabGroupId;
  tabs: PersistedVaultTab[];
}

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

export interface PersistedSearchBookmark {
  createdAt: number;
  id: string;
  label: string;
  query: string;
}

export interface PersistedEntryBookmark {
  createdAt: number;
  entryId: string;
  id: string;
  label: string;
  path: string;
}

export type PersistedVaultBookmark =
  | (PersistedEntryBookmark & { kind: "entry" })
  | (PersistedGraphBookmark & { kind: "graph" })
  | (PersistedSearchBookmark & { kind: "search" });

export interface VaultWorkspaceLayoutSnapshot {
  tabs: PersistedVaultTab[];
  activeTab: PersistedVaultTab | null;
  tabGroups: PersistedVaultTabGroup[];
  activeTabGroupId: PersistedVaultTabGroupId;
  layout: VaultWorkspacePaneNode;
  left: { open: boolean; mode: VaultLeftPanelMode };
  right: { open: boolean; mode: VaultRightPanelMode };
  selectedFolderId: string | null;
  expandedFolderIds: string[];
  searchQuery: string;
  bookmarks: PersistedVaultBookmark[];
  viewMode: VaultMarkdownViewMode;
  globalGraph: PersistedGraphPaneState<GlobalGraphViewSettings>;
  localGraph: PersistedGraphPaneState<LocalGraphViewSettings>;
  plugins: {
    calendar: {
      cursorMonth: string;
      folderId?: string | null;
      open: boolean;
      templateEntryId?: string | null;
    };
    templates: {
      folderPath?: string | null;
      includeDescendants: boolean;
    };
  };
}

export interface PersistedNamedWorkspace {
  createdAt: number;
  id: string;
  label: string;
  snapshot: VaultWorkspaceLayoutSnapshot;
  updatedAt: number;
}

export const MAX_VAULT_BOOKMARKS = 64;
export const MAX_NAMED_WORKSPACES = 32;
export const MAX_NAMED_WORKSPACE_SNAPSHOT_SERIALIZED_BYTES = 12_000;
export const MAX_NAMED_WORKSPACES_SERIALIZED_BYTES = 300_000;
// AES payloads are base64 encoded before Firestore storage. Keeping the UTF-8
// plaintext below 480 KiB leaves substantial room for IV/wrapped-key fields,
// ciphertext authentication tag, base64 expansion, and Firestore field names.
export const MAX_ENCRYPTED_WORKSPACE_PLAINTEXT_BYTES = 480_000;

export interface VaultPersistedWorkspaceState {
  version: 1;
  tabs: PersistedVaultTab[];
  activeTab: PersistedVaultTab | null;
  tabGroups: PersistedVaultTabGroup[];
  activeTabGroupId: PersistedVaultTabGroupId;
  layout: VaultWorkspacePaneNode;
  left: { open: boolean; mode: VaultLeftPanelMode };
  right: { open: boolean; mode: VaultRightPanelMode };
  selectedFolderId: string | null;
  expandedFolderIds: string[];
  searchQuery: string;
  bookmarks: PersistedVaultBookmark[];
  searchBookmarks: PersistedSearchBookmark[];
  viewMode: VaultMarkdownViewMode;
  graphBookmarks: PersistedGraphBookmark[];
  namedWorkspaces: PersistedNamedWorkspace[];
  globalGraph: PersistedGraphPaneState<GlobalGraphViewSettings>;
  localGraph: PersistedGraphPaneState<LocalGraphViewSettings>;
  plugins: {
    calendar: {
      cursorMonth: string;
      folderId?: string | null;
      open: boolean;
      templateEntryId?: string | null;
    };
    templates: {
      folderPath?: string | null;
      includeDescendants: boolean;
    };
  };
}

export interface FlushLatestWorkspaceStateInput<TState> {
  getCurrentState: () => TState;
  getLastSavedSerialization: () => string;
  maxPasses?: number;
  save: (state: TState, serialization: string) => Promise<void>;
}

export interface FlushLatestWorkspaceStateResult {
  passes: number;
  stable: boolean;
}

/**
 * Persist until the snapshot submitted to the server is still the newest
 * local state after the write completes. Navigation guards stay interactive,
 * so a single captured snapshot must not clear a newer tab or viewport change.
 */
export async function flushLatestWorkspaceState<TState>({
  getCurrentState,
  getLastSavedSerialization,
  maxPasses = 12,
  save
}: FlushLatestWorkspaceStateInput<TState>): Promise<FlushLatestWorkspaceStateResult> {
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const state = getCurrentState();
    const serialization = JSON.stringify(state);
    if (serialization === getLastSavedSerialization()) {
      return { passes: pass - 1, stable: true };
    }
    await save(state, serialization);
    if (JSON.stringify(getCurrentState()) === serialization) {
      return { passes: pass, stable: true };
    }
  }
  return { passes: maxPasses, stable: false };
}

const defaultViewport: GraphViewport = { centerX: 0, centerY: 0, zoom: 1 };
const graphSections = new Set<GraphSettingsSectionId>(["filters", "groups", "display", "forces", "local"]);
const workspaceTextEncoder = new TextEncoder();

function serializedUtf8Bytes(value: unknown) {
  return workspaceTextEncoder.encode(JSON.stringify(value)).byteLength;
}

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

function safePath(value: unknown): string | undefined {
  const path = safeString(value, 1_000)?.trim().normalize("NFC");
  if (!path) return undefined;
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return undefined;
  }
  return path;
}

function safeVaultFolderPath(value: unknown): string | undefined {
  const path = safePath(value)?.replace(/^\/+|\/+$/gu, "");
  if (!path || path.includes("\\")) return undefined;
  return path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ? undefined
    : path;
}

function finiteInRange(value: unknown, fallback: number, range: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeWorkspaceSplit(value: unknown): VaultWorkspaceSplitState {
  const source = isRecord(value) ? value : {};
  return {
    direction: source.direction === "horizontal" ? "horizontal" : "vertical",
    ratio: finiteInRange(source.ratio, 0.5, { min: 0.2, max: 0.8 })
  };
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
    return value.pinned === true ? { kind: "global-graph", pinned: true } : { kind: "global-graph" };
  }
  const entryId = value.kind === "entry" ? safeId(value.entryId) : undefined;
  const instanceId = isWorkspacePaneGroupId(value.instanceId)
    ? value.instanceId
    : undefined;
  return entryId
    ? {
        kind: "entry",
        entryId,
        ...(instanceId ? { instanceId } : {}),
        ...(value.pinned === true ? { pinned: true as const } : {})
      }
    : null;
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

function normalizeSearchBookmarks(value: unknown): PersistedSearchBookmark[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const bookmarks: PersistedSearchBookmark[] = [];
  for (const item of value.slice(0, 64)) {
    if (!isRecord(item)) continue;
    const id = safeId(item.id);
    const label = safeString(item.label, 120)?.trim();
    const query = safeString(item.query, 2_000)?.trim();
    if (!id || !label || !query || ids.has(id)) continue;
    ids.add(id);
    bookmarks.push({
      createdAt: finiteInRange(item.createdAt, 0, { min: 0, max: 9_000_000_000_000_000 }),
      id,
      label,
      query
    });
  }
  return bookmarks;
}

function bookmarkIdentity(bookmark: Pick<PersistedVaultBookmark, "id" | "kind">) {
  return `${bookmark.kind}:${bookmark.id}`;
}

function normalizeVaultBookmarksOnly(value: unknown): PersistedVaultBookmark[] {
  if (!Array.isArray(value)) return [];
  const identities = new Set<string>();
  const bookmarks: PersistedVaultBookmark[] = [];
  for (const item of value.slice(0, MAX_VAULT_BOOKMARKS)) {
    if (!isRecord(item)) continue;
    const id = safeId(item.id);
    const label = safeString(item.label, 120)?.trim();
    if (!id || !label) continue;
    const createdAt = finiteInRange(item.createdAt, 0, { min: 0, max: 9_000_000_000_000_000 });
    let bookmark: PersistedVaultBookmark | null = null;
    if (item.kind === "entry") {
      const entryId = safeId(item.entryId);
      const path = safePath(item.path);
      if (entryId && path) bookmark = { kind: "entry", createdAt, entryId, id, label, path };
    } else if (item.kind === "graph") {
      bookmark = {
        kind: "graph",
        createdAt,
        id,
        label,
        settings: normalizeGlobalSettings(item.settings),
        viewport: normalizeViewport(item.viewport)
      };
    } else if (item.kind === "search") {
      const query = safeString(item.query, 2_000)?.trim();
      if (query) bookmark = { kind: "search", createdAt, id, label, query };
    }
    if (!bookmark || identities.has(bookmarkIdentity(bookmark))) continue;
    identities.add(bookmarkIdentity(bookmark));
    bookmarks.push(bookmark);
  }
  return bookmarks;
}

function legacyBookmarks(value: Record<string, unknown>): PersistedVaultBookmark[] {
  return [
    ...normalizeGraphBookmarks(value.graphBookmarks).map((bookmark): PersistedVaultBookmark => ({
      ...bookmark,
      kind: "graph"
    })),
    ...normalizeSearchBookmarks(value.searchBookmarks).map((bookmark): PersistedVaultBookmark => ({
      ...bookmark,
      kind: "search"
    }))
  ];
}

function mergeVaultBookmarks(primary: readonly PersistedVaultBookmark[], legacy: readonly PersistedVaultBookmark[]) {
  const identities = new Set<string>();
  const merged: PersistedVaultBookmark[] = [];
  for (const bookmark of [...primary, ...legacy]) {
    const identity = bookmarkIdentity(bookmark);
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(bookmark);
    if (merged.length >= MAX_VAULT_BOOKMARKS) break;
  }
  return merged;
}

function graphBookmarkWithoutKind(bookmark: PersistedVaultBookmark & { kind: "graph" }): PersistedGraphBookmark {
  return {
    createdAt: bookmark.createdAt,
    id: bookmark.id,
    label: bookmark.label,
    settings: bookmark.settings,
    viewport: bookmark.viewport
  };
}

function searchBookmarkWithoutKind(bookmark: PersistedVaultBookmark & { kind: "search" }): PersistedSearchBookmark {
  return {
    createdAt: bookmark.createdAt,
    id: bookmark.id,
    label: bookmark.label,
    query: bookmark.query
  };
}

function normalizePanelMode<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function normalizedTabs(value: unknown) {
  const tabs = Array.isArray(value)
    ? value.slice(0, 64).map(normalizeTab).filter((tab): tab is PersistedVaultTab => tab !== null)
    : [];
  return tabs.filter((tab, index) => tabs.findIndex((candidate) => (
    candidate.kind === tab.kind && (
      tab.kind === "global-graph"
      || candidate.kind === "entry"
        && candidate.entryId === tab.entryId
        && candidate.instanceId === tab.instanceId
    )
  )) === index);
}

function tabKey(tab: PersistedVaultTab) {
  return tab.kind === "global-graph"
    ? "global-graph"
    : `entry:${tab.entryId}:${tab.instanceId ?? "default"}`;
}

function sameTab(left: PersistedVaultTab, right: PersistedVaultTab) {
  return tabKey(left) === tabKey(right);
}

function normalizedTabGroups(
  value: unknown,
  legacyTabs: readonly PersistedVaultTab[],
  legacyActiveTab: PersistedVaultTab | null,
  requestedActiveGroupId: unknown,
  requestedLayout: VaultWorkspacePaneNode
) {
  const groups: PersistedVaultTabGroup[] = [];
  const claimed = new Set<string>();
  const source = Array.isArray(value) ? value.slice(0, 8) : [];
  const layoutGroupIds = workspaceLayoutGroupIds(requestedLayout);
  let canonicalTabCount = 0;
  for (const id of layoutGroupIds) {
    const raw = source.find((candidate) => isRecord(candidate) && candidate.id === id);
    const tabs = (isRecord(raw) ? normalizedTabs(raw.tabs) : []).filter((tab) => {
      const key = tabKey(tab);
      if (claimed.has(key) || claimed.size >= 64) return false;
      claimed.add(key);
      return true;
    });
    canonicalTabCount += tabs.length;
    const requestedActive = isRecord(raw) ? normalizeTab(raw.activeTab) : null;
    groups.push({
      id,
      tabs,
      activeTab: requestedActive && tabs.some((tab) => sameTab(tab, requestedActive))
        ? requestedActive
        : tabs[0] ?? null
    });
  }

  const fallbackGroup = groups.find((group) => group.id === "primary")
    ?? groups[0]
    ?? { id: "primary", tabs: [], activeTab: null };
  if (groups.length === 0) groups.push(fallbackGroup);
  for (const tab of legacyTabs) {
    const key = tabKey(tab);
    if (!claimed.has(key) && claimed.size < 64) {
      fallbackGroup.tabs.push(tab);
      claimed.add(key);
    }
  }
  if (!fallbackGroup.activeTab || !fallbackGroup.tabs.some((tab) => sameTab(tab, fallbackGroup.activeTab!))) {
    fallbackGroup.activeTab = fallbackGroup.tabs[0] ?? null;
  }

  const nonEmptyGroups = groups.filter((group) => group.tabs.length > 0);
  const finalGroups = nonEmptyGroups.length > 0 ? nonEmptyGroups : [fallbackGroup];

  const legacyOwner = legacyActiveTab
    ? finalGroups.find((group) => group.tabs.some((tab) => sameTab(tab, legacyActiveTab)))
    : undefined;
  const activeTabGroupId: PersistedVaultTabGroupId = isWorkspacePaneGroupId(requestedActiveGroupId)
    && finalGroups.some((group) => group.id === requestedActiveGroupId)
    ? requestedActiveGroupId
    : legacyOwner?.id ?? finalGroups[0].id;
  const activeGroup = finalGroups.find((group) => group.id === activeTabGroupId) ?? finalGroups[0];
  if (
    legacyOwner
    && legacyActiveTab
    && (canonicalTabCount === 0 || !isWorkspacePaneGroupId(requestedActiveGroupId))
  ) {
    legacyOwner.activeTab = legacyActiveTab;
  }
  const layout = reconcileWorkspaceLayoutGroups(requestedLayout, finalGroups.map((group) => group.id));
  return {
    activeTab: activeGroup.activeTab,
    activeTabGroupId,
    layout,
    tabGroups: finalGroups,
    tabs: finalGroups.flatMap((group) => group.tabs)
  };
}

function workspaceLayoutFromPersistedValue(
  layoutValue: unknown,
  legacyGroupsValue: unknown,
  legacySplitValue: unknown
): VaultWorkspacePaneNode {
  if (isRecord(layoutValue)) return normalizeWorkspaceLayout(layoutValue);
  const source = Array.isArray(legacyGroupsValue) ? legacyGroupsValue : [];
  const hasSecondary = source.some((candidate) => isRecord(candidate) && candidate.id === "secondary");
  if (!hasSecondary) return createDefaultWorkspaceLayout();
  const split = normalizeWorkspaceSplit(legacySplitValue);
  const layout = splitWorkspacePane({
    direction: split.direction,
    layout: createDefaultWorkspaceLayout(),
    newGroupId: "secondary",
    splitId: "split_legacy",
    targetGroupId: "primary"
  });
  return resizeWorkspaceSplit(layout, "split_legacy", split.ratio);
}

function normalizedWorkspaceLayout(value: unknown): VaultWorkspaceLayoutSnapshot | null {
  if (!isRecord(value)) return null;
  const fallback = createDefaultVaultWorkspaceState();
  const left = isRecord(value.left) ? value.left : {};
  const right = isRecord(value.right) ? value.right : {};
  const globalGraph = isRecord(value.globalGraph) ? value.globalGraph : {};
  const localGraph = isRecord(value.localGraph) ? value.localGraph : {};
  const plugins = isRecord(value.plugins) ? value.plugins : {};
  const calendar = isRecord(plugins.calendar) ? plugins.calendar : {};
  const templates = isRecord(plugins.templates) ? plugins.templates : {};
  const selectedFolderId = value.selectedFolderId === null ? null : safeId(value.selectedFolderId) ?? null;
  const expandedFolderIds = Array.isArray(value.expandedFolderIds)
    ? [...new Set(value.expandedFolderIds.slice(0, 5_000).map(safeId).filter((id): id is string => Boolean(id)))]
    : [];
  const legacyTabs = normalizedTabs(value.tabs);
  const legacyActiveTab = normalizeTab(value.activeTab);
  const requestedLayout = workspaceLayoutFromPersistedValue(value.layout, value.tabGroups, value.split);
  const normalizedGroups = normalizedTabGroups(
    value.tabGroups,
    legacyTabs,
    legacyActiveTab,
    value.activeTabGroupId,
    requestedLayout
  );
  const snapshot: VaultWorkspaceLayoutSnapshot = {
    tabs: normalizedGroups.tabs,
    activeTab: normalizedGroups.activeTab,
    tabGroups: normalizedGroups.tabGroups,
    activeTabGroupId: normalizedGroups.activeTabGroupId,
    layout: normalizedGroups.layout,
    left: {
      open: booleanOr(left.open, fallback.left.open),
      mode: normalizePanelMode(left.mode, ["files", "search", "tags", "bookmarks"], fallback.left.mode)
    },
    right: {
      open: booleanOr(right.open, fallback.right.open),
      mode: normalizePanelMode(right.mode, ["backlinks", "outgoing", "properties", "outline", "local-graph", "history"], fallback.right.mode)
    },
    selectedFolderId,
    expandedFolderIds,
    searchQuery: safeString(value.searchQuery, 2_000) ?? "",
    bookmarks: normalizeVaultBookmarksOnly(value.bookmarks),
    viewMode: normalizePanelMode(value.viewMode, ["source", "live-preview", "reading"], fallback.viewMode),
    plugins: {
      calendar: {
        cursorMonth: normalizeDailyMonth(safeString(calendar.cursorMonth, 7) ?? fallback.plugins.calendar.cursorMonth),
        folderId: calendar.folderId === null ? null : safeId(calendar.folderId) ?? null,
        open: booleanOr(calendar.open, fallback.plugins.calendar.open),
        templateEntryId: calendar.templateEntryId === null ? null : safeId(calendar.templateEntryId) ?? null
      },
      templates: {
        folderPath: templates.folderPath === null
          ? null
          : safeVaultFolderPath(templates.folderPath) ?? null,
        includeDescendants: booleanOr(
          templates.includeDescendants,
          fallback.plugins.templates.includeDescendants
        )
      }
    },
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
  return serializedUtf8Bytes(snapshot) <= MAX_NAMED_WORKSPACE_SNAPSHOT_SERIALIZED_BYTES
    ? snapshot
    : null;
}

function normalizeNamedWorkspaces(value: unknown): PersistedNamedWorkspace[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const workspaces: PersistedNamedWorkspace[] = [];
  for (const item of value.slice(0, MAX_NAMED_WORKSPACES)) {
    if (!isRecord(item)) continue;
    const id = safeId(item.id);
    const label = safeString(item.label, 120)?.trim();
    const snapshot = normalizedWorkspaceLayout(item.snapshot);
    if (!id || !label || !snapshot || ids.has(id)) continue;
    ids.add(id);
    const workspace: PersistedNamedWorkspace = {
      createdAt: finiteInRange(item.createdAt, 0, { min: 0, max: 9_000_000_000_000_000 }),
      id,
      label,
      snapshot,
      updatedAt: finiteInRange(item.updatedAt, 0, { min: 0, max: 9_000_000_000_000_000 })
    };
    if (serializedUtf8Bytes([...workspaces, workspace]) > MAX_NAMED_WORKSPACES_SERIALIZED_BYTES) continue;
    workspaces.push(workspace);
  }
  return workspaces;
}

export function captureVaultWorkspaceLayout(state: VaultPersistedWorkspaceState): VaultWorkspaceLayoutSnapshot {
  return {
    tabs: state.tabs,
    activeTab: state.activeTab,
    tabGroups: state.tabGroups,
    activeTabGroupId: state.activeTabGroupId,
    layout: state.layout,
    left: state.left,
    right: state.right,
    selectedFolderId: state.selectedFolderId,
    expandedFolderIds: state.expandedFolderIds,
    searchQuery: state.searchQuery,
    bookmarks: state.bookmarks,
    viewMode: state.viewMode,
    plugins: state.plugins,
    globalGraph: state.globalGraph,
    localGraph: state.localGraph
  };
}

export function vaultWorkspaceLayoutFitsEncryptedDocument(
  snapshot: VaultWorkspaceLayoutSnapshot,
  existingNamedWorkspaces: readonly PersistedNamedWorkspace[] = []
) {
  if (serializedUtf8Bytes(snapshot) > MAX_NAMED_WORKSPACE_SNAPSHOT_SERIALIZED_BYTES) return false;
  const upperBoundCandidate: PersistedNamedWorkspace = {
    createdAt: 9_000_000_000_000_000,
    id: "x".repeat(160),
    label: "한".repeat(120),
    snapshot,
    updatedAt: 9_000_000_000_000_000
  };
  return serializedUtf8Bytes([...existingNamedWorkspaces, upperBoundCandidate]) <= MAX_NAMED_WORKSPACES_SERIALIZED_BYTES;
}

export function vaultWorkspaceStateFitsEncryptedDocument(state: VaultPersistedWorkspaceState) {
  return serializedUtf8Bytes(state) <= MAX_ENCRYPTED_WORKSPACE_PLAINTEXT_BYTES;
}

function tabAvailable(tab: PersistedVaultTab, availableEntryIds: ReadonlySet<string>) {
  return tab.kind === "global-graph" || availableEntryIds.has(tab.entryId);
}

/**
 * Restores only IDs still present in the caller's decrypted ACL-filtered Vault.
 * Missing entry bookmarks stay visible as unavailable, but they are never
 * promoted into an open tab, Local Graph root, or Daily Notes template.
 */
export function restoreVaultWorkspaceLayout(
  current: VaultPersistedWorkspaceState,
  snapshot: VaultWorkspaceLayoutSnapshot,
  availableEntryIds: ReadonlySet<string>,
  availableFolderIds?: ReadonlySet<string>
): VaultPersistedWorkspaceState {
  const normalized = normalizedWorkspaceLayout(snapshot);
  if (!normalized) return current;
  const filteredGroups = normalized.tabGroups.flatMap((group): PersistedVaultTabGroup[] => {
    const groupTabs = group.tabs.filter((tab) => tabAvailable(tab, availableEntryIds));
    const requestedActive = group.activeTab && tabAvailable(group.activeTab, availableEntryIds)
      ? group.activeTab
      : null;
    return [{
      id: group.id,
      tabs: groupTabs,
      activeTab: requestedActive && groupTabs.some((tab) => sameTab(tab, requestedActive))
        ? requestedActive
        : groupTabs[0] ?? null
    }];
  });
  const nonEmptyGroups = filteredGroups.filter((group) => group.tabs.length > 0);
  const tabGroups = nonEmptyGroups.length > 0
    ? nonEmptyGroups
    : [filteredGroups.find((group) => group.id === normalized.activeTabGroupId)
      ?? filteredGroups[0]
      ?? { id: "primary", tabs: [], activeTab: null }];
  const activeTabGroupId = tabGroups.some((group) => group.id === normalized.activeTabGroupId)
    ? normalized.activeTabGroupId
    : tabGroups[0].id;
  const activeGroup = tabGroups.find((group) => group.id === activeTabGroupId)!;
  const tabs = tabGroups.flatMap((group) => group.tabs);
  const activeTab = activeGroup.activeTab;
  const bookmarks = normalized.bookmarks;
  const localRoot = normalized.localGraph.settings.root;
  const localGraph = localRoot !== "follow-active" && !availableEntryIds.has(localRoot.entryId)
    ? { ...normalized.localGraph, settings: { ...normalized.localGraph.settings, root: "follow-active" as const } }
    : normalized.localGraph;
  const selectedFolderId = normalized.selectedFolderId
    && availableFolderIds
    && !availableFolderIds.has(normalized.selectedFolderId)
    ? null
    : normalized.selectedFolderId;
  const expandedFolderIds = availableFolderIds
    ? normalized.expandedFolderIds.filter((folderId) => availableFolderIds.has(folderId))
    : normalized.expandedFolderIds;
  const calendarFolderId = normalized.plugins.calendar.folderId
    && availableFolderIds
    && !availableFolderIds.has(normalized.plugins.calendar.folderId)
    ? null
    : normalized.plugins.calendar.folderId ?? null;
  const calendarTemplateEntryId = normalized.plugins.calendar.templateEntryId
    && !availableEntryIds.has(normalized.plugins.calendar.templateEntryId)
    ? null
    : normalized.plugins.calendar.templateEntryId ?? null;
  return {
    ...current,
    ...normalized,
    version: 1,
    tabs,
    activeTab,
    tabGroups,
    activeTabGroupId,
    layout: reconcileWorkspaceLayoutGroups(normalized.layout, tabGroups.map((group) => group.id)),
    bookmarks,
    graphBookmarks: bookmarks.filter((bookmark): bookmark is PersistedVaultBookmark & { kind: "graph" } => bookmark.kind === "graph")
      .map(graphBookmarkWithoutKind),
    searchBookmarks: bookmarks.filter((bookmark): bookmark is PersistedVaultBookmark & { kind: "search" } => bookmark.kind === "search")
      .map(searchBookmarkWithoutKind),
    namedWorkspaces: current.namedWorkspaces,
    selectedFolderId,
    expandedFolderIds,
    localGraph,
    plugins: {
      calendar: {
        ...normalized.plugins.calendar,
        folderId: calendarFolderId,
        templateEntryId: calendarTemplateEntryId
      },
      templates: normalized.plugins.templates
    }
  };
}

export function createDefaultVaultWorkspaceState(): VaultPersistedWorkspaceState {
  return {
    version: 1,
    tabs: [],
    activeTab: null,
    tabGroups: [{ id: "primary", tabs: [], activeTab: null }],
    activeTabGroupId: "primary",
    layout: createDefaultWorkspaceLayout(),
    left: { open: true, mode: "files" },
    right: { open: true, mode: "backlinks" },
    selectedFolderId: null,
    expandedFolderIds: [],
    searchQuery: "",
    bookmarks: [],
    searchBookmarks: [],
    viewMode: "live-preview",
    graphBookmarks: [],
    namedWorkspaces: [],
    plugins: {
      calendar: {
        cursorMonth: localMonthKey(new Date()),
        folderId: null,
        open: true,
        templateEntryId: null
      },
      templates: {
        folderPath: null,
        includeDescendants: true
      }
    },
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
  const plugins = isRecord(value.plugins) ? value.plugins : {};
  const calendar = isRecord(plugins.calendar) ? plugins.calendar : {};
  const templates = isRecord(plugins.templates) ? plugins.templates : {};
  const deduplicatedTabs = normalizedTabs(value.tabs);
  const legacyActiveTab = normalizeTab(value.activeTab);
  const requestedLayout = workspaceLayoutFromPersistedValue(value.layout, value.tabGroups, value.split);
  const normalizedGroups = normalizedTabGroups(
    value.tabGroups,
    deduplicatedTabs,
    legacyActiveTab,
    value.activeTabGroupId,
    requestedLayout
  );
  const selectedFolderId = value.selectedFolderId === null ? null : safeId(value.selectedFolderId) ?? null;
  const expandedFolderIds = Array.isArray(value.expandedFolderIds)
    ? [...new Set(value.expandedFolderIds.slice(0, 5_000).map(safeId).filter((id): id is string => Boolean(id)))]
    : [];
  const bookmarks = mergeVaultBookmarks(normalizeVaultBookmarksOnly(value.bookmarks), legacyBookmarks(value));
  const graphBookmarks = bookmarks
    .filter((bookmark): bookmark is PersistedVaultBookmark & { kind: "graph" } => bookmark.kind === "graph")
    .map(graphBookmarkWithoutKind);
  const searchBookmarks = bookmarks
    .filter((bookmark): bookmark is PersistedVaultBookmark & { kind: "search" } => bookmark.kind === "search")
    .map(searchBookmarkWithoutKind);

  const normalizedState: VaultPersistedWorkspaceState = {
    version: 1,
    tabs: normalizedGroups.tabs,
    activeTab: normalizedGroups.activeTab,
    tabGroups: normalizedGroups.tabGroups,
    activeTabGroupId: normalizedGroups.activeTabGroupId,
    layout: normalizedGroups.layout,
    left: {
      open: booleanOr(left.open, fallback.left.open),
      mode: normalizePanelMode(left.mode, ["files", "search", "tags", "bookmarks"], fallback.left.mode)
    },
    right: {
      open: booleanOr(right.open, fallback.right.open),
      mode: normalizePanelMode(right.mode, ["backlinks", "outgoing", "properties", "outline", "local-graph", "history"], fallback.right.mode)
    },
    selectedFolderId,
    expandedFolderIds,
    searchQuery: safeString(value.searchQuery, 2_000) ?? "",
    bookmarks,
    searchBookmarks,
    viewMode: normalizePanelMode(value.viewMode, ["source", "live-preview", "reading"], fallback.viewMode),
    graphBookmarks,
    namedWorkspaces: normalizeNamedWorkspaces(value.namedWorkspaces),
    plugins: {
      calendar: {
        cursorMonth: normalizeDailyMonth(safeString(calendar.cursorMonth, 7) ?? fallback.plugins.calendar.cursorMonth),
        folderId: calendar.folderId === null ? null : safeId(calendar.folderId) ?? null,
        open: booleanOr(calendar.open, fallback.plugins.calendar.open),
        templateEntryId: calendar.templateEntryId === null ? null : safeId(calendar.templateEntryId) ?? null
      },
      templates: {
        folderPath: templates.folderPath === null
          ? null
          : safeVaultFolderPath(templates.folderPath) ?? null,
        includeDescendants: booleanOr(
          templates.includeDescendants,
          fallback.plugins.templates.includeDescendants
        )
      }
    },
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
  return vaultWorkspaceStateFitsEncryptedDocument(normalizedState) ? normalizedState : fallback;
}
