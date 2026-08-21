import { backlinkOccurrences, buildKnowledgeIndex } from "./knowledgeIndex";
import {
  normalizeVaultPath,
  resolveInternalLink,
  vaultBasename,
  vaultDirectory
} from "./path";
import type {
  InternalLinkOccurrence,
  InternalLinkSyntax,
  ParsedMarkdownMetadata,
  VaultIndexEntry
} from "./types";

export interface RevisionedVaultIndexEntry extends VaultIndexEntry {
  revision: number;
}

export interface InternalLinkRewritePatch {
  start: number;
  end: number;
  before: string;
  after: string;
  syntax: InternalLinkSyntax;
  line: number;
  column: number;
}

export interface IncomingInternalLinkRewritePlan {
  sourceEntryId: string;
  sourcePath: string;
  rewrittenSourcePath: string;
  expectedRevision: number;
  targetEntryId: string;
  oldTargetPath: string;
  newTargetPath: string;
  patches: InternalLinkRewritePatch[];
}

export type ApplyInternalLinkRewriteResult =
  | {
      status: "applied";
      markdown: string;
      nextRevision: number;
      appliedPatchCount: number;
    }
  | {
      status: "conflict";
      reason: "revision-mismatch" | "content-mismatch";
      expectedRevision: number;
      actualRevision: number;
    };

export interface PlanIncomingInternalLinkRewritesInput {
  entries: readonly RevisionedVaultIndexEntry[];
  targetEntryId: string;
  newTargetPath: string;
}

function caseFold(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function withoutAliases(
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>
): Map<string, ParsedMarkdownMetadata> {
  return new Map(
    [...metadataByEntryId].map(([entryId, metadata]) => [entryId, { ...metadata, aliases: [] }])
  );
}

function offsetForOccurrence(markdown: string, occurrence: InternalLinkOccurrence): number {
  let offset = 0;
  for (let line = 1; line < occurrence.line; line += 1) {
    const newline = markdown.indexOf("\n", offset);
    if (newline < 0) {
      return -1;
    }
    offset = newline + 1;
  }
  return offset + occurrence.column - 1;
}

function markdownPath(path: string, omitMarkdownExtension: boolean): string {
  return omitMarkdownExtension ? path.replace(/\.md$/i, "") : path;
}

function relativeVaultPath(sourcePath: string, targetPath: string): string {
  const sourceParts = vaultDirectory(sourcePath).split("/").filter(Boolean);
  const targetParts = normalizeVaultPath(targetPath).split("/").filter(Boolean);
  let commonLength = 0;

  while (
    commonLength < sourceParts.length &&
    commonLength < targetParts.length &&
    caseFold(sourceParts[commonLength]) === caseFold(targetParts[commonLength])
  ) {
    commonLength += 1;
  }

  return [
    ...sourceParts.slice(commonLength).map(() => ".."),
    ...targetParts.slice(commonLength)
  ].join("/");
}

function encodeRelativeMarkdownPath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment === "." || segment === ".." ? segment : encodeURIComponent(segment))
    .join("/");
}

function occurrenceWithTarget(
  occurrence: InternalLinkOccurrence,
  sourcePath: string,
  target: string
): InternalLinkOccurrence {
  return { ...occurrence, sourcePath, target };
}

function resolvesToEntry(
  occurrence: InternalLinkOccurrence,
  candidate: string,
  sourcePath: string,
  targetEntryId: string,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>
): boolean {
  const resolution = resolveInternalLink(
    occurrenceWithTarget(occurrence, sourcePath, candidate),
    entries,
    metadataByEntryId
  );
  return resolution.status === "resolved" && resolution.targetEntryId === targetEntryId;
}

function isPathBasedLink(
  occurrence: InternalLinkOccurrence,
  targetEntryId: string,
  entries: readonly VaultIndexEntry[],
  metadataWithoutAliases: ReadonlyMap<string, ParsedMarkdownMetadata>
): boolean {
  if (!occurrence.target) {
    return false;
  }
  const resolution = resolveInternalLink(occurrence, entries, metadataWithoutAliases);
  return resolution.status === "resolved" && resolution.targetEntryId === targetEntryId;
}

