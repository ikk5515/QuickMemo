import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, FileText, Folder, List, LockKeyhole, Search, X } from "lucide-react";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { UnlockPanel } from "../components/UnlockPanel";
import { ReadonlyNoteRenderer } from "../components/ReadonlyNoteRenderer";
import { useAuth } from "../context/AuthContext";
import { useVaultDecryptionSession } from "../context/VaultDecryptionContext";
import type { NoteSnapshot } from "../services/notes";
import { MarkdownRenderer } from "../features/markdown/MarkdownRenderer";
import type { MarkdownLinkReference } from "../features/markdown/types";
import type { MarkdownHeading, ResolvedLinkOccurrence, VaultIndexEntry } from "../features/knowledge/types";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../features/vault/vaultData";
import { usePrivateWikiData } from "../features/wiki/usePrivateWikiData";
import { WikiAssetEmbed, useWikiAssetReader } from "../features/wiki/WikiAssetEmbed";
import { useWikiKnowledge, WIKI_GRAPH_SETTINGS } from "../features/wiki/useWikiKnowledge";
import { wikiEntries, wikiGraphData, wikiTreeRows, WIKI_GRAPH_NODE_LIMIT, WIKI_LIST_PAGE_SIZE } from "../features/wiki/wikiModel";
import { hasFeatureAccess } from "../lib/featureAccess";
import "../styles/wiki.css";

const LazyGraphCanvas = lazy(() => import("../features/graph/GraphCanvas").then((module) => ({ default: module.GraphCanvas })));

function wikiUrl(id: string) { return `/wiki?note=${encodeURIComponent(id)}`; }

export default function WikiPage() {
  const { firebaseUser, profile, privateKey } = useAuth();
  if (!firebaseUser || !profile || profile.uid !== firebaseUser.uid || !profile.isActive || !hasFeatureAccess(profile, "notes")) return null;
  if (!privateKey) return <div className="private-wiki private-wiki--locked"><WikiHomeLink /><UnlockPanel /></div>;
  return <WikiDataGate privateKey={privateKey} uid={profile.uid} />;
}

function WikiHomeLink() {
  return <Link className="wiki-home-link" to="/app"><ArrowLeft aria-hidden="true" size={16} />메모로 돌아가기</Link>;
}

function WikiDataGate({ privateKey, uid }: { privateKey: CryptoKey; uid: string }) {
  const data = usePrivateWikiData(uid, privateKey);
  if (!data.ready) return (
    <div className="private-wiki private-wiki--locked">
      <WikiHomeLink />
      <div className="wiki-state" role={data.error ? "alert" : "status"}>
        <BookOpen aria-hidden="true" size={30} />
        <h1>나의 위키</h1>
        <p>{data.error ?? "암호화된 메모를 안전하게 열고 있습니다."}</p>
        {data.error ? <button onClick={data.retry} type="button">다시 시도</button> : null}
      </div>
    </div>
  );
  return <WikiReader assetSnapshots={data.assetSnapshots} folders={data.folders} notes={data.notes} privateKey={privateKey} uid={uid} />;
}

