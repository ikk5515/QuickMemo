import { ChevronLeft, ChevronRight, PanelLeftClose, X } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ReadonlyNoteRenderer } from "../../components/ReadonlyNoteRenderer";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { MarkdownLinkPreviewInteraction, MarkdownLinkReference } from "../markdown/types";
import type { VaultIndexEntry } from "../knowledge/types";
import type { WikiReadableNote } from "./wikiModel";
import type { WikiPageKnowledge } from "./useWikiKnowledge";
import type { WikiDocumentContext, WikiReaderProps } from "./WikiReader";

export interface WikiDocumentActions {
  activate: (id: string, focus?: boolean) => void;
  close: (id: string) => void;
  collapse: (id: string) => void;
  move: (id: string, direction: -1 | 1) => void;
  reorder: (id: string, toId: string) => void;
  resize: (id: string, width: number) => void;
  followLink: (id: string, reference: MarkdownLinkReference, event: MouseEvent<HTMLElement>) => void;
  previewLink: (id: string, reference: MarkdownLinkReference, interaction: MarkdownLinkPreviewInteraction) => void;
  openLink: (id: string, reference: MarkdownLinkReference, activation?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void;
  articleRef: (id: string, element: HTMLElement | null) => void;
}
interface PanelProps extends Pick<WikiReaderProps, "renderDocument" | "renderDocumentActions" | "renderAsset"> {
  note: WikiReadableNote; entry: VaultIndexEntry; page?: WikiPageKnowledge; entries: ReadonlyMap<string, VaultIndexEntry>;
  x: number; width: number; collapsed: boolean; active: boolean; compact: boolean; exiting: boolean; closing: boolean;
  loading: boolean; ready: boolean; actions: WikiDocumentActions; urlFor: (id: string) => string;
}

/** Geometry updates do not re-render the editor/Markdown subtree. Collapsing
 * changes the viewport around it while keeping its own width and scroll intact. */
export const WikiDocumentPanel = memo(function WikiDocumentPanel({ note, entry, page, entries, x, width, collapsed, active, compact, exiting, closing,
  loading, ready, actions, urlFor, renderDocument, renderDocumentActions, renderAsset }: PanelProps) {
  const article = useRef<HTMLElement | null>(null);
  const setArticle = useCallback((element: HTMLElement | null) => { article.current = element; actions.articleRef(note.id, element); }, [actions, note.id]);
  useLayoutEffect(() => {
    if (!collapsed && width > 0 && article.current) article.current.style.width = `${width}px`;
  }, [collapsed, width]);
  const context = useMemo<WikiDocumentContext>(() => ({ active, collapsed,
    onLinkClick: (reference, event) => actions.followLink(note.id, reference, event),
    onLinkPreviewInteraction: (reference, interaction) => actions.previewLink(note.id, reference, interaction),
    openLink: (reference, activation) => actions.openLink(note.id, reference, activation)
  }), [actions, active, collapsed, note.id]);
  const title = note.title.replace(/\.md$/i, "") || "제목 없는 메모";
  return <section className="wiki-document-slot" data-collapsed={collapsed} data-exiting={exiting || undefined} data-note-id={note.id}
    style={{ width, transform: `translateX(${x}px)` }} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-quickmemo-wiki-panel")) event.preventDefault(); }}
    onDrop={(event) => { const source = event.dataTransfer.getData("application/x-quickmemo-wiki-panel"); if (source) { event.preventDefault(); actions.reorder(source, note.id); } }}>
    <div className="wiki-document-strip" aria-hidden={!collapsed || exiting} inert={!collapsed || exiting}>
      <button aria-label={`${title} 문서 펼치기`} aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" className="wiki-document-strip-title" onClick={() => actions.activate(note.id)} title={title} type="button"
        draggable={!compact} onDragStart={(event) => { event.dataTransfer.setData("application/x-quickmemo-wiki-panel", note.id); event.dataTransfer.effectAllowed = "move"; }}
        onKeyDown={(event) => { if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); actions.move(note.id, event.key === "ArrowLeft" ? -1 : 1); } }}>
        {title}
      </button>
      <button aria-label={`${title} 문서 닫기`} className="wiki-document-close" disabled={closing} onClick={() => actions.close(note.id)} type="button"><X aria-hidden="true" size={15} /></button>
    </div>
    <article aria-hidden={collapsed || exiting || undefined} aria-label={title} className={`wiki-panel${renderDocument ? " wiki-panel--editable" : ""}`}
      data-active={active} data-note-id={note.id} inert={collapsed || exiting} ref={setArticle} tabIndex={-1}
      onFocusCapture={() => { if (!active && !collapsed) actions.activate(note.id, false); }}>
      <div className="wiki-panel-toolbar">
        <span className="wiki-panel-document-title" title={entry.path} draggable={!compact}
          onDragStart={(event) => { event.dataTransfer.setData("application/x-quickmemo-wiki-panel", note.id); event.dataTransfer.effectAllowed = "move"; }}>{title}</span>
        <div className="wiki-panel-actions">
          {renderDocumentActions?.(note, entry, context)}
          <details className="wiki-panel-options"><summary aria-label={`${title} 문서 배치`} title="문서 배치"><PanelLeftClose aria-hidden="true" size={16} /></summary>
            <div role="group" aria-label="문서 배치"><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); actions.move(note.id, -1); }} type="button"><ChevronLeft aria-hidden="true" size={14} />왼쪽으로 이동</button>
              <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); actions.move(note.id, 1); }} type="button"><ChevronRight aria-hidden="true" size={14} />오른쪽으로 이동</button>
              <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); actions.collapse(note.id); }} type="button"><PanelLeftClose aria-hidden="true" size={14} />문서 접기</button></div>
          </details>
          <button aria-label={`${title} 문서 닫기`} className="wiki-document-close" disabled={closing} onClick={() => actions.close(note.id)} title="문서 닫기" type="button"><X aria-hidden="true" size={15} /></button>
        </div>
      </div>
      <WikiDocumentContents note={note} entry={entry} page={page} entries={entries} loading={loading} ready={ready} context={context}
        renderDocument={renderDocument} renderAsset={renderAsset} actions={actions} urlFor={urlFor} />
    </article>
    {!compact && !collapsed && !exiting ? <SidebarResizeHandle label={`${title} 문서 너비 조절`} width={width} minWidth={280} maxWidth={1200} onChange={(next) => actions.resize(note.id, next)} /> : null}
  </section>;
});

