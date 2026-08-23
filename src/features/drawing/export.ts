import { drawingElementBounds } from "./geometry";
import {
  createDrawingSource,
  serializeDrawingDocument,
  type DrawingDocument,
  type DrawingElement
} from "./model";

const EXPORT_COLOR_PATTERN = /^(?:#[0-9a-f]{3,8}|transparent)$/iu;
const MAX_EXPORT_BYTES = 2_000_000;

export interface DrawingSvgExportOptions {
  background?: string;
  padding?: number;
}

function xml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function number(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function common(element: DrawingElement) {
  return `fill="none" stroke="${xml(element.color)}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${number(element.strokeWidth)}"`;
}

function shape(element: DrawingElement) {
  if (element.type === "pen") {
    if (element.points.length === 1) {
      return `<circle cx="${number(element.points[0].x)}" cy="${number(element.points[0].y)}" r="${number(Math.max(0.5, element.strokeWidth / 2))}" fill="${xml(element.color)}"/>`;
    }
    return `<polyline ${common(element)} points="${element.points.map((point) => `${number(point.x)},${number(point.y)}`).join(" ")}"/>`;
  }
  if (element.type === "line") {
    return `<line ${common(element)} x1="${number(element.start.x)}" y1="${number(element.start.y)}" x2="${number(element.end.x)}" y2="${number(element.end.y)}"/>`;
  }
  if (element.type === "rectangle") {
    return `<rect ${common(element)} x="${number(Math.min(element.start.x, element.end.x))}" y="${number(Math.min(element.start.y, element.end.y))}" width="${number(Math.abs(element.end.x - element.start.x))}" height="${number(Math.abs(element.end.y - element.start.y))}"/>`;
  }
  if (element.type === "ellipse") {
    return `<ellipse ${common(element)} cx="${number((element.start.x + element.end.x) / 2)}" cy="${number((element.start.y + element.end.y) / 2)}" rx="${number(Math.abs(element.end.x - element.start.x) / 2)}" ry="${number(Math.abs(element.end.y - element.start.y) / 2)}"/>`;
  }
  if (element.type === "text") {
    const fontSize = Math.max(12, element.strokeWidth * 8);
    const lines = element.text.split("\n");
    return `<text fill="${xml(element.color)}" font-family="system-ui, sans-serif" font-size="${number(fontSize)}" x="${number(element.point.x)}" y="${number(element.point.y)}">${lines.map((line, index) => `<tspan x="${number(element.point.x)}" dy="${index ? "1.2em" : "0"}">${xml(line)}</tspan>`).join("")}</text>`;
  }
  const angle = Math.atan2(element.end.y - element.start.y, element.end.x - element.start.x);
  const length = 14 + element.strokeWidth * 2;
  const left = {
    x: element.end.x - Math.cos(angle - Math.PI / 6) * length,
    y: element.end.y - Math.sin(angle - Math.PI / 6) * length
  };
  const right = {
    x: element.end.x - Math.cos(angle + Math.PI / 6) * length,
    y: element.end.y - Math.sin(angle + Math.PI / 6) * length
  };
  return `<g><line ${common(element)} x1="${number(element.start.x)}" y1="${number(element.start.y)}" x2="${number(element.end.x)}" y2="${number(element.end.y)}"/><polyline ${common(element)} points="${number(left.x)},${number(left.y)} ${number(element.end.x)},${number(element.end.y)} ${number(right.x)},${number(right.y)}"/></g>`;
}

/** Produces a standalone SVG with no script, foreignObject, image, or URL. */
export function drawingDocumentToSvg(
  document: DrawingDocument,
  options: DrawingSvgExportOptions = {}
) {
  // Reuse the canonical parser as a fail-closed schema and coordinate check.
  serializeDrawingDocument(createDrawingSource(), document);
  const padding = Number.isFinite(options.padding)
    ? Math.max(0, Math.min(256, options.padding!))
    : 24;
  const background = options.background ?? "transparent";
  if (!EXPORT_COLOR_PATTERN.test(background)) throw new Error("Drawing 내보내기 배경색이 올바르지 않습니다.");

  const bounds = document.elements.map(drawingElementBounds);
  const minX = bounds.length ? Math.min(...bounds.map((item) => item.x)) - padding : 0;
  const minY = bounds.length ? Math.min(...bounds.map((item) => item.y)) - padding : 0;
  const maxX = bounds.length ? Math.max(...bounds.map((item) => item.x + item.width)) + padding : 1000;
  const maxY = bounds.length ? Math.max(...bounds.map((item) => item.y + item.height)) + padding : 700;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(minX)} ${number(minY)} ${number(width)} ${number(height)}" role="img"><rect x="${number(minX)}" y="${number(minY)}" width="${number(width)}" height="${number(height)}" fill="${xml(background)}"/>${document.elements.map(shape).join("")}</svg>`;
  if (new TextEncoder().encode(svg).byteLength > MAX_EXPORT_BYTES) {
    throw new Error("Drawing SVG 내보내기 결과가 2,000,000바이트를 초과했습니다.");
  }
  return svg;
}

export function safeDrawingExportFilename(value: string) {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? "-" : character;
  }).join("");
  const safe = withoutControls
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${safe.replace(/[-.\s]/gu, "") ? safe : "Drawing"}.svg`;
}
