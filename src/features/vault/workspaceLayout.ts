export type VaultWorkspaceSplitDirection = "horizontal" | "vertical";

export interface VaultWorkspacePaneLeaf {
  type: "pane";
  groupId: string;
}

export interface VaultWorkspacePaneSplit {
  type: "split";
  id: string;
  direction: VaultWorkspaceSplitDirection;
  ratio: number;
  first: VaultWorkspacePaneNode;
  second: VaultWorkspacePaneNode;
}

export type VaultWorkspacePaneNode = VaultWorkspacePaneLeaf | VaultWorkspacePaneSplit;

export const MAXIMUM_WORKSPACE_PANES = 8;
export const MAXIMUM_WORKSPACE_SPLIT_DEPTH = 5;
export const MINIMUM_WORKSPACE_SPLIT_RATIO = 0.2;
export const MAXIMUM_WORKSPACE_SPLIT_RATIO = 0.8;

const IDENTIFIER_PATTERN = /^(?:primary|secondary|pane_[A-Za-z0-9_-]{1,32}|split_[A-Za-z0-9_-]{1,32})$/u;

export function isWorkspaceLayoutIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function isWorkspacePaneGroupId(value: unknown): value is string {
  return isWorkspaceLayoutIdentifier(value) && !value.startsWith("split_");
}

export function clampWorkspaceSplitRatio(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(MINIMUM_WORKSPACE_SPLIT_RATIO, Math.min(MAXIMUM_WORKSPACE_SPLIT_RATIO, value));
}

export function createDefaultWorkspaceLayout(): VaultWorkspacePaneNode {
  return { type: "pane", groupId: "primary" };
}

export function workspaceLayoutGroupIds(node: VaultWorkspacePaneNode): string[] {
  return node.type === "pane"
    ? [node.groupId]
    : [...workspaceLayoutGroupIds(node.first), ...workspaceLayoutGroupIds(node.second)];
}

export function workspaceLayoutHasGroup(node: VaultWorkspacePaneNode, groupId: string): boolean {
  return node.type === "pane"
    ? node.groupId === groupId
    : workspaceLayoutHasGroup(node.first, groupId) || workspaceLayoutHasGroup(node.second, groupId);
}

function workspaceLayoutDepth(node: VaultWorkspacePaneNode): number {
  return node.type === "pane"
    ? 1
    : 1 + Math.max(workspaceLayoutDepth(node.first), workspaceLayoutDepth(node.second));
}

function replacePane(
  node: VaultWorkspacePaneNode,
  targetGroupId: string,
  replacement: VaultWorkspacePaneNode
): VaultWorkspacePaneNode {
  if (node.type === "pane") return node.groupId === targetGroupId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, targetGroupId, replacement),
    second: replacePane(node.second, targetGroupId, replacement)
  };
}

export function splitWorkspacePane(input: {
  direction: VaultWorkspaceSplitDirection;
  layout: VaultWorkspacePaneNode;
  newGroupId: string;
  placement?: "after" | "before";
  splitId: string;
  targetGroupId: string;
}): VaultWorkspacePaneNode {
  const groups = workspaceLayoutGroupIds(input.layout);
  if (!groups.includes(input.targetGroupId)) throw new Error("workspace-layout-target-missing");
  if (groups.includes(input.newGroupId)) throw new Error("workspace-layout-group-duplicate");
  if (groups.length >= MAXIMUM_WORKSPACE_PANES) throw new Error("workspace-layout-pane-limit");
  if (!isWorkspacePaneGroupId(input.newGroupId)
    || !isWorkspaceLayoutIdentifier(input.splitId)
    || !input.splitId.startsWith("split_")) {
    throw new Error("workspace-layout-identifier-invalid");
  }
  const current: VaultWorkspacePaneLeaf = { type: "pane", groupId: input.targetGroupId };
  const added: VaultWorkspacePaneLeaf = { type: "pane", groupId: input.newGroupId };
  const split: VaultWorkspacePaneSplit = {
    type: "split",
    id: input.splitId,
    direction: input.direction,
    ratio: 0.5,
    first: input.placement === "before" ? added : current,
    second: input.placement === "before" ? current : added
  };
  const next = replacePane(input.layout, input.targetGroupId, split);
  if (workspaceLayoutDepth(next) > MAXIMUM_WORKSPACE_SPLIT_DEPTH) {
    throw new Error("workspace-layout-depth-limit");
  }
  return next;
}

