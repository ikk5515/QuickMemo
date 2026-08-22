import {
  MAX_ALIASES_PER_ENTRY,
  MAX_BLOCK_REFERENCES_PER_ENTRY,
  MAX_FRONTMATTER_PROPERTIES_PER_ENTRY,
  MAX_HEADINGS_PER_ENTRY,
  MAX_INTERNAL_LINK_CONTEXT_CHARACTERS,
  MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
  MAX_INTERNAL_LINK_TARGET_CHARACTERS,
  MAX_TAG_OCCURRENCES_PER_ENTRY,
  parseObsidianMarkdown
} from "./markdown";
import {
  buildInternalLinkResolutionIndex,
  normalizeVaultPath,
  resolveInternalLink
} from "./path";
import type { InternalLinkResolutionIndex } from "./path";
import type {
  InternalLinkOccurrence,
  KnowledgeIndex,
  ParsedMarkdownMetadata,
  ResolvedLinkOccurrence,
  TagIndexEntry,
  VaultIndexEntry
} from "./types";
import { findUnlinkedMentions } from "./unlinkedMentions";

const EMPTY_METADATA: ParsedMarkdownMetadata = {
  aliases: [],
  tags: [],
  properties: {},
  headings: [],
  blocks: [],
  links: []
};

export const MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX = 32_768;
export const MAX_TAG_OCCURRENCES_PER_INDEX = 32_768;
export const MAX_CANVAS_NODES_PER_ENTRY = 10_000;
export const MAX_CANVAS_TEXT_CHARACTERS_PER_NODE = 1_000_000;
export const MAX_CANVAS_TEXT_CHARACTERS_PER_ENTRY = 8_000_000;

interface KnowledgeIndexInternals {
  rawMetadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>;
  resolutionIndex: InternalLinkResolutionIndex;
}

export interface KnowledgeIndexUpdateDiagnostics {
  /** Entry contents parsed by this operation. Paths and note text are never exposed here. */
  parsedEntryIds: readonly string[];
  /** Entries whose metadata projection changed, including an entry that was removed. */
  changedMetadataEntryIds: readonly string[];
  /** Sources whose resolved outgoing-link arrays were replaced. */
  reindexedSourceEntryIds: readonly string[];
  /** True when a path/alias universe change required every source link to be re-resolved. */
  globallyReresolved: boolean;
}

const internalsByIndex = new WeakMap<KnowledgeIndex, KnowledgeIndexInternals>();
const diagnosticsByIndex = new WeakMap<KnowledgeIndex, KnowledgeIndexUpdateDiagnostics>();

interface CanvasNode {
  type?: string;
  file?: string;
  text?: string;
}

function mergeMetadata(
  parts: readonly ParsedMarkdownMetadata[],
  maximumLinkOccurrences = MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
  maximumTagOccurrences = MAX_TAG_OCCURRENCES_PER_ENTRY
): ParsedMarkdownMetadata {
  const aliases: string[] = [];
  const tags: string[] = [];
  const properties = Object.create(null) as ParsedMarkdownMetadata["properties"];
  let propertyCount = 0;
  const seenAliases = new Set<string>();
  const seenTags = new Set<string>();
  const links: InternalLinkOccurrence[] = [];
  const headings: ParsedMarkdownMetadata["headings"] = [];
  const blocks: ParsedMarkdownMetadata["blocks"] = [];
  for (const part of parts) {
    for (const alias of part.aliases) {
      if (aliases.length >= MAX_ALIASES_PER_ENTRY) {
        break;
      }
      const key = alias.toLocaleLowerCase();
      if (!seenAliases.has(key)) {
        aliases.push(alias);
        seenAliases.add(key);
      }
    }
    for (const tag of part.tags) {
      if (tags.length >= maximumTagOccurrences) {
        break;
      }
      const key = tag.toLocaleLowerCase();
      if (!seenTags.has(key)) {
        tags.push(tag);
        seenTags.add(key);
      }
    }
    for (const [key, value] of Object.entries(part.properties)) {
      if (["__proto__", "constructor", "prototype"].includes(key.toLocaleLowerCase("en-US"))) {
        continue;
      }
      const exists = Object.hasOwn(properties, key);
      if (!exists && propertyCount >= MAX_FRONTMATTER_PROPERTIES_PER_ENTRY) {
        break;
      }
      properties[key] = value;
      if (!exists) {
        propertyCount += 1;
      }
    }
    if (headings.length < MAX_HEADINGS_PER_ENTRY) {
      headings.push(...part.headings.slice(0, MAX_HEADINGS_PER_ENTRY - headings.length));
    }
    if (blocks.length < MAX_BLOCK_REFERENCES_PER_ENTRY) {
      blocks.push(...part.blocks.slice(0, MAX_BLOCK_REFERENCES_PER_ENTRY - blocks.length));
    }
    const remainingLinks = maximumLinkOccurrences - links.length;
    if (remainingLinks > 0) {
      links.push(...part.links.slice(0, remainingLinks));
    }
  }
  return {
    aliases,
    tags,
    properties,
    headings,
    blocks,
    links
  };
}

