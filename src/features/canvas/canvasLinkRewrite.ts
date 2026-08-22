import {
  applyInternalLinkRewritePlan,
  planInternalLinkRewritesForPathChanges,
  type RevisionedVaultIndexEntry,
  type VaultEntryPathChange
} from "../knowledge";
import { normalizeVaultPath, vaultDirectory } from "../knowledge/path";
import { parseCanvasDocument, safeVaultPath, type JsonCanvasDocument } from "./canvasModel";

export interface CanvasPathRewritePlan {
  sourceEntryId: string;
  sourcePath: string;
  rewrittenSourcePath: string;
  expectedRevision: number;
  originalSource: string;
  rewrittenSource: string;
  changeCount: number;
}

export interface PlanCanvasPathRewritesInput {
  entries: readonly RevisionedVaultIndexEntry[];
  pathChanges: readonly VaultEntryPathChange[];
}

export interface VaultContentPathRewritePlans {
  markdownPlans: ReturnType<typeof planInternalLinkRewritesForPathChanges>;
  canvasPlans: CanvasPathRewritePlan[];
}

export type ApplyCanvasPathRewriteResult =
  | {
      status: "applied";
      source: string;
      nextRevision: number;
      appliedChangeCount: number;
    }
  | {
      status: "conflict";
      reason: "revision-mismatch" | "content-mismatch";
      expectedRevision: number;
      actualRevision: number;
    };

interface CanvasTextSource {
  canvasEntryId: string;
  nodeId: string;
  syntheticEntryId: string;
}

function caseFold(value: string) {
  return normalizeVaultPath(value).normalize("NFC").toLocaleLowerCase();
}

function pathInDirectory(directory: string, fileName: string) {
  return normalizeVaultPath(directory ? `${directory}/${fileName}` : fileName);
}

