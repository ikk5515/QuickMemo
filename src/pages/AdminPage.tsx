import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Eye,
  FileText,
  KeyRound,
  LibraryBig,
  LockKeyhole,
  Mail,
  NotebookPen,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserRoundCog,
  UsersRound,
  UserX,
  X
} from "lucide-react";
import type { Timestamp } from "firebase/firestore";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { AdminEmailSettingsPanel } from "../components/AdminEmailSettingsPanel";
import { AppSelect } from "../components/AppSelect";
import { AppShell } from "../components/AppShell";
import { ReadonlyNoteRenderer } from "../components/ReadonlyNoteRenderer";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import {
  AdminNoteDecryptionCache,
  lockedAdminNoteView,
  resolveAdminNoteViews,
  type AdminNoteView
} from "../lib/adminNoteDecryption";
import { generateUserKeyBundle } from "../lib/crypto";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { defaultFeatureAccess, normalizeFeatureAccess } from "../lib/featureAccess";
import { initialsFromName } from "../lib/roster";
import { minimumNewPasswordLength, newPasswordMeetsMinimum } from "../lib/passwordPolicy";
import { useModalFocus } from "../lib/useModalFocus";
import { createUser, deleteManagedUserDocuments, updateUser } from "../services/adminFunctions";
import { deleteRevisionedNote, subscribeAllNotesForAdmin, type NoteSnapshot } from "../services/notes";
import { subscribeUsers } from "../services/users";
import type { AppFeature, FeatureAccess, NoteKind, UserProfile } from "../types";
import "../styles/admin-settings.css";

const palette = ["#2f7d70", "#c75146", "#7c5b9e", "#b9822f", "#3f6fb5", "#65707a"];
const AUTO_SAVE_DELAY_MS = 550;
const managedUserDeleteUiMessages = new Set([
  "관리자 인증을 확인할 수 없습니다.",
  "첨부파일 정리가 오래 걸리고 있습니다. 잠시 후 사용자 삭제를 다시 시도해주세요.",
  "관리자 중요 작업을 계속하려면 로그아웃 후 다시 로그인해주세요.",
  "사용자를 삭제하지 못했습니다."
]);
const featureAccessOptions = [
  { feature: "notes", label: "노트", icon: NotebookPen },
  { feature: "library", label: "자료실", icon: LibraryBig },
  { feature: "schedule", label: "일정관리", icon: CalendarDays }
] as const;

interface DraftUser {
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  password: string;
  isAdmin: boolean;
  featureAccess: FeatureAccess;
  allowedShareTargetUids: string[];
}

const initialDraft: DraftUser = {
  displayName: "",
  avatarText: "",
  color: palette[0],
  quickKey: 0,
  password: "",
  isAdmin: false,
  featureAccess: { ...defaultFeatureAccess },
  allowedShareTargetUids: []
};

type AdminNoteTypeFilter = "all" | NoteKind;
export type AdminTab = "create" | "users" | "notes" | "email";
type UserStatusFilter = "all" | "active" | "inactive" | "admin";

export function managedUserDeleteUiError(error: unknown) {
  return error instanceof Error && managedUserDeleteUiMessages.has(error.message)
    ? error.message
    : "사용자를 삭제하지 못했습니다.";
}

export const adminTabIds: Readonly<Record<AdminTab, { panelId: string; tabId: string }>> = {
  create: {
    panelId: "admin-create-panel",
    tabId: "admin-create-tab"
  },
  users: {
    panelId: "admin-users-panel",
    tabId: "admin-users-tab"
  },
  notes: {
    panelId: "admin-notes-panel",
    tabId: "admin-notes-tab"
  },
  email: {
    panelId: "admin-email-settings-panel",
    tabId: "admin-email-settings-tab"
  }
};

const adminTabs = [
  { description: "새 계정과 최초 접근 권한을 설정합니다.", icon: Plus, label: "사용자 추가", tab: "create" },
  { description: "계정 상태, 기능 권한, 공유 대상을 관리합니다.", icon: UserRoundCog, label: "사용자 목록", tab: "users" },
  { description: "권한 범위 안의 암호화 노트를 확인하고 관리합니다.", icon: FileText, label: "노트 관리", tab: "notes" },
  { description: "Secure Share용 SMTP 연결과 검증 상태를 관리합니다.", icon: Mail, label: "이메일 설정", tab: "email" }
] as const;

interface AdminTabsProps {
  activeTab: AdminTab;
  onSelect: (tab: AdminTab) => void;
}