function parseCanvasMetadata(
  entry: VaultIndexEntry,
  maximumLinkOccurrences: number,
  maximumTagOccurrences: number
): ParsedMarkdownMetadata {
  if (!entry.content) {
    return EMPTY_METADATA;
  }
  try {
    const parsed = JSON.parse(entry.content) as { nodes?: CanvasNode[] };
    const parts: ParsedMarkdownMetadata[] = [];
    const fileLinks: InternalLinkOccurrence[] = [];
    let remainingTextLinks = maximumLinkOccurrences;
    let remainingTextCharacters = MAX_CANVAS_TEXT_CHARACTERS_PER_ENTRY;
    const nodes = Array.isArray(parsed.nodes)
      ? parsed.nodes.slice(0, MAX_CANVAS_NODES_PER_ENTRY)
      : [];
    for (const [index, node] of nodes.entries()) {
      if (node.type === "text" && typeof node.text === "string") {
        if (remainingTextCharacters <= 0) {
          continue;
        }
        const boundedText = node.text.slice(
          0,
          Math.min(MAX_CANVAS_TEXT_CHARACTERS_PER_NODE, remainingTextCharacters)
        );
        const metadata = parseObsidianMarkdown(
          entry.id,
          entry.path,
          boundedText,
          remainingTextLinks,
          0
        );
        // Official Obsidian 1.13.7 contributes internal links from Canvas text
        // cards to Graph/Backlinks, but does not add their hashtags to Tags or
        // tag nodes. Canvas frontmatter/aliases are likewise not file metadata.
        parts.push({
          ...EMPTY_METADATA,
          headings: metadata.headings,
          blocks: metadata.blocks,
          links: metadata.links
        });
        remainingTextCharacters -= boundedText.length;
        remainingTextLinks = Math.max(0, remainingTextLinks - metadata.links.length);
      }
      if (
        node.type === "file"
        && typeof node.file === "string"
        && node.file.length <= MAX_INTERNAL_LINK_TARGET_CHARACTERS
        && fileLinks.length < maximumLinkOccurrences
      ) {
        fileLinks.push({
          sourceEntryId: entry.id,
          sourcePath: normalizeVaultPath(entry.path),
          syntax: "wikilink",
          raw: node.file,
          target: node.file,
          embedded: true,
          line: index + 1,
          column: 1,
          context: node.file.slice(0, MAX_INTERNAL_LINK_CONTEXT_CHARACTERS)
        });
      }
    }
    const merged = mergeMetadata(
      parts,
      maximumLinkOccurrences,
      maximumTagOccurrences
    );
    return {
      ...merged,
      links: [...merged.links, ...fileLinks].slice(0, maximumLinkOccurrences)
    };
  } catch {
    return EMPTY_METADATA;
  }
}

function metadataForEntry(
  entry: VaultIndexEntry,
  maximumLinkOccurrences: number,
  maximumTagOccurrences: number
): ParsedMarkdownMetadata {
  if (entry.kind === "markdown") {
    return parseObsidianMarkdown(
      entry.id,
      entry.path,
      entry.content ?? "",
      maximumLinkOccurrences,
      maximumTagOccurrences
    );
  }
  if (entry.kind === "canvas") {
    return parseCanvasMetadata(
      entry,
      maximumLinkOccurrences,
      maximumTagOccurrences
    );
  }
  return EMPTY_METADATA;
}

function parentTagKeys(tag: string): string[] {
  const segments = tag.split("/");
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/").toLocaleLowerCase());
  }
  return parents;
}

