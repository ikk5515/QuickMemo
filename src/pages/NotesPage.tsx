import {
  ArrowUpDown,
  CalendarClock,
  CheckCircle2,
  Download,
  Eye,
  File,
  FilePlus2,
  FolderOpen,
  History,
  ListChecks,
  Loader2,
  PanelRightOpen,
  Pencil,
  RotateCcw,
  Save,
  Share2,
  Star,
  Trash2,
  UsersRound,
  X
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Timestamp } from "firebase/firestore";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import {
  attachmentDownloadName,
  attachmentExtension,
  attachmentValidationError,
  formatFileSize,
  maxAttachmentFileBytes,
  safeAttachmentBaseName
} from "../lib/attachments";
import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  generateNoteKey,
  unwrapNoteKey,
  wrapNoteKey
} from "../lib/crypto";
import {
  imageHtml,
  linkifyEditorHtml,
  parseEditorContent,
  previewTextFromHtml,
  sanitizeEditorHtml,
  serializeEditorContent
} from "../lib/editorContent";
import { publishActiveNote, subscribeActiveNote } from "../services/activeNotes";
import {
  confirmNoteRead,
  createNoteAttachment,
  deleteNoteAttachment,
  createEncryptedNote,
  deleteNote,
  markNoteRead,
  purgeNote,
  publishNoteCursor,
  restoreNote,
  setNotePinned,
  subscribeNoteAttachments,
  subscribeDeletedNotes,
  subscribeMyNoteStates,
  subscribeNoteHistory,
  subscribeNoteUserStates,
  subscribeVisibleNotes,
  updateEncryptedNote,
  updateNoteAccess,
  updateNoteDeadline,
  type NoteHistorySnapshot,
  type NoteAttachmentSnapshot,
  type NoteUserStateSnapshot,
  type NoteSnapshot
} from "../services/notes";
import { subscribeUsers } from "../services/users";
import type { ActiveNoteDocument, DecryptedNote, NoteKind, UserProfile } from "../types";

interface EditorState {
  noteId: string | null;
  title: string;
  body: string;
  type: NoteKind;
  participantUids: string[];
  noteKey: CryptoKey | null;
  fontSize: number;
  dueAt: Date | null;
  dirty: boolean;
}

interface NoteDraft {
  title: string;
  body: string;
  fontSize: number;
}

interface PdfPreviewState {
  fileName: string;
  url: string;
}

const blankEditor = (uid: string): EditorState => ({
  noteId: null,
  title: "",
  body: "",
  type: "personal",
  participantUids: [uid],
  noteKey: null,
  fontSize: 17,
  dueAt: null,
  dirty: false
});

type NoteSortField = "createdAt" | "dueAt";
type NoteSortDirection = "asc" | "desc";
type NoteListFilter = "all" | NoteKind;

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

const fontSizes = [14, 16, 17, 18, 20, 22, 24, 28];
const imageWidthOptions = [25, 50, 75, 100];
const maxImageDataUrlLength = 760_000;
const autosaveDelayMs = 450;
const deletedNoteRetentionDays = 30;
const historySummaryMaxLength = 420;
const cursorPublishDelayMs = 220;
const remoteCursorFreshMs = 15_000;
const activeNoteClientStorageKey = "quickmemo-active-note-client-id";
const noteSortStoragePrefix = "quickmemo-note-sort:";
const noteFilterStoragePrefix = "quickmemo-note-filter:";
const defaultNoteSort: NoteSortSetting = { field: "createdAt", direction: "desc" };
const defaultNoteFilter: NoteListFilter = "all";

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