function wikilinkTarget(
  occurrence: InternalLinkOccurrence,
  sourcePath: string,
  targetEntry: VaultIndexEntry,
  renamedEntries: readonly VaultIndexEntry[],
  renamedMetadata: ReadonlyMap<string, ParsedMarkdownMetadata>
): string {
  const normalizedPath = normalizeVaultPath(targetEntry.path);
  const omitMarkdownExtension = targetEntry.kind === "markdown";
  const canonicalPath = markdownPath(normalizedPath, omitMarkdownExtension);
  const basename = vaultBasename(canonicalPath);
  const candidates = [basename, canonicalPath];

  for (const candidate of candidates) {
    if (resolvesToEntry(
      occurrence,
      candidate,
      sourcePath,
      targetEntry.id,
      renamedEntries,
      renamedMetadata
    )) {
      return candidate;
    }
  }

  // The canonical path is deterministic even if a malformed vault contains a
  // duplicate path. Normal vault writes reject that state before this planner.
  return canonicalPath;
}

function rewriteWikilinkRaw(raw: string, newTarget: string): string {
  const prefixLength = raw.startsWith("![[") ? 3 : 2;
  const inner = raw.slice(prefixLength, -2);
  const aliasIndex = inner.indexOf("|");
  const targetAndFragment = aliasIndex >= 0 ? inner.slice(0, aliasIndex) : inner;
  const alias = aliasIndex >= 0 ? inner.slice(aliasIndex) : "";
  const blockIndex = targetAndFragment.indexOf("#^");
  const headingIndex = targetAndFragment.indexOf("#");
  const fragmentIndex = blockIndex >= 0 ? blockIndex : headingIndex;
  const rawTarget = fragmentIndex >= 0
    ? targetAndFragment.slice(0, fragmentIndex)
    : targetAndFragment;
  const fragment = fragmentIndex >= 0 ? targetAndFragment.slice(fragmentIndex) : "";
  const leadingWhitespace = rawTarget.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = rawTarget.match(/\s*$/)?.[0] ?? "";
  const prefix = raw.slice(0, prefixLength);

  return `${prefix}${leadingWhitespace}${newTarget}${trailingWhitespace}${fragment}${alias}]]`;
}

const MARKDOWN_LINK_RAW_PATTERN = /^((?:!)?\[[^\]]*\]\(\s*)(?:<([^>]+)>|((?:\\.|[^)\s])+))([\s\S]*)$/;

function rewriteMarkdownLinkRaw(raw: string, newTarget: string): string {
  const match = raw.match(MARKDOWN_LINK_RAW_PATTERN);
  if (!match) {
    return raw;
  }
  const [, prefix, angleTarget, plainTarget, suffix] = match;
  const originalTarget = angleTarget ?? plainTarget ?? "";
  const fragmentIndex = originalTarget.indexOf("#");
  const fragment = fragmentIndex >= 0 ? originalTarget.slice(fragmentIndex) : "";
  const wrappedTarget = angleTarget !== undefined
    ? `<${newTarget}${fragment}>`
    : `${newTarget}${fragment}`;
  return `${prefix}${wrappedTarget}${suffix}`;
}

function rewriteOccurrence(
  occurrence: InternalLinkOccurrence,
  sourcePath: string,
  targetEntry: VaultIndexEntry,
  renamedEntries: readonly VaultIndexEntry[],
  renamedMetadata: ReadonlyMap<string, ParsedMarkdownMetadata>
): string {
  if (occurrence.syntax === "wikilink") {
    return rewriteWikilinkRaw(
      occurrence.raw,
      wikilinkTarget(
        occurrence,
        sourcePath,
        targetEntry,
        renamedEntries,
        renamedMetadata
      )
    );
  }

  const originalUsedMarkdownExtension = /\.md$/i.test(occurrence.target);
  const targetPath = markdownPath(
    normalizeVaultPath(targetEntry.path),
    targetEntry.kind === "markdown" && !originalUsedMarkdownExtension
  );
  let relativePath = relativeVaultPath(sourcePath, targetPath);
  if (occurrence.target.startsWith("./") && !relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }
  return rewriteMarkdownLinkRaw(occurrence.raw, encodeRelativeMarkdownPath(relativePath));
}

function assertValidRename(
  entries: readonly RevisionedVaultIndexEntry[],
  targetEntryId: string,
  newTargetPath: string
): { targetEntry: RevisionedVaultIndexEntry; normalizedNewPath: string } {
  const targetEntry = entries.find((entry) => entry.id === targetEntryId);
  if (!targetEntry) {
    throw new Error("Cannot plan link rewrites for a missing target entry.");
  }
  const normalizedNewPath = normalizeVaultPath(newTargetPath);
  if (!normalizedNewPath) {
    throw new Error("Cannot plan link rewrites for an empty target path.");
  }
  const duplicate = entries.some((entry) =>
    entry.id !== targetEntryId && caseFold(normalizeVaultPath(entry.path)) === caseFold(normalizedNewPath)
  );
  if (duplicate) {
    throw new Error("Cannot plan link rewrites for a duplicate target path.");
  }
  return { targetEntry, normalizedNewPath };
}

