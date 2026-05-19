import { AlertTriangle, Download, Eye, File, Loader2, LockKeyhole, X } from "lucide-react";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { attachmentDownloadName, formatFileSize } from "../lib/attachments";
import {
  decryptBytes,
  decryptText,
  derivePublicShareContentKey,
  importAesKeyBase64Url,
  verifyPublicSharePassword
} from "../lib/crypto";
import { linkifyEditorHtml, parseEditorContent, sanitizeEditorHtml } from "../lib/editorContent";
import {
  getPublicNoteShareAttachments,
  publicShareActive,
  subscribePublicNoteShare,
  type PublicNoteShareAttachmentSnapshot,
  type PublicNoteShareSnapshot
} from "../services/publicShares";

interface PublicShareAttachmentView {
  id: string;
  downloadName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  url: string;
  bytes: Uint8Array;
}

interface PublicShareContent {
  attachments: PublicShareAttachmentView[];
  bodyHtml: string;
  fontSize: number;
  title: string;
}

export default function PublicSharePage() {
  const { shareId } = useParams();
  const [title, setTitle] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [fontSize, setFontSize] = useState(17);
  const [attachments, setAttachments] = useState<PublicShareAttachmentView[]>([]);
  const [share, setShare] = useState<PublicNoteShareSnapshot | null>(null);
  const [shareKeyValue, setShareKeyValue] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<PublicShareAttachmentView | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const contentKeyRef = useRef<CryptoKey | null>(null);
  const passwordSignatureRef = useRef<string | null>(null);

  const revokeAttachmentUrls = useCallback(() => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
  }, []);

  const applyShareContent = useCallback((content: PublicShareContent) => {
    revokeAttachmentUrls();
    objectUrlsRef.current = content.attachments.map((attachment) => attachment.url);
    setTitle(content.title);
    setBodyHtml(content.bodyHtml);
    setFontSize(content.fontSize);
    setAttachments(content.attachments);
    setPasswordRequired(false);
  }, [revokeAttachmentUrls]);

  const clearShareContent = useCallback(() => {
    revokeAttachmentUrls();
    setTitle("");
    setBodyHtml("");
    setAttachments([]);
    setAttachmentPreview(null);
  }, [revokeAttachmentUrls]);

  useEffect(() => {
    let active = true;
    let updateVersion = 0;

    async function applyShareUpdate(nextShare: PublicNoteShareSnapshot, nextShareKeyValue: string, shareKey: CryptoKey) {
      const currentVersion = (updateVersion += 1);

      if (!publicShareActive(nextShare)) {
        throw new Error("공유 링크가 만료되었거나 중단되었습니다.");
      }

      setShare(nextShare);
      setShareKeyValue(nextShareKeyValue);

      if (nextShare.passwordHash) {
        const nextSignature = publicSharePasswordSignature(nextShare);

        if (!contentKeyRef.current || passwordSignatureRef.current !== nextSignature) {
          contentKeyRef.current = null;
          passwordSignatureRef.current = null;
          clearShareContent();
          setPasswordRequired(true);
          return;
        }
      } else {
        contentKeyRef.current = shareKey;
        passwordSignatureRef.current = null;
      }

      const contentKey = contentKeyRef.current ?? shareKey;
      const content = await decryptPublicShareContent(shareId ?? "", nextShare, contentKey);

      if (!active || currentVersion !== updateVersion) {
        content.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
        return;
      }

      applyShareContent(content);
    }

    async function loadShare() {
      setLoading(true);
      setError(null);
      setPasswordRequired(false);
      setPasswordInput("");
      setPasswordError(null);
      setAttachments([]);
      setShare(null);
      setShareKeyValue(null);
      contentKeyRef.current = null;
      passwordSignatureRef.current = null;
      setTitle("");
      setBodyHtml("");
      revokeAttachmentUrls();

      try {
        const shareKeyValue = shareKeyFromHash();

        if (!shareId || !shareKeyValue) {
          throw new Error("공유 링크가 올바르지 않습니다.");
        }

        const shareKey = await importAesKeyBase64Url(shareKeyValue);

        return subscribePublicNoteShare(
          shareId,
          (nextShare) => {
            if (!nextShare) {
              setError("공유 링크가 만료되었거나 중단되었습니다.");
              setLoading(false);
              return;
            }

            void applyShareUpdate(nextShare, shareKeyValue, shareKey)
              .then(() => {
                if (active) {
                  setError(null);
                  setLoading(false);
                }
              })
              .catch((shareError) => {
                if (active) {
                  clearShareContent();
                  setError(shareError instanceof Error ? shareError.message : "공유 노트를 열 수 없습니다.");
                  setLoading(false);
                }
              });
          },
          () => {
            if (active) {
              setError("공유 링크 상태를 불러오지 못했습니다.");
              setLoading(false);
            }
          }
        );
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "공유 노트를 열 수 없습니다.");
          setLoading(false);
        }
      }
    }

    let unsubscribe: (() => void) | undefined;
    void loadShare().then((nextUnsubscribe) => {
      if (!active) {
        nextUnsubscribe?.();
        return;
      }

      unsubscribe = nextUnsubscribe;
    });

    return () => {
      active = false;
      unsubscribe?.();
      revokeAttachmentUrls();
    };
  }, [applyShareContent, clearShareContent, revokeAttachmentUrls, shareId]);

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!shareId || !share || !shareKeyValue || !share.passwordHash) {
      setPasswordError("공유 링크를 다시 열어주세요.");
      return;
    }

    setUnlocking(true);
    setPasswordError(null);

    try {
      const trimmedPassword = passwordInput.trim();
      const unlocked = await verifyPublicSharePassword(trimmedPassword, share.passwordHash, shareKeyValue);

      if (!unlocked) {
        setPasswordError("비밀번호가 올바르지 않습니다.");
        return;
      }

      const contentKey = await derivePublicShareContentKey(shareKeyValue, trimmedPassword, share.passwordHash);
      contentKeyRef.current = contentKey;
      passwordSignatureRef.current = publicSharePasswordSignature(share);
      const content = await decryptPublicShareContent(shareId, share, contentKey);
      applyShareContent(content);
      setPasswordInput("");
    } catch {
      setPasswordError("공유 노트를 여는 중 문제가 발생했습니다.");
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <main className="public-share-page">
      <section className="public-share-document">
        {loading ? (
          <div className="public-share-state">
            <Loader2 className="spin" size={28} />
            공유 노트를 여는 중...
          </div>
        ) : error ? (
          <div className="public-share-state error">
            <AlertTriangle size={30} />
            <h1>공유 노트를 열 수 없습니다</h1>
            <p>{error}</p>
          </div>
        ) : passwordRequired ? (
          <form className="public-share-state public-share-password-state" onSubmit={handlePasswordSubmit}>
            <LockKeyhole size={30} />
            <h1>비밀번호가 필요합니다</h1>
            <label>
              <span>비밀번호</span>
              <input
                autoComplete="current-password"
                autoFocus
                onChange={(event) => setPasswordInput(event.target.value)}
                placeholder="공유 비밀번호"
                type="password"
                value={passwordInput}
              />
            </label>
            <button disabled={unlocking || !passwordInput.trim()} type="submit">
              {unlocking ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />}
              확인
            </button>
            {passwordError && <p className="form-error">{passwordError}</p>}
          </form>
        ) : (
          <>
            <header className="public-share-header">
              <h1>{title}</h1>
            </header>
            <article
              className="note-preview-body public-share-body"
              style={{ "--editor-font-size": `${fontSize}px` } as CSSProperties}
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
            {attachments.length > 0 && (
              <section className="public-share-attachments" aria-label="공유 첨부파일">
                <h2>
                  <File size={17} />
                  첨부파일
                </h2>
                <div className="public-share-attachment-list">
                  {attachments.map((attachment) => (
                    <article className="public-share-attachment" key={attachment.id}>
                      {isImageAttachment(attachment) ? (
                        <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="public-share-image-link">
                          <img src={attachment.url} alt={attachment.downloadName} />
                        </a>
                      ) : (
                        <span className="public-share-file-icon">
                          <File size={18} />
                        </span>
                      )}
                      <div>
                        <strong>{attachment.downloadName}</strong>
                        <span>
                          {attachment.extension.toUpperCase()} · {formatFileSize(attachment.originalSize)}
                        </span>
                      </div>
                      <div className="public-share-attachment-actions">
                        <button className="secondary-button public-share-download" type="button" onClick={() => setAttachmentPreview(attachment)}>
                          <Eye size={15} />
                          미리보기
                        </button>
                        <a className="secondary-button public-share-download" href={attachment.url} download={attachment.downloadName}>
                          <Download size={15} />
                          다운로드
                        </a>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </section>
      {attachmentPreview && (
        <PublicAttachmentPreviewModal attachment={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
      )}
    </main>
  );
}

async function decryptPublicAttachment(attachment: PublicNoteShareAttachmentSnapshot, shareKey: CryptoKey) {
  const bytes = await decryptBytes(
    {
      version: 1,
      algorithm: "AES-GCM",
      cipherBytes: attachment.encryptedData.toUint8Array(),
      iv: attachment.iv.toUint8Array()
    },
    shareKey
  );
  const blob = new Blob([bytes], { type: attachment.mimeType || "application/octet-stream" });

  return {
    id: attachment.id,
    downloadName: attachmentDownloadName(attachment),
    extension: attachment.extension,
    mimeType: attachment.mimeType,
    originalSize: attachment.originalSize,
    url: URL.createObjectURL(blob),
    bytes
  } satisfies PublicShareAttachmentView;
}

async function decryptPublicShareContent(shareId: string, share: PublicNoteShareSnapshot, shareKey: CryptoKey): Promise<PublicShareContent> {
  const [decryptedTitle, decryptedBody, encryptedAttachments] = await Promise.all([
    decryptText(share.encryptedTitle, shareKey),
    decryptText(share.encryptedBody, shareKey),
    getPublicNoteShareAttachments(shareId)
  ]);
  const parsedBody = parseEditorContent(decryptedBody);
  const attachments = await Promise.all(encryptedAttachments.map((attachment) => decryptPublicAttachment(attachment, shareKey)));

  return {
    title: decryptedTitle || "제목 없음",
    bodyHtml: linkifyEditorHtml(sanitizeEditorHtml(parsedBody.html || "<p>내용 없음</p>")),
    fontSize: parsedBody.fontSize,
    attachments
  };
}

function shareKeyFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("key");
}

function isImageAttachment(attachment: Pick<PublicShareAttachmentView, "extension" | "mimeType">) {
  return attachment.mimeType.startsWith("image/") || ["gif", "jpeg", "jpg", "png", "webp"].includes(attachment.extension);
}

function isPdfAttachment(attachment: Pick<PublicShareAttachmentView, "extension" | "mimeType">) {
  return attachment.mimeType === "application/pdf" || attachment.extension === "pdf";
}

function isTextAttachment(attachment: Pick<PublicShareAttachmentView, "extension" | "mimeType">) {
  return attachment.mimeType.startsWith("text/") || ["csv", "json", "md", "txt"].includes(attachment.extension);
}

function publicSharePasswordSignature(share: PublicNoteShareSnapshot) {
  return share.passwordHash
    ? `${share.passwordHash.algorithm}:${share.passwordHash.iterations}:${share.passwordHash.salt}:${share.passwordHash.hash}`
    : null;
}

function PublicAttachmentPreviewModal({
  attachment,
  onClose
}: {
  attachment: PublicShareAttachmentView;
  onClose: () => void;
}) {
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

  return (
    <div className="modal-backdrop pdf-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={`${attachment.downloadName} 미리보기`}
        aria-modal="true"
        className="pdf-preview-modal public-attachment-preview-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="pdf-preview-header">
          <div className="pdf-preview-title">
            <span>첨부파일 미리보기</span>
            <h2>{attachment.downloadName}</h2>
          </div>
          <div className="pdf-preview-actions">
            <a className="secondary-button pdf-preview-download" download={attachment.downloadName} href={attachment.url}>
              <Download size={16} />
              다운로드
            </a>
            <button className="icon-button pdf-preview-close" type="button" onClick={onClose} aria-label="미리보기 닫기">
              <X size={16} />
            </button>
          </div>
        </header>
        {isImageAttachment(attachment) ? (
          <div className="public-image-preview-frame">
            <img src={attachment.url} alt={attachment.downloadName} />
          </div>
        ) : isPdfAttachment(attachment) ? (
          <iframe className="pdf-preview-frame" src={attachment.url} title={`${attachment.downloadName} PDF 미리보기`} />
        ) : isTextAttachment(attachment) ? (
          <pre className="file-text-preview">{decodePublicPreviewText(attachment.bytes, attachment.extension)}</pre>
        ) : (
          <pre className="file-text-preview unsupported">이 파일 형식은 브라우저 미리보기를 지원하지 않습니다. 다운로드해서 확인해주세요.</pre>
        )}
      </section>
    </div>
  );
}

function decodePublicPreviewText(bytes: Uint8Array, extension: string) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 120_000);

  if (extension === "json") {
    try {
      return JSON.stringify(JSON.parse(text), null, 2).slice(0, 120_000);
    } catch {
      return text;
    }
  }

  return text;
}
