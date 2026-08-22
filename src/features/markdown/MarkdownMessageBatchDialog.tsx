import { Check, Copy, MessagesSquare, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { DiscordAiMarkdownDelivery } from "./export";

type DiscordAiMessageBatch = Extract<DiscordAiMarkdownDelivery, { kind: "message-batch" }>;

export interface MarkdownMessageBatchDialogProps {
  copyMessage?: (content: string) => Promise<void>;
  delivery: DiscordAiMessageBatch;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}

export function MarkdownMessageBatchDialog({
  copyMessage = (content) => navigator.clipboard.writeText(content),
  delivery,
  onClose,
  returnFocusTo
}: MarkdownMessageBatchDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const firstCopyButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [copiedIndexes, setCopiedIndexes] = useState<ReadonlySet<number>>(new Set());
  const [status, setStatus] = useState(`${delivery.messages.length}개 메시지를 순서대로 복사하세요.`);

  useEffect(() => {
    firstCopyButtonRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
      });
    };
  }, [returnFocusTo]);

  async function handleCopy(index: number, content: string) {
    if (busyIndex !== null) return;
    setBusyIndex(index);
    try {
      await copyMessage(content);
      setCopiedIndexes((current) => new Set(current).add(index));
      setStatus(`${index}/${delivery.messages.length} 메시지를 복사했습니다.`);
    } catch {
      setStatus(`${index}/${delivery.messages.length} 메시지를 복사하지 못했습니다.`);
    } finally {
      setBusyIndex(null);
    }
  }

  return (
    <div
      className="vault-message-batch-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        ref={dialogRef}
        aria-describedby={`${titleId}-description`}
        aria-labelledby={titleId}
        aria-modal="true"
        className="vault-message-batch-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [tabindex]:not([tabindex="-1"])'
          ) ?? []);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        role="dialog"
      >
        <header>
          <div>
            <MessagesSquare aria-hidden="true" size={18} />
            <h2 id={titleId}>Discord · AI 메시지 나누기</h2>
          </div>
          <button aria-label="메시지 나누기 닫기" onClick={onClose} type="button"><X size={17} /></button>
        </header>
        <p id={`${titleId}-description`} className="vault-message-batch-description">
          한 메시지 제한 {delivery.maximumMessageCharacters.toLocaleString()}자를 넘지 않도록 나눴습니다.
          합치지 말고 번호 순서대로 하나씩 복사해 붙여 넣으세요.
        </p>
        {delivery.warnings.length ? (
          <ul aria-label="내보내기 주의사항" className="vault-message-batch-warnings">
            {delivery.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        ) : null}
        <ol aria-label="나눈 Markdown 메시지" className="vault-message-batch-list">
          {delivery.messages.map((message, offset) => {
            const copied = copiedIndexes.has(message.index);
            return (
              <li key={message.index}>
                <div>
                  <strong>{message.index}/{message.total}</strong>
                  <span>{message.content.length.toLocaleString()}자</span>
                  <button
                    ref={offset === 0 ? firstCopyButtonRef : undefined}
                    aria-label={`${message.index}/${message.total} 메시지 복사`}
                    disabled={busyIndex !== null}
                    onClick={() => void handleCopy(message.index, message.content)}
                    type="button"
                  >
                    {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
                    {busyIndex === message.index ? "복사 중…" : copied ? "복사됨" : "복사"}
                  </button>
                </div>
                <pre>{message.content}</pre>
              </li>
            );
          })}
        </ol>
        <footer>
          <p aria-live="polite" role="status">{status}</p>
          <button onClick={onClose} type="button">닫기</button>
        </footer>
      </section>
    </div>
  );
}
