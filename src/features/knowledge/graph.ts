import { matchesVaultSearchQuery, parseVaultSearchQuery } from "./query";
import { vaultBasename, vaultStem } from "./path";
import type {
  GraphCommonSettings,
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphSnapshot,
  GraphViewSettings,
  KnowledgeIndex,
  ParsedMarkdownMetadata,
  ResolvedLinkOccurrence,
  VaultIndexEntry
} from "./types";

export const DEFAULT_GRAPH_COMMON_SETTINGS: GraphCommonSettings = {
  query: "",
  showTags: false,
  showAttachments: false,
  existingFilesOnly: false,
  groups: [],
  arrows: false,
  textFadeThreshold: 0,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.519,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250
};

export const DEFAULT_GLOBAL_GRAPH_SETTINGS: Extract<GraphViewSettings, { scope: "global" }> = {
  scope: "global",
  common: { ...DEFAULT_GRAPH_COMMON_SETTINGS },
  showOrphans: true,
  animate: false
};

export const DEFAULT_LOCAL_GRAPH_SETTINGS: Extract<GraphViewSettings, { scope: "local" }> = {
  scope: "local",
  common: { ...DEFAULT_GRAPH_COMMON_SETTINGS },
  root: "follow-active",
  depth: 1,
  incoming: true,
  outgoing: true,
  neighborLinks: false
};

export interface BuildGraphSnapshotOptions {
  activeEntryId?: string;
  allowRegex?: boolean;
}

interface CollapsedLink {
  sourceEntryId: string;
  targetEntryId?: string;
  unresolvedKey?: string;
  occurrences: ResolvedLinkOccurrence[];
}

function isAttachment(entry: VaultIndexEntry): boolean {
  return entry.kind === "asset";
}

function emptyMetadata(): ParsedMarkdownMetadata {
  return { aliases: [], tags: [], properties: {}, headings: [], blocks: [], links: [] };
}

function entryNodeId(entryId: string): string {
  return `entry:${entryId}`;
}

function unresolvedNodeId(key: string): string {
  return `unresolved:${key.toLocaleLowerCase()}`;
}

function tagNodeId(key: string): string {
  return `tag:${key}`;
}

function collapseLinks(index: KnowledgeIndex): CollapsedLink[] {
  const collapsed = new Map<string, CollapsedLink>();
  for (const [sourceEntryId, occurrences] of index.outgoingByEntryId) {
    for (const occurrence of occurrences) {
      const targetKey = occurrence.targetEntryId
        ? `entry:${occurrence.targetEntryId}`
        : `missing:${occurrence.unresolvedKey.toLocaleLowerCase()}`;
      const key = `${sourceEntryId}->${targetKey}`;
      const existing = collapsed.get(key);
      if (existing) {
        existing.occurrences.push(occurrence);
      } else {
        collapsed.set(key, {
          sourceEntryId,
          targetEntryId: occurrence.targetEntryId,
          unresolvedKey: occurrence.targetEntryId ? undefined : occurrence.unresolvedKey,
          occurrences: [occurrence]
        });
      }
    }
  }
  return [...collapsed.values()];
}

function graphGroupForEntry(
  groups: readonly GraphGroup[],
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata,
  allowRegex: boolean
): GraphGroup | undefined {
  return [...groups]
    .sort((left, right) => left.order - right.order)
    .find((group) => matchesVaultSearchQuery(group.query, entry, metadata, { allowRegex }));
}

function graphNodeForEntry(
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata,
  groups: readonly GraphGroup[],
  incomingReferenceCount: number,
  allowRegex: boolean
): GraphNode {
  const group = graphGroupForEntry(groups, entry, metadata, allowRegex);
  return {
    id: entryNodeId(entry.id),
    kind: isAttachment(entry) ? "attachment" : "file",
    label: isAttachment(entry) ? vaultBasename(entry.path) : vaultStem(entry.path),
    entryId: entry.id,
    path: entry.path,
    incomingReferenceCount,
    groupId: group?.id,
    color: group?.color,
    createdAt: entry.createdAt
  };
}

function graphEdgeFromCollapsed(link: CollapsedLink): GraphEdge {
  const target = link.targetEntryId
    ? entryNodeId(link.targetEntryId)
    : unresolvedNodeId(link.unresolvedKey ?? "");
  return {
    id: `link:${entryNodeId(link.sourceEntryId)}->${target}`,
    kind: "internal-link",
    source: entryNodeId(link.sourceEntryId),
    target,
    occurrenceCount: link.occurrences.length,
    occurrenceLines: link.occurrences.map((occurrence) => occurrence.line)
  };
}

