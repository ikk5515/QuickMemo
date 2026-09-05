import { vaultEntryPath, type DecryptedVaultFolder, type DecryptedVaultNote } from "../vault/vaultData";
import { previewTextFromHtml } from "../../lib/editorContent";
import type { GraphSnapshot, MarkdownHeading, VaultIndexEntry, VaultSearchQuery } from "../knowledge/types";
import type { GraphUiData } from "../graph/types";

export const WIKI_LIST_PAGE_SIZE = 120;
export const WIKI_GRAPH_NODE_LIMIT = 120;

export type WikiReadableNote = Pick<DecryptedVaultNote, "id" | "title" | "body" | "entryKind" | "contentFormat" | "folderId">;
export type WikiReadableFolder = Pick<DecryptedVaultFolder, "id" | "parentId" | "displayName">;

/** Only the supplied folder projection can contribute a visible path. */
export function wikiFolderPaths(folders: readonly WikiReadableFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const pending: WikiReadableFolder[] = [];
    const seen = new Set<string>();
    let current: WikiReadableFolder | undefined = folder;
    while (current && !paths.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id); pending.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let path = current ? paths.get(current.id) ?? "" : "";
    while (pending.length) {
      const next = pending.pop()!;
      path = path ? `${path}/${next.displayName}` : next.displayName;
      paths.set(next.id, path);
    }
  }
  return paths;
}

export function wikiEntries(notes: readonly WikiReadableNote[], folders: readonly WikiReadableFolder[]): VaultIndexEntry[] {
  const paths = wikiFolderPaths(folders);
  return notes.map((note) => ({
    id: note.id,
    path: vaultEntryPath(note, paths),
    kind: note.entryKind,
    content: note.contentFormat === "legacy-html-v1" ? previewTextFromHtml(note.body) : note.body
  })).sort((left, right) => left.path.localeCompare(right.path, "ko"));
}

/** Per-reader identity cache: typing in A must not invalidate B's editor props. */
export class WikiEntriesProjection {
  private cached = new Map<string, { body: string; format: WikiReadableNote["contentFormat"]; entry: VaultIndexEntry }>();
  private previous: VaultIndexEntry[] = [];
  project(notes: readonly WikiReadableNote[], folders: readonly WikiReadableFolder[]) {
    const paths = wikiFolderPaths(folders);
    const next = new Map<string, { body: string; format: WikiReadableNote["contentFormat"]; entry: VaultIndexEntry }>();
    const entries = notes.map((note) => {
      const path = vaultEntryPath(note, paths);
      const cached = this.cached.get(note.id);
      const value = cached && cached.body === note.body && cached.format === note.contentFormat && cached.entry.path === path && cached.entry.kind === note.entryKind
        ? cached : { body: note.body, format: note.contentFormat, entry: { id: note.id, path, kind: note.entryKind,
          content: note.contentFormat === "legacy-html-v1" ? previewTextFromHtml(note.body) : note.body } };
      next.set(note.id, value); return value.entry;
    }).sort((a, b) => a.path.localeCompare(b.path, "ko"));
    this.cached = next;
    if (entries.length !== this.previous.length || entries.some((entry, index) => entry !== this.previous[index])) this.previous = entries;
    return this.previous;
  }
  clear() { this.cached.clear(); this.previous = []; }
}


export interface WikiOutlineNode { heading: MarkdownHeading; children: WikiOutlineNode[] }
export function wikiOutline(headings: readonly MarkdownHeading[]): WikiOutlineNode[] {
  const roots: WikiOutlineNode[] = [];
  const parents: WikiOutlineNode[] = [];
  for (const heading of headings) {
    const node: WikiOutlineNode = { heading, children: [] };
    while (parents.length && parents.at(-1)!.heading.level >= heading.level) parents.pop();
    if (parents.length) parents.at(-1)!.children.push(node);
    else roots.push(node);
    parents.push(node);
  }
  return roots;
}

export type WikiTreeRow =
  | { kind: "folder"; id: string; title: string; depth: number; count: number }
  | { kind: "note"; id: string; title: string; depth: number; path: string };

/** Iterative flattening keeps deep or large trees bounded without recursive JSX. */
export function wikiTreeRows(entries: readonly VaultIndexEntry[], collapsed: ReadonlySet<string>, readableFolders: readonly WikiReadableFolder[] = []): WikiTreeRow[] {
  const folders = new Map<string, { title: string; parent: string; count: number }>();
  const children = new Map<string, WikiTreeRow[]>();
  for (const path of wikiFolderPaths(readableFolders).values()) {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const id = segments.slice(0, index + 1).join("/");
      folders.set(id, { title: segments[index], parent: segments.slice(0, index).join("/"), count: 0 });
    }
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    let parent = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const id = segments.slice(0, index + 1).join("/");
      const folder = folders.get(id);
      if (folder) folder.count += 1;
      else folders.set(id, { title: segments[index], parent, count: 1 });
      parent = id;
    }
    const siblings = children.get(parent) ?? [];
    siblings.push({ kind: "note", id: entry.id, title: segments.at(-1)!.replace(/\.md$/i, ""), depth: segments.length - 1, path: entry.path });
    children.set(parent, siblings);
  }
  for (const [id, folder] of folders) {
    const siblings = children.get(folder.parent) ?? [];
    siblings.push({ kind: "folder", id, title: folder.title, depth: id.split("/").length - 1, count: folder.count });
    children.set(folder.parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => (
    Number(right.kind === "folder") - Number(left.kind === "folder") || left.title.localeCompare(right.title, "ko")
  ));
  const result: WikiTreeRow[] = [];
  const pending = [...(children.get("") ?? [])].reverse();
  while (pending.length) {
    const row = pending.pop()!;
    result.push(row);
    if (row.kind === "folder" && !collapsed.has(row.id)) pending.push(...[...(children.get(row.id) ?? [])].reverse());
  }
  return result;
}

/** Escape every regex operator before sending literal words to the timed worker. */
export function wikiSearchQuery(query: string) {
  return query.trim().split(/\s+/u).filter(Boolean)
    .map((word) => /^[\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u.test(word) && word.toLocaleUpperCase() !== "OR"
      ? word
      : `/${word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/i`).join(" ");
}

/** The main-thread fallback never constructs or executes regular expressions. */
export function wikiLiteralSearchQuery(query: string): VaultSearchQuery {
  return { type: "and", children: query.trim().split(/\s+/u).filter(Boolean).map((value) => ({ type: "term", value })) };
}

export function wikiGraphData(snapshot: GraphSnapshot): GraphUiData {
  const ordered = [...snapshot.nodes].sort((left, right) => (
    Number(right.id === snapshot.rootNodeId) - Number(left.id === snapshot.rootNodeId)
    || right.incomingReferenceCount - left.incomingReferenceCount
  ));
  const nodes = ordered.slice(0, WIKI_GRAPH_NODE_LIMIT).map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind === "unresolved" ? "unresolved" as const : "note" as const,
    path: node.path,
    inboundReferenceCount: node.incomingReferenceCount
  }));
  const ids = new Set(nodes.map((node) => node.id));
  return {
    rootNodeId: snapshot.rootNodeId,
    nodes,
    edges: snapshot.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({
      id: edge.id, sourceId: edge.source, targetId: edge.target, occurrenceCount: edge.occurrenceCount
    }))
  };
}
