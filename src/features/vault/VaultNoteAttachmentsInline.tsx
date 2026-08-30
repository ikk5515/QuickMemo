import { File, FileImage, Paperclip } from "lucide-react";
import {
  attachmentDownloadName,
  formatFileSize,
  isPublicShareRasterImageExtension
} from "../../lib/attachments";
import type { NoteAttachmentSnapshot } from "../../services/notes";

const visibleAttachmentSummaryCount = 5;

export interface VaultNoteAttachmentsInlineProps {
  attachments: NoteAttachmentSnapshot[];
  disabled?: boolean;
  error?: string;
  loading: boolean;
  onManage: (returnFocusTo: HTMLButtonElement) => void;
}

export function VaultNoteAttachmentsInline({
  attachments,
  disabled = false,
  error = "",
  loading,
  onManage
}: VaultNoteAttachmentsInlineProps) {
  const visibleAttachments = attachments.slice(0, visibleAttachmentSummaryCount);
  const hasMore = attachments.length > visibleAttachmentSummaryCount;
  const countLabel = `${attachments.length}개`;

  return (
    <section aria-label="노트 첨부파일" className="vault-note-attachments-inline">
      <div className="vault-note-attachments-inline-label">
        <Paperclip aria-hidden="true" size={15} />
        <strong>파일</strong>
        <span aria-live="polite">
          {loading ? "확인 중" : error ? "확인 실패" : countLabel}
        </span>
      </div>

      {visibleAttachments.length ? (
        <ul aria-label="최근 첨부파일" className="vault-note-attachments-inline-list">
          {visibleAttachments.map((attachment) => {
            const fileName = attachmentDownloadName(attachment);
            const AttachmentIcon = isPublicShareRasterImageExtension(attachment.extension)
              ? FileImage
              : File;
            return (
              <li key={attachment.id} title={`${fileName} · ${formatFileSize(attachment.originalSize)}`}>
                <AttachmentIcon aria-hidden="true" size={14} />
                <span>{fileName}</span>
                <small>{formatFileSize(attachment.originalSize)}</small>
              </li>
            );
          })}
          {hasMore ? (
            <li className="vault-note-attachments-inline-more">
              +{attachments.length - visibleAttachmentSummaryCount}
            </li>
          ) : null}
        </ul>
      ) : (
        <span className={`vault-note-attachments-inline-empty${error ? " is-error" : ""}`}>
          {loading ? "첨부파일 목록을 불러오는 중입니다." : error || "첨부파일이 없습니다."}
        </span>
      )}

      <button
        aria-label={attachments.length ? "노트 첨부파일 관리" : "노트에 파일 추가"}
        className="vault-note-attachments-inline-manage"
        disabled={disabled}
        onClick={(event) => onManage(event.currentTarget)}
        type="button"
      >
        {attachments.length ? "관리" : "추가"}
      </button>
    </section>
  );
}

export default VaultNoteAttachmentsInline;
