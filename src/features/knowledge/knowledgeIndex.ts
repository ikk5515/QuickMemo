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
import type {
  InternalLinkOccurrence,
  KnowledgeIndex,
  ParsedMarkdownMetadata,
  ResolvedLinkOccurrence,
  TagIndexEntry,
  VaultIndexEntry
} from "./types";

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
  const properties: ParsedMarkdownMetadata["properties"] = {};
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
    let remainingTextTags = maximumTagOccurrences;
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
          remainingTextTags
        );
        parts.push(metadata);
        remainingTextCharacters -= boundedText.length;
        remainingTextLinks = Math.max(0, remainingTextLinks - metadata.links.length);
        remainingTextTags = Math.max(0, remainingTextTags - metadata.tags.length);
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

export function buildKnowledgeIndex(inputEntries: readonly VaultIndexEntry[]): KnowledgeIndex {
  const entries = inputEntries.map((entry) => ({ ...entry, path: normalizeVaultPath(entry.path) }));
  const metadataByEntryId = new Map<string, ParsedMarkdownMetadata>();
  let remainingLinkOccurrences = MAX_INTERNAL_LINK_OCCURRENCES_PER_INDEX;
  let remainingTagOccurrences = MAX_TAG_OCCURRENCES_PER_INDEX;
  for (const entry of entries) {
    const entryBudget = Math.min(
      MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
      remainingLinkOccurrences
    );
    const tagBudget = Math.min(
      MAX_TAG_OCCURRENCES_PER_ENTRY,
      remainingTagOccurrences
    );
    const metadata = metadataForEntry(entry, entryBudget, tagBudget);
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

  const outgoingByEntryId = new Map<string, ResolvedLinkOccurrence[]>();
  const backlinksByEntryId = new Map<string, ResolvedLinkOccurrence[]>();
  for (const entry of entries) {
    outgoingByEntryId.set(entry.id, []);
    backlinksByEntryId.set(entry.id, []);
  }
  const resolutionIndex = buildInternalLinkResolutionIndex(entries, metadataByEntryId);
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

  return {
    entries,
    metadataByEntryId,
    outgoingByEntryId,
    backlinksByEntryId,
    tags: createTagIndex(metadataByEntryId)
  };
}

export function outgoingOccurrences(index: KnowledgeIndex, entryId: string): readonly ResolvedLinkOccurrence[] {
  return index.outgoingByEntryId.get(entryId) ?? [];
}

export function backlinkOccurrences(index: KnowledgeIndex, entryId: string): readonly ResolvedLinkOccurrence[] {
  return index.backlinksByEntryId.get(entryId) ?? [];
}