function createTagIndex(metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>): Map<string, TagIndexEntry> {
  const tags = new Map<string, TagIndexEntry>();
  for (const [entryId, metadata] of metadataByEntryId) {
    for (const tag of metadata.tags) {
      const key = tag.toLocaleLowerCase();
      const existing = tags.get(key);
      if (existing) {
        // Each entry's metadata is already case-insensitively deduplicated.
        // Avoid an O(n) includes scan for a tag shared by many entries.
        existing.entryIds.push(entryId);
        existing.count = existing.entryIds.length;
      } else {
        tags.set(key, {
          key,
          displayName: tag,
          entryIds: [entryId],
          count: 1,
          parentKeys: parentTagKeys(tag)
        });
      }
    }
  }
  return tags;
}

function copyFrontmatterValue(
  value: ParsedMarkdownMetadata["properties"][string]
): ParsedMarkdownMetadata["properties"][string] {
  return Array.isArray(value) ? [...value] : value;
}

function copyMetadata(
  metadata: ParsedMarkdownMetadata,
  maximumLinkOccurrences = metadata.links.length,
  maximumTagOccurrences = metadata.tags.length
): ParsedMarkdownMetadata {
  return {
    aliases: [...metadata.aliases],
    tags: metadata.tags.slice(0, maximumTagOccurrences),
    properties: Object.fromEntries(
      Object.entries(metadata.properties).map(([key, value]) => [
        key,
        copyFrontmatterValue(value)
      ])
    ),
    headings: metadata.headings.map((heading) => ({ ...heading })),
    blocks: metadata.blocks.map((block) => ({ ...block })),
    links: metadata.links.slice(0, maximumLinkOccurrences).map((link) => ({
      ...link,
      fragment: link.fragment ? { ...link.fragment } : undefined
    }))
  };
}

function normalizeEntry(entry: VaultIndexEntry): VaultIndexEntry {
  return { ...entry, path: normalizeVaultPath(entry.path) };
}

function applyVaultWideOccurrenceBudgets(
  entries: readonly VaultIndexEntry[],
  rawMetadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  previousIndex?: KnowledgeIndex,
  previousInternals?: KnowledgeIndexInternals
): Map<string, ParsedMarkdownMetadata> {
  const metadataByEntryId = new Map<string, ParsedMarkdownMetadata>();
  let remainingLinkOccurrences = MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX;
  let remainingTagOccurrences = MAX_TAG_OCCURRENCES_PER_INDEX;
  for (const entry of entries) {
    const rawMetadata = rawMetadataByEntryId.get(entry.id) ?? EMPTY_METADATA;
    const linkCount = Math.min(rawMetadata.links.length, remainingLinkOccurrences);
    const tagCount = Math.min(rawMetadata.tags.length, remainingTagOccurrences);
    const previousMetadata = previousIndex?.metadataByEntryId.get(entry.id);
    const rawMetadataIsUnchanged = previousInternals?.rawMetadataByEntryId.get(entry.id)
      === rawMetadata;
    const metadata = rawMetadataIsUnchanged
      && previousMetadata
      && previousMetadata.links.length === linkCount
      && previousMetadata.tags.length === tagCount
      ? previousMetadata
      : copyMetadata(rawMetadata, linkCount, tagCount);
    metadataByEntryId.set(entry.id, metadata);
    remainingLinkOccurrences = Math.max(
      0,
      remainingLinkOccurrences - metadata.links.length
    );
    remainingTagOccurrences = Math.max(
      0,
      remainingTagOccurrences - metadata.tags.length
    );
  }
  return metadataByEntryId;
}

function resolveAllLinks(
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex: InternalLinkResolutionIndex
): Pick<KnowledgeIndex, "outgoingByEntryId" | "backlinksByEntryId"> {
  const outgoingByEntryId = new Map<string, ResolvedLinkOccurrence[]>();
  const backlinksByEntryId = new Map<string, ResolvedLinkOccurrence[]>();
  for (const entry of entries) {
    outgoingByEntryId.set(entry.id, []);
    backlinksByEntryId.set(entry.id, []);
  }
  for (const entry of entries) {
    const resolved = (metadataByEntryId.get(entry.id)?.links ?? []).map((occurrence) =>
      resolveInternalLink(occurrence, entries, metadataByEntryId, resolutionIndex)
    );
    outgoingByEntryId.set(entry.id, resolved);
    for (const occurrence of resolved) {
      if (occurrence.status === "resolved" && occurrence.targetEntryId) {
        backlinksByEntryId.get(occurrence.targetEntryId)?.push(occurrence);
      }
    }
  }
  return { outgoingByEntryId, backlinksByEntryId };
}

