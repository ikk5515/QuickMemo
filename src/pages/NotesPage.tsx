import {
  FilePlus2,
  ListChecks,
  Loader2,
  Save,
  Share2,
  Trash2,
  UsersRound
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import {
  decryptText,
  generateNoteKey,
  unwrapNoteKey,
  wrapNoteKey,
  encryptText
} from "../lib/crypto";
import {
  createEncryptedNote,
  deleteNote,
  subscribeVisibleNotes,
  updateEncryptedNote,
  type NoteSnapshot
} from "../services/notes";
import { subscribeUsers } from "../services/users";
import type { DecryptedNote, NoteKind, UserProfile } from "../types";

interface EditorState {
  noteId: string | null;
  title: string;
  body: string;
  type: NoteKind;
  participantUids: string[];
  noteKey: CryptoKey | null;
  dirty: boolean;
}

const blankEditor = (uid: string): EditorState => ({
  noteId: null,
  title: "",
  body: "",
  type: "personal",
  participantUids: [uid],
  noteKey: null,
  dirty: false
});

export default function NotesPage() {
  const { profile, privateKey } = useAuth();
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [decryptedNotes, setDecryptedNotes] = useState<DecryptedNote[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [editor, setEditor] = useState<EditorState>(() => blankEditor(profile?.uid ?? ""));
  const [status, setStatus] = useState("준비됨");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const autosaveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!profile) {
      return undefined;
    }

    return subscribeVisibleNotes(profile.uid, setNotes, () => setError("노트 목록을 불러오지 못했습니다."));
  }, [profile]);

  useEffect(() => {
    return subscribeUsers(setUsers, () => setError("사용자 목록을 불러오지 못했습니다."));
  }, []);

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
      const nextNotes = await Promise.all(
        notes.map(async (note) => {
          const wrappedKey = note.wrappedKeys[safeProfile.uid];

          if (!wrappedKey) {
            return null;
          }

          try {
            const noteKey = await unwrapNoteKey(wrappedKey, safePrivateKey);
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

      if (!cancelled) {
        setDecryptedNotes(nextNotes.filter((note): note is DecryptedNote => Boolean(note)));
      }
    }

    void decryptNotes();
    return () => {
      cancelled = true;
    };
  }, [notes, privateKey, profile]);

  useEffect(() => {
    if (!editor.noteId || !editor.noteKey || !editor.dirty || !profile) {
      return undefined;
    }

    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }

    autosaveTimer.current = window.setTimeout(() => {
      void saveCurrentNote(false);
    }, 900);

    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
    // saveCurrentNote reads the current render state; adding it here restarts the debounce on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.title, editor.body, editor.dirty, editor.noteId, editor.noteKey, profile]);

  const activeUsers = useMemo(
    () => users.filter((user) => user.isActive && user.publicKeyJwk),
    [users]
  );
  const personalNotes = decryptedNotes.filter((note) => note.type === "personal");
  const sharedNotes = decryptedNotes.filter((note) => note.type === "shared");

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

  function updateEditor(field: "title" | "body", value: string) {
    setEditor((current) => ({ ...current, [field]: value, dirty: true }));
  }

  async function openNote(note: DecryptedNote) {
    const rawNote = notes.find((current) => current.id === note.id);

    if (!rawNote) {
      return;
    }

    try {
      const noteKey = await unwrapNoteKey(rawNote.wrappedKeys[unlockedProfile.uid], unlockedPrivateKey);
      setEditor({
        noteId: note.id,
        title: note.title,
        body: note.body,
        type: note.type,
        participantUids: note.participantUids,
        noteKey,
        dirty: false
      });
      setStatus("노트를 열었습니다.");
      setError(null);
    } catch {
      setError("이 노트를 열 수 없습니다.");
    }
  }

  function startNewNote(type: NoteKind = "personal") {
    setEditor({
      ...blankEditor(unlockedProfile.uid),
      type,
      participantUids: type === "shared" ? [unlockedProfile.uid] : [unlockedProfile.uid]
    });
    setStatus("새 노트 작성 중");
    setError(null);
  }

  function toggleParticipant(event: ChangeEvent<HTMLInputElement>) {
    const uid = event.target.value;

    setEditor((current) => {
      const participantUids = event.target.checked
        ? Array.from(new Set([...current.participantUids, uid, unlockedProfile.uid]))
        : current.participantUids.filter(
            (participantUid) => participantUid !== uid || participantUid === unlockedProfile.uid
          );

      return { ...current, participantUids, dirty: true };
    });
  }

  async function buildEncryptedPayload(noteKey: CryptoKey) {
    const [encryptedTitle, encryptedBody] = await Promise.all([
      encryptText(editor.title.trim() || "제목 없음", noteKey),
      encryptText(editor.body, noteKey)
    ]);

    return { encryptedTitle, encryptedBody };
  }

  async function saveCurrentNote(showSavedMessage = true) {
    if (saving) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (editor.noteId && editor.noteKey) {
        const payload = await buildEncryptedPayload(editor.noteKey);
        await updateEncryptedNote(editor.noteId, unlockedProfile.uid, payload.encryptedTitle, payload.encryptedBody);
        setEditor((current) => ({ ...current, dirty: false }));
        setStatus(showSavedMessage ? "변경 사항을 저장했습니다." : "자동 저장됨");
        return;
      }

      const noteKey = await generateNoteKey();
      const payload = await buildEncryptedPayload(noteKey);
      const participantUids =
        editor.type === "personal"
          ? [unlockedProfile.uid]
          : Array.from(new Set([unlockedProfile.uid, ...editor.participantUids]));
      const participantProfiles = activeUsers.filter((user) => participantUids.includes(user.uid));
      const wrappedKeys = Object.fromEntries(
        await Promise.all(
          participantProfiles.map(async (user) => [user.uid, await wrapNoteKey(noteKey, user.publicKeyJwk)] as const)
        )
      );

      if (!wrappedKeys[unlockedProfile.uid]) {
        wrappedKeys[unlockedProfile.uid] = await wrapNoteKey(noteKey, unlockedProfile.publicKeyJwk);
      }

      const created = await createEncryptedNote({
        type: editor.type,
        ownerUid: unlockedProfile.uid,
        participantUids,
        encryptedTitle: payload.encryptedTitle,
        encryptedBody: payload.encryptedBody,
        wrappedKeys
      });

      setEditor((current) => ({ ...current, noteId: created.id, noteKey, dirty: false }));
      setStatus("노트를 저장 목록에 추가했습니다.");
    } catch {
      setError("노트를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrentNote() {
    if (!editor.noteId) {
      startNewNote(editor.type);
      return;
    }

    setSaving(true);

    try {
      await deleteNote(editor.noteId);
      startNewNote("personal");
      setStatus("노트를 삭제했습니다.");
    } catch {
      setError("노트를 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <section className="workspace notes-workspace">
        <aside className="note-sidebar">
          <div className="sidebar-actions">
            <button type="button" onClick={() => startNewNote("personal")}>
              <FilePlus2 size={18} />
              개인 노트
            </button>
            <button className="secondary-button" type="button" onClick={() => startNewNote("shared")}>
              <Share2 size={18} />
              공유 노트
            </button>
          </div>
          <NoteList title="저장된 개인 노트" icon={<ListChecks size={18} />} notes={personalNotes} onOpen={openNote} />
          <NoteList title="공유 노트" icon={<UsersRound size={18} />} notes={sharedNotes} onOpen={openNote} />
        </aside>
        <section className="editor-panel">
          <div className="editor-toolbar">
            <div className="segmented-control" aria-label="노트 유형">
              <button
                className={editor.type === "personal" ? "active" : ""}
                disabled={Boolean(editor.noteId)}
            onClick={() =>
              setEditor((current) => ({ ...current, type: "personal", participantUids: [unlockedProfile.uid] }))
            }
                type="button"
              >
                개인
              </button>
              <button
                className={editor.type === "shared" ? "active" : ""}
                disabled={Boolean(editor.noteId)}
            onClick={() =>
              setEditor((current) => ({ ...current, type: "shared", participantUids: [unlockedProfile.uid] }))
            }
                type="button"
              >
                공유
              </button>
            </div>
            <div className="toolbar-actions">
              <span className="sync-status">{saving ? "저장 중..." : status}</span>
              <button disabled={saving} onClick={() => void saveCurrentNote(true)} type="button">
                {saving ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
                저장
              </button>
              <button
                className="icon-button danger"
                disabled={saving}
                onClick={() => void removeCurrentNote()}
                type="button"
                aria-label="노트 삭제"
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>
          {editor.type === "shared" && (
            <div className="share-strip">
              {activeUsers.map((user) => (
                <label key={user.uid} className="share-user">
                  <input
                    checked={editor.participantUids.includes(user.uid)}
                    disabled={Boolean(editor.noteId) || user.uid === unlockedProfile.uid}
                    onChange={toggleParticipant}
                    type="checkbox"
                    value={user.uid}
                  />
                  <span className="mini-avatar" style={{ background: user.color }}>
                    {user.avatarText}
                  </span>
                  {user.displayName}
                </label>
              ))}
            </div>
          )}
          <input
            className="title-input"
            onChange={(event) => updateEditor("title", event.target.value)}
            placeholder="노트 제목"
            value={editor.title}
          />
          <textarea
            className="body-input"
            onChange={(event) => updateEditor("body", event.target.value)}
            placeholder="메모를 입력하세요..."
            value={editor.body}
          />
          {error && <p className="form-error">{error}</p>}
        </section>
      </section>
    </AppShell>
  );
}

function NoteList({
  title,
  icon,
  notes,
  onOpen
}: {
  title: string;
  icon: ReactNode;
  notes: DecryptedNote[];
  onOpen: (note: DecryptedNote) => Promise<void>;
}) {
  return (
    <section className="note-list-section">
      <h2>
        {icon}
        {title}
      </h2>
      {notes.length === 0 ? (
        <p className="muted">아직 저장된 노트가 없습니다.</p>
      ) : (
        <div className="note-list">
          {notes.map((note) => (
            <button key={note.id} className="note-list-item" type="button" onClick={() => void onOpen(note)}>
              <strong>{note.title || "제목 없음"}</strong>
              <span>{note.body || "내용 없음"}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
