import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Expand, List, LockKeyhole, Network, Search, X } from "lucide-react";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ReadonlyNoteRenderer } from "../../components/ReadonlyNoteRenderer";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { MarkdownLinkClickHandler, MarkdownLinkPreviewInteraction, MarkdownLinkReference } from "../markdown/types";
import type { MarkdownHeading, ResolvedLinkOccurrence, VaultIndexEntry } from "../knowledge/types";
import { previewTextFromHtml } from "../../lib/editorContent";
import { useWikiKnowledge, WIKI_GLOBAL_GRAPH_SETTINGS, WIKI_GRAPH_SETTINGS, type WikiPageKnowledge } from "./useWikiKnowledge";
import { appendWikiPanel, wikiEntries, wikiGraphData, wikiOutline, wikiPanelIds, wikiTreeRows, WIKI_GRAPH_NODE_LIMIT, WIKI_LIST_PAGE_SIZE,
  type WikiOutlineNode, type WikiReadableFolder, type WikiReadableNote } from "./wikiModel";
import { WikiPublicProjection } from "./wikiPublicProjection";
import "../../styles/wiki.css";

const LazyGraphCanvas = lazy(() => import("../graph/GraphCanvas").then((module) => ({ default: module.GraphCanvas })));
const EMPTY_HEADINGS: readonly MarkdownHeading[] = [];
const MOBILE_QUERY = "(max-width: 767px)";
function subscribeMobileViewport(notify: () => void) {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY) : null;
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
}
function mobileViewportSnapshot() { return typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches; }
function serverViewportSnapshot() { return false; }

export interface WikiReaderProps {
  notes: readonly WikiReadableNote[];
  folders: readonly WikiReadableFolder[];
  mode?: "private" | "public";
  title?: string;
  basePath?: string;
  homeLink?: { href: string; label: string };
  headerActions?: ReactNode;
  loadingNoteIds?: ReadonlySet<string>;
  publicLinkEntries?: readonly VaultIndexEntry[];
  renderAsset?: (reference: MarkdownLinkReference, sourceEntry: VaultIndexEntry, onLinkClick: MarkdownLinkClickHandler) => ReactNode;
}

