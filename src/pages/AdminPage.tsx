import {
  ArrowDown,
  ArrowUp,
  Eye,
  FileText,
  LockKeyhole,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UserRoundCog,
  X
} from "lucide-react";
import type { Timestamp } from "firebase/firestore";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../context/AuthContext";
import { decryptText, generateUserKeyBundle, unwrapNoteKey } from "../lib/crypto";
import { parseEditorContent, previewTextFromHtml } from "../lib/editorContent";
import { firebaseAuthErrorMessage } from "../lib/firebaseErrors";
import { initialsFromName } from "../lib/roster";
import { createUser, updateUser } from "../services/adminFunctions";
import { deleteNote, subscribeAllNotesForAdmin, type NoteSnapshot } from "../services/notes";
import { subscribeUsers } from "../services/users";
import type { NoteKind, UserProfile } from "../types";

const palette = ["#2f7d70", "#c75146", "#7c5b9e", "#b9822f", "#3f6fb5", "#65707a"];

interface DraftUser {
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  password: string;
  isAdmin: boolean;
}

const initialDraft: DraftUser = {
  displayName: "",
  avatarText: "",
  color: palette[0],
  quickKey: 0,
  password: "",
  isAdmin: false
};

type AdminNoteTypeFilter = "all" | NoteKind;

interface AdminNoteView extends NoteSnapshot {
  title: string;
  bodyHtml: string;
  bodyPreview: string;
  fontSize: number;
  canReadContent: boolean;
  unavailableReason: string | null;
}

