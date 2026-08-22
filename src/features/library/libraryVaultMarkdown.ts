import { safeLibraryExternalUrl } from "../../lib/libraryContent";
import type { LibraryItemContent, LibraryReaderBlock } from "../../types";

const MAX_VAULT_ENTRY_TITLE_CHARACTERS = 180;
const OBSIDIAN_TAG_PATTERN = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Join_Control}_/-]+$/u;
const NUMERIC_TAG_PATTERN = /^\p{N}+$/u;

export interface LibraryVaultMarkdownInput {
  capturedAt?: unknown;
  content: LibraryItemContent;
}

export interface LibraryVaultMarkdownDocument {
  body: string;
  capturedAt: string | null;
  sourceUrl: string | null;
  tags: string[];
  title: string;
}

function boundedUnicode(value: string, maximum: number) {
  return Array.from(value).slice(0, maximum).join("");
}

function yamlString(value: string) {
  return JSON.stringify(value.replaceAll("\u0000", ""));
}

function escapeMarkdownInline(value: string) {
  return value
    .replaceAll("\u0000", "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/gu, "\\$1");
}

function escapedLines(value: string) {
  return value.replace(/\r\n?/gu, "\n").split("\n").map(escapeMarkdownInline);
}

function quoteBlock(value: string) {
  return escapedLines(value).map((line) => `> ${line}`).join("\n");
}

function safeCodeFence(value: string) {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${value.replace(/\r\n?/gu, "\n")}\n${fence}`;
}

function readerBlockMarkdown(block: LibraryReaderBlock) {
  const text = block.text.trim();
  if (!text) return "";
  switch (block.kind) {
    case "heading":
      return `### ${escapeMarkdownInline(text)}`;
    case "quote":
      return quoteBlock(text);
    case "list-item":
      return escapedLines(text).map((line) => `- ${line}`).join("\n");
    case "code":
      return safeCodeFence(text);
    default:
      return escapedLines(text).join("\n");
  }
}

function validIsoTimestamp(value: unknown): string | null {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string") {
    date = new Date(value);
  } else if (value && typeof value === "object") {
    const timestamp = value as {
      nanoseconds?: unknown;
      seconds?: unknown;
      toDate?: unknown;
      toMillis?: unknown;
    };
    if (typeof timestamp.toDate === "function") {
      date = (timestamp.toDate as () => Date)();
    } else if (typeof timestamp.toMillis === "function") {
      date = new Date((timestamp.toMillis as () => number)());
    } else if (typeof timestamp.seconds === "number") {
      const nanos = typeof timestamp.nanoseconds === "number" ? timestamp.nanoseconds : 0;
      date = new Date(timestamp.seconds * 1_000 + nanos / 1_000_000);
    }
  }
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeLibraryVaultTags(values: readonly string[]) {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = value.trim().replace(/^#+/u, "").normalize("NFC");
    const identity = tag.toLocaleLowerCase("ko-KR");
    if (
      !tag
      || tag.length > 80
      || tag.split("/").some((segment) => !segment)
      || NUMERIC_TAG_PATTERN.test(tag)
      || !OBSIDIAN_TAG_PATTERN.test(tag)
      || seen.has(identity)
    ) {
      continue;
    }
    seen.add(identity);
    tags.push(tag);
    if (tags.length >= 100) break;
  }
  return tags;
}

export function libraryVaultNoteTitle(content: LibraryItemContent) {
  const source = content.title || content.sourceFileName || content.siteName || "자료실 메모";
  const withoutControlCharacters = Array.from(source.normalize("NFC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  const normalized = withoutControlCharacters
    .replace(/[\\/]/gu, " - ")
    .replace(/\s+/gu, " ")
    .trim();
  return boundedUnicode(normalized || "자료실 메모", MAX_VAULT_ENTRY_TITLE_CHARACTERS);
}

export function libraryItemToVaultMarkdown(
  input: LibraryVaultMarkdownInput
): LibraryVaultMarkdownDocument {
  const content = input.content;
  const title = libraryVaultNoteTitle(content);
  const sourceUrl = safeLibraryExternalUrl(content.url);
  const capturedAt = validIsoTimestamp(input.capturedAt);
  const tags = normalizeLibraryVaultTags(content.tags);
  const properties = [
    "---",
    "type: library-clip",
    `title: ${yamlString(title)}`,
    ...(sourceUrl ? [`source: ${yamlString(sourceUrl)}`] : []),
    ...(capturedAt ? [`captured_at: ${yamlString(capturedAt)}`] : []),
    ...(content.siteName ? [`site: ${yamlString(content.siteName)}`] : []),
    ...(content.collection ? [`collection: ${yamlString(content.collection)}`] : []),
    ...(tags.length ? ["tags:", ...tags.map((tag) => `  - ${yamlString(tag)}`)] : []),
    "---"
  ];
  const metadata = [
    "> [!info] 자료실에서 가져옴",
    ...(sourceUrl ? [`> 출처: [${escapeMarkdownInline(content.siteName || "원문 열기")}](<${sourceUrl.replaceAll(">", "%3E")}>)`] : []),
    `> 캡처 시각: ${capturedAt ?? "기록 없음"}`
  ];
  const sections: string[] = [properties.join("\n"), `# ${escapeMarkdownInline(title)}`, metadata.join("\n")];

  if (content.description) {
    sections.push(`## 요약\n\n${escapedLines(content.description).join("\n")}`);
  }
  if (content.selectionText) {
    sections.push(`## 선택한 내용\n\n${quoteBlock(content.selectionText)}`);
  }
  const readerBody = content.readerBlocks.map(readerBlockMarkdown).filter(Boolean).join("\n\n");
  if (readerBody) {
    sections.push(`## 본문\n\n${readerBody}`);
  }
  if (content.ocrText) {
    sections.push(`## 추출한 텍스트\n\n${escapedLines(content.ocrText).join("\n")}`);
  }
  if (content.highlights.length) {
    const highlights = content.highlights.map((highlight) => {
      const lines = [quoteBlock(highlight.quote)];
      if (highlight.note) lines.push(escapedLines(highlight.note).join("\n"));
      return lines.join("\n\n");
    });
    sections.push(`## 하이라이트\n\n${highlights.join("\n\n---\n\n")}`);
  }

  return {
    body: `${sections.join("\n\n")}\n`,
    capturedAt,
    sourceUrl,
    tags,
    title
  };
}
