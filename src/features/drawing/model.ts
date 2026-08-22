const DRAWING_MARKER = /^quickmemo-plugin:\s*drawing-v1\s*$/imu;
const DRAWING_FENCE = /```quickmemo-drawing\s*\r?\n([\s\S]*?)\r?\n```/iu;
const MAX_SOURCE_CHARACTERS = 500_000;
export const MAX_DRAWING_ELEMENTS = 5_000;
const MAX_POINTS = 25_000;
export const MAX_DRAWING_COORDINATE = 1_000_000;
const COLOR_PATTERN = /^(?:#[0-9a-f]{3,8}|transparent)$/iu;

export interface DrawingPoint { x: number; y: number }

interface DrawingElementBase {
  color: string;
  id: string;
  strokeWidth: number;
  type: "pen" | "line" | "rectangle" | "ellipse" | "arrow" | "text";
}

export type DrawingElement =
  | DrawingElementBase & { type: "pen"; points: DrawingPoint[] }
  | DrawingElementBase & { type: "line" | "rectangle" | "ellipse" | "arrow"; start: DrawingPoint; end: DrawingPoint }
  | DrawingElementBase & { type: "text"; point: DrawingPoint; text: string };

export interface DrawingDocument {
  elements: DrawingElement[];
  version: 1;
}

export interface DrawingParseResult {
  document: DrawingDocument | null;
  errors: string[];
  readOnly: boolean;
}

export function createDrawingSource(title = "Drawing") {
  const safeTitle = title.replace(/[\r\n]+/gu, " ").trim().slice(0, 180) || "Drawing";
  return `---\nquickmemo-plugin: drawing-v1\n---\n# ${safeTitle}\n\n\`\`\`quickmemo-drawing\n{"version":1,"elements":[]}\n\`\`\`\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function finiteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DRAWING_COORDINATE;
}

function point(value: unknown): DrawingPoint | null {
  return isRecord(value) && hasOnlyKeys(value, ["x", "y"])
    && finiteCoordinate(value.x) && finiteCoordinate(value.y)
    ? { x: value.x, y: value.y }
    : null;
}

function base(value: Record<string, unknown>) {
  const id = typeof value.id === "string" && /^[a-z0-9_-]{1,120}$/iu.test(value.id) ? value.id : null;
  const color = typeof value.color === "string" && COLOR_PATTERN.test(value.color) ? value.color : null;
  const strokeWidth = typeof value.strokeWidth === "number" && Number.isFinite(value.strokeWidth)
    && value.strokeWidth >= 0.5 && value.strokeWidth <= 32 ? value.strokeWidth : null;
  return id && color && strokeWidth !== null ? { color, id, strokeWidth } : null;
}

function element(value: unknown): DrawingElement | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const allowedKeys = value.type === "pen"
    ? ["type", "id", "color", "strokeWidth", "points"]
    : ["line", "rectangle", "ellipse", "arrow"].includes(value.type)
      ? ["type", "id", "color", "strokeWidth", "start", "end"]
      : value.type === "text"
        ? ["type", "id", "color", "strokeWidth", "point", "text"]
        : [];
  if (!allowedKeys.length || !hasOnlyKeys(value, allowedKeys)) return null;
  const common = base(value);
  if (!common) return null;
  if (value.type === "pen") {
    if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > MAX_POINTS) return null;
    const points = value.points.map(point);
    return points.some((item) => !item) ? null : { ...common, type: "pen", points: points as DrawingPoint[] };
  }
  if (["line", "rectangle", "ellipse", "arrow"].includes(value.type)) {
    const start = point(value.start);
    const end = point(value.end);
    return start && end
      ? { ...common, type: value.type as "line" | "rectangle" | "ellipse" | "arrow", start, end }
      : null;
  }
  if (value.type === "text") {
    const textPoint = point(value.point);
    return textPoint && typeof value.text === "string" && value.text.length >= 1 && value.text.length <= 2_000
      ? { ...common, type: "text", point: textPoint, text: value.text }
      : null;
  }
  return null;
}

export function parseDrawingSource(source: string): DrawingParseResult {
  if (source.length > MAX_SOURCE_CHARACTERS || new TextEncoder().encode(source).byteLength > MAX_SOURCE_CHARACTERS) {
    return { document: null, errors: ["Drawing 노트가 500,000자 제한을 초과했습니다."], readOnly: true };
  }
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter || !DRAWING_MARKER.test(frontmatter[1])) {
    return { document: null, errors: ["quickmemo-plugin: drawing-v1 속성이 없습니다."], readOnly: true };
  }
  const fence = source.match(DRAWING_FENCE);
  if (!fence) {
    return { document: null, errors: ["quickmemo-drawing JSON 블록이 없습니다."], readOnly: true };
  }
  try {
    const parsed: unknown = JSON.parse(fence[1]);
    if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["version", "elements"])
      || parsed.version !== 1 || !Array.isArray(parsed.elements)) {
      throw new TypeError("version 1 elements 배열이 필요합니다.");
    }
    if (parsed.elements.length > MAX_DRAWING_ELEMENTS) {
      throw new RangeError(`요소는 ${MAX_DRAWING_ELEMENTS}개까지만 저장할 수 있습니다.`);
    }
    const elements = parsed.elements.map(element);
    if (elements.some((item) => !item)) {
      throw new TypeError("지원하지 않거나 범위를 벗어난 Drawing 요소가 있습니다.");
    }
    const elementIds = new Set(elements.map((item) => item?.id));
    if (elementIds.size !== elements.length) {
      throw new TypeError("Drawing 요소 id는 중복될 수 없습니다.");
    }
    const totalPoints = elements.reduce((sum, item) => sum + (item?.type === "pen" ? item.points.length : 0), 0);
    if (totalPoints > MAX_POINTS) {
      throw new RangeError(`펜 점은 전체 ${MAX_POINTS}개까지만 저장할 수 있습니다.`);
    }
    return { document: { version: 1, elements: elements as DrawingElement[] }, errors: [], readOnly: false };
  } catch (error) {
    return {
      document: null,
      errors: [error instanceof Error ? `Drawing JSON을 열 수 없습니다: ${error.message}` : "Drawing JSON을 열 수 없습니다."],
      readOnly: true
    };
  }
}

export function serializeDrawingDocument(source: string, document: DrawingDocument) {
  const parsed = parseDrawingSource(source);
  if (!parsed.document || parsed.readOnly) {
    throw new Error("읽기 전용 Drawing 원문은 덮어쓸 수 없습니다.");
  }
  if (document.elements.length > MAX_DRAWING_ELEMENTS) {
    throw new Error(`요소는 ${MAX_DRAWING_ELEMENTS}개까지만 저장할 수 있습니다.`);
  }
  const json = JSON.stringify({ version: 1, elements: document.elements });
  const next = source.replace(DRAWING_FENCE, `\`\`\`quickmemo-drawing\n${json}\n\`\`\``);
  if (next.length > MAX_SOURCE_CHARACTERS || new TextEncoder().encode(next).byteLength > MAX_SOURCE_CHARACTERS) {
    throw new Error("Drawing 노트가 500,000자 제한을 초과했습니다.");
  }
  const validated = parseDrawingSource(next);
  if (!validated.document || validated.readOnly) {
    throw new Error(validated.errors[0] ?? "Drawing 요소 검증에 실패했습니다.");
  }
  return next;
}

export function isDrawingSource(source: string) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  return Boolean(frontmatter && DRAWING_MARKER.test(frontmatter[1]));
}