function clippedText(value: string, maxLength = historySummaryMaxLength) {
  const normalizedValue = value.replace(/\s+/g, " ").trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1).trim()}...`;
}

function historySummaryFromDraft(draft: NoteDraft) {
  const title = clippedText(draft.title || "제목 없음", 120);
  const body = clippedText(previewTextFromHtml(draft.body) || (/<img\b/i.test(draft.body) ? "이미지 포함" : "내용 없음"));

  return `제목: ${title}\n내용: ${body}`;
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

function timestampsEqual(left: Date | null, right: Date | null) {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

function nextParticipantList(currentParticipantUids: string[], selectedUid: string, checked: boolean, ownerUid: string) {
  const participantUids = checked
    ? Array.from(new Set([...currentParticipantUids, selectedUid, ownerUid]))
    : currentParticipantUids.filter((participantUid) => participantUid !== selectedUid || participantUid === ownerUid);

  return Array.from(new Set([ownerUid, ...participantUids]));
}

function noteTimestampMillis(note: DecryptedNote, field: NoteSortField) {
  const timestamp = field === "createdAt" ? note.createdAt : note.dueAt;

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

function filterNotes(notes: DecryptedNote[], filter: NoteListFilter) {
  return filter === "all" ? notes : notes.filter((note) => note.type === filter);
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
      (parsed.field === "createdAt" || parsed.field === "dueAt") &&
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

function noteSyncSignature(note: DecryptedNote) {
  const updatedAt = note.updatedAt ? `${note.updatedAt.seconds}:${note.updatedAt.nanoseconds}` : "pending";

  return [
    note.id,
    updatedAt,
    note.updatedBy,
    note.encryptedTitle.iv,
    note.encryptedTitle.cipherText,
    note.encryptedBody.iv,
    note.encryptedBody.cipherText
  ].join(":");
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

function deadlineDDay(date: Date | null) {
  if (!date) {
    return null;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((startOfLocalDay(date) - startOfLocalDay(new Date())) / dayMs);

  if (diffDays === 0) {
    return "D-Day";
  }

  return diffDays > 0 ? `D-${diffDays}` : `D+${Math.abs(diffDays)}`;
}

function deadlineTone(date: Date | null) {
  if (!date) {
    return "none";
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((startOfLocalDay(date) - startOfLocalDay(new Date())) / dayMs);

  if (diffDays < 0) {
    return "overdue";
  }

  if (diffDays === 0) {
    return "today";
  }

  if (diffDays <= 3) {
    return "soon";
  }

  return "upcoming";
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
  const labels: Record<NoteHistorySnapshot["action"], string> = {
    create: "생성",
    content: "내용 수정",
    deadline: "마감일 변경",
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
    dueAt: "마감일",
    participants: "공유 대상",
    deleted: "삭제 상태",
    restored: "복구 상태"
  };

  return labels[field] ?? field;
}

function toDateTimeLocalValue(date: Date | null) {
  if (!date) {
    return "";
  }

  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

async function decryptNoteSnapshots(notes: NoteSnapshot[], uid: string, privateKey: CryptoKey) {
  const nextNotes = await Promise.all(
    notes.map(async (note) => {
      const wrappedKey = note.wrappedKeys[uid];

      if (!wrappedKey) {
        return null;
      }

      try {
        const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
        const [title, body] = await Promise.all([
          decryptText(note.encryptedTitle, noteKey),
          decryptText(note.encryptedBody, noteKey)
        ]);
        return { ...note, title, body } satisfies DecryptedNote;
      } catch {
        return {
          ...note,
          title: "복호화할 수 없는 노트",
          body: "비밀번호 초기화 또는 공유 키 변경으로 이 기기에서 열 수 없습니다."
        } satisfies DecryptedNote;
      }
    })
  );

  return nextNotes.filter((note): note is DecryptedNote => Boolean(note));
}

export default function NotesPage() {
  const { profile, privateKey } = useAuth();
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [deletedNotes, setDeletedNotes] = useState<NoteSnapshot[]>([]);
  const [decryptedNotes, setDecryptedNotes] = useState<DecryptedNote[]>([]);
  const [decryptedDeletedNotes, setDecryptedDeletedNotes] = useState<DecryptedNote[]>([]);
  const [noteStateMap, setNoteStateMap] = useState<NoteStateByNoteId>({});
  const [activeCursorStates, setActiveCursorStates] = useState<NoteUserStateSnapshot[]>([]);
  const [cursorClock, setCursorClock] = useState(() => Date.now());
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [activeNote, setActiveNote] = useState<ActiveNoteDocument | null>(null);
  const [editor, setEditor] = useState<EditorState>(() => blankEditor(profile?.uid ?? ""));
  const [status, setStatus] = useState("준비됨");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attachmentBusyId, setAttachmentBusyId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<NoteAttachmentSnapshot[]>([]);
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [noteSort, setNoteSort] = useState<NoteSortSetting>(defaultNoteSort);
  const [noteFilter, setNoteFilter] = useState<NoteListFilter>(defaultNoteFilter);
  const autosaveTimer = useRef<number | null>(null);
  const cursorPublishTimer = useRef<number | null>(null);
  const lastPublishedCursor = useRef<string | null>(null);
  const memoEditorRef = useRef<HTMLDivElement | null>(null);
  const pendingLocalEcho = useRef<{ noteId: string; draft: NoteDraft; createdAt: number } | null>(null);
  const appliedRemoteRevision = useRef<{ noteId: string; signature: string } | null>(null);
  const activeNoteClientId = useRef(getActiveNoteClientId());
  const pdfPreviewUrl = useRef<string | null>(null);
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

  useEffect(() => {
    if (!profile) {
      return undefined;
    }

    return subscribeVisibleNotes(profile.uid, profile.isAdmin ? null : visibleNoteOwnerUids, setNotes, () =>
      setError("노트 목록을 불러오지 못했습니다.")
    );
  }, [profile, visibleNoteOwnerUids]);

  useEffect(() => {
    if (!profile) {
      setDeletedNotes([]);
      return undefined;
    }

    return subscribeDeletedNotes(profile.uid, profile.isAdmin ? null : visibleNoteOwnerUids, setDeletedNotes, () =>
      setError("복구함을 불러오지 못했습니다.")
    );
  }, [profile, visibleNoteOwnerUids]);

  useEffect(() => {
    if (!profile) {
      setActiveNote(null);
      return undefined;
    }

    return subscribeActiveNote(profile.uid, setActiveNote, () => setError("활성 노트 상태를 불러오지 못했습니다."));
  }, [profile]);

  useEffect(() => {
    return subscribeUsers(setUsers, () => setError("사용자 목록을 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    return () => {
      if (pdfPreviewUrl.current) {
        URL.revokeObjectURL(pdfPreviewUrl.current);
        pdfPreviewUrl.current = null;
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
    if (!editor.noteId) {
      setAttachments([]);
      return undefined;
    }

    return subscribeNoteAttachments(editor.noteId, setAttachments, () => setError("첨부파일 목록을 불러오지 못했습니다."));
  }, [editor.noteId]);

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

    if (!currentProfile || !currentPrivateKey) {
      setDecryptedNotes([]);
      return;
    }

    const safeProfile = currentProfile;
    const safePrivateKey = currentPrivateKey;
    let cancelled = false;

    async function decryptNotes() {
      const nextNotes = await decryptNoteSnapshots(notes, safeProfile.uid, safePrivateKey);

      if (!cancelled) {
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

    if (!currentProfile || !currentPrivateKey) {
      setDecryptedDeletedNotes([]);
      return;
    }

    const safeProfile = currentProfile;
    const safePrivateKey = currentPrivateKey;
    let cancelled = false;

    async function decryptNotes() {
      const nextNotes = await decryptNoteSnapshots(deletedNotes, safeProfile.uid, safePrivateKey);

      if (!cancelled) {
        setDecryptedDeletedNotes(nextNotes);
      }
    }

    void decryptNotes();
    return () => {
      cancelled = true;
    };
  }, [deletedNotes, privateKey, profile]);

  useEffect(() => {
    if (!profile) {
      setNoteStateMap({});
      return undefined;
    }

    const noteIds = [...decryptedNotes, ...decryptedDeletedNotes].map((note) => note.id);
    return subscribeMyNoteStates(profile.uid, noteIds, setNoteStateMap, () =>
      setError("노트 개인 상태를 불러오지 못했습니다.")
    );
  }, [decryptedDeletedNotes, decryptedNotes, profile]);

  useEffect(() => {
    const draft = {
      title: editor.title,
      body: editor.body,
      fontSize: editor.fontSize
    };

    if (!editor.dirty || !profile || saving || (!editor.noteId && !draftHasContent(draft))) {
      return undefined;
    }

    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }

    autosaveTimer.current = window.setTimeout(() => {
      void saveCurrentNote(false);
    }, autosaveDelayMs);

    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
    // saveCurrentNote reads the current render state; adding it here restarts the debounce on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editor.title,
    editor.body,
    editor.fontSize,
    editor.dueAt,
    editor.participantUids,
    editor.dirty,
    editor.noteId,
    editor.noteKey,
    profile,
    saving
  ]);

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
  const noteCounts = useMemo(
    () => {
      const counts: NoteListCounts = { all: 0, personal: 0, shared: 0 };

      decryptedNotes.forEach((note) => {
        counts.all += 1;
        counts[note.type] += 1;
      });

      return counts;
    },
    [decryptedNotes]
  );
  const visibleNotes = useMemo(
    () => sortNotes(filterNotes(decryptedNotes, noteFilter), noteSort, noteStateMap),
    [decryptedNotes, noteFilter, noteSort, noteStateMap]
  );
  const trashNotes = useMemo(
    () => sortDeletedNotes(filterNotes(decryptedDeletedNotes, noteFilter)),
    [decryptedDeletedNotes, noteFilter]
  );
  const activeRemoteNote = useMemo(
    () => decryptedNotes.find((note) => note.id === editor.noteId) ?? null,
    [decryptedNotes, editor.noteId]
  );
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
        return Boolean(cursorUpdatedAt && cursorClock - cursorUpdatedAt.getTime() <= remoteCursorFreshMs);
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
    if (!activeCursorNoteId) {
      setActiveCursorStates([]);
      return undefined;
    }

    return subscribeNoteUserStates(activeCursorNoteId, setActiveCursorStates, () =>
      setError("공유 노트 커서 상태를 불러오지 못했습니다.")
    );
  }, [activeCursorNoteId]);

  useEffect(() => {
    if (!activeCursorNoteId) {
      return undefined;
    }

    const intervalId = window.setInterval(() => setCursorClock(Date.now()), 5000);
    return () => window.clearInterval(intervalId);
  }, [activeCursorNoteId]);

  useEffect(() => {
    if (!activeRemoteNote || !profile) {
      return;
    }

    const remoteDraft = draftFromNote(activeRemoteNote);
    const remoteDueAt = dateFromTimestamp(activeRemoteNote.dueAt);
    const remoteSignature = noteSyncSignature(activeRemoteNote);
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
      timestampsEqual(editor.dueAt, remoteDueAt) &&
      editor.type === activeRemoteNote.type &&
      editor.participantUids.join("|") === activeRemoteNote.participantUids.join("|");

    if (contentMatches && metadataMatches) {
      if (pendingEcho?.noteId === activeRemoteNote.id && noteDraftsMatch(remoteDraft, pendingEcho.draft)) {
        pendingLocalEcho.current = null;
      }

      appliedRemoteRevision.current = { noteId: activeRemoteNote.id, signature: remoteSignature };
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

      if (noteDraftsMatch(currentDraft, pendingEcho.draft)) {
        pendingLocalEcho.current = null;
      }

      return;
    }

    if (editor.dirty && !contentMatches) {
      return;
    }

    appliedRemoteRevision.current = { noteId: activeRemoteNote.id, signature: remoteSignature };
    setEditor((current) => ({
      ...current,
      title: remoteDraft.title,
      body: remoteDraft.body,
      type: activeRemoteNote.type,
      participantUids: activeRemoteNote.participantUids,
      fontSize: remoteDraft.fontSize,
      dueAt: remoteDueAt,
      dirty: contentMatches ? current.dirty : false
    }));
    setStatus(activeRemoteNote.type === "shared" ? "공유 노트 변경 사항을 반영했습니다." : "다른 기기 변경 사항을 반영했습니다.");
  }, [
    activeRemoteNote,
    editor,
    editor.body,
    editor.dueAt,
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
    if (!previewNoteId) {
      return undefined;
    }

    function handlePreviewCancel(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setPreviewNoteId(null);
    }

    window.addEventListener("keydown", handlePreviewCancel);
    return () => window.removeEventListener("keydown", handlePreviewCancel);
  }, [previewNoteId]);

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
  const deadlineLabel = editor.dueAt ? formatFullDateTime(editor.dueAt) : "마감일 없음";
  const deadlineDday = deadlineDDay(editor.dueAt);
  const currentDeadlineTone = deadlineTone(editor.dueAt);
  const activeNotePinned = activeRemoteNote ? notePinned(activeRemoteNote.id, noteStateMap) : false;

  function announceActiveNote(noteId: string | null) {
    void publishActiveNote(unlockedProfile.uid, noteId, activeNoteClientId.current).catch(() => {
      setError("현재 노트 상태를 다른 기기에 알리지 못했습니다.");
    });
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

  function updateFontSize(fontSize: number) {
    setEditor((current) => ({ ...current, fontSize, dirty: true }));
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

  function updateDeadline(value: string) {
    const dueAt = value ? new Date(value) : null;
    const noteId = editor.noteId;

    setEditor((current) => ({
      ...current,
      dueAt,
      dirty: current.noteId ? current.dirty : true
    }));

    if (!noteId) {
      setStatus(dueAt ? "마감일을 선택했습니다." : "마감일을 해제했습니다.");
      return;
    }

    void saveDeadline(noteId, dueAt);
  }

  async function saveDeadline(noteId: string, dueAt: Date | null) {
    setSaving(true);
    setError(null);

    try {
      await updateNoteDeadline(noteId, unlockedProfile.uid, dueAt ? Timestamp.fromDate(dueAt) : null);
      setStatus(dueAt ? "마감일을 저장했습니다." : "마감일을 해제했습니다.");
    } catch {
      setError("마감일을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
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

    try {
      const noteKey = await unwrapNoteKey(rawNote.wrappedKeys[unlockedProfile.uid], unlockedPrivateKey);
      const nextDraft = draftOverride ?? draftFromNote(note);

      if (editor.noteId && editor.noteId !== note.id) {
        clearEditorCursor();
      }

      appliedRemoteRevision.current = { noteId: note.id, signature: noteSyncSignature(note) };
      setEditor({
        noteId: note.id,
        title: nextDraft.title,
        body: nextDraft.body,
        type: note.type,
        participantUids: note.participantUids,
        noteKey,
        fontSize: nextDraft.fontSize,
        dueAt: dateFromTimestamp(note.dueAt),
        dirty: false
      });
      setListOpen(false);
      setShareOpen(false);
      setPreviewNoteId(null);
      setStatus("노트를 열었습니다.");
      setError(null);
      void markNoteRead(note.id, unlockedProfile.uid).catch(() => undefined);

      if (shouldAnnounce) {
        announceActiveNote(note.id);
      }
    } catch {
      setError("이 노트를 열 수 없습니다.");
    }
  }

  function startNewNote() {
    clearEditorCursor();
    setEditor(blankEditor(unlockedProfile.uid));
    setShareOpen(false);
    setDeadlineOpen(false);
    setStatus("새 노트 작성 중");
    setError(null);
    announceActiveNote(null);
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
      dirty: current.noteId ? current.dirty : true
    }));

    if (editor.noteId && editor.noteKey) {
      void updateCurrentNoteAccess(editor.noteId, editor.noteKey, participantUids, previousParticipantUids);
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
    participantUids: string[],
    previousParticipantUids: string[]
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
      await updateNoteAccess(noteId, unlockedProfile.uid, type, participantUids, wrappedKeys);
      setStatus(type === "shared" ? "공유 대상을 저장했습니다." : "개인 노트로 변경했습니다.");
    } catch {
      setEditor((current) =>
        current.noteId === noteId
          ? {
              ...current,
              participantUids: previousParticipantUids,
              type: noteTypeFromParticipants(previousParticipantUids)
            }
          : current
      );
      setError("공유 대상을 변경하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function persistCurrentNote(showSavedMessage = true): Promise<{ noteId: string; noteKey: CryptoKey } | null> {
    if (saving) {
      return null;
    }

    const draft = {
      title: editor.title,
      body: editor.body,
      fontSize: editor.fontSize
    };

    setSaving(true);
    setError(null);

    try {
      if (editor.noteId && editor.noteKey) {
        const payload = await encryptNoteDraft(draft, editor.noteKey);
        const historySummary = await encryptText(historySummaryFromDraft(draft), editor.noteKey);
        await updateEncryptedNote(
          editor.noteId,
          unlockedProfile.uid,
          payload.encryptedTitle,
          payload.encryptedBody,
          changedDraftFields(activeRemoteNote ? draftFromNote(activeRemoteNote) : null, draft),
          historySummary
        );
        pendingLocalEcho.current = { noteId: editor.noteId, draft, createdAt: Date.now() };
        announceActiveNote(editor.noteId);
        setEditor((current) => (draftsMatch(current, draft) ? { ...current, dirty: false } : current));
        setStatus(showSavedMessage ? "변경 사항을 저장했습니다." : "자동 저장됨");
        return { noteId: editor.noteId, noteKey: editor.noteKey };
      }

      const noteKey = await generateNoteKey();
      const payload = await encryptNoteDraft(draft, noteKey);
      const historySummary = await encryptText(historySummaryFromDraft(draft), noteKey);
      const participantUids = Array.from(new Set([unlockedProfile.uid, ...editor.participantUids])).filter(
        (uid) => uid === unlockedProfile.uid || canShareWithUser(uid)
      );
      const wrappedKeys = await wrappedKeysForParticipants(noteKey, participantUids);
      const type = noteTypeFromParticipants(participantUids);

      const created = await createEncryptedNote({
        type,
        ownerUid: unlockedProfile.uid,
        participantUids,
        encryptedTitle: payload.encryptedTitle,
        encryptedBody: payload.encryptedBody,
        wrappedKeys,
        dueAt: editor.dueAt ? Timestamp.fromDate(editor.dueAt) : null,
        historySummary
      });
      pendingLocalEcho.current = { noteId: created.id, draft, createdAt: Date.now() };

      setEditor((current) => ({
        ...current,
        noteId: created.id,
        noteKey,
        type,
        dirty: !draftsMatch(current, draft)
      }));
      announceActiveNote(created.id);
      setStatus(showSavedMessage ? "노트를 저장 목록에 추가했습니다." : "자동 저장됨");
      return { noteId: created.id, noteKey };
    } catch {
      setError("노트를 저장하지 못했습니다.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveCurrentNote(showSavedMessage = true) {
    await persistCurrentNote(showSavedMessage);
  }

  async function ensureCurrentNoteForAttachment() {
    if (editor.noteId && editor.noteKey) {
      return { noteId: editor.noteId, noteKey: editor.noteKey };
    }

    const savedNote = await persistCurrentNote(false);

    if (!savedNote) {
      throw new Error("노트를 먼저 저장하지 못했습니다.");
    }

    return savedNote;
  }

  async function insertPastedFiles(files: File[], range: Range | null = null) {
    const attachmentFiles: File[] = [];
    let imageRange = range;

    for (const file of files) {
      if (file.type.startsWith("image/")) {
        await insertImageFile(file, imageRange);
        imageRange = null;
      } else {
        attachmentFiles.push(file);
      }
    }

    if (attachmentFiles.length) {
      await uploadAttachmentFiles(attachmentFiles);
    }
  }

  async function uploadAttachmentFiles(files: File[], targetNote?: { noteId: string; noteKey: CryptoKey }) {
    const validFiles: File[] = [];
    const rejectedFiles: string[] = [];

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

    setAttachmentBusyId("upload");
    setError(null);

    try {
      const noteTarget = targetNote ?? (await ensureCurrentNoteForAttachment());

      for (const file of validFiles) {
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        const encryptedFile = await encryptBytes(fileBytes, noteTarget.noteKey);
        await createNoteAttachment({
          noteId: noteTarget.noteId,
          fileName: safeAttachmentBaseName(file.name),
          extension: attachmentExtension(file.name),
          mimeType: (file.type || "application/octet-stream").slice(0, 120),
          originalSize: file.size,
          encryptedData: encryptedFile.cipherBytes,
          iv: encryptedFile.iv,
          uploadedBy: unlockedProfile.uid
        });
      }

      setStatus(
        validFiles.length === 1
          ? `첨부파일을 업로드했습니다. 최대 ${formatFileSize(maxAttachmentFileBytes)}까지 가능합니다.`
          : `첨부파일 ${validFiles.length}개를 업로드했습니다.`
      );

      if (rejectedFiles.length) {
        setError(`일부 파일은 제외했습니다. ${rejectedFiles[0]}`);
      }
    } catch {
      setError("첨부파일을 업로드하지 못했습니다.");
    } finally {
      setAttachmentBusyId(null);
    }
  }

  async function noteKeyForDownload(noteId: string) {
    return resolveNoteKey(noteId);
  }

  async function decryptAttachmentFile(noteId: string, attachment: NoteAttachmentSnapshot) {
    const noteKey = await noteKeyForDownload(noteId);
    return decryptBytes(
      {
        version: 1,
        algorithm: "AES-GCM",
        cipherBytes: attachment.encryptedData.toUint8Array(),
        iv: attachment.iv.toUint8Array()
      },
      noteKey
    );
  }

  function closePdfPreview() {
    if (pdfPreviewUrl.current) {
      URL.revokeObjectURL(pdfPreviewUrl.current);
      pdfPreviewUrl.current = null;
    }

    setPdfPreview(null);
  }

  async function previewPdfAttachment(noteId: string, attachment: NoteAttachmentSnapshot) {
    if (attachment.extension !== "pdf") {
      setError("PDF 파일만 미리보기할 수 있습니다.");
      return;
    }

    setAttachmentBusyId(attachment.id);
    setError(null);

    try {
      const plainBytes = await decryptAttachmentFile(noteId, attachment);
      const blob = new Blob([plainBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      if (pdfPreviewUrl.current) {
        URL.revokeObjectURL(pdfPreviewUrl.current);
      }

      pdfPreviewUrl.current = url;
      setPdfPreview({ fileName: attachmentDownloadName(attachment), url });
      setStatus("PDF 미리보기를 열었습니다.");
    } catch {
      setError("PDF 미리보기를 열지 못했습니다.");
    } finally {
      setAttachmentBusyId(null);
    }
  }

  async function downloadAttachment(noteId: string, attachment: NoteAttachmentSnapshot) {
    setAttachmentBusyId(attachment.id);
    setError(null);

    try {
      const plainBytes = await decryptAttachmentFile(noteId, attachment);
      const blob = new Blob([plainBytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachmentDownloadName(attachment);
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus("첨부파일 다운로드를 시작했습니다.");
    } catch {
      setError("첨부파일을 다운로드하지 못했습니다.");
    } finally {
      setAttachmentBusyId(null);
    }
  }

  async function uploadPreviewAttachments(note: DecryptedNote, files: File[]) {
    try {
      const noteKey = await noteKeyForDownload(note.id);
      await uploadAttachmentFiles(files, { noteId: note.id, noteKey });
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
      return;
    }

    setAttachmentBusyId(attachment.id);
    setError(null);

    try {
      await deleteNoteAttachment(note.id, attachment.id);
      setStatus("첨부파일을 삭제했습니다.");
    } catch {
      setError("첨부파일을 삭제하지 못했습니다.");
    } finally {
      setAttachmentBusyId(null);
    }
  }

  async function removeCurrentNote() {
    if (!editor.noteId) {
      startNewNote();
      return;
    }

    if (!activeRemoteNote || !canDeleteNote(activeRemoteNote)) {
      setError("노트 소유자 또는 참여 중인 관리자만 삭제할 수 있습니다.");
      return;
    }

    setSaving(true);

    try {
      await deleteNote(editor.noteId, unlockedProfile.uid);
      startNewNote();
      setStatus("노트를 삭제했습니다.");
    } catch {
      setError("노트를 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function removePreviewNote(note: DecryptedNote) {
    if (!canDeleteNote(note)) {
      setError("노트 소유자 또는 참여 중인 관리자만 삭제할 수 있습니다.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await deleteNote(note.id, unlockedProfile.uid);
      setPreviewNoteId(null);

      if (editor.noteId === note.id) {
        startNewNote();
      }

      setStatus("노트를 삭제했습니다.");
    } catch {
      setError("노트를 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function restorePreviewNote(note: DecryptedNote) {
    if (!canRestoreNote(note)) {
      setError("노트 소유자 또는 관리자만 복구할 수 있습니다.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await restoreNote(note.id, unlockedProfile.uid);
      setPreviewNoteId(null);
      setStatus("노트를 복구했습니다.");
    } catch {
      setError("노트를 복구하지 못했습니다.");
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

    const rawNote = [...notes, ...deletedNotes].find((current) => current.id === note.id);
    const wrappedKey = rawNote?.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("즉시 삭제에 필요한 노트 키를 찾지 못했습니다.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const noteKey = await resolveNoteKey(note.id);
      const redactedPayload = await encryptNoteDraft(purgedDraft(), noteKey);

      await purgeNote({
        noteId: note.id,
        uid: unlockedProfile.uid,
        encryptedTitle: redactedPayload.encryptedTitle,
        encryptedBody: redactedPayload.encryptedBody,
        wrappedKey
      });

      setPreviewNoteId(null);

      if (editor.noteId === note.id) {
        startNewNote();
      }

      setStatus("노트를 즉시 삭제했습니다.");
    } catch {
      setError("노트를 즉시 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function savePreviewNote(note: DecryptedNote, draft: NoteDraft) {
    if (saving) {
      return false;
    }

    const rawNote = notes.find((current) => current.id === note.id);

    if (!rawNote) {
      setError("이 노트를 저장할 수 없습니다.");
      return false;
    }

    setSaving(true);
    setError(null);

    try {
      const noteKey = await unwrapNoteKey(rawNote.wrappedKeys[unlockedProfile.uid], unlockedPrivateKey);
      const payload = await encryptNoteDraft(draft, noteKey);
      const historySummary = await encryptText(historySummaryFromDraft(draft), noteKey);

      await updateEncryptedNote(
        note.id,
        unlockedProfile.uid,
        payload.encryptedTitle,
        payload.encryptedBody,
        changedDraftFields(draftFromNote(note), draft),
        historySummary
      );
      pendingLocalEcho.current = { noteId: note.id, draft, createdAt: Date.now() };
      announceActiveNote(note.id);

      if (editor.noteId === note.id) {
        setEditor((current) => ({
          ...current,
          title: draft.title,
          body: draft.body,
          fontSize: draft.fontSize,
          noteKey,
          dirty: false
        }));
      }

      setStatus("팝업에서 변경 사항을 저장했습니다.");
      return true;
    } catch {
      setError("노트를 저장하지 못했습니다.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function insertImageFile(file: File, range: Range | null = null) {
    try {
      const dataUrl = await imageFileToResizedDataUrl(file);

      if (dataUrl.length > maxImageDataUrlLength) {
        setError("이미지 용량이 큽니다. 더 작은 이미지를 선택해주세요.");
        return;
      }

      const html = imageHtml(dataUrl, file.name);
      const nextHtml = insertHtmlAtSelection(memoEditorRef.current, html, range);
      setEditor((current) => ({ ...current, body: nextHtml ?? `${current.body}${html}`, dirty: true }));
      setError(null);
    } catch {
      setError("붙여넣은 이미지를 넣지 못했습니다.");
    }
  }

  return (
    <AppShell>
      <section className="workspace notes-workspace">
        <section className="editor-panel full-editor-panel">
          <div className="editor-toolbar">
            <div className="editor-primary-actions">
              <button className="secondary-button" type="button" onClick={() => setShareOpen((current) => !current)}>
                <UsersRound size={18} />
                공유 대상
              </button>
              <span className="note-meta-card">
                <span>생성일</span>
                <strong>{formatFullDateTime(createdDate)}</strong>
              </span>
              <div className="deadline-control">
                <button
                  className={`deadline-summary ${currentDeadlineTone}`}
                  type="button"
                  onClick={() => setDeadlineOpen((current) => !current)}
                >
                  <span>
                    <CalendarClock size={16} />
                    마감일
                  </span>
                  <strong>{deadlineLabel}</strong>
                  <em>{deadlineDday ?? "설정"}</em>
                </button>
                {deadlineOpen && (
                  <div className="deadline-picker">
                    <label className="deadline-picker-field">
                      날짜 및 시간
                      <input
                        aria-label="마감일 날짜와 시간"
                        onChange={(event) => updateDeadline(event.target.value)}
                        type="datetime-local"
                        value={toDateTimeLocalValue(editor.dueAt)}
                      />
                    </label>
                    <button className="secondary-button" type="button" onClick={() => updateDeadline("")}>
                      해제
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="toolbar-actions">
              <label className="font-size-control">
                글자
                <select
                  aria-label="메모 글자 크기"
                  onChange={(event) => updateFontSize(Number(event.target.value))}
                  value={editor.fontSize}
                >
                  {fontSizes.map((fontSize) => (
                    <option key={fontSize} value={fontSize}>
                      {fontSize}px
                    </option>
                  ))}
                </select>
              </label>
              <button className="secondary-button" type="button" onClick={() => setListOpen((current) => !current)}>
                <PanelRightOpen size={18} />
                노트 목록
              </button>
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
              <button type="button" onClick={() => startNewNote()}>
                <FilePlus2 size={18} />
                새 노트
              </button>
              <span className="sync-status">{saving ? "저장 중..." : status}</span>
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
            className="title-input"
            onChange={(event) => updateEditor("title", event.target.value)}
            placeholder="노트 제목"
            value={editor.title}
          />
          <RichMemoEditor
            editorRef={memoEditorRef}
            fontSize={editor.fontSize}
            onCursorChange={publishEditorCursor}
            onFilesPaste={(files, range) => void insertPastedFiles(files, range)}
            onChange={(value) => updateEditor("body", value)}
            remoteCursors={remoteEditorCursors}
            value={editor.body}
          />
          {editor.noteId && activeRemoteNote && (
            <AttachmentList
              attachments={attachments}
              busyId={attachmentBusyId}
              canDelete={(attachment) => canDeleteAttachmentForNote(activeRemoteNote, attachment)}
              onDelete={(attachment) => void removeAttachment(activeRemoteNote, attachment)}
              onDownload={(attachment) => void downloadAttachment(editor.noteId ?? activeRemoteNote.id, attachment)}
              onPreview={(attachment) => void previewPdfAttachment(editor.noteId ?? activeRemoteNote.id, attachment)}
            />
          )}
          <div className="editor-footer">
            <span className={`note-kind-pill ${currentType}`}>{currentType === "shared" ? "공유" : "개인"}</span>
            {error && <p className="form-error">{error}</p>}
          </div>
        </section>
        <NoteDrawer
          activeNoteId={editor.noteId}
          canRestoreNote={canRestoreNote}
          counts={noteCounts}
          deletedNotes={trashNotes}
          filter={noteFilter}
          noteStates={noteStateMap}
          notes={visibleNotes}
          onClose={() => setListOpen(false)}
          onFilterChange={updateNoteFilter}
          onNew={startNewNote}
          onPreview={previewStoredNote}
          onPurge={(note) => void purgePreviewNote(note)}
          onRestore={(note) => void restorePreviewNote(note)}
          onSortChange={updateSortSetting}
          onTogglePin={(note) => void togglePinnedNote(note)}
          open={listOpen}
          sortSetting={noteSort}
        />
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
            onDelete={(note) => void removePreviewNote(note)}
            onDeleteAttachment={(note, attachment) => void removeAttachment(note, attachment)}
            onDownloadAttachment={(note, attachment) => void downloadAttachment(note.id, attachment)}
            onPreviewAttachment={(note, attachment) => void previewPdfAttachment(note.id, attachment)}
            onPurge={(note) => void purgePreviewNote(note)}
            onLoad={(note, draft) => void openNote(note, draft)}
            onResolveNoteKey={resolveNoteKey}
            onRestore={(note) => void restorePreviewNote(note)}
            onSave={(note, draft) => savePreviewNote(note, draft)}
            onTogglePin={(note) => void togglePinnedNote(note)}
            onUploadAttachments={(note, files) => void uploadPreviewAttachments(note, files)}
            saving={saving}
            attachmentBusyId={attachmentBusyId}
            canDeleteAttachment={canDeleteAttachmentForNote}
          />
        )}
        {pdfPreview && <PdfPreviewModal fileName={pdfPreview.fileName} onClose={closePdfPreview} url={pdfPreview.url} />}
      </section>
    </AppShell>
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
  onFilesPaste: (files: File[], range: Range | null) => void;
  onChange: (value: string) => void;
  remoteCursors?: RemoteCursorView[];
  value: string;
}) {
  const selectedImageRef = useRef<HTMLImageElement | null>(null);
  const [selectedImageWidth, setSelectedImageWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = editorRef.current;

    if (!element || element.innerHTML === value) {
      return;
    }

    const wasFocused = document.activeElement === element;
    element.innerHTML = value;

    if (wasFocused) {
      placeCaretAtEnd(element);
    }
  }, [editorRef, value]);

  function clearImageSelection() {
    selectedImageRef.current = null;
    setSelectedImageWidth(null);
  }

  function handleInput(event: FormEvent<HTMLDivElement>) {
    const inputEvent = event.nativeEvent as InputEvent;
    const shouldLinkify =
      inputEvent.inputType === "insertParagraph" || inputEvent.inputType === "insertLineBreak" || inputEvent.data === " ";

    onChange(shouldLinkify ? linkifyEditableElement(editorRef.current) : editorRef.current?.innerHTML ?? "");
    emitCursorPosition(true);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files);
    const itemFiles = Array.from(event.clipboardData.items)
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const pastedFiles = files.length ? files : itemFiles;

    if (pastedFiles.length) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      event.preventDefault();
      onFilesPaste(pastedFiles, range);
      return;
    }

    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    onChange(linkifyEditableElement(editorRef.current));
    emitCursorPosition(true);
  }

  function handleBlur() {
    onChange(linkifyEditableElement(editorRef.current));
    emitCursorPosition(false);
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target;
    const image = target instanceof HTMLElement ? target.closest("img") : null;
    const anchor = target instanceof HTMLElement ? target.closest("a[href]") : null;

    if (image instanceof HTMLImageElement && editorRef.current?.contains(image)) {
      selectedImageRef.current = image;
      setSelectedImageWidth(readImageWidth(image));
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

  function emitCursorPosition(cursorVisible: boolean) {
    if (!onCursorChange) {
      return;
    }

    const cursorOffset = cursorVisible ? getCaretCharacterOffset(editorRef.current) : null;
    onCursorChange(cursorOffset, cursorVisible && cursorOffset !== null);
  }

  function updateSelectedImageWidth(width: number) {
    const image = selectedImageRef.current;

    if (!image || !editorRef.current?.contains(image)) {
      clearImageSelection();
      return;
    }

    image.dataset.qmWidth = String(width);
    image.style.width = `${width}%`;
    image.style.maxWidth = "100%";
    image.style.height = "auto";
    setSelectedImageWidth(width);
    onChange(editorRef.current.innerHTML);
  }

  return (
    <>
      {selectedImageWidth && (
        <div className="image-size-toolbar" aria-label="이미지 크기 조절">
          <span>이미지 크기</span>
          {imageWidthOptions.map((width) => (
            <button
              aria-pressed={selectedImageWidth === width}
              className={selectedImageWidth === width ? "active" : ""}
              key={width}
              onClick={() => updateSelectedImageWidth(width)}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              {width}%
            </button>
          ))}
        </div>
      )}
      <div className="rich-editor-frame">
        <div
          ref={editorRef}
          className="rich-body-input"
          contentEditable
          data-placeholder="메모를 입력하세요..."
          onBlur={handleBlur}
          onClick={handleClick}
          onFocus={() => emitCursorPosition(true)}
          onInput={handleInput}
          onKeyUp={() => emitCursorPosition(true)}
          onMouseUp={() => emitCursorPosition(true)}
          onPaste={handlePaste}
          role="textbox"
          style={{ fontSize }}
          suppressContentEditableWarning
        />
        <RemoteCursorLayer cursors={remoteCursors} editorRef={editorRef} />
      </div>
    </>
  );
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

function readImageWidth(image: HTMLImageElement) {
  const width = Number(image.dataset.qmWidth ?? image.style.width.replace("%", ""));
  return imageWidthOptions.includes(width) ? width : 100;
}

function placeCaretAtEnd(element: HTMLElement) {
  element.focus();

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function linkifyEditableElement(element: HTMLDivElement | null) {
  if (!element) {
    return "";
  }

  const caretOffset = getCaretCharacterOffset(element);
  const linkedHtml = linkifyEditorHtml(element.innerHTML);

  if (linkedHtml !== element.innerHTML) {
    element.innerHTML = linkedHtml;
    restoreCaretByCharacterOffset(element, caretOffset);
  }

  return element.innerHTML;
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

function restoreCaretByCharacterOffset(element: HTMLElement, offset: number | null) {
  if (offset === null) {
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(element, 4);
  let remainingOffset = offset;
  let currentNode = walker.nextNode();

  while (currentNode) {
    const textLength = currentNode.textContent?.length ?? 0;

    if (remainingOffset <= textLength) {
      range.setStart(currentNode, remainingOffset);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }

    remainingOffset -= textLength;
    currentNode = walker.nextNode();
  }

  placeCaretAtEnd(element);
}

function NoteDrawer({
  activeNoteId,
  canRestoreNote,
  counts,
  deletedNotes,
  filter,
  noteStates,
  notes,
  onClose,
  onFilterChange,
  onNew,
  onPreview,
  onPurge,
  onRestore,
  onSortChange,
  onTogglePin,
  open,
  sortSetting
}: {
  activeNoteId: string | null;
  canRestoreNote: (note: DecryptedNote) => boolean;
  counts: NoteListCounts;
  deletedNotes: DecryptedNote[];
  filter: NoteListFilter;
  noteStates: NoteStateByNoteId;
  notes: DecryptedNote[];
  onClose: () => void;
  onFilterChange: (filter: NoteListFilter) => void;
  onNew: () => void;
  onPreview: (note: DecryptedNote) => void;
  onPurge: (note: DecryptedNote) => void;
  onRestore: (note: DecryptedNote) => void;
  onSortChange: (setting: NoteSortSetting) => void;
  onTogglePin: (note: DecryptedNote) => void;
  open: boolean;
  sortSetting: NoteSortSetting;
}) {
  const [mode, setMode] = useState<DrawerMode>("notes");

  if (!open) {
    return null;
  }

  const isTrashMode = mode === "trash";
  const listedNotes = isTrashMode ? deletedNotes : notes;

  return (
    <aside className="note-drawer" aria-label="노트 목록">
      <div className="note-drawer-header">
        <h2>
          <ListChecks size={18} />
          {isTrashMode ? "복구함" : "전체 노트"}
        </h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="노트 목록 닫기">
          <X size={18} />
        </button>
      </div>
      <button
        className="secondary-button drawer-new-button"
        type="button"
        onClick={() => {
          onNew();
          onClose();
        }}
      >
        <FilePlus2 size={18} />
        새 메모
      </button>
      <div className="drawer-mode-tabs" role="tablist" aria-label="노트 목록 모드">
        <button
          aria-selected={!isTrashMode}
          className={!isTrashMode ? "active" : ""}
          role="tab"
          type="button"
          onClick={() => setMode("notes")}
        >
          노트
        </button>
        <button
          aria-selected={isTrashMode}
          className={isTrashMode ? "active" : ""}
          role="tab"
          type="button"
          onClick={() => setMode("trash")}
        >
          복구함
          <strong>{deletedNotes.length}</strong>
        </button>
      </div>
      <div className="note-filter-tabs" role="tablist" aria-label="노트 종류 필터">
        <NoteFilterButton
          count={counts.all}
          filter="all"
          label="전체"
          selected={filter === "all"}
          onSelect={onFilterChange}
        />
        <NoteFilterButton
          count={counts.personal}
          filter="personal"
          label="개인"
          selected={filter === "personal"}
          onSelect={onFilterChange}
        />
        <NoteFilterButton
          count={counts.shared}
          filter="shared"
          label="공유"
          selected={filter === "shared"}
          onSelect={onFilterChange}
        />
      </div>
      <div className="note-sort-controls">
        <label className="font-size-control">
          정렬
          <select
            aria-label="노트 목록 정렬 기준"
            onChange={(event) => onSortChange({ ...sortSetting, field: event.target.value as NoteSortField })}
            value={sortSetting.field}
          >
            <option value="createdAt">생성일</option>
            <option value="dueAt">마감일</option>
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
      {isTrashMode && <p className="trash-retention-hint">삭제된 노트는 {deletedNoteRetentionDays}일 보관 기준으로 표시됩니다.</p>}
      <NoteList
        activeNoteId={activeNoteId}
        canRestoreNote={canRestoreNote}
        deleted={isTrashMode}
        filter={filter}
        noteStates={noteStates}
        notes={listedNotes}
        onPreview={onPreview}
        onPurge={onPurge}
        onRestore={onRestore}
        onTogglePin={onTogglePin}
      />
    </aside>
  );
}

function NoteFilterButton({
  count,
  filter,
  label,
  onSelect,
  selected
}: {
  count: number;
  filter: NoteListFilter;
  label: string;
  onSelect: (filter: NoteListFilter) => void;
  selected: boolean;
}) {
  return (
    <button
      aria-selected={selected}
      className={`note-filter-tab ${selected ? "active" : ""}`}
      role="tab"
      type="button"
      onClick={() => onSelect(filter)}
    >
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}

function NoteList({
  activeNoteId,
  canRestoreNote,
  deleted = false,
  filter,
  noteStates,
  notes,
  onPreview,
  onPurge,
  onRestore,
  onTogglePin
}: {
  activeNoteId: string | null;
  canRestoreNote: (note: DecryptedNote) => boolean;
  deleted?: boolean;
  filter: NoteListFilter;
  noteStates: NoteStateByNoteId;
  notes: DecryptedNote[];
  onPreview: (note: DecryptedNote) => void;
  onPurge: (note: DecryptedNote) => void;
  onRestore: (note: DecryptedNote) => void;
  onTogglePin: (note: DecryptedNote) => void;
}) {
  if (notes.length === 0) {
    const emptyMessage = deleted
      ? "복구함에 노트가 없습니다."
      : filter === "personal"
        ? "아직 저장된 개인 노트가 없습니다."
        : filter === "shared"
          ? "아직 저장된 공유 노트가 없습니다."
          : "아직 저장된 노트가 없습니다.";

    return <p className="muted">{emptyMessage}</p>;
  }

  return (
    <div className="note-list">
      {notes.map((note) => {
        const createdAt = dateFromTimestamp(note.createdAt);
        const dueAt = dateFromTimestamp(note.dueAt);
        const deletedAt = dateFromTimestamp(note.deletedAt);
        const dueTone = deadlineTone(dueAt);
        const pinned = notePinned(note.id, noteStates);
        const canRestore = canRestoreNote(note);

        return (
          <article
            key={note.id}
            className={`note-list-item ${activeNoteId === note.id ? "active" : ""} ${deleted ? "deleted" : ""}`}
          >
            <button className="note-list-open" type="button" onClick={() => onPreview(note)}>
              <header>
                <span className={`note-kind-pill ${note.type}`}>
                  {note.type === "shared" ? <Share2 size={12} /> : null}
                  {note.type === "shared" ? "공유" : "개인"}
                </span>
                <strong>{note.title || "제목 없음"}</strong>
              </header>
              <span className="note-snippet">{previewTextFromHtml(note.body) || "내용 없음"}</span>
              <footer className="note-list-meta">
                <span className="note-list-date">
                  <span>{deleted ? "삭제" : "생성"}</span>
                  <strong>{formatCompactDateTime(deleted ? deletedAt : createdAt)}</strong>
                  {deleted && <em>{deletedRetentionLabel(note)}</em>}
                </span>
                <span className={`note-list-date deadline ${dueTone}`}>
                  <span>마감</span>
                  <strong>{formatCompactDateTime(dueAt)}</strong>
                  {dueAt && <em>{deadlineDDay(dueAt)}</em>}
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

function AttachmentList({
  attachments,
  busyId,
  canDelete,
  compact = false,
  onDelete,
  onDownload,
  onPreview
}: {
  attachments: NoteAttachmentSnapshot[];
  busyId: string | null;
  canDelete: (attachment: NoteAttachmentSnapshot) => boolean;
  compact?: boolean;
  onDelete: (attachment: NoteAttachmentSnapshot) => void;
  onDownload: (attachment: NoteAttachmentSnapshot) => void;
  onPreview?: (attachment: NoteAttachmentSnapshot) => void;
}) {
  if (!attachments.length) {
    return null;
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
          const disabled = busyId === attachment.id;

          return (
            <article className="attachment-item" key={attachment.id}>
              <div className="attachment-info">
                <strong>{attachmentDownloadName(attachment)}</strong>
                <span>
                  {attachment.extension.toUpperCase()} · {formatFileSize(attachment.originalSize)}
                </span>
              </div>
              <div className="attachment-actions">
                {attachment.extension === "pdf" && onPreview && (
                  <button
                    aria-label={`${attachmentDownloadName(attachment)} 미리보기`}
                    className="secondary-button attachment-action"
                    disabled={Boolean(busyId)}
                    onClick={() => onPreview(attachment)}
                    type="button"
                  >
                    <Eye size={16} />
                    미리보기
                  </button>
                )}
                <button
                  aria-label={`${attachmentDownloadName(attachment)} 다운로드`}
                  className="secondary-button attachment-action"
                  disabled={Boolean(busyId)}
                  onClick={() => onDownload(attachment)}
                  type="button"
                >
                  {disabled ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                  다운로드
                </button>
                <button
                  aria-label={`${attachmentDownloadName(attachment)} 삭제`}
                  className="icon-button danger attachment-delete-action"
                  disabled={Boolean(busyId) || !canDelete(attachment)}
                  onClick={() => onDelete(attachment)}
                  type="button"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PdfPreviewModal({
  fileName,
  onClose,
  url
}: {
  fileName: string;
  onClose: () => void;
  url: string;
}) {
  return (
    <div className="modal-backdrop pdf-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="pdf-preview-title"
        aria-modal="true"
        className="pdf-preview-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="pdf-preview-header">
          <div className="pdf-preview-title">
            <span>PDF 미리보기</span>
            <h2 id="pdf-preview-title">{fileName}</h2>
          </div>
          <div className="pdf-preview-actions">
            <a className="secondary-button pdf-preview-download" download={fileName} href={url}>
              <Download size={14} />
              다운로드
            </a>
            <button className="icon-button pdf-preview-close" type="button" onClick={onClose} aria-label="PDF 미리보기 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        <iframe
          className="pdf-preview-frame"
          referrerPolicy="no-referrer"
          sandbox=""
          src={url}
          title={`${fileName} 미리보기`}
        />
      </section>
    </div>
  );
}

function NotePreviewModal({
  attachmentBusyId,
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
  saving
}: {
  attachmentBusyId: string | null;
  canDeleteAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => boolean;
  canDelete: boolean;
  canRestore: boolean;
  currentUid: string;
  historyUsers: UserProfile[];
  isPinned: boolean;
  note: DecryptedNote;
  onClose: () => void;
  onConfirm: (note: DecryptedNote) => void;
  onDelete: (note: DecryptedNote) => void;
  onDeleteAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => void;
  onDownloadAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => void;
  onPreviewAttachment: (note: DecryptedNote, attachment: NoteAttachmentSnapshot) => void;
  onPurge: (note: DecryptedNote) => void;
  onLoad: (note: DecryptedNote, draft: NoteDraft) => void;
  onResolveNoteKey: (noteId: string) => Promise<CryptoKey>;
  onRestore: (note: DecryptedNote) => void;
  onSave: (note: DecryptedNote, draft: NoteDraft) => Promise<boolean>;
  onTogglePin: (note: DecryptedNote) => void;
  onUploadAttachments: (note: DecryptedNote, files: File[]) => void;
  saving: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<NoteDraft>(() => draftFromNote(note));
  const [draftDirty, setDraftDirty] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<NoteAttachmentSnapshot[]>([]);
  const [readStates, setReadStates] = useState<NoteUserStateSnapshot[]>([]);
  const [history, setHistory] = useState<NoteHistorySnapshot[]>([]);
  const [historySummaries, setHistorySummaries] = useState<Record<string, string>>({});
  const previewAutosaveTimer = useRef<number | null>(null);
  const previewEditorRef = useRef<HTMLDivElement | null>(null);
  const latestDraftRef = useRef(draft);

  useEffect(() => {
    latestDraftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    return subscribeNoteAttachments(note.id, setAttachments, () => setModalError("첨부파일 목록을 불러오지 못했습니다."));
  }, [note.id]);

  useEffect(() => {
    return subscribeNoteUserStates(note.id, setReadStates, () => setModalError("읽음 상태를 불러오지 못했습니다."));
  }, [note.id]);

  useEffect(() => {
    return subscribeNoteHistory(note.id, setHistory, () => setModalError("수정 이력을 불러오지 못했습니다."));
  }, [note.id]);

  useEffect(() => {
    const entriesWithSummary = history.filter((entry) => entry.encryptedSummary);

    if (!entriesWithSummary.length) {
      setHistorySummaries({});
      return undefined;
    }

    let cancelled = false;

    async function decryptSummaries() {
      try {
        const noteKey = await onResolveNoteKey(note.id);
        const nextSummaries = Object.fromEntries(
          await Promise.all(
            entriesWithSummary.map(async (entry) => {
              try {
                return [entry.id, await decryptText(entry.encryptedSummary!, noteKey)] as const;
              } catch {
                return [entry.id, "내용 요약을 열 수 없습니다."] as const;
              }
            })
          )
        );

        if (!cancelled) {
          setHistorySummaries(nextSummaries);
        }
      } catch {
        if (!cancelled) {
          setHistorySummaries({});
        }
      }
    }

    void decryptSummaries();
    return () => {
      cancelled = true;
    };
  }, [history, note.id, onResolveNoteKey]);

  useEffect(() => {
    const remoteDraft = draftFromNote(note);

    if (noteDraftsMatch(latestDraftRef.current, remoteDraft)) {
      return;
    }

    setDraft(remoteDraft);
    setDraftDirty(false);
    setModalError(isEditing ? "다른 기기 변경 사항을 반영했습니다." : null);
  }, [isEditing, note]);

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
    setDraftDirty(false);
    setModalError(null);
    setIsEditing(true);
  }

  function cancelEdit() {
    setDraft(draftFromNote(note));
    setDraftDirty(false);
    setModalError(null);
    setIsEditing(false);
  }

  function updateDraft(field: "title" | "body", value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setDraftDirty(true);
  }

  function updateDraftFontSize(fontSize: number) {
    setDraft((current) => ({ ...current, fontSize }));
    setDraftDirty(true);
  }

  async function saveDraft(exitEdit = true) {
    setModalError(null);

    const savedDraft = draft;
    const saved = await onSave(note, savedDraft);

    if (!saved) {
      setModalError("노트를 저장하지 못했습니다.");
      return;
    }

    if (noteDraftsMatch(latestDraftRef.current, savedDraft)) {
      setDraftDirty(false);

      if (exitEdit) {
        setIsEditing(false);
      }
    }
  }

  async function insertPreviewImageFile(file: File, range: Range | null = null) {
    try {
      const dataUrl = await imageFileToResizedDataUrl(file);

      if (dataUrl.length > maxImageDataUrlLength) {
        setModalError("이미지 용량이 큽니다. 더 작은 이미지를 선택해주세요.");
        return;
      }

      const html = imageHtml(dataUrl, file.name);
      const nextHtml = insertHtmlAtSelection(previewEditorRef.current, html, range);

      setDraft((current) => ({ ...current, body: nextHtml ?? `${current.body}${html}` }));
      setDraftDirty(true);
      setModalError(null);
    } catch {
      setModalError("붙여넣은 이미지를 넣지 못했습니다.");
    }
  }

  async function insertPreviewPastedFiles(files: File[], range: Range | null = null) {
    const attachmentFiles: File[] = [];
    let imageRange = range;

    for (const file of files) {
      if (file.type.startsWith("image/")) {
        await insertPreviewImageFile(file, imageRange);
        imageRange = null;
      } else {
        attachmentFiles.push(file);
      }
    }

    if (attachmentFiles.length) {
      onUploadAttachments(note, attachmentFiles);
    }
  }

  const bodyHtml = draft.body || "<p>내용 없음</p>";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="note-preview-modal"
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
                      onClick={() => onRestore(note)}
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
                onClick={() => onDelete(note)}
              >
                <Trash2 size={14} />
                삭제
              </button>
            )}
            <button className="icon-button" type="button" onClick={onClose} aria-label="노트 조회 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        {isEditing ? (
          <div className="note-preview-editor">
            <label className="font-size-control note-preview-font-control">
              글자
              <select
                aria-label="팝업 메모 글자 크기"
                onChange={(event) => updateDraftFontSize(Number(event.target.value))}
                value={draft.fontSize}
              >
                {fontSizes.map((fontSize) => (
                  <option key={fontSize} value={fontSize}>
                    {fontSize}px
                  </option>
                ))}
              </select>
            </label>
            <RichMemoEditor
              editorRef={previewEditorRef}
              fontSize={draft.fontSize}
              onFilesPaste={(files, range) => void insertPreviewPastedFiles(files, range)}
              onChange={(value) => updateDraft("body", value)}
              value={draft.body}
            />
            {modalError && <p className="form-error">{modalError}</p>}
          </div>
        ) : (
          <div
            className="note-preview-body"
            style={{ fontSize: draft.fontSize }}
            dangerouslySetInnerHTML={{ __html: linkifyEditorHtml(sanitizeEditorHtml(bodyHtml)) }}
          />
        )}
        <NoteInsightPanel
          currentUid={currentUid}
          history={history}
          historySummaries={historySummaries}
          note={note}
          onConfirm={onConfirm}
          readStates={readStates}
          users={historyUsers}
        />
        <AttachmentList
          attachments={attachments}
          busyId={attachmentBusyId}
          canDelete={(attachment) => canDeleteAttachment(note, attachment)}
          compact
          onDelete={(attachment) => onDeleteAttachment(note, attachment)}
          onDownload={(attachment) => onDownloadAttachment(note, attachment)}
          onPreview={(attachment) => onPreviewAttachment(note, attachment)}
        />
      </section>
    </div>
  );
}

function NoteInsightPanel({
  currentUid,
  history,
  historySummaries,
  note,
  onConfirm,
  readStates,
  users
}: {
  currentUid: string;
  history: NoteHistorySnapshot[];
  historySummaries: Record<string, string>;
  note: DecryptedNote;
  onConfirm: (note: DecryptedNote) => void;
  readStates: NoteUserStateSnapshot[];
  users: UserProfile[];
}) {
  const usersByUid = new Map(users.map((user) => [user.uid, user]));
  const statesByUid = new Map(readStates.map((state) => [state.uid, state]));
  const currentState = statesByUid.get(currentUid);
  const showReceipts = note.type === "shared";

  return (
    <section className="note-insight-panel" aria-label="노트 활동 정보">
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
            {history.slice(0, 8).map((entry) => {
              const actor = usersByUid.get(entry.actorUid);
              const createdAt = dateFromTimestamp(entry.createdAt);
              const summary = historySummaries[entry.id] ?? entry.changedFields.map(historyFieldLabel).join(", ");

              return (
                <article className="history-item" key={entry.id}>
                  <span>{historyActionLabel(entry.action)}</span>
                  <strong>{summary}</strong>
                  <em>
                    {actor?.displayName ?? entry.actorUid} · {formatCompactDateTime(createdAt)}
                  </em>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="muted">아직 기록된 수정 이력이 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function insertHtmlAtSelection(container: HTMLDivElement | null, html: string, savedRange: Range | null = null) {
  if (!container) {
    return null;
  }

  container.focus();

  const selection = window.getSelection();
  const currentRange =
    selection?.rangeCount && selection.anchorNode && container.contains(selection.anchorNode)
      ? selection.getRangeAt(0)
      : null;
  const range = savedRange && container.contains(savedRange.commonAncestorContainer) ? savedRange : currentRange;

  if (range) {
    selection?.removeAllRanges();
    selection?.addRange(range);
    const template = document.createElement("template");
    template.innerHTML = sanitizeEditorHtml(html);
    const lastNode = template.content.lastChild;
    range.deleteContents();
    range.insertNode(template.content);

    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  } else {
    container.insertAdjacentHTML("beforeend", sanitizeEditorHtml(html));
  }

  return container.innerHTML;
}

async function imageFileToResizedDataUrl(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("이미지 파일이 아닙니다.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  return resizeImageDataUrl(dataUrl);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function resizeImageDataUrl(dataUrl: string) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
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
