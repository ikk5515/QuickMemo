import type {
  FrontmatterValue,
  GraphSnapshot,
  GraphViewSettings,
  MarkdownBlockReference,
  MarkdownHeading,
  ResolvedLinkOccurrence,
  TagIndexEntry,
  UnlinkedMentionOccurrence,
  VaultIndexEntry
} from "./types";

export interface KnowledgeMetadataLinkSummary {
  target: string;
}

export interface KnowledgeMetadataSummary {
  entryId: string;
  aliases: string[];
  tags: string[];
  properties: Record<string, FrontmatterValue>;
  headings: MarkdownHeading[];
  blocks: MarkdownBlockReference[];
  links: KnowledgeMetadataLinkSummary[];
}

export interface KnowledgeWorkerUpdateResult {
  version: number;
  entryCount: number;
  changedMetadataEntryIds: string[];
}

export interface KnowledgeWorkerRequestBase {
  id: string;
}

export type KnowledgeWorkerRequest =
  | (KnowledgeWorkerRequestBase & { type: "initialize" })
  | (KnowledgeWorkerRequestBase & { type: "replace-vault"; entries: VaultIndexEntry[] })
  | (KnowledgeWorkerRequestBase & { type: "upsert-entry"; entry: VaultIndexEntry })
  | (KnowledgeWorkerRequestBase & { type: "remove-entry"; entryId: string })
  | (KnowledgeWorkerRequestBase & { type: "search"; query: string })
  | (KnowledgeWorkerRequestBase & { type: "outgoing-links"; entryId: string })
  | (KnowledgeWorkerRequestBase & { type: "backlinks"; entryId: string })
  | (KnowledgeWorkerRequestBase & { type: "unlinked-mentions"; entryId: string })
  | (KnowledgeWorkerRequestBase & { type: "tags" })
  | (KnowledgeWorkerRequestBase & { type: "metadata-summaries"; entryIds?: string[] })
  | (KnowledgeWorkerRequestBase & {
      type: "graph-snapshot";
      settings: GraphViewSettings;
      activeEntryId?: string;
    })
  | (KnowledgeWorkerRequestBase & { type: "dispose" });

export type KnowledgeWorkerErrorCode =
  | "invalid-request"
  | "internal-error";

export type KnowledgeWorkerResponse =
  | { id: string; type: "ready"; version: number; entryCount: number }
  | ({ id: string; type: "updated" } & KnowledgeWorkerUpdateResult)
  | { id: string; type: "search-results"; version: number; entryIds: string[] }
  | { id: string; type: "outgoing-links"; version: number; occurrences: ResolvedLinkOccurrence[] }
  | { id: string; type: "backlinks"; version: number; occurrences: ResolvedLinkOccurrence[] }
  | { id: string; type: "unlinked-mentions"; version: number; occurrences: UnlinkedMentionOccurrence[] }
  | { id: string; type: "tags"; version: number; tags: TagIndexEntry[] }
  | { id: string; type: "metadata-summaries"; version: number; summaries: KnowledgeMetadataSummary[] }
  | { id: string; type: "graph-snapshot"; version: number; snapshot: GraphSnapshot }
  | { id: string; type: "disposed" }
  | { id: string; type: "error"; code: KnowledgeWorkerErrorCode; message: string };
