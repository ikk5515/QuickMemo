export interface PinnableWorkspaceTab {
  id: string;
  pinned?: boolean;
}

export interface WorkspaceTabClosePlan<TTab> {
  blocked: boolean;
  nextActiveTabId: string | null;
  tabs: TTab[];
}

export type WorkspaceTabGroupId = string;

export interface WorkspaceTabGroupState {
  activeTabId: string | null;
  id: WorkspaceTabGroupId;
  tabIds: string[];
}

export interface WorkspaceTabGroupsPlan {
  activeTabGroupId: WorkspaceTabGroupId;
  activeTabId: string | null;
  groups: WorkspaceTabGroupState[];
}

function orderedGroupIds(groups: readonly WorkspaceTabGroupState[], requestedOrder?: readonly string[]) {
  const available = new Set(groups.map((group) => group.id));
  const seen = new Set<string>();
  return [...(requestedOrder ?? []), ...groups.map((group) => group.id)].filter((id) => {
    if (!available.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function createDefaultWorkspaceTabGroups(): WorkspaceTabGroupState[] {
  return [{ id: "primary", tabIds: [], activeTabId: null }];
}

/**
 * Reconciles the lightweight runtime group layout with the canonical flat tab
 * collection. Tabs are unique across groups; legacy/unassigned tabs are
 * appended to primary when it exists, otherwise to the first bounded pane.
 */
export function reconcileWorkspaceTabGroups(
  groups: readonly WorkspaceTabGroupState[],
  availableTabIds: readonly string[],
  requestedActiveGroupId: WorkspaceTabGroupId,
  requestedActiveTabId: string | null,
  requestedGroupOrder?: readonly string[]
): WorkspaceTabGroupsPlan {
  const available = new Set(availableTabIds);
  const claimed = new Set<string>();
  const nextGroups: WorkspaceTabGroupState[] = [];

  for (const id of orderedGroupIds(groups, requestedGroupOrder)) {
    const source = groups.find((group) => group.id === id);
    if (!source) continue;
    const tabIds = source.tabIds.filter((tabId) => {
      if (!available.has(tabId) || claimed.has(tabId)) return false;
      claimed.add(tabId);
      return true;
    });
    nextGroups.push({
      id,
      tabIds,
      activeTabId: source.activeTabId && tabIds.includes(source.activeTabId)
        ? source.activeTabId
        : tabIds[0] ?? null
    });
  }

  if (nextGroups.length === 0) {
    nextGroups.push({ id: "primary", tabIds: [], activeTabId: null });
  }
  const fallbackGroup = nextGroups.find((group) => group.id === "primary") ?? nextGroups[0];
  for (const tabId of availableTabIds) {
    if (!claimed.has(tabId)) {
      fallbackGroup.tabIds.push(tabId);
      claimed.add(tabId);
    }
  }
  if (!fallbackGroup.activeTabId || !fallbackGroup.tabIds.includes(fallbackGroup.activeTabId)) {
    fallbackGroup.activeTabId = fallbackGroup.tabIds[0] ?? null;
  }
  const populatedGroups = nextGroups.filter((group) => group.tabIds.length > 0);
  const finalGroups = populatedGroups.length > 0 ? populatedGroups : [fallbackGroup];

  const requestedOwner = requestedActiveTabId
    ? finalGroups.find((group) => group.tabIds.includes(requestedActiveTabId))
    : undefined;
  const activeTabGroupId = requestedOwner?.id
    ?? (finalGroups.some((group) => group.id === requestedActiveGroupId)
      ? requestedActiveGroupId
      : fallbackGroup.id);
  const activeGroup = finalGroups.find((group) => group.id === activeTabGroupId) ?? finalGroups[0];
  if (requestedOwner && requestedActiveTabId) {
    requestedOwner.activeTabId = requestedActiveTabId;
  }
  return {
    activeTabGroupId: activeGroup.id,
    activeTabId: activeGroup.activeTabId,
    groups: finalGroups
  };
}

/** Move or insert a unique tab into a group and make that group active. */
export function openWorkspaceTabInGroup(
  groups: readonly WorkspaceTabGroupState[],
  tabId: string,
  targetGroupId: WorkspaceTabGroupId,
  replaceTabId: string | null = null
): WorkspaceTabGroupsPlan {
  const nextGroups = groups.map((group) => ({
    ...group,
    tabIds: group.tabIds.filter((candidate) => candidate !== tabId && candidate !== replaceTabId),
    activeTabId: group.activeTabId === tabId || group.activeTabId === replaceTabId
      ? null
      : group.activeTabId
  }));
  let target = nextGroups.find((group) => group.id === targetGroupId);
  if (!target) {
    target = { id: targetGroupId, tabIds: [], activeTabId: null };
    nextGroups.push(target);
  }
  target.tabIds.push(tabId);
  target.activeTabId = tabId;

  const cleaned = nextGroups.map((group) => ({
      ...group,
      activeTabId: group.activeTabId && group.tabIds.includes(group.activeTabId)
        ? group.activeTabId
        : group.tabIds[0] ?? null
    }));
  return { groups: cleaned, activeTabGroupId: targetGroupId, activeTabId: tabId };
}

export function activateWorkspaceTabGroup(
  groups: readonly WorkspaceTabGroupState[],
  groupId: WorkspaceTabGroupId,
  tabId?: string | null
): WorkspaceTabGroupsPlan {
  const nextGroups = groups.map((group) => {
    if (group.id !== groupId) return { ...group, tabIds: [...group.tabIds] };
    const nextActive = tabId && group.tabIds.includes(tabId) ? tabId : group.activeTabId ?? group.tabIds[0] ?? null;
    return { ...group, tabIds: [...group.tabIds], activeTabId: nextActive };
  });
  const activeGroup = nextGroups.find((group) => group.id === groupId)
    ?? nextGroups.find((group) => group.id === "primary")
    ?? nextGroups[0]
    ?? { id: "primary", tabIds: [], activeTabId: null };
  return {
    groups: nextGroups.length ? nextGroups : [activeGroup],
    activeTabGroupId: activeGroup.id,
    activeTabId: activeGroup.activeTabId
  };
}

export function removeWorkspaceTabFromGroups(
  groups: readonly WorkspaceTabGroupState[],
  tabId: string,
  activeTabGroupId: WorkspaceTabGroupId
): WorkspaceTabGroupsPlan {
  const owner = groups.find((group) => group.tabIds.includes(tabId));
  const index = owner?.tabIds.indexOf(tabId) ?? -1;
  let nextGroups = groups.map((group) => {
    if (group.id !== owner?.id) return { ...group, tabIds: [...group.tabIds] };
    const tabIds = group.tabIds.filter((candidate) => candidate !== tabId);
    const activeTabId = group.activeTabId === tabId
      ? tabIds[Math.min(index, Math.max(0, tabIds.length - 1))] ?? null
      : group.activeTabId;
    return { ...group, tabIds, activeTabId };
  });
  if (nextGroups.length > 1) {
    nextGroups = nextGroups.filter((group) => group.tabIds.length > 0);
  }
  if (nextGroups.length === 0) {
    nextGroups.push({ id: "primary", tabIds: [], activeTabId: null });
  }
  let nextActiveGroupId = nextGroups.some((group) => group.id === activeTabGroupId)
    ? activeTabGroupId
    : nextGroups.find((group) => group.id === "primary")?.id ?? nextGroups[0].id;
  const requestedActiveGroup = nextGroups.find((group) => group.id === nextActiveGroupId);
  if (!requestedActiveGroup?.activeTabId) {
    nextActiveGroupId = nextGroups.find((group) => Boolean(group.activeTabId))?.id ?? nextGroups[0].id;
  }
  const activeGroup = nextGroups.find((group) => group.id === nextActiveGroupId)!;
  return {
    groups: nextGroups,
    activeTabGroupId: nextActiveGroupId,
    activeTabId: activeGroup.activeTabId
  };
}

export function planWorkspaceTabClose<TTab extends PinnableWorkspaceTab>(
  tabs: readonly TTab[],
  tabId: string,
  activeTabId: string | null
): WorkspaceTabClosePlan<TTab> {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return { blocked: false, nextActiveTabId: activeTabId, tabs: [...tabs] };
  if (tabs[index].pinned) return { blocked: true, nextActiveTabId: activeTabId, tabs: [...tabs] };
  const nextTabs = tabs.filter((tab) => tab.id !== tabId);
  const nextActiveTabId = activeTabId === tabId
    ? nextTabs[Math.min(index, Math.max(0, nextTabs.length - 1))]?.id ?? null
    : activeTabId;
  return { blocked: false, nextActiveTabId, tabs: nextTabs };
}

export function toggleWorkspaceTabPinned<TTab extends PinnableWorkspaceTab>(tabs: readonly TTab[], tabId: string) {
  return tabs.map((tab) => tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab);
}
