import { ArrowLeft, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Expand, List, LockKeyhole, Network, Search, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { MarkdownLinkClickHandler, MarkdownLinkPreviewInteraction, MarkdownLinkReference } from "../markdown/types";
import type { MarkdownHeading, VaultIndexEntry } from "../knowledge/types";
import { previewTextFromHtml } from "../../lib/editorContent";
import { useWikiKnowledge, WIKI_GLOBAL_GRAPH_SETTINGS, WIKI_GRAPH_SETTINGS } from "./useWikiKnowledge";
import { WikiEntriesProjection, wikiFolderPaths, wikiGraphData, wikiOutline, wikiTreeRows, WIKI_GRAPH_NODE_LIMIT, WIKI_LIST_PAGE_SIZE,
  type WikiOutlineNode, type WikiReadableFolder, type WikiReadableNote } from "./wikiModel";
import { WikiPublicProjection } from "./wikiPublicProjection";
import { wikiWorkspaceLayout, type ControlledWikiWorkspace, type WikiWorkspacePanel } from "./wikiWorkspace";
import type { ControlledSidebarPreference } from "../workspace/useResizableSidebar";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle";
import { useLocalSidebarPreference } from "../workspace/sidebarPreference";
import { useWikiWorkspace } from "./useWikiWorkspace";
import { WikiDocumentPanel, type WikiDocumentActions } from "./WikiDocumentPanel";
import "../../styles/wiki.css";

const LazyGraphCanvas = lazy(() => import("../graph/GraphCanvas").then((module) => ({ default: module.GraphCanvas })));
const EMPTY_HEADINGS: readonly MarkdownHeading[] = [];
const EMPTY_ENTRY_MAP: ReadonlyMap<string, VaultIndexEntry> = new Map();
const EMPTY_RESULT_IDS: readonly string[] = [];
const MOBILE_QUERY = "(max-width: 767px)";
function subscribeMobileViewport(notify: () => void) {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY) : null;
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
}
function mobileViewportSnapshot() { return typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches; }
function serverViewportSnapshot() { return false; }