function registerIndex(
  index: KnowledgeIndex,
  internals: KnowledgeIndexInternals,
  diagnostics?: KnowledgeIndexUpdateDiagnostics
): KnowledgeIndex {
  internalsByIndex.set(index, internals);
  if (diagnostics) {
    diagnosticsByIndex.set(index, diagnostics);
  }
  return index;
}

export function buildKnowledgeIndex(inputEntries: readonly VaultIndexEntry[]): KnowledgeIndex {
  const entries = inputEntries.map(normalizeEntry);
  const rawMetadataByEntryId = new Map<string, ParsedMarkdownMetadata>();
  for (const entry of entries) {
    rawMetadataByEntryId.set(entry.id, metadataForEntry(
      entry,
      MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
      MAX_TAG_OCCURRENCES_PER_ENTRY
    ));
  }
  const metadataByEntryId = applyVaultWideOccurrenceBudgets(
    entries,
    rawMetadataByEntryId
  );
  const resolutionIndex = buildInternalLinkResolutionIndex(entries, metadataByEntryId);
  const { outgoingByEntryId, backlinksByEntryId } = resolveAllLinks(
    entries,
    metadataByEntryId,
    resolutionIndex
  );

  const index: KnowledgeIndex = {
    entries,
    metadataByEntryId,
    outgoingByEntryId,
    backlinksByEntryId,
    tags: createTagIndex(metadataByEntryId)
  };
  return registerIndex(index, { rawMetadataByEntryId, resolutionIndex });
}

function internalStateFor(index: KnowledgeIndex): KnowledgeIndexInternals {
  const existing = internalsByIndex.get(index);
  if (existing) {
    return existing;
  }

  // KnowledgeIndex is a public structural type. Preserve compatibility with a
  // caller-created value, while indexes produced by this module always take the
  // lossless cached path above.
  const rawMetadataByEntryId = new Map<string, ParsedMarkdownMetadata>();
  for (const [entryId, metadata] of index.metadataByEntryId) {
    rawMetadataByEntryId.set(entryId, copyMetadata(metadata));
  }
  return {
    rawMetadataByEntryId,
    resolutionIndex: buildInternalLinkResolutionIndex(
      index.entries,
      index.metadataByEntryId
    )
  };
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function sameLinkOccurrence(
  left: InternalLinkOccurrence,
  right: InternalLinkOccurrence
): boolean {
  return left.sourceEntryId === right.sourceEntryId
    && left.sourcePath === right.sourcePath
    && left.syntax === right.syntax
    && left.raw === right.raw
    && left.target === right.target
    && left.displayText === right.displayText
    && left.fragment?.kind === right.fragment?.kind
    && left.fragment?.value === right.fragment?.value
    && left.embedded === right.embedded
    && left.line === right.line
    && left.column === right.column
    && left.context === right.context;
}

function sameLinkOccurrences(
  left: readonly InternalLinkOccurrence[] | undefined,
  right: readonly InternalLinkOccurrence[] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((occurrence, index) => sameLinkOccurrence(
    occurrence,
    right[index]
  ));
}

function sameFrontmatterValue(
  left: ParsedMarkdownMetadata["properties"][string],
  right: ParsedMarkdownMetadata["properties"][string]
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]));
  }
  return Object.is(left, right);
}

function sameProperties(
  left: ParsedMarkdownMetadata["properties"] | undefined,
  right: ParsedMarkdownMetadata["properties"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return sameStrings(leftKeys, rightKeys)
    && leftKeys.every((key) => sameFrontmatterValue(left[key], right[key]));
}

function sameHeadings(
  left: ParsedMarkdownMetadata["headings"] | undefined,
  right: ParsedMarkdownMetadata["headings"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((heading, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && heading.level === candidate.level
      && heading.text === candidate.text
      && heading.line === candidate.line
      && heading.slug === candidate.slug;
  });
}

function sameBlocks(
  left: ParsedMarkdownMetadata["blocks"] | undefined,
  right: ParsedMarkdownMetadata["blocks"] | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((block, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && block.id === candidate.id
      && block.line === candidate.line;
  });
}

function sameMetadata(
  left: ParsedMarkdownMetadata | undefined,
  right: ParsedMarkdownMetadata | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return sameStrings(left.aliases, right.aliases)
    && sameStrings(left.tags, right.tags)
    && sameProperties(left.properties, right.properties)
    && sameHeadings(left.headings, right.headings)
    && sameBlocks(left.blocks, right.blocks)
    && sameLinkOccurrences(left.links, right.links);
}

function metadataIdsThatChanged(
  previousIndex: KnowledgeIndex,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>
): string[] {
  const orderedIds = previousIndex.entries.map((entry) => entry.id);
  const seen = new Set(orderedIds);
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      orderedIds.push(entry.id);
    }
  }
  return orderedIds.filter((entryId) => !sameMetadata(
    previousIndex.metadataByEntryId.get(entryId),
    metadataByEntryId.get(entryId)
  ));
}

