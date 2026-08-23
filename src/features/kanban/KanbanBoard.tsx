import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  GripVertical,
  Link2,
  ListPlus,
  Plus,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { parseMarkdownInline, type MarkdownInlineToken } from "../markdown";
import { downloadBlob } from "../vault/browserDownload";
import {
  MAX_KANBAN_PARSE_DIAGNOSTICS,
  exportObsidianKanbanMarkdown,
  importKanbanMarkdown,
  parseKanbanSource,
  serializeKanbanDocument,
  type KanbanCard,
  type KanbanDocument,
  type KanbanImportResult
} from "./model";
import "./kanban.css";

const MAX_KANBAN_RENDERED_DIAGNOSTICS = MAX_KANBAN_PARSE_DIAGNOSTICS;
const MAX_KANBAN_INTEROP_CHARACTERS = 500_000;

interface InspectedKanbanImport {
  baseSource: string;
  input: string;
  result: KanbanImportResult;
}

function renderedDiagnostics(errors: readonly string[]) {
  if (errors.length <= MAX_KANBAN_RENDERED_DIAGNOSTICS) return errors;
  return [
    ...errors.slice(0, MAX_KANBAN_RENDERED_DIAGNOSTICS - 1),
    `추가 진단 ${errors.length - (MAX_KANBAN_RENDERED_DIAGNOSTICS - 1)}개는 안전을 위해 표시하지 않았습니다.`
  ];
}

function safeKanbanFilename(value: string) {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? "-" : character;
  }).join("");
  const safe = withoutControls
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${safe.replace(/[-.\s]/gu, "") ? safe : "Kanban"}.md`;
}

export interface KanbanBoardProps {
  onChange: (source: string) => void;
  onOpenLink?: (target: string) => void;
  readOnly?: boolean;
  source: string;
}

interface KanbanInternalLink {
  display: string;
  target: string;
}

const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const EMPTY_COLUMN_DROP_PREFIX = "kanban-empty-column:";

function isSafeInternalTarget(target: string): boolean {
  const candidates = [target];
  try {
    candidates.push(decodeURIComponent(target));
  } catch {
    // A literal percent sign is valid in an internal note title. The raw
    // candidate is still checked below and is never sent to browser navigation.
  }
  return candidates.every((candidate) => (
    !candidate.includes("\u0000")
    && !candidate.trim().startsWith("//")
    && !URI_SCHEME_PATTERN.test(candidate.trim())
  ));
}

function cardInternalLinks(source: string): KanbanInternalLink[] {
  const links: KanbanInternalLink[] = [];
  const seen = new Set<string>();
  const visit = (tokens: readonly MarkdownInlineToken[]) => {
    for (const token of tokens) {
      if (token.type === "emphasis" || token.type === "strong" || token.type === "delete") {
        visit(token.children);
        continue;
      }
      if (token.type !== "wikilink") continue;
      const target = token.target.trim();
      if (!target || !isSafeInternalTarget(target)) {
        continue;
      }
      const key = `${target}\n${token.display}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ display: token.display, target });
    }
  };
  visit(parseMarkdownInline(source));
  return links;
}

function cloneDocument(document: KanbanDocument): KanbanDocument {
  return {
    ...document,
    columns: document.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({
        ...card,
        checklist: card.checklist?.map((item) => ({ ...item })) ?? []
      }))
    }))
  };
}

