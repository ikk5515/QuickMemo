import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Command as CommandIcon,
  Download,
  FileCode2,
  FilePlus2,
  Files,
  Folder,
  FolderInput,
  FolderPlus,
  GitFork,
  Hash,
  LibraryBig,
  Link2,
  ListTree,
  Menu,
  Network,
  PanelRight,
  Pencil,
  Save,
  Search,
  Settings2,
  Table2,
  Tags,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  type DragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ReadonlyNoteRenderer } from "../components/ReadonlyNoteRenderer";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { emptyJsonCanvas } from "../features/canvas/canvasModel";
import {
  createDefaultGlobalGraphSettings,
  createDefaultLocalGraphSettings,
  graphOpenIntentFromModifiers
} from "../features/graph/graphSettings";
import type {
  GraphNode as UiGraphNode,
  GraphOpenIntent,
  GraphSettingsSectionId,
  GraphViewport,
  GraphViewSettings as UiGraphViewSettings
} from "../features/graph/types";
import {
  backlinkOccurrences,
  applyInternalLinkRewritePlan,
  buildGraphSnapshot,
  buildKnowledgeIndex,
  KnowledgeWorkerClient,
  matchesVaultSearchQuery,
  outgoingOccurrences,
  planIncomingInternalLinkRewrites,
  resolveInternalLink,
  type GraphSnapshot as IndexGraphSnapshot,
  type GraphViewSettings as IndexGraphViewSettings,
  type IncomingInternalLinkRewritePlan,
  type InternalLinkOccurrence,
  type KnowledgeMetadataSummary,
  type MarkdownHeading,
  type ParsedMarkdownMetadata,
  type ResolvedLinkOccurrence,
  type RevisionedVaultIndexEntry,
  type TagIndexEntry,
  type VaultIndexEntry
} from "../features/knowledge";
import {
  MarkdownRenderer,
  exportMarkdown,
  previewLegacyHtmlToMarkdown,
  type MarkdownExportProfile,
  type MarkdownLinkReference,
  type MarkdownViewMode
} from "../features/markdown";
import { CodeMirrorMarkdownEditor } from "../features/vault/CodeMirrorMarkdownEditor";
import { VaultAssetPreview } from "../features/vault/VaultAssetPreview";
import { downloadBlob } from "../features/vault/browserDownload";
import {
  compensateCreatedVaultImportEntries,
  type CreatedVaultImportEntry
} from "../features/vault/importRollback";
import { decodeVaultAsset } from "../features/vault/vaultAsset";
import { VaultOutline } from "../features/vault/VaultOutline";
import { VaultPropertiesEditor } from "../features/vault/VaultPropertiesEditor";
import {
  isKeyboardContextMenuGesture,
  keyboardContextMenuPoint,
  VaultMoveDialog,
  type VaultMoveDestination,
  type VaultMoveTarget
} from "../features/vault/VaultMoveDialog";
import { planUnresolvedMarkdownTarget } from "../features/vault/unresolvedMarkdownPath";
import { vaultPathCollisionKey } from "../features/vault/interop/path";
import {
  chooseTemplate,
  expandTemplate,
  templateCandidates,
  uniqueNoteTitle
} from "../features/vault/noteCommands";
import {
  CommandPalette,
  QuickSwitcher,
  useVaultNavigationShortcuts,
  type CommandPaletteItem,
  type NavigationActivationMetadata,
  type QuickSwitcherItem
} from "../features/vault/navigation";
import { previewTextFromHtml } from "../lib/editorContent";
import {
  buildVaultPaths,
  createEncryptedVaultFolder,
  decryptVaultFolders,
  decryptVaultNotes,
  migrateLegacyVaultFolder,
  renameEncryptedVaultFolder,
  vaultEntryPath,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "../features/vault/vaultData";
import {
  createEncryptedVaultAsset,
  createEncryptedVaultEntry,
  createMarkdownVaultNote,
  saveEncryptedVaultEntry,
  type MarkdownNoteDraft
} from "../features/vault/vaultPersistence";
import {
  auditVaultFolderTree,
  requireValidVaultFolderTree
} from "../features/vault/vaultIntegrity";
import { requireValidProposedVaultFolderTree } from "../features/vault/vaultFolderPreflight";
import {
  createDefaultVaultWorkspaceState,
  normalizeVaultWorkspaceState,
  type PersistedGraphBookmark,
  type PersistedVaultTab,
  type VaultPersistedWorkspaceState
} from "../features/vault/workspaceState";
import {
  subscribeNoteFolders,
  subscribeVisibleNotes,
  deleteRevisionedNote,
  updateEncryptedNoteFolder,
  updateRevisionedNoteFolder,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../services/notes";
import { subscribeUsers } from "../services/users";
import {
  VaultWorkspaceRevisionConflictError,
  loadVaultWorkspaceRecord,
  saveVaultWorkspace,
  type VaultWorkspaceState
} from "../services/vaultWorkspace";
import type { UserProfile } from "../types";
import "../styles/vault.css";

const LazyBaseView = lazy(() => import("../features/base/BaseView").then((module) => ({
  default: module.BaseView
})));
const LazyGraphView = lazy(() => import("../features/graph/GraphView").then((module) => ({
  default: module.GraphView
})));
const LazyJsonCanvasView = lazy(() => import("../features/canvas/JsonCanvasView").then((module) => ({
  default: module.JsonCanvasView
})));

const MOBILE_VAULT_MEDIA_QUERY = "(max-width: 760px)";
const EMPTY_FRONTMATTER_PROPERTIES = Object.freeze({});

function subscribeMobileVaultLayout(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia(MOBILE_VAULT_MEDIA_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function mobileVaultLayoutSnapshot() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_VAULT_MEDIA_QUERY).matches;
}

function useMobileVaultLayout() {
  return useSyncExternalStore(subscribeMobileVaultLayout, mobileVaultLayoutSnapshot, () => false);
}

function VaultViewLoading({ label }: { label: string }) {
  return <div aria-live="polite" className="vault-view-loading" role="status">{label} 불러오는 중…</div>;
}

type LeftPanelMode = "files" | "search" | "tags";
type RightPanelMode = "backlinks" | "outgoing" | "properties" | "outline" | "local-graph";
type WorkspaceTab =
  | { id: string; kind: "entry"; entryId: string; label: string }
  | { id: "global-graph"; kind: "global-graph"; label: string };

interface VaultContextMenuState {
  returnFocusElement: HTMLButtonElement | null;
  targetId: string;
  targetKind: "entry" | "folder";
  x: number;
  y: number;
}

interface DraftState extends MarkdownNoteDraft {
  /** Revision from which this edit buffer was created; never follows remote updates while dirty. */
  baseRevision: number;
  dirty: boolean;
}

interface CreateVaultEntryOptions {
  folderId?: string | null;
  preserveRequestedTitle?: boolean;
}

const vaultCommands: CommandPaletteItem[] = [
  { id: "new-note", label: "새 노트 만들기", section: "파일", shortcut: "Cmd/Ctrl+N", keywords: ["markdown"] },
  { id: "new-canvas", label: "새 Canvas 만들기", section: "파일", keywords: ["canvas", "캔버스"] },
  { id: "new-base", label: "새 Base 만들기", section: "파일", keywords: ["base", "베이스", "데이터베이스"] },
  { id: "daily-note", label: "오늘의 Daily Note 열기", section: "노트", keywords: ["daily", "오늘"] },
  { id: "unique-note", label: "고유 노트 만들기", section: "노트", keywords: ["unique", "timestamp", "고유"] },
  { id: "random-note", label: "무작위 노트 열기", section: "노트", keywords: ["random"] },
  { id: "insert-template", label: "현재 노트에 템플릿 삽입", section: "템플릿", keywords: ["template", "템플릿"] },
  { id: "new-from-template", label: "템플릿에서 새 노트 만들기", section: "템플릿", keywords: ["template", "템플릿"] },
  { id: "global-graph", label: "전체 그래프 열기", section: "보기", keywords: ["graph", "그래프"] },
  { id: "outline", label: "현재 노트 목차 열기", section: "보기", keywords: ["outline", "목차"] },
  { id: "search", label: "전체 검색 열기", section: "보기", keywords: ["search", "검색"] },
  { id: "toggle-left", label: "왼쪽 사이드바 전환", section: "보기" },
  { id: "toggle-right", label: "오른쪽 사이드바 전환", section: "보기" },
  { id: "import-obsidian", label: "Obsidian ZIP 가져오기", section: "가져오기·내보내기", keywords: ["zip", "import"] },
  { id: "export-obsidian", label: "Obsidian ZIP 내보내기", section: "가져오기·내보내기", keywords: ["zip", "export"] },
  { id: "open-library", label: "자료실 열기", section: "QuickMemo" },
  { id: "open-schedule", label: "일정 열기", section: "QuickMemo" },
  { id: "open-legacy", label: "기존 노트 관리 열기", section: "QuickMemo" }
];

function timestampMillis(value: DecryptedVaultNote["createdAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : undefined;
}

function normalizedEntryTitle(value: string, kind: DecryptedVaultNote["entryKind"] = "markdown") {
  if (kind === "asset") {
    return value.trim().normalize("NFC").toLocaleLowerCase();
  }
  const extension = kind === "canvas" ? ".canvas" : kind === "base" ? ".base" : ".md";
  const escapedExtension = extension.replace(".", "\\.");
  return `${value.trim().normalize("NFC").replace(new RegExp(`${escapedExtension}$`, "i"), "")}${extension}`.toLocaleLowerCase();
}

function uniqueTitle(
  notes: readonly DecryptedVaultNote[],
  base: string,
  folderId: string | null,
  kind: DecryptedVaultNote["entryKind"]
) {
  const titles = new Set(notes
    .filter((note) => (note.folderId ?? null) === folderId)
    .map((note) => normalizedEntryTitle(note.title, note.entryKind)));
  if (!titles.has(normalizedEntryTitle(base, kind))) {
    return base;
  }
  let suffix = 2;
  while (titles.has(normalizedEntryTitle(`${base} ${suffix}`, kind))) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

function entryLabel(note: DecryptedVaultNote) {
  if (note.entryKind === "canvas") {
    return `${note.title.replace(/\.canvas$/i, "")}.canvas`;
  }
  if (note.entryKind === "base") {
    return `${note.title.replace(/\.base$/i, "")}.base`;
  }
  return note.title;
}

function markdownEmbedFragment(source: string, subpath: string | null) {
  if (!subpath) {
    return source.slice(0, 200_000);
  }
  let fragment = subpath.replace(/^#/, "");
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // Keep the literal fragment when percent decoding is malformed.
  }
  const lines = source.split("\n");
  if (fragment.startsWith("^")) {
    const blockId = fragment.slice(1).trim();
    const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = lines.find((candidate) => new RegExp(`(?:^|\\s)\\^${escaped}\\s*$`, "u").test(candidate));
    return (line?.replace(new RegExp(`\\s*\\^${escaped}\\s*$`, "u"), "") ?? source).slice(0, 200_000);
  }
  const expected = fragment.trim().normalize("NFC").toLocaleLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (!match || match[2].normalize("NFC").toLocaleLowerCase() !== expected) {
      continue;
    }
    const level = match[1].length;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextHeading = /^(#{1,6})\s+/.exec(lines[next]);
      if (nextHeading && nextHeading[1].length <= level) {
        end = next;
        break;
      }
    }
    return lines.slice(index, end).join("\n").slice(0, 200_000);
  }
  return source.slice(0, 200_000);
}

function graphSettingsForIndex(settings: UiGraphViewSettings): IndexGraphViewSettings {
  return settings as IndexGraphViewSettings;
}

/**
 * The knowledge worker only needs filters, groups and Local Graph traversal
 * options. Keeping visual/force controls out of this object prevents every
 * slider movement from rebuilding the complete graph index.
 */
function useGraphDataSettings(settings: UiGraphViewSettings): IndexGraphViewSettings {
  const {
    existingFilesOnly,
    groups,
    query,
    showAttachments,
    showTags
  } = settings.common;
  const scope = settings.scope;
  const showOrphans = settings.scope === "global" ? settings.showOrphans : true;
  const depth = settings.scope === "local" ? settings.depth : 1;
  const incoming = settings.scope === "local" ? settings.incoming : true;
  const neighborLinks = settings.scope === "local" ? settings.neighborLinks : false;
  const outgoing = settings.scope === "local" ? settings.outgoing : true;
  const rootEntryId = settings.scope === "local" && settings.root !== "follow-active"
    ? settings.root.entryId
    : null;

  return useMemo(() => {
    let dataSettings: UiGraphViewSettings;
    if (scope === "global") {
      const defaults = createDefaultGlobalGraphSettings();
      dataSettings = {
        ...defaults,
        common: {
          ...defaults.common,
          existingFilesOnly,
          groups,
          query,
          showAttachments,
          showTags
        },
        showOrphans
      };
    } else {
      const defaults = createDefaultLocalGraphSettings();
      dataSettings = {
        ...defaults,
        common: {
          ...defaults.common,
          existingFilesOnly,
          groups,
          query,
          showAttachments,
          showTags
        },
        depth: depth as 1 | 2 | 3 | 4 | 5,
        incoming,
        neighborLinks,
        outgoing,
        root: rootEntryId ? { entryId: rootEntryId } : "follow-active"
      };
    }
    return graphSettingsForIndex(dataSettings);
  }, [
    depth,
    existingFilesOnly,
    groups,
    incoming,
    neighborLinks,
    outgoing,
    query,
    rootEntryId,
    scope,
    showAttachments,
    showOrphans,
    showTags
  ]);
}

function useStableEvent<Arguments extends unknown[], Result>(
  handler: (...args: Arguments) => Result
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback((...args: Arguments) => handlerRef.current(...args), []);
}

function graphNodesForUi(snapshot: ReturnType<typeof buildGraphSnapshot>, entries: readonly VaultIndexEntry[]) {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  return snapshot.nodes.map((node): UiGraphNode => {
    const entry = node.entryId ? entryById.get(node.entryId) : undefined;
    const kind: UiGraphNode["kind"] = node.kind === "tag"
      ? "tag"
      : node.kind === "unresolved"
        ? "unresolved"
        : node.kind === "attachment"
          ? "attachment"
          : entry?.kind === "canvas"
            ? "canvas"
            : "note";
    return {
      id: node.id,
      label: node.label,
      kind,
      path: node.path,
      preview: entry?.content
        ?.replace(/^---[\s\S]*?---\s*/u, "")
        .replace(/[`#>*_[\]()!~-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240),
      inboundReferenceCount: node.incomingReferenceCount,
      groupIds: node.groupId ? [node.groupId] : [],
      color: node.color
    };
  });
}

function graphEdgesForUi(snapshot: ReturnType<typeof buildGraphSnapshot>) {
  return snapshot.edges.map((edge) => ({
    id: edge.id,
    sourceId: edge.source,
    targetId: edge.target,
    occurrenceCount: edge.occurrenceCount
  }));
}

function persistedTab(tab: WorkspaceTab): PersistedVaultTab {
  return tab.kind === "entry"
    ? { kind: "entry", entryId: tab.entryId }
    : { kind: "global-graph" };
}

function restoredTab(tab: PersistedVaultTab, notes: readonly DecryptedVaultNote[] = []): WorkspaceTab {
  if (tab.kind === "global-graph") {
    return { id: "global-graph", kind: "global-graph", label: "그래프 보기" };
  }
  const note = notes.find((candidate) => candidate.id === tab.entryId);
  return {
    id: `entry:${tab.entryId}`,
    kind: "entry",
    entryId: tab.entryId,
    label: note ? entryLabel(note) : "암호화 노트"
  };
}

function workspaceStateForSave(input: {
  activeTab: WorkspaceTab | null;
  expandedFolderIds: ReadonlySet<string>;
  globalCollapsedSections: GraphSettingsSectionId[];
  globalGraphSettings: UiGraphViewSettings;
  globalViewport: GraphViewport;
  graphBookmarks: PersistedGraphBookmark[];
  leftMode: LeftPanelMode;
  leftOpen: boolean;
  localCollapsedSections: GraphSettingsSectionId[];
  localGraphSettings: UiGraphViewSettings;
  localViewport: GraphViewport;
  rightMode: RightPanelMode;
  rightOpen: boolean;
  searchQuery: string;
  selectedFolderId: string | null;
  tabs: WorkspaceTab[];
  viewMode: MarkdownViewMode;
}): VaultPersistedWorkspaceState {
  const defaults = createDefaultVaultWorkspaceState();
  return {
    version: 1,
    tabs: input.tabs.map(persistedTab),
    activeTab: input.activeTab ? persistedTab(input.activeTab) : null,
    left: { open: input.leftOpen, mode: input.leftMode },
    right: { open: input.rightOpen, mode: input.rightMode },
    selectedFolderId: input.selectedFolderId,
    expandedFolderIds: [...input.expandedFolderIds],
    searchQuery: input.searchQuery,
    viewMode: input.viewMode,
    graphBookmarks: input.graphBookmarks,
    globalGraph: {
      settings: input.globalGraphSettings.scope === "global"
        ? input.globalGraphSettings
        : defaults.globalGraph.settings,
      viewport: input.globalViewport,
      collapsedSections: input.globalCollapsedSections
    },
    localGraph: {
      settings: input.localGraphSettings.scope === "local"
        ? input.localGraphSettings
        : defaults.localGraph.settings,
      viewport: input.localViewport,
      collapsedSections: input.localCollapsedSections
    }
  };
}

function useKnowledgeGraphSnapshot(
  index: ReturnType<typeof buildKnowledgeIndex> | null,
  settings: IndexGraphViewSettings,
  activeEntryId: string | null
) {
  return useMemo(
    () => index
      ? buildGraphSnapshot(
          index,
          settings,
          { activeEntryId: activeEntryId ?? undefined, allowRegex: false }
        )
      : emptyGraphSnapshot(settings.scope),
    [activeEntryId, index, settings]
  );
}

function emptyGraphSnapshot(scope: IndexGraphSnapshot["scope"]): IndexGraphSnapshot {
  return { scope, nodes: [], edges: [] };
}

function markdownDocumentStats(source: string) {
  return {
    characters: source.length,
    words: source.match(/\S+/gu)?.length ?? 0
  };
}

function UnlockedVaultPage({
  privateKey,
  profile
}: {
  privateKey: CryptoKey;
  profile: UserProfile;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedWorkspacePanel = searchParams.get("panel");
  const requestedWorkspaceView = searchParams.get("view");
  const [rawNotes, setRawNotes] = useState<NoteSnapshot[]>([]);
  const [rawFolders, setRawFolders] = useState<NoteFolderSnapshot[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [notes, setNotes] = useState<DecryptedVaultNote[]>([]);
  const [folders, setFolders] = useState<DecryptedVaultFolder[]>([]);
  const [knowledgeClient, setKnowledgeClient] = useState<KnowledgeWorkerClient | null>(null);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  const [metadataSummaries, setMetadataSummaries] = useState<KnowledgeMetadataSummary[]>([]);
  const [indexedTags, setIndexedTags] = useState<TagIndexEntry[]>([]);
  const [workerBacklinks, setWorkerBacklinks] = useState<ResolvedLinkOccurrence[]>([]);
  const [workerOutgoing, setWorkerOutgoing] = useState<ResolvedLinkOccurrence[]>([]);
  const [workerSearchEntryIds, setWorkerSearchEntryIds] = useState<string[] | null>(null);
  const [workerGlobalSnapshot, setWorkerGlobalSnapshot] = useState<IndexGraphSnapshot | null>(null);
  const [workerLocalSnapshot, setWorkerLocalSnapshot] = useState<IndexGraphSnapshot | null>(null);
  const [leftMode, setLeftMode] = useState<LeftPanelMode>("files");
  const [rightMode, setRightMode] = useState<RightPanelMode>("backlinks");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const draftsRef = useRef(drafts);
  const [viewMode, setViewMode] = useState<MarkdownViewMode>("live-preview");
  const [globalGraphSettings, setGlobalGraphSettings] = useState<UiGraphViewSettings>(() => createDefaultGlobalGraphSettings());
  const [localGraphSettings, setLocalGraphSettings] = useState<UiGraphViewSettings>(() => createDefaultLocalGraphSettings());
  const globalGraphDataSettings = useGraphDataSettings(globalGraphSettings);
  const localGraphDataSettings = useGraphDataSettings(localGraphSettings);
  const deferredGlobalGraphDataSettings = useDeferredValue(globalGraphDataSettings);
  const deferredLocalGraphDataSettings = useDeferredValue(localGraphDataSettings);
  const [globalViewport, setGlobalViewport] = useState<GraphViewport>({ centerX: 0, centerY: 0, zoom: 1 });
  const [localViewport, setLocalViewport] = useState<GraphViewport>({ centerX: 0, centerY: 0, zoom: 1 });
  const [globalCollapsedSections, setGlobalCollapsedSections] = useState<GraphSettingsSectionId[]>([]);
  const [localCollapsedSections, setLocalCollapsedSections] = useState<GraphSettingsSectionId[]>([]);
  const [graphBookmarks, setGraphBookmarks] = useState<PersistedGraphBookmark[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [editorInsertRequest, setEditorInsertRequest] = useState<{ entryId: string; id: number; text: string } | null>(null);
  const [editorRevealRequest, setEditorRevealRequest] = useState<{ entryId: string; id: number; line: number } | null>(null);
  const [status, setStatus] = useState("암호화 Vault 준비 중");
  const [error, setError] = useState<string | null>(null);
  const [savingEntryIds, setSavingEntryIds] = useState<Set<string>>(new Set());
  const savingEntryIdsRef = useRef<Set<string>>(new Set());
  const [folderMigrationBusy, setFolderMigrationBusy] = useState(false);
  const [vaultImportBusy, setVaultImportBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<VaultContextMenuState | null>(null);
  const [moveTarget, setMoveTarget] = useState<VaultMoveTarget | null>(null);
  const decryptGeneration = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const workspaceRevisionRef = useRef<number | undefined>(undefined);
  const lastSavedWorkspaceRef = useRef("");
  const renameEntryRef = useRef<(entryId: string, requestedTitle?: string) => Promise<void>>(async () => undefined);
  const workspaceSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSaveGenerationRef = useRef(0);
  const editorRequestIdRef = useRef(0);
  const mobileLayout = useMobileVaultLayout();

  const closeContextMenu = useCallback((restoreFocus = true) => {
    const returnFocusElement = contextMenu?.returnFocusElement;
    setContextMenu(null);
    if (restoreFocus && returnFocusElement?.isConnected) {
      window.setTimeout(() => returnFocusElement.focus(), 0);
    }
  }, [contextMenu]);

  const showLeftPanel = useCallback((mode?: LeftPanelMode) => {
    if (mode) {
      setLeftMode(mode);
    }
    setLeftOpen(true);
    if (mobileLayout) {
      setRightOpen(false);
    }
  }, [mobileLayout]);

  const showRightPanel = useCallback((mode: RightPanelMode) => {
    setRightMode(mode);
    setRightOpen(true);
    if (mobileLayout) {
      setLeftOpen(false);
    }
  }, [mobileLayout]);

  const toggleLeftPanel = useCallback(() => {
    const next = !leftOpen;
    setLeftOpen(next);
    if (next && mobileLayout) {
      setRightOpen(false);
    }
  }, [leftOpen, mobileLayout]);

  const toggleRightPanel = useCallback(() => {
    const next = !rightOpen;
    setRightOpen(next);
    if (next && mobileLayout) {
      setLeftOpen(false);
    }
  }, [mobileLayout, rightOpen]);

  useEffect(() => {
    if (mobileLayout && leftOpen && rightOpen) {
      setRightOpen(false);
    }
  }, [leftOpen, mobileLayout, rightOpen]);

  useEffect(() => () => {
    workspaceSaveGenerationRef.current += 1;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    importAbortRef.current?.abort();
    importAbortRef.current = null;
  }, []);

  useEffect(() => {
    renameEntryRef.current = renameEntry;
  });

  useVaultNavigationShortcuts({
    enabled: Boolean(privateKey && profile),
    onOpenCommandPalette: () => setCommandPaletteOpen(true),
    onOpenQuickSwitcher: () => setQuickSwitcherOpen(true)
  });

  useEffect(() => {
    if (!contextMenu && !moveTarget) {
      return undefined;
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
        setMoveTarget(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeContextMenu, contextMenu, moveTarget]);

  useEffect(() => {
    if (!privateKey || !profile || typeof Worker === "undefined") {
      setKnowledgeClient(null);
      return undefined;
    }
    let client: KnowledgeWorkerClient;
    try {
      client = new KnowledgeWorkerClient();
    } catch {
      setKnowledgeClient(null);
      return undefined;
    }
    setKnowledgeClient(client);
    return () => {
      setKnowledgeClient((current) => current === client ? null : current);
      void client.dispose();
    };
  }, [privateKey, profile]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    if (!privateKey || !profile) {
      return undefined;
    }
    let active = true;
    setWorkspaceReady(false);

    void loadVaultWorkspaceRecord<VaultWorkspaceState>(profile.uid, privateKey)
      .then((record) => {
        if (!active) {
          return;
        }
        const restored = normalizeVaultWorkspaceState(record?.state);
        const restoredTabs = restored.tabs.map((tab) => restoredTab(tab));
        const restoredActive = restored.activeTab ? restoredTab(restored.activeTab).id : null;
        setTabs(restoredTabs);
        setActiveTabId(restoredTabs.some((tab) => tab.id === restoredActive)
          ? restoredActive
          : restoredTabs[0]?.id ?? null);
        setLeftMode(restored.left.mode);
        setLeftOpen(restored.left.open);
        setRightMode(restored.right.mode);
        setRightOpen(restored.right.open);
        setSelectedFolderId(restored.selectedFolderId);
        setExpandedFolderIds(new Set(restored.expandedFolderIds));
        setSearchQuery(restored.searchQuery);
        setViewMode(restored.viewMode);
        setGlobalGraphSettings(restored.globalGraph.settings);
        setLocalGraphSettings(restored.localGraph.settings);
        setGlobalViewport(restored.globalGraph.viewport);
        setLocalViewport(restored.localGraph.viewport);
        setGlobalCollapsedSections(restored.globalGraph.collapsedSections);
        setLocalCollapsedSections(restored.localGraph.collapsedSections);
        setGraphBookmarks(restored.graphBookmarks);
        workspaceRevisionRef.current = record?.revision;
        lastSavedWorkspaceRef.current = JSON.stringify(restored);
        setWorkspaceReady(true);
      })
      .catch(() => {
        if (active) {
          setError("암호화 워크스페이스 상태를 불러오지 못했습니다. 덮어쓰지 않고 현재 세션만 사용합니다.");
        }
      });

    return () => {
      active = false;
    };
  }, [privateKey, profile]);

  const ownerIds = useMemo(() => {
    if (!profile || profile.isAdmin) {
      return null;
    }
    return Array.from(new Set([profile.uid, ...users.filter((user) => user.isActive).map((user) => user.uid)])).sort();
  }, [profile, users]);
  const ownerIdKey = ownerIds?.join("\n") ?? "admin";

  useEffect(() => {
    if (!privateKey || !profile) {
      setUsers([]);
      return undefined;
    }
    return subscribeUsers(setUsers, () => setError("공유 사용자 목록을 불러오지 못했습니다."));
  }, [privateKey, profile]);

  useEffect(() => {
    if (!privateKey || !profile) {
      setRawNotes([]);
      return undefined;
    }
    const visibleOwners = ownerIdKey === "admin" ? null : ownerIdKey.split("\n").filter(Boolean);
    return subscribeVisibleNotes(
      profile.uid,
      visibleOwners,
      setRawNotes,
      () => setError("암호화 노트 목록을 불러오지 못했습니다.")
    );
  }, [ownerIdKey, privateKey, profile]);

  useEffect(() => {
    if (!privateKey || !profile) {
      setRawFolders([]);
      return undefined;
    }
    return subscribeNoteFolders(profile.uid, setRawFolders, () => setError("폴더 목록을 불러오지 못했습니다."));
  }, [privateKey, profile]);

  useEffect(() => {
    if (!privateKey || !profile) {
      setNotes([]);
      setFolders([]);
      return;
    }
    const generation = decryptGeneration.current + 1;
    decryptGeneration.current = generation;
    void Promise.all([
      decryptVaultNotes(rawNotes, profile.uid, privateKey),
      decryptVaultFolders(rawFolders, profile.uid, privateKey)
    ]).then(([nextNotes, nextFolders]) => {
      if (decryptGeneration.current !== generation) {
        return;
      }
      const folderAudit = auditVaultFolderTree(nextFolders);
      setNotes(nextNotes);
      setFolders(nextFolders);
      if (!folderAudit.valid) {
        setError("폴더 트리 무결성 오류를 발견했습니다. 폴더 이동과 마이그레이션을 중단했습니다.");
        setStatus(`${nextNotes.length}개 항목 연결됨 · 폴더 복구 필요`);
      } else {
        setStatus(`${nextNotes.length}개 항목 연결됨`);
      }
    });
  }, [privateKey, profile, rawFolders, rawNotes]);

  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const note of notes) {
        if (!next[note.id]?.dirty) {
          next[note.id] = {
            baseRevision: note.revision ?? 0,
            body: note.body,
            dirty: false,
            folderId: note.folderId ?? null,
            title: note.title
          };
        }
      }
      for (const entryId of Object.keys(next)) {
        if (!notes.some((note) => note.id === entryId)) {
          delete next[entryId];
        }
      }
      return next;
    });
  }, [notes]);

  const folderPaths = useMemo(() => buildVaultPaths(folders), [folders]);
  const entryPaths = useMemo(
    () => new Map(notes.map((note) => [note.id, vaultEntryPath(note, folderPaths)])),
    [folderPaths, notes]
  );
  const availableTemplates = useMemo(
    () => templateCandidates(notes, entryPaths),
    [entryPaths, notes]
  );
  const indexEntries = useMemo<VaultIndexEntry[]>(() => notes.map((note) => ({
    id: note.id,
    path: entryPaths.get(note.id) ?? entryLabel(note),
    kind: note.entryKind,
    content: note.entryKind === "asset"
      ? undefined
      : note.contentFormat === "legacy-html-v1"
        ? previewTextFromHtml(note.body)
        : note.body,
    createdAt: timestampMillis(note.createdAt),
    updatedAt: timestampMillis(note.updatedAt)
  })), [entryPaths, notes]);
  const decodedAssetsByEntryId = useMemo(() => {
    const decoded = new Map<string, ReturnType<typeof decodeVaultAsset>>();
    for (const note of notes) {
      if (note.entryKind !== "asset") {
        continue;
      }
      try {
        decoded.set(note.id, decodeVaultAsset(draftsRef.current[note.id]?.body ?? note.body));
      } catch {
        // A damaged authenticated payload remains visible as an entry, but is
        // never handed to a browser decoder or silently omitted from export.
      }
    }
    return decoded;
  }, [notes]);
  const canvasFileOptions = useMemo(() => indexEntries
    .filter((entry) => entry.kind !== "legacy-html")
    .map((entry) => ({
      ...(entry.kind === "asset" ? { asset: decodedAssetsByEntryId.get(entry.id) } : {}),
      kind: entry.kind as "markdown" | "canvas" | "base" | "asset",
      label: entry.path,
      path: entry.path
    })), [decodedAssetsByEntryId, indexEntries]);
  const indexEntryById = useMemo(
    () => new Map(indexEntries.map((entry) => [entry.id, entry])),
    [indexEntries]
  );
  const fallbackKnowledgeIndex = useMemo(
    () => knowledgeClient ? null : buildKnowledgeIndex(indexEntries),
    [indexEntries, knowledgeClient]
  );
  const metadataSummaryByEntryId = useMemo(
    () => new Map(metadataSummaries.map((summary) => [summary.entryId, summary])),
    [metadataSummaries]
  );
  const baseMetadataByEntryId = useMemo<ReadonlyMap<string, ParsedMarkdownMetadata>>(() => {
    if (!knowledgeClient && fallbackKnowledgeIndex) {
      return fallbackKnowledgeIndex.metadataByEntryId;
    }
    return new Map(metadataSummaries.map((summary) => [summary.entryId, {
      aliases: summary.aliases,
      blocks: summary.blocks,
      headings: summary.headings,
      links: [],
      properties: summary.properties,
      tags: summary.tags
    }]));
  }, [fallbackKnowledgeIndex, knowledgeClient, metadataSummaries]);

  useEffect(() => {
    if (!knowledgeClient) {
      return undefined;
    }
    let active = true;
    setWorkerSearchEntryIds(null);
    void knowledgeClient.replaceVault(indexEntries)
      .then(() => Promise.all([
        knowledgeClient.metadataSummaries(),
        knowledgeClient.tags()
      ]))
      .then(([summaries, tags]) => {
        if (!active) {
          return;
        }
        setMetadataSummaries(summaries);
        setIndexedTags(tags);
        setKnowledgeVersion((version) => version + 1);
      })
      .catch(() => {
        if (active) {
          setError("지식 인덱스를 갱신하지 못했습니다. 평문 내용은 로그에 남기지 않았습니다.");
        }
      });
    return () => {
      active = false;
    };
  }, [indexEntries, knowledgeClient]);

  const quickSwitcherEntries = useMemo<QuickSwitcherItem[]>(() => [
    ...notes.map((note): QuickSwitcherItem => ({
      id: note.id,
      title: entryLabel(note),
      path: entryPaths.get(note.id),
      aliases: metadataSummaryByEntryId.get(note.id)?.aliases
        ?? fallbackKnowledgeIndex?.metadataByEntryId.get(note.id)?.aliases,
      kind: note.entryKind
    })),
    ...folders.map((folder): QuickSwitcherItem => ({
      id: `folder:${folder.id}`,
      title: folder.displayName,
      path: folderPaths.get(folder.id),
      kind: "folder"
    }))
  ], [entryPaths, fallbackKnowledgeIndex, folderPaths, folders, metadataSummaryByEntryId, notes]);
  const commandPaletteCommands = useMemo<CommandPaletteItem[]>(() => [
    ...vaultCommands,
    ...graphBookmarks.map((bookmark) => ({
      id: `graph-bookmark:${bookmark.id}`,
      label: bookmark.label,
      section: "그래프 북마크",
      keywords: ["graph", "bookmark", "그래프", "북마크"]
    }))
  ], [graphBookmarks]);

  useEffect(() => {
    if (!workspaceReady || requestedWorkspaceView === "graph") {
      return;
    }
    const requestedEntryId = searchParams.get("entry");
    const firstEntry = requestedEntryId && notes.some((note) => note.id === requestedEntryId)
      ? notes.find((note) => note.id === requestedEntryId)
      : notes[0];
    if (!firstEntry || tabs.length) {
      return;
    }
    const tab = { id: `entry:${firstEntry.id}`, kind: "entry", entryId: firstEntry.id, label: entryLabel(firstEntry) } as const;
    setTabs([tab]);
    setActiveTabId(tab.id);
  }, [notes, requestedWorkspaceView, searchParams, tabs.length, workspaceReady]);

  useEffect(() => {
    setTabs((current) => current.map((tab) => {
      if (tab.kind !== "entry") {
        return tab;
      }
      const note = notes.find((candidate) => candidate.id === tab.entryId);
      return note ? { ...tab, label: entryLabel(note) } : tab;
    }));
  }, [notes]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeEntryId = activeTab?.kind === "entry" ? activeTab.entryId : null;
  const activeNote = activeEntryId ? notes.find((note) => note.id === activeEntryId) ?? null : null;
  const activeDraft = activeEntryId ? drafts[activeEntryId] : undefined;
  const deferredActiveBody = useDeferredValue(activeDraft?.body ?? "");
  const activeDocumentStats = useMemo(
    () => markdownDocumentStats(deferredActiveBody),
    [deferredActiveBody]
  );
  const activeMetadata = activeEntryId
    ? metadataSummaryByEntryId.get(activeEntryId)
      ?? fallbackKnowledgeIndex?.metadataByEntryId.get(activeEntryId)
    : undefined;
  const backlinks = activeEntryId
    ? knowledgeClient
      ? workerBacklinks
      : fallbackKnowledgeIndex ? backlinkOccurrences(fallbackKnowledgeIndex, activeEntryId) : []
    : [];
  const outgoing = activeEntryId
    ? knowledgeClient
      ? workerOutgoing
      : fallbackKnowledgeIndex ? outgoingOccurrences(fallbackKnowledgeIndex, activeEntryId) : []
    : [];

  useEffect(() => {
    setEditorInsertRequest((current) => current?.entryId === activeEntryId ? current : null);
    setEditorRevealRequest((current) => current?.entryId === activeEntryId ? current : null);
  }, [activeEntryId]);

  useEffect(() => {
    if (
      !knowledgeClient
      || !activeNote
      || !activeDraft?.dirty
      || activeNote.contentFormat === "legacy-html-v1"
    ) {
      return undefined;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      const path = vaultEntryPath({
        ...activeNote,
        folderId: activeDraft.folderId,
        title: activeDraft.title
      }, folderPaths);
      const entry: VaultIndexEntry = {
        id: activeNote.id,
        path,
        kind: activeNote.entryKind,
        content: activeNote.entryKind === "asset" ? undefined : activeDraft.body,
        createdAt: timestampMillis(activeNote.createdAt),
        updatedAt: Date.now()
      };
      void knowledgeClient.upsertEntry(entry)
        .then(() => Promise.all([
          knowledgeClient.metadataSummaries([entry.id]),
          knowledgeClient.tags()
        ]))
        .then(([summaries, tags]) => {
          if (!active) {
            return;
          }
          setMetadataSummaries((current) => [
            ...current.filter((summary) => summary.entryId !== entry.id),
            ...summaries
          ]);
          setIndexedTags(tags);
          setKnowledgeVersion((version) => version + 1);
        })
        .catch(() => {
          if (active) {
            setError("편집 중인 노트의 연결 인덱스를 갱신하지 못했습니다.");
          }
        });
    }, 400);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeDraft, activeNote, folderPaths, knowledgeClient]);

  useEffect(() => {
    if (!workspaceReady || !profile || !privateKey) {
      return undefined;
    }
    const persistedWorkspace = workspaceStateForSave({
      activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      expandedFolderIds,
      globalCollapsedSections,
      globalGraphSettings,
      globalViewport,
      graphBookmarks,
      leftMode,
      leftOpen,
      localCollapsedSections,
      localGraphSettings,
      localViewport,
      rightMode,
      rightOpen,
      searchQuery,
      selectedFolderId,
      tabs,
      viewMode
    });
    const serialized = JSON.stringify(persistedWorkspace);
    if (serialized === lastSavedWorkspaceRef.current) {
      return undefined;
    }
    const saveGeneration = workspaceSaveGenerationRef.current;
    const timer = window.setTimeout(() => {
      const saveTask = workspaceSaveChainRef.current.then(async () => {
        if (
          workspaceSaveGenerationRef.current !== saveGeneration
          || serialized === lastSavedWorkspaceRef.current
        ) {
          return;
        }
        const result = await saveVaultWorkspace(
          profile,
          privateKey,
          persistedWorkspace as unknown as VaultWorkspaceState,
          workspaceRevisionRef.current
        );
        if (workspaceSaveGenerationRef.current !== saveGeneration) {
          return;
        }
        workspaceRevisionRef.current = result.revision;
        lastSavedWorkspaceRef.current = serialized;
      });
      workspaceSaveChainRef.current = saveTask.catch((caught) => {
        if (workspaceSaveGenerationRef.current !== saveGeneration) {
          return;
        }
        workspaceSaveGenerationRef.current += 1;
        setWorkspaceReady(false);
        if (caught instanceof VaultWorkspaceRevisionConflictError) {
          setError("다른 탭에서 워크스페이스 배치가 변경되었습니다. 새로고침 후 다시 시도해주세요.");
        } else {
          setError("암호화 워크스페이스 상태를 저장하지 못했습니다. 노트 본문 저장에는 영향을 주지 않습니다.");
        }
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    activeTabId,
    expandedFolderIds,
    globalCollapsedSections,
    globalGraphSettings,
    globalViewport,
    graphBookmarks,
    leftMode,
    leftOpen,
    localCollapsedSections,
    localGraphSettings,
    localViewport,
    privateKey,
    profile,
    rightMode,
    rightOpen,
    searchQuery,
    selectedFolderId,
    tabs,
    viewMode,
    workspaceReady
  ]);

  useEffect(() => {
    if (!knowledgeClient || knowledgeVersion === 0) {
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    const searchPromise = searchQuery.trim()
      ? knowledgeClient.search(searchQuery, { signal: controller.signal })
      : Promise.resolve(null);
    void searchPromise
      .then((entryIds) => {
        if (!active) {
          return;
        }
        setWorkerSearchEntryIds(entryIds);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) {
          setError("지식 검색을 완료하지 못했습니다.");
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [knowledgeClient, knowledgeVersion, searchQuery]);

  useEffect(() => {
    if (!knowledgeClient || knowledgeVersion === 0) {
      return undefined;
    }
    let active = true;
    const backlinksPromise = activeEntryId ? knowledgeClient.backlinks(activeEntryId) : Promise.resolve([]);
    const outgoingPromise = activeEntryId ? knowledgeClient.outgoingLinks(activeEntryId) : Promise.resolve([]);
    void Promise.all([backlinksPromise, outgoingPromise])
      .then(([nextBacklinks, nextOutgoing]) => {
        if (active) {
          setWorkerBacklinks(nextBacklinks);
          setWorkerOutgoing(nextOutgoing);
        }
      })
      .catch(() => {
        if (active) setError("링크 목록을 계산하지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [activeEntryId, knowledgeClient, knowledgeVersion]);

  useEffect(() => {
    if (!knowledgeClient || knowledgeVersion === 0) {
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    void knowledgeClient.graphSnapshot(
      deferredGlobalGraphDataSettings,
      undefined,
      { signal: controller.signal }
    ).then((snapshot) => {
      if (active) setWorkerGlobalSnapshot(snapshot);
    }).catch(() => {
      if (active && !controller.signal.aborted) setError("전체 그래프를 계산하지 못했습니다.");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [deferredGlobalGraphDataSettings, knowledgeClient, knowledgeVersion]);

  useEffect(() => {
    if (!knowledgeClient || knowledgeVersion === 0) {
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    void knowledgeClient.graphSnapshot(
      deferredLocalGraphDataSettings,
      activeEntryId ?? undefined,
      { signal: controller.signal }
    ).then((snapshot) => {
      if (active) setWorkerLocalSnapshot(snapshot);
    }).catch(() => {
      if (active && !controller.signal.aborted) setError("로컬 그래프를 계산하지 못했습니다.");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeEntryId, deferredLocalGraphDataSettings, knowledgeClient, knowledgeVersion]);

  const fallbackGlobalSnapshot = useKnowledgeGraphSnapshot(
    fallbackKnowledgeIndex,
    deferredGlobalGraphDataSettings,
    activeEntryId
  );
  const fallbackLocalSnapshot = useKnowledgeGraphSnapshot(
    fallbackKnowledgeIndex,
    deferredLocalGraphDataSettings,
    activeEntryId
  );
  const globalSnapshot = workerGlobalSnapshot ?? fallbackGlobalSnapshot;
  const localSnapshot = workerLocalSnapshot ?? fallbackLocalSnapshot;
  const graphUiNodes = useMemo(
    () => graphNodesForUi(globalSnapshot, indexEntries),
    [globalSnapshot, indexEntries]
  );
  const graphUiEdges = useMemo(() => graphEdgesForUi(globalSnapshot), [globalSnapshot]);
  const localUiNodes = useMemo(
    () => graphNodesForUi(localSnapshot, indexEntries),
    [indexEntries, localSnapshot]
  );
  const localUiEdges = useMemo(() => graphEdgesForUi(localSnapshot), [localSnapshot]);

  const filteredNotes = useMemo(() => {
    if (!searchQuery.trim()) {
      return notes;
    }
    if (knowledgeClient) {
      const matches = new Set(workerSearchEntryIds ?? []);
      return notes.filter((note) => matches.has(note.id));
    }
    if (!fallbackKnowledgeIndex) {
      return [];
    }
    return notes.filter((note) => {
      const indexedEntry = indexEntryById.get(note.id);
      const metadata = fallbackKnowledgeIndex.metadataByEntryId.get(note.id);
      if (!indexedEntry || !metadata) {
        return false;
      }
      return matchesVaultSearchQuery(searchQuery, indexedEntry, metadata, { allowRegex: false });
    });
  }, [fallbackKnowledgeIndex, indexEntryById, knowledgeClient, notes, searchQuery, workerSearchEntryIds]);

  const visibleTags = knowledgeClient
    ? indexedTags
    : [...(fallbackKnowledgeIndex?.tags.values() ?? [])];

  const completionNotes = useMemo(() => indexEntries
    .filter((entry) => entry.kind !== "asset" && entry.kind !== "legacy-html")
    .map((entry) => {
      const metadata = baseMetadataByEntryId.get(entry.id);
      return {
        aliases: metadata?.aliases ?? [],
        blocks: metadata?.blocks.map((block) => block.id) ?? [],
        headings: metadata?.headings.map((heading) => heading.text) ?? [],
        path: entry.path
      };
    }), [baseMetadataByEntryId, indexEntries]);
  const completionTags = useMemo(() => (
    knowledgeClient
      ? indexedTags
      : [...(fallbackKnowledgeIndex?.tags.values() ?? [])]
  ).map((tag) => tag.displayName), [fallbackKnowledgeIndex, indexedTags, knowledgeClient]);
  const markdownCompletionData = {
    currentBlocks: activeMetadata?.blocks.map((block) => block.id) ?? [],
    currentHeadings: activeMetadata?.headings.map((heading) => heading.text) ?? [],
    currentNotePath: activeEntryId ? entryPaths.get(activeEntryId) ?? null : null,
    notes: completionNotes,
    tags: completionTags
  };

  const saveEntry = useCallback(async (entryId: string) => {
    if (!profile || !privateKey || savingEntryIdsRef.current.has(entryId)) {
      return;
    }
    const note = notes.find((candidate) => candidate.id === entryId);
    const draft = draftsRef.current[entryId];
    if (!note || !draft?.dirty || note.contentFormat === "legacy-html-v1") {
      return;
    }
    if (draft.title.trim() !== note.title.trim()) {
      await renameEntryRef.current(entryId, draft.title);
      return;
    }
    const duplicate = notes.some((candidate) => (
      candidate.id !== entryId
      && (candidate.folderId ?? null) === draft.folderId
      && normalizedEntryTitle(candidate.title, candidate.entryKind) === normalizedEntryTitle(draft.title, note.entryKind)
    ));
    if (duplicate) {
      setError("같은 폴더에 동일한 이름의 항목이 있습니다.");
      return;
    }

    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    setError(null);
    try {
      const result = await saveEncryptedVaultEntry(
        { ...note, revision: draft.baseRevision },
        profile.uid,
        privateKey,
        draft
      );
      setNotes((current) => current.map((candidate) => (
        candidate.id === entryId
          ? { ...candidate, title: draft.title.trim(), body: draft.body, folderId: draft.folderId, revision: result.revision }
          : candidate
      )));
      setDrafts((current) => {
        const latest = current[entryId];
        const next = latest && latest.title === draft.title && latest.body === draft.body && latest.folderId === draft.folderId
          ? { ...current, [entryId]: { ...latest, baseRevision: result.revision, dirty: false } }
          : current;
        draftsRef.current = next;
        return next;
      });
      setStatus("Markdown 원본과 암호화 이력을 저장했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "노트를 저장하지 못했습니다.");
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  }, [notes, privateKey, profile]);

  async function flushDirtyEntries() {
    const dirtyEntryIds = Object.entries(draftsRef.current)
      .filter(([, draft]) => draft.dirty)
      .map(([entryId]) => entryId);
    if (!dirtyEntryIds.length) {
      return true;
    }
    setStatus("이동하기 전에 편집 내용을 저장하는 중입니다…");
    for (const entryId of dirtyEntryIds) {
      await saveEntry(entryId);
    }
    const remaining = Object.values(draftsRef.current).filter((draft) => draft.dirty).length;
    if (!remaining) {
      return true;
    }
    return window.confirm(`${remaining}개 항목을 아직 저장하지 못했습니다. 편집 내용을 남겨둔 채 이동할까요?`);
  }

  useEffect(() => {
    const hasDirtyDrafts = Object.values(drafts).some((draft) => draft.dirty);
    if (!hasDirtyDrafts) {
      return undefined;
    }
    const preventAccidentalUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalUnload);
    return () => window.removeEventListener("beforeunload", preventAccidentalUnload);
  }, [drafts]);

  async function navigateAfterSaving(destination: string) {
    if (await flushDirtyEntries()) {
      navigate(destination);
    }
  }

  useEffect(() => {
    if (!activeEntryId || !activeDraft?.dirty) {
      return undefined;
    }
    const timer = window.setTimeout(() => void saveEntry(activeEntryId), 1_500);
    return () => window.clearTimeout(timer);
  }, [activeDraft?.body, activeDraft?.dirty, activeDraft?.folderId, activeDraft?.title, activeEntryId, saveEntry]);

  function updateActiveDraft(patch: Partial<Omit<DraftState, "dirty" | "baseRevision">>) {
    if (!activeEntryId) {
      return;
    }
    setDrafts((current) => ({
      ...current,
      [activeEntryId]: {
        ...(current[activeEntryId] ?? {
          baseRevision: activeNote?.revision ?? 0,
          title: "",
          body: "",
          folderId: null
        }),
        ...patch,
        dirty: true
      }
    }));
  }

  function openEntry(entryId: string, intent: GraphOpenIntent = { target: "current" }) {
    const note = notes.find((candidate) => candidate.id === entryId);
    if (!note) {
      return;
    }
    if (intent.target === "new-window") {
      if (activeEntryId) {
        void saveEntry(activeEntryId);
      }
      const openedWindow = window.open(`/app?entry=${encodeURIComponent(entryId)}`, "_blank", "noopener,noreferrer");
      if (openedWindow) {
        openedWindow.opener = null;
      }
      return;
    }
    if (activeEntryId && activeEntryId !== entryId) {
      void saveEntry(activeEntryId);
    }
    const nextTab: WorkspaceTab = { id: `entry:${entryId}`, kind: "entry", entryId, label: entryLabel(note) };
    setTabs((current) => {
      if (current.some((tab) => tab.id === nextTab.id)) {
        return current;
      }
      if (intent.target === "current" && activeTabId) {
        return current.map((tab) => tab.id === activeTabId ? nextTab : tab);
      }
      return [...current, nextTab];
    });
    setActiveTabId(nextTab.id);
    if (mobileLayout) {
      setLeftOpen(false);
      setRightOpen(false);
    }
  }

  async function createEntry(
    kind: "markdown" | "canvas" | "base",
    titleBase?: string,
    body?: string,
    options: CreateVaultEntryOptions = {}
  ) {
    if (!profile) {
      return;
    }
    setError(null);
    try {
      const folderId = options.folderId === undefined ? selectedFolderId : options.folderId;
      const requestedTitle = titleBase ?? (kind === "canvas" ? "새 캔버스" : kind === "base" ? "새 Base" : "새 노트");
      const collision = options.preserveRequestedTitle
        ? notes.find((note) => (
            (note.folderId ?? null) === folderId
            && normalizedEntryTitle(note.title, note.entryKind) === normalizedEntryTitle(requestedTitle, kind)
          ))
        : undefined;
      if (collision) {
        openEntry(collision.id);
        return;
      }
      const title = options.preserveRequestedTitle
        ? requestedTitle.trim().normalize("NFC")
        : uniqueTitle(notes, requestedTitle, folderId, kind);
      const result = kind === "markdown"
        ? await createMarkdownVaultNote(profile, { body: body ?? "", folderId, title })
        : await createEncryptedVaultEntry(profile, kind === "canvas" ? {
            body: body ?? emptyJsonCanvas,
            contentFormat: "json-canvas-v1",
            entryKind: "canvas",
            folderId,
            title
          } : {
            body: body ?? "",
            contentFormat: "base-v1",
            entryKind: "base",
            folderId,
            title
          });
      const tab: WorkspaceTab = { id: `entry:${result.noteId}`, kind: "entry", entryId: result.noteId, label: title };
      setTabs((current) => [...current.filter((item) => item.id !== tab.id), tab]);
      setActiveTabId(tab.id);
      if (mobileLayout) {
        setLeftOpen(false);
        setRightOpen(false);
      }
      setStatus(kind === "canvas"
        ? "암호화 Canvas를 만들었습니다."
        : kind === "base"
          ? "암호화 Base를 만들었습니다."
          : "Markdown 노트를 만들었습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "새 항목을 만들지 못했습니다.");
    }
  }

  async function createUnresolvedMarkdownEntry(requestedPath: string) {
    if (!profile) {
      return;
    }
    setError(null);
    try {
      const target = planUnresolvedMarkdownTarget(requestedPath);
      requireValidProposedVaultFolderTree(
        folders.map((folder) => ({
          id: folder.id,
          parentId: folder.parentId ?? null,
          path: folderPaths.get(folder.id) ?? folder.displayName
        })),
        target.folders
      );
      const folderIdByPathKey = new Map(
        folders.flatMap((folder) => {
          const path = folderPaths.get(folder.id);
          return path ? [[vaultPathCollisionKey(path), folder.id] as const] : [];
        })
      );
      let parentId: string | null = null;
      const expandedIds: string[] = [];
      for (const [index, folder] of target.folders.entries()) {
        const key = vaultPathCollisionKey(folder.path);
        const existingFolderId = folderIdByPathKey.get(key);
        if (existingFolderId) {
          parentId = existingFolderId;
          expandedIds.push(existingFolderId);
          continue;
        }
        const created = await createEncryptedVaultFolder(
          profile,
          folder.name,
          parentId,
          folders.length + index
        );
        parentId = created.id;
        folderIdByPathKey.set(key, created.id);
        expandedIds.push(created.id);
      }
      if (expandedIds.length) {
        setExpandedFolderIds((current) => new Set([...current, ...expandedIds]));
      }
      await createEntry("markdown", target.title, "", {
        folderId: parentId,
        preserveRequestedTitle: true
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "링크 경로에 노트를 만들지 못했습니다.");
    }
  }

  const openGlobalGraph = useCallback(() => {
    const tab: WorkspaceTab = { id: "global-graph", kind: "global-graph", label: "그래프 보기" };
    setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
    if (mobileLayout) {
      setLeftOpen(false);
      setRightOpen(false);
    }
  }, [mobileLayout]);

  useEffect(() => {
    if (!workspaceReady) {
      return;
    }

    if (requestedWorkspaceView === "graph") {
      openGlobalGraph();
      return;
    }

    if (requestedWorkspacePanel === "files" || requestedWorkspacePanel === "search") {
      showLeftPanel(requestedWorkspacePanel);
    }
  }, [
    location.key,
    openGlobalGraph,
    requestedWorkspacePanel,
    requestedWorkspaceView,
    showLeftPanel,
    workspaceReady
  ]);

  function closeTab(tabId: string) {
    const closingTab = tabs.find((tab) => tab.id === tabId);
    if (closingTab?.kind === "entry") {
      void saveEntry(closingTab.entryId);
    }
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      const next = current.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next[Math.min(index, Math.max(0, next.length - 1))]?.id ?? null);
      }
      return next;
    });
  }

  async function createFolder() {
    if (!profile) {
      return;
    }
    const name = window.prompt("새 폴더 이름");
    if (!name) {
      return;
    }
    if (folders.some((folder) => (
      (folder.parentId ?? null) === selectedFolderId
      && folder.displayName.trim().localeCompare(name.trim(), undefined, { sensitivity: "accent" }) === 0
    ))) {
      setError("같은 위치에 동일한 이름의 폴더가 있습니다.");
      return;
    }
    try {
      requireValidVaultFolderTree([
        ...folders,
        {
          id: `pending-folder-${crypto.randomUUID()}`,
          parentId: selectedFolderId
        }
      ]);
      await createEncryptedVaultFolder(profile, name, selectedFolderId, folders.length);
      setStatus("암호화 폴더를 만들었습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "폴더를 만들지 못했습니다.");
    }
  }

  async function migrateFolders() {
    if (!profile || folderMigrationBusy) {
      return;
    }
    const legacyFolders = rawFolders.filter((folder) => !folder.encryptedName || !folder.wrappedKey);
    if (!legacyFolders.length) {
      return;
    }
    setFolderMigrationBusy(true);
    setError(null);
    try {
      requireValidVaultFolderTree(rawFolders);
      for (const [index, folder] of legacyFolders.entries()) {
        await migrateLegacyVaultFolder(profile, folder, index);
      }
      setStatus(`${legacyFolders.length}개 폴더 이름을 암호화했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "폴더 암호화 마이그레이션을 완료하지 못했습니다.");
    } finally {
      setFolderMigrationBusy(false);
    }
  }

  function revisionedIndexEntries(): RevisionedVaultIndexEntry[] {
    const notesById = new Map(notes.map((note) => [note.id, note]));
    return indexEntries.map((entry) => ({
      ...entry,
      content: entry.kind === "asset"
        ? undefined
        : draftsRef.current[entry.id]?.body ?? entry.content,
      revision: notesById.get(entry.id)?.revision ?? 0
    }));
  }

  async function persistIncomingLinkRewritePlans(
    plans: readonly IncomingInternalLinkRewritePlan[],
    excludedEntryId: string
  ) {
    if (!profile || !privateKey) {
      return { failed: plans.length, updated: 0 };
    }
    let failed = 0;
    let updated = 0;
    for (const plan of plans) {
      if (plan.sourceEntryId === excludedEntryId) {
        continue;
      }
      const sourceNote = notes.find((candidate) => candidate.id === plan.sourceEntryId);
      const sourceDraft = draftsRef.current[plan.sourceEntryId];
      if (
        !sourceNote
        || !sourceDraft
        || sourceDraft.dirty
        || sourceDraft.baseRevision !== (sourceNote.revision ?? 0)
        || sourceNote.ownerUid !== profile.uid
        || sourceNote.type !== "personal"
        || sourceNote.contentFormat !== "markdown-v1"
        || savingEntryIdsRef.current.has(sourceNote.id)
      ) {
        failed += 1;
        continue;
      }
      const applied = applyInternalLinkRewritePlan(
        plan,
        sourceDraft.body,
        sourceDraft.baseRevision
      );
      if (applied.status !== "applied") {
        failed += 1;
        continue;
      }
      savingEntryIdsRef.current.add(sourceNote.id);
      setSavingEntryIds((current) => new Set(current).add(sourceNote.id));
      try {
        const nextDraft = { ...sourceDraft, body: applied.markdown, dirty: false };
        const result = await saveEncryptedVaultEntry(
          { ...sourceNote, revision: sourceDraft.baseRevision },
          profile.uid,
          privateKey,
          nextDraft
        );
        const savedDraft = { ...nextDraft, baseRevision: result.revision };
        draftsRef.current = { ...draftsRef.current, [sourceNote.id]: savedDraft };
        setDrafts((current) => ({ ...current, [sourceNote.id]: savedDraft }));
        setNotes((current) => current.map((candidate) => candidate.id === sourceNote.id
          ? { ...candidate, body: applied.markdown, revision: result.revision }
          : candidate));
        updated += applied.appliedPatchCount;
      } catch {
        failed += 1;
      } finally {
        savingEntryIdsRef.current.delete(sourceNote.id);
        setSavingEntryIds((current) => {
          const next = new Set(current);
          next.delete(sourceNote.id);
          return next;
        });
      }
    }
    return { failed, updated };
  }

  async function moveEntryToFolder(entryId: string, folderId: string | null) {
    if (!profile || !privateKey || savingEntryIdsRef.current.has(entryId)) {
      return;
    }
    const note = notes.find((candidate) => candidate.id === entryId);
    if (!note || note.type !== "personal" || note.ownerUid !== profile.uid) {
      setError("내 개인 항목만 폴더로 이동할 수 있습니다.");
      return;
    }
    if ((note.folderId ?? null) === folderId) {
      return;
    }
    if (notes.some((candidate) => (
      candidate.id !== entryId
      && (candidate.folderId ?? null) === folderId
      && normalizedEntryTitle(candidate.title, candidate.entryKind) === normalizedEntryTitle(note.title, note.entryKind)
    ))) {
      setError("대상 폴더에 동일한 이름의 항목이 있습니다.");
      return;
    }
    try {
      const nextPath = vaultEntryPath({ ...note, folderId }, folderPaths);
      const rewritePlans = planIncomingInternalLinkRewrites({
        entries: revisionedIndexEntries(),
        targetEntryId: entryId,
        newTargetPath: nextPath
      });
      const selfPlan = rewritePlans.find((plan) => plan.sourceEntryId === entryId);
      let expectedRevision = note.revision ?? 0;
      let rewrittenBody: string | null = null;
      if (selfPlan) {
        const targetDraft = draftsRef.current[entryId];
        if (!targetDraft || note.contentFormat !== "markdown-v1") {
          throw new Error("자기 링크를 안전하게 갱신할 수 없어 이동을 중단했습니다.");
        }
        const applied = applyInternalLinkRewritePlan(selfPlan, targetDraft.body, targetDraft.baseRevision);
        if (applied.status !== "applied") {
          throw new Error("노트가 다른 곳에서 변경되어 이동을 중단했습니다.");
        }
        const nextDraft = { ...targetDraft, body: applied.markdown, dirty: false };
        const saved = await saveEncryptedVaultEntry(
          { ...note, revision: targetDraft.baseRevision },
          profile.uid,
          privateKey,
          nextDraft
        );
        expectedRevision = saved.revision;
        rewrittenBody = applied.markdown;
        const savedDraft = { ...nextDraft, baseRevision: saved.revision };
        draftsRef.current = { ...draftsRef.current, [entryId]: savedDraft };
        setDrafts((current) => ({ ...current, [entryId]: savedDraft }));
      }
      const result = await updateRevisionedNoteFolder({
        expectedRevision,
        folderId,
        noteId: entryId,
        readerUids: note.participantUids,
        uid: profile.uid
      });
      setNotes((current) => current.map((candidate) => candidate.id === entryId
        ? {
            ...candidate,
            ...(rewrittenBody === null ? {} : { body: rewrittenBody }),
            folderId,
            lastMutationId: result.lastMutationId,
            revision: result.revision
          }
        : candidate));
      setDrafts((current) => current[entryId]
        ? { ...current, [entryId]: { ...current[entryId], baseRevision: result.revision, folderId } }
        : current);
      if (draftsRef.current[entryId]) {
        draftsRef.current = {
          ...draftsRef.current,
          [entryId]: { ...draftsRef.current[entryId], baseRevision: result.revision, folderId }
        };
      }
      const linkResult = await persistIncomingLinkRewritePlans(rewritePlans, entryId);
      setStatus(linkResult.failed
        ? `항목을 이동했지만 ${linkResult.failed}개 노트의 링크 갱신은 충돌로 남았습니다.`
        : `항목을 이동하고 내부 링크 ${linkResult.updated + (selfPlan?.patches.length ?? 0)}개를 갱신했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "항목을 이동하지 못했습니다.");
    }
  }

  async function moveFolder(folderId: string, parentId: string | null) {
    if (!profile || folderId === parentId) {
      return;
    }
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder?.encryptedName || !folder.wrappedKey) {
      setError("먼저 기존 폴더 이름을 암호화해주세요.");
      return;
    }
    if (folders.some((candidate) => (
      candidate.id !== folderId
      && (candidate.parentId ?? null) === parentId
      && candidate.displayName.trim().localeCompare(folder.displayName.trim(), undefined, { sensitivity: "accent" }) === 0
    ))) {
      setError("대상 위치에 동일한 이름의 폴더가 있습니다.");
      return;
    }
    const descendantPath = folderPaths.get(parentId ?? "") ?? "";
    const folderPath = folderPaths.get(folderId) ?? "";
    if (descendantPath.startsWith(`${folderPath}/`)) {
      setError("폴더를 자신의 하위 폴더로 이동할 수 없습니다.");
      return;
    }
    try {
      requireValidVaultFolderTree(folders.map((candidate) => (
        candidate.id === folderId ? { ...candidate, parentId } : candidate
      )));
      const result = await updateEncryptedNoteFolder({
        expectedRevision: folder.revision ?? 1,
        folderId,
        ownerUid: profile.uid,
        parentId
      });
      setFolders((current) => current.map((candidate) => candidate.id === folderId
        ? { ...candidate, parentId, revision: result.revision }
        : candidate));
      setStatus("폴더를 이동했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "폴더를 이동하지 못했습니다.");
    }
  }

  async function moveContextTarget(folderId: string | null) {
    const target = moveTarget;
    setMoveTarget(null);
    if (!target) {
      return;
    }
    if (target.targetKind === "entry") {
      await moveEntryToFolder(target.targetId, folderId);
    } else {
      await moveFolder(target.targetId, folderId);
    }
  }

  async function renameFolder(folderId: string) {
    if (!profile || !privateKey) {
      return;
    }
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) {
      return;
    }
    const name = window.prompt("폴더 이름 변경", folder.displayName)?.trim();
    if (!name || name === folder.displayName) {
      return;
    }
    if (folders.some((candidate) => (
      candidate.id !== folder.id
      && (candidate.parentId ?? null) === (folder.parentId ?? null)
      && candidate.displayName.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
    ))) {
      setError("같은 위치에 동일한 이름의 폴더가 있습니다.");
      return;
    }
    try {
      const result = await renameEncryptedVaultFolder(folder, profile.uid, privateKey, name);
      setFolders((current) => current.map((candidate) => candidate.id === folderId
        ? { ...candidate, displayName: name, revision: result.revision }
        : candidate));
      setStatus("암호화된 폴더 이름을 변경했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "폴더 이름을 변경하지 못했습니다.");
    }
  }

  async function renameEntry(entryId: string, requestedTitle?: string) {
    if (!profile || !privateKey || savingEntryIdsRef.current.has(entryId)) {
      return;
    }
    const note = notes.find((candidate) => candidate.id === entryId);
    const currentDraft = draftsRef.current[entryId];
    if (!note || !currentDraft || note.contentFormat === "legacy-html-v1") {
      setError("기존 HTML 노트는 Markdown 복사본으로 변환한 뒤 이름을 변경할 수 있습니다.");
      return;
    }
    const title = (requestedTitle ?? window.prompt("항목 이름 변경", currentDraft.title))?.trim();
    // The inline title field already updates the draft before Save is pressed.
    // Compare against the persisted note, not the draft, or an inline rename is
    // incorrectly treated as a no-op and the tree/tab keep the old title.
    if (!title || title === note.title.trim()) {
      return;
    }
    if (notes.some((candidate) => (
      candidate.id !== entryId
      && (candidate.folderId ?? null) === currentDraft.folderId
      && normalizedEntryTitle(candidate.title, candidate.entryKind) === normalizedEntryTitle(title, note.entryKind)
    ))) {
      setError("같은 폴더에 동일한 이름의 항목이 있습니다.");
      return;
    }

    const nextDraft = { ...currentDraft, title, dirty: true };
    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    try {
      const nextPath = vaultEntryPath({
        ...note,
        folderId: nextDraft.folderId,
        title
      }, folderPaths);
      const rewritePlans = planIncomingInternalLinkRewrites({
        entries: revisionedIndexEntries(),
        targetEntryId: entryId,
        newTargetPath: nextPath
      });
      const selfPlan = rewritePlans.find((plan) => plan.sourceEntryId === entryId);
      let rewrittenDraft = nextDraft;
      if (selfPlan) {
        const applied = applyInternalLinkRewritePlan(
          selfPlan,
          nextDraft.body,
          currentDraft.baseRevision
        );
        if (applied.status !== "applied") {
          throw new Error("노트가 다른 곳에서 변경되어 이름 변경을 중단했습니다.");
        }
        rewrittenDraft = { ...nextDraft, body: applied.markdown };
      }
      const result = await saveEncryptedVaultEntry(
        { ...note, revision: currentDraft.baseRevision },
        profile.uid,
        privateKey,
        rewrittenDraft
      );
      setNotes((current) => current.map((candidate) => candidate.id === entryId
        ? { ...candidate, body: rewrittenDraft.body, title, revision: result.revision }
        : candidate));
      const cleanDraft = { ...rewrittenDraft, baseRevision: result.revision, dirty: false };
      draftsRef.current = { ...draftsRef.current, [entryId]: cleanDraft };
      setDrafts((current) => ({
        ...current,
        [entryId]: cleanDraft
      }));
      const linkResult = await persistIncomingLinkRewritePlans(rewritePlans, entryId);
      setStatus(linkResult.failed
        ? `이름은 변경했지만 ${linkResult.failed}개 노트의 링크 갱신은 충돌로 남았습니다.`
        : `이름을 변경하고 내부 링크 ${linkResult.updated + (selfPlan?.patches.length ?? 0)}개를 갱신했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "항목 이름을 변경하지 못했습니다.");
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  }

  async function moveEntryToTrash(entryId: string) {
    if (!profile || !privateKey || savingEntryIdsRef.current.has(entryId)) {
      return;
    }
    const note = notes.find((candidate) => candidate.id === entryId);
    const draft = draftsRef.current[entryId];
    if (!note || note.ownerUid !== profile.uid) {
      setError("내가 소유한 항목만 휴지통으로 이동할 수 있습니다.");
      return;
    }
    if (!window.confirm(`'${entryLabel(note)}' 항목을 휴지통으로 이동할까요? 기존 노트 관리의 휴지통에서 복구할 수 있습니다.`)) {
      return;
    }

    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    try {
      let expectedRevision = note.revision ?? 0;
      if (draft?.dirty && note.contentFormat !== "legacy-html-v1") {
        const saved = await saveEncryptedVaultEntry(
          { ...note, revision: draft.baseRevision },
          profile.uid,
          privateKey,
          draft
        );
        expectedRevision = saved.revision;
      }
      await deleteRevisionedNote({
        expectedRevision,
        noteId: entryId,
        readerUids: note.participantUids,
        uid: profile.uid
      });
      setNotes((current) => current.filter((candidate) => candidate.id !== entryId));
      setDrafts((current) => {
        const next = { ...current };
        delete next[entryId];
        return next;
      });
      setTabs((current) => current.filter((tab) => tab.kind !== "entry" || tab.entryId !== entryId));
      if (activeEntryId === entryId) {
        setActiveTabId(null);
      }
      setStatus("항목을 휴지통으로 이동하고 revision 이력을 남겼습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "항목을 휴지통으로 이동하지 못했습니다.");
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  }

  function handleGraphNodeOpen(node: UiGraphNode, intent: GraphOpenIntent) {
    if (node.kind === "tag") {
      setSearchQuery(`tag:${node.label.replace(/^#/, "")}`);
      showLeftPanel("search");
      return;
    }
    if (node.kind === "unresolved") {
      void createUnresolvedMarkdownEntry(node.path ?? node.label);
      return;
    }
    const entryId = node.id.startsWith("entry:") ? node.id.slice("entry:".length) : null;
    if (entryId) {
      openEntry(entryId, intent);
    }
  }

  function handleMarkdownTagClick(tag: string) {
    setSearchQuery(`tag:${tag}`);
    showLeftPanel("search");
  }

  function resolveMarkdownReference(
    reference: MarkdownLinkReference,
    sourceEntryId = activeEntryId
  ) {
    if (reference.kind === "external" || !sourceEntryId) {
      return null;
    }
    const sourcePath = entryPaths.get(sourceEntryId);
    if (!sourcePath) {
      return null;
    }
    let fragment: InternalLinkOccurrence["fragment"];
    if (reference.subpath?.startsWith("#^")) {
      fragment = { kind: "block", value: reference.subpath.slice(2) };
    } else if (reference.subpath?.startsWith("#")) {
      fragment = { kind: "heading", value: reference.subpath.slice(1) };
    }
    return resolveInternalLink({
      sourceEntryId,
      sourcePath,
      syntax: reference.kind === "markdown-internal" ? "markdown" : "wikilink",
      raw: reference.raw,
      target: reference.path,
      displayText: reference.display,
      ...(fragment ? { fragment } : {}),
      embedded: reference.embed,
      line: 1,
      column: 1,
      context: reference.raw
    }, indexEntries, baseMetadataByEntryId);
  }

  function handleMarkdownLink(
    reference: MarkdownLinkReference,
    event: MouseEvent<HTMLElement>,
    sourceEntryId = activeEntryId
  ) {
    if (reference.kind === "external") {
      return;
    }
    const resolution = resolveMarkdownReference(reference, sourceEntryId);
    if (resolution?.targetEntryId) {
      openEntry(resolution.targetEntryId, {
        target: event.metaKey || event.ctrlKey ? "new-tab" : "current"
      });
      return;
    }
    const requestedPath = resolution?.unresolvedKey || reference.path || reference.display;
    if (window.confirm(`'${requestedPath}' 노트를 만들까요?`)) {
      void createUnresolvedMarkdownEntry(requestedPath);
    }
  }

  function renderMarkdownEmbed(reference: MarkdownLinkReference) {
    const resolution = resolveMarkdownReference(reference);
    const target = resolution?.targetEntryId
      ? notes.find((note) => note.id === resolution.targetEntryId)
      : null;
    if (!target) {
      return null;
    }
    if (target.entryKind === "asset") {
      const asset = decodedAssetsByEntryId.get(target.id);
      return (
        <span className="vault-markdown-embed-card vault-markdown-embed-card--asset">
          <button onClick={() => openEntry(target.id)} type="button">{entryLabel(target)}</button>
          {asset ? (
            <VaultAssetPreview
              asset={asset}
              compact
              fileName={draftsRef.current[target.id]?.title ?? target.title}
            />
          ) : (
            <span role="alert">첨부 데이터의 무결성을 확인할 수 없습니다.</span>
          )}
        </span>
      );
    }
    const targetBody = draftsRef.current[target.id]?.body ?? target.body;
    const preview = target.contentFormat === "markdown-v1"
      ? markdownEmbedFragment(targetBody, reference.subpath)
      : target.entryKind === "canvas"
        ? "Canvas 파일"
        : target.entryKind === "base"
          ? "Base 보기"
          : previewTextFromHtml(targetBody);
    return (
      <span className="vault-markdown-embed-card">
        <button onClick={() => openEntry(target.id)} type="button">{entryLabel(target)}</button>
        <span>{preview}</span>
      </span>
    );
  }

  async function copyCurrent(profileName: MarkdownExportProfile) {
    if (!activeNote || !activeDraft || activeNote.contentFormat !== "markdown-v1") {
      return;
    }
    const exported = exportMarkdown(activeDraft.body, {
      profile: profileName,
      sourcePath: entryPaths.get(activeNote.id)
    });
    try {
      await navigator.clipboard.writeText(exported.chunks.join("\n\n"));
      setStatus(`${profileName} 형식으로 복사했습니다.`);
    } catch {
      setError("클립보드에 복사하지 못했습니다.");
    }
  }

  async function convertLegacyNote() {
    if (!activeNote || activeNote.contentFormat !== "legacy-html-v1") {
      return;
    }
    const preview = previewLegacyHtmlToMarkdown(activeNote.body);
    const warning = preview.warnings.map((item) => `• ${item.message}`).join("\n");
    if (!window.confirm(`원본은 그대로 두고 Markdown 복사본을 만듭니다.${warning ? `\n\n${warning}` : ""}`)) {
      return;
    }
    await createEntry("markdown", `${activeNote.title} Markdown`, preview.markdown);
  }

  async function exportObsidianZip() {
    const exportableNotes = notes.filter((note) => note.contentFormat !== "legacy-html-v1");
    if (!exportableNotes.length) {
      setError("내보낼 Markdown, Canvas 또는 Base 항목이 없습니다.");
      return;
    }
    setError(null);
    setStatus("Obsidian 호환 ZIP을 만드는 중입니다…");
    exportAbortRef.current?.abort();
    const abortController = new AbortController();
    exportAbortRef.current = abortController;
    try {
      const { exportObsidianVaultZipInWorker } = await import("../features/vault/interop");
      const result = await exportObsidianVaultZipInWorker(exportableNotes.map((note) => {
        const draft = draftsRef.current[note.id];
        const currentNote = draft
          ? { ...note, title: draft.title, folderId: draft.folderId }
          : note;
        if (note.entryKind === "asset") {
          const asset = decodeVaultAsset(draft?.body ?? note.body);
          return {
            path: vaultEntryPath(currentNote, folderPaths),
            kind: "asset" as const,
            content: asset.bytes,
            mimeType: asset.mimeType
          };
        }
        return {
          path: vaultEntryPath(currentNote, folderPaths),
          kind: note.entryKind === "markdown" ? "markdown" as const
            : note.entryKind === "canvas" ? "canvas" as const
              : "base" as const,
          content: draft?.body ?? note.body
        };
      }), {
        folders: [...folderPaths.values()],
        duplicatePolicy: "error"
      }, { signal: abortController.signal });
      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const bytes = Uint8Array.from(result.bytes);
      const now = new Date();
      const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
      downloadBlob(
        new Blob([bytes.buffer], { type: "application/zip" }),
        `QuickMemo-Vault-${date}.zip`
      );
      const legacyCount = notes.length - exportableNotes.length;
      setStatus(`${result.manifest.entries.length}개 항목을 내보냈습니다.${legacyCount ? ` 기존 HTML ${legacyCount}개는 제외했습니다.` : ""}`);
    } catch (caught) {
      if (!(caught instanceof Error && caught.name === "AbortError")) {
        setError(caught instanceof Error ? `ZIP 내보내기 실패: ${caught.message}` : "ZIP을 내보내지 못했습니다.");
      }
    } finally {
      if (exportAbortRef.current === abortController) {
        exportAbortRef.current = null;
      }
    }
  }

  async function importObsidianZip(file: File) {
    if (!profile || vaultImportBusy) {
      return;
    }
    setError(null);
    setVaultImportBusy(true);
    const abortController = new AbortController();
    const createdEntries: CreatedVaultImportEntry[] = [];
    let createdFolderCount = 0;
    importAbortRef.current = abortController;
    setStatus("Obsidian ZIP을 안전하게 검사하는 중입니다…");
    try {
      const {
        DEFAULT_VAULT_INTEROP_LIMITS,
        planObsidianVaultImport,
        readObsidianVaultZipInWorker,
        vaultPathCollisionKey
      } = await import("../features/vault/interop");
      if (file.size > DEFAULT_VAULT_INTEROP_LIMITS.maxArchiveBytes) {
        throw new Error("archive-too-large");
      }
      const archiveBytes = new Uint8Array(await file.arrayBuffer());
      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const manifest = await readObsidianVaultZipInWorker(archiveBytes, {
          duplicatePolicy: "rename",
          stripCommonRoot: true,
          validateCanvas: true
        },
        { signal: abortController.signal }
      );
      const existingEntryPaths = notes.map((note) => {
        const draft = draftsRef.current[note.id];
        return vaultEntryPath(draft ? { ...note, folderId: draft.folderId, title: draft.title } : note, folderPaths);
      });
      const plan = planObsidianVaultImport(
        manifest,
        folders.map((folder) => ({
          id: folder.id,
          parentId: folder.parentId ?? null,
          path: folderPaths.get(folder.id) ?? folder.displayName
        })),
        existingEntryPaths
      );
      if (!plan.entries.length) {
        setError("가져올 Markdown, Canvas, Base 또는 첨부 파일이 없습니다.");
        return;
      }
      const notices = [
        `${plan.entries.length}개 항목과 ${plan.folders.filter((folder) => !folder.existingFolderId).length}개 새 폴더를 암호화해 가져옵니다.`,
        plan.renamedEntries ? `기존 파일과 충돌한 ${plan.renamedEntries}개 이름은 자동 변경됩니다.` : "",
        plan.assetEntries ? `첨부 ${plan.assetEntries}개도 같은 E2EE 저장 경로로 암호화합니다.` : "",
        manifest.skipped.length ? `시스템 또는 Obsidian 설정 ${manifest.skipped.length}개는 제외합니다.` : ""
      ].filter(Boolean).join("\n");
      if (!window.confirm(`${notices}\n\n계속할까요?`)) {
        setStatus("ZIP 가져오기를 취소했습니다.");
        return;
      }
      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      setStatus("검증된 항목을 암호화해 저장하는 중입니다…");
      const folderIdByPathKey = new Map<string, string>();
      for (const folder of plan.folders) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const key = vaultPathCollisionKey(folder.path);
        if (folder.existingFolderId) {
          folderIdByPathKey.set(key, folder.existingFolderId);
          continue;
        }
        const parentId = folder.parentPath
          ? folderIdByPathKey.get(vaultPathCollisionKey(folder.parentPath)) ?? null
          : null;
        if (folder.parentPath && !parentId) {
          throw new Error("import-parent-missing");
        }
        const created = await createEncryptedVaultFolder(
          profile,
          folder.name,
          parentId,
          folderIdByPathKey.size
        );
        folderIdByPathKey.set(key, created.id);
        createdFolderCount += 1;
      }
      for (const entry of plan.entries) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const folderId = entry.folderPath
          ? folderIdByPathKey.get(vaultPathCollisionKey(entry.folderPath)) ?? null
          : null;
        if (entry.folderPath && !folderId) {
          throw new Error("import-folder-missing");
        }
        if (entry.kind === "asset") {
          const created = await createEncryptedVaultAsset(profile, {
            bytes: entry.bytes,
            folderId,
            mimeType: entry.mimeType,
            title: entry.title
          });
          createdEntries.push({ noteId: created.noteId, revision: created.revision });
        } else {
          const created = await createEncryptedVaultEntry(profile, {
            body: entry.body,
            contentFormat: entry.kind === "markdown"
              ? "markdown-v1"
              : entry.kind === "canvas"
                ? "json-canvas-v1"
                : "base-v1",
            entryKind: entry.kind,
            folderId,
            title: entry.title
          });
          createdEntries.push({ noteId: created.noteId, revision: created.revision });
        }
      }
      setStatus(`${plan.entries.length}개 항목을 암호화해 가져왔습니다.${plan.assetEntries ? ` 첨부 ${plan.assetEntries}개 포함.` : ""}`);
    } catch (caught) {
      const compensation = await compensateCreatedVaultImportEntries(createdEntries, (entry) => (
        deleteRevisionedNote({
          expectedRevision: entry.revision,
          noteId: entry.noteId,
          readerUids: [profile.uid],
          uid: profile.uid
        })
      ));
      const folderNotice = createdFolderCount
        ? ` 새로 만든 빈 폴더 ${createdFolderCount}개는 남아 있을 수 있습니다.`
        : "";
      const compensationNotice = compensation.attempted
        ? compensation.cleanupFailed
          ? ` 생성 항목 ${compensation.softDeleted}개는 revision 이력을 남기고 휴지통으로 이동했지만 ${compensation.cleanupFailed}개는 자동 정리하지 못했습니다.`
          : ` 생성 항목 ${compensation.softDeleted}개를 revision 이력을 남기고 휴지통으로 이동했습니다. 문서와 이력의 quota 사용량은 남습니다.`
        : "";
      if (caught instanceof Error && caught.name === "AbortError") {
        setStatus(`ZIP 가져오기를 취소했습니다.${compensationNotice}${folderNotice}`);
      } else {
        setError(`ZIP 가져오기에 실패했습니다. 파일 구조·크기·Canvas 형식을 확인해주세요.${compensationNotice}${folderNotice}`);
      }
    } finally {
      if (importAbortRef.current === abortController) {
        importAbortRef.current = null;
      }
      setVaultImportBusy(false);
    }
  }

  function openDailyNote() {
    const now = new Date();
    const title = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    const existing = notes.find((note) => (
      note.entryKind === "markdown"
      && (note.folderId ?? null) === selectedFolderId
      && normalizedEntryTitle(note.title, note.entryKind) === normalizedEntryTitle(title, "markdown")
    ));
    if (existing) {
      openEntry(existing.id);
    } else {
      void createEntry("markdown", title, `# ${title}\n\n`);
    }
  }

  function createUniqueNote() {
    const title = uniqueNoteTitle(new Date());
    void createEntry("markdown", title, `# ${title}\n\n`);
  }

  function selectTemplateFromPrompt() {
    if (availableTemplates.length === 0) {
      setError("Templates 또는 템플릿 폴더에 Markdown 템플릿을 먼저 만들어주세요.");
      return null;
    }
    const templateList = availableTemplates
      .slice(0, 20)
      .map((template) => template.path)
      .join("\n");
    const requested = window.prompt(
      `사용할 템플릿 이름 또는 경로를 입력하세요.\n\n${templateList}`,
      availableTemplates.length === 1 ? availableTemplates[0].title : ""
    );
    if (!requested) {
      return null;
    }
    const template = chooseTemplate(availableTemplates, requested);
    if (!template) {
      setError("템플릿을 하나로 찾지 못했습니다. 정확한 이름 또는 경로를 입력해주세요.");
      return null;
    }
    setError(null);
    return template;
  }

  function insertTemplateIntoActiveNote() {
    if (!activeNote || !activeDraft || activeNote.contentFormat !== "markdown-v1") {
      setError("Markdown 노트를 연 뒤 템플릿을 삽입해주세요.");
      return;
    }
    const template = selectTemplateFromPrompt();
    if (!template) {
      return;
    }
    const text = expandTemplate(template.body, { now: new Date(), title: activeDraft.title });
    const id = ++editorRequestIdRef.current;
    setViewMode("live-preview");
    setEditorInsertRequest({ entryId: activeNote.id, id, text });
    setStatus(`${template.title} 템플릿을 현재 커서에 삽입했습니다.`);
  }

  function createNoteFromTemplate() {
    const template = selectTemplateFromPrompt();
    if (!template) {
      return;
    }
    const requestedTitle = window.prompt("새 노트 이름", template.title.replace(/\.md$/i, ""));
    if (!requestedTitle?.trim()) {
      return;
    }
    const title = requestedTitle.trim().slice(0, 240);
    const body = expandTemplate(template.body, { now: new Date(), title });
    void createEntry("markdown", title, body);
  }

  function revealOutlineHeading(heading: MarkdownHeading) {
    if (!activeNote || activeNote.contentFormat !== "markdown-v1") {
      return;
    }
    const id = ++editorRequestIdRef.current;
    setViewMode("live-preview");
    setEditorRevealRequest({ entryId: activeNote.id, id, line: heading.line });
    if (mobileLayout) {
      setRightOpen(false);
    }
  }

  function openRandomNote() {
    const candidates = notes.filter((note) => note.entryKind === "markdown");
    if (!candidates.length) {
      setError("무작위로 열 Markdown 노트가 없습니다.");
      return;
    }
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    openEntry(candidates[random[0] % candidates.length].id);
  }

  function handleQuickSwitcherOpen(entry: QuickSwitcherItem, metadata: NavigationActivationMetadata) {
    if (entry.kind === "folder" && entry.id.startsWith("folder:")) {
      const folderId = entry.id.slice("folder:".length);
      setSelectedFolderId(folderId);
      setExpandedFolderIds((current) => new Set(current).add(folderId));
      showLeftPanel("files");
      return;
    }
    const target: GraphOpenIntent["target"] = metadata.target === "new-tab-group"
      ? "new-group"
      : metadata.target;
    openEntry(entry.id, { target });
  }

  function bookmarkGlobalGraph() {
    if (globalGraphSettings.scope !== "global") {
      return;
    }
    const label = window.prompt("그래프 북마크 이름", `그래프 ${graphBookmarks.length + 1}`)?.trim();
    if (!label) {
      return;
    }
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    setGraphBookmarks((current) => [...current, {
      createdAt: Date.now(),
      id: `${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`,
      label: label.slice(0, 120),
      settings: globalGraphSettings,
      viewport: globalViewport
    }].slice(-64));
    setStatus("그래프 설정과 화면 위치를 암호화 북마크에 추가했습니다.");
  }

  function handleCommand(command: CommandPaletteItem) {
    if (command.id.startsWith("graph-bookmark:")) {
      const bookmark = graphBookmarks.find((candidate) => command.id === `graph-bookmark:${candidate.id}`);
      if (bookmark) {
        setGlobalGraphSettings(bookmark.settings);
        setGlobalViewport(bookmark.viewport);
        openGlobalGraph();
      }
      return;
    }
    switch (command.id) {
      case "new-note": void createEntry("markdown"); break;
      case "new-canvas": void createEntry("canvas"); break;
      case "new-base": void createEntry("base"); break;
      case "daily-note": openDailyNote(); break;
      case "unique-note": createUniqueNote(); break;
      case "random-note": openRandomNote(); break;
      case "insert-template": insertTemplateIntoActiveNote(); break;
      case "new-from-template": createNoteFromTemplate(); break;
      case "global-graph": openGlobalGraph(); break;
      case "outline": showRightPanel("outline"); break;
      case "search": showLeftPanel("search"); break;
      case "toggle-left": toggleLeftPanel(); break;
      case "toggle-right": toggleRightPanel(); break;
      case "import-obsidian": importInputRef.current?.click(); break;
      case "export-obsidian": void exportObsidianZip(); break;
      case "open-library": void navigateAfterSaving("/library"); break;
      case "open-schedule": void navigateAfterSaving("/schedule"); break;
      case "open-legacy": void navigateAfterSaving("/app/legacy"); break;
    }
  }

  function handleGraphNodeContextMenu(node: UiGraphNode, point: { clientX: number; clientY: number }) {
    if (node.id.startsWith("entry:")) {
      setContextMenu({
        returnFocusElement: document.activeElement instanceof HTMLButtonElement
          ? document.activeElement
          : null,
        targetId: node.id.slice("entry:".length),
        targetKind: "entry",
        x: point.clientX,
        y: point.clientY
      });
    }
  }

  const stableBookmarkGlobalGraph = useStableEvent(bookmarkGlobalGraph);
  const stableHandleGraphNodeContextMenu = useStableEvent(handleGraphNodeContextMenu);
  const stableHandleGraphNodeOpen = useStableEvent(handleGraphNodeOpen);

  const legacyFolderCount = rawFolders.filter((folder) => !folder.encryptedName || !folder.wrappedKey).length;
  const moveTargetNote = moveTarget?.targetKind === "entry"
    ? notes.find((note) => note.id === moveTarget.targetId)
    : undefined;
  const moveTargetLabel = moveTarget?.targetKind === "entry"
    ? moveTargetNote ? entryLabel(moveTargetNote) : "항목"
    : folders.find((folder) => folder.id === moveTarget?.targetId)?.displayName ?? "폴더";
  const moveDestinations = useMemo((): VaultMoveDestination[] => {
    if (!moveTarget) {
      return [];
    }
    const currentParentId = moveTarget.targetKind === "entry"
      ? notes.find((note) => note.id === moveTarget.targetId)?.folderId ?? null
      : folders.find((folder) => folder.id === moveTarget.targetId)?.parentId ?? null;
    const sourceFolderPath = moveTarget.targetKind === "folder"
      ? folderPaths.get(moveTarget.targetId) ?? ""
      : "";
    return [
      {
        disabled: currentParentId === null,
        folderId: null,
        label: "Vault 루트"
      },
      ...folders
        .map((folder) => ({ folder, path: folderPaths.get(folder.id) ?? folder.displayName }))
        .sort((left, right) => left.path.localeCompare(right.path, "ko"))
        .map(({ folder, path }) => ({
          disabled: currentParentId === folder.id
            || (moveTarget.targetKind === "folder" && (
              folder.id === moveTarget.targetId
              || Boolean(sourceFolderPath && path.startsWith(`${sourceFolderPath}/`))
            )),
          folderId: folder.id,
          label: path
        }))
    ];
  }, [folderPaths, folders, moveTarget, notes]);

  return (
    <AppShell onBeforeExit={flushDirtyEntries} variant="vault">
      <div className={`vault-workspace${leftOpen ? "" : " vault-left-closed"}${rightOpen ? "" : " vault-right-closed"}`}>
        <input
          accept=".zip,application/zip"
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importObsidianZip(file);
          }}
          ref={importInputRef}
          tabIndex={-1}
          type="file"
        />
        <aside aria-label="Vault 리본" className="vault-ribbon">
          <button aria-controls="vault-left-panel" aria-expanded={leftOpen} aria-label={leftOpen ? "왼쪽 패널 닫기" : "왼쪽 패널 열기"} onClick={toggleLeftPanel} type="button"><Menu size={18} /></button>
          <button aria-label="명령 팔레트" onClick={() => setCommandPaletteOpen(true)} title="명령 팔레트 (Cmd/Ctrl+P)" type="button"><CommandIcon size={18} /></button>
          <button aria-label="파일" aria-pressed={leftMode === "files"} onClick={() => showLeftPanel("files")} title="파일" type="button"><Files size={18} /></button>
          <button aria-label="검색" aria-pressed={leftMode === "search"} onClick={() => showLeftPanel("search")} title="검색" type="button"><Search size={18} /></button>
          <button aria-label="태그" aria-pressed={leftMode === "tags"} onClick={() => showLeftPanel("tags")} title="태그" type="button"><Tags size={18} /></button>
          <button aria-label="그래프 보기" onClick={openGlobalGraph} title="그래프 보기" type="button"><Network size={18} /></button>
          <button aria-label="새 Canvas" onClick={() => void createEntry("canvas")} title="새 Canvas" type="button"><GitFork size={18} /></button>
          <button aria-label="새 Base" onClick={() => void createEntry("base")} title="새 Base" type="button"><Table2 size={18} /></button>
          <button aria-label="Obsidian ZIP 가져오기" disabled={vaultImportBusy} onClick={() => importInputRef.current?.click()} title="Obsidian ZIP 가져오기" type="button"><Upload size={18} /></button>
          <button aria-label="Obsidian ZIP 내보내기" onClick={() => void exportObsidianZip()} title="Obsidian ZIP 내보내기" type="button"><Download size={18} /></button>
          <span className="vault-ribbon-spacer" />
          <button aria-label="자료실" onClick={() => void navigateAfterSaving("/library")} title="자료실" type="button"><LibraryBig size={18} /></button>
          <button aria-label="일정" onClick={() => void navigateAfterSaving("/schedule")} title="일정" type="button"><CalendarDays size={18} /></button>
          <button aria-label="기존 노트 관리" onClick={() => void navigateAfterSaving("/app/legacy")} title="기존 노트 관리" type="button"><Settings2 size={18} /></button>
        </aside>

        {leftOpen ? (
          <aside aria-label="Vault 탐색기" className="vault-left-panel" id="vault-left-panel">
            <header>
              <strong>{leftMode === "files" ? "파일" : leftMode === "search" ? "검색" : "태그"}</strong>
              <button aria-label="왼쪽 패널 닫기" onClick={() => setLeftOpen(false)} type="button"><X size={15} /></button>
            </header>
            {leftMode === "files" ? (
              <>
                <div className="vault-panel-toolbar">
                  <button aria-label="새 노트" onClick={() => void createEntry("markdown")} type="button"><FilePlus2 size={16} /></button>
                  <button aria-label="새 폴더" onClick={() => void createFolder()} type="button"><FolderPlus size={16} /></button>
                  <button aria-label="새 Canvas" onClick={() => void createEntry("canvas")} type="button"><GitFork size={16} /></button>
                  <button aria-label="새 Base" onClick={() => void createEntry("base")} type="button"><Table2 size={16} /></button>
                </div>
                {legacyFolderCount > 0 ? (
                  <button className="vault-migration-button" disabled={folderMigrationBusy} onClick={() => void migrateFolders()} type="button">
                    <FolderInput size={15} /> 기존 폴더 {legacyFolderCount}개 암호화
                  </button>
                ) : null}
                <VaultFileTree
                  expandedFolderIds={expandedFolderIds}
                  folders={folders}
                  notes={notes}
                  onDropEntry={moveEntryToFolder}
                  onDropFolder={moveFolder}
                  onContextEntry={(entryId, x, y, returnFocusElement) => setContextMenu({
                    returnFocusElement,
                    targetId: entryId,
                    targetKind: "entry",
                    x,
                    y
                  })}
                  onContextFolder={(folderId, x, y, returnFocusElement) => setContextMenu({
                    returnFocusElement,
                    targetId: folderId,
                    targetKind: "folder",
                    x,
                    y
                  })}
                  onOpenEntry={openEntry}
                  onSelectFolder={setSelectedFolderId}
                  onToggleFolder={(folderId) => setExpandedFolderIds((current) => {
                    const next = new Set(current);
                    if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
                    return next;
                  })}
                  selectedFolderId={selectedFolderId}
                />
              </>
            ) : leftMode === "search" ? (
              <div className="vault-search-panel">
                <label>
                  <span className="sr-only">Vault 검색식</span>
                  <input autoFocus onChange={(event) => setSearchQuery(event.currentTarget.value)} placeholder="경로, 내용, tag:…" type="search" value={searchQuery} />
                </label>
                <VaultEntryList notes={filteredNotes} onOpen={openEntry} />
              </div>
            ) : (
              <VaultTagList
                onSelect={(tag, additive) => {
                  const tagQuery = `tag:${tag}`;
                  setSearchQuery((current) => {
                    if (!additive) {
                      return tagQuery;
                    }
                    const terms = current.split(/\s+/).filter(Boolean);
                    return terms.includes(tagQuery)
                      ? terms.filter((term) => term !== tagQuery).join(" ")
                      : [...terms, tagQuery].join(" ");
                  });
                  showLeftPanel("search");
                }}
                tags={visibleTags}
              />
            )}
          </aside>
        ) : null}

        <main className="vault-center">
          <div aria-label="열린 탭" className="vault-tab-bar" role="tablist">
            {tabs.map((tab) => (
              <div className={tab.id === activeTabId ? "active" : ""} key={tab.id} role="presentation">
                <button
                  aria-controls="vault-active-tabpanel"
                  aria-selected={tab.id === activeTabId}
                  id={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  role="tab"
                  tabIndex={tab.id === activeTabId ? 0 : -1}
                  type="button"
                >
                  {tab.label}
                </button>
                <button aria-label={`${tab.label} 닫기`} onClick={() => closeTab(tab.id)} type="button"><X size={13} /></button>
              </div>
            ))}
            <button aria-label="새 노트 탭" className="vault-new-tab" onClick={() => void createEntry("markdown")} type="button">+</button>
            <button aria-controls="vault-right-panel" aria-expanded={rightOpen} aria-label={rightOpen ? "오른쪽 패널 닫기" : "오른쪽 패널 열기"} className="vault-right-toggle" onClick={toggleRightPanel} type="button"><PanelRight size={17} /></button>
          </div>

          <section aria-labelledby={activeTabId ?? undefined} className="vault-editor-pane" id="vault-active-tabpanel" role="tabpanel">
            {activeTab?.kind === "global-graph" ? (
              <Suspense fallback={<VaultViewLoading label="전체 그래프" />}>
                <LazyGraphView
                  activeNodeId={activeEntryId ? `entry:${activeEntryId}` : undefined}
                  collapsedSettingsSections={globalCollapsedSections}
                  edges={graphUiEdges}
                  initialViewport={globalViewport}
                  nodes={graphUiNodes}
                  onCollapsedSettingsSectionsChange={setGlobalCollapsedSections}
                  onBookmark={stableBookmarkGlobalGraph}
                  onNodeContextMenu={stableHandleGraphNodeContextMenu}
                  onNodeOpen={stableHandleGraphNodeOpen}
                  onSettingsChange={setGlobalGraphSettings}
                  onViewportChange={setGlobalViewport}
                  settings={globalGraphSettings}
                />
              </Suspense>
            ) : activeNote && activeDraft ? (
              <>
                <header className="vault-note-header">
                  <div className="vault-breadcrumb">{entryPaths.get(activeNote.id)}</div>
                  <input
                    aria-label="노트 이름"
                    disabled={activeNote.contentFormat === "legacy-html-v1"}
                    onChange={(event) => updateActiveDraft({ title: event.currentTarget.value })}
                    value={activeDraft.title}
                  />
                  <div className="vault-note-actions">
                    {activeNote.contentFormat === "markdown-v1" ? (["source", "live-preview", "reading"] as const).map((mode) => (
                      <button aria-pressed={viewMode === mode} key={mode} onClick={() => setViewMode(mode)} type="button">
                        {mode === "source" ? "소스" : mode === "live-preview" ? "라이브" : "읽기"}
                      </button>
                    )) : null}
                    {activeNote.contentFormat === "markdown-v1" ? (
                      <select aria-label="Markdown 복사 형식" defaultValue="" onChange={(event) => {
                        const value = event.currentTarget.value as MarkdownExportProfile;
                        if (value) void copyCurrent(value);
                        event.currentTarget.value = "";
                      }}>
                        <option value="">복사…</option>
                        <option value="raw">원본 Markdown</option>
                        <option value="github">GitHub</option>
                        <option value="notion">Notion</option>
                        <option value="discord-ai">Discord · AI</option>
                      </select>
                    ) : null}
                    <button aria-label="저장" disabled={!activeDraft.dirty || savingEntryIds.has(activeNote.id)} onClick={() => void saveEntry(activeNote.id)} type="button"><Save size={16} /></button>
                  </div>
                </header>
                <div className="vault-note-content">
                  {activeNote.entryKind === "canvas" ? (
                    <Suspense fallback={<VaultViewLoading label="Canvas" />}>
                      <LazyJsonCanvasView
                        fileOptions={canvasFileOptions}
                        onChange={(body) => updateActiveDraft({ body })}
                        onOpenFile={(path) => {
                          const entry = indexEntries.find((candidate) => candidate.path === path);
                          if (entry) openEntry(entry.id);
                        }}
                        source={activeDraft.body}
                      />
                    </Suspense>
                  ) : activeNote.entryKind === "asset" ? (
                    decodedAssetsByEntryId.has(activeNote.id) ? (
                      <VaultAssetPreview
                        asset={decodedAssetsByEntryId.get(activeNote.id)!}
                        fileName={activeDraft.title}
                      />
                    ) : (
                      <div className="vault-asset-preview-error" role="alert">
                        첨부 데이터의 무결성을 확인할 수 없어 미리보기와 내보내기를 차단했습니다.
                      </div>
                    )
                  ) : activeNote.entryKind === "base" ? (
                    <div className="vault-base-view">
                      <Suspense fallback={<VaultViewLoading label="Base" />}>
                        <LazyBaseView
                          entries={indexEntries}
                          metadataByEntryId={baseMetadataByEntryId}
                          onOpenEntry={(entryId) => openEntry(entryId)}
                          source={activeDraft.body}
                        />
                      </Suspense>
                      <details>
                        <summary>Base YAML 편집</summary>
                        <CodeMirrorMarkdownEditor
                          onChange={(body) => updateActiveDraft({ body })}
                          onSave={() => void saveEntry(activeNote.id)}
                          value={activeDraft.body}
                        />
                      </details>
                    </div>
                  ) : activeNote.contentFormat === "legacy-html-v1" ? (
                    <div className="vault-legacy-note">
                      <div className="vault-legacy-banner">
                        <span>기존 HTML 노트 — 원본을 보존하고 있습니다.</span>
                        <button onClick={() => void convertLegacyNote()} type="button">Markdown 복사본 만들기</button>
                      </div>
                      <ReadonlyNoteRenderer as="article" content={activeNote.body} />
                    </div>
                  ) : viewMode === "reading" ? (
                    <MarkdownRenderer
                      onLinkClick={handleMarkdownLink}
                      onTagClick={handleMarkdownTagClick}
                      renderEmbed={renderMarkdownEmbed}
                      source={activeDraft.body}
                    />
                  ) : viewMode === "live-preview" ? (
                    <div className="vault-live-preview">
                      <CodeMirrorMarkdownEditor
                        completionData={markdownCompletionData}
                        insertRequest={editorInsertRequest?.entryId === activeNote.id ? editorInsertRequest : null}
                        onChange={(body) => updateActiveDraft({ body })}
                        onInsertHandled={(id) => setEditorInsertRequest((current) => current?.id === id ? null : current)}
                        onRevealHandled={(id) => setEditorRevealRequest((current) => current?.id === id ? null : current)}
                        onSave={() => void saveEntry(activeNote.id)}
                        revealRequest={editorRevealRequest?.entryId === activeNote.id ? editorRevealRequest : null}
                        value={activeDraft.body}
                      />
                      <MarkdownRenderer
                        onLinkClick={handleMarkdownLink}
                        onTagClick={handleMarkdownTagClick}
                        renderEmbed={renderMarkdownEmbed}
                        source={deferredActiveBody}
                      />
                    </div>
                  ) : (
                    <CodeMirrorMarkdownEditor
                      autoFocus
                      completionData={markdownCompletionData}
                      insertRequest={editorInsertRequest?.entryId === activeNote.id ? editorInsertRequest : null}
                      onChange={(body) => updateActiveDraft({ body })}
                      onInsertHandled={(id) => setEditorInsertRequest((current) => current?.id === id ? null : current)}
                      onRevealHandled={(id) => setEditorRevealRequest((current) => current?.id === id ? null : current)}
                      onSave={() => void saveEntry(activeNote.id)}
                      revealRequest={editorRevealRequest?.entryId === activeNote.id ? editorRevealRequest : null}
                      value={activeDraft.body}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="vault-empty-state">
                <BookOpen size={34} />
                <h2>새로운 지식의 점을 만드세요</h2>
                <p>Markdown 노트를 만들고 <code>[[링크]]</code>와 <code>#태그</code>로 연결할 수 있습니다.</p>
                <button onClick={() => void createEntry("markdown")} type="button">새 노트</button>
              </div>
            )}
          </section>
          <footer className="vault-status-bar">
            <span aria-live="polite" role={error ? "alert" : "status"}>{error ?? status}</span>
            <span>{activeDraft ? `${activeDocumentStats.words}단어 · ${activeDocumentStats.characters}자` : ""}</span>
            <span>{activeEntryId ? `백링크 ${backlinks.length} · 나가는 링크 ${outgoing.length}` : `${globalSnapshot.nodes.length} nodes`}</span>
          </footer>
        </main>

        {rightOpen ? (
          <aside aria-label="연결 정보" className="vault-right-panel" id="vault-right-panel">
            <header>
              <div role="tablist">
                <button aria-label="백링크" aria-selected={rightMode === "backlinks"} onClick={() => setRightMode("backlinks")} role="tab" title="백링크" type="button"><Link2 size={15} /><span>백링크</span></button>
                <button aria-label="나가는 링크" aria-selected={rightMode === "outgoing"} onClick={() => setRightMode("outgoing")} role="tab" title="나가는 링크" type="button"><GitFork size={15} /><span>나가는 링크</span></button>
                <button aria-label="목차" aria-selected={rightMode === "outline"} onClick={() => setRightMode("outline")} role="tab" title="목차" type="button"><ListTree size={15} /><span>목차</span></button>
                <button aria-label="속성" aria-selected={rightMode === "properties"} onClick={() => setRightMode("properties")} role="tab" title="속성" type="button"><Hash size={15} /><span>속성</span></button>
                <button aria-label="로컬 그래프" aria-selected={rightMode === "local-graph"} onClick={() => setRightMode("local-graph")} role="tab" title="로컬 그래프" type="button"><Network size={15} /><span>로컬</span></button>
              </div>
              <button aria-label="오른쪽 패널 닫기" onClick={() => setRightOpen(false)} type="button"><X size={15} /></button>
            </header>
            {rightMode === "backlinks" ? (
              <LinkOccurrenceList empty="연결된 백링크가 없습니다." notes={notes} occurrences={backlinks} onOpen={openEntry} sourceSide />
            ) : rightMode === "outgoing" ? (
              <LinkOccurrenceList empty="나가는 링크가 없습니다." notes={notes} occurrences={outgoing} onOpen={openEntry} />
            ) : rightMode === "outline" ? (
              <VaultOutline headings={activeMetadata?.headings ?? []} onNavigate={revealOutlineHeading} />
            ) : rightMode === "properties" ? (
              <VaultPropertiesEditor
                disabled={!activeNote || activeNote.contentFormat !== "markdown-v1"}
                onChange={(body) => { setError(null); updateActiveDraft({ body }); }}
                onError={setError}
                properties={activeMetadata?.properties ?? EMPTY_FRONTMATTER_PROPERTIES}
                source={activeDraft?.body ?? ""}
              />
            ) : (
              <div className="vault-local-graph-pane">
                <button
                  className="vault-local-graph-pin"
                  disabled={!activeEntryId}
                  onClick={() => setLocalGraphSettings((current) => current.scope === "local"
                    ? {
                        ...current,
                        root: current.root === "follow-active" && activeEntryId
                          ? { entryId: activeEntryId }
                          : "follow-active"
                      }
                    : current)}
                  type="button"
                >
                  {localGraphSettings.scope === "local" && localGraphSettings.root !== "follow-active"
                    ? "고정 해제"
                    : "현재 노트에 고정"}
                </button>
                <Suspense fallback={<VaultViewLoading label="로컬 그래프" />}>
                  <LazyGraphView
                    activeNodeId={activeEntryId ? `entry:${activeEntryId}` : undefined}
                    collapsedSettingsSections={localCollapsedSections}
                    defaultSettingsOpen={false}
                    edges={localUiEdges}
                    initialViewport={localViewport}
                    nodes={localUiNodes}
                    onCollapsedSettingsSectionsChange={setLocalCollapsedSections}
                    onNodeContextMenu={stableHandleGraphNodeContextMenu}
                    onNodeOpen={stableHandleGraphNodeOpen}
                    onSettingsChange={setLocalGraphSettings}
                    onViewportChange={setLocalViewport}
                    settings={localGraphSettings}
                  />
                </Suspense>
              </div>
            )}
          </aside>
        ) : null}
        {contextMenu ? (
          <div className="vault-context-backdrop" onClick={() => closeContextMenu()} role="presentation">
            <div
              aria-label={contextMenu.targetKind === "entry" ? "파일 작업" : "폴더 작업"}
              className="vault-context-menu"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeContextMenu();
                  return;
                }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  return;
                }
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)'
                )];
                if (!items.length) {
                  return;
                }
                event.preventDefault();
                const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                const nextIndex = event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowDown"
                      ? currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
                      : currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
                items[nextIndex]?.focus();
              }}
              role="menu"
              style={{
                left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 220)),
                top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 150))
              }}
            >
              <button autoFocus onClick={() => {
                const target = contextMenu;
                closeContextMenu();
                if (target.targetKind === "entry") void renameEntry(target.targetId);
                else void renameFolder(target.targetId);
              }} role="menuitem" type="button">
                <Pencil size={14} /> 이름 변경
              </button>
              <button onClick={() => {
                const target = contextMenu;
                closeContextMenu(false);
                setMoveTarget({
                  returnFocusTo: target.returnFocusElement,
                  targetId: target.targetId,
                  targetKind: target.targetKind
                });
              }} role="menuitem" type="button">
                <FolderInput size={14} /> 이동…
              </button>
              {contextMenu.targetKind === "entry" ? (
                <button className="danger" onClick={() => {
                  const target = contextMenu;
                  closeContextMenu();
                  void moveEntryToTrash(target.targetId);
                }} role="menuitem" type="button">
                  <Trash2 size={14} /> 휴지통으로 이동
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {moveTarget ? (
          <VaultMoveDialog
            destinations={moveDestinations}
            label={moveTargetLabel}
            onClose={() => setMoveTarget(null)}
            onMove={moveContextTarget}
            returnFocusTo={moveTarget.returnFocusTo}
          />
        ) : null}
      </div>
      <CommandPalette
        commands={commandPaletteCommands}
        onExecute={(command) => handleCommand(command)}
        onOpenChange={setCommandPaletteOpen}
        open={commandPaletteOpen}
      />
      <QuickSwitcher
        entries={quickSwitcherEntries}
        onOpen={handleQuickSwitcherOpen}
        onOpenChange={setQuickSwitcherOpen}
        open={quickSwitcherOpen}
      />
    </AppShell>
  );
}

