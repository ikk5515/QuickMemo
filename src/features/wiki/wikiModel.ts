import { buildVaultPaths, vaultEntryPath, type DecryptedVaultFolder, type DecryptedVaultNote } from "../vault/vaultData";
import { previewTextFromHtml } from "../../lib/editorContent";
import type { GraphSnapshot, VaultIndexEntry, VaultSearchQuery } from "../knowledge/types";
import type { GraphUiData } from "../graph/types";

export const WIKI_LIST_PAGE_SIZE = 120;
export const WIKI_GRAPH_NODE_LIMIT = 120;

export function wikiEntries(notes: readonly DecryptedVaultNote[], folders: DecryptedVaultFolder[]): VaultIndexEntry[] {
  const paths = buildVaultPaths(folders);
  return notes.map((note) => ({
    id: note.id,
    path: vaultEntryPath(note, paths),
    kind: note.entryKind,
    content: note.contentFormat === "legacy-html-v1" ? previewTextFromHtml(note.body) : note.body
  })).sort((left, right) => left.path.localeCompare(right.path, "ko"));
}

export type WikiTreeRow =
  | { kind: "folder"; id: string; title: string; depth: number; count: number }
  | { kind: "note"; id: string; title: string; depth: number; path: string };

/** Iterative flattening keeps deep or large trees bounded without recursive JSX. */
export function wikiTreeRows(entries: readonly VaultIndexEntry[], collapsed: ReadonlySet<string>): WikiTreeRow[] {
  const folders = new Map<string, { title: string; parent: string; count: number }>();
  const children = new Map<string, WikiTreeRow[]>();
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