function WikiReader({ assetSnapshots, folders, notes, privateKey, uid }: {
  assetSnapshots: NoteSnapshot[]; folders: DecryptedVaultFolder[]; notes: DecryptedVaultNote[]; privateKey: CryptoKey; uid: string;
}) {
  const session = useVaultDecryptionSession();
  const assetReader = useWikiAssetReader(session ? { uid, privateKey, session, snapshots: assetSnapshots, folders } : null);
  const [params, setParams] = useSearchParams();
  const requestedId = params.get("note");
  const entries = useMemo(() => wikiEntries(notes, folders), [folders, notes]);
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const activeId = requestedId ?? entries[0]?.id;
  const note = activeId ? noteById.get(activeId) : undefined;
  const renderedNoteId = note?.id;
  const activeEntry = activeId ? entryById.get(activeId) : undefined;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [linkStatus, setLinkStatus] = useState("");
  const [pendingHeading, setPendingHeading] = useState<{ id: string; fragment: string } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const knowledge = useWikiKnowledge(entries, note?.id, deferredQuery);
  const graph = useMemo(() => knowledge.active ? wikiGraphData(knowledge.active.graph) : null, [knowledge.active]);

  function navigate(id: string, newTab = false, fragment?: string) {
    if (!noteById.has(id)) return;
    if (newTab) {
      window.open(`${wikiUrl(id)}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`, "_blank", "noopener,noreferrer");
      return;
    }
    setParams({ note: id });
    setLinkStatus("");
    setSidebarOpen(false);
    setPendingHeading(fragment ? { id, fragment } : null);
    articleRef.current?.scrollTo?.({ top: 0 });
    window.scrollTo?.({ top: 0 });
  }

  const revealHeading = useCallback((heading: MarkdownHeading | string) => {
    const fragment = typeof heading === "string" ? heading.replace(/^#/, "") : heading.slug;
    const normalized = fragment.normalize("NFC").trim().toLocaleLowerCase();
    const elements = articleRef.current?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
    const target = [...(elements ?? [])].find((element) => (
      element.id === fragment || element.textContent?.normalize("NFC").trim().toLocaleLowerCase() === normalized
    ));
    if (!target) return;
    target.tabIndex = -1;
    target.scrollIntoView?.({ block: "start", behavior: "instant" });
    target.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!renderedNoteId) return;
    const fragment = pendingHeading?.id === renderedNoteId ? pendingHeading.fragment : (() => {
      try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ""; }
    })();
    if (!fragment) return;
    const frame = window.requestAnimationFrame(() => revealHeading(fragment));
    return () => window.cancelAnimationFrame(frame);
  }, [renderedNoteId, pendingHeading, revealHeading]);

  function followLink(reference: MarkdownLinkReference, event: MouseEvent<HTMLElement>) {
    if (reference.kind === "external") return;
    event.preventDefault();
    const fragment = reference.subpath?.replace(/^#/, "");
    if (!reference.path && fragment) {
      revealHeading(fragment);
      return;
    }
    const occurrence = knowledge.active?.outgoing.find((link) => (
      link.target === reference.path && link.syntax === (reference.kind === "wikilink" ? "wikilink" : "markdown")
    ));
    if (occurrence?.status === "resolved" && occurrence.targetEntryId && noteById.has(occurrence.targetEntryId)) {
      navigate(occurrence.targetEntryId, event.metaKey || event.ctrlKey || event.shiftKey, fragment);
    } else setLinkStatus(occurrence?.status === "ambiguous"
      ? "같은 이름의 메모가 여러 개입니다. 검색에서 폴더 경로를 확인해주세요."
      : "이 링크의 메모를 위키에서 찾을 수 없습니다.");
  }

  const backlinks = useMemo(() => {
    const seen = new Set<string>();
    return (knowledge.active?.backlinks ?? []).filter((link) => {
      if (seen.has(link.sourceEntryId) || !entryById.has(link.sourceEntryId)) return false;
      seen.add(link.sourceEntryId);
      return true;
    });
  }, [entryById, knowledge.active]);

  function renderEmbed(reference: MarkdownLinkReference) {
    if (!activeEntry || reference.kind === "external") return null;
    return <WikiAssetEmbed onLinkClick={followLink} reader={assetReader} reference={reference} sourceEntry={activeEntry} />;
  }

  return (
    <div className="private-wiki" data-sidebar-open={sidebarOpen}>
      <a className="wiki-skip-link" href="#wiki-article">본문으로 건너뛰기</a>
      <header className="wiki-topbar">
        <button aria-controls="wiki-sidebar" aria-expanded={sidebarOpen} aria-label={sidebarOpen ? "위키 목록 닫기" : "위키 목록 열기"} className="wiki-menu-button" onClick={() => setSidebarOpen((value) => !value)} ref={menuRef} type="button">
          {sidebarOpen ? <X aria-hidden="true" size={19} /> : <List aria-hidden="true" size={19} />}
        </button>
        <Link className="wiki-brand" to="/wiki"><BookOpen aria-hidden="true" size={21} /><span>QuickMemo <strong>위키</strong></span></Link>
        <span className="wiki-private-badge"><LockKeyhole aria-hidden="true" size={13} />나만의 읽기 공간</span>
        <WikiHomeLink />
      </header>
      <div className="wiki-layout">
        <aside aria-label="위키 탐색" className="wiki-sidebar" id="wiki-sidebar" onKeyDown={(event) => {
          if (event.key === "Escape") { setSidebarOpen(false); menuRef.current?.focus(); }
        }}>
          <label className="wiki-search">
            <Search aria-hidden="true" size={17} />
            <input aria-label="위키 검색" autoComplete="off" maxLength={300} onChange={(event) => setQuery(event.target.value)} placeholder="메모 검색" type="search" value={query} />
          </label>
          <p className="wiki-search-caption">제목과 본문에서 찾기</p>
          {query.trim() ? <p className="wiki-search-status" role="status">{query !== deferredQuery || knowledge.searching ? "검색 중…" : knowledge.searchError ? "검색하지 못했습니다. 다시 입력해주세요." : `${knowledge.resultIds.length}개의 메모`}</p> : <p className="wiki-list-label">모든 메모 <span>{entries.length}</span></p>}
          <WikiNavigation activeId={note?.id} entries={entries} onNavigate={navigate} query={deferredQuery} resultIds={knowledge.resultIds} />
          <p className="wiki-sidebar-footer">저장한 메모를 읽고 연결을 따라가세요.</p>
        </aside>
        <main className="wiki-reading" id="wiki-article" ref={articleRef} tabIndex={-1}>
          {note && activeEntry ? <>
            <div className="wiki-breadcrumb">{activeEntry.path.split("/").slice(0, -1).join(" / ") || "나의 메모"}</div>
            <h1 className="wiki-title">{note.title.replace(/\.md$/i, "") || "제목 없는 메모"}</h1>
            {note.contentFormat === "legacy-html-v1"
              ? <ReadonlyNoteRenderer className="wiki-body" content={note.body} emptyText="아직 내용이 없는 메모입니다." />
              : <MarkdownRenderer className="wiki-body" emptyText="아직 내용이 없는 메모입니다." key={note.id} maxCustomEmbeds={32} onLinkClick={followLink} renderEmbed={renderEmbed} source={note.body} />}
            {linkStatus ? <p className="wiki-link-status" role="status">{linkStatus}</p> : null}
            <WikiBacklinks backlinks={backlinks} entries={entryById} onNavigate={navigate} ready={knowledge.ready} />
          </> : <div className="wiki-state">
            <BookOpen aria-hidden="true" size={36} />
            <h1>{requestedId ? "메모를 찾을 수 없습니다" : "메모가 모여 위키가 됩니다"}</h1>
            <p>{requestedId ? "삭제되었거나 이 위키에서 읽을 수 없는 메모입니다. 목록에서 다른 메모를 선택해주세요." : "메모에서 작성한 내용을 이곳에서 편안하게 읽고 검색할 수 있습니다."}</p>
            <WikiHomeLink />
          </div>}
        </main>
        {note ? <aside aria-label="현재 메모 정보" className="wiki-context">
          <section aria-label="연결된 메모 그래프" className="wiki-local-graph">
            <h2>연결된 메모</h2>
            {graph ? <Suspense fallback={<p className="wiki-muted" role="status">연결을 준비하고 있습니다.</p>}>
              <LazyGraphCanvas fitOnLoad activeNodeId={graph.rootNodeId} edges={graph.edges} nodes={graph.nodes} onNodeOpen={(node, intent) => {
                const id = knowledge.active?.graph.nodes.find((candidate) => candidate.id === node.id)?.entryId;
                if (id) navigate(id, intent.target !== "current");
              }} settings={WIKI_GRAPH_SETTINGS} />
            </Suspense> : <p className="wiki-muted" role="status">연결을 준비하고 있습니다.</p>}
            {(knowledge.active?.graph.nodes.length ?? 0) > WIKI_GRAPH_NODE_LIMIT ? <p className="wiki-muted">가까운 연결 {WIKI_GRAPH_NODE_LIMIT}개를 표시합니다.</p> : null}
          </section>
          <details className="wiki-toc" open>
            <summary>이 페이지의 목차</summary>
            <nav aria-label="현재 메모 목차">
              {knowledge.active?.headings.length ? <ol>{knowledge.active.headings.map((heading, index) => <li key={`${heading.line}:${index}`}><button onClick={() => revealHeading(heading)} style={{ paddingInlineStart: `${Math.min(heading.level - 1, 3) * 12 + 8}px` }} type="button">{heading.text}</button></li>)}</ol> : <p className="wiki-muted">이 메모에는 소제목이 없습니다.</p>}
            </nav>
          </details>
          {knowledge.indexError ? <p className="wiki-muted" role="status">연결 정보를 불러오지 못했습니다. 메모 본문은 계속 읽을 수 있습니다.</p> : null}
        </aside> : null}
      </div>
    </div>
  );
}

