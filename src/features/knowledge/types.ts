export type VaultEntryKind = "markdown" | "legacy-html" | "canvas" | "asset" | "base";

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export interface VaultIndexEntry {
  id: string;
  path: string;
  kind: VaultEntryKind;
  content?: string;
  /**
   * Decrypted file size in bytes when the vault projection knows it. Asset
   * indexes may omit this instead of exposing encrypted payload sizes as if
   * they were plaintext file sizes.
   */
  size?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
  slug: string;
}

export interface MarkdownBlockReference {
  id: string;
  line: number;
}

export type InternalLinkSyntax = "wikilink" | "markdown";
export type InternalLinkFragment =
  | { kind: "heading"; value: string }
  | { kind: "block"; value: string };

export interface InternalLinkOccurrence {
  sourceEntryId: string;
  sourcePath: string;
  syntax: InternalLinkSyntax;
  raw: string;
  target: string;
  displayText?: string;
  fragment?: InternalLinkFragment;
  embedded: boolean;
  line: number;
  column: number;
  context: string;
}

export interface ParsedMarkdownMetadata {
  aliases: string[];
  tags: string[];
  properties: Record<string, FrontmatterValue>;
  headings: MarkdownHeading[];
  blocks: MarkdownBlockReference[];
  links: InternalLinkOccurrence[];
}

export interface TagIndexEntry {
  key: string;
  displayName: string;
  entryIds: string[];
  count: number;
  parentKeys: string[];
}

export type LinkResolutionStatus = "resolved" | "unresolved" | "ambiguous";

export interface ResolvedLinkOccurrence extends InternalLinkOccurrence {
  status: LinkResolutionStatus;
  targetEntryId?: string;
  targetPath?: string;
  candidateEntryIds: string[];
  unresolvedKey: string;
}

/**
 * A visible title or alias mention that is not already part of Markdown link
 * syntax. Offsets refer to the decrypted source snapshot held by the in-memory
 * knowledge index and must be revalidated before an edit is applied.
 */
export interface UnlinkedMentionOccurrence {
  sourceEntryId: string;
  sourcePath: string;
  targetEntryId: string;
  targetPath: string;
  matchedText: string;
  matchedTerm: string;
  startOffset: number;
  endOffset: number;
  line: number;
  column: number;
  context: string;
}

export interface KnowledgeIndex {
  entries: VaultIndexEntry[];
  metadataByEntryId: Map<string, ParsedMarkdownMetadata>;
  outgoingByEntryId: Map<string, ResolvedLinkOccurrence[]>;
  backlinksByEntryId: Map<string, ResolvedLinkOccurrence[]>;
  tags: Map<string, TagIndexEntry>;
}

export interface GraphGroup {
  id: string;
  query: string;
  color: string;
  order: number;
}

export interface GraphCommonSettings {
  query: string;
  showTags: boolean;
  showAttachments: boolean;
  existingFilesOnly: boolean;
  groups: GraphGroup[];
  arrows: boolean;
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export type GraphViewSettings =
  | {
      scope: "global";
      common: GraphCommonSettings;
      showOrphans: boolean;
      animate: boolean;
    }
  | {
      scope: "local";
      common: GraphCommonSettings;
      root: "follow-active" | { entryId: string };
      depth: 1 | 2 | 3 | 4 | 5;
      incoming: boolean;
      outgoing: boolean;
      neighborLinks: boolean;
    };

export type GraphNodeKind = "file" | "attachment" | "tag" | "unresolved";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  entryId?: string;
  path?: string;
  tag?: string;
  unresolvedKey?: string;
  incomingReferenceCount: number;
  groupId?: string;
  color?: string;
  createdAt?: number;
}

export type GraphEdgeKind = "internal-link" | "tag";

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  occurrenceCount: number;
  occurrenceLines: number[];
}

export interface GraphSnapshot {
  scope: GraphViewSettings["scope"];
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootNodeId?: string;
}

export type VaultSearchField =
  | "file"
  | "path"
  | "content"
  | "tag"
  | "property"
  | "line"
  | "block"
  | "section"
  | "task";

export type VaultSearchQuery =
  | { type: "all" }
  | { type: "term"; field?: VaultSearchField; value: string; propertyName?: string }
  | { type: "regex"; field?: VaultSearchField; source: string; flags: string; propertyName?: string }
  | { type: "not"; child: VaultSearchQuery }
  | { type: "and"; children: VaultSearchQuery[] }
  | { type: "or"; children: VaultSearchQuery[] };
