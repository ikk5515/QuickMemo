import { MAX_VAULT_BODY_UTF8_BYTES } from "./vaultPayloadLimits";

export const MAX_MARKDOWN_MERGE_INPUT_BYTES = 1_000_000;
export const MAX_MARKDOWN_MERGE_LINES = 25_000;
export const MAX_MARKDOWN_MERGE_TIME_MS = 120;
export const MAX_MARKDOWN_MERGE_WORK_UNITS = 2_000_000;

const SMALL_DIFF_CELL_BUDGET = 120_000;
const utf8Encoder = new TextEncoder();

export type MarkdownMergeLimitReason =
  | "input-too-large"
  | "too-many-lines"
  | "time-budget"
  | "work-budget";

export type MarkdownMergeChoice = "local" | "remote" | "both" | "manual";

export interface MarkdownMergeConflict {
  baseEndLine: number;
  baseStartLine: number;
  baseText: string;
  index: number;
  localText: string;
  remoteText: string;
}

export type MarkdownMergeChunk =
  | { kind: "text"; text: string }
  | { conflictIndex: number; kind: "conflict" };

export interface MarkdownMergePlan {
  chunks: readonly MarkdownMergeChunk[];
  conflicts: readonly MarkdownMergeConflict[];
  limitReason: MarkdownMergeLimitReason | null;
  mode: "merged" | "needs-resolution" | "comparison-blocked";
}

export interface MarkdownMergeResolution {
  choice: MarkdownMergeChoice;
  manualText?: string;
}

export type MarkdownMergeResolveResult =
  | { markdown: string; status: "resolved" }
  | { conflictIndexes: readonly number[]; status: "unresolved" }
  | { maxBytes: number; status: "output-too-large" };

interface DiffChange {
  baseEnd: number;
  baseStart: number;
  replacement: readonly string[];
}

interface DiffRange {
  baseEnd: number;
  baseStart: number;
  otherEnd: number;
  otherStart: number;
}

interface MergeBudget {
  deadline: number;
  nextTimeCheckWork: number;
  now: () => number;
  work: number;
}

interface BuildMarkdownMergePlanOptions {
  /** Test-only tightening. The public maximum can never be increased. */
  timeBudgetMs?: number;
}

class MergeBudgetError extends Error {
  readonly reason: Extract<MarkdownMergeLimitReason, "time-budget" | "work-budget">;

  constructor(reason: Extract<MarkdownMergeLimitReason, "time-budget" | "work-budget">) {
    super(reason);
    this.name = "MergeBudgetError";
    this.reason = reason;
  }
}

function nowMillis() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function spend(budget: MergeBudget, amount = 1) {
  budget.work += amount;
  if (budget.work > MAX_MARKDOWN_MERGE_WORK_UNITS) {
    throw new MergeBudgetError("work-budget");
  }
  if (budget.work >= budget.nextTimeCheckWork) {
    if (budget.now() > budget.deadline) throw new MergeBudgetError("time-budget");
    budget.nextTimeCheckWork = budget.work + 1_024;
  }
}

function utf8BytesWithin(value: string, limit: number) {
  if (value.length > limit) return false;
  return utf8Encoder.encode(value).byteLength <= limit;
}

function countLinesWithin(value: string, limit: number) {
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character !== 10 && character !== 13) continue;
    if (character === 13 && value.charCodeAt(index + 1) === 10) index += 1;
    lines += 1;
    if (lines > limit) return false;
  }
  return true;
}

function wholeDocumentConflict(
  base: string,
  local: string,
  remote: string,
  reason: MarkdownMergeLimitReason
): MarkdownMergePlan {
  return {
    chunks: [{ conflictIndex: 0, kind: "conflict" }],
    conflicts: [{
      baseEndLine: 0,
      baseStartLine: 0,
      baseText: base,
      index: 0,
      localText: local,
      remoteText: remote
    }],
    limitReason: reason,
    mode: "comparison-blocked"
  };
}

function splitLines(value: string) {
  // Keep LF, CRLF, and legacy CR delimiters on their source line so arbitrary
  // line ranges can be concatenated without inventing or dropping bytes.
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character !== 10 && character !== 13) continue;
    if (character === 13 && value.charCodeAt(index + 1) === 10) index += 1;
    lines.push(value.slice(start, index + 1));
    start = index + 1;
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