export function planIncomingInternalLinkRewrites({
  entries,
  targetEntryId,
  newTargetPath
}: PlanIncomingInternalLinkRewritesInput): IncomingInternalLinkRewritePlan[] {
  const { targetEntry, normalizedNewPath } = assertValidRename(entries, targetEntryId, newTargetPath);
  const oldTargetPath = normalizeVaultPath(targetEntry.path);
  if (oldTargetPath === normalizedNewPath) {
    return [];
  }

  const oldIndex = buildKnowledgeIndex(entries);
  const oldEntries = oldIndex.entries;
  const oldMetadataWithoutAliases = withoutAliases(oldIndex.metadataByEntryId);
  const renamedEntries: RevisionedVaultIndexEntry[] = entries.map((entry) => ({
    ...entry,
    path: entry.id === targetEntryId ? normalizedNewPath : normalizeVaultPath(entry.path)
  }));
  const renamedIndex = buildKnowledgeIndex(renamedEntries);
  const renamedTarget = renamedEntries.find((entry) => entry.id === targetEntryId);
  if (!renamedTarget) {
    return [];
  }

  const occurrencesBySource = new Map<string, InternalLinkOccurrence[]>();
  for (const occurrence of backlinkOccurrences(oldIndex, targetEntryId)) {
    if (!isPathBasedLink(
      occurrence,
      targetEntryId,
      oldEntries,
      oldMetadataWithoutAliases
    )) {
      continue;
    }
    const current = occurrencesBySource.get(occurrence.sourceEntryId) ?? [];
    current.push(occurrence);
    occurrencesBySource.set(occurrence.sourceEntryId, current);
  }

  const plans: IncomingInternalLinkRewritePlan[] = [];
  for (const [sourceEntryId, occurrences] of occurrencesBySource) {
    const source = entries.find((entry) => entry.id === sourceEntryId);
    if (!source || source.kind !== "markdown") {
      continue;
    }
    const markdown = source.content ?? "";
    const rewrittenSourcePath = source.id === targetEntryId
      ? normalizedNewPath
      : normalizeVaultPath(source.path);
    const patches: InternalLinkRewritePatch[] = [];

    for (const occurrence of occurrences) {
      const start = offsetForOccurrence(markdown, occurrence);
      const end = start + occurrence.raw.length;
      if (start < 0 || markdown.slice(start, end) !== occurrence.raw) {
        throw new Error("Cannot plan link rewrites because parsed link offsets are stale.");
      }
      const after = rewriteOccurrence(
        occurrence,
        rewrittenSourcePath,
        renamedTarget,
        renamedEntries,
        renamedIndex.metadataByEntryId
      );
      if (after !== occurrence.raw) {
        patches.push({
          start,
          end,
          before: occurrence.raw,
          after,
          syntax: occurrence.syntax,
          line: occurrence.line,
          column: occurrence.column
        });
      }
    }

    if (patches.length > 0) {
      plans.push({
        sourceEntryId,
        sourcePath: normalizeVaultPath(source.path),
        rewrittenSourcePath,
        expectedRevision: source.revision,
        targetEntryId,
        oldTargetPath,
        newTargetPath: normalizedNewPath,
        patches: patches.sort((left, right) => left.start - right.start)
      });
    }
  }

  return plans.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

export function applyInternalLinkRewritePlan(
  plan: IncomingInternalLinkRewritePlan,
  markdown: string,
  currentRevision: number
): ApplyInternalLinkRewriteResult {
  if (currentRevision !== plan.expectedRevision) {
    return {
      status: "conflict",
      reason: "revision-mismatch",
      expectedRevision: plan.expectedRevision,
      actualRevision: currentRevision
    };
  }

  const patches = [...plan.patches].sort((left, right) => right.start - left.start);
  let previousStart = markdown.length;
  for (const patch of patches) {
    if (
      patch.start < 0 ||
      patch.end < patch.start ||
      patch.end > previousStart ||
      markdown.slice(patch.start, patch.end) !== patch.before
    ) {
      return {
        status: "conflict",
        reason: "content-mismatch",
        expectedRevision: plan.expectedRevision,
        actualRevision: currentRevision
      };
    }
    previousStart = patch.start;
  }

  let rewritten = markdown;
  for (const patch of patches) {
    rewritten = `${rewritten.slice(0, patch.start)}${patch.after}${rewritten.slice(patch.end)}`;
  }
  return {
    status: "applied",
    markdown: rewritten,
    nextRevision: currentRevision + 1,
    appliedPatchCount: patches.length
  };
}