export function resizeWorkspaceSplit(
  node: VaultWorkspacePaneNode,
  splitId: string,
  ratio: number
): VaultWorkspacePaneNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: clampWorkspaceSplitRatio(ratio) };
  return {
    ...node,
    first: resizeWorkspaceSplit(node.first, splitId, ratio),
    second: resizeWorkspaceSplit(node.second, splitId, ratio)
  };
}

function removePaneNode(
  node: VaultWorkspacePaneNode,
  groupId: string
): VaultWorkspacePaneNode | null {
  if (node.type === "pane") return node.groupId === groupId ? null : node;
  const first = removePaneNode(node.first, groupId);
  const second = removePaneNode(node.second, groupId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function removeWorkspacePane(
  layout: VaultWorkspacePaneNode,
  groupId: string
): VaultWorkspacePaneNode {
  const groups = workspaceLayoutGroupIds(layout);
  if (!groups.includes(groupId)) return layout;
  if (groups.length === 1) throw new Error("workspace-layout-last-pane");
  return removePaneNode(layout, groupId) ?? createDefaultWorkspaceLayout();
}

/**
 * Remove panes which no longer have a runtime tab group and collapse their
 * parent split. The final pane is kept even when its tab list is empty so the
 * workspace always has one safe destination for the next open operation.
 */
export function reconcileWorkspaceLayoutGroups(
  layout: VaultWorkspacePaneNode,
  groupIds: readonly string[]
): VaultWorkspacePaneNode {
  const allowed = new Set(groupIds.filter(isWorkspacePaneGroupId));
  if (allowed.size === 0) return createDefaultWorkspaceLayout();

  function visit(node: VaultWorkspacePaneNode): VaultWorkspacePaneNode | null {
    if (node.type === "pane") return allowed.has(node.groupId) ? node : null;
    const first = visit(node.first);
    const second = visit(node.second);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  }

  const reconciled = visit(layout);
  if (reconciled) return reconciled;
  const first = [...allowed][0];
  return first ? { type: "pane", groupId: first } : createDefaultWorkspaceLayout();
}

function normalizeNode(
  value: unknown,
  depth: number,
  seenGroups: Set<string>,
  seenSplits: Set<string>
): VaultWorkspacePaneNode | null {
  if (!value || typeof value !== "object" || depth > MAXIMUM_WORKSPACE_SPLIT_DEPTH) return null;
  const candidate = value as Partial<VaultWorkspacePaneNode> & Record<string, unknown>;
  if (candidate.type === "pane") {
    if (!isWorkspacePaneGroupId(candidate.groupId) || seenGroups.has(candidate.groupId as string)) return null;
    seenGroups.add(candidate.groupId as string);
    return { type: "pane", groupId: candidate.groupId as string };
  }
  if (candidate.type !== "split"
    || !isWorkspaceLayoutIdentifier(candidate.id)
    || !(candidate.id as string).startsWith("split_")
    || seenSplits.has(candidate.id as string)
    || (candidate.direction !== "horizontal" && candidate.direction !== "vertical")) {
    return null;
  }
  seenSplits.add(candidate.id as string);
  const first = normalizeNode(candidate.first, depth + 1, seenGroups, seenSplits);
  const second = normalizeNode(candidate.second, depth + 1, seenGroups, seenSplits);
  if (!first || !second) return null;
  return {
    type: "split",
    id: candidate.id as string,
    direction: candidate.direction,
    ratio: clampWorkspaceSplitRatio(Number(candidate.ratio)),
    first,
    second
  };
}

export function normalizeWorkspaceLayout(value: unknown): VaultWorkspacePaneNode {
  const normalized = normalizeNode(value, 1, new Set(), new Set());
  if (!normalized) return createDefaultWorkspaceLayout();
  const groups = workspaceLayoutGroupIds(normalized);
  return groups.length <= MAXIMUM_WORKSPACE_PANES ? normalized : createDefaultWorkspaceLayout();
}
