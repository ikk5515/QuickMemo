import {
  Bookmark,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
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
  History,
  LibraryBig,
  Link2,
  ListTree,
  Menu,
  Network,
  PanelRight,
  PenTool,
  Pin,
  Pencil,
  Save,
  Search,
  Settings2,
  Share2,
  Table2,
  Tags,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
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
  applyCanvasPathRewritePlan,
  planVaultContentPathRewritesForPathChanges
} from "../features/canvas/canvasLinkRewrite";
import { setJsonCanvasVaultEntryDragData } from "../features/canvas/vaultEntryDrag";
import type { BaseMetadata } from "../features/base";
import {
  dailyNoteBody,
  dailyNoteDateFromTitle,
  localDateKey,
  localMonthKey,
  monthlyNoteBody,
  parseLocalDateKey,
  weeklyNoteBody
} from "../features/calendar/dailyNotes";
import { createDrawingSource } from "../features/drawing/model";
import {
  canonicalizeDraftTitle,
  captureRevisionedDraft,
  findConfirmedDraftSubmission,
  persistedRevisionRelation,
  reconcileDraftAfterConflictSave,
  reconcileDraftAfterSave,
  sameDraftPayload,
  sameRevisionedDraft,
  type RevisionedEditableDraft
} from "../features/vault/draftConcurrency";
import {
  EntryIdleDebounce,
  entryAutosaveRetryDelayMs,
  vaultEntryAutosaveIdleMs
} from "../features/vault/entryAutosave";
import {
  shouldReleaseVaultEntryCreation,
  type CreatableVaultEntryKind,
  type PendingVaultEntryCreation
} from "../features/vault/vaultEntryCreationLock";
import {
  createVaultPagePreviewContent,
  vaultPagePreviewDelay,
  vaultPagePreviewPosition,
  type VaultPagePreviewContent,
  type VaultPagePreviewPosition
} from "../features/vault/pagePreview";
import type {
  PreparedVaultPathRewriteJob,
  VaultPathRewriteStepV1
} from "../features/vault/pathRewriteJob";
import {
  automaticVaultPathRewriteRetryDelayMs,
  reconcileVaultPathRewriteJobAfterRecoveryScan,
  retryableVaultPathRewriteFailure,
  shouldAutomaticallyRecoverVaultPathRewriteJob,
  vaultPathRewriteRecoveryContinuationIsCurrent,
  VaultPathRewriteControllerError,
  type VaultPathRewriteStage
} from "../features/vault/pathRewriteControllerCore";
import {
  clearOptimisticVaultEntryPatch,
  projectOptimisticVaultEntries,
  type OptimisticVaultEntryPatch
} from "../features/vault/optimisticEntryOperations";
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
  createUnlinkedMentionWikilinkEdit,
  KnowledgeWorkerClient,
  matchesVaultSearchQuery,
  outgoingOccurrences,
  resolveInternalLink,
  unlinkedMentionOccurrences,
  vaultSearchQueryUsesRegex,
  type GraphSnapshot as IndexGraphSnapshot,
  type GraphViewSettings as IndexGraphViewSettings,
  type InternalLinkOccurrence,
  type KnowledgeMetadataSummary,
  type MarkdownHeading,
  type FrontmatterValue,
  type ResolvedLinkOccurrence,
  type RevisionedVaultIndexEntry,
  type TagIndexEntry,
  type UnlinkedMentionOccurrence,
  type VaultIndexEntry
} from "../features/knowledge";
import {
  MarkdownRenderer,
  exportMarkdown,
  exportMarkdownForDiscordAi,
  previewMarkdownHtmlNormalization,
  type DiscordAiMarkdownDelivery,
  type MarkdownExportProfile,
  type MarkdownLinkPreviewInteraction,
  type MarkdownLinkReference,
  type MarkdownViewMode
} from "../features/markdown";
import { createKanbanSource } from "../features/kanban/model";
import { setDataviewTaskChecked, type DataviewTask } from "../features/dataview/task";
import { applyTemplateInsertion, renderSafeTemplate } from "../features/templater/templateEngine";
import type {
  CodeMirrorMarkdownEditorProps,
  MarkdownImagePasteContext,
  MarkdownImagePasteResult
} from "../features/vault/CodeMirrorMarkdownEditor";
import { WorkspacePaneTree, type WorkspacePaneRender } from "../features/vault/WorkspacePaneTree";
import { VaultAssetPreview } from "../features/vault/VaultAssetPreview";
import { setFrontmatterProperty } from "../features/vault/frontmatterEditing";
import type { VaultHistoryDraft } from "../features/vault/VaultHistoryPanel";
import { downloadBlob } from "../features/vault/browserDownload";
import {
  createVaultImportManifest
} from "../features/vault/importRollback";
import { decodeVaultAsset } from "../features/vault/vaultAsset";
import { BoundedVaultAssetDecodeCache } from "../features/vault/vaultAssetCache";
import type { VaultMarkdownCopyDraft } from "../features/vault/core/formatConverter";
import type { ComposerEntrySnapshot, NoteComposerAdapter } from "../features/vault/core/noteComposer";
import { deterministicVaultOperationId } from "../features/vault/core/operationId";
import {
  activateWorkspaceTabGroup,
  createDefaultWorkspaceTabGroups,
  openWorkspaceTabInGroup,
  planWorkspaceTabClose,
  reconcileWorkspaceTabGroups,
  removeWorkspaceTabFromGroups,
  toggleWorkspaceTabPinned,
  type WorkspaceTabGroupId,
  type WorkspaceTabGroupState
} from "../features/vault/workspaceTabs";
import {
  MAXIMUM_WORKSPACE_PANES,
  createDefaultWorkspaceLayout,
  reconcileWorkspaceLayoutGroups,
  resizeWorkspaceSplit,
  splitWorkspacePane,
  workspaceLayoutGroupIds,
  type VaultWorkspacePaneNode,
  type VaultWorkspaceSplitDirection
} from "../features/vault/workspaceLayout";
import type { VaultTrashFolderItem } from "../features/vault/VaultTrashDialog";
import {
  partitionVaultFolderTrash,
  vaultFolderTrashCounts,
  visibleVaultNotesForFolders
} from "../features/vault/folderTrash";
import {
  MAXIMUM_VAULT_TREE_SELECTION,
  canonicalVaultTreeBulkTargets,
  createVaultTreeSelectionState,
  reconcileVaultTreeSelection,
  updateVaultTreeSelection,
  vaultTreeTargetKey,
  type VaultTreeTarget,
  type VaultTreeSelectionState
} from "../features/vault/fileTreeSelection";
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
  templateCandidates,
  uniqueNoteTitle
} from "../features/vault/noteCommands";
import { detectMarkdownPluginView } from "../features/vault/markdownPluginView";
import { useVaultNavigationShortcuts } from "../features/vault/navigation/useVaultNavigationShortcuts";
import type {
  CommandPaletteItem,
  NavigationActivationMetadata,
  QuickSwitcherItem
} from "../features/vault/navigation/types";
import { previewTextFromHtml } from "../lib/editorContent";
import { FeatureErrorBoundary } from "../components/FeatureErrorBoundary";
import { registerPrivateKeyAutoLockGuard } from "../lib/privateKeyAutoLockGuard";
import {
  buildVaultPaths,
  createEncryptedVaultFolder,
  decryptVaultFolders,
  decryptVaultNotes,
  migrateLegacyVaultFolder,
  moveEncryptedVaultFolder,
  renameEncryptedVaultFolder,
  vaultEntryPath,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "../features/vault/vaultData";
import {
  createEncryptedVaultAsset,
  createEncryptedVaultEntry,
  createMarkdownVaultNote,
  moveOnlyEncryptedVaultEntry,
  saveAndMoveEncryptedVaultEntry,
  saveEncryptedVaultEntry,
  type MarkdownNoteDraft,
  type VaultPastedImageSourceCommitCredential
} from "../features/vault/vaultPersistence";
import {
  VAULT_NAME_INDEX_VERSION,
  auditVaultFolderTree,
  requireValidVaultFolderTree,
  vaultNameFingerprint
} from "../features/vault/vaultIntegrity";
import { requireValidProposedVaultFolderTree } from "../features/vault/vaultFolderPreflight";
import type {
  VaultPastedImageFolderRuntime
} from "../features/vault/vaultPastedImageFolder";
import {
  DEFAULT_VAULT_RIGHT_PANEL_WIDTH,
  MIN_VAULT_RIGHT_PANEL_WIDTH,
  captureVaultWorkspaceLayout,
  clampVaultRightPanelWidth,
  clampVaultRightPanelWidthForViewport,
  createDefaultVaultWorkspaceState,
  flushLatestWorkspaceState,
  maxVaultRightPanelWidthForViewport,
  normalizeVaultWorkspaceState,
  restoreVaultWorkspaceLayout,
  vaultWorkspaceLayoutFitsEncryptedDocument,
  vaultWorkspaceStateFitsEncryptedDocument,
  MAX_NAMED_WORKSPACES,
  MAX_VAULT_BOOKMARKS,
  type PersistedEntryBookmark,
  type PersistedGraphBookmark,
  type PersistedNamedWorkspace,
  type PersistedSearchBookmark,
  type PersistedVaultTab,
  type PersistedVaultTabGroup,
  type PersistedVaultBookmark,
  type VaultPersistedWorkspaceState
} from "../features/vault/workspaceState";
import { resolveAlreadyPersistedWorkspaceSave } from "../features/vault/workspaceSaveQueue";
import {
  subscribeNoteFolders,
  subscribeDeletedNoteFolders,
  subscribeDeletedNotes,
  subscribeVisibleNotes,
  deleteRevisionedNote,
  getVisibleNotesByIdsFromServer,
  loadOwnedVaultCutoverInventory,
  NoteRevisionConflictError,
  restoreRevisionedNote,
  restoreRevisionedEncryptedFolderSubtree,
  trashRevisionedEncryptedFolderSubtree,
  VaultNameConflictError,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../services/notes";
import { subscribeUsers } from "../services/users";
import {
  VaultFolderApiError
} from "../services/vaultFolderMutations";
import { createVaultApiDeadline } from "../services/vaultApiDeadline";
import { VaultNoteApiError } from "../services/vaultNoteMutations";
import {
  activatePreparedVaultIntegrityKey,
  createVaultIntegrityCutoverLeaseId,
  prepareVaultIntegrityKey,
  reconcilePendingVaultIntegrityClaims,
  releaseVaultIntegrityCutoverLease,
  renewVaultIntegrityCutoverLease,
  sealVaultIntegrityCutover,
  type PreparedVaultIntegrityKey,
  type VaultIntegrityCutoverLease,
  VaultIntegrityApiError
} from "../services/vaultIntegrity";
import type {
  VaultPathRewriteActivationInput,
  VaultPathRewriteJobSummary,
  VaultPathRewriteSourceSnapshot
} from "../services/vaultPathRewriteJobs";
import {
  cleanupRetainedTerminalVaultImportJobs,
  cleanupTerminalVaultImportJob,
  commitVaultImportJob,
  createVaultImportJobId,
  createVaultImportTargetId,
  ensureVaultImportJob,
  listRecoverableVaultImportJobs,
  loadVaultImportJob,
  rollbackVaultImportJob,
  VaultImportJobError,
  type VaultImportJobSummary
} from "../services/vaultImportJobs";
import {
  VaultWorkspaceRevisionConflictError,
  loadVaultWorkspaceRecord,
  saveVaultWorkspace,
  type VaultWorkspaceState
} from "../services/vaultWorkspace";
import type { UserProfile } from "../types";
import "../styles/vault.css";

type VaultPathRewriteJobsModule = typeof import("../services/vaultPathRewriteJobs");
type VaultPathRewriteJobModule = typeof import("../features/vault/pathRewriteJob");
type VaultPathRewriteControllerModule = typeof import("../features/vault/pathRewriteController");

let vaultPathRewriteJobsModulePromise: Promise<VaultPathRewriteJobsModule> | null = null;
let vaultPathRewriteJobModulePromise: Promise<VaultPathRewriteJobModule> | null = null;
let vaultPathRewriteControllerModulePromise: Promise<VaultPathRewriteControllerModule> | null = null;

function loadVaultPathRewriteControllerModule() {
  vaultPathRewriteControllerModulePromise ??= import("../features/vault/pathRewriteController")
    .catch((cause: unknown) => {
      vaultPathRewriteControllerModulePromise = null;
      throw cause;
    });
  return vaultPathRewriteControllerModulePromise;
}

function loadVaultPathRewriteJobModule() {
  vaultPathRewriteJobModulePromise ??= import("../features/vault/pathRewriteJob");
  return vaultPathRewriteJobModulePromise;
}

function loadVaultPathRewriteJobsModule() {
  vaultPathRewriteJobsModulePromise ??= import("../services/vaultPathRewriteJobs");
  return vaultPathRewriteJobsModulePromise;
}

const executeVaultPathRewrite = (
  ...args: Parameters<VaultPathRewriteControllerModule["executeVaultPathRewrite"]>
) => loadVaultPathRewriteControllerModule()
  .then((module) => module.executeVaultPathRewrite(...args));

const flushVaultDraftsBeforePathRewriteRecovery = (
  ...args: Parameters<VaultPathRewriteControllerModule["flushVaultDraftsBeforePathRewriteRecovery"]>
) => loadVaultPathRewriteControllerModule()
  .then((module) => module.flushVaultDraftsBeforePathRewriteRecovery(...args));

const recoverVaultPathRewrite = (
  ...args: Parameters<VaultPathRewriteControllerModule["recoverVaultPathRewrite"]>
) => loadVaultPathRewriteControllerModule()
  .then((module) => module.recoverVaultPathRewrite(...args));

const buildVaultPathRewriteSourcePlans = (
  ...args: Parameters<VaultPathRewriteJobModule["buildVaultPathRewriteSourcePlans"]>
) => loadVaultPathRewriteJobModule()
  .then((module) => module.buildVaultPathRewriteSourcePlans(...args));

const prepareVaultPathRewriteJob = (
  ...args: Parameters<VaultPathRewriteJobModule["prepareVaultPathRewriteJob"]>
) => loadVaultPathRewriteJobModule()
  .then((module) => module.prepareVaultPathRewriteJob(...args));

const activateVaultPathRewriteJob = (
  ...args: Parameters<VaultPathRewriteJobsModule["activateVaultPathRewriteJob"]>
) => loadVaultPathRewriteJobsModule().then((module) => module.activateVaultPathRewriteJob(...args));

const scheduleTerminalVaultPathRewriteCleanup = (
  ...args: Parameters<VaultPathRewriteJobsModule["scheduleTerminalVaultPathRewriteCleanup"]>
) => loadVaultPathRewriteJobsModule()
  .then((module) => module.scheduleTerminalVaultPathRewriteCleanup(...args));

const beginTerminalVaultPathRewriteCleanupSession = (
  ...args: Parameters<VaultPathRewriteJobsModule["beginTerminalVaultPathRewriteCleanupSession"]>
) => loadVaultPathRewriteJobsModule()
  .then((module) => module.beginTerminalVaultPathRewriteCleanupSession(...args));

const ensureVaultPathRewriteJob = (
  ...args: Parameters<VaultPathRewriteJobsModule["ensureVaultPathRewriteJob"]>
) => loadVaultPathRewriteJobsModule().then((module) => module.ensureVaultPathRewriteJob(...args));

const scanRecoverableVaultPathRewriteJobs = (
  ...args: Parameters<VaultPathRewriteJobsModule["scanRecoverableVaultPathRewriteJobs"]>
) => loadVaultPathRewriteJobsModule()
  .then((module) => module.scanRecoverableVaultPathRewriteJobs(...args));

const recoverPreparedVaultPathRewriteJob = (
  ...args: Parameters<VaultPathRewriteJobsModule["recoverPreparedVaultPathRewriteJob"]>
) => loadVaultPathRewriteJobsModule()
  .then((module) => module.recoverPreparedVaultPathRewriteJob(...args));

const resumeVaultPathRewriteJob = (
  ...args: Parameters<VaultPathRewriteJobsModule["resumeVaultPathRewriteJob"]>
) => loadVaultPathRewriteJobsModule().then((module) => module.resumeVaultPathRewriteJob(...args));

const LazyBaseView = lazy(() => import("../features/base/BaseView").then((module) => ({
  default: module.BaseView
})));
const LazyDailyNotesCalendar = lazy(() => import("../features/calendar/DailyNotesCalendar").then((module) => ({
  default: module.DailyNotesCalendar
})));
const LazyDailyNotesSettings = lazy(() => import("../features/calendar/DailyNotesSettings"));
const LazyCodeMirrorMarkdownEditor = lazy(() => import("../features/vault/CodeMirrorMarkdownEditor").then((module) => ({
  default: module.CodeMirrorMarkdownEditor
})));
const LazyDataviewBlock = lazy(() => import("../features/dataview/DataviewBlock").then((module) => ({
  default: module.DataviewBlock
})));
const LazyMarkdownMessageBatchDialog = lazy(() => import("../features/markdown/MarkdownMessageBatchDialog").then((module) => ({
  default: module.MarkdownMessageBatchDialog
})));
const LazyDrawingView = lazy(() => import("../features/drawing/DrawingView").then((module) => ({
  default: module.DrawingView
})));
const LazyGraphView = lazy(() => import("../features/graph/GraphView").then((module) => ({
  default: module.GraphView
})));
const LazyVaultJsonCanvasPane = lazy(() => import("../features/canvas/VaultJsonCanvasPane").then((module) => ({
  default: module.VaultJsonCanvasPane
})));
const LazyKanbanBoard = lazy(() => import("../features/kanban/KanbanBoard").then((module) => ({
  default: module.KanbanBoard
})));
const LazyLinkOccurrencePanel = lazy(() => import("../features/vault/LinkOccurrencePanel").then((module) => ({
  default: module.LinkOccurrencePanel
})));
const LazyVaultOutline = lazy(() => import("../features/vault/VaultOutline").then((module) => ({
  default: module.VaultOutline
})));
const LazyVaultPropertiesEditor = lazy(() => import("../features/vault/VaultPropertiesEditor").then((module) => ({
  default: module.VaultPropertiesEditor
})));
const LazyVaultSearchPanel = lazy(() => import("../features/vault/VaultSearchPanel").then((module) => ({
  default: module.VaultSearchPanel
})));
const LazyVaultWorkspaceManager = lazy(() => import("../features/vault/VaultWorkspaceManager").then((module) => ({
  default: module.VaultWorkspaceManager
})));
const LazyTemplatePickerDialog = lazy(() => import("../features/templater/TemplatePickerDialog").then((module) => ({
  default: module.TemplatePickerDialog
})));
const LazyVaultHistoryPanel = lazy(() => import("../features/vault/VaultHistoryPanel").then((module) => ({
  default: module.VaultHistoryPanel
})));
const LazyVaultTrashDialog = lazy(() => import("../features/vault/VaultTrashDialog").then((module) => ({
  default: module.VaultTrashDialog
})));
const LazyVaultShareManagerDialog = lazy(() => import("../features/vault/VaultShareManagerDialog").then((module) => ({
  default: module.VaultShareManagerDialog
})));
const LazyVaultNoteAttachmentsRegion = lazy(() => import("../features/vault/VaultNoteAttachmentsRegion"));
const LazyVaultParticipantShareDialog = lazy(() => import("../features/vault/VaultParticipantShareDialog").then((module) => ({
  default: module.VaultParticipantShareDialog
})));
const LazyCommandPalette = lazy(() => import("../features/vault/navigation/CommandPalette").then((module) => ({
  default: module.CommandPalette
})));
const LazyQuickSwitcher = lazy(() => import("../features/vault/navigation/QuickSwitcher").then((module) => ({
  default: module.QuickSwitcher
})));
const LazyVaultImportRecoveryPanel = lazy(() => import("../features/vault/VaultImportRecoveryPanel").then((module) => ({
  default: module.VaultImportRecoveryPanel
})));
const LazyVaultPathRewriteRecoveryNotice = lazy(() => import("../features/vault/VaultPathRewriteRecoveryNotice").then((module) => ({
  default: module.VaultPathRewriteRecoveryNotice
})));
const LazyVaultDraftConflictResolver = lazy(() => import("../features/vault/VaultDraftConflictResolver").then((module) => ({
  default: module.VaultDraftConflictResolver
})));
const LazyVaultAudioRecorder = lazy(() => import("../features/vault/core/VaultAudioRecorder").then((module) => ({
  default: module.VaultAudioRecorder
})));
const LazyVaultFootnotesView = lazy(() => import("../features/vault/core/VaultFootnotesView").then((module) => ({
  default: module.VaultFootnotesView
})));
const LazyVaultFormatConverter = lazy(() => import("../features/vault/core/VaultFormatConverter").then((module) => ({
  default: module.VaultFormatConverter
})));
const LazyVaultNoteComposer = lazy(() => import("../features/vault/core/VaultNoteComposer").then((module) => ({
  default: module.VaultNoteComposer
})));
const LazyVaultSlides = lazy(() => import("../features/vault/core/VaultSlides").then((module) => ({
  default: module.VaultSlides
})));
const LazyVaultWebViewer = lazy(() => import("../features/vault/core/VaultWebViewer").then((module) => ({
  default: module.VaultWebViewer
})));

const MOBILE_VAULT_MEDIA_QUERY = "(max-width: 760px)";
const COMPACT_CALENDAR_MEDIA_QUERY = "(max-width: 420px)";
const GRAPH_VIEWPORT_COMMIT_DELAY_MS = 240;
const EMPTY_FRONTMATTER_PROPERTIES = Object.freeze({});
const MOBILE_DRAWER_FOCUSABLE = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

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

function subscribeCompactCalendarLayout(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(COMPACT_CALENDAR_MEDIA_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function compactCalendarLayoutSnapshot() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(COMPACT_CALENDAR_MEDIA_QUERY).matches;
}

function useCompactCalendarLayout() {
  return useSyncExternalStore(subscribeCompactCalendarLayout, compactCalendarLayoutSnapshot, () => false);
}

function subscribeOnlineStatus(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function onlineStatusSnapshot() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function useOnlineStatus() {
  return useSyncExternalStore(subscribeOnlineStatus, onlineStatusSnapshot, () => true);
}

function VaultViewLoading({ label }: { label: string }) {
  return <div aria-live="polite" className="vault-view-loading" role="status">{label} 불러오는 중…</div>;
}

function VaultMarkdownEditor(props: CodeMirrorMarkdownEditorProps) {
  return (
    <Suspense fallback={<VaultViewLoading label="Markdown 편집기" />}>
      <LazyCodeMirrorMarkdownEditor {...props} />
    </Suspense>
  );
}

function handleRovingTabListKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .filter((tab) => !tab.disabled);
  if (!tabs.length) return;
  const activeTab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
  const activeIndex = activeTab ? tabs.indexOf(activeTab) : -1;
  let nextIndex = activeIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (event.key === "ArrowRight") nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % tabs.length;
  if (event.key === "ArrowLeft") nextIndex = activeIndex < 0 ? tabs.length - 1 : (activeIndex - 1 + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

type LeftPanelMode = "files" | "search" | "tags" | "bookmarks";
type RightPanelMode = "backlinks" | "outgoing" | "properties" | "outline" | "local-graph" | "history";

class VaultPathRewriteSnapshotChangedError extends Error {
  constructor(message = "Vault 구독 세대가 변경되었습니다.") {
    super(message);
    this.name = "VaultPathRewriteSnapshotChangedError";
  }
}

interface VaultPathRewriteGenerationSignal {
  decryptedFolders: readonly DecryptedVaultFolder[];
  decryptedNotes: readonly DecryptedVaultNote[];
  folderReservationSignature: string | null;
  folderServerReady: boolean;
  noteReservationSignature: string | null;
  noteServerReady: boolean;
  rawFolders: readonly NoteFolderSnapshot[];
  rawNotes: readonly NoteSnapshot[];
}

export function vaultPathRewriteGenerationSignalChanged(
  before: VaultPathRewriteGenerationSignal,
  after: VaultPathRewriteGenerationSignal
) {
  return before.decryptedFolders !== after.decryptedFolders
    || before.decryptedNotes !== after.decryptedNotes
    || before.folderReservationSignature !== after.folderReservationSignature
    || before.folderServerReady !== after.folderServerReady
    || before.noteReservationSignature !== after.noteReservationSignature
    || before.noteServerReady !== after.noteServerReady
    || before.rawFolders !== after.rawFolders
    || before.rawNotes !== after.rawNotes;
}

function pathRewriteInventoryFailureMessage(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = String(error.code);
  if (code === "vault_path_rewrite_inventory_changed") {
    return "다른 탭에서 Vault 항목이나 폴더가 변경되어 작업을 중단했습니다. 최신 목록으로 다시 시도해주세요.";
  }
  if (code === "vault_path_rewrite_inventory_capacity") {
    return "Vault 항목 또는 폴더 수가 안전한 경로 갱신 한도를 초과해 작업을 중단했습니다.";
  }
  if (code === "vault_inventory_manifest_invalid") {
    return "암호화된 경로 인벤토리가 현재 Vault와 일치하지 않아 변경을 중단했습니다. 새로고침 후에도 반복되면 복구가 필요합니다.";
  }
  if (code === "vault_inventory_manifest_capacity") {
    return "암호화된 경로 인벤토리 shard가 안전한 용량을 초과해 변경을 중단했습니다.";
  }
  if (code === "vault_inventory_manifest_timeout") {
    return "서버 경로 확인이 지연되어 작업 잠금을 해제했습니다. 현재 편집본은 보존되며 잠시 후 다시 시도할 수 있습니다.";
  }
  return null;
}

function persistedEncryptedMutationPatch(result: {
  revision: number;
  encryptedBody?: DecryptedVaultNote["encryptedBody"];
  encryptedTitle?: DecryptedVaultNote["encryptedTitle"];
  vaultNameClaimId?: string;
  vaultNameIndexVersion?: DecryptedVaultNote["vaultNameIndexVersion"];
}): Partial<Pick<
  DecryptedVaultNote,
  "encryptedBody" | "encryptedTitle" | "vaultNameClaimId" | "vaultNameIndexVersion"
>> {
  return {
    ...(result.encryptedBody ? { encryptedBody: result.encryptedBody } : {}),
    ...(result.encryptedTitle ? { encryptedTitle: result.encryptedTitle } : {}),
    ...(result.vaultNameClaimId ? { vaultNameClaimId: result.vaultNameClaimId } : {}),
    ...(result.vaultNameIndexVersion !== undefined
      ? { vaultNameIndexVersion: result.vaultNameIndexVersion }
      : {})
  };
}

function ambiguousVaultSaveFailure(error: unknown) {
  return error instanceof VaultNoteApiError
    && (
      error.code === "network_error"
      || error.code === "network_timeout"
      || error.code === "invalid_response"
      || error.status >= 500
    );
}

function persistedEncryptedFolderMutationPatch(result: {
  revision: number;
  encryptedName?: DecryptedVaultFolder["encryptedName"];
  vaultNameClaimId?: string;
  vaultNameIndexVersion?: DecryptedVaultFolder["vaultNameIndexVersion"];
}): Partial<Pick<
  DecryptedVaultFolder,
  "encryptedName" | "vaultNameClaimId" | "vaultNameIndexVersion"
>> {
  return {
    ...(result.encryptedName ? { encryptedName: result.encryptedName } : {}),
    ...(result.vaultNameClaimId ? { vaultNameClaimId: result.vaultNameClaimId } : {}),
    ...(result.vaultNameIndexVersion !== undefined
      ? { vaultNameIndexVersion: result.vaultNameIndexVersion }
      : {})
  };
}

async function resolveDeferredVaultFolderCollision(
  folder: DecryptedVaultFolder,
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  replacement: { name: string; parentId: string | null },
  pathRewriteActivation?: VaultPathRewriteActivationInput
) {
  const { resolveVaultFolderNameCollision } = await import(
    "../features/vault/vaultFolderCollisionRecovery"
  );
  return resolveVaultFolderNameCollision(
    folder,
    profile,
    privateKey,
    vaultIntegrityKey,
    replacement,
    pathRewriteActivation
  );
}

async function resolveDeferredVaultEntryCollision(
  note: DecryptedVaultNote,
  uid: string,
  privateKey: CryptoKey,
  vaultIntegrityKey: CryptoKey,
  replacement: { folderId: string | null; title: string },
  pathRewriteActivation?: VaultPathRewriteActivationInput
) {
  const { resolveVaultEntryNameCollision } = await import(
    "../features/vault/vaultEntryCollisionRecovery"
  );
  return resolveVaultEntryNameCollision(
    note,
    uid,
    privateKey,
    vaultIntegrityKey,
    replacement,
    pathRewriteActivation
  );
}

const RIGHT_PANEL_TABS = [
  { icon: Link2, label: "백링크", mode: "backlinks" },
  { icon: GitFork, label: "나가는 링크", mode: "outgoing" },
  { icon: ListTree, label: "목차", mode: "outline" },
  { icon: Hash, label: "속성", mode: "properties" },
  { icon: Network, label: "로컬 그래프", mode: "local-graph" },
  { icon: History, label: "File Recovery", mode: "history" }
] as const satisfies ReadonlyArray<{
  icon: typeof Link2;
  label: string;
  mode: RightPanelMode;
}>;
type VaultCoreToolId = "audio" | "footnotes" | "format" | "composer" | "slides" | "web";
type WorkspaceTab =
  | { id: string; kind: "entry"; entryId: string; instanceId?: WorkspaceTabGroupId; label: string; pinned?: boolean }
  | { id: "global-graph"; kind: "global-graph"; label: string; pinned?: boolean };

interface VaultContextMenuState {
  returnFocusElement: HTMLButtonElement | null;
  targetId: string;
  targetKind: "entry" | "folder";
  x: number;
  y: number;
}

interface VaultShareDialogState {
  hasUnsharedAssetEmbeds?: boolean;
  note: DecryptedVaultNote;
  returnFocusTo: HTMLElement | null;
}

interface DraftState extends MarkdownNoteDraft {
  /** Revision from which this edit buffer was created; never follows remote updates while dirty. */
  baseRevision: number;
  dirty: boolean;
}

type VaultEntryRenameResult = "blocked" | "retryable-failure" | "saved" | "unchanged";

interface MarkdownDraftBaseSnapshot {
  baseRevision: number;
  body: string;
  contentFormat: "markdown-v1";
  entryKind: "markdown";
  folderId: string | null;
  ownerUid: string;
  title: string;
}

interface MarkdownDraftMergeConflictState {
  base: MarkdownDraftBaseSnapshot;
  entryId: string;
  local: RevisionedEditableDraft;
  remote: DecryptedVaultNote & { contentFormat: "markdown-v1"; entryKind: "markdown" };
}

function isMarkdownMergeEntry(
  note: DecryptedVaultNote
): note is DecryptedVaultNote & { contentFormat: "markdown-v1"; entryKind: "markdown" } {
  return note.contentFormat === "markdown-v1" && note.entryKind === "markdown";
}

function resolveConflictScalar<T>(base: T, local: T, remote: T): { conflict: false; value: T } | { conflict: true } {
  if (local === remote) return { conflict: false, value: local };
  if (local === base) return { conflict: false, value: remote };
  if (remote === base) return { conflict: false, value: local };
  return { conflict: true };
}

function InactiveWorkspacePane({
  documentKey,
  draft,
  groupLabel,
  note,
  onActivate,
  onChange,
  onPasteImages,
  onSave,
  readOnly,
  tab
}: {
  documentKey: string;
  draft?: DraftState;
  groupLabel: string;
  note: DecryptedVaultNote | null;
  onActivate: () => void;
  onChange: (body: string) => void;
  onPasteImages?: CodeMirrorMarkdownEditorProps["onPasteImages"];
  onSave: () => void;
  readOnly: boolean;
  tab: WorkspaceTab | null;
}) {
  return (
    <div className="vault-inactive-pane">
      <header>
        <span>{tab?.label ?? "빈 탭 그룹"}</span>
        <button aria-label={`${groupLabel} 활성화`} onClick={onActivate} type="button">이 그룹에서 편집</button>
      </header>
      <div className={`vault-inactive-pane-preview${note?.entryKind === "markdown" && note.contentFormat === "markdown-v1" && draft ? " is-editor" : ""}`}>
        {tab?.kind === "global-graph" ? (
          <div className="vault-inactive-pane-placeholder"><Network size={30} /><span>전체 그래프</span></div>
        ) : note?.contentFormat === "legacy-html-v1" ? (
          <ReadonlyNoteRenderer as="article" content={note.body} />
        ) : note?.entryKind === "markdown" && note.contentFormat === "markdown-v1" && draft ? (
          <VaultMarkdownEditor
            documentKey={documentKey}
            livePreview
            onChange={onChange}
            onPasteImages={onPasteImages}
            onSave={onSave}
            readOnly={readOnly}
            value={draft.body}
            valueRevision={draft.baseRevision}
          />
        ) : (
          <div className="vault-inactive-pane-placeholder">
            <BookOpen size={30} />
            <span>{note ? `${entryLabel(note)} · ${note.entryKind}` : "열린 항목 없음"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface VaultWorkspaceConflictState {
  actualRevision: number;
  localState: VaultPersistedWorkspaceState;
  remoteState: VaultPersistedWorkspaceState | null;
}

type VaultNameMigrationStatus = "checking" | "waiting" | "running" | "ready" | "blocked";

interface VaultNameMigrationProgressState {
  completed: number;
  migrated: number;
  skipped: number;
  total: number;
}

interface CreateVaultEntryOptions {
  folderId?: string | null;
  preserveRequestedTitle?: boolean;
}

function timestampMillis(value: DecryptedVaultNote["createdAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : undefined;
}

export function ownedNoteReservationSignature(notes: readonly NoteSnapshot[], uid: string) {
  return JSON.stringify(notes
    .filter((note) => (
      note.ownerUid === uid
      && note.isDeleted !== true
      && (note.type === "personal" || note.type === "shared")
    ))
    .map((note) => [
      note.id,
      note.folderId ?? null,
      note.entryKind ?? null,
      note.contentFormat ?? null,
      note.encryptedTitle.version,
      note.encryptedTitle.algorithm,
      note.encryptedTitle.iv,
      note.encryptedTitle.cipherText,
      note.vaultNameClaimId ?? null,
      note.vaultNameIndexVersion ?? null
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export function visibleVaultOwnerIds(profile: UserProfile, users: readonly UserProfile[]) {
  if (profile.isAdmin) return null;
  return Array.from(new Set([
    profile.uid,
    ...users
      .filter((user) => (
        user.isActive
        && user.uid !== profile.uid
        && user.allowedShareTargetUids?.includes(profile.uid) === true
      ))
      .map((user) => user.uid)
  ])).sort();
}

export function knowledgeAccessScopeSignature(notes: readonly NoteSnapshot[], uid: string) {
  return notes
    .filter((note) => note.participantUids.includes(uid) && note.isDeleted !== true)
    .map((note) => JSON.stringify([
      note.id,
      note.ownerUid,
      note.type,
      [...note.participantUids].sort(),
      note.wrappedKeys[uid]?.wrappedKey ?? null
    ]))
    .sort();
}

export function knowledgeAccessScopeRequiresReset(
  previous: readonly string[],
  current: readonly string[]
) {
  if (!previous.length) return false;
  const currentSet = new Set(current);
  return previous.some((signature) => !currentSet.has(signature));
}

export function vaultOwnerScopeRequiresReset(previous: string, current: string) {
  if (previous === current || current === "admin") return false;
  if (previous === "admin") return true;
  const currentOwners = new Set(current.split("\n").filter(Boolean));
  return previous.split("\n").filter(Boolean).some((ownerUid) => !currentOwners.has(ownerUid));
}

export function vaultPlaintextScopeSignature(
  notes: readonly NoteSnapshot[],
  uid: string,
  ownerScopeKey: string
) {
  return JSON.stringify([
    ownerScopeKey,
    ...notes
      .filter((note) => note.participantUids.includes(uid) && note.isDeleted !== true)
      .map((note) => [
        note.id,
        note.ownerUid,
        note.type,
        [...note.participantUids].sort(),
        note.wrappedKeys[uid]?.wrappedKey ?? null
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  ]);
}

interface ParsedVaultPlaintextScope {
  entriesById: ReadonlyMap<string, string>;
  ownerScopeKey: string;
}

function parseVaultPlaintextScope(scopeKey: string): ParsedVaultPlaintextScope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopeKey);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
  const entriesById = new Map<string, string>();
  for (const value of parsed.slice(1)) {
    if (
      !Array.isArray(value)
      || value.length !== 5
      || typeof value[0] !== "string"
      || typeof value[1] !== "string"
      || typeof value[2] !== "string"
      || !Array.isArray(value[3])
      || !value[3].every((participantUid) => typeof participantUid === "string")
      || (value[4] !== null && typeof value[4] !== "string")
      || entriesById.has(value[0])
    ) return null;
    entriesById.set(value[0], JSON.stringify(value));
  }
  return { entriesById, ownerScopeKey: parsed[0] };
}

/**
 * An additive grant cannot revoke plaintext already decrypted for this
 * session. Keep the existing inventory visible while the added documents
 * decrypt, but fail closed on removals, owner contraction, and same-ID access
 * replacement. Malformed scope state is never compatible.
 */
export function vaultPlaintextScopeCanRetain(
  decryptedScopeKey: string,
  currentScopeKey: string
) {
  if (decryptedScopeKey === currentScopeKey) return true;
  const decryptedScope = parseVaultPlaintextScope(decryptedScopeKey);
  const currentScope = parseVaultPlaintextScope(currentScopeKey);
  if (
    !decryptedScope
    || !currentScope
    || vaultOwnerScopeRequiresReset(
      decryptedScope.ownerScopeKey,
      currentScope.ownerScopeKey
    )
  ) return false;
  for (const [noteId, entry] of decryptedScope.entriesById) {
    if (currentScope.entriesById.get(noteId) !== entry) return false;
  }
  return true;
}

export function decryptedVaultNotesForScope(
  decryptedNotes: readonly DecryptedVaultNote[],
  ownerIds: readonly string[] | null,
  decryptedScopeKey: string | null,
  currentScopeKey: string,
  snapshotReceived: boolean
) {
  if (
    !snapshotReceived
    || decryptedScopeKey === null
    || !vaultPlaintextScopeCanRetain(decryptedScopeKey, currentScopeKey)
  ) return [];
  if (ownerIds === null) return [...decryptedNotes];
  const visibleOwners = new Set(ownerIds);
  return decryptedNotes.filter((note) => visibleOwners.has(note.ownerUid));
}

export function workspaceTabsForVaultNotes(
  storedTabs: readonly WorkspaceTab[],
  notes: readonly DecryptedVaultNote[]
) {
  const notesById = new Map(notes.map((note) => [note.id, note]));
  return storedTabs.flatMap((tab): WorkspaceTab[] => {
    if (tab.kind !== "entry") return [tab];
    const note = notesById.get(tab.entryId);
    return note ? [{ ...tab, label: entryLabel(note) }] : [];
  });
}

export function ownedFolderReservationSignature(folders: readonly NoteFolderSnapshot[], uid: string) {
  return JSON.stringify(folders
    .filter((folder) => folder.ownerUid === uid)
    .map((folder) => [
      folder.id,
      folder.parentId ?? null,
      folder.encryptedName?.version ?? null,
      folder.encryptedName?.algorithm ?? null,
      folder.encryptedName?.iv ?? null,
      folder.encryptedName?.cipherText ?? null,
      folder.encryptedName ? null : folder.name,
      folder.vaultNameClaimId ?? null,
      folder.vaultNameIndexVersion ?? null
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
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
      color: node.color,
      createdAt: node.createdAt
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
    ? {
        kind: "entry",
        entryId: tab.entryId,
        ...(tab.instanceId ? { instanceId: tab.instanceId } : {}),
        ...(tab.pinned ? { pinned: true as const } : {})
      }
    : tab.pinned ? { kind: "global-graph", pinned: true } : { kind: "global-graph" };
}

function persistedTabId(tab: PersistedVaultTab) {
  return tab.kind === "global-graph"
    ? "global-graph"
    : workspaceEntryTabId(tab.entryId, tab.instanceId ?? "primary");
}

function workspaceEntryTabId(entryId: string, groupId: WorkspaceTabGroupId) {
  return groupId === "primary" ? `entry:${entryId}` : `entry:${entryId}:${groupId}`;
}

function restoredTab(tab: PersistedVaultTab, notes: readonly DecryptedVaultNote[] = []): WorkspaceTab {
  if (tab.kind === "global-graph") {
    return { id: "global-graph", kind: "global-graph", label: "그래프 보기", pinned: tab.pinned === true };
  }
  const note = notes.find((candidate) => candidate.id === tab.entryId);
  return {
    id: workspaceEntryTabId(tab.entryId, tab.instanceId ?? "primary"),
    kind: "entry",
    entryId: tab.entryId,
    ...(tab.instanceId ? { instanceId: tab.instanceId } : {}),
    label: note ? entryLabel(note) : "암호화 노트",
    pinned: tab.pinned === true
  };
}

function workspaceStateForSave(input: {
  activeTab: WorkspaceTab | null;
  activeTabGroupId: WorkspaceTabGroupId;
  workspaceLayout: VaultWorkspacePaneNode;
  calendarCursorMonth: string;
  calendarOpen: boolean;
  dailyNotesFolderId: string | null;
  dailyNotesTemplateEntryId: string | null;
  templatesFolderPath: string | null;
  templatesIncludeDescendants: boolean;
  expandedFolderIds: ReadonlySet<string>;
  globalCollapsedSections: GraphSettingsSectionId[];
  globalGraphSettings: UiGraphViewSettings;
  globalViewport: GraphViewport;
  bookmarks: PersistedVaultBookmark[];
  graphBookmarks: PersistedGraphBookmark[];
  leftMode: LeftPanelMode;
  leftOpen: boolean;
  localCollapsedSections: GraphSettingsSectionId[];
  localGraphSettings: UiGraphViewSettings;
  localViewport: GraphViewport;
  namedWorkspaces: PersistedNamedWorkspace[];
  rightMode: RightPanelMode;
  rightOpen: boolean;
  rightPanelWidth: number;
  searchQuery: string;
  searchBookmarks: PersistedSearchBookmark[];
  selectedFolderId: string | null;
  tabs: WorkspaceTab[];
  tabGroups: WorkspaceTabGroupState[];
  viewMode: MarkdownViewMode;
}): VaultPersistedWorkspaceState {
  const defaults = createDefaultVaultWorkspaceState();
  const tabById = new Map(input.tabs.map((tab) => [tab.id, tab]));
  const tabGroups = input.tabGroups.flatMap((group): PersistedVaultTabGroup[] => {
    const groupTabs = group.tabIds.flatMap((tabId): PersistedVaultTab[] => {
      const tab = tabById.get(tabId);
      return tab ? [persistedTab(tab)] : [];
    });
    if (input.tabGroups.length > 1 && groupTabs.length === 0) return [];
    const groupActiveTab = group.activeTabId ? tabById.get(group.activeTabId) : undefined;
    return [{
      id: group.id,
      tabs: groupTabs,
      activeTab: groupActiveTab ? persistedTab(groupActiveTab) : groupTabs[0] ?? null
    }];
  });
  const safeTabGroups = tabGroups.length > 0
    ? tabGroups
    : [{ id: "primary", tabs: [], activeTab: null }];
  return {
    version: 1,
    tabs: input.tabs.map(persistedTab),
    activeTab: input.activeTab ? persistedTab(input.activeTab) : null,
    tabGroups: safeTabGroups,
    activeTabGroupId: safeTabGroups.some((group) => group.id === input.activeTabGroupId)
      ? input.activeTabGroupId
      : safeTabGroups[0].id,
    layout: reconcileWorkspaceLayoutGroups(
      input.workspaceLayout,
      safeTabGroups.map((group) => group.id)
    ),
    left: { open: input.leftOpen, mode: input.leftMode },
    right: {
      open: input.rightOpen,
      mode: input.rightMode,
      width: clampVaultRightPanelWidth(input.rightPanelWidth)
    },
    selectedFolderId: input.selectedFolderId,
    expandedFolderIds: [...input.expandedFolderIds],
    searchQuery: input.searchQuery,
    bookmarks: input.bookmarks,
    searchBookmarks: input.searchBookmarks,
    viewMode: input.viewMode,
    graphBookmarks: input.graphBookmarks,
    namedWorkspaces: input.namedWorkspaces,
    plugins: {
      calendar: {
        cursorMonth: input.calendarCursorMonth,
        folderId: input.dailyNotesFolderId,
        open: input.calendarOpen,
        templateEntryId: input.dailyNotesTemplateEntryId
      },
      templates: {
        folderPath: input.templatesFolderPath,
        includeDescendants: input.templatesIncludeDescendants
      }
    },
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

function sameGraphViewport(left: GraphViewport, right: GraphViewport) {
  return left.centerX === right.centerX
    && left.centerY === right.centerY
    && left.zoom === right.zoom;
}

export function vaultWorkspaceWithGraphViewport(
  workspace: VaultPersistedWorkspaceState,
  scope: "global" | "local",
  viewport: GraphViewport
): VaultPersistedWorkspaceState {
  const nextViewport = { ...viewport };
  return scope === "global"
    ? {
        ...workspace,
        globalGraph: {
          ...workspace.globalGraph,
          viewport: nextViewport
        }
      }
    : {
        ...workspace,
        localGraph: {
          ...workspace.localGraph,
          viewport: nextViewport
        }
      };
}

function namedWorkspaceForEntryIds(
  workspace: PersistedNamedWorkspace,
  visibleEntryIds: ReadonlySet<string>
): PersistedNamedWorkspace {
  const tabAvailable = (tab: PersistedVaultTab) => tab.kind !== "entry" || visibleEntryIds.has(tab.entryId);
  const tabGroups = workspace.snapshot.tabGroups.flatMap((group): PersistedVaultTabGroup[] => {
    const tabs = group.tabs.filter(tabAvailable);
    const activeTab = group.activeTab && tabAvailable(group.activeTab)
      && tabs.some((tab) => persistedTabId(tab) === persistedTabId(group.activeTab!))
      ? group.activeTab
      : tabs[0] ?? null;
    return [{ ...group, tabs, activeTab }];
  });
  const nonEmptyGroups = tabGroups.filter((group) => group.tabs.length > 0);
  const safeGroups = nonEmptyGroups.length > 0
    ? nonEmptyGroups
    : [tabGroups.find((group) => group.id === workspace.snapshot.activeTabGroupId)
      ?? tabGroups[0]
      ?? { id: "primary", tabs: [], activeTab: null }];
  const activeTabGroupId = safeGroups.some((group) => group.id === workspace.snapshot.activeTabGroupId)
    ? workspace.snapshot.activeTabGroupId
    : safeGroups[0].id;
  const activeTab = safeGroups.find((group) => group.id === activeTabGroupId)?.activeTab ?? null;
  const visibleTabs = safeGroups.flatMap((group) => group.tabs);
  return {
    ...workspace,
    snapshot: {
      ...workspace.snapshot,
      activeTab,
      activeTabGroupId,
      layout: reconcileWorkspaceLayoutGroups(
        workspace.snapshot.layout,
        safeGroups.map((group) => group.id)
      ),
      bookmarks: workspace.snapshot.bookmarks.filter(
        (bookmark) => bookmark.kind !== "entry" || visibleEntryIds.has(bookmark.entryId)
      ),
      plugins: {
        ...workspace.snapshot.plugins,
        calendar: {
          ...workspace.snapshot.plugins.calendar,
          templateEntryId: workspace.snapshot.plugins.calendar.templateEntryId
            && visibleEntryIds.has(workspace.snapshot.plugins.calendar.templateEntryId)
            ? workspace.snapshot.plugins.calendar.templateEntryId
            : null
        }
      },
      tabs: visibleTabs,
      tabGroups: safeGroups
    }
  };
}

export function vaultWorkspaceForEntryIds(
  workspace: VaultPersistedWorkspaceState,
  visibleEntryIds: ReadonlySet<string>
): VaultPersistedWorkspaceState {
  const normalizedWorkspace = normalizeVaultWorkspaceState(workspace);
  const filtered = namedWorkspaceForEntryIds({
    id: "current",
    label: "current",
    createdAt: 0,
    updatedAt: 0,
    snapshot: captureVaultWorkspaceLayout(normalizedWorkspace)
  }, visibleEntryIds).snapshot;
  const requestedActiveTab = normalizedWorkspace.activeTab;
  const activeTab = requestedActiveTab
    && (requestedActiveTab.kind !== "entry" || visibleEntryIds.has(requestedActiveTab.entryId))
    && filtered.tabs.some((tab) => persistedTabId(tab) === persistedTabId(requestedActiveTab))
    ? requestedActiveTab
    : null;
  return {
    ...normalizedWorkspace,
    activeTab,
    activeTabGroupId: filtered.activeTabGroupId,
    layout: filtered.layout,
    bookmarks: normalizedWorkspace.bookmarks.filter(
      (bookmark) => bookmark.kind !== "entry" || visibleEntryIds.has(bookmark.entryId)
    ),
    namedWorkspaces: normalizedWorkspace.namedWorkspaces.map(
      (namedWorkspace) => namedWorkspaceForEntryIds(namedWorkspace, visibleEntryIds)
    ),
    plugins: {
      ...normalizedWorkspace.plugins,
      calendar: {
        ...normalizedWorkspace.plugins.calendar,
        templateEntryId: normalizedWorkspace.plugins.calendar.templateEntryId
          && visibleEntryIds.has(normalizedWorkspace.plugins.calendar.templateEntryId)
          ? normalizedWorkspace.plugins.calendar.templateEntryId
          : null
      }
    },
    tabs: filtered.tabs,
    tabGroups: filtered.tabGroups
  };
}

export function vaultWorkspaceWithoutEntryReferences(
  workspace: VaultPersistedWorkspaceState
): VaultPersistedWorkspaceState {
  return vaultWorkspaceForEntryIds(workspace, new Set());
}

function useKnowledgeGraphSnapshot(
  index: ReturnType<typeof buildKnowledgeIndex> | null,
  settings: IndexGraphViewSettings,
  activeEntryId: string | null
) {
  return useMemo(
    () => index && !graphViewSettingsUsesRegex(settings)
      ? buildGraphSnapshot(
          index,
          settings,
          { activeEntryId: activeEntryId ?? undefined, allowRegex: false }
        )
      : emptyGraphSnapshot(settings.scope),
    [activeEntryId, index, settings]
  );
}

function graphViewSettingsUsesRegex(settings: IndexGraphViewSettings) {
  return [settings.common.query, ...settings.common.groups.map((group) => group.query)]
    .some((query) => query.trim() !== "" && vaultSearchQueryUsesRegex(query));
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

function sameVaultIndexEntry(left: VaultIndexEntry, right: VaultIndexEntry) {
  return left.id === right.id
    && left.path === right.path
    && left.kind === right.kind
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

const KNOWLEDGE_BULK_REPLACE_THRESHOLD = 200;

type ActiveVaultPagePreview = VaultPagePreviewContent & VaultPagePreviewPosition;

interface VaultPagePreviewIntent {
  anchor: HTMLElement;
  content: VaultPagePreviewContent;
  sources: Set<MarkdownLinkPreviewInteraction["source"]>;
}

function clearVaultPagePreviewTimer(timer: { current: number | null }) {
  if (timer.current !== null) {
    window.clearTimeout(timer.current);
    timer.current = null;
  }
}

function UnlockedVaultPage({
  getIdToken,
  privateKey,
  profile
}: {
  getIdToken: () => Promise<string>;
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
  const [noteSnapshotReceived, setNoteSnapshotReceived] = useState(false);
  const [folderSnapshotReceived, setFolderSnapshotReceived] = useState(false);
  const [vaultDataReady, setVaultDataReady] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const ownerIds = useMemo(() => visibleVaultOwnerIds(profile, users), [profile, users]);
  const ownerIdKey = ownerIds?.join("\n") ?? "admin";
  const plaintextScopeKey = useMemo(
    () => vaultPlaintextScopeSignature(rawNotes, profile.uid, ownerIdKey),
    [ownerIdKey, profile.uid, rawNotes]
  );
  const [decryptedVaultScopeKey, setDecryptedVaultScopeKey] = useState<string | null>(null);
  const [decryptedNotes, setDecryptedNotes] = useState<DecryptedVaultNote[]>([]);
  const vaultPlaintextScopeReady = noteSnapshotReceived
    && decryptedVaultScopeKey === plaintextScopeKey;
  const notes = useMemo(() => decryptedVaultNotesForScope(
    decryptedNotes,
    ownerIds,
    decryptedVaultScopeKey,
    plaintextScopeKey,
    noteSnapshotReceived
  ), [decryptedNotes, decryptedVaultScopeKey, noteSnapshotReceived, ownerIds, plaintextScopeKey]);
  const [folders, setFolders] = useState<DecryptedVaultFolder[]>([]);
  const vaultIntegrityProfileSignature = JSON.stringify([profile.uid, profile.publicKeyJwk]);
  const vaultIntegrityProfileRef = useRef(profile);
  vaultIntegrityProfileRef.current = profile;
  const [vaultIntegrityKey, setVaultIntegrityKey] = useState<CryptoKey | null>(null);
  const [preparedVaultIntegrityKey, setPreparedVaultIntegrityKey] = useState<PreparedVaultIntegrityKey | null>(null);
  const [vaultNameMigrationStatus, setVaultNameMigrationStatus] = useState<VaultNameMigrationStatus>("checking");
  const [vaultNameMigrationProgress, setVaultNameMigrationProgress] = useState<VaultNameMigrationProgressState | null>(null);
  const [vaultNameMigrationFailure, setVaultNameMigrationFailure] = useState<string | null>(null);
  const [vaultIntegrityRetryAttempt, setVaultIntegrityRetryAttempt] = useState(0);
  const LazyVaultNameIntegrityNotice = useMemo(() => {
    void vaultIntegrityRetryAttempt;
    return lazy(() => import("../features/vault/VaultNameIntegrityNotice"));
  }, [vaultIntegrityRetryAttempt]);
  const [vaultNameMigrationResumeAttempt, setVaultNameMigrationResumeAttempt] = useState(0);
  const vaultNameMigrationStatusRef = useRef<VaultNameMigrationStatus>("checking");
  vaultNameMigrationStatusRef.current = vaultNameMigrationStatus;
  const [vaultNameCollisionTargetIds, setVaultNameCollisionTargetIds] = useState<Set<string>>(new Set());
  const [vaultNameCollisionRepairTargetIds, setVaultNameCollisionRepairTargetIds] = useState<Set<string>>(new Set());
  const [vaultNameCollisionRepairBusy, setVaultNameCollisionRepairBusy] = useState(false);
  const vaultNameCollisionRepairBusyRef = useRef(false);
  const vaultNameCollisionRepairTargetIdsRef = useRef(vaultNameCollisionRepairTargetIds);
  vaultNameCollisionRepairTargetIdsRef.current = vaultNameCollisionRepairTargetIds;
  const [noteServerReservationSignature, setNoteServerReservationSignature] = useState<string | null>(null);
  const [folderServerReservationSignature, setFolderServerReservationSignature] = useState<string | null>(null);
  const notesRef = useRef<DecryptedVaultNote[]>(notes);
  const foldersRef = useRef<DecryptedVaultFolder[]>(folders);
  const folderPathsRef = useRef<Map<string, string>>(new Map());
  const [knowledgeClient, setKnowledgeClient] = useState<KnowledgeWorkerClient | null>(null);
  const [knowledgeClientGeneration, setKnowledgeClientGeneration] = useState(0);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  const [knowledgeSyncRetry, setKnowledgeSyncRetry] = useState(0);
  const [metadataSummaries, setMetadataSummaries] = useState<KnowledgeMetadataSummary[]>([]);
  const [indexedTags, setIndexedTags] = useState<TagIndexEntry[]>([]);
  const [workerBacklinks, setWorkerBacklinks] = useState<ResolvedLinkOccurrence[]>([]);
  const [workerOutgoing, setWorkerOutgoing] = useState<ResolvedLinkOccurrence[]>([]);
  const [workerUnlinkedMentions, setWorkerUnlinkedMentions] = useState<UnlinkedMentionOccurrence[]>([]);
  const [workerSearchEntryIds, setWorkerSearchEntryIds] = useState<string[] | null>(null);
  const [workerGlobalSnapshot, setWorkerGlobalSnapshot] = useState<IndexGraphSnapshot | null>(null);
  const [workerLocalSnapshot, setWorkerLocalSnapshot] = useState<IndexGraphSnapshot | null>(null);
  const [leftMode, setLeftMode] = useState<LeftPanelMode>("files");
  const [rightMode, setRightMode] = useState<RightPanelMode>("backlinks");
  // Start closed until the encrypted workspace record has been restored. This
  // prevents a saved closed layout from flashing both sidebars on first paint.
  // First-time vaults still receive the open-panel defaults from
  // createDefaultVaultWorkspaceState() in applyRestoredWorkspace().
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const leftOpenRef = useRef(leftOpen);
  leftOpenRef.current = leftOpen;
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_VAULT_RIGHT_PANEL_WIDTH);
  const vaultViewportWidth = (
    typeof window === "undefined" ? 1_440 : window.innerWidth
  );
  const [vaultWorkspaceWidth, setVaultWorkspaceWidth] = useState(vaultViewportWidth);
  const [searchQuery, setSearchQuery] = useState("");
  const [entryBookmarks, setEntryBookmarks] = useState<PersistedEntryBookmark[]>([]);
  const [searchBookmarks, setSearchBookmarks] = useState<PersistedSearchBookmark[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [storedTabs, setTabs] = useState<WorkspaceTab[]>([]);
  const tabs = useMemo(() => workspaceTabsForVaultNotes(storedTabs, notes), [notes, storedTabs]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabGroups, setTabGroups] = useState<WorkspaceTabGroupState[]>(createDefaultWorkspaceTabGroups);
  const [activeTabGroupId, setActiveTabGroupId] = useState<WorkspaceTabGroupId>("primary");
  const [workspaceLayout, setWorkspaceLayout] = useState<VaultWorkspacePaneNode>(createDefaultWorkspaceLayout);
  const workspaceGroupOrder = useMemo(() => workspaceLayoutGroupIds(workspaceLayout), [workspaceLayout]);
  const resizeWorkspacePane = useCallback((splitId: string, ratio: number) => {
    setWorkspaceLayout((current) => resizeWorkspaceSplit(current, splitId, ratio));
  }, []);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const draftsRef = useRef(drafts);
  const markdownDraftRevisionRef = useRef(0);
  const [viewMode, setViewMode] = useState<MarkdownViewMode>("live-preview");
  const [pagePreview, setPagePreview] = useState<ActiveVaultPagePreview | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(true);
  const [calendarCursorMonth, setCalendarCursorMonth] = useState(() => localMonthKey(new Date()));
  const [dailyNotesFolderId, setDailyNotesFolderId] = useState<string | null>(null);
  const [dailyNotesTemplateEntryId, setDailyNotesTemplateEntryId] = useState<string | null>(null);
  const [templatesFolderPath, setTemplatesFolderPath] = useState<string | null>(null);
  const [templatesIncludeDescendants, setTemplatesIncludeDescendants] = useState(true);
  const [compactCalendarOpen, setCompactCalendarOpen] = useState(false);
  const [templateDialogMode, setTemplateDialogMode] = useState<"insert" | "create" | null>(null);
  const [activeCoreTool, setActiveCoreTool] = useState<VaultCoreToolId | null>(null);
  const [editorSelection, setEditorSelection] = useState<{ end: number; start: number } | null>(null);
  const [globalGraphSettings, setGlobalGraphSettings] = useState<UiGraphViewSettings>(() => createDefaultGlobalGraphSettings());
  const [localGraphSettings, setLocalGraphSettings] = useState<UiGraphViewSettings>(() => createDefaultLocalGraphSettings());
  const globalGraphDataSettings = useGraphDataSettings(globalGraphSettings);
  const localGraphDataSettings = useGraphDataSettings(localGraphSettings);
  const deferredDrafts = useDeferredValue(drafts);
  const deferredGlobalGraphDataSettings = useDeferredValue(globalGraphDataSettings);
  const deferredLocalGraphDataSettings = useDeferredValue(localGraphDataSettings);
  const [globalViewport, setGlobalViewport] = useState<GraphViewport>({ centerX: 0, centerY: 0, zoom: 1 });
  const [localViewport, setLocalViewport] = useState<GraphViewport>({ centerX: 0, centerY: 0, zoom: 1 });
  const [globalCollapsedSections, setGlobalCollapsedSections] = useState<GraphSettingsSectionId[]>([]);
  const [localCollapsedSections, setLocalCollapsedSections] = useState<GraphSettingsSectionId[]>([]);
  const [graphBookmarks, setGraphBookmarks] = useState<PersistedGraphBookmark[]>([]);
  const [namedWorkspaces, setNamedWorkspaces] = useState<PersistedNamedWorkspace[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceConflict, setWorkspaceConflict] = useState<VaultWorkspaceConflictState | null>(null);
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [lastSavedWorkspaceSerialization, setLastSavedWorkspaceSerialization] = useState("");
  const [workspaceSavePending, setWorkspaceSavePending] = useState(false);
  const [workspaceSaveRetry, setWorkspaceSaveRetry] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [editorInsertRequest, setEditorInsertRequest] = useState<{
    cursorOffset?: number;
    entryId: string;
    id: number;
    text: string;
  } | null>(null);
  const [editorRevealRequest, setEditorRevealRequest] = useState<{ entryId: string; id: number; line: number } | null>(null);
  const [status, setStatus] = useState("암호화 Vault 준비 중");
  const [error, setError] = useState<string | null>(null);
  const [pathRewriteBusy, setPathRewriteBusy] = useState(false);
  const [pathRewriteRecoveryRetry, setPathRewriteRecoveryRetry] = useState(0);
  const [pathRewriteJob, setPathRewriteJob] = useState<VaultPathRewriteJobSummary | null>(null);
  const [pendingEntryCreation, setPendingEntryCreation] = useState<PendingVaultEntryCreation | null>(null);
  const [savingEntryIds, setSavingEntryIds] = useState<Set<string>>(new Set());
  const [deletingEntryIds, setDeletingEntryIds] = useState<Set<string>>(new Set());
  const [optimisticEntryPatches, setOptimisticEntryPatches] = useState<
    Map<string, OptimisticVaultEntryPatch>
  >(new Map());
  const [trashOpen, setTrashOpen] = useState(false);
  const [discordMessageBatch, setDiscordMessageBatch] = useState<Extract<
    DiscordAiMarkdownDelivery,
    { kind: "message-batch" }
  > | null>(null);
  const [trashNotesLoading, setTrashNotesLoading] = useState(false);
  const [trashFoldersLoading, setTrashFoldersLoading] = useState(false);
  const [trashNotesServerReady, setTrashNotesServerReady] = useState(false);
  const [trashFoldersServerReady, setTrashFoldersServerReady] = useState(false);
  const [trashNotes, setTrashNotes] = useState<DecryptedVaultNote[]>([]);
  const [trashFolders, setTrashFolders] = useState<VaultTrashFolderItem[]>([]);
  const [trashBusyEntryIds, setTrashBusyEntryIds] = useState<Set<string>>(new Set());
  const [trashBusyFolderIds, setTrashBusyFolderIds] = useState<Set<string>>(new Set());
  const savingEntryIdsRef = useRef<Set<string>>(new Set());
  const deletingEntryIdsRef = useRef<Set<string>>(new Set());
  const folderTrashLockedFolderIdsRef = useRef<Set<string>>(new Set());
  const [saveFailedEntryIds, setSaveFailedEntryIds] = useState<Set<string>>(new Set());
  const [conflictedEntryIds, setConflictedEntryIds] = useState<Map<string, number>>(new Map());
  const [draftMergeConflict, setDraftMergeConflict] = useState<MarkdownDraftMergeConflictState | null>(null);
  const [draftMergeOpen, setDraftMergeOpen] = useState(false);
  const [draftMergeBusyEntryId, setDraftMergeBusyEntryId] = useState<string | null>(null);
  const [folderMigrationBusy, setFolderMigrationBusy] = useState(false);
  const [vaultImportBusy, setVaultImportBusy] = useState(false);
  const [recoverableImportJobs, setRecoverableImportJobs] = useState<VaultImportJobSummary[]>([]);
  const [importRecoveryBusyJobId, setImportRecoveryBusyJobId] = useState<string | null>(null);
  const [importRecoveryOpen, setImportRecoveryOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<VaultContextMenuState | null>(null);
  const [moveTarget, setMoveTarget] = useState<VaultMoveTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<VaultShareDialogState | null>(null);
  const [participantShareTarget, setParticipantShareTarget] = useState<VaultShareDialogState | null>(null);
  const decryptGeneration = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const pendingEntryCreationRef = useRef<PendingVaultEntryCreation | null>(null);
  const vaultPageMountedRef = useRef(true);
  const pagePreviewIntentRef = useRef<VaultPagePreviewIntent | null>(null);
  const pagePreviewVisibleAnchorRef = useRef<HTMLElement | null>(null);
  const pagePreviewOpenTimerRef = useRef<number | null>(null);
  const pagePreviewCloseTimerRef = useRef<number | null>(null);
  const vaultImportRecoveryGenerationRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const templateApplyBusyRef = useRef(false);
  const trashButtonRef = useRef<HTMLButtonElement>(null);
  const markdownCopySelectRef = useRef<HTMLSelectElement>(null);
  const trashDecryptGenerationRef = useRef(0);
  const trashFolderDecryptGenerationRef = useRef(0);
  const allVisibleNoteSnapshotsRef = useRef<NoteSnapshot[]>([]);
  const activeFolderSnapshotsRef = useRef<NoteFolderSnapshot[]>([]);
  const allFolderSnapshotsRef = useRef<NoteFolderSnapshot[]>([]);
  const pendingCreatedEntryIdsRef = useRef<Set<string>>(new Set());
  const pendingClipboardAssetTitleKeysRef = useRef<Map<
    string,
    { folderId: string | null; sourceNoteId: string; title: string }
  >>(new Map());
  const pendingClipboardAssetTitleKeyByIdRef = useRef<Map<string, string>>(new Map());
  const pendingClipboardAssetIdsRef = useRef<Set<string>>(new Set());
  const pendingClipboardPasteCountsRef = useRef<Map<string, number>>(new Map());
  const blockedPastedImageRollbackReleasesRef = useRef<Map<
    string,
    Map<string, () => void>
  >>(new Map());
  const pastedImageFolderRuntimeRef = useRef<VaultPastedImageFolderRuntime | null>(null);
  const pastedImageFolderRuntimePromiseRef = useRef<Promise<
    VaultPastedImageFolderRuntime
  > | null>(null);
  const pastedImageFolderRuntimeGenerationRef = useRef(0);
  const resetPastedImageFolderRuntime = useCallback(() => {
    pastedImageFolderRuntimeGenerationRef.current += 1;
    pastedImageFolderRuntimePromiseRef.current = null;
    const runtime = pastedImageFolderRuntimeRef.current;
    pastedImageFolderRuntimeRef.current = null;
    runtime?.reset();
  }, []);
  async function loadPastedImageFolderRuntime() {
    const loaded = pastedImageFolderRuntimeRef.current;
    if (loaded) return loaded;
    const inFlight = pastedImageFolderRuntimePromiseRef.current;
    if (inFlight) return inFlight;

    const generation = pastedImageFolderRuntimeGenerationRef.current;
    const request = import("../features/vault/vaultPastedImageFolder").then((module) => {
      const runtime = module.createVaultPastedImageFolderRuntime();
      if (pastedImageFolderRuntimeGenerationRef.current !== generation) {
        runtime.reset();
        throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
      }
      pastedImageFolderRuntimeRef.current = runtime;
      return runtime;
    });
    const clearRequest = () => {
      if (pastedImageFolderRuntimePromiseRef.current === request) {
        pastedImageFolderRuntimePromiseRef.current = null;
      }
    };
    pastedImageFolderRuntimePromiseRef.current = request;
    void request.then(clearRequest, clearRequest);
    return request;
  }
  useEffect(() => {
    for (const note of notes) {
      const pendingTitleKey = pendingClipboardAssetTitleKeyByIdRef.current.get(note.id);
      if (!pendingTitleKey) continue;
      const reservation = pendingClipboardAssetTitleKeysRef.current.get(pendingTitleKey);
      if (
        !reservation
        || note.ownerUid !== profile.uid
        || note.isDeleted
        || note.entryKind !== "asset"
        || (note.folderId ?? null) !== reservation.folderId
        || note.title !== reservation.title
      ) continue;
      pendingClipboardAssetTitleKeyByIdRef.current.delete(note.id);
      pendingClipboardAssetTitleKeysRef.current.delete(pendingTitleKey);
      pendingClipboardAssetIdsRef.current.delete(note.id);
      pendingCreatedEntryIdsRef.current.delete(note.id);
    }
  }, [notes, profile.uid]);
  const previousOwnerIdKeyRef = useRef(ownerIdKey);
  const noteSubscriptionGenerationRef = useRef(0);
  const noteAccessScopeRef = useRef<string[]>([]);
  const noteSubscriptionServerReadyRef = useRef(false);
  const folderSubscriptionServerReadyRef = useRef(false);
  const noteServerReservationSignatureRef = useRef<string | null>(null);
  const folderServerReservationSignatureRef = useRef<string | null>(null);
  const pendingFolderRestoreRef = useRef<{ folderId: string; revision: number } | null>(null);
  const compactCalendarDialogRef = useRef<HTMLElement>(null);
  const compactCalendarToggleRef = useRef<HTMLButtonElement>(null);
  const compactCalendarReturnFocusRef = useRef<HTMLElement | null>(null);
  const vaultWorkspaceRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLElement>(null);
  const rightPanelRef = useRef<HTMLElement>(null);
  const rightPanelResizeRef = useRef<{
    frameId: number | null;
    pendingWidth: number;
    pointerId: number;
    startClientX: number;
    startWidth: number;
  } | null>(null);
  const leftPanelToggleRef = useRef<HTMLButtonElement>(null);
  const rightPanelToggleRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const pendingMobileDrawerFocusRef = useRef<HTMLElement | null>(null);
  const handledRequestedEntryRef = useRef<string | null>(null);
  const handledWorkspaceRouteIntentRef = useRef<string | null>(null);
  const initialEntryAutoOpenPendingRef = useRef(false);
  const workspaceRevisionRef = useRef<number | undefined>(undefined);
  const lastSavedWorkspaceRef = useRef("");
  const latestWorkspaceStateRef = useRef<VaultPersistedWorkspaceState>(createDefaultVaultWorkspaceState());
  const globalViewportRef = useRef(globalViewport);
  const localViewportRef = useRef(localViewport);
  const workspaceInteractionDuringLoadRef = useRef(false);
  const pendingWorkspaceStateRef = useRef<VaultPersistedWorkspaceState | null>(null);
  const renameEntryRef = useRef<(
    entryId: string,
    requestedTitle?: string
  ) => Promise<VaultEntryRenameResult>>(async () => "blocked");
  const moveEntryRef = useRef<(entryId: string, folderId: string | null) => Promise<void>>(async () => undefined);
  const trashEntryRef = useRef<(entryId: string, confirmed?: boolean) => Promise<void>>(async () => undefined);
  const saveEntryRef = useRef<(
    entryId: string,
    pastedImageSourceCommit?: VaultPastedImageSourceCommitCredential
  ) => Promise<void>>(async () => undefined);
  const entryAutosaveRef = useRef<EntryIdleDebounce | null>(null);
  entryAutosaveRef.current ??= new EntryIdleDebounce();
  const entryAutosaveRetryCountsRef = useRef<Map<string, number>>(new Map());
  const ambiguousEntrySaveAttemptsRef = useRef<Map<string, RevisionedEditableDraft[]>>(new Map());
  const entryMutationPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const draftBaseSnapshotsRef = useRef<Map<string, MarkdownDraftBaseSnapshot>>(new Map());
  const draftMergeRequestGenerationRef = useRef(0);
  const draftMergeReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const pathRewriteBusyRef = useRef(false);
  const pathRewriteCleanupOwnerRef = useRef<string | null>(null);
  const pathRewriteCleanupSessionRef = useRef<{ privateKey: CryptoKey; uid: string } | null>(null);
  const pathRewriteRecoveryBusyOwnerRef = useRef<number | null>(null);
  const pathRewriteRecoveryGenerationRef = useRef(0);
  const pathRewriteRecoveryFailureCountRef = useRef(0);
  const optimisticEntryOperationIdRef = useRef(0);
  const durableSourceNotesRef = useRef<Map<string, DecryptedVaultNote>>(new Map());
  const vaultNameMigrationGenerationRef = useRef(0);
  const vaultNameMigrationPromiseRef = useRef<Promise<void> | null>(null);
  const vaultIntegritySealAbortRef = useRef<AbortController | null>(null);
  const vaultIntegrityBusyRetryTimerRef = useRef<number | null>(null);
  const workspaceSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSaveGenerationRef = useRef(0);
  const workspaceSaveDebounceTimerRef = useRef<number | null>(null);
  const workspaceSaveRetryTimerRef = useRef<number | null>(null);
  const globalViewportCommitTimerRef = useRef<number | null>(null);
  const localViewportCommitTimerRef = useRef<number | null>(null);
  const privateKeyAutoLockGuardRef = useRef<() => boolean>(() => false);
  const workspaceConflictPendingRef = useRef(false);
  const workspaceConflictRequestGenerationRef = useRef(0);
  const workspaceAccessScopeGenerationRef = useRef(0);
  const knowledgeEntriesRef = useRef<Map<string, VaultIndexEntry>>(new Map());
  const knowledgeAccessScopeRef = useRef<string[]>([]);
  const knowledgeSyncChainRef = useRef<Promise<void>>(Promise.resolve());
  const knowledgeSyncGenerationRef = useRef(0);
  const knowledgeSyncFailureCountRef = useRef(0);
  const knowledgeForceFullSyncRef = useRef(false);
  const knowledgeSyncRetryTimerRef = useRef<number | null>(null);
  const decodedAssetCacheRef = useRef(new BoundedVaultAssetDecodeCache());
  const desktopLeftOpenRef = useRef(false);
  const desktopRightOpenRef = useRef(false);
  const previousMobileLayoutRef = useRef(mobileVaultLayoutSnapshot());
  const editorRequestIdRef = useRef(0);
  const dismissVaultPagePreview = useCallback((clearIntent = true) => {
    clearVaultPagePreviewTimer(pagePreviewOpenTimerRef);
    clearVaultPagePreviewTimer(pagePreviewCloseTimerRef);
    if (clearIntent) pagePreviewIntentRef.current = null;
    pagePreviewVisibleAnchorRef.current = null;
    setPagePreview(null);
  }, []);
  const mobileLayout = useMobileVaultLayout();
  const compactCalendarLayout = useCompactCalendarLayout();
  const isOnline = useOnlineStatus();
  const rightPanelMaxWidth = maxVaultRightPanelWidthForViewport(
    vaultViewportWidth,
    leftOpen,
    vaultWorkspaceWidth
  );
  const effectiveRightPanelWidth = clampVaultRightPanelWidthForViewport(
    rightPanelWidth,
    vaultViewportWidth,
    leftOpen,
    vaultWorkspaceWidth
  );
  useLayoutEffect(() => {
    const workspace = vaultWorkspaceRef.current;
    if (!workspace) return;
    const updateViewportWidth = () => setVaultWorkspaceWidth(workspace.clientWidth || window.innerWidth);
    updateViewportWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportWidth);
      return () => window.removeEventListener("resize", updateViewportWidth);
    }
    const resizeObserver = new ResizeObserver(updateViewportWidth);
    resizeObserver.observe(workspace);
    return () => resizeObserver.disconnect();
  }, []);
  useEffect(() => {
    vaultPageMountedRef.current = true;
    return () => {
      vaultPageMountedRef.current = false;
      pendingEntryCreationRef.current = null;
    };
  }, []);
  const trashLoading = trashNotesLoading || trashFoldersLoading;
  const trashServerReady = trashNotesServerReady && trashFoldersServerReady;
  const currentServerReservationSignature = noteServerReservationSignature !== null
    && folderServerReservationSignature !== null
    ? `${noteServerReservationSignature}\n${folderServerReservationSignature}`
    : null;
  const vaultServerSubscriptionsReady = currentServerReservationSignature !== null;
  useEffect(() => {
    noteServerReservationSignatureRef.current = noteServerReservationSignature;
  }, [noteServerReservationSignature]);
  useEffect(() => {
    folderServerReservationSignatureRef.current = folderServerReservationSignature;
  }, [folderServerReservationSignature]);
  const vaultNameWritesReady = isOnline
    && vaultNameMigrationStatus === "ready"
    && vaultIntegrityKey !== null
    && vaultServerSubscriptionsReady;
  const previousOnlineRef = useRef(isOnline);
  privateKeyAutoLockGuardRef.current = () => Boolean(
    templateApplyBusyRef.current
    || pathRewriteBusyRef.current
    || vaultImportBusy
    || entryMutationPromisesRef.current.size > 0
    || pendingClipboardPasteCountsRef.current.size > 0
    || Object.values(draftsRef.current).some((draft) => draft.dirty)
    || globalViewportCommitTimerRef.current !== null
    || localViewportCommitTimerRef.current !== null
    || workspaceSaveDebounceTimerRef.current !== null
    || workspaceSaveRetryTimerRef.current !== null
    || workspaceConflictPendingRef.current
    || workspaceSavePending
    || (workspaceReady
      && JSON.stringify(latestWorkspaceStateRef.current) !== lastSavedWorkspaceRef.current)
  );
  useEffect(() => registerPrivateKeyAutoLockGuard(
    () => privateKeyAutoLockGuardRef.current()
  ), []);
  const cancelScheduledWorkspaceSave = useCallback(() => {
    if (workspaceSaveDebounceTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveDebounceTimerRef.current);
      workspaceSaveDebounceTimerRef.current = null;
    }
  }, []);
  const commitPendingGraphViewports = useCallback(() => {
    if (globalViewportCommitTimerRef.current !== null) {
      window.clearTimeout(globalViewportCommitTimerRef.current);
      globalViewportCommitTimerRef.current = null;
    }
    if (localViewportCommitTimerRef.current !== null) {
      window.clearTimeout(localViewportCommitTimerRef.current);
      localViewportCommitTimerRef.current = null;
    }
    setGlobalViewport((current) => sameGraphViewport(current, globalViewportRef.current)
      ? current
      : { ...globalViewportRef.current });
    setLocalViewport((current) => sameGraphViewport(current, localViewportRef.current)
      ? current
      : { ...localViewportRef.current });
  }, []);
  const applyGlobalGraphViewport = useCallback((viewport: GraphViewport) => {
    const latestViewport = { ...viewport };
    const pendingCommit = globalViewportCommitTimerRef.current !== null;
    if (!pendingCommit && sameGraphViewport(globalViewportRef.current, latestViewport)) return;
    cancelScheduledWorkspaceSave();
    if (globalViewportCommitTimerRef.current !== null) {
      window.clearTimeout(globalViewportCommitTimerRef.current);
      globalViewportCommitTimerRef.current = null;
    }
    globalViewportRef.current = latestViewport;
    latestWorkspaceStateRef.current = vaultWorkspaceWithGraphViewport(
      latestWorkspaceStateRef.current,
      "global",
      latestViewport
    );
    setGlobalViewport(latestViewport);
  }, [cancelScheduledWorkspaceSave]);
  const applyLocalGraphViewport = useCallback((viewport: GraphViewport) => {
    const latestViewport = { ...viewport };
    const pendingCommit = localViewportCommitTimerRef.current !== null;
    if (!pendingCommit && sameGraphViewport(localViewportRef.current, latestViewport)) return;
    cancelScheduledWorkspaceSave();
    if (localViewportCommitTimerRef.current !== null) {
      window.clearTimeout(localViewportCommitTimerRef.current);
      localViewportCommitTimerRef.current = null;
    }
    localViewportRef.current = latestViewport;
    latestWorkspaceStateRef.current = vaultWorkspaceWithGraphViewport(
      latestWorkspaceStateRef.current,
      "local",
      latestViewport
    );
    setLocalViewport(latestViewport);
  }, [cancelScheduledWorkspaceSave]);
  const queueGlobalGraphViewport = useCallback((viewport: GraphViewport) => {
    const latestViewport = { ...viewport };
    const pendingCommit = globalViewportCommitTimerRef.current !== null;
    if (!pendingCommit && sameGraphViewport(globalViewportRef.current, latestViewport)) return;
    if (!sameGraphViewport(globalViewportRef.current, latestViewport)) {
      globalViewportRef.current = latestViewport;
      latestWorkspaceStateRef.current = vaultWorkspaceWithGraphViewport(
        latestWorkspaceStateRef.current,
        "global",
        latestViewport
      );
    }
    cancelScheduledWorkspaceSave();
    if (globalViewportCommitTimerRef.current !== null) {
      window.clearTimeout(globalViewportCommitTimerRef.current);
    }
    globalViewportCommitTimerRef.current = window.setTimeout(() => {
      globalViewportCommitTimerRef.current = null;
      setGlobalViewport({ ...globalViewportRef.current });
    }, GRAPH_VIEWPORT_COMMIT_DELAY_MS);
  }, [cancelScheduledWorkspaceSave]);
  const queueLocalGraphViewport = useCallback((viewport: GraphViewport) => {
    const latestViewport = { ...viewport };
    const pendingCommit = localViewportCommitTimerRef.current !== null;
    if (!pendingCommit && sameGraphViewport(localViewportRef.current, latestViewport)) return;
    if (!sameGraphViewport(localViewportRef.current, latestViewport)) {
      localViewportRef.current = latestViewport;
      latestWorkspaceStateRef.current = vaultWorkspaceWithGraphViewport(
        latestWorkspaceStateRef.current,
        "local",
        latestViewport
      );
    }
    cancelScheduledWorkspaceSave();
    if (localViewportCommitTimerRef.current !== null) {
      window.clearTimeout(localViewportCommitTimerRef.current);
    }
    localViewportCommitTimerRef.current = window.setTimeout(() => {
      localViewportCommitTimerRef.current = null;
      setLocalViewport({ ...localViewportRef.current });
    }, GRAPH_VIEWPORT_COMMIT_DELAY_MS);
  }, [cancelScheduledWorkspaceSave]);
  const activeMobileDrawer = mobileLayout
    ? leftOpen ? "left" : rightOpen ? "right" : null
    : null;
  const vaultBookmarks = useMemo<PersistedVaultBookmark[]>(() => {
    const visibleEntryIds = new Set(notes.map((note) => note.id));
    return [
    ...entryBookmarks
      .filter((bookmark) => visibleEntryIds.has(bookmark.entryId))
      .map((bookmark): PersistedVaultBookmark => ({ ...bookmark, kind: "entry" })),
    ...graphBookmarks.map((bookmark): PersistedVaultBookmark => ({ ...bookmark, kind: "graph" })),
    ...searchBookmarks.map((bookmark): PersistedVaultBookmark => ({ ...bookmark, kind: "search" }))
  ].sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_VAULT_BOOKMARKS);
  }, [
    entryBookmarks,
    graphBookmarks,
    notes,
    searchBookmarks
  ]);

  latestWorkspaceStateRef.current = workspaceStateForSave({
    activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
    activeTabGroupId,
    workspaceLayout,
    calendarCursorMonth,
    calendarOpen,
    dailyNotesFolderId,
    dailyNotesTemplateEntryId,
    templatesFolderPath,
    templatesIncludeDescendants,
    expandedFolderIds,
    globalCollapsedSections,
    globalGraphSettings,
    globalViewport: globalViewportRef.current,
    bookmarks: vaultBookmarks,
    graphBookmarks,
    leftMode,
    leftOpen: mobileLayout ? desktopLeftOpenRef.current : leftOpen,
    localCollapsedSections,
    localGraphSettings,
    localViewport: localViewportRef.current,
    namedWorkspaces,
    rightMode,
    rightOpen: mobileLayout ? desktopRightOpenRef.current : rightOpen,
    rightPanelWidth,
    searchQuery,
    searchBookmarks,
    selectedFolderId,
    tabs,
    tabGroups,
    viewMode
  });
  const latestWorkspaceSerialization = JSON.stringify(latestWorkspaceStateRef.current);

  const commitNotes = useCallback((updater: (current: DecryptedVaultNote[]) => DecryptedVaultNote[]) => {
    const next = updater(notesRef.current);
    notesRef.current = next;
    setDecryptedNotes(next);
    return next;
  }, []);

  const commitFolders = useCallback((updater: (current: DecryptedVaultFolder[]) => DecryptedVaultFolder[]) => {
    const next = updater(foldersRef.current);
    foldersRef.current = next;
    folderPathsRef.current = buildVaultPaths(next);
    setFolders(next);
    return next;
  }, []);

  const stageOptimisticEntryPatch = useCallback((
    entryId: string,
    patch: Omit<OptimisticVaultEntryPatch, "operationId">
  ) => {
    const operationId = optimisticEntryOperationIdRef.current + 1;
    optimisticEntryOperationIdRef.current = operationId;
    setOptimisticEntryPatches((current) => new Map(current).set(entryId, {
      ...patch,
      operationId
    }));
    return operationId;
  }, []);

  const finishOptimisticEntryPatch = useCallback((entryId: string, operationId: number) => {
    setOptimisticEntryPatches((current) => {
      const next = clearOptimisticVaultEntryPatch(current, entryId, operationId);
      return next === current ? current : new Map(next);
    });
  }, []);

  const captureMarkdownDraftBase = useCallback((
    entryId: string,
    note: DecryptedVaultNote | undefined,
    draft: DraftState | undefined,
    replace = false
  ) => {
    if (!note || !draft || !isMarkdownMergeEntry(note)) return null;
    const existing = draftBaseSnapshotsRef.current.get(entryId);
    if (!replace && existing && existing.baseRevision === draft.baseRevision) return existing;
    const snapshot: MarkdownDraftBaseSnapshot = {
      baseRevision: draft.baseRevision,
      body: draft.body,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      folderId: draft.folderId,
      ownerUid: note.ownerUid,
      title: draft.title
    };
    draftBaseSnapshotsRef.current.set(entryId, snapshot);
    return snapshot;
  }, []);

  const readCurrentServerVaultEntry = useCallback(async (entryId: string) => {
    if (!isOnline) throw new Error("offline");
    const deadline = createVaultApiDeadline(undefined, 8_000);
    try {
      return await deadline.race((async () => {
        const result = await getVisibleNotesByIdsFromServer(profile.uid, [entryId]);
        if (!result.resolvedNoteIds.includes(entryId) || result.notes.length !== 1) {
          throw new Error("server-entry-unavailable");
        }
        const decrypted = await decryptVaultNotes(result.notes, profile.uid, privateKey);
        const remote = decrypted.length === 1 ? decrypted[0] : null;
        if (
          !remote
          || remote.id !== entryId
          || !remote.participantUids.includes(profile.uid)
          || !remote.wrappedKeys[profile.uid]
        ) {
          throw new Error("server-entry-unauthorized");
        }
        return remote;
      })());
    } finally {
      deadline.dispose();
    }
  }, [isOnline, privateKey, profile.uid]);

  const prepareDraftMergeConflict = useCallback(async (entryId: string, openResolver: boolean) => {
    const base = draftBaseSnapshotsRef.current.get(entryId);
    const local = draftsRef.current[entryId];
    const note = notesRef.current.find((candidate) => candidate.id === entryId);
    if (
      !base
      || !local?.dirty
      || local.baseRevision !== base.baseRevision
      || !note
      || !isMarkdownMergeEntry(note)
      || note.ownerUid !== base.ownerUid
    ) {
      setDraftMergeConflict(null);
      setDraftMergeOpen(false);
      setStatus("자동 병합에 필요한 기준본을 확인하지 못했습니다. 현재 편집본 복사 또는 서버 되돌리기를 사용해주세요.");
      return false;
    }

    const generation = draftMergeRequestGenerationRef.current + 1;
    draftMergeRequestGenerationRef.current = generation;
    setDraftMergeBusyEntryId(entryId);
    try {
      const remote = await readCurrentServerVaultEntry(entryId);
      if (
        draftMergeRequestGenerationRef.current !== generation
        || draftBaseSnapshotsRef.current.get(entryId) !== base
      ) {
        return false;
      }
      const latestLocal = draftsRef.current[entryId];
      if (
        !latestLocal?.dirty
        || latestLocal.baseRevision !== base.baseRevision
        || !isMarkdownMergeEntry(remote)
        || remote.ownerUid !== base.ownerUid
      ) {
        setDraftMergeConflict(null);
        setDraftMergeOpen(false);
        setStatus("서버 최신본과 현재 편집본의 안전 범위를 확인하지 못해 병합하지 않았습니다.");
        return false;
      }
      setConflictedEntryIds((current) => new Map(current).set(entryId, remote.revision ?? 0));
      setDraftMergeConflict({
        base,
        entryId,
        local: captureRevisionedDraft(latestLocal),
        remote
      });
      setDraftMergeOpen(openResolver);
      setError(null);
      setStatus(openResolver
        ? "서버 최신본을 직접 확인했습니다. 충돌별 보존 방법을 선택해주세요."
        : "서버 최신본을 직접 확인했습니다. 안전 병합을 열 수 있습니다.");
      return true;
    } catch {
      if (draftMergeRequestGenerationRef.current === generation) {
        setDraftMergeConflict(null);
        setDraftMergeOpen(false);
        setStatus("서버 최신본을 안전하게 확인하지 못했습니다. 현재 편집본은 그대로 유지됩니다.");
      }
      return false;
    } finally {
      if (draftMergeRequestGenerationRef.current === generation) {
        setDraftMergeBusyEntryId(null);
      }
    }
  }, [readCurrentServerVaultEntry]);

  const clearVaultPlaintextForAccessScope = useCallback(() => {
    // Authorization changes are a synchronous plaintext boundary. WebCrypto,
    // Firestore callbacks, and worker messages cannot be cancelled reliably,
    // so invalidate every continuation before clearing all note-derived state.
    decryptGeneration.current += 1;
    workspaceAccessScopeGenerationRef.current += 1;
    workspaceSaveGenerationRef.current += 1;
    workspaceConflictRequestGenerationRef.current += 1;
    draftMergeRequestGenerationRef.current += 1;
    knowledgeSyncGenerationRef.current += 1;
    vaultImportRecoveryGenerationRef.current += 1;
    pathRewriteRecoveryGenerationRef.current += 1;
    pathRewriteCleanupOwnerRef.current = null;
    pathRewriteCleanupSessionRef.current = null;
    pathRewriteRecoveryFailureCountRef.current = 0;
    const recoveryOwnedPathLock = pathRewriteRecoveryBusyOwnerRef.current !== null;
    pathRewriteRecoveryBusyOwnerRef.current = null;
    // Release only a recovery-owned lock. A concurrent rename or move owns the
    // same global lock independently and must finish its server reconciliation.
    if (recoveryOwnedPathLock) {
      pathRewriteBusyRef.current = false;
      setPathRewriteBusy(false);
    }
    setPathRewriteJob(null);
    setDecryptedVaultScopeKey(null);
    setVaultDataReady(false);
    allVisibleNoteSnapshotsRef.current = [];
    pendingCreatedEntryIdsRef.current.clear();
    pendingClipboardAssetTitleKeysRef.current.clear();
    pendingClipboardAssetTitleKeyByIdRef.current.clear();
    pendingClipboardAssetIdsRef.current.clear();
    pendingClipboardPasteCountsRef.current.clear();
    blockedPastedImageRollbackReleasesRef.current.clear();
    resetPastedImageFolderRuntime();
    noteAccessScopeRef.current = [];
    noteSubscriptionServerReadyRef.current = false;
    setRawNotes([]);
    setNoteSnapshotReceived(false);
    setNoteServerReservationSignature(null);
    entryAutosaveRef.current?.cancelAll();
    entryAutosaveRetryCountsRef.current.clear();
    ambiguousEntrySaveAttemptsRef.current.clear();
    folderTrashLockedFolderIdsRef.current.clear();
    notesRef.current = [];
    setDecryptedNotes([]);
    draftsRef.current = {};
    setDrafts({});
    draftBaseSnapshotsRef.current.clear();
    draftMergeReturnFocusRef.current = null;
    setDraftMergeConflict(null);
    setDraftMergeOpen(false);
    setDraftMergeBusyEntryId(null);
    setShareTarget(null);
    setParticipantShareTarget(null);
    durableSourceNotesRef.current.clear();
    setTabs([]);
    setActiveTabId(null);
    setTabGroups(createDefaultWorkspaceTabGroups());
    setActiveTabGroupId("primary");
    setWorkspaceLayout(createDefaultWorkspaceLayout());
    setEntryBookmarks([]);
    setNamedWorkspaces((current) => {
      const noVisibleEntries = new Set<string>();
      return current.map((workspace) => namedWorkspaceForEntryIds(workspace, noVisibleEntries));
    });
    setDailyNotesTemplateEntryId(null);
    setTemplatesFolderPath(null);
    setTemplatesIncludeDescendants(true);
    setCommandPaletteOpen(false);
    setQuickSwitcherOpen(false);
    setContextMenu(null);
    setMoveTarget(null);
    decodedAssetCacheRef.current.clear();
    knowledgeEntriesRef.current.clear();
    knowledgeAccessScopeRef.current = [];
    knowledgeSyncChainRef.current = Promise.resolve();
    knowledgeForceFullSyncRef.current = true;
    setMetadataSummaries([]);
    setIndexedTags([]);
    setKnowledgeVersion(0);
    setWorkerSearchEntryIds(null);
    setWorkerBacklinks([]);
    setWorkerOutgoing([]);
    setWorkerUnlinkedMentions([]);
    setWorkerGlobalSnapshot(null);
    setWorkerLocalSnapshot(null);
    setWorkspaceConflict(null);
    setRecoverableImportJobs([]);
    setImportRecoveryBusyJobId(null);
    setImportRecoveryOpen(false);
    pendingWorkspaceStateRef.current = null;
    initialEntryAutoOpenPendingRef.current = false;
    latestWorkspaceStateRef.current = vaultWorkspaceWithoutEntryReferences(latestWorkspaceStateRef.current);
    lastSavedWorkspaceRef.current = "";
    setLastSavedWorkspaceSerialization("");
    setWorkspaceSavePending(false);
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    if (knowledgeSyncRetryTimerRef.current !== null) {
      window.clearTimeout(knowledgeSyncRetryTimerRef.current);
      knowledgeSyncRetryTimerRef.current = null;
    }
    if (workspaceSaveRetryTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveRetryTimerRef.current);
      workspaceSaveRetryTimerRef.current = null;
    }
    if (globalViewportCommitTimerRef.current !== null) {
      window.clearTimeout(globalViewportCommitTimerRef.current);
      globalViewportCommitTimerRef.current = null;
    }
    if (localViewportCommitTimerRef.current !== null) {
      window.clearTimeout(localViewportCommitTimerRef.current);
      localViewportCommitTimerRef.current = null;
    }
    if (workspaceSaveDebounceTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveDebounceTimerRef.current);
      workspaceSaveDebounceTimerRef.current = null;
    }
    setKnowledgeClient((current) => {
      if (current) void current.dispose();
      return null;
    });
    setKnowledgeClientGeneration((current) => current + 1);
  }, [resetPastedImageFolderRuntime]);

  useLayoutEffect(() => {
    const previousOwnerIdKey = previousOwnerIdKeyRef.current;
    if (previousOwnerIdKey === ownerIdKey) return;
    previousOwnerIdKeyRef.current = ownerIdKey;
    // Invalidate an old subscription before the browser can paint the render
    // that observed the new owner allowlist.
    noteSubscriptionGenerationRef.current += 1;
    if (vaultOwnerScopeRequiresReset(previousOwnerIdKey, ownerIdKey)) {
      clearVaultPlaintextForAccessScope();
    }
  }, [clearVaultPlaintextForAccessScope, ownerIdKey]);

  const applyRestoredWorkspace = useCallback((
    restored: VaultPersistedWorkspaceState,
    revision?: number,
    allowInitialEntryAutoOpen = false
  ) => {
    workspaceConflictRequestGenerationRef.current += 1;
    initialEntryAutoOpenPendingRef.current = allowInitialEntryAutoOpen;
    const restoredTabs = restored.tabs.map((tab) => restoredTab(tab));
    const restoredGroups = restored.tabGroups.map((group) => ({
      id: group.id,
      tabIds: group.tabs.map((tab) => restoredTab(tab).id),
      activeTabId: group.activeTab ? restoredTab(group.activeTab).id : null
    }));
    const reconciledGroups = reconcileWorkspaceTabGroups(
      restoredGroups,
      restoredTabs.map((tab) => tab.id),
      restored.activeTabGroupId,
      restored.activeTab ? restoredTab(restored.activeTab).id : null,
      workspaceLayoutGroupIds(restored.layout)
    );
    setTabs(restoredTabs);
    setTabGroups(reconciledGroups.groups);
    setActiveTabGroupId(reconciledGroups.activeTabGroupId);
    setActiveTabId(reconciledGroups.activeTabId);
    setWorkspaceLayout(reconcileWorkspaceLayoutGroups(
      restored.layout,
      reconciledGroups.groups.map((group) => group.id)
    ));
    setLeftMode(restored.left.mode);
    desktopLeftOpenRef.current = restored.left.open;
    desktopRightOpenRef.current = restored.right.open;
    const restorePanels = !mobileVaultLayoutSnapshot();
    setLeftOpen(restorePanels && restored.left.open);
    setRightMode(restored.right.mode);
    setRightPanelWidth(restored.right.width);
    setRightOpen(restorePanels && restored.right.open);
    setSelectedFolderId(restored.selectedFolderId);
    setExpandedFolderIds(new Set(restored.expandedFolderIds));
    setSearchQuery(restored.searchQuery);
    setEntryBookmarks(restored.bookmarks
      .filter((bookmark): bookmark is PersistedVaultBookmark & { kind: "entry" } => bookmark.kind === "entry")
      .map((bookmark) => ({
        createdAt: bookmark.createdAt,
        entryId: bookmark.entryId,
        id: bookmark.id,
        label: bookmark.label,
        path: bookmark.path
      })));
    setSearchBookmarks(restored.searchBookmarks);
    setViewMode(restored.viewMode);
    setCalendarOpen(restored.plugins.calendar.open);
    setCalendarCursorMonth(restored.plugins.calendar.cursorMonth);
    setDailyNotesFolderId(restored.plugins.calendar.folderId ?? null);
    setDailyNotesTemplateEntryId(restored.plugins.calendar.templateEntryId ?? null);
    setTemplatesFolderPath(restored.plugins.templates.folderPath ?? null);
    setTemplatesIncludeDescendants(restored.plugins.templates.includeDescendants);
    setGlobalGraphSettings(restored.globalGraph.settings);
    setLocalGraphSettings(restored.localGraph.settings);
    applyGlobalGraphViewport(restored.globalGraph.viewport);
    applyLocalGraphViewport(restored.localGraph.viewport);
    setGlobalCollapsedSections(restored.globalGraph.collapsedSections);
    setLocalCollapsedSections(restored.localGraph.collapsedSections);
    setGraphBookmarks(restored.graphBookmarks);
    setNamedWorkspaces(restored.namedWorkspaces);
    latestWorkspaceStateRef.current = restored;
    workspaceRevisionRef.current = revision;
    pendingWorkspaceStateRef.current = null;
    const restoredSerialization = JSON.stringify(restored);
    lastSavedWorkspaceRef.current = restoredSerialization;
    setLastSavedWorkspaceSerialization(restoredSerialization);
    setWorkspaceSavePending(false);
    workspaceInteractionDuringLoadRef.current = false;
    workspaceConflictPendingRef.current = false;
    setWorkspaceConflict(null);
    setWorkspaceReady(true);
  }, [applyGlobalGraphViewport, applyLocalGraphViewport]);

  function keepCurrentWorkspaceAfterConflict() {
    if (!workspaceConflict) return;
    workspaceConflictRequestGenerationRef.current += 1;
    workspaceConflictPendingRef.current = false;
    workspaceRevisionRef.current = workspaceConflict.actualRevision;
    const remoteSerialization = workspaceConflict.remoteState
      ? JSON.stringify(workspaceConflict.remoteState)
      : `remote-revision:${workspaceConflict.actualRevision}`;
    lastSavedWorkspaceRef.current = remoteSerialization;
    setLastSavedWorkspaceSerialization(remoteSerialization);
    pendingWorkspaceStateRef.current = latestWorkspaceStateRef.current;
    setWorkspaceConflict(null);
    setWorkspaceReady(true);
    setWorkspaceSaveRetry((attempt) => attempt + 1);
  }

  async function reloadWorkspaceConflictRemote() {
    if (!workspaceConflict || !profile || !privateKey) return;
    try {
      const record = await loadVaultWorkspaceRecord<VaultWorkspaceState>(profile.uid, privateKey);
      setWorkspaceConflict((current) => current ? {
        ...current,
        actualRevision: record?.revision ?? current.actualRevision,
        remoteState: record
          ? vaultWorkspaceForEntryIds(
              normalizeVaultWorkspaceState(record.state),
              new Set(notesRef.current.map((note) => note.id))
            )
          : createDefaultVaultWorkspaceState()
      } : null);
      workspaceConflictPendingRef.current = false;
      setError(null);
    } catch {
      setError("서버 워크스페이스를 다시 불러오지 못했습니다. 현재 배치는 계속 메모리에 보존됩니다.");
    }
  }

  const beginEntryMutation = useCallback((entryId: string) => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    entryMutationPromisesRef.current.set(entryId, promise);
    return () => {
      if (entryMutationPromisesRef.current.get(entryId) === promise) {
        entryMutationPromisesRef.current.delete(entryId);
      }
      release();
    };
  }, []);

  useEffect(() => {
    if (!compactCalendarOpen) return undefined;
    const returnFocus = compactCalendarReturnFocusRef.current
      ?? (compactCalendarToggleRef.current?.isConnected ? compactCalendarToggleRef.current : leftPanelToggleRef.current);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCompactCalendarOpen(false);
        return;
      }
      if (event.key !== "Tab" || !compactCalendarDialogRef.current) return;
      const controls = [...compactCalendarDialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled)"
      )].filter((control) => !control.closest("details:not([open])"));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (returnFocus?.isConnected) {
        window.setTimeout(() => returnFocus.focus(), 0);
      }
      compactCalendarReturnFocusRef.current = null;
    };
  }, [compactCalendarOpen]);

  const openCompactCalendarDialog = useCallback((trigger?: HTMLElement | null) => {
    compactCalendarReturnFocusRef.current = mobileLayout
      ? leftPanelToggleRef.current
      : trigger ?? compactCalendarToggleRef.current;
    if (mobileLayout) {
      // A single modal surface owns focus and Escape at a time. Closing the
      // drawers directly avoids their focus-restoration timers racing the
      // calendar dialog's autofocus.
      mobileDrawerReturnFocusRef.current = null;
      pendingMobileDrawerFocusRef.current = null;
      setLeftOpen(false);
      setRightOpen(false);
    }
    setCompactCalendarOpen(true);
  }, [mobileLayout]);

  const closeContextMenu = useCallback((restoreFocus = true) => {
    const returnFocusElement = contextMenu?.returnFocusElement;
    setContextMenu(null);
    if (restoreFocus && returnFocusElement?.isConnected) {
      window.setTimeout(() => returnFocusElement.focus(), 0);
    }
  }, [contextMenu]);

  const rememberMobileDrawerTrigger = useCallback((fallback?: HTMLElement | null) => {
    if (mobileLayout) {
      const activeElement = document.activeElement;
      mobileDrawerReturnFocusRef.current = activeElement instanceof HTMLElement
        && activeElement !== document.body
        && activeElement !== document.documentElement
        ? activeElement
        : fallback ?? null;
    }
  }, [mobileLayout]);

  const restoreMobileDrawerFocus = useCallback((fallback?: HTMLButtonElement | null) => {
    const target = mobileDrawerReturnFocusRef.current?.isConnected
      ? mobileDrawerReturnFocusRef.current
      : fallback;
    mobileDrawerReturnFocusRef.current = null;
    pendingMobileDrawerFocusRef.current = target?.isConnected ? target : null;
  }, []);

  const clampRightPanelWidthForCurrentLayout = useCallback((requestedWidth: number) => (
    clampVaultRightPanelWidthForViewport(
      requestedWidth,
      vaultViewportWidth,
      leftOpen,
      vaultWorkspaceWidth
    )
  ), [leftOpen, vaultViewportWidth, vaultWorkspaceWidth]);

  const queueRightPanelResize = useCallback((requestedWidth: number) => {
    const resize = rightPanelResizeRef.current;
    if (!resize) return;
    resize.pendingWidth = clampRightPanelWidthForCurrentLayout(requestedWidth);
    if (resize.frameId !== null) return;
    resize.frameId = window.requestAnimationFrame(() => {
      const activeResize = rightPanelResizeRef.current;
      if (!activeResize) return;
      activeResize.frameId = null;
      vaultWorkspaceRef.current?.style.setProperty(
        "--vault-right-panel-width",
        `${activeResize.pendingWidth}px`
      );
    });
  }, [clampRightPanelWidthForCurrentLayout]);

  const beginRightPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (mobileLayout || event.button !== 0) return;
    event.preventDefault();
    const previous = rightPanelResizeRef.current;
    if (previous?.frameId !== null && previous?.frameId !== undefined) {
      window.cancelAnimationFrame(previous.frameId);
    }
    rightPanelResizeRef.current = {
      frameId: null,
      pendingWidth: effectiveRightPanelWidth,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: effectiveRightPanelWidth
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [effectiveRightPanelWidth, mobileLayout]);

  const moveRightPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = rightPanelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    queueRightPanelResize(resize.startWidth + resize.startClientX - event.clientX);
  }, [queueRightPanelResize]);

  const finishRightPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = rightPanelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    const width = event.type === "pointercancel" || event.type === "lostpointercapture"
      ? resize.pendingWidth
      : clampRightPanelWidthForCurrentLayout(
          resize.startWidth + resize.startClientX - event.clientX
        );
    if (resize.frameId !== null) window.cancelAnimationFrame(resize.frameId);
    rightPanelResizeRef.current = null;
    vaultWorkspaceRef.current?.style.setProperty("--vault-right-panel-width", `${width}px`);
    setRightPanelWidth(width);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [clampRightPanelWidthForCurrentLayout]);

  const handleRightPanelResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 10;
    let requestedWidth: number | null = null;
    if (event.key === "ArrowLeft") requestedWidth = effectiveRightPanelWidth + step;
    if (event.key === "ArrowRight") requestedWidth = effectiveRightPanelWidth - step;
    if (event.key === "Home") requestedWidth = MIN_VAULT_RIGHT_PANEL_WIDTH;
    if (event.key === "End") requestedWidth = rightPanelMaxWidth;
    if (requestedWidth === null) return;
    event.preventDefault();
    setRightPanelWidth(clampRightPanelWidthForCurrentLayout(requestedWidth));
  }, [clampRightPanelWidthForCurrentLayout, effectiveRightPanelWidth, rightPanelMaxWidth]);

  const closeLeftPanel = useCallback(() => {
    setLeftOpen(false);
    if (mobileLayout) restoreMobileDrawerFocus(leftPanelToggleRef.current);
  }, [mobileLayout, restoreMobileDrawerFocus]);

  const closeRightPanel = useCallback(() => {
    setRightOpen(false);
    if (mobileLayout) restoreMobileDrawerFocus(rightPanelToggleRef.current);
  }, [mobileLayout, restoreMobileDrawerFocus]);

  const showLeftPanel = useCallback((mode?: LeftPanelMode) => {
    if (mode) {
      setLeftMode(mode);
    }
    if (!leftOpenRef.current) rememberMobileDrawerTrigger(leftPanelToggleRef.current);
    setLeftOpen(true);
    if (mobileLayout) {
      setRightOpen(false);
    }
  }, [mobileLayout, rememberMobileDrawerTrigger]);

  const showRightPanel = useCallback((mode: RightPanelMode) => {
    setRightMode(mode);
    if (!rightOpen) rememberMobileDrawerTrigger(rightPanelToggleRef.current);
    setRightOpen(true);
    if (mobileLayout) {
      setLeftOpen(false);
    }
  }, [mobileLayout, rememberMobileDrawerTrigger, rightOpen]);

  const toggleLeftPanel = useCallback(() => {
    const next = !leftOpen;
    if (next) rememberMobileDrawerTrigger(leftPanelToggleRef.current);
    setLeftOpen(next);
    if (next && mobileLayout) {
      setRightOpen(false);
    } else if (!next && mobileLayout) {
      restoreMobileDrawerFocus(leftPanelToggleRef.current);
    }
  }, [leftOpen, mobileLayout, rememberMobileDrawerTrigger, restoreMobileDrawerFocus]);

  const toggleRightPanel = useCallback(() => {
    const next = !rightOpen;
    if (next) rememberMobileDrawerTrigger(rightPanelToggleRef.current);
    setRightOpen(next);
    if (next && mobileLayout) {
      setLeftOpen(false);
    } else if (!next && mobileLayout) {
      restoreMobileDrawerFocus(rightPanelToggleRef.current);
    }
  }, [mobileLayout, rememberMobileDrawerTrigger, restoreMobileDrawerFocus, rightOpen]);

  useEffect(() => {
    if (mobileLayout && leftOpen && rightOpen) {
      setRightOpen(false);
    }
  }, [leftOpen, mobileLayout, rightOpen]);

  useEffect(() => {
    const wasMobile = previousMobileLayoutRef.current;
    previousMobileLayoutRef.current = mobileLayout;
    if (wasMobile === mobileLayout) {
      if (!mobileLayout) {
        desktopLeftOpenRef.current = leftOpen;
        desktopRightOpenRef.current = rightOpen;
      }
      return;
    }
    if (mobileLayout) {
      desktopLeftOpenRef.current = leftOpen;
      desktopRightOpenRef.current = rightOpen;
      setLeftOpen(false);
      setRightOpen(false);
    } else {
      setLeftOpen(desktopLeftOpenRef.current);
      setRightOpen(desktopRightOpenRef.current);
    }
  }, [leftOpen, mobileLayout, rightOpen]);

  useEffect(() => {
    if (!activeMobileDrawer) return undefined;
    const panel = activeMobileDrawer === "left" ? leftPanelRef.current : rightPanelRef.current;
    if (!panel) return undefined;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(MOBILE_DRAWER_FOCUSABLE))
      .filter((element) => element.getClientRects().length > 0);
    const focusTimer = window.setTimeout(() => {
      if (!panel.contains(document.activeElement)) {
        focusable()[0]?.focus();
      }
    }, 0);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (activeMobileDrawer === "left") closeLeftPanel(); else closeRightPanel();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeMobileDrawer, closeLeftPanel, closeRightPanel]);

  useEffect(() => {
    if (activeMobileDrawer || !pendingMobileDrawerFocusRef.current) return undefined;
    const target = pendingMobileDrawerFocusRef.current;
    pendingMobileDrawerFocusRef.current = null;
    let attempts = 0;
    let focusFrame = 0;
    const focusAfterInertRemoval = () => {
      attempts += 1;
      if (!target.isConnected) return;
      if (!target.closest("[inert]")) {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) return;
      }
      if (attempts < 12) {
        focusFrame = window.requestAnimationFrame(focusAfterInertRemoval);
      }
    };
    focusFrame = window.requestAnimationFrame(focusAfterInertRemoval);
    return () => window.cancelAnimationFrame(focusFrame);
  }, [activeMobileDrawer]);

  useEffect(() => () => {
    // WebCrypto work cannot be cancelled. Invalidate every continuation and
    // synchronously wipe decrypted refs so a late Promise cannot repopulate
    // plaintext after lock, logout, or unmount.
    decryptGeneration.current += 1;
    workspaceAccessScopeGenerationRef.current += 1;
    notesRef.current = [];
    foldersRef.current = [];
    allVisibleNoteSnapshotsRef.current = [];
    pendingCreatedEntryIdsRef.current.clear();
    pendingClipboardAssetTitleKeysRef.current.clear();
    pendingClipboardAssetTitleKeyByIdRef.current.clear();
    pendingClipboardAssetIdsRef.current.clear();
    pendingClipboardPasteCountsRef.current.clear();
    blockedPastedImageRollbackReleasesRef.current.clear();
    resetPastedImageFolderRuntime();
    entryAutosaveRef.current?.cancelAll();
    entryAutosaveRetryCountsRef.current.clear();
    ambiguousEntrySaveAttemptsRef.current.clear();
    folderTrashLockedFolderIdsRef.current.clear();
    activeFolderSnapshotsRef.current = [];
    allFolderSnapshotsRef.current = [];
    noteSubscriptionServerReadyRef.current = false;
    folderSubscriptionServerReadyRef.current = false;
    pendingFolderRestoreRef.current = null;
    folderPathsRef.current = new Map();
    draftsRef.current = {};
    draftBaseSnapshotsRef.current.clear();
    draftMergeRequestGenerationRef.current += 1;
    draftMergeReturnFocusRef.current = null;
    knowledgeEntriesRef.current.clear();
    pendingWorkspaceStateRef.current = null;
    workspaceSaveGenerationRef.current += 1;
    workspaceConflictRequestGenerationRef.current += 1;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    decodedAssetCacheRef.current.clear();
    const rightPanelResize = rightPanelResizeRef.current;
    if (rightPanelResize?.frameId !== null && rightPanelResize?.frameId !== undefined) {
      window.cancelAnimationFrame(rightPanelResize.frameId);
    }
    rightPanelResizeRef.current = null;
    if (knowledgeSyncRetryTimerRef.current !== null) {
      window.clearTimeout(knowledgeSyncRetryTimerRef.current);
      knowledgeSyncRetryTimerRef.current = null;
    }
    if (workspaceSaveRetryTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveRetryTimerRef.current);
      workspaceSaveRetryTimerRef.current = null;
    }
    if (globalViewportCommitTimerRef.current !== null) {
      window.clearTimeout(globalViewportCommitTimerRef.current);
      globalViewportCommitTimerRef.current = null;
    }
    if (localViewportCommitTimerRef.current !== null) {
      window.clearTimeout(localViewportCommitTimerRef.current);
      localViewportCommitTimerRef.current = null;
    }
    if (workspaceSaveDebounceTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveDebounceTimerRef.current);
      workspaceSaveDebounceTimerRef.current = null;
    }
  }, [resetPastedImageFolderRuntime]);

  useEffect(() => {
    decodedAssetCacheRef.current.clear();
  }, [privateKey, profile?.uid]);

  useEffect(() => {
    renameEntryRef.current = renameEntry;
    moveEntryRef.current = moveEntryToFolder;
    trashEntryRef.current = moveEntryToTrash;
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
  }, [knowledgeClientGeneration, privateKey, profile]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    let active = true;
    const migrationGeneration = vaultNameMigrationGenerationRef.current + 1;
    vaultNameMigrationGenerationRef.current = migrationGeneration;
    if (vaultIntegrityBusyRetryTimerRef.current !== null) {
      window.clearTimeout(vaultIntegrityBusyRetryTimerRef.current);
      vaultIntegrityBusyRetryTimerRef.current = null;
    }
    vaultIntegritySealAbortRef.current?.abort();
    vaultIntegritySealAbortRef.current = null;
    vaultNameMigrationPromiseRef.current = null;
    setVaultIntegrityKey(null);
    setPreparedVaultIntegrityKey(null);
    setVaultNameMigrationProgress(null);
    setVaultNameMigrationFailure(null);
    setVaultNameCollisionTargetIds(new Set());
    setVaultNameCollisionRepairTargetIds(new Set());
    if (!isOnline) {
      setVaultNameMigrationStatus("waiting");
      return () => {
        active = false;
        if (vaultIntegrityBusyRetryTimerRef.current !== null) {
          window.clearTimeout(vaultIntegrityBusyRetryTimerRef.current);
          vaultIntegrityBusyRetryTimerRef.current = null;
        }
        if (vaultNameMigrationGenerationRef.current === migrationGeneration) {
          vaultNameMigrationGenerationRef.current += 1;
        }
      };
    }

    setVaultNameMigrationStatus("checking");
    setStatus("암호화된 이름 완료 상태를 서버에서 확인하는 중입니다…");
    void prepareVaultIntegrityKey(vaultIntegrityProfileRef.current, privateKey)
      .then((prepared) => {
        if (!active || vaultNameMigrationGenerationRef.current !== migrationGeneration) return;
        setPreparedVaultIntegrityKey(prepared);
        if (prepared.cutoverState === "ready") {
          setVaultIntegrityKey(prepared.key);
          setVaultNameMigrationStatus("ready");
          setStatus("암호화된 이름 무결성 준비가 완료된 Vault입니다.");
          return;
        }
        setVaultNameMigrationStatus("waiting");
        setStatus("서버의 전체 노트·폴더 목록을 한 번 확인하는 중입니다…");
      })
      .catch((caught) => {
        if (!active || vaultNameMigrationGenerationRef.current !== migrationGeneration) return;
        const message = caught instanceof Error
          ? `암호화된 이름 완료 상태를 확인하지 못했습니다: ${caught.message}`
          : "암호화된 이름 완료 상태를 확인하지 못했습니다.";
        setVaultNameMigrationFailure(message);
        setVaultNameMigrationStatus("blocked");
        setError(message);
      });
    return () => {
      active = false;
      if (vaultIntegrityBusyRetryTimerRef.current !== null) {
        window.clearTimeout(vaultIntegrityBusyRetryTimerRef.current);
        vaultIntegrityBusyRetryTimerRef.current = null;
      }
      if (vaultNameMigrationGenerationRef.current === migrationGeneration) {
        vaultNameMigrationGenerationRef.current += 1;
      }
      vaultIntegritySealAbortRef.current?.abort();
      vaultIntegritySealAbortRef.current = null;
    };
  }, [isOnline, privateKey, vaultIntegrityProfileSignature, vaultIntegrityRetryAttempt]);

  useEffect(() => {
    if (
      !privateKey
      || !profile
      || !isOnline
      || !vaultDataReady
      || !vaultPlaintextScopeReady
      || workspaceReady
    ) {
      return undefined;
    }
    let active = true;
    let retryTimer: number | undefined;
    const accessScopeGeneration = workspaceAccessScopeGenerationRef.current;
    setWorkspaceReady(false);

    void loadVaultWorkspaceRecord<VaultWorkspaceState>(profile.uid, privateKey)
      .then((record) => {
        if (!active || workspaceAccessScopeGenerationRef.current !== accessScopeGeneration) {
          return;
        }
        const remoteState = vaultWorkspaceForEntryIds(
          normalizeVaultWorkspaceState(record?.state),
          new Set(notesRef.current.map((note) => note.id))
        );
        if (workspaceInteractionDuringLoadRef.current) {
          if (record) {
            workspaceRevisionRef.current = record.revision;
            workspaceConflictPendingRef.current = false;
            setWorkspaceConflict({
              actualRevision: record.revision,
              localState: latestWorkspaceStateRef.current,
              remoteState
            });
            setWorkspaceReady(true);
            setError("서버 배치를 불러오는 동안 현재 탭에서 배치가 변경되어 자동으로 덮어쓰지 않았습니다.");
            return;
          }

          // A first-time vault has no remote workspace document. Preserve any
          // trusted interaction that happened while the absence check was in
          // flight, then let the normal encrypted save effect create revision
          // 1 from the current in-memory layout.
          workspaceRevisionRef.current = undefined;
          initialEntryAutoOpenPendingRef.current = false;
          const remoteSerialization = JSON.stringify(remoteState);
          lastSavedWorkspaceRef.current = remoteSerialization;
          setLastSavedWorkspaceSerialization(remoteSerialization);
          pendingWorkspaceStateRef.current = latestWorkspaceStateRef.current;
          workspaceInteractionDuringLoadRef.current = false;
          workspaceConflictPendingRef.current = false;
          setWorkspaceConflict(null);
          setWorkspaceReady(true);
          return;
        }
        applyRestoredWorkspace(remoteState, record?.revision, record === null);
      })
      .catch(() => {
        if (active && workspaceAccessScopeGenerationRef.current === accessScopeGeneration) {
          setError("암호화 워크스페이스 상태를 불러오지 못했습니다. 덮어쓰지 않고 잠시 후 다시 시도합니다.");
          const retryDelay = Math.min(30_000, 1_000 * (2 ** Math.min(workspaceLoadAttempt, 5)));
          retryTimer = window.setTimeout(() => setWorkspaceLoadAttempt((attempt) => attempt + 1), retryDelay);
        }
      });

    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [
    applyRestoredWorkspace,
    isOnline,
    ownerIdKey,
    privateKey,
    profile,
    vaultDataReady,
    vaultPlaintextScopeReady,
    workspaceLoadAttempt,
    workspaceReady
  ]);

  useEffect(() => {
    if (!privateKey || !profile) {
      setUsers([]);
      return undefined;
    }
    return subscribeUsers(setUsers, () => setError("공유 사용자 목록을 불러오지 못했습니다."));
  }, [privateKey, profile]);

  useEffect(() => {
    trashDecryptGenerationRef.current += 1;
    trashFolderDecryptGenerationRef.current += 1;
    if (!trashOpen || !privateKey || !profile) {
      setTrashNotes([]);
      setTrashFolders([]);
      setTrashNotesLoading(false);
      setTrashFoldersLoading(false);
      setTrashNotesServerReady(false);
      setTrashFoldersServerReady(false);
      return undefined;
    }

    let active = true;
    setTrashNotes([]);
    setTrashFolders([]);
    setTrashNotesLoading(true);
    setTrashFoldersLoading(true);
    setTrashNotesServerReady(false);
    setTrashFoldersServerReady(false);
    const unsubscribeNotes = subscribeDeletedNotes(
      profile.uid,
      [profile.uid],
      (deletedSnapshots, metadata) => {
        const decryptGeneration = trashDecryptGenerationRef.current + 1;
        trashDecryptGenerationRef.current = decryptGeneration;
        setTrashNotesServerReady(metadata.serverComplete);
        setTrashNotesLoading(true);
        void decryptVaultNotes(deletedSnapshots, profile.uid, privateKey)
          .then((decrypted) => {
            if (
              !active
              || trashDecryptGenerationRef.current !== decryptGeneration
            ) return;
            setTrashNotes(decrypted.filter((note) => note.ownerUid === profile.uid));
            setTrashNotesLoading(!metadata.serverComplete);
          })
          .catch(() => {
            if (!active || trashDecryptGenerationRef.current !== decryptGeneration) return;
            setTrashNotes([]);
            setTrashNotesLoading(false);
            setTrashNotesServerReady(false);
            setError("Vault 휴지통을 복호화하지 못해 복원을 잠갔습니다.");
          });
      },
      () => {
        if (!active) return;
        setTrashNotes([]);
        setTrashNotesLoading(false);
        setTrashNotesServerReady(false);
        setError("서버의 Vault 휴지통을 확인하지 못해 복원을 잠갔습니다.");
      },
      500
    );
    const unsubscribeFolders = subscribeDeletedNoteFolders(
      profile.uid,
      (deletedFolderSnapshots, metadata) => {
        const decryptGeneration = trashFolderDecryptGenerationRef.current + 1;
        trashFolderDecryptGenerationRef.current = decryptGeneration;
        setTrashFoldersServerReady(metadata.serverComplete);
        setTrashFoldersLoading(true);
        const partition = partitionVaultFolderTrash(deletedFolderSnapshots);
        void decryptVaultFolders(deletedFolderSnapshots, profile.uid, privateKey)
          .then((decrypted) => {
            if (!active || trashFolderDecryptGenerationRef.current !== decryptGeneration) return;
            const byId = new Map(decrypted.map((folder) => [folder.id, folder]));
            setTrashFolders(partition.trashRoots.flatMap((root) => {
              const folder = byId.get(root.id);
              if (!folder) return [];
              return [{
                ...vaultFolderTrashCounts(
                  root.id,
                  deletedFolderSnapshots,
                  allVisibleNoteSnapshotsRef.current
                ),
                folder
              }];
            }));
            setTrashFoldersLoading(!metadata.serverComplete);
          })
          .catch(() => {
            if (!active || trashFolderDecryptGenerationRef.current !== decryptGeneration) return;
            setTrashFolders([]);
            setTrashFoldersLoading(false);
            setTrashFoldersServerReady(false);
            setError("암호화 폴더 휴지통을 복호화하지 못해 복원을 잠갔습니다.");
          });
      },
      () => {
        if (!active) return;
        setTrashFolders([]);
        setTrashFoldersLoading(false);
        setTrashFoldersServerReady(false);
        setError("서버의 폴더 휴지통을 확인하지 못해 복원을 잠갔습니다.");
      }
    );

    return () => {
      active = false;
      trashDecryptGenerationRef.current += 1;
      trashFolderDecryptGenerationRef.current += 1;
      unsubscribeNotes();
      unsubscribeFolders();
      setTrashNotes([]);
      setTrashFolders([]);
      setTrashNotesServerReady(false);
      setTrashFoldersServerReady(false);
    };
  }, [privateKey, profile, trashOpen]);

  useEffect(() => {
    const subscriptionGeneration = noteSubscriptionGenerationRef.current + 1;
    noteSubscriptionGenerationRef.current = subscriptionGeneration;
    noteSubscriptionServerReadyRef.current = false;
    setNoteServerReservationSignature(null);
    if (!privateKey || !profile) {
      allVisibleNoteSnapshotsRef.current = [];
      setRawNotes([]);
      setNoteSnapshotReceived(false);
      return undefined;
    }
    const visibleOwners = ownerIdKey === "admin" ? null : ownerIdKey.split("\n").filter(Boolean);
    const unsubscribe = subscribeVisibleNotes(
      profile.uid,
      visibleOwners,
      (nextNotes, metadata) => {
        if (noteSubscriptionGenerationRef.current !== subscriptionGeneration) return;
        const activeNotes = visibleVaultNotesForFolders(nextNotes, activeFolderSnapshotsRef.current);
        for (const note of activeNotes) {
          pendingCreatedEntryIdsRef.current.delete(note.id);
        }
        const nextAccessScope = knowledgeAccessScopeSignature(activeNotes, profile.uid);
        if (knowledgeAccessScopeRequiresReset(noteAccessScopeRef.current, nextAccessScope)) {
          clearVaultPlaintextForAccessScope();
        }
        noteAccessScopeRef.current = nextAccessScope;
        allVisibleNoteSnapshotsRef.current = nextNotes;
        noteSubscriptionServerReadyRef.current = metadata.serverComplete;
        setVaultDataReady(false);
        setRawNotes(activeNotes);
        setNoteSnapshotReceived(true);
        setNoteServerReservationSignature(metadata.serverComplete && folderSubscriptionServerReadyRef.current
          ? ownedNoteReservationSignature(activeNotes, profile.uid)
          : null);
      },
      () => {
        if (noteSubscriptionGenerationRef.current !== subscriptionGeneration) return;
        noteSubscriptionServerReadyRef.current = false;
        setNoteServerReservationSignature(null);
        setError("암호화 노트 목록을 불러오지 못했습니다.");
      },
      undefined,
      { repairLegacyDeletionMetadata: false }
    );
    return () => {
      if (noteSubscriptionGenerationRef.current === subscriptionGeneration) {
        noteSubscriptionGenerationRef.current += 1;
      }
      unsubscribe();
    };
  }, [clearVaultPlaintextForAccessScope, ownerIdKey, privateKey, profile, vaultIntegrityRetryAttempt]);

  useEffect(() => {
    folderSubscriptionServerReadyRef.current = false;
    setFolderServerReservationSignature(null);
    if (!privateKey || !profile) {
      activeFolderSnapshotsRef.current = [];
      allFolderSnapshotsRef.current = [];
      setRawFolders([]);
      setFolderSnapshotReceived(false);
      return undefined;
    }
    return subscribeNoteFolders(profile.uid, (nextFolders, metadata) => {
      const folderContentChanged = activeFolderSnapshotsRef.current !== nextFolders;
      activeFolderSnapshotsRef.current = nextFolders;
      folderSubscriptionServerReadyRef.current = metadata.serverComplete;
      const activeNotes = visibleVaultNotesForFolders(
        allVisibleNoteSnapshotsRef.current,
        nextFolders
      );
      if (folderContentChanged) {
        // vaultPasteLock is an opaque, server-only coordination field. Its
        // acquire/renew/release notifications must not re-run WebCrypto across
        // every note and folder when no user-visible folder data changed.
        setVaultDataReady(false);
        setRawFolders(nextFolders);
        setRawNotes(activeNotes);
      }
      setFolderSnapshotReceived(true);
      setFolderServerReservationSignature(metadata.serverComplete
        ? ownedFolderReservationSignature(nextFolders, profile.uid)
        : null);
      setNoteServerReservationSignature(
        metadata.serverComplete && noteSubscriptionServerReadyRef.current
          ? ownedNoteReservationSignature(activeNotes, profile.uid)
          : null
      );
    }, () => {
      // A listener error can be an authorization revocation. Do not retain an
      // old decrypted folder tree (or note paths derived from it) after that
      // boundary, even when the note listener has not failed yet.
      clearVaultPlaintextForAccessScope();
      folderSubscriptionServerReadyRef.current = false;
      setFolderServerReservationSignature(null);
      setNoteServerReservationSignature(null);
      setError("폴더 목록을 불러오지 못했습니다.");
    }, (allFolders, metadata) => {
      allFolderSnapshotsRef.current = allFolders;
      const pendingRestore = pendingFolderRestoreRef.current;
      if (pendingRestore && metadata.serverComplete) {
        pendingFolderRestoreRef.current = null;
        const target = allFolders.find((folder) => folder.id === pendingRestore.folderId);
        const partition = partitionVaultFolderTrash(allFolders);
        if (
          target
          && target.isDeleted !== true
          && target.revision === pendingRestore.revision
          && !partition.hiddenFolderIds.has(target.id)
        ) {
          setStatus("암호화 폴더와 하위 트리를 원래 위치로 복원했습니다.");
        } else {
          setError("복원 쓰기는 보존했지만 상위 폴더 트리가 동시에 변경되어 활성 경로를 확인하지 못했습니다. 가장 바깥쪽 휴지통 폴더부터 다시 확인해주세요.");
        }
      }
    });
  }, [clearVaultPlaintextForAccessScope, privateKey, profile, vaultIntegrityRetryAttempt]);

  useEffect(() => {
    if (!privateKey || !profile || !noteSnapshotReceived || !folderSnapshotReceived) {
      commitNotes(() => []);
      commitFolders(() => []);
      setDecryptedVaultScopeKey(null);
      setVaultDataReady(false);
      return;
    }
    const generation = decryptGeneration.current + 1;
    const decryptScopeKey = plaintextScopeKey;
    decryptGeneration.current = generation;
    let cancelled = false;
    void Promise.all([
      decryptVaultNotes(rawNotes, profile.uid, privateKey, {
        reusableNotes: notesRef.current
      }),
      decryptVaultFolders(rawFolders, profile.uid, privateKey, {
        reusableFolders: foldersRef.current
      })
    ]).then(([nextNotes, nextFolders]) => {
      if (cancelled || decryptGeneration.current !== generation) {
        return;
      }
      const folderAudit = auditVaultFolderTree(nextFolders);
      commitNotes(() => nextNotes);
      commitFolders(() => nextFolders);
      setDecryptedVaultScopeKey(decryptScopeKey);
      setVaultDataReady(true);
      if (!folderAudit.valid) {
        setError("폴더 트리 무결성 오류를 발견했습니다. 폴더 이동과 마이그레이션을 중단했습니다.");
        setStatus(`${nextNotes.length}개 항목 연결됨 · 폴더 복구 필요`);
      } else {
        setStatus(`${nextNotes.length}개 항목 연결됨`);
      }
    }).catch(() => {
      if (!cancelled && decryptGeneration.current === generation) {
        commitNotes(() => []);
        commitFolders(() => []);
        setDecryptedVaultScopeKey(null);
        setVaultDataReady(false);
        setError("Vault 복호화를 완료하지 못했습니다. 평문 캐시를 비우고 쓰기를 잠갔습니다.");
      }
    });

    return () => {
      cancelled = true;
      if (decryptGeneration.current === generation) {
        decryptGeneration.current += 1;
      }
    };
  }, [commitFolders, commitNotes, folderSnapshotReceived, noteSnapshotReceived, plaintextScopeKey, privateKey, profile, rawFolders, rawNotes]);

  useEffect(() => {
    if (
      !preparedVaultIntegrityKey
      || preparedVaultIntegrityKey.cutoverState === "ready"
      || !isOnline
      || !vaultServerSubscriptionsReady
      || vaultNameMigrationStatusRef.current !== "waiting"
      || vaultNameMigrationPromiseRef.current
    ) {
      return;
    }

    const generation = vaultNameMigrationGenerationRef.current;
    const controller = new AbortController();
    vaultIntegritySealAbortRef.current?.abort();
    vaultIntegritySealAbortRef.current = controller;
    setVaultNameMigrationStatus("running");
    setVaultNameMigrationProgress({ completed: 0, migrated: 0, skipped: 0, total: 0 });
    setVaultNameMigrationFailure(null);
    setVaultNameCollisionTargetIds(new Set());
    setVaultNameCollisionRepairTargetIds(new Set());
    setStatus("암호화된 이름 예약을 한 번 확인하는 중입니다…");

    const pending = (async () => {
      const {
        migrateVaultNameReservations,
        preflightVaultNameCutover,
        vaultNameCollisionRepairTargetIds
      } = await import("../features/vault/vaultNameMigration");
      const currentProfile = vaultIntegrityProfileRef.current;
      const migrationCancelled = () => (
        vaultNameMigrationGenerationRef.current !== generation || controller.signal.aborted
      );
      let activeIntegrityKey = preparedVaultIntegrityKey.key;
      // A brand-new Vault must prove that its complete owner inventory is
      // decryptable before the first integrity marker write. Existing pending
      // Vaults already crossed that boundary and can reconcile stale blinded
      // reservations before loading a fresh migration inventory.
      if (preparedVaultIntegrityKey.state === "candidate") {
        const candidateInventory = await loadOwnedVaultCutoverInventory(currentProfile.uid);
        if (migrationCancelled()) {
          return { kind: "cancelled" } as const;
        }
        if (!folderSubscriptionServerReadyRef.current) {
          throw new Error("서버의 전체 Vault 폴더 목록을 아직 확인하지 못했습니다.");
        }
        await preflightVaultNameCutover({
          activeNotes: candidateInventory.activeNotes,
          deletedNotes: candidateInventory.deletedNotes,
          folders: activeFolderSnapshotsRef.current.filter(
            (folder) => folder.ownerUid === currentProfile.uid
          ),
          privateKey,
          uid: currentProfile.uid,
          vaultIntegrityKey: activeIntegrityKey
        });
      }

      const activated = await activatePreparedVaultIntegrityKey(
        preparedVaultIntegrityKey,
        privateKey
      );
      activeIntegrityKey = activated.key;
      if (migrationCancelled()) {
        return { kind: "cancelled" } as const;
      }
      if (activated.cutoverState === "ready") {
        return { key: activeIntegrityKey, kind: "already-ready" } as const;
      }

      const leaseId = createVaultIntegrityCutoverLeaseId();
      let cutoverLease: VaultIntegrityCutoverLease | null = null;
      let leaseLastConfirmedAt = 0;
      const renewCutoverLeaseBetweenBatches = async () => {
        if (migrationCancelled()) {
          throw new Error("Vault 무결성 확인이 취소되었습니다.");
        }
        if (!cutoverLease) {
          throw new Error("Vault 무결성 임대 상태를 확인할 수 없습니다.");
        }
        // Renewal is serialized between mutation batches. An interval update
        // could invalidate the marker updateTime read by an in-flight fenced
        // note/folder transaction and create an avoidable abort loop.
        if (Date.now() - leaseLastConfirmedAt < 25_000) return;
        const renewed = await renewVaultIntegrityCutoverLease(
          currentProfile.uid,
          cutoverLease,
          controller.signal
        );
        if (renewed.state === "ready") {
          throw new VaultIntegrityApiError("vault_cutover_complete", 409);
        }
        leaseLastConfirmedAt = Date.now();
      };

      try {
        const reconcilePendingClaims = async () => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const reconciled = await reconcilePendingVaultIntegrityClaims(
                currentProfile.uid,
                leaseId,
                controller.signal
              );
              cutoverLease = {
                leaseGeneration: reconciled.leaseGeneration,
                leaseId
              };
              leaseLastConfirmedAt = Date.now();
              return reconciled;
            } catch (caught) {
              if (
                caught instanceof VaultIntegrityApiError
                && caught.code === "vault_cutover_complete"
              ) {
                return null;
              }
              if (
                caught instanceof VaultIntegrityApiError
                && caught.code === "vault_cutover_changed"
                && attempt < 1
              ) {
                continue;
              }
              throw caught;
            }
          }
          throw new Error("Vault 이름 예약 정리 재시도 횟수를 초과했습니다.");
        };
        const initialReconciliation = await reconcilePendingClaims();
        if (initialReconciliation === null) {
          return { key: activeIntegrityKey, kind: "already-ready" } as const;
        }
        if (!cutoverLease) {
          throw new Error("Vault 무결성 임대 응답을 확인할 수 없습니다.");
        }
        let reconciledClaimCount = initialReconciliation.removedClaimCount;
        if (migrationCancelled()) {
          return { kind: "cancelled" } as const;
        }
        // Reconciliation may have removed orphaned/superseded reservations, so
        // never reuse an inventory captured before it. The migration plan and
        // count assertions are always based on this fresh server read.
        const inventory = await loadOwnedVaultCutoverInventory(currentProfile.uid);
        if (migrationCancelled()) {
          return { kind: "cancelled" } as const;
        }
        if (!folderSubscriptionServerReadyRef.current) {
          throw new Error("서버의 전체 Vault 폴더 목록을 아직 확인하지 못했습니다.");
        }
        const ownedFolderSnapshots = activeFolderSnapshotsRef.current
          .filter((folder) => folder.ownerUid === currentProfile.uid);
        const preflight = await preflightVaultNameCutover({
          activeNotes: inventory.activeNotes,
          deletedNotes: inventory.deletedNotes,
          folders: ownedFolderSnapshots,
          privateKey,
          uid: currentProfile.uid,
          vaultIntegrityKey: activeIntegrityKey
        });
        if (migrationCancelled()) {
          return { kind: "cancelled" } as const;
        }
        setVaultIntegrityKey(activeIntegrityKey);
        setVaultNameMigrationProgress({
          completed: 0,
          migrated: 0,
          skipped: 0,
          total: preflight.folders.length + preflight.activeNotes.length + preflight.deletedNotes.length
        });

        const result = await migrateVaultNameReservations({
          cutoverLease,
          deletedNotes: preflight.deletedNotes,
          expectedDeletedNoteCount: inventory.deletedNotes.length,
          expectedFolderCount: preflight.folders.length,
          expectedNoteCount: inventory.activeNotes.length,
          folders: preflight.folders,
          legacyActiveNoteIds: preflight.legacyActiveNoteIds,
          legacyDeletedNoteIds: preflight.legacyDeletedNoteIds,
          notes: preflight.activeNotes,
          onLeaseCheckpoint: renewCutoverLeaseBetweenBatches,
          onProgress: (progress) => {
            if (vaultNameMigrationGenerationRef.current === generation) {
              setVaultNameMigrationProgress(progress);
            }
          },
          privateKey,
          profile: currentProfile,
          signal: controller.signal,
          vaultIntegrityKey: activeIntegrityKey
        });
        if (migrationCancelled()) {
          return { kind: "cancelled" } as const;
        }
        if (result.deferredTargetIds.length) {
          return {
            kind: "deferred",
            repairTargetIds: vaultNameCollisionRepairTargetIds(result, notesRef.current),
            result
          } as const;
        }

        // Only a pre-existing claim can become safely superseded during the
        // migration. When the initial server inventory observed no claim, the
        // same held lease proves that a second full reconciliation cannot find
        // such a legacy reservation, saving one bounded full-Vault scan.
        if (initialReconciliation.observedClaimCount > 0) {
          const finalReconciliation = await reconcilePendingClaims();
          if (finalReconciliation === null) {
            return { key: activeIntegrityKey, kind: "already-ready" } as const;
          }
          reconciledClaimCount += finalReconciliation.removedClaimCount;
        }
        if (migrationCancelled()) {
          return { kind: "cancelled" } as const;
        }

        if (!cutoverLease) {
          throw new Error("Vault 무결성 임대 상태를 확인할 수 없습니다.");
        }
        await sealVaultIntegrityCutover(currentProfile.uid, cutoverLease, {
          expectedActiveNoteCount: inventory.activeNotes.length,
          expectedDeletedNoteCount: inventory.deletedNotes.length,
          expectedFolderCount: preflight.folders.length
        }, controller.signal);
        cutoverLease = null;
        return {
          key: activeIntegrityKey,
          kind: "sealed",
          reconciledClaimCount,
          result
        } as const;
      } finally {
        if (cutoverLease) {
          await releaseVaultIntegrityCutoverLease(
            currentProfile.uid,
            cutoverLease
          ).catch(() => undefined);
        }
      }
    })().then((outcome) => {
      if (vaultNameMigrationGenerationRef.current !== generation) return;
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "already-ready") {
        setVaultIntegrityKey(outcome.key);
        setVaultNameMigrationProgress(null);
        setVaultNameMigrationFailure(null);
        setVaultNameCollisionTargetIds(new Set());
        setVaultNameCollisionRepairTargetIds(new Set());
        setVaultNameMigrationStatus("ready");
        setStatus("다른 탭에서 암호화된 이름 무결성 준비를 완료했습니다.");
        return;
      }
      setVaultNameMigrationProgress(outcome.result);
      if (outcome.kind === "deferred") {
        const actionableTargetIds = new Set(outcome.repairTargetIds);
        setVaultNameCollisionTargetIds(new Set(outcome.result.deferredTargetIds));
        setVaultNameCollisionRepairTargetIds(actionableTargetIds);
        setVaultNameMigrationStatus("blocked");
        const failure = outcome.result.collisions.length
          ? `이름이 겹친 항목 ${actionableTargetIds.size}개가 있습니다. 새 이름을 정하면 내용을 보존하고 검증을 이어갑니다.`
          : `이전 버전의 공유 폴더 경로 ${actionableTargetIds.size}개를 발견했습니다. 표시된 공유 항목을 Vault 루트로 이동해 무결성 검증을 완료해주세요.`;
        setVaultNameMigrationFailure(failure);
        setError(failure);
        return;
      }
      setVaultIntegrityKey(outcome.key);
      setVaultNameCollisionTargetIds(new Set());
      setVaultNameCollisionRepairTargetIds(new Set());
      setVaultNameMigrationFailure(null);
      setVaultNameMigrationStatus("ready");
      setStatus(outcome.reconciledClaimCount
        ? `오래된 이름 예약 ${outcome.reconciledClaimCount}개를 안전하게 정리하고 무결성 완료 상태를 저장했습니다.`
        : outcome.result.migrated
          ? `암호화된 이름 예약 ${outcome.result.migrated}개를 확인하고 완료 상태를 저장했습니다.`
          : "암호화된 이름 무결성 완료 상태를 서버에 저장했습니다.");
    }).catch((caught) => {
      if (
        vaultNameMigrationGenerationRef.current !== generation
        || controller.signal.aborted
      ) return;
      if (caught instanceof VaultIntegrityApiError && caught.code === "vault_cutover_busy") {
        const retryAfterSeconds = Math.min(30, Math.max(1, caught.retryAfterSeconds ?? 3));
        setVaultNameMigrationStatus("waiting");
        setVaultNameMigrationProgress(null);
        setVaultNameMigrationFailure("다른 탭이나 기기의 확인이 끝나기를 기다리고 있습니다. 현재 편집 버퍼는 유지됩니다.");
        setVaultNameCollisionTargetIds(new Set());
        setVaultNameCollisionRepairTargetIds(new Set());
        setStatus(`다른 탭의 Vault 확인이 끝난 뒤 ${retryAfterSeconds}초 후 다시 확인합니다.`);
        setError(null);
        if (vaultIntegrityBusyRetryTimerRef.current !== null) {
          window.clearTimeout(vaultIntegrityBusyRetryTimerRef.current);
        }
        vaultIntegrityBusyRetryTimerRef.current = window.setTimeout(() => {
          vaultIntegrityBusyRetryTimerRef.current = null;
          if (
            vaultNameMigrationGenerationRef.current !== generation
            || controller.signal.aborted
          ) return;
          setVaultNameMigrationStatus("checking");
          setVaultIntegrityRetryAttempt((attempt) => attempt + 1);
        }, retryAfterSeconds * 1_000);
        return;
      }
      const failure = caught instanceof Error
        ? `이름 예약 확인을 완료하지 못했습니다: ${caught.message}`
        : "이름 예약 확인을 완료하지 못해 Vault 쓰기를 잠갔습니다.";
      const conflictTargetIds = caught instanceof Error
        && caught.name === "VaultNameReservationMigrationConflictError"
        && Array.isArray((caught as Error & { targetIds?: unknown }).targetIds)
        ? (caught as Error & { targetIds: unknown[] }).targetIds
            .filter((targetId): targetId is string => typeof targetId === "string")
        : [];
      const knownTargetIds = new Set([
        ...notesRef.current.map((note) => note.id),
        ...foldersRef.current.map((folder) => folder.id)
      ]);
      const knownCollisionTargets = conflictTargetIds.filter((targetId) => knownTargetIds.has(targetId));
      setVaultNameMigrationStatus("blocked");
      setVaultNameCollisionTargetIds(new Set(knownCollisionTargets));
      setVaultNameCollisionRepairTargetIds(new Set(knownCollisionTargets));
      setVaultNameMigrationFailure(failure);
      setError(failure);
    }).finally(() => {
      const cancelledWhileCurrent = controller.signal.aborted
        && vaultNameMigrationGenerationRef.current === generation;
      if (vaultNameMigrationPromiseRef.current === pending) {
        vaultNameMigrationPromiseRef.current = null;
      }
      if (vaultIntegritySealAbortRef.current === controller) {
        vaultIntegritySealAbortRef.current = null;
      }
      if (
        cancelledWhileCurrent
        && vaultNameMigrationStatusRef.current === "running"
      ) {
        setVaultNameMigrationProgress(null);
        setVaultNameMigrationStatus("waiting");
        // Readiness can recover before the aborted promise releases its lease.
        // Bump an explicit dependency after that promise is cleared so the
        // migration cannot remain stranded in waiting with unchanged inputs.
        setVaultNameMigrationResumeAttempt((attempt) => attempt + 1);
      }
    });
    vaultNameMigrationPromiseRef.current = pending;
    return () => {
      if (vaultIntegritySealAbortRef.current === controller) {
        controller.abort();
      }
    };
  }, [
    isOnline,
    privateKey,
    preparedVaultIntegrityKey,
    vaultIntegrityRetryAttempt,
    vaultNameMigrationResumeAttempt,
    vaultServerSubscriptionsReady
  ]);

  useEffect(() => {
    if (
      !isOnline
      || !preparedVaultIntegrityKey
      || vaultServerSubscriptionsReady
      || (vaultNameMigrationStatus !== "waiting" && vaultNameMigrationStatus !== "ready")
    ) {
      return undefined;
    }
    const generation = vaultNameMigrationGenerationRef.current;
    const timeout = window.setTimeout(() => {
      if (
        vaultNameMigrationGenerationRef.current !== generation
        || (vaultNameMigrationStatusRef.current !== "waiting"
          && vaultNameMigrationStatusRef.current !== "ready")
      ) return;
      const failure = "서버의 전체 노트·폴더 목록을 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해주세요.";
      setVaultNameMigrationFailure(failure);
      setVaultNameMigrationStatus("blocked");
      setError(failure);
    }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [
    isOnline,
    preparedVaultIntegrityKey,
    vaultNameMigrationStatus,
    vaultServerSubscriptionsReady
  ]);

  function retryVaultNameMigration() {
    if (
      vaultNameCollisionRepairBusyRef.current
      || vaultNameMigrationStatus === "running"
      || vaultNameMigrationPromiseRef.current
    ) return;
    if (vaultIntegrityBusyRetryTimerRef.current !== null) {
      window.clearTimeout(vaultIntegrityBusyRetryTimerRef.current);
      vaultIntegrityBusyRetryTimerRef.current = null;
    }
    vaultNameMigrationGenerationRef.current += 1;
    vaultIntegritySealAbortRef.current?.abort();
    vaultIntegritySealAbortRef.current = null;
    setVaultIntegrityKey(null);
    setPreparedVaultIntegrityKey(null);
    setVaultNameMigrationProgress(null);
    setVaultNameMigrationFailure(null);
    setVaultNameCollisionTargetIds(new Set());
    setVaultNameCollisionRepairTargetIds(new Set());
    setNoteServerReservationSignature(null);
    setFolderServerReservationSignature(null);
    setVaultNameMigrationStatus(isOnline ? "checking" : "waiting");
    setStatus("암호화된 이름 완료 상태를 다시 확인합니다…");
    setError(null);
    setVaultIntegrityRetryAttempt((attempt) => attempt + 1);
  }

  function canMutateExistingNameTarget(entryId: string) {
    return vaultNameWritesReady
      || (vaultNameMigrationStatus === "blocked" && vaultNameCollisionTargetIds.has(entryId));
  }

  async function repairFirstVaultNameCollision() {
    if (
      vaultNameCollisionRepairBusyRef.current
      || vaultNameMigrationStatusRef.current !== "blocked"
    ) return;
    const generation = vaultNameMigrationGenerationRef.current;
    const targetId = vaultNameCollisionRepairTargetIdsRef.current.values().next().value as string;
    if (!targetId) return;
    vaultNameCollisionRepairBusyRef.current = true;
    setVaultNameCollisionRepairBusy(true);
    setError(null);
    try {
      const { promptVaultNameCollisionRepair } = await import(
        "../features/vault/vaultCollisionNaming"
      );
      if (
        vaultNameMigrationGenerationRef.current !== generation
        || vaultNameMigrationStatusRef.current !== "blocked"
        || !vaultNameCollisionRepairTargetIdsRef.current.has(targetId)
      ) return;
      const repair = promptVaultNameCollisionRepair(
        notesRef.current,
        foldersRef.current,
        targetId
      );
      if (!repair) return;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (
        vaultNameMigrationGenerationRef.current !== generation
        || vaultNameMigrationStatusRef.current !== "blocked"
        || !vaultNameCollisionRepairTargetIdsRef.current.has(targetId)
      ) return;
      if (repair.kind === "entry") {
        openEntry(repair.targetId);
        await renameEntry(repair.targetId, repair.name);
      } else if (repair.kind === "missing") {
        setError("충돌 항목을 찾지 못했습니다. 다시 확인해주세요.");
      } else {
        setLeftMode("files");
        setLeftOpen(true);
        setSelectedFolderId(repair.targetId);
        await renameFolder(repair.targetId, repair.name);
      }
    } catch {
      if (vaultNameMigrationGenerationRef.current === generation) {
        setError("충돌 정리 도구를 불러오지 못했습니다.");
      }
    } finally {
      vaultNameCollisionRepairBusyRef.current = false;
      setVaultNameCollisionRepairBusy(false);
    }
  }

  function recheckVaultNameIntegrityAfterRepair() {
    window.setTimeout(() => retryVaultNameMigration(), 0);
  }

  useEffect(() => {
    if (!vaultPlaintextScopeReady) return;
    const next = { ...draftsRef.current };
    const noteIds = new Set(notes.map((note) => note.id));
    for (const note of notes) {
      if (!next[note.id]?.dirty) {
        draftBaseSnapshotsRef.current.delete(note.id);
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
      if (!noteIds.has(entryId)) {
        delete next[entryId];
        draftBaseSnapshotsRef.current.delete(entryId);
      }
    }
    if (draftMergeConflict && !noteIds.has(draftMergeConflict.entryId)) {
      draftMergeRequestGenerationRef.current += 1;
      setDraftMergeConflict(null);
      setDraftMergeOpen(false);
      setDraftMergeBusyEntryId(null);
    }
    draftsRef.current = next;
    setDrafts(next);
  }, [draftMergeConflict, notes, vaultPlaintextScopeReady]);

  const folderPaths = useMemo(() => buildVaultPaths(folders), [folders]);
  folderPathsRef.current = folderPaths;
  const entryPaths = useMemo(
    () => new Map(notes.map((note) => [note.id, vaultEntryPath(note, folderPaths)])),
    [folderPaths, notes]
  );
  const availableTemplates = useMemo(
    () => templateCandidates(notes.map((note) => ({
      ...note,
      body: deferredDrafts[note.id]?.body ?? note.body
    })), entryPaths, {
      ...(templatesFolderPath ? { folderPath: templatesFolderPath } : {}),
      includeDescendants: templatesIncludeDescendants
    }),
    [deferredDrafts, entryPaths, notes, templatesFolderPath, templatesIncludeDescendants]
  );
  const dailyFolderOptions = useMemo(() => folders.map((folder) => ({
    id: folder.id,
    path: folderPaths.get(folder.id) || folder.displayName
  })).sort((left, right) => left.path.localeCompare(right.path)), [folderPaths, folders]);
  const dailyTemplateOptions = useMemo(() => availableTemplates.map((template) => ({
    id: template.id,
    path: template.path
  })), [availableTemplates]);
  const effectiveDailyNotesFolderId = dailyNotesFolderId === null
    || folders.some((folder) => folder.id === dailyNotesFolderId)
    ? dailyNotesFolderId
    : null;
  const dailyNoteDates = useMemo(() => new Set(notes.flatMap((note) => {
    const draft = deferredDrafts[note.id];
    if (note.entryKind !== "markdown" || (draft?.folderId ?? note.folderId ?? null) !== effectiveDailyNotesFolderId) {
      return [];
    }
    const date = dailyNoteDateFromTitle(draft?.title ?? note.title);
    return date ? [date] : [];
  })), [deferredDrafts, effectiveDailyNotesFolderId, notes]);
  const periodicNoteKeys = useMemo(() => {
    const weeks = new Set<string>();
    const months = new Set<string>();
    for (const note of notes) {
      const draft = deferredDrafts[note.id];
      if (
        note.entryKind !== "markdown"
        || (draft?.folderId ?? note.folderId ?? null) !== effectiveDailyNotesFolderId
      ) continue;
      const title = normalizedEntryTitle(draft?.title ?? note.title, "markdown");
      if (/^\d{4}-W\d{2}$/u.test(title)) weeks.add(title);
      if (/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(title)) months.add(title);
    }
    return { months, weeks };
  }, [deferredDrafts, effectiveDailyNotesFolderId, notes]);
  const indexEntries = useMemo<VaultIndexEntry[]>(() => notes.map((note) => ({
    id: note.id,
    path: entryPaths.get(note.id) ?? entryLabel(note),
    kind: note.entryKind,
    content: note.entryKind === "asset"
      ? undefined
      : note.contentFormat === "legacy-html-v1"
        ? previewTextFromHtml(note.body)
        : deferredDrafts[note.id]?.body ?? note.body,
    createdAt: timestampMillis(note.createdAt),
    updatedAt: timestampMillis(note.updatedAt)
  })), [deferredDrafts, entryPaths, notes]);
  useEffect(() => {
    decodedAssetCacheRef.current.retain(new Set(notes.map((note) => note.id)));
  }, [notes]);
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  useEffect(() => {
    if (!pagePreview) return undefined;
    const dismissForViewportChange = () => dismissVaultPagePreview();
    window.addEventListener("resize", dismissForViewportChange);
    window.addEventListener("scroll", dismissForViewportChange, true);
    return () => {
      window.removeEventListener("resize", dismissForViewportChange);
      window.removeEventListener("scroll", dismissForViewportChange, true);
    };
  }, [dismissVaultPagePreview, pagePreview]);
  useEffect(() => {
    return () => {
      clearVaultPagePreviewTimer(pagePreviewOpenTimerRef);
      clearVaultPagePreviewTimer(pagePreviewCloseTimerRef);
      pagePreviewIntentRef.current = null;
      pagePreviewVisibleAnchorRef.current = null;
    };
  }, []);
  const decodedAssetForEntry = useCallback((entryId: string) => {
    const note = noteById.get(entryId);
    if (!note || note.entryKind !== "asset") return null;
    return decodedAssetCacheRef.current.get(
      entryId,
      draftsRef.current[entryId]?.body ?? note.body
    );
  }, [noteById]);
  const draftBodyForCanvasEntry = useCallback(
    (entryId: string, fallback: string) => draftsRef.current[entryId]?.body ?? fallback,
    []
  );
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
  const baseMetadataByEntryId = useMemo<ReadonlyMap<string, BaseMetadata>>(() => {
    if (!knowledgeClient && fallbackKnowledgeIndex) {
      return fallbackKnowledgeIndex.metadataByEntryId;
    }
    return new Map(metadataSummaries.map((summary) => [summary.entryId, {
      aliases: summary.aliases,
      blocks: summary.blocks,
      headings: summary.headings,
      links: summary.links,
      properties: summary.properties,
      tags: summary.tags
    }]));
  }, [fallbackKnowledgeIndex, knowledgeClient, metadataSummaries]);

  useEffect(() => {
    knowledgeSyncGenerationRef.current += 1;
    knowledgeSyncFailureCountRef.current = 0;
    knowledgeForceFullSyncRef.current = false;
    if (knowledgeSyncRetryTimerRef.current !== null) {
      window.clearTimeout(knowledgeSyncRetryTimerRef.current);
      knowledgeSyncRetryTimerRef.current = null;
    }
    knowledgeEntriesRef.current = new Map();
    knowledgeSyncChainRef.current = Promise.resolve();
    setMetadataSummaries([]);
    setIndexedTags([]);
    setKnowledgeVersion(0);
    setWorkerSearchEntryIds(null);
    setWorkerBacklinks([]);
    setWorkerOutgoing([]);
    setWorkerUnlinkedMentions([]);
    setWorkerGlobalSnapshot(null);
    setWorkerLocalSnapshot(null);
  }, [knowledgeClient]);

  useEffect(() => {
    if (!knowledgeClient) return undefined;
    const nextAccessScope = knowledgeAccessScopeSignature(rawNotes, profile.uid);
    const accessScopeChanged = knowledgeAccessScopeRequiresReset(
      knowledgeAccessScopeRef.current,
      nextAccessScope
    );
    knowledgeAccessScopeRef.current = nextAccessScope;
    if (accessScopeChanged) {
      // ACL revocation or same-ID access-scope replacement is a security
      // boundary, not a normal 400 ms content debounce. Terminate the worker
      // synchronously so old plaintext paths/tags cannot answer one more
      // graph/search request, then render only the current safe fallback while
      // a new worker starts.
      knowledgeSyncGenerationRef.current += 1;
      knowledgeEntriesRef.current = new Map();
      knowledgeSyncChainRef.current = Promise.resolve();
      knowledgeForceFullSyncRef.current = true;
      if (knowledgeSyncRetryTimerRef.current !== null) {
        window.clearTimeout(knowledgeSyncRetryTimerRef.current);
        knowledgeSyncRetryTimerRef.current = null;
      }
      setMetadataSummaries([]);
      setIndexedTags([]);
      setWorkerSearchEntryIds(null);
      setWorkerBacklinks([]);
      setWorkerOutgoing([]);
      setWorkerUnlinkedMentions([]);
      setWorkerGlobalSnapshot(null);
      setWorkerLocalSnapshot(null);
      const staleClient = knowledgeClient;
      void staleClient.dispose();
      setKnowledgeClient((current) => current === staleClient ? null : current);
      setKnowledgeClientGeneration((current) => current + 1);
      return undefined;
    }
    const generation = knowledgeSyncGenerationRef.current;
    const snapshot = indexEntries.map((entry) => ({ ...entry }));
    const delay = knowledgeEntriesRef.current.size === 0 ? 0 : 400;
    const timer = window.setTimeout(() => {
      const syncTask = knowledgeSyncChainRef.current.then(async () => {
        if (knowledgeSyncGenerationRef.current !== generation) return;
        const previous = knowledgeEntriesRef.current;
        const next = new Map(snapshot.map((entry) => [entry.id, entry]));
        const removedIds = [...previous.keys()].filter((entryId) => !next.has(entryId));
        const changedEntries = snapshot.filter((entry) => {
          const oldEntry = previous.get(entry.id);
          return !oldEntry || !sameVaultIndexEntry(oldEntry, entry);
        });
        const changeCount = removedIds.length + changedEntries.length;
        const previousOrder = [...previous.keys()];
        const orderChanged = previousOrder.length !== snapshot.length
          || snapshot.some((entry, index) => previousOrder[index] !== entry.id);
        if (changeCount === 0 && !orderChanged) return;
        const useBulkReplace = knowledgeForceFullSyncRef.current
          || previous.size === 0
          || orderChanged
          || changeCount > KNOWLEDGE_BULK_REPLACE_THRESHOLD
          || changeCount > Math.max(20, Math.floor(previous.size * 0.2));
        const changedMetadataEntryIds = new Set<string>([
          ...removedIds,
          ...changedEntries.map((entry) => entry.id)
        ]);
        if (useBulkReplace) {
          const result = await knowledgeClient.replaceVault(snapshot);
          for (const entryId of result.changedMetadataEntryIds) changedMetadataEntryIds.add(entryId);
        } else {
          for (const entryId of removedIds) {
            const result = await knowledgeClient.removeEntry(entryId);
            for (const changedEntryId of result.changedMetadataEntryIds) {
              changedMetadataEntryIds.add(changedEntryId);
            }
          }
          for (const entry of changedEntries) {
            const result = await knowledgeClient.upsertEntry(entry);
            for (const changedEntryId of result.changedMetadataEntryIds) {
              changedMetadataEntryIds.add(changedEntryId);
            }
          }
        }
        if (knowledgeSyncGenerationRef.current !== generation) return;
        const [summaries, tags] = await Promise.all([
          useBulkReplace
            ? knowledgeClient.metadataSummaries()
            : knowledgeClient.metadataSummaries(
              [...changedMetadataEntryIds].filter((entryId) => next.has(entryId))
            ),
          knowledgeClient.tags()
        ]);
        if (knowledgeSyncGenerationRef.current !== generation) return;
        if (useBulkReplace) {
          setMetadataSummaries(summaries);
        } else {
          const removedOrChanged = changedMetadataEntryIds;
          setMetadataSummaries((current) => [
            ...current.filter((summary) => !removedOrChanged.has(summary.entryId)),
            ...summaries
          ]);
        }
        setIndexedTags(tags);
        knowledgeEntriesRef.current = next;
        knowledgeForceFullSyncRef.current = false;
        knowledgeSyncFailureCountRef.current = 0;
        setKnowledgeVersion((version) => version + 1);
      });
      knowledgeSyncChainRef.current = syncTask.catch(() => {
        if (knowledgeSyncGenerationRef.current === generation) {
          const failureCount = knowledgeSyncFailureCountRef.current + 1;
          knowledgeSyncFailureCountRef.current = failureCount;
          knowledgeForceFullSyncRef.current = true;
          if (failureCount <= 3) {
            setError(`지식 인덱스 갱신을 다시 시도합니다 (${failureCount}/3). 평문 내용은 로그에 남기지 않았습니다.`);
            const retryDelay = 250 * (2 ** (failureCount - 1));
            knowledgeSyncRetryTimerRef.current = window.setTimeout(() => {
              knowledgeSyncRetryTimerRef.current = null;
              if (knowledgeSyncGenerationRef.current === generation) {
                setKnowledgeSyncRetry((value) => value + 1);
              }
            }, retryDelay);
          } else {
            knowledgeSyncGenerationRef.current += 1;
            knowledgeEntriesRef.current = new Map();
            setMetadataSummaries([]);
            setIndexedTags([]);
            setWorkerSearchEntryIds(null);
            setWorkerBacklinks([]);
            setWorkerOutgoing([]);
            setWorkerUnlinkedMentions([]);
            setWorkerGlobalSnapshot(null);
            setWorkerLocalSnapshot(null);
            setError("지식 인덱스 worker가 반복 실패해 안전한 메인 스레드 검색으로 전환했습니다. 정규식 검색·필터는 실행하지 않으며 평문 내용은 로그에 남기지 않았습니다.");
            setKnowledgeClient((current) => {
              if (current !== knowledgeClient) return current;
              void knowledgeClient.dispose();
              return null;
            });
          }
        }
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [indexEntries, knowledgeClient, knowledgeSyncRetry, profile.uid, rawNotes]);

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
  const commandPaletteCommands = useMemo<CommandPaletteItem[]>(() => {
    const availableEntryIds = new Set(notes.map((note) => note.id));
    return [
      ...vaultBookmarks.flatMap((bookmark): CommandPaletteItem[] => (
        bookmark.kind === "entry" && !availableEntryIds.has(bookmark.entryId)
          ? []
          : [{
              id: `vault-bookmark:${bookmark.kind}:${bookmark.id}`,
              label: bookmark.label,
              section: "북마크",
              keywords: [bookmark.kind, "bookmark", "북마크"]
            }]
      )),
      ...namedWorkspaces.map((workspace): CommandPaletteItem => ({
        id: `named-workspace:${workspace.id}`,
        label: workspace.label,
        section: "워크스페이스",
        keywords: ["workspace", "layout", "워크스페이스", "배치"]
      }))
    ];
  }, [namedWorkspaces, notes, vaultBookmarks]);

  useEffect(() => {
    if (!workspaceReady) return;
    const requestedEntryId = searchParams.get("entry");
    const requestedEntry = requestedEntryId
      ? notes.find((note) => note.id === requestedEntryId)
      : null;
    if (requestedEntry && handledRequestedEntryRef.current !== requestedEntry.id) {
      initialEntryAutoOpenPendingRef.current = false;
      const requestedTab: WorkspaceTab = {
        id: workspaceEntryTabId(requestedEntry.id, activeTabGroupId),
        kind: "entry",
        entryId: requestedEntry.id,
        ...(activeTabGroupId === "primary" ? {} : { instanceId: activeTabGroupId }),
        label: entryLabel(requestedEntry)
      };
      setTabs((current) => current.some((tab) => tab.id === requestedTab.id)
        ? current
        : [...current, requestedTab]);
      const groupPlan = openWorkspaceTabInGroup(tabGroups, requestedTab.id, activeTabGroupId);
      setTabGroups(groupPlan.groups);
      setActiveTabGroupId(groupPlan.activeTabGroupId);
      setActiveTabId(groupPlan.activeTabId);
      handledRequestedEntryRef.current = requestedEntry.id;
      return;
    }
    if (requestedEntryId) {
      initialEntryAutoOpenPendingRef.current = false;
      return;
    }
    if (requestedWorkspaceView === "graph" || tabs.length) {
      initialEntryAutoOpenPendingRef.current = false;
      return;
    }
    if (!initialEntryAutoOpenPendingRef.current) return;
    const firstEntry = notes[0];
    if (!firstEntry) return;
    initialEntryAutoOpenPendingRef.current = false;
    const tab = { id: `entry:${firstEntry.id}`, kind: "entry", entryId: firstEntry.id, label: entryLabel(firstEntry) } as const;
    setTabs([tab]);
    const groupPlan = openWorkspaceTabInGroup(tabGroups, tab.id, activeTabGroupId);
    setTabGroups(groupPlan.groups);
    setActiveTabGroupId(groupPlan.activeTabGroupId);
    setActiveTabId(groupPlan.activeTabId);
  }, [activeTabGroupId, notes, requestedWorkspaceView, searchParams, tabGroups, tabs.length, workspaceReady]);

  useEffect(() => {
    setTabs((current) => current.map((tab) => {
      if (tab.kind !== "entry") {
        return tab;
      }
      const note = notes.find((candidate) => candidate.id === tab.entryId);
      return note ? { ...tab, label: entryLabel(note) } : tab;
    }));
  }, [notes]);

  useEffect(() => {
    const reconciled = reconcileWorkspaceTabGroups(
      tabGroups,
      storedTabs.map((tab) => tab.id),
      activeTabGroupId,
      activeTabId,
      workspaceGroupOrder
    );
    if (JSON.stringify(reconciled.groups) !== JSON.stringify(tabGroups)) {
      setTabGroups(reconciled.groups);
    }
    if (reconciled.activeTabGroupId !== activeTabGroupId) {
      setActiveTabGroupId(reconciled.activeTabGroupId);
    }
    if (reconciled.activeTabId !== activeTabId) {
      setActiveTabId(reconciled.activeTabId);
    }
    const reconciledLayout = reconcileWorkspaceLayoutGroups(
      workspaceLayout,
      reconciled.groups.map((group) => group.id)
    );
    if (JSON.stringify(reconciledLayout) !== JSON.stringify(workspaceLayout)) {
      setWorkspaceLayout(reconciledLayout);
    }
  }, [activeTabGroupId, activeTabId, storedTabs, tabGroups, workspaceGroupOrder, workspaceLayout]);

  useEffect(() => {
    if (!workspaceReady || !vaultDataReady) return;
    const noteIds = new Set(notes.map((note) => note.id));
    const folderIds = new Set(folders.map((folder) => folder.id));
    const validTabs = storedTabs.filter((tab) => (
      tab.kind === "global-graph"
      || noteIds.has(tab.entryId)
      || pendingCreatedEntryIdsRef.current.has(tab.entryId)
    ));
    if (validTabs.length !== storedTabs.length) {
      setTabs(validTabs);
    }
    if (activeTabId && !validTabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(validTabs[0]?.id ?? null);
    }
    if (selectedFolderId && !folderIds.has(selectedFolderId)) {
      setSelectedFolderId(null);
    }
    setExpandedFolderIds((current) => {
      const valid = new Set([...current].filter((folderId) => folderIds.has(folderId)));
      return valid.size === current.size ? current : valid;
    });
    if (dailyNotesFolderId && !folderIds.has(dailyNotesFolderId)) {
      setDailyNotesFolderId(null);
    }
    if (dailyNotesTemplateEntryId && !noteIds.has(dailyNotesTemplateEntryId)) {
      setDailyNotesTemplateEntryId(null);
    }
    if (
      templatesFolderPath
      && !folders.some((folder) => folderPaths.get(folder.id) === templatesFolderPath)
    ) {
      setTemplatesFolderPath(null);
    }
  }, [activeTabId, dailyNotesFolderId, dailyNotesTemplateEntryId, folderPaths, folders, notes, selectedFolderId, storedTabs, templatesFolderPath, vaultDataReady, workspaceReady]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeEntryId = activeTab?.kind === "entry" ? activeTab.entryId : null;
  const activeNote = activeEntryId ? notes.find((note) => note.id === activeEntryId) ?? null : null;
  const activeDraft = activeEntryId ? drafts[activeEntryId] : undefined;
  const activeMarkdownMayContainConvertibleHtml = Boolean(
    activeNote?.contentFormat === "markdown-v1"
    && activeDraft
    && /^ {0,3}<(?:blockquote|div|h[1-6]|ol|p|pre|table|ul|hr)\b/im.test(activeDraft.body)
  );
  useEffect(() => {
    if (!shouldReleaseVaultEntryCreation(pendingEntryCreation, {
      activeEntryId,
      hasActiveDraft: Boolean(activeDraft),
      hasActiveNote: Boolean(activeNote)
    })) {
      return;
    }
    const createdEntryId = pendingEntryCreation?.entryId;
    if (!createdEntryId) return;
    if (pendingEntryCreationRef.current?.entryId === createdEntryId) {
      pendingEntryCreationRef.current = null;
    }
    setPendingEntryCreation((current) => current?.entryId === createdEntryId ? null : current);
  }, [activeDraft, activeEntryId, activeNote, pendingEntryCreation]);
  useLayoutEffect(() => {
    // Any active-note, ACL/decryption scope, or view transition invalidates the
    // plaintext popup before paint. Nothing from Page Preview is persisted.
    dismissVaultPagePreview();
  }, [activeEntryId, dismissVaultPagePreview, noteById, vaultPlaintextScopeReady, viewMode]);
  const deferredActiveBody = useDeferredValue(activeDraft?.body ?? "");
  const activeMarkdownPluginView = activeNote?.entryKind === "markdown" && activeDraft
    ? detectMarkdownPluginView(activeDraft.body)
    : null;
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
  const unlinkedMentions = activeEntryId
    ? knowledgeClient
      ? workerUnlinkedMentions
      : fallbackKnowledgeIndex ? unlinkedMentionOccurrences(fallbackKnowledgeIndex, activeEntryId) : []
    : [];

  useEffect(() => {
    setEditorInsertRequest((current) => current?.entryId === activeEntryId ? current : null);
    setEditorRevealRequest((current) => current?.entryId === activeEntryId ? current : null);
    setEditorSelection(null);
    setActiveCoreTool(null);
  }, [activeEntryId]);

  const composerEntries = useMemo<ComposerEntrySnapshot[]>(() => notes.flatMap((note) => {
    const draft = drafts[note.id];
    if (
      note.ownerUid !== profile.uid
      || note.contentFormat !== "markdown-v1"
      || note.entryKind !== "markdown"
      || !draft
      || deletingEntryIds.has(note.id)
    ) {
      return [];
    }
    return [{
      body: draft.body,
      contentFormat: "markdown-v1" as const,
      dirty: draft.dirty,
      folderId: draft.folderId,
      id: note.id,
      revision: draft.baseRevision,
      title: draft.title
    }];
  }), [deletingEntryIds, drafts, notes, profile.uid]);
  const activeComposerEntry = activeEntryId
    ? composerEntries.find((entry) => entry.id === activeEntryId) ?? null
    : null;

  useEffect(() => {
    if (
      !workspaceReady
      || !vaultDataReady
      || !vaultPlaintextScopeReady
      || !profile
      || !privateKey
      || !isOnline
      || workspaceConflict
      || workspaceConflictPendingRef.current
    ) {
      return undefined;
    }
    const persistedWorkspace = workspaceStateForSave({
      activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      activeTabGroupId,
      workspaceLayout,
      calendarCursorMonth,
      calendarOpen,
      dailyNotesFolderId,
      dailyNotesTemplateEntryId,
      templatesFolderPath,
      templatesIncludeDescendants,
      expandedFolderIds,
      globalCollapsedSections,
      globalGraphSettings,
      globalViewport: globalViewportRef.current,
      bookmarks: vaultBookmarks,
      graphBookmarks,
      leftMode,
      leftOpen: mobileLayout ? desktopLeftOpenRef.current : leftOpen,
      localCollapsedSections,
      localGraphSettings,
      localViewport: localViewportRef.current,
      namedWorkspaces,
      rightMode,
      rightOpen: mobileLayout ? desktopRightOpenRef.current : rightOpen,
      rightPanelWidth,
      searchQuery,
      searchBookmarks,
      selectedFolderId,
      tabs,
      tabGroups,
      viewMode
    });
    if (!vaultWorkspaceStateFitsEncryptedDocument(persistedWorkspace)) {
      setError("암호화 워크스페이스 상태가 안전 저장 크기를 초과했습니다. 그래프 그룹 또는 북마크를 줄여주세요.");
      return undefined;
    }
    const serialized = JSON.stringify(persistedWorkspace);
    if (serialized === lastSavedWorkspaceRef.current) {
      pendingWorkspaceStateRef.current = null;
      setWorkspaceSavePending(false);
      return undefined;
    }
    pendingWorkspaceStateRef.current = persistedWorkspace;
    setWorkspaceSavePending(true);
    const saveGeneration = workspaceSaveGenerationRef.current;
    const timer = window.setTimeout(() => {
      if (workspaceSaveDebounceTimerRef.current === timer) {
        workspaceSaveDebounceTimerRef.current = null;
      }
      const saveTask = workspaceSaveChainRef.current.then(async () => {
        if (
          workspaceSaveGenerationRef.current !== saveGeneration
          || workspaceConflictPendingRef.current
        ) {
          return;
        }
        if (serialized === lastSavedWorkspaceRef.current) {
          const settled = resolveAlreadyPersistedWorkspaceSave({
            debouncePending: workspaceSaveDebounceTimerRef.current !== null,
            pendingState: pendingWorkspaceStateRef.current,
            scheduledState: persistedWorkspace
          });
          pendingWorkspaceStateRef.current = settled.pendingState;
          setWorkspaceSavePending(settled.savePending);
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
        setLastSavedWorkspaceSerialization(serialized);
        if (pendingWorkspaceStateRef.current === persistedWorkspace) {
          pendingWorkspaceStateRef.current = null;
        }
        setWorkspaceSavePending(
          pendingWorkspaceStateRef.current !== null
          || workspaceSaveDebounceTimerRef.current !== null
        );
      });
      workspaceSaveChainRef.current = saveTask.catch((caught) => {
        if (workspaceSaveGenerationRef.current !== saveGeneration) {
          return;
        }
        if (caught instanceof VaultWorkspaceRevisionConflictError) {
          workspaceConflictPendingRef.current = true;
          const conflictRequestGeneration = workspaceConflictRequestGenerationRef.current + 1;
          workspaceConflictRequestGenerationRef.current = conflictRequestGeneration;
          setError("다른 탭에서 워크스페이스 배치가 변경되었습니다. 현재 배치를 덮어쓰지 않고 비교 선택을 준비합니다.");
          setWorkspaceConflict({
            actualRevision: caught.actualRevision,
            localState: persistedWorkspace,
            remoteState: null
          });
          void loadVaultWorkspaceRecord<VaultWorkspaceState>(profile.uid, privateKey)
            .then((record) => {
              if (
                workspaceSaveGenerationRef.current !== saveGeneration
                || workspaceConflictRequestGenerationRef.current !== conflictRequestGeneration
              ) return;
              setWorkspaceConflict({
                actualRevision: record?.revision ?? caught.actualRevision,
                localState: persistedWorkspace,
                remoteState: record
                  ? vaultWorkspaceForEntryIds(
                      normalizeVaultWorkspaceState(record.state),
                      new Set(notesRef.current.map((note) => note.id))
                    )
                  : null
              });
            })
            .catch(() => {
              if (
                workspaceSaveGenerationRef.current === saveGeneration
                && workspaceConflictRequestGenerationRef.current === conflictRequestGeneration
              ) {
                setWorkspaceConflict({
                  actualRevision: caught.actualRevision,
                  localState: persistedWorkspace,
                  remoteState: null
                });
                setError("서버 워크스페이스를 복호화해 비교하지 못했습니다. 현재 배치는 메모리에 보존했습니다.");
              }
            });
        } else {
          setError("암호화 워크스페이스 상태를 저장하지 못했습니다. 노트 본문 저장에는 영향을 주지 않습니다.");
          workspaceSaveRetryTimerRef.current = window.setTimeout(() => {
            workspaceSaveRetryTimerRef.current = null;
            if (workspaceSaveGenerationRef.current === saveGeneration) {
              setWorkspaceSaveRetry((attempt) => attempt + 1);
            }
          }, 3_000);
        }
      });
    }, 600);
    workspaceSaveDebounceTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (workspaceSaveDebounceTimerRef.current === timer) {
        workspaceSaveDebounceTimerRef.current = null;
      }
    };
  }, [
    activeTabGroupId,
    activeTabId,
    calendarCursorMonth,
    calendarOpen,
    dailyNotesFolderId,
    dailyNotesTemplateEntryId,
    templatesFolderPath,
    templatesIncludeDescendants,
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
    namedWorkspaces,
    mobileLayout,
    isOnline,
    privateKey,
    profile,
    rightMode,
    rightOpen,
    rightPanelWidth,
    searchQuery,
    searchBookmarks,
    selectedFolderId,
    tabs,
    tabGroups,
    vaultDataReady,
    vaultBookmarks,
    vaultPlaintextScopeReady,
    viewMode,
    workspaceLayout,
    workspaceReady,
    workspaceConflict,
    workspaceSaveRetry
  ]);

  useEffect(() => {
    if (!knowledgeClient || knowledgeVersion === 0) {
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    // Never render results from a previous query while the worker evaluates
    // the current query. A failed request must remain visibly empty instead
    // of presenting stale matches as if they belonged to the new expression.
    setWorkerSearchEntryIds(null);
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
          setWorkerSearchEntryIds(null);
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
    setWorkerBacklinks([]);
    setWorkerOutgoing([]);
    setWorkerUnlinkedMentions([]);
    const backlinksPromise = activeEntryId ? knowledgeClient.backlinks(activeEntryId) : Promise.resolve([]);
    const outgoingPromise = activeEntryId ? knowledgeClient.outgoingLinks(activeEntryId) : Promise.resolve([]);
    const unlinkedMentionsPromise = activeEntryId
      ? knowledgeClient.unlinkedMentions(activeEntryId)
      : Promise.resolve([]);
    void Promise.all([backlinksPromise, outgoingPromise, unlinkedMentionsPromise])
      .then(([nextBacklinks, nextOutgoing, nextUnlinkedMentions]) => {
        if (active) {
          setWorkerBacklinks(nextBacklinks);
          setWorkerOutgoing(nextOutgoing);
          setWorkerUnlinkedMentions(nextUnlinkedMentions);
        }
      })
      .catch(() => {
        if (active) {
          setWorkerBacklinks([]);
          setWorkerOutgoing([]);
          setWorkerUnlinkedMentions([]);
          setError("링크 목록을 계산하지 못했습니다.");
        }
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
    setWorkerGlobalSnapshot(null);
    void knowledgeClient.graphSnapshot(
      deferredGlobalGraphDataSettings,
      undefined,
      { signal: controller.signal }
    ).then((snapshot) => {
      if (active) setWorkerGlobalSnapshot(snapshot);
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setWorkerGlobalSnapshot(null);
        setError("전체 그래프를 계산하지 못했습니다.");
      }
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
    setWorkerLocalSnapshot(null);
    void knowledgeClient.graphSnapshot(
      deferredLocalGraphDataSettings,
      activeEntryId ?? undefined,
      { signal: controller.signal }
    ).then((snapshot) => {
      if (active) setWorkerLocalSnapshot(snapshot);
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setWorkerLocalSnapshot(null);
        setError("로컬 그래프를 계산하지 못했습니다.");
      }
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
  const globalSnapshot = vaultPlaintextScopeReady
    ? workerGlobalSnapshot ?? fallbackGlobalSnapshot
    : emptyGraphSnapshot("global");
  const localSnapshot = vaultPlaintextScopeReady
    ? workerLocalSnapshot ?? fallbackLocalSnapshot
    : emptyGraphSnapshot("local");
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
    if (vaultSearchQueryUsesRegex(searchQuery)) {
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

  const fallbackRegexUnavailable = !knowledgeClient && (
    (searchQuery.trim() !== "" && vaultSearchQueryUsesRegex(searchQuery))
    || graphViewSettingsUsesRegex(deferredGlobalGraphDataSettings)
    || graphViewSettingsUsesRegex(deferredLocalGraphDataSettings)
  );

  const visibleTags = vaultPlaintextScopeReady
    ? knowledgeClient
      ? indexedTags
      : [...(fallbackKnowledgeIndex?.tags.values() ?? [])]
    : [];

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
  const completionTags = useMemo(() => vaultPlaintextScopeReady ? (
    knowledgeClient
      ? indexedTags
      : [...(fallbackKnowledgeIndex?.tags.values() ?? [])]
  ).map((tag) => tag.displayName) : [], [
    fallbackKnowledgeIndex,
    indexedTags,
    knowledgeClient,
    vaultPlaintextScopeReady
  ]);
  const markdownCompletionData = {
    currentBlocks: activeMetadata?.blocks.map((block) => block.id) ?? [],
    currentHeadings: activeMetadata?.headings.map((heading) => heading.text) ?? [],
    currentNotePath: activeEntryId ? entryPaths.get(activeEntryId) ?? null : null,
    notes: completionNotes,
    tags: completionTags
  };

  const saveEntry = useCallback(async (
    entryId: string,
    pastedImageSourceCommit?: VaultPastedImageSourceCommitCredential
  ) => {
    // Explicit saves, navigation flushes, and fired idle callbacks all own the
    // next attempt. Cancel only this entry so unrelated notes keep their own
    // idle deadlines.
    entryAutosaveRef.current?.cancel(entryId);
    if (!pastedImageSourceCommit) {
      const blockedRollbacks = blockedPastedImageRollbackReleasesRef.current.get(entryId);
      if (blockedRollbacks) {
        const currentBody = draftsRef.current[entryId]?.body ?? "";
        const rollbackModule = await import("../features/vault/vaultClipboardPasteFlow");
        if (rollbackModule.releaseResolvedVaultClipboardRollbacks(currentBody, blockedRollbacks)) {
          blockedPastedImageRollbackReleasesRef.current.delete(entryId);
        } else {
          setError(rollbackModule.VAULT_CLIPBOARD_ROLLBACK_BLOCKED_MESSAGE);
          return;
        }
      }
      if (pendingClipboardPasteCountsRef.current.has(entryId)) return;
    }
    const scheduleRetry = () => {
      const latestDraft = draftsRef.current[entryId];
      if (!isOnline || !latestDraft?.dirty) return false;
      const failureCount = (entryAutosaveRetryCountsRef.current.get(entryId) ?? 0) + 1;
      entryAutosaveRetryCountsRef.current.set(entryId, failureCount);
      const retryDelay = entryAutosaveRetryDelayMs(failureCount);
      if (retryDelay === null) return false;
      entryAutosaveRef.current?.schedule(
        entryId,
        { draft: latestDraft, failureCount },
        retryDelay,
        () => void saveEntryRef.current(entryId)
      );
      setStatus(`암호화 저장을 ${Math.ceil(retryDelay / 1_000)}초 후 자동으로 다시 시도합니다 (${failureCount}/5).`);
      return true;
    };
    if (!profile || !privateKey || !vaultIntegrityKey) {
      setError("암호화된 이름 무결성 키가 준비될 때까지 Vault 쓰기가 잠깁니다.");
      return;
    }
    const existingMutation = entryMutationPromisesRef.current.get(entryId);
    if (existingMutation) {
      await existingMutation;
      if (draftsRef.current[entryId]?.dirty) {
        await saveEntryRef.current(entryId, pastedImageSourceCommit);
      }
      return;
    }
    const currentNotes = notesRef.current;
    const note = currentNotes.find((candidate) => candidate.id === entryId);
    let draft = draftsRef.current[entryId];
    if (!note || !draft?.dirty || note.contentFormat === "legacy-html-v1") {
      entryAutosaveRetryCountsRef.current.delete(entryId);
      return;
    }
    if (!isOnline) {
      if (pastedImageSourceCommit) {
        setError("서버 연결이 끊겨 이미지 링크를 안전하게 저장하지 못했습니다.");
      } else {
        setSaveFailedEntryIds((current) => new Set(current).add(entryId));
        setStatus("오프라인 · 편집 내용은 현재 세션 메모리에만 보존되며 연결되면 다시 저장합니다.");
      }
      return;
    }
    if (conflictedEntryIds.has(entryId)) {
      return;
    }
    let restoredBlankTitle = false;
    if (draft.title.trim() !== note.title.trim()) {
      if (!draft.title.trim()) {
        restoredBlankTitle = true;
        draft = { ...draft, title: note.title };
        const nextDrafts = { ...draftsRef.current, [entryId]: draft };
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
      } else {
        if (
          vaultNameWritesReady
          || (vaultNameMigrationStatus === "blocked" && vaultNameCollisionTargetIds.has(entryId))
        ) {
          const result = await renameEntryRef.current(entryId, draft.title);
          if (result === "saved" || result === "unchanged") {
            entryAutosaveRetryCountsRef.current.delete(entryId);
          } else if (result === "retryable-failure") {
            setSaveFailedEntryIds((current) => new Set(current).add(entryId));
            if (!scheduleRetry()) {
              setStatus("이름 자동 저장이 반복 실패했습니다. 현재 이름은 이 세션에 보존되어 있으며 다시 입력하거나 저장을 눌러 재시도할 수 있습니다.");
            }
          }
        } else {
          setError("암호화된 이름 예약 검증이 끝난 뒤 항목 이름을 저장할 수 있습니다.");
        }
        return;
      }
    }
    if (!vaultNameWritesReady) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 Vault 저장이 잠깁니다.");
      return;
    }
    const finishEntryMutation = beginEntryMutation(entryId);
    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    setError(null);
    let hasPendingEdits = false;
    const rememberAmbiguousAttempt = () => {
      const captured = canonicalizeDraftTitle(captureRevisionedDraft(draft));
      const existing = (ambiguousEntrySaveAttemptsRef.current.get(entryId) ?? [])
        .filter((attempt) => attempt.baseRevision === captured.baseRevision);
      if (!existing.some((attempt) => sameRevisionedDraft(attempt, captured))) {
        existing.push(captured);
      }
      ambiguousEntrySaveAttemptsRef.current.set(entryId, existing.slice(-5));
    };
    const commitPersistedDraft = (
      result: {
        encryptedBody?: DecryptedVaultNote["encryptedBody"];
        encryptedTitle?: DecryptedVaultNote["encryptedTitle"];
        revision: number;
        vaultNameClaimId?: string;
        vaultNameIndexVersion?: DecryptedVaultNote["vaultNameIndexVersion"];
      },
      submittedDraft: RevisionedEditableDraft
    ) => {
      const canonicalSubmitted = canonicalizeDraftTitle(submittedDraft);
      const latestBeforeCommit = draftsRef.current[entryId];
      const draftAlreadyNewer = Boolean(
        latestBeforeCommit && latestBeforeCommit.baseRevision > result.revision
      );
      const currentCandidate = notesRef.current.find((candidate) => candidate.id === entryId);
      let observedRevision = currentCandidate?.revision ?? result.revision;
      let revisionRelation: ReturnType<typeof persistedRevisionRelation> = currentCandidate
        ? persistedRevisionRelation(currentCandidate.revision, result.revision)
        : "superseded";
      if (draftAlreadyNewer) {
        revisionRelation = "superseded";
        observedRevision = Math.max(observedRevision, latestBeforeCommit?.baseRevision ?? 0);
      }
      const currentRevisionPayloadMatches = currentCandidate
        ? revisionRelation !== "current" || (
            currentCandidate.body === canonicalSubmitted.body
            && (currentCandidate.folderId ?? null) === canonicalSubmitted.folderId
            && currentCandidate.title === canonicalSubmitted.title
          )
        : false;
      commitNotes((current) => current.map((candidate) => {
        if (candidate.id !== entryId) return candidate;
        if (revisionRelation !== "apply") return candidate;
        return {
          ...candidate,
          ...persistedEncryptedMutationPatch(result),
          title: canonicalSubmitted.title,
          body: canonicalSubmitted.body,
          folderId: canonicalSubmitted.folderId,
          revision: result.revision
        };
      }));
      const latest = draftsRef.current[entryId];
      if (revisionRelation === "superseded" || !currentRevisionPayloadMatches) {
        hasPendingEdits = Boolean(latest?.dirty);
        const requiresConflict = !currentRevisionPayloadMatches
          || Boolean(latest?.dirty && latest.baseRevision < observedRevision);
        if (requiresConflict) {
          setConflictedEntryIds((current) => new Map(current).set(entryId, observedRevision));
          setError("저장 응답보다 최신 서버 revision을 유지했습니다. 현재 편집본은 덮어쓰지 않고 서버 최신본과 비교합니다.");
        } else {
          setStatus("늦게 도착한 저장 응답은 적용하지 않고 이미 수신한 최신 서버 revision을 유지했습니다.");
        }
        setSaveFailedEntryIds((current) => {
          const next = new Set(current);
          next.delete(entryId);
          return next;
        });
        entryAutosaveRetryCountsRef.current.delete(entryId);
        return requiresConflict ? "conflict" as const : "superseded" as const;
      }
      if (latest) {
        const reconciled = reconcileDraftAfterSave(latest, canonicalSubmitted, result.revision);
        hasPendingEdits = reconciled.dirty;
        if (reconciled.dirty && isMarkdownMergeEntry(note)) {
          draftBaseSnapshotsRef.current.set(entryId, {
            baseRevision: result.revision,
            body: canonicalSubmitted.body,
            contentFormat: "markdown-v1",
            entryKind: "markdown",
            folderId: canonicalSubmitted.folderId,
            ownerUid: note.ownerUid,
            title: canonicalSubmitted.title
          });
        } else {
          draftBaseSnapshotsRef.current.delete(entryId);
        }
        const nextDrafts = { ...draftsRef.current, [entryId]: reconciled };
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
      } else {
        draftBaseSnapshotsRef.current.delete(entryId);
      }
      setSaveFailedEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      entryAutosaveRetryCountsRef.current.delete(entryId);
      if (
        pathRewriteRecoveryFailureCountRef.current > 0
        && !pathRewriteBusyRef.current
      ) {
        pathRewriteRecoveryFailureCountRef.current = 0;
        setPathRewriteRecoveryRetry((current) => current + 1);
      }
      setConflictedEntryIds((current) => {
        const next = new Map(current);
        next.delete(entryId);
        return next;
      });
      setDraftMergeConflict((current) => current?.entryId === entryId ? null : current);
      setStatus(restoredBlankTitle
        ? "빈 이름은 저장하지 않고 기존 이름을 유지했으며 Markdown 본문은 암호화 저장했습니다."
        : hasPendingEdits
          ? "저장 중 추가된 편집을 보존했습니다. 다음 revision으로 계속 저장합니다."
          : "Markdown 원본과 암호화 이력을 저장했습니다.");
      return "committed" as const;
    };
    try {
      let submittedDraft: RevisionedEditableDraft = canonicalizeDraftTitle(captureRevisionedDraft(draft));
      let result: Parameters<typeof commitPersistedDraft>[0];
      const currentRevision = note.revision ?? 0;
      if (currentRevision !== draft.baseRevision) {
        const confirmedSubmission = findConfirmedDraftSubmission({
          body: note.body,
          folderId: note.folderId ?? null,
          revision: currentRevision,
          title: note.title
        }, [
          ...(ambiguousEntrySaveAttemptsRef.current.get(entryId) ?? []),
          canonicalizeDraftTitle(captureRevisionedDraft(draft))
        ]);
        if (!confirmedSubmission) {
          throw new NoteRevisionConflictError(draft.baseRevision, currentRevision);
        }
        submittedDraft = confirmedSubmission;
        result = {
          encryptedBody: note.encryptedBody,
          encryptedTitle: note.encryptedTitle,
          revision: currentRevision,
          vaultNameClaimId: note.vaultNameClaimId,
          vaultNameIndexVersion: note.vaultNameIndexVersion
        };
      } else {
        try {
          result = await saveEncryptedVaultEntry(
            note,
            profile.uid,
            privateKey,
            vaultIntegrityKey,
            draft,
            undefined,
            pastedImageSourceCommit
          );
        } catch (caught) {
          if (ambiguousVaultSaveFailure(caught)) rememberAmbiguousAttempt();
          const pendingAttempts = ambiguousEntrySaveAttemptsRef.current.get(entryId) ?? [];
          if (!ambiguousVaultSaveFailure(caught) && !(caught instanceof NoteRevisionConflictError && pendingAttempts.length)) {
            throw caught;
          }
          let remote: DecryptedVaultNote | null = null;
          try {
            remote = await readCurrentServerVaultEntry(entryId);
          } catch {
            // The original error remains authoritative when a bounded
            // read-after-timeout cannot prove whether the write committed.
          }
          const remoteRevision = remote?.revision ?? 0;
          const confirmedSubmission = remote ? findConfirmedDraftSubmission({
            body: remote.body,
            folderId: remote.folderId ?? null,
            revision: remoteRevision,
            title: remote.title
          }, pendingAttempts) : null;
          if (!remote || !confirmedSubmission) throw caught;
          submittedDraft = confirmedSubmission;
          result = {
            encryptedBody: remote.encryptedBody,
            encryptedTitle: remote.encryptedTitle,
            revision: remoteRevision,
            vaultNameClaimId: remote.vaultNameClaimId,
            vaultNameIndexVersion: remote.vaultNameIndexVersion
          };
        }
      }
      ambiguousEntrySaveAttemptsRef.current.delete(entryId);
      const commitOutcome = commitPersistedDraft(result, submittedDraft);
      if (
        commitOutcome === "conflict"
        && draftsRef.current[entryId]?.dirty
        && isMarkdownMergeEntry(note)
      ) {
        void prepareDraftMergeConflict(entryId, false);
      }
    } catch (caught) {
      if (caught instanceof NoteRevisionConflictError) {
        ambiguousEntrySaveAttemptsRef.current.delete(entryId);
        entryAutosaveRetryCountsRef.current.delete(entryId);
        setConflictedEntryIds((current) => new Map(current).set(entryId, caught.actualRevision));
        setError("다른 기기나 탭에서 이 노트가 변경되었습니다. 현재 편집본은 유지되며 서버 최신본을 안전하게 확인합니다.");
        if (isMarkdownMergeEntry(note)) {
          void prepareDraftMergeConflict(entryId, false);
        }
      } else {
        if (!pastedImageSourceCommit) {
          setSaveFailedEntryIds((current) => new Set(current).add(entryId));
        }
        setError(caught instanceof Error ? caught.message : "노트를 저장하지 못했습니다.");
        if (!pastedImageSourceCommit && !scheduleRetry()) {
          setStatus("자동 저장이 반복 실패했습니다. 현재 편집본은 이 세션에 보존되어 있으며 다시 입력하거나 저장을 눌러 재시도할 수 있습니다.");
        }
      }
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      finishEntryMutation();
    }
  }, [
    beginEntryMutation,
    commitNotes,
    conflictedEntryIds,
    isOnline,
    privateKey,
    prepareDraftMergeConflict,
    profile,
    readCurrentServerVaultEntry,
    vaultIntegrityKey,
    vaultNameWritesReady,
    vaultNameCollisionTargetIds,
    vaultNameMigrationStatus
  ]);

  useEffect(() => {
    saveEntryRef.current = saveEntry;
  }, [saveEntry]);

  useEffect(() => {
    const reconnected = isOnline && !previousOnlineRef.current;
    previousOnlineRef.current = isOnline;
    if (!reconnected) return;
    pathRewriteRecoveryFailureCountRef.current = 0;
    setStatus("연결이 복구되어 저장하지 못한 노트를 다시 저장합니다…");
    for (const entryId of saveFailedEntryIds) {
      void saveEntry(entryId);
    }
  }, [isOnline, saveEntry, saveFailedEntryIds]);

  async function flushDirtyEntries() {
    const dirtyEntryIds = Object.entries(draftsRef.current)
      .filter(([, draft]) => draft.dirty)
      .map(([entryId]) => entryId);
    if (!dirtyEntryIds.length) {
      return true;
    }
    setStatus("이동하기 전에 편집 내용을 저장하는 중입니다…");
    for (const entryId of dirtyEntryIds) {
      const existingMutation = entryMutationPromisesRef.current.get(entryId);
      if (existingMutation) {
        await existingMutation;
      }
      await saveEntryRef.current(entryId);
    }
    const remaining = Object.values(draftsRef.current).filter((draft) => draft.dirty).length;
    if (!remaining) {
      return true;
    }
    return window.confirm(`${remaining}개 항목을 아직 저장하지 못했습니다. 지금 이동하면 현재 세션의 저장되지 않은 편집을 잃을 수 있습니다. 그래도 이동할까요?`);
  }

  async function flushWorkspaceBeforeExit() {
    commitPendingGraphViewports();
    if (!workspaceReady) {
      if (workspaceInteractionDuringLoadRef.current) {
        setError("서버 워크스페이스를 확인하는 중입니다. 현재 배치를 안전하게 비교한 뒤 이동해주세요.");
        return false;
      }
      return true;
    }
    if (workspaceConflict || workspaceConflictPendingRef.current) {
      setError("워크스페이스 배치 충돌을 먼저 선택해주세요.");
      return false;
    }

    cancelScheduledWorkspaceSave();
    const initialLatest = latestWorkspaceStateRef.current;
    if (!vaultWorkspaceStateFitsEncryptedDocument(initialLatest)) {
      setError("암호화 워크스페이스 상태가 안전 저장 크기를 초과해 화면 이동을 중단했습니다. 그래프 그룹 또는 북마크를 줄여주세요.");
      return false;
    }
    const initialSerialized = JSON.stringify(initialLatest);
    if (initialSerialized === lastSavedWorkspaceRef.current) return true;
    if (!isOnline) {
      return window.confirm("오프라인이라 마지막 탭·패널 배치를 서버에 저장할 수 없습니다. 노트 편집본과 현재 배치는 이 세션에만 남습니다. 그래도 이동할까요?");
    }
    const saveGeneration = workspaceSaveGenerationRef.current;
    try {
      const flushResult = await flushLatestWorkspaceState({
        getCurrentState: () => latestWorkspaceStateRef.current,
        getLastSavedSerialization: () => lastSavedWorkspaceRef.current,
        save: async (latest, serialized) => {
          const saveTask = workspaceSaveChainRef.current.then(async () => {
            if (workspaceConflictPendingRef.current) return false;
            const result = await saveVaultWorkspace(
              profile,
              privateKey,
              latest as unknown as VaultWorkspaceState,
              workspaceRevisionRef.current
            );
            if (workspaceSaveGenerationRef.current !== saveGeneration) return false;
            workspaceRevisionRef.current = result.revision;
            lastSavedWorkspaceRef.current = serialized;
            setLastSavedWorkspaceSerialization(serialized);
            const pending = pendingWorkspaceStateRef.current;
            if (pending && JSON.stringify(pending) === serialized) {
              pendingWorkspaceStateRef.current = null;
            }
            setWorkspaceSavePending(
              pendingWorkspaceStateRef.current !== null
              || workspaceSaveDebounceTimerRef.current !== null
            );
            return true;
          });
          workspaceSaveChainRef.current = saveTask.then(() => undefined).catch(() => undefined);
          if (!await saveTask) {
            throw new Error("워크스페이스 저장 상태가 변경되어 이동을 중단했습니다.");
          }
        }
      });
      if (!flushResult.stable) {
        setError("탭·패널 배치가 계속 변경되어 최신 상태 저장을 확인하지 못했습니다. 잠시 후 다시 이동해주세요.");
        return false;
      }
      const pending = pendingWorkspaceStateRef.current;
      if (pending && JSON.stringify(pending) === lastSavedWorkspaceRef.current) {
        pendingWorkspaceStateRef.current = null;
      }
      return !workspaceConflictPendingRef.current;
    } catch (caught) {
      if (caught instanceof VaultWorkspaceRevisionConflictError) {
        workspaceConflictPendingRef.current = true;
        const requestGeneration = workspaceConflictRequestGenerationRef.current + 1;
        workspaceConflictRequestGenerationRef.current = requestGeneration;
        setWorkspaceConflict({
          actualRevision: caught.actualRevision,
          localState: latestWorkspaceStateRef.current,
          remoteState: null
        });
        setError("다른 탭의 워크스페이스 배치와 충돌했습니다. 어느 쪽도 덮어쓰지 않았습니다.");
        void loadVaultWorkspaceRecord<VaultWorkspaceState>(profile.uid, privateKey)
          .then((record) => {
            if (workspaceConflictRequestGenerationRef.current !== requestGeneration) return;
            setWorkspaceConflict({
              actualRevision: record?.revision ?? caught.actualRevision,
              localState: latestWorkspaceStateRef.current,
              remoteState: record
                ? vaultWorkspaceForEntryIds(
                    normalizeVaultWorkspaceState(record.state),
                    new Set(notesRef.current.map((note) => note.id))
                  )
                : null
            });
          })
          .catch(() => undefined);
        return false;
      }
      setError("마지막 워크스페이스 배치를 저장하지 못해 화면 이동을 중단했습니다.");
      return false;
    }
  }

  async function flushVaultBeforeExit() {
    return await flushDirtyEntries() && await flushWorkspaceBeforeExit();
  }

  useEffect(() => {
    const preventAccidentalUnload = (event: BeforeUnloadEvent) => {
      const hasDirtyDrafts = Object.values(draftsRef.current).some((draft) => draft.dirty);
      const hasUnsavedWorkspace = workspaceInteractionDuringLoadRef.current || (
        workspaceReady
        && (
          JSON.stringify(latestWorkspaceStateRef.current) !== lastSavedWorkspaceRef.current
          || pendingWorkspaceStateRef.current !== null
          || workspaceSaveDebounceTimerRef.current !== null
          || workspaceConflictPendingRef.current
        )
      );
      if (!hasDirtyDrafts && !hasUnsavedWorkspace) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalUnload);
    return () => window.removeEventListener("beforeunload", preventAccidentalUnload);
  }, [workspaceReady]);

  async function navigateAfterSaving(destination: string) {
    if (await flushVaultBeforeExit()) {
      navigate(destination);
    }
  }

  useEffect(() => {
    const autosave = entryAutosaveRef.current;
    if (!autosave) return;
    const dirtyEntryIds = new Set<string>();
    for (const [entryId, draft] of Object.entries(drafts)) {
      if (!draft.dirty || conflictedEntryIds.has(entryId)) continue;
      dirtyEntryIds.add(entryId);
      const entryKind = notesRef.current.find((note) => note.id === entryId)?.entryKind;
      autosave.schedule(
        entryId,
        draft,
        vaultEntryAutosaveIdleMs(entryKind),
        () => void saveEntryRef.current(entryId)
      );
    }
    autosave.retain(dirtyEntryIds);
  }, [conflictedEntryIds, drafts, isOnline, privateKey, profile, vaultIntegrityKey, vaultNameWritesReady]);

  useEffect(() => () => {
    entryAutosaveRef.current?.cancelAll();
    entryAutosaveRetryCountsRef.current.clear();
  }, []);

  function updateEntryDraft(
    entryId: string,
    patch: Partial<Omit<DraftState, "dirty" | "baseRevision">>
  ) {
    if (deletingEntryIdsRef.current.has(entryId)) {
      return;
    }
    entryAutosaveRetryCountsRef.current.delete(entryId);
    const note = notesRef.current.find((candidate) => candidate.id === entryId);
    const currentDraft = draftsRef.current[entryId];
    if (
      note?.entryKind === "markdown"
      && patch.body !== undefined
      && patch.body !== currentDraft?.body
    ) {
      markdownDraftRevisionRef.current += 1;
    }
    if (!currentDraft?.dirty) {
      captureMarkdownDraftBase(entryId, note, currentDraft);
    }
    const next = {
      ...draftsRef.current,
      [entryId]: {
          ...(currentDraft ?? {
          baseRevision: note?.revision ?? 0,
          title: "",
          body: "",
          folderId: null
          }),
          ...patch,
          dirty: true
      }
    };
    draftsRef.current = next;
    setDrafts(next);
    setSaveFailedEntryIds((current) => {
      const next = new Set(current);
      next.delete(entryId);
      return next;
    });
  }

  function updateActiveDraft(patch: Partial<Omit<DraftState, "dirty" | "baseRevision">>) {
    if (activeEntryId) updateEntryDraft(activeEntryId, patch);
  }

  const createUnlinkedMentionLink = useCallback((occurrence: UnlinkedMentionOccurrence) => {
    if (pathRewriteBusyRef.current || deletingEntryIdsRef.current.has(occurrence.sourceEntryId)) {
      setError("경로 변경이나 휴지통 이동이 끝난 뒤 링크를 만들어주세요.");
      return;
    }
    if (conflictedEntryIds.has(occurrence.sourceEntryId)) {
      setError("원본 노트의 저장 충돌을 먼저 해결해주세요. 현재 초안은 덮어쓰지 않았습니다.");
      return;
    }
    const sourceNote = notesRef.current.find((note) => note.id === occurrence.sourceEntryId);
    const sourceDraft = draftsRef.current[occurrence.sourceEntryId];
    const targetEntry = indexEntryById.get(occurrence.targetEntryId);
    if (
      !sourceNote
      || sourceNote.entryKind !== "markdown"
      || sourceNote.contentFormat !== "markdown-v1"
      || !sourceDraft
      || !targetEntry
      || targetEntry.kind !== "markdown"
    ) {
      setError("현재 지식 범위에서 수정 가능한 Markdown 원본을 찾지 못했습니다.");
      return;
    }

    const edit = createUnlinkedMentionWikilinkEdit(
      sourceDraft.body,
      occurrence,
      targetEntry.path
    );
    if (edit.status !== "applied") {
      setError(edit.status === "stale-occurrence"
        ? "원본 노트가 바뀌어 이전 언급 위치를 사용하지 않았습니다. 인덱스 갱신 후 다시 시도해주세요."
        : "현재 경로로 안전한 Wikilink를 만들 수 없습니다.");
      return;
    }

    const latest = draftsRef.current[occurrence.sourceEntryId];
    if (!latest || latest.body !== sourceDraft.body) {
      setError("원본 노트가 방금 변경되어 링크를 만들지 않았습니다. 최신 언급에서 다시 시도해주세요.");
      return;
    }
    if (!latest.dirty) {
      captureMarkdownDraftBase(occurrence.sourceEntryId, sourceNote, latest);
    }
    const nextDrafts = {
      ...draftsRef.current,
      [occurrence.sourceEntryId]: {
        ...latest,
        body: edit.markdown,
        dirty: true
      }
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setSaveFailedEntryIds((current) => {
      const next = new Set(current);
      next.delete(occurrence.sourceEntryId);
      return next;
    });
    setWorkerUnlinkedMentions((current) => current.filter((candidate) => !(
      candidate.sourceEntryId === occurrence.sourceEntryId
      && candidate.targetEntryId === occurrence.targetEntryId
      && candidate.startOffset === occurrence.startOffset
      && candidate.endOffset === occurrence.endOffset
    )));
    setError(null);
    setStatus("연결되지 않은 언급을 Wikilink로 바꾸고 revision 확인 저장을 예약했습니다.");
    window.setTimeout(() => void saveEntryRef.current(occurrence.sourceEntryId), 0);
  }, [captureMarkdownDraftBase, conflictedEntryIds, indexEntryById]);

  function openEntry(
    entryId: string,
    intent: GraphOpenIntent = { target: "current" },
    newGroupDirection: VaultWorkspaceSplitDirection = "vertical"
  ) {
    if (pendingEntryCreationRef.current) {
      setStatus("새 항목의 암호화 생성이 끝난 뒤 다른 탭을 열 수 있습니다.");
      return;
    }
    if (deletingEntryIdsRef.current.has(entryId)) {
      setStatus("휴지통으로 이동 중인 항목은 작업이 끝난 뒤 다시 열 수 있습니다.");
      return;
    }
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
    const newGroupPlan = intent.target === "new-group"
      ? planWorkspaceGroupSplit(newGroupDirection)
      : null;
    if (intent.target === "new-group" && !newGroupPlan) return;
    const targetGroupId: WorkspaceTabGroupId = newGroupPlan?.groupId ?? activeTabGroupId;
    const targetGroup = tabGroups.find((group) => group.id === targetGroupId);
    const existingTargetTab = tabs.find((tab) => (
      tab.kind === "entry"
      && tab.entryId === entryId
      && targetGroup?.tabIds.includes(tab.id)
    ));
    const nextTab: WorkspaceTab = existingTargetTab ?? {
      id: workspaceEntryTabId(entryId, targetGroupId),
      kind: "entry",
      entryId,
      ...(targetGroupId === "primary" ? {} : { instanceId: targetGroupId }),
      label: entryLabel(note)
    };
    const activeGroup = tabGroups.find((group) => group.id === activeTabGroupId);
    const activeWorkspaceTab = tabs.find((tab) => tab.id === activeGroup?.activeTabId);
    const tabAlreadyOpen = tabs.some((tab) => tab.id === nextTab.id);
    const replaceTabId = !tabAlreadyOpen && intent.target === "current" && activeWorkspaceTab && !activeWorkspaceTab.pinned
      ? activeWorkspaceTab.id
      : null;
    setTabs((current) => {
      if (current.some((tab) => tab.id === nextTab.id)) {
        return current;
      }
      if (replaceTabId) {
        return current.map((tab) => tab.id === replaceTabId ? nextTab : tab);
      }
      return [...current, nextTab];
    });
    const groupPlan = openWorkspaceTabInGroup(tabGroups, nextTab.id, targetGroupId, replaceTabId);
    if (newGroupPlan) setWorkspaceLayout(newGroupPlan.layout);
    setTabGroups(groupPlan.groups);
    setActiveTabGroupId(groupPlan.activeTabGroupId);
    setActiveTabId(groupPlan.activeTabId);
    if (mobileLayout) {
      setLeftOpen(false);
      setRightOpen(false);
    }
  }

  async function createEntry(
    kind: CreatableVaultEntryKind,
    titleBase?: string,
    body?: string,
    options: CreateVaultEntryOptions = {}
  ): Promise<boolean> {
    const requestedFolderId = options.folderId === undefined ? selectedFolderId : options.folderId;
    if (
      requestedFolderId !== null
      && folderTrashLockedFolderIdsRef.current.has(requestedFolderId)
    ) {
      setError("폴더 휴지통 처리가 끝난 뒤 새 항목을 만들어주세요.");
      return false;
    }
    if (pendingEntryCreationRef.current) {
      setError("새 항목의 암호화 생성이 끝난 뒤 다시 시도해주세요.");
      return false;
    }
    if (!profile || !vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      setError(pathRewriteBusyRef.current
        ? "내부 참조 갱신이 끝난 뒤 새 항목을 만들어주세요."
        : "암호화된 이름 무결성 키가 준비될 때까지 새 항목을 만들 수 없습니다.");
      return false;
    }
    const creationRequest: PendingVaultEntryCreation = { entryId: null, kind };
    pendingEntryCreationRef.current = creationRequest;
    setPendingEntryCreation(creationRequest);
    setError(null);
    let handedOffToActiveDraft = false;
    try {
      const folderId = requestedFolderId;
      const requestedTitle = titleBase ?? (kind === "canvas" ? "새 캔버스" : kind === "base" ? "새 Base" : "새 노트");
      const ownedNotes = notes.filter((note) => note.ownerUid === profile.uid);
      const collision = options.preserveRequestedTitle
        ? ownedNotes.find((note) => (
            (note.folderId ?? null) === folderId
            && normalizedEntryTitle(note.title, note.entryKind) === normalizedEntryTitle(requestedTitle, kind)
          ))
        : undefined;
      if (collision) {
        openEntry(collision.id);
        return false;
      }
      const title = options.preserveRequestedTitle
        ? requestedTitle.trim().normalize("NFC")
        : uniqueTitle(ownedNotes, requestedTitle, folderId, kind);
      const result = kind === "markdown"
        ? await createMarkdownVaultNote(profile, vaultIntegrityKey, { body: body ?? "", folderId, title })
        : await createEncryptedVaultEntry(profile, vaultIntegrityKey, kind === "canvas" ? {
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
      const tab: WorkspaceTab = {
        id: workspaceEntryTabId(result.noteId, activeTabGroupId),
        kind: "entry",
        entryId: result.noteId,
        ...(activeTabGroupId === "primary" ? {} : { instanceId: activeTabGroupId }),
        label: title
      };
      if (!vaultPageMountedRef.current) {
        return false;
      }
      const createdEntry: PendingVaultEntryCreation = { entryId: result.noteId, kind };
      pendingEntryCreationRef.current = createdEntry;
      setPendingEntryCreation(createdEntry);
      pendingCreatedEntryIdsRef.current.add(result.noteId);
      setTabs((current) => [...current.filter((item) => item.id !== tab.id), tab]);
      const groupPlan = openWorkspaceTabInGroup(tabGroups, tab.id, activeTabGroupId);
      setTabGroups(groupPlan.groups);
      setActiveTabGroupId(groupPlan.activeTabGroupId);
      setActiveTabId(groupPlan.activeTabId);
      if (mobileLayout) {
        setLeftOpen(false);
        setRightOpen(false);
      }
      setStatus(kind === "canvas"
        ? "암호화 Canvas를 만들었습니다."
        : kind === "base"
          ? "암호화 Base를 만들었습니다."
          : "Markdown 노트를 만들었습니다.");
      handedOffToActiveDraft = true;
      return true;
    } catch (caught) {
      if (vaultPageMountedRef.current) {
        setError(caught instanceof Error ? caught.message : "새 항목을 만들지 못했습니다.");
      }
      return false;
    } finally {
      if (!handedOffToActiveDraft && pendingEntryCreationRef.current === creationRequest) {
        pendingEntryCreationRef.current = null;
        if (vaultPageMountedRef.current) {
          setPendingEntryCreation(null);
        }
      }
    }
  }

  async function createUnresolvedMarkdownEntry(requestedPath: string) {
    if (!profile || !vaultIntegrityKey || !vaultNameWritesReady) {
      setError("암호화된 이름 무결성 키가 준비될 때까지 링크 노트를 만들 수 없습니다.");
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
          vaultIntegrityKey,
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
    if (pendingEntryCreationRef.current) {
      setStatus("새 항목의 암호화 생성이 끝난 뒤 그래프를 열 수 있습니다.");
      return;
    }
    const tab: WorkspaceTab = { id: "global-graph", kind: "global-graph", label: "그래프 보기" };
    if (activeTabId !== tab.id) {
      setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
      const groupPlan = openWorkspaceTabInGroup(tabGroups, tab.id, activeTabGroupId);
      setTabGroups(groupPlan.groups);
      setActiveTabGroupId(groupPlan.activeTabGroupId);
      setActiveTabId(groupPlan.activeTabId);
    }
    if (mobileLayout) {
      setLeftOpen(false);
      setRightOpen(false);
    }
  }, [activeTabGroupId, activeTabId, mobileLayout, tabGroups]);

  useEffect(() => {
    if (!workspaceReady) {
      return;
    }

    const routeIntentKey = JSON.stringify([
      profile.uid,
      location.key,
      requestedWorkspaceView,
      requestedWorkspacePanel
    ]);
    if (handledWorkspaceRouteIntentRef.current === routeIntentKey) {
      return;
    }
    // A route is an opening intent, not a permanently controlled panel state.
    // Mark it handled before applying it so subsequent callback/state changes
    // cannot reopen a panel that the user deliberately closed.
    handledWorkspaceRouteIntentRef.current = routeIntentKey;

    if (requestedWorkspaceView === "graph") {
      openGlobalGraph();
      return;
    }

    if (
      requestedWorkspacePanel === "files"
      || requestedWorkspacePanel === "search"
      || requestedWorkspacePanel === "tags"
      || requestedWorkspacePanel === "bookmarks"
    ) {
      showLeftPanel(requestedWorkspacePanel);
    }
  }, [
    location.key,
    openGlobalGraph,
    profile.uid,
    requestedWorkspacePanel,
    requestedWorkspaceView,
    showLeftPanel,
    workspaceReady
  ]);

  function closeTab(tabId: string) {
    if (pendingEntryCreationRef.current) {
      setStatus("새 항목의 암호화 생성이 끝난 뒤 탭을 닫을 수 있습니다.");
      return;
    }
    const closingTab = tabs.find((tab) => tab.id === tabId);
    const ownerGroup = tabGroups.find((group) => group.tabIds.includes(tabId));
    const groupTabs = ownerGroup
      ? ownerGroup.tabIds.flatMap((id) => {
          const tab = tabs.find((candidate) => candidate.id === id);
          return tab ? [tab] : [];
        })
      : tabs;
    const plan = planWorkspaceTabClose(groupTabs, tabId, ownerGroup?.activeTabId ?? activeTabId);
    if (plan.blocked) {
      setStatus("고정된 탭입니다. 고정을 해제한 뒤 닫아주세요.");
      return;
    }
    if (closingTab?.kind === "entry") {
      void saveEntry(closingTab.entryId);
    }
    // Closing a tab is an explicit workspace choice. In particular, closing
    // the final tab must not re-arm the first-time Vault auto-open behavior.
    initialEntryAutoOpenPendingRef.current = false;
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    const groupsPlan = removeWorkspaceTabFromGroups(tabGroups, tabId, activeTabGroupId);
    setTabGroups(groupsPlan.groups);
    setWorkspaceLayout((current) => reconcileWorkspaceLayoutGroups(
      current,
      groupsPlan.groups.map((group) => group.id)
    ));
    setActiveTabGroupId(groupsPlan.activeTabGroupId);
    setActiveTabId(groupsPlan.activeTabId);
  }

  function activateTabInGroup(groupId: WorkspaceTabGroupId, tabId?: string | null) {
    if (pendingEntryCreationRef.current) {
      setStatus("새 항목의 암호화 생성이 끝난 뒤 탭을 전환할 수 있습니다.");
      return;
    }
    const plan = activateWorkspaceTabGroup(tabGroups, groupId, tabId);
    if (activeEntryId && plan.activeTabId !== activeTabId) {
      void saveEntry(activeEntryId);
    }
    setTabGroups(plan.groups);
    setActiveTabGroupId(plan.activeTabGroupId);
    setActiveTabId(plan.activeTabId);
  }

  function planWorkspaceGroupSplit(direction: VaultWorkspaceSplitDirection) {
    if (workspaceGroupOrder.length >= MAXIMUM_WORKSPACE_PANES) {
      setError(`분할 창은 최대 ${MAXIMUM_WORKSPACE_PANES}개까지 열 수 있습니다.`);
      return null;
    }
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const groupId = `pane_${token}`;
    try {
      return {
        groupId,
        layout: splitWorkspacePane({
          direction,
          layout: workspaceLayout,
          newGroupId: groupId,
          splitId: `split_${token}`,
          targetGroupId: activeTabGroupId
        })
      };
    } catch (caught) {
      setError(caught instanceof Error && caught.message === "workspace-layout-depth-limit"
        ? "이 pane은 최대 중첩 깊이에 도달했습니다. 더 바깥 pane을 활성화한 뒤 분할해주세요."
        : "현재 워크스페이스 pane을 안전하게 분할할 수 없습니다.");
      return null;
    }
  }

  function splitActiveWorkspacePane(direction: VaultWorkspaceSplitDirection) {
    if (activeTab?.kind !== "entry") {
      setError("노트·Canvas·Base 탭을 연 뒤 새 탭 그룹으로 분할해주세요.");
      return;
    }
    openEntry(activeTab.entryId, { target: "new-group" }, direction);
  }

  function toggleTabPinned(tabId: string) {
    setTabs((current) => toggleWorkspaceTabPinned(current, tabId));
  }

  async function createFolder() {
    if (pendingEntryCreationRef.current) {
      setError("새 항목의 암호화 생성이 끝난 뒤 새 폴더를 만들어주세요.");
      return;
    }
    if (!profile || !vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      setError(pathRewriteBusyRef.current
        ? "내부 참조 갱신이 끝난 뒤 새 폴더를 만들어주세요."
        : "암호화된 이름 무결성 키가 준비될 때까지 폴더를 만들 수 없습니다.");
      return;
    }
    if (
      selectedFolderId !== null
      && folderTrashLockedFolderIdsRef.current.has(selectedFolderId)
    ) {
      setError("폴더 휴지통 처리가 끝난 뒤 하위 폴더를 만들어주세요.");
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
      await createEncryptedVaultFolder(profile, vaultIntegrityKey, name, selectedFolderId, folders.length);
      setStatus("암호화 폴더를 만들었습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "폴더를 만들지 못했습니다.");
    }
  }

  async function migrateFolders() {
    if (!profile || !vaultIntegrityKey || !vaultNameWritesReady || folderMigrationBusy) {
      if (!vaultIntegrityKey) {
        setError("암호화된 이름 무결성 키가 준비될 때까지 폴더 마이그레이션을 시작할 수 없습니다.");
      }
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
        await migrateLegacyVaultFolder(profile, vaultIntegrityKey, folder, index);
      }
      setStatus(`${legacyFolders.length}개 폴더 이름을 암호화했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "폴더 암호화 마이그레이션을 완료하지 못했습니다.");
    } finally {
      setFolderMigrationBusy(false);
    }
  }

  function setPathRewriteStage(stage: VaultPathRewriteStage, job?: VaultPathRewriteJobSummary) {
    if (job) setPathRewriteJob(job);
    if (stage === "preparing") setStatus("암호화된 내부 참조 갱신 작업을 준비하는 중입니다…");
    if (stage === "prepared") setStatus("참조 갱신 작업을 안전하게 저장했습니다. 경로를 변경하는 중입니다…");
    if (stage === "path-committed") setStatus("경로 변경을 저장했습니다. 내부 참조를 확인하는 중입니다…");
    if (stage === "resuming") setStatus(`내부 참조를 갱신하는 중입니다… ${job?.cursor ?? 0}/${job?.stepCount ?? 0}`);
    if (stage === "completed") setStatus(`내부 참조 갱신을 완료했습니다. ${job?.confirmedCount ?? 0}개 파일 확인됨`);
    if (stage === "blocked") setStatus("내부 참조 갱신이 충돌로 중단되었습니다. 원본과 현재 편집본은 덮어쓰지 않았습니다.");
  }

  async function fetchOwnedServerNotes(noteIds: readonly string[]) {
    if (!isOnline) throw new Error("온라인 연결 후 경로 변경을 다시 시도해주세요.");
    const uniqueIds = Array.from(new Set(noteIds));
    const snapshots: NoteSnapshot[] = [];
    const resolvedIds = new Set<string>();
    for (let offset = 0; offset < uniqueIds.length; offset += 1_000) {
      const result = await getVisibleNotesByIdsFromServer(profile.uid, uniqueIds.slice(offset, offset + 1_000));
      result.notes.forEach((note) => snapshots.push(note));
      result.resolvedNoteIds.forEach((entryId) => resolvedIds.add(entryId));
    }
    if (uniqueIds.some((entryId) => !resolvedIds.has(entryId))) {
      throw new Error("서버에서 모든 경로 갱신 대상을 확인하지 못했습니다.");
    }
    const decrypted = await decryptVaultNotes(snapshots, profile.uid, privateKey, {
      reusableNotes: notesRef.current
    });
    const owned = decrypted.filter((note) => note.ownerUid === profile.uid);
    if (owned.length !== uniqueIds.length) {
      throw new Error("경로 갱신 대상의 소유권 또는 암호화 payload를 확인하지 못했습니다.");
    }
    return owned;
  }

  function captureVaultPathRewriteGenerationSignal(): VaultPathRewriteGenerationSignal {
    return {
      decryptedFolders: foldersRef.current,
      decryptedNotes: notesRef.current,
      folderReservationSignature: folderServerReservationSignatureRef.current,
      folderServerReady: folderSubscriptionServerReadyRef.current,
      noteReservationSignature: noteServerReservationSignatureRef.current,
      noteServerReady: noteSubscriptionServerReadyRef.current,
      rawFolders: allFolderSnapshotsRef.current,
      rawNotes: allVisibleNoteSnapshotsRef.current
    };
  }

  async function waitForVaultPathRewriteGenerationChange(
    baseline: VaultPathRewriteGenerationSignal,
    deadline: number
  ) {
    while (Date.now() < deadline) {
      if (vaultPathRewriteGenerationSignalChanged(
        baseline,
        captureVaultPathRewriteGenerationSignal()
      )) {
        return true;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    return vaultPathRewriteGenerationSignalChanged(
      baseline,
      captureVaultPathRewriteGenerationSignal()
    );
  }

  function captureCurrentRevisionedIndexGeneration() {
    if (
      !vaultDataReady
      || !noteSubscriptionServerReadyRef.current
      || !folderSubscriptionServerReadyRef.current
      || noteServerReservationSignatureRef.current === null
      || folderServerReservationSignatureRef.current === null
    ) {
      throw new VaultPathRewriteSnapshotChangedError();
    }
    const rawAllNotes = allVisibleNoteSnapshotsRef.current;
    const rawAllFolders = allFolderSnapshotsRef.current;
    const rawOwnerNotes = rawAllNotes.filter((note) => (
      note.ownerUid === profile.uid
      && note.isDeleted !== true
      && note.isPurged !== true
      && note.secureShareCopyState !== "copying"
      && note.secureShareCopyState !== "aborted"
    ));
    const rawOwnerFolders = rawAllFolders.filter((folder) => folder.ownerUid === profile.uid);
    const folderPartition = partitionVaultFolderTrash(rawOwnerFolders);
    if (folderPartition.invalidFolderIds.size > 0) {
      throw new Error("서버의 전체 Vault 폴더 경로를 확인할 수 없습니다.");
    }
    const rawVisibleOwnerNotes = visibleVaultNotesForFolders(
      rawOwnerNotes,
      folderPartition.activeFolders
    );
    if (
      ownedNoteReservationSignature(rawVisibleOwnerNotes, profile.uid)
        !== noteServerReservationSignatureRef.current
      || ownedFolderReservationSignature(folderPartition.activeFolders, profile.uid)
        !== folderServerReservationSignatureRef.current
    ) {
      throw new VaultPathRewriteSnapshotChangedError();
    }
    const currentNotes = notesRef.current.filter((note) => note.ownerUid === profile.uid);
    const currentFolders = foldersRef.current.filter((folder) => folder.ownerUid === profile.uid);
    if (currentFolders.some((folder) => folder.nameDecryptionFailed)) {
      throw new Error("서버 Vault 폴더 이름을 복호화하지 못해 경로 변경을 잠갔습니다.");
    }
    requireValidVaultFolderTree(currentFolders);
    return {
      currentFolders,
      currentNotes,
      rawAllFolders,
      rawAllNotes,
      rawActiveFolders: folderPartition.activeFolders,
      rawOwnerFolders,
      rawOwnerNotes,
      rawVisibleOwnerNotes
    };
  }

  async function buildCurrentRevisionedIndexEntries() {
    if (!isOnline) {
      throw new Error("온라인 연결 후 경로 변경을 다시 시도해주세요.");
    }
    const inventory = await import("../features/vault/pathRewriteInventory");
    let generationDeadline: number | null = null;
    for (let generationChangeCount = 0; generationChangeCount <= 3; generationChangeCount += 1) {
      const generationSignal = captureVaultPathRewriteGenerationSignal();
      try {
        const generation = captureCurrentRevisionedIndexGeneration();
        const planned = await inventory.buildAlignedVaultPathRewriteIndex({
          uid: profile.uid,
          rawVisibleNotes: generation.rawVisibleOwnerNotes,
          rawActiveFolders: generation.rawActiveFolders,
          decryptedNotes: generation.currentNotes,
          decryptedFolders: generation.currentFolders
        });
        if (!planned) throw new VaultPathRewriteSnapshotChangedError();
        const inventoryBinding = await inventory.loadVaultPathRewriteInventoryBinding({
          uid: profile.uid,
          notes: generation.rawOwnerNotes,
          folders: generation.rawOwnerFolders
        });
        if (vaultPathRewriteGenerationSignalChanged(
          generationSignal,
          captureVaultPathRewriteGenerationSignal()
        )) {
          throw new VaultPathRewriteSnapshotChangedError();
        }
        return {
          entries: planned.entries,
          folders: generation.currentFolders,
          folderPaths: planned.folderPaths,
          inventoryBinding,
          notes: generation.currentNotes
        };
      } catch (caught) {
        const manifestSnapshotLag = caught instanceof inventory.VaultPathRewriteInventorySnapshotLagError;
        const localSnapshotLag = caught instanceof VaultPathRewriteSnapshotChangedError;
        if (!manifestSnapshotLag && !localSnapshotLag) {
          throw caught;
        }
        generationDeadline ??= Date.now() + 2_000;
        const canRetry = generationChangeCount < 3
          && await waitForVaultPathRewriteGenerationChange(generationSignal, generationDeadline);
        if (!canRetry) {
          throw new Error(manifestSnapshotLag
            ? "서버 경로 인벤토리와 최신 Vault 구독 세대를 제한 시간 안에 정렬하지 못했습니다. 잠시 후 다시 시도해주세요."
            : "서버의 최신 Vault 구독 세대를 제한 시간 안에 확인하지 못했습니다. 잠시 후 다시 시도해주세요.");
        }
      }
    }
    throw new Error("서버의 최신 Vault 구독 세대를 확인하지 못했습니다.");
  }

  async function flushOwnedRewriteDrafts(excludedEntryId?: string) {
    const dirtySourceIds = notesRef.current
      .filter((note) => (
        note.ownerUid === profile.uid
        && note.id !== excludedEntryId
        && (note.contentFormat === "markdown-v1" || note.contentFormat === "json-canvas-v1")
        && draftsRef.current[note.id]?.dirty
      ))
      .map((note) => note.id);
    if (dirtySourceIds.length) setStatus("경로 변경 전에 편집 중인 참조 source를 저장하는 중입니다…");
    const remainingDirtyEntryIds = await flushVaultDraftsBeforePathRewriteRecovery({
      dirtyEntryIds: dirtySourceIds,
      isDirty: (entryId) => Boolean(draftsRef.current[entryId]?.dirty),
      save: (entryId) => saveEntryRef.current(entryId),
      waitForMutation: (entryId) => entryMutationPromisesRef.current.get(entryId)
    });
    const unsafeEntryIds = dirtySourceIds.filter((entryId) => {
      const note = notesRef.current.find((candidate) => candidate.id === entryId);
      const draft = draftsRef.current[entryId];
      return !note || !draft || draft.dirty || draft.baseRevision !== (note.revision ?? 0);
    });
    if (remainingDirtyEntryIds.length > 0 || unsafeEntryIds.length > 0) {
      throw new Error("저장하지 못한 편집 source가 있어 경로 변경을 시작하지 않았습니다.");
    }
  }

  function excludedSharedRewriteSourceCount(pathChanges: readonly {
    entryId: string;
    newPath: string;
    oldPath: string;
  }[]) {
    try {
      const localEntries: RevisionedVaultIndexEntry[] = notesRef.current.map((note) => ({
        id: note.id,
        path: vaultEntryPath(note, folderPathsRef.current),
        kind: note.entryKind,
        content: note.entryKind === "asset"
          ? undefined
          : note.contentFormat === "legacy-html-v1"
            ? previewTextFromHtml(note.body)
            : draftsRef.current[note.id]?.body ?? note.body,
        createdAt: timestampMillis(note.createdAt),
        updatedAt: timestampMillis(note.updatedAt),
        revision: note.revision ?? 0
      }));
      const plans = planVaultContentPathRewritesForPathChanges({ entries: localEntries, pathChanges });
      const otherOwnerIds = new Set(notesRef.current
        .filter((note) => note.ownerUid !== profile.uid)
        .map((note) => note.id));
      return new Set([
        ...plans.markdownPlans.map((plan) => plan.sourceEntryId),
        ...plans.canvasPlans.map((plan) => plan.sourceEntryId)
      ].filter((entryId) => otherOwnerIds.has(entryId))).size;
    } catch {
      return 0;
    }
  }

  function sharedRewriteWarning(count: number) {
    return count > 0
      ? ` · 다른 소유자의 공유 source ${count}개는 권한 경계를 넘어 자동 변경하지 않았습니다.`
      : "";
  }

  async function readDurableSource(sourceEntryId: string): Promise<VaultPathRewriteSourceSnapshot | null> {
    const pending = entryMutationPromisesRef.current.get(sourceEntryId);
    if (pending) await pending;
    const [note] = await fetchOwnedServerNotes([sourceEntryId]);
    if (!note || (note.contentFormat !== "markdown-v1" && note.contentFormat !== "json-canvas-v1")) return null;
    durableSourceNotesRef.current.set(sourceEntryId, note);
    return {
      revision: note.revision ?? 0,
      source: note.body,
      sourceEntryId,
      sourceKind: note.contentFormat === "markdown-v1" ? "markdown" : "canvas"
    };
  }

  async function applyDurableRewriteStep(
    step: VaultPathRewriteStepV1,
    current: VaultPathRewriteSourceSnapshot
  ) {
    const sourceNote = durableSourceNotesRef.current.get(step.sourceEntryId);
    if (
      !sourceNote
      || sourceNote.ownerUid !== profile.uid
      || (sourceNote.revision ?? 0) !== current.revision
      || sourceNote.body !== current.source
    ) {
      throw new Error("참조 source revision이 실행 직전에 변경되었습니다.");
    }
    const finishEntryMutation = beginEntryMutation(sourceNote.id);
    savingEntryIdsRef.current.add(sourceNote.id);
    setSavingEntryIds((entries) => new Set(entries).add(sourceNote.id));
    try {
      const submitted = {
        baseRevision: current.revision,
        body: step.rewrittenSource,
        dirty: false,
        folderId: sourceNote.folderId ?? null,
        title: sourceNote.title
      };
      const result = await saveEncryptedVaultEntry(
        { ...sourceNote, revision: current.revision },
        profile.uid,
        privateKey,
        vaultIntegrityKey!,
        submitted
      );
      if (result.revision !== current.revision + 1) {
        throw new Error("참조 source 저장 revision을 확인하지 못했습니다.");
      }
      commitNotes((notes) => notes.map((note) => note.id === sourceNote.id
        ? {
            ...note,
            ...persistedEncryptedMutationPatch(result),
            body: step.rewrittenSource,
            revision: result.revision
          }
        : note));
      const latest = draftsRef.current[sourceNote.id];
      if (latest && sameDraftPayload(latest, {
        body: current.source,
        folderId: sourceNote.folderId ?? null,
        title: sourceNote.title
      })) {
        const nextDrafts = {
          ...draftsRef.current,
          [sourceNote.id]: { ...latest, baseRevision: result.revision, body: step.rewrittenSource, dirty: false }
        };
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
      } else if (latest) {
        setConflictedEntryIds((entries) => new Map(entries).set(sourceNote.id, result.revision));
      }
    } finally {
      durableSourceNotesRef.current.delete(sourceNote.id);
      savingEntryIdsRef.current.delete(sourceNote.id);
      setSavingEntryIds((entries) => {
        const next = new Set(entries);
        next.delete(sourceNote.id);
        return next;
      });
      finishEntryMutation();
    }
  }

  function executePreparedPathRewrite(
    prepared: PreparedVaultPathRewriteJob,
    commitPathMutation: (activation: VaultPathRewriteActivationInput) => Promise<void>
  ) {
    return executeVaultPathRewrite({
      activate: () => activateVaultPathRewriteJob(profile.uid, privateKey, prepared.jobId),
      commitPathMutation,
      ensurePrepared: () => ensureVaultPathRewriteJob(profile, privateKey, prepared),
      onStage: setPathRewriteStage,
      prepared,
      resume: () => resumeVaultPathRewriteJob({
        applyStep: applyDurableRewriteStep,
        jobId: prepared.jobId,
        maxSteps: 25,
        privateKey,
        readSource: readDurableSource,
        uid: profile.uid
      })
    });
  }

  function recoverDurablePathRewriteJob(
    job: VaultPathRewriteJobSummary,
    continuationIsCurrent: () => boolean
  ) {
    return recoverVaultPathRewrite({
      job,
      onStage: (stage, stageJob) => {
        if (continuationIsCurrent()) setPathRewriteStage(stage, stageJob);
      },
      recoverPrepared: () => recoverPreparedVaultPathRewriteJob({
        jobId: job.jobId,
        privateKey,
        readCurrentPaths: async (entryIds) => {
          if (folderServerReservationSignature === null || noteServerReservationSignature === null) {
            throw new Error("서버 경로 snapshot을 확인하지 못했습니다.");
          }
          const serverNotes = await fetchOwnedServerNotes(entryIds);
          return serverNotes.map((note) => ({
            entryId: note.id,
            path: vaultEntryPath(note, folderPathsRef.current)
          }));
        },
        uid: profile.uid
      }),
      resume: () => resumeVaultPathRewriteJob({
        applyStep: applyDurableRewriteStep,
        jobId: job.jobId,
        maxSteps: 25,
        privateKey,
        readSource: readDurableSource,
        uid: profile.uid
      })
    });
  }

  async function retryBlockedPathRewriteJob() {
    const job = pathRewriteJob;
    if (!job || job.status !== "blocked" || job.lastErrorCode === "job-corrupt") return;
    if (!isOnline) {
      setError("온라인 연결 후 내부 참조 상태를 다시 확인해주세요.");
      return;
    }
    if (
      !vaultDataReady
      || !vaultNameWritesReady
      || folderServerReservationSignature === null
      || noteServerReservationSignature === null
    ) {
      setError("서버의 최신 Vault 경로와 revision을 확인한 뒤 다시 시도해주세요.");
      return;
    }
    if (pathRewriteBusyRef.current) return;

    const generation = pathRewriteRecoveryGenerationRef.current;
    const continuationIsCurrent = () => vaultPathRewriteRecoveryContinuationIsCurrent({
      cancelled: false,
      currentGeneration: pathRewriteRecoveryGenerationRef.current,
      generation
    });
    pathRewriteBusyRef.current = true;
    pathRewriteRecoveryBusyOwnerRef.current = generation;
    setPathRewriteBusy(true);
    setError(null);
    try {
      if (job.stepCount > 0) {
        setStatus("저장되지 않은 편집을 먼저 확인하는 중입니다…");
        const dirtyEntryIds = Object.entries(draftsRef.current)
          .filter(([, draft]) => draft.dirty)
          .map(([entryId]) => entryId);
        const remainingDirtyEntryIds = await flushVaultDraftsBeforePathRewriteRecovery({
          dirtyEntryIds,
          isDirty: (entryId) => Boolean(draftsRef.current[entryId]?.dirty),
          save: (entryId) => saveEntryRef.current(entryId),
          waitForMutation: (entryId) => entryMutationPromisesRef.current.get(entryId)
        });
        if (!continuationIsCurrent()) return;
        if (remainingDirtyEntryIds.length > 0) {
          setError(
            `${remainingDirtyEntryIds.length}개 편집본을 서버에 저장하지 못해 내부 참조 재개를 중단했습니다. 현재 초안은 이 세션에 그대로 남아 있습니다.`
          );
          return;
        }
      }

      setStatus(`서버의 현재 경로와 revision을 다시 확인하는 중입니다… ${job.cursor}/${job.stepCount}`);
      const recovered = await recoverDurablePathRewriteJob(job, continuationIsCurrent);
      if (!continuationIsCurrent()) return;
      setPathRewriteJob(recovered.job);
      if (recovered.outcome === "deferred") {
        setStatus("다른 탭에서 진행 중일 수 있어 내부 참조 복구를 잠시 보류했습니다.");
        return;
      }
      if (recovered.outcome === "not-applied") {
        setStatus("준비된 경로 변경이 서버에 적용되지 않아 원본 참조를 수정하지 않았습니다.");
        return;
      }
      setStatus(`내부 참조 갱신을 완료했습니다. ${recovered.job.confirmedCount}개 파일 확인됨`);
      setPathRewriteRecoveryRetry((current) => current + 1);
    } catch (caught) {
      if (!continuationIsCurrent()) return;
      const blockedJob = caught instanceof VaultPathRewriteControllerError ? caught.job : undefined;
      if (blockedJob) setPathRewriteJob(blockedJob);
      setError(caught instanceof Error
        ? `내부 참조 작업을 안전하게 재개하지 못했습니다: ${caught.message}`
        : "내부 참조 작업을 안전하게 재개하지 못했습니다.");
    } finally {
      if (pathRewriteRecoveryBusyOwnerRef.current === generation) {
        pathRewriteRecoveryBusyOwnerRef.current = null;
        pathRewriteBusyRef.current = false;
        setPathRewriteBusy(false);
      }
    }
  }

  useEffect(() => {
    // Reset the strictly bounded automatic-cleanup allowance only when this
    // owner actually unlocks a new Vault session. The following recovery effect
    // is declared after this one, so its lazy module callback observes the new
    // allowance before it can resume or complete a job.
    if (
      pathRewriteCleanupSessionRef.current?.privateKey === privateKey
      && pathRewriteCleanupSessionRef.current.uid === profile.uid
    ) return;
    pathRewriteCleanupSessionRef.current = { privateKey, uid: profile.uid };
    pathRewriteCleanupOwnerRef.current = null;
    pathRewriteRecoveryFailureCountRef.current = 0;
    void beginTerminalVaultPathRewriteCleanupSession(profile.uid).catch(() => undefined);
  }, [privateKey, profile.uid]);

  useEffect(() => {
    if (
      !isOnline
      || !vaultDataReady
      || !vaultNameWritesReady
    ) return undefined;
    if (pathRewriteBusyRef.current) {
      const retryTimer = window.setTimeout(() => {
        setPathRewriteRecoveryRetry((current) => current + 1);
      }, 250);
      return () => window.clearTimeout(retryTimer);
    }
    const generation = pathRewriteRecoveryGenerationRef.current + 1;
    pathRewriteRecoveryGenerationRef.current = generation;
    let cancelled = false;
    const continuationIsCurrent = () => vaultPathRewriteRecoveryContinuationIsCurrent({
      cancelled,
      currentGeneration: pathRewriteRecoveryGenerationRef.current,
      generation
    });
    const observedBlockedJobId = pathRewriteJob?.status === "blocked"
      ? pathRewriteJob.jobId
      : null;
    const observedBlockedRevision = pathRewriteJob?.status === "blocked"
      ? pathRewriteJob.revision
      : null;
    let deferredRecoveryTimer: number | null = null;
    let deferredRecoveryDeadline = Number.POSITIVE_INFINITY;
    const scheduleDeferredRecovery = (delayMs: number) => {
      if (!Number.isFinite(delayMs) || delayMs <= 0) return;
      const deadline = Date.now() + delayMs;
      if (deferredRecoveryTimer !== null && deadline >= deferredRecoveryDeadline) return;
      if (deferredRecoveryTimer !== null) window.clearTimeout(deferredRecoveryTimer);
      deferredRecoveryDeadline = deadline;
      deferredRecoveryTimer = window.setTimeout(() => {
        if (continuationIsCurrent()) {
          setPathRewriteRecoveryRetry((current) => current + 1);
        }
      }, Math.max(0, deadline - Date.now()) + 25);
    };
    const scheduleFailedRecovery = () => {
      const failureCount = pathRewriteRecoveryFailureCountRef.current + 1;
      pathRewriteRecoveryFailureCountRef.current = failureCount;
      const retryDelay = automaticVaultPathRewriteRetryDelayMs(failureCount);
      if (retryDelay === null) return null;
      scheduleDeferredRecovery(retryDelay);
      return { failureCount, retryDelay };
    };

    void scanRecoverableVaultPathRewriteJobs(profile.uid, privateKey).then(async ({
      jobs,
      hasMore,
      shouldContinueImmediately
    }) => {
      if (!continuationIsCurrent()) return;
      if (observedBlockedJobId !== null) {
        setPathRewriteJob((current) => reconcileVaultPathRewriteJobAfterRecoveryScan({
          continuationIsCurrent: continuationIsCurrent(),
          current,
          observedBlockedJobId,
          observedBlockedRevision,
          scanComplete: !hasMore,
          scannedJobs: jobs
        }));
      }
      const deferredDelays = jobs
        .map((job) => job.recoveryAfterMs ?? 0)
        .filter((delay) => delay > 0);
      if (deferredDelays.length > 0) {
        scheduleDeferredRecovery(Math.min(...deferredDelays));
      }
      const eligibleJobs = jobs.filter((job) => (job.recoveryAfterMs ?? 0) <= 0);
      if (eligibleJobs.length === 0) {
        pathRewriteRecoveryFailureCountRef.current = 0;
        return;
      }
      const manualRecoveryJob = eligibleJobs.find((job) => (
        !shouldAutomaticallyRecoverVaultPathRewriteJob(job)
      ));
      if (manualRecoveryJob) {
        setPathRewriteJob(manualRecoveryJob);
        setStatus("중단된 내부 참조 작업은 현재 원본을 보존하고 직접 재확인을 기다립니다.");
      }
      const automaticJobs = eligibleJobs.filter(shouldAutomaticallyRecoverVaultPathRewriteJob);
      if (automaticJobs.length === 0) {
        pathRewriteRecoveryFailureCountRef.current = 0;
        return;
      }
      // The lookup itself is read-only. Claim the global path lock only after
      // a recoverable job is known, and retry if a user mutation won the race.
      if (pathRewriteBusyRef.current) {
        setPathRewriteRecoveryRetry((current) => current + 1);
        return;
      }
      pathRewriteBusyRef.current = true;
      pathRewriteRecoveryBusyOwnerRef.current = generation;
      setPathRewriteBusy(true);
      if (automaticJobs.some((job) => job.stepCount > 0)) {
        setStatus("저장되지 않은 편집을 먼저 확인하는 중입니다…");
        const dirtyEntryIds = Object.entries(draftsRef.current)
          .filter(([, draft]) => draft.dirty)
          .map(([entryId]) => entryId);
        const remainingDirtyEntryIds = await flushVaultDraftsBeforePathRewriteRecovery({
          dirtyEntryIds,
          isDirty: (entryId) => Boolean(draftsRef.current[entryId]?.dirty),
          save: (entryId) => saveEntryRef.current(entryId),
          waitForMutation: (entryId) => entryMutationPromisesRef.current.get(entryId)
        });
        if (!continuationIsCurrent()) return;
        if (remainingDirtyEntryIds.length > 0) {
          const retry = scheduleFailedRecovery();
          setError(
            `${remainingDirtyEntryIds.length}개 편집본을 서버에 저장하지 못해 내부 참조 자동 복구를 중단했습니다. 현재 초안은 이 세션에 그대로 남아 있습니다.${retry ? ` ${Math.ceil(retry.retryDelay / 1_000)}초 후 다시 확인합니다 (${retry.failureCount}/5).` : " 편집본을 저장한 뒤 복구 알림에서 다시 확인해주세요."}`
          );
          return;
        }
      }
      for (const job of automaticJobs) {
        if (!continuationIsCurrent()) return;
        setPathRewriteJob(job);
        setStatus(`중단된 내부 참조 작업을 확인하는 중입니다… ${job.cursor}/${job.stepCount}`);
        const recovered = await recoverDurablePathRewriteJob(job, continuationIsCurrent);
        if (!continuationIsCurrent()) return;
        setPathRewriteJob(recovered.job);
        if (recovered.outcome === "deferred") {
          scheduleDeferredRecovery(recovered.job.recoveryAfterMs ?? 250);
          setStatus("다른 탭에서 진행 중일 수 있어 내부 참조 자동 복구를 잠시 보류했습니다.");
          continue;
        }
        if (recovered.outcome === "not-applied") {
          setStatus("이전에 준비한 경로 변경은 서버에 적용되지 않아 내부 참조 작업을 실행하지 않았습니다.");
        }
      }
      pathRewriteRecoveryFailureCountRef.current = 0;
      if (manualRecoveryJob) {
        setPathRewriteJob(manualRecoveryJob);
        setStatus("자동 복구 작업을 확인했습니다. 충돌한 내부 참조 원본은 직접 재확인을 기다립니다.");
      }
      if (hasMore && shouldContinueImmediately) {
        // The bounded page was full. Rescan after these jobs became terminal so
        // a legacy 50-job backlog plus a concurrent atomic overshoot converges
        // in the current unlocked session.
        setPathRewriteRecoveryRetry((current) => current + 1);
      }
    }).catch((caught) => {
      if (!continuationIsCurrent()) return;
      const job = caught instanceof VaultPathRewriteControllerError ? caught.job : undefined;
      if (job) {
        setPathRewriteJob(job);
        if (job.status === "blocked" && job.lastErrorCode === "write-failed") {
          const retry = scheduleFailedRecovery();
          if (retry) {
            setError(null);
            setStatus(`최신 서버 revision을 다시 읽어 ${Math.ceil(retry.retryDelay / 1_000)}초 후 내부 참조 저장을 재시도합니다 (${retry.failureCount}/5).`);
          } else {
            setError("내부 참조 암호화 저장이 반복 실패했습니다. 원본은 보존했으며 복구 알림에서 다시 시도할 수 있습니다.");
          }
          return;
        }
        if (job.status === "blocked") {
          pathRewriteRecoveryFailureCountRef.current = 0;
          setError(null);
          setStatus("내부 참조 원본은 변경하지 않았습니다. 복구 알림에서 현재 서버 상태를 직접 재확인할 수 있습니다.");
          return;
        }
      }
      const retryCause = caught instanceof VaultPathRewriteControllerError
        ? caught.cause
        : caught;
      if (retryableVaultPathRewriteFailure(retryCause)) {
        const retry = scheduleFailedRecovery();
        if (retry) {
          setError(null);
          setStatus(`네트워크 상태를 확인해 ${Math.ceil(retry.retryDelay / 1_000)}초 후 내부 참조 자동 복구를 다시 시도합니다 (${retry.failureCount}/5).`);
          return;
        }
      }
      setError(caught instanceof Error
        ? `중단된 내부 참조 작업을 자동 복구하지 못했습니다: ${caught.message}`
        : "중단된 내부 참조 작업을 자동 복구하지 못했습니다.");
    }).finally(() => {
      if (pathRewriteRecoveryBusyOwnerRef.current === generation) {
        pathRewriteRecoveryBusyOwnerRef.current = null;
        pathRewriteBusyRef.current = false;
        setPathRewriteBusy(false);
      }
      if (
        continuationIsCurrent()
        && pathRewriteCleanupOwnerRef.current !== profile.uid
      ) {
        // Terminal ciphertext cleanup is deliberately best-effort and runs
        // once per unlocked profile session, after critical recovery has had
        // priority. It never blocks login or surfaces private maintenance data.
        pathRewriteCleanupOwnerRef.current = profile.uid;
        void scheduleTerminalVaultPathRewriteCleanup(profile.uid).catch(() => undefined);
      }
    });

    return () => {
      cancelled = true;
      if (deferredRecoveryTimer !== null) window.clearTimeout(deferredRecoveryTimer);
      if (pathRewriteRecoveryGenerationRef.current === generation) {
        pathRewriteRecoveryGenerationRef.current += 1;
      }
    };
    // Recovery is intentionally keyed to server-confirmed Vault readiness.
    // Mutable adapters read current refs so a note/folder render does not
    // restart the same encrypted maintenance scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, pathRewriteRecoveryRetry, privateKey, profile.uid, vaultDataReady, vaultNameWritesReady]);

  useEffect(() => {
    if (!isOnline || !vaultDataReady || !vaultNameWritesReady || pathRewriteBusy) return undefined;
    const generation = vaultImportRecoveryGenerationRef.current + 1;
    vaultImportRecoveryGenerationRef.current = generation;
    let cancelled = false;

    void cleanupRetainedTerminalVaultImportJobs(profile.uid)
      .then(() => listRecoverableVaultImportJobs(profile.uid, privateKey))
      .then((jobs) => {
        if (cancelled || generation !== vaultImportRecoveryGenerationRef.current) return;
        setRecoverableImportJobs(jobs);
        if (jobs.length) {
          setImportRecoveryOpen(true);
          setError("중단된 ZIP 가져오기가 있습니다. 서버 상태를 확인한 뒤 복구 방법을 직접 선택해주세요.");
        }
      }).catch(() => {
      if (cancelled || generation !== vaultImportRecoveryGenerationRef.current) return;
      setError("중단된 ZIP 가져오기 상태를 서버에서 확인하지 못했습니다. 기존 데이터는 변경하지 않았습니다.");
    }).finally(() => {
      if (!cancelled && generation === vaultImportRecoveryGenerationRef.current) {
        setImportRecoveryBusyJobId(null);
      }
    });

    return () => {
      cancelled = true;
      if (vaultImportRecoveryGenerationRef.current === generation) {
        vaultImportRecoveryGenerationRef.current += 1;
      }
    };
  }, [isOnline, pathRewriteBusy, privateKey, profile.uid, vaultDataReady, vaultNameWritesReady]);

  async function recheckRecoverableImportJobs(announce = true) {
    if (!isOnline) {
      setError("온라인 연결 후 ZIP 가져오기 상태를 다시 확인해주세요.");
      return;
    }
    setImportRecoveryBusyJobId("recheck");
    try {
      await cleanupRetainedTerminalVaultImportJobs(profile.uid);
      const jobs = await listRecoverableVaultImportJobs(profile.uid, privateKey);
      setRecoverableImportJobs(jobs);
      setImportRecoveryOpen(jobs.length > 0);
      if (announce) {
        setError(null);
        setStatus(jobs.length
          ? `복구가 필요한 ZIP 가져오기 ${jobs.length}개를 서버에서 확인했습니다.`
          : "중단된 ZIP 가져오기가 없음을 서버에서 확인했습니다.");
      }
    } catch {
      setError("ZIP 가져오기 상태를 서버에서 다시 확인하지 못했습니다. 기존 데이터는 변경하지 않았습니다.");
    } finally {
      setImportRecoveryBusyJobId(null);
    }
  }

  async function rollbackRecoverableImportJob(job: VaultImportJobSummary) {
    if (!isOnline || importRecoveryBusyJobId) return;
    if (
      job.status === "staging"
      && !window.confirm("다른 탭이나 기기에서 이 ZIP 가져오기가 실행 중이지 않음을 확인했나요? 새로 생성된 항목만 revision 검증 후 휴지통으로 이동합니다.")
    ) return;
    setImportRecoveryBusyJobId(job.jobId);
    setError(null);
    try {
      const latest = await loadVaultImportJob(profile.uid, privateKey, job.jobId);
      if (!latest) {
        await recheckRecoverableImportJobs(false);
        setStatus("해당 ZIP 가져오기 작업이 서버에 남아 있지 않음을 확인했습니다.");
        return;
      }
      if (latest.status === "committed") {
        await cleanupTerminalVaultImportJob(profile.uid, latest.jobId).catch(() => undefined);
        await recheckRecoverableImportJobs(false);
        setStatus("ZIP 가져오기가 이미 완료되어 항목을 삭제하지 않았습니다.");
        return;
      }
      const recovered = await rollbackVaultImportJob({
        uid: profile.uid,
        privateKey,
        jobId: latest.jobId
      });
      if (recovered.status === "rolled-back") {
        await cleanupTerminalVaultImportJob(profile.uid, recovered.jobId).catch(() => undefined);
      }
      await recheckRecoverableImportJobs(false);
      setStatus(recovered.status === "rolled-back"
        ? "ZIP 가져오기로 새로 생성된 항목만 revision 확인 후 휴지통 처리했습니다."
        : "ZIP 가져오기가 이미 완료되어 항목을 삭제하지 않았습니다.");
    } catch (caught) {
      await recheckRecoverableImportJobs(false);
      setError(caught instanceof VaultImportJobError && caught.code === "conflict"
        ? "가져온 항목이 이후 수정되어 자동 롤백하지 않았습니다. 현재 내용과 이력은 보존했습니다."
        : "서버 snapshot 또는 복구 정보의 무결성을 확인하지 못해 롤백을 중단했습니다.");
    } finally {
      setImportRecoveryBusyJobId(null);
    }
  }

  async function moveEntryToFolder(entryId: string, folderId: string | null) {
    if (!profile || !privateKey || !vaultIntegrityKey) {
      setError("암호화된 이름 무결성 키가 준비될 때까지 항목을 이동할 수 없습니다.");
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("다른 경로 변경의 내부 참조를 확인하는 중입니다.");
      return;
    }
    if (clipboardAssetsPendingForEntry(entryId)) {
      setError("이미지 붙여넣기가 끝난 뒤 항목을 이동해주세요.");
      return;
    }
    if (!canMutateExistingNameTarget(entryId)) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 항목 이동이 잠깁니다.");
      return;
    }
    const existingMutation = entryMutationPromisesRef.current.get(entryId);
    if (existingMutation) {
      await existingMutation;
      await moveEntryRef.current(entryId, folderId);
      return;
    }
    const currentNotes = notesRef.current;
    const note = currentNotes.find((candidate) => candidate.id === entryId);
    const resolvingNameCollision = vaultNameMigrationStatus === "blocked"
      && vaultNameCollisionTargetIds.has(entryId);
    const repairsHistoricalSharedFolder = Boolean(
      resolvingNameCollision
      && note?.type === "shared"
      && note.ownerUid === profile.uid
      && (note.folderId ?? null) !== null
      && folderId === null
    );
    if (
      !note
      || note.ownerUid !== profile.uid
      || (note.type !== "personal" && !repairsHistoricalSharedFolder)
    ) {
      setError("내 개인 항목만 폴더로 이동할 수 있습니다.");
      return;
    }
    if ((note.folderId ?? null) === folderId) {
      return;
    }
    const targetDraft = draftsRef.current[entryId];
    if (!targetDraft) {
      setError("이동할 항목의 편집 버퍼를 준비하지 못했습니다.");
      return;
    }
    if (currentNotes.some((candidate) => (
      candidate.id !== entryId
      && candidate.ownerUid === note.ownerUid
      && (candidate.folderId ?? null) === folderId
      && normalizedEntryTitle(candidate.title, candidate.entryKind) === normalizedEntryTitle(targetDraft.title, note.entryKind)
    ))) {
      setError("대상 폴더에 동일한 이름의 항목이 있습니다.");
      return;
    }
    const optimisticOperationId = stageOptimisticEntryPatch(entryId, { folderId });
    const finishEntryMutation = beginEntryMutation(entryId);
    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    pathRewriteBusyRef.current = true;
    setPathRewriteBusy(true);
    setPathRewriteJob(null);
    setError(null);
    try {
      if (!resolvingNameCollision) await flushOwnedRewriteDrafts(entryId);
      const refreshedNote = notesRef.current.find((candidate) => candidate.id === entryId);
      const refreshedDraftState = draftsRef.current[entryId];
      if (!refreshedNote || !refreshedDraftState || conflictedEntryIds.has(entryId)) {
        throw new Error("이동 대상의 최신 server revision을 확인하지 못했습니다.");
      }
      const refreshedDraft = canonicalizeDraftTitle(refreshedDraftState);
      const server = await buildCurrentRevisionedIndexEntries();
      const serverTarget = server.notes.find((candidate) => candidate.id === entryId);
      if (
        !serverTarget
        || (serverTarget.revision ?? 0) !== refreshedDraft.baseRevision
      ) {
        throw new Error("이동 대상이 다른 기기에서 변경되어 경로 변경을 시작하지 않았습니다.");
      }
      const nextPath = vaultEntryPath(
        { ...serverTarget, folderId, title: refreshedDraft.title },
        server.folderPaths
      );
      const currentPath = vaultEntryPath(serverTarget, server.folderPaths);
      // The manifest and expected revision bind the persisted base generation.
      // Plan self-links from the authorized local draft, then persist its body
      // and path in the same mutation instead of creating an extra history row.
      const planningEntries = resolvingNameCollision
        ? server.entries
        : server.entries.map((entry) => (
            entry.id === entryId && (entry.kind === "markdown" || entry.kind === "canvas")
              ? { ...entry, content: refreshedDraft.body, revision: refreshedDraft.baseRevision }
              : entry
          ));
      const rewritePlans = resolvingNameCollision
        ? { canvasPlans: [], markdownPlans: [] }
        : planVaultContentPathRewritesForPathChanges({
            entries: planningEntries,
            pathChanges: [{ entryId, newPath: nextPath, oldPath: currentPath }]
          });
      const excludedSharedCount = resolvingNameCollision ? 0 : excludedSharedRewriteSourceCount([
        { entryId, newPath: nextPath, oldPath: currentPath }
      ]);
      const selfPlan = rewritePlans.markdownPlans.find((plan) => plan.sourceEntryId === entryId);
      const selfCanvasPlan = rewritePlans.canvasPlans.find((plan) => plan.sourceEntryId === entryId);
      const sourcePlans = (await buildVaultPathRewriteSourcePlans({
        canvasPlans: rewritePlans.canvasPlans,
        entries: planningEntries,
        markdownPlans: rewritePlans.markdownPlans
      })).filter((plan) => plan.sourceEntryId !== entryId);
      const prepared = await prepareVaultPathRewriteJob(vaultIntegrityKey, {
        ...server.inventoryBinding,
        mutationTarget: { expectedRevision: refreshedDraft.baseRevision, id: entryId, kind: "entry" },
        ownerUid: profile.uid,
        pathChanges: [{ entryId, newPath: nextPath, oldPath: currentPath }],
        sourcePlans
      });
      let pathMutationDraft: DraftState | null = null;
      let pathMutationPersistedBody = serverTarget.body;
      let pathMutationLocallyConfirmed = false;
      let pathMutationSupersededRevision: number | null = null;
      let pathMutationSupersededHasConflict = false;
      const commitMovedTarget = (
        result: {
          encryptedBody?: DecryptedVaultNote["encryptedBody"];
          encryptedTitle?: DecryptedVaultNote["encryptedTitle"];
          lastMutationId?: string;
          revision: number;
          vaultNameClaimId?: string;
          vaultNameIndexVersion?: DecryptedVaultNote["vaultNameIndexVersion"];
        },
        submittedDraft: DraftState,
        persistedBody: string
      ) => {
        const canonicalSubmitted = canonicalizeDraftTitle(submittedDraft);
        const latestBeforeCommit = draftsRef.current[entryId];
        const draftAlreadyNewer = Boolean(
          latestBeforeCommit && latestBeforeCommit.baseRevision > result.revision
        );
        const currentCandidate = notesRef.current.find((candidate) => candidate.id === entryId);
        let observedRevision = currentCandidate?.revision ?? result.revision;
        let revisionRelation: ReturnType<typeof persistedRevisionRelation> = currentCandidate
          ? persistedRevisionRelation(currentCandidate.revision, result.revision)
          : "superseded";
        if (draftAlreadyNewer) {
          revisionRelation = "superseded";
          observedRevision = Math.max(observedRevision, latestBeforeCommit?.baseRevision ?? 0);
        }
        const currentRevisionPayloadMatches = currentCandidate
          ? revisionRelation !== "current" || (
              currentCandidate.body === persistedBody
              && (currentCandidate.folderId ?? null) === folderId
              && currentCandidate.title === canonicalSubmitted.title
            )
          : false;
        commitNotes((current) => current.map((candidate) => {
          if (candidate.id !== entryId) return candidate;
          if (revisionRelation !== "apply") return candidate;
          return {
            ...candidate,
            ...persistedEncryptedMutationPatch(result),
            body: persistedBody,
            folderId,
            ...(result.lastMutationId ? { lastMutationId: result.lastMutationId } : {}),
            revision: result.revision,
            title: canonicalSubmitted.title
          };
        }));
        const latest = draftsRef.current[entryId];
        if (revisionRelation === "superseded" || !currentRevisionPayloadMatches) {
          pathMutationSupersededRevision = observedRevision;
          if (!currentRevisionPayloadMatches || Boolean(latest?.dirty && latest.baseRevision < observedRevision)) {
            pathMutationSupersededHasConflict = true;
            setConflictedEntryIds((current) => new Map(current).set(entryId, observedRevision));
            setError("이동 응답보다 최신 서버 revision을 유지했습니다. 현재 편집본은 덮어쓰지 않았습니다.");
          }
          pathMutationLocallyConfirmed = true;
          return;
        }
        if (latest?.baseRevision === result.revision) {
          // The Firestore subscription can install this exact revision before
          // the API response (or response-loss confirmation) returns. Its
          // draft is already based on the persisted move and must not be
          // compared with the old-folder request snapshot.
        } else if (latest && sameDraftPayload(latest, refreshedDraft)) {
          const nextDrafts = {
            ...draftsRef.current,
            [entryId]: {
              ...canonicalSubmitted,
              baseRevision: result.revision,
              dirty: canonicalSubmitted.body !== persistedBody
            }
          };
          draftsRef.current = nextDrafts;
          setDrafts(nextDrafts);
        } else if (latest) {
          pathMutationSupersededRevision = result.revision;
          pathMutationSupersededHasConflict = true;
          setConflictedEntryIds((current) => new Map(current).set(entryId, result.revision));
          setError("이동을 저장하는 동안 편집본이 변경되었습니다. 현재 편집은 보존하고 서버 결과와 안전하게 비교합니다.");
        }
        pathMutationLocallyConfirmed = true;
      };
      const completed = await executePreparedPathRewrite(prepared, async (pathRewriteActivation) => {
        let submittedDraft: DraftState = canonicalizeDraftTitle({ ...refreshedDraft, dirty: false, folderId });
        if (selfPlan) {
          if (serverTarget.contentFormat !== "markdown-v1") {
            throw new Error("자기 링크를 안전하게 갱신할 수 없어 이동을 중단했습니다.");
          }
          const applied = applyInternalLinkRewritePlan(
            selfPlan,
            refreshedDraft.body,
            refreshedDraft.baseRevision
          );
          if (applied.status !== "applied") throw new Error("자기 링크 source가 변경되었습니다.");
          submittedDraft = { ...submittedDraft, body: applied.markdown };
        } else if (selfCanvasPlan) {
          const applied = applyCanvasPathRewritePlan(
            selfCanvasPlan,
            refreshedDraft.body,
            refreshedDraft.baseRevision
          );
          if (applied.status !== "applied") throw new Error("Canvas 자기 링크 source가 변경되었습니다.");
          submittedDraft = { ...submittedDraft, body: applied.source };
        }
        pathMutationDraft = submittedDraft;
        pathMutationPersistedBody = resolvingNameCollision ? serverTarget.body : submittedDraft.body;
        const revisionedTarget = { ...serverTarget, revision: refreshedDraft.baseRevision };
        const result = resolvingNameCollision
          ? await resolveDeferredVaultEntryCollision(
              revisionedTarget,
              profile.uid,
              privateKey,
              vaultIntegrityKey,
              { folderId, title: submittedDraft.title },
              pathRewriteActivation
            )
          : revisionedTarget.contentFormat === "legacy-html-v1"
            ? await moveOnlyEncryptedVaultEntry(
                revisionedTarget,
                profile.uid,
                privateKey,
                vaultIntegrityKey,
                submittedDraft,
                pathRewriteActivation
              )
            : await saveAndMoveEncryptedVaultEntry(
                revisionedTarget,
                profile.uid,
                privateKey,
                vaultIntegrityKey,
                submittedDraft,
                pathRewriteActivation
              );
        commitMovedTarget(result, submittedDraft, pathMutationPersistedBody);
      });
      if (!pathMutationLocallyConfirmed) {
        const committedDraft = pathMutationDraft as DraftState | null;
        if (!committedDraft) {
          throw new Error("이동 결과를 로컬 편집 버퍼와 연결하지 못했습니다.");
        }
        const remote = await readCurrentServerVaultEntry(entryId);
        const confirmed = findConfirmedDraftSubmission({
          body: remote.body,
          folderId: remote.folderId ?? null,
          revision: remote.revision ?? 0,
          title: remote.title
        }, [{ ...committedDraft, body: pathMutationPersistedBody }]);
        if (!confirmed || remote.ownerUid !== profile.uid) {
          throw new Error("서버에서 완료된 이동 결과의 revision과 암호화 payload를 확인하지 못했습니다.");
        }
        commitMovedTarget({
          encryptedBody: remote.encryptedBody,
          encryptedTitle: remote.encryptedTitle,
          lastMutationId: remote.lastMutationId,
          revision: remote.revision ?? 0,
          vaultNameClaimId: remote.vaultNameClaimId,
          vaultNameIndexVersion: remote.vaultNameIndexVersion
        }, committedDraft, pathMutationPersistedBody);
      }
      if (pathMutationSupersededRevision !== null) {
        if (!pathMutationSupersededHasConflict) {
          setStatus("늦게 도착한 이동 응답은 적용하지 않고 이미 수신한 최신 서버 revision을 유지했습니다.");
        }
        return;
      }
      const selfRewriteCount = (selfPlan?.patches.length ?? 0) + (selfCanvasPlan?.changeCount ?? 0);
      setStatus(resolvingNameCollision
        ? "중복 이름 해소를 위해 항목을 이동했습니다. 기존의 모호한 링크는 임의로 한 항목에 귀속하지 않았으므로 다시 확인해주세요."
        : `항목을 이동하고 내부 참조 ${completed.confirmedCount + selfRewriteCount}개를 확인했습니다.${sharedRewriteWarning(excludedSharedCount)}`);
    } catch (caught) {
      const underlyingError = caught instanceof VaultPathRewriteControllerError
        ? caught.cause
        : caught;
      const inventoryFailure = pathRewriteInventoryFailureMessage(underlyingError);
      if (inventoryFailure) {
        setError(inventoryFailure);
      } else if (underlyingError instanceof NoteRevisionConflictError) {
        setConflictedEntryIds((current) => new Map(current).set(entryId, underlyingError.actualRevision));
        setError("다른 기기나 탭에서 이 항목이 변경되어 이동하지 않았습니다. 현재 편집본은 그대로 보존됩니다.");
        if (isMarkdownMergeEntry(note)) void prepareDraftMergeConflict(entryId, false);
      } else if (underlyingError instanceof VaultNameConflictError) {
        setError("대상 폴더에 동일한 이름의 항목이 있어 이동하지 않았습니다.");
      } else {
        setError(caught instanceof Error ? caught.message : "항목을 이동하지 못했습니다.");
      }
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      finishEntryMutation();
      finishOptimisticEntryPatch(entryId, optimisticOperationId);
      pathRewriteBusyRef.current = false;
      setPathRewriteBusy(false);
    }
  }

  async function moveFolder(folderId: string, parentId: string | null) {
    if (!profile || !privateKey || !vaultIntegrityKey || folderId === parentId) {
      if (!privateKey || !vaultIntegrityKey) {
        setError("암호화된 이름 무결성 키가 준비될 때까지 폴더를 이동할 수 없습니다.");
      }
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("다른 경로 변경의 내부 참조를 확인하는 중입니다.");
      return;
    }
    if (clipboardAssetsPendingForFolder(folderId)) {
      setError("이미지 붙여넣기가 끝난 뒤 이 폴더를 이동해주세요.");
      return;
    }
    if (!canMutateExistingNameTarget(folderId)) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 폴더 이동이 잠깁니다.");
      return;
    }
    const currentFolders = foldersRef.current;
    const folder = currentFolders.find((candidate) => candidate.id === folderId);
    const resolvingNameCollision = vaultNameMigrationStatus === "blocked"
      && vaultNameCollisionTargetIds.has(folderId);
    if (!folder) {
      return;
    }
    if ((!folder.encryptedName || !folder.wrappedKey) && !resolvingNameCollision) {
      setError("먼저 기존 폴더 이름을 암호화해주세요.");
      return;
    }
    if (currentFolders.some((candidate) => (
      candidate.id !== folderId
      && (candidate.parentId ?? null) === parentId
      && candidate.displayName.trim().localeCompare(folder.displayName.trim(), undefined, { sensitivity: "accent" }) === 0
    ))) {
      setError("대상 위치에 동일한 이름의 폴더가 있습니다.");
      return;
    }
    const descendantPath = folderPathsRef.current.get(parentId ?? "") ?? "";
    const folderPath = folderPathsRef.current.get(folderId) ?? "";
    if (descendantPath.startsWith(`${folderPath}/`)) {
      setError("폴더를 자신의 하위 폴더로 이동할 수 없습니다.");
      return;
    }
    pathRewriteBusyRef.current = true;
    setPathRewriteBusy(true);
    setPathRewriteJob(null);
    setError(null);
    try {
      if (!resolvingNameCollision) await flushOwnedRewriteDrafts();
      const server = await buildCurrentRevisionedIndexEntries();
      const serverFolder = server.folders.find((candidate) => candidate.id === folderId);
      if (!serverFolder || (serverFolder.revision ?? 1) !== (folder.revision ?? 1)) {
        throw new Error("이동 대상 폴더가 다른 기기에서 변경되어 작업을 시작하지 않았습니다.");
      }
      const nextFolders = server.folders.map((candidate) => (
        candidate.id === folderId ? { ...candidate, parentId } : candidate
      ));
      requireValidVaultFolderTree(nextFolders);
      const nextFolderPaths = buildVaultPaths(nextFolders);
      const pathChanges = server.notes
        .filter((note) => note.type === "personal")
        .flatMap((note) => {
          const oldPath = vaultEntryPath(note, server.folderPaths);
          const newPath = vaultEntryPath(note, nextFolderPaths);
          return oldPath === newPath ? [] : [{ entryId: note.id, newPath, oldPath }];
        });
      const rewritePlans = resolvingNameCollision
        ? { canvasPlans: [], markdownPlans: [] }
        : planVaultContentPathRewritesForPathChanges({ entries: server.entries, pathChanges });
      const excludedSharedCount = resolvingNameCollision ? 0 : excludedSharedRewriteSourceCount(pathChanges);
      const sourcePlans = await buildVaultPathRewriteSourcePlans({
        canvasPlans: rewritePlans.canvasPlans,
        entries: server.entries,
        markdownPlans: rewritePlans.markdownPlans
      });
      const prepared = await prepareVaultPathRewriteJob(vaultIntegrityKey, {
        ...server.inventoryBinding,
        mutationTarget: { expectedRevision: serverFolder.revision ?? 1, id: folderId, kind: "folder" },
        ownerUid: profile.uid,
        pathChanges,
        sourcePlans
      });
      const completed = await executePreparedPathRewrite(prepared, async (pathRewriteActivation) => {
        const result = resolvingNameCollision
          ? await resolveDeferredVaultFolderCollision(
              serverFolder,
              profile,
              privateKey,
              vaultIntegrityKey,
              { name: serverFolder.displayName, parentId },
              pathRewriteActivation
            )
            : await moveEncryptedVaultFolder(
              serverFolder,
              profile.uid,
              vaultIntegrityKey,
              parentId,
              pathRewriteActivation
            );
        commitFolders((current) => current.map((candidate) => candidate.id === folderId
          ? {
              ...candidate,
              ...persistedEncryptedFolderMutationPatch(result),
              parentId,
              revision: result.revision
            }
          : candidate));
      });
      setStatus(resolvingNameCollision
        ? "중복 이름 해소를 위해 폴더를 이동했습니다. 기존의 모호한 링크는 자동 귀속하지 않았으므로 다시 확인해주세요."
        : `폴더를 이동하고 내부 참조 ${completed.confirmedCount}개 파일을 서버에서 확인했습니다.${sharedRewriteWarning(excludedSharedCount)}`);
    } catch (caught) {
      const underlyingError = caught instanceof VaultPathRewriteControllerError
        ? caught.cause
        : caught;
      const inventoryFailure = pathRewriteInventoryFailureMessage(underlyingError);
      if (inventoryFailure) {
        setError(inventoryFailure);
      } else if (underlyingError instanceof VaultNameConflictError) {
        setError("대상 위치에 동일한 이름의 폴더가 있어 이동하지 않았습니다.");
      } else if (underlyingError instanceof VaultFolderApiError && underlyingError.status === 409) {
        setError("다른 기기나 탭에서 폴더가 변경되어 이동하지 않았습니다. 폴더 목록을 다시 확인해주세요.");
      } else if (caught instanceof VaultPathRewriteControllerError && caught.stage === "path-committed") {
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "폴더를 이동하지 못했습니다.");
      }
    } finally {
      pathRewriteBusyRef.current = false;
      setPathRewriteBusy(false);
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

  async function renameFolder(folderId: string, requestedName?: string) {
    if (!profile || !privateKey || !vaultIntegrityKey) {
      setError("암호화된 이름 무결성 키가 준비될 때까지 폴더 이름을 바꿀 수 없습니다.");
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("다른 경로 변경의 내부 참조를 확인하는 중입니다.");
      return;
    }
    if (clipboardAssetsPendingForFolder(folderId)) {
      setError("이미지 붙여넣기가 끝난 뒤 이 폴더 이름을 변경해주세요.");
      return;
    }
    if (!canMutateExistingNameTarget(folderId)) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 폴더 이름 변경이 잠깁니다.");
      return;
    }
    const currentFolders = foldersRef.current;
    const folder = currentFolders.find((candidate) => candidate.id === folderId);
    if (!folder) {
      return;
    }
    const name = (requestedName ?? window.prompt("폴더 이름 변경", folder.displayName))?.trim();
    if (!name || name === folder.displayName) {
      return;
    }
    if (currentFolders.some((candidate) => (
      candidate.id !== folder.id
      && (candidate.parentId ?? null) === (folder.parentId ?? null)
      && candidate.displayName.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
    ))) {
      setError("같은 위치에 동일한 이름의 폴더가 있습니다.");
      return;
    }
    const resolvingNameCollision = vaultNameMigrationStatus === "blocked"
      && vaultNameCollisionTargetIds.has(folderId);
    pathRewriteBusyRef.current = true;
    setPathRewriteBusy(true);
    setPathRewriteJob(null);
    setError(null);
    try {
      if (!resolvingNameCollision) await flushOwnedRewriteDrafts();
      const server = await buildCurrentRevisionedIndexEntries();
      const serverFolder = server.folders.find((candidate) => candidate.id === folderId);
      if (!serverFolder || (serverFolder.revision ?? 1) !== (folder.revision ?? 1)) {
        throw new Error("이름 변경 대상 폴더가 다른 기기에서 변경되어 작업을 시작하지 않았습니다.");
      }
      const nextFolders = server.folders.map((candidate) => candidate.id === folderId
        ? { ...candidate, displayName: name }
        : candidate);
      const nextFolderPaths = buildVaultPaths(nextFolders);
      const pathChanges = server.notes
        .filter((note) => note.type === "personal")
        .flatMap((note) => {
          const oldPath = vaultEntryPath(note, server.folderPaths);
          const newPath = vaultEntryPath(note, nextFolderPaths);
          return oldPath === newPath ? [] : [{ entryId: note.id, newPath, oldPath }];
      });
      const rewritePlans = resolvingNameCollision
        ? { canvasPlans: [], markdownPlans: [] }
        : planVaultContentPathRewritesForPathChanges({ entries: server.entries, pathChanges });
      const excludedSharedCount = resolvingNameCollision ? 0 : excludedSharedRewriteSourceCount(pathChanges);
      const sourcePlans = await buildVaultPathRewriteSourcePlans({
        canvasPlans: rewritePlans.canvasPlans,
        entries: server.entries,
        markdownPlans: rewritePlans.markdownPlans
      });
      const prepared = await prepareVaultPathRewriteJob(vaultIntegrityKey, {
        ...server.inventoryBinding,
        mutationTarget: { expectedRevision: serverFolder.revision ?? 1, id: folderId, kind: "folder" },
        ownerUid: profile.uid,
        pathChanges,
        sourcePlans
      });
      const completed = await executePreparedPathRewrite(prepared, async (pathRewriteActivation) => {
        const result = resolvingNameCollision
          ? await resolveDeferredVaultFolderCollision(
              serverFolder,
              profile,
              privateKey,
              vaultIntegrityKey,
              { name, parentId: serverFolder.parentId ?? null },
              pathRewriteActivation
            )
            : await renameEncryptedVaultFolder(
              serverFolder,
              profile.uid,
              privateKey,
              vaultIntegrityKey,
              name,
              pathRewriteActivation
            );
        commitFolders((current) => current.map((candidate) => candidate.id === folderId
          ? {
              ...candidate,
              ...persistedEncryptedFolderMutationPatch(result),
              displayName: name,
              revision: result.revision
            }
          : candidate));
      });
      setStatus(resolvingNameCollision
        ? "중복 폴더 이름을 해소해 검증을 다시 시작합니다."
        : `암호화된 폴더 이름을 변경하고 내부 참조 ${completed.confirmedCount}개 파일을 서버에서 확인했습니다.${sharedRewriteWarning(excludedSharedCount)}`);
      if (resolvingNameCollision) recheckVaultNameIntegrityAfterRepair();
    } catch (caught) {
      const underlyingError = caught instanceof VaultPathRewriteControllerError
        ? caught.cause
        : caught;
      const inventoryFailure = pathRewriteInventoryFailureMessage(underlyingError);
      if (inventoryFailure) {
        setError(inventoryFailure);
      } else if (underlyingError instanceof VaultNameConflictError) {
        setError("같은 위치에 동일한 이름의 폴더가 있어 이름을 변경하지 않았습니다.");
      } else if (underlyingError instanceof VaultFolderApiError && underlyingError.status === 409) {
        setError("다른 기기나 탭에서 폴더가 변경되어 이름을 바꾸지 않았습니다. 폴더 목록을 다시 확인해주세요.");
      } else {
        setError(caught instanceof Error ? caught.message : "폴더 이름을 변경하지 못했습니다.");
      }
    } finally {
      pathRewriteBusyRef.current = false;
      setPathRewriteBusy(false);
    }
  }

  async function renameEntry(entryId: string, requestedTitle?: string) {
    if (!profile || !privateKey || !vaultIntegrityKey) {
      setError("암호화된 이름 무결성 키가 준비될 때까지 항목 이름을 바꿀 수 없습니다.");
      return "retryable-failure" as const;
    }
    if (pathRewriteBusyRef.current) {
      setError("다른 경로 변경의 내부 참조를 확인하는 중입니다.");
      return "retryable-failure" as const;
    }
    if (clipboardAssetsPendingForEntry(entryId)) {
      setError("이미지 붙여넣기가 끝난 뒤 항목 이름을 변경해주세요.");
      return "retryable-failure" as const;
    }
    if (!canMutateExistingNameTarget(entryId)) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 항목 이름 변경이 잠깁니다.");
      return "retryable-failure" as const;
    }
    const existingMutation = entryMutationPromisesRef.current.get(entryId);
    if (existingMutation) {
      await existingMutation;
      return await renameEntryRef.current(entryId, requestedTitle);
    }
    const currentNotes = notesRef.current;
    const note = currentNotes.find((candidate) => candidate.id === entryId);
    const currentDraft = draftsRef.current[entryId];
    const resolvingNameCollision = vaultNameMigrationStatus === "blocked"
      && vaultNameCollisionTargetIds.has(entryId);
    if (!note || !currentDraft) {
      setError("이름을 변경할 항목의 편집 버퍼를 준비하지 못했습니다.");
      return "blocked" as const;
    }
    if (note.contentFormat === "legacy-html-v1" && !resolvingNameCollision) {
      setError("기존 HTML 노트는 Markdown 복사본으로 변환한 뒤 이름을 변경할 수 있습니다.");
      return "blocked" as const;
    }
    if (note.ownerUid !== profile.uid) {
      setError("공유 항목의 이름과 위치는 소유자만 변경할 수 있습니다.");
      return "blocked" as const;
    }
    const collisionRepairFolderId = resolvingNameCollision
      && note.type === "shared"
      && (note.folderId ?? null) !== null
        ? null
        : currentDraft.folderId;
    const title = (requestedTitle ?? window.prompt("항목 이름 변경", currentDraft.title))
      ?.trim()
      .normalize("NFC");
    // The inline title field already updates the draft before Save is pressed.
    // Compare against the persisted note, not the draft, or an inline rename is
    // incorrectly treated as a no-op and the tree/tab keep the old title.
    if (!title || title === note.title.trim()) {
      return "unchanged" as const;
    }
    if (currentNotes.some((candidate) => (
      candidate.id !== entryId
      && candidate.ownerUid === note.ownerUid
      && (candidate.folderId ?? null) === collisionRepairFolderId
      && normalizedEntryTitle(candidate.title, candidate.entryKind) === normalizedEntryTitle(title, note.entryKind)
    ))) {
      setError("같은 폴더에 동일한 이름의 항목이 있습니다.");
      return "blocked" as const;
    }
    const optimisticOperationId = stageOptimisticEntryPatch(entryId, {
      folderId: collisionRepairFolderId,
      title
    });
    if (!currentDraft.dirty) {
      captureMarkdownDraftBase(entryId, note, currentDraft);
    }
    const nextDraft = {
      ...currentDraft,
      dirty: true,
      folderId: collisionRepairFolderId,
      title
    };
    const stagedDrafts = { ...draftsRef.current, [entryId]: nextDraft };
    draftsRef.current = stagedDrafts;
    setDrafts(stagedDrafts);
    const finishEntryMutation = beginEntryMutation(entryId);
    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    pathRewriteBusyRef.current = true;
    setPathRewriteBusy(true);
    setPathRewriteJob(null);
    setError(null);
    try {
      if (!resolvingNameCollision) await flushOwnedRewriteDrafts(entryId);
      const refreshedNote = notesRef.current.find((candidate) => candidate.id === entryId);
      const refreshedDraftState = draftsRef.current[entryId];
      if (!refreshedNote || !refreshedDraftState || conflictedEntryIds.has(entryId)) {
        throw new Error("이름 변경 대상의 최신 server revision을 확인하지 못했습니다.");
      }
      const refreshedDraft = canonicalizeDraftTitle(refreshedDraftState);
      const server = await buildCurrentRevisionedIndexEntries();
      const serverTarget = server.notes.find((candidate) => candidate.id === entryId);
      if (
        !serverTarget
        || (serverTarget.revision ?? 0) !== refreshedDraft.baseRevision
      ) {
        throw new Error("이름 변경 대상이 다른 기기에서 변경되어 작업을 시작하지 않았습니다.");
      }
      const nextPath = vaultEntryPath({
        ...serverTarget,
        folderId: refreshedDraft.folderId,
        title
      }, server.folderPaths);
      const currentPath = vaultEntryPath(serverTarget, server.folderPaths);
      // Keep the server inventory as the base-generation authority while using
      // the current local target body for self-link planning. The API commits
      // that body, title, claim, and rewrite activation as one revision.
      const planningEntries = resolvingNameCollision
        ? server.entries
        : server.entries.map((entry) => (
            entry.id === entryId && (entry.kind === "markdown" || entry.kind === "canvas")
              ? { ...entry, content: refreshedDraft.body, revision: refreshedDraft.baseRevision }
              : entry
          ));
      const rewritePlans = resolvingNameCollision
        ? { canvasPlans: [], markdownPlans: [] }
        : planVaultContentPathRewritesForPathChanges({
            entries: planningEntries,
            pathChanges: [{ entryId, newPath: nextPath, oldPath: currentPath }]
          });
      const excludedSharedCount = resolvingNameCollision ? 0 : excludedSharedRewriteSourceCount([
        { entryId, newPath: nextPath, oldPath: currentPath }
      ]);
      const selfPlan = rewritePlans.markdownPlans.find((plan) => plan.sourceEntryId === entryId);
      const selfCanvasPlan = rewritePlans.canvasPlans.find((plan) => plan.sourceEntryId === entryId);
      const sourcePlans = (await buildVaultPathRewriteSourcePlans({
        canvasPlans: rewritePlans.canvasPlans,
        entries: planningEntries,
        markdownPlans: rewritePlans.markdownPlans
      })).filter((plan) => plan.sourceEntryId !== entryId);
      const prepared = await prepareVaultPathRewriteJob(vaultIntegrityKey, {
        ...server.inventoryBinding,
        mutationTarget: { expectedRevision: refreshedDraft.baseRevision, id: entryId, kind: "entry" },
        ownerUid: profile.uid,
        pathChanges: [{ entryId, newPath: nextPath, oldPath: currentPath }],
        sourcePlans
      });
      let pathMutationDraft: DraftState | null = null;
      let pathMutationPersistedBody = serverTarget.body;
      let pathMutationLocallyConfirmed = false;
      let pathMutationSupersededRevision: number | null = null;
      let pathMutationSupersededHasConflict = false;
      const commitRenamedTarget = (
        result: {
          encryptedBody?: DecryptedVaultNote["encryptedBody"];
          encryptedTitle?: DecryptedVaultNote["encryptedTitle"];
          revision: number;
          vaultNameClaimId?: string;
          vaultNameIndexVersion?: DecryptedVaultNote["vaultNameIndexVersion"];
        },
        rewrittenDraft: DraftState,
        persistedBody: string
      ) => {
        const canonicalRewritten = canonicalizeDraftTitle(rewrittenDraft);
        const latestBeforeCommit = draftsRef.current[entryId];
        const draftAlreadyNewer = Boolean(
          latestBeforeCommit && latestBeforeCommit.baseRevision > result.revision
        );
        const currentCandidate = notesRef.current.find((candidate) => candidate.id === entryId);
        let observedRevision = currentCandidate?.revision ?? result.revision;
        let revisionRelation: ReturnType<typeof persistedRevisionRelation> = currentCandidate
          ? persistedRevisionRelation(currentCandidate.revision, result.revision)
          : "superseded";
        if (draftAlreadyNewer) {
          revisionRelation = "superseded";
          observedRevision = Math.max(observedRevision, latestBeforeCommit?.baseRevision ?? 0);
        }
        const currentRevisionPayloadMatches = currentCandidate
          ? revisionRelation !== "current" || (
              currentCandidate.body === persistedBody
              && (currentCandidate.folderId ?? null) === canonicalRewritten.folderId
              && currentCandidate.title === canonicalRewritten.title
            )
          : false;
        commitNotes((current) => current.map((candidate) => {
          if (candidate.id !== entryId) return candidate;
          if (revisionRelation !== "apply") return candidate;
          return {
            ...candidate,
            ...persistedEncryptedMutationPatch(result),
            body: persistedBody,
            folderId: canonicalRewritten.folderId,
            title: canonicalRewritten.title,
            revision: result.revision
          };
        }));
        const latest = draftsRef.current[entryId];
        if (revisionRelation === "superseded" || !currentRevisionPayloadMatches) {
          pathMutationSupersededRevision = observedRevision;
          if (!currentRevisionPayloadMatches || Boolean(latest?.dirty && latest.baseRevision < observedRevision)) {
            pathMutationSupersededHasConflict = true;
            setConflictedEntryIds((current) => new Map(current).set(entryId, observedRevision));
            setError("이름 변경 응답보다 최신 서버 revision을 유지했습니다. 현재 편집본은 덮어쓰지 않았습니다.");
          }
          pathMutationLocallyConfirmed = true;
          return;
        }
        if (latest?.baseRevision === result.revision) {
          // A matching subscription may arrive before this continuation. The
          // draft already has the persisted rename as its base, including any
          // later local keystrokes that must stay dirty.
        } else if (latest && sameDraftPayload(latest, refreshedDraft)) {
          const nextDrafts = {
            ...draftsRef.current,
            [entryId]: {
              ...canonicalRewritten,
              baseRevision: result.revision,
              dirty: canonicalRewritten.body !== persistedBody
            }
          };
          draftsRef.current = nextDrafts;
          setDrafts(nextDrafts);
        } else if (latest) {
          pathMutationSupersededRevision = result.revision;
          pathMutationSupersededHasConflict = true;
          setConflictedEntryIds((current) => new Map(current).set(entryId, result.revision));
          setError("이름 변경을 저장하는 동안 편집본이 변경되었습니다. 현재 편집은 보존하고 서버 결과와 안전하게 비교합니다.");
        }
        pathMutationLocallyConfirmed = true;
      };
      const completed = await executePreparedPathRewrite(prepared, async (pathRewriteActivation) => {
        let rewrittenDraft = canonicalizeDraftTitle({ ...refreshedDraft, dirty: false, title });
        if (selfPlan) {
          const applied = applyInternalLinkRewritePlan(
            selfPlan,
            refreshedDraft.body,
            refreshedDraft.baseRevision
          );
          if (applied.status !== "applied") throw new Error("자기 링크 source가 변경되었습니다.");
          rewrittenDraft = { ...rewrittenDraft, body: applied.markdown };
        } else if (selfCanvasPlan) {
          const applied = applyCanvasPathRewritePlan(
            selfCanvasPlan,
            refreshedDraft.body,
            refreshedDraft.baseRevision
          );
          if (applied.status !== "applied") throw new Error("Canvas 자기 링크 source가 변경되었습니다.");
          rewrittenDraft = { ...rewrittenDraft, body: applied.source };
        }
        pathMutationDraft = rewrittenDraft;
        pathMutationPersistedBody = resolvingNameCollision ? serverTarget.body : rewrittenDraft.body;
        const revisionedTarget = { ...serverTarget, revision: refreshedDraft.baseRevision };
        const result = resolvingNameCollision
          ? await resolveDeferredVaultEntryCollision(
              revisionedTarget,
              profile.uid,
              privateKey,
              vaultIntegrityKey,
              { folderId: rewrittenDraft.folderId, title },
              pathRewriteActivation
            )
          : await saveEncryptedVaultEntry(
              revisionedTarget,
              profile.uid,
              privateKey,
              vaultIntegrityKey,
              rewrittenDraft,
              pathRewriteActivation
            );
        commitRenamedTarget(result, rewrittenDraft, pathMutationPersistedBody);
      });
      if (!pathMutationLocallyConfirmed) {
        const committedDraft = pathMutationDraft as DraftState | null;
        if (!committedDraft) {
          throw new Error("이름 변경 결과를 로컬 편집 버퍼와 연결하지 못했습니다.");
        }
        const remote = await readCurrentServerVaultEntry(entryId);
        const confirmed = findConfirmedDraftSubmission({
          body: remote.body,
          folderId: remote.folderId ?? null,
          revision: remote.revision ?? 0,
          title: remote.title
        }, [{ ...committedDraft, body: pathMutationPersistedBody }]);
        if (!confirmed || remote.ownerUid !== profile.uid) {
          throw new Error("서버에서 완료된 이름 변경 결과의 revision과 암호화 payload를 확인하지 못했습니다.");
        }
        commitRenamedTarget({
          encryptedBody: remote.encryptedBody,
          encryptedTitle: remote.encryptedTitle,
          revision: remote.revision ?? 0,
          vaultNameClaimId: remote.vaultNameClaimId,
          vaultNameIndexVersion: remote.vaultNameIndexVersion
        }, committedDraft, pathMutationPersistedBody);
      }
      if (pathMutationSupersededRevision !== null) {
        if (!pathMutationSupersededHasConflict) {
          setStatus("늦게 도착한 이름 변경 응답은 적용하지 않고 이미 수신한 최신 서버 revision을 유지했습니다.");
        }
        if (resolvingNameCollision) recheckVaultNameIntegrityAfterRepair();
        return pathMutationSupersededHasConflict ? "blocked" as const : "saved" as const;
      }
      const selfRewriteCount = (selfPlan?.patches.length ?? 0) + (selfCanvasPlan?.changeCount ?? 0);
      setStatus(resolvingNameCollision
        ? "중복 이름을 해소해 검증을 다시 시작합니다. 모호한 기존 링크는 자동 귀속하지 않습니다."
        : `이름을 변경하고 내부 참조 ${completed.confirmedCount + selfRewriteCount}개를 확인했습니다.${sharedRewriteWarning(excludedSharedCount)}`);
      if (resolvingNameCollision) recheckVaultNameIntegrityAfterRepair();
      return "saved" as const;
    } catch (caught) {
      const underlyingError = caught instanceof VaultPathRewriteControllerError
        ? caught.cause
        : caught;
      const inventoryFailure = pathRewriteInventoryFailureMessage(underlyingError);
      if (inventoryFailure) {
        setError(inventoryFailure);
        return underlyingError
          && typeof underlyingError === "object"
          && "code" in underlyingError
          && String(underlyingError.code) === "vault_path_rewrite_inventory_changed"
          ? "retryable-failure" as const
          : "blocked" as const;
      } else if (underlyingError instanceof NoteRevisionConflictError) {
        setConflictedEntryIds((current) => new Map(current).set(entryId, underlyingError.actualRevision));
        setError("다른 기기나 탭에서 이 항목이 변경되어 이름을 바꾸지 않았습니다. 현재 편집본은 그대로 보존됩니다.");
        if (isMarkdownMergeEntry(note)) void prepareDraftMergeConflict(entryId, false);
        return "blocked" as const;
      } else if (underlyingError instanceof VaultNameConflictError) {
        setError("같은 폴더에 동일한 이름의 항목이 있어 이름을 변경하지 않았습니다.");
        return "blocked" as const;
      } else {
        setError(caught instanceof Error ? caught.message : "항목 이름을 변경하지 못했습니다.");
        return "retryable-failure" as const;
      }
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      finishEntryMutation();
      finishOptimisticEntryPatch(entryId, optimisticOperationId);
      pathRewriteBusyRef.current = false;
      setPathRewriteBusy(false);
    }
  }

  async function restoreTrashEntry(entryId: string) {
    if (!profile || !privateKey || !vaultIntegrityKey || !vaultNameWritesReady || !trashServerReady) {
      setError("서버의 휴지통과 이름 예약을 확인한 뒤 복원할 수 있습니다.");
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("내부 참조 갱신이 끝난 뒤 휴지통 항목을 복원해주세요.");
      return;
    }
    const note = trashNotes.find((candidate) => candidate.id === entryId);
    if (!note || note.ownerUid !== profile.uid || note.isDeleted !== true) {
      setError("내가 소유한 삭제 항목만 복원할 수 있습니다.");
      return;
    }
    if (
      note.folderId !== null
      && note.folderId !== undefined
      && !foldersRef.current.some((folder) => folder.id === note.folderId)
    ) {
      setError("원래 폴더가 존재하지 않아 자동 복원하지 않았습니다. 폴더 복구 기능이 준비될 때까지 원본은 휴지통에 보존됩니다.");
      return;
    }
    const activeCollision = notesRef.current.some((candidate) => (
      candidate.ownerUid === note.ownerUid
      && candidate.id !== note.id
      && (candidate.folderId ?? null) === (note.folderId ?? null)
      && normalizedEntryTitle(candidate.title, candidate.entryKind) === normalizedEntryTitle(note.title, note.entryKind)
    ));
    if (activeCollision) {
      setError("원래 위치에 동일한 이름의 항목이 있어 복원하지 않았습니다.");
      return;
    }
    if (note.vaultNameClaimId && note.vaultNameIndexVersion !== VAULT_NAME_INDEX_VERSION) {
      setError("삭제 항목의 이름 예약 버전을 확인할 수 없어 복원을 잠갔습니다.");
      return;
    }

    setTrashBusyEntryIds((current) => new Set(current).add(entryId));
    setError(null);
    try {
      // Always send the deterministic reservation. The server atomically
      // reuses a retained versioned claim id or creates the missing claim for
      // a deleted legacy entry that was migrated identity-only.
      const nameClaim = {
        claimId: await vaultNameFingerprint(vaultIntegrityKey, {
          kind: note.entryKind,
          name: note.title,
          parentId: note.folderId ?? null,
          targetType: "entry"
        }),
        indexVersion: VAULT_NAME_INDEX_VERSION,
        parentId: note.folderId ?? null
      };
      await restoreRevisionedNote({
        expectedRevision: note.revision ?? 0,
        nameClaim,
        noteId: note.id,
        readerUids: note.participantUids,
        uid: profile.uid
      });
      setTrashNotes((current) => current.filter((candidate) => candidate.id !== entryId));
      setStatus("Vault 휴지통 항목을 원래 위치로 복원했습니다.");
    } catch (caught) {
      if (caught instanceof VaultNameConflictError) {
        setError("원래 위치에 동일한 이름의 항목이 있어 복원하지 않았습니다.");
      } else if (caught instanceof NoteRevisionConflictError) {
        setError("다른 기기에서 휴지통 항목이 변경되어 복원하지 않았습니다. 목록을 다시 확인해주세요.");
      } else {
        setError(caught instanceof Error ? caught.message : "Vault 휴지통 항목을 복원하지 못했습니다.");
      }
    } finally {
      setTrashBusyEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  }

  async function restoreTrashFolder(folderId: string) {
    if (!profile || !vaultNameWritesReady || !trashServerReady) {
      setError("서버의 폴더 휴지통과 이름 예약을 확인한 뒤 복원할 수 있습니다.");
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("내부 참조 갱신이 끝난 뒤 폴더를 복원해주세요.");
      return;
    }
    const item = trashFolders.find((candidate) => candidate.folder.id === folderId);
    if (!item || item.folder.ownerUid !== profile.uid || item.folder.isDeleted !== true) {
      setError("내가 소유한 가장 바깥쪽 삭제 폴더만 복원할 수 있습니다.");
      return;
    }

    setTrashBusyFolderIds((current) => new Set(current).add(folderId));
    setError(null);
    try {
      pendingFolderRestoreRef.current = {
        folderId,
        revision: (item.folder.revision ?? 0) + 1
      };
      await restoreRevisionedEncryptedFolderSubtree({
        expectedRevision: item.folder.revision ?? 0,
        folderId,
        folders: allFolderSnapshotsRef.current,
        ownerUid: profile.uid
      });
      setTrashFolders((current) => current.filter((candidate) => candidate.folder.id !== folderId));
      if (pendingFolderRestoreRef.current?.folderId === folderId) {
        setStatus("폴더 복원 요청을 저장했습니다. 서버에서 전체 활성 경로를 확인하는 중입니다…");
      }
    } catch (caught) {
      pendingFolderRestoreRef.current = null;
      if (caught instanceof VaultNameConflictError) {
        setError("원래 위치에 동일한 이름의 폴더가 있어 복원하지 않았습니다.");
      } else if (caught instanceof NoteRevisionConflictError) {
        setError("다른 기기에서 폴더가 변경되어 복원하지 않았습니다. 휴지통을 다시 확인해주세요.");
      } else {
        setError(caught instanceof Error ? caught.message : "암호화 폴더를 복원하지 못했습니다.");
      }
    } finally {
      setTrashBusyFolderIds((current) => {
        const next = new Set(current);
        next.delete(folderId);
        return next;
      });
    }
  }

  function clipboardAssetsPendingForEntry(entryId: string) {
    return pendingClipboardAssetIdsRef.current.has(entryId)
      || pendingClipboardPasteCountsRef.current.has(entryId)
      || [...pendingClipboardAssetTitleKeysRef.current.values()]
        .some((reservation) => reservation.sourceNoteId === entryId);
  }

  function clipboardPendingAssetFolderIds() {
    const titleReservations = pendingClipboardAssetTitleKeysRef.current;
    const pendingAssetIds = pendingClipboardAssetIdsRef.current;
    if (titleReservations.size === 0 && pendingAssetIds.size === 0) {
      return new Set<string>();
    }
    const runtime = pastedImageFolderRuntimeRef.current;
    if (!runtime) {
      return new Set(foldersRef.current.map((folder) => folder.id));
    }
    return runtime.pendingFolderIds(
      titleReservations.values(),
      pendingAssetIds,
      notesRef.current
    );
  }

  function clipboardAssetsPendingForFolder(folderId: string) {
    return clipboardPendingAssetFolderIds().has(folderId);
  }

  async function moveFolderToTrash(folderId: string, confirmed = false) {
    if (!profile || !vaultNameWritesReady || folderServerReservationSignature === null) {
      setError("서버의 전체 폴더 트리와 이름 예약을 확인한 뒤 휴지통으로 이동할 수 있습니다.");
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("내부 참조 갱신이 끝난 뒤 폴더를 휴지통으로 이동해주세요.");
      return;
    }
    if (folderTrashLockedFolderIdsRef.current.size > 0) {
      setError("다른 폴더의 휴지통 처리가 끝난 뒤 다시 시도해주세요.");
      return;
    }
    if (!canMutateExistingNameTarget(folderId)) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 폴더 휴지통 이동이 잠깁니다.");
      return;
    }
    const folder = foldersRef.current.find((candidate) => candidate.id === folderId);
    if (!folder || folder.ownerUid !== profile.uid || !folder.encryptedName || !folder.wrappedKey) {
      setError("내가 소유한 암호화 폴더만 휴지통으로 이동할 수 있습니다.");
      return;
    }
    const pendingAssetFolderIds = clipboardPendingAssetFolderIds();
    if (pendingAssetFolderIds.has(folderId)) {
      setError("이미지 붙여넣기가 끝난 뒤 이 폴더를 휴지통으로 이동해주세요.");
      return;
    }
    const projected = partitionVaultFolderTrash(foldersRef.current.map((candidate) => (
      candidate.id === folderId ? { ...candidate, isDeleted: true } : candidate
    )));
    const hiddenFolderIds = projected.hiddenFolderIds;
    const hiddenEntryIds = new Set(notesRef.current
      .filter((note) => {
        const parentId = note.folderId ?? null;
        return parentId !== null && hiddenFolderIds.has(parentId);
      })
      .map((note) => note.id));
    if ([...hiddenEntryIds].some(clipboardAssetsPendingForEntry)) {
      setError("하위 노트의 이미지 붙여넣기가 끝난 뒤 폴더를 휴지통으로 이동해주세요.");
      return;
    }
    if ([...hiddenFolderIds].some((hiddenFolderId) => pendingAssetFolderIds.has(hiddenFolderId))) {
      setError("하위 폴더의 이미지 붙여넣기가 끝난 뒤 폴더를 휴지통으로 이동해주세요.");
      return;
    }
    if ([...hiddenEntryIds].some((entryId) => deletingEntryIdsRef.current.has(entryId))) {
      setError("하위 항목 변경이 끝난 뒤 폴더를 휴지통으로 이동해주세요.");
      return;
    }
    if (!confirmed && !window.confirm(
      `'${folder.displayName}' 폴더와 하위 폴더 ${Math.max(0, hiddenFolderIds.size - 1)}개, 항목 ${hiddenEntryIds.size}개를 Vault 휴지통으로 이동할까요?`
    )) return;

    hiddenFolderIds.forEach((hiddenFolderId) => {
      folderTrashLockedFolderIdsRef.current.add(hiddenFolderId);
    });
    hiddenEntryIds.forEach((entryId) => {
      deletingEntryIdsRef.current.add(entryId);
    });
    setDeletingEntryIds((current) => new Set([...current, ...hiddenEntryIds]));
    setTrashBusyFolderIds((current) => new Set(current).add(folderId));
    setError(null);
    let ownsPathLock = false;
    try {
      await flushOwnedRewriteDrafts();
      if ([...hiddenEntryIds].some(clipboardAssetsPendingForEntry)) {
        throw new Error("하위 노트의 이미지 붙여넣기 상태가 변경되어 폴더 휴지통 처리를 중단했습니다.");
      }
      const refreshedPendingAssetFolderIds = clipboardPendingAssetFolderIds();
      if ([...hiddenFolderIds].some((hiddenFolderId) => refreshedPendingAssetFolderIds.has(hiddenFolderId))) {
        throw new Error("하위 폴더의 이미지 붙여넣기 상태가 변경되어 폴더 휴지통 처리를 중단했습니다.");
      }
      if (pathRewriteBusyRef.current) {
        throw new Error("다른 경로 변경이 시작되어 폴더 휴지통 처리를 중단했습니다.");
      }
      pathRewriteBusyRef.current = true;
      ownsPathLock = true;
      setPathRewriteBusy(true);
      const shareableSourceNoteIds = notesRef.current.flatMap((note) => (
        hiddenEntryIds.has(note.id)
        && note.ownerUid === profile.uid
        && (note.entryKind === "markdown" || note.entryKind === "legacy-html")
          ? [note.id]
          : []
      ));
      let revokedShareCount = 0;
      if (shareableSourceNoteIds.length > 0) {
        const { revokeVaultSecureSharesBeforeSourcesTrash } = await import(
          "../features/vault/vaultSecureShareLifecycle"
        );
        revokedShareCount = await revokeVaultSecureSharesBeforeSourcesTrash({
          getIdToken,
          sourceNoteIds: shareableSourceNoteIds
        });
      }
      await trashRevisionedEncryptedFolderSubtree({
        expectedRevision: folder.revision ?? 0,
        folderId,
        folders: allFolderSnapshotsRef.current,
        ownerUid: profile.uid
      });
      commitFolders((current) => current.filter((candidate) => !hiddenFolderIds.has(candidate.id)));
      commitNotes((current) => current.filter((note) => !hiddenEntryIds.has(note.id)));
      setTabs((current) => current.filter((tab) => tab.kind !== "entry" || !hiddenEntryIds.has(tab.entryId)));
      if (activeEntryId && hiddenEntryIds.has(activeEntryId)) setActiveTabId(null);
      if (selectedFolderId && hiddenFolderIds.has(selectedFolderId)) setSelectedFolderId(null);
      setStatus(`폴더 하위 트리를 원자적으로 휴지통 처리했습니다. 항목 ${hiddenEntryIds.size}개는 원본 revision과 암호문을 그대로 보존합니다.${revokedShareCount > 0 ? ` 보안 공유 ${revokedShareCount}개를 중단했습니다.` : ""}`);
    } catch (caught) {
      if (caught instanceof NoteRevisionConflictError) {
        setError("다른 기기에서 폴더가 변경되어 휴지통으로 이동하지 않았습니다.");
      } else {
        setError(caught instanceof Error ? caught.message : "폴더를 휴지통으로 이동하지 못했습니다.");
      }
    } finally {
      if (ownsPathLock) {
        pathRewriteBusyRef.current = false;
        setPathRewriteBusy(false);
      }
      hiddenFolderIds.forEach((hiddenFolderId) => {
        folderTrashLockedFolderIdsRef.current.delete(hiddenFolderId);
      });
      hiddenEntryIds.forEach((entryId) => {
        deletingEntryIdsRef.current.delete(entryId);
      });
      setDeletingEntryIds((current) => {
        const next = new Set(current);
        hiddenEntryIds.forEach((entryId) => next.delete(entryId));
        return next;
      });
      setTrashBusyFolderIds((current) => {
        const next = new Set(current);
        next.delete(folderId);
        return next;
      });
    }
  }

  async function openVaultShareManager(
    entryId: string,
    returnFocusTo: HTMLElement | null
  ) {
    if (clipboardAssetsPendingForEntry(entryId)) {
      setError("붙여넣은 이미지가 서버 Vault 목록에 반영된 뒤 노트 공유를 열어주세요.");
      return;
    }
    const existingMutation = entryMutationPromisesRef.current.get(entryId);
    if (existingMutation) await existingMutation;

    const initialNote = notesRef.current.find((candidate) => candidate.id === entryId);
    if (
      !initialNote
      || initialNote.ownerUid !== profile.uid
      || initialNote.isDeleted
      || (initialNote.entryKind !== "markdown" && initialNote.entryKind !== "legacy-html")
      || (initialNote.contentFormat !== "markdown-v1" && initialNote.contentFormat !== "legacy-html-v1")
    ) {
      setError("내가 소유한 Markdown 또는 기존 노트만 공유할 수 있습니다.");
      return;
    }

    if (draftsRef.current[entryId]?.dirty) {
      await saveEntryRef.current(entryId);
    }
    const savedDraft = draftsRef.current[entryId];
    const savedNote = notesRef.current.find((candidate) => candidate.id === entryId);
    if (
      !savedNote
      || savedNote.ownerUid !== profile.uid
      || savedNote.isDeleted
      || savedDraft?.dirty
      || conflictedEntryIds.has(entryId)
      || entryMutationPromisesRef.current.has(entryId)
    ) {
      setError("현재 편집 내용을 먼저 암호화해 저장한 뒤 공유를 열 수 있습니다.");
      return;
    }
    if (clipboardAssetsPendingForEntry(entryId)) {
      setError("붙여넣은 이미지가 서버 Vault 목록에 반영된 뒤 노트 공유를 열어주세요.");
      return;
    }

    const { embeddedVaultAssetIdsForShare } = await import(
      "../features/vault/vaultShareEligibility"
    );
    const latestSavedNote = notesRef.current.find((candidate) => candidate.id === entryId);
    if (
      clipboardAssetsPendingForEntry(entryId)
      || draftsRef.current[entryId]?.dirty
      || conflictedEntryIds.has(entryId)
      || entryMutationPromisesRef.current.has(entryId)
      || !latestSavedNote
      || latestSavedNote.ownerUid !== profile.uid
      || latestSavedNote.isDeleted
      || (latestSavedNote.revision ?? 0) !== (savedNote.revision ?? 0)
    ) {
      setError("공유 상태를 확인하는 동안 노트가 변경되었습니다. 저장이 끝난 뒤 다시 열어주세요.");
      return;
    }
    const hasUnsharedAssetEmbeds = embeddedVaultAssetIdsForShare(
      latestSavedNote,
      entryPaths.get(latestSavedNote.id) ?? entryLabel(latestSavedNote),
      indexEntries
    ).length > 0;

    setError(null);
    setShareTarget({ hasUnsharedAssetEmbeds, note: latestSavedNote, returnFocusTo });
  }

  async function moveEntryToTrash(entryId: string, confirmed = false) {
    if (!profile || !privateKey || !vaultIntegrityKey) {
      setError("암호화된 이름 무결성 키가 준비될 때까지 항목을 휴지통으로 이동할 수 없습니다.");
      return;
    }
    if (pathRewriteBusyRef.current) {
      setError("내부 참조 갱신이 끝난 뒤 항목을 휴지통으로 이동해주세요.");
      return;
    }
    if (clipboardAssetsPendingForEntry(entryId)) {
      setError("이미지 붙여넣기가 끝난 뒤 항목을 휴지통으로 이동해주세요.");
      return;
    }
    if (!canMutateExistingNameTarget(entryId)) {
      setError("암호화된 이름 예약 검증이 끝날 때까지 휴지통 이동이 잠깁니다.");
      return;
    }
    const existingMutation = entryMutationPromisesRef.current.get(entryId);
    if (existingMutation) {
      await existingMutation;
      await trashEntryRef.current(entryId, confirmed);
      return;
    }
    const note = notesRef.current.find((candidate) => candidate.id === entryId);
    if (!note || note.ownerUid !== profile.uid) {
      setError("내가 소유한 항목만 휴지통으로 이동할 수 있습니다.");
      return;
    }
    if (!confirmed && !window.confirm(`'${entryLabel(note)}' 항목을 Vault 휴지통으로 이동할까요? 왼쪽 리본의 휴지통에서 복원할 수 있습니다.`)) {
      return;
    }

    const optimisticOperationId = stageOptimisticEntryPatch(entryId, { hidden: true });
    const finishEntryMutation = beginEntryMutation(entryId);
    deletingEntryIdsRef.current.add(entryId);
    setDeletingEntryIds((current) => new Set(current).add(entryId));
    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    try {
      const draft = draftsRef.current[entryId];
      let expectedRevision = note.revision ?? 0;
      let revokedShareCount = 0;
      if (draft?.dirty && note.contentFormat !== "legacy-html-v1") {
        const saved = await saveEncryptedVaultEntry(
          { ...note, revision: draft.baseRevision },
          profile.uid,
          privateKey,
          vaultIntegrityKey,
          draft
        );
        expectedRevision = saved.revision;
        const latest = draftsRef.current[entryId] ?? draft;
        const reconciled = reconcileDraftAfterSave(latest, draft, saved.revision);
        const nextDrafts = { ...draftsRef.current, [entryId]: reconciled };
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
        commitNotes((current) => current.map((candidate) => candidate.id === entryId
          ? {
              ...candidate,
              ...persistedEncryptedMutationPatch(saved),
              body: draft.body,
              folderId: draft.folderId,
              revision: saved.revision,
              title: draft.title.trim()
            }
          : candidate));
      }
      if (note.entryKind === "markdown" || note.entryKind === "legacy-html") {
        const { revokeVaultSecureSharesBeforeTrash } = await import(
          "../features/vault/vaultSecureShareLifecycle"
        );
        revokedShareCount = await revokeVaultSecureSharesBeforeTrash({
          getIdToken,
          sourceNoteId: entryId
        });
      }
      await deleteRevisionedNote({
        expectedRevision,
        noteId: entryId,
        readerUids: note.participantUids,
        uid: profile.uid
      });
      commitNotes((current) => current.filter((candidate) => candidate.id !== entryId));
      const nextDrafts = { ...draftsRef.current };
      delete nextDrafts[entryId];
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setTabs((current) => current.filter((tab) => tab.kind !== "entry" || tab.entryId !== entryId));
      if (activeEntryId === entryId) {
        setActiveTabId(null);
      }
      setStatus(revokedShareCount > 0
        ? `보안 공유 ${revokedShareCount}개를 중단하고 항목을 휴지통으로 이동했습니다.`
        : "항목을 휴지통으로 이동하고 revision 이력을 남겼습니다.");
    } catch (caught) {
      if (caught instanceof NoteRevisionConflictError) {
        setConflictedEntryIds((current) => new Map(current).set(entryId, caught.actualRevision));
        setError("다른 기기나 탭에서 이 항목이 변경되어 휴지통으로 이동하지 않았습니다. 현재 편집본은 보존됩니다.");
      } else {
        setError(caught instanceof Error ? caught.message : "항목을 휴지통으로 이동하지 못했습니다.");
      }
    } finally {
      deletingEntryIdsRef.current.delete(entryId);
      setDeletingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      finishEntryMutation();
      finishOptimisticEntryPatch(entryId, optimisticOperationId);
    }
  }

  function ownedVaultTreeTargets(targets: readonly VaultTreeTarget[]) {
    if (!targets.length || targets.length > MAXIMUM_VAULT_TREE_SELECTION) return false;
    return targets.every((target) => target.kind === "entry"
      ? notesRef.current.some((note) => note.id === target.id && note.ownerUid === profile.uid && note.type === "personal")
      : foldersRef.current.some((folder) => (
          folder.id === target.id
          && folder.ownerUid === profile.uid
          && Boolean(folder.encryptedName && folder.wrappedKey)
        )));
  }

  function bulkMoveHasNameCollision(targets: readonly VaultTreeTarget[], folderId: string | null) {
    const selectedEntryIds = new Set(targets.filter((target) => target.kind === "entry").map((target) => target.id));
    const selectedFolderIds = new Set(targets.filter((target) => target.kind === "folder").map((target) => target.id));
    const movingEntryNames = new Set<string>();
    const movingFolderNames = new Set<string>();
    for (const target of targets) {
      if (target.kind === "entry") {
        const note = notesRef.current.find((candidate) => candidate.id === target.id);
        const draft = draftsRef.current[target.id];
        if (!note || !draft || (note.folderId ?? null) === folderId) continue;
        const name = normalizedEntryTitle(draft.title, note.entryKind);
        if (movingEntryNames.has(name) || notesRef.current.some((candidate) => (
          !selectedEntryIds.has(candidate.id)
          && candidate.ownerUid === profile.uid
          && (candidate.folderId ?? null) === folderId
          && normalizedEntryTitle(candidate.title, candidate.entryKind) === name
        ))) return true;
        movingEntryNames.add(name);
      } else {
        const folder = foldersRef.current.find((candidate) => candidate.id === target.id);
        if (!folder || (folder.parentId ?? null) === folderId) continue;
        const name = folder.displayName.trim().normalize("NFC").toLocaleLowerCase();
        if (movingFolderNames.has(name) || foldersRef.current.some((candidate) => (
          !selectedFolderIds.has(candidate.id)
          && (candidate.parentId ?? null) === folderId
          && candidate.displayName.trim().normalize("NFC").toLocaleLowerCase() === name
        ))) return true;
        movingFolderNames.add(name);
      }
    }
    return false;
  }

  async function renameVaultTreeTarget(target: VaultTreeTarget) {
    if (!ownedVaultTreeTargets([target])) {
      setError("내가 소유한 암호화 항목이나 폴더만 이름을 변경할 수 있습니다.");
      return;
    }
    if (target.kind === "entry") await renameEntry(target.id);
    else await renameFolder(target.id);
  }

  async function moveVaultTreeTargets(targets: readonly VaultTreeTarget[], folderId: string | null) {
    if (!ownedVaultTreeTargets(targets)) {
      setError(`한 번에 1~${MAXIMUM_VAULT_TREE_SELECTION}개의 내가 소유한 암호화 항목만 이동할 수 있습니다.`);
      return false;
    }
    if (bulkMoveHasNameCollision(targets, folderId)) {
      setError("선택 항목끼리 또는 대상 폴더의 기존 항목과 이름이 충돌해 일괄 이동을 시작하지 않았습니다.");
      return false;
    }
    setError(null);
    setStatus(`선택한 ${targets.length}개 항목을 revision 확인 후 순차 이동하는 중입니다…`);
    for (const target of targets) {
      if (target.kind === "entry") await moveEntryToFolder(target.id, folderId);
      else await moveFolder(target.id, folderId);
    }
    setStatus("선택 항목의 이동 요청을 순차 처리했습니다. 충돌 알림이 표시된 항목은 원래 위치에 보존됩니다.");
    return true;
  }

  async function trashVaultTreeTargets(targets: readonly VaultTreeTarget[]) {
    if (!ownedVaultTreeTargets(targets)) {
      setError(`한 번에 1~${MAXIMUM_VAULT_TREE_SELECTION}개의 내가 소유한 암호화 항목만 휴지통으로 이동할 수 있습니다.`);
      return false;
    }
    setError(null);
    setStatus(`선택한 ${targets.length}개 항목을 revision 확인 후 순차 휴지통 처리하는 중입니다…`);
    for (const target of targets.filter((candidate) => candidate.kind === "folder")) {
      await moveFolderToTrash(target.id, true);
    }
    for (const target of targets.filter((candidate) => candidate.kind === "entry")) {
      await moveEntryToTrash(target.id, true);
    }
    setStatus("선택 항목의 휴지통 요청을 순차 처리했습니다. 충돌 알림이 표시된 항목은 원본 그대로 보존됩니다.");
    return true;
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

  function handleMarkdownLinkPreviewInteraction(
    reference: MarkdownLinkReference,
    interaction: MarkdownLinkPreviewInteraction
  ) {
    const { active, anchor, source } = interaction;
    if ((viewMode !== "reading" && viewMode !== "live-preview") || reference.kind === "external") {
      return;
    }
    if (
      source === "pointer"
      && active
      && (
        typeof window.matchMedia !== "function"
        || !window.matchMedia("(hover: hover) and (pointer: fine)").matches
      )
    ) {
      // Coarse/touch pointers keep their first tap for opening the note instead
      // of synthesizing a hover popup over the workspace.
      return;
    }

    if (!active) {
      const intent = pagePreviewIntentRef.current;
      if (!intent || intent.anchor !== anchor) return;
      intent.sources.delete(source);
      if (intent.sources.size > 0) return;
      clearVaultPagePreviewTimer(pagePreviewOpenTimerRef);
      clearVaultPagePreviewTimer(pagePreviewCloseTimerRef);
      const reducedMotion = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      pagePreviewCloseTimerRef.current = window.setTimeout(() => {
        const latestIntent = pagePreviewIntentRef.current;
        if (
          latestIntent?.anchor === anchor
          && latestIntent.sources.size === 0
        ) {
          dismissVaultPagePreview();
        }
      }, vaultPagePreviewDelay("close", source, reducedMotion));
      return;
    }

    const resolution = resolveMarkdownReference(reference);
    const target = resolution?.targetEntryId
      ? noteById.get(resolution.targetEntryId)
      : null;
    const content = createVaultPagePreviewContent({
      reference,
      resolvedTargetEntryId: resolution?.targetEntryId,
      target: target ? {
        body: draftsRef.current[target.id]?.body ?? target.body,
        contentFormat: target.contentFormat,
        entryKind: target.entryKind,
        id: target.id,
        path: entryPaths.get(target.id) ?? entryLabel(target),
        title: draftsRef.current[target.id]?.title ?? target.title
      } : null
    });
    if (!content) {
      dismissVaultPagePreview();
      return;
    }

    clearVaultPagePreviewTimer(pagePreviewCloseTimerRef);
    const currentIntent = pagePreviewIntentRef.current;
    if (currentIntent?.anchor === anchor) {
      currentIntent.content = content;
      currentIntent.sources.add(source);
      if (pagePreviewVisibleAnchorRef.current === anchor) return;
    } else {
      clearVaultPagePreviewTimer(pagePreviewOpenTimerRef);
      pagePreviewVisibleAnchorRef.current = null;
      setPagePreview(null);
      pagePreviewIntentRef.current = {
        anchor,
        content,
        sources: new Set([source])
      };
    }

    const reducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    clearVaultPagePreviewTimer(pagePreviewOpenTimerRef);
    pagePreviewOpenTimerRef.current = window.setTimeout(() => {
      const intent = pagePreviewIntentRef.current;
      if (!intent || intent.anchor !== anchor || intent.sources.size === 0 || !anchor.isConnected) {
        return;
      }
      pagePreviewVisibleAnchorRef.current = anchor;
      setPagePreview({
        ...intent.content,
        ...vaultPagePreviewPosition(anchor.getBoundingClientRect(), {
          height: window.innerHeight,
          width: window.innerWidth
        })
      });
    }, vaultPagePreviewDelay("open", source, reducedMotion));
  }

  function handleMarkdownLink(
    reference: MarkdownLinkReference,
    event: Pick<MouseEvent<HTMLElement>, "ctrlKey" | "metaKey">,
    sourceEntryId = activeEntryId
  ) {
    if (reference.kind === "external") {
      return;
    }
    dismissVaultPagePreview();
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

  function openKanbanLink(target: string) {
    const hashIndex = target.indexOf("#");
    const path = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const subpath = hashIndex >= 0 ? target.slice(hashIndex) : null;
    const reference: MarkdownLinkReference = {
      display: target,
      embed: false,
      kind: "wikilink",
      path,
      raw: `[[${target}]]`,
      subpath,
      target
    };
    const resolution = resolveMarkdownReference(reference);
    if (resolution?.targetEntryId) {
      openEntry(resolution.targetEntryId);
      return;
    }
    const requestedPath = resolution?.unresolvedKey || path || target;
    if (window.confirm(`'${requestedPath}' 노트를 만들까요?`)) {
      void createUnresolvedMarkdownEntry(requestedPath);
    }
  }

  function editBaseProperty(entryId: string, property: string, value: FrontmatterValue) {
    if (deletingEntryIdsRef.current.has(entryId)) {
      setError("휴지통으로 이동 중인 항목은 속성을 수정할 수 없습니다.");
      return;
    }
    const note = notes.find((candidate) => candidate.id === entryId);
    const current = draftsRef.current[entryId];
    if (!note || !current || note.contentFormat !== "markdown-v1") {
      setError("Markdown 노트의 지원되는 최상위 속성만 Base에서 편집할 수 있습니다.");
      return;
    }
    try {
      if (!current.dirty) {
        captureMarkdownDraftBase(entryId, note, current);
      }
      const nextDraft: DraftState = {
        ...current,
        body: setFrontmatterProperty(current.body, property, value),
        dirty: true
      };
      const nextDrafts = { ...draftsRef.current, [entryId]: nextDraft };
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setSaveFailedEntryIds((currentFailures) => {
        const next = new Set(currentFailures);
        next.delete(entryId);
        return next;
      });
      setError(null);
      window.setTimeout(() => void saveEntry(entryId), 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Base 속성을 수정하지 못했습니다.");
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
      const asset = decodedAssetForEntry(target.id);
      return (
        <span className="vault-markdown-embed-card vault-markdown-embed-card--asset">
          {asset ? (
            <VaultAssetPreview
              asset={asset}
              compact
              fileName={draftsRef.current[target.id]?.title ?? target.title}
              inlineEmbed={{
                label: entryLabel(target),
                onOpen: () => openEntry(target.id)
              }}
            />
          ) : (
            <>
              <button onClick={() => openEntry(target.id)} type="button">{entryLabel(target)}</button>
              <span role="alert">첨부 데이터의 무결성을 확인할 수 없습니다.</span>
            </>
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
    const sourcePath = entryPaths.get(activeNote.id);
    if (profileName === "discord-ai") {
      const delivery = exportMarkdownForDiscordAi(activeDraft.body, { sourcePath });
      if (delivery.kind === "message-batch") {
        setDiscordMessageBatch(delivery);
        setStatus(`${delivery.messages.length}개 메시지로 안전하게 나눴습니다.`);
        return;
      }
      try {
        await navigator.clipboard.writeText(delivery.singleMessageContent);
        setStatus("Discord · AI 형식으로 복사했습니다.");
      } catch {
        setError("클립보드에 복사하지 못했습니다.");
      }
      return;
    }
    const exported = exportMarkdown(activeDraft.body, {
      profile: profileName,
      sourcePath
    });
    try {
      await navigator.clipboard.writeText(exported.content);
      setStatus(`${profileName} 형식으로 복사했습니다.`);
    } catch {
      setError("클립보드에 복사하지 못했습니다.");
    }
  }

  async function convertLegacyNote() {
    if (!activeNote || activeNote.contentFormat !== "legacy-html-v1") {
      return;
    }
    openCoreTool("format");
  }

  async function createNormalizedMarkdownCopy() {
    if (
      !activeNote
      || activeNote.contentFormat !== "markdown-v1"
      || !activeDraft
      || !activeMarkdownMayContainConvertibleHtml
    ) return;
    const preview = previewMarkdownHtmlNormalization(activeDraft.body);
    if (preview.changedBlockCount < 1) {
      setStatus(
        preview.warnings[0]?.message
        ?? "코드·YAML·인라인 HTML을 제외하면 변환할 블록 HTML이 없습니다."
      );
      return;
    }
    const warningLines = preview.warnings.map((item) => `• ${item.message}`).join("\n");
    const confirmed = window.confirm(
      `HTML 블록 ${preview.changedBlockCount}개를 Markdown으로 바꾼 복사본을 만듭니다. 원본과 첨부·공유 설정은 변경하지 않습니다.${warningLines ? `\n\n${warningLines}` : ""}`
    );
    if (!confirmed) return;
    await createEntry(
      "markdown",
      `${activeDraft.title.replace(/\.md$/iu, "")} Markdown`,
      preview.markdown,
      { folderId: activeDraft.folderId }
    );
  }

  async function exportObsidianZip() {
    if (!profile || !privateKey) {
      setError("암호화 잠금을 해제한 뒤 첨부파일을 포함한 ZIP을 내보낼 수 있습니다.");
      return;
    }
    const exportableNotes = notes.filter((note) => note.contentFormat !== "legacy-html-v1");
    if (!notes.length) {
      setError("내보낼 노트나 첨부파일이 없습니다.");
      return;
    }
    setError(null);
    setStatus("복호화된 노트와 첨부파일을 포함한 Obsidian 호환 ZIP을 만드는 중입니다…");
    exportAbortRef.current?.abort();
    const abortController = new AbortController();
    exportAbortRef.current = abortController;
    try {
      const [
        { exportObsidianVaultZipInWorker },
        {
          collectVaultAttachmentBackup,
          vaultAttachmentBackupByteBudget
        }
      ] = await Promise.all([
        import("../features/vault/interop"),
        import("../features/vault/vaultAttachmentBackup")
      ]);
      const baseSources = exportableNotes.map((note) => {
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
      });
      const currentPaths = new Map(notes.map((note) => {
        const draft = draftsRef.current[note.id];
        const currentNote = draft
          ? { ...note, title: draft.title, folderId: draft.folderId }
          : note;
        return [note.id, vaultEntryPath(currentNote, folderPaths)] as const;
      }));
      const attachmentBackup = await collectVaultAttachmentBackup(
        notes.map((note) => ({
          id: note.id,
          path: currentPaths.get(note.id) ?? "",
          wrappedKey: note.wrappedKeys[profile.uid]
        })).filter((note) => Boolean(note.path)),
        privateKey,
        {
          byteBudget: vaultAttachmentBackupByteBudget(baseSources),
          occupiedPaths: baseSources.map((source) => source.path),
          signal: abortController.signal
        }
      );
      abortController.signal.throwIfAborted();
      const result = await exportObsidianVaultZipInWorker([
        ...baseSources,
        ...attachmentBackup.sources,
        attachmentBackup.manifestSource
      ], {
        folders: [...folderPaths.values()],
        duplicatePolicy: "error"
      }, { signal: abortController.signal }).finally(() => {
        attachmentBackup.sources.forEach((source) => {
          if (source.content instanceof Uint8Array) source.content.fill(0);
        });
      });
      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const archiveBuffer = result.bytes.buffer instanceof ArrayBuffer
        && result.bytes.byteOffset === 0
        && result.bytes.byteLength === result.bytes.buffer.byteLength
        ? result.bytes.buffer
        : Uint8Array.from(result.bytes).buffer;
      const now = new Date();
      const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
      downloadBlob(
        new Blob([archiveBuffer], { type: "application/zip" }),
        `QuickMemo-Vault-${date}.zip`
      );
      result.bytes.fill(0);
      result.manifest.entries.forEach((entry) => entry.bytes.fill(0));
      const legacyCount = notes.length - exportableNotes.length;
      const attachmentSummary = ` 첨부파일 ${attachmentBackup.included.length}개를 포함했습니다.`;
      const missingSummary = attachmentBackup.missing.length
        ? ` 제외된 첨부파일 ${attachmentBackup.missing.length}개는 ZIP의 QuickMemo-Attachments-Manifest.json에 기록했습니다.`
        : "";
      setStatus(
        `${result.manifest.entries.length}개 항목을 내보냈습니다.${attachmentSummary}${missingSummary}${legacyCount ? ` 기존 HTML ${legacyCount}개는 제외했습니다.` : ""}`
      );
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
    if (!profile || !vaultIntegrityKey || !vaultNameWritesReady || vaultImportBusy || pathRewriteBusyRef.current) {
      if (pathRewriteBusyRef.current) {
        setError("내부 참조 갱신이 끝난 뒤 Vault를 가져와주세요.");
      }
      if (!vaultIntegrityKey) {
        setError("암호화된 이름 무결성 키가 준비될 때까지 ZIP을 가져올 수 없습니다.");
      }
      return;
    }
    setError(null);
    setVaultImportBusy(true);
    const abortController = new AbortController();
    let importJobId: string | null = null;
    let plannedEntryCount = 0;
    let plannedAssetCount = 0;
    importAbortRef.current = abortController;
    setStatus("Obsidian ZIP을 안전하게 검사하는 중입니다…");
    try {
      await cleanupRetainedTerminalVaultImportJobs(profile.uid);
      const interruptedJobs = await listRecoverableVaultImportJobs(profile.uid, privateKey);
      if (interruptedJobs.length) {
        setRecoverableImportJobs(interruptedJobs);
        setImportRecoveryOpen(true);
        setError("기존 ZIP 가져오기 복구를 먼저 완료해주세요. 확인 없이 자동 롤백하지 않았습니다.");
        return;
      }
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

      setStatus("암호화된 가져오기 복구 manifest를 준비하는 중입니다…");
      const folderIdByPathKey = new Map<string, string>();
      for (const folder of plan.folders) {
        const key = vaultPathCollisionKey(folder.path);
        folderIdByPathKey.set(key, folder.existingFolderId ?? createVaultImportTargetId());
      }
      const stagedFolders: Array<{
        claimId: string;
        folder: (typeof plan.folders)[number];
        order: number;
        parentId: string | null;
        targetId: string;
      }> = [];
      for (const [order, folder] of plan.folders.entries()) {
        if (folder.existingFolderId) continue;
        if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const parentId = folder.parentPath
          ? folderIdByPathKey.get(vaultPathCollisionKey(folder.parentPath)) ?? null
          : null;
        if (folder.parentPath && !parentId) {
          throw new Error("import-parent-missing");
        }
        const targetId = folderIdByPathKey.get(vaultPathCollisionKey(folder.path));
        if (!targetId) throw new Error("import-folder-id-missing");
        stagedFolders.push({
          claimId: await vaultNameFingerprint(vaultIntegrityKey, {
            name: folder.name.trim().normalize("NFC"),
            parentId,
            targetType: "folder"
          }),
          folder,
          order,
          parentId,
          targetId
        });
      }
      const stagedEntries: Array<{
        claimId: string;
        contentFormat: "markdown-v1" | "json-canvas-v1" | "base-v1" | "asset-v1";
        entry: (typeof plan.entries)[number];
        folderId: string | null;
        targetId: string;
      }> = [];
      for (const entry of plan.entries) {
        if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const folderId = entry.folderPath
          ? folderIdByPathKey.get(vaultPathCollisionKey(entry.folderPath)) ?? null
          : null;
        if (entry.folderPath && !folderId) {
          throw new Error("import-folder-missing");
        }
        const contentFormat = entry.kind === "markdown"
          ? "markdown-v1" as const
          : entry.kind === "canvas"
            ? "json-canvas-v1" as const
            : entry.kind === "base"
              ? "base-v1" as const
              : "asset-v1" as const;
        stagedEntries.push({
          claimId: await vaultNameFingerprint(vaultIntegrityKey, {
            kind: entry.kind,
            name: entry.title.trim().normalize("NFC"),
            parentId: folderId,
            targetType: "entry"
          }),
          contentFormat,
          entry,
          folderId,
          targetId: createVaultImportTargetId()
        });
      }
      const durableManifest = createVaultImportManifest({
        ownerUid: profile.uid,
        folders: stagedFolders.map((folder) => ({
          targetId: folder.targetId,
          claimId: folder.claimId,
          parentId: folder.parentId
        })),
        entries: stagedEntries.map((entry) => ({
          targetId: entry.targetId,
          claimId: entry.claimId,
          folderId: entry.folderId,
          contentFormat: entry.contentFormat,
          entryKind: entry.entry.kind
        }))
      });
      importJobId = createVaultImportJobId();
      plannedEntryCount = stagedEntries.length;
      plannedAssetCount = plan.assetEntries;
      const preparedJob = await ensureVaultImportJob({
        profile,
        privateKey,
        jobId: importJobId,
        manifest: durableManifest
      });
      if (preparedJob.status !== "staging") {
        throw new Error("import-job-not-staging");
      }

      setStatus("검증된 항목을 암호화해 저장하는 중입니다…");
      for (const staged of stagedFolders) {
        if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
        await createEncryptedVaultFolder(
          profile,
          vaultIntegrityKey,
          staged.folder.name,
          staged.parentId,
          staged.order,
          "#7c5cff",
          { targetId: staged.targetId, importJobId }
        );
      }
      for (const staged of stagedEntries) {
        if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { entry } = staged;
        if (entry.kind === "asset") {
          await createEncryptedVaultAsset(profile, vaultIntegrityKey, {
            bytes: entry.bytes,
            folderId: staged.folderId,
            mimeType: entry.mimeType,
            title: entry.title
          }, { targetId: staged.targetId, importJobId });
        } else {
          await createEncryptedVaultEntry(profile, vaultIntegrityKey, {
            body: entry.body,
            contentFormat: staged.contentFormat,
            entryKind: entry.kind,
            folderId: staged.folderId,
            title: entry.title
          }, { targetId: staged.targetId, importJobId });
        }
      }
      try {
        await commitVaultImportJob(profile.uid, importJobId);
      } catch (commitError) {
        const confirmed = await loadVaultImportJob(profile.uid, privateKey, importJobId);
        if (confirmed?.status !== "committed") throw commitError;
      }
      await cleanupTerminalVaultImportJob(profile.uid, importJobId).catch(() => undefined);
      setRecoverableImportJobs([]);
      setImportRecoveryOpen(false);
      setStatus(`${plannedEntryCount}개 항목을 암호화해 가져왔습니다.${plannedAssetCount ? ` 첨부 ${plannedAssetCount}개 포함.` : ""}`);
    } catch (caught) {
      let compensationNotice = "";
      let committedDespiteResponseLoss = false;
      if (importJobId) {
        try {
          const compensation = await rollbackVaultImportJob({
            uid: profile.uid,
            privateKey,
            jobId: importJobId
          });
          if (compensation.status === "committed") {
            committedDespiteResponseLoss = true;
          } else {
            const cleaned = compensation.entrySoftDeleted + compensation.folderRootsTrashed + compensation.alreadyCleaned;
            compensationNotice = cleaned
              ? ` 생성된 항목과 폴더 ${cleaned}개를 revision 이력을 보존한 채 휴지통 처리했습니다. 문서와 이력의 quota 사용량은 남습니다.`
              : " 암호화된 가져오기 준비 작업을 안전하게 취소했습니다.";
            await cleanupTerminalVaultImportJob(profile.uid, importJobId).catch(() => undefined);
          }
        } catch (rollbackError) {
          if (!(rollbackError instanceof VaultImportJobError && rollbackError.code === "not-found")) {
            compensationNotice = " 자동 롤백이 충돌 또는 서버 snapshot 불완전으로 잠겼습니다. 기존 데이터 보호를 위해 추가 삭제는 수행하지 않았습니다.";
            void recheckRecoverableImportJobs(false);
            setImportRecoveryOpen(true);
          }
        }
      }
      if (committedDespiteResponseLoss) {
        setStatus(`${plannedEntryCount}개 항목 가져오기가 서버에서 완료된 것을 다시 확인했습니다.${plannedAssetCount ? ` 첨부 ${plannedAssetCount}개 포함.` : ""}`);
        return;
      }
      if (caught instanceof Error && caught.name === "AbortError") {
        setStatus(`ZIP 가져오기를 취소했습니다.${compensationNotice}`);
      } else {
        setError(`ZIP 가져오기에 실패했습니다. 파일 구조·크기·Canvas 형식을 확인해주세요.${compensationNotice}`);
      }
    } finally {
      if (importAbortRef.current === abortController) {
        importAbortRef.current = null;
      }
      setVaultImportBusy(false);
    }
  }

  function findPeriodicMarkdownNote(title: string) {
    return notes.find((note) => (
      note.entryKind === "markdown"
      && (draftsRef.current[note.id]?.folderId ?? note.folderId ?? null) === effectiveDailyNotesFolderId
      && normalizedEntryTitle(draftsRef.current[note.id]?.title ?? note.title, note.entryKind) === normalizedEntryTitle(title, "markdown")
    ));
  }

  function openDailyNoteForDate(title: string) {
    let body: string;
    try {
      const targetDate = parseLocalDateKey(title);
      if (!targetDate) throw new Error("Daily Note 날짜가 올바르지 않습니다.");
      const template = availableTemplates.find((candidate) => candidate.id === dailyNotesTemplateEntryId);
      if (template) {
        const folderPath = effectiveDailyNotesFolderId ? folderPaths.get(effectiveDailyNotesFolderId) ?? "" : "";
        const path = [folderPath, `${title}.md`].filter(Boolean).join("/");
        const rendered = renderSafeTemplate(template.body, { now: targetDate, path, title });
        body = dailyNoteBody(title, rendered.text);
        if (rendered.warnings[0]) setStatus(`Daily Note 템플릿 경고 · ${rendered.warnings[0]}`);
      } else {
        body = dailyNoteBody(title);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Daily Note 날짜가 올바르지 않습니다.");
      return;
    }
    const existing = findPeriodicMarkdownNote(title);
    if (existing) {
      openEntry(existing.id);
    } else {
      void createEntry("markdown", title, body, {
        folderId: effectiveDailyNotesFolderId,
        preserveRequestedTitle: true
      });
    }
  }

  function openWeeklyNote(weekKey: string) {
    let body: string;
    try {
      body = weeklyNoteBody(weekKey);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "주간 노트 범위가 올바르지 않습니다.");
      return;
    }
    const existing = findPeriodicMarkdownNote(weekKey);
    if (existing) openEntry(existing.id);
    else void createEntry("markdown", weekKey, body, {
      folderId: effectiveDailyNotesFolderId,
      preserveRequestedTitle: true
    });
  }

  function openMonthlyNote(monthKey: string) {
    let body: string;
    try {
      body = monthlyNoteBody(monthKey);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "월간 노트 범위가 올바르지 않습니다.");
      return;
    }
    const existing = findPeriodicMarkdownNote(monthKey);
    if (existing) openEntry(existing.id);
    else void createEntry("markdown", monthKey, body, {
      folderId: effectiveDailyNotesFolderId,
      preserveRequestedTitle: true
    });
  }

  function openDailyNote() {
    openDailyNoteForDate(localDateKey(new Date()));
  }

  function createUniqueNote() {
    const title = uniqueNoteTitle(new Date());
    void createEntry("markdown", title, `# ${title}\n\n`);
  }

  function openTemplateDialog(mode: "insert" | "create") {
    if (availableTemplates.length === 0) {
      setError("Templates 또는 템플릿 폴더에 Markdown 템플릿을 먼저 만들어주세요.");
      return;
    }
    setError(null);
    setTemplateDialogMode(mode);
  }

  function insertTemplateIntoActiveNote() {
    if (!activeNote || !activeDraft || activeNote.contentFormat !== "markdown-v1") {
      setError("Markdown 노트를 연 뒤 템플릿을 삽입해주세요.");
      return;
    }
    openTemplateDialog("insert");
  }

  function createNoteFromTemplate() {
    openTemplateDialog("create");
  }

  async function applyTemplate(
    template: (typeof availableTemplates)[number],
    title: string,
    inputs: Readonly<Record<string, string>>
  ) {
    const path = templateDialogMode === "insert" && activeNote
      ? entryPaths.get(activeNote.id) ?? `${title.replace(/\.md$/iu, "")}.md`
      : [selectedFolderId ? folderPaths.get(selectedFolderId) ?? "" : "", `${title.replace(/\.md$/iu, "")}.md`]
          .filter(Boolean)
          .join("/");
    const selectedText = templateDialogMode === "insert" && activeDraft && editorSelection
      ? activeDraft.body.slice(editorSelection.start, editorSelection.end)
      : undefined;
    const result = renderSafeTemplate(template.body, {
      inputs,
      now: new Date(),
      path,
      selection: selectedText,
      title
    });
    const warning = result.warnings[0] ? ` · ${result.warnings[0]}` : "";
    if (templateDialogMode === "insert" && activeNote && activeDraft) {
      const insertionSelection = editorSelection ?? { start: 0, end: 0 };
      // Validate the exact replacement size before sending the same bounded
      // transaction to CodeMirror. With an empty selection, insertion size is
      // independent of the live caret position retained by the editor.
      applyTemplateInsertion(
        activeDraft.body,
        insertionSelection.start,
        insertionSelection.end,
        result
      );
      const id = ++editorRequestIdRef.current;
      setViewMode("live-preview");
      setEditorInsertRequest({
        ...(result.cursorOffset === undefined ? {} : { cursorOffset: result.cursorOffset }),
        entryId: activeNote.id,
        id,
        text: result.text
      });
      setStatus(`${template.title} 템플릿을 현재 커서에 삽입했습니다.${warning}`);
      setTemplateDialogMode(null);
    } else if (templateDialogMode === "create") {
      const safeTitle = title.trim().slice(0, 180);
      if (!safeTitle || templateApplyBusyRef.current) return;
      templateApplyBusyRef.current = true;
      setStatus(`${template.title} 템플릿 노트를 암호화해 만드는 중입니다…`);
      try {
        const created = await createEntry("markdown", safeTitle, result.text);
        if (!created) return;
        setStatus(`${template.title} 템플릿으로 새 노트를 만들었습니다.${warning}`);
        setTemplateDialogMode(null);
      } finally {
        templateApplyBusyRef.current = false;
      }
    }
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

  async function createIndexFromCurrentSearch() {
    const accessScopeGeneration = workspaceAccessScopeGenerationRef.current;
    if (searchQuery.trim() && knowledgeClient && workerSearchEntryIds === null) {
      setError("검색 결과 계산이 끝난 뒤 인덱스를 만들어주세요.");
      return;
    }
    const candidates = filteredNotes.flatMap((note) => {
      if (note.entryKind === "asset" || note.entryKind === "legacy-html") return [];
      const path = entryPaths.get(note.id);
      return path ? [{ path, title: entryLabel(note) }] : [];
    });
    if (candidates.length === 0) {
      setError(searchQuery.trim()
        ? "현재 검색 결과에 연결할 수 있는 항목이 없습니다."
        : "인덱스에 연결할 수 있는 항목이 없습니다.");
      return;
    }
    const defaultTitle = searchQuery.trim() ? "검색 결과 인덱스" : "지식 인덱스";
    const requestedTitle = window.prompt("인덱스 이름", defaultTitle)?.trim();
    if (!requestedTitle) return;
    const { createSearchIndexMarkdown } = await import("../features/vault/moc");
    if (workspaceAccessScopeGenerationRef.current !== accessScopeGeneration) return;
    const result = createSearchIndexMarkdown({
      candidates,
      query: searchQuery,
      sourceFolderPath: selectedFolderId ? folderPaths.get(selectedFolderId) ?? "" : "",
      title: requestedTitle
    });
    const created = await createEntry("markdown", requestedTitle, result.source, {
      folderId: selectedFolderId
    });
    if (!created) return;
    setStatus(`${result.included}개 항목을 연결한 암호화 검색 결과 인덱스를 만들었습니다.${result.omitted ? ` 안전 상한을 넘은 ${result.omitted}개는 생략했습니다.` : ""}`);
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

  function bookmarkGlobalGraph(requestedLabel?: string) {
    if (globalGraphSettings.scope !== "global") {
      return;
    }
    const label = (requestedLabel
      ?? window.prompt("그래프 북마크 이름", `그래프 ${graphBookmarks.length + 1}`))?.trim();
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
      viewport: globalViewportRef.current
    }].slice(-64));
    setStatus("그래프 설정과 화면 위치를 암호화 북마크에 추가했습니다.");
  }

  function addSearchBookmark(label: string) {
    const query = searchQuery.trim();
    const normalizedLabel = label.trim().slice(0, 120);
    if (!query || !normalizedLabel) return;
    setSearchBookmarks((current) => {
      const existing = current.find((bookmark) => bookmark.query === query);
      if (existing) {
        return current.map((bookmark) => bookmark.id === existing.id
          ? { ...bookmark, label: normalizedLabel, createdAt: Date.now() }
          : bookmark);
      }
      return [{
        createdAt: Date.now(),
        id: crypto.randomUUID(),
        label: normalizedLabel,
        query
      }, ...current].slice(0, 64);
    });
    setStatus("현재 검색식을 암호화된 워크스페이스에 저장했습니다.");
  }

  function removeSearchBookmark(bookmarkId: string) {
    setSearchBookmarks((current) => current.filter((bookmark) => bookmark.id !== bookmarkId));
    setStatus("검색 북마크를 삭제했습니다.");
  }

  function addVaultBookmark(kind: PersistedVaultBookmark["kind"], label: string) {
    if (kind === "graph") {
      bookmarkGlobalGraph(label);
      return;
    }
    if (kind === "search") {
      addSearchBookmark(label);
      return;
    }
    if (!activeNote) return;
    const path = entryPaths.get(activeNote.id);
    if (!path) return;
    const normalizedLabel = label.trim().slice(0, 120);
    if (!normalizedLabel) return;
    setEntryBookmarks((current) => {
      const existing = current.find((bookmark) => bookmark.entryId === activeNote.id);
      if (existing) {
        return current.map((bookmark) => bookmark.id === existing.id ? {
          ...bookmark,
          createdAt: Date.now(),
          label: normalizedLabel,
          path: path.slice(0, 1_000)
        } : bookmark);
      }
      return [{
        createdAt: Date.now(),
        entryId: activeNote.id,
        id: crypto.randomUUID(),
        label: normalizedLabel,
        path: path.slice(0, 1_000)
      }, ...current].slice(0, MAX_VAULT_BOOKMARKS);
    });
    setStatus("현재 항목을 암호화된 북마크에 추가했습니다.");
  }

  function openVaultBookmark(bookmark: PersistedVaultBookmark) {
    if (bookmark.kind === "entry") {
      if (!notes.some((note) => note.id === bookmark.entryId)) {
        setStatus("권한이 없거나 삭제된 북마크 항목은 열지 않았습니다.");
        return;
      }
      openEntry(bookmark.entryId, { target: "new-tab" });
      return;
    }
    if (bookmark.kind === "search") {
      setSearchQuery(bookmark.query);
      showLeftPanel("search");
      return;
    }
    setGlobalGraphSettings(bookmark.settings);
    applyGlobalGraphViewport(bookmark.viewport);
    openGlobalGraph();
  }

  function removeVaultBookmark(bookmark: PersistedVaultBookmark) {
    if (bookmark.kind === "entry") {
      setEntryBookmarks((current) => current.filter((candidate) => candidate.id !== bookmark.id));
    } else if (bookmark.kind === "search") {
      setSearchBookmarks((current) => current.filter((candidate) => candidate.id !== bookmark.id));
    } else {
      setGraphBookmarks((current) => current.filter((candidate) => candidate.id !== bookmark.id));
    }
    setStatus("북마크를 삭제했습니다.");
  }

  function captureNamedWorkspace(label: string) {
    const normalizedLabel = label.trim().slice(0, 120);
    if (!normalizedLabel) return;
    if (namedWorkspaces.length >= MAX_NAMED_WORKSPACES) {
      setError(`워크스페이스는 최대 ${MAX_NAMED_WORKSPACES}개까지 저장할 수 있습니다.`);
      return;
    }
    const snapshot = captureVaultWorkspaceLayout(latestWorkspaceStateRef.current);
    if (!vaultWorkspaceLayoutFitsEncryptedDocument(snapshot, namedWorkspaces)) {
      setError("현재 그래프 그룹·검색식이 너무 커서 워크스페이스 배치를 안전한 크기로 저장하지 않았습니다.");
      return;
    }
    const now = Date.now();
    const candidate: PersistedNamedWorkspace = {
      createdAt: now,
      id: crypto.randomUUID(),
      label: normalizedLabel,
      snapshot,
      updatedAt: now
    };
    const prospective = {
      ...latestWorkspaceStateRef.current,
      namedWorkspaces: [candidate, ...namedWorkspaces].slice(0, MAX_NAMED_WORKSPACES)
    };
    if (!vaultWorkspaceStateFitsEncryptedDocument(prospective)) {
      setError("암호화 워크스페이스 전체가 안전 저장 크기를 초과해 현재 배치를 추가하지 않았습니다.");
      return;
    }
    setNamedWorkspaces(prospective.namedWorkspaces);
    setError(null);
    setStatus("현재 탭·패널 배치를 암호화 워크스페이스로 저장했습니다.");
  }

  function renameNamedWorkspace(workspaceId: string, label: string) {
    const normalizedLabel = label.trim().slice(0, 120);
    if (!normalizedLabel) return;
    setNamedWorkspaces((current) => current.map((workspace) => workspace.id === workspaceId
      ? { ...workspace, label: normalizedLabel, updatedAt: Date.now() }
      : workspace));
    setStatus("워크스페이스 이름을 변경했습니다.");
  }

  function deleteNamedWorkspace(workspaceId: string) {
    setNamedWorkspaces((current) => current.filter((workspace) => workspace.id !== workspaceId));
    setStatus("워크스페이스를 삭제했습니다.");
  }

  async function restoreNamedWorkspace(workspaceId: string) {
    const namedWorkspace = namedWorkspaces.find((workspace) => workspace.id === workspaceId);
    if (!namedWorkspace || workspaceConflict || workspaceConflictPendingRef.current) {
      setError("워크스페이스 충돌을 먼저 해결한 뒤 배치를 복원해주세요.");
      return;
    }
    if (!await flushDirtyEntries()) return;
    const restored = restoreVaultWorkspaceLayout(
      latestWorkspaceStateRef.current,
      namedWorkspace.snapshot,
      new Set(notes.map((note) => note.id)),
      new Set(folders.map((folder) => folder.id))
    );
    const previouslySaved = lastSavedWorkspaceRef.current;
    applyRestoredWorkspace(restored, workspaceRevisionRef.current);
    lastSavedWorkspaceRef.current = previouslySaved;
    setLastSavedWorkspaceSerialization(previouslySaved);
    pendingWorkspaceStateRef.current = restored;
    setWorkspaceSaveRetry((attempt) => attempt + 1);
    setStatus(`${namedWorkspace.label} 워크스페이스를 복원했습니다. 사용할 수 없는 항목은 열지 않았습니다.`);
  }

  function composerSnapshot(note: DecryptedVaultNote): ComposerEntrySnapshot | null {
    if (note.contentFormat !== "markdown-v1" || note.entryKind !== "markdown") return null;
    return {
      body: note.body,
      contentFormat: "markdown-v1",
      dirty: false,
      folderId: note.folderId ?? null,
      id: note.id,
      revision: note.revision ?? 0,
      title: note.title
    };
  }

  async function readComposerEntryFromServer(entryId: string) {
    const encrypted = await getVisibleNotesByIdsFromServer(profile.uid, [entryId]);
    const [note] = await decryptVaultNotes(encrypted.notes, profile.uid, privateKey);
    if (!note || note.ownerUid !== profile.uid) return null;
    return { note, snapshot: composerSnapshot(note) };
  }

  function applyComposerSave(
    entryId: string,
    submitted: Pick<DraftState, "body" | "folderId" | "title">,
    persisted: {
      revision: number;
      encryptedBody?: DecryptedVaultNote["encryptedBody"];
      encryptedTitle?: DecryptedVaultNote["encryptedTitle"];
      vaultNameClaimId?: string;
      vaultNameIndexVersion?: DecryptedVaultNote["vaultNameIndexVersion"];
    }
  ) {
    commitNotes((current) => current.map((candidate) => candidate.id === entryId
      ? {
          ...candidate,
          ...persistedEncryptedMutationPatch(persisted),
          body: submitted.body,
          folderId: submitted.folderId,
          revision: persisted.revision,
          title: submitted.title
        }
      : candidate));
    const latest = draftsRef.current[entryId];
    if (!latest) return;
    const nextDrafts = {
      ...draftsRef.current,
      [entryId]: reconcileDraftAfterSave(latest, submitted, persisted.revision)
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
  }

  async function createComposerMarkdownCopy(input: Parameters<NoteComposerAdapter["createMarkdownCopy"]>[0]) {
    if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current || !isOnline) {
      throw new Error("온라인 상태와 암호화된 이름 예약을 확인한 뒤 노트를 분리해주세요.");
    }
    const title = input.title.trim().normalize("NFC");
    const jobId = await deterministicVaultOperationId("vi1_", input.operationId, "note-composer-job");
    const targetId = await deterministicVaultOperationId("vit1_", input.operationId, "note-composer-entry");
    const claimId = await vaultNameFingerprint(vaultIntegrityKey, {
      kind: "markdown",
      name: title,
      parentId: input.folderId,
      targetType: "entry"
    });
    const manifest = createVaultImportManifest({
      ownerUid: profile.uid,
      folders: [],
      entries: [{
        claimId,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        folderId: input.folderId,
        targetId
      }]
    });
    const prepared = await ensureVaultImportJob({
      profile,
      privateKey,
      jobId,
      manifest
    });
    if (prepared.status === "blocked" || prepared.status === "rolled-back" || prepared.status === "rolling-back") {
      throw new Error("이전 Note composer 작업이 안전하게 완료되지 않아 새 복사본을 만들지 않았습니다.");
    }
    if (prepared.status !== "committed") {
      if (prepared.status !== "staging") {
        throw new Error("Note composer 작업이 저장 준비 상태가 아닙니다.");
      }
      await createEncryptedVaultEntry(profile, vaultIntegrityKey, {
        body: input.body,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        folderId: input.folderId,
        title
      }, { targetId, importJobId: jobId });
      try {
        await commitVaultImportJob(profile.uid, jobId);
      } catch (caught) {
        const confirmed = await loadVaultImportJob(profile.uid, privateKey, jobId);
        if (confirmed?.status !== "committed") throw caught;
      }
    }
    const verified = await readComposerEntryFromServer(targetId);
    if (
      !verified?.snapshot
      || verified.snapshot.body !== input.body
      || verified.snapshot.title !== title
      || verified.snapshot.folderId !== input.folderId
      || verified.snapshot.revision !== 1
    ) {
      throw new Error("생성된 분리 노트를 서버에서 동일한 원본으로 확인하지 못했습니다.");
    }
    pendingCreatedEntryIdsRef.current.add(targetId);
    commitNotes((current) => current.some((candidate) => candidate.id === targetId)
      ? current
      : [...current, verified.note]);
    const nextDrafts = {
      ...draftsRef.current,
      [targetId]: { ...verified.snapshot, baseRevision: 1 }
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    await cleanupTerminalVaultImportJob(profile.uid, jobId).catch(() => undefined);
    return { entryId: targetId, revision: 1 };
  }

  const noteComposerAdapter: NoteComposerAdapter = {
    createMarkdownCopy: createComposerMarkdownCopy,
    flushDirtyDraft: async (guard) => {
      const current = draftsRef.current[guard.id];
      if (
        !current
        || current.body !== guard.body
        || current.folderId !== guard.folderId
        || current.title !== guard.title
        || current.baseRevision !== guard.revision
      ) {
        throw new Error("편집 중인 초안이 달라져 Note composer 작업을 중단했습니다.");
      }
      if (current.dirty) await saveEntryRef.current(guard.id);
      const afterSave = draftsRef.current[guard.id];
      if (!afterSave || afterSave.dirty) {
        throw new Error("현재 초안을 서버에 저장하지 못해 Note composer 작업을 중단했습니다.");
      }
      const verified = await readComposerEntryFromServer(guard.id);
      if (!verified?.snapshot) throw new Error("저장된 노트를 서버에서 다시 확인하지 못했습니다.");
      return verified.snapshot;
    },
    readEntry: async (entryId) => (await readComposerEntryFromServer(entryId))?.snapshot ?? null,
    saveMarkdown: async (input) => {
      if (!vaultIntegrityKey || !isOnline || pathRewriteBusyRef.current) {
        throw new Error("온라인 상태와 Vault 경로 작업을 확인해주세요.");
      }
      const currentDraft = draftsRef.current[input.entryId];
      if (
        !currentDraft
        || currentDraft.dirty
        || currentDraft.body !== input.expectedBody
        || currentDraft.title !== input.title
        || currentDraft.baseRevision !== input.expectedRevision
      ) {
        throw new Error("저장 직전 초안이 달라져 Note composer 작업을 중단했습니다.");
      }
      const verified = await readComposerEntryFromServer(input.entryId);
      if (
        !verified?.snapshot
        || verified.snapshot.body !== input.expectedBody
        || verified.snapshot.title !== input.title
        || verified.snapshot.revision !== input.expectedRevision
      ) {
        throw new Error("서버 revision이 달라져 Note composer 작업을 중단했습니다.");
      }
      const submitted = {
        body: input.body,
        folderId: verified.snapshot.folderId,
        title: input.title
      };
      try {
        const saved = await saveEncryptedVaultEntry(
          verified.note,
          profile.uid,
          privateKey,
          vaultIntegrityKey,
          submitted
        );
        applyComposerSave(input.entryId, submitted, saved);
        return { revision: saved.revision };
      } catch (caught) {
        const confirmed = await readComposerEntryFromServer(input.entryId).catch(() => null);
        if (
          confirmed?.snapshot
          && confirmed.snapshot.body === input.body
          && confirmed.snapshot.title === input.title
          && confirmed.snapshot.revision > input.expectedRevision
        ) {
          applyComposerSave(input.entryId, submitted, {
            encryptedBody: confirmed.note.encryptedBody,
            encryptedTitle: confirmed.note.encryptedTitle,
            revision: confirmed.snapshot.revision,
            vaultNameClaimId: confirmed.note.vaultNameClaimId,
            vaultNameIndexVersion: confirmed.note.vaultNameIndexVersion
          });
          return { revision: confirmed.snapshot.revision };
        }
        throw caught;
      }
    },
    trashEntry: async (input) => {
      if (!isOnline || pathRewriteBusyRef.current) {
        throw new Error("온라인 상태와 Vault 경로 작업을 확인해주세요.");
      }
      const verified = await readComposerEntryFromServer(input.entryId);
      if (
        !verified?.snapshot
        || verified.snapshot.body !== input.expectedBody
        || verified.snapshot.revision !== input.expectedRevision
      ) {
        throw new Error("원본 revision이 달라 휴지통으로 이동하지 않았습니다.");
      }
      try {
        await deleteRevisionedNote({
          expectedRevision: input.expectedRevision,
          noteId: input.entryId,
          readerUids: verified.note.participantUids,
          uid: profile.uid
        });
      } catch (caught) {
        const stillVisible = await readComposerEntryFromServer(input.entryId).catch(() => null);
        if (stillVisible) throw caught;
      }
      commitNotes((current) => current.filter((candidate) => candidate.id !== input.entryId));
      const nextDrafts = { ...draftsRef.current };
      delete nextDrafts[input.entryId];
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setTabs((current) => current.filter((tab) => tab.kind !== "entry" || tab.entryId !== input.entryId));
    }
  };

  async function saveRecordedAudio(capture: {
    bytes: Uint8Array;
    mimeType: string;
    suggestedName: string;
  }) {
    if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      throw new Error("암호화된 이름 예약이 끝난 뒤 녹음을 저장해주세요.");
    }
    const folderId = selectedFolderId;
    const title = uniqueTitle(
      notesRef.current.filter((note) => note.ownerUid === profile.uid),
      capture.suggestedName,
      folderId,
      "asset"
    );
    const result = await createEncryptedVaultAsset(profile, vaultIntegrityKey, {
      bytes: capture.bytes,
      folderId,
      mimeType: capture.mimeType,
      title
    });
    pendingCreatedEntryIdsRef.current.add(result.noteId);
    setStatus(`'${title}' 녹음을 asset-v1로 암호화해 저장했습니다.`);
  }

  async function resolvePastedImageAssetDestination(signal: AbortSignal) {
    if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      throw new Error("경로 작업 후 이미지를 추가해주세요.");
    }
    const runtime = await loadPastedImageFolderRuntime();
    signal.throwIfAborted();
    if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      throw new Error("Vault 상태가 바뀌었습니다. 다시 시도해주세요.");
    }
    return runtime.resolveServerLease({
      createFolder: async (currentFolders) => {
        if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
          throw new Error("Vault 상태가 바뀌었습니다. 다시 시도해주세요.");
        }
        requireValidVaultFolderTree([
          ...currentFolders,
          { id: `pending-pasted-images-${crypto.randomUUID()}`, parentId: null }
        ]);
        return createEncryptedVaultFolder(
          profile,
          vaultIntegrityKey,
          runtime.folderName,
          null,
          currentFolders.length
        );
      },
      getFolders: () => foldersRef.current,
      isNameConflict: (caught) => caught instanceof VaultNameConflictError,
      ownerUid: profile.uid,
      signal
    });
  }

  async function pasteImagesIntoMarkdownEntry(
    entryId: string,
    files: readonly File[],
    { signal }: MarkdownImagePasteContext
  ): Promise<MarkdownImagePasteResult | null> {
    const accessScopeGeneration = workspaceAccessScopeGenerationRef.current;
    const accessScopeIsCurrent = () => (
      workspaceAccessScopeGenerationRef.current === accessScopeGeneration
    );
    const requireCurrentAccessScope = () => {
      if (!accessScopeIsCurrent()) {
        throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
      }
    };
    const note = notesRef.current.find((candidate) => candidate.id === entryId) ?? null;
    const draft = draftsRef.current[entryId] ?? null;
    if (!note || !draft || note.entryKind !== "markdown" || note.contentFormat !== "markdown-v1") {
      setError("Markdown 노트를 열어주세요.");
      return null;
    }
    if (
      !vaultIntegrityKey
      || !vaultNameWritesReady
      || pathRewriteBusyRef.current
      || pendingEntryCreationRef.current
      || deletingEntryIdsRef.current.has(note.id)
    ) {
      setError("경로 작업 후 이미지를 추가해주세요.");
      return null;
    }
    if (note.ownerUid !== profile.uid || note.type !== "personal") {
      setError("내 개인 Markdown 노트에서만 지원합니다.");
      return null;
    }

    let releasePendingPaste = () => {};
    setError(null);
    setStatus(`${files.length > 1 ? `${files.length}개 ` : ""}이미지를 확인 중입니다…`);
    try {
      const pasteModule = await import(
        "../features/vault/vaultClipboardPasteFlow"
      );
      releasePendingPaste = pasteModule.beginVaultClipboardPastePendingGuard({
        counts: pendingClipboardPasteCountsRef.current,
        entryId: note.id,
        hasDirtyDraft: () => Boolean(draftsRef.current[note.id]?.dirty),
        resumeSave: () => void saveEntryRef.current(note.id)
      });
      const result = await pasteModule.pasteVaultClipboardImages({
        assertAssetDestinationCurrent: (target) => {
          requireCurrentAccessScope();
          const runtime = pastedImageFolderRuntimeRef.current;
          if (!runtime) throw new Error("이미지 폴더 상태가 만료되었습니다.");
          runtime.assertTargetCurrent({
            getFolders: () => foldersRef.current,
            ownerUid: profile.uid,
            pathRewriteBusy: pathRewriteBusyRef.current,
            target
          });
        },
        commitSource: async (source, destination) => {
          requireCurrentAccessScope();
          const minimumRevision = note.revision ?? 0;
          const committed = await pasteModule.commitVaultClipboardSourceWithConfirmation(
            () => saveEntryRef.current(entryId, {
              vaultPasteFolderId: destination.folderId,
              vaultPasteFolderRevision: destination.folderRevision,
              vaultPasteLockId: destination.lockId
            }),
            () => notesRef.current.some((candidate) => (
              candidate.id === entryId
              && candidate.ownerUid === profile.uid
              && (candidate.revision ?? 0) > minimumRevision
              && candidate.body.includes(source)
            )),
            () => Boolean(draftsRef.current[entryId]?.dirty)
          );
          requireCurrentAccessScope();
          return committed;
        },
        confirmAssetDestination: (lease) => {
          requireCurrentAccessScope();
          const runtime = pastedImageFolderRuntimeRef.current;
          return runtime
            ? runtime.confirm(lease)
            : Promise.reject(new Error("이미지 폴더 상태가 만료되었습니다."));
        },
        files,
        getNotes: () => notesRef.current,
        integrityKey: vaultIntegrityKey,
        note,
        pendingAssetTitleKeyById: pendingClipboardAssetTitleKeyByIdRef.current,
        pendingAssetTitleKeys: pendingClipboardAssetTitleKeysRef.current,
        pendingClipboardAssetIds: pendingClipboardAssetIdsRef.current,
        pendingCreatedEntryIds: pendingCreatedEntryIdsRef.current,
        profile,
        releaseAssetDestination: (lease) => (
          pastedImageFolderRuntimeRef.current?.release(lease)
          ?? Promise.resolve()
        ),
        resolveAssetDestination: async (resolveSignal) => {
          requireCurrentAccessScope();
          const destination = await resolvePastedImageAssetDestination(resolveSignal);
          if (!accessScopeIsCurrent()) {
            await pastedImageFolderRuntimeRef.current?.release(destination);
            requireCurrentAccessScope();
          }
          return destination;
        },
        rollbackSource: (rollback) => {
          if (!accessScopeIsCurrent()) return false;
          const latestDraft = draftsRef.current[entryId];
          if (!latestDraft) return false;
          const body = pasteModule.rollbackVaultClipboardSource(latestDraft.body, rollback);
          if (body === null) return false;
          if (body !== latestDraft.body) updateEntryDraft(entryId, { body });
          return true;
        },
        setError: (message) => {
          if (accessScopeIsCurrent()) setError(message);
        },
        setStatus: (message) => {
          if (accessScopeIsCurrent()) setStatus(message);
        },
        signal,
        sourceFolderId: draft.folderId,
        sourceTitle: draft.title
      });
      if (!accessScopeIsCurrent()) {
        await result?.onDiscard?.();
        releasePendingPaste();
        return null;
      }
      if (!result) {
        releasePendingPaste();
        return null;
      }
      return {
        ...result,
        onSettled: async (outcome) => {
          try {
            await result.onSettled?.(outcome);
          } finally {
            if (!accessScopeIsCurrent()) {
              releasePendingPaste();
            } else if (outcome === "rollback-blocked") {
              const blocked = blockedPastedImageRollbackReleasesRef.current.get(entryId)
                ?? new Map<string, () => void>();
              blocked.set(result.source, releasePendingPaste);
              blockedPastedImageRollbackReleasesRef.current.set(entryId, blocked);
              setError(pasteModule.VAULT_CLIPBOARD_ROLLBACK_BLOCKED_MESSAGE);
            } else {
              releasePendingPaste();
            }
          }
        }
      };
    } catch (caught) {
      releasePendingPaste();
      if (accessScopeIsCurrent() && !signal.aborted) {
        setError(caught instanceof Error ? caught.message : "이미지 모듈 오류입니다.");
      }
      return null;
    }
  }

  function pasteImagesIntoActiveMarkdown(
    files: readonly File[],
    context: MarkdownImagePasteContext
  ) {
    if (!activeEntryId) return Promise.resolve(null);
    return pasteImagesIntoMarkdownEntry(activeEntryId, files, context);
  }

  async function importCanvasExternalFiles(files: readonly File[]) {
    const accessScopeGeneration = workspaceAccessScopeGenerationRef.current;
    const assertCurrent = () => {
      if (workspaceAccessScopeGenerationRef.current !== accessScopeGeneration) {
        throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
      }
    };
    if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      throw new Error("암호화된 이름 예약이 끝난 뒤 외부 파일을 추가해주세요.");
    }
    const folderId = selectedFolderId;
    const folderPath = folderId ? folderPaths.get(folderId) : "";
    if (folderId && !folderPath) {
      throw new Error("외부 파일을 저장할 Vault 폴더를 확인하지 못했습니다.");
    }
    const existingTitles = notesRef.current
      .filter((note) => (note.folderId ?? null) === folderId)
      .map((note) => entryLabel(note));
    const canvasImport = await import("../features/canvas/vaultCanvasExternalFiles");
    assertCurrent();
    return canvasImport.importVaultCanvasExternalFiles({
      assertCurrent,
      createAsset: async ({ bytes, mimeType, title }) => {
        assertCurrent();
        const result = await createEncryptedVaultAsset(profile, vaultIntegrityKey, {
          bytes,
          folderId,
          mimeType,
          title
        });
        assertCurrent();
        pendingCreatedEntryIdsRef.current.add(result.noteId);
      },
      existingTitles,
      files,
      folderPath: folderPath ?? ""
    });
  }

  async function createConvertedMarkdownCopy(draft: VaultMarkdownCopyDraft) {
    const accessScopeGeneration = workspaceAccessScopeGenerationRef.current;
    const assertCurrent = () => {
      if (workspaceAccessScopeGenerationRef.current !== accessScopeGeneration) {
        throw new DOMException("Vault 접근 범위가 변경되었습니다.", "AbortError");
      }
    };
    if (!vaultIntegrityKey || !vaultNameWritesReady || pathRewriteBusyRef.current) {
      throw new Error("암호화된 이름 예약이 끝난 뒤 복사본을 만들어주세요.");
    }
    const formatConverter = await import("../features/vault/core/formatConverter");
    assertCurrent();
    const encrypted = await getVisibleNotesByIdsFromServer(profile.uid, [draft.sourceEntryId]);
    const [latest] = await decryptVaultNotes(encrypted.notes, profile.uid, privateKey);
    assertCurrent();
    if (!latest || latest.contentFormat !== "legacy-html-v1") {
      throw new Error("변환할 HTML 원본을 서버에서 다시 확인하지 못했습니다.");
    }
    const localSource = notesRef.current.find((note) => note.id === draft.sourceEntryId);
    if (!localSource || localSource.contentFormat !== "legacy-html-v1") {
      throw new Error("미리보기한 HTML 원본을 현재 Vault에서 다시 확인하지 못했습니다.");
    }
    const previewPlan = formatConverter.planLegacyVaultFormatConversion({
      body: localSource.body,
      contentFormat: "legacy-html-v1",
      folderId: localSource.folderId ?? null,
      id: draft.sourceEntryId,
      revision: localSource.revision ?? 0,
      title: localSource.title
    });
    if (
      draft.sourceRevision !== previewPlan.copy.sourceRevision
      || draft.body !== previewPlan.copy.body
      || draft.folderId !== previewPlan.copy.folderId
    ) {
      throw new Error("미리보기와 변환 요청이 일치하지 않습니다. 최신 원본으로 다시 미리보기해주세요.");
    }
    formatConverter.assertFormatConversionSourceUnchanged(previewPlan, {
      body: latest.body,
      contentFormat: "legacy-html-v1",
      folderId: latest.folderId ?? null,
      id: latest.id,
      revision: latest.revision ?? 0,
      title: latest.title
    });
    const verifiedPlan = formatConverter.planLegacyVaultFormatConversion({
      body: latest.body,
      contentFormat: "legacy-html-v1",
      folderId: latest.folderId ?? null,
      id: latest.id,
      revision: latest.revision ?? 0,
      title: latest.title
    });
    const targetFolderId = latest.ownerUid === profile.uid && latest.type === "personal"
      ? latest.folderId ?? null
      : null;
    const title = uniqueTitle(
      notesRef.current.filter((note) => note.ownerUid === profile.uid),
      draft.title,
      targetFolderId,
      "markdown"
    );
    const result = await createMarkdownVaultNote(profile, vaultIntegrityKey, {
      body: verifiedPlan.copy.body,
      folderId: targetFolderId,
      title
    });
    assertCurrent();
    pendingCreatedEntryIdsRef.current.add(result.noteId);
    setStatus(`원본을 보존하고 '${title}' Markdown 복사본을 만들었습니다.`);
  }

  function openCoreTool(tool: VaultCoreToolId) {
    const requiresMarkdown = tool === "footnotes" || tool === "composer" || tool === "slides";
    if (requiresMarkdown && (!activeNote || activeNote.contentFormat !== "markdown-v1" || !activeDraft)) {
      setError("Markdown 노트를 연 뒤 이 Core 도구를 사용해주세요.");
      return;
    }
    if (tool === "format" && (!activeNote || activeNote.contentFormat !== "legacy-html-v1")) {
      setError("기존 HTML 노트를 연 뒤 Format converter를 사용해주세요.");
      return;
    }
    if (tool === "audio" && (!vaultNameWritesReady || pathRewriteBusy)) {
      setError("암호화된 이름 예약과 경로 작업이 끝난 뒤 녹음해주세요.");
      return;
    }
    if (tool === "composer" && (
      !activeNote
      || activeNote.ownerUid !== profile.uid
      || !isOnline
      || pathRewriteBusy
      || conflictedEntryIds.has(activeNote.id)
    )) {
      setError("내가 소유한 최신 Markdown 노트를 온라인에서 저장한 뒤 Note composer를 사용해주세요.");
      return;
    }
    setError(null);
    setActiveCoreTool(tool);
  }

  function handleCommand(command: CommandPaletteItem) {
    if (command.id.startsWith("vault-bookmark:")) {
      const bookmark = vaultBookmarks.find((candidate) => (
        command.id === `vault-bookmark:${candidate.kind}:${candidate.id}`
      ));
      if (bookmark) openVaultBookmark(bookmark);
      return;
    }
    if (command.id.startsWith("named-workspace:")) {
      const workspaceId = command.id.slice("named-workspace:".length);
      void restoreNamedWorkspace(workspaceId);
      return;
    }
    if (command.id.startsWith("graph-bookmark:")) {
      const bookmark = graphBookmarks.find((candidate) => command.id === `graph-bookmark:${candidate.id}`);
      if (bookmark) {
        setGlobalGraphSettings(bookmark.settings);
        applyGlobalGraphViewport(bookmark.viewport);
        openGlobalGraph();
      }
      return;
    }
    switch (command.id) {
      case "new-note": void createEntry("markdown"); break;
      case "new-canvas": void createEntry("canvas"); break;
      case "new-base": void createEntry("base"); break;
      case "new-drawing": void createEntry("markdown", "새 드로잉", createDrawingSource("새 드로잉")); break;
      case "new-kanban": void createEntry("markdown", "새 Kanban", createKanbanSource("새 Kanban")); break;
      case "daily-note": openDailyNote(); break;
      case "unique-note": createUniqueNote(); break;
      case "random-note": openRandomNote(); break;
      case "create-search-index": void createIndexFromCurrentSearch(); break;
      case "insert-template": insertTemplateIntoActiveNote(); break;
      case "new-from-template": createNoteFromTemplate(); break;
      case "global-graph": openGlobalGraph(); break;
      case "outline": showRightPanel("outline"); break;
      case "search": showLeftPanel("search"); break;
      case "bookmarks": showLeftPanel("bookmarks"); break;
      case "toggle-tab-pin": if (activeTabId) toggleTabPinned(activeTabId); break;
      case "toggle-calendar":
        if (compactCalendarLayout) {
          openCompactCalendarDialog();
        } else {
          showLeftPanel("files");
          setCalendarOpen((current) => leftOpen && leftMode === "files" ? !current : true);
        }
        break;
      case "toggle-left": toggleLeftPanel(); break;
      case "toggle-right": toggleRightPanel(); break;
      case "audio-recorder": openCoreTool("audio"); break;
      case "footnotes-view": openCoreTool("footnotes"); break;
      case "format-converter": openCoreTool("format"); break;
      case "note-composer": openCoreTool("composer"); break;
      case "slides": openCoreTool("slides"); break;
      case "web-viewer": openCoreTool("web"); break;
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

  function toggleDataviewTask(
    entryId: string,
    line: number,
    checked: boolean,
    expected: DataviewTask
  ) {
    const note = notesRef.current.find((candidate) => candidate.id === entryId);
    const draft = draftsRef.current[entryId];
    if (
      !note
      || !draft
      || note.ownerUid !== profile.uid
      || note.entryKind !== "markdown"
      || note.contentFormat !== "markdown-v1"
    ) {
      setError("내가 소유한 Markdown 작업만 Dataview에서 변경할 수 있습니다.");
      return;
    }
    if (
      deletingEntryIdsRef.current.has(entryId)
      || pathRewriteBusyRef.current
      || conflictedEntryIds.has(entryId)
    ) {
      setError("휴지통·경로 변경·저장 충돌을 먼저 해결한 뒤 작업을 변경해주세요.");
      return;
    }
    const nextBody = setDataviewTaskChecked(draft.body, line, checked, expected);
    if (nextBody === null) {
      setError("작업 원문이 변경되어 이전 줄을 수정하지 않았습니다. Dataview 결과를 새로 확인해주세요.");
      return;
    }
    if (nextBody === draft.body) return;
    updateEntryDraft(entryId, { body: nextBody });
    setError(null);
    setStatus("Dataview 작업을 Markdown 원문에 반영하고 revision 확인 저장을 예약했습니다.");
    window.setTimeout(() => void saveEntryRef.current(entryId), 0);
  }

  function renderMarkdownCodeBlock(language: string, source: string) {
    const normalized = language.trim().toLocaleLowerCase();
    if (normalized === "dataview") {
      return (
        <Suspense fallback={<VaultViewLoading label="Dataview" />}>
          <LazyDataviewBlock
            canToggleTask={(entryId) => {
              const note = noteById.get(entryId);
              return Boolean(
                note
                && note.ownerUid === profile.uid
                && note.entryKind === "markdown"
                && note.contentFormat === "markdown-v1"
                && !deletingEntryIds.has(entryId)
                && !conflictedEntryIds.has(entryId)
                && !pathRewriteBusy
              );
            }}
            entries={indexEntries}
            metadataByEntryId={baseMetadataByEntryId}
            onOpenEntry={(entryId) => openEntry(entryId)}
            onToggleTask={toggleDataviewTask}
            source={source}
          />
        </Suspense>
      );
    }
    if (normalized === "dataviewjs") {
      return (
        <aside className="vault-plugin-warning" role="alert">
          <strong>DataviewJS는 실행하지 않습니다.</strong>
          <p>임의 JavaScript·네트워크 호출 없이 LIST/TABLE/TASK/CALENDAR Dataview 쿼리를 사용해주세요.</p>
        </aside>
      );
    }
    return undefined;
  }

  function closeDraftMergeResolver(restoreFocus = true) {
    draftMergeRequestGenerationRef.current += 1;
    setDraftMergeConflict(null);
    setDraftMergeOpen(false);
    setDraftMergeBusyEntryId(null);
    const returnFocus = draftMergeReturnFocusRef.current;
    draftMergeReturnFocusRef.current = null;
    if (restoreFocus && returnFocus?.isConnected) {
      window.setTimeout(() => returnFocus.focus(), 0);
    }
  }

  async function openDraftMergeResolver(entryId: string, trigger?: HTMLButtonElement | null) {
    draftMergeReturnFocusRef.current = trigger ?? null;
    const prepared = await prepareDraftMergeConflict(entryId, true);
    if (!prepared && trigger?.isConnected) window.setTimeout(() => trigger.focus(), 0);
  }

  async function applyDraftMergeResolution(mergedMarkdown: string) {
    const conflict = draftMergeConflict;
    if (
      !conflict
      || !draftMergeOpen
      || !vaultIntegrityKey
      || !vaultNameWritesReady
      || pathRewriteBusyRef.current
      || deletingEntryIdsRef.current.has(conflict.entryId)
      || entryMutationPromisesRef.current.has(conflict.entryId)
    ) {
      setError("현재 서버 상태를 다시 확인한 뒤 병합을 적용해주세요.");
      throw new Error("merge-precondition-failed");
    }

    const entryId = conflict.entryId;
    const generation = draftMergeRequestGenerationRef.current + 1;
    draftMergeRequestGenerationRef.current = generation;
    setDraftMergeBusyEntryId(entryId);
    const finishEntryMutation = beginEntryMutation(entryId);
    savingEntryIdsRef.current.add(entryId);
    setSavingEntryIds((current) => new Set(current).add(entryId));
    try {
      const currentBase = draftBaseSnapshotsRef.current.get(entryId);
      const currentLocal = draftsRef.current[entryId];
      if (
        currentBase !== conflict.base
        || !sameRevisionedDraft(currentLocal, conflict.local)
        || !currentLocal?.dirty
      ) {
        setError("병합 화면을 연 뒤 현재 편집본이 변경되었습니다. 최신 내용으로 다시 비교해주세요.");
        if (currentBase && currentLocal?.dirty && currentLocal.baseRevision === currentBase.baseRevision) {
          void prepareDraftMergeConflict(entryId, true);
        }
        throw new Error("merge-local-changed");
      }

      const remote = await readCurrentServerVaultEntry(entryId);
      if (
        draftMergeRequestGenerationRef.current !== generation
        || draftBaseSnapshotsRef.current.get(entryId) !== conflict.base
        || !isMarkdownMergeEntry(remote)
        || remote.ownerUid !== conflict.base.ownerUid
      ) {
        throw new Error("merge-scope-changed");
      }
      const latestBeforeSave = draftsRef.current[entryId];
      if (!latestBeforeSave || !sameRevisionedDraft(latestBeforeSave, conflict.local)) {
        setError("서버 확인 중 현재 편집본이 변경되어 병합을 저장하지 않았습니다.");
        if (latestBeforeSave?.dirty && latestBeforeSave.baseRevision === conflict.base.baseRevision) {
          setDraftMergeConflict({ ...conflict, local: captureRevisionedDraft(latestBeforeSave) });
        }
        throw new Error("merge-local-changed");
      }

      const remoteChanged = (remote.revision ?? 0) !== (conflict.remote.revision ?? 0)
        || remote.body !== conflict.remote.body
        || remote.title !== conflict.remote.title
        || (remote.folderId ?? null) !== (conflict.remote.folderId ?? null)
        || remote.type !== conflict.remote.type
        || remote.participantUids.join("\n") !== conflict.remote.participantUids.join("\n");
      if (remoteChanged) {
        setConflictedEntryIds((current) => new Map(current).set(entryId, remote.revision ?? 0));
        setDraftMergeConflict({
          base: conflict.base,
          entryId,
          local: captureRevisionedDraft(latestBeforeSave),
          remote
        });
        setError("병합 적용 직전에 서버 최신본이 변경되었습니다. 새 비교 결과에서 다시 선택해주세요.");
        throw new Error("merge-remote-changed");
      }

      const resolvedTitle = resolveConflictScalar(
        conflict.base.title,
        conflict.local.title,
        remote.title
      );
      const resolvedFolder = resolveConflictScalar(
        conflict.base.folderId,
        conflict.local.folderId,
        remote.folderId ?? null
      );
      if (
        resolvedTitle.conflict
        || resolvedFolder.conflict
        || (!resolvedFolder.conflict && resolvedFolder.value !== (remote.folderId ?? null))
        || (!resolvedTitle.conflict && remote.ownerUid !== profile.uid && resolvedTitle.value !== remote.title)
      ) {
        setError("본문과 함께 이름 또는 폴더도 양쪽에서 변경되어 자동 저장하지 않았습니다. 현재 편집본 복사 후 서버 최신본에서 다시 적용해주세요.");
        throw new Error("merge-metadata-conflict");
      }

      const submitted = {
        body: mergedMarkdown,
        folderId: remote.folderId ?? null,
        title: resolvedTitle.value
      };
      const result = await saveEncryptedVaultEntry(
        { ...remote, revision: remote.revision ?? 0 },
        profile.uid,
        privateKey,
        vaultIntegrityKey,
        submitted
      );
      if (
        result.revision !== (remote.revision ?? 0)
        && result.revision !== (remote.revision ?? 0) + 1
      ) {
        throw new Error("merge-revision-invalid");
      }
      if (draftMergeRequestGenerationRef.current !== generation) {
        throw new Error("merge-scope-changed");
      }

      let newerObservedRevision = 0;
      commitNotes((current) => current.map((candidate) => {
        if (candidate.id !== entryId) return candidate;
        if ((candidate.revision ?? 0) > result.revision) {
          newerObservedRevision = candidate.revision ?? 0;
          return candidate;
        }
        return {
          ...candidate,
          ...persistedEncryptedMutationPatch(result),
          body: submitted.body,
          folderId: submitted.folderId,
          revision: result.revision,
          title: submitted.title
        };
      }));
      const latest = draftsRef.current[entryId];
      if (!latest) throw new Error("merge-local-missing");
      let nextDraft = reconcileDraftAfterConflictSave(
        latest,
        conflict.local,
        submitted,
        result.revision
      );
      if (newerObservedRevision && !nextDraft.dirty) {
        nextDraft = { ...nextDraft, dirty: true };
      }
      const nextDrafts = { ...draftsRef.current, [entryId]: nextDraft };
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);

      if (nextDraft.dirty || newerObservedRevision) {
        draftBaseSnapshotsRef.current.set(entryId, {
          baseRevision: result.revision,
          body: submitted.body,
          contentFormat: "markdown-v1",
          entryKind: "markdown",
          folderId: submitted.folderId,
          ownerUid: remote.ownerUid,
          title: submitted.title
        });
      } else {
        draftBaseSnapshotsRef.current.delete(entryId);
      }
      if (newerObservedRevision) {
        setConflictedEntryIds((current) => new Map(current).set(entryId, newerObservedRevision));
        setError("병합 저장 직후 더 최신 서버 revision을 감지했습니다. 편집본을 유지하고 다시 비교합니다.");
        setDraftMergeConflict(null);
        setDraftMergeOpen(false);
        window.setTimeout(() => void prepareDraftMergeConflict(entryId, true), 0);
        throw new Error("merge-newer-revision-observed");
      }

      setConflictedEntryIds((current) => {
        const next = new Map(current);
        next.delete(entryId);
        return next;
      });
      setSaveFailedEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      setDraftMergeConflict(null);
      setDraftMergeOpen(false);
      setError(null);
      setStatus(nextDraft.dirty
        ? "병합본을 새 revision으로 저장하고, 저장 중 추가된 편집은 계속 보존했습니다."
        : "선택한 병합본을 새 revision으로 안전하게 저장했습니다.");
      const returnFocus = draftMergeReturnFocusRef.current;
      draftMergeReturnFocusRef.current = null;
      if (returnFocus?.isConnected) window.setTimeout(() => returnFocus.focus(), 0);
      if (nextDraft.dirty) window.setTimeout(() => void saveEntryRef.current(entryId), 0);
    } catch (caught) {
      if (caught instanceof NoteRevisionConflictError) {
        setConflictedEntryIds((current) => new Map(current).set(entryId, caught.actualRevision));
        setError("병합 저장 직전에 서버 revision이 변경되었습니다. 최신 서버 본문으로 다시 비교합니다.");
        await prepareDraftMergeConflict(entryId, true);
      }
      throw new Error("draft-merge-not-saved");
    } finally {
      savingEntryIdsRef.current.delete(entryId);
      setSavingEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      if (draftMergeRequestGenerationRef.current === generation) {
        setDraftMergeBusyEntryId(null);
      }
      finishEntryMutation();
    }
  }

  async function reloadConflictedEntry(entryId: string) {
    const captured = draftsRef.current[entryId];
    if (
      !captured?.dirty
      || !window.confirm("현재 편집본을 버리고 서버 최신본으로 되돌릴까요? 이 작업은 자동으로 합치지 않습니다.")
    ) {
      return;
    }
    if (entryMutationPromisesRef.current.has(entryId)) {
      setError("진행 중인 저장이 끝난 뒤 서버 최신본을 다시 불러와주세요.");
      return;
    }
    const generation = draftMergeRequestGenerationRef.current + 1;
    draftMergeRequestGenerationRef.current = generation;
    setDraftMergeBusyEntryId(entryId);
    const finishEntryMutation = beginEntryMutation(entryId);
    try {
      const remote = await readCurrentServerVaultEntry(entryId);
      if (
        draftMergeRequestGenerationRef.current !== generation
        || !sameRevisionedDraft(draftsRef.current[entryId], captured)
      ) {
        setError("서버 확인 중 편집본이 변경되어 되돌리지 않았습니다.");
        return;
      }
      commitNotes((current) => current.map((candidate) => candidate.id === entryId ? remote : candidate));
      const nextDraft: DraftState = {
        baseRevision: remote.revision ?? 0,
        body: remote.body,
        dirty: false,
        folderId: remote.folderId ?? null,
        title: remote.title
      };
      const nextDrafts = { ...draftsRef.current, [entryId]: nextDraft };
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      draftBaseSnapshotsRef.current.delete(entryId);
      setConflictedEntryIds((current) => {
        const next = new Map(current);
        next.delete(entryId);
        return next;
      });
      setSaveFailedEntryIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      setDraftMergeConflict(null);
      setDraftMergeOpen(false);
      setError(null);
      setStatus("서버에서 직접 확인한 최신 암호화 revision으로 되돌렸습니다.");
    } catch {
      if (draftMergeRequestGenerationRef.current === generation) {
        setError("서버 최신본을 안전하게 확인하지 못해 현재 편집본을 유지했습니다.");
      }
    } finally {
      if (draftMergeRequestGenerationRef.current === generation) setDraftMergeBusyEntryId(null);
      finishEntryMutation();
    }
  }

  async function preserveConflictedEntry(entryId: string) {
    const note = notes.find((candidate) => candidate.id === entryId);
    const draft = draftsRef.current[entryId];
    if (!note || !draft || note.entryKind === "asset" || note.entryKind === "legacy-html") return;
    const kind = note.entryKind as "markdown" | "canvas" | "base";
    const preserved = await createEntry(kind, `${draft.title.replace(/\.(?:md|canvas|base)$/iu, "")} 충돌 복사본`, draft.body, {
      folderId: draft.folderId
    });
    if (preserved) {
      setStatus("현재 편집본을 별도 암호화 항목으로 보존했습니다. 원본 충돌은 그대로 유지됩니다.");
    }
  }

  function restoreHistorySnapshot(entryId: string, snapshot: VaultHistoryDraft) {
    if (deletingEntryIdsRef.current.has(entryId)) {
      setError("휴지통으로 이동 중인 항목은 이력을 복원할 수 없습니다.");
      return;
    }
    const note = notes.find((candidate) => candidate.id === entryId);
    if (!note || snapshot.contentFormat !== note.contentFormat || snapshot.entryKind !== note.entryKind) {
      setError("현재 항목과 이력 형식이 달라 복원하지 않았습니다.");
      return;
    }
    const currentDraft = draftsRef.current[entryId] ?? {
      baseRevision: note.revision ?? 0,
      body: note.body,
      dirty: false,
      folderId: note.folderId ?? null,
      title: note.title
    };
    captureMarkdownDraftBase(entryId, note, currentDraft, true);
    const nextDraft: DraftState = {
      baseRevision: note.revision ?? 0,
      body: snapshot.body,
      dirty: true,
      folderId: note.folderId ?? null,
      title: note.title
    };
    const nextDrafts = { ...draftsRef.current, [entryId]: nextDraft };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setConflictedEntryIds((current) => {
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
    setSaveFailedEntryIds((current) => {
      const next = new Set(current);
      next.delete(entryId);
      return next;
    });
    setError(null);
    setStatus("선택한 이력의 본문을 현재 위치에 복원했습니다. 자동 저장 후 새 revision으로 남습니다.");
    // A history restore is a programmatic edit, so schedule it through the
    // same revision-checked autosave path as editor changes. The dirty draft
    // remains the source of truth if the save is offline, fails, or conflicts.
    window.setTimeout(() => void saveEntryRef.current(entryId), 0);
  }

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
  // Read-only recovery discovery does not set pathRewriteBusy. The flag now
  // means an actual rename/move/recovery mutation owns the durable path lock.
  const pathRewriteContentLocked = pathRewriteBusy;
  const entryCreationContentLocked = pendingEntryCreation !== null;
  const activeSaveStatus = pendingEntryCreation
    ? `암호화 ${pendingEntryCreation.kind === "canvas" ? "Canvas" : pendingEntryCreation.kind === "base" ? "Base" : "노트"} 생성 중…`
    : pathRewriteBusy
    ? `내부 참조 확인 중${pathRewriteJob ? ` · ${pathRewriteJob.cursor}/${pathRewriteJob.stepCount}` : ""}`
    : activeEntryId && deletingEntryIds.has(activeEntryId)
    ? "휴지통으로 안전하게 이동 중…"
    : activeEntryId && conflictedEntryIds.has(activeEntryId)
    ? "저장 충돌 · 선택 필요"
    : activeEntryId && savingEntryIds.has(activeEntryId)
      ? "암호화 저장 중…"
      : activeEntryId && !isOnline && activeDraft?.dirty
        ? "오프라인 · 현재 세션 메모리에 보존됨"
        : activeEntryId && saveFailedEntryIds.has(activeEntryId)
          ? "저장 실패 · 다시 시도 필요"
          : activeDraft?.dirty
            ? "자동 저장 대기"
            : activeEntryId
              ? "저장됨"
              : "";
  const vaultNameCollisionLabels = [...vaultNameCollisionRepairTargetIds].map((targetId) => {
    const note = notes.find((candidate) => candidate.id === targetId);
    if (note) return entryPaths.get(note.id) ?? entryLabel(note);
    return folderPaths.get(targetId) ?? folders.find((folder) => folder.id === targetId)?.displayName ?? "알 수 없는 항목";
  }).slice(0, 4);
  const activeCanResolveNameCollision = Boolean(
    activeNote
    && activeDraft
    && vaultNameMigrationStatus === "blocked"
    && vaultNameCollisionTargetIds.has(activeNote.id)
    && activeDraft.title.trim() !== activeNote.title.trim()
  );
  const bookmarkEntryOptions = useMemo(() => notes.map((note) => ({
    id: note.id,
    path: entryPaths.get(note.id) ?? entryLabel(note),
    title: entryLabel(note)
  })), [entryPaths, notes]);
  const optimisticFileTreeNotes = useMemo(() => (
    projectOptimisticVaultEntries(notes, optimisticEntryPatches)
  ), [notes, optimisticEntryPatches]);
  const contextMenuShareNote = contextMenu?.targetKind === "entry"
    ? notes.find((note) => note.id === contextMenu.targetId) ?? null
    : null;
  const contextMenuCanShare = Boolean(
    contextMenuShareNote
    && contextMenuShareNote.ownerUid === profile.uid
    && !contextMenuShareNote.isDeleted
    && (contextMenuShareNote.entryKind === "markdown" || contextMenuShareNote.entryKind === "legacy-html")
  );

  return (
    <AppShell onBeforeExit={flushVaultBeforeExit} variant="vault">
      <div
        className={`vault-workspace${leftOpen ? "" : " vault-left-closed"}${rightOpen ? "" : " vault-right-closed"}`}
        data-workspace-sync={workspaceConflict
          ? "conflict"
          : !workspaceReady
            ? "loading"
            : workspaceSavePending || latestWorkspaceSerialization !== lastSavedWorkspaceSerialization
              ? "pending"
              : "saved"}
        onKeyDownCapture={(event) => {
          if (!workspaceReady && event.isTrusted) workspaceInteractionDuringLoadRef.current = true;
        }}
        onPointerDownCapture={(event) => {
          if (!workspaceReady && event.isTrusted) workspaceInteractionDuringLoadRef.current = true;
        }}
        ref={vaultWorkspaceRef}
        style={{ "--vault-right-panel-width": `${effectiveRightPanelWidth}px` } as CSSProperties}
      >
        {workspaceConflict ? (
          <aside aria-label="워크스페이스 배치 충돌" className="vault-workspace-conflict" role="alert">
            <div>
              <strong>워크스페이스 배치 충돌</strong>
              <p>현재 탭의 배치와 서버의 최신 배치를 어느 쪽도 자동으로 덮어쓰지 않았습니다.</p>
            </div>
            <div>
              <button onClick={keepCurrentWorkspaceAfterConflict} type="button">현재 배치를 서버에 저장</button>
              {workspaceConflict.remoteState ? (
                <button
                  onClick={() => applyRestoredWorkspace(workspaceConflict.remoteState!, workspaceConflict.actualRevision)}
                  type="button"
                >서버 배치 불러오기</button>
              ) : (
                <button onClick={() => void reloadWorkspaceConflictRemote()} type="button">서버 배치 다시 확인</button>
              )}
            </div>
          </aside>
        ) : null}
        {pathRewriteJob?.status === "blocked" ? (
          <Suspense fallback={<VaultViewLoading label="링크 갱신 복구" />}>
            <LazyVaultPathRewriteRecoveryNotice
              busy={pathRewriteBusy}
              job={pathRewriteJob}
              online={isOnline}
              ready={
                vaultDataReady
                && vaultNameWritesReady
                && folderServerReservationSignature !== null
                && noteServerReservationSignature !== null
              }
              onRetry={() => void retryBlockedPathRewriteJob()}
            />
          </Suspense>
        ) : null}
        {recoverableImportJobs.length && importRecoveryOpen ? (
          <Suspense fallback={<VaultViewLoading label="ZIP 가져오기 복구" />}>
            <LazyVaultImportRecoveryPanel
              busyJobId={importRecoveryBusyJobId}
              jobs={recoverableImportJobs}
              onClose={() => setImportRecoveryOpen(false)}
              onRecheck={() => recheckRecoverableImportJobs()}
              onRollback={rollbackRecoverableImportJob}
            />
          </Suspense>
        ) : recoverableImportJobs.length ? (
          <aside aria-label="ZIP 가져오기 복구 알림" className="vault-workspace-conflict" role="status">
            <div>
              <strong>ZIP 가져오기 복구 필요</strong>
              <p>기존 데이터는 변경하지 않았습니다. 서버 상태를 확인하고 복구 방법을 선택하세요.</p>
            </div>
            <div><button onClick={() => setImportRecoveryOpen(true)} type="button">복구 패널 열기</button></div>
          </aside>
        ) : null}
        {!workspaceConflict
        && !vaultNameWritesReady
        && (
          !isOnline
          || vaultNameMigrationStatus === "waiting"
          || vaultNameMigrationStatus === "running"
          || vaultNameMigrationStatus === "blocked"
        ) ? (
          <FeatureErrorBoundary
            fallback={(
              <aside aria-label="Vault 이름 무결성 준비" className="vault-workspace-conflict vault-name-migration" role="alert">
                <div>
                  <strong>암호화된 이름 무결성 준비</strong>
                  <p>안내 오류입니다. 편집 내용은 유지됩니다.</p>
                </div>
                <div>
                  {vaultNameCollisionRepairTargetIds.size ? (
                    <button disabled={vaultNameCollisionRepairBusy} onClick={() => void repairFirstVaultNameCollision()} type="button">충돌 이름 바꾸기</button>
                  ) : null}
                  <button disabled={!isOnline || vaultNameCollisionRepairBusy} onClick={retryVaultNameMigration} type="button">다시 확인</button>
                </div>
              </aside>
            )}
            key={vaultIntegrityRetryAttempt}
          >
            <Suspense fallback={<VaultViewLoading label="이름 무결성 준비" />}>
              <LazyVaultNameIntegrityNotice
                collisionLabels={vaultNameCollisionLabels}
                failure={vaultNameMigrationFailure}
                migrationStatus={vaultNameMigrationStatus}
                online={isOnline}
                onRepair={() => void repairFirstVaultNameCollision()}
                onRetry={retryVaultNameMigration}
                progress={vaultNameMigrationProgress}
                repairBusy={vaultNameCollisionRepairBusy}
                repairCount={vaultNameCollisionRepairTargetIds.size}
              />
            </Suspense>
          </FeatureErrorBoundary>
        ) : null}
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
        <aside
          aria-hidden={activeMobileDrawer ? true : undefined}
          aria-label="Vault 리본"
          className="vault-ribbon"
          inert={Boolean(activeMobileDrawer)}
        >
          <button aria-controls="vault-left-panel" aria-expanded={leftOpen} aria-label={leftOpen ? "왼쪽 패널 닫기" : "왼쪽 패널 열기"} onClick={toggleLeftPanel} ref={leftPanelToggleRef} type="button"><Menu size={18} /></button>
          <button aria-label="명령 팔레트" onClick={() => setCommandPaletteOpen(true)} title="명령 팔레트 (Cmd/Ctrl+P)" type="button"><CommandIcon size={18} /></button>
          <button aria-label="파일" aria-pressed={leftMode === "files"} onClick={() => showLeftPanel("files")} title="파일" type="button"><Files size={18} /></button>
          <button aria-label="검색" aria-pressed={leftMode === "search"} onClick={() => showLeftPanel("search")} title="검색" type="button"><Search size={18} /></button>
          <button aria-label="태그" aria-pressed={leftMode === "tags"} onClick={() => showLeftPanel("tags")} title="태그" type="button"><Tags size={18} /></button>
          <button aria-label="북마크와 워크스페이스" aria-pressed={leftMode === "bookmarks"} onClick={() => showLeftPanel("bookmarks")} title="북마크와 워크스페이스" type="button"><Bookmark size={18} /></button>
          <button aria-label="그래프 보기" onClick={openGlobalGraph} title="그래프 보기" type="button"><Network size={18} /></button>
          <button aria-label="새 Canvas" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("canvas")} title="새 Canvas" type="button"><GitFork size={18} /></button>
          <button aria-label="새 Base" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("base")} title="새 Base" type="button"><Table2 size={18} /></button>
          <button aria-label="새 QuickMemo Drawing" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("markdown", "새 드로잉", createDrawingSource("새 드로잉"))} title="새 QuickMemo Drawing" type="button"><PenTool size={18} /></button>
          <button aria-label="새 Kanban" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("markdown", "새 Kanban", createKanbanSource("새 Kanban"))} title="새 Kanban" type="button"><Columns3 size={18} /></button>
          <button aria-label="Obsidian ZIP 가져오기" disabled={!vaultNameWritesReady || vaultImportBusy || pathRewriteBusy || entryCreationContentLocked} onClick={() => importInputRef.current?.click()} title="Obsidian ZIP 가져오기" type="button"><Upload size={18} /></button>
          <button aria-label="노트와 첨부파일을 복호화해 Obsidian ZIP 내보내기" onClick={() => void exportObsidianZip()} title="노트와 첨부파일을 복호화해 Obsidian ZIP 내보내기" type="button"><Download size={18} /></button>
          <button aria-label="Vault 휴지통" onClick={() => setTrashOpen(true)} ref={trashButtonRef} title="Vault 휴지통" type="button"><Trash2 size={18} /></button>
          <span className="vault-ribbon-spacer" />
          <button aria-label="자료실" onClick={() => void navigateAfterSaving("/library")} title="자료실" type="button"><LibraryBig size={18} /></button>
          <button aria-label="일정" onClick={() => void navigateAfterSaving("/schedule")} title="일정" type="button"><CalendarDays size={18} /></button>
          <button aria-label="기존 노트 관리" onClick={() => void navigateAfterSaving("/app/legacy")} title="기존 노트 관리" type="button"><Settings2 size={18} /></button>
        </aside>

        {activeMobileDrawer ? (
          <button
            aria-hidden="true"
            className="vault-mobile-drawer-backdrop"
            onClick={activeMobileDrawer === "left" ? closeLeftPanel : closeRightPanel}
            tabIndex={-1}
            type="button"
          />
        ) : null}

        {leftOpen ? (
          <aside
            aria-label="Vault 탐색기"
            aria-modal={mobileLayout ? true : undefined}
            className="vault-left-panel"
            id="vault-left-panel"
            ref={leftPanelRef}
            role={mobileLayout ? "dialog" : undefined}
            tabIndex={mobileLayout ? -1 : undefined}
          >
            <header>
              <strong>{leftMode === "files" ? "파일" : leftMode === "search" ? "검색" : leftMode === "tags" ? "태그" : "북마크"}</strong>
              <button
                aria-controls="vault-left-panel"
                aria-expanded="true"
                aria-label={mobileLayout ? "왼쪽 패널 닫기" : "왼쪽 패널 접기"}
                className="vault-left-panel-collapse"
                onClick={closeLeftPanel}
                title={mobileLayout ? "왼쪽 패널 닫기" : "왼쪽 패널 접기"}
                type="button"
              >{mobileLayout ? <X aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={18} />}</button>
            </header>
            {leftMode === "files" ? (
              <>
                <div className="vault-panel-toolbar">
                  <button aria-label="새 노트" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("markdown")} type="button"><FilePlus2 size={16} /></button>
                  <button aria-label="새 폴더" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createFolder()} type="button"><FolderPlus size={16} /></button>
                  <button aria-label="새 Canvas" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("canvas")} type="button"><GitFork size={16} /></button>
                  <button aria-label="새 Base" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("base")} type="button"><Table2 size={16} /></button>
                </div>
                {legacyFolderCount > 0 ? (
                  <button className="vault-migration-button" disabled={!vaultNameWritesReady || folderMigrationBusy} onClick={() => void migrateFolders()} type="button">
                    <FolderInput size={15} /> 기존 폴더 {legacyFolderCount}개 암호화
                  </button>
                ) : null}
                <VaultFileTree
                  expandedFolderIds={expandedFolderIds}
                  folders={folders}
                  mutationDisabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked}
                  notes={optimisticFileTreeNotes}
                  onBulkMove={moveVaultTreeTargets}
                  onBulkTrash={trashVaultTreeTargets}
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
                  onRenameTarget={renameVaultTreeTarget}
                  onSelectFolder={setSelectedFolderId}
                  onToggleFolder={(folderId) => setExpandedFolderIds((current) => {
                    const next = new Set(current);
                    if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
                    return next;
                  })}
                  selectedFolderId={selectedFolderId}
                />
                <section aria-label="Daily Notes" className={`vault-calendar-pane${calendarOpen ? " open" : ""}`}>
                  <button
                    aria-expanded={compactCalendarLayout ? compactCalendarOpen : calendarOpen}
                    className="vault-calendar-toggle"
                    onClick={(event) => compactCalendarLayout
                      ? openCompactCalendarDialog(event.currentTarget)
                      : setCalendarOpen((current) => !current)}
                    ref={compactCalendarToggleRef}
                    type="button"
                  >
                    {compactCalendarLayout
                      ? <ChevronRight size={14} />
                      : calendarOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <CalendarDays size={14} /> Daily Notes
                  </button>
                  {calendarOpen && !compactCalendarLayout ? (
                    <Suspense fallback={<VaultViewLoading label="Daily Notes" />}>
                      <LazyDailyNotesCalendar
                        createDisabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked}
                        cursorMonth={calendarCursorMonth}
                        monthNoteKeys={periodicNoteKeys.months}
                        noteDates={dailyNoteDates}
                        onCursorMonthChange={setCalendarCursorMonth}
                        onOpenDate={openDailyNoteForDate}
                        onOpenMonth={openMonthlyNote}
                        onOpenWeek={openWeeklyNote}
                        weekNoteKeys={periodicNoteKeys.weeks}
                      />
                      <LazyDailyNotesSettings
                        folderId={dailyNotesFolderId}
                        folderOptions={dailyFolderOptions}
                        onFolderChange={setDailyNotesFolderId}
                        onTemplatesFolderChange={setTemplatesFolderPath}
                        onTemplatesIncludeDescendantsChange={setTemplatesIncludeDescendants}
                        onTemplateChange={setDailyNotesTemplateEntryId}
                        templateEntryId={dailyNotesTemplateEntryId}
                        templateOptions={dailyTemplateOptions}
                        templatesFolderPath={templatesFolderPath}
                        templatesIncludeDescendants={templatesIncludeDescendants}
                      />
                    </Suspense>
                  ) : null}
                </section>
              </>
            ) : leftMode === "search" ? (
              <Suspense fallback={<VaultViewLoading label="검색" />}>
                <LazyVaultSearchPanel
                  bookmarks={searchBookmarks}
                  notes={filteredNotes}
                  onAddBookmark={addSearchBookmark}
                  onOpen={openEntry}
                  onQueryChange={setSearchQuery}
                  onRemoveBookmark={removeSearchBookmark}
                  pathsByEntryId={entryPaths}
                  query={searchQuery}
                />
              </Suspense>
            ) : leftMode === "tags" ? (
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
            ) : (
              <Suspense fallback={<VaultViewLoading label="북마크와 워크스페이스" />}>
                <LazyVaultWorkspaceManager
                  activeEntryId={activeEntryId}
                  bookmarks={vaultBookmarks}
                  canBookmarkGraph={activeTab?.kind === "global-graph"}
                  canBookmarkSearch={Boolean(searchQuery.trim())}
                  entries={bookmarkEntryOptions}
                  namedWorkspaces={namedWorkspaces}
                  onAddBookmark={addVaultBookmark}
                  onCaptureWorkspace={captureNamedWorkspace}
                  onDeleteWorkspace={deleteNamedWorkspace}
                  onOpenBookmark={openVaultBookmark}
                  onRemoveBookmark={removeVaultBookmark}
                  onRenameWorkspace={renameNamedWorkspace}
                  onRestoreWorkspace={(workspaceId) => void restoreNamedWorkspace(workspaceId)}
                />
              </Suspense>
            )}
          </aside>
        ) : null}

        <main
          aria-hidden={activeMobileDrawer ? true : undefined}
          className="vault-center"
          inert={Boolean(activeMobileDrawer)}
        >
          <WorkspacePaneTree
            activeGroupId={activeTabGroupId}
            layout={workspaceLayout}
            mobile={mobileLayout}
            onResize={resizeWorkspacePane}
            panes={tabGroups.map((group): WorkspacePaneRender => {
              const groupTabs = group.tabIds.flatMap((tabId) => {
                const tab = tabs.find((candidate) => candidate.id === tabId);
                return tab ? [tab] : [];
              });
              const groupActiveTab = groupTabs.find((tab) => tab.id === group.activeTabId) ?? null;
              const groupActiveEntryId = groupActiveTab?.kind === "entry" ? groupActiveTab.entryId : null;
              const groupActiveNote = groupActiveEntryId
                ? notes.find((note) => note.id === groupActiveEntryId) ?? null
                : null;
              const groupActiveDraft = groupActiveEntryId ? drafts[groupActiveEntryId] : undefined;
              const groupPosition = workspaceGroupOrder.indexOf(group.id) + 1;
              const groupLabel = `탭 그룹 ${Math.max(1, groupPosition)}`;
              const groupIsActive = group.id === activeTabGroupId;
              const tabPanelId = `vault-${group.id}-tabpanel`;
              return { groupId: group.id, node: (
                <div
                  className={`vault-tab-group${groupIsActive ? " active" : ""}`}
                  data-group-id={group.id}
                  key={group.id}
                >
                  <div className="vault-tab-bar">
                    {mobileLayout && tabGroups.length > 1 ? (
                      <label className="vault-tab-group-selector">
                        <span className="sr-only">탭 그룹 선택</span>
                        <select
                          aria-label="탭 그룹 선택"
                          disabled={entryCreationContentLocked}
                          onChange={(event) => activateTabInGroup(event.currentTarget.value as WorkspaceTabGroupId)}
                          value={activeTabGroupId}
                        >
                          {tabGroups.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              그룹 {workspaceGroupOrder.indexOf(candidate.id) + 1} · {candidate.tabIds.length}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <div aria-label={`${groupLabel} 열린 탭`} className="vault-tab-strip" onKeyDown={handleRovingTabListKeyDown} role="tablist">
              {groupTabs.map((tab) => (
                <div className={`${tab.id === group.activeTabId ? "active" : ""}${tab.pinned ? " pinned" : ""}`} key={tab.id} role="presentation">
                  <button
                    aria-controls={tabPanelId}
                    aria-selected={tab.id === group.activeTabId}
                    disabled={entryCreationContentLocked}
                    id={tab.id}
                    onClick={() => activateTabInGroup(group.id, tab.id)}
                    role="tab"
                    tabIndex={tab.id === group.activeTabId ? 0 : -1}
                    type="button"
                  >
                    {tab.label}
                  </button>
                  <button
                    aria-label={`${tab.label} 탭 ${tab.pinned ? "고정 해제" : "고정"}`}
                    aria-pressed={Boolean(tab.pinned)}
                    className="vault-tab-pin"
                    disabled={entryCreationContentLocked}
                    onClick={() => toggleTabPinned(tab.id)}
                    title={tab.pinned ? "탭 고정 해제" : "탭 고정"}
                    type="button"
                  ><Pin fill={tab.pinned ? "currentColor" : "none"} size={12} /></button>
                  <button
                    aria-label={tab.pinned ? `${tab.label} 고정됨: 닫으려면 고정 해제` : `${tab.label} 닫기`}
                    disabled={Boolean(tab.pinned) || entryCreationContentLocked}
                    onClick={() => closeTab(tab.id)}
                    type="button"
                  ><X size={13} /></button>
                </div>
              ))}
            </div>
            <div className="vault-tab-actions" role="presentation">
              {groupIsActive ? <button aria-label="새 노트 탭" className="vault-new-tab" disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("markdown")} type="button">+</button> : null}
              {groupIsActive && !mobileLayout ? (
                <>
                  <button
                    aria-label="현재 pane을 좌우로 분할"
                    className="vault-split-direction"
                    disabled={entryCreationContentLocked || tabGroups.length >= MAXIMUM_WORKSPACE_PANES || groupActiveTab?.kind !== "entry"}
                    onClick={() => splitActiveWorkspacePane("vertical")}
                    title="오른쪽에 새 탭 그룹"
                    type="button"
                  ><Columns3 aria-hidden="true" size={16} /></button>
                  <button
                    aria-label="현재 pane을 위아래로 분할"
                    className="vault-split-direction"
                    disabled={entryCreationContentLocked || tabGroups.length >= MAXIMUM_WORKSPACE_PANES || groupActiveTab?.kind !== "entry"}
                    onClick={() => splitActiveWorkspacePane("horizontal")}
                    title="아래에 새 탭 그룹"
                    type="button"
                  ><Columns3 aria-hidden="true" size={16} style={{ transform: "rotate(90deg)" }} /></button>
                </>
              ) : null}
              {groupIsActive ? <button aria-controls="vault-right-panel" aria-expanded={rightOpen} aria-label={rightOpen ? "오른쪽 패널 닫기" : "오른쪽 패널 열기"} className="vault-right-toggle" onClick={toggleRightPanel} ref={rightPanelToggleRef} type="button"><PanelRight size={17} /></button> : null}
            </div>
          </div>

          <section aria-labelledby={group.activeTabId ?? undefined} className="vault-editor-pane" id={tabPanelId} role="tabpanel">
            {!groupIsActive ? (
              <InactiveWorkspacePane
                documentKey={`${groupActiveNote?.id ?? "empty"}:${group.id}`}
                draft={groupActiveDraft}
                groupLabel={groupLabel}
                note={groupActiveNote}
                onActivate={() => activateTabInGroup(group.id)}
                onChange={(body) => {
                  if (groupActiveEntryId) updateEntryDraft(groupActiveEntryId, { body });
                }}
                onPasteImages={groupActiveEntryId
                  ? (files, context) => pasteImagesIntoMarkdownEntry(groupActiveEntryId, files, context)
                  : undefined}
                onSave={() => {
                  if (groupActiveEntryId) void saveEntry(groupActiveEntryId);
                }}
                readOnly={
                  !groupActiveNote
                  || deletingEntryIds.has(groupActiveNote.id)
                  || pathRewriteContentLocked
                  || entryCreationContentLocked
                  || conflictedEntryIds.has(groupActiveNote.id)
                }
                tab={groupActiveTab}
              />
            ) : activeTab?.kind === "global-graph" ? (
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
                  onViewportChange={queueGlobalGraphViewport}
                  settings={globalGraphSettings}
                />
              </Suspense>
            ) : activeNote && activeDraft ? (
              <>
                <header className="vault-note-header">
                  <div className="vault-breadcrumb">{entryPaths.get(activeNote.id)}</div>
                  <input
                    aria-label="노트 이름"
                    disabled={
                      activeNote.contentFormat === "legacy-html-v1"
                      || activeNote.ownerUid !== profile.uid
                      || deletingEntryIds.has(activeNote.id)
                      || pathRewriteBusy
                      || entryCreationContentLocked
                    }
                    onChange={(event) => updateActiveDraft({ title: event.currentTarget.value })}
                    value={activeDraft.title}
                  />
                  <div className="vault-note-actions">
                    {activeNote.contentFormat === "markdown-v1" ? (["source", "live-preview", "reading"] as const).map((mode) => (
                      <button
                        aria-label={mode === "source" ? "소스 모드" : mode === "live-preview" ? "라이브 프리뷰" : "읽기 보기"}
                        aria-pressed={viewMode === mode}
                        key={mode}
                        onClick={() => setViewMode(mode)}
                        type="button"
                      >
                        {mode === "source" ? "소스" : mode === "live-preview" ? "라이브" : "읽기"}
                      </button>
                    )) : null}
                    {activeNote.contentFormat === "markdown-v1" ? (
                      <select ref={markdownCopySelectRef} aria-label="Markdown 복사 형식" defaultValue="" onChange={(event) => {
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
                    {activeMarkdownMayContainConvertibleHtml ? (
                      <button
                        disabled={entryCreationContentLocked || pathRewriteBusy}
                        onClick={() => void createNormalizedMarkdownCopy()}
                        type="button"
                      >HTML → Markdown 복사</button>
                    ) : null}
                    {activeNote.ownerUid === profile.uid
                      && (activeNote.entryKind === "markdown" || activeNote.entryKind === "legacy-html") ? (
                      <button
                        aria-label="노트 공유"
                        disabled={
                          deletingEntryIds.has(activeNote.id)
                          || conflictedEntryIds.has(activeNote.id)
                          || !isOnline
                          || pathRewriteBusy
                          || entryCreationContentLocked
                        }
                        onClick={(event) => void openVaultShareManager(activeNote.id, event.currentTarget)}
                        title="보안 링크와 QuickMemo 사용자 공유"
                        type="button"
                      ><Share2 aria-hidden="true" size={16} /></button>
                    ) : null}
                    <button
                      aria-label="저장"
                      disabled={
                        !activeDraft.dirty
                        || savingEntryIds.has(activeNote.id)
                        || conflictedEntryIds.has(activeNote.id)
                        || !isOnline
                        || (!vaultNameWritesReady && !activeCanResolveNameCollision)
                        || entryCreationContentLocked
                      }
                      onClick={() => void saveEntry(activeNote.id)}
                      title={!isOnline ? "온라인 연결 후 저장할 수 있습니다." : conflictedEntryIds.has(activeNote.id) ? "먼저 저장 충돌을 해결해주세요." : "저장"}
                      type="button"
                    ><Save size={16} /></button>
                  </div>
                </header>
                {conflictedEntryIds.has(activeNote.id) ? (
                  <aside className="vault-save-conflict" role="alert">
                    <div>
                      <strong>저장 충돌</strong>
                      <p>서버 최신본을 직접 확인합니다. 선택하거나 확인하기 전에는 어느 쪽도 덮어쓰지 않습니다.</p>
                    </div>
                    <div>
                      {isMarkdownMergeEntry(activeNote) ? (
                        <button
                          disabled={!isOnline || draftMergeBusyEntryId === activeNote.id}
                          onClick={(event) => void openDraftMergeResolver(activeNote.id, event.currentTarget)}
                          type="button"
                        >{draftMergeBusyEntryId === activeNote.id ? "서버 최신본 확인 중…" : "안전 병합"}</button>
                      ) : null}
                      <button disabled={draftMergeBusyEntryId === activeNote.id} onClick={() => void preserveConflictedEntry(activeNote.id)} type="button">현재 편집본을 복사</button>
                      <button disabled={!isOnline || draftMergeBusyEntryId === activeNote.id} onClick={() => void reloadConflictedEntry(activeNote.id)} type="button">서버 버전으로 되돌리기</button>
                    </div>
                  </aside>
                ) : null}
                <div className="vault-note-content">
                  {activeNote.entryKind === "canvas" ? (
                    <Suspense fallback={<VaultViewLoading label="Canvas" />}>
                      <LazyVaultJsonCanvasPane
                        decodedAssetForEntry={decodedAssetForEntry}
                        entryPaths={entryPaths}
                        getDraftBody={draftBodyForCanvasEntry}
                        key={activeNote.id}
                        markdownDraftRevision={markdownDraftRevisionRef.current}
                        notes={notes}
                        onChange={(body) => updateActiveDraft({ body })}
                        onImportExternalFiles={importCanvasExternalFiles}
                        onOpenFile={(path) => {
                          const entry = indexEntries.find((candidate) => candidate.path === path);
                          if (entry) openEntry(entry.id);
                        }}
                        readOnly={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
                        source={activeDraft.body}
                      />
                    </Suspense>
                  ) : activeNote.entryKind === "asset" ? (
                    decodedAssetForEntry(activeNote.id) ? (
                      <VaultAssetPreview
                        asset={decodedAssetForEntry(activeNote.id)!}
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
                          onEditProperty={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked ? undefined : editBaseProperty}
                          onOpenEntry={(entryId) => openEntry(entryId)}
                          readOnlyEntryIds={deletingEntryIds}
                          source={activeDraft.body}
                        />
                      </Suspense>
                      <details>
                        <summary>Base YAML 편집</summary>
                        <VaultMarkdownEditor
                          documentKey={activeNote.id}
                          onChange={(body) => updateActiveDraft({ body })}
                          onSave={() => void saveEntry(activeNote.id)}
                          readOnly={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
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
                  ) : (
                    <>
                      <Suspense fallback={<div aria-label="노트 첨부파일" className="vault-note-attachments-inline" role="status">파일 목록 준비 중</div>}>
                        <LazyVaultNoteAttachmentsRegion
                          disabled={
                            deletingEntryIds.has(activeNote.id)
                            || conflictedEntryIds.has(activeNote.id)
                            || !isOnline
                            || pathRewriteBusy
                            || entryCreationContentLocked
                          }
                          key={activeNote.id}
                          note={activeNote}
                          onOpenLibrary={() => void navigateAfterSaving(`/library?sourceNoteId=${encodeURIComponent(activeNote.id)}`)}
                          privateKey={privateKey}
                          profile={profile}
                        />
                      </Suspense>
                      {activeMarkdownPluginView && viewMode !== "source" ? (
                        <Suspense fallback={<VaultViewLoading label={activeMarkdownPluginView === "drawing" ? "Drawing" : "Kanban"} />}>
                          {activeMarkdownPluginView === "drawing" ? (
                            <LazyDrawingView
                              onChange={(body) => updateActiveDraft({ body })}
                              readOnly={viewMode === "reading" || deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
                              source={activeDraft.body}
                            />
                          ) : (
                            <LazyKanbanBoard
                              onChange={(body) => updateActiveDraft({ body })}
                              onOpenLink={openKanbanLink}
                              readOnly={viewMode === "reading" || deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
                              source={activeDraft.body}
                            />
                          )}
                        </Suspense>
                      ) : viewMode === "reading" ? (
                        <MarkdownRenderer
                          className="vault-markdown-renderer"
                          onLinkClick={handleMarkdownLink}
                          onLinkPreviewInteraction={handleMarkdownLinkPreviewInteraction}
                          onTagClick={handleMarkdownTagClick}
                          renderCodeBlock={renderMarkdownCodeBlock}
                          renderEmbed={renderMarkdownEmbed}
                          source={activeDraft.body}
                        />
                      ) : viewMode === "live-preview" ? (
                        <VaultMarkdownEditor
                          completionData={markdownCompletionData}
                          documentKey={activeNote.id}
                          insertRequest={editorInsertRequest?.entryId === activeNote.id ? editorInsertRequest : null}
                          livePreview
                          onChange={(body) => updateActiveDraft({ body })}
                          onInsertHandled={(id) => setEditorInsertRequest((current) => current?.id === id ? null : current)}
                          onLinkClick={handleMarkdownLink}
                          onLinkPreviewInteraction={handleMarkdownLinkPreviewInteraction}
                          onPasteImages={pasteImagesIntoActiveMarkdown}
                          onTagClick={handleMarkdownTagClick}
                          onRevealHandled={(id) => setEditorRevealRequest((current) => current?.id === id ? null : current)}
                          onSave={() => void saveEntry(activeNote.id)}
                          onSelectionChange={setEditorSelection}
                          readOnly={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
                          renderCodeBlock={renderMarkdownCodeBlock}
                          renderEmbed={renderMarkdownEmbed}
                          revealRequest={editorRevealRequest?.entryId === activeNote.id ? editorRevealRequest : null}
                          value={activeDraft.body}
                          valueRevision={activeDraft.baseRevision}
                        />
                      ) : (
                        <VaultMarkdownEditor
                          autoFocus
                          completionData={markdownCompletionData}
                          documentKey={activeNote.id}
                          insertRequest={editorInsertRequest?.entryId === activeNote.id ? editorInsertRequest : null}
                          onChange={(body) => updateActiveDraft({ body })}
                          onInsertHandled={(id) => setEditorInsertRequest((current) => current?.id === id ? null : current)}
                          onPasteImages={pasteImagesIntoActiveMarkdown}
                          onRevealHandled={(id) => setEditorRevealRequest((current) => current?.id === id ? null : current)}
                          onSave={() => void saveEntry(activeNote.id)}
                          onSelectionChange={setEditorSelection}
                          readOnly={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
                          revealRequest={editorRevealRequest?.entryId === activeNote.id ? editorRevealRequest : null}
                          value={activeDraft.body}
                          valueRevision={activeDraft.baseRevision}
                        />
                      )}
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="vault-empty-state">
                <BookOpen size={34} />
                <h2>새로운 지식의 점을 만드세요</h2>
                <p>Markdown 노트를 만들고 <code>[[링크]]</code>와 <code>#태그</code>로 연결할 수 있습니다.</p>
                <button disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked} onClick={() => void createEntry("markdown")} type="button">새 노트</button>
              </div>
            )}
          </section>
                </div>
              ) };
            })}
          />
          <footer className="vault-status-bar">
            <span aria-live="polite" role={error ? "alert" : "status"}>{error ?? status}</span>
            {fallbackRegexUnavailable ? (
              <span aria-live="polite" className="vault-regex-unavailable" role="status">
                현재 안전 모드에서는 정규식 검색·그래프 필터를 실행하지 않습니다.
              </span>
            ) : null}
            <span aria-live="polite" className="vault-save-state">{activeSaveStatus}</span>
            <span className="vault-document-stats">{activeDraft ? `${activeDocumentStats.words}단어 · ${activeDocumentStats.characters}자` : ""}</span>
            <span className="vault-link-stats">{activeEntryId ? `백링크 ${backlinks.length} · 나가는 링크 ${outgoing.length}` : `${globalSnapshot.nodes.length} nodes`}</span>
          </footer>
        </main>

        {rightOpen ? (
          <aside
            aria-label="연결 정보"
            aria-modal={mobileLayout ? true : undefined}
            className="vault-right-panel"
            id="vault-right-panel"
            ref={rightPanelRef}
            role={mobileLayout ? "dialog" : undefined}
            tabIndex={mobileLayout ? -1 : undefined}
          >
            {!mobileLayout ? (
              <div
                aria-controls="vault-right-panel"
                aria-label="오른쪽 패널 너비 조절"
                aria-orientation="vertical"
                aria-valuemax={rightPanelMaxWidth}
                aria-valuemin={MIN_VAULT_RIGHT_PANEL_WIDTH}
                aria-valuenow={effectiveRightPanelWidth}
                aria-valuetext={`${effectiveRightPanelWidth}px`}
                className="vault-right-panel-resizer"
                onKeyDown={handleRightPanelResizeKeyDown}
                onLostPointerCapture={finishRightPanelResize}
                onPointerCancel={finishRightPanelResize}
                onPointerDown={beginRightPanelResize}
                onPointerMove={moveRightPanelResize}
                onPointerUp={finishRightPanelResize}
                role="separator"
                tabIndex={0}
                title="드래그하거나 좌우 방향키로 너비 조절"
              />
            ) : null}
            <header>
              <div aria-label="연결 정보 보기" onKeyDown={handleRovingTabListKeyDown} role="tablist">
                {RIGHT_PANEL_TABS.map(({ icon: Icon, label, mode }) => (
                  <button
                    aria-label={label}
                    aria-selected={rightMode === mode}
                    key={mode}
                    onClick={() => setRightMode(mode)}
                    role="tab"
                    tabIndex={rightMode === mode ? 0 : -1}
                    title={label}
                    type="button"
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
              <button aria-label="오른쪽 패널 닫기" onClick={closeRightPanel} type="button"><X size={15} /></button>
            </header>
            <div aria-live="polite" className="vault-right-panel-current-mode" role="status">
              {RIGHT_PANEL_TABS.find(({ mode }) => mode === rightMode)?.label}
            </div>
            {rightMode === "backlinks" ? (
              <Suspense fallback={<VaultViewLoading label="백링크" />}>
                <LazyLinkOccurrencePanel
                  direction="backlinks"
                  emptyLabel="연결된 백링크가 없습니다."
                  entries={indexEntries}
                  key="backlinks"
                  occurrences={backlinks}
                  unlinkedMentions={unlinkedMentions}
                  onCreateUnlinkedLink={createUnlinkedMentionLink}
                  onOpenEntry={openEntry}
                />
              </Suspense>
            ) : rightMode === "outgoing" ? (
              <Suspense fallback={<VaultViewLoading label="나가는 링크" />}>
                <LazyLinkOccurrencePanel
                  direction="outgoing"
                  emptyLabel="나가는 링크가 없습니다."
                  entries={indexEntries}
                  key="outgoing"
                  occurrences={outgoing}
                  onOpenEntry={openEntry}
                />
              </Suspense>
            ) : rightMode === "outline" ? (
              <Suspense fallback={<VaultViewLoading label="목차" />}>
                <LazyVaultOutline headings={activeMetadata?.headings ?? []} onNavigate={revealOutlineHeading} />
              </Suspense>
            ) : rightMode === "properties" ? (
              <Suspense fallback={<VaultViewLoading label="속성" />}>
                <LazyVaultPropertiesEditor
                  disabled={!activeNote || activeNote.contentFormat !== "markdown-v1"}
                  onChange={(body) => { setError(null); updateActiveDraft({ body }); }}
                  onError={setError}
                  properties={activeMetadata?.properties ?? EMPTY_FRONTMATTER_PROPERTIES}
                  source={activeDraft?.body ?? ""}
                />
              </Suspense>
            ) : rightMode === "local-graph" ? (
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
                    onViewportChange={queueLocalGraphViewport}
                    settings={localGraphSettings}
                  />
                </Suspense>
              </div>
            ) : activeNote ? (
              <Suspense fallback={<VaultViewLoading label="File Recovery" />}>
                <LazyVaultHistoryPanel
                  key={activeNote.id}
                  note={activeNote}
                  onRestore={(snapshot) => restoreHistorySnapshot(activeNote.id, snapshot)}
                  privateKey={privateKey}
                  readOnly={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}
                  uid={profile.uid}
                />
              </Suspense>
            ) : (
              <p className="vault-panel-empty">File Recovery에서 확인할 항목을 먼저 여세요.</p>
            )}
          </aside>
        ) : null}
        {pagePreview ? (
          <aside
            aria-label={`${pagePreview.title} 페이지 미리보기`}
            aria-live="polite"
            className="vault-page-preview"
            data-placement={pagePreview.placement}
            role="tooltip"
            style={{
              left: pagePreview.left,
              top: pagePreview.top,
              transform: pagePreview.placement === "above" ? "translateY(-100%)" : undefined,
              width: pagePreview.width
            }}
          >
            <strong>{pagePreview.title}</strong>
            {pagePreview.path ? <small>{pagePreview.path}</small> : null}
            <p>{pagePreview.body || "내용 없음"}</p>
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
                top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - (contextMenuCanShare ? 190 : 150)))
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
              {contextMenuCanShare ? (
                <button onClick={() => {
                  const target = contextMenu;
                  closeContextMenu(false);
                  void openVaultShareManager(target.targetId, target.returnFocusElement);
                }} role="menuitem" type="button">
                  <Share2 aria-hidden="true" size={14} /> 공유…
                </button>
              ) : null}
              {contextMenu.targetKind === "entry" ? (
                <button className="danger" onClick={() => {
                  const target = contextMenu;
                  closeContextMenu();
                  void moveEntryToTrash(target.targetId);
                }} role="menuitem" type="button">
                  <Trash2 size={14} /> 휴지통으로 이동
                </button>
              ) : (
                <button className="danger" onClick={() => {
                  const target = contextMenu;
                  closeContextMenu();
                  void moveFolderToTrash(target.targetId);
                }} role="menuitem" type="button">
                  <Trash2 size={14} /> 하위 트리 휴지통
                </button>
              )}
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
        {shareTarget ? (
          <Suspense fallback={<VaultViewLoading label="노트 공유" />}>
            <LazyVaultShareManagerDialog
              getIdToken={getIdToken}
              hasUnsharedAssetEmbeds={shareTarget.hasUnsharedAssetEmbeds === true}
              note={shareTarget.note}
              onClose={() => setShareTarget(null)}
              onRequestParticipantSharing={() => {
                setParticipantShareTarget({
                  ...shareTarget,
                  hasUnsharedAssetEmbeds: shareTarget.hasUnsharedAssetEmbeds === true
                });
                setShareTarget(null);
              }}
              privateKey={privateKey}
              profile={profile}
              returnFocusTo={shareTarget.returnFocusTo}
            />
          </Suspense>
        ) : null}
        {participantShareTarget ? (
          <Suspense fallback={<VaultViewLoading label="사용자 공유" />}>
            <LazyVaultParticipantShareDialog
              hasUnsharedAssetEmbeds={participantShareTarget.hasUnsharedAssetEmbeds === true}
              note={participantShareTarget.note}
              onClose={() => setParticipantShareTarget(null)}
              onUpdated={(result) => {
                const entryId = participantShareTarget.note.id;
                commitNotes((current) => current.map((candidate) => candidate.id === entryId
                  ? {
                      ...candidate,
                      folderId: result.folderId,
                      participantUids: result.participantUids,
                      revision: result.revision,
                      type: result.type,
                      wrappedKeys: result.wrappedKeys
                    }
                  : candidate));
                const currentDraft = draftsRef.current[entryId];
                if (currentDraft) {
                  const nextDrafts = {
                    ...draftsRef.current,
                    [entryId]: { ...currentDraft, baseRevision: result.revision }
                  };
                  draftsRef.current = nextDrafts;
                  setDrafts(nextDrafts);
                }
                const currentBase = draftBaseSnapshotsRef.current.get(entryId);
                if (currentBase) {
                  draftBaseSnapshotsRef.current.set(entryId, {
                    ...currentBase,
                    baseRevision: result.revision,
                    folderId: result.folderId
                  });
                }
                setStatus(result.type === "shared"
                  ? `QuickMemo 사용자 ${Math.max(0, result.participantUids.length - 1)}명과 암호화 공유했습니다.`
                  : "QuickMemo 사용자 공유를 해제했습니다.");
              }}
              privateKey={privateKey}
              profile={profile}
              returnFocusTo={participantShareTarget.returnFocusTo}
              users={users}
            />
          </Suspense>
        ) : null}
        {compactCalendarLayout && compactCalendarOpen ? (
          <section aria-label="Daily Notes 달력" aria-modal="true" className="vault-calendar-mobile-dialog" ref={compactCalendarDialogRef} role="dialog">
            <header>
              <strong><CalendarDays size={16} /> Daily Notes</strong>
              <button aria-label="Daily Notes 달력 닫기" autoFocus onClick={() => setCompactCalendarOpen(false)} type="button"><X size={17} /></button>
            </header>
            <Suspense fallback={<VaultViewLoading label="Daily Notes" />}>
              <LazyDailyNotesCalendar
                createDisabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked}
                cursorMonth={calendarCursorMonth}
                monthNoteKeys={periodicNoteKeys.months}
                noteDates={dailyNoteDates}
                onCursorMonthChange={setCalendarCursorMonth}
                onOpenDate={(dateKey) => {
                  setCompactCalendarOpen(false);
                  openDailyNoteForDate(dateKey);
                }}
                onOpenMonth={(monthKey) => {
                  setCompactCalendarOpen(false);
                  openMonthlyNote(monthKey);
                }}
                onOpenWeek={(weekKey) => {
                  setCompactCalendarOpen(false);
                  openWeeklyNote(weekKey);
                }}
                weekNoteKeys={periodicNoteKeys.weeks}
              />
              <LazyDailyNotesSettings
                folderId={dailyNotesFolderId}
                folderOptions={dailyFolderOptions}
                onFolderChange={setDailyNotesFolderId}
                onTemplatesFolderChange={setTemplatesFolderPath}
                onTemplatesIncludeDescendantsChange={setTemplatesIncludeDescendants}
                onTemplateChange={setDailyNotesTemplateEntryId}
                templateEntryId={dailyNotesTemplateEntryId}
                templateOptions={dailyTemplateOptions}
                templatesFolderPath={templatesFolderPath}
                templatesIncludeDescendants={templatesIncludeDescendants}
              />
            </Suspense>
          </section>
        ) : null}
      </div>
      {commandPaletteOpen ? (
        <FeatureErrorBoundary fallback={(
          <div className="vault-dialog-loading" role="alert">
            명령 팔레트를 불러오지 못했습니다.
            <button onClick={() => setCommandPaletteOpen(false)} type="button">닫기</button>
          </div>
        )}>
          <Suspense fallback={<div aria-live="polite" className="vault-dialog-loading" role="status">명령 팔레트 불러오는 중…</div>}>
            <LazyCommandPalette
              commands={commandPaletteCommands}
              includeVaultCommands
              onExecute={(command) => handleCommand(command)}
              onOpenChange={setCommandPaletteOpen}
              open
            />
          </Suspense>
        </FeatureErrorBoundary>
      ) : null}
      {quickSwitcherOpen ? (
        <FeatureErrorBoundary fallback={(
          <div className="vault-dialog-loading" role="alert">
            퀵 스위처를 불러오지 못했습니다.
            <button onClick={() => setQuickSwitcherOpen(false)} type="button">닫기</button>
          </div>
        )}>
          <Suspense fallback={<div aria-live="polite" className="vault-dialog-loading" role="status">퀵 스위처 불러오는 중…</div>}>
            <LazyQuickSwitcher
              entries={quickSwitcherEntries}
              onOpen={handleQuickSwitcherOpen}
              onOpenChange={setQuickSwitcherOpen}
              open
            />
          </Suspense>
        </FeatureErrorBoundary>
      ) : null}
      {trashOpen ? (
        <Suspense fallback={<div aria-live="polite" className="vault-dialog-loading" role="status">휴지통 불러오는 중…</div>}>
          <LazyVaultTrashDialog
            busyEntryIds={trashBusyEntryIds}
            busyFolderIds={trashBusyFolderIds}
            folders={trashFolders}
            loading={trashLoading}
            notes={trashNotes}
            onClose={() => setTrashOpen(false)}
            onRestore={(entryId) => void restoreTrashEntry(entryId)}
            onRestoreFolder={(folderId) => void restoreTrashFolder(folderId)}
            returnFocusTo={trashButtonRef.current}
            serverReady={trashServerReady}
          />
        </Suspense>
      ) : null}
      {discordMessageBatch ? (
        <FeatureErrorBoundary fallback={(
          <div className="vault-dialog-loading" role="alert">
            메시지 나누기 도구를 불러오지 못했습니다. 편집 내용은 유지됩니다.
            <button onClick={() => setDiscordMessageBatch(null)} type="button">닫기</button>
          </div>
        )}>
          <Suspense fallback={<div aria-live="polite" className="vault-dialog-loading" role="status">메시지 나누기 도구 불러오는 중…</div>}>
            <LazyMarkdownMessageBatchDialog
              delivery={discordMessageBatch}
              onClose={() => setDiscordMessageBatch(null)}
              returnFocusTo={markdownCopySelectRef.current}
            />
          </Suspense>
        </FeatureErrorBoundary>
      ) : null}
      {templateDialogMode ? (
        <Suspense fallback={<div aria-live="polite" className="vault-dialog-loading" role="status">템플릿 도구 불러오는 중…</div>}>
          <LazyTemplatePickerDialog
            candidates={availableTemplates}
            confirmDisabled={templateDialogMode === "create" && (!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked)}
            confirmDisabledReason={templateDialogMode === "create" && (!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked)
              ? "암호화된 이름 예약 확인이 끝나면 새 노트를 만들 수 있습니다."
              : undefined}
            currentPath={templateDialogMode === "insert" && activeNote
              ? entryPaths.get(activeNote.id) ?? ""
              : selectedFolderId ? folderPaths.get(selectedFolderId) ?? "" : ""}
            currentTitle={activeDraft?.title ?? ""}
            currentSelection={templateDialogMode === "insert" && activeDraft && editorSelection
              ? activeDraft.body.slice(editorSelection.start, editorSelection.end)
              : undefined}
            mode={templateDialogMode}
            onCancel={() => setTemplateDialogMode(null)}
            onConfirm={applyTemplate}
          />
        </Suspense>
      ) : null}
      {draftMergeOpen && draftMergeConflict ? (
        <Suspense fallback={(
          <div className="vault-core-dialog-backdrop">
            <p aria-live="polite" className="vault-dialog-loading" role="status">안전 병합 도구 불러오는 중…</p>
          </div>
        )}>
          <LazyVaultDraftConflictResolver
            baseMarkdown={draftMergeConflict.base.body}
            busy={draftMergeBusyEntryId === draftMergeConflict.entryId}
            localMarkdown={draftMergeConflict.local.body}
            onCancel={() => closeDraftMergeResolver()}
            onResolve={(mergedMarkdown) => applyDraftMergeResolution(mergedMarkdown)}
            remoteMarkdown={draftMergeConflict.remote.body}
          />
        </Suspense>
      ) : null}
      {activeCoreTool ? (
        <div
          className="vault-core-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setActiveCoreTool(null);
          }}
          role="presentation"
        >
          <section
            aria-label="Vault Core 도구"
            aria-modal="true"
            className={`vault-core-dialog vault-core-dialog--${activeCoreTool}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setActiveCoreTool(null);
                return;
              }
              if (event.key === "Tab") {
                const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(MOBILE_DRAWER_FOCUSABLE)]
                  .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }}
            role="dialog"
          >
            <div className="vault-core-dialog__toolbar">
              <span>Core 도구</span>
              <button aria-label="Core 도구 닫기" autoFocus onClick={() => setActiveCoreTool(null)} type="button">
                <X aria-hidden="true" size={17} />
              </button>
            </div>
            <Suspense fallback={<VaultViewLoading label="Core 도구" />}>
              {activeCoreTool === "audio" ? (
                <LazyVaultAudioRecorder
                  disabled={!vaultNameWritesReady || pathRewriteBusy || entryCreationContentLocked}
                  onCapture={saveRecordedAudio}
                />
              ) : activeCoreTool === "footnotes" && activeNote?.contentFormat === "markdown-v1" && activeDraft ? (
                <LazyVaultFootnotesView
                  onNavigate={(footnote) => {
                    if (footnote.definitionLine === null) return;
                    setViewMode("live-preview");
                    setEditorRevealRequest({
                      entryId: activeNote.id,
                      id: Date.now(),
                      line: footnote.definitionLine
                    });
                    setActiveCoreTool(null);
                  }}
                  source={activeDraft.body}
                />
              ) : activeCoreTool === "format" && activeNote?.contentFormat === "legacy-html-v1" ? (
                <LazyVaultFormatConverter
                  onCreateMarkdownCopy={createConvertedMarkdownCopy}
                  source={{
                    body: activeNote.body,
                    contentFormat: "legacy-html-v1",
                    folderId: activeNote.folderId ?? null,
                    id: activeNote.id,
                    revision: activeNote.revision ?? 0,
                    title: activeNote.title
                  }}
                />
              ) : activeCoreTool === "composer" && activeComposerEntry ? (
                <LazyVaultNoteComposer
                  activeEntry={activeComposerEntry}
                  adapter={noteComposerAdapter}
                  mergeCandidates={composerEntries}
                  onComplete={(entryId) => {
                    setActiveCoreTool(null);
                    window.setTimeout(() => openEntry(entryId), 0);
                  }}
                  selection={editorSelection}
                />
              ) : activeCoreTool === "slides" && activeNote?.contentFormat === "markdown-v1" && activeDraft ? (
                <LazyVaultSlides
                  onClose={() => setActiveCoreTool(null)}
                  source={activeDraft.body}
                  title={activeDraft.title}
                />
              ) : activeCoreTool === "web" ? (
                <LazyVaultWebViewer />
              ) : (
                <p role="alert">현재 항목에서 이 Core 도구를 안전하게 열 수 없습니다.</p>
              )}
            </Suspense>
          </section>
        </div>
      ) : null}
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
  const profileUid = profile?.uid;
  const getIdToken = useCallback(async () => {
    if (!firebaseUser || !profileUid || firebaseUser.uid !== profileUid) {
      throw new Error("로그인 권한을 확인할 수 없습니다.");
    }
    return firebaseUser.getIdToken();
  }, [firebaseUser, profileUid]);

  if (!profile || !firebaseUser || firebaseUser.uid !== profile.uid) {
    return null;
  }
  if (!privateKey) {
    return <AppShell variant="vault"><UnlockPanel /></AppShell>;
  }
  return <UnlockedVaultPage getIdToken={getIdToken} privateKey={privateKey} profile={profile} />;
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

export function VaultFileTree({
  expandedFolderIds,
  folders,
  mutationDisabled,
  notes,
  onBulkMove,
  onBulkTrash,
  onContextEntry,
  onContextFolder,
  onDropEntry,
  onDropFolder,
  onOpenEntry,
  onRenameTarget,
  onSelectFolder,
  onToggleFolder,
  selectedFolderId
}: {
  expandedFolderIds: ReadonlySet<string>;
  folders: readonly DecryptedVaultFolder[];
  mutationDisabled: boolean;
  notes: readonly DecryptedVaultNote[];
  onBulkMove: (targets: readonly VaultTreeTarget[], folderId: string | null) => Promise<boolean | void>;
  onBulkTrash: (targets: readonly VaultTreeTarget[]) => Promise<boolean | void>;
  onContextEntry: (entryId: string, x: number, y: number, trigger: HTMLButtonElement) => void;
  onContextFolder: (folderId: string, x: number, y: number, trigger: HTMLButtonElement) => void;
  onDropEntry: (entryId: string, folderId: string | null) => Promise<void>;
  onDropFolder: (folderId: string, parentId: string | null) => Promise<void>;
  onOpenEntry: (entryId: string, intent?: GraphOpenIntent) => void;
  onRenameTarget: (target: VaultTreeTarget) => Promise<void>;
  onSelectFolder: (folderId: string | null) => void;
  onToggleFolder: (folderId: string) => void;
  selectedFolderId: string | null;
}) {
  const [actionBusy, setActionBusy] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveReturnFocusTo, setBulkMoveReturnFocusTo] = useState<HTMLButtonElement | null>(null);
  const [selection, setSelection] = useState<VaultTreeSelectionState>(createVaultTreeSelectionState);
  const [selectionMode, setSelectionMode] = useState(false);
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
  const orderedTargets = useMemo(() => {
    const all: VaultTreeTarget[] = [];
    const visible: VaultTreeTarget[] = [];
    const visitedFolders = new Set<string>();
    const visit = (parentId: string | null, ancestorsVisible: boolean) => {
      for (const folder of childFoldersByParent.get(parentId) ?? []) {
        if (visitedFolders.has(folder.id)) continue;
        visitedFolders.add(folder.id);
        const target: VaultTreeTarget = {
          id: folder.id,
          key: vaultTreeTargetKey("folder", folder.id),
          kind: "folder",
          parentFolderId: folder.parentId ?? null
        };
        all.push(target);
        if (ancestorsVisible) visible.push(target);
        visit(folder.id, ancestorsVisible && expandedFolderIds.has(folder.id));
      }
      for (const note of childNotesByParent.get(parentId) ?? []) {
        const target: VaultTreeTarget = {
          id: note.id,
          key: vaultTreeTargetKey("entry", note.id),
          kind: "entry",
          parentFolderId: note.folderId ?? null
        };
        all.push(target);
        if (ancestorsVisible) visible.push(target);
      }
    };
    visit(null, true);
    return { all, visible };
  }, [childFoldersByParent, childNotesByParent, expandedFolderIds]);
  const availableTargetKeys = useMemo(
    () => new Set(orderedTargets.all.map((target) => target.key)),
    [orderedTargets]
  );
  const visibleTargetKeys = useMemo(
    () => orderedTargets.visible.map((target) => target.key),
    [orderedTargets]
  );
  const selectedTargets = useMemo(
    () => orderedTargets.all.filter((target) => selection.selectedKeys.has(target.key)),
    [orderedTargets, selection.selectedKeys]
  );
  const folderParentById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.parentId ?? null] as const)),
    [folders]
  );
  const canonicalSelectedTargets = useMemo(
    () => canonicalVaultTreeBulkTargets(selectedTargets, folderParentById),
    [folderParentById, selectedTargets]
  );
  const bulkMoveDestinations = useMemo((): VaultMoveDestination[] => {
    const selectedFolderIds = new Set(canonicalSelectedTargets
      .filter((target) => target.kind === "folder")
      .map((target) => target.id));
    const folderById = new Map(folders.map((folder) => [folder.id, folder] as const));
    const folderPath = (folder: DecryptedVaultFolder) => {
      const segments = [folder.displayName];
      const visited = new Set([folder.id]);
      let parentId = folder.parentId ?? null;
      while (parentId && !visited.has(parentId) && segments.length < 32) {
        visited.add(parentId);
        const parent = folderById.get(parentId);
        if (!parent) break;
        segments.unshift(parent.displayName);
        parentId = parent.parentId ?? null;
      }
      return segments.join("/");
    };
    const destinationInsideSelection = (folderId: string) => {
      let cursor: string | null = folderId;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor)) {
        if (selectedFolderIds.has(cursor)) return true;
        visited.add(cursor);
        cursor = folderParentById.get(cursor) ?? null;
      }
      return false;
    };
    const allAlreadyAt = (folderId: string | null) => canonicalSelectedTargets.length > 0
      && canonicalSelectedTargets.every((target) => target.parentFolderId === folderId);
    return [
      { disabled: allAlreadyAt(null), folderId: null, label: "Vault 루트" },
      ...folders
        .map((folder) => ({ folder, path: folderPath(folder) }))
        .sort((left, right) => left.path.localeCompare(right.path, "ko"))
        .map(({ folder, path }) => ({
          disabled: allAlreadyAt(folder.id) || destinationInsideSelection(folder.id),
          folderId: folder.id,
          label: path
        }))
    ];
  }, [canonicalSelectedTargets, folderParentById, folders]);

  useEffect(() => {
    setSelection((current) => reconcileVaultTreeSelection(current, availableTargetKeys));
  }, [availableTargetKeys]);

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

  function activateTarget(event: MouseEvent<HTMLButtonElement>, target: VaultTreeTarget) {
    if (!selectionMode) return true;
    setSelection((current) => updateVaultTreeSelection(current, visibleTargetKeys, target.key, {
      range: event.shiftKey,
      toggle: event.metaKey || event.ctrlKey
    }));
    return false;
  }

  function selectContextTarget(target: VaultTreeTarget) {
    if (!selectionMode) return;
    setSelection((current) => current.selectedKeys.has(target.key)
      ? current
      : updateVaultTreeSelection(current, visibleTargetKeys, target.key, { range: false, toggle: false }));
  }

  function clearSelection() {
    setSelection(createVaultTreeSelectionState());
  }

  function toggleSelectionMode() {
    setBulkMoveOpen(false);
    if (selectionMode) clearSelection();
    setSelectionMode(!selectionMode);
  }

  async function runSelectionAction(action: () => Promise<boolean | void>, clearAfter = false) {
    if (actionBusy || mutationDisabled || !canonicalSelectedTargets.length) return;
    setActionBusy(true);
    try {
      const completed = await action();
      if (clearAfter && completed !== false) clearSelection();
    } finally {
      setActionBusy(false);
    }
  }

  async function applyBulkMove(folderId: string | null) {
    setBulkMoveOpen(false);
    await runSelectionAction(
      () => onBulkMove(canonicalSelectedTargets, folderId),
      true
    );
  }

  function confirmBulkTrash() {
    if (!canonicalSelectedTargets.length || actionBusy || mutationDisabled) return;
    const folderCount = canonicalSelectedTargets.filter((target) => target.kind === "folder").length;
    const entryCount = canonicalSelectedTargets.length - folderCount;
    if (!window.confirm(
      `선택한 폴더 ${folderCount}개와 항목 ${entryCount}개를 Vault 휴지통으로 이동할까요? 선택한 폴더의 하위 트리도 포함되며 휴지통에서 복원할 수 있습니다.`
    )) return;
    void runSelectionAction(() => onBulkTrash(canonicalSelectedTargets), true);
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
          const target: VaultTreeTarget = {
            id: folder.id,
            key: vaultTreeTargetKey("folder", folder.id),
            kind: "folder",
            parentFolderId: folder.parentId ?? null
          };
          const multiSelected = selection.selectedKeys.has(target.key);
          const rowSelected = selectionMode ? multiSelected : selectedFolderId === folder.id;
          return (
            <div key={folder.id} role="presentation">
              <button
                aria-expanded={expanded}
                aria-level={depth + 1}
                aria-selected={rowSelected}
                className={`vault-tree-row vault-folder-row ${rowSelected ? "selected" : ""}`}
                data-selection-key={target.key}
                draggable
                onClick={(event) => {
                  if (consumeLongPressClick()) return;
                  if (!activateTarget(event, target)) return;
                  onSelectFolder(folder.id);
                  onToggleFolder(folder.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  selectContextTarget(target);
                  onContextFolder(folder.id, event.clientX, event.clientY, event.currentTarget);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={(event) => event.dataTransfer.setData("application/x-quickmemo-folder", folder.id)}
                onDrop={(event) => handleDrop(event, folder.id)}
                onKeyDown={(event) => handleContextMenuKey(event, (x, y, trigger) => {
                  selectContextTarget(target);
                  onContextFolder(folder.id, x, y, trigger);
                })}
                onPointerCancel={cancelLongPress}
                onPointerDown={(event) => beginLongPress(event, (x, y, trigger) => {
                  selectContextTarget(target);
                  onContextFolder(folder.id, x, y, trigger);
                })}
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
        {childNotes.map((note) => {
          const target: VaultTreeTarget = {
            id: note.id,
            key: vaultTreeTargetKey("entry", note.id),
            kind: "entry",
            parentFolderId: note.folderId ?? null
          };
          const multiSelected = selection.selectedKeys.has(target.key);
          return (
            <button
              aria-level={depth + 1}
              aria-selected={selectionMode && multiSelected}
              className={`vault-tree-row vault-note-row ${selectionMode && multiSelected ? "selected" : ""}`}
              data-selection-key={target.key}
              draggable
              key={note.id}
              onClick={(event) => {
                if (consumeLongPressClick()) return;
                if (!activateTarget(event, target)) return;
                onOpenEntry(note.id, graphOpenIntentFromModifiers(event));
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                selectContextTarget(target);
                onContextEntry(note.id, event.clientX, event.clientY, event.currentTarget);
              }}
              onDragStart={(event) => {
                setJsonCanvasVaultEntryDragData(event.dataTransfer, note.id);
                event.dataTransfer.setData("application/x-quickmemo-entry", note.id);
                event.dataTransfer.effectAllowed = "copyMove";
              }}
              onKeyDown={(event) => handleContextMenuKey(event, (x, y, trigger) => {
                selectContextTarget(target);
                onContextEntry(note.id, x, y, trigger);
              })}
              onPointerCancel={cancelLongPress}
              onPointerDown={(event) => beginLongPress(event, (x, y, trigger) => {
                selectContextTarget(target);
                onContextEntry(note.id, x, y, trigger);
              })}
              onPointerMove={moveLongPress}
              onPointerUp={cancelLongPress}
              role="treeitem"
              style={{ paddingInlineStart: 26 + depth * 14 }}
              type="button"
            >
              {note.entryKind === "canvas" ? <GitFork size={13} /> : <FileCode2 size={13} />}
              <span>{entryLabel(note)}</span>
            </button>
          );
        })}
      </>
    );
  }

  return (
    <section aria-label="Vault 파일 선택" className="vault-file-tree-shell">
      <div className="vault-tree-selection-mode-toolbar">
        <button
          aria-pressed={selectionMode}
          onClick={toggleSelectionMode}
          type="button"
        ><ListTree aria-hidden="true" size={14} /> 다중 선택</button>
        <span aria-live="polite" className="sr-only">
          {selectionMode ? "다중 선택 모드입니다. Control 또는 Command 클릭으로 토글하고 Shift 클릭으로 범위를 선택합니다." : "일반 파일 열기 모드입니다."}
        </span>
      </div>
      {selectionMode && selectedTargets.length ? (
        <div aria-label="선택 항목 작업" className="vault-tree-selection-toolbar" role="toolbar">
          <strong aria-live="polite">{selectedTargets.length}개 선택</strong>
          <button
            aria-label="선택 항목 이름 변경"
            disabled={actionBusy || mutationDisabled || selectedTargets.length !== 1}
            onClick={() => void runSelectionAction(() => onRenameTarget(selectedTargets[0]))}
            type="button"
          ><Pencil size={14} /></button>
          <button
            aria-label="선택 항목 이동"
            disabled={actionBusy || mutationDisabled || !canonicalSelectedTargets.length}
            onClick={(event) => {
              setBulkMoveReturnFocusTo(event.currentTarget);
              setBulkMoveOpen(true);
            }}
            type="button"
          ><FolderInput size={14} /></button>
          <button
            aria-label="선택 항목 휴지통으로 이동"
            className="danger"
            disabled={actionBusy || mutationDisabled || !canonicalSelectedTargets.length}
            onClick={confirmBulkTrash}
            type="button"
          ><Trash2 size={14} /></button>
          <button aria-label="파일 선택 해제" disabled={actionBusy} onClick={clearSelection} type="button"><X size={14} /></button>
        </div>
      ) : null}
      {selectionMode && selection.limitReached ? (
        <p aria-live="polite" className="vault-tree-selection-limit" role="status">
          한 번에 최대 {MAXIMUM_VAULT_TREE_SELECTION}개까지 선택할 수 있습니다.
        </p>
      ) : null}
      <div
        aria-multiselectable={selectionMode ? "true" : undefined}
        className={`vault-file-tree ${!selectionMode && selectedFolderId === null ? "root-selected" : ""}`}
        onClick={(event) => {
          if (event.currentTarget !== event.target) return;
          if (selectionMode) clearSelection();
          else onSelectFolder(null);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => handleDrop(event, null)}
        role="tree"
      >
        {renderLevel(null, 0)}
      </div>
      {bulkMoveOpen ? (
        <VaultMoveDialog
          destinations={bulkMoveDestinations}
          label={`선택한 ${selectedTargets.length}개 항목`}
          onClose={() => setBulkMoveOpen(false)}
          onMove={applyBulkMove}
          returnFocusTo={bulkMoveReturnFocusTo}
        />
      ) : null}
    </section>
  );
}