export interface WikiDocumentContext {
  active: boolean;
  collapsed: boolean;
  onLinkClick: MarkdownLinkClickHandler;
  onLinkPreviewInteraction: (reference: MarkdownLinkReference, interaction: MarkdownLinkPreviewInteraction) => void;
  openLink: (reference: MarkdownLinkReference, activation?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void;
}

export interface WikiReaderProps {
  notes: readonly WikiReadableNote[];
  folders: readonly WikiReadableFolder[];
  mode?: "private" | "public";
  title?: string;
  basePath?: string;
  homeLink?: { href: string; label: string };
  onBeforeExit?: () => boolean | Promise<boolean>;
  headerActions?: ReactNode;
  loadingNoteIds?: ReadonlySet<string>;
  publicLinkEntries?: readonly VaultIndexEntry[];
  renderAsset?: (reference: MarkdownLinkReference, sourceEntry: VaultIndexEntry, onLinkClick: MarkdownLinkClickHandler) => ReactNode;
  renderDocument?: (note: WikiReadableNote, entry: VaultIndexEntry, context: WikiDocumentContext) => ReactNode;
  renderDocumentActions?: (note: WikiReadableNote, entry: VaultIndexEntry, context: WikiDocumentContext) => ReactNode;
  treeActions?: ReactNode;
  onNoteContextMenu?: (note: WikiReadableNote, event: MouseEvent<HTMLElement>) => void;
  onFolderContextMenu?: (folder: WikiReadableFolder, event: MouseEvent<HTMLElement>) => void;
  beforeCloseDocument?: (id: string) => boolean | Promise<boolean>;
  onActiveDocumentChange?: (id: string | null) => void;
  openDocumentRequest?: { id: string; requestId: number };
  onHeadingNavigate?: (id: string, fragment: string) => void;
  workspace?: ControlledWikiWorkspace;
  preferenceIdentity?: string;
  sidebarPreference?: ControlledSidebarPreference;
}

/** This reader has no auth, database, or encryption access: all content is supplied by its gate. */
export function WikiReader({ notes: suppliedNotes, folders, mode = "private", title = "QuickMemo", basePath = "/wiki", homeLink, onBeforeExit, headerActions, loadingNoteIds, publicLinkEntries,
  renderAsset, renderDocument, renderDocumentActions, treeActions, onNoteContextMenu, onFolderContextMenu, beforeCloseDocument, onActiveDocumentChange,
  openDocumentRequest, onHeadingNavigate, workspace: controlledWorkspace, preferenceIdentity, sidebarPreference }: WikiReaderProps) {
  const navigateRoute = useNavigate();
  const [exitPending, setExitPending] = useState(false);
  const publicProjection = useMemo(() => new WikiPublicProjection(), []);
  const notes = useMemo(() => mode === "public" ? publicProjection.project(suppliedNotes, folders, publicLinkEntries) : suppliedNotes, [folders, mode, publicLinkEntries, publicProjection, suppliedNotes]);
  useEffect(() => () => publicProjection.clear(), [publicProjection]);
  const entryProjection = useMemo(() => new WikiEntriesProjection(), []);
  useEffect(() => () => entryProjection.clear(), [entryProjection]);
  const entries = useMemo(() => entryProjection.project(notes, folders), [entryProjection, folders, notes]);
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const workspace = useWikiWorkspace(entries, mode, basePath, controlledWorkspace);
  const ids = workspace.state.panels.map((panel) => panel.id);
  const activeId = workspace.state.activeId ?? undefined;
  const mobileViewport = useSyncExternalStore(subscribeMobileViewport, mobileViewportSnapshot, serverViewportSnapshot);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const localSidebar = useLocalSidebarPreference("wiki", preferenceIdentity);
  const sidebar = sidebarPreference ?? localSidebar;
  const sidebarOpen = mobileViewport ? mobileDrawerOpen : !sidebar.collapsed;
  const setSidebarOpen = (open: boolean) => { if (mobileViewport) setMobileDrawerOpen(open); else sidebar.onChange({ width: sidebar.width, collapsed: !open }); };
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [linkStatus, setLinkStatus] = useState("");
  const [graphMode, setGraphMode] = useState<"local" | "global">("local");
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [pendingHeading, setPendingHeading] = useState<{ id: string; fragment: string } | null>(null);
  const [activeHeading, setActiveHeading] = useState("");
  const requestedHeadingRef = useRef<{ articleId: string; target: HTMLElement; slug: string; scrollTop: number } | null>(null);
  const [preview, setPreview] = useState<{ id: string; sourceId: string; left: number; top: number } | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRefs = useRef(new Map<string, HTMLElement>());
  const retainedFocusId = useRef<string | null>(null);
  const stackRef = useRef<HTMLElement>(null);
  const [stackWidth, setStackWidth] = useState(() => Math.max(320, window.innerWidth - 280 - (window.innerWidth >= 1200 ? 300 : 0)));
  const layout = useMemo(() => wikiWorkspaceLayout(workspace.state, stackWidth), [stackWidth, workspace.state]);
  const [exiting, setExiting] = useState<{ panel: WikiWorkspacePanel; index: number; x: number; collapsed: boolean }[]>([]);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const closeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);
  const latestWorkspace = useRef({ workspace, layout });
  useLayoutEffect(() => { latestWorkspace.current = { workspace, layout }; });
  const menuRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const graphButtonRef = useRef<HTMLButtonElement>(null);
  const visibleIds = layout.placements.filter((placement) => !placement.collapsed).map((placement) => placement.id);
  const knowledge = useWikiKnowledge(entries, activeId, deferredQuery, visibleIds, graphMode);
  const graph = useMemo(() => knowledge.active ? wikiGraphData(knowledge.active.graph) : null, [knowledge.active]);
  const headings = knowledge.active?.headings ?? EMPTY_HEADINGS;
  const outline = useMemo(() => wikiOutline(headings), [headings]);
  const urlFor = workspace.urlFor;
  function navigate(id: string, _sourceId?: string, newTab = false, fragment?: string) {
    if (!noteById.has(id)) return;
    if (newTab) {
      window.open(urlFor(id) + (fragment ? "#" + encodeURIComponent(fragment) : ""), "_blank", "noopener,noreferrer");
      return;
    }
    workspace.dispatch({ type: "open", id });
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (mobileViewport) setSidebarOpen(false);
    setLinkStatus(""); setPreview(null);
    setPendingHeading(fragment ? { id, fragment } : null);
  }
  async function exitToHome() {
    if (!homeLink || !onBeforeExit || exitPending) return;
    setExitPending(true);
    try {
      const allowed = await onBeforeExit();
      if (mounted.current && allowed) navigateRoute(homeLink.href);
    } catch { if (mounted.current) setLinkStatus("저장 상태를 확인하지 못했습니다. 다시 시도해주세요."); }
    finally { if (mounted.current) setExitPending(false); }
  }
  async function closePanel(id: string) {
    if (closingIds.has(id)) return;
    setClosingIds((current) => new Set(current).add(id));
    try {
      if (beforeCloseDocument && !(await beforeCloseDocument(id))) return;
      if (!mounted.current) return;
      const current = latestWorkspace.current;
      const index = current.workspace.state.panels.findIndex((panel) => panel.id === id);
      const panel = current.workspace.state.panels[index];
      if (!panel) return;
      const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reducedMotion) {
        const placement = current.layout.placements[index];
        setExiting((exits) => [...exits.filter((item) => item.panel.id !== id), {
          panel, index, x: placement?.x ?? 0, collapsed: placement?.collapsed ?? true
        }]);
        closeTimers.current.set(id, setTimeout(() => { closeTimers.current.delete(id); setExiting((current) => current.filter((item) => item.panel.id !== id)); }, 210));
      }
      current.workspace.dispatch({ type: "close", id });
    } catch { if (mounted.current) setLinkStatus("저장 상태를 확인하지 못했습니다. 문서를 닫기 전에 다시 시도해주세요."); }
    finally { if (mounted.current) setClosingIds((current) => { const next = new Set(current); next.delete(id); return next; }); }
  }
  const revealHeading = useCallback((id: string, heading: MarkdownHeading | string) => {
    let fragment = typeof heading === "string" ? heading.replace(/^#/, "") : heading.slug;
    try { fragment = decodeURIComponent(fragment); } catch { /* Malformed URL escapes remain literal. */ }
    if (onHeadingNavigate) { onHeadingNavigate(id, fragment); setActiveHeading(fragment); return; }
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
  }, [onHeadingNavigate]);

  useEffect(() => {
    const panel = activeId ? panelRefs.current.get(activeId) : null;
    if (!panel || renderDocument) return;
    if (retainedFocusId.current === activeId) { retainedFocusId.current = null; return; }
    const frame = window.requestAnimationFrame(() => {
      panel.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, workspace.navigationVersion, renderDocument]);

  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const measure = () => { const width = stack.getBoundingClientRect().width; if (width > 0) setStackWidth(width); };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(stack);
    if (!observer) window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timers = closeTimers.current;
    return () => { mounted.current = false; timers.forEach(clearTimeout); timers.clear(); };
  }, []);

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
    openLink(sourceId, reference, event);
  }
  function openLink(sourceId: string, reference: MarkdownLinkReference, activation?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
    if (reference.kind === "external") {
      try { const url = new URL(reference.href ?? reference.target); if (url.protocol === "https:" || url.protocol === "http:") window.open(url.href, "_blank", "noopener,noreferrer"); } catch { /* Invalid schemes never navigate. */ }
      return;
    }
    const fragment = reference.subpath?.replace(/^#/, "");
    if (!reference.path && fragment) { revealHeading(sourceId, fragment); return; }
    const occurrence = resolvedTarget(sourceId, reference);
    if (occurrence?.status === "resolved" && occurrence.targetEntryId && noteById.has(occurrence.targetEntryId)) {
      navigate(occurrence.targetEntryId, sourceId, Boolean(activation?.metaKey || activation?.ctrlKey || activation?.shiftKey), fragment);
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
  const activateEvent = useStableEvent((id: string, focus: boolean = true) => {
    if (!noteById.has(id)) return;
    if (!focus && id === activeId) return;
    retainedFocusId.current = focus ? null : id;
    workspace.dispatch({ type: "open", id }, focus);
    setPendingHeading(null); setPreview(null); setLinkStatus("");
    if (mobileViewport) setSidebarOpen(false);
  });
  const closeEvent = useStableEvent((id: string) => { void closePanel(id); });
  const collapseEvent = useStableEvent((id: string) => workspace.dispatch({ type: "toggle-collapse", id }));
  const moveEvent = useStableEvent((id: string, direction: -1 | 1) => workspace.dispatch({ type: "reorder", id, toIndex: ids.indexOf(id) + direction }, false));
  const reorderEvent = useStableEvent((id: string, toId: string) => workspace.dispatch({ type: "reorder", id, toIndex: ids.indexOf(toId) }, false));
  const resizeEvent = useStableEvent((id: string, width: number) => workspace.dispatch({ type: "resize", id, width }, false));
  const followEvent = useStableEvent(followLink);
  const previewEvent = useStableEvent(previewLink);
  // In an editor Ctrl/Meta activates a link instead of moving the caret.
  // Shift additionally requests a browser tab; readonly links retain native modifiers.
  const openLinkEvent = useStableEvent((id: string, reference: MarkdownLinkReference, activation?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
    openLink(id, reference, { shiftKey: activation?.shiftKey }));
  const articleRef = useCallback((id: string, element: HTMLElement | null) => { if (element) panelRefs.current.set(id, element); else panelRefs.current.delete(id); }, []);
  const actions = useMemo<WikiDocumentActions>(() => ({ activate: activateEvent, close: closeEvent, collapse: collapseEvent, move: moveEvent, reorder: reorderEvent,
    resize: resizeEvent, followLink: followEvent, previewLink: previewEvent, openLink: openLinkEvent, articleRef
  }), [activateEvent, articleRef, closeEvent, collapseEvent, followEvent, moveEvent, openLinkEvent, previewEvent, reorderEvent, resizeEvent]);
  const activeChangeEvent = useStableEvent((id: string | null) => onActiveDocumentChange?.(id));
  useEffect(() => { activeChangeEvent(activeId ?? null); }, [activeChangeEvent, activeId]);
  const handledRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!openDocumentRequest || !noteById.has(openDocumentRequest.id)) return;
    const key = JSON.stringify(openDocumentRequest);
    if (handledRequest.current === key) return;
    handledRequest.current = key; activateEvent(openDocumentRequest.id);
  }, [activateEvent, noteById, openDocumentRequest]);
  const stableUrlFor = urlFor;
  const noteContextEvent = useStableEvent((id: string, event: MouseEvent<HTMLElement>) => { const note = noteById.get(id); if (note) onNoteContextMenu?.(note, event); });
  const folderContextEvent = useStableEvent((folder: WikiReadableFolder, event: MouseEvent<HTMLElement>) => onFolderContextMenu?.(folder, event));
  const renderPanels = workspace.state.panels.map((panel, index) => ({ panel, placement: layout.placements[index], exiting: false }));
  for (const exit of exiting) {
    if (!noteById.has(exit.panel.id) || ids.includes(exit.panel.id)) continue;
    renderPanels.splice(Math.min(exit.index, renderPanels.length), 0, { panel: exit.panel, placement: {
      id: exit.panel.id, width: layout.compact ? stackWidth : 0, x: layout.compact ? -16 : exit.x,
      collapsed: exit.collapsed
    }, exiting: true });
  }
  const previewNote = preview ? noteById.get(preview.id) : undefined;
  const graphContent = graph ? <Suspense fallback={<p className="wiki-muted" role="status">연결을 준비하고 있습니다.</p>}>
    <LazyGraphCanvas compactAccessibility={!graphExpanded} fitOnLoad activeNodeId={graph.rootNodeId} edges={graph.edges} nodes={graph.nodes} onNodeOpen={(node, intent) => {
      const id = knowledge.active?.graph.nodes.find((candidate) => candidate.id === node.id)?.entryId;
      if (id) { navigate(id, activeId, intent.target !== "current"); setGraphExpanded(false); }
    }} settings={graphMode === "global" ? WIKI_GLOBAL_GRAPH_SETTINGS : WIKI_GRAPH_SETTINGS} />
  </Suspense> : <p className="wiki-muted" role="status">연결을 준비하고 있습니다.</p>;

  return <div className="private-wiki" data-mode={mode} data-sidebar-open={sidebarOpen} style={{ "--wiki-sidebar-width": `${sidebar.width}px` } as CSSProperties} onKeyDown={(event) => {
    if (event.key !== "Escape" || graphExpanded) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (preview) { setPreview(null); event.preventDefault(); }
    else if (sidebarOpen && mobileViewport) { setSidebarOpen(false); menuRef.current?.focus(); event.preventDefault(); }
    else if (activeId && !renderDocument) { closeEvent(activeId); event.preventDefault(); }
  }}>
    <a className="wiki-skip-link" href="#wiki-article">본문으로 건너뛰기</a>
    <header className="wiki-topbar">
      <button aria-controls="wiki-sidebar" aria-expanded={sidebarOpen} aria-label={sidebarOpen ? "위키 목록 닫기" : "위키 목록 열기"} className="wiki-menu-button" onClick={() => setSidebarOpen(!sidebarOpen)} ref={menuRef} type="button">
        {sidebarOpen ? <X aria-hidden="true" size={19} /> : <List aria-hidden="true" size={19} />}
      </button>
      <Link className="wiki-brand" to={basePath} onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); if (entries[0]) activateEvent(entries[0].id);
      }}><BookOpen aria-hidden="true" size={21} /><span>{title}</span></Link>
      {mode === "private" ? <span className="wiki-private-badge"><LockKeyhole aria-hidden="true" size={13} />비공개</span> : null}
      <div className="wiki-header-actions">{headerActions}{homeLink ? <Link aria-disabled={exitPending || undefined} className="wiki-home-link" to={homeLink.href} onClick={(event) => {
        if (!onBeforeExit || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void exitToHome();
      }}><ArrowLeft aria-hidden="true" size={16} />{homeLink.label}</Link> : null}</div>
    </header>
    <div className="wiki-layout">
      <aside aria-hidden={!sidebarOpen || undefined} aria-label="위키 탐색" className="wiki-sidebar" id="wiki-sidebar" inert={!sidebarOpen}>
        <div className="wiki-sidebar-content">
        <label className="wiki-search"><Search aria-hidden="true" size={16} />
          <input aria-label="위키 검색" autoComplete="off" maxLength={300} onChange={(event) => setQuery(event.target.value)} placeholder="Search page or heading" ref={searchRef} type="search" value={query} />
        </label>
        {query.trim() ? <p className="wiki-search-status" role="status">{query !== deferredQuery || knowledge.searching ? "검색 중…" : knowledge.searchError ? "검색하지 못했습니다. 다시 입력해주세요." : knowledge.resultIds.length ? "검색 결과" : "검색 결과가 없습니다."}</p> : null}
        {treeActions ? <div className="wiki-tree-actions">{treeActions}</div> : null}
        <WikiNavigation activeId={activeId} entries={entries} folders={folders} onNavigate={activateEvent} query={deferredQuery} resultIds={deferredQuery.trim() ? knowledge.resultIds : EMPTY_RESULT_IDS} urlFor={stableUrlFor}
          onNoteContextMenu={onNoteContextMenu ? noteContextEvent : undefined} onFolderContextMenu={onFolderContextMenu ? folderContextEvent : undefined} />
        </div>
        {sidebarOpen && !mobileViewport ? <SidebarResizeHandle label="위키 목록 너비 조절" controls="wiki-sidebar" width={sidebar.width} minWidth={180} maxWidth={Math.max(180, Math.min(520, window.innerWidth - 360))}
          onChange={(width) => sidebar.onChange({ width, collapsed: false })} /> : null}
      </aside>
      <main aria-label="위키 읽기 패널" className="wiki-panel-stack" data-compact={layout.compact} id="wiki-article" ref={stackRef} tabIndex={-1}>
        {layout.compact && ids.length ? <div className="wiki-open-documents">
          <button aria-label="이전 열린 문서" disabled={ids.indexOf(activeId ?? "") <= 0} onClick={() => activateEvent(ids[ids.indexOf(activeId ?? "") - 1])} type="button"><ChevronLeft aria-hidden="true" size={17} /></button>
          <details><summary aria-label="열린 문서 목록">{activeId ? noteById.get(activeId)?.title.replace(/\.md$/i, "") : "문서 선택"}<ChevronDown aria-hidden="true" size={14} /></summary>
            <div className="wiki-open-document-list" role="group" aria-label="열린 문서">{ids.map((id) => <div key={id}>
              <button aria-current={id === activeId ? "page" : undefined} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); activateEvent(id); }} type="button">{noteById.get(id)?.title.replace(/\.md$/i, "")}</button>
              <button aria-label={`${noteById.get(id)?.title.replace(/\.md$/i, "")} 문서 닫기`} disabled={closingIds.has(id)} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); closeEvent(id); }} type="button"><X aria-hidden="true" size={15} /></button>
            </div>)}</div>
          </details>
          <button aria-label="다음 열린 문서" disabled={ids.indexOf(activeId ?? "") >= ids.length - 1} onClick={() => activateEvent(ids[ids.indexOf(activeId ?? "") + 1])} type="button"><ChevronRight aria-hidden="true" size={17} /></button>
        </div> : null}
        <div className="wiki-document-viewport">
          {renderPanels.map(({ panel, placement, exiting: leaving }) => {
            const note = noteById.get(panel.id); const entry = entryById.get(panel.id);
            if (!note || !entry) return null;
            return <WikiDocumentPanel key={panel.id} note={note} entry={entry} page={renderDocument ? undefined : knowledge.pages.get(panel.id)}
              entries={renderDocument ? EMPTY_ENTRY_MAP : entryById} x={placement.x} width={placement.width} collapsed={placement.collapsed} compact={layout.compact}
              active={panel.id === activeId} exiting={leaving} closing={closingIds.has(panel.id)} loading={!renderDocument && Boolean(loadingNoteIds?.has(panel.id))}
              ready={renderDocument ? true : knowledge.ready} actions={actions} urlFor={stableUrlFor} renderDocument={renderDocument} renderDocumentActions={renderDocumentActions} renderAsset={renderAsset} />;
          })}
          {!ids.length ? <div className="wiki-state"><BookOpen aria-hidden="true" size={28} /><h1>열린 문서가 없습니다</h1><p>목록에서 문서를 선택해주세요.</p></div> : null}
        </div>
        {linkStatus ? <p className="wiki-workspace-status" role="status">{linkStatus}</p> : null}
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