/**
 * The unlocked application is a separate component so locking or signing out
 * unmounts every decrypted state container at once. Late async continuations
 * can no longer repopulate plaintext after the security boundary is closed.
 */
export default function VaultPage() {
  const { firebaseUser, privateKey, profile } = useAuth();

  if (!profile || !firebaseUser || firebaseUser.uid !== profile.uid) {
    return null;
  }
  if (!privateKey) {
    return <AppShell variant="vault"><UnlockPanel /></AppShell>;
  }
  return <UnlockedVaultPage privateKey={privateKey} profile={profile} />;
}

interface VaultTagTreeNode {
  children: Map<string, VaultTagTreeNode>;
  displayPath: string;
  entryIds: Set<string>;
  key: string;
  label: string;
}

function VaultTagList({
  onSelect,
  tags
}: {
  onSelect: (tag: string, additive: boolean) => void;
  tags: readonly TagIndexEntry[];
}) {
  const [nested, setNested] = useState(true);
  const [sort, setSort] = useState<"frequency" | "name">("frequency");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const roots = new Map<string, VaultTagTreeNode>();
    for (const tag of tags) {
      const keySegments = tag.key.split("/");
      const displaySegments = tag.displayName.split("/");
      let children = roots;
      for (let index = 0; index < keySegments.length; index += 1) {
        const key = keySegments.slice(0, index + 1).join("/");
        let node = children.get(keySegments[index]);
        if (!node) {
          node = {
            children: new Map(),
            displayPath: displaySegments.slice(0, index + 1).join("/"),
            entryIds: new Set(),
            key,
            label: displaySegments[index] ?? keySegments[index]
          };
          children.set(keySegments[index], node);
        }
        tag.entryIds.forEach((entryId) => node?.entryIds.add(entryId));
        children = node.children;
      }
    }
    return roots;
  }, [tags]);
  const branchKeys = useMemo(() => {
    const keys: string[] = [];
    const visit = (nodes: ReadonlyMap<string, VaultTagTreeNode>) => {
      for (const node of nodes.values()) {
        if (node.children.size) {
          keys.push(node.key);
          visit(node.children);
        }
      }
    };
    visit(tree);
    return keys;
  }, [tree]);
  const compare = useCallback((left: { label: string; count: number }, right: { label: string; count: number }) => (
    sort === "name"
      ? left.label.localeCompare(right.label, "ko")
      : right.count - left.count || left.label.localeCompare(right.label, "ko")
  ), [sort]);

  const renderTree = (nodes: ReadonlyMap<string, VaultTagTreeNode>, depth: number): React.ReactNode => (
    [...nodes.values()]
      .sort((left, right) => compare(
        { label: left.label, count: left.entryIds.size },
        { label: right.label, count: right.entryIds.size }
      ))
      .map((node) => {
        const hasChildren = node.children.size > 0;
        const isCollapsed = collapsed.has(node.key);
        return (
          <div key={node.key}>
            <div className="vault-tag-tree-row" style={{ paddingInlineStart: depth * 12 }}>
              {hasChildren ? (
                <button
                  aria-expanded={!isCollapsed}
                  aria-label={`#${node.displayPath} ${isCollapsed ? "펼치기" : "접기"}`}
                  className="vault-tag-disclosure"
                  onClick={() => setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(node.key)) next.delete(node.key); else next.add(node.key);
                    return next;
                  })}
                  type="button"
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : <span aria-hidden="true" className="vault-tag-disclosure-spacer" />}
              <button
                className="vault-tag-value"
                onClick={(event) => onSelect(node.displayPath, event.metaKey || event.ctrlKey)}
                type="button"
              >
                <span>#{node.label}</span><strong>{node.entryIds.size}</strong>
              </button>
            </div>
            {hasChildren && !isCollapsed ? renderTree(node.children, depth + 1) : null}
          </div>
        );
      })
  );

  if (!tags.length) {
    return <p className="vault-panel-empty">태그가 없습니다.</p>;
  }

  return (
    <div className="vault-tag-list">
      <div className="vault-tag-toolbar">
        <button aria-pressed={nested} onClick={() => setNested((value) => !value)} type="button">
          {nested ? "중첩" : "평면"}
        </button>
        <select aria-label="태그 정렬" onChange={(event) => setSort(event.currentTarget.value as "frequency" | "name")} value={sort}>
          <option value="frequency">빈도순</option>
          <option value="name">이름순</option>
        </select>
        {nested && branchKeys.length ? (
          <button onClick={() => setCollapsed((current) => current.size ? new Set() : new Set(branchKeys))} type="button">
            {collapsed.size ? "모두 펼치기" : "모두 접기"}
          </button>
        ) : null}
      </div>
      {nested ? renderTree(tree, 0) : [...tags]
        .sort((left, right) => compare(
          { label: left.displayName, count: left.count },
          { label: right.displayName, count: right.count }
        ))
        .map((tag) => (
          <button
            className="vault-tag-flat-row"
            key={tag.key}
            onClick={(event) => onSelect(tag.displayName, event.metaKey || event.ctrlKey)}
            type="button"
          >
            <span>#{tag.displayName}</span><strong>{tag.count}</strong>
          </button>
        ))}
    </div>
  );
}

