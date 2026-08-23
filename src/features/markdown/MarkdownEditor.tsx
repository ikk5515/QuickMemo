import {
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type {
  MarkdownLinkClickHandler,
  MarkdownTagClickHandler,
  MarkdownViewMode
} from "./types";
import "./markdown.css";

const markdownModes: Array<{ id: MarkdownViewMode; label: string }> = [
  { id: "source", label: "소스 모드" },
  { id: "live-preview", label: "분할 미리보기" },
  { id: "reading", label: "읽기 보기" }
];

export interface MarkdownEditorProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  mode?: MarkdownViewMode;
  defaultMode?: MarkdownViewMode;
  onModeChange?: (mode: MarkdownViewMode) => void;
  onLinkClick?: MarkdownLinkClickHandler;
  onTagClick?: MarkdownTagClickHandler;
  label?: string;
  placeholder?: string;
  readOnly?: boolean;
}

export function MarkdownEditor({
  value,
  onChange,
  mode,
  defaultMode = "live-preview",
  onModeChange,
  onLinkClick,
  onTagClick,
  label = "Markdown 노트",
  placeholder = "Markdown으로 기록하세요…",
  readOnly = false,
  className = "",
  ...attributes
}: MarkdownEditorProps) {
  const [uncontrolledMode, setUncontrolledMode] = useState<MarkdownViewMode>(defaultMode);
  const selectedMode = mode ?? uncontrolledMode;
  const labelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectMode = (nextMode: MarkdownViewMode) => {
    if (mode === undefined) {
      setUncontrolledMode(nextMode);
    }
    onModeChange?.(nextMode);
  };

  const handleModeKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentMode: MarkdownViewMode
  ) => {
    const currentIndex = markdownModes.findIndex((item) => item.id === currentMode);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % markdownModes.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + markdownModes.length) % markdownModes.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = markdownModes.length - 1;
    }

    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextMode = markdownModes[nextIndex].id;
    selectMode(nextMode);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-markdown-mode="${nextMode}"]`)
      ?.focus();
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || readOnly) {
      return;
    }
    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    onChange(`${value.slice(0, start)}\t${value.slice(end)}`);
    window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(start + 1, start + 1));
  };

  const editor = (
    <textarea
      ref={textareaRef}
      aria-label={`${label} 소스`}
      className="qm-markdown-source"
      placeholder={placeholder}
      readOnly={readOnly}
      spellCheck
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={handleEditorKeyDown}
    />
  );

  return (
    <section
      {...attributes}
      aria-labelledby={labelId}
      className={["qm-markdown-editor", className].filter(Boolean).join(" ")}
    >
      <div className="qm-markdown-editor-header">
        <h2 id={labelId}>{label}</h2>
        <div aria-label="Markdown 보기 모드" className="qm-markdown-mode-tabs" role="tablist">
          {markdownModes.map((item) => {
            const selected = selectedMode === item.id;
            return (
              <button
                key={item.id}
                aria-selected={selected}
                data-markdown-mode={item.id}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
                onClick={() => selectMode(item.id)}
                onKeyDown={(event) => handleModeKeyDown(event, item.id)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {selectedMode === "source" && (
        <div className="qm-markdown-pane qm-markdown-pane--source">{editor}</div>
      )}

      {selectedMode === "live-preview" && (
        <div className="qm-markdown-live-preview">
          <div className="qm-markdown-pane qm-markdown-pane--source">{editor}</div>
          <div aria-label={`${label} 미리보기`} className="qm-markdown-pane qm-markdown-pane--preview">
            <MarkdownRenderer
              source={value}
              onLinkClick={onLinkClick}
              onTagClick={onTagClick}
            />
          </div>
        </div>
      )}

      {selectedMode === "reading" && (
        <div aria-label={`${label} 읽기 보기`} className="qm-markdown-pane qm-markdown-pane--reading">
          <MarkdownRenderer
            source={value}
            onLinkClick={onLinkClick}
            onTagClick={onTagClick}
          />
        </div>
      )}
    </section>
  );
}
