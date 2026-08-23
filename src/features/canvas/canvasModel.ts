import type { Edge, Node } from "@xyflow/react";

export type JsonCanvasNodeType = "text" | "file" | "link" | "group";
export type JsonCanvasSide = "top" | "right" | "bottom" | "left";
export type JsonCanvasEnd = "none" | "arrow";

export interface JsonCanvasNode extends Record<string, unknown> {
  id: string;
  type: JsonCanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
}

export interface JsonCanvasEdge extends Record<string, unknown> {
  id: string;
  fromNode: string;
  fromSide?: JsonCanvasSide;
  fromEnd?: JsonCanvasEnd;
  toNode: string;
  toSide?: JsonCanvasSide;
  toEnd?: JsonCanvasEnd;
  color?: string;
  label?: string;
}

export interface JsonCanvasDocument extends Record<string, unknown> {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

export interface JsonCanvasParseResult {
  document: JsonCanvasDocument;
  editable: boolean;
  warnings: string[];
}

export interface CanvasFlowNodeData extends Record<string, unknown> {
  canvas: JsonCanvasNode;
}

export type CanvasFlowNode = Node<CanvasFlowNodeData, "canvasCard">;
export type CanvasFlowEdge = Edge<JsonCanvasEdge>;

export type CanvasAlignment = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type CanvasDistribution = "horizontal" | "vertical";
export type CanvasStackOrder = "front" | "back";

const MAX_CANVAS_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_CANVAS_NODES = 10_000;
const MAX_CANVAS_EDGES = 20_000;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_COORDINATE = 100_000_000;
const MAX_DIMENSION = 1_000_000;
const JSON_CANVAS_SIDES = new Set<JsonCanvasSide>(["top", "right", "bottom", "left"]);
const JSON_CANVAS_ENDS = new Set<JsonCanvasEnd>(["none", "arrow"]);
const JSON_CANVAS_NODE_TYPES = new Set<JsonCanvasNodeType>(["text", "file", "link", "group"]);
const JSON_CANVAS_PRESET_COLORS: Record<string, string> = {
  "1": "#ef4444",
  "2": "#f97316",
  "3": "#eab308",
  "4": "#22c55e",
  "5": "#06b6d4",
  "6": "#a855f7"
};
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function isCoordinate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function isDimension(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION;
}

function isOptionalEnum<T extends string>(value: unknown, values: ReadonlySet<T>): value is T | undefined {
  return value === undefined || (typeof value === "string" && values.has(value as T));
}

function isCanvasNode(value: unknown): value is JsonCanvasNode {
  if (!isRecord(value)
    || !isBoundedString(value.id, MAX_ID_LENGTH, false)
    || !isBoundedString(value.type, 16, false)
    || !JSON_CANVAS_NODE_TYPES.has(value.type as JsonCanvasNodeType)
    || !isCoordinate(value.x)
    || !isCoordinate(value.y)
    || !isDimension(value.width)
    || !isDimension(value.height)
    || (value.color !== undefined && !isBoundedString(value.color, 64))
  ) {
    return false;
  }

  if (value.type === "text") {
    return isBoundedString(value.text, MAX_TEXT_LENGTH);
  }
  if (value.type === "file") {
    return isBoundedString(value.file, MAX_PATH_LENGTH, false)
      && (value.subpath === undefined || isBoundedString(value.subpath, MAX_PATH_LENGTH));
  }
  if (value.type === "link") {
    return isBoundedString(value.url, MAX_PATH_LENGTH, false);
  }
  return (value.label === undefined || isBoundedString(value.label, MAX_TEXT_LENGTH))
    && (value.background === undefined || isBoundedString(value.background, MAX_PATH_LENGTH))
    && (value.backgroundStyle === undefined || ["cover", "ratio", "repeat"].includes(String(value.backgroundStyle)));
}

function isCanvasEdge(value: unknown): value is JsonCanvasEdge {
  return isRecord(value)
    && isBoundedString(value.id, MAX_ID_LENGTH, false)
    && isBoundedString(value.fromNode, MAX_ID_LENGTH, false)
    && isBoundedString(value.toNode, MAX_ID_LENGTH, false)
    && isOptionalEnum(value.fromSide, JSON_CANVAS_SIDES)
    && isOptionalEnum(value.toSide, JSON_CANVAS_SIDES)
    && isOptionalEnum(value.fromEnd, JSON_CANVAS_ENDS)
    && isOptionalEnum(value.toEnd, JSON_CANVAS_ENDS)
    && (value.color === undefined || isBoundedString(value.color, 64))
    && (value.label === undefined || isBoundedString(value.label, MAX_TEXT_LENGTH));
}

export function parseCanvasDocument(source: string): JsonCanvasParseResult {
  if (new TextEncoder().encode(source).byteLength > MAX_CANVAS_SOURCE_BYTES) {
    return {
      document: { nodes: [], edges: [] },
      editable: false,
      warnings: ["Canvas 파일이 안전한 편집 크기 제한을 초과했습니다. 원본은 변경하지 않습니다."]
    };
  }

  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)
      || (parsed.nodes !== undefined && !Array.isArray(parsed.nodes))
      || (parsed.edges !== undefined && !Array.isArray(parsed.edges))
    ) {
      return {
        document: { nodes: [], edges: [] },
        editable: false,
        warnings: ["Canvas JSON 형식을 확인할 수 없어 편집을 잠갔습니다. 원본은 변경하지 않습니다."]
      };
    }

    const rawNodes = parsed.nodes ?? [];
    const rawEdges = parsed.edges ?? [];
    const warnings: string[] = [];
    const nodeIds = new Set<string>();
    const nodes: JsonCanvasNode[] = [];
    if (rawNodes.length > MAX_CANVAS_NODES) {
      warnings.push("Canvas 카드 수가 안전한 편집 제한을 초과했습니다. 원본은 변경하지 않습니다.");
    }
    for (const candidate of rawNodes.slice(0, MAX_CANVAS_NODES)) {
      if (isCanvasNode(candidate) && !nodeIds.has(candidate.id)) {
        nodeIds.add(candidate.id);
        nodes.push({ ...candidate });
      } else {
        warnings.push("지원하지 않거나 중복된 Canvas 카드가 있어 편집을 잠갔습니다.");
      }
    }

    const edgeIds = new Set<string>();
    const edges: JsonCanvasEdge[] = [];
    if (rawEdges.length > MAX_CANVAS_EDGES) {
      warnings.push("Canvas 연결선 수가 안전한 편집 제한을 초과했습니다. 원본은 변경하지 않습니다.");
    }
    for (const candidate of rawEdges.slice(0, MAX_CANVAS_EDGES)) {
      if (isCanvasEdge(candidate)
        && !edgeIds.has(candidate.id)
        && nodeIds.has(candidate.fromNode)
        && nodeIds.has(candidate.toNode)
      ) {
        edgeIds.add(candidate.id);
        edges.push({ ...candidate });
      } else {
        warnings.push("지원하지 않거나 끊어진 Canvas 연결선이 있어 편집을 잠갔습니다.");
      }
    }

    return {
      document: { ...parsed, nodes, edges } as JsonCanvasDocument,
      editable: warnings.length === 0,
      warnings: [...new Set(warnings)]
    };
  } catch {
    return {
      document: { nodes: [], edges: [] },
      editable: false,
      warnings: ["Canvas JSON을 읽을 수 없어 편집을 잠갔습니다. 원본은 변경하지 않습니다."]
    };
  }
}

