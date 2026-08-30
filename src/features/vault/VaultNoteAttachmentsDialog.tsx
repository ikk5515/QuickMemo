import {
  Download,
  File,
  FolderOpen,
  Loader2,
  Paperclip,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import {
  allowedAttachmentExtensions,
  attachmentDownloadName,
  attachmentExtension,
  attachmentValidationError,
  formatFileSize,
  maxAttachmentFileLabel,
  safeAttachmentBaseName,
  safePublicShareAttachmentMimeType
} from "../../lib/attachments";
import {
  decryptAttachmentToBlob,
  encryptAttachmentBlob
} from "../../lib/attachmentCrypto";
import { unwrapNoteKey } from "../../lib/crypto";
import { hasFeatureAccess } from "../../lib/featureAccess";
import { useModalFocus } from "../../lib/useModalFocus";
import {
  createNoteAttachment,
  deleteNoteAttachment,
  getEncryptedNoteAttachmentSource,
  subscribeNoteAttachments,
  type NoteAttachmentSnapshot
} from "../../services/notes";
import { publicNoteShareMaxAttachmentCount } from "../../services/publicShares";
import type { UserProfile } from "../../types";
import { downloadBlob } from "./browserDownload";
import type { DecryptedVaultNote } from "./vaultData";
import "./VaultNoteAttachmentsDialog.css";

const attachmentInputAccept = allowedAttachmentExtensions
  .map((extension) => `.${extension}`)
  .join(",");
const maximumAttachmentBatchFiles = 20;

type AttachmentOperation =
  | { kind: "deleting" | "downloading"; attachmentId: string }
  | { kind: "uploading"; fileName: string; label: string; progress: number }
  | null;

export interface VaultNoteAttachmentsDialogProps {
  note: DecryptedVaultNote;
  onClose: () => void;
  onOpenLibrary: () => void;
  privateKey: CryptoKey;
  profile: UserProfile;
  returnFocusTo?: HTMLElement | null;
}

export function vaultNoteAttachmentAccess(
  note: DecryptedVaultNote,
  profile: UserProfile
): { allowed: true; reason: "" } | { allowed: false; reason: string } {
  if (!profile.isActive || !hasFeatureAccess(profile, "notes")) {
    return { allowed: false, reason: "활성화된 노트 권한이 있어야 파일을 관리할 수 있습니다." };
  }
  if (note.isDeleted || note.ownerUid !== profile.uid || note.type !== "personal") {
    return { allowed: false, reason: "내 개인 활성 노트의 파일만 관리할 수 있습니다." };
  }
  if (note.contentFormat !== "markdown-v1" || note.entryKind !== "markdown") {
    return { allowed: false, reason: "Markdown 노트에서만 파일을 첨부할 수 있습니다." };
  }
  if (!note.wrappedKeys[profile.uid]) {
    return { allowed: false, reason: "이 노트의 암호화 키를 확인할 수 없습니다." };
  }
  return { allowed: true, reason: "" };
}

function operationErrorMessage(caught: unknown, fallback: string) {
  return caught instanceof DOMException && caught.name === "AbortError"
    ? "파일 작업을 취소했습니다."
    : fallback;
}

export function VaultNoteAttachmentsDialog({
  note,
  onClose,
  onOpenLibrary,
  privateKey,
  profile,
  returnFocusTo
}: VaultNoteAttachmentsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(returnFocusTo ?? null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const activeRef = useRef(true);
  const access = vaultNoteAttachmentAccess(note, profile);
  const [attachments, setAttachments] = useState<NoteAttachmentSnapshot[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<AttachmentOperation>(null);
  const [status, setStatus] = useState("");

  useModalFocus(dialogRef, {
    returnFocusRef: returnFocusRef as RefObject<HTMLElement | null>
  });

  useEffect(() => {
    activeRef.current = true;
    setAttachments([]);
    setError("");
    setStatus("");
    if (!access.allowed) {
      setLoading(false);
      return () => {
        activeRef.current = false;
        uploadControllerRef.current?.abort();
        uploadControllerRef.current = null;
      };
    }
    setLoading(true);
    const unsubscribe = subscribeNoteAttachments(
      note.id,
      (next) => {
        if (!activeRef.current) return;
        setAttachments(next);
        setLoading(false);
      },
      () => {
        if (!activeRef.current) return;
        setError("첨부파일 목록을 불러오지 못했습니다.");
        setLoading(false);
      }
    );
    return () => {
      activeRef.current = false;
      uploadControllerRef.current?.abort();
      uploadControllerRef.current = null;
      unsubscribe();
    };
  }, [access.allowed, note.id]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !operation) {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, operation]);

  async function noteKey() {
    const wrappedKey = note.wrappedKeys[profile.uid];
    if (!wrappedKey) {
      throw new Error("missing-note-key");
    }
    return unwrapNoteKey(wrappedKey, privateKey);
  }

  async function uploadFiles(files: readonly File[]) {
    if (!access.allowed || operation || !files.length) return;
    const selected = files.slice(0, maximumAttachmentBatchFiles);
    const valid: File[] = [];
    const rejected: string[] = [];
    selected.forEach((file) => {
      const validationError = attachmentValidationError(file);
      if (validationError) rejected.push(`${file.name}: ${validationError}`);
      else valid.push(file);
    });
    if (files.length > maximumAttachmentBatchFiles) {
      rejected.push(`한 번에 최대 ${maximumAttachmentBatchFiles}개까지 선택할 수 있습니다.`);
    }
    if (attachments.length + valid.length > publicNoteShareMaxAttachmentCount) {
      setError(`노트당 파일은 최대 ${publicNoteShareMaxAttachmentCount}개까지 첨부할 수 있습니다.`);
      return;
    }
    if (!valid.length) {
      setError(rejected[0] ?? "첨부할 수 있는 파일이 없습니다.");
      return;
    }

    const controller = new AbortController();
    uploadControllerRef.current = controller;
    setError("");
    setStatus("");
    try {
      const key = await noteKey();
      for (const [index, file] of valid.entries()) {
        controller.signal.throwIfAborted();
        const prefix = valid.length > 1 ? `${index + 1}/${valid.length} · ` : "";
        setOperation({ kind: "uploading", fileName: file.name, label: `${prefix}암호화 중`, progress: 0 });
        const encrypted = await encryptAttachmentBlob(
          file,
          key,
          (progress) => {
            if (!controller.signal.aborted && activeRef.current) {
              setOperation({
                kind: "uploading",
                fileName: file.name,
                label: `${prefix}암호화 중`,
                progress: Math.round(progress.percentage * 0.45)
              });
            }
          },
          controller.signal
        );
        controller.signal.throwIfAborted();
        const extension = attachmentExtension(file.name);
        await createNoteAttachment({
          encryptedBlob: encrypted.blob,
          encryption: encrypted.metadata,
          extension,
          fileName: safeAttachmentBaseName(file.name),
          mimeType: safePublicShareAttachmentMimeType(extension),
          noteId: note.id,
          onUploadProgress: (progress) => {
            if (!controller.signal.aborted && activeRef.current) {
              setOperation({
                kind: "uploading",
                fileName: file.name,
                label: `${prefix}암호문 업로드 중`,
                progress: 45 + Math.round(progress.percentage * 0.55)
              });
            }
          },
          originalSize: file.size,
          signal: controller.signal,
          uploadedBy: profile.uid
        });
      }
      if (activeRef.current) {
        setStatus(valid.length === 1
          ? "파일을 암호화해 노트에 첨부했습니다. 자료실에도 자동으로 표시됩니다."
          : `${valid.length}개 파일을 암호화해 첨부했습니다. 자료실에도 자동으로 표시됩니다.`);
        if (rejected.length) setError(`일부 파일은 제외했습니다. ${rejected[0]}`);
      }
    } catch (caught) {
      if (activeRef.current) {
        setError(operationErrorMessage(caught, "파일을 암호화해 업로드하지 못했습니다."));
      }
    } finally {
      if (uploadControllerRef.current === controller) uploadControllerRef.current = null;
      if (activeRef.current) setOperation(null);
    }
  }

  async function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    await uploadFiles(files);
  }

  async function downloadAttachment(attachment: NoteAttachmentSnapshot) {
    if (operation) return;
    setError("");
    setOperation({ kind: "downloading", attachmentId: attachment.id });
    try {
      const key = await noteKey();
      const encryptedSource = await getEncryptedNoteAttachmentSource(attachment);
      const blob = await decryptAttachmentToBlob(attachment, key, encryptedSource);
      if (activeRef.current) {
        downloadBlob(blob, attachmentDownloadName(attachment));
        setStatus("파일을 복호화해 다운로드했습니다.");
      }
    } catch {
      if (activeRef.current) setError("파일을 다운로드하지 못했습니다.");
    } finally {
      if (activeRef.current) setOperation(null);
    }
  }

  async function removeAttachment(attachment: NoteAttachmentSnapshot) {
    if (operation) return;
    if (!window.confirm(`'${attachmentDownloadName(attachment)}' 파일을 노트와 자료실 목록에서 삭제할까요?`)) {
      return;
    }
    setError("");
    setOperation({ kind: "deleting", attachmentId: attachment.id });
    try {
      await deleteNoteAttachment(note.id, attachment.id);
      if (activeRef.current) setStatus("파일을 노트와 자료실 목록에서 삭제했습니다.");
    } catch {
      if (activeRef.current) setError("파일을 삭제하지 못했습니다.");
    } finally {
      if (activeRef.current) setOperation(null);
    }
  }

  const uploading = operation?.kind === "uploading";

  return createPortal(
    <div className="vault-attachments-backdrop" role="presentation">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="vault-attachments-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="vault-attachments-header">
          <div>
            <span><Paperclip aria-hidden="true" size={15} /> 노트 파일</span>
            <h2 id={titleId}>{note.title || "제목 없는 노트"}</h2>
          </div>
          <button aria-label="첨부파일 관리 닫기" className="icon-button" disabled={Boolean(operation)} onClick={onClose} type="button">
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="vault-attachments-body">
          <p className="vault-attachments-description">
            파일 내용은 노트 키로 먼저 암호화한 뒤 비공개 저장소에 보관합니다. 원본 한 개를 이 노트와 자료실이 함께 참조하므로 중복 저장하지 않습니다.
          </p>

          {!access.allowed ? (
            <p className="vault-attachments-feedback error" role="alert">{access.reason}</p>
          ) : (
            <>
              <input
                accept={attachmentInputAccept}
                disabled={Boolean(operation)}
                hidden
                multiple
                onChange={(event) => void handleFileSelection(event)}
                ref={fileInputRef}
                type="file"
              />
              <div className="vault-attachments-toolbar">
                <button
                  data-dialog-initial-focus
                  disabled={Boolean(operation) || attachments.length >= publicNoteShareMaxAttachmentCount}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  <Upload aria-hidden="true" size={16} /> 파일 추가
                </button>
                <button className="secondary-button" disabled={uploading} onClick={onOpenLibrary} type="button">
                  <FolderOpen aria-hidden="true" size={16} /> 자료실에서 보기
                </button>
              </div>
              <small className="vault-attachments-limits">
                파일당 최대 {maxAttachmentFileLabel} · 한 번에 {maximumAttachmentBatchFiles}개 · 노트당 {publicNoteShareMaxAttachmentCount}개
              </small>
            </>
          )}

          {operation?.kind === "uploading" ? (
            <div className="vault-attachments-progress" role="status">
              <div><Loader2 aria-hidden="true" className="spin" size={16} /><strong>{operation.label}</strong></div>
              <span>{operation.fileName}</span>
              <progress max={100} value={operation.progress}>{operation.progress}%</progress>
              <button className="secondary-button" onClick={() => uploadControllerRef.current?.abort()} type="button">업로드 취소</button>
            </div>
          ) : null}

          {error ? <p className="vault-attachments-feedback error" role="alert">{error}</p> : null}
          {status ? <p className="vault-attachments-feedback" role="status">{status}</p> : null}

          {loading ? (
            <p className="vault-attachments-empty" role="status"><Loader2 aria-hidden="true" className="spin" size={16} /> 파일 목록을 불러오는 중입니다.</p>
          ) : attachments.length ? (
            <ul className="vault-attachments-list">
              {attachments.map((attachment) => {
                const busy = operation && operation.kind !== "uploading" && operation.attachmentId === attachment.id;
                return (
                  <li key={attachment.id}>
                    <File aria-hidden="true" size={19} />
                    <div>
                      <strong>{attachmentDownloadName(attachment)}</strong>
                      <span>{formatFileSize(attachment.originalSize)} · {attachment.extension.toUpperCase()}</span>
                    </div>
                    <div className="vault-attachments-actions">
                      <button aria-label={`${attachmentDownloadName(attachment)} 다운로드`} className="icon-button" disabled={Boolean(operation)} onClick={() => void downloadAttachment(attachment)} type="button">
                        {busy && operation?.kind === "downloading" ? <Loader2 aria-hidden="true" className="spin" size={16} /> : <Download aria-hidden="true" size={16} />}
                      </button>
                      <button aria-label={`${attachmentDownloadName(attachment)} 삭제`} className="icon-button danger" disabled={Boolean(operation)} onClick={() => void removeAttachment(attachment)} type="button">
                        {busy && operation?.kind === "deleting" ? <Loader2 aria-hidden="true" className="spin" size={16} /> : <Trash2 aria-hidden="true" size={16} />}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="vault-attachments-empty">이 노트에 첨부된 파일이 없습니다.</p>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}

export default VaultNoteAttachmentsDialog;