const WikiDocumentContents = memo(function WikiDocumentContents({ note, entry, page, entries, loading, ready, context, renderDocument, renderAsset, actions, urlFor }: {
  note: WikiReadableNote; entry: VaultIndexEntry; page?: WikiPageKnowledge; entries: ReadonlyMap<string, VaultIndexEntry>; loading: boolean; ready: boolean;
  context: WikiDocumentContext; actions: WikiDocumentActions; urlFor: (id: string) => string;
} & Pick<WikiReaderProps, "renderDocument" | "renderAsset">) {
  if (renderDocument) return <div className="wiki-document-editor">{renderDocument(note, entry, context)}</div>;
  const title = note.title.replace(/\.md$/i, "") || "제목 없는 메모";
  return <div className="wiki-reading">
    {note.contentFormat === "legacy-html-v1" || loading ? <h1 className="wiki-title">{title}</h1> : null}
    {loading ? <p className="wiki-muted" role="status">본문을 불러오고 있습니다…</p>
      : note.contentFormat === "legacy-html-v1" ? <ReadonlyNoteRenderer className="wiki-body" content={note.body} emptyText="아직 내용이 없는 메모입니다." />
        : <MarkdownRenderer className="wiki-body" documentTitle={{ fallback: title, className: "wiki-title" }} emptyText="아직 내용이 없는 메모입니다." maxCustomEmbeds={32}
          onLinkClick={context.onLinkClick} onLinkPreviewInteraction={context.onLinkPreviewInteraction}
          renderEmbed={(reference) => reference.kind === "external" ? null : renderAsset?.(reference, entry, context.onLinkClick)
            ?? <span className="wiki-asset-placeholder">첨부를 미리 볼 수 없습니다.</span>} source={note.body} />}
    {!loading ? <WikiDocumentBacklinks entries={entries} onNavigate={(id) => actions.activate(id)} page={page} ready={ready} urlFor={urlFor} /> : null}
  </div>;
});

function WikiDocumentBacklinks({ entries, onNavigate, page, ready, urlFor }: {
  entries: ReadonlyMap<string, VaultIndexEntry>; onNavigate: (id: string) => void; page?: WikiPageKnowledge; ready: boolean; urlFor: (id: string) => string;
}) {
  const [limit, setLimit] = useState(12);
  const backlinks = useMemo(() => {
    const seen = new Set<string>();
    return (page?.backlinks ?? []).filter((link) => { if (seen.has(link.sourceEntryId) || !entries.has(link.sourceEntryId)) return false; seen.add(link.sourceEntryId); return true; });
  }, [entries, page]);
  return <section aria-label="이 메모를 연결한 메모" className="wiki-backlinks"><h2>LINKS TO THIS PAGE</h2>
    {!ready ? <p className="wiki-muted">연결을 확인하고 있습니다.</p> : backlinks.length ? <ul>{backlinks.slice(0, limit).map((link) => <li key={link.sourceEntryId}>
      <a href={urlFor(link.sourceEntryId)} title={entries.get(link.sourceEntryId)?.path} onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onNavigate(link.sourceEntryId);
      }}><strong>{entries.get(link.sourceEntryId)?.path.split("/").at(-1)?.replace(/\.md$/i, "")}</strong></a>
    </li>)}</ul> : <p className="wiki-muted">연결된 메모가 없습니다.</p>}
    {backlinks.length > limit ? <button onClick={() => setLimit((value) => value + 12)} type="button">연결 더 보기</button> : null}
  </section>;
}