function matchingUniqueAnchors(
  base: readonly string[],
  other: readonly string[],
  range: DiffRange,
  budget: MergeBudget
) {
  const baseOccurrences = new Map<string, { count: number; index: number }>();
  const otherOccurrences = new Map<string, { count: number; index: number }>();
  for (let index = range.baseStart; index < range.baseEnd; index += 1) {
    spend(budget);
    const previous = baseOccurrences.get(base[index]);
    baseOccurrences.set(base[index], previous
      ? { count: previous.count + 1, index: previous.index }
      : { count: 1, index });
  }
  for (let index = range.otherStart; index < range.otherEnd; index += 1) {
    spend(budget);
    const previous = otherOccurrences.get(other[index]);
    otherOccurrences.set(other[index], previous
      ? { count: previous.count + 1, index: previous.index }
      : { count: 1, index });
  }

  const candidates: Array<{ baseIndex: number; otherIndex: number }> = [];
  for (const [line, occurrence] of baseOccurrences) {
    spend(budget);
    const otherOccurrence = otherOccurrences.get(line);
    if (occurrence.count === 1 && otherOccurrence?.count === 1) {
      candidates.push({ baseIndex: occurrence.index, otherIndex: otherOccurrence.index });
    }
  }
  candidates.sort((left, right) => left.baseIndex - right.baseIndex);
  if (!candidates.length) return [];

  // Longest increasing subsequence by the matching document's line index.
  const tails: number[] = [];
  const previous = new Int32Array(candidates.length);
  previous.fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    spend(budget, Math.max(1, Math.ceil(Math.log2(tails.length + 2))));
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]].otherIndex < candidates[index].otherIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }

  const anchors: Array<{ baseIndex: number; otherIndex: number }> = [];
  let cursor = tails[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    anchors.push(candidates[cursor]);
    cursor = previous[cursor];
  }
  anchors.reverse();
  return anchors;
}

function smallDiffChanges(
  base: readonly string[],
  other: readonly string[],
  range: DiffRange,
  budget: MergeBudget
): DiffChange[] {
  const baseLength = range.baseEnd - range.baseStart;
  const otherLength = range.otherEnd - range.otherStart;
  const columns = otherLength + 1;
  const matrix = new Uint32Array((baseLength + 1) * columns);
  spend(budget, matrix.length);

  for (let baseOffset = baseLength - 1; baseOffset >= 0; baseOffset -= 1) {
    for (let otherOffset = otherLength - 1; otherOffset >= 0; otherOffset -= 1) {
      const offset = baseOffset * columns + otherOffset;
      matrix[offset] = base[range.baseStart + baseOffset] === other[range.otherStart + otherOffset]
        ? matrix[(baseOffset + 1) * columns + otherOffset + 1] + 1
        : Math.max(matrix[(baseOffset + 1) * columns + otherOffset], matrix[offset + 1]);
    }
  }

  const matches: Array<{ baseIndex: number; otherIndex: number }> = [];
  let baseOffset = 0;
  let otherOffset = 0;
  while (baseOffset < baseLength && otherOffset < otherLength) {
    spend(budget);
    if (base[range.baseStart + baseOffset] === other[range.otherStart + otherOffset]) {
      matches.push({
        baseIndex: range.baseStart + baseOffset,
        otherIndex: range.otherStart + otherOffset
      });
      baseOffset += 1;
      otherOffset += 1;
    } else if (
      matrix[(baseOffset + 1) * columns + otherOffset]
      >= matrix[baseOffset * columns + otherOffset + 1]
    ) {
      baseOffset += 1;
    } else {
      otherOffset += 1;
    }
  }

  return changesBetweenAnchors(base, other, range, matches);
}

function changesBetweenAnchors(
  _base: readonly string[],
  other: readonly string[],
  range: DiffRange,
  anchors: readonly { baseIndex: number; otherIndex: number }[]
): DiffChange[] {
  const changes: DiffChange[] = [];
  let baseCursor = range.baseStart;
  let otherCursor = range.otherStart;
  for (const anchor of anchors) {
    if (baseCursor !== anchor.baseIndex || otherCursor !== anchor.otherIndex) {
      changes.push({
        baseEnd: anchor.baseIndex,
        baseStart: baseCursor,
        replacement: other.slice(otherCursor, anchor.otherIndex)
      });
    }
    baseCursor = anchor.baseIndex + 1;
    otherCursor = anchor.otherIndex + 1;
  }
  if (baseCursor !== range.baseEnd || otherCursor !== range.otherEnd) {
    changes.push({
      baseEnd: range.baseEnd,
      baseStart: baseCursor,
      replacement: other.slice(otherCursor, range.otherEnd)
    });
  }
  return changes;
}