function incomingReferenceCounts(links: readonly CollapsedLink[], visibleEntryIds: ReadonlySet<string>): Map<string, number> {
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const link of links) {
    if (
      link.targetEntryId &&
      visibleEntryIds.has(link.sourceEntryId) &&
      visibleEntryIds.has(link.targetEntryId)
    ) {
      const sources = sourcesByTarget.get(link.targetEntryId) ?? new Set<string>();
      sources.add(link.sourceEntryId);
      sourcesByTarget.set(link.targetEntryId, sources);
    }
  }
  return new Map([...sourcesByTarget].map(([target, sources]) => [target, sources.size]));
}

function unresolvedNode(
  key: string,
  groups: readonly GraphGroup[],
  incomingReferenceCount: number,
  allowRegex: boolean
): GraphNode {
  const pseudoEntry: VaultIndexEntry = { id: `unresolved:${key}`, path: key, kind: "markdown" };
  const group = graphGroupForEntry(groups, pseudoEntry, emptyMetadata(), allowRegex);
  return {
    id: unresolvedNodeId(key),
    kind: "unresolved",
    label: vaultStem(key) || key,
    path: key,
    unresolvedKey: key,
    incomingReferenceCount,
    groupId: group?.id,
    color: group?.color
  };
}

function unresolvedMatchesQuery(query: string, key: string, allowRegex: boolean): boolean {
  const pseudoEntry: VaultIndexEntry = { id: `unresolved:${key}`, path: key, kind: "markdown" };
  return matchesVaultSearchQuery(query, pseudoEntry, emptyMetadata(), { allowRegex });
}

function addTagNodesAndEdges(
  index: KnowledgeIndex,
  visibleEntryIds: ReadonlySet<string>,
  groups: readonly GraphGroup[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  allowRegex: boolean
): void {
  const visibleTagSources = new Map<string, string[]>();
  for (const entryId of visibleEntryIds) {
    const metadata = index.metadataByEntryId.get(entryId);
    for (const tag of metadata?.tags ?? []) {
      const key = tag.toLocaleLowerCase();
      const entryIds = visibleTagSources.get(key) ?? [];
      entryIds.push(entryId);
      visibleTagSources.set(key, entryIds);
    }
  }

  for (const [key, entryIds] of visibleTagSources) {
    const tag = index.tags.get(key);
    if (!tag) {
      continue;
    }
    const pseudoEntry: VaultIndexEntry = { id: `tag:${key}`, path: `#${tag.displayName}`, kind: "markdown" };
    const group = graphGroupForEntry(groups, pseudoEntry, {
      ...emptyMetadata(),
      tags: [tag.displayName]
    }, allowRegex);
    nodes.push({
      id: tagNodeId(key),
      kind: "tag",
      label: `#${tag.displayName}`,
      tag: tag.displayName,
      incomingReferenceCount: new Set(entryIds).size,
      groupId: group?.id,
      color: group?.color
    });
    for (const entryId of new Set(entryIds)) {
      edges.push({
        id: `tag:${entryNodeId(entryId)}->${tagNodeId(key)}`,
        kind: "tag",
        source: entryNodeId(entryId),
        target: tagNodeId(key),
        occurrenceCount: 1,
        occurrenceLines: []
      });
    }
  }
}

function globalEntryIds(
  index: KnowledgeIndex,
  settings: Extract<GraphViewSettings, { scope: "global" }>,
  allowRegex: boolean
): Set<string> {
  const parsedQuery = parseVaultSearchQuery(settings.common.query);
  const visible = new Set(
    index.entries
      .filter((entry) => settings.common.showAttachments || !isAttachment(entry))
      .filter((entry) =>
        matchesVaultSearchQuery(
          parsedQuery,
          entry,
          index.metadataByEntryId.get(entry.id) ?? emptyMetadata(),
          { allowRegex }
        )
      )
      .map((entry) => entry.id)
  );

  if (!settings.showOrphans) {
    const connected = new Set<string>();
    for (const link of collapseLinks(index)) {
      if (link.targetEntryId && visible.has(link.sourceEntryId) && visible.has(link.targetEntryId)) {
        connected.add(link.sourceEntryId);
        connected.add(link.targetEntryId);
      }
    }
    for (const entryId of visible) {
      if (!connected.has(entryId)) {
        visible.delete(entryId);
      }
    }
  }
  return visible;
}

interface LocalSelection {
  entryIds: Set<string>;
  selectedLinkIds: Set<string>;
  unresolvedKeys: Set<string>;
  rootEntryId?: string;
}

function localEntryIds(
  index: KnowledgeIndex,
  links: readonly CollapsedLink[],
  settings: Extract<GraphViewSettings, { scope: "local" }>,
  activeEntryId: string | undefined,
  allowRegex: boolean
): LocalSelection {
  const rootEntryId = settings.root === "follow-active" ? activeEntryId : settings.root.entryId;
  if (!rootEntryId || !index.entries.some((entry) => entry.id === rootEntryId)) {
    return { entryIds: new Set(), selectedLinkIds: new Set(), unresolvedKeys: new Set() };
  }
  const parsedQuery = parseVaultSearchQuery(settings.common.query);
  const eligible = new Set(
    index.entries
      .filter((entry) => settings.common.showAttachments || !isAttachment(entry))
      .filter((entry) =>
        matchesVaultSearchQuery(
          parsedQuery,
          entry,
          index.metadataByEntryId.get(entry.id) ?? emptyMetadata(),
          { allowRegex }
        )
      )
      .map((entry) => entry.id)
  );
  eligible.add(rootEntryId);

  const depths = new Map<string, number>([[rootEntryId, 0]]);
  const queue = [rootEntryId];
  const selectedLinkIds = new Set<string>();
  const unresolvedKeys = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const depth = depths.get(current) ?? 0;
    if (depth >= settings.depth) {
      continue;
    }
    for (const link of links) {
      const edgeId = graphEdgeFromCollapsed(link).id;
      let neighbor: string | undefined;
      if (settings.outgoing && link.sourceEntryId === current) {
        if (link.targetEntryId) {
          neighbor = link.targetEntryId;
        } else if (!settings.common.existingFilesOnly && link.unresolvedKey) {
          unresolvedKeys.add(link.unresolvedKey);
          selectedLinkIds.add(edgeId);
        }
      }
      if (settings.incoming && link.targetEntryId === current) {
        neighbor = link.sourceEntryId;
      }
      if (!neighbor || !eligible.has(neighbor)) {
        continue;
      }
      if (!depths.has(neighbor)) {
        selectedLinkIds.add(edgeId);
        depths.set(neighbor, depth + 1);
        queue.push(neighbor);
      } else if (current === rootEntryId || neighbor === rootEntryId) {
        selectedLinkIds.add(edgeId);
      }
    }
  }
  const entryIds = new Set(depths.keys());
  if (settings.neighborLinks) {
    for (const link of links) {
      if (
        link.targetEntryId &&
        entryIds.has(link.sourceEntryId) &&
        entryIds.has(link.targetEntryId)
      ) {
        selectedLinkIds.add(graphEdgeFromCollapsed(link).id);
      }
    }
  }
  return { entryIds, selectedLinkIds, unresolvedKeys, rootEntryId };
}

