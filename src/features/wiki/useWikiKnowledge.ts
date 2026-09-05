import { useEffect, useMemo, useState } from "react";
import { KnowledgeWorkerClient } from "../knowledge/knowledgeWorkerClient";
import { buildKnowledgeIndex, removeKnowledgeIndex, upsertKnowledgeIndex } from "../knowledge/knowledgeIndex";
import { buildGraphSnapshot, DEFAULT_LOCAL_GRAPH_SETTINGS, DEFAULT_GLOBAL_GRAPH_SETTINGS } from "../knowledge/graph";
import { matchesVaultSearchQuery } from "../knowledge/query";
import type { GraphSnapshot, KnowledgeIndex, MarkdownHeading, ResolvedLinkOccurrence, VaultIndexEntry } from "../knowledge/types";
import { wikiLiteralSearchQuery, wikiSearchQuery } from "./wikiModel";

export const WIKI_GRAPH_SETTINGS = {
  ...DEFAULT_LOCAL_GRAPH_SETTINGS,
  common: { ...DEFAULT_LOCAL_GRAPH_SETTINGS.common, existingFilesOnly: true, linkDistance: 110, nodeSize: 1.1 }
};
export const WIKI_GLOBAL_GRAPH_SETTINGS = {
  ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
  common: WIKI_GRAPH_SETTINGS.common,
  animate: false
};
const EMPTY_PANEL_IDS: readonly string[] = [];

const MAX_INCREMENTAL_WIKI_UPDATES = 200;

class IndexSession {
  private fallback: KnowledgeIndex | null = null;
  private indexedEntries = new Map<string, VaultIndexEntry>();
  private initialized = false;
  private closed = false;
  private currentGeneration = 0;
  private sync: Promise<void> = Promise.resolve();

  constructor(readonly worker: KnowledgeWorkerClient | null) {}

  get disposed() { return this.closed; }
  get generation() { return this.currentGeneration; }
  beginUpdate() { return ++this.currentGeneration; }
  isCurrent(generation: number) { return !this.closed && this.currentGeneration === generation; }

  snapshot(entries: readonly VaultIndexEntry[], generation: number): Runtime {
    return { entries, entryById: new Map(this.indexedEntries), session: this, generation, worker: this.worker, fallback: this.fallback };
  }

  update(entries: readonly VaultIndexEntry[], generation: number) {
    const task = this.sync.then(() => this.apply(entries, generation));
    // A failed update must not poison the serial queue for later snapshots.
    this.sync = task.then(() => undefined, () => undefined);
    return task;
  }

  private async apply(entries: readonly VaultIndexEntry[], generation: number) {
    if (!this.isCurrent(generation)) return false;
    const nextEntries = new Map(entries.map((entry) => [entry.id, entry]));
    const removedIds = [...this.indexedEntries.keys()].filter((id) => !nextEntries.has(id));
    const changedEntries = entries.filter((entry) => !sameEntry(this.indexedEntries.get(entry.id), entry));
    try {
      if (!this.initialized || removedIds.length + changedEntries.length > MAX_INCREMENTAL_WIKI_UPDATES) {
        if (this.worker) await this.worker.replaceVault(entries);
        else this.fallback = buildKnowledgeIndex(entries);
        if (this.closed) return false;
        this.indexedEntries = nextEntries;
        this.initialized = true;
      } else {
        for (const id of removedIds) {
          if (!this.isCurrent(generation)) return false;
          if (this.worker) await this.worker.removeEntry(id);
          else this.fallback = removeKnowledgeIndex(this.fallback!, id);
          if (this.closed) return false;
          this.indexedEntries.delete(id);
        }
        for (const entry of changedEntries) {
          if (!this.isCurrent(generation)) return false;
          if (this.worker) await this.worker.upsertEntry(entry);
          else this.fallback = upsertKnowledgeIndex(this.fallback!, entry);
          if (this.closed) return false;
          this.indexedEntries.set(entry.id, entry);
        }
      }
      return this.isCurrent(generation);
    } catch (error) {
      // A timeout can restart the worker after a partial mutation. Rebuild
      // from an authoritative projection on the next update, never guess.
      this.initialized = false;
      throw error;
    }
  }

  dispose() {
    this.closed = true;
    this.currentGeneration += 1;
    this.indexedEntries.clear();
    this.fallback = null;
    void this.worker?.dispose();
  }
}

interface Runtime {
  entries: readonly VaultIndexEntry[];
  entryById: ReadonlyMap<string, VaultIndexEntry>;
  session: IndexSession;
  generation: number;
  worker: KnowledgeWorkerClient | null;
  fallback: KnowledgeIndex | null;
}