export function safeCanvasDocument(source: string): JsonCanvasDocument {
  return parseCanvasDocument(source).document;
}

export function safeHttpUrl(value: string | undefined): string | null {
  if (!value || value.length > MAX_PATH_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function safeVaultPath(value: string | undefined): string | null {
  if (!value || value.length > MAX_PATH_LENGTH || value.startsWith("/") || value.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") ? value : null;
}

export function safeCanvasColor(value: string | undefined, fallback = "#8b82f6") {
  if (!value) {
    return fallback;
  }
  if (Object.hasOwn(JSON_CANVAS_PRESET_COLORS, value)) {
    return JSON_CANVAS_PRESET_COLORS[value];
  }
  return HEX_COLOR_PATTERN.test(value) ? value : fallback;
}

export function effectiveJsonCanvasEdgeEnds(edge: Pick<JsonCanvasEdge, "fromEnd" | "toEnd">) {
  return {
    fromEnd: edge.fromEnd ?? "none",
    toEnd: edge.toEnd ?? "arrow"
  } as const;
}

export function jsonCanvasEdgeEndsForDirection(value: string): Pick<JsonCanvasEdge, "fromEnd" | "toEnd"> | null {
  if (value === "none-arrow") return { fromEnd: "none", toEnd: "arrow" };
  if (value === "arrow-none") return { fromEnd: "arrow", toEnd: "none" };
  if (value === "arrow-arrow") return { fromEnd: "arrow", toEnd: "arrow" };
  if (value === "none-none") return { fromEnd: "none", toEnd: "none" };
  return null;
}

export function jsonCanvasEdgeNavigationNodeId(
  edge: Pick<JsonCanvasEdge, "fromNode" | "toNode">,
  direction: "source" | "target"
) {
  return direction === "source" ? edge.fromNode : edge.toNode;
}

function nodeSize(node: JsonCanvasNode) {
  return { width: node.width, height: node.height };
}

function canvasNodeContains(container: JsonCanvasNode, candidate: JsonCanvasNode) {
  const sameBounds = candidate.x === container.x
    && candidate.y === container.y
    && candidate.width === container.width
    && candidate.height === container.height;
  return candidate.id !== container.id
    && !(candidate.type === "group" && sameBounds)
    && candidate.x >= container.x
    && candidate.y >= container.y
    && candidate.x + candidate.width <= container.x + container.width
    && candidate.y + candidate.height <= container.y + container.height;
}

function canvasGroupArea(group: JsonCanvasNode) {
  return group.width * group.height;
}

/**
 * A card can be geometrically covered by multiple groups even though JSON
 * Canvas has no parent field. Choose the smallest enclosing group and then the
 * highest z-order group (last in `nodes`) so membership is deterministic.
 */
export function containingJsonCanvasGroupId(
  document: JsonCanvasDocument,
  candidate: JsonCanvasNode
): string | null {
  let owner: JsonCanvasNode | null = null;
  let ownerIndex = -1;
  for (const [index, node] of document.nodes.entries()) {
    if (node.type !== "group" || !canvasNodeContains(node, candidate)) {
      continue;
    }
    const area = canvasGroupArea(node);
    const ownerArea = owner ? canvasGroupArea(owner) : Number.POSITIVE_INFINITY;
    if (area < ownerArea || (area === ownerArea && index > ownerIndex)) {
      owner = node;
      ownerIndex = index;
    }
  }
  return owner?.id ?? null;
}

/**
 * JSON Canvas 1.0 intentionally has no persisted parent/group identifier.
 * Obsidian therefore derives group membership from geometry. Keep that
 * relationship in memory only so round-tripping never adds a proprietary
 * field to the canonical `.canvas` document.
 */
export function containedJsonCanvasNodeIds(
  document: JsonCanvasDocument,
  groupIds: ReadonlySet<string>
): Set<string> {
  if (groupIds.size === 0) {
    return new Set();
  }
  const existingGroupIds = new Set(document.nodes.flatMap((node) => (
    node.type === "group" && groupIds.has(node.id) ? [node.id] : []
  )));
  if (existingGroupIds.size === 0) {
    return new Set();
  }
  const contained = new Set<string>();
  const pending = [...existingGroupIds];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const groupId = pending[cursor];
    for (const node of document.nodes) {
      if (
        existingGroupIds.has(node.id)
        || contained.has(node.id)
        || containingJsonCanvasGroupId(document, node) !== groupId
      ) {
        continue;
      }
      contained.add(node.id);
      if (node.type === "group") {
        pending.push(node.id);
      }
    }
  }
  return contained;
}

export function expandJsonCanvasGroupSelection(
  document: JsonCanvasDocument,
  selectedNodeIds: ReadonlySet<string>
): Set<string> {
  const expanded = new Set(selectedNodeIds);
  if (expanded.size === document.nodes.length) {
    return expanded;
  }
  for (const id of containedJsonCanvasNodeIds(document, selectedNodeIds)) {
    expanded.add(id);
  }
  return expanded;
}

export function translateJsonCanvasNodes(
  document: JsonCanvasDocument,
  nodeIds: ReadonlySet<string>,
  deltaX: number,
  deltaY: number
): JsonCanvasDocument {
  if (
    nodeIds.size === 0
    || (!deltaX && !deltaY)
    || !Number.isFinite(deltaX)
    || !Number.isFinite(deltaY)
  ) {
    return document;
  }
  return {
    ...document,
    nodes: document.nodes.map((node) => nodeIds.has(node.id)
      ? { ...node, x: node.x + deltaX, y: node.y + deltaY }
      : node)
  };
}

export function alignJsonCanvasNodes(
  document: JsonCanvasDocument,
  selectedNodeIds: ReadonlySet<string>,
  alignment: CanvasAlignment
): JsonCanvasDocument {
  const selected = document.nodes.filter((node) => selectedNodeIds.has(node.id));
  if (selected.length < 2) {
    return document;
  }

  const left = Math.min(...selected.map((node) => node.x));
  const right = Math.max(...selected.map((node) => node.x + nodeSize(node).width));
  const top = Math.min(...selected.map((node) => node.y));
  const bottom = Math.max(...selected.map((node) => node.y + nodeSize(node).height));
  const horizontalCenter = (left + right) / 2;
  const verticalCenter = (top + bottom) / 2;

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (!selectedNodeIds.has(node.id)) {
        return node;
      }
      if (alignment === "left") {
        return { ...node, x: left };
      }
      if (alignment === "center") {
        return { ...node, x: horizontalCenter - node.width / 2 };
      }
      if (alignment === "right") {
        return { ...node, x: right - node.width };
      }
      if (alignment === "top") {
        return { ...node, y: top };
      }
      if (alignment === "middle") {
        return { ...node, y: verticalCenter - node.height / 2 };
      }
      return { ...node, y: bottom - node.height };
    })
  };
}

