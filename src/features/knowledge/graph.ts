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
  VaultIndexEntry,
  VaultSearchQuery
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

/** Mirrors the encrypted workspace-state boundary and caps worker evaluation. */
export const MAX_GRAPH_GROUPS_PER_SNAPSHOT = 64;

export interface BuildGraphSnapshotOptions {
  activeEntryId?: string;
  allowRegex?: boolean;
}

interface CollapsedLink {
  order: number;
  sourceEntryId: string;
  targetEntryId?: string;
  unresolvedKey?: string;
  occurrences: ResolvedLinkOccurrence[];
}

interface LinkAdjacency {
  incomingByTarget: Map<string, CollapsedLink[]>;
  outgoingBySource: Map<string, CollapsedLink[]>;
}

interface PreparedGraphGroup {
  group: GraphGroup;
  query: VaultSearchQuery;
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
          order: collapsed.size,
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

function appendAdjacentLink(
  adjacency: Map<string, CollapsedLink[]>,
  entryId: string,
  link: CollapsedLink
): void {
  const links = adjacency.get(entryId);
  if (links) {
    links.push(link);
  } else {
    adjacency.set(entryId, [link]);
  }
}

function buildLinkAdjacency(links: readonly CollapsedLink[]): LinkAdjacency {
  const incomingByTarget = new Map<string, CollapsedLink[]>();
  const outgoingBySource = new Map<string, CollapsedLink[]>();
  for (const link of links) {
    appendAdjacentLink(outgoingBySource, link.sourceEntryId, link);
    if (link.targetEntryId) {
      appendAdjacentLink(incomingByTarget, link.targetEntryId, link);
    }
  }
  return { incomingByTarget, outgoingBySource };
}

function forEachAdjacentLink(
  entryId: string,
  adjacency: LinkAdjacency,
  incoming: boolean,
  outgoing: boolean,
  visit: (link: CollapsedLink) => void
): void {
  const incomingLinks = incoming ? adjacency.incomingByTarget.get(entryId) ?? [] : [];
  const outgoingLinks = outgoing ? adjacency.outgoingBySource.get(entryId) ?? [] : [];
  let incomingIndex = 0;
  let outgoingIndex = 0;

  while (incomingIndex < incomingLinks.length || outgoingIndex < outgoingLinks.length) {
    const incomingLink = incomingLinks[incomingIndex];
    const outgoingLink = outgoingLinks[outgoingIndex];
    if (!outgoingLink || (incomingLink && incomingLink.order < outgoingLink.order)) {
      visit(incomingLink);
      incomingIndex += 1;
      continue;
    }
    visit(outgoingLink);
    outgoingIndex += 1;
    if (incomingLink === outgoingLink) {
      incomingIndex += 1;
    }
  }
}

function graphGroupForEntry(
  groups: readonly PreparedGraphGroup[],
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata,
  allowRegex: boolean
): GraphGroup | undefined {
  return groups.find(({ query }) =>
    matchesVaultSearchQuery(query, entry, metadata, { allowRegex })
  )?.group;
}

function prepareGraphGroups(groups: readonly GraphGroup[]): PreparedGraphGroup[] {
  return groups
    .slice(0, MAX_GRAPH_GROUPS_PER_SNAPSHOT)
    .map((group, index) => ({ group, index }))
    .sort((left, right) => left.group.order - right.group.order || left.index - right.index)
    .map(({ group }) => ({ group, query: parseVaultSearchQuery(group.query) }));
}

function graphNodeForEntry(
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata,
  groups: readonly PreparedGraphGroup[],
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

function collapsedLinkTargetNodeId(link: CollapsedLink): string {
  return link.targetEntryId
    ? entryNodeId(link.targetEntryId)
    : unresolvedNodeId(link.unresolvedKey ?? "");
}

function graphEdgeId(link: CollapsedLink): string {
  return `link:${entryNodeId(link.sourceEntryId)}->${collapsedLinkTargetNodeId(link)}`;
}

function graphEdgeFromCollapsed(link: CollapsedLink): GraphEdge {
  const target = collapsedLinkTargetNodeId(link);
  return {
    id: graphEdgeId(link),
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
  groups: readonly PreparedGraphGroup[],
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

function unresolvedMatchesQuery(query: VaultSearchQuery, key: string, allowRegex: boolean): boolean {
  const pseudoEntry: VaultIndexEntry = { id: `unresolved:${key}`, path: key, kind: "markdown" };
  return matchesVaultSearchQuery(query, pseudoEntry, emptyMetadata(), { allowRegex });
}

function addTagNodesAndEdges(
  index: KnowledgeIndex,
  visibleEntryIds: ReadonlySet<string>,
  groups: readonly PreparedGraphGroup[],
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
  links: readonly CollapsedLink[],
  settings: Extract<GraphViewSettings, { scope: "global" }>,
  parsedQuery: VaultSearchQuery,
  allowRegex: boolean
): Set<string> {
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
    // Obsidian's orphan state belongs to the full ACL-scoped knowledge graph,
    // not to the temporary search/attachment projection. Otherwise a linked
    // note becomes an apparent orphan merely because its neighbour is hidden
    // by the current query. Attachment links also must not turn a note into a
    // connected knowledge note.
    const entryById = new Map(index.entries.map((entry) => [entry.id, entry]));
    const connected = new Set<string>();
    for (const link of links) {
      if (!link.targetEntryId) continue;
      const source = entryById.get(link.sourceEntryId);
      const target = entryById.get(link.targetEntryId);
      if (!source || !target || isAttachment(source) || isAttachment(target)) continue;
      connected.add(link.sourceEntryId);
      connected.add(link.targetEntryId);
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
  adjacency: LinkAdjacency,
  settings: Extract<GraphViewSettings, { scope: "local" }>,
  activeEntryId: string | undefined,
  parsedQuery: VaultSearchQuery,
  allowRegex: boolean
): LocalSelection {
  const rootEntryId = settings.root === "follow-active" ? activeEntryId : settings.root.entryId;
  if (!rootEntryId || !index.entries.some((entry) => entry.id === rootEntryId)) {
    return { entryIds: new Set(), selectedLinkIds: new Set(), unresolvedKeys: new Set() };
  }
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
  let queueIndex = 0;
  const selectedLinkIds = new Set<string>();
  const unresolvedKeys = new Set<string>();
  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    const depth = depths.get(current) ?? 0;
    if (depth >= settings.depth) {
      continue;
    }
    forEachAdjacentLink(current, adjacency, settings.incoming, settings.outgoing, (link) => {
      // Official Obsidian 1.13.7 retains self links in Global Graph but omits
      // them from Local Graph traversal and neighbor-link projection.
      if (link.targetEntryId === link.sourceEntryId) {
        return;
      }
      const edgeId = graphEdgeId(link);
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
        return;
      }
      if (!depths.has(neighbor)) {
        selectedLinkIds.add(edgeId);
        depths.set(neighbor, depth + 1);
        queue.push(neighbor);
      } else if (current === rootEntryId || neighbor === rootEntryId) {
        selectedLinkIds.add(edgeId);
      }
    });
  }
  const entryIds = new Set(depths.keys());
  if (settings.neighborLinks) {
    for (const link of links) {
      if (
        link.targetEntryId &&
        link.sourceEntryId !== link.targetEntryId &&
        entryIds.has(link.sourceEntryId) &&
        entryIds.has(link.targetEntryId)
      ) {
        selectedLinkIds.add(graphEdgeId(link));
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
  const parsedQuery = parseVaultSearchQuery(settings.common.query);
  const preparedGroups = prepareGraphGroups(settings.common.groups);
  const links = collapseLinks(index);
  const adjacency = settings.scope === "local" ? buildLinkAdjacency(links) : undefined;
  const localSelection = settings.scope === "local" && adjacency
    ? localEntryIds(
        index,
        links,
        adjacency,
        settings,
        options.activeEntryId,
        parsedQuery,
        allowRegex
      )
    : undefined;
  const visibleEntryIds = settings.scope === "global"
    ? globalEntryIds(index, links, settings, parsedQuery, allowRegex)
    : localSelection?.entryIds ?? new Set<string>();
  const counts = incomingReferenceCounts(links, visibleEntryIds);
  const nodes = index.entries
    .filter((entry) => visibleEntryIds.has(entry.id))
    .map((entry) => graphNodeForEntry(
      entry,
      index.metadataByEntryId.get(entry.id) ?? emptyMetadata(),
      preparedGroups,
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
    if (!unresolvedMatchesQuery(parsedQuery, link.unresolvedKey, allowRegex)) {
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
      preparedGroups,
      unresolved.sources.size,
      allowRegex
    ));
  }
  if (settings.common.showTags) {
    addTagNodesAndEdges(index, visibleEntryIds, preparedGroups, nodes, edges, allowRegex);
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