function sameEntry(left: VaultIndexEntry | undefined, right: VaultIndexEntry) {
  return left?.id === right.id
    && left.path === right.path
    && left.kind === right.kind
    && left.content === right.content
    && left.size === right.size
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function matchesProjection(runtime: Runtime, entries: readonly VaultIndexEntry[]) {
  return runtime.entries === entries || (
    runtime.entryById.size === entries.length
    && entries.every((entry) => sameEntry(runtime.entryById.get(entry.id), entry))
  );
}

export interface WikiPageKnowledge {
  id: string;
  headings: readonly MarkdownHeading[];
  backlinks: readonly ResolvedLinkOccurrence[];
  outgoing: readonly ResolvedLinkOccurrence[];
}
interface ActiveKnowledge extends WikiPageKnowledge { runtime: Runtime; graph: GraphSnapshot }

export function useWikiKnowledge(entries: readonly VaultIndexEntry[], activeId: string | undefined, query: string,
  panelIds: readonly string[] = EMPTY_PANEL_IDS, graphMode: "local" | "global" = "local") {
  const [session, setSession] = useState<IndexSession | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [indexError, setIndexError] = useState(false);
  const [active, setActive] = useState<ActiveKnowledge | null>(null);
  const [pages, setPages] = useState<{ runtime: Runtime; signature: string; byId: ReadonlyMap<string, WikiPageKnowledge> } | null>(null);
  const panelSignature = JSON.stringify([...new Set([...(activeId ? [activeId] : []), ...panelIds])].slice(0, 6));
  const [results, setResults] = useState<{ runtime: Runtime; query: string; ids: string[]; failed: boolean } | null>(null);
  const currentRuntime = useMemo(() => runtime?.session === session
    && session && !session.disposed && runtime?.generation === session.generation
    && matchesProjection(runtime, entries) ? runtime : null, [entries, runtime, session]);

  // This component is unmounted by the private data gate whenever authority
  // contracts or the key locks. Only that lifetime boundary disposes the index.
  useEffect(() => {
    let worker: KnowledgeWorkerClient | null = null;
    if (typeof Worker !== "undefined") {
      try { worker = new KnowledgeWorkerClient(); } catch { /* Restricted browsers use the same bounded parser locally. */ }
    }
    const next = new IndexSession(worker);
    setSession(next);
    return () => next.dispose();
  }, []);

  useEffect(() => {
    if (!session || session.disposed || currentRuntime) return;
    let closed = false;
    const generation = session.beginUpdate();
    setIndexError(false);

    // Keep worker mutations and its restart snapshot in the same order. Do not
    // abort an in-flight mutation: the worker may already have applied it. The
    // next snapshot diffs against the acknowledged state and superseded results
    // never become visible. Large changes use one replacement instead of a
    // promise/request fan-out or hundreds of repeated link-resolution passes.
    void session.update(entries, generation).then((applied) => {
      if (!closed && applied && session.isCurrent(generation)) setRuntime(session.snapshot(entries, generation));
    }).catch(() => {
      if (!closed && session.isCurrent(generation)) setIndexError(true);
    });
    return () => { closed = true; };
  }, [currentRuntime, entries, session]);

  useEffect(() => {
    if (!currentRuntime || !activeId) return;
    let closed = false;
    const controller = new AbortController();
    const { worker, fallback } = currentRuntime;
    const ids = (JSON.parse(panelSignature) as string[]).filter((id) => currentRuntime.entryById.has(id));
    const settings = graphMode === "global" ? WIKI_GLOBAL_GRAPH_SETTINGS : WIKI_GRAPH_SETTINGS;
    if (worker) {
      void Promise.all([
        worker.metadataSummaries(ids),
        Promise.all(ids.map(async (id) => ({ id, backlinks: await worker.backlinks(id), outgoing: await worker.outgoingLinks(id) }))),
        graphMode === "global" ? worker.globalGraphSnapshot(WIKI_GLOBAL_GRAPH_SETTINGS, { signal: controller.signal })
          : worker.localGraphSnapshot(WIKI_GRAPH_SETTINGS, activeId, { signal: controller.signal })
      ]).then(([metadata, connections, graph]) => {
        if (closed) return;
        const byId = new Map(connections.map((page) => [page.id, { ...page, headings: metadata.find((item) => item.entryId === page.id)?.headings ?? [] }]));
        const current = byId.get(activeId);
        if (current) setActive({ ...current, runtime: currentRuntime, graph });
        setPages({ runtime: currentRuntime, signature: panelSignature, byId });
      }).catch(() => {
        if (!closed) setIndexError(true);
      });
    } else if (fallback) {
      const byId = new Map(ids.map((id) => [id, { id,
        headings: fallback.metadataByEntryId.get(id)?.headings ?? [],
        backlinks: fallback.backlinksByEntryId.get(id) ?? [], outgoing: fallback.outgoingByEntryId.get(id) ?? []
      }]));
      const current = byId.get(activeId);
      if (current) setActive({ ...current, runtime: currentRuntime,
        graph: buildGraphSnapshot(fallback, settings, { activeEntryId: activeId, allowRegex: false }) });
      setPages({ runtime: currentRuntime, signature: panelSignature, byId });
    }
    return () => { closed = true; controller.abort(); };
  }, [activeId, currentRuntime, graphMode, panelSignature]);

  useEffect(() => {
    if (!currentRuntime || !query.trim()) return;
    let closed = false;
    const controller = new AbortController();
    const search = wikiSearchQuery(query);
    const { worker, fallback } = currentRuntime;
    const literalSearch = wikiLiteralSearchQuery(query);
    const task = worker ? worker.search(search, { signal: controller.signal }) : Promise.resolve(
      fallback!.entries.filter((entry) => matchesVaultSearchQuery(
        literalSearch, entry, fallback!.metadataByEntryId.get(entry.id)!, { allowRegex: false }
      )).map((entry) => entry.id)
    );
    void task.then((ids) => {
      if (!closed) setResults({ runtime: currentRuntime, query, ids, failed: false });
    }).catch(() => {
      if (!closed) setResults({ runtime: currentRuntime, query, ids: [], failed: true });
    });
    return () => { closed = true; controller.abort(); };
  }, [currentRuntime, query]);

  const currentResults = results?.runtime === currentRuntime && results?.query === query ? results : null;
  return {
    active: active?.runtime === currentRuntime && active?.id === activeId && active.graph.scope === graphMode ? active : null,
    pages: pages?.runtime === currentRuntime && pages.signature === panelSignature ? pages.byId : new Map<string, WikiPageKnowledge>(),
    ready: Boolean(currentRuntime),
    indexError,
    searchError: Boolean(currentResults?.failed),
    searching: Boolean(query.trim() && !currentResults),
    resultIds: currentResults?.ids ?? []
  };
}
