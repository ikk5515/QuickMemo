import { AlertTriangle, Download, File, Loader2 } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { attachmentDownloadName, formatFileSize } from "../lib/attachments";
import { decryptBytes, decryptText, importAesKeyBase64Url } from "../lib/crypto";
import { linkifyEditorHtml, parseEditorContent, sanitizeEditorHtml } from "../lib/editorContent";
import {
  getPublicNoteShare,
  getPublicNoteShareAttachments,
  publicShareActive,
  type PublicNoteShareAttachmentSnapshot
} from "../services/publicShares";

interface PublicShareAttachmentView {
  id: string;
  downloadName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  url: string;
}

export default function PublicSharePage() {
  const { shareId } = useParams();
  const [title, setTitle] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [fontSize, setFontSize] = useState(17);
  const [attachments, setAttachments] = useState<PublicShareAttachmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];

    async function loadShare() {
      setLoading(true);
      setError(null);

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

        const [decryptedTitle, decryptedBody, encryptedAttachments] = await Promise.all([
          decryptText(share.encryptedTitle, shareKey),
          decryptText(share.encryptedBody, shareKey),
          getPublicNoteShareAttachments(shareId)
        ]);
        const parsedBody = parseEditorContent(decryptedBody);
        const nextAttachments = await Promise.all(
          encryptedAttachments.map(async (attachment) => {
            const view = await decryptPublicAttachment(attachment, shareKey);
            objectUrls.push(view.url);
            return view;
          })
        );

        if (!active) {
          return;
        }

        setTitle(decryptedTitle || "제목 없음");
        setBodyHtml(linkifyEditorHtml(sanitizeEditorHtml(parsedBody.html || "<p>내용 없음</p>")));
        setFontSize(parsedBody.fontSize);
        setAttachments(nextAttachments);
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
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [shareId]);

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

function shareKeyFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("key");
}

function isImageAttachment(attachment: Pick<PublicShareAttachmentView, "extension" | "mimeType">) {
  return attachment.mimeType.startsWith("image/") || ["gif", "jpeg", "jpg", "png", "webp"].includes(attachment.extension);
}
