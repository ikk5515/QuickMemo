import { buildGraphSnapshot, graphSnapshotCacheKey } from "./graph";
import {
  backlinkOccurrences,
  buildKnowledgeIndex,
  getKnowledgeIndexUpdateDiagnostics,
  outgoingOccurrences,
  removeKnowledgeIndex,
  unlinkedMentionOccurrences,
  upsertKnowledgeIndex
} from "./knowledgeIndex";
import { matchesVaultSearchQuery, parseVaultSearchQuery } from "./query";
import type { GraphSnapshot, KnowledgeIndex, ParsedMarkdownMetadata, VaultIndexEntry } from "./types";
import type {
  KnowledgeMetadataLinkSummary,
  KnowledgeMetadataSummary,
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse
} from "./workerProtocol";

export interface KnowledgeWorkerRuntime {
  handleRequest(request: KnowledgeWorkerRequest): void;
}

export interface KnowledgeWorkerRuntimeOptions {
  postMessage(response: KnowledgeWorkerResponse): void;
  close?(): void;
}

// Metadata summaries feed safe Base/Dataview projections, not the canonical
// graph/backlink index. Keep the structured clone bounded independently from
// the much larger parsing limits so a valid large Vault cannot freeze the UI.
export const MAX_METADATA_SUMMARY_LINKS_PER_ENTRY = 256;
export const MAX_METADATA_SUMMARY_LINKS_PER_RESPONSE = 4_096;
export const MAX_METADATA_SUMMARY_LINK_TARGET_CHARACTERS = 1_024;

interface MetadataSummaryLinkBudget {
  remaining: number;
}

function emptyIndex(): KnowledgeIndex {
  return buildKnowledgeIndex([]);
}

function copyEntry(entry: VaultIndexEntry): VaultIndexEntry {
  return { ...entry };
}

function metadataSummaryLinks(
  metadata: ParsedMarkdownMetadata,
  linkBudget: MetadataSummaryLinkBudget
): KnowledgeMetadataSummary["links"] {
  const seenTargets = new Set<string>();
  const links: KnowledgeMetadataSummary["links"] = [];
  for (const link of metadata.links) {
    if (
      links.length >= MAX_METADATA_SUMMARY_LINKS_PER_ENTRY
      || linkBudget.remaining <= 0
    ) {
      break;
    }
    if (
      link.target.length > MAX_METADATA_SUMMARY_LINK_TARGET_CHARACTERS
      || seenTargets.has(link.target)
    ) {
      continue;
    }
    seenTargets.add(link.target);
    links.push({ target: link.target });
    linkBudget.remaining -= 1;
  }
  return links;
}

function metadataSummaryLinkProjection(
  index: KnowledgeIndex
): ReadonlyMap<string, KnowledgeMetadataSummary["links"]> {
  const linkBudget: MetadataSummaryLinkBudget = {
    remaining: MAX_METADATA_SUMMARY_LINKS_PER_RESPONSE
  };
  const linksByEntryId = new Map<string, KnowledgeMetadataSummary["links"]>();
  for (const entry of index.entries) {
    const metadata = index.metadataByEntryId.get(entry.id);
    if (!metadata) {
      continue;
    }
    const links = metadataSummaryLinks(metadata, linkBudget);
    if (links.length > 0) {
      linksByEntryId.set(entry.id, links);
    }
  }
  return linksByEntryId;
}

function sameMetadataSummaryLinks(
  left: readonly KnowledgeMetadataLinkSummary[] | undefined,
  right: readonly KnowledgeMetadataLinkSummary[] | undefined
): boolean {
  const leftLinks = left ?? [];
  const rightLinks = right ?? [];
  return leftLinks.length === rightLinks.length
    && leftLinks.every((link, index) => link.target === rightLinks[index]?.target);
}