function VaultEntryList({ notes, onOpen }: { notes: readonly DecryptedVaultNote[]; onOpen: (entryId: string) => void }) {
  if (!notes.length) {
    return <p className="vault-panel-empty">일치하는 항목이 없습니다.</p>;
  }
  return (
    <div className="vault-entry-list">
      {notes.map((note) => (
        <button key={note.id} onClick={() => onOpen(note.id)} type="button">
          {note.entryKind === "canvas" ? <GitFork size={14} /> : <FileCode2 size={14} />}
          <span>{entryLabel(note)}</span>
        </button>
      ))}
    </div>
  );
}

function VaultFileTree({
  expandedFolderIds,
  folders,
  notes,
  onContextEntry,
  onContextFolder,
  onDropEntry,
  onDropFolder,
  onOpenEntry,
  onSelectFolder,
  onToggleFolder,
  selectedFolderId
}: {
  expandedFolderIds: ReadonlySet<string>;
  folders: readonly DecryptedVaultFolder[];
  notes: readonly DecryptedVaultNote[];
  onContextEntry: (entryId: string, x: number, y: number, trigger: HTMLButtonElement) => void;
  onContextFolder: (folderId: string, x: number, y: number, trigger: HTMLButtonElement) => void;
  onDropEntry: (entryId: string, folderId: string | null) => Promise<void>;
  onDropFolder: (folderId: string, parentId: string | null) => Promise<void>;
  onOpenEntry: (entryId: string, intent?: GraphOpenIntent) => void;
  onSelectFolder: (folderId: string | null) => void;
  onToggleFolder: (folderId: string) => void;
  selectedFolderId: string | null;
}) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const childFoldersByParent = useMemo(() => {
    const children = new Map<string | null, DecryptedVaultFolder[]>();
    for (const folder of folders) {
      const parentId = folder.parentId ?? null;
      const siblings = children.get(parentId) ?? [];
      siblings.push(folder);
      children.set(parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => (
        (left.order ?? 0) - (right.order ?? 0)
        || left.displayName.localeCompare(right.displayName, "ko")
      ));
    }
    return children;
  }, [folders]);
  const childNotesByParent = useMemo(() => {
    const children = new Map<string | null, DecryptedVaultNote[]>();
    for (const note of notes) {
      const parentId = note.folderId ?? null;
      const siblings = children.get(parentId) ?? [];
      siblings.push(note);
      children.set(parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => left.title.localeCompare(right.title, "ko"));
    }
    return children;
  }, [notes]);

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }
  }, []);

  function cancelLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }

  function beginLongPress(
    event: ReactPointerEvent<HTMLButtonElement>,
    openMenu: (x: number, y: number, trigger: HTMLButtonElement) => void
  ) {
    if (event.pointerType !== "touch") {
      return;
    }
    cancelLongPress();
    const point = { x: event.clientX, y: event.clientY };
    const trigger = event.currentTarget;
    longPressStartRef.current = point;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressNextClickRef.current = true;
      openMenu(point.x, point.y, trigger);
    }, 550);
  }

  function moveLongPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = longPressStartRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelLongPress();
    }
  }

  function consumeLongPressClick() {
    if (!suppressNextClickRef.current) {
      return false;
    }
    suppressNextClickRef.current = false;
    return true;
  }

  function handleDrop(event: DragEvent, folderId: string | null) {
    event.preventDefault();
    const entryId = event.dataTransfer.getData("application/x-quickmemo-entry");
    const draggedFolderId = event.dataTransfer.getData("application/x-quickmemo-folder");
    if (entryId) void onDropEntry(entryId, folderId);
    if (draggedFolderId) void onDropFolder(draggedFolderId, folderId);
  }

  function handleContextMenuKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    openMenu: (x: number, y: number, trigger: HTMLButtonElement) => void
  ) {
    if (!isKeyboardContextMenuGesture(event.key, event.shiftKey)) {
      return;
    }
    event.preventDefault();
    const point = keyboardContextMenuPoint(event.currentTarget.getBoundingClientRect());
    openMenu(point.x, point.y, event.currentTarget);
  }

  function renderLevel(parentId: string | null, depth: number): React.ReactNode {
    const childFolders = childFoldersByParent.get(parentId) ?? [];
    const childNotes = childNotesByParent.get(parentId) ?? [];
    return (
      <>
        {childFolders.map((folder) => {
          const expanded = expandedFolderIds.has(folder.id);
          return (
            <div key={folder.id} role="presentation">
              <button
                aria-expanded={expanded}
                aria-level={depth + 1}
                aria-selected={selectedFolderId === folder.id}
                className={`vault-tree-row vault-folder-row ${selectedFolderId === folder.id ? "selected" : ""}`}
                draggable
                onClick={() => {
                  if (consumeLongPressClick()) return;
                  onSelectFolder(folder.id);
                  onToggleFolder(folder.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextFolder(folder.id, event.clientX, event.clientY, event.currentTarget);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={(event) => event.dataTransfer.setData("application/x-quickmemo-folder", folder.id)}
                onDrop={(event) => handleDrop(event, folder.id)}
                onKeyDown={(event) => handleContextMenuKey(event, (x, y, trigger) => onContextFolder(folder.id, x, y, trigger))}
                onPointerCancel={cancelLongPress}
                onPointerDown={(event) => beginLongPress(event, (x, y, trigger) => onContextFolder(folder.id, x, y, trigger))}
                onPointerMove={moveLongPress}
                onPointerUp={cancelLongPress}
                role="treeitem"
                style={{ paddingInlineStart: 8 + depth * 14 }}
                type="button"
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={14} />
                <span>{folder.displayName}</span>
              </button>
              {expanded ? <div role="group">{renderLevel(folder.id, depth + 1)}</div> : null}
            </div>
          );
        })}
        {childNotes.map((note) => (
          <button
            className="vault-tree-row vault-note-row"
            draggable
            key={note.id}
            aria-level={depth + 1}
            onClick={(event) => {
              if (consumeLongPressClick()) return;
              onOpenEntry(note.id, graphOpenIntentFromModifiers(event));
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              onContextEntry(note.id, event.clientX, event.clientY, event.currentTarget);
            }}
            onDragStart={(event) => event.dataTransfer.setData("application/x-quickmemo-entry", note.id)}
            onKeyDown={(event) => handleContextMenuKey(event, (x, y, trigger) => onContextEntry(note.id, x, y, trigger))}
            onPointerCancel={cancelLongPress}
            onPointerDown={(event) => beginLongPress(event, (x, y, trigger) => onContextEntry(note.id, x, y, trigger))}
            onPointerMove={moveLongPress}
            onPointerUp={cancelLongPress}
            role="treeitem"
            style={{ paddingInlineStart: 26 + depth * 14 }}
            type="button"
          >
            {note.entryKind === "canvas" ? <GitFork size={13} /> : <FileCode2 size={13} />}
            <span>{entryLabel(note)}</span>
          </button>
        ))}
      </>
    );
  }

  return (
    <div
      className={`vault-file-tree ${selectedFolderId === null ? "root-selected" : ""}`}
      onClick={(event) => { if (event.currentTarget === event.target) onSelectFolder(null); }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => handleDrop(event, null)}
      role="tree"
    >
      {renderLevel(null, 0)}
    </div>
  );
}

function LinkOccurrenceList({
  empty,
  occurrences,
  notes,
  onOpen,
  sourceSide = false
}: {
  empty: string;
  notes: readonly DecryptedVaultNote[];
  occurrences: readonly ResolvedLinkOccurrence[];
  onOpen: (entryId: string) => void;
  sourceSide?: boolean;
}) {
  if (!occurrences.length) {
    return <p className="vault-panel-empty">{empty}</p>;
  }
  return (
    <div className="vault-link-list">
      {occurrences.map((occurrence, index) => {
        const entryId = sourceSide ? occurrence.sourceEntryId : occurrence.targetEntryId;
        const note = entryId ? notes.find((candidate) => candidate.id === entryId) : null;
        return (
          <button disabled={!entryId} key={`${occurrence.sourceEntryId}-${occurrence.line}-${index}`} onClick={() => entryId && onOpen(entryId)} type="button">
            <strong>{note?.title ?? occurrence.target}</strong>
            <span>{occurrence.context}</span>
            <small>{occurrence.sourcePath}:{occurrence.line}</small>
          </button>
        );
      })}
    </div>
  );
}
