import type {
  MarkdownBlock,
  MarkdownDocument,
  MarkdownFootnote,
  MarkdownFootnoteReferenceToken,
  MarkdownInlineToken,
  MarkdownLinkToken,
  MarkdownTableBlock,
  MarkdownWikiLinkToken
} from "./types";

const tagCodePointPattern = /^[\p{L}\p{M}\p{N}\p{Emoji}_/-]$/u;
const tagValuePattern = /^[\p{L}\p{M}\p{N}\p{Emoji}_/-]+$/u;
const numericTagPattern = /^\p{N}+$/u;
const protocolPattern = /^[a-z][a-z\d+.-]*:/i;
const listPattern = /^(\s{0,3})(?:(\d+)[.)]|([-+*]))\s+(.*)$/;
const headingPattern = /^\s{0,3}(#{1,6})(?:\s+|$)(.*)$/;
const fencePattern = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const quotePattern = /^\s{0,3}>\s?(.*)$/;
const calloutPattern = /^\[!([^\]\s]+)\]([+-])?(?:\s+(.*))?$/;
const footnoteDefinitionPattern = /^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$/;
const thematicBreakPattern = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const tableDelimiterCellPattern = /^:?-{3,}:?$/;
const mathFencePattern = /^\s{0,3}\$\$(.*)$/;
const maximumMarkdownBlockNestingDepth = 64;
const maximumMarkdownInlineNestingDepth = 32;
const markdownInlineProbeMultiplier = 12;

interface MarkdownInlineParseContext {
  remainingProbeCharacters: number;
}

export function normalizeMarkdownLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Removes Obsidian `%% ... %%` comments while preserving code and line positions.
 * Fenced code, inline code spans, and YAML frontmatter are intentionally left alone.
 */
