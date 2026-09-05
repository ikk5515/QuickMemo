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

export function safeVaultPath(value: string | undefined): string | null {
  if (!value || value.length > MAX_PATH_LENGTH || value.startsWith("/") || value.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") ? value : null;
}
