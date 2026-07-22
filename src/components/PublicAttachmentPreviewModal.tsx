import { Download, Loader2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, type RefObject } from "react";
import { sanitizeEditorHtml } from "../lib/editorContent";
import type { PublicAttachmentPreviewState } from "../lib/publicAttachmentPreview";

const PublicPdfCanvasPreview = lazy(() => import("./PublicPdfCanvasPreview"));

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export default function PublicAttachmentPreviewModal({
  fallbackFocus = null,
  onClose,
  preview,
  returnFocus = null
}: {
  fallbackFocus?: HTMLElement | null;
  onClose: () => void;
  preview: PublicAttachmentPreviewState;
  returnFocus?: HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);

  useDialogFocus(dialogRef, returnFocus, fallbackFocus);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop pdf-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="public-attachment-preview-title"
        aria-modal="true"
        className="pdf-preview-modal"
        ref={dialogRef}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="pdf-preview-header">
          <div className="pdf-preview-title">
            <span>{preview.label}</span>
            <h2 id="public-attachment-preview-title">{preview.fileName}</h2>
          </div>
          <div className="pdf-preview-actions">
            {preview.url && (
              <a
                className="secondary-button pdf-preview-download"
                download={preview.fileName}
                href={preview.url}
                rel="noopener noreferrer"
              >
                <Download size={14} />
                다운로드
              </a>
            )}
            <button
              aria-label="파일 미리보기 닫기"
              className="icon-button pdf-preview-close"
              data-dialog-initial-focus
              type="button"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        {preview.kind === "image" && preview.url ? (
          <div className="public-image-preview-frame">
            <img src={preview.url} alt={preview.fileName} />
          </div>
        ) : preview.kind === "pdf" && preview.bytes ? (
          <Suspense fallback={<PreviewLoadingStatus label="PDF 미리보기를 준비하는 중..." />}>
            <PublicPdfCanvasPreview bytes={preview.bytes} fileName={preview.fileName} />
          </Suspense>
        ) : preview.kind === "docx" ? (
          <div className="docx-preview-frame">
            <iframe
              className="docx-preview-sandbox"
              referrerPolicy="no-referrer"
              sandbox=""
              srcDoc={preview.srcDoc ?? ""}
              title={`${preview.fileName} DOCX 미리보기`}
            />
          </div>
        ) : preview.kind === "hwp" ? (
          <div className="document-preview-frame">
            <div
              className="document-preview-page hwp-fallback-preview"
              dangerouslySetInnerHTML={{ __html: sanitizeEditorHtml(preview.fallbackHtml ?? "") }}
            />
          </div>
        ) : preview.kind === "html" ? (
          <div className="document-preview-frame">
            <div
              className="document-preview-page"
              dangerouslySetInnerHTML={{ __html: sanitizeEditorHtml(preview.html ?? "") }}
            />
          </div>
        ) : (
          <pre className={`file-text-preview ${preview.kind === "unsupported" ? "unsupported" : ""}`}>{preview.text}</pre>
        )}
      </section>
    </div>
  );
}

function PreviewLoadingStatus({ label }: { label: string }) {
  return (
    <p className="pdf-preview-status" role="status" aria-live="polite">
      <Loader2 className="spin" size={16} />
      {label}
    </p>
  );
}

function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  returnFocus: HTMLElement | null,
  fallbackFocus: HTMLElement | null
) {
  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return undefined;
    }

    const previewDialog: HTMLElement = dialog;
    const previousFocus = returnFocus?.isConnected
      ? returnFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frameId = window.requestAnimationFrame(() => {
      const focusTarget = previewDialog.querySelector<HTMLElement>("[autofocus], [data-dialog-initial-focus], " + dialogFocusableSelector);
      previewDialog.tabIndex = -1;
      (focusTarget ?? previewDialog).focus({ preventScroll: true });
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = Array.from(previewDialog.querySelectorAll<HTMLElement>(dialogFocusableSelector)).filter(
        (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true"
      );

      if (!focusableElements.length) {
        event.preventDefault();
        previewDialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements.at(-1)!;
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || !previewDialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener("keydown", handleKeyDown, true);

      const focusTarget = previousFocus?.isConnected ? previousFocus : fallbackFocus;
      if (focusTarget?.isConnected) {
        focusTarget.focus({ preventScroll: true });
      }
    };
  }, [dialogRef, fallbackFocus, returnFocus]);
}