/** This reader has no auth, database, or encryption access: all content is supplied by its gate. */
export function WikiReader({ notes: suppliedNotes, folders, mode = "private", title = "QuickMemo", basePath = "/wiki", homeLink, headerActions, loadingNoteIds, publicLinkEntries, renderAsset }: WikiReaderProps) {
  const publicProjection = useMemo(() => new WikiPublicProjection(), []);
  const notes = useMemo(() => mode === "public" ? publicProjection.project(suppliedNotes, folders, publicLinkEntries) : suppliedNotes, [folders, mode, publicLinkEntries, publicProjection, suppliedNotes]);
  useEffect(() => () => publicProjection.clear(), [publicProjection]);
  const [params, setParams] = useSearchParams();
  const requestedId = params.get("note");
  const entries = useMemo(() => wikiEntries(notes, folders), [folders, notes]);
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const allowedIds = useMemo(() => new Set(noteById.keys()), [noteById]);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const previousIds = params.getAll("pane").slice(0, 5);
  const rootId = previousIds[0] ?? requestedId ?? entries[0]?.id;
  const ids = wikiPanelIds(rootId, previousIds.length ? [...previousIds.slice(1), ...(requestedId ? [requestedId] : [])] : [], allowedIds);
  const panelSignature = JSON.stringify(ids);
  const [focused, setFocused] = useState<{ signature: string; id: string } | null>(null);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const activeId = focused?.signature === panelSignature && ids.includes(focused.id) ? focused.id : ids.at(-1);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mobileViewport = useSyncExternalStore(subscribeMobileViewport, mobileViewportSnapshot, serverViewportSnapshot);
  const [linkStatus, setLinkStatus] = useState("");
  const [graphMode, setGraphMode] = useState<"local" | "global">("local");
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [pendingHeading, setPendingHeading] = useState<{ id: string; fragment: string } | null>(null);
  const [activeHeading, setActiveHeading] = useState("");
  const requestedHeadingRef = useRef<{ articleId: string; target: HTMLElement; slug: string; scrollTop: number } | null>(null);
  const [preview, setPreview] = useState<{ id: string; sourceId: string; left: number; top: number } | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRefs = useRef(new Map<string, HTMLElement>());
  const menuRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const graphButtonRef = useRef<HTMLButtonElement>(null);
  const knowledge = useWikiKnowledge(entries, activeId, deferredQuery, ids, graphMode);
  const graph = useMemo(() => knowledge.active ? wikiGraphData(knowledge.active.graph) : null, [knowledge.active]);
  const headings = knowledge.active?.headings ?? EMPTY_HEADINGS;
  const outline = useMemo(() => wikiOutline(headings), [headings]);
  const urlFor = (id: string) => basePath + "?note=" + encodeURIComponent(id);

  function writePanels(nextIds: readonly string[]) {
    if (!nextIds.length) return;
    const next = new URLSearchParams({ note: nextIds.at(-1)! });
    nextIds.slice(0, -1).forEach((id) => next.append("pane", id));
    setFocused(null);
    setNavigationVersion((version) => version + 1);
    setParams(next);
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setLinkStatus(""); setSidebarOpen(false); setPreview(null);
  }
  function navigate(id: string, sourceId?: string, newTab = false, fragment?: string) {
    if (!noteById.has(id)) return;
    if (newTab) {
      window.open(urlFor(id) + (fragment ? "#" + encodeURIComponent(fragment) : ""), "_blank", "noopener,noreferrer");
      return;
    }
    writePanels(sourceId ? appendWikiPanel(ids, sourceId, id) : [id]);
    setPendingHeading(fragment ? { id, fragment } : null);
  }
  function closePanel(id: string) {
    const index = ids.indexOf(id);
    if (index > 0) writePanels(ids.slice(0, index));
  }
  const revealHeading = useCallback((id: string, heading: MarkdownHeading | string) => {
    let fragment = typeof heading === "string" ? heading.replace(/^#/, "") : heading.slug;
    try { fragment = decodeURIComponent(fragment); } catch { /* Malformed URL escapes remain literal. */ }
    const normalized = fragment.normalize("NFC").trim().toLocaleLowerCase();
    const article = panelRefs.current.get(id);
    const elements = article?.querySelectorAll<HTMLElement>(".wiki-body h1, .wiki-body h2, .wiki-body h3, .wiki-body h4, .wiki-body h5, .wiki-body h6");
    const target = fragment.startsWith("^")
      ? [...(article?.querySelectorAll<HTMLElement>(".wiki-body [data-block-id]") ?? [])].find((element) => element.dataset.blockId === fragment.slice(1))
      : [...(elements ?? [])].find((element) => element.id === fragment)
        ?? [...(elements ?? [])].find((element) => element.textContent?.normalize("NFC").trim().toLocaleLowerCase() === normalized);
    if (!target) return;
    target.tabIndex = -1;
    target.scrollIntoView?.({ block: "start", inline: "nearest", behavior: "instant" });
    target.focus({ preventScroll: true });
    if (article && !fragment.startsWith("^")) requestedHeadingRef.current = { articleId: id, target, slug: target.id || fragment, scrollTop: article.scrollTop };
    setActiveHeading(fragment);
  }, []);

  useEffect(() => {
    const currentIds = JSON.parse(panelSignature) as string[];
    const panel = panelRefs.current.get(currentIds.at(-1) ?? "");
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      panel.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationVersion, panelSignature]);

  useEffect(() => {
    if (!mobileViewport || !sidebarOpen) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [mobileViewport, sidebarOpen]);

  useEffect(() => {
    const id = pendingHeading?.id ?? activeId;
    if (!id) return;
    let fragment = pendingHeading?.fragment ?? "";
    if (!fragment) { try { fragment = decodeURIComponent(window.location.hash.slice(1)); } catch { /* Invalid URL fragments are ignored. */ } }
    if (!fragment) return;
    const frame = window.requestAnimationFrame(() => revealHeading(id, fragment));
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, pendingHeading, revealHeading]);

  useEffect(() => {
    if (requestedHeadingRef.current && !requestedHeadingRef.current.target.isConnected) requestedHeadingRef.current = null;
    const article = activeId ? panelRefs.current.get(activeId) : null;
    if (!article || !headings.length) return;
    const elements = [...article.querySelectorAll<HTMLElement>(".wiki-body h1, .wiki-body h2, .wiki-body h3, .wiki-body h4, .wiki-body h5, .wiki-body h6")];
    const headingInset = (elements[0] ? Number.parseFloat(window.getComputedStyle(elements[0]).scrollMarginTop) : 0) || 78;
    const update = () => {
      const requested = requestedHeadingRef.current;
      if (requested && requested.articleId === activeId) {
        // Near the end (or in a short article), the requested heading cannot
        // reach the top inset. Keep explicit navigation until scrolling moves.
        if (requested.target.isConnected && requested.target.id === requested.slug && Math.abs(article.scrollTop - requested.scrollTop) < 1) {
          setActiveHeading(requested.slug); return;
        }
        requestedHeadingRef.current = null;
      }
      const top = article.getBoundingClientRect().top + headingInset + 12;
      let current = elements[0];
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= top) current = element;
        else break;
      }
      if (article.scrollHeight > article.clientHeight + 1 && article.scrollTop + article.clientHeight >= article.scrollHeight - 2) current = elements.at(-1) ?? current;
      if (current) setActiveHeading(current.id);
    };
    update();
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(update, { root: article, rootMargin: "-60px 0px -65% 0px" }) : null;
    if (!observer) article.addEventListener("scroll", update, { passive: true });
    elements.forEach((element) => observer?.observe(element));
    return () => { article.removeEventListener("scroll", update); observer?.disconnect(); };
  }, [activeId, headings]);

  useEffect(() => () => { if (previewTimer.current) clearTimeout(previewTimer.current); }, []);

  function resolvedTarget(sourceId: string, reference: MarkdownLinkReference) {
    return knowledge.pages.get(sourceId)?.outgoing.find((link) => link.target === reference.path
      && link.syntax === (reference.kind === "wikilink" ? "wikilink" : "markdown"));
  }
  function followLink(sourceId: string, reference: MarkdownLinkReference, event: MouseEvent<HTMLElement>) {
    if (reference.kind === "external") return;
    event.preventDefault();
    const fragment = reference.subpath?.replace(/^#/, "");
    if (!reference.path && fragment) { revealHeading(sourceId, fragment); return; }
    const occurrence = resolvedTarget(sourceId, reference);
    if (occurrence?.status === "resolved" && occurrence.targetEntryId && noteById.has(occurrence.targetEntryId)) {
      navigate(occurrence.targetEntryId, sourceId, event.metaKey || event.ctrlKey || event.shiftKey, fragment);
    } else setLinkStatus(occurrence?.status === "ambiguous"
      ? "같은 이름의 메모가 여러 개입니다. 검색에서 폴더 경로를 확인해주세요."
      : "이 링크의 메모를 위키에서 찾을 수 없습니다.");
  }
  function previewLink(sourceId: string, reference: MarkdownLinkReference, interaction: MarkdownLinkPreviewInteraction) {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!interaction.active) { previewTimer.current = setTimeout(() => setPreview(null), 160); return; }
    const occurrence = resolvedTarget(sourceId, reference);
    const id = occurrence?.status === "resolved" ? occurrence.targetEntryId : undefined;
    if (!id || !noteById.has(id)) return;
    const rect = interaction.anchor.getBoundingClientRect();
    previewTimer.current = setTimeout(() => setPreview({ id, sourceId,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 240))
    }), interaction.source === "focus" ? 0 : 220);
  }
  const previewNote = preview ? noteById.get(preview.id) : undefined;
  const graphContent = graph ? <Suspense fallback={<p className="wiki-muted" role="status">연결을 준비하고 있습니다.</p>}>
    <LazyGraphCanvas compactAccessibility={!graphExpanded} fitOnLoad activeNodeId={graph.rootNodeId} edges={graph.edges} nodes={graph.nodes} onNodeOpen={(node, intent) => {
      const id = knowledge.active?.graph.nodes.find((candidate) => candidate.id === node.id)?.entryId;
      if (id) { navigate(id, activeId, intent.target !== "current"); setGraphExpanded(false); }
    }} settings={graphMode === "global" ? WIKI_GLOBAL_GRAPH_SETTINGS : WIKI_GRAPH_SETTINGS} />
  </Suspense> : <p className="wiki-muted" role="status">연결을 준비하고 있습니다.</p>;

  return <div className="private-wiki" data-mode={mode} data-sidebar-open={sidebarOpen} onKeyDown={(event) => {
    if (event.key !== "Escape" || graphExpanded) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (preview) { setPreview(null); event.preventDefault(); }
    else if (sidebarOpen) { setSidebarOpen(false); menuRef.current?.focus(); event.preventDefault(); }
    else if (ids.length > 1) { closePanel(ids.at(-1)!); event.preventDefault(); }
  }}>
    <a className="wiki-skip-link" href="#wiki-article">본문으로 건너뛰기</a>
    <header className="wiki-topbar">
      <button aria-controls="wiki-sidebar" aria-expanded={sidebarOpen} aria-label={sidebarOpen ? "위키 목록 닫기" : "위키 목록 열기"} className="wiki-menu-button" onClick={() => setSidebarOpen((value) => !value)} ref={menuRef} type="button">
        {sidebarOpen ? <X aria-hidden="true" size={19} /> : <List aria-hidden="true" size={19} />}
      </button>
      <Link className="wiki-brand" to={basePath}><BookOpen aria-hidden="true" size={21} /><span>{title}<strong>위키</strong></span></Link>
      {mode === "private" ? <span className="wiki-private-badge"><LockKeyhole aria-hidden="true" size={13} />비공개</span> : null}
      <div className="wiki-header-actions">{headerActions}{homeLink ? <Link className="wiki-home-link" to={homeLink.href}><ArrowLeft aria-hidden="true" size={16} />{homeLink.label}</Link> : null}</div>
    </header>
    <div className="wiki-layout">
      <aside aria-hidden={mobileViewport && !sidebarOpen || undefined} aria-label="위키 탐색" className="wiki-sidebar" id="wiki-sidebar" inert={mobileViewport && !sidebarOpen}>
        <div className="wiki-sidebar-content">
        <label className="wiki-search"><Search aria-hidden="true" size={16} />
          <input aria-label="위키 검색" autoComplete="off" maxLength={300} onChange={(event) => setQuery(event.target.value)} placeholder="Search page or heading" ref={searchRef} type="search" value={query} />
        </label>
        {query.trim() ? <p className="wiki-search-status" role="status">{query !== deferredQuery || knowledge.searching ? "검색 중…" : knowledge.searchError ? "검색하지 못했습니다. 다시 입력해주세요." : knowledge.resultIds.length ? "검색 결과" : "검색 결과가 없습니다."}</p> : null}
        <WikiNavigation activeId={activeId} entries={entries} onNavigate={(id) => navigate(id)} query={deferredQuery} resultIds={knowledge.resultIds} urlFor={urlFor} />
        </div>
      </aside>
      <main aria-label="위키 읽기 패널" className="wiki-panel-stack" data-stacked={ids.length > 1} id="wiki-article" tabIndex={-1}>
        {ids.length ? ids.map((id, index) => {
          const note = noteById.get(id)!; const entry = entryById.get(id)!;
          const page = knowledge.pages.get(id);
          return <article aria-hidden={mobileViewport && id !== activeId || undefined} aria-label={note.title.replace(/\.md$/i, "") || "제목 없는 메모"} className="wiki-panel" data-active={id === activeId} data-note-id={id} inert={mobileViewport && id !== activeId} key={id}
            onFocusCapture={() => setFocused({ signature: panelSignature, id })} onPointerDown={() => setFocused({ signature: panelSignature, id })}
            ref={(element) => { if (element) panelRefs.current.set(id, element); else panelRefs.current.delete(id); }} tabIndex={-1}>
            <div className="wiki-panel-toolbar">
              {index > 0 ? <button aria-label="이전 읽기 패널로 돌아가기" className="wiki-panel-back" onClick={() => closePanel(id)} type="button"><ArrowLeft aria-hidden="true" size={16} /><span>이전 메모</span></button>
                : <span className="wiki-breadcrumb">{entry.path.replace(/\.md$/i, "").split("/").join(" / ")}</span>}
              {index > 0 ? <span className="wiki-breadcrumb">{note.title.replace(/\.md$/i, "")}</span> : null}
            </div>
            <div className="wiki-reading">
              {note.contentFormat === "legacy-html-v1" || loadingNoteIds?.has(id) ? <h1 className="wiki-title">{note.title.replace(/\.md$/i, "") || "제목 없는 메모"}</h1> : null}
              {loadingNoteIds?.has(id) ? <p className="wiki-muted" role="status">본문을 불러오고 있습니다…</p>
                : note.contentFormat === "legacy-html-v1" ? <ReadonlyNoteRenderer className="wiki-body" content={note.body} emptyText="아직 내용이 없는 메모입니다." />
                : <MarkdownRenderer className="wiki-body" documentTitle={{ fallback: note.title.replace(/\.md$/i, "") || "제목 없는 메모", className: "wiki-title" }} emptyText="아직 내용이 없는 메모입니다." maxCustomEmbeds={32}
                  onLinkClick={(reference, event) => followLink(id, reference, event)} onLinkPreviewInteraction={(reference, interaction) => previewLink(id, reference, interaction)}
                  renderEmbed={(reference) => reference.kind === "external" ? null : renderAsset?.(reference, entry, (ref, event) => followLink(id, ref, event))
                    ?? <span className="wiki-asset-placeholder">{reference.display}</span>} source={note.body} />}
              {id === activeId && linkStatus ? <p className="wiki-link-status" role="status">{linkStatus}</p> : null}
              <WikiBacklinks entries={entryById} onNavigate={(targetId) => navigate(targetId, id)} page={page} ready={knowledge.ready} urlFor={urlFor} />
              {index > 0 ? <div className="wiki-panel-footer"><button aria-label={note.title + " 읽기 패널 닫기"} className="wiki-icon-button" onClick={() => closePanel(id)} title="읽기 패널 닫기" type="button"><X aria-hidden="true" size={19} /></button></div> : null}
            </div>
          </article>;
        }) : <div className="wiki-state"><BookOpen aria-hidden="true" size={36} />
          <h1>{requestedId ? "메모를 찾을 수 없습니다" : "아직 읽을 메모가 없습니다"}</h1>
          <p>{requestedId ? "삭제되었거나 이 위키에서 읽을 수 없는 메모입니다. 목록에서 다른 메모를 선택해주세요." : "선택한 메모가 여기에 표시됩니다."}</p>
        </div>}
      </main>
      {activeId ? <aside aria-label="현재 메모 정보" className="wiki-context">
        <section aria-label="연결된 메모 그래프" className="wiki-local-graph">
          <div className="wiki-section-label"><h2>INTERACTIVE GRAPH</h2></div>
          <div className="wiki-graph-box"><div className="wiki-graph-actions">
            <button aria-label="그래프 크게 보기" className="wiki-icon-button" onClick={() => setGraphExpanded(true)} ref={graphButtonRef} title="그래프 크게 보기" type="button"><Expand aria-hidden="true" size={16} /></button>
            <button aria-label={graphMode === "local" ? "전체 위키 그래프 보기" : "현재 메모 연결 보기"} aria-pressed={graphMode === "global"} className="wiki-icon-button" onClick={() => setGraphMode((value) => value === "local" ? "global" : "local")} title={graphMode === "local" ? "전체 위키 그래프 보기" : "현재 메모 연결 보기"} type="button"><Network aria-hidden="true" size={17} /></button>
          </div>{graphExpanded ? <div className="wiki-graph-paused" /> : graphContent}</div>
          {(knowledge.active?.graph.nodes.length ?? 0) > WIKI_GRAPH_NODE_LIMIT ? <p className="wiki-muted">연결이 많은 메모 {WIKI_GRAPH_NODE_LIMIT}개를 표시합니다.</p> : null}
        </section>
        <details className="wiki-toc" open><summary>ON THIS PAGE</summary>
          <nav aria-label="현재 메모 목차">{outline.length ? <WikiOutline nodes={outline} activeSlug={activeHeading} onSelect={(heading) => revealHeading(activeId, heading)} /> : <p className="wiki-muted">소제목이 없습니다.</p>}</nav>
        </details>
        {knowledge.indexError ? <p className="wiki-muted" role="status">연결 정보를 불러오지 못했습니다. 메모 본문은 계속 읽을 수 있습니다.</p> : null}
      </aside> : null}
    </div>
    {preview && previewNote ? <div className="wiki-hover-preview" onMouseEnter={() => { if (previewTimer.current) clearTimeout(previewTimer.current); }} onMouseLeave={() => setPreview(null)} role="region" aria-label="연결된 메모 미리보기" style={{ left: preview.left, top: preview.top }}>
      <strong>{previewNote.title.replace(/\.md$/i, "")}</strong><p>{(previewNote.contentFormat === "legacy-html-v1" ? previewTextFromHtml(previewNote.body) : previewNote.body).slice(0, 420)}</p>
      <button onClick={() => navigate(preview.id, preview.sourceId)} type="button">읽기 패널에서 열기<ChevronRight aria-hidden="true" size={14} /></button>
    </div> : null}
    {graphExpanded ? <WikiGraphDialog onClose={() => { setGraphExpanded(false); graphButtonRef.current?.focus(); }}>{graphContent}</WikiGraphDialog> : null}
  </div>;
}