function WikiNavigation({ activeId, entries, onNavigate, query, resultIds }: {
  activeId?: string;
  entries: readonly VaultIndexEntry[];
  onNavigate: (id: string, newTab?: boolean) => void;
  query: string;
  resultIds: readonly string[];
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pagination, setPagination] = useState({ key: "", page: 0 });
  const matching = useMemo(() => new Set(resultIds), [resultIds]);
  const rows = useMemo(() => query.trim()
    ? entries.filter((entry) => matching.has(entry.id)).map((entry) => ({ kind: "note" as const, id: entry.id, title: entry.path.split("/").at(-1)!.replace(/\.md$/i, ""), depth: 0, path: entry.path }))
    : wikiTreeRows(entries, collapsed), [collapsed, entries, matching, query]);
  const pageCount = Math.max(1, Math.ceil(rows.length / WIKI_LIST_PAGE_SIZE));
  const page = pagination.key === query ? Math.min(pagination.page, pageCount - 1) : 0;
  const visibleRows = rows.slice(page * WIKI_LIST_PAGE_SIZE, (page + 1) * WIKI_LIST_PAGE_SIZE);
  function clickNote(event: MouseEvent<HTMLAnchorElement>, id: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(id);
  }
  return <nav aria-label={query.trim() ? "위키 검색 결과" : "위키 폴더와 메모"} className="wiki-navigation">
    <ul>{visibleRows.map((row) => <li key={`${row.kind}:${row.id}`} style={{ paddingInlineStart: Math.min(row.depth, 7) * 12 }}>
      {row.kind === "folder" ? <button aria-expanded={!collapsed.has(row.id)} className="wiki-folder" onClick={() => {
        setCollapsed((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; });
      }} title={row.id} type="button">
        {collapsed.has(row.id) ? <ChevronRight aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}<Folder aria-hidden="true" size={15} /><span>{row.title}</span><small>{row.count}</small>
      </button> : <a aria-current={activeId === row.id ? "page" : undefined} className="wiki-note-link" href={wikiUrl(row.id)} onClick={(event) => clickNote(event, row.id)} title={row.path}>
        <FileText aria-hidden="true" size={15} /><span>{row.title}{query.trim() ? <small>{row.path}</small> : null}</span>
      </a>}
    </li>)}</ul>
    {pageCount > 1 ? <div className="wiki-pagination"><button disabled={page === 0} onClick={() => setPagination({ key: query, page: page - 1 })} type="button">이전</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPagination({ key: query, page: page + 1 })} type="button">다음</button></div> : null}
  </nav>;
}