function formatAdminDate(timestamp: Timestamp | null | undefined, emptyText = "없음") {
  const date = timestamp?.toDate();

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

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function deadlineDDay(timestamp: Timestamp | null | undefined) {
  const date = timestamp?.toDate();

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

export default function AdminPage() {
  const { profile, privateKey } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [adminNoteViews, setAdminNoteViews] = useState<AdminNoteView[]>([]);
  const [noteOwnerFilter, setNoteOwnerFilter] = useState("all");
  const [noteTypeFilter, setNoteTypeFilter] = useState<AdminNoteTypeFilter>("all");
  const [noteSearch, setNoteSearch] = useState("");
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

            return {
              ...note,
              title,
              bodyHtml: parsedBody.html,
              bodyPreview: previewText || (/<img\b/i.test(parsedBody.html) ? "이미지가 포함된 노트" : "본문 없음"),
              fontSize: parsedBody.fontSize,
              canReadContent: true,
              unavailableReason: null
            } satisfies AdminNoteView;
          } catch {
            return {
              ...fallback,
              title: "복호화할 수 없는 노트",
              bodyPreview: "키가 변경되었거나 이 계정으로 열 수 없는 노트입니다.",
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

      return [note.title, note.bodyPreview, ownerName, participants]
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
        keyBundle
      });
      setDraft({ ...initialDraft, quickKey: nextQuickKey + 1, color: palette[users.length % palette.length] });
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

  async function handleDeleteManagedNote(note: AdminNoteView) {
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
      await deleteNote(note.id);
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
            <h1>사용자와 로그인 순서를 관리합니다</h1>
          </div>
        </div>
        <div className="admin-grid">
          <section className="panel">
            <h2>
              <Plus size={20} />
              사용자 추가
            </h2>
            <form className="form-grid" onSubmit={handleCreateUser}>
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
              <label>
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
                관리자 권한 부여
              </label>
              {notice && <p className="form-success">{notice}</p>}
              {error && <p className="form-error">{error}</p>}
              <button disabled={pending} type="submit">
                {pending ? "생성 중" : "사용자 생성"}
              </button>
            </form>
          </section>
          <section className="panel wide-panel">
            <h2>
              <UserRoundCog size={20} />
              사용자 목록
            </h2>
            <div className="user-table">
              {users.map((user, index) => (
                <EditableUserRow key={user.uid} index={index} total={users.length} user={user} users={users} />
              ))}
            </div>
          </section>
        </div>
        <section className="panel wide-panel admin-note-panel">
          <div className="admin-note-heading">
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
            <label className="admin-note-search">
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
                const dueLabel = deadlineDDay(note.dueAt);

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
                        {note.dueAt && (
                          <span>
                            마감 {formatAdminDate(note.dueAt)}
                            {dueLabel ? ` · ${dueLabel}` : ""}
                          </span>
                        )}
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
        {selectedAdminNote && (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <article className="note-preview-modal admin-note-modal">
              <header className="note-preview-header">
                <div>
                  <div className="note-preview-kicker">
                    {selectedAdminNote.type === "shared" ? "공유 노트" : "개인 노트"} · 작성자{" "}
                    {userName(selectedAdminNote.ownerUid)}
                  </div>
                  <h2>{selectedAdminNote.title}</h2>
                  <div className="admin-note-modal-meta">
                    <span>생성 {formatAdminDate(selectedAdminNote.createdAt, "입력 전")}</span>
                    <span>수정 {formatAdminDate(selectedAdminNote.updatedAt, "없음")}</span>
                    {selectedAdminNote.dueAt && (
                      <span>
                        마감 {formatAdminDate(selectedAdminNote.dueAt)}
                        {deadlineDDay(selectedAdminNote.dueAt) ? ` · ${deadlineDDay(selectedAdminNote.dueAt)}` : ""}
                      </span>
                    )}
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
                      __html: selectedAdminNote.bodyHtml || "<p>본문 없음</p>"
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

function EditableUserRow({
  user,
  users,
  index,
  total
}: {
  user: UserProfile;
  users: UserProfile[];
  index: number;
  total: number;
}) {
  const [draft, setDraft] = useState(user);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(user);
  }, [user]);

  async function handleSave() {
    setPending(true);
    setMessage(null);

    try {
      await updateUser({
        uid: user.uid,
        displayName: draft.displayName,
        avatarText: draft.avatarText,
        color: draft.color,
        quickKey: Number(draft.quickKey),
        order: Number(draft.order),
        isActive: draft.isActive,
        isAdmin: draft.isAdmin
      });
      setMessage("저장됨");
    } catch {
      setMessage("저장 실패");
    } finally {
      setPending(false);
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
          updateUser({
            uid: orderedUser.uid,
            displayName: orderedUser.displayName,
            avatarText: orderedUser.avatarText,
            color: orderedUser.color,
            quickKey: orderedUser.quickKey,
            order: orderIndex + 1,
            isActive: orderedUser.isActive,
            isAdmin: orderedUser.isAdmin
          })
        )
      );
      setMessage("순서 저장됨");
    } catch {
      setMessage("순서 변경 실패");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="user-row">
      <div className="user-row-avatar" style={{ background: draft.color }}>
        {draft.avatarText}
      </div>
      <div className="user-row-fields">
        <input
          aria-label="사용자 이름"
          maxLength={24}
          onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
          value={draft.displayName}
        />
        <input
          aria-label="원 안 글자"
          maxLength={3}
          onChange={(event) => setDraft((current) => ({ ...current, avatarText: event.target.value.toUpperCase() }))}
          value={draft.avatarText}
        />
        <input
          aria-label="빠른 로그인 번호"
          min={1}
          onChange={(event) => setDraft((current) => ({ ...current, quickKey: Number(event.target.value) }))}
          type="number"
          value={draft.quickKey}
        />
        <input
          aria-label="원 색상"
          onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
          type="color"
          value={draft.color}
        />
      </div>
      <div className="user-row-toggles">
        <label className="checkbox-row">
          <input
            checked={draft.isAdmin}
            onChange={(event) => setDraft((current) => ({ ...current, isAdmin: event.target.checked }))}
            type="checkbox"
          />
          관리자
        </label>
        <label className="checkbox-row">
          <input
            checked={draft.isActive}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
            type="checkbox"
          />
          활성
        </label>
      </div>
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
        <button className="icon-button" disabled={pending} onClick={() => void handleSave()} type="button" aria-label="저장">
          <Save size={16} />
        </button>
      </div>
      <p className="reset-hint">
        비밀번호 강제 변경은 Admin SDK가 있는 서버를 연결하면 다시 활성화할 수 있습니다.
      </p>
      {message && <p className="row-message">{message}</p>}
    </article>
  );
}