export function distributeJsonCanvasNodes(
  document: JsonCanvasDocument,
  selectedNodeIds: ReadonlySet<string>,
  distribution: CanvasDistribution
): JsonCanvasDocument {
  const sourceOrder = new Map(document.nodes.map((node, index) => [node.id, index]));
  const selected = document.nodes
    .filter((node) => selectedNodeIds.has(node.id))
    .sort((first, second) => {
      const firstStart = distribution === "horizontal" ? first.x : first.y;
      const secondStart = distribution === "horizontal" ? second.x : second.y;
      return firstStart - secondStart
        || (sourceOrder.get(first.id) ?? 0) - (sourceOrder.get(second.id) ?? 0);
    });
  if (selected.length < 3) {
    return document;
  }

  const first = selected[0];
  const last = selected[selected.length - 1];
  const start = distribution === "horizontal" ? first.x : first.y;
  const end = distribution === "horizontal"
    ? last.x + last.width
    : last.y + last.height;
  const occupied = selected.reduce(
    (total, node) => total + (distribution === "horizontal" ? node.width : node.height),
    0
  );
  const gap = (end - start - occupied) / (selected.length - 1);
  const distributedPosition = new Map<string, number>();
  let cursor = start;
  for (const node of selected) {
    distributedPosition.set(node.id, cursor);
    cursor += (distribution === "horizontal" ? node.width : node.height) + gap;
  }

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const position = distributedPosition.get(node.id);
      if (position === undefined) {
        return node;
      }
      return distribution === "horizontal"
        ? { ...node, x: position }
        : { ...node, y: position };
    })
  };
}

