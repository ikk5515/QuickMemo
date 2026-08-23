import {
  previewLegacyHtmlToMarkdown,
  type LegacyHtmlConversionWarning
} from "./legacyHtml";

export interface MarkdownHtmlNormalizationPreview {
  markdown: string;
  changedBlockCount: number;
  warnings: LegacyHtmlConversionWarning[];
  lossy: boolean;
  sourcePreserved: true;
}

interface FenceState {
  character: "`" | "~";
  length: number;
}

const convertibleBlockTags = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "UL"
]);
const maximumCandidateLines = 5_000;
const maximumCandidateLength = 500_000;
const maximumNormalizationSourceLength = 1_000_000;
const maximumNormalizationBlockCount = 128;
const maximumNormalizationCandidateCharacters = 500_000;
const maximumNormalizationElementCount = 5_000;

type HtmlTagToken = {
  kind: "open" | "close" | "other";
  name?: string;
  selfClosing?: boolean;
};

interface HtmlScanCursor {
  line: number;
  column: number;
  consumed: number;
  maximumEndLine: number;
  limitReached: boolean;
}

type BlockCandidateScan = {
  candidate: {
    html: string;
    indent: string;
    startLine: number;
    endLine: number;
  } | null;
  /**
   * Lines that belong to an ambiguous/incomplete HTML root. They must be
   * copied verbatim and skipped by the outer scanner so each source character
   * is inspected at most once.
   */
  preserveThroughLine: number;
  limitReached: boolean;
};

/**
 * Builds a copy-only preview for Markdown notes that contain old block HTML.
 *
 * The scanner intentionally ignores inline HTML and every code/YAML context.
 * A candidate must occupy complete lines and parse to exactly one supported
 * root element before it is passed to the legacy converter.  Callers must save
 * the returned body as a new note; this function never mutates its input.
 */
export function previewMarkdownHtmlNormalization(
  sourceMarkdown: string
): MarkdownHtmlNormalizationPreview {
  if (sourceMarkdown.length > maximumNormalizationSourceLength) {
    return normalizationBudgetFallback(
      sourceMarkdown,
      "문서 크기가 안전한 HTML 변환 한도를 넘어 원문을 그대로 유지했습니다."
    );
  }

  const normalizedSource = sourceMarkdown.replace(/\r\n?/g, "\n");
  const lines = normalizedSource.split("\n");
  const yamlEndLine = findYamlEndLine(lines);
  let fence: FenceState | null = null;
  const candidates: Array<NonNullable<BlockCandidateScan["candidate"]>> = [];
  let candidateCharacters = 0;
  let elementCount = 0;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];

    if (index <= yamlEndLine) {
      index += 1;
      continue;
    }

    if (fence) {
      if (isClosingFence(line, fence)) {
        fence = null;
      }
      index += 1;
      continue;
    }

    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      index += 1;
      continue;
    }

    // A tab or four leading spaces is Markdown code, even if its contents look
    // like a complete HTML element.
    if (/^(?:\t| {4})/.test(line)) {
      index += 1;
      continue;
    }

    const scan = readWholeLineBlockCandidate(lines, index);
    if (!scan) {
      index += 1;
      continue;
    }

    if (scan.limitReached) {
      return normalizationBudgetFallback(
        sourceMarkdown,
        "HTML 블록 구조가 안전한 검사 한도를 넘어 원문을 그대로 유지했습니다."
      );
    }

    const candidate = scan.candidate;
    if (!candidate) {
      index = scan.preserveThroughLine + 1;
      continue;
    }

    candidateCharacters += candidate.html.length;
    elementCount += countOpeningHtmlElements(candidate.html);
    candidates.push(candidate);
    if (
      candidates.length > maximumNormalizationBlockCount
      || candidateCharacters > maximumNormalizationCandidateCharacters
      || elementCount > maximumNormalizationElementCount
    ) {
      return normalizationBudgetFallback(
        sourceMarkdown,
        "변환할 HTML 블록의 양이 안전한 처리 한도를 넘어 원문을 그대로 유지했습니다. 블록을 나누어 다시 시도해주세요."
      );
    }
    index = candidate.endLine + 1;
  }

  if (candidates.length === 0) {
    return {
      markdown: sourceMarkdown,
      changedBlockCount: 0,
      warnings: [],
      lossy: false,
      sourcePreserved: true
    };
  }

  // Candidate discovery above is DOM-free and must finish within the total
  // document budget before any conversion begins. This second pass therefore
  // either converts the complete plan or leaves the source byte-identical.
  const output: string[] = [];
  const warnings = new Map<LegacyHtmlConversionWarning["code"], LegacyHtmlConversionWarning>();
  let sourceLine = 0;
  for (const candidate of candidates) {
    output.push(...lines.slice(sourceLine, candidate.startLine));
    const preview = previewLegacyHtmlToMarkdown(candidate.html);
    const replacement = applyIndent(preview.markdown, candidate.indent);
    output.push(...replacement.split("\n"));
    preview.warnings.forEach((warning) => {
      if (!warnings.has(warning.code)) {
        warnings.set(warning.code, warning);
      }
    });
    sourceLine = candidate.endLine + 1;
  }
  output.push(...lines.slice(sourceLine));

  const newline = sourceMarkdown.includes("\r\n") ? "\r\n" : "\n";
  const collectedWarnings = Array.from(warnings.values());
  return {
    markdown: output.join("\n").replace(/\n/g, newline),
    changedBlockCount: candidates.length,
    warnings: collectedWarnings,
    lossy: collectedWarnings.length > 0,
    sourcePreserved: true
  };
}

