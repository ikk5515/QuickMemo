import {
  ArrowDown,
  ArrowUp,
  Eye,
  FileText,
  KeyRound,
  LockKeyhole,
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
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { decryptText, generateUserKeyBundle, unwrapNoteKey } from "../lib/crypto";
import { linkifyEditorHtml, parseEditorContent, previewTextFromHtml } from "../lib/editorContent";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { initialsFromName } from "../lib/roster";
import { createUser, deleteManagedUserDocuments, updateUser } from "../services/adminFunctions";
import { deleteNote, subscribeAllNotesForAdmin, type NoteSnapshot } from "../services/notes";
import { subscribeUsers } from "../services/users";
import type { NoteKind, UserProfile } from "../types";

const palette = ["#2f7d70", "#c75146", "#7c5b9e", "#b9822f", "#3f6fb5", "#65707a"];
const AUTO_SAVE_DELAY_MS = 550;
const adminNotePreviewMaxCharacters = 240;

interface DraftUser {
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  password: string;
  isAdmin: boolean;
  allowedShareTargetUids: string[];
}

const initialDraft: DraftUser = {
  displayName: "",
  avatarText: "",
  color: palette[0],
  quickKey: 0,
  password: "",
  isAdmin: false,
  allowedShareTargetUids: []
};

type AdminNoteTypeFilter = "all" | NoteKind;
type AdminTab = "create" | "users" | "notes";
type UserStatusFilter = "all" | "active" | "inactive" | "admin";

interface AdminNoteView extends NoteSnapshot {
  title: string;
  bodyHtml: string;
  bodyPreview: string;
  bodySearchText: string;
  fontSize: number;
  canReadContent: boolean;
  unavailableReason: string | null;
}

function adminNotePreviewText(value: string) {
  const normalizedValue = value.replace(/\s+/g, " ").trim();

  if (normalizedValue.length <= adminNotePreviewMaxCharacters) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, adminNotePreviewMaxCharacters).trimEnd()}...`;
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

function normalizedShareTargets(ownerUid: string, targetUids: string[] = []) {
  return Array.from(new Set([ownerUid, ...targetUids.filter(Boolean)]));
}

function shareTargetsOf(user: Pick<UserProfile, "uid" | "allowedShareTargetUids">) {
  return normalizedShareTargets(user.uid, user.allowedShareTargetUids ?? []);
}

function persistedShareTargetsOf(user: Pick<UserProfile, "uid" | "isAdmin" | "allowedShareTargetUids">) {
  return user.isAdmin ? [user.uid] : shareTargetsOf(user);
}

function editableUserDraft(user: UserProfile) {
  return {
    ...user,
    role: user.isAdmin ? ("admin" as const) : ("user" as const),
    allowedShareTargetUids: persistedShareTargetsOf(user)
  };
}

function stableEditableSignature(user: UserProfile) {
  const shareTargets = persistedShareTargetsOf(user);
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

  if (draft.password.length < 6) {
    return "초기 비밀번호는 6자 이상 입력해주세요.";
  }

  if (users.some((user) => user.displayName.trim().toLowerCase() === displayName.toLowerCase())) {
    return "이미 사용 중인 사용자 이름입니다.";
  }

  if (users.some((user) => user.quickKey === quickKey)) {
    return "이미 사용 중인 빠른 로그인 번호입니다.";
  }

  return null;
}

function updatePayloadFromDraft(user: UserProfile) {
  return {
    uid: user.uid,
    displayName: user.displayName,
    avatarText: user.avatarText,
    color: user.color,
    quickKey: Number(user.quickKey),
    order: Number(user.order),
    isActive: user.isActive,
    isAdmin: user.isAdmin,
    allowedShareTargetUids: persistedShareTargetsOf(user)
  };
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

  useEffect(() => {
    return subscribeUsers(setUsers, () => setError("사용자 목록을 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    if (!profile?.isAdmin) {
      setNotes([]);
      return undefined;
    }

    return subscribeAllNotesForAdmin(setNotes, () => setNoteError("노트 목록을 불러오지 못했습니다."));
  }, [profile?.isAdmin]);

  useEffect(() => {
    let cancelled = false;

    async function decryptAdminNotes() {
      const nextNotes = await Promise.all(
        notes.map(async (note) => {
          const lockedReason = privateKey
            ? "관리자가 공유 대상에 포함되지 않아 본문을 복호화할 수 없습니다."
            : "암호화 키가 잠겨 있어 본문을 표시할 수 없습니다.";
          const fallback: AdminNoteView = {
            ...note,
            title: "암호화된 노트",
            bodyHtml: "",
            bodyPreview: lockedReason,
            bodySearchText: lockedReason,
            fontSize: 17,
            canReadContent: false,
            unavailableReason: lockedReason
          };

          if (!profile || !privateKey) {
            return fallback;
          }

          const wrappedKey = note.wrappedKeys[profile.uid];

          if (!wrappedKey) {
            return fallback;
          }

          try {
            const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
            const [title, body] = await Promise.all([
              decryptText(note.encryptedTitle, noteKey),
              decryptText(note.encryptedBody, noteKey)
            ]);
            const parsedBody = parseEditorContent(body);
            const previewText = previewTextFromHtml(body);
            const emptyPreviewText = /<img\b/i.test(parsedBody.html) ? "이미지가 포함된 노트" : "본문 없음";

            return {
              ...note,
              title,
              bodyHtml: parsedBody.html,
              bodyPreview: adminNotePreviewText(previewText) || emptyPreviewText,
              bodySearchText: previewText || emptyPreviewText,
              fontSize: parsedBody.fontSize,
              canReadContent: true,
              unavailableReason: null
            } satisfies AdminNoteView;
          } catch {
            return {
              ...fallback,
              title: "복호화할 수 없는 노트",
              bodyPreview: "키가 변경되었거나 이 계정으로 열 수 없는 노트입니다.",
              bodySearchText: "키가 변경되었거나 이 계정으로 열 수 없는 노트입니다.",
              unavailableReason: "키가 변경되었거나 이 계정으로 열 수 없는 노트입니다."
            };
          }
        })
      );

      if (!cancelled) {
        setAdminNoteViews(nextNotes);
      }
    }

    void decryptAdminNotes();

    return () => {
      cancelled = true;
    };
  }, [notes, privateKey, profile]);

  useEffect(() => {
    if (selectedNoteId && !adminNoteViews.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(null);
    }
  }, [adminNoteViews, selectedNoteId]);

  useEffect(() => {
    if (!selectedNoteId) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedNoteId(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNoteId]);

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

  async function handleDeleteManagedNote(note: AdminNoteView) {
    if (!profile) {
      setNoteError("관리자 정보를 확인하지 못했습니다.");
      return;
    }

    const currentProfile = profile;
    const readableTitle = note.canReadContent ? note.title : "암호화된 노트";
    const confirmed = window.confirm(
      `${userName(note.ownerUid)} 사용자의 "${readableTitle}" 노트를 삭제할까요?\n삭제하면 복구할 수 없습니다.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingNoteId(note.id);
    setNoteNotice(null);
    setNoteError(null);

    try {
      await deleteNote(note.id, currentProfile.uid, note.participantUids);
      setSelectedNoteId(null);
      setNoteNotice("노트를 삭제했습니다.");
    } catch {
      setNoteError("노트를 삭제하지 못했습니다. 권한 또는 네트워크 상태를 확인해주세요.");
    } finally {
      setDeletingNoteId(null);
    }
  }

  return (
    <AppShell>
      <section className="workspace admin-workspace">
        <div className="workspace-heading">
          <div>
            <div className="section-kicker">
              <ShieldCheck size={18} />
              관리자 페이지
            </div>
            <h1>사용자, 공유 권한, 노트를 관리합니다</h1>
          </div>
        </div>

        <section className="admin-stats-grid" aria-label="관리 현황">
          <AdminStat icon={<UsersRound size={18} />} label="전체 사용자" value={adminStats.totalUsers} />
          <AdminStat icon={<UserCheck size={18} />} label="활성 사용자" value={adminStats.activeUsers} />
          <AdminStat icon={<ShieldCheck size={18} />} label="관리자" value={adminStats.admins} />
          <AdminStat icon={<KeyRound size={18} />} label="공유 허용" value={adminStats.shareLinks} />
        </section>

        <div className="admin-tabs" role="tablist" aria-label="관리자 기능">
          <button
            aria-selected={activeAdminTab === "create"}
            className={activeAdminTab === "create" ? "active" : ""}
            onClick={() => setActiveAdminTab("create")}
            role="tab"
            type="button"
          >
            <Plus size={16} />
            사용자 추가
          </button>
          <button
            aria-selected={activeAdminTab === "users"}
            className={activeAdminTab === "users" ? "active" : ""}
            onClick={() => setActiveAdminTab("users")}
            role="tab"
            type="button"
          >
            <UserRoundCog size={16} />
            사용자 목록
          </button>
          <button
            aria-selected={activeAdminTab === "notes"}
            className={activeAdminTab === "notes" ? "active" : ""}
            onClick={() => setActiveAdminTab("notes")}
            role="tab"
            type="button"
          >
            <FileText size={16} />
            노트 관리
          </button>
        </div>

        {activeAdminTab !== "notes" && (
          <div className={`admin-management-grid ${activeAdminTab === "users" ? "single-panel" : ""}`}>
            {activeAdminTab === "create" && (
              <section className="panel admin-create-panel">
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
                  minLength={6}
                  onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
                  required
                  type="password"
                  value={draft.password}
                />
              </label>
              <label className="checkbox-row">
                <input
                  checked={draft.isAdmin}
                  onChange={(event) => setDraft((current) => ({ ...current, isAdmin: event.target.checked }))}
                  type="checkbox"
                />
                관리자 권한
              </label>
              {!draft.isAdmin && activeUsers.length > 0 && (
                <div className="permission-editor create-permission-editor">
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
                  </div>
                </div>
              )}
              {draft.isAdmin && <p className="admin-share-note">관리자는 모든 사용자에게 공유할 수 있습니다.</p>}
              {notice && <p className="form-success">{notice}</p>}
              {error && <p className="form-error">{error}</p>}
              <button disabled={pending} type="submit">
                {pending ? "생성 중" : "사용자 생성"}
              </button>
            </form>
              </section>
            )}

            {activeAdminTab === "users" && (
              <section className="panel admin-users-panel">
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
                <select
                  onChange={(event) => setUserStatusFilter(event.target.value as UserStatusFilter)}
                  value={userStatusFilter}
                >
                  <option value="all">전체</option>
                  <option value="active">활성</option>
                  <option value="inactive">비활성</option>
                  <option value="admin">관리자</option>
                </select>
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
          <section className="panel wide-panel admin-note-panel">
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
              <select value={noteOwnerFilter} onChange={(event) => setNoteOwnerFilter(event.target.value)}>
                <option value="all">전체 사용자</option>
                {users.map((user) => (
                  <option key={user.uid} value={user.uid}>
                    {user.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              노트 종류
              <select
                value={noteTypeFilter}
                onChange={(event) => setNoteTypeFilter(event.target.value as AdminNoteTypeFilter)}
              >
                <option value="all">전체</option>
                <option value="personal">개인 노트</option>
                <option value="shared">공유 노트</option>
              </select>
            </label>
            <label className="admin-search-field">
              검색
              <span>
                <Search size={16} />
                <input
                  onChange={(event) => setNoteSearch(event.target.value)}
                  placeholder="제목, 내용, 사용자"
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
                        onClick={() => setSelectedNoteId(note.id)}
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
        {selectedAdminNote && (
          <div className="modal-backdrop" role="presentation">
            <article
              className="note-preview-modal admin-note-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="admin-note-modal-title"
            >
              <header className="note-preview-header">
                <div>
                  <div className="note-preview-kicker">
                    {selectedAdminNote.type === "shared" ? "공유 노트" : "개인 노트"} · 작성자{" "}
                    {userName(selectedAdminNote.ownerUid)}
                  </div>
                  <h2 id="admin-note-modal-title">{selectedAdminNote.title}</h2>
                  <div className="admin-note-modal-meta">
                    <span>생성 {formatAdminDate(selectedAdminNote.createdAt, "입력 전")}</span>
                    <span>수정 {formatAdminDate(selectedAdminNote.updatedAt, "없음")}</span>
                  </div>
                </div>
                <div className="note-preview-actions">
                  <button
                    className="secondary-button danger"
                    disabled={deletingNoteId === selectedAdminNote.id}
                    onClick={() => void handleDeleteManagedNote(selectedAdminNote)}
                    type="button"
                  >
                    삭제
                  </button>
                  <button className="icon-button" onClick={() => setSelectedNoteId(null)} type="button" aria-label="닫기">
                    <X size={18} />
                  </button>
                </div>
              </header>
              <div className="note-preview-body">
                {selectedAdminNote.canReadContent ? (
                  <div
                    className="admin-note-view-body"
                    style={{ fontSize: selectedAdminNote.fontSize }}
                    dangerouslySetInnerHTML={{
                      __html: linkifyEditorHtml(selectedAdminNote.bodyHtml || "<p>본문 없음</p>")
                    }}
                  />
                ) : (
                  <div className="admin-note-locked">
                    <LockKeyhole size={18} />
                    {selectedAdminNote.unavailableReason}
                  </div>
                )}
              </div>
            </article>
          </div>
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

function EditableUserCard({
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
            draftSignature === confirmedSignatureRef.current ||
            draftSignature === lastSubmittedSignatureRef.current
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
    const isDirty = nextSignature !== confirmedSignatureRef.current;

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
      setMessage(error instanceof Error ? error.message : "삭제 실패");
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
            onChange={(event) =>
              updateDraft(
                (current) => ({
                  ...current,
                  isAdmin: event.target.checked,
                  role: event.target.checked ? "admin" : "user",
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
            onChange={(event) => updateDraft((current) => ({ ...current, isActive: event.target.checked }), "immediate")}
            type="checkbox"
          />
          활성
        </label>
      </div>

      {draft.isAdmin ? (
        <p className="admin-share-note">관리자는 공유 허용 대상 설정 없이 모든 사용자에게 공유할 수 있습니다.</p>
      ) : (
        <div className="permission-editor">
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
        </div>
      )}

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