export function AdminTabs({ activeTab, onSelect }: AdminTabsProps) {
  const tabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: AdminTab) {
    const currentIndex = adminTabs.findIndex(({ tab }) => tab === currentTab);
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % adminTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + adminTabs.length) % adminTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = adminTabs.length - 1;
    }

    if (currentIndex < 0 || nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextTab = adminTabs[nextIndex].tab;
    onSelect(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  return (
    <div
      aria-label="관리자 기능"
      aria-orientation="vertical"
      className="admin-tabs admin-settings-tabs"
      role="tablist"
    >
      {adminTabs.map(({ icon: Icon, label, tab }) => {
        const selected = activeTab === tab;
        const ids = adminTabIds[tab];

        return (
          <button
            aria-controls={ids.panelId}
            aria-selected={selected}
            className={selected ? "active" : ""}
            id={ids.tabId}
            key={tab}
            onClick={() => onSelect(tab)}
            onKeyDown={(event) => handleKeyDown(event, tab)}
            ref={(element) => {
              tabRefs.current[tab] = element;
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden="true" size={16} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function timestampToDate(value: Timestamp | Date | null | undefined) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function formatAdminDate(timestamp: Timestamp | Date | null | undefined, emptyText = "없음") {
  const date = timestampToDate(timestamp);

  if (!date) {
    return emptyText;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

interface AdminNotePreviewDialogProps {
  deleting: boolean;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  note: AdminNoteView;
  onClose: () => void;
  onMoveToRecovery: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  userName: (uid: string) => string;
}

export function AdminNotePreviewDialog({
  deleting,
  fallbackFocusRef,
  note,
  onClose,
  onMoveToRecovery,
  returnFocusRef,
  userName
}: AdminNotePreviewDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus(dialogRef, { fallbackFocusRef, returnFocusRef });

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
    <div className="modal-backdrop" role="presentation">
      <article
        aria-labelledby="admin-note-modal-title"
        aria-modal="true"
        className="note-preview-modal admin-note-modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="note-preview-header">
          <div>
            <div className="note-preview-kicker">
              {note.type === "shared" ? "공유 노트" : "개인 노트"} · 작성자 {userName(note.ownerUid)}
            </div>
            <h2 id="admin-note-modal-title">{note.title}</h2>
            <div className="admin-note-modal-meta">
              <span>생성 {formatAdminDate(note.createdAt, "입력 전")}</span>
              <span>수정 {formatAdminDate(note.updatedAt, "없음")}</span>
            </div>
          </div>
          <div className="note-preview-actions">
            <button
              className="secondary-button danger"
              disabled={deleting}
              onClick={onMoveToRecovery}
              type="button"
            >
              복구함으로 이동
            </button>
            <button
              aria-label="노트 미리보기 닫기"
              className="icon-button"
              data-dialog-initial-focus
              onClick={onClose}
              type="button"
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="note-preview-body">
          {note.canReadContent ? (
            <ReadonlyNoteRenderer
              className="admin-note-view-body"
              content={note.bodyHtml}
              contentFormat={note.bodyFormat}
              emptyText="본문 없음"
              fontSize={note.fontSize}
            />
          ) : (
            <div className="admin-note-locked">
              <LockKeyhole size={18} />
              {note.unavailableReason}
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

function normalizedShareTargets(ownerUid: string, targetUids: string[] = []) {
  return Array.from(new Set([ownerUid, ...targetUids.filter(Boolean)]));
}

function shareTargetsOf(user: Pick<UserProfile, "uid" | "allowedShareTargetUids">) {
  return normalizedShareTargets(user.uid, user.allowedShareTargetUids ?? []);
}

function persistedShareTargetsOf(user: Pick<UserProfile, "uid" | "isAdmin" | "allowedShareTargetUids">) {
  return user.isAdmin ? [user.uid] : shareTargetsOf(user);
}

export function editableUserDraft(user: UserProfile) {
  return {
    ...user,
    role: user.isAdmin ? ("admin" as const) : ("user" as const),
    featureAccess: normalizeFeatureAccess(user),
    allowedShareTargetUids: persistedShareTargetsOf(user)
  };
}

export function stableEditableSignature(user: UserProfile) {
  const shareTargets = persistedShareTargetsOf(user);
  const featureAccess = normalizeFeatureAccess(user);
  const sortedTargets = [
    user.uid,
    ...shareTargets.filter((targetUid) => targetUid !== user.uid).sort((left, right) => left.localeCompare(right))
  ];

  return JSON.stringify({
    uid: user.uid,
    displayName: user.displayName.trim(),
    avatarText: user.avatarText.trim().toUpperCase(),
    color: user.color,
    quickKey: Number(user.quickKey),
    order: Number(user.order),
    isActive: user.isActive,
    isAdmin: user.isAdmin,
    featureAccess,
    allowedShareTargetUids: sortedTargets
  });
}

function editableUserValidationError(user: UserProfile, users: UserProfile[]) {
  const quickKey = Number(user.quickKey);
  const displayName = user.displayName.trim();
  const normalizedDisplayName = displayName.toLowerCase();

  if (!displayName) {
    return "이름을 입력하면 자동 저장됩니다.";
  }

  if (!user.avatarText.trim()) {
    return "원 글자를 입력하면 자동 저장됩니다.";
  }

  if (!Number.isInteger(quickKey) || quickKey < 1 || quickKey > 99) {
    return "번호는 1부터 99까지 입력해주세요.";
  }

  if (users.some((targetUser) => targetUser.uid !== user.uid && targetUser.quickKey === quickKey)) {
    return "이미 사용 중인 번호입니다.";
  }

  if (
    users.some(
      (targetUser) =>
        targetUser.uid !== user.uid &&
        targetUser.displayName.trim().toLowerCase() === normalizedDisplayName
    )
  ) {
    return "이미 사용 중인 이름입니다.";
  }

  return null;
}

function createUserValidationError(draft: DraftUser, users: UserProfile[], fallbackQuickKey: number) {
  const displayName = draft.displayName.trim();
  const avatarText = draft.avatarText.trim();
  const quickKey = Number(draft.quickKey || fallbackQuickKey);

  if (!displayName) {
    return "이름을 입력해주세요.";
  }

  if (!avatarText) {
    return "원 안 글자를 입력해주세요.";
  }

  if (!Number.isInteger(quickKey) || quickKey < 1 || quickKey > 99) {
    return "빠른 로그인 번호는 1부터 99까지 입력해주세요.";
  }

  if (!newPasswordMeetsMinimum(draft.password)) {
    return `초기 비밀번호는 ${minimumNewPasswordLength}자 이상 입력해주세요.`;
  }

  if (users.some((user) => user.displayName.trim().toLowerCase() === displayName.toLowerCase())) {
    return "이미 사용 중인 사용자 이름입니다.";
  }

  if (users.some((user) => user.quickKey === quickKey)) {
    return "이미 사용 중인 빠른 로그인 번호입니다.";
  }

  return null;
}

export function updatePayloadFromDraft(user: UserProfile) {
  return {
    uid: user.uid,
    displayName: user.displayName,
    avatarText: user.avatarText,
    color: user.color,
    quickKey: Number(user.quickKey),
    order: Number(user.order),
    isActive: user.isActive,
    isAdmin: user.isAdmin,
    featureAccess: normalizeFeatureAccess(user),
    allowedShareTargetUids: persistedShareTargetsOf(user)
  };
}

export function FeatureAccessFields({
  access,
  disabled,
  onToggle
}: {
  access: FeatureAccess;
  disabled: boolean;
  onToggle: (feature: AppFeature, checked: boolean) => void;
}) {
  const enabledCount = featureAccessOptions.filter(({ feature }) => access[feature]).length;

  return (
    <>
      <div className="permission-editor-header">
        <span>
          <ShieldCheck size={16} />
          기능 권한
        </span>
        <strong>{enabledCount}/{featureAccessOptions.length}</strong>
      </div>
      <p className="muted">
        {disabled
          ? "관리자는 계정 운영을 위해 모든 기능을 사용합니다."
          : "체크한 기능만 해당 사용자의 메뉴와 작업 공간에서 사용할 수 있습니다."}
      </p>
      <div className="permission-chip-grid" role="group" aria-label="사용 기능">
        {featureAccessOptions.map(({ feature, icon: Icon, label }) => (
          <label key={feature} className="permission-chip">
            <input
              checked={access[feature]}
              disabled={disabled}
              onChange={(event) => onToggle(feature, event.target.checked)}
              type="checkbox"
            />
            <Icon aria-hidden="true" size={15} />
            {label}
          </label>
        ))}
      </div>
    </>
  );
}

export default function AdminPage() {
  const { privateKey } = useAuth();

  if (!privateKey) {
    return (
      <AppShell>
        <section className="workspace admin-workspace">
          <UnlockPanel />
        </section>
      </AppShell>
    );
  }

  return <AdminDashboard />;
}

function AdminDashboard() {
  const { profile, privateKey } = useAuth();
  const adminUid = profile?.uid;
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [adminNoteViews, setAdminNoteViews] = useState<AdminNoteView[]>([]);
  const [activeAdminTab, setActiveAdminTab] = useState<AdminTab>("users");
  const [noteOwnerFilter, setNoteOwnerFilter] = useState("all");
  const [noteTypeFilter, setNoteTypeFilter] = useState<AdminNoteTypeFilter>("all");
  const [noteSearch, setNoteSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<UserStatusFilter>("all");
  const [noteNotice, setNoteNotice] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftUser>(initialDraft);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const adminNoteDecryptCache = useRef(new AdminNoteDecryptionCache());
  const adminNoteDecryptGeneration = useRef(0);
  const adminNoteDialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const adminNoteFallbackFocusRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return subscribeUsers(setUsers, () => setError("사용자 목록을 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    if (!profile?.isAdmin || activeAdminTab !== "notes") {
      setNotes([]);
      return undefined;
    }

    return subscribeAllNotesForAdmin(setNotes, () => setNoteError("노트 목록을 불러오지 못했습니다."));
  }, [activeAdminTab, profile?.isAdmin]);

  useEffect(() => {
    const generation = adminNoteDecryptGeneration.current + 1;
    adminNoteDecryptGeneration.current = generation;
    let cancelled = false;

    if (activeAdminTab !== "notes") {
      adminNoteDecryptCache.current.clear();
      setAdminNoteViews([]);
      return undefined;
    }

    if (!adminUid || !privateKey) {
      adminNoteDecryptCache.current.clear();
      setAdminNoteViews(notes.map((note) => lockedAdminNoteView(note, Boolean(privateKey))));
      return undefined;
    }

    void resolveAdminNoteViews({
      cache: adminNoteDecryptCache.current,
      notes,
      onPending: (pendingViews) => {
        if (!cancelled && adminNoteDecryptGeneration.current === generation) {
          setAdminNoteViews(pendingViews);
        }
      },
      privateKey,
      uid: adminUid
    }).then((nextNotes) => {
      if (!cancelled && adminNoteDecryptGeneration.current === generation) {
        setAdminNoteViews(nextNotes);
      }
    }).catch(() => {
      if (!cancelled && adminNoteDecryptGeneration.current === generation) {
        adminNoteDecryptCache.current.clear();
        setAdminNoteViews(notes.map((note) => lockedAdminNoteView(note, true)));
        setNoteError("노트 본문을 복호화하지 못했습니다. 잠시 후 다시 시도해주세요.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeAdminTab, adminUid, notes, privateKey]);

  useEffect(() => {
    if (selectedNoteId && !adminNoteViews.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(null);
    }
  }, [adminNoteViews, selectedNoteId]);

  const nextQuickKey = useMemo(() => {
    const used = new Set(users.map((user) => user.quickKey));
    for (let key = 1; key <= 99; key += 1) {
      if (!used.has(key)) {
        return key;
      }
    }
    return users.length + 1;
  }, [users]);

  const userMap = useMemo(() => new Map(users.map((user) => [user.uid, user])), [users]);
  const activeUsers = useMemo(() => users.filter((user) => user.isActive), [users]);
  const activeAdminCount = useMemo(() => users.filter((user) => user.isAdmin && user.isActive).length, [users]);

  const adminNoteCounts = useMemo(
    () =>
      adminNoteViews.reduce(
        (counts, note) => ({
          all: counts.all + 1,
          personal: counts.personal + (note.type === "personal" ? 1 : 0),
          shared: counts.shared + (note.type === "shared" ? 1 : 0)
        }),
        { all: 0, personal: 0, shared: 0 }
      ),
    [adminNoteViews]
  );

  const adminStats = useMemo(
    () => ({
      totalUsers: users.length,
      activeUsers: users.filter((user) => user.isActive).length,
      admins: users.filter((user) => user.isAdmin).length,
      shareLinks: users.reduce((count, user) => count + (user.isAdmin ? 0 : Math.max(shareTargetsOf(user).length - 1, 0)), 0)
    }),
    [users]
  );

  const filteredUsers = useMemo(() => {
    const searchText = userSearch.trim().toLowerCase();

    return users.filter((user) => {
      if (userStatusFilter === "active" && !user.isActive) {
        return false;
      }

      if (userStatusFilter === "inactive" && user.isActive) {
        return false;
      }

      if (userStatusFilter === "admin" && !user.isAdmin) {
        return false;
      }

      if (!searchText) {
        return true;
      }

      return [user.displayName, user.avatarText, String(user.quickKey)].join(" ").toLowerCase().includes(searchText);
    });
  }, [userSearch, userStatusFilter, users]);

  const filteredAdminNotes = useMemo(() => {
    const searchText = noteSearch.trim().toLowerCase();

    return adminNoteViews.filter((note) => {
      if (noteOwnerFilter !== "all" && note.ownerUid !== noteOwnerFilter) {
        return false;
      }

      if (noteTypeFilter !== "all" && note.type !== noteTypeFilter) {
        return false;
      }

      if (!searchText) {
        return true;
      }

      const ownerName = userMap.get(note.ownerUid)?.displayName ?? note.ownerUid;
      const participants = note.participantUids
        .map((uid) => userMap.get(uid)?.displayName ?? uid)
        .join(" ");

      return [note.title, note.bodySearchText, ownerName, participants]
        .join(" ")
        .toLowerCase()
        .includes(searchText);
    });
  }, [adminNoteViews, noteOwnerFilter, noteSearch, noteTypeFilter, userMap]);

  const selectedAdminNote = adminNoteViews.find((note) => note.id === selectedNoteId) ?? null;

  useEffect(() => {
    if (!draft.quickKey && nextQuickKey) {
      setDraft((current) => ({ ...current, quickKey: nextQuickKey }));
    }
  }, [draft.quickKey, nextQuickKey]);

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = createUserValidationError(draft, users, nextQuickKey);

    if (validationError) {
      setError(validationError);
      setNotice(null);
      return;
    }

    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const keyBundle = await generateUserKeyBundle(draft.password);
      await createUser({
        displayName: draft.displayName,
        avatarText: draft.avatarText || initialsFromName(draft.displayName),
        color: draft.color,
        quickKey: Number(draft.quickKey || nextQuickKey),
        password: draft.password,
        isAdmin: draft.isAdmin,
        featureAccess: normalizeFeatureAccess(draft),
        allowedShareTargetUids: draft.isAdmin ? [] : draft.allowedShareTargetUids,
        keyBundle
      });
      setDraft({
        ...initialDraft,
        quickKey: nextQuickKey + 1,
        color: palette[users.length % palette.length]
      });
      setNotice("사용자를 만들었습니다.");
    } catch (createError) {
      setError(firebaseAuthErrorMessage(createError, "사용자를 만들지 못했습니다."));
    } finally {
      setPending(false);
    }
  }

  function userName(uid: string) {
    return userMap.get(uid)?.displayName ?? uid;
  }

  function participantSummary(note: NoteSnapshot) {
    if (note.type === "personal") {
      return "개인 노트";
    }

    return note.participantUids.map(userName).join(", ");
  }

  function toggleDraftShareTarget(uid: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      allowedShareTargetUids: checked
        ? Array.from(new Set([...current.allowedShareTargetUids, uid]))
        : current.allowedShareTargetUids.filter((targetUid) => targetUid !== uid)
    }));
  }

  function toggleDraftFeatureAccess(feature: AppFeature, checked: boolean) {
    setDraft((current) => ({
      ...current,
      featureAccess: {
        ...normalizeFeatureAccess(current),
        [feature]: checked
      }
    }));
  }

  async function handleDeleteManagedNote(note: AdminNoteView) {
    if (!profile) {
      setNoteError("관리자 정보를 확인하지 못했습니다.");
      return;
    }

    const currentProfile = profile;
    const readableTitle = note.canReadContent ? note.title : "암호화된 노트";
    const confirmed = window.confirm(
      `${userName(note.ownerUid)} 사용자의 "${readableTitle}" 노트를 복구함으로 이동할까요?`
    );

    if (!confirmed) {
      return;
    }

    setDeletingNoteId(note.id);
    setNoteNotice(null);
    setNoteError(null);

    try {
      await deleteRevisionedNote({
        expectedRevision: note.revision ?? 0,
        noteId: note.id,
        readerUids: note.participantUids,
        uid: currentProfile.uid
      });
      setSelectedNoteId(null);
      setNoteNotice("노트를 복구함으로 이동했습니다.");
    } catch {
      setNoteError("노트를 삭제하지 못했습니다. 권한 또는 네트워크 상태를 확인해주세요.");
    } finally {
      setDeletingNoteId(null);
    }
  }

  const activeAdminSection = adminTabs.find(({ tab }) => tab === activeAdminTab) ?? adminTabs[1];
  const ActiveAdminSectionIcon = activeAdminSection.icon;

  return (
    <AppShell>
      <section className="workspace admin-workspace admin-settings-workspace">
        <div className="admin-settings-layout">
          <aside aria-labelledby="admin-settings-title" className="admin-settings-sidebar">
            <header className="admin-settings-sidebar-header">
              <span className="admin-settings-eyebrow">
                <ShieldCheck aria-hidden="true" size={15} />
                QUICKMEMO
              </span>
              <h1 id="admin-settings-title">관리자 설정</h1>
              <p>사용자, 공유 권한과 운영 연결을 한곳에서 관리합니다.</p>
            </header>

            <AdminTabs activeTab={activeAdminTab} onSelect={setActiveAdminTab} />

            <section className="admin-stats-grid admin-settings-summary" aria-label="관리 현황">
              <AdminStat icon={<UsersRound size={15} />} label="전체" value={adminStats.totalUsers} />
              <AdminStat icon={<UserCheck size={15} />} label="활성" value={adminStats.activeUsers} />
              <AdminStat icon={<ShieldCheck size={15} />} label="관리자" value={adminStats.admins} />
              <AdminStat icon={<KeyRound size={15} />} label="공유 허용" value={adminStats.shareLinks} />
            </section>
          </aside>

          <section aria-label={`${activeAdminSection.label} 설정`} className="admin-settings-pane">
            <header className="admin-settings-pane-header">
              <span className="admin-settings-pane-icon" aria-hidden="true">
                <ActiveAdminSectionIcon size={18} />
              </span>
              <div>
                <strong>{activeAdminSection.label}</strong>
                <p>{activeAdminSection.description}</p>
              </div>
            </header>

            <div className="admin-settings-pane-body" key={activeAdminTab}>
              {(activeAdminTab === "create" || activeAdminTab === "users") && (
          <div className={`admin-management-grid ${activeAdminTab === "users" ? "single-panel" : ""}`}>
            {activeAdminTab === "create" && (
              <section
                aria-labelledby={adminTabIds.create.tabId}
                className="panel admin-create-panel"
                id={adminTabIds.create.panelId}
                role="tabpanel"
              >
            <div className="admin-section-header">
              <h2>
                <Plus size={20} />
                사용자 추가
              </h2>
              <div className="admin-avatar-preview" style={{ background: draft.color }}>
                {draft.avatarText || initialsFromName(draft.displayName) || "?"}
              </div>
            </div>
            <form className="form-grid admin-create-form" onSubmit={handleCreateUser}>
              <label>
                이름
                <input
                  maxLength={24}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      displayName: event.target.value,
                      avatarText: current.avatarText || initialsFromName(event.target.value)
                    }))
                  }
                  required
                  value={draft.displayName}
                />
              </label>
              <label>
                원 안 글자
                <input
                  maxLength={3}
                  onChange={(event) => setDraft((current) => ({ ...current, avatarText: event.target.value.toUpperCase() }))}
                  required
                  value={draft.avatarText}
                />
              </label>
              <label>
                빠른 로그인 번호
                <input
                  min={1}
                  onChange={(event) => setDraft((current) => ({ ...current, quickKey: Number(event.target.value) }))}
                  required
                  type="number"
                  value={draft.quickKey || nextQuickKey}
                />
              </label>
              <label>
                색상
                <input
                  onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
                  type="color"
                  value={draft.color}
                />
              </label>
              <label className="admin-create-password">
                초기 비밀번호
                <input
                  autoComplete="new-password"
                  minLength={minimumNewPasswordLength}
                  onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
                  required
                  type="password"
                  value={draft.password}
                />
              </label>
              <label className="checkbox-row">
                <input
                  checked={draft.isAdmin}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      isAdmin: event.target.checked,
                      featureAccess: event.target.checked
                        ? { ...defaultFeatureAccess }
                        : current.featureAccess
                    }))
                  }
                  type="checkbox"
                />
                관리자 권한
              </label>
              <div className="permission-editor create-permission-editor">
                <FeatureAccessFields
                  access={normalizeFeatureAccess(draft)}
                  disabled={draft.isAdmin}
                  onToggle={toggleDraftFeatureAccess}
                />
                {!draft.isAdmin && (
                  <>
                    <div className="permission-editor-header">
                      <span>
                        <UsersRound size={16} />
                        공유 허용 대상
                      </span>
                      <strong>{draft.allowedShareTargetUids.length}</strong>
                    </div>
                    <div className="permission-chip-grid">
                      {activeUsers.map((user) => (
                        <label key={user.uid} className="permission-chip">
                          <input
                            checked={draft.allowedShareTargetUids.includes(user.uid)}
                            onChange={(event) => toggleDraftShareTarget(user.uid, event.target.checked)}
                            type="checkbox"
                          />
                          <span className="mini-avatar" style={{ background: user.color }}>
                            {user.avatarText}
                          </span>
                          {user.displayName}
                        </label>
                      ))}
                      {activeUsers.length === 0 && <p className="muted">선택할 사용자가 없습니다.</p>}
                    </div>
                  </>
                )}
                {draft.isAdmin && <p className="admin-share-note">관리자는 모든 사용자에게 공유할 수 있습니다.</p>}
              </div>
              {notice && <p className="form-success">{notice}</p>}
              {error && <p className="form-error">{error}</p>}
              <button disabled={pending} type="submit">
                {pending ? "생성 중" : "사용자 생성"}
              </button>
            </form>
              </section>
            )}

            {activeAdminTab === "users" && (
              <section
                aria-labelledby={adminTabIds.users.tabId}
                className="panel admin-users-panel"
                id={adminTabIds.users.panelId}
                role="tabpanel"
              >
            <div className="admin-section-header">
              <h2>
                <UserRoundCog size={20} />
                사용자 목록
              </h2>
              <span className="admin-section-count">{filteredUsers.length}명</span>
            </div>
            <div className="admin-user-toolbar">
              <label className="admin-search-field">
                검색
                <span>
                  <Search size={16} />
                  <input
                    onChange={(event) => setUserSearch(event.target.value)}
                    placeholder="이름, 원 글자, 번호"
                    value={userSearch}
                  />
                </span>
              </label>
              <label>
                상태
                <AppSelect
                  onChange={(event) => setUserStatusFilter(event.target.value as UserStatusFilter)}
                  value={userStatusFilter}
                >
                  <option value="all">전체</option>
                  <option value="active">활성</option>
                  <option value="inactive">비활성</option>
                  <option value="admin">관리자</option>
                </AppSelect>
              </label>
            </div>
            <div className="admin-user-card-list">
              {filteredUsers.length ? (
                filteredUsers.map((user, index) => {
                  const orderIndex = users.findIndex((currentUser) => currentUser.uid === user.uid);

                  return (
                    <EditableUserCard
                      activeAdminCount={activeAdminCount}
                      currentUid={profile?.uid ?? ""}
                      key={user.uid}
                      index={orderIndex >= 0 ? orderIndex : index}
                      total={users.length}
                      user={user}
                      users={users}
                    />
                  );
                })
              ) : (
                <div className="empty-state">조건에 맞는 사용자가 없습니다.</div>
              )}
            </div>
              </section>
            )}
          </div>
        )}

        {activeAdminTab === "notes" && (
          <section
            aria-labelledby={adminTabIds.notes.tabId}
            className="panel wide-panel admin-note-panel"
            id={adminTabIds.notes.panelId}
            role="tabpanel"
          >
          <div className="admin-section-header">
            <h2>
              <FileText size={20} />
              노트 관리
            </h2>
            <div className="admin-note-counts">
              <span>전체 {adminNoteCounts.all}</span>
              <span>개인 {adminNoteCounts.personal}</span>
              <span>공유 {adminNoteCounts.shared}</span>
            </div>
          </div>
          <div className="admin-note-toolbar">
            <label>
              작성자
              <AppSelect value={noteOwnerFilter} onChange={(event) => setNoteOwnerFilter(event.target.value)}>
                <option value="all">전체 사용자</option>
                {users.map((user) => (
                  <option key={user.uid} value={user.uid}>
                    {user.displayName}
                  </option>
                ))}
              </AppSelect>
            </label>
            <label>
              노트 종류
              <AppSelect
                value={noteTypeFilter}
                onChange={(event) => setNoteTypeFilter(event.target.value as AdminNoteTypeFilter)}
              >
                <option value="all">전체</option>
                <option value="personal">개인 노트</option>
                <option value="shared">공유 노트</option>
              </AppSelect>
            </label>
            <label className="admin-search-field">
              검색
              <span>
                <Search size={16} />
                <input
                  onChange={(event) => setNoteSearch(event.target.value)}
                  placeholder="제목, 내용, 사용자"
                  ref={adminNoteFallbackFocusRef}
                  value={noteSearch}
                />
              </span>
            </label>
          </div>
          {noteNotice && <p className="form-success">{noteNotice}</p>}
          {noteError && <p className="form-error">{noteError}</p>}
          <div className="admin-note-list">
            {filteredAdminNotes.length ? (
              filteredAdminNotes.map((note) => {
                return (
                  <article className="admin-note-card" key={note.id}>
                    <div className="admin-note-main">
                      <div className="admin-note-title-line">
                        <span className={`note-kind-pill ${note.type === "shared" ? "shared" : ""}`}>
                          {note.type === "shared" ? "공유" : "개인"}
                        </span>
                        {!note.canReadContent && (
                          <span className="admin-note-lock">
                            <LockKeyhole size={14} />
                            본문 잠김
                          </span>
                        )}
                      </div>
                      <h3>{note.title}</h3>
                      <p className="admin-note-preview">{note.bodyPreview}</p>
                      <div className="admin-note-meta">
                        <span>
                          작성자 <strong>{userName(note.ownerUid)}</strong>
                        </span>
                        <span>{participantSummary(note)}</span>
                        <span>생성 {formatAdminDate(note.createdAt, "입력 전")}</span>
                        <span>수정 {formatAdminDate(note.updatedAt, "없음")}</span>
                      </div>
                    </div>
                    <div className="admin-note-actions">
                      <button
                        className="icon-button"
                        onClick={(event) => {
                          adminNoteDialogReturnFocusRef.current = event.currentTarget;
                          setSelectedNoteId(note.id);
                        }}
                        type="button"
                        aria-label="노트 조회"
                      >
                        <Eye size={16} />
                      </button>
                      <button
                        className="icon-button danger"
                        disabled={deletingNoteId === note.id}
                        onClick={() => void handleDeleteManagedNote(note)}
                        type="button"
                        aria-label="노트 삭제"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="empty-state">조건에 맞는 노트가 없습니다.</div>
            )}
          </div>
          </section>
        )}
              {activeAdminTab === "email" && <AdminEmailSettingsPanel />}
            </div>
          </section>
        </div>

        {selectedAdminNote && (
          <AdminNotePreviewDialog
            deleting={deletingNoteId === selectedAdminNote.id}
            fallbackFocusRef={adminNoteFallbackFocusRef}
            note={selectedAdminNote}
            onClose={() => setSelectedNoteId(null)}
            onMoveToRecovery={() => void handleDeleteManagedNote(selectedAdminNote)}
            returnFocusRef={adminNoteDialogReturnFocusRef}
            userName={userName}
          />
        )}
      </section>
    </AppShell>
  );
}

function AdminStat({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <article className="admin-stat-card">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <em>{label}</em>
      </div>
    </article>
  );
}

export function EditableUserCard({
  activeAdminCount,
  currentUid,
  user,
  users,
  index,
  total
}: {
  activeAdminCount: number;
  currentUid: string;
  user: UserProfile;
  users: UserProfile[];
  index: number;
  total: number;
}) {
  const initialUserDraft = editableUserDraft(user);
  const [draft, setDraft] = useState<UserProfile>(() => initialUserDraft);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef(initialUserDraft);
  const confirmedSignatureRef = useRef(stableEditableSignature(initialUserDraft));
  const latestSaveDraftRef = useRef<UserProfile | null>(null);
  const lastSubmittedSignatureRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const targetUids = shareTargetsOf(draft);
  const targetUsers = users.filter((targetUser) => targetUser.uid !== user.uid);
  const selectedTargetUsers = targetUsers.filter((targetUser) => targetUids.includes(targetUser.uid));

  const persistDraft = useCallback(
    async (requestedDraft: UserProfile) => {
      latestSaveDraftRef.current = requestedDraft;

      if (savingRef.current) {
        return;
      }

      savingRef.current = true;
      setPending(true);

      try {
        while (latestSaveDraftRef.current) {
          const draftToSave = latestSaveDraftRef.current;
          const validationError = editableUserValidationError(draftToSave, users);
          latestSaveDraftRef.current = null;

          if (validationError) {
            setMessage(validationError);
            continue;
          }

          const draftSignature = stableEditableSignature(draftToSave);

          if (
            draftSignature === confirmedSignatureRef.current
            && draftSignature === lastSubmittedSignatureRef.current
          ) {
            setMessage("저장됨");
            continue;
          }

          setMessage("저장 중...");
          await updateUser(updatePayloadFromDraft(draftToSave));
          lastSubmittedSignatureRef.current = draftSignature;

          if (stableEditableSignature(draftRef.current) === draftSignature) {
            setMessage("저장됨");
          }
        }
      } catch {
        setMessage("저장 실패");
      } finally {
        savingRef.current = false;
        setPending(false);

        const isDirty = stableEditableSignature(draftRef.current) !== confirmedSignatureRef.current;
        dirtyRef.current = isDirty;
        setDirty(isDirty);
      }
    },
    [users]
  );

  useEffect(() => {
    const incomingDraft = editableUserDraft(user);
    const incomingSignature = stableEditableSignature(incomingDraft);
    const currentSignature = stableEditableSignature(draftRef.current);

    confirmedSignatureRef.current = incomingSignature;

    if (!dirtyRef.current || currentSignature === incomingSignature) {
      draftRef.current = incomingDraft;
      dirtyRef.current = false;
      setDraft(incomingDraft);
      setDirty(false);
    }
  }, [user]);

  useEffect(() => {
    if (!dirty) {
      return undefined;
    }

    const validationError = editableUserValidationError(draft, users);

    if (validationError) {
      setMessage(validationError);
      return undefined;
    }

    setMessage("자동 저장 대기");
    const timer = window.setTimeout(() => void persistDraft(draft), AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [dirty, draft, persistDraft, users]);

  function updateDraft(updater: (current: UserProfile) => UserProfile, saveMode: "debounced" | "immediate" = "debounced") {
    const nextDraft = editableUserDraft(updater(draftRef.current));
    const nextSignature = stableEditableSignature(nextDraft);
    const saveHasUnconfirmedState = savingRef.current
      || latestSaveDraftRef.current !== null
      || (
        lastSubmittedSignatureRef.current !== null
        && lastSubmittedSignatureRef.current !== confirmedSignatureRef.current
      );
    const isDirty = nextSignature !== confirmedSignatureRef.current || saveHasUnconfirmedState;

    draftRef.current = nextDraft;
    dirtyRef.current = isDirty;
    setDraft(nextDraft);
    setDirty(isDirty);
    setMessage(isDirty ? (saveMode === "immediate" ? "저장 중..." : "자동 저장 대기") : "저장됨");

    if (saveMode === "immediate" && isDirty) {
      void persistDraft(nextDraft);
    }
  }

  async function move(direction: -1 | 1) {
    const nextIndex = index + direction;

    if (nextIndex < 0 || nextIndex >= total) {
      return;
    }

    const ordered = [...users];
    const [picked] = ordered.splice(index, 1);
    ordered.splice(nextIndex, 0, picked);

    setPending(true);
    setMessage(null);

    try {
      await Promise.all(
        ordered.map((orderedUser, orderIndex) =>
          updateUser(updatePayloadFromDraft(editableUserDraft({ ...orderedUser, order: orderIndex + 1 })))
        )
      );
      setMessage("순서 저장됨");
    } catch {
      setMessage("순서 변경 실패");
    } finally {
      setPending(false);
    }
  }

  async function deleteUserPermanently() {
    if (user.uid === currentUid) {
      setMessage("현재 로그인한 관리자는 삭제할 수 없습니다.");
      return;
    }

    if (user.isAdmin && user.isActive && activeAdminCount <= 1) {
      setMessage("마지막 활성 관리자는 삭제할 수 없습니다.");
      return;
    }

    const confirmed = window.confirm(
      `${user.displayName || "이 사용자"} 사용자를 영구 삭제할까요?\nFirebase Auth 계정, 앱 계정 문서, 작성한 노트/첨부파일/일정이 함께 삭제되며 되돌릴 수 없습니다.`
    );

    if (!confirmed) {
      return;
    }

    setPending(true);
    setMessage("삭제 중...");

    try {
      await deleteManagedUserDocuments(user, ({ attempt, maxAttempts }) => {
        setMessage(`삭제 데이터 정리 중... (${attempt}/${maxAttempts})`);
      });
      dirtyRef.current = false;
      latestSaveDraftRef.current = null;
      lastSubmittedSignatureRef.current = stableEditableSignature(user);
      confirmedSignatureRef.current = stableEditableSignature(user);
      setDirty(false);
      setMessage("삭제됨");
    } catch (error) {
      setMessage(managedUserDeleteUiError(error));
    } finally {
      setPending(false);
    }
  }

  function toggleShareTarget(uid: string, checked: boolean) {
    updateDraft((current) => {
      const currentTargets = shareTargetsOf(current);
      const nextTargets = checked
        ? Array.from(new Set([...currentTargets, uid]))
        : currentTargets.filter((targetUid) => targetUid !== uid && targetUid !== user.uid);

      return {
        ...current,
        allowedShareTargetUids: normalizedShareTargets(user.uid, nextTargets)
      };
    }, "immediate");
  }

  function toggleFeatureAccess(feature: AppFeature, checked: boolean) {
    updateDraft((current) => ({
      ...current,
      featureAccess: {
        ...normalizeFeatureAccess(current),
        [feature]: checked
      }
    }), "immediate");
  }

  return (
    <article className={`admin-user-card ${draft.isActive ? "" : "inactive"}`}>
      <header className="admin-user-card-header">
        <div className="user-row-avatar" style={{ background: draft.color }}>
          {draft.avatarText}
        </div>
        <div>
          <h3>{draft.displayName || "이름 없음"}</h3>
          <div className="admin-user-badges">
            <span className="admin-user-badge key">#{draft.quickKey}</span>
            <span className={`admin-user-badge ${draft.isAdmin ? "admin" : "user"}`}>
              {draft.isAdmin ? "관리자" : "사용자"}
            </span>
            <span className={`admin-user-badge ${draft.isActive ? "active" : "inactive"}`}>
              {draft.isActive ? "활성" : "비활성"}
            </span>
          </div>
          <div className="admin-user-meta-row">
            <span>생성 {formatAdminDate(draft.createdAt, "기록 없음")}</span>
            <span>수정 {formatAdminDate(draft.updatedAt, "기록 없음")}</span>
          </div>
        </div>
      </header>

      <div className="admin-user-fields">
        <label>
          이름
          <input
            aria-label="사용자 이름"
            maxLength={24}
            onChange={(event) => updateDraft((current) => ({ ...current, displayName: event.target.value }))}
            value={draft.displayName}
          />
        </label>
        <label>
          원 글자
          <input
            aria-label="원 안 글자"
            maxLength={3}
            onChange={(event) => updateDraft((current) => ({ ...current, avatarText: event.target.value.toUpperCase() }))}
            value={draft.avatarText}
          />
        </label>
        <label>
          번호
          <input
            aria-label="빠른 로그인 번호"
            min={1}
            onChange={(event) => updateDraft((current) => ({ ...current, quickKey: Number(event.target.value) }))}
            type="number"
            value={draft.quickKey}
          />
        </label>
        <label>
          색상
          <input
            aria-label="원 색상"
            onChange={(event) => updateDraft((current) => ({ ...current, color: event.target.value }))}
            type="color"
            value={draft.color}
          />
        </label>
      </div>

      <div className="admin-user-switches">
        <label className="checkbox-row">
          <input
            checked={draft.isAdmin}
            disabled={pending || user.uid === currentUid}
            onChange={(event) =>
              updateDraft(
                (current) => ({
                  ...current,
                  isAdmin: event.target.checked,
                  role: event.target.checked ? "admin" : "user",
                  featureAccess: event.target.checked
                    ? { ...defaultFeatureAccess }
                    : normalizeFeatureAccess(current),
                  allowedShareTargetUids: event.target.checked ? [user.uid] : shareTargetsOf(current)
                }),
                "immediate"
              )
            }
            type="checkbox"
          />
          관리자
        </label>
        <label className="checkbox-row">
          <input
            checked={draft.isActive}
            disabled={pending || user.uid === currentUid}
            onChange={(event) => updateDraft((current) => ({ ...current, isActive: event.target.checked }), "immediate")}
            type="checkbox"
          />
          활성
        </label>
      </div>
      {user.uid === currentUid && (
        <p className="admin-share-note">현재 로그인한 관리자의 관리자·활성 상태는 다른 관리자가 변경할 수 있습니다.</p>
      )}

      <div className="permission-editor">
        <FeatureAccessFields
          access={normalizeFeatureAccess(draft)}
          disabled={draft.isAdmin}
          onToggle={toggleFeatureAccess}
        />
        {draft.isAdmin ? (
          <p className="admin-share-note">관리자는 공유 허용 대상 설정 없이 모든 사용자에게 공유할 수 있습니다.</p>
        ) : (
          <>
            <div className="permission-editor-header">
              <span>
                <UsersRound size={16} />
                공유 허용 대상
              </span>
              <strong>{selectedTargetUsers.length}</strong>
            </div>
            <div className="permission-chip-grid">
              {targetUsers.map((targetUser) => (
                <label key={targetUser.uid} className="permission-chip">
                  <input
                    checked={targetUids.includes(targetUser.uid)}
                    onChange={(event) => toggleShareTarget(targetUser.uid, event.target.checked)}
                    type="checkbox"
                  />
                  <span className="mini-avatar" style={{ background: targetUser.color }}>
                    {targetUser.avatarText}
                  </span>
                  {targetUser.displayName}
                </label>
              ))}
              {targetUsers.length === 0 && <p className="muted">선택할 사용자가 없습니다.</p>}
            </div>
          </>
        )}
      </div>

      <footer className="admin-user-card-footer">
        <div className="row-actions">
          <button className="icon-button" disabled={pending || index === 0} onClick={() => void move(-1)} type="button" aria-label="위로">
            <ArrowUp size={16} />
          </button>
          <button
            className="icon-button"
            disabled={pending || index === total - 1}
            onClick={() => void move(1)}
            type="button"
            aria-label="아래로"
          >
            <ArrowDown size={16} />
          </button>
          <button
            className="secondary-button danger admin-user-delete-button"
            disabled={pending}
            onClick={() => void deleteUserPermanently()}
            type="button"
          >
            <Trash2 size={15} />
            삭제
          </button>
        </div>
        <p className="reset-hint">
          <UserX size={13} />
          비밀번호 강제 변경은 Admin SDK가 있는 서버를 연결하면 다시 활성화할 수 있습니다.
        </p>
        <p className={`row-message ${pending ? "saving" : dirty ? "pending" : "saved"}`}>
          {message ?? (pending ? "저장 중..." : dirty ? "자동 저장 대기" : "자동 저장")}
        </p>
      </footer>
    </article>
  );
}
