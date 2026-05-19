import { AlertTriangle, Download, File, Loader2, LockKeyhole } from "lucide-react";
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
  getPublicNoteShare,
  getPublicNoteShareAttachments,
  publicShareActive,
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
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

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

  useEffect(() => {
    let active = true;

    async function loadShare() {
      setLoading(true);
      setError(null);
      setPasswordRequired(false);
      setPasswordInput("");
      setPasswordError(null);
      setAttachments([]);
      setShare(null);
      setShareKeyValue(null);
      setTitle("");
      setBodyHtml("");
      revokeAttachmentUrls();

      try {
        const shareKeyValue = shareKeyFromHash();

        if (!shareId || !shareKeyValue) {
          throw new Error("공유 링크가 올바르지 않습니다.");
        }

        const shareKey = await importAesKeyBase64Url(shareKeyValue);
        const share = await getPublicNoteShare(shareId);

        if (!share || !publicShareActive(share)) {
          throw new Error("공유 링크가 만료되었거나 중단되었습니다.");
        }

        if (!active) {
          return;
        }

        setShare(share);
        setShareKeyValue(shareKeyValue);

        if (share.passwordHash) {
          setPasswordRequired(true);
          return;
        }

        const content = await decryptPublicShareContent(shareId, share, shareKey);

        if (!active) {
          content.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
          return;
        }

        applyShareContent(content);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "공유 노트를 열 수 없습니다.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadShare();

    return () => {
      active = false;
      revokeAttachmentUrls();
    };
  }, [applyShareContent, revokeAttachmentUrls, shareId]);

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
                      <a className="secondary-button public-share-download" href={attachment.url} download={attachment.downloadName}>
                        <Download size={15} />
                        다운로드
                      </a>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </section>
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
    url: URL.createObjectURL(blob)
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