function metadataIdsWithChangedLinks(
  previous: ReadonlyMap<string, ParsedMarkdownMetadata>,
  next: ReadonlyMap<string, ParsedMarkdownMetadata>,
  entries: readonly VaultIndexEntry[]
): string[] {
  return entries
    .map((entry) => entry.id)
    .filter((entryId) => !sameLinkOccurrences(
      previous.get(entryId)?.links,
      next.get(entryId)?.links
    ));
}

function metadataIdsWithChangedTags(
  previous: ReadonlyMap<string, ParsedMarkdownMetadata>,
  next: ReadonlyMap<string, ParsedMarkdownMetadata>
): Set<string> {
  const entryIds = new Set([...previous.keys(), ...next.keys()]);
  return new Set([...entryIds].filter((entryId) => !sameStrings(
    previous.get(entryId)?.tags,
    next.get(entryId)?.tags
  )));
}

function resolveChangedSources(
  previousIndex: KnowledgeIndex,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex: InternalLinkResolutionIndex,
  sourceEntryIds: readonly string[]
): Pick<KnowledgeIndex, "outgoingByEntryId" | "backlinksByEntryId"> {
  const outgoingByEntryId = new Map(previousIndex.outgoingByEntryId);
  const backlinksByEntryId = new Map(previousIndex.backlinksByEntryId);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const entryOrder = new Map(entries.map((entry, index) => [entry.id, index]));
  const changedSourceIds = new Set(sourceEntryIds);
  const touchedTargetEntryIds = new Set<string>();
  const newBacklinksByTargetId = new Map<string, ResolvedLinkOccurrence[]>();

  for (const sourceEntryId of sourceEntryIds) {
    for (const occurrence of previousIndex.outgoingByEntryId.get(sourceEntryId) ?? []) {
      if (occurrence.status === "resolved" && occurrence.targetEntryId) {
        touchedTargetEntryIds.add(occurrence.targetEntryId);
      }
    }
    const entry = entryById.get(sourceEntryId);
    if (!entry) {
      outgoingByEntryId.delete(sourceEntryId);
      continue;
    }
    const resolved = (metadataByEntryId.get(sourceEntryId)?.links ?? []).map((occurrence) =>
      resolveInternalLink(occurrence, entries, metadataByEntryId, resolutionIndex)
    );
    outgoingByEntryId.set(sourceEntryId, resolved);
    for (const occurrence of resolved) {
      if (occurrence.status === "resolved" && occurrence.targetEntryId) {
        touchedTargetEntryIds.add(occurrence.targetEntryId);
        const backlinks = newBacklinksByTargetId.get(occurrence.targetEntryId);
        if (backlinks) {
          backlinks.push(occurrence);
        } else {
          newBacklinksByTargetId.set(occurrence.targetEntryId, [occurrence]);
        }
      }
    }
  }

  for (const targetEntryId of touchedTargetEntryIds) {
    if (!entryById.has(targetEntryId)) {
      backlinksByEntryId.delete(targetEntryId);
      continue;
    }
    const retained = (previousIndex.backlinksByEntryId.get(targetEntryId) ?? [])
      .filter((occurrence) => !changedSourceIds.has(occurrence.sourceEntryId));
    const added = newBacklinksByTargetId.get(targetEntryId) ?? [];
    const backlinks: ResolvedLinkOccurrence[] = [];
    let retainedIndex = 0;
    let addedIndex = 0;
    while (retainedIndex < retained.length || addedIndex < added.length) {
      const retainedOccurrence = retained[retainedIndex];
      const addedOccurrence = added[addedIndex];
      if (!retainedOccurrence) {
        backlinks.push(addedOccurrence);
        addedIndex += 1;
        continue;
      }
      if (!addedOccurrence) {
        backlinks.push(retainedOccurrence);
        retainedIndex += 1;
        continue;
      }
      const retainedOrder = entryOrder.get(retainedOccurrence.sourceEntryId)
        ?? Number.MAX_SAFE_INTEGER;
      const addedOrder = entryOrder.get(addedOccurrence.sourceEntryId)
        ?? Number.MAX_SAFE_INTEGER;
      if (retainedOrder < addedOrder) {
        backlinks.push(retainedOccurrence);
        retainedIndex += 1;
      } else {
        backlinks.push(addedOccurrence);
        addedIndex += 1;
      }
    }
    backlinksByEntryId.set(targetEntryId, backlinks);
  }

  return { outgoingByEntryId, backlinksByEntryId };
}