function WikiBacklinks({ backlinks, entries, onNavigate, ready }: {
  backlinks: readonly ResolvedLinkOccurrence[];
  entries: ReadonlyMap<string, VaultIndexEntry>;
  onNavigate: (id: string, newTab?: boolean) => void;
  ready: boolean;
}) {
  const [limit, setLimit] = useState(12);
  return <section aria-label="이 메모를 연결한 메모" className="wiki-backlinks">
    <h2>이 메모를 연결한 메모 <span>{backlinks.length}</span></h2>
    {!ready ? <p className="wiki-muted">연결을 확인하고 있습니다.</p> : backlinks.length ? <ul>{backlinks.slice(0, limit).map((link) => <li key={link.sourceEntryId}>
      <a href={wikiUrl(link.sourceEntryId)} onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onNavigate(link.sourceEntryId);
      }}><strong>{entries.get(link.sourceEntryId)?.path.replace(/\.md$/i, "")}</strong><span>{link.context.slice(0, 220)}</span></a>
    </li>)}</ul> : <p className="wiki-muted">다른 메모에서 이 메모로 링크하면 여기에 표시됩니다.</p>}
    {backlinks.length > limit ? <button onClick={() => setLimit((value) => value + 12)} type="button">연결 더 보기</button> : null}
  </section>;
}
