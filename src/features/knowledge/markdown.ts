import { isExternalLinkTarget, normalizeVaultPath } from "./path";
import type {
  FrontmatterScalar,
  FrontmatterValue,
  InternalLinkFragment,
  InternalLinkOccurrence,
  ParsedMarkdownMetadata
} from "./types";

interface FrontmatterParseResult {
  properties: Record<string, FrontmatterValue>;
  start: number;
  end: number;
  endLine: number;
}

const FRONTMATTER_KEY_PATTERN = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const TAG_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}_\-/\p{Extended_Pictographic}]/u;
const TAG_NON_NUMERIC_PATTERN = /[\p{L}\p{M}_\-\p{Extended_Pictographic}]/u;
const INLINE_TAG_PATTERN = /(^|[\s([{>"'])#([\p{L}\p{M}\p{N}_\-/\p{Extended_Pictographic}]+)/gu;

export const MAX_INTERNAL_LINK_CONTEXT_CHARACTERS = 320;
export const MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY = 4_096;
export const MAX_TAG_OCCURRENCES_PER_ENTRY = 4_096;
export const MAX_TAG_CHARACTERS = 256;
export const MAX_ALIASES_PER_ENTRY = 256;
export const MAX_FRONTMATTER_PROPERTIES_PER_ENTRY = 512;
export const MAX_FRONTMATTER_SEQUENCE_VALUES = 4_096;
export const MAX_FRONTMATTER_SCALAR_CHARACTERS = 8_192;
export const MAX_HEADINGS_PER_ENTRY = 4_096;
export const MAX_BLOCK_REFERENCES_PER_ENTRY = 4_096;
export const MAX_HEADING_TEXT_CHARACTERS = 1_024;
export const MAX_INTERNAL_LINK_SYNTAX_CHARACTERS = 16_384;
export const MAX_INTERNAL_LINK_TARGET_CHARACTERS = 8_192;

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(first === '"' ? /\\"/g : /\\'/g, first);
    }
  }
  return trimmed;
}

function splitInlineYamlList(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  const values: string[] = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if ((character === '"' || character === "'") && inner[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
      current += character;
      continue;
    }
    if (character === "," && !quote) {
      values.push(current.trim());
      current = "";
      if (values.length >= MAX_FRONTMATTER_SEQUENCE_VALUES) {
        break;
      }
      continue;
    }
    current += character;
  }
  if (current.trim() || inner.endsWith(",")) {
    values.push(current.trim());
  }
  return values.filter(Boolean);
}

function parseYamlScalar(value: string): FrontmatterScalar {
  const unquoted = stripMatchingQuotes(value);
  const lowered = unquoted.toLocaleLowerCase();
  if (lowered === "null" || unquoted === "~") {
    return null;
  }
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  if (/^-?(?:\d+|\d*\.\d+)$/.test(unquoted)) {
    const numberValue = Number(unquoted);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  return unquoted.slice(0, MAX_FRONTMATTER_SCALAR_CHARACTERS);
}

function parseYamlValue(value: string): FrontmatterValue {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitInlineYamlList(trimmed).map(parseYamlScalar);
  }
  return parseYamlScalar(trimmed);
}

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const empty: FrontmatterParseResult = { properties: {}, start: 0, end: 0, endLine: 0 };
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return empty;
  }

  const lines = markdown.split(/\r?\n/);
  let closingLine = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closingLine = index;
      break;
    }
  }
  if (closingLine < 0) {
    return empty;
  }

  const properties: Record<string, FrontmatterValue> = {};
  for (let index = 1; index < closingLine; index += 1) {
    if (Object.keys(properties).length >= MAX_FRONTMATTER_PROPERTIES_PER_ENTRY) {
      break;
    }
    const match = lines[index].match(FRONTMATTER_KEY_PATTERN);
    if (!match || /^\s/.test(lines[index])) {
      continue;
    }
    const [, key, rawValue] = match;
    if (rawValue.trim()) {
      properties[key] = parseYamlValue(rawValue);
      continue;
    }

    const sequence: FrontmatterScalar[] = [];
    let sequenceIndex = index + 1;
    while (
      sequenceIndex < closingLine
      && sequence.length < MAX_FRONTMATTER_SEQUENCE_VALUES
    ) {
      const sequenceMatch = lines[sequenceIndex].match(/^\s+-\s+(.+)$/);
      if (!sequenceMatch) {
        break;
      }
      sequence.push(parseYamlScalar(sequenceMatch[1]));
      sequenceIndex += 1;
    }
    properties[key] = sequence.length > 0 ? sequence : "";
    index = sequenceIndex - 1;
  }

  let end = 0;
  for (let index = 0; index <= closingLine; index += 1) {
    end += lines[index].length;
    if (index < lines.length - 1) {
      end += markdown.slice(end, end + 2) === "\r\n" ? 2 : 1;
    }
  }
  return { properties, start: 0, end, endLine: closingLine + 1 };
}