function changedMetadataSummaryLinkEntryIds(
  previousIndex: KnowledgeIndex,
  nextIndex: KnowledgeIndex
): string[] {
  const previous = metadataSummaryLinkProjection(previousIndex);
  const next = metadataSummaryLinkProjection(nextIndex);
  const orderedIds = previousIndex.entries.map((entry) => entry.id);
  const seen = new Set(orderedIds);
  for (const entry of nextIndex.entries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      orderedIds.push(entry.id);
    }
  }
  return orderedIds.filter((entryId) => !sameMetadataSummaryLinks(
    previous.get(entryId),
    next.get(entryId)
  ));
}

function metadataSummary(
  entryId: string,
  metadata: ParsedMarkdownMetadata,
  links: KnowledgeMetadataSummary["links"]
): KnowledgeMetadataSummary {
  const properties = Object.fromEntries(
    Object.entries(metadata.properties).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value
    ])
  );
  return {
    entryId,
    aliases: [...metadata.aliases],
    tags: [...metadata.tags],
    properties,
    headings: metadata.headings.map((heading) => ({ ...heading })),
    blocks: metadata.blocks.map((block) => ({ ...block })),
    links: links.map((link) => ({ ...link }))
  };
}

function safeErrorResponse(
  id: string,
  code: "invalid-request" | "internal-error" = "internal-error"
): KnowledgeWorkerResponse {
  return {
    id,
    type: "error",
    code,
    message: "Knowledge worker request failed."
  };
}

function safeRequestId(request: unknown): string {
  if (
    typeof request === "object" &&
    request !== null &&
    "id" in request &&
    typeof request.id === "string"
  ) {
    return request.id;
  }
  return "invalid-request";
}