export function stripObsidianComments(source: string, preserveFrontmatter = true) {
  const lines = normalizeMarkdownLineEndings(source).split("\n");
  let commentOpen = false;
  let fenceMarker: "`" | "~" | null = null;
  let fenceLength = 0;
  let frontmatterOpen = preserveFrontmatter && lines[0] === "---";

  return lines.map((line, lineIndex) => {
    if (frontmatterOpen) {
      if (lineIndex > 0 && (line === "---" || line === "...")) {
        frontmatterOpen = false;
      }
      return line;
    }

    if (fenceMarker) {
      const closing = line.match(/^\s{0,3}(`+|~+)\s*$/);
      if (
        closing
        && closing[1][0] === fenceMarker
        && closing[1].length >= fenceLength
      ) {
        fenceMarker = null;
        fenceLength = 0;
      }
      return line;
    }

    if (!commentOpen) {
      const openingFence = line.match(fencePattern);
      if (openingFence) {
        fenceMarker = openingFence[1][0] as "`" | "~";
        fenceLength = openingFence[1].length;
        return line;
      }
    }

    let result = "";
    let index = 0;
    while (index < line.length) {
      if (commentOpen) {
        const commentEnd = line.indexOf("%%", index);
        if (commentEnd === -1) {
          return result;
        }
        commentOpen = false;
        index = commentEnd + 2;
        continue;
      }

      if (line.startsWith("%%", index)) {
        commentOpen = true;
        index += 2;
        continue;
      }

      if (line[index] === "`") {
        let markerLength = 1;
        while (line[index + markerLength] === "`") {
          markerLength += 1;
        }
        const marker = "`".repeat(markerLength);
        const closing = line.indexOf(marker, index + markerLength);
        if (closing !== -1) {
          result += line.slice(index, closing + markerLength);
          index = closing + markerLength;
          continue;
        }
        result += line.slice(index, index + markerLength);
        index += markerLength;
        continue;
      }

      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

export function isSafeExternalHttpUrl(href: string) {
  const trimmed = href.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidObsidianTag(tag: string) {
  const value = tag.startsWith("#") ? tag.slice(1) : tag;
  const valueWithoutEmojiJoiners = value.replace(/\u200d/g, "").replace(/\ufe0f/g, "");
  return Boolean(value)
    && Boolean(valueWithoutEmojiJoiners)
    && tagValuePattern.test(valueWithoutEmojiJoiners)
    && !numericTagPattern.test(value)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("//");
}

export interface ParsedWikiLinkTarget {
  target: string;
  path: string;
  subpath: string | null;
  display: string;
}

export function parseWikiLinkTarget(value: string): ParsedWikiLinkTarget | null {
  const separator = findUnescaped(value, "|");
  const target = (separator === -1 ? value : value.slice(0, separator)).trim();
  const alias = separator === -1 ? "" : unescapeMarkdown(value.slice(separator + 1).trim());

  if (!target) {
    return null;
  }

  const hashIndex = findUnescaped(target, "#");
  const path = unescapeMarkdown(hashIndex === -1 ? target : target.slice(0, hashIndex)).trim();
  const subpath = hashIndex === -1
    ? null
    : `#${unescapeMarkdown(target.slice(hashIndex + 1)).trim()}`;
  const fileName = path.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "") ?? "";
  const subpathLabel = subpath?.slice(1).replace(/^\^/, "") ?? "";
  const defaultDisplay = path
    ? `${fileName || path}${subpathLabel ? ` › ${subpathLabel}` : ""}`
    : subpathLabel;

  return {
    target: unescapeMarkdown(target),
    path,
    subpath,
    display: alias || defaultDisplay || unescapeMarkdown(target)
  };
}

export function parseMarkdownInline(value: string): MarkdownInlineToken[] {
  const source = stripObsidianComments(value, false);
  return parseMarkdownInlineValue(source, {
    remainingProbeCharacters: Math.max(1_024, source.length * markdownInlineProbeMultiplier)
  }, 0);
}

function parseMarkdownInlineValue(
  value: string,
  context: MarkdownInlineParseContext,
  depth: number
): MarkdownInlineToken[] {
  if (depth >= maximumMarkdownInlineNestingDepth) {
    return value ? [{ type: "text", value }] : [];
  }
  const tokens: MarkdownInlineToken[] = [];
  let text = "";
  let index = 0;

  const pushText = () => {
    if (!text) {
      return;
    }
    tokens.push({ type: "text", value: text });
    text = "";
  };

  while (index < value.length) {
    if (context.remainingProbeCharacters <= 0) {
      text += value.slice(index);
      break;
    }
    if (value[index] === "\\" && index + 1 < value.length) {
      text += value[index + 1];
      index += 2;
      continue;
    }

    const code = parseCodeSpan(value, index, context);
    if (code) {
      pushText();
      tokens.push({ type: "code", value: code.value });
      index = code.end;
      continue;
    }

    const footnote = parseFootnoteReference(value, index, context, depth);
    if (footnote) {
      pushText();
      tokens.push(footnote.token);
      index = footnote.end;
      continue;
    }

    const math = parseInlineMath(value, index, context);
    if (math) {
      pushText();
      tokens.push({ type: "math", value: math.value });
      index = math.end;
      continue;
    }

    const wiki = parseWikiLink(value, index, context);
    if (wiki) {
      pushText();
      tokens.push(wiki.token);
      index = wiki.end;
      continue;
    }

    const markdownLink = parseMarkdownLink(value, index, context, depth);
    if (markdownLink) {
      pushText();
      tokens.push(markdownLink.token);
      index = markdownLink.end;
      continue;
    }

    const decorated = parseDecoratedSpan(value, index, context, depth);
    if (decorated) {
      pushText();
      tokens.push(decorated.token);
      index = decorated.end;
      continue;
    }

    const tag = parseTag(value, index);
    if (tag) {
      pushText();
      tokens.push({
        type: "tag",
        raw: tag.raw,
        tag: tag.raw.slice(1),
        normalizedTag: tag.raw.slice(1).normalize("NFC").toLocaleLowerCase()
      });
      index = tag.end;
      continue;
    }

    text += value[index];
    index += 1;
  }

  pushText();
  return mergeAdjacentText(tokens);
}

export function tokenizeMarkdown(source: string): MarkdownDocument {
  return tokenizeMarkdownAtDepth(source, 0);
}

function shallowMarkdownDocument(source: string): MarkdownDocument {
  const value = normalizeMarkdownLineEndings(source);
  return {
    blocks: value ? [{ type: "paragraph", children: parseMarkdownInline(value) }] : [],
    footnotes: []
  };
}

function tokenizeMarkdownAtDepth(source: string, depth: number): MarkdownDocument {
  const lines = stripObsidianComments(source).split("\n");
  const blocks: MarkdownBlock[] = [];
  const footnoteDefinitions = new Map<string, { label: string; blocks: MarkdownBlock[] }>();
  let index = 0;

  if (lines[0] === "---") {
    const end = lines.slice(1).findIndex((line) => line === "---" || line === "...");
    if (end !== -1) {
      blocks.push({ type: "frontmatter", value: lines.slice(1, end + 1).join("\n") });
      index = end + 2;
    }
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(fencePattern);
    if (fence) {
      const marker = fence[1][0];
      const minimumLength = fence[1].length;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closing = lines[index].match(/^\s{0,3}(`+|~+)\s*$/);
        if (closing && closing[1][0] === marker && closing[1].length >= minimumLength) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({
        type: "code-block",
        language: fence[2].trim().split(/\s+/)[0] ?? "",
        value: body.join("\n")
      });
      continue;
    }

    const math = parseMathBlock(lines, index);
    if (math) {
      blocks.push(math.block);
      index = math.end;
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseMarkdownInline(heading[2].replace(/\s+#+\s*$/, ""))
      });
      index += 1;
      continue;
    }

    if (thematicBreakPattern.test(line)) {
      blocks.push({ type: "thematic-break" });
      index += 1;
      continue;
    }

    if (quotePattern.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(quotePattern);
        if (!match) {
          break;
        }
        quoted.push(match[1]);
        index += 1;
      }
      const callout = quoted[0]?.match(calloutPattern);
      if (callout) {
        const calloutType = normalizeCalloutType(callout[1]);
        const nestedSource = quoted.slice(1).join("\n");
        const body = depth >= maximumMarkdownBlockNestingDepth
          ? shallowMarkdownDocument(nestedSource)
          : tokenizeMarkdownAtDepth(nestedSource, depth + 1);
        mergeNestedFootnotes(footnoteDefinitions, body.footnotes);
        blocks.push({
          type: "callout",
          calloutType,
          title: parseMarkdownInline(callout[3]?.trim() || defaultCalloutTitle(calloutType)),
          foldable: Boolean(callout[2]),
          open: callout[2] !== "-",
          blocks: body.blocks
        });
      } else {
        const nestedSource = quoted.join("\n");
        const body = depth >= maximumMarkdownBlockNestingDepth
          ? shallowMarkdownDocument(nestedSource)
          : tokenizeMarkdownAtDepth(nestedSource, depth + 1);
        mergeNestedFootnotes(footnoteDefinitions, body.footnotes);
        blocks.push({ type: "quote", blocks: body.blocks });
      }
      continue;
    }

    const footnoteDefinition = parseFootnoteDefinition(lines, index);
    if (footnoteDefinition) {
      const normalizedLabel = normalizeFootnoteLabel(footnoteDefinition.label);
      if (!footnoteDefinitions.has(normalizedLabel)) {
        const definitionDocument = depth >= maximumMarkdownBlockNestingDepth
          ? shallowMarkdownDocument(footnoteDefinition.value)
          : tokenizeMarkdownAtDepth(footnoteDefinition.value, depth + 1);
        mergeNestedFootnotes(footnoteDefinitions, definitionDocument.footnotes);
        footnoteDefinitions.set(normalizedLabel, {
          label: footnoteDefinition.label,
          blocks: definitionDocument.blocks
        });
      }
      index = footnoteDefinition.end;
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.end;
      continue;
    }

    const list = parseList(lines, index);
    if (list) {
      blocks.push(list.block);
      index = list.end;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !isBlockStarter(lines, index)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join("\n")) });
  }

  return {
    blocks,
    footnotes: resolveFootnotes(blocks, footnoteDefinitions)
  };
}

function parseCodeSpan(value: string, index: number, context: MarkdownInlineParseContext) {
  if (value[index] !== "`") {
    return null;
  }

  let markerLength = 1;
  while (value[index + markerLength] === "`") {
    if (!consumeInlineProbe(context)) {
      return null;
    }
    markerLength += 1;
  }
  const marker = "`".repeat(markerLength);
  const closing = findSequenceWithBudget(value, marker, index + markerLength, context);
  if (closing === -1) {
    return null;
  }

  let content = value.slice(index + markerLength, closing).replace(/\n/g, " ");
  if (/^\s.*\s$/.test(content) && content.trim()) {
    content = content.slice(1, -1);
  }
  return { value: content, end: closing + markerLength };
}

function parseFootnoteReference(
  value: string,
  index: number,
  context: MarkdownInlineParseContext,
  depth: number
) {
  const inline = value.startsWith("^[", index);
  const reference = value.startsWith("[^", index);
  if (!inline && !reference) {
    return null;
  }

  const contentStart = index + 2;
  const closing = findUnescapedWithBudget(value, "]", contentStart, context);
  if (closing === -1) {
    return null;
  }
  const contentEnd = closing;
  const content = value.slice(contentStart, contentEnd).trim();
  if (!content || (!inline && /\s/u.test(content))) {
    return null;
  }

  const token: MarkdownFootnoteReferenceToken = {
    type: "footnote-reference",
    raw: value.slice(index, contentEnd + 1),
    label: inline ? "" : content,
    inline: inline ? parseMarkdownInlineValue(content, context, depth + 1) : null,
    number: null,
    referenceIndex: null
  };
  return { token, end: contentEnd + 1 };
}

function parseInlineMath(value: string, index: number, context: MarkdownInlineParseContext) {
  if (
    value[index] !== "$"
    || value[index + 1] === "$"
    || !value[index + 1]
    || /\s/u.test(value[index + 1])
  ) {
    return null;
  }

  for (let end = index + 1; end < value.length; end += 1) {
    if (!consumeInlineProbe(context)) {
      return null;
    }
    if (value[end] === "\\") {
      end += 1;
      continue;
    }
    if (value[end] === "\n") {
      return null;
    }
    if (value[end] === "$" && !/\s/u.test(value[end - 1])) {
      const content = value.slice(index + 1, end);
      return content ? { value: content, end: end + 1 } : null;
    }
  }
  return null;
}

function parseMathBlock(lines: string[], index: number) {
  const opening = lines[index].match(mathFencePattern);
  if (!opening) {
    return null;
  }

  const afterOpening = opening[1];
  if (afterOpening.trim().endsWith("$$")) {
    return {
      block: {
        type: "math-block" as const,
        value: afterOpening.trim().slice(0, -2).trim()
      },
      end: index + 1
    };
  }

  const body: string[] = afterOpening ? [afterOpening] : [];
  let end = index + 1;
  while (end < lines.length) {
    const closing = lines[end].match(/^(.*)\$\$\s*$/);
    if (closing) {
      if (closing[1]) {
        body.push(closing[1]);
      }
      return {
        block: { type: "math-block" as const, value: body.join("\n").trim() },
        end: end + 1
      };
    }
    body.push(lines[end]);
    end += 1;
  }

  return null;
}

function parseWikiLink(value: string, index: number, context: MarkdownInlineParseContext) {
  const embed = value.startsWith("![[", index);
  if (!embed && !value.startsWith("[[", index)) {
    return null;
  }

  const contentStart = index + (embed ? 3 : 2);
  const closing = findSequenceWithBudget(value, "]]", contentStart, context);
  if (closing === -1) {
    return null;
  }

  const parsed = parseWikiLinkTarget(value.slice(contentStart, closing));
  if (!parsed) {
    return null;
  }

  const raw = value.slice(index, closing + 2);
  const token: MarkdownWikiLinkToken = {
    type: "wikilink",
    raw,
    target: parsed.target,
    path: parsed.path,
    subpath: parsed.subpath,
    display: parsed.display,
    embed
  };
  return { token, end: closing + 2 };
}

function parseMarkdownLink(
  value: string,
  index: number,
  context: MarkdownInlineParseContext,
  depth: number
) {
  const image = value.startsWith("![", index);
  const openingLength = image ? 2 : 1;
  if (value[index] !== "[" && !image) {
    return null;
  }

  const labelStart = index + openingLength;
  const labelEnd = findSequenceWithBudget(value, "](", labelStart, context);
  if (labelEnd === -1) {
    return null;
  }
  const hrefEnd = findClosingParenthesis(value, labelEnd + 2, context);
  if (hrefEnd === -1) {
    return null;
  }

  const rawHref = value.slice(labelEnd + 2, hrefEnd).trim();
  const href = unwrapMarkdownHref(rawHref);
  if (!href) {
    return null;
  }
  const external = protocolPattern.test(href) || href.startsWith("//");
  const safe = external
    ? isSafeExternalHttpUrl(href)
    : !href.startsWith("//") && !href.includes("\u0000");
  const token: MarkdownLinkToken = {
    type: "link",
    raw: value.slice(index, hrefEnd + 1),
    href,
    external,
    safe,
    embed: image,
    children: parseMarkdownInlineValue(value.slice(labelStart, labelEnd), context, depth + 1)
  };

  if (image) {
    token.children = [{ type: "text", value: value.slice(labelStart, labelEnd) || href }];
  }
  return { token, end: hrefEnd + 1 };
}

function parseDecoratedSpan(
  value: string,
  index: number,
  context: MarkdownInlineParseContext,
  depth: number
) {
  const candidates: Array<{ marker: string; type: "strong" | "emphasis" | "delete" }> = [
    { marker: "**", type: "strong" },
    { marker: "__", type: "strong" },
    { marker: "~~", type: "delete" },
    { marker: "*", type: "emphasis" },
    { marker: "_", type: "emphasis" }
  ];

  for (const candidate of candidates) {
    if (!value.startsWith(candidate.marker, index)) {
      continue;
    }
    const contentStart = index + candidate.marker.length;
    const closing = findSequenceWithBudget(value, candidate.marker, contentStart, context);
    if (closing <= contentStart) {
      continue;
    }
    return {
      token: {
        type: candidate.type,
        children: parseMarkdownInlineValue(value.slice(contentStart, closing), context, depth + 1)
      } as MarkdownInlineToken,
      end: closing + candidate.marker.length
    };
  }
  return null;
}

function parseTag(value: string, index: number) {
  if (value[index] !== "#" || !isTagBoundary(value[index - 1])) {
    return null;
  }

  let end = index + 1;
  while (end < value.length) {
    const codePoint = String.fromCodePoint(value.codePointAt(end) ?? 0);
    if (codePoint !== "\u200d" && codePoint !== "\ufe0f" && !tagCodePointPattern.test(codePoint)) {
      break;
    }
    end += codePoint.length;
  }
  const raw = value.slice(index, end);
  return isValidObsidianTag(raw) ? { raw, end } : null;
}

function isTagBoundary(previous: string | undefined) {
  return previous === undefined || /[\s([{>"'.,;:!?]/u.test(previous);
}

function parseTable(lines: string[], index: number): { block: MarkdownTableBlock; end: number } | null {
  if (index + 1 >= lines.length || !lines[index].includes("|")) {
    return null;
  }
  const header = splitTableRow(lines[index]);
  const delimiters = splitTableRow(lines[index + 1]).map((cell) => cell.trim());
  if (
    header.length < 2
    || delimiters.length !== header.length
    || delimiters.some((cell) => !tableDelimiterCellPattern.test(cell))
  ) {
    return null;
  }

  const alignments = delimiters.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) {
      return "center" as const;
    }
    if (cell.endsWith(":")) {
      return "right" as const;
    }
    if (cell.startsWith(":")) {
      return "left" as const;
    }
    return null;
  });
  const rows: MarkdownTableBlock["rows"] = [];
  let end = index + 2;
  while (end < lines.length && lines[end].trim() && lines[end].includes("|")) {
    const row = splitTableRow(lines[end]);
    while (row.length < header.length) {
      row.push("");
    }
    rows.push(row.slice(0, header.length).map((cell) => ({ children: parseMarkdownInline(cell.trim()) })));
    end += 1;
  }

  return {
    block: {
      type: "table",
      alignments,
      header: header.map((cell) => ({ children: parseMarkdownInline(cell.trim()) })),
      rows
    },
    end
  };
}

function parseList(lines: string[], index: number) {
  const first = lines[index].match(listPattern);
  if (!first) {
    return null;
  }
  const ordered = Boolean(first[2]);
  const items: Array<{ checked: boolean | null; children: MarkdownInlineToken[] }> = [];
  let end = index;

  while (end < lines.length) {
    const match = lines[end].match(listPattern);
    if (!match || Boolean(match[2]) !== ordered) {
      break;
    }
    let content = match[4];
    const task = content.match(/^\[([ xX])\]\s*(.*)$/);
    let checked: boolean | null = null;
    if (task) {
      checked = task[1].toLocaleLowerCase() === "x";
      content = task[2];
    }
    end += 1;

    const continuation: string[] = [content];
    while (
      end < lines.length
      && /^\s{2,}\S/.test(lines[end])
      && !listPattern.test(lines[end])
    ) {
      continuation.push(lines[end].trimStart());
      end += 1;
    }
    items.push({ checked, children: parseMarkdownInline(continuation.join("\n")) });
  }

  return {
    block: {
      type: "list" as const,
      ordered,
      start: ordered ? Number(first[2]) : 1,
      items
    },
    end
  };
}

function parseFootnoteDefinition(lines: string[], index: number) {
  const first = lines[index].match(footnoteDefinitionPattern);
  if (!first) {
    return null;
  }

  const body = [first[2]];
  let end = index + 1;
  while (end < lines.length) {
    const continuation = lines[end].match(/^(?: {4}|\t)(.*)$/);
    if (continuation) {
      body.push(continuation[1]);
      end += 1;
      continue;
    }
    if (!lines[end].trim() && /^(?: {4}|\t)/.test(lines[end + 1] ?? "")) {
      body.push("");
      end += 1;
      continue;
    }
    break;
  }

  return {
    label: first[1],
    value: body.join("\n"),
    end
  };
}

function normalizeFootnoteLabel(label: string) {
  return label.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function mergeNestedFootnotes(
  definitions: Map<string, { label: string; blocks: MarkdownBlock[] }>,
  footnotes: MarkdownFootnote[]
) {
  for (const footnote of footnotes) {
    const normalizedLabel = normalizeFootnoteLabel(footnote.label);
    if (!normalizedLabel.startsWith("__inline-") && !definitions.has(normalizedLabel)) {
      definitions.set(normalizedLabel, { label: footnote.label, blocks: footnote.blocks });
    }
  }
}

function normalizeCalloutType(type: string) {
  return type
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "note";
}

function defaultCalloutTitle(type: string) {
  return `${type.charAt(0).toLocaleUpperCase()}${type.slice(1)}`;
}

function resolveFootnotes(
  blocks: MarkdownBlock[],
  definitions: Map<string, { label: string; blocks: MarkdownBlock[] }>
): MarkdownFootnote[] {
  const footnotes: MarkdownFootnote[] = [];
  const byLabel = new Map<string, MarkdownFootnote>();
  let inlineCount = 0;

  const visitInline = (tokens: MarkdownInlineToken[]) => {
    for (const token of tokens) {
      if (token.type === "footnote-reference") {
        let normalizedLabel: string;
        let definition: { label: string; blocks: MarkdownBlock[] } | undefined;
        if (token.inline) {
          inlineCount += 1;
          normalizedLabel = `__inline-${inlineCount}`;
          definition = {
            label: normalizedLabel,
            blocks: [{ type: "paragraph", children: token.inline }]
          };
        } else {
          normalizedLabel = normalizeFootnoteLabel(token.label);
          definition = definitions.get(normalizedLabel);
        }

        if (!definition) {
          token.number = null;
          token.referenceIndex = null;
          continue;
        }

        let footnote = byLabel.get(normalizedLabel);
        if (!footnote) {
          footnote = {
            label: definition.label,
            number: footnotes.length + 1,
            blocks: definition.blocks,
            referenceCount: 0
          };
          byLabel.set(normalizedLabel, footnote);
          footnotes.push(footnote);
        }
        footnote.referenceCount += 1;
        token.number = footnote.number;
        token.referenceIndex = footnote.referenceCount;
        continue;
      }

      if (
        token.type === "strong"
        || token.type === "emphasis"
        || token.type === "delete"
        || token.type === "link"
      ) {
        visitInline(token.children);
      }
    }
  };

  const visitBlocks = (items: MarkdownBlock[]) => {
    for (const block of items) {
      switch (block.type) {
        case "heading":
        case "paragraph":
          visitInline(block.children);
          break;
        case "list":
          block.items.forEach((item) => visitInline(item.children));
          break;
        case "quote":
          visitBlocks(block.blocks);
          break;
        case "callout":
          visitInline(block.title);
          visitBlocks(block.blocks);
          break;
        case "table":
          block.header.forEach((cell) => visitInline(cell.children));
          block.rows.forEach((row) => row.forEach((cell) => visitInline(cell.children)));
          break;
        case "code-block":
        case "math-block":
        case "thematic-break":
        case "frontmatter":
          break;
      }
    }
  };

  visitBlocks(blocks);
  for (let index = 0; index < footnotes.length; index += 1) {
    visitBlocks(footnotes[index].blocks);
  }
  return footnotes;
}

function isBlockStarter(lines: string[], index: number) {
  const line = lines[index];
  return fencePattern.test(line)
    || mathFencePattern.test(line)
    || headingPattern.test(line)
    || quotePattern.test(line)
    || footnoteDefinitionPattern.test(line)
    || thematicBreakPattern.test(line)
    || listPattern.test(line)
    || Boolean(parseTable(lines, index));
}

function splitTableRow(value: string) {
  let row = value.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "\\" && row[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (row[index] === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += row[index];
    }
  }
  cells.push(cell);
  return cells;
}

function findClosingParenthesis(
  value: string,
  start: number,
  context: MarkdownInlineParseContext
) {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (!consumeInlineProbe(context)) {
      return -1;
    }
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === "(") {
      depth += 1;
    } else if (value[index] === ")") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

function consumeInlineProbe(context: MarkdownInlineParseContext, amount = 1) {
  if (context.remainingProbeCharacters < amount) {
    context.remainingProbeCharacters = 0;
    return false;
  }
  context.remainingProbeCharacters -= amount;
  return true;
}

function findSequenceWithBudget(
  value: string,
  sequence: string,
  start: number,
  context: MarkdownInlineParseContext
) {
  const lastStart = value.length - sequence.length;
  for (let index = start; index <= lastStart; index += 1) {
    if (!consumeInlineProbe(context, Math.max(1, sequence.length))) {
      return -1;
    }
    if (value.startsWith(sequence, index)) {
      return index;
    }
  }
  return -1;
}

function findUnescapedWithBudget(
  value: string,
  character: string,
  start: number,
  context: MarkdownInlineParseContext
) {
  for (let index = start; index < value.length; index += 1) {
    if (!consumeInlineProbe(context)) {
      return -1;
    }
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === character) {
      return index;
    }
  }
  return -1;
}

function unwrapMarkdownHref(value: string) {
  const withoutTitle = value.match(/^(?:<([^>]+)>|(\S+?))(?:\s+["'(].*)?$/);
  return unescapeMarkdown((withoutTitle?.[1] ?? withoutTitle?.[2] ?? "").trim());
}

function findUnescaped(value: string, character: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === character) {
      return index;
    }
  }
  return -1;
}

function unescapeMarkdown(value: string) {
  return value.replace(/\\([\\|#\]])/g, "$1");
}

function mergeAdjacentText(tokens: MarkdownInlineToken[]) {
  return tokens.reduce<MarkdownInlineToken[]>((merged, token) => {
    const previous = merged.at(-1);
    if (previous?.type === "text" && token.type === "text") {
      previous.value += token.value;
    } else {
      merged.push(token);
    }
    return merged;
  }, []);
}
