import type {
  GlobalGraphViewSettings,
  GraphCommonSettings,
  GraphGroup,
  GraphNode,
  GraphOpenIntent,
  GraphViewSettings,
  LocalGraphViewSettings
} from "./types";

export interface GraphNumberRange {
  min: number;
  max: number;
  step: number;
}

export const GRAPH_SETTING_RANGES = {
  centerForce: { min: 0, max: 1, step: 0.001 },
  depth: { min: 1, max: 5, step: 1 },
  linkDistance: { min: 30, max: 500, step: 1 },
  linkForce: { min: 0, max: 1, step: 0.01 },
  linkThickness: { min: 0.1, max: 5, step: 0.1 },
  nodeSize: { min: 0.1, max: 5, step: 0.1 },
  repelForce: { min: 0, max: 20, step: 0.1 },
  textFadeThreshold: { min: -3, max: 3, step: 0.1 },
  zoom: { min: 1 / 128, max: 8, step: 0.1 }
} as const satisfies Record<string, GraphNumberRange>;

const DEFAULT_COMMON_SETTINGS: GraphCommonSettings = {
  query: "",
  showTags: false,
  showAttachments: false,
  existingFilesOnly: false,
  groups: [],
  arrows: false,
  textFadeThreshold: 0,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.519,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250
};

function defaultCommonSettings(): GraphCommonSettings {
  return { ...DEFAULT_COMMON_SETTINGS, groups: [] };
}

export function createDefaultGlobalGraphSettings(): GlobalGraphViewSettings {
  return {
    scope: "global",
    common: defaultCommonSettings(),
    showOrphans: true,
    animate: false
  };
}

export function createDefaultLocalGraphSettings(): LocalGraphViewSettings {
  return {
    scope: "local",
    common: defaultCommonSettings(),
    root: "follow-active",
    depth: 1,
    incoming: true,
    outgoing: true,
    neighborLinks: false
  };
}

export function createDefaultGraphSettings(scope: GraphViewSettings["scope"]): GraphViewSettings {
  return scope === "global" ? createDefaultGlobalGraphSettings() : createDefaultLocalGraphSettings();
}

export function orderedGraphGroups(groups: readonly GraphGroup[]): GraphGroup[] {
  return groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) => left.group.order - right.group.order || left.index - right.index)
    .map(({ group }, order) => ({ ...group, order }));
}

export function moveGraphGroup(groups: readonly GraphGroup[], fromIndex: number, toIndex: number): GraphGroup[] {
  const ordered = orderedGraphGroups(groups);
  if (
    fromIndex < 0
    || fromIndex >= ordered.length
    || toIndex < 0
    || toIndex >= ordered.length
    || fromIndex === toIndex
  ) {
    return ordered;
  }

  const [moved] = ordered.splice(fromIndex, 1);
  ordered.splice(toIndex, 0, moved);
  return ordered.map((group, order) => ({ ...group, order }));
}

export function firstMatchingGraphGroup(
  node: Pick<GraphNode, "groupIds">,
  groups: readonly GraphGroup[]
): GraphGroup | undefined {
  if (!node.groupIds || node.groupIds.length === 0) {
    return undefined;
  }

  const matches = new Set(node.groupIds);
  return orderedGraphGroups(groups).find((group) => matches.has(group.id));
}

export function resolveGraphNodeColor(
  node: Pick<GraphNode, "color" | "groupIds">,
  groups: readonly GraphGroup[],
  fallback = "#8b82f6"
): string {
  return firstMatchingGraphGroup(node, groups)?.color ?? node.color ?? fallback;
}

export function clampGraphNumber(value: number, range: GraphNumberRange): number {
  if (!Number.isFinite(value)) {
    return range.min;
  }
  return Math.min(range.max, Math.max(range.min, value));
}

export function graphOpenIntentFromModifiers(modifiers: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): GraphOpenIntent {
  const primaryModifier = modifiers.metaKey || modifiers.ctrlKey;
  if (primaryModifier && modifiers.altKey && modifiers.shiftKey) {
    return { target: "new-window" };
  }
  if (primaryModifier && modifiers.altKey) {
    return { target: "new-group" };
  }
  if (primaryModifier) {
    return { target: "new-tab" };
  }
  return { target: "current" };
}

export function replaceGraphCommonSettings(
  settings: GraphViewSettings,
  common: GraphCommonSettings
): GraphViewSettings {
  return settings.scope === "global"
    ? { ...settings, common }
    : { ...settings, common };
}