export function buildGraphSnapshot(
  index: KnowledgeIndex,
  settings: GraphViewSettings,
  options: BuildGraphSnapshotOptions = {}
): GraphSnapshot {
  const allowRegex = options.allowRegex !== false;
  const links = collapseLinks(index);
  const localSelection = settings.scope === "local"
    ? localEntryIds(index, links, settings, options.activeEntryId, allowRegex)
    : undefined;
  const visibleEntryIds = settings.scope === "global"
    ? globalEntryIds(index, settings, allowRegex)
    : localSelection?.entryIds ?? new Set<string>();
  const counts = incomingReferenceCounts(links, visibleEntryIds);
  const nodes = index.entries
    .filter((entry) => visibleEntryIds.has(entry.id))
    .map((entry) => graphNodeForEntry(
      entry,
      index.metadataByEntryId.get(entry.id) ?? emptyMetadata(),
      settings.common.groups,
      counts.get(entry.id) ?? 0,
      allowRegex
    ));
  const edges: GraphEdge[] = [];
  const unresolvedCounts = new Map<string, { displayKey: string; sources: Set<string> }>();

  for (const link of links) {
    if (!visibleEntryIds.has(link.sourceEntryId)) {
      continue;
    }
    const edge = graphEdgeFromCollapsed(link);
    if (settings.scope === "local" && !localSelection?.selectedLinkIds.has(edge.id)) {
      continue;
    }
    if (link.targetEntryId) {
      if (visibleEntryIds.has(link.targetEntryId)) {
        edges.push(edge);
      }
      continue;
    }
    if (settings.common.existingFilesOnly || !link.unresolvedKey) {
      continue;
    }
    if (!unresolvedMatchesQuery(settings.common.query, link.unresolvedKey, allowRegex)) {
      continue;
    }
    if (settings.scope === "local" && !localSelection?.unresolvedKeys.has(link.unresolvedKey)) {
      continue;
    }
    edges.push(edge);
    const normalizedKey = link.unresolvedKey.toLocaleLowerCase();
    const unresolved = unresolvedCounts.get(normalizedKey) ?? {
      displayKey: link.unresolvedKey,
      sources: new Set<string>()
    };
    unresolved.sources.add(link.sourceEntryId);
    unresolvedCounts.set(normalizedKey, unresolved);
  }

  for (const unresolved of unresolvedCounts.values()) {
    nodes.push(unresolvedNode(
      unresolved.displayKey,
      settings.common.groups,
      unresolved.sources.size,
      allowRegex
    ));
  }
  if (settings.common.showTags) {
    addTagNodesAndEdges(index, visibleEntryIds, settings.common.groups, nodes, edges, allowRegex);
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return {
    scope: settings.scope,
    nodes,
    edges,
    rootNodeId: localSelection?.rootEntryId ? entryNodeId(localSelection.rootEntryId) : undefined
  };
}
