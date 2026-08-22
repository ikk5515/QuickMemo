export const MAXIMUM_VAULT_TREE_SELECTION = 100;

export type VaultTreeTargetKind = "entry" | "folder";

export interface VaultTreeTarget {
  id: string;
  key: string;
  kind: VaultTreeTargetKind;
  parentFolderId: string | null;
}

export interface VaultTreeSelectionState {
  anchorKey: string | null;
  limitReached: boolean;
  selectedKeys: ReadonlySet<string>;
}

export interface VaultTreeSelectionModifiers {
  range: boolean;
  toggle: boolean;
}

export function vaultTreeTargetKey(kind: VaultTreeTargetKind, id: string) {
  return `${kind}:${id}`;
}

export function createVaultTreeSelectionState(): VaultTreeSelectionState {
  return { anchorKey: null, limitReached: false, selectedKeys: new Set() };
}

function boundedSelection(keys: readonly string[]) {
  return {
    limitReached: keys.length > MAXIMUM_VAULT_TREE_SELECTION,
    selectedKeys: new Set(keys.slice(0, MAXIMUM_VAULT_TREE_SELECTION))
  };
}

export function updateVaultTreeSelection(
  current: VaultTreeSelectionState,
  visibleKeys: readonly string[],
  targetKey: string,
  modifiers: VaultTreeSelectionModifiers
): VaultTreeSelectionState {
  if (!visibleKeys.includes(targetKey)) return current;
  if (modifiers.range && current.anchorKey && visibleKeys.includes(current.anchorKey)) {
    const anchorIndex = visibleKeys.indexOf(current.anchorKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    const direction = targetIndex >= anchorIndex ? 1 : -1;
    const range: string[] = [];
    for (let index = anchorIndex; ; index += direction) {
      range.push(visibleKeys[index]);
      if (index === targetIndex) break;
    }
    const requested = modifiers.toggle
      ? [...current.selectedKeys, ...range.filter((key) => !current.selectedKeys.has(key))]
      : range;
    const bounded = boundedSelection(requested);
    return {
      anchorKey: current.anchorKey,
      limitReached: bounded.limitReached,
      selectedKeys: bounded.selectedKeys
    };
  }
  if (modifiers.toggle) {
    const selectedKeys = new Set(current.selectedKeys);
    if (selectedKeys.has(targetKey)) {
      selectedKeys.delete(targetKey);
      return { anchorKey: targetKey, limitReached: false, selectedKeys };
    }
    if (selectedKeys.size >= MAXIMUM_VAULT_TREE_SELECTION) {
      return { ...current, limitReached: true };
    }
    selectedKeys.add(targetKey);
    return { anchorKey: targetKey, limitReached: false, selectedKeys };
  }
  return { anchorKey: targetKey, limitReached: false, selectedKeys: new Set([targetKey]) };
}

export function reconcileVaultTreeSelection(
  current: VaultTreeSelectionState,
  availableKeys: ReadonlySet<string>
): VaultTreeSelectionState {
  const selectedKeys = new Set([...current.selectedKeys].filter((key) => availableKeys.has(key)));
  const anchorKey = current.anchorKey && availableKeys.has(current.anchorKey)
    ? current.anchorKey
    : null;
  if (selectedKeys.size === current.selectedKeys.size && anchorKey === current.anchorKey && !current.limitReached) {
    return current;
  }
  return { anchorKey, limitReached: false, selectedKeys };
}

/**
 * Removes redundant descendants when their selected ancestor folder already
 * represents the complete subtree. This prevents duplicate move/trash calls.
 */
export function canonicalVaultTreeBulkTargets(
  targets: readonly VaultTreeTarget[],
  folderParentById: ReadonlyMap<string, string | null>
) {
  const boundedTargets = targets.slice(0, MAXIMUM_VAULT_TREE_SELECTION);
  const selectedFolderIds = new Set(
    boundedTargets.filter((target) => target.kind === "folder").map((target) => target.id)
  );
  const hasSelectedAncestor = (parentFolderId: string | null) => {
    let cursor = parentFolderId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      if (selectedFolderIds.has(cursor)) return true;
      visited.add(cursor);
      cursor = folderParentById.get(cursor) ?? null;
    }
    return false;
  };
  return boundedTargets.filter((target) => !hasSelectedAncestor(target.parentFolderId));
}