function WikiNavigation({ activeId, entries, onNavigate, query, resultIds, urlFor }: {
  activeId?: string; entries: readonly VaultIndexEntry[]; onNavigate: (id: string) => void; query: string; resultIds: readonly string[]; urlFor: (id: string) => string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rootOpen, setRootOpen] = useState(true);
  const [pagination, setPagination] = useState({ key: "", page: 0 });
  const matching = useMemo(() => new Set(resultIds), [resultIds]);
  const rows = useMemo(() => query.trim() ? entries.filter((entry) => matching.has(entry.id)).map((entry) => ({ kind: "note" as const, id: entry.id,
    title: entry.path.split("/").at(-1)!.replace(/\.md$/i, ""), depth: 0, path: entry.path })) : wikiTreeRows(entries, collapsed), [collapsed, entries, matching, query]);
  const pageCount = Math.max(1, Math.ceil(rows.length / WIKI_LIST_PAGE_SIZE));
  const page = pagination.key === query ? Math.min(pagination.page, pageCount - 1) : 0;
  const shown = rows.slice(page * WIKI_LIST_PAGE_SIZE, (page + 1) * WIKI_LIST_PAGE_SIZE);
  return <nav aria-label={query.trim() ? "위키 검색 결과" : "위키 폴더와 메모"} className="wiki-navigation">
    {!query.trim() ? <button aria-expanded={rootOpen} className="wiki-tree-root" onClick={() => setRootOpen((value) => !value)} type="button">{rootOpen ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}위키</button> : null}
    {rootOpen || query.trim() ? <ul>{shown.map((row) => <li data-depth={row.depth} key={row.kind + ":" + row.id} style={{ marginInlineStart: Math.min(row.depth, 10) * 14 }}>
      {row.kind === "folder" ? <button aria-expanded={!collapsed.has(row.id)} className="wiki-folder" onClick={() => setCollapsed((current) => {
        const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next;
      })} title={row.id} type="button">{collapsed.has(row.id) ? <ChevronRight aria-hidden="true" size={13} /> : <ChevronDown aria-hidden="true" size={13} />}<span>{row.title}</span></button>
        : <a aria-current={activeId === row.id ? "page" : undefined} className="wiki-note-link" href={urlFor(row.id)} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); onNavigate(row.id);
        }} title={row.path}><span>{row.title}{query.trim() ? <small>{row.path}</small> : null}</span></a>}
    </li>)}</ul> : null}
    {(rootOpen || query.trim()) && pageCount > 1 ? <div className="wiki-pagination"><button disabled={page === 0} onClick={() => setPagination({ key: query, page: page - 1 })} type="button">이전</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPagination({ key: query, page: page + 1 })} type="button">다음</button></div> : null}
  </nav>;
}

