import type { FrontmatterScalar, FrontmatterValue } from "../knowledge";

const FRONTMATTER_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export class UnsupportedFrontmatterPropertyError extends Error {
  constructor(message = "지원하지 않는 YAML 속성 구조입니다.") {
    super(message);
    this.name = "UnsupportedFrontmatterPropertyError";
  }
}

function lineEndingFor(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function serializeScalar(value: FrontmatterScalar): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return String(value);
}

export function serializeFrontmatterValue(value: FrontmatterValue): string {
  return Array.isArray(value)
    ? `[${value.map(serializeScalar).join(", ")}]`
    : serializeScalar(value);
}

function assertPropertyKey(key: string): void {
  if (!FRONTMATTER_KEY_PATTERN.test(key)) {
    throw new Error("속성 이름에는 영문, 숫자, _, -만 사용할 수 있습니다.");
  }
}

interface FrontmatterRange {
  closingLine: number;
  lines: string[];
  newline: "\n" | "\r\n";
}

function frontmatterRange(source: string): FrontmatterRange | null {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return null;
  }
  const newline = lineEndingFor(source);
  const lines = source.split(/\r?\n/u);
  const closingLine = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingLine < 0) {
    throw new UnsupportedFrontmatterPropertyError("닫히지 않은 YAML frontmatter는 편집할 수 없습니다.");
  }
  return { closingLine, lines, newline };
}

function propertyLineRange(
  lines: readonly string[],
  closingLine: number,
  key: string
): { start: number; end: number } | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const propertyPattern = new RegExp(`^${escapedKey}\\s*:\\s*(.*)$`, "u");
  for (let index = 1; index < closingLine; index += 1) {
    const match = propertyPattern.exec(lines[index]);
    if (!match) {
      continue;
    }
    if (match[1].trim()) {
      return { start: index, end: index + 1 };
    }

    let end = index + 1;
    while (end < closingLine && /^\s+-\s+.+$/u.test(lines[end])) {
      end += 1;
    }
    if (end === index + 1 && end < closingLine && /^\s+/u.test(lines[end])) {
      throw new UnsupportedFrontmatterPropertyError();
    }
    let probe = end;
    while (probe < closingLine && lines[probe].trim() === "") {
      probe += 1;
    }
    if (probe < closingLine && /^\s+/u.test(lines[probe])) {
      throw new UnsupportedFrontmatterPropertyError();
    }
    return { start: index, end };
  }
  return null;
}

/**
 * Updates one supported top-level property while preserving unrelated YAML,
 * comments and the Markdown body byte-for-byte apart from line joining.
 */
export function setFrontmatterProperty(
  source: string,
  rawKey: string,
  value: FrontmatterValue
): string {
  const key = rawKey.trim();
  assertPropertyKey(key);
  const serialized = `${key}: ${serializeFrontmatterValue(value)}`;
  const range = frontmatterRange(source);
  if (!range) {
    const newline = lineEndingFor(source);
    return `---${newline}${serialized}${newline}---${newline}${newline}${source}`;
  }

  const existing = propertyLineRange(range.lines, range.closingLine, key);
  if (existing) {
    range.lines.splice(existing.start, existing.end - existing.start, serialized);
  } else {
    range.lines.splice(range.closingLine, 0, serialized);
  }
  return range.lines.join(range.newline);
}

export function removeFrontmatterProperty(source: string, rawKey: string): string {
  const key = rawKey.trim();
  assertPropertyKey(key);
  const range = frontmatterRange(source);
  if (!range) {
    return source;
  }
  const existing = propertyLineRange(range.lines, range.closingLine, key);
  if (!existing) {
    return source;
  }
  range.lines.splice(existing.start, existing.end - existing.start);
  return range.lines.join(range.newline);
}

export function propertyEditorValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return value.map((item) => item === null ? "null" : String(item)).join(", ");
  }
  return value === null ? "null" : String(value);
}

export function parsePropertyEditorValue(
  rawValue: string,
  previousValue: FrontmatterValue | undefined
): FrontmatterValue {
  const value = rawValue.trim();
  if (Array.isArray(previousValue)) {
    return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
  }
  if (typeof previousValue === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (typeof previousValue === "number" && value !== "") {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return numericValue;
  }
  if (previousValue === null && value.toLocaleLowerCase() === "null") {
    return null;
  }
  return rawValue;
}
