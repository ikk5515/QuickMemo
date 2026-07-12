import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowUpDown,
  Bold,
  Ban,
  CheckCircle2,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderOpen,
  Heading2,
  Heading3,
  History,
  LayoutGrid,
  ListChecks,
  List,
  ListOrdered,
  ListTodo,
  LockKeyhole,
  Loader2,
  PanelLeftOpen,
  PaintBucket,
  Paperclip,
  Palette,
  Pencil,
  Pilcrow,
  Quote,
  RotateCcw,
  Rows3,
  Save,
  Search,
  Share2,
  Star,
  Strikethrough,
  Table2,
  Trash2,
  Redo2,
  Undo2,
  Underline,
  Upload,
  UsersRound,
  X
} from "lucide-react";
import type { Editor as TipTapEditor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import { Timestamp } from "firebase/firestore";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  allowedAttachmentExtensions,
  attachmentDownloadName,
  attachmentExtension,
  attachmentValidationError,
  formatFileSize,
  maxAttachmentFileLabel,
  maxAttachmentPreviewBytes,
  maxAttachmentPreviewLabel,
  safeAttachmentBaseName,
  safePublicShareAttachmentMimeType
} from "../lib/attachments";
import {
  decryptAttachmentToBlob,
  decryptAttachmentToBytes,
  encryptAttachmentBlob,
  reencryptAttachmentBlob
} from "../lib/attachmentCrypto";
import {
  decryptText,
  derivePublicShareContentKey,
  encryptText,
  exportAesKeyBase64Url,
  generateNoteKey,
  hashPublicSharePassword,
  importAesKeyBase64Url,
  unwrapNoteKey,
  wrapNoteKey
} from "../lib/crypto";
import {
  imageHtml,
  linkifyEditorHtml,
  parseEditorContent,
  plainTextToEditorHtml,
  previewTextFromHtml,
  sanitizeEditorHtml,
  serializeEditorContent
} from "../lib/editorContent";
import {
  maxPdfPreviewCanvasPixels,
  maxPdfPreviewImagePixels,
  maxPdfPreviewPageCssWidth,
  maxPdfPreviewPages,
  maxPdfPreviewTotalCanvasPixels,
  pdfPreviewCanvasLayout
} from "../lib/pdfPreviewCanvas";
import {
  editorCellColors,
  editorImagePixelWidthBounds,
  editorLineHeightBounds,
  editorLineHeights,
  editorTableColumnPixelWidthBounds,
  editorTablePixelHeightBounds,
  editorTableRowPixelHeightBounds,
  editorTablePixelWidthBounds,
  editorTextSizeBounds,
  editorTextColors,
  editorTextSizes,
  richEditorExtensions
} from "../lib/richEditorExtensions";
import { selectionFromStoredRange, type StoredEditorSelectionRange } from "../lib/editorSelection";
import {
  extractHwpPreviewHtml,
  extractHwpxPreviewHtml,
  extractXlsxPreviewHtml,
  renderSafeDocxPreviewSrcDoc
} from "../lib/documentPreview";
import { safeRasterImageBytes } from "../lib/safeRasterImage";
import { publishActiveNote, subscribeActiveNote } from "../services/activeNotes";
import {
  confirmNoteRead,
  createRevisionedEncryptedNote,
  createNoteFolder,
  createNoteAttachment,
  deleteRevisionedNote,
  deleteNoteFolder,
  deleteNoteAttachment,
  getEncryptedNoteAttachmentSource,
  getNoteAttachments,
  getNoteRevisionState,
  markNoteRead,
  purgeNote,
  publishNoteCursor,
  restoreRevisionedNote,
  setNotePinned,
  subscribeNoteAttachments,
  subscribeDeletedNotes,
  subscribeNoteFolders,
  subscribeMyNoteStates,
  subscribeNoteHistory,
  subscribeNoteUserStates,
  subscribeVisibleNotes,
  updateRevisionedEncryptedNote,
  updateRevisionedNoteAccess,
  updateNoteFolder,
  NoteRevisionConflictError,
  type NoteHistorySnapshot,
  type NoteAttachmentSnapshot,
  type NoteFolderSnapshot,
  type NoteUserStateSnapshot,
  type NoteSnapshot
} from "../services/notes";
import {
  activatePublicNoteShare,
  createPublicShareGeneration,
  createPublicNoteShare,
  createPublicNoteShareAttachment,
  deleteExpiredPublicSharesForOwner,
  deletePublicNoteShare,
  deletePublicNoteShareAttachments,
  getOwnerPublicNoteShareAttachments,
  publicShareActive,
  publicShareExpiresAt,
  publicNoteShareMaxAttachmentCount,
  publicShareUrl,
  revokePublicNoteShare,
  subscribePublicSharesForOwner,
  updatePublicNoteShareContent,
  type PublicNoteShareSnapshot
} from "../services/publicShares";
import { subscribeUsers } from "../services/users";
import type { ActiveNoteDocument, DecryptedNote, NoteKind, UserProfile } from "../types";

interface EditorState {
  noteId: string | null;
  baseRevision: number;
  title: string;
  body: string;
  type: NoteKind;
  participantUids: string[];
  noteKey: CryptoKey | null;
  folderId: string | null;
  fontSize: number;
  dirty: boolean;
}

interface NoteDraft {
  title: string;
  body: string;
  fontSize: number;
}

interface PersistedNoteResult {
  noteId: string;
  noteKey: CryptoKey;
  draft: NoteDraft;
  revision: number;
}

interface AttachmentNoteTarget {
  draft: NoteDraft;
  noteId: string;
  noteKey: CryptoKey;
  revision: number;
}

interface PreviewNoteSaveResult {
  error?: string;
  revision: number | null;
}

export interface AttachmentPreviewState {
  bytes?: Uint8Array;
  fileName: string;
  fallbackHtml?: string;
  html?: string;
  kind: "docx" | "html" | "hwp" | "image" | "pdf" | "text" | "unsupported";
  label: string;
  srcDoc?: string;
  text?: string;
  url?: string;
}

const blankEditor = (uid: string): EditorState => ({
  noteId: null,
  baseRevision: 0,
  title: "",
  body: "",
  type: "personal",
  participantUids: [uid],
  noteKey: null,
  folderId: null,
  fontSize: 17,
  dirty: false
});

type NoteSortField = "createdAt" | "updatedAt" | "title";
type NoteSortDirection = "asc" | "desc";
type NoteListFilter = "all" | NoteKind;
type EditorToolTab = "format" | "table" | "media";
const editorToolTabs: Array<{ id: EditorToolTab; label: string }> = [
  { id: "format", label: "서식" },
  { id: "table", label: "표" },
  { id: "media", label: "파일" }
];

interface NoteSortSetting {
  field: NoteSortField;
  direction: NoteSortDirection;
}

interface NoteListCounts {
  all: number;
  personal: number;
  shared: number;
}

type NoteStateByNoteId = Record<string, NoteUserStateSnapshot | undefined>;
type DrawerMode = "notes" | "trash";
type OverviewFolderFilter = "all" | "shared" | "unfiled" | string;

interface RichEditorInsertHtml {
  (html: string): string | null;
}

interface RemoteCursorView {
  uid: string;
  displayName: string;
  color: string;
  cursorOffset: number;
}

interface CursorClientRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

type TableResizeCursor = "col" | "row" | "ew" | "ns" | "nwse";

interface TableResizeHit {
  cell?: HTMLTableCellElement;
  columnIndex?: number;
  cursor: TableResizeCursor;
  heightSign: -1 | 0 | 1;
  kind: "column" | "row" | "table";
  row?: HTMLTableRowElement;
  table: HTMLTableElement;
  widthSign: -1 | 0 | 1;
}

interface TableResizeNodeTarget {
  nodeName: "table" | "tableCell" | "tableHeader" | "tableRow";
  position: number;
}

interface TableResizeSession {
  columnCellTargets: TableResizeNodeTarget[];
  startColumnWidths: number[];
  tableTarget: TableResizeNodeTarget | null;
  rowTarget: TableResizeNodeTarget | null;
}

interface TableDocumentInfo {
  rows: Array<{ cells: TableResizeNodeTarget[]; target: TableResizeNodeTarget }>;
  tableTarget: TableResizeNodeTarget;
}

interface TableControlState {
  columnTargets: TableResizeNodeTarget[];
  columnWidthPx: number;
  rowHeightPx: number;
  rowTarget: TableResizeNodeTarget;
  tableHeightPx: number;
  tableTarget: TableResizeNodeTarget;
  tableWidthPx: number;
}

const fontSizes = editorTextSizes;
const maxImageDataUrlLength = 760_000;
const maxInlineImageInputBytes = 20 * 1024 * 1024;
const maxInlineImagePixels = 20_000_000;
const inlineImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const autosaveDelayMs = 2500;
const publicSharePasswordMinLength = 12;
const deletedNoteRetentionDays = 30;
const historySummaryMaxLength = 420;
const cursorPublishDelayMs = 220;
const remoteCursorFreshMs = 15_000;
const activeNoteClientStorageKey = "quickmemo-active-note-client-id";
const noteSortStoragePrefix = "quickmemo-note-sort:";
const noteFilterStoragePrefix = "quickmemo-note-filter:";
const publicShareUrlStoragePrefix = "quickmemo-public-share-url:";
const publicShareContentKeyStoragePrefix = "quickmemo-public-share-content-key:";
const publicShareUrlMemoryCache = new Map<string, string>();
const publicShareContentKeyMemoryCache = new Map<string, string>();
const defaultNoteSort: NoteSortSetting = { field: "createdAt", direction: "desc" };
const defaultNoteFilter: NoteListFilter = "all";
const folderColorOptions = ["#2f7d70", "#3f6fb5", "#b9822f", "#c75146", "#64748b", "#7c3aed"];
const attachmentInputAccept = allowedAttachmentExtensions.map((extension) => `.${extension}`).join(",");
export const previewableAttachmentExtensions = new Set(["pdf", "txt", "md", "csv", "json", "doc", "docx", "hwp", "hwpx", "xlsx"]);
export const textPreviewAttachmentExtensions = new Set(["txt", "md", "csv", "json"]);
export const legacyBinaryPreviewAttachmentExtensions = new Set(["doc"]);
const attachmentUploadToastClearDelayMs = 900;
const attachmentUploadFailureClearDelayMs = 2400;

type AttachmentUploadPhase = "preparing" | "encrypting" | "uploading" | "finalizing" | "syncing" | "complete" | "failed";

interface AttachmentUploadProgressState {
  fileCount: number;
  fileIndex: number;
  fileName: string;
  loadedBytes: number;
  overallPercent: number;
  percent: number;
  phase: AttachmentUploadPhase;
  runId: string;
  totalBytes: number;
}

interface AttachmentActionBusyState {
  deletingIds: string[];
  downloadingId: string | null;
  previewingId: string | null;
}

const idleAttachmentActionBusyState: AttachmentActionBusyState = {
  deletingIds: [],
  downloadingId: null,
  previewingId: null
};

const attachmentUploadPhaseLabel: Record<AttachmentUploadPhase, string> = {
  preparing: "첨부 준비 중",
  encrypting: "암호화 중",
  uploading: "업로드 중",
  finalizing: "마무리 중",
  syncing: "공유 링크 동기화 중",
  complete: "업로드 완료",
  failed: "업로드 실패"
};
const maxTextPreviewCharacters = 120_000;
const maxTextPreviewBytes = 512 * 1024;
const safeHexColorPattern = /^#[0-9a-f]{6}$/;

function dataTransferHasFiles(dataTransfer: DataTransfer | null) {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

function draftFromNote(note: DecryptedNote): NoteDraft {
  const parsedBody = parseEditorContent(note.body);

  return {
    title: note.title,
    body: parsedBody.html,
    fontSize: parsedBody.fontSize
  };
}

async function encryptNoteDraft(draft: NoteDraft, noteKey: CryptoKey) {
  const [encryptedTitle, encryptedBody] = await Promise.all([
    encryptText(draft.title.trim() || "제목 없음", noteKey),
    encryptText(serializeEditorContent(draft.body, draft.fontSize), noteKey)
  ]);

  return { encryptedTitle, encryptedBody };
}

interface SharedBlockMetadata {
  authors: string[];
  blockId: string | null;
  editors: string[];
  hasAttribution: boolean;
  isBlank: boolean;
  lastEditorUid: string | null;
  signature: string;
}

function sharedNoteDraftForSave(
  previousDraft: NoteDraft | null,
  draft: NoteDraft,
  actorUid: string,
  fallbackAuthorUid: string,
  users: UserProfile[] = []
): NoteDraft {
  return {
    ...draft,
    body: annotateSharedNoteBody(previousDraft?.body ?? "", draft.body, actorUid, fallbackAuthorUid, users)
  };
}

function annotateSharedNoteBody(previousHtml: string, nextHtml: string, actorUid: string, fallbackAuthorUid: string, users: UserProfile[]) {
  if (typeof document === "undefined") {
    return nextHtml;
  }

  const usersByUid = new Map(users.map((user) => [user.uid, user]));
  const previousBlocks = sharedBlockMetadataFromHtml(previousHtml, fallbackAuthorUid);
  const usedPreviousBlocks = new Set<SharedBlockMetadata>();
  const usedNextBlockIds = new Set<string>();
  const template = document.createElement("template");
  template.innerHTML = sanitizeEditorHtml(nextHtml);
  const nextBlocks = sharedAttributionBlocks(template.content);

  nextBlocks.forEach((block, index) => {
    if (isBlankSharedBlock(block)) {
      clearSharedAttributionAttributes(block);
      return;
    }

    const nextSignature = comparableSharedBlockSignature(block);
    const requestedBlockId = parseBlockId(block.dataset.qmBlockId);
    let previousBlock = requestedBlockId ? previousBlocks.find((candidate) => candidate.blockId === requestedBlockId) ?? null : null;

    if (previousBlock && usedPreviousBlocks.has(previousBlock)) {
      previousBlock = null;
    }

    if (!previousBlock) {
      previousBlock = previousBlocks.find((candidate) => !usedPreviousBlocks.has(candidate) && candidate.signature === nextSignature) ?? null;
    }

    if (!previousBlock) {
      const indexedPreviousBlock = previousBlocks[index];
      previousBlock = indexedPreviousBlock && !usedPreviousBlocks.has(indexedPreviousBlock) ? indexedPreviousBlock : null;
    }

    if (previousBlock) {
      usedPreviousBlocks.add(previousBlock);
    }

    let blockId = createSharedBlockId();

    if (requestedBlockId && !usedNextBlockIds.has(requestedBlockId)) {
      blockId = requestedBlockId;
    } else if (previousBlock?.blockId && !usedNextBlockIds.has(previousBlock.blockId)) {
      blockId = previousBlock.blockId;
    }
    const isNewBlock = !previousBlock;
    const previousAuthors = previousBlock?.authors.length ? previousBlock.authors : [fallbackAuthorUid];
    const previousEditors = previousBlock?.editors.length ? previousBlock.editors : previousAuthors;
    const previousLastEditorUid = previousBlock?.lastEditorUid ?? previousEditors.at(-1) ?? fallbackAuthorUid;
    const changed = !previousBlock || nextSignature !== previousBlock.signature;
    const shouldTreatAsNewAuthoredBlock = isNewBlock || Boolean(previousBlock?.isBlank);
    const shouldKeepPreviousAuthor = Boolean(previousBlock && previousBlock.hasAttribution && !previousBlock.isBlank);
    const isLegacyContent = Boolean(previousBlock && !previousBlock.hasAttribution && !previousBlock.isBlank);
    const nextAuthors =
      shouldTreatAsNewAuthoredBlock || (!shouldKeepPreviousAuthor && !isLegacyContent)
        ? [actorUid]
        : previousAuthors;
    const nextEditors = shouldTreatAsNewAuthoredBlock ? [actorUid] : previousEditors;
    const finalEditors = changed ? appendUniqueUid(nextEditors, actorUid) : nextEditors;
    const finalLastEditorUid = changed ? actorUid : previousLastEditorUid;

    block.dataset.qmBlockId = blockId;
    block.dataset.qmAuthorUids = nextAuthors.join(",");
    block.dataset.qmEditorUids = finalEditors.join(",");
    block.dataset.qmLastEditorUid = finalLastEditorUid;
    block.dataset.qmAttributionLabel = sharedAttributionLabel(nextAuthors, finalLastEditorUid, usersByUid);
    usedNextBlockIds.add(blockId);
  });

  const container = document.createElement("div");
  container.appendChild(template.content);
  return container.innerHTML;
}

function sharedBlockMetadataFromHtml(html: string, fallbackAuthorUid: string): SharedBlockMetadata[] {
  if (typeof document === "undefined") {
    return [];
  }

  const template = document.createElement("template");
  template.innerHTML = sanitizeEditorHtml(html);

  return sharedAttributionBlocks(template.content).map((block) => {
    const authors = parseUidList(block.dataset.qmAuthorUids);
    const editors = parseUidList(block.dataset.qmEditorUids);
    const blockId = parseBlockId(block.dataset.qmBlockId);
    const lastEditorUid = parseUid(block.dataset.qmLastEditorUid);
    const safeAuthors = authors.length ? authors : [fallbackAuthorUid];
    const safeEditors = editors.length ? editors : safeAuthors;

    return {
      authors: safeAuthors,
      blockId,
      editors: safeEditors,
      hasAttribution: Boolean(blockId || authors.length || editors.length || lastEditorUid),
      isBlank: isBlankSharedBlock(block),
      lastEditorUid: lastEditorUid ?? safeEditors.at(-1) ?? fallbackAuthorUid,
      signature: comparableSharedBlockSignature(block)
    };
  });
}

function trustedSharedBlockMetadataFromHistory(
  note: DecryptedNote,
  history: NoteHistorySnapshot[],
  historySnapshots: Record<string, NoteDraft>
) {
  const chronologicalEntries = history
    .map((entry, index) => ({ draft: historySnapshots[entry.id] ?? null, entry, index }))
    .filter((item): item is { draft: NoteDraft; entry: NoteHistorySnapshot; index: number } => Boolean(item.draft))
    .sort((left, right) => {
      const leftMillis = timestampMillisValue(left.entry.createdAt) ?? 0;
      const rightMillis = timestampMillisValue(right.entry.createdAt) ?? 0;
      return leftMillis - rightMillis || right.index - left.index;
    });

  return chronologicalEntries.reduce<SharedBlockMetadata[]>((previousBlocks, { draft, entry }) => {
    const actorUid = parseUid(entry.actorUid) ?? note.updatedBy ?? note.ownerUid;
    return deriveSharedBlockMetadataForActor(previousBlocks, draft.body, actorUid, note.ownerUid);
  }, []);
}

function deriveSharedBlockMetadataForActor(
  previousBlocks: SharedBlockMetadata[],
  nextHtml: string,
  actorUid: string,
  fallbackAuthorUid: string
) {
  if (typeof document === "undefined") {
    return [];
  }

  const usedPreviousBlocks = new Set<SharedBlockMetadata>();
  const template = document.createElement("template");
  template.innerHTML = sanitizeEditorHtml(nextHtml);

  return sharedAttributionBlocks(template.content).map((block, index) => {
    if (isBlankSharedBlock(block)) {
      return {
        authors: [],
        blockId: null,
        editors: [],
        hasAttribution: false,
        isBlank: true,
        lastEditorUid: null,
        signature: ""
      };
    }

    const signature = comparableSharedBlockSignature(block);
    const previousBlock = matchSharedBlockMetadata(previousBlocks, usedPreviousBlocks, signature, index);
    const previousAuthors = previousBlock?.authors.length ? previousBlock.authors : [fallbackAuthorUid];
    const previousEditors = previousBlock?.editors.length ? previousBlock.editors : previousAuthors;
    const changed = !previousBlock || signature !== previousBlock.signature;
    const shouldTreatAsNewAuthoredBlock = !previousBlock || previousBlock.isBlank;
    const authors = shouldTreatAsNewAuthoredBlock ? [actorUid] : previousAuthors;
    const nextEditors = shouldTreatAsNewAuthoredBlock ? [actorUid] : previousEditors;
    const editors = changed ? appendUniqueUid(nextEditors, actorUid) : nextEditors;
    const lastEditorUid = changed ? actorUid : previousBlock?.lastEditorUid ?? editors.at(-1) ?? actorUid;

    return {
      authors,
      blockId: null,
      editors,
      hasAttribution: true,
      isBlank: false,
      lastEditorUid,
      signature
    };
  });
}

function matchSharedBlockMetadata(
  blocks: SharedBlockMetadata[],
  usedBlocks: Set<SharedBlockMetadata>,
  signature: string,
  index: number
) {
  let block = blocks.find((candidate) => !usedBlocks.has(candidate) && !candidate.isBlank && candidate.signature === signature) ?? null;

  if (!block) {
    const indexedBlock = blocks[index];
    block = indexedBlock && !usedBlocks.has(indexedBlock) && !indexedBlock.isBlank ? indexedBlock : null;
  }

  if (block) {
    usedBlocks.add(block);
  }

  return block;
}

function sharedAttributionBlocks(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>("td, th, li, p")).filter((element) => {
    if (element.tagName === "P") {
      return !element.closest("td, th, li");
    }

    if (element.tagName === "LI") {
      return !element.closest("td, th");
    }

    return true;
  });
}

function comparableSharedBlockSignature(block: HTMLElement) {
  const clone = block.cloneNode(true) as HTMLElement;

  clone.querySelectorAll<HTMLElement>(".qm-attribution-note").forEach((element) => element.remove());
  clone
    .querySelectorAll<HTMLElement>(
      "[data-qm-block-id], [data-qm-author-uids], [data-qm-editor-uids], [data-qm-last-editor-uid], [data-qm-attribution-label]"
    )
    .forEach((element) => {
      element.removeAttribute("data-qm-block-id");
      element.removeAttribute("data-qm-author-uids");
      element.removeAttribute("data-qm-editor-uids");
      element.removeAttribute("data-qm-last-editor-uid");
      element.removeAttribute("data-qm-attribution-label");
    });
  clone.removeAttribute("data-qm-block-id");
  clone.removeAttribute("data-qm-author-uids");
  clone.removeAttribute("data-qm-editor-uids");
  clone.removeAttribute("data-qm-last-editor-uid");
  clone.removeAttribute("data-qm-attribution-label");

  return `${clone.tagName}:${clone.innerHTML.replace(/\s+/g, " ").trim()}`;
}

function parseUidList(value: string | null | undefined) {
  return Array.from(
    new Set(
      String(value ?? "")
        .split(",")
        .map((uid) => uid.trim())
        .filter((uid) => /^[A-Za-z0-9_:.-]{1,128}$/.test(uid))
    )
  );
}

function parseUid(value: string | null | undefined) {
  const normalizedUid = String(value ?? "").trim();
  return /^[A-Za-z0-9_:.-]{1,128}$/.test(normalizedUid) ? normalizedUid : null;
}

function parseBlockId(value: string | null | undefined) {
  const normalizedBlockId = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{12,64}$/.test(normalizedBlockId) ? normalizedBlockId : null;
}

function appendUniqueUid(values: string[], uid: string) {
  return values.includes(uid) ? values : [...values, uid];
}

function createSharedBlockId() {
  const randomValue =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2);
  return `qm_${randomValue.slice(0, 28)}`;
}

function clearSharedAttributionAttributes(block: HTMLElement) {
  block.removeAttribute("data-qm-block-id");
  block.removeAttribute("data-qm-author-uids");
  block.removeAttribute("data-qm-editor-uids");
  block.removeAttribute("data-qm-last-editor-uid");
  block.removeAttribute("data-qm-attribution-label");
}

function isBlankSharedBlock(block: HTMLElement) {
  const clone = block.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>(".qm-attribution-note").forEach((element) => element.remove());
  clearSharedAttributionAttributes(clone);
  const text = (clone.textContent ?? "").replace(/\u00a0/g, " ").trim();
  return !text && !clone.querySelector("img, table, input[type='checkbox']");
}

function sharedAttributionHtml(
  html: string,
  note: DecryptedNote,
  users: UserProfile[],
  trustedBlocks: SharedBlockMetadata[] = []
) {
  if (typeof document === "undefined") {
    return linkifyEditorHtml(sanitizeEditorHtml(html));
  }

  const usersByUid = new Map(users.map((user) => [user.uid, user]));
  const usedTrustedBlocks = new Set<SharedBlockMetadata>();
  const template = document.createElement("template");
  template.innerHTML = linkifyEditorHtml(sanitizeEditorHtml(html));

  sharedAttributionBlocks(template.content).forEach((block, index) => {
    if (isBlankSharedBlock(block)) {
      clearSharedAttributionAttributes(block);
      return;
    }

    const signature = comparableSharedBlockSignature(block);
    const trustedBlock = matchSharedBlockMetadata(trustedBlocks, usedTrustedBlocks, signature, index);
    const safeAuthors = trustedBlock?.authors.length ? trustedBlock.authors : [note.ownerUid];
    const safeEditors = trustedBlock?.editors.length ? trustedBlock.editors : [note.updatedBy || note.ownerUid];
    const finalLastEditorUid = trustedBlock?.lastEditorUid ?? safeEditors.at(-1) ?? note.updatedBy ?? note.ownerUid;
    const label = sharedAttributionLabel(safeAuthors, finalLastEditorUid, usersByUid);
    clearSharedAttributionAttributes(block);
    block.dataset.qmAttributionLabel = label;
    renderSharedAttributionNote(block, label);
  });

  const container = document.createElement("div");
  container.appendChild(template.content);
  return container.innerHTML;
}

function renderSharedAttributionNote(block: HTMLElement, label: string) {
  const noteElement = document.createElement("small");
  noteElement.className = "qm-attribution-note";
  noteElement.textContent = label;

  if (block.tagName === "P" && block.parentNode) {
    block.parentNode.insertBefore(noteElement, block.nextSibling);
    return;
  }

  block.appendChild(noteElement);
}

function sharedAttributionLabel(authorUids: string[], lastEditorUid: string, usersByUid: Map<string, UserProfile>) {
  return `작성자: ${uidLabels(authorUids, usersByUid)}, 최종 수정자: ${uidLabels([lastEditorUid], usersByUid)}`;
}

function uidLabels(uids: string[], usersByUid: Map<string, UserProfile>) {
  return uids.map((uid) => usersByUid.get(uid)?.avatarText || uid.slice(0, 2).toUpperCase()).join(",");
}

function clippedText(value: string, maxLength = historySummaryMaxLength) {
  const normalizedValue = value.replace(/\s+/g, " ").trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1).trim()}...`;
}

function historySummaryFromDraft(previousDraft: NoteDraft | null, draft: NoteDraft) {
  if (!previousDraft) {
    const title = clippedText(draft.title || "제목 없음", 120);
    const body = clippedText(previewTextFromHtml(draft.body) || (/<img\b/i.test(draft.body) ? "이미지 포함" : "내용 없음"));

    return `제목: ${title}\n내용: ${body}`;
  }

  const changes: string[] = [];

  if (previousDraft.title !== draft.title) {
    changes.push(`제목 변경: ${textChangeSummary(previousDraft.title || "제목 없음", draft.title || "제목 없음", 160)}`);
  }

  if (previousDraft.body !== draft.body || previousDraft.fontSize !== draft.fontSize) {
    changes.push(bodyChangeSummary(previousDraft, draft));
  }

  return changes.length ? clippedText(changes.join("\n")) : "저장됨";
}

function historySnapshotFromDraft(draft: NoteDraft) {
  return JSON.stringify({
    title: draft.title,
    body: sanitizeEditorHtml(draft.body),
    fontSize: clampDraftFontSize(draft.fontSize)
  });
}

function draftFromHistorySnapshot(value: string): NoteDraft | null {
  try {
    const parsed = JSON.parse(value) as Partial<NoteDraft>;

    if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
      return null;
    }

    return {
      title: parsed.title,
      body: sanitizeEditorHtml(parsed.body),
      fontSize: clampDraftFontSize(Number(parsed.fontSize))
    };
  } catch {
    return null;
  }
}

interface HistoryDiffLine {
  changed: string;
  id: string;
  label: string;
  prefix: string;
  removed: string;
  suffix: string;
}

function historyDiffLines(previousDraft: NoteDraft | null, draft: NoteDraft) {
  const lines: HistoryDiffLine[] = [];

  if (!previousDraft) {
    const title = clippedText(draft.title || "제목 없음", 160);
    const body = clippedText(previewTextFromHtml(draft.body) || (/<img\b/i.test(draft.body) ? "이미지 포함" : "내용 없음"), 260);

    lines.push({ changed: title, id: "title", label: "제목", prefix: "", removed: "", suffix: "" });
    lines.push({ changed: body, id: "body", label: "내용", prefix: "", removed: "", suffix: "" });
    return lines;
  }

  if (previousDraft.title !== draft.title) {
    lines.push({
      ...textDiffLine("title", "제목", previousDraft.title || "제목 없음", draft.title || "제목 없음"),
      id: "title",
      label: "제목"
    });
  }

  const previousText = previewTextFromHtml(previousDraft.body);
  const nextText = previewTextFromHtml(draft.body);

  if (previousText !== nextText) {
    lines.push({
      ...textDiffLine("body", "내용", previousText || "내용 없음", nextText || "내용 없음"),
      id: "body",
      label: "내용"
    });
  } else if (previousDraft.body !== draft.body) {
    lines.push({
      changed: bodyStructureChangeLabel(previousDraft.body, draft.body),
      id: "body-format",
      label: "본문",
      prefix: "",
      removed: "",
      suffix: ""
    });
  }

  if (previousDraft.fontSize !== draft.fontSize) {
    lines.push({
      changed: `${previousDraft.fontSize}px → ${draft.fontSize}px`,
      id: "font-size",
      label: "기본 글자",
      prefix: "",
      removed: "",
      suffix: ""
    });
  }

  return lines;
}

function textDiffLine(id: string, label: string, previousValue: string, nextValue: string): HistoryDiffLine {
  const previousText = previousValue.replace(/\s+/g, " ").trim();
  const nextText = nextValue.replace(/\s+/g, " ").trim();
  const maxLength = 320;
  const previous = previousText.slice(0, maxLength);
  const next = nextText.slice(0, maxLength);
  let prefixLength = 0;

  while (prefixLength < previous.length && prefixLength < next.length && previous[prefixLength] === next[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < previous.length - prefixLength &&
    suffixLength < next.length - prefixLength &&
    previous[previous.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const nextChangedEnd = suffixLength ? next.length - suffixLength : next.length;
  const previousChangedEnd = suffixLength ? previous.length - suffixLength : previous.length;
  const changed = next.slice(prefixLength, nextChangedEnd);
  const removed = previous.slice(prefixLength, previousChangedEnd);
  const prefix = clippedDiffContext(next.slice(0, prefixLength), "end");
  const suffix = clippedDiffContext(next.slice(nextChangedEnd), "start");

  return {
    changed: changed || (removed ? "삭제됨" : next || "내용 없음"),
    id,
    label,
    prefix,
    removed,
    suffix
  };
}

function clippedDiffContext(value: string, edge: "start" | "end") {
  if (value.length <= 48) {
    return value;
  }

  return edge === "start" ? `${value.slice(0, 48)}...` : `...${value.slice(-48)}`;
}

function bodyStructureChangeLabel(previousBody: string, nextBody: string) {
  const previousTasks = countMatches(previousBody, /data-checked="true"/g);
  const nextTasks = countMatches(nextBody, /data-checked="true"/g);

  if (previousTasks !== nextTasks) {
    return `체크 상태 ${previousTasks}개 → ${nextTasks}개`;
  }

  if (previousBody.includes("<table") || nextBody.includes("<table")) {
    return "표 또는 표 서식 변경";
  }

  if (previousBody.includes("<img") || nextBody.includes("<img")) {
    return "이미지 변경";
  }

  return "서식 변경";
}

function countMatches(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}

function clampDraftFontSize(value: number) {
  if (!Number.isFinite(value)) {
    return 17;
  }

  return Math.min(editorTextSizeBounds.max, Math.max(editorTextSizeBounds.min, Math.round(value)));
}

function clampSelectionFontSize(value: number) {
  return clampDraftFontSize(value);
}

function clampSelectionLineHeight(value: number) {
  if (!Number.isFinite(value)) {
    return 1.5;
  }

  const roundedValue = Math.round(value * 100) / 100;
  return Math.min(editorLineHeightBounds.max, Math.max(editorLineHeightBounds.min, roundedValue));
}

function bodyChangeSummary(previousDraft: NoteDraft, draft: NoteDraft) {
  const previousStats = editorBodyStats(previousDraft.body);
  const nextStats = editorBodyStats(draft.body);

  if (previousStats.text !== nextStats.text) {
    return `본문 변경: ${textChangeSummary(previousStats.text || "내용 없음", nextStats.text || "내용 없음")}`;
  }

  const structuralChanges: string[] = [];

  if (previousStats.checkedTasks !== nextStats.checkedTasks || previousStats.totalTasks !== nextStats.totalTasks) {
    structuralChanges.push(`체크 ${previousStats.checkedTasks}/${previousStats.totalTasks} -> ${nextStats.checkedTasks}/${nextStats.totalTasks}`);
  }

  if (previousStats.tableCells !== nextStats.tableCells || previousStats.tables !== nextStats.tables) {
    structuralChanges.push(`표 ${previousStats.tables}개/${previousStats.tableCells}칸 -> ${nextStats.tables}개/${nextStats.tableCells}칸`);
  }

  if (previousDraft.fontSize !== draft.fontSize) {
    structuralChanges.push(`글자 ${previousDraft.fontSize}px -> ${draft.fontSize}px`);
  }

  return structuralChanges.length ? `본문 변경: ${structuralChanges.join(", ")}` : "본문 서식/표 색상 변경";
}

function editorBodyStats(html: string) {
  if (typeof document === "undefined") {
    return {
      checkedTasks: 0,
      tableCells: 0,
      tables: 0,
      text: previewTextFromHtml(html),
      totalTasks: 0
    };
  }

  const container = document.createElement("div");
  container.innerHTML = sanitizeEditorHtml(html);

  return {
    checkedTasks: container.querySelectorAll('li[data-type="taskItem"][data-checked="true"], input[type="checkbox"]:checked').length,
    tableCells: container.querySelectorAll("td, th").length,
    tables: container.querySelectorAll("table").length,
    text: previewTextFromHtml(html),
    totalTasks: container.querySelectorAll('li[data-type="taskItem"], input[type="checkbox"]').length
  };
}

function textChangeSummary(previousText: string, nextText: string, maxLength = 220) {
  const previousValue = previousText.replace(/\s+/g, " ").trim();
  const nextValue = nextText.replace(/\s+/g, " ").trim();

  if (!previousValue) {
    return `추가 "${clippedText(nextValue, maxLength)}"`;
  }

  if (!nextValue) {
    return `삭제 "${clippedText(previousValue, maxLength)}"`;
  }

  const prefixLength = commonPrefixLength(previousValue, nextValue);
  const suffixLength = commonSuffixLength(previousValue.slice(prefixLength), nextValue.slice(prefixLength));
  const previousChanged = previousValue.slice(prefixLength, previousValue.length - suffixLength);
  const nextChanged = nextValue.slice(prefixLength, nextValue.length - suffixLength);

  return `"${clippedText(previousChanged || previousValue, Math.floor(maxLength / 2))}" -> "${clippedText(
    nextChanged || nextValue,
    Math.floor(maxLength / 2)
  )}"`;
}

function commonPrefixLength(left: string, right: string) {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function commonSuffixLength(left: string, right: string) {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    index += 1;
  }

  return index;
}

function purgedDraft(): NoteDraft {
  return {
    title: "완전 삭제된 노트",
    body: "<p>완전 삭제되어 내용을 볼 수 없습니다.</p>",
    fontSize: 17
  };
}

function draftHasContent(draft: NoteDraft) {
  return Boolean(draft.title.trim() || previewTextFromHtml(draft.body) || /<img\b/i.test(draft.body));
}

function draftsMatch(editor: EditorState, draft: NoteDraft) {
  return editor.title === draft.title && editor.body === draft.body && editor.fontSize === draft.fontSize;
}

function noteDraftsMatch(left: NoteDraft, right: NoteDraft) {
  return left.title === right.title && left.body === right.body && left.fontSize === right.fontSize;
}

function noteTypeFromParticipants(participantUids: string[]): NoteKind {
  return participantUids.length > 1 ? "shared" : "personal";
}