function nextKanbanId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`.slice(0, 120);
}

export function moveKanbanColumn(
  document: KanbanDocument,
  fromIndex: number,
  toIndex: number
): KanbanDocument | null {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
    || fromIndex < 0 || fromIndex >= document.columns.length
    || toIndex < 0 || toIndex >= document.columns.length
    || fromIndex === toIndex) return null;
  const next = cloneDocument(document);
  next.columns = arrayMove(next.columns, fromIndex, toIndex);
  return next;
}

function cardLocation(document: KanbanDocument, id: string) {
  for (let columnIndex = 0; columnIndex < document.columns.length; columnIndex += 1) {
    const cardIndex = document.columns[columnIndex].cards.findIndex((card) => card.id === id);
    if (cardIndex >= 0) return { cardIndex, columnIndex };
  }
  return null;
}

export function kanbanEmptyColumnDropId(columnId: string) {
  return `${EMPTY_COLUMN_DROP_PREFIX}${columnId}`;
}

export interface KanbanCardDropResult {
  document: KanbanDocument;
  targetColumnIndex: number;
}

/**
 * Applies either a card-to-card sort or a card-to-empty-column drop without
 * mutating the parsed Markdown document. Empty-column targets are accepted only
 * while the target column is still empty, so stale drag events fail closed.
 */
export function moveKanbanCardForDrop(
  document: KanbanDocument,
  activeId: string,
  overId: string
): KanbanCardDropResult | null {
  const from = cardLocation(document, activeId);
  if (!from || activeId === overId) return null;

  const targetCard = cardLocation(document, overId);
  let targetColumnIndex = targetCard?.columnIndex ?? -1;
  if (!targetCard && overId.startsWith(EMPTY_COLUMN_DROP_PREFIX)) {
    const targetColumnId = overId.slice(EMPTY_COLUMN_DROP_PREFIX.length);
    targetColumnIndex = document.columns.findIndex((column) => column.id === targetColumnId);
    if (targetColumnIndex < 0 || document.columns[targetColumnIndex].cards.length !== 0) {
      return null;
    }
  }
  if (targetColumnIndex < 0 || (!targetCard && targetColumnIndex === from.columnIndex)) {
    return null;
  }

  const next = cloneDocument(document);
  if (targetCard && from.columnIndex === targetColumnIndex) {
    next.columns[from.columnIndex].cards = arrayMove(
      next.columns[from.columnIndex].cards,
      from.cardIndex,
      targetCard.cardIndex
    );
  } else {
    const [moving] = next.columns[from.columnIndex].cards.splice(from.cardIndex, 1);
    const insertionIndex = targetCard
      ? targetCard.cardIndex
      : next.columns[targetColumnIndex].cards.length;
    next.columns[targetColumnIndex].cards.splice(insertionIndex, 0, moving);
  }
  return { document: next, targetColumnIndex };
}

function KanbanEmptyColumnDropTarget({
  columnId,
  disabled,
  title
}: {
  columnId: string;
  disabled: boolean;
  title: string;
}) {
  const { isOver, setNodeRef } = useDroppable({
    data: { columnId, kind: "kanban-empty-column", label: title },
    disabled,
    id: kanbanEmptyColumnDropId(columnId)
  });

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={`${title} 빈 열 카드 놓기 영역`}
      className="qm-kanban-empty-drop"
      data-drag-over={isOver || undefined}
      ref={setNodeRef}
      role="group"
    >
      <span aria-hidden="true">카드를 여기로 끌어오세요</span>
      <span className="sr-only">키보드에서는 카드의 열 이동 메뉴를 사용하세요.</span>
    </div>
  );
}

export function KanbanBoard({ onChange, onOpenLink, readOnly = false, source }: KanbanBoardProps) {
  const parsed = useMemo(() => parseKanbanSource(source), [source]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [exportText, setExportText] = useState("");
  const [importConfirmed, setImportConfirmed] = useState(false);
  const [importInspection, setImportInspection] = useState<InspectedKanbanImport | null>(null);
  const [importText, setImportText] = useState("");
  const [interopOpen, setInteropOpen] = useState(false);
  const interopPanelId = useId();
  const [message, setMessage] = useState("");
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const document = parsed.document;
  const locked = readOnly || parsed.readOnly;
  if (!document) {
    const visibleErrors = renderedDiagnostics(parsed.errors);
    return <section className="qm-kanban-error" role="alert"><h2>Kanban을 열 수 없습니다</h2><ul>{visibleErrors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul></section>;
  }
  const commit = (next: KanbanDocument) => {
    if (locked) return false;
    try {
      onChange(serializeKanbanDocument(next));
      setMessage("");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Kanban을 저장하지 못했습니다.");
      return false;
    }
  };
  const update = (mutate: (next: KanbanDocument) => void) => {
    if (locked) return false;
    const next = cloneDocument(document);
    mutate(next);
    return commit(next);
  };
  const columnTitles = document.columns.map((column) => column.title);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || locked) return;
    const result = moveKanbanCardForDrop(document, String(active.id), String(over.id));
    if (!result || !commit(result.document)) return;
    const targetTitle = result.document.columns[result.targetColumnIndex]?.title ?? "선택한";
    setMoveAnnouncement(`카드를 ${targetTitle} 열로 옮겼습니다.`);
  };
  const closeInterop = () => {
    setExportText("");
    setImportConfirmed(false);
    setImportInspection(null);
    setImportText("");
    setInteropOpen(false);
  };
  const inspectImport = () => {
    if (locked) return;
    try {
      const result = importKanbanMarkdown(importText);
      setImportConfirmed(false);
      setImportInspection({ baseSource: source, input: importText, result });
      setMessage(result.source
        ? "호환성 검사가 끝났습니다. 교체 내용을 확인하고 명시적으로 동의해야 적용됩니다."
        : "호환되지 않는 Markdown입니다. 현재 보드는 변경하지 않았습니다.");
    } catch {
      setImportConfirmed(false);
      setImportInspection(null);
      setMessage("Kanban Markdown 호환성을 안전하게 검사하지 못했습니다. 현재 보드는 변경하지 않았습니다.");
    }
  };
  const applyInspectedImport = () => {
    if (locked || !importConfirmed || !importInspection?.result.source
      || importInspection.input !== importText) return;
    if (importInspection.baseSource !== source) {
      setImportConfirmed(false);
      setImportInspection(null);
      setMessage("검사 후 현재 보드가 변경되었습니다. 다시 호환성을 검사해주세요.");
      return;
    }
    try {
      onChange(importInspection.result.source);
    } catch {
      setMessage("확인한 Kanban Markdown을 저장 요청하지 못했습니다. 현재 편집 내용을 확인해주세요.");
      return;
    }
    setMessage("확인한 Obsidian Kanban Markdown을 저장 요청했습니다.");
    setExportText("");
    setImportConfirmed(false);
    setImportInspection(null);
    setImportText("");
    setInteropOpen(false);
  };
  const prepareExport = async () => {
    try {
      const text = exportObsidianKanbanMarkdown(document);
      setExportText(text);
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard?.writeText) {
        setMessage("클립보드를 사용할 수 없어 아래 내보내기 원문과 다운로드를 준비했습니다.");
        return;
      }
      try {
        await clipboard.writeText(text);
        setMessage("Obsidian Kanban Markdown을 클립보드에 복사했습니다.");
      } catch {
        setMessage("클립보드 복사에 실패해 아래 내보내기 원문과 다운로드를 준비했습니다.");
      }
    } catch {
      setExportText("");
      setMessage("Kanban Markdown을 안전하게 내보내지 못했습니다.");
    }
  };
  const downloadExport = () => {
    if (!exportText || typeof URL.createObjectURL !== "function") {
      setMessage("이 브라우저에서는 파일 다운로드를 사용할 수 없습니다. 내보내기 원문을 복사해주세요.");
      return;
    }
    try {
      downloadBlob(
        new Blob([exportText], { type: "text/markdown;charset=utf-8" }),
        safeKanbanFilename(document.title)
      );
      setMessage("Obsidian Kanban Markdown 다운로드를 준비했습니다.");
    } catch {
      setMessage("파일 다운로드에 실패했습니다. 내보내기 원문을 복사해주세요.");
    }
  };
  return (
    <section aria-label={`${document.title} Kanban`} className="qm-kanban">
      {parsed.errors.length ? <div className="qm-kanban-warning" role="status">보존할 수 없는 Markdown이 있어 읽기 전용으로 열었습니다. 소스 모드에서 확인하세요.</div> : null}
      {message ? <div className="qm-kanban-warning" role="status">{message}</div> : null}
      <div aria-live="polite" className="sr-only">{moveAnnouncement}</div>
      <div className="qm-kanban-interop-toolbar">
        <button
          aria-controls={interopPanelId}
          aria-expanded={interopOpen}
          onClick={() => {
            if (interopOpen) closeInterop();
            else setInteropOpen(true);
          }}
          type="button"
        ><Upload aria-hidden="true" size={14} /> Obsidian 가져오기·내보내기</button>
      </div>
      {interopOpen ? (
        <section aria-label="Obsidian Kanban 호환 도구" className="qm-kanban-interop" id={interopPanelId}>
          <div className="qm-kanban-interop-section">
            <h3>Obsidian Markdown 가져오기</h3>
            <p>원문은 호환성 검사 전후에도 자동 적용되지 않습니다. 검사 성공 후 교체 동의가 필요합니다.</p>
            <label>
              <span>가져올 Markdown</span>
              <textarea
                disabled={locked}
                maxLength={MAX_KANBAN_INTEROP_CHARACTERS}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setImportText(value);
                  setImportConfirmed(false);
                  setImportInspection(null);
                }}
                placeholder="Obsidian Kanban Markdown을 붙여넣으세요."
                rows={7}
                value={importText}
              />
            </label>
            <button disabled={locked || !importText.trim()} onClick={inspectImport} type="button">호환성 검사</button>
            {importInspection ? (
              <div className="qm-kanban-import-result">
                {importInspection.result.source ? (
                  <>
                    <strong aria-live="polite" role="status">호환 가능</strong>
                    {importInspection.result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                    <label className="qm-kanban-import-confirm">
                      <input
                        checked={importConfirmed}
                        disabled={locked}
                        onChange={(event) => setImportConfirmed(event.currentTarget.checked)}
                        type="checkbox"
                      />
                      <span>현재 보드 본문을 검사한 내용으로 교체하는 데 동의합니다.</span>
                    </label>
                    <button disabled={locked || !importConfirmed} onClick={applyInspectedImport} type="button">확인 후 가져오기 적용</button>
                  </>
                ) : (
                  <>
                    <strong aria-live="polite" role="status">호환 불가 · 현재 보드 변경 없음</strong>
                    <ul>{renderedDiagnostics(importInspection.result.errors).map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div className="qm-kanban-interop-section">
            <h3>Obsidian Markdown 내보내기</h3>
            <p>내보내기는 현재 보드를 변경하거나 외부 서버로 전송하지 않습니다.</p>
            <button disabled={parsed.readOnly} onClick={() => void prepareExport()} type="button"><ClipboardCopy aria-hidden="true" size={14} /> 복사 및 원문 준비</button>
            {exportText ? (
              <>
                <label>
                  <span>내보내기 원문</span>
                  <textarea onFocus={(event) => event.currentTarget.select()} readOnly rows={7} value={exportText} />
                </label>
                <button onClick={downloadExport} type="button"><Download aria-hidden="true" size={14} /> Markdown 다운로드</button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
        <div className="qm-kanban-columns">
          {document.columns.map((column, columnIndex) => (
            <section className="qm-kanban-column" key={column.id}>
              <header>
                <input
                  aria-label={`${column.title} 열 이름`}
                  disabled={locked}
                  maxLength={120}
                  onChange={(event) => {
                    const title = event.currentTarget.value.replace(/[\r\n]/gu, " ");
                    if (title !== column.title) update((next) => { next.columns[columnIndex].title = title; });
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  value={column.title}
                />
                <span>{column.cards.length}</span>
                <span aria-label={`${column.title} 열 순서 이동`} className="qm-kanban-column-move" role="group">
                  <button
                    aria-label={`${column.title} 열 왼쪽으로 이동`}
                    disabled={locked || columnIndex === 0}
                    onClick={() => {
                      const next = moveKanbanColumn(document, columnIndex, columnIndex - 1);
                      if (next && commit(next)) setMoveAnnouncement(`${column.title} 열을 왼쪽으로 옮겼습니다.`);
                    }}
                    type="button"
                  ><ChevronLeft size={14} /></button>
                  <button
                    aria-label={`${column.title} 열 오른쪽으로 이동`}
                    disabled={locked || columnIndex === document.columns.length - 1}
                    onClick={() => {
                      const next = moveKanbanColumn(document, columnIndex, columnIndex + 1);
                      if (next && commit(next)) setMoveAnnouncement(`${column.title} 열을 오른쪽으로 옮겼습니다.`);
                    }}
                    type="button"
                  ><ChevronRight size={14} /></button>
                </span>
                <button aria-label={`${column.title} 열 삭제`} disabled={locked || document.columns.length <= 1 || column.cards.length > 0} onClick={() => update((next) => { next.columns.splice(columnIndex, 1); })} title={column.cards.length ? "카드를 모두 옮긴 뒤 삭제할 수 있습니다." : "열 삭제"} type="button"><Trash2 size={14} /></button>
              </header>
              <SortableContext items={column.cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
                <div className="qm-kanban-cards">
                  {column.cards.length === 0 ? (
                    <KanbanEmptyColumnDropTarget
                      columnId={column.id}
                      disabled={locked}
                      title={column.title}
                    />
                  ) : null}
                  {column.cards.map((card, cardIndex) => (
                    <SortableCard
                      card={card}
                      columnIndex={columnIndex}
                      columns={columnTitles}
                      disabled={locked}
                      key={card.id}
                      onChange={(patch) => update((next) => { Object.assign(next.columns[columnIndex].cards[cardIndex], patch); })}
                      onDelete={() => update((next) => { next.columns[columnIndex].cards.splice(cardIndex, 1); })}
                      onOpenLink={onOpenLink}
                      onMove={(targetColumnIndex) => {
                        const moved = update((next) => {
                          const [moving] = next.columns[columnIndex].cards.splice(cardIndex, 1);
                          next.columns[targetColumnIndex].cards.push(moving);
                        });
                        if (moved && targetColumnIndex !== columnIndex) {
                          setMoveAnnouncement(`카드를 ${columnTitles[targetColumnIndex] ?? "선택한"} 열로 옮겼습니다.`);
                        }
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
              <form onSubmit={(event) => {
                event.preventDefault();
                const text = drafts[column.id]?.trim();
                if (!text || locked) return;
                update((next) => { next.columns[columnIndex].cards.push({ checked: false, checklist: [], id: nextKanbanId("card"), text: text.slice(0, 500) }); });
                setDrafts((current) => ({ ...current, [column.id]: "" }));
              }}>
                <input
                  aria-label={`${column.title}에 카드 추가`}
                  disabled={locked}
                  maxLength={500}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDrafts((current) => ({ ...current, [column.id]: value }));
                  }}
                  placeholder="카드 추가"
                  value={drafts[column.id] ?? ""}
                />
                <button aria-label="카드 추가" disabled={locked || !(drafts[column.id] ?? "").trim()} type="submit"><Plus size={14} /></button>
              </form>
            </section>
          ))}
          <button className="qm-kanban-add-column" disabled={locked || document.columns.length >= 50} onClick={() => update((next) => { next.columns.push({ cards: [], id: `new-column-${Date.now()}`, title: "새 열" }); })} type="button"><Plus size={15} /> 열 추가</button>
        </div>
      </DndContext>
    </section>
  );
}

function SortableCard({
  card,
  columnIndex,
  columns,
  disabled,
  onChange,
  onDelete,
  onMove,
  onOpenLink
}: {
  card: KanbanCard;
  columnIndex: number;
  columns: string[];
  disabled: boolean;
  onChange: (patch: Partial<KanbanCard>) => void;
  onDelete: () => void;
  onMove: (columnIndex: number) => void;
  onOpenLink?: KanbanBoardProps["onOpenLink"];
}) {
  const [text, setText] = useState(card.text);
  useEffect(() => setText(card.text), [card.text]);
  const internalLinks = useMemo(
    () => onOpenLink ? cardInternalLinks(text) : [],
    [onOpenLink, text]
  );
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ disabled, id: card.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <article className="qm-kanban-card" ref={setNodeRef} style={style}>
      <button {...attributes} {...listeners} aria-label="카드 끌어서 이동" className="qm-kanban-handle" disabled={disabled} type="button"><GripVertical size={14} /></button>
      <input aria-label={`${card.text} 완료`} checked={card.checked} disabled={disabled} onChange={(event) => onChange({ checked: event.currentTarget.checked })} type="checkbox" />
      <input
        aria-label="카드 내용"
        className="qm-kanban-card-content"
        disabled={disabled}
        maxLength={500}
        onChange={(event) => {
          const nextText = event.currentTarget.value.replace(/[\r\n]/gu, " ");
          setText(nextText);
          if (nextText !== card.text) onChange({ text: nextText });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        type="text"
        value={text}
      />
      {internalLinks.length ? (
        <span aria-label="카드 내부 링크" className="qm-kanban-card-links" role="group">
          {internalLinks.map((link) => (
            <button
              aria-label={`${link.display} 노트 열기`}
              key={`${link.target}:${link.display}`}
              onClick={() => onOpenLink?.(link.target)}
              type="button"
            >
              <Link2 aria-hidden="true" size={12} />
              <span>{link.display}</span>
            </button>
          ))}
        </span>
      ) : null}
      <div aria-label="카드 체크리스트" className="qm-kanban-checklist" role="group">
        {(card.checklist ?? []).map((item, itemIndex) => (
          <div className="qm-kanban-checklist-item" key={item.id}>
            <input
              aria-label={`${item.text} 완료`}
              checked={item.checked}
              disabled={disabled}
              onChange={(event) => {
                const checklist = (card.checklist ?? []).map((candidate, index) => index === itemIndex
                  ? { ...candidate, checked: event.currentTarget.checked }
                  : candidate);
                onChange({ checklist });
              }}
              type="checkbox"
            />
            <input
              aria-label="체크 항목 내용"
              disabled={disabled}
              maxLength={500}
              onChange={(event) => {
                const nextText = event.currentTarget.value.replace(/[\r\n]/gu, " ");
                const checklist = (card.checklist ?? []).map((candidate, index) => index === itemIndex
                  ? { ...candidate, text: nextText }
                  : candidate);
                onChange({ checklist });
              }}
              value={item.text}
            />
            <button
              aria-label={`${item.text} 체크 항목 삭제`}
              disabled={disabled}
              onClick={() => onChange({ checklist: (card.checklist ?? []).filter((_, index) => index !== itemIndex) })}
              type="button"
            ><Trash2 size={12} /></button>
          </div>
        ))}
        <button
          className="qm-kanban-checklist-add"
          disabled={disabled}
          onClick={() => onChange({
            checklist: [
              ...(card.checklist ?? []),
              { checked: false, id: nextKanbanId("check"), text: "새 체크 항목" }
            ]
          })}
          type="button"
        ><ListPlus size={13} /> 체크 항목</button>
      </div>
      <select aria-label="카드 열 이동" disabled={disabled} onChange={(event) => onMove(Number(event.currentTarget.value))} value={columnIndex}>{columns.map((title, index) => <option key={`${index}:${title}`} value={index}>{title}</option>)}</select>
      <button aria-label="카드 삭제" className="qm-kanban-card-delete" disabled={disabled} onClick={onDelete} type="button"><Trash2 size={13} /></button>
    </article>
  );
}
