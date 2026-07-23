import {
  Archive,
  ArchiveRestore,
  BookOpenCheck,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Filter,
  FolderOpen,
  Highlighter,
  Inbox,
  LibraryBig,
  Link2,
  ListFilter,
  Loader2,
  PanelRightClose,
  Plus,
  Search,
  Star,
  Tag,
  Trash2,
  X
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import PublicAttachmentPreviewModal from "../components/PublicAttachmentPreviewModal";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import {
  attachmentDownloadName,
  formatFileSize,
  isPublicShareRasterImageExtension,
  maxAttachmentPreviewBytes,
  maxAttachmentPreviewLabel,
  safePublicShareAttachmentMimeType
} from "../lib/attachments";
import { decryptAttachmentToBlob, decryptAttachmentToBytes } from "../lib/attachmentCrypto";
import { decryptText, unwrapNoteKey } from "../lib/crypto";
import { hasFeatureAccess } from "../lib/featureAccess";
import {
  extractLibraryAttachmentText,
  libraryAttachmentExtractionMode,
  type LibraryAttachmentExtractionMode
} from "../lib/libraryAttachmentExtraction";
import {
  consumeLibraryCaptureHandoff,
  libraryCaptureFromPaste,
  takeLibraryCaptureHandoffFromLocation,
  type LibraryCapturePayload
} from "../lib/libraryCapture";
import {
  emptyLibraryItemContent,
  libraryReaderBlockMaxCount,
  libraryReaderTextMaxLength,
  libraryReaderBlockTextMaxLength,
  librarySelectionTextMaxLength,
  librarySearchText,
  libraryTitleMaxLength,
  nextLibraryId,
  safeLibraryExternalUrl
} from "../lib/libraryContent";
import {
  decodeTextAttachmentPreview,
  type PublicAttachmentPreviewState
} from "../lib/publicAttachmentPreview";
import { safeRasterImageBytes } from "../lib/safeRasterImage";
import { publishActiveNote } from "../services/activeNotes";
import {
  createLibraryItem,
  decryptLibraryItems,
  deleteLibraryItem,
  getNextLibraryItemsPage,
  libraryInitialSubscriptionLimit,
  librarySubscriptionStep,
  LibraryItemRevisionConflictError,
  markLibraryItemReviewed,
  subscribeLibraryItems,
  touchLibraryItemOpened,
  updateLibraryItem,
  type DecryptedLibraryItem,
  type LibraryItemsCursor,
  type LibraryItemsServerFacet,
  type LibraryItemSnapshot
} from "../services/library";
import {
  getEncryptedNoteAttachmentSource,
  getNoteAttachments,
  getVisibleNotesByIds,
  subscribeVisibleNoteById,
  subscribeVisibleNotes,
  type NoteAttachmentSnapshot,
  type NoteSnapshot
} from "../services/notes";
import { subscribeUsers } from "../services/users";
import type {
  LibraryHighlight,
  LibraryHighlightColor,
  LibraryCaptureSource as StoredLibraryCaptureSource,
  LibraryItemContent,
  LibraryItemKind,
  LibraryItemStatus,
  LibraryReaderBlock,
  LibraryReaderBlockKind,
  UserProfile
} from "../types";

type LibraryQuickView = "all" | "today" | "favorites" | "archived";
type LibraryKindFilter = "all" | LibraryItemKind;
type LibraryStatusFilter = "all" | LibraryItemStatus;
type LibrarySort = "updated" | "created" | "opened" | "title";

interface AttachmentGroup {
  attachments: NoteAttachmentSnapshot[];
  revision: number;
}

interface VirtualAttachmentItem {
  id: string;
  source: "attachment";
  attachment: NoteAttachmentSnapshot;
  note: NoteSnapshot;
  noteTitle: string;
}

interface ManagedLibraryViewItem {
  id: string;
  source: "managed";
  item: DecryptedLibraryItem;
}

type LibraryViewItem = ManagedLibraryViewItem | VirtualAttachmentItem;

interface CaptureDraft {
  captureSource: Extract<StoredLibraryCaptureSource, "manual" | "browser-extension" | "bookmarklet">;
  collection: string;
  description: string;
  kind: "link" | "clip";
  readerBlocks: LibraryReaderBlock[];
  readerText: string;
  selectionText: string;
  tags: string;
  title: string;
  url: string;
}

interface PendingHighlight {
  blockId: string;
  endOffset: number;
  itemId: string;
  quote: string;
  startOffset: number;
}

interface DeleteTarget {
  generationId: string;
  id: string;
  lastMutationId: string;
  revision: number;
  title: string;
}

function useMobileLibraryReader() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 900px)").matches
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}

interface AttachmentExtractionProgress {
  id: string;
  label: string;
  mode: LibraryAttachmentExtractionMode;
  progress: number | null;
}

interface AttachmentExtractionBase {
  generationId: string;
  itemId: string;
  lastMutationId: string;
  revision: number;
}

const emptyCaptureDraft: CaptureDraft = {
  captureSource: "manual",
  collection: "",
  description: "",
  kind: "link",
  readerBlocks: [],
  readerText: "",
  selectionText: "",
  tags: "",
  title: "",
  url: ""
};

const textAttachmentExtensions = new Set(["txt", "md", "csv", "json"]);
const attachmentPreviewExtensions = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);
const quickViewLabels: Record<LibraryQuickView, string> = {
  all: "전체 자료",
  today: "오늘의 리뷰",
  favorites: "즐겨찾기",
  archived: "보관함"
};
const statusLabels: Record<LibraryItemStatus, string> = {
  inbox: "미분류",
  reading: "읽는 중",
  archived: "보관됨"
};
const kindLabels: Record<LibraryItemKind, string> = {
  link: "링크",
  clip: "클립",
  attachment: "파일"
};
const initialAttachmentNoteLimit = 80;
const attachmentNoteLimitStep = 80;
const maximumAttachmentNoteLimit = 800;
const highlightColorLabels: Record<LibraryHighlightColor, string> = {
  yellow: "노랑",
  green: "초록",
  blue: "파랑",
  pink: "분홍"
};

function throwIfAttachmentActionAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("첨부파일 작업이 취소되었습니다.", "AbortError");
  }
}

function attachmentRevision(note: NoteSnapshot) {
  const value = note.attachmentRevision;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function noteRevision(note: NoteSnapshot) {
  const value = note.revision;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function timestampMillis(value: unknown) {
  if (!value || typeof value !== "object") {
    return 0;
  }

  const candidate = value as { nanoseconds?: unknown; seconds?: unknown; toMillis?: unknown };

  if (typeof candidate.toMillis === "function") {
    return (candidate.toMillis as () => number)();
  }

  return typeof candidate.seconds === "number"
    ? candidate.seconds * 1000 + (typeof candidate.nanoseconds === "number" ? candidate.nanoseconds / 1_000_000 : 0)
    : 0;
}

function sameEncryptedLibraryContent(left: LibraryItemSnapshot, right: DecryptedLibraryItem) {
  return left.generationId === right.generationId
    && left.encryptedContent.version === right.encryptedContent.version
    && left.encryptedContent.algorithm === right.encryptedContent.algorithm
    && left.encryptedContent.cipherText === right.encryptedContent.cipherText
    && left.encryptedContent.iv === right.encryptedContent.iv
    && left.wrappedKeys[left.ownerUid]?.wrappedKey === right.wrappedKeys[right.ownerUid]?.wrappedKey;
}

function formatLibraryDate(value: unknown) {
  const millis = timestampMillis(value);

  if (!millis) {
    return "날짜 없음";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    year: new Date(millis).getFullYear() === new Date().getFullYear() ? undefined : "numeric"
  }).format(new Date(millis));
}

function todayStartMillis() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function managedItemTitle(item: DecryptedLibraryItem) {
  return item.content.title.trim() || item.content.sourceFileName.trim() || "제목 없는 자료";
}

function viewItemTitle(item: LibraryViewItem) {
  return item.source === "managed" ? managedItemTitle(item.item) : attachmentDownloadName(item.attachment);
}

function viewItemKind(item: LibraryViewItem): LibraryItemKind {
  return item.source === "managed" ? item.item.kind : "attachment";
}

function viewItemStatus(item: LibraryViewItem): LibraryItemStatus {
  return item.source === "managed" ? item.item.status : "inbox";
}

function viewItemCreatedAt(item: LibraryViewItem) {
  return item.source === "managed" ? timestampMillis(item.item.createdAt) : timestampMillis(item.attachment.createdAt);
}

function viewItemUpdatedAt(item: LibraryViewItem) {
  return item.source === "managed"
    ? timestampMillis(item.item.updatedAt)
    : timestampMillis(item.note.updatedAt) || timestampMillis(item.attachment.createdAt);
}

function viewItemSearchText(item: LibraryViewItem) {
  if (item.source === "managed") {
    return librarySearchText(item.item.content);
  }

  return [
    attachmentDownloadName(item.attachment),
    item.attachment.extension,
    item.noteTitle
  ]
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR");
}

function viewItemCollection(item: LibraryViewItem) {
  return item.source === "managed" ? item.item.content.collection : "";
}

function viewItemTags(item: LibraryViewItem) {
  return item.source === "managed" ? item.item.content.tags : [];
}

function viewItemFavorite(item: LibraryViewItem) {
  return item.source === "managed" && item.item.isFavorite;
}

function libraryKindIcon(item: LibraryViewItem) {
  if (item.source === "managed" && item.item.kind === "link") {
    return <Link2 size={19} />;
  }

  if (item.source === "managed" && item.item.kind === "clip") {
    return <FileText size={19} />;
  }

  const extension = item.source === "attachment"
    ? item.attachment.extension
    : item.item.content.sourceFileName.split(".").at(-1)?.toLowerCase() ?? "";

  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    return <FileImage size={19} />;
  }

  if (["csv", "xls", "xlsx"].includes(extension)) {
    return <FileSpreadsheet size={19} />;
  }

  if (extension === "zip") {
    return <FileArchive size={19} />;
  }

  return <File size={19} />;
}

function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  return Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker)).then(() => results);
}

function safeReaderChunkLength(value: string, offset: number, maximum: number) {
  let length = Math.min(maximum, value.length - offset);
  const previous = value.charCodeAt(offset + length - 1);
  const next = value.charCodeAt(offset + length);

  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    length -= 1;
  }

  return length;
}

function readerBlocksFromText(value: string): LibraryReaderBlock[] {
  const paragraphs = value
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/gu)
    .map((text) => text.trim())
    .filter(Boolean);
  const blocks: LibraryReaderBlock[] = [];

  for (const paragraph of paragraphs) {
    for (let offset = 0; offset < paragraph.length;) {
      const chunkLength = safeReaderChunkLength(paragraph, offset, libraryReaderBlockTextMaxLength);
      blocks.push({
        id: nextLibraryId(),
        kind: "paragraph",
        text: paragraph.slice(offset, offset + chunkLength)
      });
      offset += chunkLength;

      if (blocks.length >= libraryReaderBlockMaxCount) {
        return blocks;
      }
    }
  }

  return blocks;
}

function boundedCaptureText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  let end = maxLength;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end).trimEnd();
}

function readerBlocksFromCapture(payload: LibraryCapturePayload) {
  const blocks: LibraryReaderBlock[] = [];
  let totalCharacters = 0;

  for (const sourceBlock of payload.blocks) {
    for (let offset = 0; offset < sourceBlock.text.length;) {
      const remaining = libraryReaderTextMaxLength - totalCharacters;
      if (remaining <= 0 || blocks.length >= libraryReaderBlockMaxCount) {
        return blocks;
      }

      const chunkLength = safeReaderChunkLength(
        sourceBlock.text,
        offset,
        Math.min(libraryReaderBlockTextMaxLength, remaining)
      );
      const chunk = sourceBlock.text.slice(offset, offset + chunkLength);
      if (!chunk) {
        break;
      }
      blocks.push({ id: nextLibraryId(), kind: sourceBlock.kind, text: chunk });
      totalCharacters += chunk.length;
      offset += chunkLength;
    }
  }

  return blocks;
}

function captureDraftFromPayload(payload: LibraryCapturePayload): CaptureDraft {
  const readerBlocks = readerBlocksFromCapture(payload);
  return {
    ...emptyCaptureDraft,
    captureSource: payload.source === "extension"
      ? "browser-extension"
      : payload.source === "bookmarklet"
        ? "bookmarklet"
        : "manual",
    kind: payload.url ? "link" : "clip",
    readerBlocks,
    readerText: readerBlocks.map((block) => block.text).join("\n\n"),
    selectionText: boundedCaptureText(payload.selectionText ?? "", librarySelectionTextMaxLength),
    title: boundedCaptureText(payload.title, libraryTitleMaxLength),
    url: payload.url ?? ""
  };
}