function dateFromTimestamp(timestamp: unknown) {
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  if (
    timestamp &&
    typeof timestamp === "object" &&
    "toDate" in timestamp &&
    typeof timestamp.toDate === "function"
  ) {
    const date = timestamp.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }

  return null;
}

function freshRemoteCursorTimestamp(updatedAt: Date | null, clockMs: number) {
  if (!updatedAt) {
    return false;
  }

  const ageMs = clockMs - updatedAt.getTime();
  return ageMs >= 0 && ageMs <= remoteCursorFreshMs;
}

function nextParticipantList(currentParticipantUids: string[], selectedUid: string, checked: boolean, ownerUid: string) {
  const participantUids = checked
    ? Array.from(new Set([...currentParticipantUids, selectedUid, ownerUid]))
    : currentParticipantUids.filter((participantUid) => participantUid !== selectedUid || participantUid === ownerUid);

  return Array.from(new Set([ownerUid, ...participantUids]));
}

function noteTimestampMillis(note: DecryptedNote, field: Exclude<NoteSortField, "title">) {
  const timestamp = note[field];

  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.getTime();
  }

  if (
    timestamp &&
    typeof timestamp === "object" &&
    "toMillis" in timestamp &&
    typeof timestamp.toMillis === "function"
  ) {
    const millis = timestamp.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }

  return null;
}

function notePinned(noteId: string, statesByNoteId: NoteStateByNoteId) {
  return statesByNoteId[noteId]?.isPinned === true;
}

function timestampMillisValue(timestamp: unknown) {
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.getTime();
  }

  if (
    timestamp &&
    typeof timestamp === "object" &&
    "toMillis" in timestamp &&
    typeof timestamp.toMillis === "function"
  ) {
    const millis = timestamp.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }

  return null;
}

function noteNeedsSharedAttention(note: DecryptedNote, state: NoteUserStateSnapshot | undefined, currentUid: string) {
  if (!currentUid || note.type !== "shared" || note.isDeleted || note.updatedBy === currentUid) {
    return false;
  }

  const updatedAt = timestampMillisValue(note.updatedAt);

  if (!updatedAt) {
    return false;
  }

  const readAt = timestampMillisValue(state?.readAt) ?? 0;
  const confirmedAt = timestampMillisValue(state?.confirmedAt) ?? 0;
  return Math.max(readAt, confirmedAt) + 500 < updatedAt;
}

function compareNoteTitles(left: DecryptedNote, right: DecryptedNote) {
  return (left.title || "제목 없음").localeCompare(right.title || "제목 없음", "ko");
}

function sortNotes(notes: DecryptedNote[], setting: NoteSortSetting, statesByNoteId: NoteStateByNoteId = {}) {
  return [...notes].sort((left, right) => {
    const leftPinned = notePinned(left.id, statesByNoteId);
    const rightPinned = notePinned(right.id, statesByNoteId);

    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }

    if (setting.field === "title") {
      const titleComparison = compareNoteTitles(left, right);
      return setting.direction === "asc" ? titleComparison : -titleComparison;
    }

    const leftValue = noteTimestampMillis(left, setting.field);
    const rightValue = noteTimestampMillis(right, setting.field);

    if (leftValue === null && rightValue === null) {
      return compareNoteTitles(left, right);
    }

    if (leftValue === null) {
      return 1;
    }

    if (rightValue === null) {
      return -1;
    }

    return setting.direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
  });
}

function sortDeletedNotes(notes: DecryptedNote[]) {
  return [...notes].sort((left, right) => {
    const leftDeletedAt = timestampMillisValue(left.deletedAt);
    const rightDeletedAt = timestampMillisValue(right.deletedAt);

    if (leftDeletedAt === null && rightDeletedAt === null) {
      return compareNoteTitles(left, right);
    }

    if (leftDeletedAt === null) {
      return 1;
    }

    if (rightDeletedAt === null) {
      return -1;
    }

    return rightDeletedAt - leftDeletedAt;
  });
}

function normalizedSearchTerm(value: string) {
  return value.trim().toLocaleLowerCase("ko");
}

function notePreviewText(note: DecryptedNote) {
  return "searchText" in note && typeof note.searchText === "string" ? note.searchText : previewTextFromHtml(note.body);
}

function noteMatchesQuery(note: DecryptedNote, query: string) {
  const term = normalizedSearchTerm(query);

  if (!term) {
    return true;
  }

  const searchableText = [note.title, notePreviewText(note)]
    .join(" ")
    .toLocaleLowerCase("ko");

  return searchableText.includes(term);
}

function filterNotes(notes: DecryptedNote[], filter: NoteListFilter, query = "") {
  const filteredByKind = filter === "all" ? notes : notes.filter((note) => note.type === filter);
  return query ? filteredByKind.filter((note) => noteMatchesQuery(note, query)) : filteredByKind;
}

function readNoteSortSetting(uid: string): NoteSortSetting {
  if (typeof window === "undefined") {
    return defaultNoteSort;
  }

  try {
    const rawValue = window.localStorage.getItem(`${noteSortStoragePrefix}${uid}`);

    if (!rawValue) {
      return defaultNoteSort;
    }

    const parsed = JSON.parse(rawValue) as Partial<NoteSortSetting>;

    if (
      (parsed.field === "createdAt" || parsed.field === "updatedAt" || parsed.field === "title") &&
      (parsed.direction === "asc" || parsed.direction === "desc")
    ) {
      return { field: parsed.field, direction: parsed.direction };
    }
  } catch {
    return defaultNoteSort;
  }

  return defaultNoteSort;
}

function readNoteFilter(uid: string): NoteListFilter {
  if (typeof window === "undefined") {
    return defaultNoteFilter;
  }

  try {
    const rawValue = window.localStorage.getItem(`${noteFilterStoragePrefix}${uid}`);

    if (rawValue === "all" || rawValue === "personal" || rawValue === "shared") {
      return rawValue;
    }
  } catch {
    return defaultNoteFilter;
  }

  return defaultNoteFilter;
}

function writeNoteSortSetting(uid: string, setting: NoteSortSetting) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(`${noteSortStoragePrefix}${uid}`, JSON.stringify(setting));
  } catch {
    // Sorting still works for the current session if storage is unavailable.
  }
}

function writeNoteFilter(uid: string, filter: NoteListFilter) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(`${noteFilterStoragePrefix}${uid}`, filter);
  } catch {
    // Filtering still works for the current session if storage is unavailable.
  }
}

function readStoredPublicShareUrl(uid: string, shareId: string) {
  return publicShareUrlMemoryCache.get(publicShareUrlStorageKey(uid, shareId)) ?? null;
}

function writeStoredPublicShareUrl(uid: string, shareId: string, url: string) {
  publicShareUrlMemoryCache.set(publicShareUrlStorageKey(uid, shareId), url);
}

function removeStoredPublicShareUrl(uid: string, shareId: string) {
  publicShareUrlMemoryCache.delete(publicShareUrlStorageKey(uid, shareId));
}

function readStoredPublicShareContentKey(uid: string, shareId: string) {
  return publicShareContentKeyMemoryCache.get(publicShareContentKeyStorageKey(uid, shareId)) ?? null;
}

function writeStoredPublicShareContentKey(uid: string, shareId: string, key: string) {
  publicShareContentKeyMemoryCache.set(publicShareContentKeyStorageKey(uid, shareId), key);
}

function removeStoredPublicShareContentKey(uid: string, shareId: string) {
  publicShareContentKeyMemoryCache.delete(publicShareContentKeyStorageKey(uid, shareId));
}

function clearStoredPublicShareSecrets(uid?: string) {
  if (!uid) {
    publicShareUrlMemoryCache.clear();
    publicShareContentKeyMemoryCache.clear();
    return;
  }

  const urlPrefix = `${publicShareUrlStoragePrefix}${uid}:`;
  const contentKeyPrefix = `${publicShareContentKeyStoragePrefix}${uid}:`;

  for (const key of publicShareUrlMemoryCache.keys()) {
    if (key.startsWith(urlPrefix)) {
      publicShareUrlMemoryCache.delete(key);
    }
  }

  for (const key of publicShareContentKeyMemoryCache.keys()) {
    if (key.startsWith(contentKeyPrefix)) {
      publicShareContentKeyMemoryCache.delete(key);
    }
  }
}

function publicShareUrlStorageKey(uid: string, shareId: string) {
  return `${publicShareUrlStoragePrefix}${uid}:${shareId}`;
}

function publicShareContentKeyStorageKey(uid: string, shareId: string) {
  return `${publicShareContentKeyStoragePrefix}${uid}:${shareId}`;
}

function publicShareKeyFromUrl(url: string) {
  try {
    const hash = new URL(url).hash.replace(/^#/, "");

    return hash ? new URLSearchParams(hash).get("key") : null;
  } catch {
    return null;
  }
}

const noteRevisionConflictMessage =
  "다른 기기에서 이 노트가 먼저 변경되어 저장하지 않았습니다. 현재 편집 내용은 그대로 유지했습니다. 필요한 내용을 복사한 뒤 노트를 다시 열어 최신 버전을 확인해주세요.";

function noteMutationErrorMessage(error: unknown, fallback: string) {
  return error instanceof NoteRevisionConflictError ? noteRevisionConflictMessage : fallback;
}

function noteSyncSignature(note: DecryptedNote) {
  const updatedAt = note.updatedAt ? `${note.updatedAt.seconds}:${note.updatedAt.nanoseconds}` : "pending";

  return [
    note.id,
    note.revision ?? 0,
    updatedAt,
    note.updatedBy,
    note.folderId ?? "",
    note.encryptedTitle.iv,
    note.encryptedTitle.cipherText,
    note.encryptedBody.iv,
    note.encryptedBody.cipherText
  ].join(":");
}

function publicShareMatchesSourceRevision(
  share: PublicNoteShareSnapshot,
  note: Pick<NoteSnapshot, "attachmentRevision" | "revision"> | undefined
) {
  const sourceRevision = note?.revision;
  const sourceAttachmentRevision = note?.attachmentRevision;

  const contentMatches = share.sourceRevision === undefined
    ? sourceRevision === undefined
    : share.sourceRevision === (sourceRevision ?? 0);
  const attachmentsMatch = share.sourceAttachmentRevision === undefined
    ? sourceAttachmentRevision === undefined
    : share.sourceAttachmentRevision === (sourceAttachmentRevision ?? 0);

  return contentMatches && attachmentsMatch;
}

function getActiveNoteClientId() {
  const fallbackId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (typeof window === "undefined") {
    return fallbackId();
  }

  try {
    const storedId = window.sessionStorage.getItem(activeNoteClientStorageKey);

    if (storedId) {
      return storedId;
    }

    const nextId = fallbackId();
    window.sessionStorage.setItem(activeNoteClientStorageKey, nextId);
    return nextId;
  } catch {
    return fallbackId();
  }
}

function formatCompactDateTime(date: Date | null) {
  if (!date) {
    return "없음";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatFullDateTime(date: Date | null) {
  if (!date) {
    return "입력 전";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function publicShareTone(share: PublicNoteShareSnapshot | undefined, clockMs: number) {
  const expiresAt = dateFromTimestamp(share?.expiresAt);

  if (!share || !expiresAt) {
    return "none";
  }

  const remainingMs = expiresAt.getTime() - clockMs;

  if (remainingMs <= 24 * 60 * 60 * 1000) {
    return "urgent";
  }

  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return "soon";
  }

  return "fresh";
}

function publicShareRemainingLabel(share: PublicNoteShareSnapshot | undefined, clockMs: number) {
  const expiresAt = dateFromTimestamp(share?.expiresAt);

  if (!share || !expiresAt) {
    return null;
  }

  const remainingMs = expiresAt.getTime() - clockMs;

  if (remainingMs <= 0) {
    return "만료";
  }

  const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));

  if (remainingHours <= 24) {
    return `${remainingHours}시간 남음`;
  }

  return `${Math.ceil(remainingHours / 24)}일 남음`;
}

function deletedRetentionLabel(note: DecryptedNote) {
  const deletedAt = dateFromTimestamp(note.deletedAt);

  if (!deletedAt) {
    return `${deletedNoteRetentionDays}일 보관`;
  }

  const elapsedDays = Math.floor((Date.now() - startOfLocalDay(deletedAt)) / (24 * 60 * 60 * 1000));
  const remainingDays = Math.max(0, deletedNoteRetentionDays - elapsedDays);
  return remainingDays > 0 ? `${remainingDays}일 후 정리 대상` : "정리 대상";
}

function changedDraftFields(previousDraft: NoteDraft | null, nextDraft: NoteDraft) {
  if (!previousDraft) {
    return ["title", "body"];
  }

  const fields: string[] = [];

  if (previousDraft.title !== nextDraft.title) {
    fields.push("title");
  }

  if (previousDraft.body !== nextDraft.body || previousDraft.fontSize !== nextDraft.fontSize) {
    fields.push("body");
  }

  return fields.length ? fields : ["body"];
}

function historyActionLabel(action: NoteHistorySnapshot["action"]) {
  const labels: Partial<Record<NoteHistorySnapshot["action"], string>> = {
    create: "생성",
    content: "내용 수정",
    share: "공유 대상 변경",
    delete: "삭제",
    restore: "복구"
  };

  return labels[action] ?? "변경";
}

function historyFieldLabel(field: string) {
  const labels: Record<string, string> = {
    title: "제목",
    body: "본문",
    participants: "공유 대상",
    deleted: "삭제 상태",
    restored: "복구 상태"
  };

  return labels[field] ?? field;
}

interface SearchableDecryptedNote extends DecryptedNote {
  searchText: string;
}

interface DecryptedNoteCacheEntry {
  body: string;
  encryptedBody: NoteSnapshot["encryptedBody"];
  encryptedTitle: NoteSnapshot["encryptedTitle"];
  searchText: string;
  title: string;
  wrappedKey: NoteSnapshot["wrappedKeys"][string];
}

type DecryptedNoteCache = Map<string, DecryptedNoteCacheEntry>;

function encryptedPayloadMatches(
  left: NoteSnapshot["encryptedTitle"],
  right: NoteSnapshot["encryptedTitle"]
) {
  return (
    left.version === right.version &&
    left.algorithm === right.algorithm &&
    left.iv === right.iv &&
    left.cipherText === right.cipherText
  );
}

function wrappedKeyMatches(
  left: NoteSnapshot["wrappedKeys"][string],
  right: NoteSnapshot["wrappedKeys"][string]
) {
  return left.version === right.version && left.algorithm === right.algorithm && left.wrappedKey === right.wrappedKey;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker));
  return results;
}

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function useDialogFocus(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return undefined;
    }

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frameId = window.requestAnimationFrame(() => {
      const focusTarget = dialog.querySelector<HTMLElement>("[autofocus], [data-dialog-initial-focus], " + dialogFocusableSelector);
      dialog.tabIndex = -1;
      (focusTarget ?? dialog).focus({ preventScroll: true });
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") {
        return;
      }

      const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));

      if (openDialogs.at(-1) !== dialog) {
        return;
      }

      const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector)).filter(
        (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true"
      );

      if (!focusableElements.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements.at(-1)!;
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener("keydown", handleKeyDown, true);

      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [dialogRef]);
}

async function decryptNoteSnapshots(
  notes: NoteSnapshot[],
  uid: string,
  privateKey: CryptoKey,
  cache?: DecryptedNoteCache,
  isCurrent: () => boolean = () => true
) {
  const nextCache = new Map<string, DecryptedNoteCacheEntry>();
  const nextNotes = await mapWithConcurrency(notes, 4, async (note) => {
    const wrappedKey = note.wrappedKeys[uid];

    if (!wrappedKey) {
      return null;
    }

    const cached = cache?.get(note.id);

    if (
      cached &&
      encryptedPayloadMatches(cached.encryptedTitle, note.encryptedTitle) &&
      encryptedPayloadMatches(cached.encryptedBody, note.encryptedBody) &&
      wrappedKeyMatches(cached.wrappedKey, wrappedKey)
    ) {
      nextCache.set(note.id, {
        ...cached,
        encryptedBody: note.encryptedBody,
        encryptedTitle: note.encryptedTitle,
        wrappedKey
      });
      return { ...note, body: cached.body, searchText: cached.searchText, title: cached.title } satisfies SearchableDecryptedNote;
    }

    try {
      const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
      const [title, body] = await Promise.all([
        decryptText(note.encryptedTitle, noteKey),
        decryptText(note.encryptedBody, noteKey)
      ]);
      const searchText = previewTextFromHtml(body);
      const decryptedNote = { ...note, title, body, searchText } satisfies SearchableDecryptedNote;
      nextCache.set(note.id, {
        body,
        encryptedBody: note.encryptedBody,
        encryptedTitle: note.encryptedTitle,
        searchText,
        title,
        wrappedKey
      });
      return decryptedNote;
    } catch {
      return {
        ...note,
        title: "복호화할 수 없는 노트",
        body: "비밀번호 초기화 또는 공유 키 변경으로 이 기기에서 열 수 없습니다.",
        searchText: "복호화할 수 없는 노트 비밀번호 초기화 또는 공유 키 변경"
      } satisfies SearchableDecryptedNote;
    }
  });

  if (cache && isCurrent()) {
    cache.clear();
    nextCache.forEach((entry, noteId) => cache.set(noteId, entry));
  }

  return nextNotes.filter((note): note is SearchableDecryptedNote => Boolean(note));
}

function noteCountsFromNotes(notes: DecryptedNote[]) {
  const counts: NoteListCounts = { all: 0, personal: 0, shared: 0 };

  notes.forEach((note) => {
    counts.all += 1;
    counts[note.type] += 1;
  });

  return counts;
}

function clampUploadPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

function attachmentUploadOverallPercent(fileIndex: number, fileCount: number, filePercent: number) {
  if (fileCount <= 0) {
    return 0;
  }

  const completedFiles = Math.max(0, fileIndex - 1);

  return clampUploadPercent(((completedFiles + clampUploadPercent(filePercent) / 100) / fileCount) * 100);
}

function nextAttachmentUploadRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function NotesPage() {
  const { profile, privateKey } = useAuth();
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [deletedNotes, setDeletedNotes] = useState<NoteSnapshot[]>([]);
  const [decryptedNotes, setDecryptedNotes] = useState<DecryptedNote[]>([]);
  const [decryptedDeletedNotes, setDecryptedDeletedNotes] = useState<DecryptedNote[]>([]);
  const [folders, setFolders] = useState<NoteFolderSnapshot[]>([]);
  const [noteStateMap, setNoteStateMap] = useState<NoteStateByNoteId>({});
  const [localSharedReadMap, setLocalSharedReadMap] = useState<Record<string, number>>({});
  const [activeCursorStates, setActiveCursorStates] = useState<NoteUserStateSnapshot[]>([]);
  const [cursorClock, setCursorClock] = useState(() => Date.now());
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [activeNote, setActiveNote] = useState<ActiveNoteDocument | null>(null);
  const [editor, setEditor] = useState<EditorState>(() => blankEditor(profile?.uid ?? ""));
  const [status, setStatus] = useState("준비됨");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attachmentActionBusy, setAttachmentActionBusy] = useState<AttachmentActionBusyState>(idleAttachmentActionBusyState);
  const [attachmentUploadProgress, setAttachmentUploadProgress] = useState<AttachmentUploadProgressState | null>(null);
  const [attachments, setAttachments] = useState<NoteAttachmentSnapshot[]>([]);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewFolderFilter, setOverviewFolderFilter] = useState<OverviewFolderFilter>("all");
  const [shareOpen, setShareOpen] = useState(false);
  const [publicShareOpen, setPublicShareOpen] = useState(false);
  const [publicShareBusy, setPublicShareBusy] = useState(false);
  const [publicShareError, setPublicShareError] = useState<string | null>(null);
  const [publicShareCopied, setPublicShareCopied] = useState(false);
  const [ownerPublicShares, setOwnerPublicShares] = useState<PublicNoteShareSnapshot[]>([]);
  const [publicShareUrlById, setPublicShareUrlById] = useState<Record<string, string>>({});
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [noteSort, setNoteSort] = useState<NoteSortSetting>(defaultNoteSort);
  const [noteFilter, setNoteFilter] = useState<NoteListFilter>(defaultNoteFilter);
  const [noteQuery, setNoteQuery] = useState("");
  const latestEditorRef = useRef(editor);
  const autosaveTimer = useRef<number | null>(null);
  const saveInFlightRef = useRef<Promise<PersistedNoteResult | null> | null>(null);
  const saveQueuedRef = useRef(false);
  const saveCurrentNoteRef = useRef<(showSavedMessage?: boolean) => Promise<PersistedNoteResult | null>>(async () => null);
  const flushCurrentNoteSaveRef = useRef<(showSavedMessage?: boolean, syncPublicShare?: boolean) => Promise<PersistedNoteResult | null>>(
    async () => null
  );
  const attachmentUploadInFlightRef = useRef(false);
  const cursorPublishTimer = useRef<number | null>(null);
  const lastPublishedCursor = useRef<string | null>(null);
  const memoEditorRef = useRef<HTMLDivElement | null>(null);
  const pendingLocalEcho = useRef<{ noteId: string; draft: NoteDraft; createdAt: number } | null>(null);
  const appliedRemoteRevision = useRef<{ noteId: string; signature: string } | null>(null);
  const revisionConflictNoteId = useRef<string | null>(null);
  const activeNoteClientId = useRef(getActiveNoteClientId());
  const attachmentPreviewUrl = useRef<string | null>(null);
  const attachmentPreviewGeneration = useRef(0);
  const attachmentDownloadGeneration = useRef(0);
  const stoppingDeletedPublicShares = useRef(new Set<string>());
  const resolvingPublicShareUrls = useRef(new Set<string>());
  const migratingLegacyPublicShares = useRef(new Set<string>());
  const inspectedPublicShareFilenameGenerations = useRef(new Set<string>());
  const migrateLegacyPublicShareRef = useRef<(share: PublicNoteShareSnapshot, note: DecryptedNote) => Promise<void>>(async () => undefined);
  const decryptedNoteCache = useRef<DecryptedNoteCache>(new Map());
  const decryptedDeletedNoteCache = useRef<DecryptedNoteCache>(new Map());
  const visibleDecryptionGeneration = useRef(0);
  const deletedDecryptionGeneration = useRef(0);
  const visibleNoteOwnerUids = useMemo(() => {
    if (!profile || profile.isAdmin) {
      return [];
    }

    return Array.from(
      new Set([
        profile.uid,
        ...users
          .filter((user) => {
            if (user.uid === profile.uid) {
              return true;
            }

            if (user.isAdmin) {
              return user.isActive;
            }

            return Boolean(user.allowedShareTargetUids?.includes(profile.uid));
          })
          .map((user) => user.uid)
      ])
    );
  }, [profile, users]);
  const noteStateIdKey = useMemo(
    () => Array.from(new Set([...notes, ...deletedNotes].map((note) => note.id))).sort().join("\n"),
    [deletedNotes, notes]
  );

  useEffect(() => {
    latestEditorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    const uid = profile?.uid;

    if (!uid || !privateKey) {
      return undefined;
    }

    return () => clearStoredPublicShareSecrets(uid);
  }, [privateKey, profile]);

  useEffect(() => {
    if (profile && privateKey) {
      return;
    }

    const uid = profile?.uid;
    const activeNoteId = latestEditorRef.current.noteId;

    if (uid) {
      void publishActiveNote(uid, null, activeNoteClientId.current).catch(() => undefined);

      if (activeNoteId) {
        void publishNoteCursor(activeNoteId, uid, activeNoteClientId.current, null, false).catch(() => undefined);
      }
    }

    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }

    if (cursorPublishTimer.current) {
      window.clearTimeout(cursorPublishTimer.current);
      cursorPublishTimer.current = null;
    }

    if (attachmentPreviewUrl.current) {
      URL.revokeObjectURL(attachmentPreviewUrl.current);
      attachmentPreviewUrl.current = null;
    }

    attachmentPreviewGeneration.current += 1;
    attachmentDownloadGeneration.current += 1;

    clearStoredPublicShareSecrets(uid);
    decryptedNoteCache.current.clear();
    decryptedDeletedNoteCache.current.clear();
    visibleDecryptionGeneration.current += 1;
    deletedDecryptionGeneration.current += 1;
    pendingLocalEcho.current = null;
    appliedRemoteRevision.current = null;
    revisionConflictNoteId.current = null;
    saveQueuedRef.current = false;
    lastPublishedCursor.current = null;
    stoppingDeletedPublicShares.current.clear();
    resolvingPublicShareUrls.current.clear();
    migratingLegacyPublicShares.current.clear();
    inspectedPublicShareFilenameGenerations.current.clear();

    setNotes([]);
    setDeletedNotes([]);
    setDecryptedNotes([]);
    setDecryptedDeletedNotes([]);
    setFolders([]);
    setNoteStateMap({});
    setLocalSharedReadMap({});
    setActiveCursorStates([]);
    setUsers([]);
    setActiveNote(null);
    setEditor(blankEditor(uid ?? ""));
    setAttachments([]);
    setAttachmentPreview(null);
    setAttachmentUploadProgress(null);
    setAttachmentActionBusy(idleAttachmentActionBusyState);
    setOwnerPublicShares([]);
    setPublicShareUrlById({});
    setListOpen(false);
    setOverviewOpen(false);
    setShareOpen(false);
    setPublicShareOpen(false);
    setPreviewNoteId(null);
    setPublicShareCopied(false);
    setPublicShareError(null);
    setError(null);
    setSaving(false);
    setStatus(profile ? "암호화 키가 잠겼습니다." : "준비됨");
  }, [privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey) {
      setNotes([]);
      return undefined;
    }

    return subscribeVisibleNotes(profile.uid, profile.isAdmin ? null : visibleNoteOwnerUids, setNotes, () =>
      setError("노트 목록을 불러오지 못했습니다.")
    );
  }, [privateKey, profile, visibleNoteOwnerUids]);

  useEffect(() => {
    if (!profile || !privateKey) {
      setDeletedNotes([]);
      return undefined;
    }

    return subscribeDeletedNotes(profile.uid, profile.isAdmin ? null : visibleNoteOwnerUids, setDeletedNotes, () =>
      setError("복구함을 불러오지 못했습니다.")
    );
  }, [privateKey, profile, visibleNoteOwnerUids]);

  useEffect(() => {
    if (!profile || !privateKey) {
      setActiveNote(null);
      return undefined;
    }

    return subscribeActiveNote(profile.uid, setActiveNote, () => setError("활성 노트 상태를 불러오지 못했습니다."));
  }, [privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey) {
      setUsers([]);
      return undefined;
    }

    return subscribeUsers(setUsers, () => setError("사용자 목록을 불러오지 못했습니다."));
  }, [privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey) {
      setFolders([]);
      return undefined;
    }

    return subscribeNoteFolders(profile.uid, setFolders, () => setError("폴더 목록을 불러오지 못했습니다."));
  }, [privateKey, profile]);

  useEffect(() => {
    return () => {
      attachmentPreviewGeneration.current += 1;
      attachmentDownloadGeneration.current += 1;

      if (attachmentPreviewUrl.current) {
        URL.revokeObjectURL(attachmentPreviewUrl.current);
        attachmentPreviewUrl.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cursorPublishTimer.current) {
        window.clearTimeout(cursorPublishTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!privateKey || !editor.noteId) {
      setAttachments([]);
      return undefined;
    }

    return subscribeNoteAttachments(editor.noteId, setAttachments, () => setError("첨부파일 목록을 불러오지 못했습니다."));
  }, [editor.noteId, privateKey]);

  useEffect(() => {
    if (!profile) {
      setNoteSort(defaultNoteSort);
      setNoteFilter(defaultNoteFilter);
      return;
    }

    setNoteSort(readNoteSortSetting(profile.uid));
    setNoteFilter(readNoteFilter(profile.uid));
  }, [profile]);

  useEffect(() => {
    const currentProfile = profile;
    const currentPrivateKey = privateKey;
    const generation = visibleDecryptionGeneration.current + 1;
    visibleDecryptionGeneration.current = generation;

    if (!currentProfile || !currentPrivateKey) {
      decryptedNoteCache.current.clear();
      setDecryptedNotes([]);
      return;
    }

    const safeProfile = currentProfile;
    const safePrivateKey = currentPrivateKey;
    let cancelled = false;

    async function decryptNotes() {
      const nextNotes = await decryptNoteSnapshots(
        notes,
        safeProfile.uid,
        safePrivateKey,
        decryptedNoteCache.current,
        () => !cancelled && visibleDecryptionGeneration.current === generation
      );

      if (!cancelled && visibleDecryptionGeneration.current === generation) {
        setDecryptedNotes(nextNotes);
      }
    }

    void decryptNotes();
    return () => {
      cancelled = true;
    };
  }, [notes, privateKey, profile]);

  useEffect(() => {
    const currentProfile = profile;
    const currentPrivateKey = privateKey;
    const generation = deletedDecryptionGeneration.current + 1;
    deletedDecryptionGeneration.current = generation;

    if (!currentProfile || !currentPrivateKey) {
      decryptedDeletedNoteCache.current.clear();
      setDecryptedDeletedNotes([]);
      return;
    }

    const safeProfile = currentProfile;
    const safePrivateKey = currentPrivateKey;
    let cancelled = false;

    async function decryptNotes() {
      const nextNotes = await decryptNoteSnapshots(
        deletedNotes,
        safeProfile.uid,
        safePrivateKey,
        decryptedDeletedNoteCache.current,
        () => !cancelled && deletedDecryptionGeneration.current === generation
      );

      if (!cancelled && deletedDecryptionGeneration.current === generation) {
        setDecryptedDeletedNotes(nextNotes);
      }
    }

    void decryptNotes();
    return () => {
      cancelled = true;
    };
  }, [deletedNotes, privateKey, profile]);

  useEffect(() => {
    const uid = profile?.uid;

    if (!uid || !privateKey) {
      setNoteStateMap({});
      return undefined;
    }

    const noteIds = noteStateIdKey ? noteStateIdKey.split("\n") : [];
    return subscribeMyNoteStates(uid, noteIds, setNoteStateMap, () =>
      setError("노트 개인 상태를 불러오지 못했습니다.")
    );
  }, [noteStateIdKey, privateKey, profile?.uid]);

  useEffect(() => {
    const draft = {
      title: editor.title,
      body: editor.body,
      fontSize: editor.fontSize
    };

    if (
      !editor.dirty ||
      !profile ||
      saving ||
      (editor.noteId !== null && revisionConflictNoteId.current === editor.noteId) ||
      (!editor.noteId && !draftHasContent(draft))
    ) {
      return undefined;
    }

    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }

    autosaveTimer.current = window.setTimeout(() => {
      void saveCurrentNoteRef.current(false);
    }, autosaveDelayMs);

    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
  }, [
    editor.baseRevision,
    editor.title,
    editor.body,
    editor.fontSize,
    editor.participantUids,
    editor.dirty,
    editor.noteId,
    editor.noteKey,
    profile,
    saving
  ]);

  useEffect(() => {
    function clearAutosaveTimer() {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
    }

    function flushPendingSave() {
      const current = latestEditorRef.current;

      if (!current.dirty || (!current.noteId && !draftHasContent(current))) {
        return;
      }

      clearAutosaveTimer();
      void flushCurrentNoteSaveRef.current(false);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        flushPendingSave();
      }
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      const current = latestEditorRef.current;

      if (!current.dirty || (!current.noteId && !draftHasContent(current))) {
        return;
      }

      flushPendingSave();
      event.preventDefault();
      event.returnValue = "";
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushPendingSave);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      clearAutosaveTimer();
      flushPendingSave();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushPendingSave);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const activeUsers = useMemo(
    () => users.filter((user) => user.isActive && user.publicKeyJwk),
    [users]
  );
  const allowedShareTargetSet = useMemo(() => {
    if (!profile) {
      return new Set<string>();
    }

    return new Set([profile.uid, ...(profile.allowedShareTargetUids ?? [])]);
  }, [profile]);
  const sharePanelUsers = useMemo(
    () =>
      profile?.isAdmin
        ? activeUsers
        : activeUsers.filter(
            (user) =>
              user.uid === profile?.uid || allowedShareTargetSet.has(user.uid) || editor.participantUids.includes(user.uid)
          ),
    [activeUsers, allowedShareTargetSet, editor.participantUids, profile?.isAdmin, profile?.uid]
  );
  const previewNote = useMemo(
    () => [...decryptedNotes, ...decryptedDeletedNotes].find((note) => note.id === previewNoteId) ?? null,
    [decryptedDeletedNotes, decryptedNotes, previewNoteId]
  );
  const noteCounts = useMemo(() => noteCountsFromNotes(decryptedNotes), [decryptedNotes]);
  const trashCounts = useMemo(() => noteCountsFromNotes(decryptedDeletedNotes), [decryptedDeletedNotes]);
  const visibleNotes = useMemo(
    () => sortNotes(filterNotes(decryptedNotes, noteFilter, noteQuery), noteSort, noteStateMap),
    [decryptedNotes, noteFilter, noteQuery, noteSort, noteStateMap]
  );
  const overviewNotes = useMemo(
    () =>
      sortNotes(
        decryptedNotes.filter(
          (note) =>
            (note.type === "personal" && note.ownerUid === profile?.uid) ||
            (note.type === "shared" && note.participantUids.includes(profile?.uid ?? ""))
        ),
        noteSort,
        noteStateMap
      ),
    [decryptedNotes, noteSort, noteStateMap, profile?.uid]
  );
  const sharedAttentionNoteIds = useMemo(() => {
    const uid = profile?.uid ?? "";

    return new Set(
      decryptedNotes
        .filter((note) => {
          const updatedAt = timestampMillisValue(note.updatedAt) ?? 0;
          const locallyReadAt = localSharedReadMap[note.id] ?? 0;
          return locallyReadAt + 500 < updatedAt && noteNeedsSharedAttention(note, noteStateMap[note.id], uid);
        })
        .map((note) => note.id)
    );
  }, [decryptedNotes, localSharedReadMap, noteStateMap, profile?.uid]);
  const sharedAttentionCount = sharedAttentionNoteIds.size;
  const trashNotes = useMemo(
    () => sortDeletedNotes(filterNotes(decryptedDeletedNotes, noteFilter, noteQuery)),
    [decryptedDeletedNotes, noteFilter, noteQuery]
  );
  const activeRemoteNote = useMemo(
    () => decryptedNotes.find((note) => note.id === editor.noteId) ?? null,
    [decryptedNotes, editor.noteId]
  );
  const canManagePublicShare = !editor.noteId || activeRemoteNote?.ownerUid === profile?.uid;
  const publicShares = useMemo(
    () => (editor.noteId ? ownerPublicShares.filter((share) => share.sourceNoteId === editor.noteId) : []),
    [editor.noteId, ownerPublicShares]
  );
  const activePublicShare = useMemo(
    () =>
      publicShares.find(
        (share) =>
          publicShareActive(share, cursorClock)
          && publicShareMatchesSourceRevision(share, notes.find((note) => note.id === share.sourceNoteId))
      ) ?? null,
    [cursorClock, notes, publicShares]
  );
  const activePublicShareUrl = activePublicShare
    ? publicShareUrlById[activePublicShare.id] ?? readStoredPublicShareUrl(profile?.uid ?? "", activePublicShare.id)
    : null;
  const activePublicShareByNoteId = useMemo(() => {
    const nextShares = new Map<string, PublicNoteShareSnapshot>();

    ownerPublicShares.forEach((share) => {
      if (
        !publicShareActive(share, cursorClock)
        || !publicShareMatchesSourceRevision(share, notes.find((note) => note.id === share.sourceNoteId))
      ) {
        return;
      }

      const current = nextShares.get(share.sourceNoteId);
      const currentExpiresAt = current ? dateFromTimestamp(current.expiresAt)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
      const nextExpiresAt = dateFromTimestamp(share.expiresAt)?.getTime() ?? Number.POSITIVE_INFINITY;

      if (!current || nextExpiresAt < currentExpiresAt) {
        nextShares.set(share.sourceNoteId, share);
      }
    });

    return nextShares;
  }, [cursorClock, notes, ownerPublicShares]);

  useEffect(() => {
    const uid = profile?.uid;

    if (!uid || !privateKey) {
      return undefined;
    }

    const cleanupExpiredShares = () => {
      void deleteExpiredPublicSharesForOwner(uid).catch(() => undefined);
    };

    cleanupExpiredShares();
    const intervalId = window.setInterval(cleanupExpiredShares, 60 * 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, [privateKey, profile?.uid]);

  useEffect(() => {
    if (!profile || !privateKey) {
      setOwnerPublicShares([]);
      setPublicShareUrlById({});
      return undefined;
    }

    return subscribePublicSharesForOwner(
      profile.uid,
      (shares) => {
        setOwnerPublicShares(shares);
        setPublicShareUrlById((current) => {
          const nextUrls = { ...current };

          shares.forEach((share) => {
            if (!nextUrls[share.id]) {
              const storedUrl = readStoredPublicShareUrl(profile.uid, share.id);

              if (storedUrl) {
                nextUrls[share.id] = storedUrl;
              }
            }
          });

          return nextUrls;
        });
      },
      () => setPublicShareError("공유 링크 상태를 불러오지 못했습니다.")
    );
  }, [privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey) {
      return;
    }

    ownerPublicShares.forEach((share) => {
      if (
        !publicShareActive(share, cursorClock) ||
        publicShareUrlById[share.id] ||
        readStoredPublicShareUrl(profile.uid, share.id) ||
        !share.ownerWrappedShareKey ||
        resolvingPublicShareUrls.current.has(share.id)
      ) {
        return;
      }

      resolvingPublicShareUrls.current.add(share.id);
      void unwrapNoteKey(share.ownerWrappedShareKey, privateKey)
        .then(exportAesKeyBase64Url)
        .then((shareKeyValue) => {
          const nextUrl = publicShareUrl(share.id, shareKeyValue);

          writeStoredPublicShareUrl(profile.uid, share.id, nextUrl);
          setPublicShareUrlById((current) => ({ ...current, [share.id]: current[share.id] ?? nextUrl }));
        })
        .catch(() => undefined)
        .finally(() => {
          resolvingPublicShareUrls.current.delete(share.id);
        });
    });
  }, [cursorClock, ownerPublicShares, privateKey, profile, publicShareUrlById]);

  useEffect(() => {
    if (!profile || !privateKey) {
      return;
    }

    const deletedNoteIds = new Set(
      decryptedDeletedNotes
        .filter((note) => note.ownerUid === profile.uid)
        .map((note) => note.id)
    );
    const sharesToStop = ownerPublicShares.filter(
      (share) => deletedNoteIds.has(share.sourceNoteId) && !stoppingDeletedPublicShares.current.has(share.id)
    );

    sharesToStop.forEach((share) => {
      stoppingDeletedPublicShares.current.add(share.id);
      void deletePublicNoteShare(share.id)
        .then(() => {
          removeStoredPublicShareUrl(profile.uid, share.id);
          removeStoredPublicShareContentKey(profile.uid, share.id);
          setPublicShareUrlById((current) => {
            const nextUrls = { ...current };
            delete nextUrls[share.id];
            return nextUrls;
          });
        })
        .catch(() => setPublicShareError("복구함으로 이동한 노트의 공유 링크를 중단하지 못했습니다."))
        .finally(() => {
          stoppingDeletedPublicShares.current.delete(share.id);
        });
    });
  }, [decryptedDeletedNotes, ownerPublicShares, privateKey, profile]);
  const resolveNoteKey = useCallback(
    async (noteId: string) => {
      if (!profile || !privateKey) {
        throw new Error("노트 키를 열 수 없습니다.");
      }

      if (editor.noteId === noteId && editor.noteKey) {
        return editor.noteKey;
      }

      const rawNote = [...notes, ...deletedNotes].find((note) => note.id === noteId);
      const wrappedKey = rawNote?.wrappedKeys[profile.uid];

      if (!wrappedKey) {
        throw new Error("노트 복호화 키를 찾을 수 없습니다.");
      }

      return unwrapNoteKey(wrappedKey, privateKey);
    },
    [deletedNotes, editor.noteId, editor.noteKey, notes, privateKey, profile]
  );

  useEffect(() => {
    if (!profile || !privateKey) {
      return;
    }

    ownerPublicShares.forEach((share) => {
      const rawNote = notes.find((note) => note.id === share.sourceNoteId);
      const decryptedNote = decryptedNotes.find((note) => note.id === share.sourceNoteId);
      const attachmentRevisionMismatch = Boolean(
        rawNote
        && share.sourceRevision === (rawNote.revision ?? 0)
        && share.sourceAttachmentRevision !== (rawNote.attachmentRevision ?? 0)
      );
      const needsStructuralMigration =
        share.sourceRevision === undefined
        || share.sourceAttachmentRevision === undefined
        || !share.currentGeneration
        || attachmentRevisionMismatch;
      const inspectionKey = `${share.id}:${share.currentGeneration ?? "legacy"}`;

      if (
        share.ownerUid !== profile.uid
        || !publicShareActive(share, cursorClock)
        || !decryptedNote
        || migratingLegacyPublicShares.current.has(share.id)
      ) {
        return;
      }

      const migrateShare = (filenamePrivacyMigration: boolean) => {
        if (migratingLegacyPublicShares.current.has(share.id)) {
          return;
        }

        const hasMigrationKey = share.passwordHash
          ? Boolean(readStoredPublicShareContentKey(profile.uid, share.id))
          : Boolean(publicShareUrlById[share.id] || readStoredPublicShareUrl(profile.uid, share.id));

        if (!hasMigrationKey) {
          inspectedPublicShareFilenameGenerations.current.delete(inspectionKey);
          setPublicShareError(
            share.passwordHash
              ? "기존 비밀번호 공유 링크는 파일명 보호 업데이트 키가 없어 새 링크를 만들어야 합니다."
              : "기존 공유 링크의 파일명 보호를 준비 중입니다. 잠시 후 다시 시도해주세요."
          );
          return;
        }

        migratingLegacyPublicShares.current.add(share.id);
        void migrateLegacyPublicShareRef.current(share, decryptedNote)
          .then(() => {
            if (filenamePrivacyMigration) {
              setStatus("기존 공유 첨부파일의 이름을 암호화해 보호했습니다.");
            }
          })
          .catch(() => {
            inspectedPublicShareFilenameGenerations.current.delete(inspectionKey);
            setPublicShareError(
              share.passwordHash
                ? "기존 비밀번호 공유 링크는 파일명 보호 업데이트 키가 없어 새 링크를 만들어야 합니다."
                : "기존 공유 링크의 파일명 보호 업데이트에 실패했습니다. 노트를 저장한 뒤 다시 시도해주세요."
            );
          })
          .finally(() => {
            migratingLegacyPublicShares.current.delete(share.id);
          });
      };

      if (needsStructuralMigration) {
        migrateShare(false);
        return;
      }

      const currentGeneration = share.currentGeneration;

      if (!currentGeneration) {
        return;
      }

      if (inspectedPublicShareFilenameGenerations.current.has(inspectionKey)) {
        return;
      }

      inspectedPublicShareFilenameGenerations.current.add(inspectionKey);
      void getOwnerPublicNoteShareAttachments(share.id, currentGeneration)
        .then((attachments) => {
          if (attachments.some((attachment) => attachment.privacyVersion !== 1 || !attachment.encryptedFileName)) {
            migrateShare(true);
          }
        })
        .catch(() => {
          inspectedPublicShareFilenameGenerations.current.delete(inspectionKey);
          setPublicShareError("기존 공유 첨부파일의 파일명 보호 상태를 확인하지 못했습니다.");
        });
    });
  }, [cursorClock, decryptedNotes, notes, ownerPublicShares, privateKey, profile, publicShareUrlById]);
  const activeCursorNoteId = activeRemoteNote?.type === "shared" ? activeRemoteNote.id : null;
  const remoteEditorCursors = useMemo(() => {
    if (!profile || !activeRemoteNote || activeRemoteNote.type !== "shared") {
      return [];
    }

    const usersByUid = new Map(users.map((user) => [user.uid, user]));
    return activeCursorStates
      .filter((state) => {
        if (
          state.uid === profile.uid ||
          state.cursorVisible !== true ||
          typeof state.cursorOffset !== "number" ||
          state.cursorOffset < 0 ||
          state.cursorClientId === activeNoteClientId.current
        ) {
          return false;
        }

        const cursorUpdatedAt = dateFromTimestamp(state.cursorUpdatedAt);
        return freshRemoteCursorTimestamp(cursorUpdatedAt, cursorClock);
      })
      .map((state) => {
        const user = usersByUid.get(state.uid);

        return {
          uid: state.uid,
          displayName: user?.displayName ?? "사용자",
          color: user?.color ?? "#2f7d70",
          cursorOffset: state.cursorOffset ?? 0
        } satisfies RemoteCursorView;
      });
  }, [activeCursorStates, activeRemoteNote, cursorClock, profile, users]);

  useEffect(() => {
    if (!privateKey || !activeCursorNoteId) {
      setActiveCursorStates([]);
      return undefined;
    }

    return subscribeNoteUserStates(activeCursorNoteId, setActiveCursorStates, () =>
      setError("공유 노트 커서 상태를 불러오지 못했습니다.")
    );
  }, [activeCursorNoteId, privateKey]);

  useEffect(() => {
    if (!privateKey || !activeCursorNoteId) {
      return undefined;
    }

    const intervalId = window.setInterval(() => setCursorClock(Date.now()), 5000);
    return () => window.clearInterval(intervalId);
  }, [activeCursorNoteId, privateKey]);

  useEffect(() => {
    if (!activeRemoteNote || !profile) {
      return;
    }

    const remoteDraft = draftFromNote(activeRemoteNote);
    const remoteSignature = noteSyncSignature(activeRemoteNote);
    const remoteRevision = activeRemoteNote.revision ?? 0;
    const pendingEcho = pendingLocalEcho.current;
    const currentDraft = {
      title: editor.title,
      body: editor.body,
      fontSize: editor.fontSize
    };

    if (editor.noteId !== activeRemoteNote.id) {
      return;
    }

    const contentMatches = draftsMatch(editor, remoteDraft);
    const metadataMatches =
      editor.type === activeRemoteNote.type &&
      editor.folderId === (activeRemoteNote.folderId ?? null) &&
      editor.participantUids.join("|") === activeRemoteNote.participantUids.join("|");

    if (contentMatches && metadataMatches) {
      if (pendingEcho?.noteId === activeRemoteNote.id && noteDraftsMatch(remoteDraft, pendingEcho.draft)) {
        pendingLocalEcho.current = null;
      }

      appliedRemoteRevision.current = { noteId: activeRemoteNote.id, signature: remoteSignature };
      revisionConflictNoteId.current = null;
      setEditor((current) =>
        current.noteId === activeRemoteNote.id && current.baseRevision !== remoteRevision
          ? { ...current, baseRevision: remoteRevision }
          : current
      );
      return;
    }

    if (
      appliedRemoteRevision.current?.noteId === activeRemoteNote.id &&
      appliedRemoteRevision.current.signature === remoteSignature
    ) {
      return;
    }

    if (pendingEcho?.noteId === activeRemoteNote.id && noteDraftsMatch(remoteDraft, pendingEcho.draft)) {
      appliedRemoteRevision.current = { noteId: activeRemoteNote.id, signature: remoteSignature };
      revisionConflictNoteId.current = null;

      if (noteDraftsMatch(currentDraft, pendingEcho.draft)) {
        pendingLocalEcho.current = null;
      }

      setEditor((current) =>
        current.noteId === activeRemoteNote.id && current.baseRevision !== remoteRevision
          ? { ...current, baseRevision: remoteRevision }
          : current
      );
      return;
    }

    if (editor.dirty && !contentMatches) {
      return;
    }

    appliedRemoteRevision.current = { noteId: activeRemoteNote.id, signature: remoteSignature };
    revisionConflictNoteId.current = null;
    setEditor((current) => ({
      ...current,
      baseRevision: remoteRevision,
      title: remoteDraft.title,
      body: remoteDraft.body,
      type: activeRemoteNote.type,
      participantUids: activeRemoteNote.participantUids,
      folderId: activeRemoteNote.folderId ?? null,
      fontSize: remoteDraft.fontSize,
      dirty: contentMatches ? current.dirty : false
    }));
    setStatus(activeRemoteNote.type === "shared" ? "공유 노트 변경 사항을 반영했습니다." : "다른 기기 변경 사항을 반영했습니다.");
  }, [
    activeRemoteNote,
    editor,
    editor.body,
    editor.fontSize,
    editor.noteId,
    editor.participantUids,
    editor.title,
    editor.type,
    profile
  ]);

  useEffect(() => {
    if (!activeNote || !profile || !privateKey || activeNote.updatedByClientId === activeNoteClientId.current) {
      return;
    }

    const currentDraft = {
      title: editor.title,
      body: editor.body,
      fontSize: editor.fontSize
    };
    const canReplaceEditor = !editor.dirty || !draftHasContent(currentDraft);

    if (!activeNote.noteId) {
      if (canReplaceEditor && (editor.noteId || draftHasContent(currentDraft))) {
        setEditor(blankEditor(profile.uid));
        setStatus("다른 기기에서 새 노트 작성을 시작했습니다.");
      }

      return;
    }

    if (editor.noteId === activeNote.noteId || !canReplaceEditor) {
      return;
    }

    const noteToOpen = decryptedNotes.find((note) => note.id === activeNote.noteId);

    if (!noteToOpen) {
      return;
    }

    void openNote(noteToOpen, undefined, false);
    setStatus("다른 기기에서 열린 노트를 표시했습니다.");
    // openNote reads the latest unlocked key material; the guards above prevent repeated remote adoption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeNote,
    decryptedNotes,
    editor.body,
    editor.dirty,
    editor.fontSize,
    editor.noteId,
    editor.title,
    privateKey,
    profile
  ]);

  useEffect(() => {
    if (!listOpen || previewNoteId || attachmentPreview) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setListOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attachmentPreview, listOpen, previewNoteId]);

  if (!profile) {
    return null;
  }

  if (!privateKey) {
    return (
      <AppShell>
        <UnlockPanel />
      </AppShell>
    );
  }

  const unlockedProfile = profile;
  const unlockedPrivateKey = privateKey;
  const currentType = noteTypeFromParticipants(editor.participantUids);
  const canEditShareTargets = !editor.noteId || activeRemoteNote?.ownerUid === unlockedProfile.uid;
  const canDeleteCurrentNote = !editor.noteId || (activeRemoteNote ? canDeleteNote(activeRemoteNote) : false);
  const createdDate = dateFromTimestamp(activeRemoteNote?.createdAt);
  const activeNotePinned = activeRemoteNote ? notePinned(activeRemoteNote.id, noteStateMap) : false;

  function announceActiveNote(noteId: string | null) {
    void publishActiveNote(unlockedProfile.uid, noteId, activeNoteClientId.current).catch(() => {
      setError("현재 노트 상태를 다른 기기에 알리지 못했습니다.");
    });
  }

  function acknowledgeSharedAttention(note: DecryptedNote) {
    if (note.type !== "shared" || note.isDeleted) {
      return;
    }

    const updatedAt = timestampMillisValue(note.updatedAt) ?? Date.now();
    setLocalSharedReadMap((current) => ({ ...current, [note.id]: Math.max(current[note.id] ?? 0, updatedAt) }));
  }

  function updateEditor(field: "title" | "body", value: string) {
    setEditor((current) => ({ ...current, [field]: value, dirty: true }));
  }

  function publishEditorCursor(cursorOffset: number | null, cursorVisible: boolean) {
    const noteId = editor.noteId;

    if (!noteId || activeRemoteNote?.type !== "shared" || activeRemoteNote.isDeleted) {
      return;
    }

    const normalizedOffset =
      cursorVisible && typeof cursorOffset === "number" ? Math.min(Math.max(cursorOffset, 0), 500000) : null;
    const signature = `${noteId}:${normalizedOffset ?? "none"}:${cursorVisible ? "visible" : "hidden"}`;

    if (lastPublishedCursor.current === signature) {
      return;
    }

    if (cursorPublishTimer.current) {
      window.clearTimeout(cursorPublishTimer.current);
      cursorPublishTimer.current = null;
    }

    const publish = () => {
      lastPublishedCursor.current = signature;
      void publishNoteCursor(
        noteId,
        unlockedProfile.uid,
        activeNoteClientId.current,
        normalizedOffset,
        cursorVisible && normalizedOffset !== null
      ).catch(() => {
        setError("공유 노트 커서 위치를 저장하지 못했습니다.");
      });
    };

    if (!cursorVisible) {
      publish();
      return;
    }

    cursorPublishTimer.current = window.setTimeout(publish, cursorPublishDelayMs);
  }

  function clearEditorCursor() {
    publishEditorCursor(null, false);
  }

  function openOverview(filter: OverviewFolderFilter = "all") {
    setOverviewFolderFilter(filter);
    setOverviewOpen(true);
    setListOpen(false);
  }

  function returnToEditor() {
    setOverviewOpen(false);
    setListOpen(false);
  }

  function updateFontSize(fontSize: number) {
    setEditor((current) => ({ ...current, fontSize: clampDraftFontSize(fontSize), dirty: true }));
  }

  async function updateEditorFolder(folderId: string | null) {
    if (currentType !== "personal") {
      return;
    }

    setEditor((current) => ({ ...current, folderId, dirty: current.noteId ? current.dirty : true }));

    if (!editor.noteId) {
      return;
    }

    try {
      await updateNoteFolder(editor.noteId, unlockedProfile.uid, folderId);
      setStatus(folderId ? "노트 폴더를 저장했습니다." : "노트를 미분류로 이동했습니다.");
    } catch {
      setEditor((current) => (current.noteId === editor.noteId ? { ...current, folderId: editor.folderId } : current));
      setError("노트 폴더를 저장하지 못했습니다.");
    }
  }

  async function createFolder(name: string, color: string) {
    const trimmedName = name.trim();
    const safeColor = normalizeCustomHexColor(color, folderColorOptions[0]);

    if (!trimmedName) {
      setError("폴더 이름을 입력해주세요.");
      return null;
    }

    try {
      const folderRef = await createNoteFolder(unlockedProfile.uid, trimmedName, safeColor);
      const createdFolder: NoteFolderSnapshot = {
        id: folderRef.id,
        ownerUid: unlockedProfile.uid,
        name: trimmedName,
        color: safeColor,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now()
      };

      setFolders((currentFolders) =>
        currentFolders.some((folder) => folder.id === folderRef.id)
          ? currentFolders
          : [...currentFolders, createdFolder].sort((left, right) => left.name.localeCompare(right.name, "ko"))
      );
      setOverviewFolderFilter(folderRef.id);
      setStatus("폴더를 만들었습니다.");
      setError(null);
      return folderRef.id;
    } catch {
      setError("폴더를 만들지 못했습니다.");
      return null;
    }
  }

  async function removeFolder(folder: NoteFolderSnapshot) {
    const notesInFolder = overviewNotes
      .filter((note) => note.type === "personal" && note.ownerUid === unlockedProfile.uid && note.folderId === folder.id)
      .map((note) => note.id);

    if (!window.confirm(`'${folder.name}' 그룹을 삭제할까요? 그룹 안의 노트는 삭제되지 않고 미분류로 이동합니다.`)) {
      return;
    }

    try {
      await deleteNoteFolder(unlockedProfile.uid, folder.id, notesInFolder);
      setFolders((currentFolders) => currentFolders.filter((currentFolder) => currentFolder.id !== folder.id));

      if (overviewFolderFilter === folder.id) {
        setOverviewFolderFilter("all");
      }

      if (editor.folderId === folder.id) {
        setEditor((current) => ({ ...current, folderId: null, dirty: current.noteId ? current.dirty : true }));
      }

      setStatus("그룹을 삭제했습니다. 해당 노트는 미분류로 이동했습니다.");
      setError(null);
    } catch {
      setError("그룹을 삭제하지 못했습니다.");
    }
  }

  async function updateStoredNoteFolder(note: DecryptedNote, folderId: string | null) {
    if (note.type !== "personal" || note.ownerUid !== unlockedProfile.uid) {
      setError("개인 노트만 폴더를 지정할 수 있습니다.");
      return;
    }

    try {
      await updateNoteFolder(note.id, unlockedProfile.uid, folderId);

      if (editor.noteId === note.id) {
        setEditor((current) => ({ ...current, folderId }));
      }

      setStatus(folderId ? "노트 폴더를 저장했습니다." : "노트를 미분류로 이동했습니다.");
      setError(null);
    } catch {
      setError("노트 폴더를 저장하지 못했습니다.");
    }
  }

  function updateSortSetting(nextSetting: NoteSortSetting) {
    setNoteSort(nextSetting);
    writeNoteSortSetting(unlockedProfile.uid, nextSetting);
  }

  function updateNoteFilter(nextFilter: NoteListFilter) {
    setNoteFilter(nextFilter);
    writeNoteFilter(unlockedProfile.uid, nextFilter);
  }

  async function togglePinnedNote(note: DecryptedNote) {
    const nextPinned = !notePinned(note.id, noteStateMap);

    try {
      await setNotePinned(note.id, unlockedProfile.uid, nextPinned);
      setStatus(nextPinned ? "즐겨찾기에 고정했습니다." : "즐겨찾기를 해제했습니다.");
    } catch {
      setError("즐겨찾기 상태를 저장하지 못했습니다.");
    }
  }

  function previewStoredNote(note: DecryptedNote) {
    if (!note.isDeleted) {
      acknowledgeSharedAttention(note);
      void markNoteRead(note.id, unlockedProfile.uid).catch(() => undefined);
    }

    setPreviewNoteId(note.id);
  }

  async function confirmSharedNote(note: DecryptedNote) {
    if (note.type !== "shared" || note.isDeleted) {
      return;
    }

    try {
      await confirmNoteRead(note.id, unlockedProfile.uid);
      setStatus("공유 노트를 확인 처리했습니다.");
      acknowledgeSharedAttention(note);
    } catch {
      setError("확인 상태를 저장하지 못했습니다.");
    }
  }

  function canDeleteNote(note: DecryptedNote) {
    return (
      note.ownerUid === unlockedProfile.uid ||
      (unlockedProfile.isAdmin && note.type === "shared" && note.participantUids.includes(unlockedProfile.uid))
    );
  }

  function canRestoreNote(note: DecryptedNote) {
    return note.isDeleted === true && canDeleteNote(note);
  }

  function canShareWithUser(uid: string) {
    return unlockedProfile.isAdmin || uid === unlockedProfile.uid || allowedShareTargetSet.has(uid);
  }

  async function confirmLeaveCurrentEditor(targetNoteId: string | null) {
    const current = latestEditorRef.current;

    if (!current.dirty || current.noteId === targetNoteId || !draftHasContent(current)) {
      return true;
    }

    await flushCurrentNoteSave(false);

    if (!latestEditorRef.current.dirty) {
      return true;
    }

    return window.confirm("저장되지 않은 편집 내용이 있습니다. 저장하지 않고 이동할까요?");
  }

  async function openNote(note: DecryptedNote, draftOverride?: NoteDraft, shouldAnnounce = true) {
    if (note.isDeleted) {
      setError("복구함의 노트는 먼저 복구한 뒤 불러올 수 있습니다.");
      return;
    }

    const rawNote = notes.find((current) => current.id === note.id);

    if (!rawNote) {
      return;
    }

    if (!(await confirmLeaveCurrentEditor(note.id))) {
      return;
    }

    try {
      const noteKey = await unwrapNoteKey(rawNote.wrappedKeys[unlockedProfile.uid], unlockedPrivateKey);
      const nextDraft = draftOverride ?? draftFromNote(note);

      if (editor.noteId && editor.noteId !== note.id) {
        clearEditorCursor();
      }

      appliedRemoteRevision.current = { noteId: note.id, signature: noteSyncSignature(note) };
      revisionConflictNoteId.current = null;
      setEditor({
        noteId: note.id,
        baseRevision: note.revision ?? 0,
        title: nextDraft.title,
        body: nextDraft.body,
        type: note.type,
        participantUids: note.participantUids,
        noteKey,
        folderId: note.folderId ?? null,
        fontSize: nextDraft.fontSize,
        dirty: false
      });
      setListOpen(false);
      setOverviewOpen(false);
      setShareOpen(false);
      setPreviewNoteId(null);
      setStatus("노트를 열었습니다.");
      setError(null);
      acknowledgeSharedAttention(note);
      void markNoteRead(note.id, unlockedProfile.uid).catch(() => undefined);

      if (shouldAnnounce) {
        announceActiveNote(note.id);
      }
    } catch {
      setError("이 노트를 열 수 없습니다.");
    }
  }

  function resetEditorToBlank(statusMessage = "새 노트 작성 중") {
    clearEditorCursor();
    revisionConflictNoteId.current = null;
    setEditor(blankEditor(unlockedProfile.uid));
    setShareOpen(false);
    setStatus(statusMessage);
    setError(null);
    announceActiveNote(null);
  }

  async function startNewNote() {
    if (!(await confirmLeaveCurrentEditor(null))) {
      return;
    }

    resetEditorToBlank();
  }

  function toggleParticipant(event: ChangeEvent<HTMLInputElement>) {
    const uid = event.currentTarget.value;
    const checked = event.currentTarget.checked;

    if (checked && !canShareWithUser(uid)) {
      setError("관리자가 허용한 사용자에게만 공유할 수 있습니다.");
      return;
    }

    const previousParticipantUids = editor.participantUids;
    const participantUids = nextParticipantList(previousParticipantUids, uid, checked, unlockedProfile.uid);
    const type = noteTypeFromParticipants(participantUids);

    setEditor((current) => ({
      ...current,
      participantUids,
      type,
      folderId: type === "personal" ? current.folderId : null,
      dirty: current.noteId ? current.dirty : true
    }));

    if (editor.noteId && editor.noteKey) {
      void updateCurrentNoteAccess(
        editor.noteId,
        editor.noteKey,
        editor.baseRevision,
        participantUids,
        previousParticipantUids,
        editor.folderId
      );
    }
  }

  async function wrappedKeysForParticipants(noteKey: CryptoKey, participantUids: string[]) {
    const usersByUid = new Map(activeUsers.map((user) => [user.uid, user]));

    return Object.fromEntries(
      await Promise.all(
        participantUids.map(async (uid) => {
          const user = uid === unlockedProfile.uid ? unlockedProfile : usersByUid.get(uid);

          if (!user?.publicKeyJwk) {
            throw new Error("공유 대상의 암호화 키를 찾을 수 없습니다.");
          }

          return [uid, await wrapNoteKey(noteKey, user.publicKeyJwk)] as const;
        })
      )
    );
  }

  async function updateCurrentNoteAccess(
    noteId: string,
    noteKey: CryptoKey,
    expectedRevision: number,
    participantUids: string[],
    previousParticipantUids: string[],
    previousFolderId: string | null
  ) {
    if (!canEditShareTargets) {
      setError("노트 소유자만 공유 대상을 변경할 수 있습니다.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const wrappedKeys = await wrappedKeysForParticipants(noteKey, participantUids);
      const type = noteTypeFromParticipants(participantUids);
      const result = await updateRevisionedNoteAccess({
        noteId,
        uid: unlockedProfile.uid,
        expectedRevision,
        type,
        participantUids,
        wrappedKeys,
        folderId: type === "personal" ? editor.folderId : null
      });
      revisionConflictNoteId.current = null;
      setEditor((current) =>
        current.noteId === noteId ? { ...current, baseRevision: result.revision } : current
      );
      await syncPublicSharesForNote(
        noteId,
        noteKey,
        {
          title: latestEditorRef.current.title,
          body: latestEditorRef.current.body,
          fontSize: latestEditorRef.current.fontSize
        },
        false,
        result.revision
      );
      setStatus(type === "shared" ? "공유 대상을 저장했습니다." : "개인 노트로 변경했습니다.");
    } catch (error) {
      setEditor((current) =>
        current.noteId === noteId
          ? {
              ...current,
              participantUids: previousParticipantUids,
              type: noteTypeFromParticipants(previousParticipantUids),
              folderId: previousFolderId
            }
          : current
      );
      if (error instanceof NoteRevisionConflictError) {
        revisionConflictNoteId.current = noteId;
      }
      setError(noteMutationErrorMessage(error, "공유 대상을 변경하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  async function openPublicShareDialog() {
    setPublicShareOpen(true);
    setPublicShareCopied(false);
    setPublicShareError(null);
  }

  async function createCurrentPublicShare(password = "") {
    if (publicShareBusy) {
      return;
    }

    if (!canManagePublicShare) {
      setPublicShareError("노트 소유자만 링크 공유를 만들 수 있습니다.");
      return;
    }

    setPublicShareBusy(true);
    setPublicShareError(null);
    setPublicShareCopied(false);

    let createdShareId: string | null = null;

    try {
      const savedNote = await persistCurrentNote(false, false);

      if (!savedNote) {
        throw new Error("노트를 먼저 저장하지 못했습니다.");
      }

      const shareKey = await generateNoteKey();
      const shareKeyValue = await exportAesKeyBase64Url(shareKey);
      const expiresAt = publicShareExpiresAt();
      const currentGeneration = createPublicShareGeneration();
      const trimmedPassword = password.trim();

      if (trimmedPassword && trimmedPassword.length < publicSharePasswordMinLength) {
        throw new Error(`공유 비밀번호는 ${publicSharePasswordMinLength}자 이상 입력해주세요.`);
      }

      const passwordHash = trimmedPassword ? await hashPublicSharePassword(trimmedPassword, shareKeyValue) : undefined;
      const contentKey = passwordHash
        ? await derivePublicShareContentKey(shareKeyValue, trimmedPassword, passwordHash)
        : shareKey;
      const storedContentKeyValue = passwordHash ? await exportAesKeyBase64Url(contentKey) : null;
      const ownerWrappedShareKey = await wrapNoteKey(shareKey, unlockedProfile.publicKeyJwk);
      const [encryptedTitle, encryptedBody] = await Promise.all([
        encryptText(editor.title.trim() || "제목 없음", contentKey),
        encryptText(serializeEditorContent(editor.body, editor.fontSize), contentKey)
      ]);
      const sourceState = await getNoteRevisionState(savedNote.noteId);

      if (sourceState.revision !== savedNote.revision) {
        throw new NoteRevisionConflictError(savedNote.revision, sourceState.revision);
      }

      const noteAttachments = await getNoteAttachments(savedNote.noteId);

      if (noteAttachments.length > publicNoteShareMaxAttachmentCount) {
        throw new Error(`공유 링크에는 첨부파일을 최대 ${publicNoteShareMaxAttachmentCount}개까지 포함할 수 있습니다.`);
      }

      const shareId = await createPublicNoteShare({
        currentGeneration,
        sourceNoteId: savedNote.noteId,
        sourceAttachmentRevision: sourceState.attachmentRevision,
        sourceRevision: sourceState.revision,
        ownerUid: unlockedProfile.uid,
        encryptedTitle,
        encryptedBody,
        ownerWrappedShareKey,
        expiresAt,
        passwordHash
      });
      createdShareId = shareId;

      for (const attachment of noteAttachments) {
        const encryptedAttachmentSource = await getEncryptedNoteAttachmentSource(attachment);
        const [encryptedAttachment, encryptedFileName] = await Promise.all([
          reencryptAttachmentBlob(attachment, savedNote.noteKey, contentKey, encryptedAttachmentSource),
          encryptText(attachmentDownloadName(attachment), contentKey)
        ]);

        await createPublicNoteShareAttachment(shareId, {
          encryptedFileName,
          extension: attachment.extension,
          generation: currentGeneration,
          mimeType: safePublicShareAttachmentMimeType(attachment.extension),
          ownerUid: unlockedProfile.uid,
          originalSize: attachment.originalSize,
          encryptedBlob: encryptedAttachment.blob,
          encryption: encryptedAttachment.metadata,
          expiresAt,
          sourceAttachmentId: attachment.id
        });
      }

      await activatePublicNoteShare(shareId, noteAttachments.length, currentGeneration);

      const nextUrl = publicShareUrl(shareId, shareKeyValue);
      writeStoredPublicShareUrl(unlockedProfile.uid, shareId, nextUrl);
      if (storedContentKeyValue) {
        writeStoredPublicShareContentKey(unlockedProfile.uid, shareId, storedContentKeyValue);
      }
      setPublicShareUrlById((current) => ({ ...current, [shareId]: nextUrl }));
      setStatus("공유 링크를 만들었습니다.");
    } catch (shareError) {
      if (createdShareId) {
        const shareToDelete = createdShareId;
        await deletePublicNoteShare(shareToDelete)
          .catch(() => revokePublicNoteShare(shareToDelete, unlockedProfile.uid))
          .catch(() => undefined);
      }

      setPublicShareError(shareError instanceof Error ? shareError.message : "공유 링크를 만들지 못했습니다.");
    } finally {
      setPublicShareBusy(false);
    }
  }

  async function copyPublicShareUrl() {
    if (!activePublicShareUrl) {
      setPublicShareError("복사할 공유 링크를 찾을 수 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(activePublicShareUrl);
      setPublicShareCopied(true);
      setPublicShareError(null);
      setStatus("공유 링크를 복사했습니다.");
    } catch {
      setPublicShareError("브라우저에서 링크 복사를 허용하지 않았습니다. 링크를 직접 선택해서 복사해주세요.");
    }
  }

  async function stopPublicShare() {
    if (!activePublicShare) {
      setPublicShareError("중단할 공유 링크가 없습니다.");
      return;
    }

    setPublicShareBusy(true);
    setPublicShareError(null);

    try {
      await deletePublicNoteShare(activePublicShare.id);
      removeStoredPublicShareUrl(unlockedProfile.uid, activePublicShare.id);
      removeStoredPublicShareContentKey(unlockedProfile.uid, activePublicShare.id);
      setPublicShareUrlById((current) => {
        const nextUrls = { ...current };
        delete nextUrls[activePublicShare.id];
        return nextUrls;
      });
      setPublicShareCopied(false);
      setStatus("공유 링크를 중단했습니다.");
    } catch {
      setPublicShareError("공유 링크를 중단하지 못했습니다.");
    } finally {
      setPublicShareBusy(false);
    }
  }

  async function setCurrentPublicSharePassword(password: string) {
    const trimmedPassword = password.trim();
    const shareKeyValue = activePublicShareUrl ? publicShareKeyFromUrl(activePublicShareUrl) : null;

    if (!activePublicShare) {
      setPublicShareError("비밀번호를 설정할 공유 링크가 없습니다.");
      return;
    }

    if (!shareKeyValue) {
      setPublicShareError("이 브라우저에는 공유 키가 없어 비밀번호를 변경할 수 없습니다.");
      return;
    }

    if (!trimmedPassword) {
      setPublicShareError("비밀번호를 입력해주세요.");
      return;
    }

    if (trimmedPassword.length < publicSharePasswordMinLength) {
      setPublicShareError(`공유 비밀번호는 ${publicSharePasswordMinLength}자 이상 입력해주세요.`);
      return;
    }

    setPublicShareBusy(true);
    setPublicShareError(null);

    try {
      const passwordHash = await hashPublicSharePassword(trimmedPassword, shareKeyValue);
      const contentKey = await derivePublicShareContentKey(shareKeyValue, trimmedPassword, passwordHash);
      const contentKeyValue = await exportAesKeyBase64Url(contentKey);

      await rewriteCurrentPublicShareContent(activePublicShare, contentKey, passwordHash);
      writeStoredPublicShareContentKey(unlockedProfile.uid, activePublicShare.id, contentKeyValue);
      setPublicShareCopied(false);
      setStatus("공유 비밀번호를 저장했습니다.");
    } catch {
      setPublicShareError("공유 비밀번호를 저장하지 못했습니다.");
    } finally {
      setPublicShareBusy(false);
    }
  }

  async function clearCurrentPublicSharePassword() {
    const shareKeyValue = activePublicShareUrl ? publicShareKeyFromUrl(activePublicShareUrl) : null;

    if (!activePublicShare) {
      setPublicShareError("비밀번호를 해제할 공유 링크가 없습니다.");
      return;
    }

    if (!shareKeyValue) {
      setPublicShareError("이 브라우저에는 공유 키가 없어 비밀번호를 변경할 수 없습니다.");
      return;
    }

    setPublicShareBusy(true);
    setPublicShareError(null);

    try {
      await rewriteCurrentPublicShareContent(activePublicShare, await importAesKeyBase64Url(shareKeyValue), null);
      removeStoredPublicShareContentKey(unlockedProfile.uid, activePublicShare.id);
      setPublicShareCopied(false);
      setStatus("공유 비밀번호를 해제했습니다.");
    } catch {
      setPublicShareError("공유 비밀번호를 해제하지 못했습니다.");
    } finally {
      setPublicShareBusy(false);
    }
  }

  async function rewriteCurrentPublicShareContent(
    share: PublicNoteShareSnapshot,
    contentKey: CryptoKey,
    passwordHash: NonNullable<PublicNoteShareSnapshot["passwordHash"]> | null
  ) {
    const savedNote = await persistCurrentNote(false, false);

    if (!savedNote) {
      throw new Error("노트를 먼저 저장하지 못했습니다.");
    }

    const sourceState = await getNoteRevisionState(savedNote.noteId);

    if (sourceState.revision !== savedNote.revision) {
      throw new NoteRevisionConflictError(savedNote.revision, sourceState.revision);
    }

    await rewritePublicShareContentFromNote(
      share,
      savedNote.noteId,
      savedNote.noteKey,
      savedNote.draft,
      sourceState,
      contentKey,
      passwordHash
    );
  }

  async function rewritePublicShareContentFromNote(
    share: PublicNoteShareSnapshot,
    noteId: string,
    noteKey: CryptoKey,
    draft: NoteDraft,
    sourceState: { attachmentRevision: number; revision: number },
    contentKey: CryptoKey,
    passwordHash: NonNullable<PublicNoteShareSnapshot["passwordHash"]> | null
  ) {
    const expiresAt = dateFromTimestamp(share.expiresAt);

    if (!expiresAt) {
      throw new Error("공유 만료 시간을 확인하지 못했습니다.");
    }

    const [encryptedTitle, encryptedBody] = await Promise.all([
      encryptText(draft.title.trim() || "제목 없음", contentKey),
      encryptText(serializeEditorContent(draft.body, draft.fontSize), contentKey)
    ]);
    const noteAttachments = await getNoteAttachments(noteId);

    if (noteAttachments.length > publicNoteShareMaxAttachmentCount) {
      throw new Error(`공유 링크에는 첨부파일을 최대 ${publicNoteShareMaxAttachmentCount}개까지 포함할 수 있습니다.`);
    }

    const nextGeneration = createPublicShareGeneration();
    const previousGeneration = share.currentGeneration ?? null;
    let nextAttachmentCount = 0;

    try {
      for (const attachment of noteAttachments) {
        const encryptedAttachmentSource = await getEncryptedNoteAttachmentSource(attachment);
        const [encryptedAttachment, encryptedFileName] = await Promise.all([
          reencryptAttachmentBlob(attachment, noteKey, contentKey, encryptedAttachmentSource),
          encryptText(attachmentDownloadName(attachment), contentKey)
        ]);

        await createPublicNoteShareAttachment(share.id, {
          encryptedFileName,
          extension: attachment.extension,
          generation: nextGeneration,
          mimeType: safePublicShareAttachmentMimeType(attachment.extension),
          ownerUid: unlockedProfile.uid,
          originalSize: attachment.originalSize,
          encryptedBlob: encryptedAttachment.blob,
          encryption: encryptedAttachment.metadata,
          expiresAt,
          sourceAttachmentId: attachment.id
        });
        nextAttachmentCount += 1;
      }

      await updatePublicNoteShareContent(share.id, {
        encryptedTitle,
        encryptedBody,
        attachmentCount: nextAttachmentCount,
        currentGeneration: nextGeneration,
        passwordHash,
        sourceAttachmentRevision: sourceState.attachmentRevision,
        sourceRevision: sourceState.revision
      });
    } catch (error) {
      await deletePublicNoteShareAttachments(share.id, nextGeneration).catch(() => undefined);
      throw error;
    }

    await deletePublicNoteShareAttachments(share.id, previousGeneration).catch(() => undefined);
  }

  async function updatePublicShareTextFromNote(
    share: PublicNoteShareSnapshot,
    draft: NoteDraft,
    contentKey: CryptoKey,
    passwordHash: NonNullable<PublicNoteShareSnapshot["passwordHash"]> | null,
    sourceState: { attachmentRevision: number; revision: number }
  ) {
    const [encryptedTitle, encryptedBody] = await Promise.all([
      encryptText(draft.title.trim() || "제목 없음", contentKey),
      encryptText(serializeEditorContent(draft.body, draft.fontSize), contentKey)
    ]);

    await updatePublicNoteShareContent(share.id, {
      encryptedTitle,
      encryptedBody,
      attachmentCount: share.attachmentCount,
      passwordHash,
      sourceAttachmentRevision: sourceState.attachmentRevision,
      sourceRevision: sourceState.revision
    });
  }

  async function publicShareContentKeyForSync(share: PublicNoteShareSnapshot) {
    const shareUrl = publicShareUrlById[share.id] ?? readStoredPublicShareUrl(unlockedProfile.uid, share.id);
    const shareKeyValue = shareUrl ? publicShareKeyFromUrl(shareUrl) : null;

    if (!shareKeyValue) {
      return null;
    }

    if (share.passwordHash) {
      const contentKeyValue = readStoredPublicShareContentKey(unlockedProfile.uid, share.id);

      return contentKeyValue ? importAesKeyBase64Url(contentKeyValue) : null;
    }

    return importAesKeyBase64Url(shareKeyValue);
  }

  async function failClosedPublicShare(share: PublicNoteShareSnapshot) {
    let stopped = false;

    try {
      await revokePublicNoteShare(share.id, unlockedProfile.uid);
      stopped = true;
    } catch {
      try {
        await deletePublicNoteShare(share.id);
        stopped = true;
      } catch {
        // A revision-bound share remains unreadable after a note content mutation even if cleanup is temporarily unavailable.
      }
    }

    removeStoredPublicShareUrl(unlockedProfile.uid, share.id);
    removeStoredPublicShareContentKey(unlockedProfile.uid, share.id);
    setPublicShareUrlById((current) => {
      if (!(share.id in current)) {
        return current;
      }

      const nextUrls = { ...current };
      delete nextUrls[share.id];
      return nextUrls;
    });

    return stopped;
  }

  async function syncPublicSharesForNote(
    noteId: string,
    noteKey: CryptoKey,
    draft: NoteDraft,
    syncAttachments = false,
    sourceRevision?: number
  ) {
    const sharesToSync = ownerPublicShares.filter(
      (share) => share.sourceNoteId === noteId && share.ownerUid === unlockedProfile.uid && publicShareActive(share)
    );

    if (!sharesToSync.length) {
      return;
    }

    const expectedSourceRevision =
      sourceRevision
      ?? [...notes, ...deletedNotes].find((note) => note.id === noteId)?.revision
      ?? 0;
    const sourceState = await getNoteRevisionState(noteId);

    if (sourceState.revision !== expectedSourceRevision) {
      for (const share of sharesToSync) {
        await failClosedPublicShare(share);
      }
      throw new NoteRevisionConflictError(expectedSourceRevision, sourceState.revision);
    }

    let stoppedPasswordProtectedShare = false;
    let syncFailed = false;

    for (const share of sharesToSync) {
      try {
        const contentKey = await publicShareContentKeyForSync(share);

        if (!contentKey) {
          stoppedPasswordProtectedShare = Boolean(share.passwordHash) || stoppedPasswordProtectedShare;
          await failClosedPublicShare(share);
          continue;
        }

        const attachmentsNeedSync =
          syncAttachments
          || share.sourceAttachmentRevision !== sourceState.attachmentRevision
          || !share.currentGeneration;

        if (attachmentsNeedSync) {
          await rewritePublicShareContentFromNote(
            share,
            noteId,
            noteKey,
            draft,
            sourceState,
            contentKey,
            share.passwordHash ?? null
          );
        } else {
          await updatePublicShareTextFromNote(
            share,
            draft,
            contentKey,
            share.passwordHash ?? null,
            sourceState
          );
        }
      } catch {
        syncFailed = true;
        await failClosedPublicShare(share);
      }
    }

    if (stoppedPasswordProtectedShare) {
      setPublicShareError("자동 업데이트 키가 없는 비밀번호 공유 링크를 안전을 위해 중단했습니다. 새 링크를 만들어주세요.");
    }

    if (syncFailed) {
      setPublicShareError("공유 링크 업데이트에 실패해 이전 내용이 노출되지 않도록 링크를 중단했습니다.");
    }
  }

  async function migrateLegacyPublicShare(share: PublicNoteShareSnapshot, note: DecryptedNote) {
    const contentKey = await publicShareContentKeyForSync(share);

    if (!contentKey) {
      throw new Error("기존 공유 링크의 자동 업데이트 키가 없습니다.");
    }

    const [noteKey, sourceState] = await Promise.all([
      resolveNoteKey(note.id),
      getNoteRevisionState(note.id)
    ]);
    const expectedRevision = note.revision ?? 0;

    if (sourceState.revision !== expectedRevision) {
      throw new NoteRevisionConflictError(expectedRevision, sourceState.revision);
    }

    await rewritePublicShareContentFromNote(
      share,
      note.id,
      noteKey,
      draftFromNote(note),
      sourceState,
      contentKey,
      share.passwordHash ?? null
    );
    setStatus("기존 공유 링크를 현재 보안 형식으로 업데이트했습니다.");
  }

  migrateLegacyPublicShareRef.current = migrateLegacyPublicShare;

  async function stopPublicSharesForNote(noteId: string) {
    const sharesToStop = ownerPublicShares.filter(
      (share) => share.sourceNoteId === noteId && share.ownerUid === unlockedProfile.uid
    );

    await Promise.all(
      sharesToStop.map(async (share) => {
        await deletePublicNoteShare(share.id);
        removeStoredPublicShareUrl(unlockedProfile.uid, share.id);
        removeStoredPublicShareContentKey(unlockedProfile.uid, share.id);
      })
    );

    if (sharesToStop.length) {
      setPublicShareUrlById((current) => {
        const nextUrls = { ...current };

        sharesToStop.forEach((share) => {
          delete nextUrls[share.id];
        });

        return nextUrls;
      });
    }
  }

  async function persistCurrentNote(showSavedMessage = true, syncPublicShare = true): Promise<PersistedNoteResult | null> {
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return saveInFlightRef.current;
    }

    const draft = {
      title: editor.title,
      body: editor.body,
      fontSize: editor.fontSize
    };

    setSaving(true);
    const savePromise = (async () => {
      setError(null);

      if (editor.noteId && editor.noteKey) {
        const expectedRevision = editor.baseRevision;
        const previousDraft = activeRemoteNote ? draftFromNote(activeRemoteNote) : null;
        const saveDraft =
          activeRemoteNote?.type === "shared"
            ? sharedNoteDraftForSave(previousDraft, draft, unlockedProfile.uid, activeRemoteNote.ownerUid, users)
            : draft;
        const payload = await encryptNoteDraft(saveDraft, editor.noteKey);
        const [historySummary, historySnapshot] = await Promise.all([
          encryptText(historySummaryFromDraft(previousDraft, saveDraft), editor.noteKey),
          encryptText(historySnapshotFromDraft(saveDraft), editor.noteKey)
        ]);
        const result = await updateRevisionedEncryptedNote({
          noteId: editor.noteId,
          uid: unlockedProfile.uid,
          expectedRevision,
          encryptedTitle: payload.encryptedTitle,
          encryptedBody: payload.encryptedBody,
          changedFields: changedDraftFields(previousDraft, saveDraft),
          readerUids: activeRemoteNote?.participantUids ?? editor.participantUids,
          historySummary,
          historySnapshot
        });
        revisionConflictNoteId.current = null;
        pendingLocalEcho.current = { noteId: editor.noteId, draft: saveDraft, createdAt: Date.now() };
        announceActiveNote(editor.noteId);
        setEditor((current) =>
          current.noteId !== editor.noteId
            ? current
            : draftsMatch(current, draft)
              ? { ...current, baseRevision: result.revision, body: saveDraft.body, dirty: false }
              : { ...current, baseRevision: result.revision }
        );
        if (syncPublicShare) {
          await syncPublicSharesForNote(editor.noteId, editor.noteKey, saveDraft, false, result.revision);
        }
        setStatus(showSavedMessage ? "변경 사항을 저장했습니다." : "자동 저장됨");
        return { noteId: editor.noteId, noteKey: editor.noteKey, draft: saveDraft, revision: result.revision };
      }

      const noteKey = await generateNoteKey();
      const participantUids = Array.from(new Set([unlockedProfile.uid, ...editor.participantUids])).filter(
        (uid) => uid === unlockedProfile.uid || canShareWithUser(uid)
      );
      const type = noteTypeFromParticipants(participantUids);
      const saveDraft = type === "shared" ? sharedNoteDraftForSave(null, draft, unlockedProfile.uid, unlockedProfile.uid, users) : draft;
      const payload = await encryptNoteDraft(saveDraft, noteKey);
      const [historySummary, historySnapshot] = await Promise.all([
        encryptText(historySummaryFromDraft(null, saveDraft), noteKey),
        encryptText(historySnapshotFromDraft(saveDraft), noteKey)
      ]);
      const wrappedKeys = await wrappedKeysForParticipants(noteKey, participantUids);

      const created = await createRevisionedEncryptedNote({
        type,
        ownerUid: unlockedProfile.uid,
        participantUids,
        encryptedTitle: payload.encryptedTitle,
        encryptedBody: payload.encryptedBody,
        wrappedKeys,
        folderId: type === "personal" ? editor.folderId : null,
        historySummary,
        historySnapshot
      });
      revisionConflictNoteId.current = null;
      pendingLocalEcho.current = { noteId: created.noteId, draft: saveDraft, createdAt: Date.now() };

      setEditor((current) => ({
        ...current,
        noteId: created.noteId,
        baseRevision: created.revision,
        noteKey,
        body: saveDraft.body,
        type,
        folderId: type === "personal" ? current.folderId : null,
        dirty: !draftsMatch(current, draft)
      }));
      announceActiveNote(created.noteId);
      if (syncPublicShare) {
        await syncPublicSharesForNote(created.noteId, noteKey, saveDraft);
      }
      setStatus(showSavedMessage ? "노트를 저장 목록에 추가했습니다." : "자동 저장됨");
      return { noteId: created.noteId, noteKey, draft: saveDraft, revision: created.revision };
    })().catch((error: unknown) => {
      if (error instanceof NoteRevisionConflictError && editor.noteId) {
        revisionConflictNoteId.current = editor.noteId;
        pendingLocalEcho.current = null;
        setStatus("저장 충돌이 감지되었습니다.");
      }
      setError(noteMutationErrorMessage(error, "노트를 저장하지 못했습니다."));
      return null;
    });

    saveInFlightRef.current = savePromise;

    try {
      return await savePromise;
    } finally {
      saveInFlightRef.current = null;
      setSaving(false);

      if (saveQueuedRef.current) {
        saveQueuedRef.current = false;

        window.setTimeout(() => {
          const current = latestEditorRef.current;

          if (
            current.dirty &&
            (current.noteId || draftHasContent(current)) &&
            (current.noteId === null || revisionConflictNoteId.current !== current.noteId)
          ) {
            void saveCurrentNoteRef.current(false);
          }
        }, 0);
      }
    }
  }

  async function flushCurrentNoteSave(showSavedMessage = false, syncPublicShare = true) {
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }

    let result: PersistedNoteResult | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = latestEditorRef.current;

      if (!current.dirty || (!current.noteId && !draftHasContent(current))) {
        return result;
      }

      result = await persistCurrentNote(showSavedMessage && attempt === 0, syncPublicShare);

      if (!result && latestEditorRef.current.dirty) {
        return null;
      }
    }

    return result;
  }

  async function saveCurrentNote(showSavedMessage = true) {
    return persistCurrentNote(showSavedMessage);
  }

  saveCurrentNoteRef.current = saveCurrentNote;
  flushCurrentNoteSaveRef.current = flushCurrentNoteSave;

  async function ensureCurrentNoteForAttachment() {
    let savedNote: PersistedNoteResult | null = null;

    if (editor.noteId && editor.noteKey) {
      if (editor.dirty) {
        savedNote = await flushCurrentNoteSave(false, false);

        if (!savedNote && latestEditorRef.current.dirty) {
          throw new Error("노트를 먼저 저장하지 못했습니다.");
        }
      }

      return {
        draft: savedNote?.draft ?? {
          title: latestEditorRef.current.title,
          body: latestEditorRef.current.body,
          fontSize: latestEditorRef.current.fontSize
        },
        noteId: savedNote?.noteId ?? latestEditorRef.current.noteId ?? editor.noteId,
        noteKey: savedNote?.noteKey ?? latestEditorRef.current.noteKey ?? editor.noteKey,
        revision: savedNote?.revision ?? latestEditorRef.current.baseRevision
      };
    }

    const createdNote = await flushCurrentNoteSave(false, false);

    if (!createdNote) {
      throw new Error("노트를 먼저 저장하지 못했습니다.");
    }

    return {
      draft: createdNote.draft,
      noteId: createdNote.noteId,
      noteKey: createdNote.noteKey,
      revision: createdNote.revision
    };
  }

  async function insertPastedFiles(files: File[], insertHtml: RichEditorInsertHtml) {
    const attachmentFiles: File[] = [];

    for (const file of files) {
      if (file.type.startsWith("image/")) {
        await insertImageFile(file, insertHtml);
      } else {
        attachmentFiles.push(file);
      }
    }

    if (attachmentFiles.length) {
      await uploadAttachmentFiles(attachmentFiles);
    }
  }

    async function uploadAttachmentFiles(files: File[], targetNote?: AttachmentNoteTarget) {
      if (attachmentUploadInFlightRef.current) {
        setError("다른 첨부파일 업로드가 끝난 뒤 다시 시도해주세요.");
        return;
      }

      const validFiles: File[] = [];
      const rejectedFiles: string[] = [];
      const runId = nextAttachmentUploadRunId();

    files.forEach((file) => {
      const validationError = attachmentValidationError(file);

      if (validationError) {
        rejectedFiles.push(`${file.name}: ${validationError}`);
      } else {
        validFiles.push(file);
      }
    });

    if (!validFiles.length) {
      setError(rejectedFiles[0] ?? "첨부할 수 있는 파일이 없습니다.");
      return;
    }

      attachmentUploadInFlightRef.current = true;
      setAttachmentUploadProgress({
      fileCount: validFiles.length,
      fileIndex: 1,
      fileName: validFiles[0]?.name ?? "첨부파일",
      loadedBytes: 0,
      overallPercent: 0,
      percent: 0,
      phase: targetNote ? "encrypting" : "preparing",
      runId,
      totalBytes: validFiles[0]?.size ?? 0
    });
    setError(null);
    let uploadSucceeded = false;

    try {
      const noteTarget = targetNote ?? (await ensureCurrentNoteForAttachment());

      for (const [fileIndex, file] of validFiles.entries()) {
        const fileNumber = fileIndex + 1;

        setAttachmentUploadProgress((current) =>
          current?.runId === runId
            ? {
                ...current,
                fileIndex: fileNumber,
                fileName: file.name,
                loadedBytes: 0,
                overallPercent: attachmentUploadOverallPercent(fileNumber, validFiles.length, 0),
                percent: 0,
                phase: "encrypting",
                totalBytes: file.size
              }
            : current
        );

        const encryptedFile = await encryptAttachmentBlob(file, noteTarget.noteKey, (progress) => {
          const loadedBytes = Math.min(progress.total, Math.max(0, progress.loaded));
          const percent = clampUploadPercent(progress.percentage || (progress.total ? (loadedBytes / progress.total) * 100 : 0));

          setAttachmentUploadProgress((current) =>
            current?.runId === runId
              ? {
                  ...current,
                  loadedBytes,
                  overallPercent: attachmentUploadOverallPercent(fileNumber, validFiles.length, percent),
                  percent,
                  phase: "encrypting",
                  totalBytes: progress.total
                }
              : current
          );
        });
        const encryptedSize = encryptedFile.metadata.encryptedSize;

        setAttachmentUploadProgress((current) =>
          current?.runId === runId
            ? {
                ...current,
                loadedBytes: 0,
                overallPercent: attachmentUploadOverallPercent(fileNumber, validFiles.length, 0),
                percent: 0,
                phase: "uploading",
                totalBytes: encryptedSize
              }
            : current
        );

        await createNoteAttachment({
          noteId: noteTarget.noteId,
          fileName: safeAttachmentBaseName(file.name),
          extension: attachmentExtension(file.name),
          mimeType: (file.type || "application/octet-stream").slice(0, 120),
          originalSize: file.size,
          encryptedBlob: encryptedFile.blob,
          encryption: encryptedFile.metadata,
          uploadedBy: unlockedProfile.uid,
          onUploadProgress: (progress) => {
            const totalBytes = progress.total || encryptedSize;
            const loadedBytes = Math.min(totalBytes, Math.max(0, progress.loaded));
            const percent = clampUploadPercent(progress.percentage || (totalBytes ? (loadedBytes / totalBytes) * 100 : 0));

            setAttachmentUploadProgress((current) =>
              current?.runId === runId
                ? {
                    ...current,
                    loadedBytes,
                    overallPercent: attachmentUploadOverallPercent(fileNumber, validFiles.length, percent),
                    percent,
                    phase: "uploading",
                    totalBytes
                  }
                : current
            );
          }
        });

        setAttachmentUploadProgress((current) =>
          current?.runId === runId
            ? {
                ...current,
                loadedBytes: encryptedSize,
                overallPercent: attachmentUploadOverallPercent(fileNumber, validFiles.length, 100),
                percent: 100,
                phase: "finalizing",
                totalBytes: encryptedSize
              }
            : current
        );
      }

      setAttachmentUploadProgress((current) =>
        current?.runId === runId
          ? {
              ...current,
              fileIndex: validFiles.length,
              fileName: validFiles.length === 1 ? validFiles[0].name : `${validFiles.length}개 첨부파일`,
              loadedBytes: current.totalBytes,
              overallPercent: 100,
              percent: 100,
              phase: "syncing"
            }
          : current
      );
      await syncPublicSharesForNote(
        noteTarget.noteId,
        noteTarget.noteKey,
        noteTarget.draft,
        true,
        noteTarget.revision
      );
      uploadSucceeded = true;

      setAttachmentUploadProgress((current) =>
        current?.runId === runId
          ? {
              ...current,
              overallPercent: 100,
              percent: 100,
              phase: "complete"
            }
          : current
      );

        setStatus(
          validFiles.length === 1
            ? `첨부파일을 업로드했습니다. 최대 ${maxAttachmentFileLabel}까지 가능합니다.`
            : `첨부파일 ${validFiles.length}개를 업로드했습니다.`
        );

      if (rejectedFiles.length) {
        setError(`일부 파일은 제외했습니다. ${rejectedFiles[0]}`);
      }
    } catch (error) {
      setAttachmentUploadProgress((current) => (current?.runId === runId ? { ...current, phase: "failed" } : current));
      setError(error instanceof Error ? error.message : "첨부파일을 업로드하지 못했습니다.");
      } finally {
        attachmentUploadInFlightRef.current = false;
        window.setTimeout(
        () => setAttachmentUploadProgress((current) => (current?.runId === runId ? null : current)),
        uploadSucceeded ? attachmentUploadToastClearDelayMs : attachmentUploadFailureClearDelayMs
      );
    }
  }

  async function noteKeyForDownload(noteId: string) {
    return resolveNoteKey(noteId);
  }

  async function decryptAttachmentFile(noteId: string, attachment: NoteAttachmentSnapshot) {
    const noteKey = await noteKeyForDownload(noteId);
    return decryptAttachmentToBytes(attachment, noteKey, await getEncryptedNoteAttachmentSource(attachment));
  }

  async function decryptAttachmentBlob(noteId: string, attachment: NoteAttachmentSnapshot) {
    const noteKey = await noteKeyForDownload(noteId);
    return decryptAttachmentToBlob(attachment, noteKey, await getEncryptedNoteAttachmentSource(attachment));
  }

  function closeAttachmentPreview() {
    attachmentPreviewGeneration.current += 1;

    if (attachmentPreviewUrl.current) {
      URL.revokeObjectURL(attachmentPreviewUrl.current);
      attachmentPreviewUrl.current = null;
    }

    setAttachmentPreview(null);
    setAttachmentActionBusy((current) => ({ ...current, previewingId: null }));
  }

    async function previewAttachment(noteId: string, attachment: NoteAttachmentSnapshot) {
      if (!previewableAttachmentExtensions.has(attachment.extension)) {
        setError("이 파일 형식은 미리보기를 지원하지 않습니다.");
        return;
      }

      const previewGeneration = attachmentPreviewGeneration.current + 1;
      attachmentPreviewGeneration.current = previewGeneration;

      if (attachmentPreviewUrl.current) {
        URL.revokeObjectURL(attachmentPreviewUrl.current);
        attachmentPreviewUrl.current = null;
      }

      setAttachmentPreview(null);

      if (attachment.originalSize > maxAttachmentPreviewBytes) {
        setAttachmentPreview({
          fileName: attachmentDownloadName(attachment),
          kind: "unsupported",
          label: "대용량 파일 미리보기 안내",
          text: `미리보기는 ${maxAttachmentPreviewLabel} 이하 파일만 지원합니다. 원본 파일은 다운로드해서 확인해주세요.`
        });
        return;
      }

      setAttachmentActionBusy((current) => ({ ...current, previewingId: attachment.id }));
      setError(null);

    try {
      const plainBytes = await decryptAttachmentFile(noteId, attachment);

      if (attachmentPreviewGeneration.current !== previewGeneration) {
        return;
      }

      const fileName = attachmentDownloadName(attachment);

      if (attachment.extension === "pdf") {
        const blob = new Blob([plainBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);

        attachmentPreviewUrl.current = url;
        setAttachmentPreview({ bytes: plainBytes, fileName, kind: "pdf", label: "PDF 미리보기", url });
        setStatus("PDF 미리보기를 열었습니다.");
        return;
      }

      if (attachment.extension === "docx") {
        const srcDoc = await renderSafeDocxPreviewSrcDoc(
          plainBytes,
          document.documentElement.dataset.theme === "dark" ? "dark" : "light"
        );

        if (attachmentPreviewGeneration.current !== previewGeneration) {
          return;
        }

        setAttachmentPreview(
          srcDoc
            ? {
                fileName,
                kind: "docx",
                label: "DOCX 양식 미리보기",
                srcDoc
              }
            : {
                fileName,
                kind: "unsupported",
                label: "DOCX 미리보기 안내",
                text: "DOCX 양식 미리보기를 안전하게 만들지 못했습니다. 원본 파일은 다운로드해서 확인해주세요."
              }
        );
        setStatus(srcDoc ? "DOCX 미리보기를 열었습니다." : "안전한 미리보기 안내를 표시했습니다.");
        return;
      }

      if (attachment.extension === "hwp") {
        const preview = await extractHwpPreviewHtml(plainBytes);

        if (attachmentPreviewGeneration.current !== previewGeneration) {
          return;
        }

        setAttachmentPreview(
          preview.html
            ? {
                fileName,
                html: preview.html,
                kind: "html",
                label: "HWP 안전 본문 미리보기"
              }
              : {
                  fileName,
                  kind: "unsupported",
                  label: "HWP 미리보기 안내",
                  text: "HWP 미리보기가 안전 제한을 초과했거나 지원하지 않는 문서입니다. 원본 파일은 다운로드해서 확인해주세요."
                }
        );
        setStatus(preview.html ? "HWP 안전 본문 미리보기를 열었습니다." : "안전한 미리보기 안내를 표시했습니다.");
        return;
      }

      if (attachment.extension === "hwpx") {
        const previewHtml = extractHwpxPreviewHtml(plainBytes);

        setAttachmentPreview({
          fileName,
          html: previewHtml,
          kind: previewHtml ? "html" : "unsupported",
          label: "HWPX 문서 미리보기",
          text: previewHtml ? undefined : "HWPX 문서에서 안전하게 표시할 본문을 찾지 못했습니다."
        });
        setStatus(previewHtml ? "HWPX 미리보기를 열었습니다." : "안전한 미리보기 안내를 표시했습니다.");
        return;
      }

      if (attachment.extension === "xlsx") {
        const previewHtml = extractXlsxPreviewHtml(plainBytes);

        setAttachmentPreview({
          fileName,
          html: previewHtml,
          kind: previewHtml ? "html" : "unsupported",
          label: "XLSX 스프레드시트 미리보기",
          text: previewHtml ? undefined : "XLSX 파일에서 안전하게 표시할 시트 내용을 찾지 못했습니다."
        });
        setStatus(previewHtml ? "XLSX 미리보기를 열었습니다." : "안전한 미리보기 안내를 표시했습니다.");
        return;
      }

      if (textPreviewAttachmentExtensions.has(attachment.extension)) {
        setAttachmentPreview({
          fileName,
          kind: "text",
          label: `${attachment.extension.toUpperCase()} 미리보기`,
          text: decodeTextAttachmentPreview(plainBytes, attachment.extension)
        });
        setStatus("파일 미리보기를 열었습니다.");
        return;
      }

      if (legacyBinaryPreviewAttachmentExtensions.has(attachment.extension)) {
        setAttachmentPreview({
          fileName,
          kind: "unsupported",
          label: `${attachment.extension.toUpperCase()} 미리보기 안내`,
          text: legacyBinaryPreviewMessage(attachment.extension)
        });
        setStatus("안전한 미리보기 안내를 표시했습니다.");
        return;
      }

      setAttachmentPreview({
        fileName,
        kind: "unsupported",
        label: "미리보기",
        text: "이 파일 형식은 앱 내부 미리보기를 지원하지 않습니다."
      });
    } catch {
      if (attachmentPreviewGeneration.current === previewGeneration) {
        setError("파일 미리보기를 열지 못했습니다.");
      }
      } finally {
        if (attachmentPreviewGeneration.current === previewGeneration) {
          setAttachmentActionBusy((current) => ({
            ...current,
            previewingId: current.previewingId === attachment.id ? null : current.previewingId
          }));
        }
      }
    }

    async function downloadAttachment(noteId: string, attachment: NoteAttachmentSnapshot) {
      const downloadGeneration = attachmentDownloadGeneration.current + 1;
      attachmentDownloadGeneration.current = downloadGeneration;
      setAttachmentActionBusy((current) => ({ ...current, downloadingId: attachment.id }));
      setError(null);

    try {
      const blob = await decryptAttachmentBlob(noteId, attachment);

      if (attachmentDownloadGeneration.current !== downloadGeneration) {
        return;
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachmentDownloadName(attachment);
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("첨부파일 다운로드를 시작했습니다.");
    } catch {
      if (attachmentDownloadGeneration.current === downloadGeneration) {
        setError("첨부파일을 다운로드하지 못했습니다.");
      }
      } finally {
        if (attachmentDownloadGeneration.current === downloadGeneration) {
          setAttachmentActionBusy((current) => ({
            ...current,
            downloadingId: current.downloadingId === attachment.id ? null : current.downloadingId
          }));
        }
      }
    }

  async function uploadPreviewAttachments(note: DecryptedNote, files: File[]) {
    try {
      const noteKey = await noteKeyForDownload(note.id);
      await uploadAttachmentFiles(files, {
        draft: draftFromNote(note),
        noteId: note.id,
        noteKey,
        revision: note.revision ?? 0
      });
    } catch {
      setError("첨부파일을 업로드하지 못했습니다.");
    }
  }

  function canDeleteAttachmentForNote(note: DecryptedNote, attachment: NoteAttachmentSnapshot) {
    return canDeleteNote(note) || attachment.uploadedBy === unlockedProfile.uid;
  }

    async function removeAttachment(note: DecryptedNote, attachment: NoteAttachmentSnapshot) {
      if (!canDeleteAttachmentForNote(note, attachment)) {
        setError("첨부파일 업로드 사용자, 노트 소유자 또는 관리자만 삭제할 수 있습니다.");
        return false;
      }

      setAttachmentActionBusy((current) => ({
        ...current,
        deletingIds: Array.from(new Set([...current.deletingIds, attachment.id]))
      }));
      setError(null);

      try {
        const noteKey = await noteKeyForDownload(note.id);
        await deleteNoteAttachment(note.id, attachment.id);
        setAttachments((current) => current.filter((currentAttachment) => currentAttachment.id !== attachment.id));
        await syncPublicSharesForNote(
          note.id,
          noteKey,
          draftFromNote(note),
          true,
          note.revision ?? 0
        );
        setStatus("첨부파일을 삭제했습니다.");
        return true;
      } catch {
        setError("첨부파일을 삭제하지 못했습니다.");
        return false;
      } finally {
        setAttachmentActionBusy((current) => ({
          ...current,
          deletingIds: current.deletingIds.filter((id) => id !== attachment.id)
        }));
      }
    }

    async function removeCurrentNote() {
      if (!editor.noteId) {
        void startNewNote();
        return;
      }

    if (!activeRemoteNote || !canDeleteNote(activeRemoteNote)) {
      setError("노트 소유자 또는 참여 중인 관리자만 삭제할 수 있습니다.");
      return;
    }

    setSaving(true);

    try {
        await deleteRevisionedNote({
          noteId: editor.noteId,
          uid: unlockedProfile.uid,
          expectedRevision: editor.baseRevision,
          readerUids: activeRemoteNote.participantUids
        });
        await stopPublicSharesForNote(editor.noteId);
        resetEditorToBlank();
        setStatus("노트를 삭제했습니다.");
    } catch (error) {
      if (error instanceof NoteRevisionConflictError) {
        revisionConflictNoteId.current = editor.noteId;
      }
      setError(noteMutationErrorMessage(error, "노트를 삭제하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  async function removePreviewNote(note: DecryptedNote) {
    if (!canDeleteNote(note)) {
      const errorMessage = "노트 소유자 또는 참여 중인 관리자만 삭제할 수 있습니다.";
      setError(errorMessage);
      return errorMessage;
    }

    setSaving(true);
    setError(null);

    try {
      await deleteRevisionedNote({
        noteId: note.id,
        uid: unlockedProfile.uid,
        expectedRevision: note.revision ?? 0,
        readerUids: note.participantUids
      });
      await stopPublicSharesForNote(note.id);
        setPreviewNoteId(null);

        if (editor.noteId === note.id) {
          resetEditorToBlank();
      }

      setStatus("노트를 삭제했습니다.");
      return null;
    } catch (error) {
      const errorMessage = noteMutationErrorMessage(error, "노트를 삭제하지 못했습니다.");
      setError(errorMessage);
      return errorMessage;
    } finally {
      setSaving(false);
    }
  }

  async function restorePreviewNote(note: DecryptedNote) {
    if (!canRestoreNote(note)) {
      const errorMessage = "노트 소유자 또는 관리자만 복구할 수 있습니다.";
      setError(errorMessage);
      return errorMessage;
    }

    setSaving(true);
    setError(null);

    try {
      await restoreRevisionedNote({
        noteId: note.id,
        uid: unlockedProfile.uid,
        expectedRevision: note.revision ?? 0,
        readerUids: note.participantUids
      });
      setPreviewNoteId(null);
      setStatus("노트를 복구했습니다.");
      return null;
    } catch (error) {
      const errorMessage = noteMutationErrorMessage(error, "노트를 복구하지 못했습니다.");
      setError(errorMessage);
      return errorMessage;
    } finally {
      setSaving(false);
    }
  }

  async function purgePreviewNote(note: DecryptedNote) {
    if (!note.isDeleted || !canDeleteNote(note)) {
      setError("복구함의 노트 소유자 또는 참여 중인 관리자만 즉시 삭제할 수 있습니다.");
      return;
    }

    const confirmed = window.confirm(
      `"${note.title || "제목 없음"}" 노트를 즉시 삭제할까요?\n첨부파일과 수정 이력을 정리하고, 노트 내용은 복구할 수 없도록 지웁니다.`
    );

    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await purgeDeletedNote(note);
      setPreviewNoteId(null);

      if (editor.noteId === note.id) {
        resetEditorToBlank();
      }

      setStatus("노트 접근을 즉시 차단했고 서버에서 잔여 암호화 데이터를 정리합니다.");
    } catch {
      setError("노트를 즉시 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function purgeDeletedNote(note: DecryptedNote) {
    await stopPublicSharesForNote(note.id);

    const tombstoneKey = await generateNoteKey();
    const [redactedPayload, wrappedKey] = await Promise.all([
      encryptNoteDraft(purgedDraft(), tombstoneKey),
      wrapNoteKey(tombstoneKey, unlockedProfile.publicKeyJwk)
    ]);

    await purgeNote({
      noteId: note.id,
      ownerUid: note.ownerUid,
      uid: unlockedProfile.uid,
      encryptedTitle: redactedPayload.encryptedTitle,
      encryptedBody: redactedPayload.encryptedBody,
      wrappedKey
    });
  }

  async function purgeDeletedNotes(notesToPurge: DecryptedNote[]) {
    const purgeableNotes = notesToPurge.filter((note) => note.isDeleted && canDeleteNote(note));

    if (!purgeableNotes.length) {
      setError("즉시 삭제할 수 있는 복구함 노트가 없습니다.");
      return;
    }

    const confirmed = window.confirm(
      `복구함의 노트 ${purgeableNotes.length}개를 즉시 삭제할까요?\n첨부파일과 수정 이력을 정리하고, 노트 내용은 복구할 수 없도록 지웁니다.`
    );

    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      for (const note of purgeableNotes) {
        await purgeDeletedNote(note);
      }

        if (editor.noteId && purgeableNotes.some((note) => note.id === editor.noteId)) {
          resetEditorToBlank();
        }

      setPreviewNoteId(null);
      setStatus(`복구함 노트 ${purgeableNotes.length}개의 접근을 차단했고 서버 정리를 시작했습니다.`);
    } catch {
      setError("복구함 전체삭제를 완료하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function savePreviewNote(
    note: DecryptedNote,
    draft: NoteDraft,
    expectedRevision: number
  ): Promise<PreviewNoteSaveResult> {
    if (saving) {
      return { revision: null, error: "다른 저장 작업이 끝난 뒤 다시 시도해주세요." };
    }

    const rawNote = notes.find((current) => current.id === note.id);

    if (!rawNote) {
      setError("이 노트를 저장할 수 없습니다.");
      return { revision: null, error: "이 노트를 저장할 수 없습니다." };
    }

    setSaving(true);
    setError(null);

    try {
      const noteKey = await unwrapNoteKey(rawNote.wrappedKeys[unlockedProfile.uid], unlockedPrivateKey);
      const previousDraft = draftFromNote(note);
      const saveDraft =
        note.type === "shared" ? sharedNoteDraftForSave(previousDraft, draft, unlockedProfile.uid, note.ownerUid, users) : draft;
      const payload = await encryptNoteDraft(saveDraft, noteKey);
      const [historySummary, historySnapshot] = await Promise.all([
        encryptText(historySummaryFromDraft(previousDraft, saveDraft), noteKey),
        encryptText(historySnapshotFromDraft(saveDraft), noteKey)
      ]);

      const result = await updateRevisionedEncryptedNote({
        noteId: note.id,
        uid: unlockedProfile.uid,
        expectedRevision,
        encryptedTitle: payload.encryptedTitle,
        encryptedBody: payload.encryptedBody,
        changedFields: changedDraftFields(previousDraft, saveDraft),
        readerUids: note.participantUids,
        historySummary,
        historySnapshot
      });
      revisionConflictNoteId.current = null;
      announceActiveNote(note.id);
      await syncPublicSharesForNote(note.id, noteKey, saveDraft, false, result.revision);

      const currentEditor = latestEditorRef.current;
      const preserveIndependentEditorDraft =
        currentEditor.noteId === note.id && currentEditor.dirty && !draftsMatch(currentEditor, saveDraft);

      if (preserveIndependentEditorDraft) {
        pendingLocalEcho.current = null;
        revisionConflictNoteId.current = note.id;
      } else if (currentEditor.noteId === note.id) {
        pendingLocalEcho.current = { noteId: note.id, draft: saveDraft, createdAt: Date.now() };
        setEditor((current) => ({
          ...current,
          title: saveDraft.title,
          body: saveDraft.body,
          fontSize: saveDraft.fontSize,
          noteKey,
          baseRevision: result.revision,
          dirty: false
        }));
      } else {
        pendingLocalEcho.current = { noteId: note.id, draft: saveDraft, createdAt: Date.now() };
      }

      setStatus(
        preserveIndependentEditorDraft
          ? "팝업 변경 사항을 저장했고, 편집기에 있던 별도 초안은 그대로 유지했습니다."
          : "팝업에서 변경 사항을 저장했습니다."
      );
      return { revision: result.revision };
    } catch (error) {
      const errorMessage = noteMutationErrorMessage(error, "노트를 저장하지 못했습니다.");
      if (error instanceof NoteRevisionConflictError) {
        revisionConflictNoteId.current = note.id;
      }
      setError(errorMessage);
      return { revision: null, error: errorMessage };
    } finally {
      setSaving(false);
    }
  }

  async function insertImageFile(file: File, insertHtml: RichEditorInsertHtml) {
    try {
      const dataUrl = await imageFileToResizedDataUrl(file);

      if (dataUrl.length > maxImageDataUrlLength) {
        setError("이미지 용량이 큽니다. 더 작은 이미지를 선택해주세요.");
        return;
      }

      const html = imageHtml(dataUrl, file.name);
      const nextHtml = insertHtml(html);
      setEditor((current) => ({ ...current, body: nextHtml ?? `${current.body}${html}`, dirty: true }));
      setError(null);
    } catch {
      setError("붙여넣은 이미지를 넣지 못했습니다.");
    }
  }

  return (
    <AppShell onNavigateHome={returnToEditor}>
      <section className="workspace notes-workspace">
        {overviewOpen ? (
          <PersonalOverview
            activeFolderFilter={overviewFolderFilter}
            attentionNoteIds={sharedAttentionNoteIds}
            clockMs={cursorClock}
            folders={folders}
            feedbackError={error}
            feedbackStatus={status}
            noteStates={noteStateMap}
            notes={overviewNotes}
            sortSetting={noteSort}
            onBack={returnToEditor}
            onCreateFolder={createFolder}
            onDeleteFolder={(folder) => void removeFolder(folder)}
            onFolderFilterChange={setOverviewFolderFilter}
            onPreview={previewStoredNote}
            onUpdateNoteFolder={(note, folderId) => void updateStoredNoteFolder(note, folderId)}
            publicShareByNoteId={activePublicShareByNoteId}
          />
        ) : (
          <>
          <div className="notes-top-actions" aria-label="노트 탐색">
            <div>
              <button
                className={`secondary-button note-nav-button ${sharedAttentionCount ? "has-alert" : ""}`}
                type="button"
                onClick={() => setListOpen((current) => !current)}
              >
                <PanelLeftOpen size={18} />
                노트 목록
                {sharedAttentionCount ? (
                  <span className="notification-badge" aria-label={`새 공유 업데이트 ${sharedAttentionCount}개`}>
                    {sharedAttentionCount > 99 ? "99+" : sharedAttentionCount}
                  </span>
                ) : null}
              </button>
              <button className="secondary-button note-nav-button" type="button" onClick={() => openOverview("all")}>
                <LayoutGrid size={18} />
                전체 조회
              </button>
                <button type="button" onClick={() => void startNewNote()}>
                <FilePlus2 size={18} />
                새 노트
              </button>
            </div>
            <span
              aria-live="polite"
              className={`notes-top-status ${saving ? "saving" : ""}`}
              role="status"
            >
              {saving ? "저장 중..." : status}
            </span>
          </div>
          <div className={`notes-editor-layout ${listOpen ? "with-drawer" : ""}`}>
            <NoteDrawer
              activeNoteId={editor.noteId}
              attentionNoteIds={sharedAttentionNoteIds}
              canRestoreNote={canRestoreNote}
              clockMs={cursorClock}
              counts={noteCounts}
              deletedCounts={trashCounts}
              deletedNotes={trashNotes}
              filter={noteFilter}
              folders={folders}
              noteStates={noteStateMap}
              notes={visibleNotes}
              onClose={() => setListOpen(false)}
              onFilterChange={updateNoteFilter}
              onOpenOverview={openOverview}
              onPreview={previewStoredNote}
              onPurge={(note) => void purgePreviewNote(note)}
              onPurgeAll={(notesToPurge) => void purgeDeletedNotes(notesToPurge)}
              onQueryChange={setNoteQuery}
              onRestore={(note) => void restorePreviewNote(note)}
              onSortChange={updateSortSetting}
              onTogglePin={(note) => void togglePinnedNote(note)}
              open={listOpen}
              publicShareByNoteId={activePublicShareByNoteId}
              query={noteQuery}
              sortSetting={noteSort}
            />
            <section className="editor-panel full-editor-panel">
          <div className="editor-toolbar">
            <div className="editor-primary-actions">
              <button className="secondary-button" type="button" onClick={() => setShareOpen((current) => !current)}>
                <UsersRound size={18} />
                공유 대상
              </button>
              <button
                className={`secondary-button ${activePublicShare ? "active" : ""}`}
                disabled={saving || publicShareBusy || !canEditShareTargets}
                type="button"
                onClick={() => void openPublicShareDialog()}
                title={canEditShareTargets ? "임시 URL로 노트 공유" : "노트 소유자만 링크 공유를 만들 수 있습니다."}
              >
                {publicShareBusy ? <Loader2 className="spin" size={18} /> : <Share2 size={18} />}
                {activePublicShare ? "공유 중" : "공유하기"}
              </button>
            </div>
            <div className="toolbar-actions">
              <label className="font-size-control">
                기본 글자
                <FontSizeNumberInput
                  ariaLabel="메모 글자 크기"
                  listId="quickmemo-font-size-options"
                  onCommit={updateFontSize}
                  value={editor.fontSize}
                />
              </label>
              {currentType === "personal" && (
                <label className="font-size-control folder-control">
                  폴더
                  <select
                    aria-label="개인 노트 폴더"
                    onChange={(event) => void updateEditorFolder(event.target.value || null)}
                    value={editor.folderId ?? ""}
                  >
                    <option value="">미분류</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {activeRemoteNote && (
                <button
                  aria-label={activeNotePinned ? "즐겨찾기 해제" : "즐겨찾기"}
                  className={`icon-button star-button ${activeNotePinned ? "active" : ""}`}
                  onClick={() => void togglePinnedNote(activeRemoteNote)}
                  title={activeNotePinned ? "즐겨찾기 해제" : "즐겨찾기"}
                  type="button"
                >
                  <Star fill="currentColor" size={18} />
                </button>
              )}
              <button disabled={saving} onClick={() => void saveCurrentNote(true)} type="button">
                {saving ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
                저장
              </button>
              <button
                aria-label="노트 삭제"
                className="icon-button danger"
                disabled={saving || !canDeleteCurrentNote}
                onClick={() => void removeCurrentNote()}
                title={canDeleteCurrentNote ? "노트 삭제" : "노트 소유자 또는 참여 중인 관리자만 삭제할 수 있습니다."}
                type="button"
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>
          {shareOpen && (
            <div className="share-strip">
              {sharePanelUsers.map((user) => {
                const checked = editor.participantUids.includes(user.uid);
                const allowed = canShareWithUser(user.uid);

                return (
                  <label key={user.uid} className={`share-user ${!allowed ? "restricted" : ""}`}>
                    <input
                      checked={checked}
                      disabled={saving || user.uid === unlockedProfile.uid || !canEditShareTargets || (!allowed && !checked)}
                      onChange={toggleParticipant}
                      type="checkbox"
                      value={user.uid}
                    />
                    <span className="mini-avatar" style={{ background: user.color }}>
                      {user.avatarText}
                    </span>
                    {user.displayName}
                    {!allowed && <em>권한 제거됨</em>}
                  </label>
                );
              })}
              {!canEditShareTargets && <p className="muted share-hint">노트 소유자만 공유 대상을 변경할 수 있습니다.</p>}
              {canEditShareTargets && !unlockedProfile.isAdmin && sharePanelUsers.length <= 1 && (
                <p className="muted share-hint">관리자 페이지에서 허용된 공유 대상이 없습니다.</p>
              )}
            </div>
          )}
          <input
            aria-label="노트 제목"
            className="title-input"
            onChange={(event) => updateEditor("title", event.target.value)}
            placeholder="노트 제목"
            value={editor.title}
          />
          <RichMemoEditor
            editorRef={memoEditorRef}
            fontSize={editor.fontSize}
            onCursorChange={publishEditorCursor}
            onFilesPaste={(files, insertHtml) => void insertPastedFiles(files, insertHtml)}
            onChange={(value) => updateEditor("body", value)}
            remoteCursors={remoteEditorCursors}
            value={editor.body}
          />
            {editor.noteId && activeRemoteNote && (
              <AttachmentList
                attachments={attachments}
                busyState={attachmentActionBusy}
                canDelete={(attachment) => canDeleteAttachmentForNote(activeRemoteNote, attachment)}
                onDelete={(attachment) => void removeAttachment(activeRemoteNote, attachment)}
              onDownload={(attachment) => void downloadAttachment(editor.noteId ?? activeRemoteNote.id, attachment)}
              onPreview={(attachment) => void previewAttachment(editor.noteId ?? activeRemoteNote.id, attachment)}
            />
          )}
          <div className="editor-footer">
            <span className={`note-kind-pill ${currentType}`}>{currentType === "shared" ? "공유" : "개인"}</span>
            <span className="note-created-inline">생성 {formatFullDateTime(createdDate)}</span>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
            </section>
          </div>
          </>
        )}
        {attachmentUploadProgress && <AttachmentUploadProgressToast progress={attachmentUploadProgress} />}
        {previewNote && (
          <NotePreviewModal
            canDelete={canDeleteNote(previewNote)}
            canRestore={canRestoreNote(previewNote)}
            currentUid={unlockedProfile.uid}
            historyUsers={users}
            isPinned={notePinned(previewNote.id, noteStateMap)}
            note={previewNote}
            onClose={() => setPreviewNoteId(null)}
            onConfirm={(note) => void confirmSharedNote(note)}
            onDelete={(note) => removePreviewNote(note)}
              onDeleteAttachment={(note, attachment) => removeAttachment(note, attachment)}
            onDownloadAttachment={(note, attachment) => void downloadAttachment(note.id, attachment)}
            onPreviewAttachment={(note, attachment) => void previewAttachment(note.id, attachment)}
            onPurge={(note) => void purgePreviewNote(note)}
            onLoad={(note, draft) => void openNote(note, draft)}
            onResolveNoteKey={resolveNoteKey}
            onRestore={(note) => restorePreviewNote(note)}
            onSave={(note, draft, expectedRevision) => savePreviewNote(note, draft, expectedRevision)}
            onTogglePin={(note) => void togglePinnedNote(note)}
            onUploadAttachments={(note, files) => void uploadPreviewAttachments(note, files)}
              saving={saving}
              suppressEscape={Boolean(attachmentPreview || publicShareOpen)}
              attachmentBusyState={attachmentActionBusy}
              canDeleteAttachment={canDeleteAttachmentForNote}
            />
        )}
        {publicShareOpen && (
          <PublicShareModal
            busy={publicShareBusy}
            copied={publicShareCopied}
            error={publicShareError}
            onClose={() => setPublicShareOpen(false)}
            onCopy={() => void copyPublicShareUrl()}
            onClearPassword={() => void clearCurrentPublicSharePassword()}
            onCreate={(password) => void createCurrentPublicShare(password)}
            onStop={() => void stopPublicShare()}
            onUpdatePassword={(password) => void setCurrentPublicSharePassword(password)}
            share={activePublicShare}
            shareUrl={activePublicShareUrl}
          />
        )}
        {attachmentPreview && <AttachmentPreviewModal onClose={closeAttachmentPreview} preview={attachmentPreview} />}
      </section>
    </AppShell>
  );
}

function PublicShareModal({
  busy,
  copied,
  error,
  onClose,
  onCopy,
  onClearPassword,
  onCreate,
  onStop,
  onUpdatePassword,
  share,
  shareUrl
}: {
  busy: boolean;
  copied: boolean;
  error: string | null;
  onClose: () => void;
  onCopy: () => void;
  onClearPassword: () => void;
  onCreate: (password: string) => void;
  onStop: () => void;
  onUpdatePassword: (password: string) => void;
  share: PublicNoteShareSnapshot | null;
  shareUrl: string | null;
}) {
  const [createPassword, setCreatePassword] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const expiresAt = dateFromTimestamp(share?.expiresAt);
  const hasPassword = Boolean(share?.passwordHash);
  const canRecoverShareUrl = Boolean(share?.ownerWrappedShareKey);

  useDialogFocus(dialogRef);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onCreate(createPassword);
  }

  function handlePasswordUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onUpdatePassword(passwordDraft);
    setPasswordDraft("");
  }

  return (
    <div className="modal-backdrop public-share-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="public-share-title"
        aria-modal="true"
        className="public-share-modal"
        ref={dialogRef}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="public-share-modal-header">
          <div>
            <span>
              <Share2 size={16} />
              임시 URL 공유
            </span>
            <h2 id="public-share-title">공유 링크</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="공유 창 닫기">
            <X size={16} />
          </button>
        </header>
        <div className="public-share-modal-body">
          {share ? (
            <>
              <p className="public-share-expiry">
                {expiresAt ? `만료 ${formatFullDateTime(expiresAt)}` : "만료 시간을 확인 중입니다."}
              </p>
              {shareUrl ? (
                <label className="public-share-url-field">
                  <span>URL</span>
                  <input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} />
                </label>
              ) : (
                <p className="public-share-missing-key">
                  {canRecoverShareUrl
                    ? "이 브라우저에서 공유 URL을 준비하는 중입니다."
                    : "이 공유는 키 동기화 전 생성되어 이 브라우저에서 URL을 다시 복사할 수 없습니다. 공유를 새로 만들면 같은 계정의 다른 브라우저에서도 복사할 수 있습니다."}
                </p>
              )}
              <div className="public-share-modal-actions">
                <button disabled={busy || !shareUrl} onClick={onCopy} type="button">
                  {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                  {copied ? "복사됨" : "URL 복사"}
                </button>
                {shareUrl && (
                  <a className="secondary-button public-share-open-link" href={shareUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={16} />
                    열기
                  </a>
                )}
                <button className="secondary-button danger" disabled={busy} onClick={onStop} type="button">
                  {busy ? <Loader2 className="spin" size={16} /> : <Ban size={16} />}
                  공유 중단
                </button>
              </div>
              <div className="public-share-password-panel">
                <div className="public-share-password-heading">
                  <LockKeyhole size={16} />
                  <span>{hasPassword ? "비밀번호 사용 중" : "비밀번호 없음"}</span>
                </div>
                <form className="public-share-password-form" onSubmit={handlePasswordUpdate}>
                  <label>
                    <span>{hasPassword ? "새 비밀번호" : "비밀번호"}</span>
                    <input
                      autoComplete="new-password"
                      disabled={busy}
                      minLength={publicSharePasswordMinLength}
                      onChange={(event) => setPasswordDraft(event.target.value)}
                      placeholder={`${publicSharePasswordMinLength}자 이상`}
                      type="password"
                      value={passwordDraft}
                    />
                  </label>
                  <div className="public-share-password-actions">
                    <button
                      disabled={busy || !shareUrl || passwordDraft.trim().length < publicSharePasswordMinLength}
                      type="submit"
                    >
                      {busy ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />}
                      {hasPassword ? "변경" : "설정"}
                    </button>
                    {hasPassword && (
                      <button className="secondary-button" disabled={busy || !shareUrl} onClick={onClearPassword} type="button">
                        비밀번호 해제
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </>
          ) : (
            <>
              <p className="public-share-expiry">공유 링크는 최대 7일 동안 열 수 있습니다.</p>
              <form className="public-share-password-form" onSubmit={handleCreate}>
                <label>
                  <span>비밀번호 (선택)</span>
                  <input
                    autoComplete="new-password"
                    disabled={busy}
                    minLength={publicSharePasswordMinLength}
                    onChange={(event) => setCreatePassword(event.target.value)}
                    placeholder={`선택 사항 · 사용 시 ${publicSharePasswordMinLength}자 이상`}
                    type="password"
                    value={createPassword}
                  />
                </label>
                <button
                  disabled={
                    busy ||
                    (createPassword.trim().length > 0 && createPassword.trim().length < publicSharePasswordMinLength)
                  }
                  type="submit"
                >
                  {busy ? <Loader2 className="spin" size={16} /> : <Share2 size={16} />}
                  링크 만들기
                </button>
              </form>
            </>
          )}
          {busy && <p className="public-share-status">공유 상태를 업데이트하는 중...</p>}
          {error && <p className="form-error">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function RichMemoEditor({
  editorRef,
  fontSize,
  onCursorChange,
  onFilesPaste,
  onChange,
  remoteCursors = [],
  value
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  fontSize: number;
  onCursorChange?: (cursorOffset: number | null, cursorVisible: boolean) => void;
  onFilesPaste: (files: File[], insertHtml: RichEditorInsertHtml) => void | Promise<void>;
  onChange: (value: string) => void;
  remoteCursors?: RemoteCursorView[];
  value: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedImageRef = useRef<HTMLImageElement | null>(null);
  const imageResizeCleanupRef = useRef<(() => void) | null>(null);
  const imageWidthControlRef = useRef<HTMLLabelElement | null>(null);
  const tableResizeCleanupRef = useRef<(() => void) | null>(null);
  const lastEditorSelectionRef = useRef<StoredEditorSelectionRange | null>(null);
  const fileDragDepthRef = useRef(0);
  const [selectedImageWidthPx, setSelectedImageWidthPx] = useState<number | null>(null);
  const [activeToolTab, setActiveToolTab] = useState<EditorToolTab>("format");
  const [customTextColor, setCustomTextColor] = useState<string>(editorTextColors[0]);
  const [customCellColor, setCustomCellColor] = useState<string>(editorCellColors[0]);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableColumns, setTableColumns] = useState(3);
  const [, setToolbarVersion] = useState(0);
  const controlIdPrefix = useId();
  const selectionFontSizeListId = `${controlIdPrefix}-selection-font-sizes`;
  const selectionLineHeightListId = `${controlIdPrefix}-selection-line-heights`;
  const editor = useEditor({
    extensions: richEditorExtensions,
    content: value || "",
    editorProps: {
      attributes: {
        "aria-label": "노트 본문",
        "aria-multiline": "true",
        class: "rich-body-input",
        role: "textbox"
      },
      handleClick: (_view, _position, event) => {
        handleEditorClick(event);
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);

        if (!files.length) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        resetFileDropState();
        void handleFiles(files);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        const itemFiles = Array.from(event.clipboardData?.items ?? [])
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file));
        const pastedFiles = files.length ? files : itemFiles;

        if (pastedFiles.length) {
          event.preventDefault();
          void handleFiles(pastedFiles);
          return true;
        }

        const plainText = event.clipboardData?.getData("text/plain") ?? "";

        if (!plainText.includes("\t")) {
          return false;
        }

        event.preventDefault();
        editor?.chain().focus().insertContent(plainTextToEditorHtml(plainText)).run();
        return true;
      },
      handleDOMEvents: {
        mousedown: (view, event) => handleTableBoundaryMouseDown(view, event)
      }
    },
    onBlur: () => emitCursorPosition(false),
    onFocus: ({ editor: focusedEditor }) => {
      rememberEditorSelection(focusedEditor);
      emitCursorPosition(true);
    },
    onSelectionUpdate: ({ editor: selectionEditor }) => {
      rememberEditorSelection(selectionEditor);
      setToolbarVersion((version) => version + 1);
      emitCursorPosition(true);
    },
    onUpdate: ({ editor: nextEditor }) => {
      rememberEditorSelection(nextEditor);
      onChange(nextEditor.getHTML());
      setToolbarVersion((version) => version + 1);
      emitCursorPosition(true);
    }
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const mutableRef = editorRef as MutableRefObject<HTMLDivElement | null>;
    mutableRef.current = editor.view.dom as HTMLDivElement;

    return () => {
      if (mutableRef.current === editor.view.dom) {
        mutableRef.current = null;
      }
    };
  }, [editor, editorRef]);

  function rememberEditorSelection(currentEditor: TipTapEditor) {
    const { from, to } = currentEditor.state.selection;
    lastEditorSelectionRef.current = { from, to };
  }

  function restoreEditorSelection(currentEditor: TipTapEditor) {
    const selection = selectionFromStoredRange(currentEditor, lastEditorSelectionRef.current);

    if (selection) {
      currentEditor.view.dispatch(currentEditor.state.tr.setSelection(selection));
    }
  }

  useEffect(() => {
    if (!editor) {
      return undefined;
    }

    const editorElement = editor.view.dom as HTMLElement;

    function setResizeCursor(cursor: TableResizeCursor | null) {
      if (cursor) {
        editorElement.dataset.qmTableResizeCursor = cursor;
      } else {
        delete editorElement.dataset.qmTableResizeCursor;
      }
    }

    function handleMouseMove(event: MouseEvent) {
      if (tableResizeCleanupRef.current) {
        return;
      }

      setResizeCursor(tableResizeCursorFromEvent(editorElement, event));
    }

    function handleMouseLeave() {
      if (!tableResizeCleanupRef.current) {
        setResizeCursor(null);
      }
    }

    function handleMouseDown(event: MouseEvent) {
      if (event.button !== 0) {
        return;
      }

      const hit = tableResizeHitFromEvent(editorElement, event);

      if (!hit) {
        return;
      }

      const resizeHit = hit;
      event.preventDefault();
      event.stopPropagation();
      selectedImageRef.current = null;
      setSelectedImageWidthPx(null);
      setResizeCursor(resizeHit.cursor);

      const restoreUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const cleanup = () => {
        document.body.style.userSelect = restoreUserSelect;
        tableResizeCleanupRef.current = null;
        setResizeCursor(null);
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", cleanup);
      };

      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = resizeHit.table.getBoundingClientRect().width;
      const startTableHeight = resizeHit.table.getBoundingClientRect().height;
      const startRowHeight = resizeHit.row?.getBoundingClientRect().height ?? 0;
      const startColumnWidth = resizeHit.cell?.getBoundingClientRect().width ?? 0;
      const resizeSession = tableResizeSessionFromHit(editor, resizeHit);

      function handleResizeMove(moveEvent: MouseEvent) {
        moveEvent.preventDefault();

        if (resizeHit.kind === "column" && typeof resizeHit.columnIndex === "number") {
          const nextWidth = clampTableColumnPixelWidth(startColumnWidth + moveEvent.clientX - startX);
          if (resizeSession && updateTableColumnWidthFromSession(editor, resizeSession, resizeHit.columnIndex, nextWidth)) {
            onChange(editor.getHTML());
            setToolbarVersion((version) => version + 1);
          }
          return;
        }

        if (resizeHit.kind === "row" && resizeSession?.rowTarget) {
          const nextHeight = clampTableRowPixelHeight(startRowHeight + moveEvent.clientY - startY);
          if (dispatchNodeAttributeUpdates(editor, [{ target: resizeSession.rowTarget, attrs: { qmHeightPx: nextHeight } }])) {
            onChange(editor.getHTML());
            setToolbarVersion((version) => version + 1);
          }
          return;
        }

        if (!resizeSession?.tableTarget) {
          return;
        }

        const nextAttributes: Record<string, number | null> = {};

        if (resizeHit.widthSign !== 0) {
          nextAttributes.qmWidth = null;
          nextAttributes.qmWidthPx = clampTablePixelWidth(startWidth + (moveEvent.clientX - startX) * resizeHit.widthSign);
        }

        if (resizeHit.heightSign !== 0) {
          nextAttributes.qmHeightPx = clampTablePixelHeight(startTableHeight + (moveEvent.clientY - startY) * resizeHit.heightSign);
        }

        if (Object.keys(nextAttributes).length) {
          if (dispatchNodeAttributeUpdates(editor, [{ target: resizeSession.tableTarget, attrs: nextAttributes }])) {
            onChange(editor.getHTML());
            setToolbarVersion((version) => version + 1);
          }
        }
      }

      tableResizeCleanupRef.current = cleanup;
      window.addEventListener("mousemove", handleResizeMove);
      window.addEventListener("mouseup", cleanup);
    }

    editorElement.addEventListener("mousemove", handleMouseMove);
    editorElement.addEventListener("mouseleave", handleMouseLeave);
    editorElement.addEventListener("mousedown", handleMouseDown, true);

    return () => {
      tableResizeCleanupRef.current?.();
      editorElement.removeEventListener("mousemove", handleMouseMove);
      editorElement.removeEventListener("mouseleave", handleMouseLeave);
      editorElement.removeEventListener("mousedown", handleMouseDown, true);
      setResizeCursor(null);
    };
  }, [editor, onChange]);

  useEffect(() => {
    if (!editor) {
      return undefined;
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      if (!selectedImageRef.current) {
        return;
      }

      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (imageWidthControlRef.current?.contains(target)) {
        return;
      }

      const image = target instanceof HTMLElement ? target.closest("img") : null;

      if (image instanceof HTMLImageElement && editorRef.current?.contains(image)) {
        return;
      }

      selectedImageRef.current = null;
      setSelectedImageWidthPx(null);
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    };
  }, [editor, editorRef]);

  useEffect(() => {
    return () => {
      imageResizeCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!editor || editor.getHTML() === (value || "")) {
      return;
    }

    const selectionBookmark = editor.state.selection.getBookmark();
    editor.commands.setContent(value || "", { emitUpdate: false });

    try {
      const restoredSelection = selectionBookmark.resolve(editor.state.doc);
      editor.view.dispatch(editor.state.tr.setSelection(restoredSelection));
      rememberEditorSelection(editor);
    } catch {
      restoreEditorSelection(editor);
    }
  }, [editor, value]);

  function clearImageSelection() {
    selectedImageRef.current = null;
    setSelectedImageWidthPx(null);
  }

  function handleEditorClick(event: Event) {
    const target = event.target;
    const image = target instanceof HTMLElement ? target.closest("img") : null;
    const anchor = target instanceof HTMLElement ? target.closest("a[href]") : null;

    if (image instanceof HTMLImageElement && editorRef.current?.contains(image)) {
      selectedImageRef.current = image;
      setSelectedImageWidthPx(readImageWidthPx(image));
      setActiveToolTab("media");
      emitCursorPosition(true);
      return;
    }

    clearImageSelection();

    if (!(anchor instanceof HTMLAnchorElement) || !editorRef.current?.contains(anchor)) {
      return;
    }

    event.preventDefault();
    clearImageSelection();
    window.open(anchor.href, "_blank", "noopener,noreferrer");
  }

  async function handleFiles(files: File[]) {
    if (!editor) {
      return;
    }

    await onFilesPaste(files, insertHtml);
  }

  function resetFileDropState() {
    fileDragDepthRef.current = 0;
    setFileDropActive(false);
  }

  function prepareFileDrop(event: ReactDragEvent<HTMLElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    return true;
  }

  function handleEditorFrameDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!prepareFileDrop(event)) {
      return;
    }

    fileDragDepthRef.current += 1;
    setFileDropActive(true);
  }

  function handleEditorFrameDragOver(event: ReactDragEvent<HTMLDivElement>) {
    prepareFileDrop(event);
  }

  function handleEditorFrameDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!prepareFileDrop(event)) {
      return;
    }

    const relatedTarget = event.relatedTarget;

    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }

    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    setFileDropActive(fileDragDepthRef.current > 0);
  }

  function handleEditorFrameDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!prepareFileDrop(event)) {
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);

    resetFileDropState();

    if (files.length) {
      void handleFiles(files);
    }
  }

  function insertHtml(html: string) {
    if (!editor) {
      return null;
    }

    editor.chain().focus().insertContent(sanitizeEditorHtml(html)).run();
    return editor.getHTML();
  }

  function emitCursorPosition(cursorVisible: boolean) {
    if (!onCursorChange) {
      return;
    }

    const cursorOffset = cursorVisible ? getCaretCharacterOffset(editorRef.current) : null;
    onCursorChange(cursorOffset, cursorVisible && cursorOffset !== null);
  }

  function updateSelectedImageWidth(width: number) {
    if (!editor) {
      return;
    }

    const image = selectedImageRef.current;
    const safeWidth = clampImagePixelWidth(width);

    if (!image || !editorRef.current?.contains(image)) {
      clearImageSelection();
      return;
    }

    const position = editor.view.posAtDOM(image, 0);

    editor.chain().setNodeSelection(position).updateAttributes("image", { qmWidth: null, qmWidthPx: safeWidth }).run();
    selectedImageRef.current = imageElementAtPosition(editor, position, image.currentSrc || image.src) ?? image;
    setSelectedImageWidthPx(safeWidth);
    onChange(editor.getHTML());
  }

  function beginImageWidthDrag(event: ReactPointerEvent<HTMLLabelElement>) {
    if (event.button !== 0 || event.target instanceof HTMLInputElement) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    imageResizeCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = currentImageWidthPx;
    const restoreCursor = document.body.style.cursor;
    const restoreUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    function cleanup() {
      document.body.style.cursor = restoreCursor;
      document.body.style.userSelect = restoreUserSelect;
      imageResizeCleanupRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      moveEvent.preventDefault();
      updateSelectedImageWidth(startWidth + moveEvent.clientX - startX);
    }

    imageResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }

  function runToolbarCommand(command: (editor: TipTapEditor) => void) {
    if (!editor) {
      return;
    }

    restoreEditorSelection(editor);
    command(editor);
    rememberEditorSelection(editor);
    setToolbarVersion((version) => version + 1);
  }

  function applySelectionFontSize(size: number) {
    const safeSize = clampSelectionFontSize(size);
    runToolbarCommand((currentEditor) => currentEditor.chain().focus().setMark("textSize", { size: safeSize }).run());
  }

  function applySelectionLineHeight(lineHeight: number) {
    const safeLineHeight = clampSelectionLineHeight(lineHeight);
    runToolbarCommand((currentEditor) => {
      currentEditor.chain().focus().setMark("lineHeight", { lineHeight: safeLineHeight }).run();
      updateSelectedBlockLineHeight(currentEditor, safeLineHeight);
    });
  }

  function applySelectionTextColor(color: string) {
    const safeColor = normalizeCustomHexColor(color, editorTextColors[0]);
    setCustomTextColor(safeColor);
    runToolbarCommand((currentEditor) => currentEditor.chain().focus().setMark("textColor", { color: safeColor }).run());
  }

  function clearSelectionTextColor() {
    runToolbarCommand((currentEditor) => currentEditor.chain().focus().unsetMark("textColor").run());
  }

  function applyCellColor(color: string) {
    const safeColor = normalizeCustomHexColor(color, editorCellColors[0]);
    setCustomCellColor(safeColor);
    runToolbarCommand((currentEditor) => currentEditor.chain().focus().setCellAttribute("backgroundColor", safeColor).run());
  }

  function updateSelectedTableWidthPx(width: number) {
    const safeWidth = clampTablePixelWidth(width);
    updateCurrentTableAttributes((tableState) => [
      {
        target: tableState.tableTarget,
        attrs: {
          qmWidth: null,
          qmWidthPx: safeWidth
        }
      }
    ]);
  }

  function updateSelectedTableHeightPx(height: number) {
    const safeHeight = clampTablePixelHeight(height);
    updateCurrentTableAttributes((tableState) => [
      {
        target: tableState.tableTarget,
        attrs: {
          qmHeightPx: safeHeight
        }
      }
    ]);
  }

  function updateSelectedColumnWidthPx(width: number) {
    const safeWidth = clampTableColumnPixelWidth(width);
    updateCurrentTableAttributes((tableState) => {
      const nextTableWidth = clampTablePixelWidth(tableState.tableWidthPx + safeWidth - tableState.columnWidthPx);

      return [
        {
          target: tableState.tableTarget,
          attrs: {
            qmWidth: null,
            qmWidthPx: nextTableWidth
          }
        },
        ...tableState.columnTargets.map((target) => {
          const node = editor?.state.doc.nodeAt(target.position);
          const colspan = Number(node?.attrs.colspan) || 1;

          return {
            target,
            attrs: {
              colwidth: Array.from({ length: colspan }, () => safeWidth),
              qmWidthPx: safeWidth
            }
          };
        })
      ];
    });
  }

  function updateSelectedRowHeightPx(height: number) {
    const safeHeight = clampTableRowPixelHeight(height);
    updateCurrentTableAttributes((tableState) => [
      {
        target: tableState.rowTarget,
        attrs: {
          qmHeightPx: safeHeight
        }
      }
    ]);
  }

  function updateCurrentTableAttributes(
    updatesFromState: (tableState: TableControlState) => Array<{ attrs: Record<string, number | number[] | null>; target: TableResizeNodeTarget }>
  ) {
    if (!editor) {
      return;
    }

    const tableState = selectedTableControlState(editor);

    if (!tableState) {
      return;
    }

    if (dispatchNodeAttributeUpdates(editor, updatesFromState(tableState))) {
      onChange(editor.getHTML());
      setToolbarVersion((version) => version + 1);
    }
  }

  function undoEditorStep() {
    runToolbarCommand((currentEditor) => currentEditor.chain().focus().undo().run());
  }

  function redoEditorStep() {
    runToolbarCommand((currentEditor) => currentEditor.chain().focus().redo().run());
  }

  function insertTable() {
    runToolbarCommand((currentEditor) =>
      currentEditor
        .chain()
        .focus()
        .insertTable({
          rows: clampTableDimension(tableRows),
          cols: clampTableDimension(tableColumns),
          withHeaderRow: true
        })
        .run()
    );
  }

  function chooseFiles() {
    fileInputRef.current?.click();
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (files.length) {
      void handleFiles(files);
    }
  }

  const currentSelectionFontSize = clampSelectionFontSize(Number(editor?.getAttributes("textSize").size) || fontSize);
  const currentSelectionLineHeight = clampSelectionLineHeight(currentBlockLineHeight(editor) ?? 1);
  const currentSelectionTextColor = String(editor?.getAttributes("textColor").color || customTextColor);
  const currentImageWidthPx = selectedImageWidthPx ?? editorImagePixelWidthBounds.max;
  const currentTableState = editor ? selectedTableControlState(editor) : null;
  const hasTextSelection = Boolean(editor && !editor.state.selection.empty);
  const quickFontSizeListId = `${controlIdPrefix}-quick-font-sizes`;
  const quickLineHeightListId = `${controlIdPrefix}-quick-line-heights`;

  function handleToolTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: EditorToolTab) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }

    event.preventDefault();
    const currentIndex = editorToolTabs.findIndex((tab) => tab.id === currentTab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? editorToolTabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + editorToolTabs.length) % editorToolTabs.length;
    const nextTab = editorToolTabs[nextIndex];
    setActiveToolTab(nextTab.id);
    document.getElementById(`${controlIdPrefix}-${nextTab.id}-tab`)?.focus();
  }

  return (
    <>
      <div className="rich-editor-toolbar" aria-label="편집 도구" data-has-selection={hasTextSelection ? "true" : undefined}>
        <div className="rich-toolbar-tabs" role="tablist" aria-label="편집 도구 탭">
          {editorToolTabs.map((tab) => (
            <button
              aria-controls={`${controlIdPrefix}-${tab.id}-panel`}
              aria-selected={activeToolTab === tab.id}
              className={activeToolTab === tab.id ? "active" : ""}
              id={`${controlIdPrefix}-${tab.id}-tab`}
              key={tab.id}
              onClick={() => setActiveToolTab(tab.id)}
              onKeyDown={(event) => handleToolTabKeyDown(event, tab.id)}
              tabIndex={activeToolTab === tab.id ? 0 : -1}
              type="button"
              role="tab"
            >
              {tab.label}
            </button>
          ))}
        </div>
        {activeToolTab === "format" && (
          <div
            aria-labelledby={`${controlIdPrefix}-format-tab`}
            className="rich-toolbar-panel"
            id={`${controlIdPrefix}-format-panel`}
            role="tabpanel"
          >
        <button
          aria-label="뒤로가기"
          className="icon-button"
          disabled={!editor?.can().undo()}
          onClick={undoEditorStep}
          onMouseDown={(event) => event.preventDefault()}
          title="뒤로가기"
          type="button"
        >
          <Undo2 size={16} />
        </button>
        <button
          aria-label="앞으로가기"
          className="icon-button"
          disabled={!editor?.can().redo()}
          onClick={redoEditorStep}
          onMouseDown={(event) => event.preventDefault()}
          title="앞으로가기"
          type="button"
        >
          <Redo2 size={16} />
        </button>
        <button
          aria-label="본문 문단"
          aria-pressed={editor?.isActive("paragraph") ?? false}
          className={`icon-button ${editor?.isActive("paragraph") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().setParagraph().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="본문 문단"
          type="button"
        >
          <Pilcrow size={16} />
        </button>
        <button
          aria-label="제목 2"
          aria-pressed={editor?.isActive("heading", { level: 2 }) ?? false}
          className={`icon-button ${editor?.isActive("heading", { level: 2 }) ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleHeading({ level: 2 }).run())}
          onMouseDown={(event) => event.preventDefault()}
          title="제목 2"
          type="button"
        >
          <Heading2 size={16} />
        </button>
        <button
          aria-label="제목 3"
          aria-pressed={editor?.isActive("heading", { level: 3 }) ?? false}
          className={`icon-button ${editor?.isActive("heading", { level: 3 }) ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleHeading({ level: 3 }).run())}
          onMouseDown={(event) => event.preventDefault()}
          title="제목 3"
          type="button"
        >
          <Heading3 size={16} />
        </button>
        <button
          aria-label="글머리 목록"
          aria-pressed={editor?.isActive("bulletList") ?? false}
          className={`icon-button ${editor?.isActive("bulletList") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleBulletList().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="글머리 목록"
          type="button"
        >
          <List size={16} />
        </button>
        <button
          aria-label="번호 목록"
          aria-pressed={editor?.isActive("orderedList") ?? false}
          className={`icon-button ${editor?.isActive("orderedList") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleOrderedList().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="번호 목록"
          type="button"
        >
          <ListOrdered size={16} />
        </button>
        <button
          aria-label="인용문"
          aria-pressed={editor?.isActive("blockquote") ?? false}
          className={`icon-button ${editor?.isActive("blockquote") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleBlockquote().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="인용문"
          type="button"
        >
          <Quote size={16} />
        </button>
        <button
          aria-label="굵게"
          aria-pressed={editor?.isActive("bold") ?? false}
          className={`icon-button ${editor?.isActive("bold") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleBold().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="굵게"
          type="button"
        >
          <Bold size={16} />
        </button>
        <button
          aria-label="밑줄"
          aria-pressed={editor?.isActive("underline") ?? false}
          className={`icon-button ${editor?.isActive("underline") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleUnderline().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="밑줄"
          type="button"
        >
          <Underline size={16} />
        </button>
        <button
          aria-label="가운데 줄"
          aria-pressed={editor?.isActive("strike") ?? false}
          className={`icon-button ${editor?.isActive("strike") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleStrike().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="가운데 줄"
          type="button"
        >
          <Strikethrough size={16} />
        </button>
        <button
          aria-label="체크리스트"
          aria-pressed={editor?.isActive("taskList") ?? false}
          className={`icon-button ${editor?.isActive("taskList") ? "active" : ""}`}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().toggleTaskList().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="체크리스트"
          type="button"
        >
          <ListTodo size={16} />
        </button>
        <button
          aria-label="왼쪽 정렬"
          className="icon-button"
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().setTextAlign("left").run())}
          onMouseDown={(event) => event.preventDefault()}
          title="왼쪽 정렬"
          type="button"
        >
          <AlignLeft size={16} />
        </button>
        <button
          aria-label="가운데 정렬"
          className="icon-button"
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().setTextAlign("center").run())}
          onMouseDown={(event) => event.preventDefault()}
          title="가운데 정렬"
          type="button"
        >
          <AlignCenter size={16} />
        </button>
        <button
          aria-label="오른쪽 정렬"
          className="icon-button"
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().setTextAlign("right").run())}
          onMouseDown={(event) => event.preventDefault()}
          title="오른쪽 정렬"
          type="button"
        >
          <AlignRight size={16} />
        </button>
        <label className="selection-font-control">
          선택 글자
          <FontSizeNumberInput
            ariaLabel="선택 영역 글자 크기"
            listId={selectionFontSizeListId}
            onCommit={applySelectionFontSize}
            value={currentSelectionFontSize}
          />
        </label>
        <label className="selection-font-control line-height-control">
          줄 간격
          <LineHeightNumberInput
            ariaLabel="선택 영역 줄 간격"
            listId={selectionLineHeightListId}
            onCommit={applySelectionLineHeight}
            value={currentSelectionLineHeight}
          />
        </label>
        <div className="text-color-palette" aria-label="글자 색상">
          <Palette size={15} />
          {editorTextColors.map((color) => (
            <button
              aria-label={`${color} 글자 색상`}
              aria-pressed={currentSelectionTextColor === color}
              className={currentSelectionTextColor === color ? "active" : ""}
              key={color}
              onClick={() => applySelectionTextColor(color)}
              onMouseDown={(event) => event.preventDefault()}
              style={{ backgroundColor: color }}
              type="button"
            />
          ))}
          <label className="custom-color-input compact" title="직접 글자 색상 선택">
            <input
              aria-label="글자 색상 직접 선택"
              onChange={(event) => applySelectionTextColor(event.target.value)}
              type="color"
              value={customTextColor}
            />
          </label>
          <button
            aria-label="글자 색상 해제"
            className="cell-color-clear"
            onClick={clearSelectionTextColor}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            <X size={13} />
          </button>
        </div>
          </div>
        )}
        {activeToolTab === "table" && (
          <div
            aria-labelledby={`${controlIdPrefix}-table-tab`}
            className="rich-toolbar-panel"
            id={`${controlIdPrefix}-table-panel`}
            role="tabpanel"
          >
        <span className="table-insert-control">
          <Table2 size={15} />
          <input
            aria-label="표 행 수"
            max={12}
            min={1}
            onChange={(event) => setTableRows(clampTableDimension(Number(event.target.value)))}
            type="number"
            value={tableRows}
          />
          <span>x</span>
          <input
            aria-label="표 열 수"
            max={12}
            min={1}
            onChange={(event) => setTableColumns(clampTableDimension(Number(event.target.value)))}
            type="number"
            value={tableColumns}
          />
          <button onClick={insertTable} onMouseDown={(event) => event.preventDefault()} type="button">
            추가
          </button>
        </span>
        <div className="table-size-controls" aria-label="표 크기 조절">
          <TableSizeNumberInput
            ariaLabel="표 너비"
            disabled={!currentTableState}
            label="표 W"
            max={editorTablePixelWidthBounds.max}
            min={editorTablePixelWidthBounds.min}
            onCommit={updateSelectedTableWidthPx}
            step={editorTablePixelWidthBounds.step}
            value={currentTableState?.tableWidthPx ?? editorTablePixelWidthBounds.min}
          />
          <TableSizeNumberInput
            ariaLabel="표 높이"
            disabled={!currentTableState}
            label="표 H"
            max={editorTablePixelHeightBounds.max}
            min={editorTablePixelHeightBounds.min}
            onCommit={updateSelectedTableHeightPx}
            step={editorTablePixelHeightBounds.step}
            value={currentTableState?.tableHeightPx ?? editorTablePixelHeightBounds.min}
          />
          <TableSizeNumberInput
            ariaLabel="현재 열 너비"
            disabled={!currentTableState}
            label="열 W"
            max={editorTableColumnPixelWidthBounds.max}
            min={editorTableColumnPixelWidthBounds.min}
            onCommit={updateSelectedColumnWidthPx}
            step={editorTableColumnPixelWidthBounds.step}
            value={currentTableState?.columnWidthPx ?? editorTableColumnPixelWidthBounds.min}
          />
          <TableSizeNumberInput
            ariaLabel="현재 행 높이"
            disabled={!currentTableState}
            label="행 H"
            max={editorTableRowPixelHeightBounds.max}
            min={editorTableRowPixelHeightBounds.min}
            onCommit={updateSelectedRowHeightPx}
            step={editorTableRowPixelHeightBounds.step}
            value={currentTableState?.rowHeightPx ?? editorTableRowPixelHeightBounds.min}
          />
        </div>
        <button
          aria-label="행 추가"
          className="icon-button"
          disabled={!editor?.isActive("table")}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().addRowAfter().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="행 추가"
          type="button"
        >
          <Rows3 size={16} />
        </button>
        <button
          className="secondary-button table-delete-button"
          disabled={!editor?.isActive("table")}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().deleteRow().run())}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          행 삭제
        </button>
        <button
          aria-label="열 추가"
          className="icon-button"
          disabled={!editor?.isActive("table")}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().addColumnAfter().run())}
          onMouseDown={(event) => event.preventDefault()}
          title="열 추가"
          type="button"
        >
          <Columns3 size={16} />
        </button>
        <button
          className="secondary-button table-delete-button"
          disabled={!editor?.isActive("table")}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().deleteColumn().run())}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          열 삭제
        </button>
        <button
          className="secondary-button table-delete-button"
          disabled={!editor?.isActive("table")}
          onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().deleteTable().run())}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          표 삭제
        </button>
        <div className="cell-color-palette" aria-label="셀 색상">
          <PaintBucket size={15} />
          {editorCellColors.map((color) => (
            <button
              aria-label={`${color} 셀 색상`}
              disabled={!editor?.isActive("table")}
              key={color}
              onClick={() => applyCellColor(color)}
              onMouseDown={(event) => event.preventDefault()}
              style={{ backgroundColor: color }}
              type="button"
            />
          ))}
          <label className="custom-color-input compact" title="직접 셀 색상 선택">
            <input
              aria-label="셀 색상 직접 선택"
              disabled={!editor?.isActive("table")}
              onChange={(event) => applyCellColor(event.target.value)}
              type="color"
              value={customCellColor}
            />
          </label>
          <button
            aria-label="셀 색상 해제"
            className="cell-color-clear"
            disabled={!editor?.isActive("table")}
            onClick={() => runToolbarCommand((currentEditor) => currentEditor.chain().focus().setCellAttribute("backgroundColor", null).run())}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            <X size={13} />
          </button>
        </div>
          </div>
        )}
        {activeToolTab === "media" && (
          <div
            aria-labelledby={`${controlIdPrefix}-media-tab`}
            className="rich-toolbar-panel"
            id={`${controlIdPrefix}-media-panel`}
            role="tabpanel"
          >
        <button className="secondary-button editor-upload-button" onClick={chooseFiles} type="button">
          <Upload size={16} />
          파일
        </button>
        {selectedImageWidthPx && (
          <label className="image-width-control" onPointerDown={beginImageWidthDrag} ref={imageWidthControlRef}>
            <span className="image-width-drag-target">이미지 너비</span>
            <input
              aria-label="이미지 너비"
              max={editorImagePixelWidthBounds.max}
              min={editorImagePixelWidthBounds.min}
              onChange={(event) => updateSelectedImageWidth(Number(event.target.value))}
              step={editorImagePixelWidthBounds.step}
              type="range"
              value={currentImageWidthPx}
            />
            <output className="image-width-drag-target">{currentImageWidthPx}px</output>
          </label>
        )}
        <input
          ref={fileInputRef}
          accept={attachmentInputAccept}
          className="sr-only"
          multiple
          onChange={handleFileInputChange}
          type="file"
        />
          </div>
        )}
      </div>
      <div
        className="rich-editor-frame"
        data-file-drop-active={fileDropActive ? "true" : undefined}
        onDragEnter={handleEditorFrameDragEnter}
        onDragLeave={handleEditorFrameDragLeave}
        onDragOver={handleEditorFrameDragOver}
        onDrop={handleEditorFrameDrop}
      >
        <EditorContent editor={editor} style={{ "--editor-font-size": `${fontSize}px` } as CSSProperties} />
        <RemoteCursorLayer cursors={remoteCursors} editorRef={editorRef} />
        {fileDropActive && (
          <div className="rich-editor-drop-overlay" aria-hidden="true">
            <Upload size={22} />
            <span>파일 첨부</span>
          </div>
        )}
      </div>
      {hasTextSelection && <div className="format-quick-dock" aria-label="선택 영역 빠른 서식" data-has-selection="true">
        <span>빠른 서식</span>
        <label className="selection-font-control compact">
          글자
          <FontSizeNumberInput
            ariaLabel="빠른 선택 영역 글자 크기"
            listId={quickFontSizeListId}
            onCommit={applySelectionFontSize}
            value={currentSelectionFontSize}
          />
        </label>
        <label className="selection-font-control compact line-height-control">
          줄
          <LineHeightNumberInput
            ariaLabel="빠른 선택 영역 줄 간격"
            listId={quickLineHeightListId}
            onCommit={applySelectionLineHeight}
            value={currentSelectionLineHeight}
          />
        </label>
        <div className="text-color-palette compact" aria-label="빠른 글자 색상">
          {editorTextColors.map((color) => (
            <button
              aria-label={`글자 색상 ${color}`}
              className={currentSelectionTextColor === color ? "active" : ""}
              key={color}
              onClick={() => applySelectionTextColor(color)}
              onMouseDown={(event) => event.preventDefault()}
              style={{ background: color }}
              type="button"
            />
          ))}
        </div>
      </div>}
    </>
  );
}

function FontSizeNumberInput({
  ariaLabel,
  listId,
  onCommit,
  value
}: {
  ariaLabel: string;
  listId: string;
  onCommit: (value: number) => void;
  value: number;
}) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  function commitValue() {
    const safeValue = clampDraftFontSize(Number(draftValue));
    setDraftValue(String(safeValue));
    onCommit(safeValue);
  }

  return (
    <>
      <input
        aria-label={ariaLabel}
        list={listId}
        max={editorTextSizeBounds.max}
        min={editorTextSizeBounds.min}
        onBlur={commitValue}
        onChange={(event) => setDraftValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitValue();
            event.currentTarget.blur();
          }
        }}
        step={editorTextSizeBounds.step}
        type="number"
        value={draftValue}
      />
      <span>px</span>
      <datalist id={listId}>
        {fontSizes.map((fontSize) => (
          <option key={fontSize} value={fontSize} />
        ))}
      </datalist>
    </>
  );
}

function LineHeightNumberInput({
  ariaLabel,
  listId,
  onCommit,
  value
}: {
  ariaLabel: string;
  listId: string;
  onCommit: (value: number) => void;
  value: number;
}) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  function commitValue() {
    const safeValue = clampSelectionLineHeight(Number(draftValue));
    setDraftValue(String(safeValue));
    onCommit(safeValue);
  }

  return (
    <>
      <input
        aria-label={ariaLabel}
        list={listId}
        max={editorLineHeightBounds.max}
        min={editorLineHeightBounds.min}
        onBlur={commitValue}
        onChange={(event) => setDraftValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitValue();
            event.currentTarget.blur();
          }
        }}
        step={editorLineHeightBounds.step}
        type="number"
        value={draftValue}
      />
      <datalist id={listId}>
        {editorLineHeights.map((lineHeight) => (
          <option key={lineHeight} value={lineHeight} />
        ))}
      </datalist>
    </>
  );
}

function TableSizeNumberInput({
  ariaLabel,
  disabled = false,
  label,
  max,
  min,
  onCommit,
  step,
  value
}: {
  ariaLabel: string;
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onCommit: (value: number) => void;
  step: number;
  value: number;
}) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  function commitValue() {
    const numericValue = Number(draftValue);
    const safeValue = Number.isFinite(numericValue) ? Math.min(max, Math.max(min, Math.round(numericValue))) : value;

    setDraftValue(String(safeValue));

    if (!disabled) {
      onCommit(safeValue);
    }
  }

  function updateDraftValue(nextValue: string) {
    setDraftValue(nextValue);

    const numericValue = Number(nextValue);

    if (!disabled && Number.isFinite(numericValue) && numericValue >= min && numericValue <= max) {
      onCommit(Math.round(numericValue));
    }
  }

  return (
    <label className="table-size-control">
      <span>{label}</span>
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        max={max}
        min={min}
        onBlur={commitValue}
        onChange={(event) => updateDraftValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitValue();
            event.currentTarget.blur();
          }
        }}
        step={step}
        type="number"
        value={draftValue}
      />
      <em>px</em>
    </label>
  );
}

function clampTableDimension(value: number) {
  if (!Number.isFinite(value)) {
    return 3;
  }

  return Math.min(12, Math.max(1, Math.round(value)));
}

function clampTablePixelWidth(value: number) {
  if (!Number.isFinite(value)) {
    return 720;
  }

  return Math.min(editorTablePixelWidthBounds.max, Math.max(editorTablePixelWidthBounds.min, Math.round(value)));
}

function clampTablePixelHeight(value: number) {
  if (!Number.isFinite(value)) {
    return editorTablePixelHeightBounds.min;
  }

  return Math.min(editorTablePixelHeightBounds.max, Math.max(editorTablePixelHeightBounds.min, Math.round(value)));
}

function clampTableRowPixelHeight(value: number) {
  if (!Number.isFinite(value)) {
    return editorTableRowPixelHeightBounds.min;
  }

  return Math.min(editorTableRowPixelHeightBounds.max, Math.max(editorTableRowPixelHeightBounds.min, Math.round(value)));
}

function clampTableColumnPixelWidth(value: number) {
  if (!Number.isFinite(value)) {
    return editorTableColumnPixelWidthBounds.min;
  }

  return Math.min(editorTableColumnPixelWidthBounds.max, Math.max(editorTableColumnPixelWidthBounds.min, Math.round(value)));
}

function currentBlockLineHeight(editor: TipTapEditor | null) {
  if (!editor) {
    return null;
  }

  const inlineLineHeight = Number(editor.getAttributes("lineHeight").lineHeight);

  if (Number.isFinite(inlineLineHeight)) {
    return clampSelectionLineHeight(inlineLineHeight);
  }

  const lineHeight = ["paragraph", "heading", "listItem", "tableCell", "tableHeader"]
    .map((nodeName) => Number(editor.getAttributes(nodeName).qmLineHeight))
    .find((value) => Number.isFinite(value));

  return lineHeight ? clampSelectionLineHeight(lineHeight) : null;
}

function updateSelectedBlockLineHeight(editor: TipTapEditor, lineHeight: number) {
  const safeLineHeight = clampSelectionLineHeight(lineHeight);

  const blockNodeNames = new Set(["paragraph", "heading", "listItem", "tableCell", "tableHeader"]);
  const { from, to, $from } = editor.state.selection;
  const positions = new Set<number>();

  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (blockNodeNames.has(node.type.name)) {
      positions.add(position);
    }
  });

  if (!positions.size) {
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);

      if (blockNodeNames.has(node.type.name)) {
        positions.add($from.before(depth));
        break;
      }
    }
  }

  if (!positions.size) {
    return;
  }

  let transaction = editor.state.tr;

  Array.from(positions)
    .sort((left, right) => left - right)
    .forEach((position) => {
      const node = transaction.doc.nodeAt(position);

      if (node && blockNodeNames.has(node.type.name)) {
        transaction = transaction.setNodeMarkup(position, undefined, {
          ...node.attrs,
          qmLineHeight: safeLineHeight
        });
      }
    });

  if (transaction.docChanged) {
    editor.view.dispatch(transaction);
  }
}

function selectedTableControlState(editor: TipTapEditor): TableControlState | null {
  const { $from } = editor.state.selection;
  let cellDepth = -1;
  let rowDepth = -1;
  let tableDepth = -1;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name;

    if (cellDepth < 0 && (nodeName === "tableCell" || nodeName === "tableHeader")) {
      cellDepth = depth;
    }

    if (rowDepth < 0 && nodeName === "tableRow") {
      rowDepth = depth;
    }

    if (tableDepth < 0 && nodeName === "table") {
      tableDepth = depth;
      break;
    }
  }

  if (cellDepth < 0 || rowDepth < 0 || tableDepth < 0) {
    return null;
  }

  const tableNode = $from.node(tableDepth);
  const rowNode = $from.node(rowDepth);
  const tablePosition = $from.before(tableDepth);
  const rowPosition = $from.before(rowDepth);
  const cellPosition = $from.before(cellDepth);
  const columnIndex = columnIndexFromRowPosition(rowNode, rowPosition, cellPosition);

  if (columnIndex < 0) {
    return null;
  }

  const rows = tableRowsFromNode(tableNode, tablePosition);
  const rowTarget = {
    nodeName: "tableRow" as const,
    position: rowPosition
  };
  const columnTargets = rows.map((row) => row.cells[columnIndex]).filter((target): target is TableResizeNodeTarget => Boolean(target));
  const selectedCell = editor.state.doc.nodeAt(cellPosition);
  const tableColumnWidths = columnWidthsFromDocRows(rows, editor.state.doc);
  const selectedColumnWidth = tableColumnWidthFromNode(selectedCell) ?? tableColumnWidths[columnIndex] ?? 120;
  const totalColumnWidth = tableColumnWidths.reduce((sum, width) => sum + width, 0);

  return {
    columnTargets,
    columnWidthPx: clampTableColumnPixelWidth(selectedColumnWidth),
    rowHeightPx: clampTableRowPixelHeight(Number(rowNode.attrs.qmHeightPx) || 48),
    rowTarget,
    tableHeightPx: clampTablePixelHeight(Number(tableNode.attrs.qmHeightPx) || editorTablePixelHeightBounds.min),
    tableTarget: {
      nodeName: "table",
      position: tablePosition
    },
    tableWidthPx: clampTablePixelWidth(Number(tableNode.attrs.qmWidthPx) || totalColumnWidth || 720)
  };
}

function columnIndexFromRowPosition(rowNode: ProseMirrorNode, rowPosition: number, cellPosition: number) {
  let selectedIndex = -1;

  rowNode.forEach((_cellNode, cellOffset, index) => {
    if (rowPosition + 1 + cellOffset === cellPosition) {
      selectedIndex = index;
    }
  });

  return selectedIndex;
}

function tableRowsFromNode(tableNode: ProseMirrorNode, tablePosition: number) {
  const rows: TableDocumentInfo["rows"] = [];

  tableNode.forEach((rowNode, rowOffset) => {
    if (rowNode.type.name !== "tableRow") {
      return;
    }

    const rowPosition = tablePosition + 1 + rowOffset;
    const cells: TableResizeNodeTarget[] = [];

    rowNode.forEach((cellNode, cellOffset) => {
      if (cellNode.type.name !== "tableCell" && cellNode.type.name !== "tableHeader") {
        return;
      }

      cells.push({
        nodeName: cellNode.type.name === "tableHeader" ? "tableHeader" : "tableCell",
        position: rowPosition + 1 + cellOffset
      });
    });

    rows.push({
      cells,
      target: {
        nodeName: "tableRow",
        position: rowPosition
      }
    });
  });

  return rows;
}

function columnWidthsFromDocRows(rows: TableDocumentInfo["rows"], doc: ProseMirrorNode) {
  const firstRow = rows[0];

  if (!firstRow) {
    return [];
  }

  return firstRow.cells.map((target) => tableColumnWidthFromNode(doc.nodeAt(target.position)) ?? 120);
}

function tableColumnWidthFromNode(node: ProseMirrorNode | null | undefined) {
  const colwidth = Array.isArray(node?.attrs.colwidth) ? Number(node?.attrs.colwidth[0]) : null;
  const qmWidthPx = Number(node?.attrs.qmWidthPx);
  const width = Number.isFinite(qmWidthPx) && qmWidthPx > 0 ? qmWidthPx : Number.isFinite(colwidth) && colwidth ? colwidth : null;

  return width ? clampTableColumnPixelWidth(width) : null;
}

function tableResizeHitFromEvent(editorElement: HTMLElement, event: MouseEvent): TableResizeHit | null {
  const target = event.target;

  if (!(target instanceof HTMLElement) || !editorElement.contains(target)) {
    return null;
  }

  if (target.closest("button, input, select, textarea, a")) {
    return null;
  }

  const table = tableFromResizeEvent(editorElement, target, event);

  if (!table) {
    return null;
  }

  const tableRect = table.getBoundingClientRect();
  const edgeThreshold = 14;
  const boundaryThreshold = 8;
  const withinTableY = event.clientY >= tableRect.top - edgeThreshold && event.clientY <= tableRect.bottom + edgeThreshold;
  const withinTableX = event.clientX >= tableRect.left - edgeThreshold && event.clientX <= tableRect.right + edgeThreshold;
  const nearLeft = withinTableY && Math.abs(event.clientX - tableRect.left) <= edgeThreshold;
  const nearRight = withinTableY && Math.abs(event.clientX - tableRect.right) <= edgeThreshold;
  const nearTop = withinTableX && Math.abs(event.clientY - tableRect.top) <= edgeThreshold;
  const nearBottom = withinTableX && Math.abs(event.clientY - tableRect.bottom) <= edgeThreshold;

  if (nearLeft || nearRight || nearTop || nearBottom) {
    const widthSign = nearLeft ? -1 : nearRight ? 1 : 0;
    const heightSign = nearTop ? -1 : nearBottom ? 1 : 0;
    const cursor: TableResizeCursor =
      widthSign !== 0 && heightSign !== 0 ? "nwse" : widthSign !== 0 ? "ew" : heightSign !== 0 ? "ns" : "col";

    return { cursor, heightSign, kind: "table", table, widthSign };
  }

  const columnCell = tableCellNearVerticalBoundary(table, event, boundaryThreshold);

  if (columnCell) {
    return {
      cell: columnCell,
      columnIndex: columnCell.cellIndex,
      cursor: "col",
      heightSign: 0,
      kind: "column",
      table,
      widthSign: 1
    };
  }

  const row = tableRowNearHorizontalBoundary(table, event, boundaryThreshold);

  if (!row) {
    return null;
  }

  return {
    cursor: "row",
    heightSign: 1,
    kind: "row",
    row,
    table,
    widthSign: 0
  };
}

function tableFromResizeEvent(editorElement: HTMLElement, target: HTMLElement, event: MouseEvent) {
  const targetTable = target.closest("table");

  if (targetTable instanceof HTMLTableElement && editorElement.contains(targetTable)) {
    return targetTable;
  }

  const tables = Array.from(editorElement.querySelectorAll("table"));

  return (
    tables.find((table) => {
      const rect = table.getBoundingClientRect();
      const threshold = 14;

      return (
        event.clientX >= rect.left - threshold &&
        event.clientX <= rect.right + threshold &&
        event.clientY >= rect.top - threshold &&
        event.clientY <= rect.bottom + threshold
      );
    }) ?? null
  );
}

function tableCellNearVerticalBoundary(table: HTMLTableElement, event: MouseEvent, threshold: number) {
  const cells = Array.from(table.querySelectorAll("td, th"));
  const tableRect = table.getBoundingClientRect();

  return (
    cells.find((cell): cell is HTMLTableCellElement => {
      if (!(cell instanceof HTMLTableCellElement)) {
        return false;
      }

      const rect = cell.getBoundingClientRect();
      const nearOuterRight = Math.abs(rect.right - tableRect.right) <= threshold;
      return !nearOuterRight && event.clientY >= rect.top && event.clientY <= rect.bottom && Math.abs(event.clientX - rect.right) <= threshold;
    }) ?? null
  );
}

function tableRowNearHorizontalBoundary(table: HTMLTableElement, event: MouseEvent, threshold: number) {
  const rows = Array.from(table.querySelectorAll("tr"));
  const tableRect = table.getBoundingClientRect();

  return (
    rows.find((row): row is HTMLTableRowElement => {
      if (!(row instanceof HTMLTableRowElement)) {
        return false;
      }

      const rect = row.getBoundingClientRect();
      const nearOuterBottom = Math.abs(rect.bottom - tableRect.bottom) <= threshold;
      return !nearOuterBottom && event.clientX >= rect.left && event.clientX <= rect.right && Math.abs(event.clientY - rect.bottom) <= threshold;
    }) ?? null
  );
}

function tableResizeCursorFromEvent(editorElement: HTMLElement, event: MouseEvent): TableResizeCursor | null {
  const actionableHit = tableResizeHitFromEvent(editorElement, event);

  if (actionableHit) {
    return actionableHit.cursor;
  }

  const target = event.target;

  if (!(target instanceof HTMLElement) || target.closest("button, input, select, textarea, a")) {
    return null;
  }

  const cell = target.closest("td, th");

  if (!(cell instanceof HTMLTableCellElement) || !editorElement.contains(cell)) {
    return null;
  }

  const cellRect = cell.getBoundingClientRect();
  return Math.abs(event.clientX - cellRect.right) <= 6 ? "col" : null;
}

function handleTableBoundaryMouseDown(view: TipTapEditor["view"], event: MouseEvent) {
  if (event.button !== 0 || event.defaultPrevented) {
    return false;
  }

  const target = event.target;

  if (!(target instanceof HTMLElement) || target.closest("td, th")) {
    return false;
  }

  const wrapper = target.closest(".tableWrapper");

  if (!(wrapper instanceof HTMLElement) || !view.dom.contains(wrapper)) {
    return false;
  }

  const targetTable = target.closest("table");
  const table =
    targetTable instanceof HTMLTableElement && wrapper.contains(targetTable)
      ? targetTable
      : wrapper.querySelector("table");
  const cell = table instanceof HTMLTableElement ? nearestTableCellFromPointer(table, event) : null;
  const selection = cell ? selectionInsideTableCell(view, cell) : null;

  if (!selection) {
    return false;
  }

  event.preventDefault();
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
  return true;
}

function nearestTableCellFromPointer(table: HTMLTableElement, event: MouseEvent) {
  const cells = Array.from(table.querySelectorAll("td, th")).filter(
    (cell): cell is HTMLTableCellElement => cell instanceof HTMLTableCellElement
  );

  if (!cells.length) {
    return null;
  }

  return cells.reduce((nearestCell, cell) => {
    const currentDistance = pointerDistanceFromRect(event, cell.getBoundingClientRect());
    const nearestDistance = pointerDistanceFromRect(event, nearestCell.getBoundingClientRect());

    return currentDistance < nearestDistance ? cell : nearestCell;
  }, cells[0]);
}

function pointerDistanceFromRect(event: MouseEvent, rect: DOMRect) {
  const distanceX = event.clientX < rect.left ? rect.left - event.clientX : Math.max(0, event.clientX - rect.right);
  const distanceY = event.clientY < rect.top ? rect.top - event.clientY : Math.max(0, event.clientY - rect.bottom);

  return distanceX * distanceX + distanceY * distanceY;
}

function selectionInsideTableCell(view: TipTapEditor["view"], cell: HTMLTableCellElement) {
  const rawPosition = view.posAtDOM(cell, 0);
  const maxPosition = view.state.doc.content.size;

  for (let position = Math.max(0, rawPosition - 2); position <= Math.min(maxPosition, rawPosition + 2); position += 1) {
    const node = view.state.doc.nodeAt(position);

    if (node?.type.name === "tableCell" || node?.type.name === "tableHeader") {
      return selectionNearPosition(view.state.doc, position + 1);
    }
  }

  return selectionNearPosition(view.state.doc, rawPosition);
}

function selectionNearPosition(doc: ProseMirrorNode, position: number) {
  const safePosition = Math.min(Math.max(position, 0), doc.content.size);

  try {
    const resolvedPosition = doc.resolve(safePosition);
    return Selection.findFrom(resolvedPosition, 1, true) ?? Selection.near(resolvedPosition, 1);
  } catch {
    return null;
  }
}

function tableResizeSessionFromHit(editor: TipTapEditor, hit: TableResizeHit): TableResizeSession | null {
  const tableIndex = tableIndexFromElement(editor.view.dom as HTMLElement, hit.table);
  const tableInfo = tableIndex >= 0 ? tableDocumentInfoByIndex(editor, tableIndex) : null;

  if (!tableInfo) {
    return null;
  }

  const rowIndex = hit.row ? Array.from(hit.table.rows).indexOf(hit.row) : -1;
  const rowTarget = rowIndex >= 0 ? tableInfo.rows[rowIndex]?.target ?? null : null;
  const columnCellTargets =
    hit.kind === "column" && typeof hit.columnIndex === "number"
      ? tableInfo.rows.map((row) => row.cells[hit.columnIndex!]).filter((target): target is TableResizeNodeTarget => Boolean(target))
      : [];
  const startColumnWidths = columnWidthsFromTable(hit.table);

  return { columnCellTargets, rowTarget, startColumnWidths, tableTarget: tableInfo.tableTarget };
}

function tableIndexFromElement(editorElement: HTMLElement, table: HTMLTableElement) {
  return Array.from(editorElement.querySelectorAll("table")).indexOf(table);
}

function tableDocumentInfoByIndex(editor: TipTapEditor, tableIndex: number): TableDocumentInfo | null {
  let currentIndex = -1;
  let tableInfo: TableDocumentInfo | null = null;

  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== "table") {
      return true;
    }

    currentIndex += 1;

    if (currentIndex !== tableIndex) {
      return false;
    }

    const rows: TableDocumentInfo["rows"] = [];

    node.forEach((rowNode, rowOffset) => {
      if (rowNode.type.name !== "tableRow") {
        return;
      }

      const rowPosition = position + 1 + rowOffset;
      const cells: TableResizeNodeTarget[] = [];

      rowNode.forEach((cellNode, cellOffset) => {
        if (cellNode.type.name !== "tableCell" && cellNode.type.name !== "tableHeader") {
          return;
        }

        cells.push({
          nodeName: cellNode.type.name === "tableHeader" ? "tableHeader" : "tableCell",
          position: rowPosition + 1 + cellOffset
        });
      });

      rows.push({
        cells,
        target: {
          nodeName: "tableRow",
          position: rowPosition
        }
      });
    });

    tableInfo = {
      rows,
      tableTarget: {
        nodeName: "table",
        position
      }
    };

    return false;
  });

  return tableInfo;
}

function updateTableColumnWidthFromSession(
  editor: TipTapEditor,
  session: TableResizeSession,
  columnIndex: number,
  width: number
) {
  if (!session.columnCellTargets.length) {
    return false;
  }

  const nextColumnWidths = session.startColumnWidths.map((columnWidth, index) =>
    index === columnIndex ? width : clampTableColumnPixelWidth(columnWidth)
  );
  const updates: Array<{ attrs: Record<string, number | number[] | null>; target: TableResizeNodeTarget }> = [];

  if (session.tableTarget && nextColumnWidths.length) {
    updates.push({
      target: session.tableTarget,
      attrs: {
        qmWidth: null,
        qmWidthPx: clampTablePixelWidth(nextColumnWidths.reduce((sum, columnWidth) => sum + columnWidth, 0))
      }
    });
  }

  session.columnCellTargets.forEach((target) => {
    const node = editor.state.doc.nodeAt(target.position);
    const colspan = Number(node?.attrs.colspan) || 1;

    updates.push({
      target,
      attrs: {
        colwidth: Array.from({ length: colspan }, () => width),
        qmWidthPx: width
      }
    });
  });

  return dispatchNodeAttributeUpdates(editor, updates);
}

function columnWidthsFromTable(table: HTMLTableElement) {
  const firstRow = table.rows[0];

  if (!firstRow) {
    return [];
  }

  return Array.from(firstRow.cells).map((cell) => clampTableColumnPixelWidth(cell.getBoundingClientRect().width));
}

function dispatchNodeAttributeUpdates(
  editor: TipTapEditor,
  updates: Array<{ attrs: Record<string, number | number[] | null>; target: TableResizeNodeTarget }>
) {
  let transaction = editor.state.tr;

  updates.forEach(({ attrs, target }) => {
    const node = transaction.doc.nodeAt(target.position);

    if (!node || node.type.name !== target.nodeName) {
      return;
    }

    transaction = transaction.setNodeMarkup(target.position, undefined, {
      ...node.attrs,
      ...attrs
    });
  });

  if (!transaction.docChanged) {
    return false;
  }

  editor.view.dispatch(transaction);
  return true;
}

function RemoteCursorLayer({
  cursors,
  editorRef
}: {
  cursors: RemoteCursorView[];
  editorRef: RefObject<HTMLDivElement | null>;
}) {
  const [positions, setPositions] = useState<Array<RemoteCursorView & { left: number; top: number; height: number }>>([]);

  useEffect(() => {
    const editorElement = editorRef.current;

    if (!editorElement || !cursors.length) {
      setPositions([]);
      return undefined;
    }

    let animationFrame = 0;

    const measure = () => {
      const nextPositions = cursors
        .map((cursor) => {
          const position = cursorPositionFromOffset(editorElement, cursor.cursorOffset);
          return position ? { ...cursor, ...position } : null;
        })
        .filter((cursor): cursor is RemoteCursorView & { left: number; top: number; height: number } => Boolean(cursor));

      setPositions(nextPositions);
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    editorElement.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      editorElement.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [cursors, editorRef]);

  if (!positions.length) {
    return null;
  }

  return (
    <div className="remote-cursor-layer" aria-hidden="true">
      {positions.map((cursor) => (
        <span
          className="remote-cursor"
          key={cursor.uid}
          style={{
            "--cursor-color": cursor.color,
            height: Math.max(cursor.height, 18),
            left: cursor.left,
            top: cursor.top
          } as CSSProperties}
        >
          <span>{cursor.displayName}</span>
        </span>
      ))}
    </div>
  );
}

function cursorPositionFromOffset(element: HTMLElement, offset: number) {
  const frame = element.parentElement;

  if (!frame) {
    return null;
  }

  const frameRect = frame.getBoundingClientRect();
  const editorRect = element.getBoundingClientRect();
  const textLength = element.textContent?.length ?? 0;

  if (textLength === 0) {
    return {
      left: editorRect.left - frameRect.left + 14,
      top: editorRect.top - frameRect.top + 14,
      height: 20
    };
  }

  const safeOffset = Math.min(Math.max(Math.round(offset), 0), textLength);
  const range = rangeFromCharacterOffset(element, safeOffset);

  if (!range) {
    return null;
  }

  const rect = readableCursorRect(range, element, safeOffset);

  if (!rect || rect.bottom < editorRect.top || rect.top > editorRect.bottom) {
    return null;
  }

  return {
    left: Math.min(Math.max(rect.left - frameRect.left, 0), editorRect.right - frameRect.left),
    top: Math.min(Math.max(rect.top - frameRect.top, 0), editorRect.bottom - frameRect.top),
    height: rect.height || 20
  };
}

function readableCursorRect(range: Range, element: HTMLElement, offset: number): CursorClientRect | null {
  const directRect = range.getClientRects()[0] ?? range.getBoundingClientRect();

  if (directRect && (directRect.height > 0 || directRect.width > 0)) {
    return directRect;
  }

  if (offset <= 0) {
    return element.getBoundingClientRect();
  }

  const previousRange = rangeFromCharacterSpan(element, offset - 1, offset);
  const previousRect = previousRange?.getClientRects()[0] ?? previousRange?.getBoundingClientRect();

  if (!previousRect) {
    return null;
  }

  return {
    bottom: previousRect.bottom,
    height: previousRect.height,
    left: previousRect.right,
    right: previousRect.right,
    top: previousRect.top,
    width: 0
  };
}

function rangeFromCharacterOffset(element: HTMLElement, offset: number) {
  const range = rangeFromCharacterSpan(element, offset, offset);

  if (range) {
    return range;
  }

  const fallbackRange = document.createRange();
  fallbackRange.selectNodeContents(element);
  fallbackRange.collapse(false);
  return fallbackRange;
}

function rangeFromCharacterSpan(element: HTMLElement, startOffset: number, endOffset: number) {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let currentNode = walker.nextNode();
  let rangeStarted = false;

  while (currentNode) {
    const textLength = currentNode.textContent?.length ?? 0;
    const nextOffset = currentOffset + textLength;

    if (!rangeStarted && startOffset <= nextOffset) {
      range.setStart(currentNode, Math.max(0, startOffset - currentOffset));
      rangeStarted = true;
    }

    if (rangeStarted && endOffset <= nextOffset) {
      range.setEnd(currentNode, Math.max(0, endOffset - currentOffset));
      return range;
    }

    currentOffset = nextOffset;
    currentNode = walker.nextNode();
  }

  return null;
}

function readImageWidthPx(image: HTMLImageElement) {
  const explicitWidth = Number(image.dataset.qmImageWidth ?? image.style.width.replace("px", ""));

  if (Number.isFinite(explicitWidth) && image.style.width.endsWith("px")) {
    return clampImagePixelWidth(explicitWidth);
  }

  return clampImagePixelWidth(Math.round(image.getBoundingClientRect().width || image.naturalWidth || editorImagePixelWidthBounds.max));
}

function imageElementAtPosition(editor: TipTapEditor, position: number, fallbackSrc?: string) {
  const node = editor.view.nodeDOM(position);

  if (node instanceof HTMLImageElement) {
    return node;
  }

  const nestedImage = node instanceof HTMLElement ? node.querySelector("img") : null;
  const selectedImage = editor.view.dom.querySelector("img.ProseMirror-selectednode");

  if (nestedImage instanceof HTMLImageElement) {
    return nestedImage;
  }

  if (selectedImage instanceof HTMLImageElement) {
    return selectedImage;
  }

  if (!fallbackSrc) {
    return null;
  }

  return Array.from(editor.view.dom.querySelectorAll("img")).find((image) => image.currentSrc === fallbackSrc || image.src === fallbackSrc) ?? null;
}

function clampImagePixelWidth(value: number) {
  if (!Number.isFinite(value)) {
    return editorImagePixelWidthBounds.max;
  }

  return Math.min(editorImagePixelWidthBounds.max, Math.max(editorImagePixelWidthBounds.min, Math.round(value)));
}

function getCaretCharacterOffset(element: HTMLElement | null) {
  if (!element) {
    return null;
  }

  const selection = window.getSelection();

  if (!selection?.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0);

  if (!element.contains(range.startContainer)) {
    return null;
  }

  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);
  return preCaretRange.toString().length;
}

function NoteDrawer({
  activeNoteId,
  attentionNoteIds,
  canRestoreNote,
  clockMs,
  counts,
  deletedCounts,
  deletedNotes,
  filter,
  folders,
  noteStates,
  notes,
  onClose,
  onFilterChange,
  onOpenOverview,
  onPreview,
  onPurge,
  onPurgeAll,
  onQueryChange,
  onRestore,
  onSortChange,
  onTogglePin,
  open,
  publicShareByNoteId,
  query,
  sortSetting
}: {
  activeNoteId: string | null;
  attentionNoteIds: Set<string>;
  canRestoreNote: (note: DecryptedNote) => boolean;
  clockMs: number;
  counts: NoteListCounts;
  deletedCounts: NoteListCounts;
  deletedNotes: DecryptedNote[];
  filter: NoteListFilter;
  folders: NoteFolderSnapshot[];
  noteStates: NoteStateByNoteId;
  notes: DecryptedNote[];
  onClose: () => void;
  onFilterChange: (filter: NoteListFilter) => void;
  onOpenOverview: (filter?: OverviewFolderFilter) => void;
  onPreview: (note: DecryptedNote) => void;
  onPurge: (note: DecryptedNote) => void;
  onPurgeAll: (notes: DecryptedNote[]) => void;
  onQueryChange: (query: string) => void;
  onRestore: (note: DecryptedNote) => void;
  onSortChange: (setting: NoteSortSetting) => void;
  onTogglePin: (note: DecryptedNote) => void;
  open: boolean;
  publicShareByNoteId: Map<string, PublicNoteShareSnapshot>;
  query: string;
  sortSetting: NoteSortSetting;
}) {
  const [mode, setMode] = useState<DrawerMode>("notes");

  if (!open) {
    return null;
  }

  const isTrashMode = mode === "trash";
  const listedNotes = isTrashMode ? deletedNotes : notes;
  const visibleCounts = isTrashMode ? deletedCounts : counts;
  const sharedAttentionCount = isTrashMode ? 0 : attentionNoteIds.size;

  return (
    <aside className="note-drawer" aria-label="노트 목록">
      <div className="note-drawer-header">
        <h2>
          <ListChecks size={18} />
          {isTrashMode ? "복구함" : "전체 노트"}
          {!isTrashMode && attentionNoteIds.size ? <span className="drawer-alert-badge">{attentionNoteIds.size}</span> : null}
        </h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="노트 목록 닫기">
          <X size={18} />
        </button>
      </div>
      <label className="note-search-control">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">노트 검색</span>
        <input
          aria-label="노트 제목과 내용 검색"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="제목 또는 내용 검색"
          type="search"
          value={query}
        />
      </label>
      {!isTrashMode && (
        <div className="drawer-folder-shortcuts" aria-label="노트 그룹 바로가기">
          <button className="secondary-button" type="button" onClick={() => onOpenOverview("all")}>
            <LayoutGrid size={15} />
            전체 조회
          </button>
          {counts.shared ? (
            <button
              className={`secondary-button ${sharedAttentionCount ? "has-alert" : ""}`}
              type="button"
              onClick={() => onOpenOverview("shared")}
            >
              <Share2 size={15} />
              <span className="filter-label-with-badge">
                <span>공유 노트</span>
                {sharedAttentionCount ? <span className="filter-alert-badge">{sharedAttentionCount}</span> : null}
              </span>
            </button>
          ) : null}
          {folders.length ? (
            <div>
              {folders.slice(0, 5).map((folder) => (
                <button
                  key={folder.id}
                  style={{ "--folder-color": folder.color } as CSSProperties}
                  type="button"
                  onClick={() => onOpenOverview(folder.id)}
                >
                  <span className="folder-dot" />
                  <span>{folder.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="drawer-folder-empty">생성된 그룹 없음</span>
          )}
        </div>
      )}
      <div className="drawer-mode-tabs" role="group" aria-label="노트 목록 모드">
        <button
          aria-pressed={!isTrashMode}
          className={!isTrashMode ? "active" : ""}
          type="button"
          onClick={() => setMode("notes")}
        >
          노트
        </button>
        <button
          aria-pressed={isTrashMode}
          className={isTrashMode ? "active" : ""}
          type="button"
          onClick={() => setMode("trash")}
        >
          복구함
          <strong>{deletedCounts.all}</strong>
        </button>
      </div>
      <div className="note-filter-tabs" role="group" aria-label="노트 종류 필터">
        <NoteFilterButton
          count={visibleCounts.all}
          filter="all"
          label="전체"
          selected={filter === "all"}
          onSelect={onFilterChange}
        />
        <NoteFilterButton
          count={visibleCounts.personal}
          filter="personal"
          label="개인"
          selected={filter === "personal"}
          onSelect={onFilterChange}
        />
        <NoteFilterButton
          alertCount={sharedAttentionCount}
          count={visibleCounts.shared}
          filter="shared"
          label="공유"
          selected={filter === "shared"}
          onSelect={onFilterChange}
        />
      </div>
      {!isTrashMode && (
        <div className="note-sort-controls">
          <label className="font-size-control">
            정렬
            <select
              aria-label="노트 목록 정렬 기준"
              onChange={(event) => onSortChange({ ...sortSetting, field: event.target.value as NoteSortField })}
              value={sortSetting.field}
            >
              <option value="createdAt">생성일</option>
              <option value="updatedAt">수정일</option>
              <option value="title">제목</option>
            </select>
          </label>
          <button
            className="secondary-button note-sort-direction"
            type="button"
            onClick={() =>
              onSortChange({
                ...sortSetting,
                direction: sortSetting.direction === "asc" ? "desc" : "asc"
              })
            }
          >
            <ArrowUpDown size={16} />
            {sortSetting.direction === "asc" ? "오름차순" : "내림차순"}
          </button>
        </div>
      )}
      {isTrashMode && (
        <div className="trash-tools">
          <p className="trash-retention-hint">삭제된 노트는 {deletedNoteRetentionDays}일 보관 기준으로 표시됩니다.</p>
          {listedNotes.length > 0 && (
            <button className="secondary-button danger" type="button" onClick={() => onPurgeAll(listedNotes)}>
              <Trash2 size={15} />
              전체삭제
            </button>
          )}
        </div>
      )}
      <NoteList
        activeNoteId={activeNoteId}
        attentionNoteIds={isTrashMode ? new Set<string>() : attentionNoteIds}
        canRestoreNote={canRestoreNote}
        clockMs={clockMs}
        deleted={isTrashMode}
        filter={filter}
        noteStates={noteStates}
        notes={listedNotes}
        onPreview={onPreview}
        onPurge={onPurge}
        onRestore={onRestore}
        onTogglePin={onTogglePin}
        folders={folders}
        publicShareByNoteId={publicShareByNoteId}
        query={query}
        sortSetting={sortSetting}
      />
    </aside>
  );
}

function NoteFilterButton({
  alertCount = 0,
  count,
  filter,
  label,
  onSelect,
  selected
}: {
  alertCount?: number;
  count: number;
  filter: NoteListFilter;
  label: string;
  onSelect: (filter: NoteListFilter) => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`note-filter-tab ${selected ? "active" : ""}`}
      type="button"
      onClick={() => onSelect(filter)}
    >
      <span className="filter-label-with-badge">
        <span>{label}</span>
        {alertCount ? <span className="filter-alert-badge">{alertCount}</span> : null}
      </span>
      <strong>{count}</strong>
    </button>
  );
}

function PublicShareStatusBadge({
  clockMs,
  share
}: {
  clockMs: number;
  share: PublicNoteShareSnapshot | undefined;
}) {
  const label = publicShareRemainingLabel(share, clockMs);

  if (!share || !label) {
    return null;
  }

  return (
    <span className={`public-share-list-badge ${publicShareTone(share, clockMs)}`}>
      <Share2 size={12} />
      URL 공유 · {label}
    </span>
  );
}

function HighlightedText({ query, text }: { query: string; text: string }) {
  const term = normalizedSearchTerm(query);

  if (!term) {
    return <>{text}</>;
  }

  const lowerText = text.toLocaleLowerCase("ko");
  const parts: Array<{ highlighted: boolean; value: string }> = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(term);

  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      parts.push({ highlighted: false, value: text.slice(cursor, matchIndex) });
    }

    parts.push({ highlighted: true, value: text.slice(matchIndex, matchIndex + term.length) });
    cursor = matchIndex + term.length;
    matchIndex = lowerText.indexOf(term, cursor);
  }

  if (cursor < text.length) {
    parts.push({ highlighted: false, value: text.slice(cursor) });
  }

  return (
    <>
      {parts.map((part, index) =>
        part.highlighted ? (
          <mark key={`${part.value}-${index}`} className="search-highlight">
            {part.value}
          </mark>
        ) : (
          <span key={`${part.value}-${index}`}>{part.value}</span>
        )
      )}
    </>
  );
}

function NoteList({
  activeNoteId,
  attentionNoteIds,
  canRestoreNote,
  clockMs,
  deleted = false,
  filter,
  folders,
  noteStates,
  notes,
  onPreview,
  onPurge,
  onRestore,
  onTogglePin,
  publicShareByNoteId,
  query,
  sortSetting
}: {
  activeNoteId: string | null;
  attentionNoteIds: Set<string>;
  canRestoreNote: (note: DecryptedNote) => boolean;
  clockMs: number;
  deleted?: boolean;
  filter: NoteListFilter;
  folders: NoteFolderSnapshot[];
  noteStates: NoteStateByNoteId;
  notes: DecryptedNote[];
  onPreview: (note: DecryptedNote) => void;
  onPurge: (note: DecryptedNote) => void;
  onRestore: (note: DecryptedNote) => void;
  onTogglePin: (note: DecryptedNote) => void;
  publicShareByNoteId: Map<string, PublicNoteShareSnapshot>;
  query: string;
  sortSetting: NoteSortSetting;
}) {
  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);

  if (notes.length === 0) {
    const emptyMessage = query.trim()
      ? "검색 조건에 맞는 노트가 없습니다."
      : deleted
        ? "복구함에 노트가 없습니다."
        : filter === "personal"
          ? "아직 저장된 개인 노트가 없습니다."
          : filter === "shared"
            ? "아직 저장된 공유 노트가 없습니다."
            : "아직 저장된 노트가 없습니다.";

    return (
      <div className="empty-state note-empty-state">
        <strong>{emptyMessage}</strong>
        <p>{query.trim() ? "다른 검색어나 필터로 다시 찾아보세요." : "새 노트를 만들거나 공유 노트를 확인해보세요."}</p>
      </div>
    );
  }

  return (
    <div className="note-list">
      {notes.map((note) => {
        const createdAt = dateFromTimestamp(note.createdAt);
        const updatedAt = dateFromTimestamp(note.updatedAt);
        const deletedAt = dateFromTimestamp(note.deletedAt);
        const pinned = notePinned(note.id, noteStates);
        const canRestore = canRestoreNote(note);
        const needsAttention = attentionNoteIds.has(note.id);
        const publicShare = deleted ? undefined : publicShareByNoteId.get(note.id);
        const folder = note.type === "personal" && note.folderId ? folderById.get(note.folderId) : null;
        const listDate = deleted ? deletedAt : sortSetting.field === "createdAt" ? createdAt : updatedAt;
        const listDateLabel = deleted ? "삭제" : sortSetting.field === "createdAt" ? "생성" : "수정";

        return (
          <article
            key={note.id}
            className={`note-list-item ${activeNoteId === note.id ? "active" : ""} ${deleted ? "deleted" : ""} ${needsAttention ? "needs-attention" : ""}`}
          >
            <button className="note-list-open" type="button" onClick={() => onPreview(note)}>
              <header>
                <span className={`note-kind-pill ${note.type}`}>
                  {note.type === "shared" ? <Share2 size={12} /> : null}
                  {note.type === "shared" ? "공유" : "개인"}
                </span>
                {folder && (
                  <span className="note-folder-badge" style={{ "--folder-color": folder.color } as CSSProperties}>
                    {folder.name}
                  </span>
                )}
                <PublicShareStatusBadge clockMs={clockMs} share={publicShare} />
                {needsAttention && <span className="note-list-alert">새 업데이트</span>}
                <strong>
                  <HighlightedText text={note.title || "제목 없음"} query={query} />
                </strong>
              </header>
              <span className="note-snippet">
                <HighlightedText text={notePreviewText(note) || "내용 없음"} query={query} />
              </span>
              <footer className="note-list-meta">
                <span className="note-list-date">
                  <span>{listDateLabel}</span>
                  <strong>{formatCompactDateTime(listDate)}</strong>
                  {deleted && <em>{deletedRetentionLabel(note)}</em>}
                </span>
              </footer>
            </button>
            <div className="note-list-quick-actions">
              {!deleted && (
                <button
                  aria-label={pinned ? "즐겨찾기 해제" : "즐겨찾기"}
                  className={`icon-button star-button ${pinned ? "active" : ""}`}
                  onClick={() => onTogglePin(note)}
                  title={pinned ? "즐겨찾기 해제" : "즐겨찾기"}
                  type="button"
                >
                  <Star fill="currentColor" size={17} />
                </button>
              )}
              {deleted && (
                <>
                  <button
                    aria-label="노트 복구"
                    className="icon-button restore"
                    disabled={!canRestore}
                    onClick={() => onRestore(note)}
                    title={canRestore ? "노트 복구" : "소유자 또는 관리자만 복구할 수 있습니다."}
                    type="button"
                  >
                    <RotateCcw size={17} />
                  </button>
                  <button
                    aria-label="노트 즉시 삭제"
                    className="icon-button danger"
                    disabled={!canRestore}
                    onClick={() => onPurge(note)}
                    title={canRestore ? "즉시 삭제" : "소유자 또는 관리자만 즉시 삭제할 수 있습니다."}
                    type="button"
                  >
                    <Trash2 size={17} />
                  </button>
                </>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PersonalOverview({
  activeFolderFilter,
  attentionNoteIds,
  clockMs,
  folders,
  feedbackError,
  feedbackStatus,
  noteStates,
  notes,
  onBack,
  onCreateFolder,
  onDeleteFolder,
  onFolderFilterChange,
  onPreview,
  onUpdateNoteFolder,
  publicShareByNoteId,
  sortSetting
}: {
  activeFolderFilter: OverviewFolderFilter;
  attentionNoteIds: Set<string>;
  clockMs: number;
  folders: NoteFolderSnapshot[];
  feedbackError: string | null;
  feedbackStatus: string;
  noteStates: NoteStateByNoteId;
  notes: DecryptedNote[];
  onBack: () => void;
  onCreateFolder: (name: string, color: string) => Promise<string | null>;
  onDeleteFolder: (folder: NoteFolderSnapshot) => void;
  onFolderFilterChange: (filter: OverviewFolderFilter) => void;
  onPreview: (note: DecryptedNote) => void;
  onUpdateNoteFolder: (note: DecryptedNote, folderId: string | null) => void;
  publicShareByNoteId: Map<string, PublicNoteShareSnapshot>;
  sortSetting: NoteSortSetting;
}) {
  const [folderName, setFolderName] = useState("");
  const [folderColor, setFolderColor] = useState(folderColorOptions[0]);
  const [overviewQuery, setOverviewQuery] = useState("");
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const personalNotes = notes.filter((note) => note.type === "personal");
  const sharedNotes = notes.filter((note) => note.type === "shared");
  const sharedAttentionCount = sharedNotes.filter((note) => attentionNoteIds.has(note.id)).length;
  const visibleNotes = notes.filter((note) => {
    if (activeFolderFilter === "all") {
      return noteMatchesQuery(note, overviewQuery);
    }

    if (activeFolderFilter === "shared") {
      return note.type === "shared" && noteMatchesQuery(note, overviewQuery);
    }

    if (activeFolderFilter === "unfiled") {
      return note.type === "personal" && (!note.folderId || !foldersById.has(note.folderId)) && noteMatchesQuery(note, overviewQuery);
    }

    return note.type === "personal" && note.folderId === activeFolderFilter && noteMatchesQuery(note, overviewQuery);
  });
  const unfiledCount = personalNotes.filter((note) => !note.folderId || !foldersById.has(note.folderId)).length;
  const activeFolder = typeof activeFolderFilter === "string" ? foldersById.get(activeFolderFilter) : null;
  const activeFilterLabel =
    activeFolderFilter === "all"
      ? "전체 노트"
      : activeFolderFilter === "shared"
        ? "공유 노트"
        : activeFolderFilter === "unfiled"
          ? "미분류"
          : activeFolder?.name ?? "분류";
  const showFeedback = feedbackError || feedbackStatus.includes("폴더") || feedbackStatus.includes("분류");

  async function submitFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (await onCreateFolder(folderName, folderColor)) {
      setFolderName("");
    }
  }

  return (
    <section className="personal-overview" aria-label="노트 전체 조회">
      <header className="personal-overview-header">
        <div>
          <span className="note-kind-pill personal">
            <Folder size={12} />
            개인 {personalNotes.length} · 공유 {sharedNotes.length}
          </span>
          <h2>전체 조회</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onBack}>
          <Pencil size={16} />
          편집으로 돌아가기
        </button>
      </header>
      <div className="personal-overview-layout">
        <aside className="overview-folder-panel" aria-label="노트 분류">
          <form className="folder-create-form" onSubmit={(event) => void submitFolder(event)}>
            <label>
              폴더 이름
              <input
                maxLength={40}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="새 그룹"
                value={folderName}
              />
            </label>
            <div className="folder-color-picker" aria-label="폴더 색상">
              <label className="custom-color-input" title="직접 색상 선택">
                <Palette size={14} />
                <input
                  aria-label="폴더 색상 직접 선택"
                  onChange={(event) => setFolderColor(normalizeCustomHexColor(event.target.value, folderColor))}
                  type="color"
                  value={folderColor}
                />
              </label>
              {folderColorOptions.map((color) => (
                <button
                  aria-label={`${color} 폴더 색상`}
                  aria-pressed={folderColor === color}
                  className={folderColor === color ? "active" : ""}
                  key={color}
                  onClick={() => setFolderColor(color)}
                  style={{ backgroundColor: color }}
                  type="button"
                />
              ))}
            </div>
            <button type="submit">
              <FolderPlus size={16} />
              폴더 생성
            </button>
          </form>
          {showFeedback && (
            <p className={feedbackError ? "form-error overview-feedback" : "form-success overview-feedback"}>
              {feedbackError ?? feedbackStatus}
            </p>
          )}
          <div className="folder-filter-chips" role="tablist" aria-label="노트 폴더 필터">
            <button
              aria-selected={activeFolderFilter === "all"}
              className={`folder-filter-button ${activeFolderFilter === "all" ? "active" : ""}`}
              onClick={() => onFolderFilterChange("all")}
              role="tab"
              type="button"
            >
              <span>전체</span>
              <strong>{notes.length}</strong>
            </button>
            <button
              aria-selected={activeFolderFilter === "shared"}
              className={`folder-filter-button shared-filter ${activeFolderFilter === "shared" ? "active" : ""}`}
              onClick={() => onFolderFilterChange("shared")}
              role="tab"
              type="button"
            >
              <span className="filter-label-with-badge">
                <span>공유 노트</span>
                {sharedAttentionCount ? <span className="filter-alert-badge">{sharedAttentionCount}</span> : null}
              </span>
              <strong>{sharedNotes.length}</strong>
            </button>
            <button
              aria-selected={activeFolderFilter === "unfiled"}
              className={`folder-filter-button ${activeFolderFilter === "unfiled" ? "active" : ""}`}
              onClick={() => onFolderFilterChange("unfiled")}
              role="tab"
              type="button"
            >
              <span>미분류</span>
              <strong>{unfiledCount}</strong>
            </button>
            {folders.map((folder) => {
              const folderCount = personalNotes.filter((note) => note.folderId === folder.id).length;

              return (
                <div className="folder-filter-row" key={folder.id} style={{ "--folder-color": folder.color } as CSSProperties}>
                  <button
                    aria-selected={activeFolderFilter === folder.id}
                    className={`folder-filter-button ${activeFolderFilter === folder.id ? "active" : ""}`}
                    onClick={() => onFolderFilterChange(folder.id)}
                    role="tab"
                    type="button"
                  >
                    <span className="folder-chip-name">{folder.name}</span>
                    <strong>{folderCount}</strong>
                  </button>
                  <button
                    aria-label={`${folder.name} 그룹 삭제`}
                    className="icon-button danger folder-delete-button"
                    onClick={() => onDeleteFolder(folder)}
                    title="그룹 삭제"
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
        <section className="overview-note-panel" aria-label={`${activeFilterLabel} 목록`}>
          <div className="overview-note-panel-header">
            <div>
              <span>{activeFilterLabel}</span>
              <h3>{visibleNotes.length}개 노트</h3>
            </div>
            <label className="note-search-control overview-search-control">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">전체 조회 검색</span>
              <input
                aria-label="전체 조회에서 노트 검색"
                onChange={(event) => setOverviewQuery(event.target.value)}
                placeholder="이 분류에서 검색"
                type="search"
                value={overviewQuery}
              />
            </label>
          </div>
          {visibleNotes.length ? (
            <div className="overview-note-grid">
              {visibleNotes.map((note) => {
                const folder = note.type === "personal" && note.folderId ? foldersById.get(note.folderId) : null;
                const createdAt = dateFromTimestamp(note.createdAt);
                const updatedAt = dateFromTimestamp(note.updatedAt);
                const cardDate = sortSetting.field === "createdAt" ? createdAt : updatedAt;
                const cardDateLabel = sortSetting.field === "createdAt" ? "생성" : "수정";
                const pinned = notePinned(note.id, noteStates);
                const needsAttention = attentionNoteIds.has(note.id);
                const publicShare = publicShareByNoteId.get(note.id);

                return (
                  <article className={`overview-note-card ${needsAttention ? "needs-attention" : ""}`} key={note.id}>
                    <button className="overview-note-open" type="button" onClick={() => onPreview(note)}>
                      <span
                        className="overview-note-folder"
                        style={{ backgroundColor: note.type === "shared" ? "#3f6fb5" : folder?.color ?? "var(--color-surface-muted)" }}
                      >
                        {note.type === "shared" ? "공유 노트" : folder?.name ?? "미분류"}
                      </span>
                      <PublicShareStatusBadge clockMs={clockMs} share={publicShare} />
                      {needsAttention && <span className="overview-note-alert">새 업데이트</span>}
                      <strong>
                        <HighlightedText text={note.title || "제목 없음"} query={overviewQuery} />
                      </strong>
                      <span>
                        <HighlightedText text={notePreviewText(note) || "내용 없음"} query={overviewQuery} />
                      </span>
                      <em>
                        {pinned ? "즐겨찾기 · " : ""}
                        {cardDateLabel} {formatCompactDateTime(cardDate)}
                      </em>
                    </button>
                    {note.type === "personal" ? (
                      <label className="overview-folder-select">
                        <span className="sr-only">폴더 지정</span>
                        <select
                          onChange={(event) => onUpdateNoteFolder(note, event.target.value || null)}
                          value={note.folderId && foldersById.has(note.folderId) ? note.folderId : ""}
                        >
                          <option value="">미분류</option>
                          {folders.map((folderOption) => (
                            <option key={folderOption.id} value={folderOption.id}>
                              {folderOption.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <span className="overview-shared-label">
                        <Share2 size={13} />
                        공유 노트
                      </span>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state note-empty-state">
              <strong>{overviewQuery.trim() ? "검색 조건에 맞는 노트가 없습니다." : "이 분류에 표시할 노트가 없습니다."}</strong>
              <p>{overviewQuery.trim() ? "검색어를 줄이거나 다른 분류를 선택해보세요." : "폴더를 바꾸거나 새 노트를 만들어 정리해보세요."}</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function AttachmentUploadProgressToast({ progress }: { progress: AttachmentUploadProgressState }) {
  const phaseLabel = attachmentUploadPhaseLabel[progress.phase];
  const overallPercent = clampUploadPercent(progress.overallPercent);
  const filePercent = clampUploadPercent(progress.percent);
  const fileCountLabel = progress.fileCount > 1 ? `${progress.fileIndex}/${progress.fileCount}` : "1개 파일";
  const byteLabel =
    progress.totalBytes > 0
      ? `${formatFileSize(progress.loadedBytes)} / ${formatFileSize(progress.totalBytes)}`
      : "업로드 준비 중";
  const isTerminal = progress.phase === "complete" || progress.phase === "failed";

  return (
    <aside
      aria-live="polite"
      className={`attachment-upload-toast ${progress.phase}`}
      role={progress.phase === "failed" ? "alert" : "status"}
    >
      <div className="attachment-upload-toast-head">
        <span className="attachment-upload-icon" aria-hidden="true">
          {progress.phase === "complete" ? (
            <CheckCircle2 size={18} />
          ) : progress.phase === "failed" ? (
            <X size={18} />
          ) : (
            <Upload size={18} />
          )}
        </span>
        <div>
          <strong>{phaseLabel}</strong>
          <span>{fileCountLabel}</span>
        </div>
        <em>{overallPercent}%</em>
      </div>
      <p className="attachment-upload-file" title={progress.fileName}>
        {progress.fileName}
      </p>
      <div
        aria-label="첨부파일 업로드 진행률"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={overallPercent}
        className="attachment-upload-bar"
        role="progressbar"
      >
        <span style={{ width: `${overallPercent}%` }} />
      </div>
      <div className="attachment-upload-meta">
        <span>{isTerminal ? phaseLabel : byteLabel}</span>
        <span>{filePercent}%</span>
      </div>
    </aside>
  );
}

function AttachmentList({
  attachments,
  busyState,
  canDelete,
  compact = false,
  onDelete,
  onDownload,
  onPreview
}: {
  attachments: NoteAttachmentSnapshot[];
  busyState: AttachmentActionBusyState;
  canDelete: (attachment: NoteAttachmentSnapshot) => boolean;
  compact?: boolean;
  onDelete: (attachment: NoteAttachmentSnapshot) => void;
  onDownload: (attachment: NoteAttachmentSnapshot) => void;
  onPreview?: (attachment: NoteAttachmentSnapshot) => void;
}) {
  if (!attachments.length) {
    return (
      <section className={`attachment-panel ${compact ? "compact" : ""}`} aria-label="첨부파일">
        <header>
          <h3>
            <File size={16} />
            첨부파일
          </h3>
          <span>0개</span>
        </header>
        <p className="attachment-empty">편집 도구의 파일 버튼이나 드래그 앤 드롭으로 파일을 추가할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className={`attachment-panel ${compact ? "compact" : ""}`} aria-label="첨부파일">
      <header>
        <h3>
          <File size={16} />
          첨부파일
        </h3>
        <span>{attachments.length}개</span>
      </header>
      <div className="attachment-list">
        {attachments.map((attachment) => {
          const deleting = busyState.deletingIds.includes(attachment.id);
          const downloading = busyState.downloadingId === attachment.id;
          const previewing = busyState.previewingId === attachment.id;
          const previewable = previewableAttachmentExtensions.has(attachment.extension);

          return (
            <article className="attachment-item" key={attachment.id}>
              <div className="attachment-info">
                <strong>{attachmentDownloadName(attachment)}</strong>
                <span>
                  {attachment.extension.toUpperCase()} · {formatFileSize(attachment.originalSize)}
                </span>
                <em className={`attachment-status-pill ${previewable ? "previewable" : "download-only"}`}>
                  {previewable ? "미리보기 가능" : "다운로드 전용"}
                </em>
              </div>
              <div className="attachment-actions">
                {previewable && onPreview && (
                    <button
                      aria-label={`${attachmentDownloadName(attachment)} 미리보기`}
                      className="secondary-button attachment-action"
                      disabled={deleting || previewing}
                      onClick={() => onPreview(attachment)}
                      type="button"
                    >
                      {previewing ? <Loader2 className="spin" size={16} /> : <Eye size={16} />}
                      미리보기
                    </button>
                )}
                <button
                    aria-label={`${attachmentDownloadName(attachment)} 다운로드`}
                    className="secondary-button attachment-action"
                    disabled={deleting || downloading}
                    onClick={() => onDownload(attachment)}
                    type="button"
                  >
                    {downloading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    다운로드
                  </button>
                <button
                    aria-label={`${attachmentDownloadName(attachment)} 삭제`}
                    className="icon-button danger attachment-delete-action"
                    disabled={deleting || !canDelete(attachment)}
                    onClick={() => onDelete(attachment)}
                    type="button"
                  >
                    {deleting ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                  </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AttachmentListModal({
  attachments,
  busyState,
  canDelete,
  onClose,
  onDelete,
  onDownload,
  onPreview
}: {
  attachments: NoteAttachmentSnapshot[];
  busyState: AttachmentActionBusyState;
  canDelete: (attachment: NoteAttachmentSnapshot) => boolean;
  onClose: () => void;
  onDelete: (attachment: NoteAttachmentSnapshot) => void;
  onDownload: (attachment: NoteAttachmentSnapshot) => void;
  onPreview: (attachment: NoteAttachmentSnapshot) => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);

  useDialogFocus(dialogRef);

  return (
    <div className="modal-backdrop note-insight-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="첨부파일"
        aria-modal="true"
        className="note-insight-modal attachment-list-modal"
        ref={dialogRef}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="note-insight-modal-header">
          <div>
            <span>
              <Paperclip size={16} />
              첨부파일
            </span>
            <h2>첨부파일 보기</h2>
          </div>
          <div className="note-insight-modal-actions">
            <em>{attachments.length}개</em>
            <button className="icon-button" type="button" onClick={onClose} aria-label="첨부파일 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="note-insight-modal-body">
            <AttachmentList
              attachments={attachments}
              busyState={busyState}
              canDelete={canDelete}
            compact
            onDelete={onDelete}
            onDownload={onDownload}
            onPreview={onPreview}
          />
        </div>
      </section>
    </div>
  );
}

export function AttachmentPreviewModal({
  onClose,
  preview
}: {
  onClose: () => void;
  preview: AttachmentPreviewState;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);

  useDialogFocus(dialogRef);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop pdf-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="pdf-preview-title"
        aria-modal="true"
        className="pdf-preview-modal"
        ref={dialogRef}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="pdf-preview-header">
          <div className="pdf-preview-title">
            <span>{preview.label}</span>
            <h2 id="pdf-preview-title">{preview.fileName}</h2>
          </div>
          <div className="pdf-preview-actions">
            {preview.url && (
              <a className="secondary-button pdf-preview-download" download={preview.fileName} href={preview.url}>
                <Download size={14} />
                다운로드
              </a>
            )}
            <button className="icon-button pdf-preview-close" type="button" onClick={onClose} aria-label="파일 미리보기 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        {preview.kind === "image" && preview.url ? (
          <div className="public-image-preview-frame">
            <img src={preview.url} alt={preview.fileName} />
          </div>
        ) : preview.kind === "pdf" && preview.bytes ? (
          <PdfCanvasPreview bytes={preview.bytes} fileName={preview.fileName} />
        ) : preview.kind === "docx" ? (
          <div className="docx-preview-frame">
            <iframe
              className="docx-preview-sandbox"
              referrerPolicy="no-referrer"
              sandbox=""
              srcDoc={preview.srcDoc ?? ""}
              title={`${preview.fileName} DOCX 미리보기`}
            />
          </div>
        ) : preview.kind === "hwp" ? (
          <div className="document-preview-frame">
            <div
              className="document-preview-page hwp-fallback-preview"
              dangerouslySetInnerHTML={{ __html: sanitizeEditorHtml(preview.fallbackHtml ?? "") }}
            />
          </div>
        ) : preview.kind === "html" ? (
          <div className="document-preview-frame">
            <div className="document-preview-page" dangerouslySetInnerHTML={{ __html: preview.html ?? "" }} />
          </div>
        ) : (
          <pre className={`file-text-preview ${preview.kind === "unsupported" ? "unsupported" : ""}`}>{preview.text}</pre>
        )}
      </section>
    </div>
  );
}

function PdfCanvasPreview({ bytes, fileName }: { bytes: Uint8Array; fileName: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ error: string | null; pageCount: number; renderedCount: number; status: "loading" | "ready" | "error" }>({
    error: null,
    pageCount: 0,
    renderedCount: 0,
    status: "loading"
  });

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const previewContainer: HTMLDivElement = container;
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void>; promise: Promise<any> } | null = null;
    let pdfDocument: { destroy: () => Promise<void> } | null = null;
    const renderTasks: Array<{ cancel: () => void; promise: Promise<void> }> = [];
    let retainedCanvasPixels = 0;

    previewContainer.replaceChildren();
    setState({ error: null, pageCount: 0, renderedCount: 0, status: "loading" });

    async function renderPdf() {
      try {
        const pdfjs = await import("pdfjs-dist");

        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          canvasMaxAreaInBytes: maxPdfPreviewCanvasPixels,
          data: bytes.slice(),
          disableAutoFetch: true,
          disableFontFace: true,
          disableRange: true,
          disableStream: true,
          enableXfa: false,
          isImageDecoderSupported: false,
          maxImageSize: maxPdfPreviewImagePixels,
          stopAtErrors: true,
          useSystemFonts: false,
          useWorkerFetch: false
        });

        const pdf = await loadingTask.promise;
        pdfDocument = pdf;
        const pageCount = pdf.numPages;
        const pagesToRender = Math.min(pageCount, maxPdfPreviewPages);
        let renderedPages = 0;

        if (!cancelled) {
          setState({ error: null, pageCount, renderedCount: 0, status: "loading" });
        }

        for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
          if (cancelled) {
            return;
          }

          const page = await pdf.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const containerWidth = previewContainer.clientWidth || maxPdfPreviewPageCssWidth;
          const remainingCanvasPixels = maxPdfPreviewTotalCanvasPixels - retainedCanvasPixels;
          const layout = pdfPreviewCanvasLayout({
            baseHeight: baseViewport.height,
            baseWidth: baseViewport.width,
            containerWidth,
            devicePixelRatio: window.devicePixelRatio || 1,
            remainingCanvasPixels
          });

          if (!layout) {
            break;
          }

          if (layout.canvasPixels > maxPdfPreviewCanvasPixels || layout.canvasPixels > remainingCanvasPixels) {
            throw new Error("PDF preview canvas budget exceeded.");
          }

          const renderViewport = page.getViewport({ scale: layout.cssScale * layout.outputScale });
          const canvas = document.createElement("canvas");

          canvas.className = "pdf-preview-canvas-page";
          canvas.width = layout.canvasWidth;
          canvas.height = layout.canvasHeight;
          canvas.style.width = `${layout.cssWidth}px`;
          canvas.style.height = `${layout.cssHeight}px`;
          canvas.setAttribute("aria-label", `${fileName} ${pageNumber}쪽`);
          previewContainer.append(canvas);
          retainedCanvasPixels += layout.canvasPixels;

          const renderTask = page.render({
            annotationMode: pdfjs.AnnotationMode.DISABLE,
            background: "#ffffff",
            canvas,
            viewport: renderViewport
          });

          renderTasks.push(renderTask);
          await renderTask.promise;
          renderedPages += 1;

          if (!cancelled) {
            setState({ error: null, pageCount, renderedCount: renderedPages, status: "loading" });
          }
        }

        if (pagesToRender > 0 && renderedPages === 0) {
          throw new Error("PDF preview has no safe renderable pages.");
        }

        if (!cancelled) {
          setState({ error: null, pageCount, renderedCount: renderedPages, status: "ready" });
        }
      } catch {
        if (!cancelled) {
          previewContainer.replaceChildren();
          setState({
            error: "PDF 미리보기를 안전하게 렌더링하지 못했습니다. 원본 파일은 다운로드해서 확인해주세요.",
            pageCount: 0,
            renderedCount: 0,
            status: "error"
          });
        }
      }
    }

    void renderPdf();

    return () => {
      cancelled = true;
      renderTasks.forEach((task) => task.cancel());
      previewContainer.replaceChildren();
      void pdfDocument?.destroy().catch(() => undefined);
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [bytes, fileName]);

  const expectedRenderedPages = Math.min(state.pageCount, maxPdfPreviewPages);
  const truncated = state.status === "ready" && (state.pageCount > maxPdfPreviewPages || state.renderedCount < expectedRenderedPages);

  return (
    <div className="pdf-preview-canvas-frame" aria-label={`${fileName} PDF 미리보기`}>
      <div ref={containerRef} className="pdf-preview-canvas-pages" />
      {state.status === "loading" && (
        <p className="pdf-preview-status">
          {state.pageCount ? `${state.renderedCount}/${Math.min(state.pageCount, maxPdfPreviewPages)}쪽 렌더링 중...` : "PDF 미리보기를 준비하는 중..."}
        </p>
      )}
      {state.error && <p className="file-preview-error">{state.error}</p>}
      {truncated && (
        <p className="pdf-preview-status">
          안전한 미리보기를 위해 {state.renderedCount}/{expectedRenderedPages}쪽만 표시했습니다. 전체 파일은 다운로드해서 확인해주세요.
        </p>
      )}
    </div>
  );
}

function NotePreviewModal({
  attachmentBusyState,
  canDeleteAttachment,
  canDelete,
  canRestore,
  currentUid,
  historyUsers,
  isPinned,
  note,
  onClose,
  onConfirm,
  onDelete,
  onDeleteAttachment,
  onDownloadAttachment,
  onPreviewAttachment,
  onPurge,
  onLoad,
  onResolveNoteKey,
  onRestore,
  onSave,
  onTogglePin,
  onUploadAttachments,
  saving,
  suppressEscape
}: {
  attachmentBusyState: AttachmentActionBusyState;
  canDeleteAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => boolean;
  canDelete: boolean;
  canRestore: boolean;
  currentUid: string;
  historyUsers: UserProfile[];
  isPinned: boolean;
  note: DecryptedNote;
  onClose: () => void;
  onConfirm: (note: DecryptedNote) => void;
  onDelete: (note: DecryptedNote) => Promise<string | null>;
  onDeleteAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => Promise<boolean>;
  onDownloadAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => void;
  onPreviewAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => void;
  onPurge: (note: DecryptedNote) => void;
  onLoad: (note: DecryptedNote, draft: NoteDraft) => void;
  onResolveNoteKey: (noteId: string) => Promise<CryptoKey>;
  onRestore: (note: DecryptedNote) => Promise<string | null>;
  onSave: (note: DecryptedNote, draft: NoteDraft, expectedRevision: number) => Promise<PreviewNoteSaveResult>;
  onTogglePin: (note: DecryptedNote) => void;
  onUploadAttachments: (note: DecryptedNote, files: File[]) => void;
  saving: boolean;
  suppressEscape: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<NoteDraft>(() => draftFromNote(note));
  const [draftDirty, setDraftDirty] = useState(false);
  const [editBaseRevision, setEditBaseRevision] = useState(note.revision ?? 0);
  const [modalError, setModalError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<NoteAttachmentSnapshot[]>([]);
  const [readStates, setReadStates] = useState<NoteUserStateSnapshot[]>([]);
  const [history, setHistory] = useState<NoteHistorySnapshot[]>([]);
  const [historySummaries, setHistorySummaries] = useState<Record<string, string>>({});
  const [historySnapshots, setHistorySnapshots] = useState<Record<string, NoteDraft>>({});
  const [revertingHistoryId, setRevertingHistoryId] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const previewAutosaveTimer = useRef<number | null>(null);
  const previewEditorRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const latestDraftRef = useRef(draft);

  useDialogFocus(dialogRef);

  useEffect(() => {
    latestDraftRef.current = draft;
  }, [draft]);

  const requestClose = useCallback(async () => {
    if (saving || closing) {
      return;
    }

    if (isEditing && draftDirty) {
      setClosing(true);
      setModalError(null);
      const savedDraft = latestDraftRef.current;
      const result = await onSave(note, savedDraft, editBaseRevision);

      if (result.revision === null) {
        setClosing(false);
        setModalError(result.error ?? "변경 사항을 저장하지 못해 창을 닫지 않았습니다.");
        return;
      }

      setEditBaseRevision(result.revision);
      if (!noteDraftsMatch(latestDraftRef.current, savedDraft)) {
        setClosing(false);
        setModalError("저장 중 추가로 입력한 내용이 있어 창을 닫지 않았습니다. 다시 저장해주세요.");
        return;
      }
      setDraftDirty(false);
      setClosing(false);
    }

    onClose();
  }, [closing, draftDirty, editBaseRevision, isEditing, note, onClose, onSave, saving]);

  useEffect(() => {
    if (suppressEscape) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();

      if (attachmentsOpen) {
        setAttachmentsOpen(false);
        return;
      }

      if (activityOpen) {
        setActivityOpen(false);
        return;
      }

      void requestClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activityOpen, attachmentsOpen, requestClose, suppressEscape]);

  useEffect(() => {
    if (!attachmentsOpen) {
      setAttachments([]);
      return undefined;
    }

    return subscribeNoteAttachments(note.id, setAttachments, () => setModalError("첨부파일 목록을 불러오지 못했습니다."));
  }, [attachmentsOpen, note.id]);

  useEffect(() => {
    if (!activityOpen) {
      setReadStates([]);
      return undefined;
    }

    return subscribeNoteUserStates(note.id, setReadStates, () => setModalError("읽음 상태를 불러오지 못했습니다."));
  }, [activityOpen, note.id]);

  useEffect(() => {
    if (!activityOpen) {
      setHistory([]);
      return undefined;
    }

    return subscribeNoteHistory(
      note.id,
      currentUid,
      note.ownerUid === currentUid,
      setHistory,
      () => setModalError("수정 이력을 불러오지 못했습니다.")
    );
  }, [activityOpen, currentUid, note.id, note.ownerUid]);

  useEffect(() => {
    if (!activityOpen) {
      setHistorySummaries({});
      setHistorySnapshots({});
      return undefined;
    }

    const entriesWithSummary = history.filter((entry) => entry.encryptedSummary);
    const entriesWithSnapshot = history.filter((entry) => entry.encryptedSnapshot);

    if (!entriesWithSummary.length && !entriesWithSnapshot.length) {
      setHistorySummaries({});
      setHistorySnapshots({});
      return undefined;
    }

    let cancelled = false;

    async function decryptSummaries() {
      try {
        const noteKey = await onResolveNoteKey(note.id);
        const [nextSummaries, nextSnapshots] = await Promise.all([
          Promise.all(
            entriesWithSummary.map(async (entry) => {
              try {
                return [entry.id, await decryptText(entry.encryptedSummary!, noteKey)] as const;
              } catch {
                return [entry.id, "내용 요약을 열 수 없습니다."] as const;
              }
            })
          ),
          Promise.all(
            entriesWithSnapshot.map(async (entry) => {
              try {
                const decrypted = await decryptText(entry.encryptedSnapshot!, noteKey);
                return [entry.id, draftFromHistorySnapshot(decrypted)] as const;
              } catch {
                return [entry.id, null] as const;
              }
            })
          )
        ]);

        if (!cancelled) {
          setHistorySummaries(Object.fromEntries(nextSummaries));
          setHistorySnapshots(
            Object.fromEntries(nextSnapshots.filter((entry): entry is readonly [string, NoteDraft] => Boolean(entry[1])))
          );
        }
      } catch {
        if (!cancelled) {
          setHistorySummaries({});
          setHistorySnapshots({});
        }
      }
    }

    void decryptSummaries();
    return () => {
      cancelled = true;
    };
  }, [activityOpen, history, note.id, onResolveNoteKey]);

  useEffect(() => {
    const remoteDraft = draftFromNote(note);
    const remoteRevision = note.revision ?? 0;

    if (noteDraftsMatch(latestDraftRef.current, remoteDraft)) {
      if (!draftDirty) {
        setEditBaseRevision(remoteRevision);
      }
      return;
    }

    if (isEditing && draftDirty) {
      setModalError("다른 기기 변경 사항이 있지만 현재 편집 중인 내용은 유지했습니다.");
      return;
    }

    setDraft(remoteDraft);
    setEditBaseRevision(remoteRevision);
    setDraftDirty(false);
    setModalError(isEditing ? "다른 기기 변경 사항을 반영했습니다." : null);
  }, [draftDirty, isEditing, note]);

  useEffect(() => {
    if (!isEditing || !draftDirty || saving) {
      return undefined;
    }

    if (previewAutosaveTimer.current) {
      window.clearTimeout(previewAutosaveTimer.current);
    }

    previewAutosaveTimer.current = window.setTimeout(() => {
      void saveDraft(false);
    }, autosaveDelayMs);

    return () => {
      if (previewAutosaveTimer.current) {
        window.clearTimeout(previewAutosaveTimer.current);
      }
    };
    // saveDraft reads the current modal state; adding it here restarts the debounce on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.title, draft.body, draft.fontSize, draftDirty, isEditing, saving]);

  function beginEdit() {
    if (note.isDeleted) {
      setModalError("복구함의 노트는 복구 후 수정할 수 있습니다.");
      return;
    }

    setDraft(draftFromNote(note));
    setEditBaseRevision(note.revision ?? 0);
    setDraftDirty(false);
    setModalError(null);
    setIsEditing(true);
  }

  function cancelEdit() {
    setDraft(draftFromNote(note));
    setEditBaseRevision(note.revision ?? 0);
    setDraftDirty(false);
    setModalError(null);
    setIsEditing(false);
  }

  async function deletePreviewNote() {
    setModalError(null);
    const errorMessage = await onDelete(note);

    if (errorMessage) {
      setModalError(errorMessage);
    }
  }

  async function restorePreviewNote() {
    setModalError(null);
    const errorMessage = await onRestore(note);

    if (errorMessage) {
      setModalError(errorMessage);
    }
  }

  function updateDraft(field: "title" | "body", value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setDraftDirty(true);
  }

  function updateDraftFontSize(fontSize: number) {
    setDraft((current) => ({ ...current, fontSize: clampDraftFontSize(fontSize) }));
    setDraftDirty(true);
  }

  async function saveDraft(exitEdit = true) {
    setModalError(null);

    const savedDraft = draft;
    const result = await onSave(note, savedDraft, editBaseRevision);

    if (result.revision === null) {
      setModalError(result.error ?? "노트를 저장하지 못했습니다.");
      return;
    }

    setEditBaseRevision(result.revision);
    if (noteDraftsMatch(latestDraftRef.current, savedDraft)) {
      setDraftDirty(false);

      if (exitEdit) {
        setIsEditing(false);
      }
    }
  }

  async function revertToHistory(entry: NoteHistorySnapshot, snapshotDraft: NoteDraft) {
    if (note.isDeleted) {
      setModalError("복구함의 노트는 복구 후 되돌릴 수 있습니다.");
      return;
    }

    const confirmed = window.confirm("선택한 수정 이력의 내용으로 되돌릴까요?");

    if (!confirmed) {
      return;
    }

    setRevertingHistoryId(entry.id);
    setModalError(null);

    try {
      const result = await onSave(note, snapshotDraft, editBaseRevision);

      if (result.revision === null) {
        setModalError(result.error ?? "수정 이력으로 되돌리지 못했습니다.");
        window.alert("수정 이력으로 되돌리지 못했습니다.");
        return;
      }

      setEditBaseRevision(result.revision);
      setDraft(snapshotDraft);
      setDraftDirty(false);
      setIsEditing(false);
      setActivityOpen(false);
      setModalError(null);
    } finally {
      setRevertingHistoryId(null);
    }
  }

  async function insertPreviewImageFile(file: File, insertHtml: RichEditorInsertHtml) {
    try {
      const dataUrl = await imageFileToResizedDataUrl(file);

      if (dataUrl.length > maxImageDataUrlLength) {
        setModalError("이미지 용량이 큽니다. 더 작은 이미지를 선택해주세요.");
        return;
      }

      const html = imageHtml(dataUrl, file.name);
      const nextHtml = insertHtml(html);

      setDraft((current) => ({ ...current, body: nextHtml ?? `${current.body}${html}` }));
      setDraftDirty(true);
      setModalError(null);
    } catch {
      setModalError("붙여넣은 이미지를 넣지 못했습니다.");
    }
  }

    async function insertPreviewPastedFiles(files: File[], insertHtml: RichEditorInsertHtml) {
    const attachmentFiles: File[] = [];

    for (const file of files) {
      if (file.type.startsWith("image/")) {
        await insertPreviewImageFile(file, insertHtml);
      } else {
        attachmentFiles.push(file);
      }
    }

      if (attachmentFiles.length) {
        onUploadAttachments(note, attachmentFiles);
      }
    }

    async function deletePreviewAttachment(attachment: NoteAttachmentSnapshot) {
      setAttachments((current) => current.filter((currentAttachment) => currentAttachment.id !== attachment.id));
      const deleted = await onDeleteAttachment(note, attachment);

      if (!deleted) {
        setAttachments((current) =>
          current.some((currentAttachment) => currentAttachment.id === attachment.id) ? current : [...current, attachment]
        );
      }
    }

    const bodyHtml = draft.body || "<p>내용 없음</p>";
  const trustedAttributionBlocks = useMemo(
    () => (note.type === "shared" ? trustedSharedBlockMetadataFromHistory(note, history, historySnapshots) : []),
    [history, historySnapshots, note]
  );
  const renderedBodyHtml =
    note.type === "shared"
      ? sharedAttributionHtml(bodyHtml, note, historyUsers, trustedAttributionBlocks)
      : linkifyEditorHtml(sanitizeEditorHtml(bodyHtml));

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => void requestClose()}>
      <section
        className="note-preview-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="note-preview-header">
          <div className="note-preview-title">
            <span className={`note-kind-pill ${note.type}`}>
              {note.type === "shared" ? <Share2 size={12} /> : null}
              {note.type === "shared" ? "공유" : "개인"}
            </span>
            {isEditing ? (
              <input
                aria-label="팝업 노트 제목"
                className="note-preview-title-input"
                id="note-preview-title"
                onChange={(event) => updateDraft("title", event.target.value)}
                placeholder="노트 제목"
                value={draft.title}
              />
            ) : (
              <h2 id="note-preview-title">{draft.title || "제목 없음"}</h2>
            )}
          </div>
          <div className="note-preview-actions">
            <button
              aria-label={isPinned ? "즐겨찾기 해제" : "즐겨찾기"}
              className={`icon-button star-button ${isPinned ? "active" : ""}`}
              disabled={note.isDeleted}
              onClick={() => onTogglePin(note)}
              title={isPinned ? "즐겨찾기 해제" : "즐겨찾기"}
              type="button"
            >
              <Star fill="currentColor" size={16} />
            </button>
            {isEditing ? (
              <>
                <button
                  className="secondary-button note-preview-action"
                  disabled={saving || !draftDirty}
                  type="button"
                  onClick={() => void saveDraft()}
                >
                  {saving ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                  저장
                </button>
                <button className="secondary-button note-preview-action" disabled={saving} type="button" onClick={cancelEdit}>
                  취소
                </button>
              </>
            ) : (
              <>
                {note.isDeleted ? (
                  <>
                    <button
                      className="secondary-button note-preview-action"
                      disabled={saving || !canRestore}
                      type="button"
                      onClick={() => void restorePreviewNote()}
                    >
                      <RotateCcw size={14} />
                      복구
                    </button>
                    <button
                      className="secondary-button danger note-preview-action"
                      disabled={saving || !canDelete}
                      type="button"
                      onClick={() => onPurge(note)}
                    >
                      <Trash2 size={14} />
                      즉시 삭제
                    </button>
                  </>
                ) : (
                  <>
                    <button className="secondary-button note-preview-action" type="button" onClick={beginEdit}>
                      <Pencil size={14} />
                      수정
                    </button>
                    <button className="secondary-button note-preview-action" type="button" onClick={() => onLoad(note, draft)}>
                      <FolderOpen size={14} />
                      불러오기
                    </button>
                  </>
                )}
              </>
            )}
            {!note.isDeleted && (
              <button
                className="secondary-button danger note-preview-action"
                disabled={saving || !canDelete}
                title={canDelete ? "노트 삭제" : "노트 소유자 또는 참여 중인 관리자만 삭제할 수 있습니다."}
                type="button"
                onClick={() => void deletePreviewNote()}
              >
                <Trash2 size={14} />
                삭제
              </button>
            )}
            <button
              aria-label="노트 조회 닫기"
              className="icon-button"
              disabled={saving || closing}
              onClick={() => void requestClose()}
              type="button"
            >
              {closing ? <Loader2 className="spin" size={16} /> : <X size={16} />}
            </button>
          </div>
        </header>
        {isEditing ? (
          <div className="note-preview-editor">
            <label className="font-size-control note-preview-font-control">
              글자
              <FontSizeNumberInput
                ariaLabel="팝업 메모 글자 크기"
                listId="quickmemo-preview-font-size-options"
                onCommit={updateDraftFontSize}
                value={draft.fontSize}
              />
            </label>
            <RichMemoEditor
              editorRef={previewEditorRef}
              fontSize={draft.fontSize}
              onFilesPaste={(files, insertHtml) => void insertPreviewPastedFiles(files, insertHtml)}
              onChange={(value) => updateDraft("body", value)}
              value={draft.body}
            />
          </div>
        ) : (
          <div
            className="note-preview-body"
            style={{ fontSize: draft.fontSize }}
            dangerouslySetInnerHTML={{ __html: renderedBodyHtml }}
          />
        )}
        {modalError && <p className="form-error" role="alert">{modalError}</p>}
        <div className="note-preview-trigger-row">
          <button className="secondary-button note-insight-trigger" type="button" onClick={() => setAttachmentsOpen(true)}>
            <Paperclip size={16} />
            첨부파일 보기
            {attachmentsOpen ? <span>{attachments.length}개</span> : null}
          </button>
          <button className="secondary-button note-insight-trigger" type="button" onClick={() => setActivityOpen(true)}>
            <History size={16} />
            활동 / 수정 이력 보기
            {activityOpen ? <span>{history.length}개 이력</span> : null}
          </button>
        </div>
        {activityOpen && (
          <NoteInsightModal
            currentUid={currentUid}
            history={history}
            historySnapshots={historySnapshots}
            historySummaries={historySummaries}
            note={note}
            onClose={() => setActivityOpen(false)}
            onConfirm={onConfirm}
            onRevert={(entry, snapshotDraft) => void revertToHistory(entry, snapshotDraft)}
            readStates={readStates}
            revertingHistoryId={revertingHistoryId}
            users={historyUsers}
          />
        )}
        {attachmentsOpen && (
            <AttachmentListModal
              attachments={attachments}
              busyState={attachmentBusyState}
              canDelete={(attachment) => canDeleteAttachment(note, attachment)}
              onClose={() => setAttachmentsOpen(false)}
              onDelete={(attachment) => void deletePreviewAttachment(attachment)}
            onDownload={(attachment) => onDownloadAttachment(note, attachment)}
            onPreview={(attachment) => onPreviewAttachment(note, attachment)}
          />
        )}
      </section>
    </div>
  );
}

function NoteInsightModal({
  currentUid,
  history,
  historySnapshots,
  historySummaries,
  note,
  onClose,
  onConfirm,
  onRevert,
  readStates,
  revertingHistoryId,
  users
}: {
  currentUid: string;
  history: NoteHistorySnapshot[];
  historySnapshots: Record<string, NoteDraft>;
  historySummaries: Record<string, string>;
  note: DecryptedNote;
  onClose: () => void;
  onConfirm: (note: DecryptedNote) => void;
  onRevert: (entry: NoteHistorySnapshot, snapshotDraft: NoteDraft) => void;
  readStates: NoteUserStateSnapshot[];
  revertingHistoryId: string | null;
  users: UserProfile[];
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const usersByUid = new Map(users.map((user) => [user.uid, user]));
  const statesByUid = new Map(readStates.map((state) => [state.uid, state]));
  const currentState = statesByUid.get(currentUid);
  const showReceipts = note.type === "shared";

  useDialogFocus(dialogRef);

  return (
    <div className="modal-backdrop note-insight-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="노트 활동 및 수정 이력"
        aria-modal="true"
        className="note-insight-modal"
        ref={dialogRef}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="note-insight-modal-header">
          <div>
            <span>
              <History size={16} />
              활동
            </span>
            <h2>활동 / 수정 이력</h2>
          </div>
          <div className="note-insight-modal-actions">
            <em>{history.length}개 이력</em>
            <button className="icon-button" type="button" onClick={onClose} aria-label="활동 및 수정 이력 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="note-insight-modal-body">
          {showReceipts && (
            <div className="note-insight-section">
              <div className="note-insight-heading">
                <h3>
                  <CheckCircle2 size={16} />
                  읽음 / 확인
                </h3>
                {!note.isDeleted && (
                  <button
                    className="secondary-button note-preview-action"
                    type="button"
                    onClick={() => onConfirm(note)}
                  >
                    <CheckCircle2 size={14} />
                    확인
                  </button>
                )}
              </div>
              <div className="receipt-list">
                {note.participantUids.map((uid) => {
                  const user = usersByUid.get(uid);
                  const state = statesByUid.get(uid);
                  const readAt = dateFromTimestamp(state?.readAt);
                  const confirmedAt = dateFromTimestamp(state?.confirmedAt);

                  return (
                    <article className="receipt-item" key={uid}>
                      <span className="mini-avatar" style={{ background: user?.color ?? "#64748b" }}>
                        {user?.avatarText ?? uid.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{user?.displayName ?? uid}</strong>
                        <span>{confirmedAt ? `확인 ${formatCompactDateTime(confirmedAt)}` : readAt ? `읽음 ${formatCompactDateTime(readAt)}` : "아직 읽지 않음"}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
              {currentState?.confirmedAt && <p className="muted receipt-current">내 확인: {formatFullDateTime(dateFromTimestamp(currentState.confirmedAt))}</p>}
            </div>
          )}
          <div className="note-insight-section">
            <div className="note-insight-heading">
              <h3>
                <History size={16} />
                수정 이력
              </h3>
            </div>
            {history.length ? (
              <div className="history-list">
                {history.map((entry, index) => {
                  const actor = usersByUid.get(entry.actorUid);
                  const createdAt = dateFromTimestamp(entry.createdAt);
                  const summary = historySummaries[entry.id] ?? entry.changedFields.map(historyFieldLabel).join(", ");
                  const snapshotDraft = historySnapshots[entry.id] ?? null;
                  const previousSnapshotDraft =
                    history
                      .slice(index + 1)
                      .map((candidate) => historySnapshots[candidate.id])
                      .find(Boolean) ?? null;
                  const canRevert = Boolean(snapshotDraft && !note.isDeleted && (entry.action === "create" || entry.action === "content"));

                  return (
                    <article className="history-item" key={entry.id}>
                      <span>{historyActionLabel(entry.action)}</span>
                      <strong className="history-summary-block">
                        {snapshotDraft ? (
                          <HistoryDiffSummary draft={snapshotDraft} fallback={summary} previousDraft={previousSnapshotDraft} />
                        ) : (
                          <span className={entry.action === "content" || entry.action === "create" ? "history-changed-summary" : ""}>
                            {summary}
                          </span>
                        )}
                      </strong>
                      <em>
                        {actor?.displayName ?? entry.actorUid} · {formatCompactDateTime(createdAt)}
                      </em>
                      <button
                        className="secondary-button history-revert-button"
                        disabled={!canRevert || revertingHistoryId === entry.id}
                        onClick={() => snapshotDraft && onRevert(entry, snapshotDraft)}
                        title={snapshotDraft ? "이 이력의 내용으로 되돌리기" : "이전 형식의 이력은 되돌릴 수 없습니다."}
                        type="button"
                      >
                        {revertingHistoryId === entry.id ? "되돌리는 중" : "이 버전으로 되돌리기"}
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="muted">아직 기록된 수정 이력이 없습니다.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function HistoryDiffSummary({
  draft,
  fallback,
  previousDraft
}: {
  draft: NoteDraft;
  fallback: string;
  previousDraft: NoteDraft | null;
}) {
  const lines = historyDiffLines(previousDraft, draft);

  if (!lines.length) {
    return <span>{fallback}</span>;
  }

  return (
    <>
      {lines.map((line) => (
        <span className="history-diff-line" key={line.id}>
          <span className="history-diff-label">{line.label}</span>
          <span className="history-diff-text">
            {line.prefix}
            {line.changed ? <mark>{line.changed}</mark> : null}
            {line.suffix}
            {line.removed && !line.changed ? <del>{line.removed}</del> : null}
          </span>
        </span>
      ))}
    </>
  );
}

async function imageFileToResizedDataUrl(file: File) {
  const mimeType = file.type.toLowerCase();

  if (!inlineImageMimeTypes.has(mimeType)) {
    throw new Error("지원하는 PNG, JPG, WEBP 이미지를 선택해주세요. 움직이는 이미지는 파일로 첨부해주세요.");
  }

  if (file.size <= 0 || file.size > maxInlineImageInputBytes) {
    throw new Error("본문 이미지는 20MB 이하만 사용할 수 있습니다.");
  }

  if (!safeRasterImageBytes(new Uint8Array(await file.arrayBuffer()), mimeType)) {
    throw new Error("이미지 크기나 형식이 안전 제한을 벗어났습니다.");
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    return await resizeImageDataUrl(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function decodeTextAttachmentPreview(bytes: Uint8Array, extension: string) {
  const decodedText = decodeReadableBytes(bytes.subarray(0, Math.min(bytes.byteLength, maxTextPreviewBytes)));

  if (extension === "json" && bytes.byteLength <= maxTextPreviewBytes) {
    try {
      return JSON.stringify(JSON.parse(decodedText), null, 2).slice(0, maxTextPreviewCharacters);
    } catch {
      return decodedText.slice(0, maxTextPreviewCharacters);
    }
  }

  return decodedText.slice(0, maxTextPreviewCharacters);
}

export function legacyBinaryPreviewMessage(extension: string) {
  const upperExtension = extension.toUpperCase();

  return [
    `${upperExtension} 파일은 구형 복합 바이너리 문서라 브라우저 내부에서 양식까지 안전하게 렌더링할 수 없습니다.`,
    "깨진 바이너리 문자를 미리보기로 노출하지 않도록 앱 안에서는 원본 다운로드 확인만 제공합니다.",
    extension === "hwp"
      ? "양식 미리보기가 필요하면 HWPX 또는 PDF로 변환해 업로드해주세요."
      : "양식 미리보기가 필요하면 DOCX 또는 PDF로 변환해 업로드해주세요."
  ].join("\n");
}

function normalizeCustomHexColor(value: string, fallback: string) {
  const normalizedValue = value.trim().toLowerCase();

  return safeHexColorPattern.test(normalizedValue) ? normalizedValue : fallback;
}

function decodeReadableBytes(bytes: Uint8Array) {
  const utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const utf16Text = new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
  const normalizedUtf8 = normalizeDecodedPreviewText(utf8Text);
  const normalizedUtf16 = normalizeDecodedPreviewText(utf16Text);

  return normalizedUtf16.length > normalizedUtf8.length * 1.4 ? normalizedUtf16 : normalizedUtf8;
}

function normalizeDecodedPreviewText(value: string) {
  let normalized = "";
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    const removableControl =
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || codePoint === 0x7f;

    if (removableControl) {
      normalized += value.slice(segmentStart, index);
      segmentStart = index + 1;
    }
  }

  return `${normalized}${value.slice(segmentStart)}`.trim();
}

function resizeImageDataUrl(dataUrl: string) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      if (!image.width || !image.height || image.width * image.height > maxInlineImagePixels) {
        reject(new Error("이미지 해상도가 너무 큽니다."));
        return;
      }

      const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("이미지를 처리할 수 없습니다."));
        return;
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    });
    image.addEventListener("error", () => reject(new Error("이미지를 읽을 수 없습니다.")));
    image.src = dataUrl;
  });
}
