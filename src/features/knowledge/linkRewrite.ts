import { backlinkOccurrences, buildKnowledgeIndex } from "./knowledgeIndex";
import {
  buildInternalLinkResolutionIndex,
  normalizeVaultPath,
  resolveInternalLink,
  vaultBasename,
  vaultDirectory,
  vaultStem
} from "./path";
import type { InternalLinkResolutionIndex } from "./path";
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

export interface InternalLinkRewritePlan {
  sourceEntryId: string;
  sourcePath: string;
  rewrittenSourcePath: string;
  expectedRevision: number;
  patches: InternalLinkRewritePatch[];
}

export interface IncomingInternalLinkRewritePlan extends InternalLinkRewritePlan {
  targetEntryId: string;
  oldTargetPath: string;
  newTargetPath: string;
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

export interface VaultEntryPathChange {
  entryId: string;
  oldPath: string;
  newPath: string;
}

export interface PlanInternalLinkRewritesForPathChangesInput {
  entries: readonly RevisionedVaultIndexEntry[];
  pathChanges: readonly VaultEntryPathChange[];
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
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex?: InternalLinkResolutionIndex
): boolean {
  const resolution = resolveInternalLink(
    occurrenceWithTarget(occurrence, sourcePath, candidate),
    entries,
    metadataByEntryId,
    resolutionIndex
  );
  return resolution.status === "resolved" && resolution.targetEntryId === targetEntryId;
}

function isPathBasedLink(
  occurrence: InternalLinkOccurrence,
  targetEntryId: string,
  entries: readonly VaultIndexEntry[],
  metadataWithoutAliases: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex?: InternalLinkResolutionIndex
): boolean {
  if (!occurrence.target) {
    return false;
  }
  const resolution = resolveInternalLink(
    occurrence,
    entries,
    metadataWithoutAliases,
    resolutionIndex
  );
  return resolution.status === "resolved" && resolution.targetEntryId === targetEntryId;
}

function wikilinkTarget(
  occurrence: InternalLinkOccurrence,
  sourcePath: string,
  targetEntry: VaultIndexEntry,
  renamedEntries: readonly VaultIndexEntry[],
  renamedMetadata: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex?: InternalLinkResolutionIndex
): string {
  const normalizedPath = normalizeVaultPath(targetEntry.path);
  const omitMarkdownExtension = targetEntry.kind === "markdown";
  const canonicalPath = markdownPath(normalizedPath, omitMarkdownExtension);
  const basename = vaultBasename(canonicalPath);
  const candidates = [basename, canonicalPath];
  const basenameCollisionCount = renamedEntries.filter((entry) => {
    const shortestName = entry.kind === "markdown"
      ? vaultStem(entry.path)
      : vaultBasename(entry.path);
    return caseFold(shortestName) === caseFold(basename);
  }).length;

  for (const candidate of candidates) {
    // The official resolver deterministically selects one duplicate basename,
    // but generated/re-written links must still name the intended file. Avoid
    // emitting a shortest link that would silently select a different target.
    if (candidate === basename && basenameCollisionCount > 1) {
      continue;
    }
    if (resolvesToEntry(
      occurrence,
      candidate,
      sourcePath,
      targetEntry.id,
      renamedEntries,
      renamedMetadata,
      resolutionIndex
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
  renamedMetadata: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex?: InternalLinkResolutionIndex
): { raw: string; target: string } {
  if (occurrence.syntax === "wikilink") {
    const target = wikilinkTarget(
      occurrence,
      sourcePath,
      targetEntry,
      renamedEntries,
      renamedMetadata,
      resolutionIndex
    );
    return { raw: rewriteWikilinkRaw(occurrence.raw, target), target };
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
  const target = encodeRelativeMarkdownPath(relativePath);
  return { raw: rewriteMarkdownLinkRaw(occurrence.raw, target), target };
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

function assertUniqueEntryIdsAndPaths(
  entries: readonly RevisionedVaultIndexEntry[],
  stateLabel: "current" | "resulting"
): void {
  const entryIds = new Set<string>();
  const pathOwners = new Map<string, string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) {
      throw new Error(`Cannot plan link rewrites because the ${stateLabel} vault contains a duplicate entry ID.`);
    }
    entryIds.add(entry.id);

    const path = normalizeVaultPath(entry.path);
    if (!path) {
      throw new Error(`Cannot plan link rewrites because the ${stateLabel} vault contains an empty path.`);
    }
    const pathKey = caseFold(path);
    if (pathOwners.has(pathKey)) {
      throw new Error(`Cannot plan link rewrites because the ${stateLabel} vault contains a duplicate path.`);
    }
    pathOwners.set(pathKey, entry.id);
  }
}

function normalizePathChanges(
  entries: readonly RevisionedVaultIndexEntry[],
  pathChanges: readonly VaultEntryPathChange[]
): {
  entries: RevisionedVaultIndexEntry[];
  changedPathsByEntryId: Map<string, string>;
} {
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    path: normalizeVaultPath(entry.path)
  }));
  assertUniqueEntryIdsAndPaths(normalizedEntries, "current");

  const entriesById = new Map(normalizedEntries.map((entry) => [entry.id, entry]));
  const changedPathsByEntryId = new Map<string, string>();
  for (const change of pathChanges) {
    if (changedPathsByEntryId.has(change.entryId)) {
      throw new Error("Cannot plan link rewrites for duplicate path changes to one entry.");
    }
    const entry = entriesById.get(change.entryId);
    if (!entry) {
      throw new Error("Cannot plan link rewrites for a path change with a missing entry.");
    }
    const oldPath = normalizeVaultPath(change.oldPath);
    if (oldPath !== entry.path) {
      throw new Error("Cannot plan link rewrites because a path change is stale.");
    }
    const newPath = normalizeVaultPath(change.newPath);
    if (!newPath) {
      throw new Error("Cannot plan link rewrites for an empty resulting path.");
    }
    changedPathsByEntryId.set(change.entryId, newPath);
  }

  const resultingEntries = normalizedEntries.map((entry) => ({
    ...entry,
    path: changedPathsByEntryId.get(entry.id) ?? entry.path
  }));
  assertUniqueEntryIdsAndPaths(resultingEntries, "resulting");
  return { entries: resultingEntries, changedPathsByEntryId };
}

function assertOccurrenceOffset(
  markdown: string,
  occurrence: InternalLinkOccurrence
): { start: number; end: number } {
  const start = offsetForOccurrence(markdown, occurrence);
  const end = start + occurrence.raw.length;
  if (start < 0 || end > markdown.length || markdown.slice(start, end) !== occurrence.raw) {
    throw new Error("Cannot plan link rewrites because parsed link offsets are stale.");
  }
  return { start, end };
}

function assertNonOverlappingPatches(patches: readonly InternalLinkRewritePatch[]): void {
  let previousEnd = -1;
  for (const patch of [...patches].sort((left, right) => left.start - right.start)) {
    if (patch.start < previousEnd) {
      throw new Error("Cannot plan link rewrites because parsed link offsets overlap.");
    }
    previousEnd = patch.end;
  }
}

/**
 * Plans the Markdown changes required by one atomic set of path changes.
 *
 * Every link is first resolved against the old vault, with aliases removed so
 * that an alias-only reference is never silently converted into a path link.
 * The untouched raw target is then resolved from the source's resulting path
 * against the resulting vault. A patch is only emitted when that raw target no
 * longer identifies the same entry. This is important for folder moves: links
 * inside a moved subtree often remain valid and should not churn needlessly,
 * while relative links from a moved source to an entry outside the subtree do
 * need to change.
 */
export function planInternalLinkRewritesForPathChanges({
  entries,
  pathChanges
}: PlanInternalLinkRewritesForPathChangesInput): InternalLinkRewritePlan[] {
  if (pathChanges.length === 0) {
    return [];
  }

  const oldEntries = entries.map((entry) => ({
    ...entry,
    path: normalizeVaultPath(entry.path)
  }));
  const {
    entries: resultingEntries,
    changedPathsByEntryId
  } = normalizePathChanges(entries, pathChanges);
  const hasEffectivePathChange = oldEntries.some((entry) =>
    (changedPathsByEntryId.get(entry.id) ?? entry.path) !== entry.path
  );
  if (!hasEffectivePathChange) {
    return [];
  }

  const oldIndex = buildKnowledgeIndex(oldEntries);
  const oldMetadataWithoutAliases = withoutAliases(oldIndex.metadataByEntryId);
  const oldResolutionIndexWithoutAliases = buildInternalLinkResolutionIndex(
    oldIndex.entries,
    oldMetadataWithoutAliases
  );
  const resultingIndex = buildKnowledgeIndex(resultingEntries);
  const resultingResolutionIndex = buildInternalLinkResolutionIndex(
    resultingIndex.entries,
    resultingIndex.metadataByEntryId
  );
  const resultingEntriesById = new Map(
    resultingEntries.map((entry) => [entry.id, entry])
  );
  const plans: InternalLinkRewritePlan[] = [];

  for (const source of oldEntries) {
    if (source.kind !== "markdown") {
      continue;
    }
    const markdown = source.content ?? "";
    const rewrittenSourcePath = changedPathsByEntryId.get(source.id) ?? source.path;
    const patches: InternalLinkRewritePatch[] = [];

    for (const occurrence of oldIndex.metadataByEntryId.get(source.id)?.links ?? []) {
      if (!occurrence.target) {
        continue;
      }
      const oldResolution = resolveInternalLink(
        occurrence,
        oldIndex.entries,
        oldMetadataWithoutAliases,
        oldResolutionIndexWithoutAliases
      );
      if (oldResolution.status !== "resolved" || !oldResolution.targetEntryId) {
        continue;
      }

      const targetEntry = resultingEntriesById.get(oldResolution.targetEntryId);
      if (!targetEntry) {
        continue;
      }
      const occurrenceAtResultingSource = {
        ...occurrence,
        sourcePath: rewrittenSourcePath
      };
      const unchangedResolution = resolveInternalLink(
        occurrenceAtResultingSource,
        resultingIndex.entries,
        resultingIndex.metadataByEntryId,
        resultingResolutionIndex
      );
      if (
        unchangedResolution.status === "resolved"
        && unchangedResolution.targetEntryId === targetEntry.id
      ) {
        continue;
      }

      const rewritten = rewriteOccurrence(
        occurrence,
        rewrittenSourcePath,
        targetEntry,
        resultingIndex.entries,
        resultingIndex.metadataByEntryId,
        resultingResolutionIndex
      );
      const rewrittenResolution = resolveInternalLink(
        occurrenceWithTarget(occurrence, rewrittenSourcePath, rewritten.target),
        resultingIndex.entries,
        resultingIndex.metadataByEntryId,
        resultingResolutionIndex
      );
      if (
        rewrittenResolution.status !== "resolved"
        || rewrittenResolution.targetEntryId !== targetEntry.id
      ) {
        throw new Error("Cannot plan link rewrites because the rewritten link is not uniquely resolvable.");
      }
      if (rewritten.raw === occurrence.raw) {
        throw new Error("Cannot plan link rewrites because a semantic change produced no textual patch.");
      }

      const { start, end } = assertOccurrenceOffset(markdown, occurrence);
      patches.push({
        start,
        end,
        before: occurrence.raw,
        after: rewritten.raw,
        syntax: occurrence.syntax,
        line: occurrence.line,
        column: occurrence.column
      });
    }

    if (patches.length > 0) {
      patches.sort((left, right) => left.start - right.start);
      assertNonOverlappingPatches(patches);
      plans.push({
        sourceEntryId: source.id,
        sourcePath: source.path,
        rewrittenSourcePath,
        expectedRevision: source.revision,
        patches
      });
    }
  }

  return plans.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath)
    || left.sourceEntryId.localeCompare(right.sourceEntryId)
  );
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
  const oldResolutionIndexWithoutAliases = buildInternalLinkResolutionIndex(
    oldEntries,
    oldMetadataWithoutAliases
  );
  const renamedEntries: RevisionedVaultIndexEntry[] = entries.map((entry) => ({
    ...entry,
    path: entry.id === targetEntryId ? normalizedNewPath : normalizeVaultPath(entry.path)
  }));
  const renamedIndex = buildKnowledgeIndex(renamedEntries);
  const renamedResolutionIndex = buildInternalLinkResolutionIndex(
    renamedIndex.entries,
    renamedIndex.metadataByEntryId
  );
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
      oldMetadataWithoutAliases,
      oldResolutionIndexWithoutAliases
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
      const { start, end } = assertOccurrenceOffset(markdown, occurrence);
      const rewritten = rewriteOccurrence(
        occurrence,
        rewrittenSourcePath,
        renamedTarget,
        renamedEntries,
        renamedIndex.metadataByEntryId,
        renamedResolutionIndex
      );
      if (rewritten.raw !== occurrence.raw) {
        patches.push({
          start,
          end,
          before: occurrence.raw,
          after: rewritten.raw,
          syntax: occurrence.syntax,
          line: occurrence.line,
          column: occurrence.column
        });
      }
    }

    if (patches.length > 0) {
      patches.sort((left, right) => left.start - right.start);
      assertNonOverlappingPatches(patches);
      plans.push({
        sourceEntryId,
        sourcePath: normalizeVaultPath(source.path),
        rewrittenSourcePath,
        expectedRevision: source.revision,
        targetEntryId,
        oldTargetPath,
        newTargetPath: normalizedNewPath,
        patches
      });
    }
  }

  return plans.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

export function applyInternalLinkRewritePlan(
  plan: InternalLinkRewritePlan,
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
