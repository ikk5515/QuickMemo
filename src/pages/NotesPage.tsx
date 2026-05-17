import {
  FilePlus2,
  ListChecks,
  Loader2,
  PanelRightOpen,
  Pencil,
  Save,
  Share2,
  Trash2,
  UsersRound,
  X
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import {
  decryptText,
  encryptText,
  generateNoteKey,
  unwrapNoteKey,
  wrapNoteKey
} from "../lib/crypto";
import {
  imageHtml,
  parseEditorContent,
  previewTextFromHtml,
  sanitizeEditorHtml,
  serializeEditorContent
} from "../lib/editorContent";
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
  fontSize: number;
  dirty: boolean;
}

const blankEditor = (uid: string): EditorState => ({
  noteId: null,
  title: "",
  body: "",
  type: "personal",
  participantUids: [uid],
  noteKey: null,
  fontSize: 17,
  dirty: false
});

const fontSizes = [14, 16, 17, 18, 20, 22, 24, 28];
const maxImageDataUrlLength = 760_000;

export default function NotesPage() {
  const { profile, privateKey } = useAuth();
  const [notes, setNotes] = useState<NoteSnapshot[]>([]);
  const [decryptedNotes, setDecryptedNotes] = useState<DecryptedNote[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [editor, setEditor] = useState<EditorState>(() => blankEditor(profile?.uid ?? ""));
  const [status, setStatus] = useState("준비됨");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  const memoEditorRef = useRef<HTMLDivElement | null>(null);

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
  }, [editor.title, editor.body, editor.fontSize, editor.dirty, editor.noteId, editor.noteKey, profile]);

  const activeUsers = useMemo(
    () => users.filter((user) => user.isActive && user.publicKeyJwk),
    [users]
  );
  const previewNote = useMemo(
    () => decryptedNotes.find((note) => note.id === previewNoteId) ?? null,
    [decryptedNotes, previewNoteId]
  );

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
  const currentType: NoteKind = editor.participantUids.length > 1 ? "shared" : "personal";

  function updateEditor(field: "title" | "body", value: string) {
    setEditor((current) => ({ ...current, [field]: value, dirty: true }));
  }

  function updateFontSize(fontSize: number) {
    setEditor((current) => ({ ...current, fontSize, dirty: true }));
  }

  async function openNote(note: DecryptedNote) {
    const rawNote = notes.find((current) => current.id === note.id);

    if (!rawNote) {
      return;
    }

    try {
      const noteKey = await unwrapNoteKey(rawNote.wrappedKeys[unlockedProfile.uid], unlockedPrivateKey);
      const parsedBody = parseEditorContent(note.body);

      setEditor({
        noteId: note.id,
        title: note.title,
        body: parsedBody.html,
        type: note.type,
        participantUids: note.participantUids,
        noteKey,
        fontSize: parsedBody.fontSize,
        dirty: false
      });
      setListOpen(false);
      setShareOpen(false);
      setPreviewNoteId(null);
      setStatus("노트를 열었습니다.");
      setError(null);
    } catch {
      setError("이 노트를 열 수 없습니다.");
    }
  }

  function startNewNote() {
    setEditor(blankEditor(unlockedProfile.uid));
    setShareOpen(false);
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

      return {
        ...current,
        participantUids,
        type: participantUids.length > 1 ? "shared" : "personal",
        dirty: true
      };
    });
  }

  async function buildEncryptedPayload(noteKey: CryptoKey) {
    const [encryptedTitle, encryptedBody] = await Promise.all([
      encryptText(editor.title.trim() || "제목 없음", noteKey),
      encryptText(serializeEditorContent(editor.body, editor.fontSize), noteKey)
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
      const participantUids = Array.from(new Set([unlockedProfile.uid, ...editor.participantUids]));
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
        type: participantUids.length > 1 ? "shared" : "personal",
        ownerUid: unlockedProfile.uid,
        participantUids,
        encryptedTitle: payload.encryptedTitle,
        encryptedBody: payload.encryptedBody,
        wrappedKeys
      });

      setEditor((current) => ({
        ...current,
        noteId: created.id,
        noteKey,
        type: participantUids.length > 1 ? "shared" : "personal",
        dirty: false
      }));
      setStatus("노트를 저장 목록에 추가했습니다.");
    } catch {
      setError("노트를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrentNote() {
    if (!editor.noteId) {
      startNewNote();
      return;
    }

    setSaving(true);

    try {
      await deleteNote(editor.noteId);
      startNewNote();
      setStatus("노트를 삭제했습니다.");
    } catch {
      setError("노트를 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function removePreviewNote(note: DecryptedNote) {
    if (note.ownerUid !== unlockedProfile.uid) {
      setError("노트 소유자만 삭제할 수 있습니다.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await deleteNote(note.id);
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
                disabled={saving}
                onClick={() => void removeCurrentNote()}
                type="button"
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>
          {shareOpen && (
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
          <RichMemoEditor
            editorRef={memoEditorRef}
            fontSize={editor.fontSize}
            onImagePaste={(file, range) => void insertImageFile(file, range)}
            onChange={(value) => updateEditor("body", value)}
            value={editor.body}
          />
          <div className="editor-footer">
            <span className={`note-kind-pill ${currentType}`}>{currentType === "shared" ? "공유" : "개인"}</span>
            {error && <p className="form-error">{error}</p>}
          </div>
        </section>
        <NoteDrawer
          activeNoteId={editor.noteId}
          notes={decryptedNotes}
          onClose={() => setListOpen(false)}
          onNew={startNewNote}
          onPreview={(note) => setPreviewNoteId(note.id)}
          open={listOpen}
        />
        {previewNote && (
          <NotePreviewModal
            canDelete={previewNote.ownerUid === unlockedProfile.uid}
            note={previewNote}
            onClose={() => setPreviewNoteId(null)}
            onDelete={(note) => void removePreviewNote(note)}
            onEdit={(note) => void openNote(note)}
            saving={saving}
          />
        )}
      </section>
    </AppShell>
  );
}

function RichMemoEditor({
  editorRef,
  fontSize,
  onImagePaste,
  onChange,
  value
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  fontSize: number;
  onImagePaste: (file: File, range: Range | null) => void;
  onChange: (value: string) => void;
  value: string;
}) {
  useEffect(() => {
    const element = editorRef.current;

    if (!element || document.activeElement === element || element.innerHTML === value) {
      return;
    }

    element.innerHTML = value;
  }, [editorRef, value]);

  function handleInput() {
    onChange(editorRef.current?.innerHTML ?? "");
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const imageFile = Array.from(event.clipboardData.items)
      .find((item) => item.type.startsWith("image/"))
      ?.getAsFile();

    if (imageFile) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      event.preventDefault();
      onImagePaste(imageFile, range);
      return;
    }

    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    handleInput();
  }

  return (
    <div
      ref={editorRef}
      className="rich-body-input"
      contentEditable
      data-placeholder="메모를 입력하세요..."
      onInput={handleInput}
      onPaste={handlePaste}
      role="textbox"
      style={{ fontSize }}
      suppressContentEditableWarning
    />
  );
}

function NoteDrawer({
  activeNoteId,
  notes,
  onClose,
  onNew,
  onPreview,
  open
}: {
  activeNoteId: string | null;
  notes: DecryptedNote[];
  onClose: () => void;
  onNew: () => void;
  onPreview: (note: DecryptedNote) => void;
  open: boolean;
}) {
  if (!open) {
    return null;
  }

  return (
    <aside className="note-drawer" aria-label="노트 목록">
      <div className="note-drawer-header">
        <h2>
          <ListChecks size={18} />
          전체 노트
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
      <NoteList activeNoteId={activeNoteId} notes={notes} onPreview={onPreview} />
    </aside>
  );
}

function NoteList({
  activeNoteId,
  notes,
  onPreview
}: {
  activeNoteId: string | null;
  notes: DecryptedNote[];
  onPreview: (note: DecryptedNote) => void;
}) {
  if (notes.length === 0) {
    return <p className="muted">아직 저장된 노트가 없습니다.</p>;
  }

  return (
    <div className="note-list">
      {notes.map((note) => (
        <button
          key={note.id}
          className={`note-list-item ${activeNoteId === note.id ? "active" : ""}`}
          type="button"
          onClick={() => onPreview(note)}
        >
          <header>
            <strong>{note.title || "제목 없음"}</strong>
            <span className={`note-kind-pill ${note.type}`}>
              {note.type === "shared" ? <Share2 size={12} /> : null}
              {note.type === "shared" ? "공유" : "개인"}
            </span>
          </header>
          <span className="note-snippet">{previewTextFromHtml(note.body) || "내용 없음"}</span>
        </button>
      ))}
    </div>
  );
}

function NotePreviewModal({
  canDelete,
  note,
  onClose,
  onDelete,
  onEdit,
  saving
}: {
  canDelete: boolean;
  note: DecryptedNote;
  onClose: () => void;
  onDelete: (note: DecryptedNote) => void;
  onEdit: (note: DecryptedNote) => void;
  saving: boolean;
}) {
  const parsedBody = parseEditorContent(note.body);
  const bodyHtml = parsedBody.html || "<p>내용 없음</p>";

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
            <h2 id="note-preview-title">{note.title || "제목 없음"}</h2>
          </div>
          <div className="note-preview-actions">
            <button className="secondary-button note-preview-action" type="button" onClick={() => onEdit(note)}>
              <Pencil size={14} />
              수정
            </button>
            <button
              className="secondary-button danger note-preview-action"
              disabled={saving || !canDelete}
              title={canDelete ? "노트 삭제" : "노트 소유자만 삭제할 수 있습니다."}
              type="button"
              onClick={() => onDelete(note)}
            >
              <Trash2 size={14} />
              삭제
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="노트 조회 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        <div
          className="note-preview-body"
          style={{ fontSize: parsedBody.fontSize }}
          dangerouslySetInnerHTML={{ __html: sanitizeEditorHtml(bodyHtml) }}
        />
      </section>
    </div>
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