export function reorderJsonCanvasNodes(
  document: JsonCanvasDocument,
  selectedNodeIds: ReadonlySet<string>,
  stackOrder: CanvasStackOrder
): JsonCanvasDocument {
  const selected = document.nodes.filter((node) => selectedNodeIds.has(node.id));
  if (selected.length === 0 || selected.length === document.nodes.length) {
    return document;
  }
  const unselected = document.nodes.filter((node) => !selectedNodeIds.has(node.id));
  return {
    ...document,
    // JSON Canvas 1.0 orders nodes from the lowest to the highest z-index.
    nodes: stackOrder === "front"
      ? [...unselected, ...selected]
      : [...selected, ...unselected]
  };
}

export interface DuplicateCanvasResult {
  document: JsonCanvasDocument;
  newNodeIds: Set<string>;
}

export function duplicateJsonCanvasSelection(
  document: JsonCanvasDocument,
  selectedNodeIds: ReadonlySet<string>,
  createId: (kind: "node" | "edge", originalId: string) => string,
  offset = 32
): DuplicateCanvasResult {
  const effectiveSelection = expandJsonCanvasGroupSelection(document, selectedNodeIds);
  const idMap = new Map<string, string>();
  const duplicates: JsonCanvasNode[] = [];

  for (const node of document.nodes) {
    if (!effectiveSelection.has(node.id)) {
      continue;
    }
    const id = createId("node", node.id);
    idMap.set(node.id, id);
    duplicates.push({ ...node, id, x: node.x + offset, y: node.y + offset });
  }

  const duplicateEdges: JsonCanvasEdge[] = [];
  for (const edge of document.edges) {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    if (fromNode && toNode) {
      duplicateEdges.push({
        ...edge,
        id: createId("edge", edge.id),
        fromNode,
        toNode
      });
    }
  }

  return {
    document: {
      ...document,
      nodes: [...document.nodes, ...duplicates],
      edges: [...document.edges, ...duplicateEdges]
    },
    newNodeIds: new Set(idMap.values())
  };
}

