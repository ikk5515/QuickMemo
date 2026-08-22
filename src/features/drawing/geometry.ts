import { MAX_DRAWING_COORDINATE, type DrawingElement, type DrawingPoint } from "./model";

export const DRAWING_COORDINATE_LIMIT = MAX_DRAWING_COORDINATE;
export const DRAWING_MIN_RESIZE_SIZE = 1;

export type DrawingResizeHandle = "nw" | "ne" | "se" | "sw";

export interface DrawingBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export function clampDrawingCoordinate(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-DRAWING_COORDINATE_LIMIT, Math.min(DRAWING_COORDINATE_LIMIT, value));
}

function boundedPoint(point: DrawingPoint): DrawingPoint {
  return {
    x: clampDrawingCoordinate(point.x),
    y: clampDrawingCoordinate(point.y)
  };
}

function boundsFromPoints(points: readonly DrawingPoint[]): DrawingBounds {
  let minX = points[0]?.x ?? 0;
  let maxX = minX;
  let minY = points[0]?.y ?? 0;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { height: maxY - minY, width: maxX - minX, x: minX, y: minY };
}

function drawingTextSize(element: Extract<DrawingElement, { type: "text" }>) {
  const fontSize = Math.max(12, element.strokeWidth * 8);
  const lines = element.text.split("\n");
  const longestLine = lines.reduce((longest, line) => Math.max(longest, Array.from(line).length), 1);
  return {
    fontSize,
    height: Math.max(fontSize, lines.length * fontSize * 1.2),
    width: Math.max(fontSize, longestLine * fontSize * 0.62)
  };
}

export function drawingElementBounds(element: DrawingElement): DrawingBounds {
  if (element.type === "pen") return boundsFromPoints(element.points);
  if (element.type === "text") {
    const size = drawingTextSize(element);
    return {
      height: size.height,
      width: size.width,
      x: element.point.x,
      y: element.point.y - size.fontSize
    };
  }
  return boundsFromPoints([element.start, element.end]);
}

export function drawingResizeHandlePoints(bounds: DrawingBounds): Record<DrawingResizeHandle, DrawingPoint> {
  return {
    nw: { x: bounds.x, y: bounds.y },
    ne: { x: bounds.x + bounds.width, y: bounds.y },
    se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    sw: { x: bounds.x, y: bounds.y + bounds.height }
  };
}

function pointSegmentDistance(point: DrawingPoint, start: DrawingPoint, end: DrawingPoint) {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, (
    (point.x - start.x) * (end.x - start.x)
    + (point.y - start.y) * (end.y - start.y)
  ) / lengthSquared));
  const projection = {
    x: start.x + ratio * (end.x - start.x),
    y: start.y + ratio * (end.y - start.y)
  };
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

export function drawingElementHit(element: DrawingElement, point: DrawingPoint, tolerance = 14) {
  const safeTolerance = Number.isFinite(tolerance) ? Math.max(1, Math.min(100, tolerance)) : 14;
  if (element.type === "pen") {
    if (element.points.length === 1) return pointSegmentDistance(point, element.points[0], element.points[0]) <= safeTolerance;
    for (let index = 1; index < element.points.length; index += 1) {
      if (pointSegmentDistance(point, element.points[index - 1], element.points[index]) <= safeTolerance) return true;
    }
    return false;
  }
  if (element.type === "line" || element.type === "arrow") {
    return pointSegmentDistance(point, element.start, element.end) <= safeTolerance;
  }
  const bounds = drawingElementBounds(element);
  const insideBounds = point.x >= bounds.x - safeTolerance
    && point.x <= bounds.x + bounds.width + safeTolerance
    && point.y >= bounds.y - safeTolerance
    && point.y <= bounds.y + bounds.height + safeTolerance;
  if (!insideBounds || element.type !== "ellipse") return insideBounds;
  const radiusX = Math.max(bounds.width / 2, safeTolerance);
  const radiusY = Math.max(bounds.height / 2, safeTolerance);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return ((point.x - centerX) / (radiusX + safeTolerance)) ** 2
    + ((point.y - centerY) / (radiusY + safeTolerance)) ** 2 <= 1;
}

export function translateDrawingElement(element: DrawingElement, delta: DrawingPoint): DrawingElement {
  const translate = (point: DrawingPoint) => boundedPoint({ x: point.x + delta.x, y: point.y + delta.y });
  if (element.type === "pen") return { ...element, points: element.points.map(translate) };
  if (element.type === "text") return { ...element, point: translate(element.point) };
  return { ...element, start: translate(element.start), end: translate(element.end) };
}

function resizeAxis(anchor: number, target: number, originalHandle: number, direction: -1 | 1) {
  const originalDelta = originalHandle - anchor;
  const denominator = Math.abs(originalDelta) < DRAWING_MIN_RESIZE_SIZE
    ? direction * DRAWING_MIN_RESIZE_SIZE
    : originalDelta;
  let nextTarget = clampDrawingCoordinate(target);
  if (Math.abs(nextTarget - anchor) < DRAWING_MIN_RESIZE_SIZE) {
    const targetDirection = nextTarget < anchor ? -1 : nextTarget > anchor ? 1 : direction;
    nextTarget = clampDrawingCoordinate(anchor + targetDirection * DRAWING_MIN_RESIZE_SIZE);
  }
  return (nextTarget - anchor) / denominator;
}

export function resizeDrawingElement(
  element: DrawingElement,
  handle: DrawingResizeHandle,
  target: DrawingPoint
): DrawingElement {
  const bounds = drawingElementBounds(element);
  const handles = drawingResizeHandlePoints(bounds);
  const originalHandle = handles[handle];
  const oppositeHandle = handles[handle === "nw" ? "se" : handle === "ne" ? "sw" : handle === "se" ? "nw" : "ne"];
  const scaleX = resizeAxis(oppositeHandle.x, target.x, originalHandle.x, handle === "nw" || handle === "sw" ? -1 : 1);
  const scaleY = resizeAxis(oppositeHandle.y, target.y, originalHandle.y, handle === "nw" || handle === "ne" ? -1 : 1);
  const scalePoint = (point: DrawingPoint) => boundedPoint({
    x: oppositeHandle.x + (point.x - oppositeHandle.x) * scaleX,
    y: oppositeHandle.y + (point.y - oppositeHandle.y) * scaleY
  });

  if (element.type === "pen") return { ...element, points: element.points.map(scalePoint) };
  if (element.type === "text") {
    const scale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
    return {
      ...element,
      point: scalePoint(element.point),
      strokeWidth: Math.max(0.5, Math.min(32, element.strokeWidth * scale))
    };
  }
  return { ...element, start: scalePoint(element.start), end: scalePoint(element.end) };
}

export function drawingElementsEqual(left: DrawingElement, right: DrawingElement) {
  if (
    left.id !== right.id
    || left.type !== right.type
    || left.color !== right.color
    || left.strokeWidth !== right.strokeWidth
  ) return false;
  if (left.type === "text" && right.type === "text") {
    return left.text === right.text && left.point.x === right.point.x && left.point.y === right.point.y;
  }
  if (left.type === "pen" && right.type === "pen") {
    return left.points.length === right.points.length
      && left.points.every((point, index) => point.x === right.points[index].x && point.y === right.points[index].y);
  }
  if (left.type === "text" || right.type === "text" || left.type === "pen" || right.type === "pen") return false;
  return left.start.x === right.start.x
    && left.start.y === right.start.y
    && left.end.x === right.end.x
    && left.end.y === right.end.y;
}
