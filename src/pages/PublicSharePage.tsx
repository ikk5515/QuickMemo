import { AlertTriangle, Download, Eye, File, Loader2, LockKeyhole } from "lucide-react";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  attachmentDownloadName,
  formatFileSize,
  isPublicShareRasterImageExtension,
  publicShareAttachmentMimeMatchesExtension,
  safePublicShareAttachmentMimeType
} from "../lib/attachments";
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
import {
  AttachmentPreviewModal,
  decodeTextAttachmentPreview,
  extractHwpPreviewHtml,
  extractHwpxPreviewHtml,
  extractXlsxPreviewHtml,
  legacyBinaryPreviewAttachmentExtensions,
  legacyBinaryPreviewMessage,
  previewableAttachmentExtensions,
  renderSafeDocxPreviewSrcDoc,
  textPreviewAttachmentExtensions,
  type AttachmentPreviewState
} from "./NotesPage";

interface PublicShareAttachmentView {
  id: string;
  downloadName: string;
  downloadUrl: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  previewUrl: string | null;
  bytes: Uint8Array;
}

type PublicShareImageAttachmentView = PublicShareAttachmentView & { previewUrl: string };

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
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
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
    objectUrlsRef.current = content.attachments.flatMap(publicAttachmentObjectUrls);
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
        content.attachments.flatMap(publicAttachmentObjectUrls).forEach((url) => URL.revokeObjectURL(url));
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

  async function openAttachmentPreview(attachment: PublicShareAttachmentView) {
    const fileName = attachment.downloadName;

    if (isImageAttachment(attachment)) {
      setAttachmentPreview({ fileName, kind: "image", label: "이미지 미리보기", url: attachment.previewUrl });
      return;
    }

    if (!previewableAttachmentExtensions.has(attachment.extension)) {
      setAttachmentPreview({
        fileName,
        kind: "unsupported",
        label: "미리보기",
        text: "이 파일 형식은 브라우저 미리보기를 지원하지 않습니다. 다운로드해서 확인해주세요."
      });
      return;
    }

    if (attachment.extension === "pdf") {
      setAttachmentPreview({ bytes: attachment.bytes, fileName, kind: "pdf", label: "PDF 미리보기", url: attachment.downloadUrl });
      return;
    }

    if (attachment.extension === "docx") {
      const srcDoc = await renderSafeDocxPreviewSrcDoc(attachment.bytes);

      setAttachmentPreview(
        srcDoc
          ? { fileName, kind: "docx", label: "DOCX 양식 미리보기", srcDoc, url: attachment.downloadUrl }
          : {
              fileName,
              kind: "unsupported",
              label: "DOCX 미리보기 안내",
              text: "DOCX 양식 미리보기를 안전하게 만들지 못했습니다. 원본 파일은 다운로드해서 확인해주세요.",
              url: attachment.downloadUrl
            }
      );
      return;
    }

    if (attachment.extension === "hwp") {
      const preview = await extractHwpPreviewHtml(attachment.bytes);

      setAttachmentPreview(
        preview.safeForRichPreview
          ? {
              bytes: attachment.bytes,
              fallbackHtml: preview.html,
              fileName,
              kind: "hwp",
              label: "HWP 문서 미리보기",
              url: attachment.downloadUrl
            }
          : preview.html
            ? { fileName, html: preview.html, kind: "html", label: "HWP 안전 본문 미리보기", url: attachment.downloadUrl }
            : {
                fileName,
                kind: "unsupported",
                label: "HWP 미리보기 안내",
                text: "HWP 미리보기가 안전 제한을 초과했거나 지원하지 않는 문서입니다. 원본 파일은 다운로드해서 확인해주세요.",
                url: attachment.downloadUrl
              }
      );
      return;
    }

    if (attachment.extension === "hwpx") {
      const html = extractHwpxPreviewHtml(attachment.bytes);

      setAttachmentPreview({
        fileName,
        html,
        kind: html ? "html" : "unsupported",
        label: "HWPX 문서 미리보기",
        text: html ? undefined : "HWPX 문서에서 안전하게 표시할 본문을 찾지 못했습니다.",
        url: attachment.downloadUrl
      });
      return;
    }

    if (attachment.extension === "xlsx") {
      const html = extractXlsxPreviewHtml(attachment.bytes);

      setAttachmentPreview({
        fileName,
        html,
        kind: html ? "html" : "unsupported",
        label: "XLSX 스프레드시트 미리보기",
        text: html ? undefined : "XLSX 파일에서 안전하게 표시할 시트 내용을 찾지 못했습니다.",
        url: attachment.downloadUrl
      });
      return;
    }

    if (textPreviewAttachmentExtensions.has(attachment.extension)) {
      setAttachmentPreview({
        fileName,
        kind: "text",
        label: `${attachment.extension.toUpperCase()} 미리보기`,
        text: decodeTextAttachmentPreview(attachment.bytes, attachment.extension),
        url: attachment.downloadUrl
      });
      return;
    }

    if (legacyBinaryPreviewAttachmentExtensions.has(attachment.extension)) {
      setAttachmentPreview({
        fileName,
        kind: "unsupported",
        label: `${attachment.extension.toUpperCase()} 미리보기 안내`,
        text: legacyBinaryPreviewMessage(attachment.extension),
        url: attachment.downloadUrl
      });
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
                        <button
                          aria-label={`${attachment.downloadName} 미리보기`}
                          className="public-share-image-link"
                          onClick={() => void openAttachmentPreview(attachment)}
                          type="button"
                        >
                          <img src={attachment.previewUrl} alt={attachment.downloadName} />
                        </button>
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
                        <button
                          className="secondary-button public-share-download"
                          type="button"
                          onClick={() => void openAttachmentPreview(attachment)}
                        >
                          <Eye size={15} />
                          미리보기
                        </button>
                        <a className="secondary-button public-share-download" href={attachment.downloadUrl} download={attachment.downloadName}>
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
      {attachmentPreview && <AttachmentPreviewModal preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />}
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
  const extension = attachment.extension.toLowerCase();
  const mimeType = attachment.mimeType.trim().toLowerCase();
  const downloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const previewUrl =
    isPublicShareRasterImageExtension(extension) && publicShareAttachmentMimeMatchesExtension(extension, mimeType)
      ? URL.createObjectURL(new Blob([bytes], { type: safePublicShareAttachmentMimeType(extension) }))
      : null;

  return {
    id: attachment.id,
    downloadName: attachmentDownloadName({ ...attachment, extension }),
    downloadUrl,
    extension,
    mimeType,
    originalSize: attachment.originalSize,
    previewUrl,
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

function publicAttachmentObjectUrls(attachment: PublicShareAttachmentView) {
  return attachment.previewUrl ? [attachment.downloadUrl, attachment.previewUrl] : [attachment.downloadUrl];
}

function isImageAttachment(attachment: PublicShareAttachmentView): attachment is PublicShareImageAttachmentView {
  return Boolean(attachment.previewUrl)
    && isPublicShareRasterImageExtension(attachment.extension)
    && publicShareAttachmentMimeMatchesExtension(attachment.extension, attachment.mimeType);
}

function publicSharePasswordSignature(share: PublicNoteShareSnapshot) {
  return share.passwordHash
    ? `${share.passwordHash.algorithm}:${share.passwordHash.iterations}:${share.passwordHash.salt}:${share.passwordHash.hash}`
    : null;
}