function normalizationBudgetFallback(
  sourceMarkdown: string,
  message: string
): MarkdownHtmlNormalizationPreview {
  return {
    markdown: sourceMarkdown,
    changedBlockCount: 0,
    warnings: [{ code: "unsupported-formatting", message }],
    lossy: false,
    sourcePreserved: true
  };
}

function countOpeningHtmlElements(html: string) {
  let count = 0;
  for (let index = html.indexOf("<"); index !== -1; index = html.indexOf("<", index + 1)) {
    if (/[a-z]/i.test(html[index + 1] ?? "")) {
      count += 1;
    }
  }
  return count;
}

function findYamlEndLine(lines: string[]) {
  if ((lines[0] ?? "").replace(/^\uFEFF/, "").trim() !== "---") {
    return -1;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const marker = lines[index].trim();
    if (marker === "---" || marker === "...") {
      return index;
    }
  }
  // An unfinished frontmatter block remains YAML rather than becoming a
  // destructive HTML-conversion opportunity.
  return lines.length - 1;
}

function parseOpeningFence(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) {
    return null;
  }
  return {
    character: match[1][0] as FenceState["character"],
    length: match[1].length
  };
}

function isClosingFence(line: string, fence: FenceState) {
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
  return Boolean(
    match
    && match[1][0] === fence.character
    && match[1].length >= fence.length
  );
}