function diffChanges(base: readonly string[], other: readonly string[], budget: MergeBudget) {
  const changes: DiffChange[] = [];
  const stack: DiffRange[] = [{
    baseEnd: base.length,
    baseStart: 0,
    otherEnd: other.length,
    otherStart: 0
  }];

  while (stack.length) {
    const initial = stack.pop();
    if (!initial) break;
    let { baseStart, baseEnd, otherStart, otherEnd } = initial;
    while (baseStart < baseEnd && otherStart < otherEnd && base[baseStart] === other[otherStart]) {
      spend(budget);
      baseStart += 1;
      otherStart += 1;
    }
    while (baseStart < baseEnd && otherStart < otherEnd && base[baseEnd - 1] === other[otherEnd - 1]) {
      spend(budget);
      baseEnd -= 1;
      otherEnd -= 1;
    }
    if (baseStart === baseEnd && otherStart === otherEnd) continue;
    if (baseStart === baseEnd || otherStart === otherEnd) {
      changes.push({ baseEnd, baseStart, replacement: other.slice(otherStart, otherEnd) });
      continue;
    }

    const baseLength = baseEnd - baseStart;
    const otherLength = otherEnd - otherStart;
    const range = { baseEnd, baseStart, otherEnd, otherStart };
    if ((baseLength + 1) * (otherLength + 1) <= SMALL_DIFF_CELL_BUDGET) {
      changes.push(...smallDiffChanges(base, other, range, budget));
      continue;
    }

    const anchors = matchingUniqueAnchors(base, other, range, budget);
    if (!anchors.length) {
      // Ambiguous/repeated large blocks are kept as one replacement. The
      // 3-way phase will require an explicit user decision if both sides touch it.
      changes.push({ baseEnd, baseStart, replacement: other.slice(otherStart, otherEnd) });
      continue;
    }
    let nextBaseEnd = baseEnd;
    let nextOtherEnd = otherEnd;
    for (let index = anchors.length - 1; index >= 0; index -= 1) {
      const anchor = anchors[index];
      if (anchor.baseIndex + 1 !== nextBaseEnd || anchor.otherIndex + 1 !== nextOtherEnd) {
        stack.push({
          baseEnd: nextBaseEnd,
          baseStart: anchor.baseIndex + 1,
          otherEnd: nextOtherEnd,
          otherStart: anchor.otherIndex + 1
        });
      }
      nextBaseEnd = anchor.baseIndex;
      nextOtherEnd = anchor.otherIndex;
    }
    if (baseStart !== nextBaseEnd || otherStart !== nextOtherEnd) {
      stack.push({ baseEnd: nextBaseEnd, baseStart, otherEnd: nextOtherEnd, otherStart });
    }
  }

  return changes.sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd);
}

function changesOverlap(left: DiffChange, right: DiffChange) {
  const leftInsertion = left.baseStart === left.baseEnd;
  const rightInsertion = right.baseStart === right.baseEnd;
  if (leftInsertion && rightInsertion) return left.baseStart === right.baseStart;
  if (leftInsertion) return left.baseStart >= right.baseStart && left.baseStart <= right.baseEnd;
  if (rightInsertion) return right.baseStart >= left.baseStart && right.baseStart <= left.baseEnd;
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd;
}

function applyChangesToRange(
  base: readonly string[],
  start: number,
  end: number,
  changes: readonly DiffChange[]
) {
  const result: string[] = [];
  let cursor = start;
  for (const change of changes) {
    result.push(...base.slice(cursor, change.baseStart), ...change.replacement);
    cursor = change.baseEnd;
  }
  result.push(...base.slice(cursor, end));
  return result.join("");
}

function appendText(chunks: MarkdownMergeChunk[], text: string) {
  if (!text) return;
  const last = chunks[chunks.length - 1];
  if (last?.kind === "text") last.text += text;
  else chunks.push({ kind: "text", text });
}

