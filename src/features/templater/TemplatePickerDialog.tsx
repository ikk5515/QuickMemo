import { FileText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TemplateCandidate } from "../vault/noteCommands";
import {
  renderSafeTemplate,
  SAFE_TEMPLATE_TOKENS,
  safeTemplatePromptNames
} from "./templateEngine";
import "./templater.css";

export interface TemplatePickerDialogProps {
  candidates: readonly TemplateCandidate[];
  confirmDisabled?: boolean;
  confirmDisabledReason?: string;
  currentPath?: string;
  currentSelection?: string;
  currentTitle?: string;
  mode: "insert" | "create";
  onCancel: () => void;
  onConfirm: (candidate: TemplateCandidate, title: string, inputs: Readonly<Record<string, string>>) => void;
}

export function TemplatePickerDialog({
  candidates,
  confirmDisabled = false,
  confirmDisabledReason,
  currentPath = "",
  currentSelection,
  currentTitle = "",
  mode,
  onCancel,
  onConfirm
}: TemplatePickerDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? "");
  const [title, setTitle] = useState(mode === "create" ? candidates[0]?.title.replace(/\.md$/iu, "") ?? "" : currentTitle);
  const [promptValues, setPromptValues] = useState<Record<string, string>>({});
  const filtered = useMemo(() => {
    const needle = query.trim().normalize("NFC").toLocaleLowerCase();
    return candidates.filter((candidate) => !needle || candidate.path.normalize("NFC").toLocaleLowerCase().includes(needle)).slice(0, 100);
  }, [candidates, query]);
  const selected = filtered.find((candidate) => candidate.id === selectedId) ?? filtered[0] ?? null;
  const promptNames = useMemo(() => selected ? safeTemplatePromptNames(selected.body) : [], [selected]);
  const renderPath = mode === "create"
    ? [currentPath.replace(/\/+$/u, ""), `${title.trim() || "새 노트"}.md`].filter(Boolean).join("/")
    : currentPath;
  const preview = useMemo(() => selected
    ? renderSafeTemplate(selected.body, {
        inputs: promptValues,
        now: new Date(),
        path: renderPath,
        selection: currentSelection,
        title: mode === "create" ? title.trim() : currentTitle
      })
    : null, [currentSelection, currentTitle, mode, promptValues, renderPath, selected, title]);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  const [returnFocus] = useState<HTMLElement | null>(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", close);
    searchRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", close);
      if (returnFocus?.isConnected) window.setTimeout(() => returnFocus.focus(), 0);
    };
  }, [returnFocus]);

  const navigateOptions = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    if (!options.length) return;
    event.preventDefault();
    const currentIndex = options.findIndex((option) => option === document.activeElement || option.getAttribute("aria-selected") === "true");
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : event.key === "ArrowDown" ? (Math.max(-1, currentIndex) + 1) % options.length
        : currentIndex <= 0 ? options.length - 1 : currentIndex - 1;
    const option = options[nextIndex];
    setSelectedId(option.dataset.templateId ?? "");
    option.focus();
  };

  return (
    <div className="qm-template-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} role="presentation">
      <section aria-labelledby="qm-template-title" aria-modal="true" className="qm-template-dialog" ref={dialogRef} role="dialog">
        <header><div><FileText size={17} /><strong id="qm-template-title">{mode === "insert" ? "템플릿 삽입" : "템플릿에서 새 노트"}</strong></div><button aria-label="닫기" onClick={onCancel} type="button"><X size={16} /></button></header>
        <label><span>템플릿 검색</span><input onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름 또는 경로" ref={searchRef} type="search" value={query} /></label>
        {mode === "create" ? <label><span>새 노트 이름</span><input maxLength={180} onChange={(event) => setTitle(event.currentTarget.value)} value={title} /></label> : null}
        <div aria-label="템플릿 목록" className="qm-template-list" onKeyDown={navigateOptions} role="listbox">
          {filtered.map((candidate) => <button aria-selected={selected?.id === candidate.id} data-template-id={candidate.id} key={candidate.id} onClick={() => { setSelectedId(candidate.id); if (mode === "create" && !title) setTitle(candidate.title.replace(/\.md$/iu, "")); }} role="option" tabIndex={selected?.id === candidate.id ? 0 : -1} type="button"><strong>{candidate.title}</strong><span>{candidate.path}</span></button>)}
          {!filtered.length ? <p role="status">일치하는 템플릿이 없습니다.</p> : null}
        </div>
        {promptNames.length ? (
          <fieldset className="qm-template-prompts">
            <legend>템플릿 입력</legend>
            {promptNames.map((name) => (
              <label key={name}>
                <span>{name}</span>
                <input
                  maxLength={2_000}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setPromptValues((current) => ({ ...current, [name]: value }));
                  }}
                  value={promptValues[name] ?? ""}
                />
              </label>
            ))}
          </fieldset>
        ) : null}
        {preview ? (
          <section aria-label="템플릿 미리보기" className="qm-template-preview">
            <strong>적용 전 미리보기</strong>
            <pre>{preview.text.slice(0, 4_000)}</pre>
            {preview.text.length > 4_000 ? <small>미리보기는 4,000자까지만 표시합니다.</small> : null}
            {preview.warnings.length ? <small>{preview.warnings[0]}</small> : null}
          </section>
        ) : null}
        <p>안전 토큰: {SAFE_TEMPLATE_TOKENS.join(" · ")}. JavaScript와 네트워크 호출은 실행하지 않습니다.</p>
        {confirmDisabled && confirmDisabledReason ? <p aria-live="polite" role="status">{confirmDisabledReason}</p> : null}
        <footer><button onClick={onCancel} type="button">취소</button><button disabled={confirmDisabled || !selected || (mode === "create" && !title.trim())} onClick={() => selected && onConfirm(selected, mode === "create" ? title.trim() : currentTitle, promptValues)} type="button">{mode === "insert" ? "삽입" : "만들기"}</button></footer>
      </section>
    </div>
  );
}