function readWholeLineBlockCandidate(
  lines: string[],
  startLine: number
): BlockCandidateScan | null {
  const opening = lines[startLine].match(/^([ ]{0,3})<([a-z][a-z\d-]*)\b/i);
  if (!opening) {
    return null;
  }

  const indent = opening[1];
  const tag = opening[2].toUpperCase();
  if (tag === "HR") {
    const html = lines[startLine].slice(indent.length).trim();
    return /^<hr\b[^>]*\/?>(?:[ \t]*)$/i.test(html) && isSingleRootElement(html, tag)
      ? {
          candidate: { html, indent, startLine, endLine: startLine },
          preserveThroughLine: startLine,
          limitReached: false
        }
      : null;
  }
  if (!convertibleBlockTags.has(tag)) {
    return null;
  }

  const maximumEndLine = Math.min(
    lines.length - 1,
    startLine + maximumCandidateLines - 1
  );
  const cursor: HtmlScanCursor = {
    line: startLine,
    column: indent.length,
    consumed: indent.length,
    maximumEndLine,
    limitReached: false
  };
  const rootOpening = readHtmlTagToken(lines, cursor);
  if (
    !rootOpening
    || rootOpening.kind !== "open"
    || rootOpening.name !== tag
    || rootOpening.selfClosing
  ) {
    return {
      candidate: null,
      preserveThroughLine: cursor.limitReached ? lines.length - 1 : Math.max(startLine, cursor.line),
      limitReached: candidateScanBudgetExceeded(cursor, lines.length)
    };
  }

  let rootDepth = 1;
  let rawTextTag: string | null = isRawTextElement(rootOpening.name)
    ? rootOpening.name ?? null
    : null;

  while (cursor.line <= maximumEndLine && cursor.consumed <= maximumCandidateLength) {
    const currentLine = lines[cursor.line];
    if (cursor.column >= currentLine.length) {
      if (!advancePastLine(cursor)) {
        break;
      }
      continue;
    }

    const nextTagStart = currentLine.indexOf("<", cursor.column);
    if (nextTagStart < 0) {
      cursor.consumed += currentLine.length - cursor.column;
      cursor.column = currentLine.length;
      continue;
    }
    cursor.consumed += nextTagStart - cursor.column;
    cursor.column = nextTagStart;

    if (rawTextTag && !startsRawTextClosingTag(currentLine, cursor.column, rawTextTag)) {
      readCursorCharacter(lines, cursor);
      continue;
    }
    if (!rawTextTag && !startsHtmlMarkup(currentLine, cursor.column)) {
      readCursorCharacter(lines, cursor);
      continue;
    }

    const token = readHtmlTagToken(lines, cursor);
    if (!token) {
      return {
        candidate: null,
        preserveThroughLine: lines.length - 1,
        limitReached: candidateScanBudgetExceeded(cursor, lines.length)
      };
    }

    if (rawTextTag) {
      if (token.kind === "close" && token.name === rawTextTag) {
        rawTextTag = null;
      }
      continue;
    }

    if (token.kind === "open" && !token.selfClosing) {
      if (token.name === tag) {
        rootDepth += 1;
      }
      if (isRawTextElement(token.name)) {
        rawTextTag = token.name ?? null;
      }
      continue;
    }

    if (token.kind !== "close" || token.name !== tag) {
      continue;
    }

    rootDepth -= 1;
    if (rootDepth !== 0) {
      continue;
    }

    const endLine = cursor.line;
    if (!/^[ \t]*$/.test(lines[endLine].slice(cursor.column))) {
      return { candidate: null, preserveThroughLine: endLine, limitReached: false };
    }
    const candidateLines = lines.slice(startLine, endLine + 1);
    candidateLines[0] = candidateLines[0].slice(indent.length);
    const html = candidateLines.join("\n").trim();
    return {
      candidate: isSingleRootElement(html, tag)
        ? { html, indent, startLine, endLine }
        : null,
      preserveThroughLine: endLine,
      limitReached: false
    };
  }

  // Once a supported root cannot be closed inside the strict line/byte bound,
  // the remainder is ambiguous HTML. Preserve it as-is and do not repeatedly
  // rescan nested opening lines (which was the former O(n * 5000) path).
  return {
    candidate: null,
    preserveThroughLine: lines.length - 1,
    limitReached: candidateScanBudgetExceeded(cursor, lines.length)
  };
}

function candidateScanBudgetExceeded(cursor: HtmlScanCursor, lineCount: number) {
  return cursor.consumed >= maximumCandidateLength
    || (cursor.maximumEndLine < lineCount - 1 && cursor.line >= cursor.maximumEndLine);
}

function startsHtmlMarkup(line: string, column: number) {
  const suffix = line.slice(column);
  return /^<\/?[a-z]/i.test(suffix)
    || suffix.startsWith("<!--")
    || suffix.startsWith("<![CDATA[")
    || /^<![A-Z]/i.test(suffix)
    || suffix.startsWith("<?");
}