function mergeChanges(
  base: readonly string[],
  localChanges: readonly DiffChange[],
  remoteChanges: readonly DiffChange[],
  budget: MergeBudget
): Pick<MarkdownMergePlan, "chunks" | "conflicts"> {
  const chunks: MarkdownMergeChunk[] = [];
  const conflicts: MarkdownMergeConflict[] = [];
  let baseCursor = 0;
  let localIndex = 0;
  let remoteIndex = 0;

  const applySingle = (change: DiffChange) => {
    appendText(chunks, base.slice(baseCursor, change.baseStart).join(""));
    appendText(chunks, change.replacement.join(""));
    baseCursor = change.baseEnd;
  };

  while (localIndex < localChanges.length || remoteIndex < remoteChanges.length) {
    spend(budget);
    const local = localChanges[localIndex];
    const remote = remoteChanges[remoteIndex];
    if (!local) {
      applySingle(remote);
      remoteIndex += 1;
      continue;
    }
    if (!remote) {
      applySingle(local);
      localIndex += 1;
      continue;
    }
    if (!changesOverlap(local, remote)) {
      if (local.baseStart < remote.baseStart) {
        applySingle(local);
        localIndex += 1;
      } else {
        applySingle(remote);
        remoteIndex += 1;
      }
      continue;
    }

    const localGroup: DiffChange[] = [local];
    const remoteGroup: DiffChange[] = [remote];
    localIndex += 1;
    remoteIndex += 1;
    let expanded = true;
    while (expanded) {
      expanded = false;
      const nextLocal = localChanges[localIndex];
      if (nextLocal && remoteGroup.some((change) => changesOverlap(nextLocal, change))) {
        localGroup.push(nextLocal);
        localIndex += 1;
        expanded = true;
      }
      const nextRemote = remoteChanges[remoteIndex];
      if (nextRemote && localGroup.some((change) => changesOverlap(nextRemote, change))) {
        remoteGroup.push(nextRemote);
        remoteIndex += 1;
        expanded = true;
      }
    }

    const start = Math.min(localGroup[0].baseStart, remoteGroup[0].baseStart);
    const end = Math.max(
      ...localGroup.map((change) => change.baseEnd),
      ...remoteGroup.map((change) => change.baseEnd)
    );
    const basePrefix = base.slice(baseCursor, start).join("");
    appendText(chunks, basePrefix);
    const baseText = base.slice(start, end).join("");
    const localText = applyChangesToRange(base, start, end, localGroup);
    const remoteText = applyChangesToRange(base, start, end, remoteGroup);
    if (localText === remoteText) {
      appendText(chunks, localText);
    } else if (localText === baseText) {
      appendText(chunks, remoteText);
    } else if (remoteText === baseText) {
      appendText(chunks, localText);
    } else {
      const conflictIndex = conflicts.length;
      conflicts.push({
        baseEndLine: end,
        baseStartLine: start,
        baseText,
        index: conflictIndex,
        localText,
        remoteText
      });
      chunks.push({ conflictIndex, kind: "conflict" });
    }
    baseCursor = end;
  }

  const tail = base.slice(baseCursor).join("");
  appendText(chunks, tail);
  return { chunks, conflicts };
}

/**
 * Builds a bounded line-based 3-way merge plan. It never writes, logs, or
 * serializes plaintext. A comparison budget failure becomes one explicit
 * whole-document conflict instead of guessing or dropping either version.
 */