function maskRange(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${text
    .slice(start, end)
    .replace(/[^\r\n]/g, " ")}${text.slice(end)}`;
}

function maskIgnoredMarkdown(markdown: string): string {
  let masked = markdown;
  const ranges: Array<[number, number]> = [];
  const fencedPattern = /^(?: {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?: {0,3})\1[ \t]*(?:\r?\n|$)/gm;
  const inlineCodePattern = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
  const obsidianCommentPattern = /%%[\s\S]*?%%/g;
  let match: RegExpExecArray | null;

  for (const pattern of [fencedPattern, inlineCodePattern, obsidianCommentPattern]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(masked)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    for (const [start, end] of ranges.splice(0)) {
      masked = maskRange(masked, start, end);
    }
  }
  return masked;
}

function maskLinkSyntaxForTags(markdown: string): string {
  const ranges: Array<[number, number]> = [];
  const patterns = [
    /!?\[\[[^\]]+\]\]/g,
    /!?\[[^\]]*\]\(\s*(?:<[^>]+>|(?:\\.|[^)\s])+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) {
      continue;
    }
    const boundedStart = Math.max(cursor, start);
    parts.push(markdown.slice(cursor, boundedStart));
    parts.push(markdown.slice(boundedStart, end).replace(/[^\r\n]/g, " "));
    cursor = end;
  }
  parts.push(markdown.slice(cursor));
  return parts.join("");
}

function boundedLineContext(
  markdown: string,
  lineStart: number,
  lineEnd: number,
  occurrenceOffset: number,
  occurrenceLength: number
) {
  const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");
  if (line.length <= MAX_INTERNAL_LINK_CONTEXT_CHARACTERS) {
    return line.trim();
  }

  const focusStart = Math.max(0, Math.min(line.length, occurrenceOffset - lineStart));
  const focusLength = Math.min(
    MAX_INTERNAL_LINK_CONTEXT_CHARACTERS,
    Math.max(0, occurrenceLength)
  );
  const before = Math.floor((MAX_INTERNAL_LINK_CONTEXT_CHARACTERS - focusLength) / 2);
  let start = Math.max(0, focusStart - before);
  start = Math.min(start, line.length - MAX_INTERNAL_LINK_CONTEXT_CHARACTERS);
  const focusEnd = Math.min(line.length, focusStart + focusLength);
  if (focusEnd > start + MAX_INTERNAL_LINK_CONTEXT_CHARACTERS) {
    start = Math.min(
      line.length - MAX_INTERNAL_LINK_CONTEXT_CHARACTERS,
      focusEnd - MAX_INTERNAL_LINK_CONTEXT_CHARACTERS
    );
  }
  return line.slice(start, start + MAX_INTERNAL_LINK_CONTEXT_CHARACTERS).trim();
}

function createLineLocator(markdown: string): (
  offset: number,
  occurrenceLength: number
) => { line: number; column: number; context: string } {
  const starts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return (offset, occurrenceLength) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const lineIndex = Math.max(0, high);
    const lineStart = starts[lineIndex];
    const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : markdown.length;
    return {
      line: lineIndex + 1,
      column: offset - lineStart + 1,
      context: boundedLineContext(markdown, lineStart, lineEnd, offset, occurrenceLength)
    };
  };
}

function splitTargetFragment(rawTarget: string): { target: string; fragment?: InternalLinkFragment } {
  const blockIndex = rawTarget.indexOf("#^");
  if (blockIndex >= 0) {
    return {
      target: rawTarget.slice(0, blockIndex).trim(),
      fragment: { kind: "block", value: rawTarget.slice(blockIndex + 2).trim() }
    };
  }
  const headingIndex = rawTarget.indexOf("#");
  if (headingIndex >= 0) {
    return {
      target: rawTarget.slice(0, headingIndex).trim(),
      fragment: { kind: "heading", value: rawTarget.slice(headingIndex + 1).trim() }
    };
  }
  return { target: rawTarget.trim() };
}

function normalizeLinkTarget(target: string): string {
  return target.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function parseLinks(
  entryId: string,
  sourcePath: string,
  markdown: string,
  searchableMarkdown: string,
  maximumOccurrences: number
): InternalLinkOccurrence[] {
  if (maximumOccurrences <= 0) {
    return [];
  }
  const occurrences: InternalLinkOccurrence[] = [];
  const locate = createLineLocator(markdown);
  const wikiPattern = /(!?)\[\[([^\]]+)\]\]/g;
  const markdownPattern = /(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|((?:\\.|[^)\s])+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  let match: RegExpExecArray | null;

  let wikiOccurrences = 0;
  while (
    wikiOccurrences < maximumOccurrences
    && (match = wikiPattern.exec(searchableMarkdown)) !== null
  ) {
    if (match[0].length > MAX_INTERNAL_LINK_SYNTAX_CHARACTERS) {
      continue;
    }
    const rawInner = markdown.slice(match.index + match[1].length + 2, match.index + match[0].length - 2);
    const pipeIndex = rawInner.indexOf("|");
    const targetWithFragment = pipeIndex >= 0 ? rawInner.slice(0, pipeIndex) : rawInner;
    if (targetWithFragment.length > MAX_INTERNAL_LINK_TARGET_CHARACTERS) {
      continue;
    }
    const displayText = pipeIndex >= 0 ? rawInner.slice(pipeIndex + 1).trim() : undefined;
    const { target, fragment } = splitTargetFragment(targetWithFragment);
    const location = locate(match.index, match[0].length);
    occurrences.push({
      sourceEntryId: entryId,
      sourcePath,
      syntax: "wikilink",
      raw: markdown.slice(match.index, match.index + match[0].length),
      target: normalizeLinkTarget(target),
      displayText: displayText || undefined,
      fragment,
      embedded: match[1] === "!",
      ...location
    });
    wikiOccurrences += 1;
  }

  let markdownOccurrences = 0;
  while (
    markdownOccurrences < maximumOccurrences
    && (match = markdownPattern.exec(searchableMarkdown)) !== null
  ) {
    if (match[0].length > MAX_INTERNAL_LINK_SYNTAX_CHARACTERS) {
      continue;
    }
    const rawTarget = (match[3] ?? match[4] ?? "").replace(/\\([()])/g, "$1").trim();
    if (rawTarget.length > MAX_INTERNAL_LINK_TARGET_CHARACTERS) {
      continue;
    }
    const { target, fragment } = splitTargetFragment(rawTarget);
    if ((!target && !fragment) || (target && isExternalLinkTarget(target))) {
      continue;
    }
    const location = locate(match.index, match[0].length);
    occurrences.push({
      sourceEntryId: entryId,
      sourcePath,
      syntax: "markdown",
      raw: markdown.slice(match.index, match.index + match[0].length),
      target: normalizeLinkTarget(target),
      displayText: match[2].trim() || undefined,
      fragment,
      embedded: match[1] === "!",
      ...location
    });
    markdownOccurrences += 1;
  }

  return occurrences
    .sort((left, right) => left.line - right.line || left.column - right.column)
    .slice(0, maximumOccurrences);
}

function propertyStrings(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" && value ? [value] : [];
}

export function normalizeTag(tag: string): string | null {
  const withoutHash = tag.trim().replace(/^#+/, "").replace(/^\/+|\/+$/g, "");
  if (
    !withoutHash
    || withoutHash.length > MAX_TAG_CHARACTERS
    || !TAG_CHARACTER_PATTERN.test(withoutHash)
    || !TAG_NON_NUMERIC_PATTERN.test(withoutHash)
  ) {
    return null;
  }
  return withoutHash.normalize("NFC");
}

function uniqueCaseInsensitive(
  values: readonly string[],
  maximumValues = Number.POSITIVE_INFINITY
): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (unique.length >= maximumValues) {
      break;
    }
    const key = value.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  }
  return unique;
}

function headingSlug(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^\p{L}\p{M}\p{N}_-]/gu, "");
}

export function parseObsidianMarkdown(
  entryId: string,
  sourcePath: string,
  markdown: string,
  maximumLinkOccurrences = MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
  maximumTagOccurrences = MAX_TAG_OCCURRENCES_PER_ENTRY
): ParsedMarkdownMetadata {
  const frontmatter = parseFrontmatter(markdown);
  const searchableMarkdown = maskIgnoredMarkdown(markdown);
  const bodyWithoutLinks = maskLinkSyntaxForTags(searchableMarkdown);
  const bodyForTags = frontmatter.end > 0
    ? maskRange(bodyWithoutLinks, frontmatter.start, frontmatter.end)
    : bodyWithoutLinks;
  const aliases = uniqueCaseInsensitive([
    ...propertyStrings(frontmatter.properties.aliases),
    ...propertyStrings(frontmatter.properties.alias)
  ].map((alias) => alias.trim().slice(0, MAX_FRONTMATTER_SCALAR_CHARACTERS)).filter(Boolean), MAX_ALIASES_PER_ENTRY);
  const tags: string[] = [];
  const seenTagKeys = new Set<string>();
  const tagBudget = Math.max(
    0,
    Math.min(MAX_TAG_OCCURRENCES_PER_ENTRY, Math.floor(maximumTagOccurrences))
  );
  const addTag = (candidate: string) => {
    if (tags.length >= tagBudget) {
      return;
    }
    const normalized = normalizeTag(candidate);
    const key = normalized?.toLocaleLowerCase();
    if (normalized && key && !seenTagKeys.has(key)) {
      seenTagKeys.add(key);
      tags.push(normalized);
    }
  };
  for (const tag of [
    ...propertyStrings(frontmatter.properties.tags),
    ...propertyStrings(frontmatter.properties.tag)
  ]) {
    addTag(tag);
    if (tags.length >= tagBudget) {
      break;
    }
  }
  let tagMatch: RegExpExecArray | null;
  INLINE_TAG_PATTERN.lastIndex = 0;
  while (
    tags.length < tagBudget
    && (tagMatch = INLINE_TAG_PATTERN.exec(bodyForTags)) !== null
  ) {
    addTag(tagMatch[2]);
  }

  const headings: ParsedMarkdownMetadata["headings"] = [];
  const blocks: ParsedMarkdownMetadata["blocks"] = [];
  const lines = searchableMarkdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (frontmatter.endLine > 0 && index < frontmatter.endLine) {
      continue;
    }
    const atxMatch = lines[index].match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (atxMatch && headings.length < MAX_HEADINGS_PER_ENTRY) {
      const text = atxMatch[2].trim().slice(0, MAX_HEADING_TEXT_CHARACTERS);
      headings.push({ level: atxMatch[1].length, text, line: index + 1, slug: headingSlug(text) });
    } else if (
      headings.length < MAX_HEADINGS_PER_ENTRY
      && index + 1 < lines.length
      && /^(?: {0,3})(=+|-+)\s*$/.test(lines[index + 1])
      && lines[index].trim()
    ) {
      const text = lines[index].trim().slice(0, MAX_HEADING_TEXT_CHARACTERS);
      headings.push({
        level: lines[index + 1].trim().startsWith("=") ? 1 : 2,
        text,
        line: index + 1,
        slug: headingSlug(text)
      });
    }
    const blockMatch = lines[index].match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/);
    if (blockMatch && blocks.length < MAX_BLOCK_REFERENCES_PER_ENTRY) {
      blocks.push({ id: blockMatch[1], line: index + 1 });
    }
    if (
      headings.length >= MAX_HEADINGS_PER_ENTRY
      && blocks.length >= MAX_BLOCK_REFERENCES_PER_ENTRY
    ) {
      break;
    }
  }

  return {
    aliases,
    tags,
    properties: frontmatter.properties,
    headings,
    blocks,
    links: parseLinks(
      entryId,
      normalizeVaultPath(sourcePath),
      markdown,
      searchableMarkdown,
      Math.max(
        0,
        Math.min(
          MAX_INTERNAL_LINK_OCCURRENCES_PER_ENTRY,
          Math.floor(maximumLinkOccurrences)
        )
      )
    )
  };
}
