import {
  MAX_ALIASES_PER_ENTRY,
  markdownOccurrenceLocation,
  markdownTextForUnlinkedMentions
} from "./markdown";
import { normalizeVaultPath, vaultStem } from "./path";
import type {
  ParsedMarkdownMetadata,
  UnlinkedMentionOccurrence,
  VaultIndexEntry
} from "./types";

export const MAX_UNLINKED_MENTION_TERM_CHARACTERS = 256;
export const MAX_UNLINKED_MENTION_OCCURRENCES_PER_SOURCE = 4_096;
export const MAX_UNLINKED_MENTION_OCCURRENCES_PER_QUERY = 32_768;

const WORD_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}_]/u;

function hasUnsafeWikilinkCharacter(value: string): boolean {
  return /[\r\n|#^]/u.test(value) || value.includes("[") || value.includes("]");
}

function caseFold(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueMentionTerms(
  target: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata | undefined
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of [vaultStem(target.path), ...(metadata?.aliases ?? []).slice(0, MAX_ALIASES_PER_ENTRY)]) {
    const term = raw.trim().normalize("NFC");
    const key = caseFold(term);
    if (
      !term
      || term.length > MAX_UNLINKED_MENTION_TERM_CHARACTERS
      || /[\r\n]/u.test(term)
      || seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms.sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function hasWordBoundary(source: string, start: number, end: number): boolean {
  const first = source[start] ?? "";
  const last = source[end - 1] ?? "";
  const before = source[start - 1] ?? "";
  const after = source[end] ?? "";
  return !(WORD_CHARACTER_PATTERN.test(first) && WORD_CHARACTER_PATTERN.test(before))
    && !(WORD_CHARACTER_PATTERN.test(last) && WORD_CHARACTER_PATTERN.test(after));
}

/**
 * Finds target-title/alias mentions only in decrypted Markdown source entries.
 * The caller supplies the already ACL-filtered knowledge scope; this helper
 * never reaches outside that set or persists any plaintext result.
 */
export function findUnlinkedMentions(
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  targetEntryId: string
): UnlinkedMentionOccurrence[] {
  const target = entries.find((entry) => entry.id === targetEntryId && entry.kind === "markdown");
  if (!target) {
    return [];
  }
  const terms = uniqueMentionTerms(target, metadataByEntryId.get(targetEntryId));
  if (terms.length === 0) {
    return [];
  }

  const termByKey = new Map(terms.map((term) => [caseFold(term), term]));
  const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "giu");
  const targetPath = normalizeVaultPath(target.path);
  const occurrences: UnlinkedMentionOccurrence[] = [];

  for (const source of entries) {
    if (
      occurrences.length >= MAX_UNLINKED_MENTION_OCCURRENCES_PER_QUERY
      || source.id === targetEntryId
      || source.kind !== "markdown"
      || !source.content
    ) {
      continue;
    }
    const searchable = markdownTextForUnlinkedMentions(source.content);
    pattern.lastIndex = 0;
    let sourceCount = 0;
    let match: RegExpExecArray | null;
    while (
      sourceCount < MAX_UNLINKED_MENTION_OCCURRENCES_PER_SOURCE
      && occurrences.length < MAX_UNLINKED_MENTION_OCCURRENCES_PER_QUERY
      && (match = pattern.exec(searchable)) !== null
    ) {
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;
      if (!hasWordBoundary(searchable, startOffset, endOffset)) {
        continue;
      }
      const matchedText = source.content.slice(startOffset, endOffset);
      const matchedTerm = termByKey.get(caseFold(matchedText));
      if (!matchedTerm) {
        continue;
      }
      occurrences.push({
        sourceEntryId: source.id,
        sourcePath: normalizeVaultPath(source.path),
        targetEntryId,
        targetPath,
        matchedText,
        matchedTerm,
        startOffset,
        endOffset,
        ...markdownOccurrenceLocation(source.content, startOffset, matchedText.length)
      });
      sourceCount += 1;
    }
  }
  return occurrences;
}

export type UnlinkedMentionEditResult =
  | { status: "applied"; markdown: string; wikilink: string }
  | { status: "stale-occurrence" }
  | { status: "unsafe-target" };

/**
 * Applies an occurrence to the latest live draft. Edits elsewhere in that
 * draft are retained; a shifted/replaced occurrence is rejected instead of
 * replacing the draft with the older indexed snapshot.
 */
export function createUnlinkedMentionWikilinkEdit(
  currentMarkdown: string,
  occurrence: UnlinkedMentionOccurrence,
  currentTargetPath: string
): UnlinkedMentionEditResult {
  const targetPath = normalizeVaultPath(currentTargetPath);
  if (
    targetPath !== normalizeVaultPath(occurrence.targetPath)
    || !targetPath.toLocaleLowerCase().endsWith(".md")
    || hasUnsafeWikilinkCharacter(targetPath)
    || hasUnsafeWikilinkCharacter(occurrence.matchedText)
  ) {
    return { status: "unsafe-target" };
  }
  if (
    occurrence.startOffset < 0
    || occurrence.endOffset <= occurrence.startOffset
    || occurrence.endOffset > currentMarkdown.length
    || currentMarkdown.slice(occurrence.startOffset, occurrence.endOffset) !== occurrence.matchedText
  ) {
    return { status: "stale-occurrence" };
  }

  const linkTarget = targetPath.replace(/\.md$/iu, "");
  const wikilink = caseFold(linkTarget) === caseFold(occurrence.matchedText)
    ? `[[${linkTarget}]]`
    : `[[${linkTarget}|${occurrence.matchedText}]]`;
  return {
    status: "applied",
    markdown: `${currentMarkdown.slice(0, occurrence.startOffset)}${wikilink}${currentMarkdown.slice(occurrence.endOffset)}`,
    wikilink
  };
}