function startsRawTextClosingTag(line: string, column: number, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^<\\/${escapedTag}(?:[\\s>])`, "i").test(line.slice(column));
}

function isRawTextElement(tag: string | undefined) {
  return tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "TITLE";
}

function readHtmlTagToken(lines: string[], cursor: HtmlScanCursor): HtmlTagToken | null {
  const initialLine = lines[cursor.line] ?? "";
  const initialSuffix = initialLine.slice(cursor.column);

  if (initialSuffix.startsWith("<!--")) {
    return readDelimitedMarkup(lines, cursor, "-->");
  }
  if (initialSuffix.startsWith("<![CDATA[")) {
    return readDelimitedMarkup(lines, cursor, "]]>");
  }

  const closing = initialSuffix.match(/^<\/([a-z][a-z\d:-]*)\b/i);
  const opening = closing ? null : initialSuffix.match(/^<([a-z][a-z\d:-]*)\b/i);
  const closingNameBoundary = closing?.[0].length ?? -1;
  let tokenOffset = 0;
  let quote: "\"" | "'" | null = null;
  let closingTailIsWhitespace = true;
  let lastNonWhitespaceBeforeClose = "";
  while (true) {
    const character = readCursorCharacter(lines, cursor);
    if (character === null) {
      return null;
    }
    tokenOffset += 1;
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      break;
    }
    if (!/\s/.test(character)) {
      lastNonWhitespaceBeforeClose = character;
      if (closing && tokenOffset > closingNameBoundary) {
        closingTailIsWhitespace = false;
      }
    }
  }

  if (closing && closingTailIsWhitespace) {
    return { kind: "close", name: closing[1].toUpperCase() };
  }
  if (opening) {
    return {
      kind: "open",
      name: opening[1].toUpperCase(),
      selfClosing: lastNonWhitespaceBeforeClose === "/"
    };
  }
  return { kind: "other" };
}

function readDelimitedMarkup(
  lines: string[],
  cursor: HtmlScanCursor,
  delimiter: "-->" | "]]>"
): HtmlTagToken | null {
  let tail = "";
  while (true) {
    const character = readCursorCharacter(lines, cursor);
    if (character === null) {
      return null;
    }
    tail = `${tail}${character}`.slice(-delimiter.length);
    if (tail === delimiter) {
      return { kind: "other" };
    }
  }
}

function readCursorCharacter(lines: string[], cursor: HtmlScanCursor): string | null {
  if (cursor.consumed >= maximumCandidateLength || cursor.line > cursor.maximumEndLine) {
    cursor.limitReached = true;
    return null;
  }
  const line = lines[cursor.line];
  if (cursor.column < line.length) {
    const character = line[cursor.column];
    cursor.column += 1;
    cursor.consumed += 1;
    return character;
  }
  if (!advancePastLine(cursor)) {
    return null;
  }
  return "\n";
}

function advancePastLine(cursor: HtmlScanCursor) {
  if (cursor.line >= cursor.maximumEndLine) {
    cursor.limitReached = true;
    return false;
  }
  cursor.line += 1;
  cursor.column = 0;
  cursor.consumed += 1;
  if (cursor.consumed > maximumCandidateLength) {
    cursor.limitReached = true;
    return false;
  }
  return true;
}

function isSingleRootElement(html: string, expectedTag: string) {
  const escapedTag = expectedTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return expectedTag === "HR"
    ? new RegExp(`^<${escapedTag}\\b[^>]*\\/?>$`, "i").test(html.trim())
    : new RegExp(`^<${escapedTag}\\b[\\s\\S]*<\\/${escapedTag}\\s*>$`, "i").test(html.trim());
}

function applyIndent(markdown: string, indent: string) {
  if (!indent || !markdown) {
    return markdown;
  }
  return markdown
    .split("\n")
    .map((line) => line ? `${indent}${line}` : line)
    .join("\n");
}