function measuredDimension(value: number | undefined, measured: number | undefined, styleValue: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    return measured;
  }
  if (typeof styleValue === "number" && Number.isFinite(styleValue) && styleValue > 0) {
    return styleValue;
  }
  return fallback;
}

export function canvasDocumentFromFlow(
  nodes: readonly CanvasFlowNode[],
  edges: readonly CanvasFlowEdge[],
  extensions: JsonCanvasDocument = { nodes: [], edges: [] }
): JsonCanvasDocument {
  return {
    ...extensions,
    nodes: nodes.map((node) => {
      const canvas = node.data.canvas;
      return {
        ...canvas,
        id: node.id,
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        width: Math.round(measuredDimension(node.width, node.measured?.width, node.style?.width, canvas.width)),
        height: Math.round(measuredDimension(node.height, node.measured?.height, node.style?.height, canvas.height))
      };
    }),
    edges: edges.map((edge) => ({
      ...(edge.data ?? {}),
      id: edge.id,
      fromNode: edge.source,
      toNode: edge.target
    }))
  };
}

export function serializeCanvas(
  nodes: readonly CanvasFlowNode[],
  edges: readonly CanvasFlowEdge[],
  extensions?: JsonCanvasDocument
) {
  return `${JSON.stringify(canvasDocumentFromFlow(nodes, edges, extensions), null, 2)}\n`;
}

export const emptyJsonCanvas = `${JSON.stringify({ nodes: [], edges: [] }, null, 2)}\n`;