function serializeCanvasDocument(document: JsonCanvasDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function changedPathMap(pathChanges: readonly VaultEntryPathChange[]) {
  const paths = new Map<string, string>();
  for (const change of pathChanges) {
    const oldPath = normalizeVaultPath(change.oldPath);
    const newPath = normalizeVaultPath(change.newPath);
    const key = caseFold(oldPath);
    if (paths.has(key)) {
      throw new Error("Cannot rewrite Canvas references for duplicate source paths.");
    }
    paths.set(key, newPath);
  }
  return paths;
}

/**
 * Plans path-safe JSON Canvas rewrites for one atomic vault path change set.
 *
 * JSON Canvas file cards and group backgrounds are root-relative paths. Text
 * cards contain Obsidian Markdown, so they are handed to the same semantic
 * resolver used by normal Markdown notes. Synthetic source files live in the
 * Canvas directory solely while planning; this preserves relative-link
 * semantics without persisting QuickMemo identifiers into the exported file.
 */
export function planVaultContentPathRewritesForPathChanges({
  entries,
  pathChanges
}: PlanCanvasPathRewritesInput): VaultContentPathRewritePlans {
  if (pathChanges.length === 0) return { markdownPlans: [], canvasPlans: [] };

  const changedPaths = changedPathMap(pathChanges);
  const changedPathByEntryId = new Map(pathChanges.map((change) => [
    change.entryId,
    normalizeVaultPath(change.newPath)
  ]));
  const usedIds = new Set(entries.map((entry) => entry.id));
  const usedOldPaths = new Set(entries.map((entry) => caseFold(entry.path)));
  const usedNewPaths = new Set(entries.map((entry) => caseFold(
    changedPathByEntryId.get(entry.id) ?? entry.path
  )));
  const canvasDocuments = new Map<string, JsonCanvasDocument>();
  const syntheticEntries: RevisionedVaultIndexEntry[] = [];
  const syntheticChanges: VaultEntryPathChange[] = [];
  const textSources: CanvasTextSource[] = [];
  let syntheticCounter = 0;

  for (const entry of entries) {
    if (entry.kind !== "canvas") continue;
    const source = entry.content ?? "";
    const parsed = parseCanvasDocument(source);
    if (!parsed.editable) {
      throw new Error(`Cannot safely update references in Canvas: ${entry.path}`);
    }
    canvasDocuments.set(entry.id, parsed.document);

    const oldDirectory = vaultDirectory(entry.path);
    const rewrittenEntryPath = changedPathByEntryId.get(entry.id) ?? normalizeVaultPath(entry.path);
    const newDirectory = vaultDirectory(rewrittenEntryPath);
    for (const node of parsed.document.nodes) {
      if (node.type !== "text" || !node.text) continue;

      let syntheticEntryId = "";
      let oldSyntheticPath = "";
      let newSyntheticPath = "";
      do {
        syntheticCounter += 1;
        syntheticEntryId = `__quickmemo_canvas_text_${syntheticCounter}`;
        const fileName = `.__quickmemo_canvas_text_${syntheticCounter}.md`;
        oldSyntheticPath = pathInDirectory(oldDirectory, fileName);
        newSyntheticPath = pathInDirectory(newDirectory, fileName);
      } while (
        usedIds.has(syntheticEntryId)
        || usedOldPaths.has(caseFold(oldSyntheticPath))
        || usedNewPaths.has(caseFold(newSyntheticPath))
      );

      usedIds.add(syntheticEntryId);
      usedOldPaths.add(caseFold(oldSyntheticPath));
      usedNewPaths.add(caseFold(newSyntheticPath));
      syntheticEntries.push({
        id: syntheticEntryId,
        path: oldSyntheticPath,
        kind: "markdown",
        content: node.text,
        revision: entry.revision
      });
      if (oldSyntheticPath !== newSyntheticPath) {
        syntheticChanges.push({
          entryId: syntheticEntryId,
          oldPath: oldSyntheticPath,
          newPath: newSyntheticPath
        });
      }
      textSources.push({
        canvasEntryId: entry.id,
        nodeId: node.id,
        syntheticEntryId
      });
    }
  }

  // This call also validates that the old and resulting vault paths are
  // unique. Its plans for real Markdown entries are deliberately ignored;
  // VaultPage persists those with the normal Markdown pipeline.
  const markdownPlans = planInternalLinkRewritesForPathChanges({
    entries: [...entries, ...syntheticEntries],
    pathChanges: [...pathChanges, ...syntheticChanges]
  });
  const textPlanBySyntheticId = new Map(markdownPlans.map((plan) => [plan.sourceEntryId, plan]));
  const textSourcesByCanvasId = new Map<string, CanvasTextSource[]>();
  for (const source of textSources) {
    const current = textSourcesByCanvasId.get(source.canvasEntryId) ?? [];
    current.push(source);
    textSourcesByCanvasId.set(source.canvasEntryId, current);
  }

  const canvasPlans: CanvasPathRewritePlan[] = [];
  for (const entry of entries) {
    if (entry.kind !== "canvas") continue;
    const originalSource = entry.content ?? "";
    const originalDocument = canvasDocuments.get(entry.id);
    if (!originalDocument) continue;
    let changeCount = 0;
    const textSourceByNodeId = new Map(
      (textSourcesByCanvasId.get(entry.id) ?? []).map((source) => [source.nodeId, source])
    );
    const nodes = originalDocument.nodes.map((node) => {
      let nextNode = node;
      const filePath = node.type === "file" ? safeVaultPath(node.file) : null;
      const backgroundPath = node.type === "group" ? safeVaultPath(node.background) : null;
      if (filePath) {
        const rewritten = changedPaths.get(caseFold(filePath));
        if (rewritten && normalizeVaultPath(filePath) !== rewritten) {
          nextNode = { ...nextNode, file: rewritten };
          changeCount += 1;
        }
      } else if (backgroundPath) {
        const rewritten = changedPaths.get(caseFold(backgroundPath));
        if (rewritten && normalizeVaultPath(backgroundPath) !== rewritten) {
          nextNode = { ...nextNode, background: rewritten };
          changeCount += 1;
        }
      }

      if (node.type === "text" && typeof node.text === "string") {
        const textSource = textSourceByNodeId.get(node.id);
        const textPlan = textSource ? textPlanBySyntheticId.get(textSource.syntheticEntryId) : undefined;
        if (textPlan) {
          const applied = applyInternalLinkRewritePlan(textPlan, node.text, entry.revision);
          if (applied.status !== "applied") {
            throw new Error(`Cannot safely update Markdown in Canvas: ${entry.path}`);
          }
          nextNode = { ...nextNode, text: applied.markdown };
          changeCount += applied.appliedPatchCount;
        }
      }
      return nextNode;
    });

    if (changeCount > 0) {
      canvasPlans.push({
        sourceEntryId: entry.id,
        sourcePath: normalizeVaultPath(entry.path),
        rewrittenSourcePath: changedPathByEntryId.get(entry.id) ?? normalizeVaultPath(entry.path),
        expectedRevision: entry.revision,
        originalSource,
        rewrittenSource: serializeCanvasDocument({ ...originalDocument, nodes }),
        changeCount
      });
    }
  }

  const realMarkdownEntryIds = new Set(
    entries.filter((entry) => entry.kind === "markdown").map((entry) => entry.id)
  );
  return {
    markdownPlans: markdownPlans.filter((plan) => realMarkdownEntryIds.has(plan.sourceEntryId)),
    canvasPlans: canvasPlans.sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath)
      || left.sourceEntryId.localeCompare(right.sourceEntryId)
    )
  };
}

export function planCanvasPathRewritesForPathChanges(
  input: PlanCanvasPathRewritesInput
): CanvasPathRewritePlan[] {
  return planVaultContentPathRewritesForPathChanges(input).canvasPlans;
}

export function applyCanvasPathRewritePlan(
  plan: CanvasPathRewritePlan,
  source: string,
  currentRevision: number
): ApplyCanvasPathRewriteResult {
  if (currentRevision !== plan.expectedRevision) {
    return {
      status: "conflict",
      reason: "revision-mismatch",
      expectedRevision: plan.expectedRevision,
      actualRevision: currentRevision
    };
  }
  if (source !== plan.originalSource) {
    return {
      status: "conflict",
      reason: "content-mismatch",
      expectedRevision: plan.expectedRevision,
      actualRevision: currentRevision
    };
  }
  return {
    status: "applied",
    source: plan.rewrittenSource,
    nextRevision: currentRevision + 1,
    appliedChangeCount: plan.changeCount
  };
}