function tagsFromInput(value: string) {
  return value
    .split(/[,#\n]/gu)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function readerBlockElement(kind: LibraryReaderBlockKind, children: ReactNode, className: string, blockId: string) {
  const common = { className, "data-library-reader-block-id": blockId };

  if (kind === "heading") {
    return <h3 {...common} key={blockId}>{children}</h3>;
  }

  if (kind === "quote") {
    return <blockquote {...common} key={blockId}>{children}</blockquote>;
  }

  if (kind === "list-item") {
    return <p {...common} className={`${className} list-item`} key={blockId}>{children}</p>;
  }

  if (kind === "code") {
    return <pre {...common} key={blockId}>{children}</pre>;
  }

  return <p {...common} key={blockId}>{children}</p>;
}

function highlightedBlockText(block: LibraryReaderBlock, highlights: LibraryHighlight[]) {
  const ranges = highlights
    .filter((highlight) => highlight.blockId === block.id)
    .sort((left, right) => left.startOffset - right.startOffset);
  const content: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((highlight) => {
    if (highlight.startOffset > cursor) {
      content.push(block.text.slice(cursor, highlight.startOffset));
    }

    content.push(
      <mark
        className={`library-highlight ${highlight.color}`}
        key={highlight.id}
        title={highlight.note || "하이라이트"}
      >
        {block.text.slice(highlight.startOffset, highlight.endOffset)}
      </mark>
    );
    cursor = highlight.endOffset;
  });

  if (cursor < block.text.length) {
    content.push(block.text.slice(cursor));
  }

  return content;
}

function selectionInsideReader(itemId: string): PendingHighlight | null {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const startBlock = startElement?.closest<HTMLElement>("[data-library-reader-block-id]");
  const endBlock = endElement?.closest<HTMLElement>("[data-library-reader-block-id]");

  if (!startBlock || startBlock !== endBlock || !startBlock.closest(".library-reader-content")) {
    return null;
  }

  const prefix = range.cloneRange();
  prefix.selectNodeContents(startBlock);
  prefix.setEnd(range.startContainer, range.startOffset);
  const quote = range.toString();
  const startOffset = prefix.toString().length;
  const endOffset = startOffset + quote.length;

  if (!quote.trim() || endOffset <= startOffset) {
    return null;
  }

  return {
    blockId: startBlock.dataset.libraryReaderBlockId ?? "",
    endOffset,
    itemId,
    quote,
    startOffset
  };
}

function createLibraryClientId() {
  const value = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `library-${value}`;
}

export default function LibraryPage() {
  const { privateKey, profile } = useAuth();
  const navigate = useNavigate();
  const [rawLibraryItems, setRawLibraryItems] = useState<LibraryItemSnapshot[]>([]);
  const [libraryItems, setLibraryItems] = useState<DecryptedLibraryItem[]>([]);
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [managedSourceNotes, setManagedSourceNotes] = useState<NoteSnapshot[]>([]);
  const [libraryPageCursor, setLibraryPageCursor] = useState<LibraryItemsCursor | null>(null);
  const [libraryHasMore, setLibraryHasMore] = useState(false);
  const [libraryLoadingMore, setLibraryLoadingMore] = useState(false);
  const [attachmentNoteLimit, setAttachmentNoteLimit] = useState(initialAttachmentNoteLimit);
  const [noteTitles, setNoteTitles] = useState<Record<string, string>>({});
  const [attachmentGroups, setAttachmentGroups] = useState<Record<string, AttachmentGroup>>({});
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryDecrypting, setLibraryDecrypting] = useState(false);
  const [notesLoading, setNotesLoading] = useState(true);
  const [attachmentProgress, setAttachmentProgress] = useState({ completed: 0, total: 0 });
  const [attachmentFailureCount, setAttachmentFailureCount] = useState(0);
  const [decryptFailureCount, setDecryptFailureCount] = useState(0);
  const [query, setQuery] = useState("");
  const [quickView, setQuickView] = useState<LibraryQuickView>("all");
  const [kindFilter, setKindFilter] = useState<LibraryKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<LibraryStatusFilter>("all");
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sort, setSort] = useState<LibrarySort>("updated");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureDraft, setCaptureDraft] = useState<CaptureDraft>(emptyCaptureDraft);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureHandoffBusy, setCaptureHandoffBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [mutatingItemIds, setMutatingItemIds] = useState<Set<string>>(new Set());
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentExtraction, setAttachmentExtraction] = useState<AttachmentExtractionProgress | null>(null);
  const [attachmentText, setAttachmentText] = useState<{ id: string; text: string } | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<PublicAttachmentPreviewState | null>(null);
  const [pendingHighlight, setPendingHighlight] = useState<PendingHighlight | null>(null);
  const [highlightNote, setHighlightNote] = useState("");
  const [highlightColor, setHighlightColor] = useState<LibraryHighlightColor>("yellow");
  const [statusMessage, setStatusMessage] = useState("자료실을 준비하는 중입니다.");
  const [error, setError] = useState<string | null>(null);
  const libraryDecryptCache = useRef(new Map<string, DecryptedLibraryItem>());
  const noteTitleCache = useRef(new Map<string, string>());
  const attachmentCache = useRef(new Map<string, NoteAttachmentSnapshot[]>());
  const attachmentRequests = useRef(new Map<string, Promise<NoteAttachmentSnapshot[]>>());
  const managedSourceChecked = useRef(new Set<string>());
  const libraryDecryptGeneration = useRef(0);
  const libraryPageGeneration = useRef(0);
  const libraryPaginationRequestGeneration = useRef(0);
  const libraryLiveItemIds = useRef<string[]>([]);
  const libraryLoadedPageCount = useRef(0);
  const noteDecryptGeneration = useRef(0);
  const attachmentGeneration = useRef(0);
  const attachmentActionGeneration = useRef(0);
  const attachmentPreviewController = useRef<AbortController | null>(null);
  const attachmentExtractionController = useRef<AbortController | null>(null);
  const attachmentExtractionBase = useRef<AttachmentExtractionBase | null>(null);
  const previewObjectUrl = useRef<string | null>(null);
  const previewReturnFocus = useRef<HTMLElement | null>(null);
  const downloadObjectUrls = useRef(new Set<string>());
  const downloadCleanupTimers = useRef(new Set<number>());
  const libraryClientId = useRef(createLibraryClientId());
  const libraryItemsRef = useRef<DecryptedLibraryItem[]>([]);
  const libraryResultsRef = useRef<HTMLHeadingElement>(null);
  const readerReturnFocus = useRef<HTMLElement | null>(null);
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  const deleteSucceeded = useRef(false);
  const revisionOverrides = useRef(new Map<string, {
    generationId: string;
    lastMutationId: string;
    revision: number;
  }>());
  const mutationChains = useRef(new Map<string, Promise<void>>());
  const openedThisSession = useRef(new Set<string>());
  const captureHandoffStarted = useRef(false);
  const currentUid = profile?.uid ?? null;
  const restoreDeleteDialogFocus = useCallback(() => {
    if (deleteSucceeded.current) {
      return;
    }
    const focusTarget = deleteReturnFocus.current?.isConnected
      ? deleteReturnFocus.current
      : libraryResultsRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, []);
  const notesFeatureEnabled = hasFeatureAccess(profile, "notes");
  const libraryServerFacet = useMemo<LibraryItemsServerFacet>(() => {
    if (quickView === "archived") {
      return { field: "status", value: "archived" };
    }
    if (quickView === "favorites") {
      return { field: "isFavorite", value: true };
    }
    if (statusFilter !== "all") {
      return { field: "status", value: statusFilter };
    }
    if (favoriteOnly) {
      return { field: "isFavorite", value: true };
    }
    if (kindFilter !== "all") {
      return { field: "kind", value: kindFilter };
    }
    return null;
  }, [favoriteOnly, kindFilter, quickView, statusFilter]);
  const visibleNoteOwnerUids = useMemo(() => {
    if (!profile || !notesFeatureEnabled) {
      return [];
    }

    return Array.from(new Set([
      profile.uid,
      ...users
        .filter((user) => {
          if (user.uid === profile.uid) {
            return true;
          }
          if (!user.isActive) {
            return false;
          }
          return user.isAdmin || Boolean(user.allowedShareTargetUids?.includes(profile.uid));
        })
        .map((user) => user.uid)
    ]));
  }, [notesFeatureEnabled, profile, users]);

  useLayoutEffect(() => {
    if (captureHandoffStarted.current) {
      return;
    }
    captureHandoffStarted.current = true;

    let handoff;
    try {
      handoff = takeLibraryCaptureHandoffFromLocation();
    } catch (caught) {
      setCaptureDraft(emptyCaptureDraft);
      setCaptureOpen(true);
      setError(caught instanceof Error ? caught.message : "캡처 핸드오프 주소를 확인하지 못했습니다.");
      return;
    }

    if (!handoff) {
      return;
    }

    setCaptureDraft(emptyCaptureDraft);
    setCaptureOpen(true);
    setCaptureHandoffBusy(true);
    setError(null);
    void consumeLibraryCaptureHandoff(handoff).then(
      (payload) => {
        setCaptureDraft(captureDraftFromPayload(payload));
        setCaptureHandoffBusy(false);
        setStatusMessage("캡처한 내용을 확인한 뒤 저장해주세요.");
      },
      (caught: unknown) => {
        setCaptureHandoffBusy(false);
        setError(caught instanceof Error ? caught.message : "확장 프로그램 캡처를 가져오지 못했습니다.");
      }
    );
  }, []);

  useEffect(() => {
    libraryItemsRef.current = libraryItems;
  }, [libraryItems]);

  useEffect(() => {
    libraryDecryptCache.current.clear();
    noteTitleCache.current.clear();
    attachmentCache.current.clear();
    attachmentRequests.current.clear();
    managedSourceChecked.current.clear();
    revisionOverrides.current.clear();
    mutationChains.current.clear();
    openedThisSession.current.clear();
    setRawLibraryItems([]);
    setLibraryItems([]);
    setNotes([]);
    setManagedSourceNotes([]);
    libraryPaginationRequestGeneration.current += 1;
    libraryLiveItemIds.current = [];
    libraryLoadedPageCount.current = 0;
    setLibraryPageCursor(null);
    setLibraryHasMore(false);
    setLibraryLoadingMore(false);
    setAttachmentNoteLimit(initialAttachmentNoteLimit);
    setNoteTitles({});
    setAttachmentGroups({});
    setSelectedId(null);
    setAttachmentText(null);
    setAttachmentPreview(null);
    setAttachmentExtraction(null);
    attachmentPreviewController.current?.abort();
    attachmentPreviewController.current = null;
    attachmentExtractionController.current?.abort();
    attachmentExtractionController.current = null;
    attachmentExtractionBase.current = null;
    attachmentActionGeneration.current += 1;

    if (previewObjectUrl.current) {
      URL.revokeObjectURL(previewObjectUrl.current);
      previewObjectUrl.current = null;
    }

    downloadCleanupTimers.current.forEach((timer) => window.clearTimeout(timer));
    downloadObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    downloadCleanupTimers.current.clear();
    downloadObjectUrls.current.clear();
  }, [currentUid, privateKey]);

  useEffect(() => {
    if (notesFeatureEnabled) {
      return;
    }

    noteDecryptGeneration.current += 1;
    attachmentGeneration.current += 1;
    attachmentActionGeneration.current += 1;
    attachmentExtractionController.current?.abort();
    attachmentExtractionController.current = null;
    attachmentExtractionBase.current = null;
    noteTitleCache.current.clear();
    attachmentCache.current.clear();
    attachmentRequests.current.clear();
    managedSourceChecked.current.clear();
    setUsers([]);
    setNotes([]);
    setManagedSourceNotes([]);
    setNoteTitles({});
    setAttachmentGroups({});
    setAttachmentProgress({ completed: 0, total: 0 });
    setAttachmentFailureCount(0);
    setNotesLoading(false);
    setAttachmentBusy(false);
    setAttachmentText(null);
    closeAttachmentPreview();
    setAttachmentExtraction(null);
  }, [notesFeatureEnabled]);

  useEffect(() => {
    if (!profile || !privateKey) {
      libraryPageGeneration.current += 1;
      libraryPaginationRequestGeneration.current += 1;
      libraryLiveItemIds.current = [];
      libraryLoadedPageCount.current = 0;
      setRawLibraryItems([]);
      setLibraryPageCursor(null);
      setLibraryHasMore(false);
      setLibraryLoadingMore(false);
      setLibraryLoading(false);
      return undefined;
    }

    const pageGeneration = libraryPageGeneration.current + 1;
    libraryPageGeneration.current = pageGeneration;
    libraryPaginationRequestGeneration.current += 1;
    libraryLiveItemIds.current = [];
    libraryLoadedPageCount.current = 0;
    setRawLibraryItems([]);
    setLibraryPageCursor(null);
    setLibraryHasMore(false);
    setLibraryLoadingMore(false);
    setLibraryLoading(true);

    return subscribeLibraryItems(
      profile.uid,
      libraryServerFacet,
      (page) => {
        if (libraryPageGeneration.current !== pageGeneration) {
          return;
        }

        page.items.forEach((item) => {
          const override = revisionOverrides.current.get(item.id);

          if (
            override !== undefined
            && (
              item.generationId !== override.generationId
              || item.revision > override.revision
              || (item.revision === override.revision && item.lastMutationId === override.lastMutationId)
            )
          ) {
            revisionOverrides.current.delete(item.id);
          }
        });

        const nextLiveIds = page.items.map((item) => item.id);
        const previousLiveIds = libraryLiveItemIds.current;
        const sameLiveWindow = nextLiveIds.length === previousLiveIds.length
          && nextLiveIds.every((id, index) => id === previousLiveIds[index]);
        const preserveLoadedTail = sameLiveWindow && libraryLoadedPageCount.current > 1;

        if (!sameLiveWindow) {
          libraryPaginationRequestGeneration.current += 1;
          setLibraryLoadingMore(false);
        }

        setRawLibraryItems((current) => {
          if (!sameLiveWindow) {
            return page.items;
          }

          const liveIds = new Set(nextLiveIds);
          const previousHeadIds = new Set(previousLiveIds);
          return [
            ...page.items,
            ...current.filter((item) => !liveIds.has(item.id) && !previousHeadIds.has(item.id))
          ];
        });
        libraryLiveItemIds.current = nextLiveIds;

        if (!preserveLoadedTail) {
          libraryLoadedPageCount.current = 1;
          setLibraryPageCursor(page.cursor);
          setLibraryHasMore(page.hasMore);
        }
        setLibraryLoading(false);
      },
      () => {
        libraryDecryptGeneration.current += 1;
        libraryPageGeneration.current += 1;
        libraryPaginationRequestGeneration.current += 1;
        libraryDecryptCache.current.clear();
        revisionOverrides.current.clear();
        libraryLiveItemIds.current = [];
        libraryLoadedPageCount.current = 0;
        setRawLibraryItems([]);
        setLibraryItems([]);
        setLibraryPageCursor(null);
        setLibraryHasMore(false);
        setLibraryLoadingMore(false);
        setLibraryDecrypting(false);
        setDecryptFailureCount(0);
        setSelectedId(null);
        setAttachmentText(null);
        closeAttachmentPreview();
        setLibraryLoading(false);
        setError("저장한 자료를 불러오지 못했습니다. 계정 상태와 연결을 확인해주세요.");
      },
      libraryInitialSubscriptionLimit
    );
  }, [libraryServerFacet, privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey) {
      libraryDecryptGeneration.current += 1;
      setLibraryItems([]);
      setLibraryDecrypting(false);
      return;
    }

    const generation = libraryDecryptGeneration.current + 1;
    libraryDecryptGeneration.current = generation;
    const validCacheKeys = new Set(rawLibraryItems.map((item) =>
      `${item.id}:${item.generationId}:${item.revision}:${item.lastMutationId}`
    ));

    for (const cacheKey of libraryDecryptCache.current.keys()) {
      if (!validCacheKeys.has(cacheKey)) {
        libraryDecryptCache.current.delete(cacheKey);
      }
    }

    if (!rawLibraryItems.length) {
      setLibraryItems([]);
      setDecryptFailureCount(0);
      setLibraryDecrypting(false);
      return;
    }

    const cacheKey = (item: LibraryItemSnapshot) =>
      `${item.id}:${item.generationId}:${item.revision}:${item.lastMutationId}`;
    const previousById = new Map(libraryItemsRef.current.map((item) => [item.id, item]));
    rawLibraryItems.forEach((item) => {
      const key = cacheKey(item);
      const cached = libraryDecryptCache.current.get(key);
      const previous = previousById.get(item.id);

      if (cached) {
        libraryDecryptCache.current.set(key, {
          ...cached,
          ...item,
          content: cached.content,
          itemKey: cached.itemKey
        });
      } else if (previous && sameEncryptedLibraryContent(item, previous)) {
        libraryDecryptCache.current.set(key, { ...item, content: previous.content, itemKey: previous.itemKey });
      }
    });
    const missing = rawLibraryItems.filter((item) => !libraryDecryptCache.current.has(cacheKey(item)));

    setLibraryItems(
      rawLibraryItems
        .map((item) => libraryDecryptCache.current.get(cacheKey(item)) ?? previousById.get(item.id) ?? null)
        .filter((item): item is DecryptedLibraryItem => Boolean(item))
    );

    if (!missing.length) {
      setDecryptFailureCount(0);
      setLibraryDecrypting(false);
      return;
    }

    let cancelled = false;
    setLibraryDecrypting(true);

    void decryptLibraryItems(missing, profile.uid, privateKey)
      .then((result) => {
        if (cancelled || libraryDecryptGeneration.current !== generation) {
          return;
        }

        result.items.forEach((item) => libraryDecryptCache.current.set(
          `${item.id}:${item.generationId}:${item.revision}:${item.lastMutationId}`,
          item
        ));
        setDecryptFailureCount(result.failedItemIds.length);
        setLibraryItems(
          rawLibraryItems
            .map((item) => libraryDecryptCache.current.get(cacheKey(item)) ?? null)
            .filter((item): item is DecryptedLibraryItem => Boolean(item))
        );
      })
      .catch(() => {
        if (!cancelled && libraryDecryptGeneration.current === generation) {
          setDecryptFailureCount(missing.length);
          setError("일부 자료의 암호화 키를 확인하지 못했습니다.");
        }
      })
      .finally(() => {
        if (!cancelled && libraryDecryptGeneration.current === generation) {
          setLibraryDecrypting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [privateKey, profile, rawLibraryItems]);

  useEffect(() => {
    if (!profile || !privateKey || profile.isAdmin || !notesFeatureEnabled) {
      setUsers([]);
      return undefined;
    }

    return subscribeUsers(
      setUsers,
      () => {
        setUsers([]);
        setError("공유 노트 소유자 범위를 확인하지 못해 내 노트만 표시합니다.");
      }
    );
  }, [notesFeatureEnabled, privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey || !notesFeatureEnabled) {
      setNotes([]);
      setNotesLoading(false);
      return undefined;
    }

    setNotesLoading(true);

    return subscribeVisibleNotes(
      profile.uid,
      profile.isAdmin ? null : visibleNoteOwnerUids,
      (nextNotes) => {
        setNotes(nextNotes);
        setNotesLoading(false);
      },
      () => {
        noteTitleCache.current.clear();
        attachmentCache.current.clear();
        managedSourceChecked.current.clear();
        setNotes([]);
        setManagedSourceNotes([]);
        setNoteTitles({});
        setAttachmentGroups({});
        setAttachmentProgress({ completed: 0, total: 0 });
        setAttachmentText(null);
        closeAttachmentPreview();
        setNotesLoading(false);
        setError("노트 첨부파일 목록을 불러오지 못했습니다.");
      },
      attachmentNoteLimit
    );
  }, [attachmentNoteLimit, notesFeatureEnabled, privateKey, profile, visibleNoteOwnerUids]);

  const managedSourceNoteIds = useMemo(
    () => new Set(
      notesFeatureEnabled
        ? rawLibraryItems.map((item) => item.sourceNoteId).filter((id): id is string => Boolean(id))
        : []
    ),
    [notesFeatureEnabled, rawLibraryItems]
  );
  const missingManagedSourceNoteIds = useMemo(
    () => Array.from(managedSourceNoteIds).filter(
      (noteId) => !notes.some((note) => note.id === noteId) && !managedSourceChecked.current.has(noteId)
    ),
    [managedSourceNoteIds, notes]
  );

  useEffect(() => {
    for (const noteId of managedSourceChecked.current) {
      if (!managedSourceNoteIds.has(noteId)) {
        managedSourceChecked.current.delete(noteId);
      }
    }

    setManagedSourceNotes((current) => {
      const next = current.filter((note) => managedSourceNoteIds.has(note.id));
      return next.length === current.length && next.every((note, index) => note === current[index]) ? current : next;
    });
  }, [managedSourceNoteIds]);

  useEffect(() => {
    if (!profile || !privateKey || !notesFeatureEnabled) {
      setManagedSourceNotes([]);
      return;
    }

    if (!missingManagedSourceNoteIds.length) {
      return;
    }

    let cancelled = false;
    const requestedIds = [...missingManagedSourceNoteIds];
    void getVisibleNotesByIds(profile.uid, requestedIds).then(
      (result) => {
        if (!cancelled) {
          result.resolvedNoteIds.forEach((noteId) => managedSourceChecked.current.add(noteId));
          setManagedSourceNotes((current) => {
            const byId = new Map(current.map((note) => [note.id, note]));
            result.notes.forEach((note) => byId.set(note.id, note));
            return Array.from(byId.values());
          });
        }
      },
      () => {
        if (!cancelled) {
          setManagedSourceNotes([]);
          setError("일부 원본 노트의 접근 권한을 확인하지 못했습니다.");
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [missingManagedSourceNoteIds, notesFeatureEnabled, privateKey, profile]);

  const availableNotes = useMemo(() => {
    const byId = new Map(managedSourceNotes.map((note) => [note.id, note]));
    notes.forEach((note) => byId.set(note.id, note));
    return Array.from(byId.values()).sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt));
  }, [managedSourceNotes, notes]);
  const eligibleRecentAttachmentNotes = useMemo(
    () => notes.filter((note) => {
      const revision = note.attachmentRevision;
      return revision === undefined
        || (Number.isSafeInteger(revision) && Number(revision) > 0);
    }),
    [notes]
  );
  const attachmentCandidateNotes = useMemo(() => {
    const selected = new Map<string, NoteSnapshot>();

    eligibleRecentAttachmentNotes.slice(0, attachmentNoteLimit).forEach((note) => selected.set(note.id, note));
    availableNotes.forEach((note) => {
      if (managedSourceNoteIds.has(note.id)) {
        selected.set(note.id, note);
      }
    });
    return Array.from(selected.values());
  }, [attachmentNoteLimit, availableNotes, eligibleRecentAttachmentNotes, managedSourceNoteIds]);
  const hasMoreAttachmentNotes = notes.length >= attachmentNoteLimit;

  useEffect(() => {
    if (!profile || !privateKey || !notesFeatureEnabled) {
      setNoteTitles({});
      return;
    }

    const generation = noteDecryptGeneration.current + 1;
    noteDecryptGeneration.current = generation;
    const validCacheKeys = new Set(attachmentCandidateNotes.map((note) => `${note.id}:${noteRevision(note)}`));

    for (const cacheKey of noteTitleCache.current.keys()) {
      if (!validCacheKeys.has(cacheKey)) {
        noteTitleCache.current.delete(cacheKey);
      }
    }

    const immediateTitles: Record<string, string> = {};
    const missing: NoteSnapshot[] = [];

    attachmentCandidateNotes.forEach((note) => {
      const cached = noteTitleCache.current.get(`${note.id}:${noteRevision(note)}`);

      if (cached) {
        immediateTitles[note.id] = cached;
      } else {
        immediateTitles[note.id] = "노트 제목 확인 중";
        missing.push(note);
      }
    });
    setNoteTitles(immediateTitles);

    if (!missing.length) {
      return;
    }

    let cancelled = false;

    void mapWithConcurrency(missing, 4, async (note) => {
      const wrappedKey = note.wrappedKeys[profile.uid];

      if (!wrappedKey) {
        return { id: note.id, title: "복호화할 수 없는 노트" };
      }

      try {
        const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
        const title = await decryptText(note.encryptedTitle, noteKey);
        return { id: note.id, title: title.trim() || "제목 없는 노트" };
      } catch {
        return { id: note.id, title: "복호화할 수 없는 노트" };
      }
    }).then((results) => {
      if (cancelled || noteDecryptGeneration.current !== generation) {
        return;
      }

      results.forEach((result) => {
        const note = missing.find((candidate) => candidate.id === result.id);

        if (note) {
          noteTitleCache.current.set(`${note.id}:${noteRevision(note)}`, result.title);
        }
      });
      setNoteTitles((current) => {
        const next: Record<string, string> = {};
        attachmentCandidateNotes.forEach((note) => {
          next[note.id] = results.find((result) => result.id === note.id)?.title ?? current[note.id] ?? "노트";
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [attachmentCandidateNotes, notesFeatureEnabled, privateKey, profile]);

  useEffect(() => {
    if (!profile || !privateKey || !notesFeatureEnabled) {
      setAttachmentGroups({});
      setAttachmentProgress({ completed: 0, total: 0 });
      return;
    }

    const generation = attachmentGeneration.current + 1;
    attachmentGeneration.current = generation;
    const validCacheKeys = new Set(attachmentCandidateNotes.map((note) => `${note.id}:${attachmentRevision(note)}`));
    const nextGroups: Record<string, AttachmentGroup> = {};
    const missing: NoteSnapshot[] = [];

    for (const cacheKey of attachmentCache.current.keys()) {
      if (!validCacheKeys.has(cacheKey)) {
        attachmentCache.current.delete(cacheKey);
      }
    }

    attachmentCandidateNotes.forEach((note) => {
      const revision = attachmentRevision(note);
      const cached = attachmentCache.current.get(`${note.id}:${revision}`);

      if (cached) {
        nextGroups[note.id] = { attachments: cached, revision };
      } else {
        missing.push(note);
      }
    });

    setAttachmentGroups(nextGroups);
    setAttachmentFailureCount(0);
    setAttachmentProgress({
      completed: attachmentCandidateNotes.length - missing.length,
      total: attachmentCandidateNotes.length
    });

    if (!missing.length) {
      return;
    }

    let cancelled = false;
    let failures = 0;

    void mapWithConcurrency(missing, 4, async (note) => {
      const requestKey = `${note.id}:${attachmentRevision(note)}`;
      let request = attachmentRequests.current.get(requestKey);

      if (!request) {
        request = getNoteAttachments(note.id);
        attachmentRequests.current.set(requestKey, request);
      }
      try {
        const attachments = await request;
        return { attachments, note, success: true };
      } catch {
        return { attachments: [] as NoteAttachmentSnapshot[], note, success: false };
      } finally {
        if (attachmentRequests.current.get(requestKey) === request) {
          attachmentRequests.current.delete(requestKey);
        }
        if (!cancelled && attachmentGeneration.current === generation) {
          setAttachmentProgress((current) => ({ ...current, completed: Math.min(current.total, current.completed + 1) }));
        }
      }
    }).then((results) => {
      if (cancelled || attachmentGeneration.current !== generation) {
        return;
      }

      results.forEach(({ attachments, note, success }) => {
        if (!success) {
          failures += 1;
          return;
        }

        const revision = attachmentRevision(note);
        attachmentCache.current.set(`${note.id}:${revision}`, attachments);
        nextGroups[note.id] = { attachments, revision };
      });
      setAttachmentGroups({ ...nextGroups });
      setAttachmentFailureCount(failures);
    });

    return () => {
      cancelled = true;
    };
  }, [attachmentCandidateNotes, notesFeatureEnabled, privateKey, profile]);

  useEffect(() => {
    const cleanupTimers = downloadCleanupTimers.current;
    const objectUrls = downloadObjectUrls.current;

    return () => {
      attachmentExtractionController.current?.abort();
      attachmentExtractionController.current = null;
      attachmentExtractionBase.current = null;
      attachmentPreviewController.current?.abort();
      attachmentPreviewController.current = null;
      attachmentActionGeneration.current += 1;

      if (previewObjectUrl.current) {
        URL.revokeObjectURL(previewObjectUrl.current);
      }

      cleanupTimers.forEach((timer) => window.clearTimeout(timer));
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      cleanupTimers.clear();
      objectUrls.clear();
    };
  }, []);

  const managedAttachmentRefs = useMemo(
    () => new Set(
      rawLibraryItems
        .filter((item) => item.kind === "attachment" && item.sourceNoteId && item.sourceAttachmentId)
        .map((item) => `${item.sourceNoteId}:${item.sourceAttachmentId}`)
    ),
    [rawLibraryItems]
  );
  const virtualAttachments = useMemo<VirtualAttachmentItem[]>(
    () => availableNotes.flatMap((note) =>
      (attachmentGroups[note.id]?.attachments ?? [])
        .filter((attachment) => !managedAttachmentRefs.has(`${note.id}:${attachment.id}`))
        .map((attachment) => ({
          attachment,
          id: `attachment:${note.id}:${attachment.id}`,
          note,
          noteTitle: noteTitles[note.id] ?? "노트 제목 확인 중",
          source: "attachment" as const
        }))
    ),
    [attachmentGroups, availableNotes, managedAttachmentRefs, noteTitles]
  );
  const allViewItems = useMemo<LibraryViewItem[]>(
    () => [
      ...libraryItems.map((item) => ({ id: item.id, item, source: "managed" as const })),
      ...virtualAttachments
    ],
    [libraryItems, virtualAttachments]
  );
  const collections = useMemo(
    () => Array.from(new Set(libraryItems.map((item) => item.content.collection.trim()).filter(Boolean))).sort((left, right) =>
      left.localeCompare(right, "ko-KR")
    ),
    [libraryItems]
  );
  const tags = useMemo(
    () => Array.from(new Set(libraryItems.flatMap((item) => item.content.tags))).sort((left, right) =>
      left.localeCompare(right, "ko-KR")
    ),
    [libraryItems]
  );
  const reviewCount = useMemo(() => {
    const today = todayStartMillis();
    return libraryItems.filter((item) => item.status !== "archived" && timestampMillis(item.lastReviewedAt) < today).length;
  }, [libraryItems]);
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("ko-KR").trim();
  const searchActive = Boolean(normalizedQuery);
  const searchTextById = useMemo(
    () => searchActive
      ? new Map(allViewItems.map((item) => [item.id, viewItemSearchText(item)]))
      : new Map<string, string>(),
    [allViewItems, searchActive]
  );
  const kindFacetItems = useMemo(() => {
    const today = todayStartMillis();
    return allViewItems.filter((item) => {
      if (quickView === "all" && statusFilter !== "archived" && viewItemStatus(item) === "archived") {
        return false;
      }

      if (quickView === "today") {
        if (item.source !== "managed" || item.item.status === "archived" || timestampMillis(item.item.lastReviewedAt) >= today) {
          return false;
        }
      }

      if (quickView === "favorites" && !viewItemFavorite(item)) {
        return false;
      }

      if (quickView === "archived" && viewItemStatus(item) !== "archived") {
        return false;
      }

      if (normalizedQuery && !searchTextById.get(item.id)?.includes(normalizedQuery)) {
        return false;
      }

      if (statusFilter !== "all" && viewItemStatus(item) !== statusFilter) {
        return false;
      }

      if (favoriteOnly && !viewItemFavorite(item)) {
        return false;
      }

      if (collectionFilter !== "all" && viewItemCollection(item) !== collectionFilter) {
        return false;
      }

      return tagFilter === "all" || viewItemTags(item).includes(tagFilter);
    });
  }, [
    allViewItems,
    collectionFilter,
    favoriteOnly,
    normalizedQuery,
    quickView,
    searchTextById,
    statusFilter,
    tagFilter
  ]);
  const kindFacetCounts = useMemo<Record<LibraryKindFilter, number>>(() => {
    const counts: Record<LibraryKindFilter, number> = {
      all: kindFacetItems.length,
      attachment: 0,
      clip: 0,
      link: 0
    };

    kindFacetItems.forEach((item) => {
      counts[viewItemKind(item)] += 1;
    });
    return counts;
  }, [kindFacetItems]);
  const filteredItems = useMemo(() => {
    const nextItems = kindFilter === "all"
      ? [...kindFacetItems]
      : kindFacetItems.filter((item) => viewItemKind(item) === kindFilter);

    return nextItems.sort((left, right) => {
      if (sort === "title") {
        return viewItemTitle(left).localeCompare(viewItemTitle(right), "ko-KR");
      }

      if (sort === "created") {
        return viewItemCreatedAt(right) - viewItemCreatedAt(left);
      }

      if (sort === "opened") {
        const leftOpened = left.source === "managed" ? timestampMillis(left.item.lastOpenedAt) : 0;
        const rightOpened = right.source === "managed" ? timestampMillis(right.item.lastOpenedAt) : 0;
        return rightOpened - leftOpened || viewItemUpdatedAt(right) - viewItemUpdatedAt(left);
      }

      return viewItemUpdatedAt(right) - viewItemUpdatedAt(left);
    });
  }, [
    kindFacetItems,
    kindFilter,
    sort
  ]);
  const selectedItem = useMemo(
    () => allViewItems.find((item) => item.id === selectedId) ?? null,
    [allViewItems, selectedId]
  );
  const selectedAttachmentSource = useMemo(() => {
    if (!selectedItem) {
      return null;
    }

    if (selectedItem.source === "attachment") {
      return selectedItem;
    }

    const sourceNoteId = selectedItem.item.sourceNoteId;
    const sourceAttachmentId = selectedItem.item.sourceAttachmentId;

    if (!sourceNoteId || !sourceAttachmentId) {
      return null;
    }

    const note = availableNotes.find((candidate) => candidate.id === sourceNoteId);
    const attachment = attachmentGroups[sourceNoteId]?.attachments.find((candidate) => candidate.id === sourceAttachmentId);

    if (!note || !attachment) {
      return null;
    }

    return {
      attachment,
      id: `attachment:${note.id}:${attachment.id}`,
      note,
      noteTitle: noteTitles[note.id] ?? "노트",
      source: "attachment" as const
    };
  }, [attachmentGroups, availableNotes, noteTitles, selectedItem]);
  const filtersActive = kindFilter !== "all"
    || statusFilter !== "all"
    || favoriteOnly
    || collectionFilter !== "all"
    || tagFilter !== "all";
  const canLoadMoreLibraryItems = libraryHasMore && Boolean(libraryPageCursor);
  const canLoadMoreAttachmentNotes = hasMoreAttachmentNotes
    && attachmentNoteLimit < maximumAttachmentNoteLimit;
  const attachmentNoteLimitReached = hasMoreAttachmentNotes
    && attachmentNoteLimit >= maximumAttachmentNoteLimit;
  const loading = libraryLoading || libraryDecrypting || notesLoading || attachmentProgress.completed < attachmentProgress.total;
  const selectedAttachmentIdentity = selectedAttachmentSource
    ? `${selectedAttachmentSource.note.id}:${selectedAttachmentSource.attachment.id}:${attachmentRevision(selectedAttachmentSource.note)}`
    : null;
  const selectedManagedSourceNoteId = selectedItem?.source === "managed" && selectedItem.item.kind === "attachment"
    ? selectedItem.item.sourceNoteId
    : null;
  const canExtractSelectedAttachment = Boolean(
    profile
    && selectedAttachmentSource
    && selectedAttachmentSource.note.ownerUid === profile.uid
    && selectedAttachmentSource.attachment.isReady !== false
  );

  useEffect(() => {
    if (selectedId && !selectedItem) {
      setSelectedId(null);
      setAttachmentText(null);
      closeAttachmentPreview();
      setStatusMessage("원본 자료의 접근 권한이 변경되어 목록에서 제거했습니다.");
    }
  }, [selectedId, selectedItem]);

  useEffect(() => {
    if (selectedId && selectedItem && !filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(null);
      setAttachmentText(null);
      closeAttachmentPreview();
      setStatusMessage("선택한 자료가 현재 보기에서 제외되어 리더를 닫았습니다.");
    }
  }, [filteredItems, selectedId, selectedItem]);

  useEffect(() => {
    if (!currentUid || !selectedManagedSourceNoteId || !notesFeatureEnabled) {
      return undefined;
    }

    const sourceNoteId = selectedManagedSourceNoteId;
    const removeUnavailableSource = () => {
      setNotes((current) => current.filter((note) => note.id !== sourceNoteId));
      setManagedSourceNotes((current) => current.filter((note) => note.id !== sourceNoteId));
      for (const cacheKey of attachmentCache.current.keys()) {
        if (cacheKey.startsWith(`${sourceNoteId}:`)) {
          attachmentCache.current.delete(cacheKey);
        }
      }
      setAttachmentGroups((current) => {
        if (!(sourceNoteId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[sourceNoteId];
        return next;
      });
      setStatusMessage("원본 노트가 삭제되었거나 접근 권한이 변경되어 원본 연결을 닫았습니다.");
    };

    return subscribeVisibleNoteById(
      currentUid,
      sourceNoteId,
      (note) => {
        setManagedSourceNotes((current) => {
          const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
          byId.set(note.id, note);
          return Array.from(byId.values());
        });
      },
      removeUnavailableSource
    );
  }, [currentUid, notesFeatureEnabled, selectedManagedSourceNoteId]);

  useEffect(() => {
    const base = attachmentExtractionBase.current;

    if (!base || !attachmentExtractionController.current) {
      return;
    }

    const current = libraryItems.find((item) => item.id === base.itemId);

    if (
      !current
      || current.generationId !== base.generationId
      || current.revision !== base.revision
      || current.lastMutationId !== base.lastMutationId
    ) {
      attachmentExtractionController.current.abort();
      attachmentExtractionBase.current = null;
      setError("자료가 다른 곳에서 변경되어 텍스트 추출을 중단했습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.");
    }
  }, [libraryItems]);

  useEffect(() => {
    attachmentExtractionController.current?.abort();
    attachmentExtractionController.current = null;
    attachmentExtractionBase.current = null;
    attachmentActionGeneration.current += 1;
    setAttachmentBusy(false);
    setAttachmentExtraction(null);
    closeAttachmentPreview();
    setAttachmentText(null);
    setPendingHighlight(null);
    setHighlightNote("");
    setHighlightColor("yellow");
  }, [selectedAttachmentIdentity, selectedId]);

  useEffect(() => {
    if (!selectedItem || selectedItem.source !== "managed") {
      return undefined;
    }

    function captureSelection() {
      const selected = selectionInsideReader(selectedItem!.id);

      if (selected) {
        setPendingHighlight(selected);
      }
    }

    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [selectedItem]);

  async function loadMoreLibraryItems() {
    if (!profile || !libraryPageCursor || !libraryHasMore || libraryLoadingMore) {
      return;
    }

    const requestGeneration = libraryPaginationRequestGeneration.current;
    const cursor = libraryPageCursor;
    setLibraryLoadingMore(true);
    setError(null);

    try {
      const page = await getNextLibraryItemsPage(
        profile.uid,
        libraryServerFacet,
        cursor,
        librarySubscriptionStep
      );

      if (libraryPaginationRequestGeneration.current !== requestGeneration) {
        return;
      }

      setRawLibraryItems((current) => {
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !existingIds.has(item.id))];
      });
      libraryLoadedPageCount.current += 1;
      setLibraryPageCursor(page.cursor ?? cursor);
      setLibraryHasMore(page.hasMore);
    } catch (caught) {
      if (libraryPaginationRequestGeneration.current === requestGeneration) {
        setError(caught instanceof Error ? caught.message : "이전 자료를 불러오지 못했습니다.");
      }
    } finally {
      if (libraryPaginationRequestGeneration.current === requestGeneration) {
        setLibraryLoadingMore(false);
      }
    }
  }

  function clearFilters() {
    setKindFilter("all");
    setStatusFilter("all");
    setFavoriteOnly(false);
    setCollectionFilter("all");
    setTagFilter("all");
  }

  function queueManagedMutation(
    itemId: string,
    operation: (item: DecryptedLibraryItem) => Promise<{ lastMutationId: string; revision: number }>,
    optimistic?: (item: DecryptedLibraryItem, revision: number) => DecryptedLibraryItem,
    options: { quiet?: boolean; errorMessage?: string; onSuccess?: () => void } = {}
  ) {
    const previous = mutationChains.current.get(itemId) ?? Promise.resolve();
    setMutatingItemIds((current) => new Set(current).add(itemId));

    const next: Promise<void> = previous
      .catch(() => undefined)
      .then(async () => {
        const current = libraryItemsRef.current.find((item) => item.id === itemId);

        if (!current) {
          throw new Error("자료가 더 이상 존재하지 않습니다.");
        }

        const override = revisionOverrides.current.get(itemId);
        const activeOverride = override?.generationId === current.generationId ? override : undefined;
        if (override && !activeOverride) {
          revisionOverrides.current.delete(itemId);
        }
        const item = {
          ...current,
          lastMutationId: activeOverride?.lastMutationId ?? current.lastMutationId,
          revision: activeOverride?.revision ?? current.revision
        };
        const result = await operation(item);
        revisionOverrides.current.set(itemId, { ...result, generationId: item.generationId });

        setLibraryItems((items) => items.map((candidate) => {
          if (candidate.id !== itemId) {
            return candidate;
          }

          const optimisticItem = optimistic
            ? optimistic({ ...candidate, lastMutationId: item.lastMutationId, revision: item.revision }, result.revision)
            : candidate;
          return { ...optimisticItem, lastMutationId: result.lastMutationId, revision: result.revision };
        }));

        options.onSuccess?.();
      })
      .catch((caught) => {
        if (!options.quiet) {
          setError(caught instanceof Error ? caught.message : options.errorMessage ?? "자료를 변경하지 못했습니다.");
        }
      })
      .finally(() => {
        if (mutationChains.current.get(itemId) === next) {
          mutationChains.current.delete(itemId);
          setMutatingItemIds((current) => {
            const updated = new Set(current);
            updated.delete(itemId);
            return updated;
          });
        }
      });

    mutationChains.current.set(itemId, next);
    return next;
  }

  function selectItem(item: LibraryViewItem) {
    readerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(item.id);
    setError(null);

    if (item.source === "managed" && !openedThisSession.current.has(item.id)) {
      openedThisSession.current.add(item.id);
      void touchLibraryItemOpened(item.item.id, item.item.ownerUid, item.item.generationId).catch(() => {
        openedThisSession.current.delete(item.id);
      });
    }
  }

  function closeReader() {
    const returnFocus = readerReturnFocus.current;
    closeAttachmentPreview();
    setSelectedId(null);
    window.setTimeout(() => {
      const focusTarget = returnFocus?.isConnected ? returnFocus : libraryResultsRef.current;
      focusTarget?.focus({ preventScroll: true });
    }, 0);
  }

  function toggleFavorite(item: DecryptedLibraryItem) {
    const nextFavorite = !item.isFavorite;
    void queueManagedMutation(
      item.id,
      (current) => updateLibraryItem(current, current.ownerUid, { isFavorite: nextFavorite }),
      (current, revision) => ({ ...current, isFavorite: nextFavorite, revision }),
      {
        onSuccess: () => setStatusMessage(nextFavorite ? "즐겨찾기에 추가했습니다." : "즐겨찾기에서 제거했습니다.")
      }
    );
  }

  function toggleArchive(item: DecryptedLibraryItem) {
    const nextStatus: LibraryItemStatus = item.status === "archived" ? "inbox" : "archived";
    let committedContent: LibraryItemContent | null = null;

    void queueManagedMutation(
      item.id,
      (current) => {
        committedContent = {
          ...current.content,
          archivedAt: nextStatus === "archived" ? new Date().toISOString() : null
        };
        return updateLibraryItem(current, current.ownerUid, { content: committedContent, status: nextStatus });
      },
      (current, revision) => ({ ...current, content: committedContent ?? current.content, revision, status: nextStatus }),
      {
        onSuccess: () => setStatusMessage(nextStatus === "archived" ? "자료를 보관했습니다." : "자료를 보관함에서 되돌렸습니다.")
      }
    );
  }

  function reviewItem(item: DecryptedLibraryItem) {
    void queueManagedMutation(
      item.id,
      (current) => markLibraryItemReviewed(
        current.id,
        current.ownerUid,
        current.revision,
        current.lastMutationId,
        current.generationId
      ),
      (current, revision) => ({
        ...current,
        lastReviewedAt: { toMillis: () => Date.now() } as DecryptedLibraryItem["lastReviewedAt"],
        revision,
        reviewCount: current.reviewCount + 1,
        status: current.status === "inbox" ? "reading" : current.status
      }),
      { onSuccess: () => setStatusMessage("오늘 검토한 자료로 표시했습니다.") }
    );
  }

  async function submitCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!profile || !privateKey) {
      setError("자료실 암호화 키가 잠겨 있습니다.");
      return;
    }

    if (!captureDraft.title.trim()) {
      setError("자료 제목을 입력해주세요.");
      return;
    }

    const safeUrl = captureDraft.url.trim() ? safeLibraryExternalUrl(captureDraft.url) : null;

    if (captureDraft.kind === "link" && !safeUrl) {
      setError("http 또는 https 링크를 입력해주세요.");
      return;
    }

    if (captureDraft.url.trim() && !safeUrl) {
      setError("안전한 http 또는 https 링크만 저장할 수 있습니다.");
      return;
    }

    let siteName = "";

    if (safeUrl) {
      try {
        siteName = new URL(safeUrl).hostname;
      } catch {
        siteName = "";
      }
    }

    const content: LibraryItemContent = {
      ...emptyLibraryItemContent(),
      collection: captureDraft.collection,
      description: captureDraft.description,
      readerBlocks: captureDraft.readerBlocks.length > 0
        ? captureDraft.readerBlocks
        : readerBlocksFromText(captureDraft.readerText),
      selectionText: captureDraft.selectionText,
      siteName,
      tags: tagsFromInput(captureDraft.tags),
      title: captureDraft.title,
      url: safeUrl ?? ""
    };

    setCaptureBusy(true);
    setError(null);

    try {
      await createLibraryItem({
        captureSource: captureDraft.captureSource,
        content,
        kind: captureDraft.kind,
        privateKey,
        publicKeyJwk: profile.publicKeyJwk,
        uid: profile.uid
      });
      setCaptureDraft(emptyCaptureDraft);
      setCaptureOpen(false);
      setQuickView("all");
      setKindFilter(captureDraft.kind);
      setStatusMessage(captureDraft.kind === "link" ? "링크를 암호화해 저장했습니다." : "클립을 암호화해 저장했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "자료를 저장하지 못했습니다.");
    } finally {
      setCaptureBusy(false);
    }
  }

  function openManualCapture() {
    setCaptureDraft(emptyCaptureDraft);
    setError(null);
    setCaptureOpen(true);
  }

  function importCaptureFromPaste(input: string) {
    try {
      setCaptureDraft(captureDraftFromPayload(libraryCaptureFromPaste(input)));
      setError(null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "붙여넣은 캡처 내용을 가져오지 못했습니다.");
      return false;
    }
  }

  async function confirmDelete() {
    if (!profile || !deleteTarget) {
      return;
    }

    setDeleteBusy(true);
    setDeleteError(null);

    try {
      await deleteLibraryItem(
        deleteTarget.id,
        profile.uid,
        deleteTarget.revision,
        deleteTarget.lastMutationId,
        deleteTarget.generationId
      );
      deleteSucceeded.current = true;
      if (selectedId === deleteTarget.id) {
        closeReader();
      } else {
        window.setTimeout(() => libraryResultsRef.current?.focus({ preventScroll: true }), 0);
      }
      setDeleteTarget(null);
      setStatusMessage("자료를 삭제했습니다.");
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "자료를 삭제하지 못했습니다.");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function openSourceNote(noteId: string) {
    if (!profile || !notesFeatureEnabled || !availableNotes.some((note) => note.id === noteId)) {
      setError("원본 노트의 접근 권한을 확인할 수 없습니다.");
      return;
    }

    try {
      await publishActiveNote(profile.uid, noteId, libraryClientId.current);
      navigate("/app");
    } catch {
      setError("원본 노트를 열 수 있도록 현재 노트 상태를 저장하지 못했습니다.");
    }
  }

  async function decryptAttachmentBytes(source: VirtualAttachmentItem, signal?: AbortSignal) {
    if (!profile || !privateKey) {
      throw new Error("암호화 키가 잠겨 있습니다.");
    }

    throwIfAttachmentActionAborted(signal);
    const wrappedKey = source.note.wrappedKeys[profile.uid];

    if (!wrappedKey) {
      throw new Error("이 첨부파일의 암호화 키를 확인할 수 없습니다.");
    }

    const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
    throwIfAttachmentActionAborted(signal);
    const encryptedSource = await getEncryptedNoteAttachmentSource(source.attachment, signal);
    throwIfAttachmentActionAborted(signal);
    const bytes = await decryptAttachmentToBytes(source.attachment, noteKey, encryptedSource);
    throwIfAttachmentActionAborted(signal);
    return bytes;
  }

  async function decryptAttachmentBlob(source: VirtualAttachmentItem) {
    if (!profile || !privateKey) {
      throw new Error("암호화 키가 잠겨 있습니다.");
    }

    const wrappedKey = source.note.wrappedKeys[profile.uid];

    if (!wrappedKey) {
      throw new Error("이 첨부파일의 암호화 키를 확인할 수 없습니다.");
    }

    const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
    const encryptedSource = await getEncryptedNoteAttachmentSource(source.attachment);
    return decryptAttachmentToBlob(source.attachment, noteKey, encryptedSource);
  }

  function closeAttachmentPreview() {
    attachmentActionGeneration.current += 1;
    attachmentPreviewController.current?.abort();
    attachmentPreviewController.current = null;

    if (previewObjectUrl.current) {
      URL.revokeObjectURL(previewObjectUrl.current);
      previewObjectUrl.current = null;
    }

    setAttachmentPreview(null);
  }

  async function previewSelectedAttachment() {
    const source = selectedAttachmentSource;

    if (!source) {
      setError("원본 첨부파일을 확인할 수 없습니다.");
      return;
    }

    if (source.attachment.originalSize > maxAttachmentPreviewBytes) {
      setError(`미리보기는 ${maxAttachmentPreviewLabel} 이하 파일만 지원합니다. 원본을 다운로드해 확인해주세요.`);
      return;
    }

    const extension = source.attachment.extension.toLowerCase();

    if (!textAttachmentExtensions.has(extension) && !attachmentPreviewExtensions.has(extension)) {
      setError("이 파일 형식은 자료실 안전 미리보기를 지원하지 않습니다. 다운로드해 확인해주세요.");
      return;
    }

    const generation = attachmentActionGeneration.current + 1;
    attachmentActionGeneration.current = generation;
    attachmentPreviewController.current?.abort();
    const controller = new AbortController();
    attachmentPreviewController.current = controller;
    setAttachmentBusy(true);
    setError(null);

    try {
      const bytes = await decryptAttachmentBytes(source, controller.signal);

      if (
        controller.signal.aborted
        || attachmentActionGeneration.current !== generation
        || selectedId !== selectedItem?.id
      ) {
        return;
      }

      const fileName = attachmentDownloadName(source.attachment);

      if (textAttachmentExtensions.has(extension)) {
        setAttachmentText({ id: selectedItem.id, text: decodeTextAttachmentPreview(bytes, extension) });
        setStatusMessage("첨부파일 본문을 복호화해 표시했습니다.");
        return;
      }

      if (extension === "pdf") {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        previewObjectUrl.current = url;
        setAttachmentPreview({ bytes, fileName, kind: "pdf", label: "PDF 안전 미리보기", url });
        return;
      }

      if (isPublicShareRasterImageExtension(extension)) {
        const mimeType = safePublicShareAttachmentMimeType(extension);

        if (!safeRasterImageBytes(bytes, mimeType)) {
          throw new Error("이미지 크기나 형식이 안전 미리보기 제한을 벗어났습니다.");
        }

        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        previewObjectUrl.current = url;
        setAttachmentPreview({ fileName, kind: "image", label: "이미지 안전 미리보기", url });
      }
    } catch (caught) {
      if (!controller.signal.aborted && attachmentActionGeneration.current === generation) {
        setError(caught instanceof Error ? caught.message : "첨부파일 미리보기를 열지 못했습니다.");
      }
    } finally {
      if (attachmentActionGeneration.current === generation) {
        setAttachmentBusy(false);
      }
      if (attachmentPreviewController.current === controller) {
        attachmentPreviewController.current = null;
      }
    }
  }

  async function downloadSelectedAttachment() {
    const source = selectedAttachmentSource;

    if (!source) {
      setError("원본 첨부파일을 확인할 수 없습니다.");
      return;
    }

    const generation = attachmentActionGeneration.current + 1;
    attachmentActionGeneration.current = generation;
    setAttachmentBusy(true);
    setError(null);

    try {
      const blob = await decryptAttachmentBlob(source);

      if (attachmentActionGeneration.current !== generation) {
        return;
      }

      const url = URL.createObjectURL(blob);
      downloadObjectUrls.current.add(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachmentDownloadName(source.attachment);
      anchor.rel = "noopener noreferrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadObjectUrls.current.delete(url);
        downloadCleanupTimers.current.delete(timer);
      }, 1000);
      downloadCleanupTimers.current.add(timer);
      setStatusMessage("첨부파일 다운로드를 시작했습니다.");
    } catch (caught) {
      if (attachmentActionGeneration.current === generation) {
        setError(caught instanceof Error ? caught.message : "첨부파일을 다운로드하지 못했습니다.");
      }
    } finally {
      if (attachmentActionGeneration.current === generation) {
        setAttachmentBusy(false);
      }
    }
  }

  async function extractSelectedAttachmentText() {
    const source = selectedAttachmentSource;
    const selected = selectedItem;

    if (!source || !selected || !profile || !privateKey) {
      setError("원본 첨부파일과 암호화 세션을 확인할 수 없습니다.");
      return;
    }

    if (source.note.ownerUid !== profile.uid) {
      setError("공유받은 첨부파일은 원본 노트 소유자만 개인 자료실에 텍스트를 저장할 수 있습니다.");
      return;
    }

    if (source.attachment.isReady === false) {
      setError("첨부파일 업로드가 완료된 뒤 다시 시도해주세요.");
      return;
    }

    const mode = libraryAttachmentExtractionMode(source.attachment.extension);
    if (!mode) {
      setError("텍스트 추출은 PDF, PNG, JPEG, WebP 형식만 지원합니다.");
      return;
    }

    if (source.attachment.originalSize > maxAttachmentPreviewBytes) {
      setError(`텍스트 추출은 ${maxAttachmentPreviewLabel} 이하 파일만 지원합니다.`);
      return;
    }

    const managed = selected.source === "managed" ? selected.item : null;
    if (managed && managed.content.highlights.length > 0) {
      setError("기존 하이라이트 위치를 보호하기 위해 본문을 다시 추출할 수 없습니다. 필요하면 새 자료로 다시 저장해주세요.");
      return;
    }

    attachmentExtractionController.current?.abort();
    closeAttachmentPreview();
    const controller = new AbortController();
    attachmentExtractionController.current = controller;
    const extractionBase: AttachmentExtractionBase | null = managed
      ? {
          generationId: managed.generationId,
          itemId: managed.id,
          lastMutationId: managed.lastMutationId,
          revision: managed.revision
        }
      : null;
    attachmentExtractionBase.current = extractionBase;
    const generation = attachmentActionGeneration.current + 1;
    attachmentActionGeneration.current = generation;
    const extractionId = selected.id;
    setAttachmentBusy(true);
    setAttachmentText(null);
    setError(null);
    setAttachmentExtraction({
      id: extractionId,
      label: "암호화된 파일을 이 기기에서 여는 중입니다.",
      mode,
      progress: null
    });

    try {
      const bytes = await decryptAttachmentBytes(source, controller.signal);

      if (controller.signal.aborted || attachmentActionGeneration.current !== generation) {
        return;
      }

      setAttachmentExtraction({
        id: extractionId,
        label: mode === "pdf-text" ? "PDF 텍스트 레이어를 읽는 중입니다." : "한·영 OCR 엔진을 준비하는 중입니다.",
        mode,
        progress: null
      });
      const result = await extractLibraryAttachmentText(bytes, {
        extension: source.attachment.extension,
        mimeType: source.attachment.mimeType,
        signal: controller.signal,
        onOcrProgress: (ocrProgress) => {
          if (controller.signal.aborted || attachmentActionGeneration.current !== generation) {
            return;
          }

          const label = ocrProgress.status === "recognizing"
            ? "이 기기에서 문자를 인식하는 중입니다."
            : ocrProgress.status === "language"
              ? "한·영 OCR 모델을 불러오는 중입니다."
              : "OCR 엔진을 준비하는 중입니다.";
          setAttachmentExtraction({ id: extractionId, label, mode, progress: ocrProgress.progress });
        }
      });

      if (controller.signal.aborted || attachmentActionGeneration.current !== generation) {
        return;
      }

      if (!result.readerBlocks.length) {
        throw new Error(result.likelyScanned
          ? "이 PDF는 스캔 이미지로 보입니다. 현재는 PDF 텍스트 레이어와 이미지 파일 OCR만 지원합니다."
          : "이 파일에서 저장할 텍스트를 찾지 못했습니다.");
      }

      const fileName = attachmentDownloadName(source.attachment);
      const completionMessage = result.truncated
        ? "추출한 텍스트가 길어 안전한 저장 크기까지만 암호화해 저장했습니다."
        : mode === "pdf-text"
          ? "PDF 텍스트를 암호화해 자료실에 저장했습니다."
          : "이미지 OCR 결과를 암호화해 자료실에 저장했습니다.";

      if (managed) {
        attachmentExtractionBase.current = null;
        let committedContent: LibraryItemContent | null = null;
        await queueManagedMutation(
          managed.id,
          (current) => {
            if (
              !extractionBase
              || current.generationId !== extractionBase.generationId
              || current.revision !== extractionBase.revision
              || current.lastMutationId !== extractionBase.lastMutationId
            ) {
              throw new LibraryItemRevisionConflictError();
            }
            if (current.content.highlights.length > 0) {
              throw new Error("다른 곳에서 하이라이트가 추가되어 기존 본문을 보호했습니다. 최신 내용을 확인해주세요.");
            }

            committedContent = {
              ...current.content,
              highlights: [],
              ocrText: "",
              readerBlocks: result.readerBlocks,
              sourceFileName: fileName,
              title: current.content.title || fileName
            };
            return updateLibraryItem(current, current.ownerUid, { content: committedContent });
          },
          (current, revision) => ({ ...current, content: committedContent ?? current.content, revision }),
          { onSuccess: () => setStatusMessage(completionMessage) }
        );
      } else {
        attachmentExtractionBase.current = null;
        const nextContent: LibraryItemContent = {
          ...emptyLibraryItemContent(),
          highlights: [],
          ocrText: "",
          readerBlocks: result.readerBlocks,
          sourceFileName: fileName,
          title: fileName
        };
        await createLibraryItem({
          captureSource: "attachment-ocr",
          content: nextContent,
          kind: "attachment",
          privateKey,
          publicKeyJwk: profile.publicKeyJwk,
          sourceAttachmentId: source.attachment.id,
          sourceNoteId: source.note.id,
          uid: profile.uid
        });
        setSelectedId(null);
        setQuickView("all");
        setKindFilter("attachment");
        setStatusMessage(completionMessage);
      }
    } catch (caught) {
      if (
        !controller.signal.aborted
        && attachmentActionGeneration.current === generation
        && (!(caught instanceof Error) || caught.name !== "AbortError")
      ) {
        setError(caught instanceof Error ? caught.message : "첨부파일에서 텍스트를 추출하지 못했습니다.");
      }
    } finally {
      if (attachmentActionGeneration.current === generation) {
        setAttachmentBusy(false);
        setAttachmentExtraction(null);
        if (attachmentExtractionController.current === controller) {
          attachmentExtractionController.current = null;
          attachmentExtractionBase.current = null;
        }
      }
    }
  }

  function addHighlight() {
    if (!selectedItem || selectedItem.source !== "managed" || !pendingHighlight || pendingHighlight.itemId !== selectedItem.id) {
      setError("리더 본문에서 메모할 텍스트를 먼저 선택해주세요.");
      return;
    }

    const item = selectedItem.item;
    const block = item.content.readerBlocks.find((candidate) => candidate.id === pendingHighlight.blockId);

    if (!block || pendingHighlight.endOffset > block.text.length) {
      setError("선택한 본문 위치를 다시 확인해주세요.");
      return;
    }

    const overlaps = item.content.highlights.some((highlight) =>
      highlight.blockId === pendingHighlight.blockId
      && pendingHighlight.startOffset < highlight.endOffset
      && pendingHighlight.endOffset > highlight.startOffset
    );

    if (overlaps) {
      setError("이미 하이라이트된 범위와 겹칩니다.");
      return;
    }

    const highlight: LibraryHighlight = {
      blockId: pendingHighlight.blockId,
      color: highlightColor,
      createdAt: new Date().toISOString(),
      endOffset: pendingHighlight.endOffset,
      id: nextLibraryId(),
      note: highlightNote,
      quote: block.text.slice(pendingHighlight.startOffset, pendingHighlight.endOffset),
      startOffset: pendingHighlight.startOffset
    };
    let committedContent: LibraryItemContent | null = null;

    void queueManagedMutation(
      item.id,
      (current) => {
        if (
          current.generationId !== item.generationId
          || current.revision !== item.revision
          || current.lastMutationId !== item.lastMutationId
        ) {
          throw new LibraryItemRevisionConflictError();
        }

        const currentBlock = current.content.readerBlocks.find((candidate) => candidate.id === highlight.blockId);
        const currentOverlaps = current.content.highlights.some((candidate) =>
          candidate.blockId === highlight.blockId
          && highlight.startOffset < candidate.endOffset
          && highlight.endOffset > candidate.startOffset
        );
        if (!currentBlock || highlight.endOffset > currentBlock.text.length || currentOverlaps) {
          throw new LibraryItemRevisionConflictError();
        }

        committedContent = {
          ...current.content,
          highlights: [...current.content.highlights, highlight]
        };
        return updateLibraryItem(current, current.ownerUid, { content: committedContent });
      },
      (current, revision) => ({ ...current, content: committedContent ?? current.content, revision }),
      {
        onSuccess: () => {
          setPendingHighlight(null);
          setHighlightNote("");
          window.getSelection()?.removeAllRanges();
          setStatusMessage("하이라이트와 메모를 암호화해 저장했습니다.");
        }
      }
    );
  }

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

  const loadingMessage = attachmentProgress.total > 0 && attachmentProgress.completed < attachmentProgress.total
    ? `${attachmentProgress.total}개 노트 중 ${attachmentProgress.completed}개의 첨부파일을 확인했습니다.`
    : libraryDecrypting
      ? "저장한 자료를 복호화하는 중입니다."
      : "자료실을 안전하게 불러오는 중입니다.";

  return (
    <AppShell>
      <section className="library-workspace" aria-labelledby="library-page-title">
        <header className="library-header">
          <div className="library-heading">
            <p className="section-kicker">
              <LibraryBig size={16} />
              자료실
            </p>
            <h1 id="library-page-title">{quickViewLabels[quickView]}</h1>
            <p>{notesFeatureEnabled
              ? "노트 첨부파일과 저장한 링크를 한 곳에서 검색하고 다시 읽습니다."
              : "저장한 링크와 클립을 한 곳에서 검색하고 다시 읽습니다."}</p>
          </div>
          <label className="library-search-control">
            <Search aria-hidden="true" size={18} />
            <span className="sr-only">자료 검색</span>
            <input
              aria-label="자료 검색"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="파일명, 제목, 태그, 본문 검색"
              type="search"
              value={query}
            />
            {query && (
              <button aria-label="검색어 지우기" className="library-search-clear" onClick={() => setQuery("")} type="button">
                <X size={15} />
              </button>
            )}
          </label>
          <div className="library-header-actions">
            <button
              aria-controls="library-filter-panel"
              aria-expanded={filtersOpen}
              className={`secondary-button ${filtersActive ? "active" : ""}`}
              onClick={() => setFiltersOpen((current) => !current)}
              type="button"
            >
              <Filter size={17} />
              필터
              {filtersActive && <span className="library-filter-dot" aria-label="필터 적용됨" />}
            </button>
            <button
              onClick={openManualCapture}
              type="button"
            >
              <Plus size={17} />
              자료 저장
            </button>
          </div>
        </header>

        <div className="library-live-region" aria-live="polite" role="status">
          {loading ? loadingMessage : `${filteredItems.length}개 자료를 표시합니다. ${statusMessage}`}
        </div>
        {!notesFeatureEnabled && (
          <div className="library-feedback" role="status">
            노트 첨부파일은 노트 기능 권한이 있을 때 함께 표시됩니다. 저장한 자료는 계속 사용할 수 있습니다.
          </div>
        )}
        {!captureOpen && (error || attachmentFailureCount > 0 || decryptFailureCount > 0) && (
          <div className="library-feedback error" role="alert">
            <span>
              {error ?? `일부 자료를 확인하지 못했습니다. 첨부 ${attachmentFailureCount}개 노트, 복호화 ${decryptFailureCount}개 항목`}
            </span>
            <button aria-label="오류 메시지 닫기" className="icon-button" onClick={() => setError(null)} type="button">
              <X size={15} />
            </button>
          </div>
        )}

        {filtersOpen && (
          <LibraryFilterPanel
            collectionFilter={collectionFilter}
            collections={collections}
            favoriteOnly={favoriteOnly}
            kindFilter={kindFilter}
            statusFilter={statusFilter}
            tagFilter={tagFilter}
            tags={tags}
            onClear={clearFilters}
            onClose={() => setFiltersOpen(false)}
            onCollectionChange={setCollectionFilter}
            onFavoriteChange={setFavoriteOnly}
            onKindChange={setKindFilter}
            onStatusChange={setStatusFilter}
            onTagChange={setTagFilter}
          />
        )}

        <div className={`library-layout ${selectedItem ? "with-reader" : ""}`}>
          <LibrarySidebar
            attachmentCount={virtualAttachments.length}
            collections={collections}
            favoriteCount={libraryItems.filter((item) => item.isFavorite).length}
            kindFacetCounts={kindFacetCounts}
            kindFilter={kindFilter}
            itemCount={allViewItems.filter((item) => viewItemStatus(item) !== "archived").length}
            quickView={quickView}
            reviewCount={reviewCount}
            tagCount={tags.length}
            onCollectionSelect={(collection) => {
              setCollectionFilter(collection);
              setQuickView("all");
            }}
            onKindFilterChange={setKindFilter}
            onQuickViewChange={(view) => {
              setQuickView(view);
              if (view === "archived") {
                setStatusFilter("all");
              }
            }}
          />

          <section className="library-results-panel" aria-labelledby="library-results-title">
            <header className="library-results-header">
              <div>
                <span>{quickView === "today" ? "오늘 확인할 자료" : "검색 결과"}</span>
                <h2 id="library-results-title" ref={libraryResultsRef} tabIndex={-1}>{filteredItems.length}개</h2>
              </div>
              <label className="library-sort-control">
                <ListFilter aria-hidden="true" size={16} />
                <span className="sr-only">자료 정렬</span>
                <select aria-label="자료 정렬" onChange={(event) => setSort(event.target.value as LibrarySort)} value={sort}>
                  <option value="updated">최근 변경순</option>
                  <option value="created">최근 추가순</option>
                  <option value="opened">최근 열람순</option>
                  <option value="title">제목순</option>
                </select>
              </label>
            </header>

            {quickView === "today" && filteredItems.length > 0 && (
              <div className="library-review-intro">
                <BookOpenCheck aria-hidden="true" size={19} />
                <div>
                  <strong>오늘의 리뷰</strong>
                  <p>오늘 아직 확인하지 않은 자료입니다. 읽은 뒤 ‘검토 완료’로 표시해주세요.</p>
                </div>
              </div>
            )}

            {loading && !allViewItems.length ? (
              <LibraryLoadingState />
            ) : filteredItems.length ? (
              <div className="library-item-list" role="list">
                {filteredItems.map((item) => (
                  <LibraryItemRow
                    active={item.id === selectedId}
                    busy={item.source === "managed" && (
                      mutatingItemIds.has(item.id) || attachmentExtraction?.id === item.id
                    )}
                    item={item}
                    key={item.id}
                    reviewMode={quickView === "today"}
                    onArchive={toggleArchive}
                    onDelete={(target, returnFocus) => {
                      deleteSucceeded.current = false;
                      deleteReturnFocus.current = returnFocus;
                      setDeleteError(null);
                      setDeleteTarget(target);
                    }}
                    onFavorite={toggleFavorite}
                    onReview={reviewItem}
                    onSelect={selectItem}
                  />
                ))}
              </div>
            ) : (
              <LibraryEmptyState
                filtered={Boolean(query || filtersActive || quickView !== "all")}
                quickView={quickView}
                onClear={() => {
                  setQuery("");
                  clearFilters();
                  setQuickView("all");
                }}
                onCreate={openManualCapture}
              />
            )}
            {(canLoadMoreLibraryItems || canLoadMoreAttachmentNotes || attachmentNoteLimitReached) && (
              <div className="library-load-more" aria-label="추가 자료 불러오기">
                {canLoadMoreLibraryItems && (
                  <button
                    className="secondary-button"
                    disabled={libraryLoading || libraryLoadingMore}
                    onClick={() => void loadMoreLibraryItems()}
                    type="button"
                  >
                    {libraryLoadingMore
                      ? "이전 자료 불러오는 중..."
                      : `저장한 자료 ${librarySubscriptionStep}개 더 불러오기`}
                  </button>
                )}
                {canLoadMoreAttachmentNotes && (
                  <button
                    className="secondary-button"
                    disabled={attachmentProgress.completed < attachmentProgress.total}
                    onClick={() => setAttachmentNoteLimit((current) => Math.min(
                      maximumAttachmentNoteLimit,
                      current + attachmentNoteLimitStep
                    ))}
                    type="button"
                  >
                    이전 노트 첨부 더 확인하기
                  </button>
                )}
                {attachmentNoteLimitReached && (
                  <p role="status">
                    노트 첨부파일 확인 한도에 도달했습니다. 검색 범위를 줄여주세요.
                  </p>
                )}
              </div>
            )}
          </section>

          {selectedItem && (
            <LibraryReader
              attachmentBusy={attachmentBusy}
              attachmentExtraction={attachmentExtraction?.id === selectedItem.id ? attachmentExtraction : null}
              attachmentSource={selectedAttachmentSource}
              attachmentText={attachmentText?.id === selectedItem.id ? attachmentText.text : null}
              canExtractAttachment={canExtractSelectedAttachment}
              highlightColor={highlightColor}
              highlightNote={highlightNote}
              item={selectedItem}
              mutating={
                (selectedItem.source === "managed" && mutatingItemIds.has(selectedItem.id))
                || attachmentExtraction?.id === selectedItem.id
              }
              pendingHighlight={pendingHighlight?.itemId === selectedItem.id ? pendingHighlight : null}
              suspended={captureOpen || Boolean(deleteTarget) || Boolean(attachmentPreview)}
              onAddHighlight={addHighlight}
              onArchive={toggleArchive}
              onClose={closeReader}
              onDelete={(target, returnFocus) => {
                deleteSucceeded.current = false;
                deleteReturnFocus.current = returnFocus;
                setDeleteError(null);
                setDeleteTarget(target);
              }}
              onDownload={() => void downloadSelectedAttachment()}
              onExtract={() => void extractSelectedAttachmentText()}
              onFavorite={toggleFavorite}
              onHighlightColorChange={setHighlightColor}
              onHighlightNoteChange={setHighlightNote}
              onOpenSource={(noteId) => void openSourceNote(noteId)}
              onPreview={(returnFocus) => {
                previewReturnFocus.current = returnFocus;
                void previewSelectedAttachment();
              }}
              onReview={reviewItem}
            />
          )}
        </div>

        {captureOpen && (
          <LibraryCaptureDialog
            busy={captureBusy}
            draft={captureDraft}
            error={error}
            importing={captureHandoffBusy}
            onChange={setCaptureDraft}
            onClose={() => {
              if (!captureBusy && !captureHandoffBusy) {
                setCaptureOpen(false);
                setError(null);
              }
            }}
            onImport={importCaptureFromPaste}
            onSubmit={submitCapture}
          />
        )}
        {deleteTarget && (
          <LibraryDeleteConfirmDialog
            error={deleteError}
            pending={deleteBusy}
            target={deleteTarget}
            onCancel={() => {
              if (!deleteBusy) {
                setDeleteTarget(null);
                setDeleteError(null);
              }
            }}
            onConfirm={() => void confirmDelete()}
            onRestoreFocus={restoreDeleteDialogFocus}
          />
        )}
        {attachmentPreview && (
          <PublicAttachmentPreviewModal
            fallbackFocus={libraryResultsRef.current}
            onClose={closeAttachmentPreview}
            preview={attachmentPreview}
            returnFocus={previewReturnFocus.current}
          />
        )}
      </section>
    </AppShell>
  );
}

function LibraryFilterPanel({
  collectionFilter,
  collections,
  favoriteOnly,
  kindFilter,
  onClear,
  onClose,
  onCollectionChange,
  onFavoriteChange,
  onKindChange,
  onStatusChange,
  onTagChange,
  statusFilter,
  tagFilter,
  tags
}: {
  collectionFilter: string;
  collections: string[];
  favoriteOnly: boolean;
  kindFilter: LibraryKindFilter;
  onClear: () => void;
  onClose: () => void;
  onCollectionChange: (value: string) => void;
  onFavoriteChange: (value: boolean) => void;
  onKindChange: (value: LibraryKindFilter) => void;
  onStatusChange: (value: LibraryStatusFilter) => void;
  onTagChange: (value: string) => void;
  statusFilter: LibraryStatusFilter;
  tagFilter: string;
  tags: string[];
}) {
  return (
    <section aria-label="자료실 필터" className="library-filter-panel" id="library-filter-panel">
      <div className="library-filter-panel-title">
        <span>
          <Filter aria-hidden="true" size={16} />
          필터
        </span>
        <button aria-label="필터 닫기" className="icon-button" onClick={onClose} type="button">
          <X size={15} />
        </button>
      </div>
      <label>
        종류
        <select onChange={(event) => onKindChange(event.target.value as LibraryKindFilter)} value={kindFilter}>
          <option value="all">전체 종류</option>
          <option value="link">링크</option>
          <option value="clip">클립</option>
          <option value="attachment">파일</option>
        </select>
      </label>
      <label>
        상태
        <select onChange={(event) => onStatusChange(event.target.value as LibraryStatusFilter)} value={statusFilter}>
          <option value="all">전체 상태</option>
          <option value="inbox">미분류</option>
          <option value="reading">읽는 중</option>
          <option value="archived">보관됨</option>
        </select>
      </label>
      <label>
        컬렉션
        <select onChange={(event) => onCollectionChange(event.target.value)} value={collectionFilter}>
          <option value="all">전체 컬렉션</option>
          {collections.map((collection) => <option key={collection} value={collection}>{collection}</option>)}
        </select>
      </label>
      <label>
        태그
        <select onChange={(event) => onTagChange(event.target.value)} value={tagFilter}>
          <option value="all">전체 태그</option>
          {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </label>
      <label className="library-favorite-filter">
        <input checked={favoriteOnly} onChange={(event) => onFavoriteChange(event.target.checked)} type="checkbox" />
        <Star aria-hidden="true" size={16} />
        즐겨찾기만 보기
      </label>
      <button className="secondary-button library-filter-reset" onClick={onClear} type="button">
        필터 초기화
      </button>
    </section>
  );
}

function LibrarySidebar({
  attachmentCount,
  collections,
  favoriteCount,
  itemCount,
  kindFacetCounts,
  kindFilter,
  onCollectionSelect,
  onKindFilterChange,
  onQuickViewChange,
  quickView,
  reviewCount,
  tagCount
}: {
  attachmentCount: number;
  collections: string[];
  favoriteCount: number;
  itemCount: number;
  kindFacetCounts: Record<LibraryKindFilter, number>;
  kindFilter: LibraryKindFilter;
  onCollectionSelect: (collection: string) => void;
  onKindFilterChange: (kind: LibraryKindFilter) => void;
  onQuickViewChange: (view: LibraryQuickView) => void;
  quickView: LibraryQuickView;
  reviewCount: number;
  tagCount: number;
}) {
  const quickViews: Array<{ count: number; Icon: typeof Inbox; id: LibraryQuickView; label: string }> = [
    { count: itemCount, Icon: Inbox, id: "all", label: "전체 자료" },
    { count: reviewCount, Icon: BookOpenCheck, id: "today", label: "오늘의 리뷰" },
    { count: favoriteCount, Icon: Star, id: "favorites", label: "즐겨찾기" },
    { count: 0, Icon: Archive, id: "archived", label: "보관함" }
  ];
  const kindViews: Array<{ Icon: typeof Inbox; id: LibraryKindFilter; label: string }> = [
    { Icon: LibraryBig, id: "all", label: "전체" },
    { Icon: Link2, id: "link", label: "링크" },
    { Icon: File, id: "attachment", label: "파일" },
    { Icon: FileText, id: "clip", label: "클립" }
  ];

  return (
    <aside className="library-sidebar">
      <nav aria-label="자료실 빠른 보기">
        <span className="library-sidebar-label">빠른 보기</span>
        {quickViews.map(({ count, Icon, id, label }) => (
          <button
            aria-current={quickView === id ? "page" : undefined}
            className={quickView === id ? "active" : ""}
            key={id}
            onClick={() => onQuickViewChange(id)}
            type="button"
          >
            <Icon aria-hidden="true" size={17} />
            <span>{label}</span>
            {id !== "archived" && <em>{count}</em>}
          </button>
        ))}
      </nav>
      <nav aria-label="자료 유형" className="library-sidebar-kind-nav">
        <span className="library-sidebar-label">자료 유형</span>
        {kindViews.map(({ Icon, id, label }) => (
          <button
            aria-pressed={kindFilter === id}
            className={kindFilter === id ? "active" : ""}
            key={id}
            onClick={() => onKindFilterChange(id)}
            type="button"
          >
            <Icon aria-hidden="true" size={17} />
            <span>{label}</span>
            <em>{kindFacetCounts[id]}</em>
          </button>
        ))}
      </nav>
      <section aria-labelledby="library-collections-title" className="library-sidebar-section">
        <div>
          <span id="library-collections-title">
            <FolderOpen aria-hidden="true" size={15} />
            컬렉션
          </span>
          <em>{collections.length}</em>
        </div>
        {collections.length ? collections.slice(0, 8).map((collection) => (
          <button key={collection} onClick={() => onCollectionSelect(collection)} type="button">
            <span>{collection}</span>
            <ChevronRight aria-hidden="true" size={14} />
          </button>
        )) : <p>저장한 컬렉션이 없습니다.</p>}
      </section>
      <div className="library-sidebar-summary">
        <span>
          <File aria-hidden="true" size={15} />
          노트 첨부 {attachmentCount}개
        </span>
        <span>
          <Tag aria-hidden="true" size={15} />
          태그 {tagCount}개
        </span>
      </div>
    </aside>
  );
}

function LibraryLoadingState() {
  return (
    <div className="library-loading-state" aria-label="자료를 불러오는 중" role="status">
      <Loader2 className="spin" size={24} />
      <strong>자료를 안전하게 불러오는 중입니다.</strong>
      <p>제목과 본문은 이 기기에서만 복호화합니다.</p>
    </div>
  );
}

function LibraryEmptyState({
  filtered,
  onClear,
  onCreate,
  quickView
}: {
  filtered: boolean;
  onClear: () => void;
  onCreate: () => void;
  quickView: LibraryQuickView;
}) {
  const title = quickView === "today"
    ? "오늘 검토할 자료가 없습니다."
    : filtered
      ? "조건에 맞는 자료가 없습니다."
      : "아직 모아볼 자료가 없습니다.";

  return (
    <div className="library-empty-state">
      <LibraryBig aria-hidden="true" size={30} />
      <strong>{title}</strong>
      <p>{filtered ? "검색어나 필터를 초기화해보세요." : "링크를 저장하거나 노트에 파일을 첨부하면 여기에 표시됩니다."}</p>
      <div>
        {filtered && <button className="secondary-button" onClick={onClear} type="button">검색과 필터 초기화</button>}
        <button onClick={onCreate} type="button">
          <Plus size={16} />
          자료 저장
        </button>
      </div>
    </div>
  );
}

function LibraryItemRow({
  active,
  busy,
  item,
  onArchive,
  onDelete,
  onFavorite,
  onReview,
  onSelect,
  reviewMode
}: {
  active: boolean;
  busy: boolean;
  item: LibraryViewItem;
  onArchive: (item: DecryptedLibraryItem) => void;
  onDelete: (target: DeleteTarget, returnFocus: HTMLElement) => void;
  onFavorite: (item: DecryptedLibraryItem) => void;
  onReview: (item: DecryptedLibraryItem) => void;
  onSelect: (item: LibraryViewItem) => void;
  reviewMode: boolean;
}) {
  const title = viewItemTitle(item);
  const kind = viewItemKind(item);
  const tags = viewItemTags(item);
  const subtitle = item.source === "managed"
    ? item.item.content.siteName || item.item.content.collection || kindLabels[kind]
    : item.noteTitle;
  const date = item.source === "managed" ? item.item.updatedAt : item.attachment.createdAt;

  return (
    <article className={`library-item-row ${active ? "active" : ""}`} role="listitem">
      <button
        aria-label={`${title} 열기`}
        aria-pressed={active}
        className="library-item-open"
        onClick={() => onSelect(item)}
        type="button"
      >
        <span className={`library-item-kind-icon ${kind}`} aria-hidden="true">
          {libraryKindIcon(item)}
        </span>
        <span className="library-item-main">
          <span className="library-item-title-line">
            <strong>{title}</strong>
            {viewItemFavorite(item) && <Star aria-label="즐겨찾기" fill="currentColor" size={14} />}
          </span>
          <span className="library-item-subtitle">{subtitle}</span>
          <span className="library-item-meta">
            <em>{kindLabels[kind]}</em>
            <span>{statusLabels[viewItemStatus(item)]}</span>
            {item.source === "attachment" && <span>{formatFileSize(item.attachment.originalSize)}</span>}
            <span>{formatLibraryDate(date)}</span>
          </span>
          {tags.length > 0 && (
            <span className="library-item-tags" aria-label={`태그 ${tags.join(", ")}`}>
              {tags.slice(0, 3).map((tag) => <em key={tag}>#{tag}</em>)}
            </span>
          )}
        </span>
        <ChevronRight className="library-item-chevron" aria-hidden="true" size={17} />
      </button>
      {item.source === "managed" && (
        <div className="library-item-actions">
          {reviewMode && (
            <button aria-label={`${title} 검토 완료`} disabled={busy} onClick={() => onReview(item.item)} type="button">
              <Check size={15} />
              검토 완료
            </button>
          )}
          <button
            aria-label={item.item.isFavorite ? `${title} 즐겨찾기 해제` : `${title} 즐겨찾기`}
            aria-pressed={item.item.isFavorite}
            className="icon-button"
            disabled={busy}
            onClick={() => onFavorite(item.item)}
            type="button"
          >
            {busy ? <Loader2 className="spin" size={15} /> : <Star fill={item.item.isFavorite ? "currentColor" : "none"} size={15} />}
          </button>
          <button
            aria-label={item.item.status === "archived" ? `${title} 보관 해제` : `${title} 보관`}
            className="icon-button"
            disabled={busy}
            onClick={() => onArchive(item.item)}
            type="button"
          >
            {item.item.status === "archived" ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </button>
          <button
            aria-label={`${title} 삭제`}
            className="icon-button danger"
            disabled={busy}
            onClick={(event) => onDelete(
              {
                generationId: item.item.generationId,
                id: item.item.id,
                lastMutationId: item.item.lastMutationId,
                revision: item.item.revision,
                title
              },
              event.currentTarget
            )}
            type="button"
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </article>
  );
}

function LibraryReader({
  attachmentBusy,
  attachmentExtraction,
  attachmentSource,
  attachmentText,
  canExtractAttachment,
  highlightColor,
  highlightNote,
  item,
  mutating,
  onAddHighlight,
  onArchive,
  onClose,
  onDelete,
  onDownload,
  onExtract,
  onFavorite,
  onHighlightColorChange,
  onHighlightNoteChange,
  onOpenSource,
  onPreview,
  onReview,
  pendingHighlight,
  suspended
}: {
  attachmentBusy: boolean;
  attachmentExtraction: AttachmentExtractionProgress | null;
  attachmentSource: VirtualAttachmentItem | null;
  attachmentText: string | null;
  canExtractAttachment: boolean;
  highlightColor: LibraryHighlightColor;
  highlightNote: string;
  item: LibraryViewItem;
  mutating: boolean;
  onAddHighlight: () => void;
  onArchive: (item: DecryptedLibraryItem) => void;
  onClose: () => void;
  onDelete: (target: DeleteTarget, returnFocus: HTMLElement) => void;
  onDownload: () => void;
  onExtract: () => void;
  onFavorite: (item: DecryptedLibraryItem) => void;
  onHighlightColorChange: (color: LibraryHighlightColor) => void;
  onHighlightNoteChange: (value: string) => void;
  onOpenSource: (noteId: string) => void;
  onPreview: (returnFocus: HTMLElement) => void;
  onReview: (item: DecryptedLibraryItem) => void;
  pendingHighlight: PendingHighlight | null;
  suspended: boolean;
}) {
  const titleId = useId();
  const readerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mobileReader = useMobileLibraryReader();
  const title = viewItemTitle(item);
  const managed = item.source === "managed" ? item.item : null;
  const safeUrl = managed?.content.url ? safeLibraryExternalUrl(managed.content.url) : null;
  const sourceNoteId = item.source === "attachment"
    ? item.note.id
    : managed?.kind === "attachment"
      ? attachmentSource?.note.id ?? null
      : managed?.sourceNoteId ?? null;
  const extension = attachmentSource?.attachment.extension.toLowerCase() ?? "";
  const extractionMode = libraryAttachmentExtractionMode(extension);
  const canPreviewAttachment = Boolean(
    attachmentSource
    && (textAttachmentExtensions.has(extension) || attachmentPreviewExtensions.has(extension))
  );

  useLayoutEffect(() => {
    if (mobileReader) {
      closeButtonRef.current?.focus({ preventScroll: true });
    } else {
      readerRef.current?.focus({ preventScroll: true });
    }
  }, [item.id, mobileReader]);

  return (
    <div
      aria-hidden={suspended ? true : undefined}
      className="library-reader-backdrop"
      inert={suspended}
      role="presentation"
      onMouseDown={(event) => {
        if (mobileReader && !suspended && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
    <aside
      aria-labelledby={titleId}
      aria-modal={mobileReader && !suspended ? true : undefined}
      className="library-reader"
      ref={readerRef}
      role={mobileReader ? "dialog" : undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (mobileReader && !suspended) {
          trapDialogKeyboard(event, false, onClose);
        }
      }}
    >
      <header className="library-reader-header">
        <div>
          <span>{kindLabels[viewItemKind(item)]}</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          aria-label="자료 리더 닫기"
          className="icon-button"
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          <PanelRightClose size={18} />
        </button>
      </header>

      <div className="library-reader-toolbar">
        {managed && (
          <>
            <button
              aria-label={managed.isFavorite ? "즐겨찾기 해제" : "즐겨찾기"}
              aria-pressed={managed.isFavorite}
              className="secondary-button"
              disabled={mutating}
              onClick={() => onFavorite(managed)}
              type="button"
            >
              <Star fill={managed.isFavorite ? "currentColor" : "none"} size={15} />
              {managed.isFavorite ? "즐겨찾기됨" : "즐겨찾기"}
            </button>
            <button className="secondary-button" disabled={mutating} onClick={() => onReview(managed)} type="button">
              <BookOpenCheck size={15} />
              검토 완료
            </button>
          </>
        )}
        {safeUrl && (
          <a className="secondary-button" href={safeUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink size={15} />
            외부에서 열기
          </a>
        )}
        {sourceNoteId && (
          <button className="secondary-button" onClick={() => onOpenSource(sourceNoteId)} type="button">
            <FileText size={15} />
            원본 노트
          </button>
        )}
        {attachmentSource && (
          <>
            {extractionMode && canExtractAttachment && (
              <button
                className="secondary-button"
                disabled={attachmentBusy || mutating || Boolean(managed?.content.highlights.length)}
                onClick={onExtract}
                type="button"
              >
                {attachmentExtraction ? <Loader2 className="spin" size={15} /> : <FileText size={15} />}
                {extractionMode === "pdf-text"
                  ? `${managed?.content.readerBlocks.length ? "PDF 다시 " : "PDF 텍스트 "}추출`
                  : managed?.content.readerBlocks.length ? "이미지 OCR 다시 실행" : "이미지 OCR 실행"}
              </button>
            )}
            {canPreviewAttachment && (
              <button
                className="secondary-button"
                disabled={attachmentBusy}
                onClick={(event) => onPreview(event.currentTarget)}
                type="button"
              >
                {attachmentBusy ? <Loader2 className="spin" size={15} /> : <Eye size={15} />}
                미리보기
              </button>
            )}
            <button className="secondary-button" disabled={attachmentBusy} onClick={onDownload} type="button">
              <Download size={15} />
              다운로드
            </button>
          </>
        )}
      </div>

      <div className="library-reader-scroll">
        {attachmentExtraction && (
          <section aria-live="polite" className="library-extraction-progress" role="status">
            <Loader2 aria-hidden="true" className="spin" size={18} />
            <div>
              <strong>{attachmentExtraction.mode === "pdf-text" ? "PDF 텍스트 추출 중" : "이미지 OCR 실행 중"}</strong>
              <p>{attachmentExtraction.label}</p>
              <progress
                aria-label="텍스트 추출 진행률"
                max={100}
                value={attachmentExtraction.progress === null ? undefined : Math.round(attachmentExtraction.progress * 100)}
              />
            </div>
          </section>
        )}
        {attachmentSource && extractionMode && !canExtractAttachment && (
          <section className="library-extraction-notice">
            <strong>원본 노트 소유자만 텍스트를 저장할 수 있습니다.</strong>
            <p>공유 권한이 해제된 뒤에도 남는 개인 복사본을 방지하기 위한 보호 정책입니다.</p>
          </section>
        )}
        {attachmentSource && extractionMode && canExtractAttachment && item.source === "attachment" && !attachmentExtraction && (
          <section className="library-extraction-notice secure">
            <strong>파일은 이 기기에서만 처리됩니다.</strong>
            <p>PDF 텍스트와 이미지 OCR 결과는 외부 분석 서버로 전송하지 않고, 저장 전 이 브라우저에서 암호화합니다.</p>
          </section>
        )}
        {attachmentSource && extractionMode && canExtractAttachment && managed?.content.highlights.length ? (
          <section className="library-extraction-notice">
            <strong>하이라이트가 있어 다시 추출을 잠갔습니다.</strong>
            <p>본문이 바뀌면 메모 위치가 어긋날 수 있어 기존 하이라이트를 보호합니다.</p>
          </section>
        ) : null}
        {managed ? (
          <>
            <section className="library-reader-info" aria-label="자료 정보">
              <span>{statusLabels[managed.status]}</span>
              {managed.content.siteName && <span>{managed.content.siteName}</span>}
              {managed.content.collection && <span>컬렉션 · {managed.content.collection}</span>}
              <span>{formatLibraryDate(managed.updatedAt)} 변경</span>
            </section>
            {managed.content.tags.length > 0 && (
              <div className="library-reader-tags" aria-label="태그">
                {managed.content.tags.map((tag) => <span key={tag}>#{tag}</span>)}
              </div>
            )}
            {managed.content.description && (
              <section className="library-reader-section">
                <h3>메모</h3>
                <p>{managed.content.description}</p>
              </section>
            )}
            {managed.content.selectionText && (
              <section className="library-reader-section selection">
                <h3>선택 텍스트</h3>
                <blockquote>{managed.content.selectionText}</blockquote>
              </section>
            )}
            {managed.content.readerBlocks.length > 0 ? (
              <section className="library-reader-section">
                <div className="library-reader-section-heading">
                  <h3>리더 본문</h3>
                  <span>텍스트를 선택해 하이라이트할 수 있습니다.</span>
                </div>
                <div className="library-reader-content">
                  {managed.content.readerBlocks.map((block) => readerBlockElement(
                    block.kind,
                    highlightedBlockText(block, managed.content.highlights),
                    "library-reader-block",
                    block.id
                  ))}
                </div>
              </section>
            ) : (
              <div className="library-reader-no-content">
                <FileText aria-hidden="true" size={23} />
                <strong>저장된 리더 본문이 없습니다.</strong>
                <p>링크는 외부에서 열거나 메모를 확인해주세요.</p>
              </div>
            )}

            {pendingHighlight && (
              <section className="library-highlight-composer" aria-labelledby="library-highlight-composer-title">
                <div>
                  <Highlighter aria-hidden="true" size={17} />
                  <strong id="library-highlight-composer-title">선택한 텍스트에 메모 추가</strong>
                </div>
                <blockquote>{pendingHighlight.quote}</blockquote>
                <label>
                  색상
                  <select onChange={(event) => onHighlightColorChange(event.target.value as LibraryHighlightColor)} value={highlightColor}>
                    {Object.entries(highlightColorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  메모
                  <textarea
                    maxLength={2000}
                    onChange={(event) => onHighlightNoteChange(event.target.value)}
                    placeholder="왜 중요한지 짧게 남겨보세요."
                    rows={3}
                    value={highlightNote}
                  />
                </label>
                <button disabled={mutating} onClick={onAddHighlight} type="button">
                  {mutating ? <Loader2 className="spin" size={16} /> : <Highlighter size={16} />}
                  하이라이트 저장
                </button>
              </section>
            )}

            {managed.content.highlights.length > 0 && (
              <section className="library-reader-section library-highlight-list">
                <h3>하이라이트 {managed.content.highlights.length}개</h3>
                {managed.content.highlights.map((highlight) => (
                  <article key={highlight.id}>
                    <span className={`library-highlight-swatch ${highlight.color}`} aria-label={`${highlightColorLabels[highlight.color]} 하이라이트`} />
                    <div>
                      <blockquote>{highlight.quote}</blockquote>
                      {highlight.note && <p>{highlight.note}</p>}
                    </div>
                  </article>
                ))}
              </section>
            )}
          </>
        ) : item.source === "attachment" ? (
          <>
            <section className="library-reader-info" aria-label="첨부파일 정보">
              <span>{item.attachment.extension.toUpperCase()}</span>
              <span>{formatFileSize(item.attachment.originalSize)}</span>
              <span>{formatLibraryDate(item.attachment.createdAt)} 첨부</span>
            </section>
            <section className="library-reader-section">
              <h3>원본 노트</h3>
              <p>{item.noteTitle}</p>
            </section>
            {!canPreviewAttachment && (
              <div className="library-reader-no-content">
                <File aria-hidden="true" size={23} />
                <strong>이 형식은 자료실 미리보기를 지원하지 않습니다.</strong>
                <p>원본 노트를 열거나 파일을 다운로드해 확인해주세요.</p>
              </div>
            )}
          </>
        ) : null}

        {attachmentText && (
          <section className="library-reader-section library-attachment-text">
            <h3>첨부파일 본문</h3>
            <pre>{attachmentText}</pre>
          </section>
        )}
      </div>

      {managed && (
        <footer className="library-reader-footer">
          <button className="secondary-button" disabled={mutating} onClick={() => onArchive(managed)} type="button">
            {managed.status === "archived" ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {managed.status === "archived" ? "보관 해제" : "보관"}
          </button>
          <button
            className="secondary-button danger"
            disabled={mutating}
            onClick={(event) => onDelete(
              {
                generationId: managed.generationId,
                id: managed.id,
                lastMutationId: managed.lastMutationId,
                revision: managed.revision,
                title
              },
              event.currentTarget
            )}
            type="button"
          >
            <Trash2 size={15} />
            삭제
          </button>
        </footer>
      )}
    </aside>
    </div>
  );
}

function focusableDialogElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]"
    )
  ).filter((element) => {
    const disabled = "disabled" in element && Boolean((element as HTMLElement & { disabled?: boolean }).disabled);
    const hiddenInput = element instanceof HTMLInputElement && element.type === "hidden";
    return !disabled
      && !hiddenInput
      && element.tabIndex >= 0
      && element.getAttribute("aria-hidden") !== "true"
      && !element.closest("[hidden]");
  });
}

function trapDialogKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  pending: boolean,
  onClose: () => void
) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();

    if (!pending) {
      onClose();
    }
    return;
  }

  if (event.key !== "Tab") {
    return;
  }

  const focusable = focusableDialogElements(event.currentTarget);
  const first = focusable[0];
  const last = focusable.at(-1);

  if (!first || !last) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function LibraryCaptureDialog({
  busy,
  draft,
  error,
  importing,
  onChange,
  onClose,
  onImport,
  onSubmit
}: {
  busy: boolean;
  draft: CaptureDraft;
  error: string | null;
  importing: boolean;
  onChange: (draft: CaptureDraft) => void;
  onClose: () => void;
  onImport: (input: string) => boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const importInputId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const initiallyImporting = useRef(importing);
  const [importInput, setImportInput] = useState("");
  const interactionBusy = busy || importing;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (initiallyImporting.current) {
      dialogRef.current?.focus({ preventScroll: true });
    } else {
      firstInputRef.current?.focus({ preventScroll: true });
    }

    return () => {
      window.setTimeout(() => previousFocus?.isConnected && previousFocus.focus({ preventScroll: true }), 0);
    };
  }, []); // The import transition is handled below without replacing the original return-focus target.

  useLayoutEffect(() => {
    if (!importing) {
      firstInputRef.current?.focus({ preventScroll: true });
    }
  }, [importing]);

  return createPortal(
    <div
      className="modal-backdrop library-capture-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !interactionBusy) {
          onClose();
        }
      }}
    >
      <section
        aria-busy={interactionBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="library-capture-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={(event) => trapDialogKeyboard(event, interactionBusy, onClose)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="library-capture-icon" aria-hidden="true">
            <Plus size={20} />
          </span>
          <div>
            <p>새 자료</p>
            <h2 id={titleId}>링크나 클립 저장</h2>
          </div>
          <button aria-label="자료 저장 창 닫기" className="icon-button" disabled={interactionBusy} onClick={onClose} type="button">
            <X size={17} />
          </button>
        </header>
        <p className="library-capture-description" id={descriptionId}>
          제목, URL, 태그, 본문은 저장 전 이 기기에서 암호화됩니다.
        </p>
        {importing && (
          <p className="library-capture-source" role="status">
            <Loader2 aria-hidden="true" className="spin" size={15} />
            Chrome 확장 프로그램에서 캡처 내용을 가져오는 중입니다.
          </p>
        )}
        {draft.captureSource !== "manual" && (
          <p className="library-capture-source" role="status">
            {draft.captureSource === "browser-extension" ? "Chrome 확장 프로그램" : "북마클릿"}에서 가져왔습니다.
            내용을 확인한 뒤 ‘자료 저장’을 눌러야 저장됩니다.
          </p>
        )}
        {error && <p className="library-capture-error" role="alert">{error}</p>}
        <form onSubmit={onSubmit}>
          <details className="library-capture-import">
            <summary>Safari 또는 북마클릿에서 가져오기</summary>
            <p>URL, 일반 텍스트 또는 QuickMemo 북마클릿 JSON을 붙여넣으세요.</p>
            <a className="library-capture-extension-download" download href="/quickmemo-capture-extension.zip">
              <Download aria-hidden="true" size={15} />
              Chrome용 캡처 확장 프로그램 받기 (ZIP)
            </a>
            <label htmlFor={importInputId}>캡처 데이터</label>
            <textarea
              disabled={interactionBusy}
              id={importInputId}
              maxLength={524_288}
              onChange={(event) => setImportInput(event.target.value)}
              placeholder="https://example.com 또는 캡처한 텍스트/JSON"
              rows={4}
              spellCheck={false}
              value={importInput}
            />
            <button
              className="secondary-button"
              disabled={interactionBusy || !importInput.trim()}
              onClick={() => {
                if (onImport(importInput)) {
                  setImportInput("");
                }
              }}
              type="button"
            >
              내용 가져오기
            </button>
          </details>
          <fieldset className="library-capture-kind">
            <legend>자료 종류</legend>
            <label className={draft.kind === "link" ? "active" : ""}>
              <input
                checked={draft.kind === "link"}
                disabled={interactionBusy}
                name="library-kind"
                onChange={() => onChange({ ...draft, kind: "link" })}
                type="radio"
              />
              <Link2 size={16} />
              링크
            </label>
            <label className={draft.kind === "clip" ? "active" : ""}>
              <input
                checked={draft.kind === "clip"}
                disabled={interactionBusy}
                name="library-kind"
                onChange={() => onChange({ ...draft, kind: "clip" })}
                type="radio"
              />
              <FileText size={16} />
              클립
            </label>
          </fieldset>
          <div className="library-capture-grid">
            <label className="wide">
              제목
              <input
                disabled={interactionBusy}
                maxLength={240}
                onChange={(event) => onChange({ ...draft, title: event.target.value })}
                placeholder="다시 찾기 쉬운 제목"
                ref={firstInputRef}
                required
                value={draft.title}
              />
            </label>
            <label className="wide">
              URL {draft.kind === "clip" && <small>(선택)</small>}
              <input
                autoCapitalize="none"
                autoCorrect="off"
                disabled={interactionBusy}
                inputMode="url"
                maxLength={4096}
                onChange={(event) => onChange({ ...draft, url: event.target.value })}
                placeholder="https://example.com/article"
                required={draft.kind === "link"}
                spellCheck={false}
                type="url"
                value={draft.url}
              />
            </label>
            <label>
              컬렉션
              <input
                disabled={interactionBusy}
                maxLength={80}
                onChange={(event) => onChange({ ...draft, collection: event.target.value })}
                placeholder="예: 업무 참고"
                value={draft.collection}
              />
            </label>
            <label>
              태그
              <input
                disabled={interactionBusy}
                onChange={(event) => onChange({ ...draft, tags: event.target.value })}
                placeholder="보안, 클라우드, 리뷰"
                value={draft.tags}
              />
            </label>
            <label className="wide">
              메모
              <textarea
                disabled={interactionBusy}
                maxLength={4000}
                onChange={(event) => onChange({ ...draft, description: event.target.value })}
                placeholder="저장하는 이유나 확인할 점"
                rows={3}
                value={draft.description}
              />
            </label>
            <label className="wide">
              선택 텍스트 <small>(선택)</small>
              <textarea
                disabled={interactionBusy}
                maxLength={20_000}
                onChange={(event) => onChange({ ...draft, selectionText: event.target.value })}
                placeholder="웹페이지에서 선택해둔 핵심 문장"
                rows={3}
                value={draft.selectionText}
              />
            </label>
            <label className="wide">
              리더 본문 <small>(선택)</small>
              <textarea
                disabled={interactionBusy}
                maxLength={180_000}
                onChange={(event) => onChange({ ...draft, readerBlocks: [], readerText: event.target.value })}
                placeholder="본문을 단락별로 붙여넣으면 선택 하이라이트를 사용할 수 있습니다."
                rows={7}
                value={draft.readerText}
              />
            </label>
          </div>
          <footer>
            <button className="secondary-button" disabled={interactionBusy} onClick={onClose} type="button">취소</button>
            <button disabled={interactionBusy} type="submit">
              {busy ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}
              {busy ? "암호화해 저장 중..." : "자료 저장"}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body
  );
}

function LibraryDeleteConfirmDialog({
  error,
  onCancel,
  onConfirm,
  onRestoreFocus,
  pending,
  target
}: {
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onRestoreFocus: () => void;
  pending: boolean;
  target: DeleteTarget;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const targetId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    cancelButtonRef.current?.focus({ preventScroll: true });

    return () => {
      window.setTimeout(onRestoreFocus, 0);
    };
  }, [onRestoreFocus]);

  return createPortal(
    <div
      className="modal-backdrop schedule-delete-confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();

        if (event.target === event.currentTarget && !pending) {
          onCancel();
        }
      }}
    >
      <section
        aria-busy={pending}
        aria-describedby={`${descriptionId} ${targetId}`}
        aria-labelledby={titleId}
        aria-modal="true"
        className="schedule-delete-confirm-modal"
        role="alertdialog"
        tabIndex={-1}
        onKeyDown={(event) => trapDialogKeyboard(event, pending, onCancel)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="schedule-delete-confirm-header">
          <span className="schedule-delete-confirm-icon" aria-hidden="true">
            <Trash2 size={21} strokeWidth={2.2} />
          </span>
          <div>
            <p className="schedule-delete-confirm-kicker">삭제 확인</p>
            <h2 id={titleId}>이 자료를 삭제할까요?</h2>
          </div>
          <button
            aria-label="삭제 확인 닫기"
            className="icon-button schedule-delete-confirm-close"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            <X size={18} />
          </button>
        </header>
        <p className="schedule-delete-confirm-description" id={descriptionId}>
          자료실의 링크, 메모, 하이라이트가 영구적으로 삭제됩니다. 원본 노트 첨부파일은 삭제하지 않습니다.
        </p>
        <div className="schedule-delete-confirm-target" id={targetId}>
          <LibraryBig aria-hidden="true" size={18} />
          <div>
            <span>삭제할 자료</span>
            <strong>{target.title}</strong>
          </div>
        </div>
        {error && <p className="schedule-delete-confirm-error" role="alert">{error}</p>}
        <footer className="schedule-delete-confirm-actions">
          <button className="secondary-button" disabled={pending} onClick={onCancel} ref={cancelButtonRef} type="button">취소</button>
          <button className="schedule-delete-confirm-submit" disabled={pending} onClick={onConfirm} type="button">
            {pending ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
            {pending ? "삭제 중..." : "삭제"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