function updateChangedTags(
  previousIndex: KnowledgeIndex,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  changedEntryIds: ReadonlySet<string>
): Map<string, TagIndexEntry> {
  if (changedEntryIds.size === 0) {
    return new Map(previousIndex.tags);
  }

  const affectedKeys = new Set<string>();
  for (const entryId of changedEntryIds) {
    for (const tag of previousIndex.metadataByEntryId.get(entryId)?.tags ?? []) {
      affectedKeys.add(tag.toLocaleLowerCase());
    }
    for (const tag of metadataByEntryId.get(entryId)?.tags ?? []) {
      affectedKeys.add(tag.toLocaleLowerCase());
    }
  }

  const orderByEntryId = new Map(entries.map((entry, index) => [entry.id, index]));
  const tags = new Map(previousIndex.tags);
  for (const key of affectedKeys) {
    const entryIds = (previousIndex.tags.get(key)?.entryIds ?? [])
      .filter((entryId) => !changedEntryIds.has(entryId));
    for (const entryId of changedEntryIds) {
      if ((metadataByEntryId.get(entryId)?.tags ?? []).some(
        (tag) => tag.toLocaleLowerCase() === key
      )) {
        entryIds.push(entryId);
      }
    }
    entryIds.sort((left, right) =>
      (orderByEntryId.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (orderByEntryId.get(right) ?? Number.MAX_SAFE_INTEGER)
    );

    const firstEntryId = entryIds[0];
    const displayName = firstEntryId
      ? metadataByEntryId.get(firstEntryId)?.tags.find(
        (tag) => tag.toLocaleLowerCase() === key
      )
      : undefined;
    if (!displayName) {
      tags.delete(key);
      continue;
    }
    tags.set(key, {
      key,
      displayName,
      entryIds,
      count: entryIds.length,
      parentKeys: parentTagKeys(displayName)
    });
  }
  return tags;
}

function createIncrementalIndex(
  previousIndex: KnowledgeIndex,
  entries: VaultIndexEntry[],
  rawMetadataByEntryId: Map<string, ParsedMarkdownMetadata>,
  forceGlobalResolution: boolean,
  parsedEntryIds: readonly string[]
): KnowledgeIndex {
  const previousInternals = internalStateFor(previousIndex);
  const metadataByEntryId = applyVaultWideOccurrenceBudgets(
    entries,
    rawMetadataByEntryId,
    previousIndex,
    previousInternals
  );
  const changedMetadataEntryIds = metadataIdsThatChanged(
    previousIndex,
    entries,
    metadataByEntryId
  );
  const changedTagEntryIds = metadataIdsWithChangedTags(
    previousIndex.metadataByEntryId,
    metadataByEntryId
  );
  const resolutionIndex = forceGlobalResolution
    ? buildInternalLinkResolutionIndex(entries, metadataByEntryId)
    : previousInternals.resolutionIndex;
  const changedLinkSourceEntryIds = forceGlobalResolution
    ? entries.map((entry) => entry.id)
    : metadataIdsWithChangedLinks(
      previousIndex.metadataByEntryId,
      metadataByEntryId,
      entries
    );
  const links = forceGlobalResolution
    ? resolveAllLinks(entries, metadataByEntryId, resolutionIndex)
    : resolveChangedSources(
      previousIndex,
      entries,
      metadataByEntryId,
      resolutionIndex,
      changedLinkSourceEntryIds
    );
  const index: KnowledgeIndex = {
    entries,
    metadataByEntryId,
    ...links,
    tags: updateChangedTags(
      previousIndex,
      entries,
      metadataByEntryId,
      changedTagEntryIds
    )
  };
  return registerIndex(
    index,
    { rawMetadataByEntryId, resolutionIndex },
    {
      parsedEntryIds: [...parsedEntryIds],
      changedMetadataEntryIds,
      reindexedSourceEntryIds: changedLinkSourceEntryIds,
      globallyReresolved: forceGlobalResolution
    }
  );
}

/**
 * Upserts one decrypted Vault entry without reparsing unchanged entry bodies.
 * The previous index is never mutated.
 */
export function upsertKnowledgeIndex(
  previousIndex: KnowledgeIndex,
  inputEntry: VaultIndexEntry
): KnowledgeIndex {
  const entry = normalizeEntry(inputEntry);
  const previousInternals = internalStateFor(previousIndex);
  const previousEntry = previousIndex.entries.find((candidate) => candidate.id === entry.id);
  const entries = previousEntry
    ? previousIndex.entries.map((candidate) =>
      candidate.id === entry.id ? entry : candidate
    )
    : [...previousIndex.entries, entry];
  const rawMetadataByEntryId = new Map(previousInternals.rawMetadataByEntryId);
  const metadata = metadataForEntry(
    entry,
    MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
    MAX_TAG_OCCURRENCES_PER_ENTRY
  );
  rawMetadataByEntryId.set(entry.id, metadata);
  const forceGlobalResolution = !previousEntry
    || previousEntry.path !== entry.path
    || !sameStrings(
      previousInternals.rawMetadataByEntryId.get(entry.id)?.aliases,
      metadata.aliases
    );

  return createIncrementalIndex(
    previousIndex,
    entries,
    rawMetadataByEntryId,
    forceGlobalResolution,
    [entry.id]
  );
}

/** Removes one entry without reparsing any remaining entry body. */
export function removeKnowledgeIndex(
  previousIndex: KnowledgeIndex,
  entryId: string
): KnowledgeIndex {
  const previousInternals = internalStateFor(previousIndex);
  const hadEntry = previousIndex.entries.some((entry) => entry.id === entryId);
  if (!hadEntry) {
    const index: KnowledgeIndex = {
      entries: [...previousIndex.entries],
      metadataByEntryId: new Map(previousIndex.metadataByEntryId),
      outgoingByEntryId: new Map(previousIndex.outgoingByEntryId),
      backlinksByEntryId: new Map(previousIndex.backlinksByEntryId),
      tags: new Map(previousIndex.tags)
    };
    return registerIndex(
      index,
      previousInternals,
      {
        parsedEntryIds: [],
        changedMetadataEntryIds: [],
        reindexedSourceEntryIds: [],
        globallyReresolved: false
      }
    );
  }

  const entries = previousIndex.entries.filter((entry) => entry.id !== entryId);
  const rawMetadataByEntryId = new Map(previousInternals.rawMetadataByEntryId);
  rawMetadataByEntryId.delete(entryId);
  return createIncrementalIndex(
    previousIndex,
    entries,
    rawMetadataByEntryId,
    true,
    []
  );
}

export function getKnowledgeIndexUpdateDiagnostics(
  index: KnowledgeIndex
): KnowledgeIndexUpdateDiagnostics | undefined {
  const diagnostics = diagnosticsByIndex.get(index);
  return diagnostics
    ? {
        parsedEntryIds: [...diagnostics.parsedEntryIds],
        changedMetadataEntryIds: [...diagnostics.changedMetadataEntryIds],
        reindexedSourceEntryIds: [...diagnostics.reindexedSourceEntryIds],
        globallyReresolved: diagnostics.globallyReresolved
      }
    : undefined;
}

export function outgoingOccurrences(index: KnowledgeIndex, entryId: string): readonly ResolvedLinkOccurrence[] {
  return index.outgoingByEntryId.get(entryId) ?? [];
}

export function backlinkOccurrences(index: KnowledgeIndex, entryId: string): readonly ResolvedLinkOccurrence[] {
  return index.backlinksByEntryId.get(entryId) ?? [];
}

export function unlinkedMentionOccurrences(index: KnowledgeIndex, entryId: string) {
  return findUnlinkedMentions(index.entries, index.metadataByEntryId, entryId);
}