function WikiBacklinks({ entries, onNavigate, page, ready, urlFor }: {
  entries: ReadonlyMap<string, VaultIndexEntry>; onNavigate: (id: string) => void; page: WikiPageKnowledge | undefined; ready: boolean; urlFor: (id: string) => string;
}) {
  const [limit, setLimit] = useState(12);
  const backlinks = useMemo(() => {
    const seen = new Set<string>();
    return (page?.backlinks ?? []).filter((link: ResolvedLinkOccurrence) => {
      if (seen.has(link.sourceEntryId) || !entries.has(link.sourceEntryId)) return false;
      seen.add(link.sourceEntryId); return true;
    });
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

function WikiOutline({ nodes, activeSlug, onSelect }: { nodes: readonly WikiOutlineNode[]; activeSlug: string; onSelect: (heading: MarkdownHeading) => void }) {
  return <ol>{nodes.map(({ heading, children }) => <li key={heading.line + ":" + heading.slug}>
    <button aria-current={heading.slug === activeSlug ? "location" : undefined} onClick={() => onSelect(heading)} type="button">{heading.text}</button>
    {children.length ? <WikiOutline nodes={children} activeSlug={activeSlug} onSelect={onSelect} /> : null}
  </li>)}</ol>;
}

function WikiGraphDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    return () => { if (typeof dialog.close === "function") dialog.close(); };
  }, []);
  return <dialog aria-label="위키 그래프 크게 보기" className="wiki-graph-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} ref={ref}>
    <div className="wiki-graph-dialog-header"><h2>INTERACTIVE GRAPH</h2><button aria-label="그래프 닫기" className="wiki-icon-button" onClick={onClose} type="button"><X aria-hidden="true" size={20} /></button></div>
    {children}
  </dialog>;
}
