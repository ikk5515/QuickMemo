import { buildGraphSnapshot } from "./graph";
import {
  backlinkOccurrences,
  buildKnowledgeIndex,
  outgoingOccurrences
} from "./knowledgeIndex";
import { matchesVaultSearchQuery, parseVaultSearchQuery } from "./query";
import type { KnowledgeIndex, ParsedMarkdownMetadata, VaultIndexEntry } from "./types";
import type {
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

function emptyIndex(): KnowledgeIndex {
  return buildKnowledgeIndex([]);
}

function copyEntry(entry: VaultIndexEntry): VaultIndexEntry {
  return { ...entry };
}

function metadataSummary(
  index: KnowledgeIndex,
  entryId: string,
  metadata: ParsedMarkdownMetadata
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
    outgoingLinkCount: outgoingOccurrences(index, entryId).length,
    backlinkCount: backlinkOccurrences(index, entryId).length
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

  const rebuild = () => {
    index = buildKnowledgeIndex([...entriesById.values()]);
    version += 1;
  };

  const updatedResponse = (id: string): KnowledgeWorkerResponse => ({
    id,
    type: "updated",
    version,
    entryCount: entriesById.size
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
            entriesById.clear();
            for (const entry of request.entries) {
              entriesById.set(entry.id, copyEntry(entry));
            }
            rebuild();
            options.postMessage(updatedResponse(request.id));
            return;
          case "upsert-entry":
            entriesById.set(request.entry.id, copyEntry(request.entry));
            rebuild();
            options.postMessage(updatedResponse(request.id));
            return;
          case "remove-entry":
            entriesById.delete(request.entryId);
            rebuild();
            options.postMessage(updatedResponse(request.id));
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
            const summaries = index.entries.flatMap((entry) => {
              if (selectedIds && !selectedIds.has(entry.id)) {
                return [];
              }
              const metadata = index.metadataByEntryId.get(entry.id);
              return metadata ? [metadataSummary(index, entry.id, metadata)] : [];
            });
            options.postMessage({
              id: request.id,
              type: "metadata-summaries",
              version,
              summaries
            });
            return;
          }
          case "graph-snapshot":
            options.postMessage({
              id: request.id,
              type: "graph-snapshot",
              version,
              snapshot: buildGraphSnapshot(index, request.settings, {
                activeEntryId: request.activeEntryId
              })
            });
            return;
          case "dispose":
            disposed = true;
            entriesById.clear();
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