const WikiNavigation = memo(function WikiNavigation({ activeId, entries, folders, onNavigate, query, resultIds, urlFor, onNoteContextMenu, onFolderContextMenu }: {
  activeId?: string; entries: readonly VaultIndexEntry[]; folders: readonly WikiReadableFolder[]; onNavigate: (id: string) => void; query: string; resultIds: readonly string[]; urlFor: (id: string) => string;
  onNoteContextMenu?: (id: string, event: MouseEvent<HTMLElement>) => void; onFolderContextMenu?: WikiReaderProps["onFolderContextMenu"];
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rootOpen, setRootOpen] = useState(true);
  const [pagination, setPagination] = useState({ key: "", page: 0 });
  const matching = useMemo(() => new Set(resultIds), [resultIds]);
  const folderByPath = useMemo(() => { const paths = wikiFolderPaths(folders); return new Map(folders.map((folder) => [paths.get(folder.id), folder])); }, [folders]);
  const rows = useMemo(() => query.trim() ? entries.filter((entry) => matching.has(entry.id)).map((entry) => ({ kind: "note" as const, id: entry.id,
    title: entry.path.split("/").at(-1)!.replace(/\.md$/i, ""), depth: 0, path: entry.path })) : wikiTreeRows(entries, collapsed, folders), [collapsed, entries, folders, matching, query]);
  const pageCount = Math.max(1, Math.ceil(rows.length / WIKI_LIST_PAGE_SIZE));
  const page = pagination.key === query ? Math.min(pagination.page, pageCount - 1) : 0;
  const shown = rows.slice(page * WIKI_LIST_PAGE_SIZE, (page + 1) * WIKI_LIST_PAGE_SIZE);
  return <nav aria-label={query.trim() ? "위키 검색 결과" : "위키 폴더와 메모"} className="wiki-navigation">
    {!query.trim() ? <button aria-expanded={rootOpen} className="wiki-tree-root" onClick={() => setRootOpen((value) => !value)} type="button">{rootOpen ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}위키</button> : null}
    {rootOpen || query.trim() ? <ul>{shown.map((row) => <li data-depth={row.depth} key={row.kind + ":" + row.id} style={{ marginInlineStart: Math.min(row.depth, 10) * 14 }}>
      {row.kind === "folder" ? <button aria-expanded={!collapsed.has(row.id)} className="wiki-folder" onClick={() => setCollapsed((current) => {
        const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next;
      })} onContextMenu={(event) => { const folder = folderByPath.get(row.id); if (folder && onFolderContextMenu) { event.preventDefault(); onFolderContextMenu(folder, event); } }} title={row.id} type="button">{collapsed.has(row.id) ? <ChevronRight aria-hidden="true" size={13} /> : <ChevronDown aria-hidden="true" size={13} />}<span>{row.title}</span></button>
        : <a aria-current={activeId === row.id ? "page" : undefined} className="wiki-note-link" href={urlFor(row.id)} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); onNavigate(row.id);
        }} onContextMenu={(event) => { if (onNoteContextMenu) { event.preventDefault(); onNoteContextMenu(row.id, event); } }} title={row.path}><span>{row.title}{query.trim() ? <small>{row.path}</small> : null}</span></a>}
    </li>)}</ul> : null}
    {(rootOpen || query.trim()) && pageCount > 1 ? <div className="wiki-pagination"><button disabled={page === 0} onClick={() => setPagination({ key: query, page: page - 1 })} type="button">이전</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPagination({ key: query, page: page + 1 })} type="button">다음</button></div> : null}
  </nav>;
}, (previous, next) => previous.activeId === next.activeId && previous.query === next.query && previous.resultIds === next.resultIds
  && previous.folders === next.folders && previous.onNavigate === next.onNavigate && previous.urlFor === next.urlFor
  && previous.onNoteContextMenu === next.onNoteContextMenu && previous.onFolderContextMenu === next.onFolderContextMenu
  && previous.entries.length === next.entries.length && previous.entries.every((entry, index) => entry.id === next.entries[index].id && entry.path === next.entries[index].path));

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

function useStableEvent<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