export function createKnowledgeWorkerRuntime(
  options: KnowledgeWorkerRuntimeOptions
): KnowledgeWorkerRuntime {
  const entriesById = new Map<string, VaultIndexEntry>();
  let index = emptyIndex();
  let version = 0;
  let disposed = false;
  // One projection per scope keeps simultaneous global/local views fast. The
  // cache belongs to this decrypted worker session and is cleared on every
  // mutation and disposal; neither plaintext nor settings leave the worker.
  const graphSnapshots = new Map<GraphSnapshot["scope"], { key: string; snapshot: GraphSnapshot }>();

  const replace = (entries: readonly VaultIndexEntry[]) => {
    const previousEntryIds = index.entries.map((entry) => entry.id);
    const nextEntriesById = new Map<string, VaultIndexEntry>();
    for (const entry of entries) {
      const copiedEntry = copyEntry(entry);
      nextEntriesById.set(copiedEntry.id, copiedEntry);
    }
    const nextIndex = buildKnowledgeIndex([...nextEntriesById.values()]);
    entriesById.clear();
    for (const [entryId, entry] of nextEntriesById) {
      entriesById.set(entryId, entry);
    }
    index = nextIndex;
    graphSnapshots.clear();
    version += 1;
    return Array.from(new Set([
      ...previousEntryIds,
      ...index.entries.map((entry) => entry.id)
    ]));
  };

  const upsert = (entry: VaultIndexEntry) => {
    const copiedEntry = copyEntry(entry);
    const previousIndex = index;
    const nextIndex = upsertKnowledgeIndex(previousIndex, copiedEntry);
    entriesById.set(copiedEntry.id, copiedEntry);
    index = nextIndex;
    graphSnapshots.clear();
    version += 1;
    return Array.from(new Set([
      ...(getKnowledgeIndexUpdateDiagnostics(index)?.changedMetadataEntryIds ?? [entry.id]),
      ...changedMetadataSummaryLinkEntryIds(previousIndex, nextIndex)
    ]));
  };

  const remove = (entryId: string) => {
    const previousIndex = index;
    const nextIndex = removeKnowledgeIndex(previousIndex, entryId);
    entriesById.delete(entryId);
    index = nextIndex;
    graphSnapshots.clear();
    version += 1;
    return Array.from(new Set([
      ...(getKnowledgeIndexUpdateDiagnostics(index)?.changedMetadataEntryIds ?? [entryId]),
      ...changedMetadataSummaryLinkEntryIds(previousIndex, nextIndex)
    ]));
  };

  const updatedResponse = (
    id: string,
    changedMetadataEntryIds: readonly string[]
  ): KnowledgeWorkerResponse => ({
    id,
    type: "updated",
    version,
    entryCount: entriesById.size,
    changedMetadataEntryIds: [...changedMetadataEntryIds]
  });

  return {
    handleRequest(request) {
      if (disposed) {
        return;
      }

      const requestId = safeRequestId(request);
      try {
        switch (request.type) {
          case "initialize":
            options.postMessage({
              id: request.id,
              type: "ready",
              version,
              entryCount: entriesById.size
            });
            return;
          case "replace-vault":
            options.postMessage(updatedResponse(request.id, replace(request.entries)));
            return;
          case "upsert-entry":
            options.postMessage(updatedResponse(request.id, upsert(request.entry)));
            return;
          case "remove-entry":
            options.postMessage(updatedResponse(request.id, remove(request.entryId)));
            return;
          case "search": {
            const query = parseVaultSearchQuery(request.query);
            const entryIds = index.entries
              .filter((entry) => matchesVaultSearchQuery(
                query,
                entry,
                index.metadataByEntryId.get(entry.id) ?? {
                  aliases: [],
                  tags: [],
                  properties: {},
                  headings: [],
                  blocks: [],
                  links: []
                }
              ))
              .map((entry) => entry.id);
            options.postMessage({
              id: request.id,
              type: "search-results",
              version,
              entryIds
            });
            return;
          }
          case "outgoing-links":
            options.postMessage({
              id: request.id,
              type: "outgoing-links",
              version,
              occurrences: [...outgoingOccurrences(index, request.entryId)]
            });
            return;
          case "backlinks":
            options.postMessage({
              id: request.id,
              type: "backlinks",
              version,
              occurrences: [...backlinkOccurrences(index, request.entryId)]
            });
            return;
          case "unlinked-mentions":
            options.postMessage({
              id: request.id,
              type: "unlinked-mentions",
              version,
              occurrences: [...unlinkedMentionOccurrences(index, request.entryId)]
            });
            return;
          case "tags":
            options.postMessage({
              id: request.id,
              type: "tags",
              version,
              tags: [...index.tags.values()]
                .sort((left, right) => left.key.localeCompare(right.key))
                .map((tag) => ({ ...tag, entryIds: [...tag.entryIds], parentKeys: [...tag.parentKeys] }))
            });
            return;
          case "metadata-summaries": {
            const selectedIds = request.entryIds
              ? new Set(request.entryIds)
              : undefined;
            // Always project the response-wide budget over the canonical Vault
            // order first. A selected fetch must be byte-for-byte equivalent to
            // selecting the same summaries from a full response.
            const linksByEntryId = metadataSummaryLinkProjection(index);
            const summaries = index.entries.flatMap((entry) => {
              if (selectedIds && !selectedIds.has(entry.id)) {
                return [];
              }
              const metadata = index.metadataByEntryId.get(entry.id);
              return metadata ? [metadataSummary(
                entry.id,
                metadata,
                linksByEntryId.get(entry.id) ?? []
              )] : [];
            });
            options.postMessage({
              id: request.id,
              type: "metadata-summaries",
              version,
              summaries
            });
            return;
          }
          case "graph-snapshot": {
            const key = graphSnapshotCacheKey(request.settings, request.activeEntryId);
            let cached = graphSnapshots.get(request.settings.scope);
            if (!cached || cached.key !== key) {
              cached = {
                key,
                snapshot: buildGraphSnapshot(index, request.settings, { activeEntryId: request.activeEntryId })
              };
              graphSnapshots.set(request.settings.scope, cached);
            }
            options.postMessage({
              id: request.id,
              type: "graph-snapshot",
              version,
              snapshot: cached.snapshot
            });
            return;
          }
          case "dispose":
            disposed = true;
            entriesById.clear();
            graphSnapshots.clear();
            index = emptyIndex();
            options.postMessage({ id: request.id, type: "disposed" });
            options.close?.();
            return;
          default:
            options.postMessage(safeErrorResponse(requestId, "invalid-request"));
            return;
        }
      } catch {
        options.postMessage(safeErrorResponse(requestId));
      }
    }
  };
}