export function buildMarkdownMergePlan(
  base: string,
  local: string,
  remote: string,
  options: BuildMarkdownMergePlanOptions = {}
): MarkdownMergePlan {
  for (const value of [base, local, remote]) {
    if (!utf8BytesWithin(value, MAX_MARKDOWN_MERGE_INPUT_BYTES)) {
      return wholeDocumentConflict(base, local, remote, "input-too-large");
    }
    if (!countLinesWithin(value, MAX_MARKDOWN_MERGE_LINES)) {
      return wholeDocumentConflict(base, local, remote, "too-many-lines");
    }
  }

  if (local === remote) {
    return { chunks: [{ kind: "text", text: local }], conflicts: [], limitReason: null, mode: "merged" };
  }
  if (local === base) {
    return { chunks: [{ kind: "text", text: remote }], conflicts: [], limitReason: null, mode: "merged" };
  }
  if (remote === base) {
    return { chunks: [{ kind: "text", text: local }], conflicts: [], limitReason: null, mode: "merged" };
  }

  const requestedBudget = Number.isFinite(options.timeBudgetMs)
    ? Math.max(0, options.timeBudgetMs ?? MAX_MARKDOWN_MERGE_TIME_MS)
    : MAX_MARKDOWN_MERGE_TIME_MS;
  const timeBudgetMs = Math.min(MAX_MARKDOWN_MERGE_TIME_MS, requestedBudget);
  if (timeBudgetMs === 0) {
    return wholeDocumentConflict(base, local, remote, "time-budget");
  }
  const startedAt = nowMillis();
  const budget: MergeBudget = {
    deadline: startedAt + timeBudgetMs,
    nextTimeCheckWork: 1_024,
    now: nowMillis,
    work: 0
  };

  try {
    spend(budget, 1_024);
    const baseLines = splitLines(base);
    const localChanges = diffChanges(baseLines, splitLines(local), budget);
    const remoteChanges = diffChanges(baseLines, splitLines(remote), budget);
    const merged = mergeChanges(baseLines, localChanges, remoteChanges, budget);
    return {
      ...merged,
      limitReason: null,
      mode: merged.conflicts.length ? "needs-resolution" : "merged"
    };
  } catch (error) {
    if (error instanceof MergeBudgetError) {
      return wholeDocumentConflict(base, local, remote, error.reason);
    }
    // Any unexpected parser/diff failure must preserve both user versions and
    // demand an explicit choice. Do not surface exception text or inputs.
    return wholeDocumentConflict(base, local, remote, "work-budget");
  }
}

export function combineMarkdownConflictVersions(local: string, remote: string) {
  if (!local) return remote;
  if (!remote || local === remote) return local;
  const separator = local.endsWith("\n")
    || local.endsWith("\r")
    || remote.startsWith("\n")
    || remote.startsWith("\r")
    ? ""
    : "\n";
  return `${local}${separator}${remote}`;
}

export function resolveMarkdownMergePlan(
  plan: MarkdownMergePlan,
  resolutions: Readonly<Record<number, MarkdownMergeResolution | undefined>>
): MarkdownMergeResolveResult {
  const unresolved: number[] = [];
  const parts: string[] = [];
  let characters = 0;
  const appendPart = (value: string) => {
    characters += value.length;
    if (characters > MAX_VAULT_BODY_UTF8_BYTES) return false;
    parts.push(value);
    return true;
  };
  for (const chunk of plan.chunks) {
    if (chunk.kind === "text") {
      if (!appendPart(chunk.text)) {
        return { maxBytes: MAX_VAULT_BODY_UTF8_BYTES, status: "output-too-large" };
      }
      continue;
    }
    const conflict = plan.conflicts[chunk.conflictIndex];
    const resolution = resolutions[chunk.conflictIndex];
    if (!conflict || !resolution) {
      unresolved.push(chunk.conflictIndex);
      continue;
    }
    let selected: string;
    if (resolution.choice === "local") selected = conflict.localText;
    else if (resolution.choice === "remote") selected = conflict.remoteText;
    else if (resolution.choice === "both") {
      if (
        conflict.localText.length + conflict.remoteText.length + 1
        > MAX_VAULT_BODY_UTF8_BYTES - characters
      ) {
        return { maxBytes: MAX_VAULT_BODY_UTF8_BYTES, status: "output-too-large" };
      }
      selected = combineMarkdownConflictVersions(conflict.localText, conflict.remoteText);
    } else if (typeof resolution.manualText === "string") {
      selected = resolution.manualText;
    } else {
      unresolved.push(chunk.conflictIndex);
      continue;
    }
    if (!appendPart(selected)) {
      return { maxBytes: MAX_VAULT_BODY_UTF8_BYTES, status: "output-too-large" };
    }
  }
  if (unresolved.length) return { conflictIndexes: unresolved, status: "unresolved" };
  const markdown = parts.join("");
  if (!utf8BytesWithin(markdown, MAX_VAULT_BODY_UTF8_BYTES)) {
    return { maxBytes: MAX_VAULT_BODY_UTF8_BYTES, status: "output-too-large" };
  }
  return { markdown, status: "resolved" };
}
