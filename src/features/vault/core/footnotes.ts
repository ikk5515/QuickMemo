import {
  normalizeMarkdownLineEndings,
  tokenizeMarkdown,
  type MarkdownBlock,
  type MarkdownFootnote,
  type MarkdownInlineToken
} from "../../markdown";

export const MAX_FOOTNOTES_VIEW_ITEMS = 500;
export const MAX_FOOTNOTE_PREVIEW_CHARACTERS = 800;
export const MAX_FOOTNOTES_SOURCE_CHARACTERS = 1_000_000;

export interface VaultFootnoteViewItem {
  definitionMarkdown: string | null;
  definitionLine: number | null;
  inline: boolean;
  label: string;
  number: number;
  preview: string;
  referenceCount: number;
}

export interface VaultFootnoteViewModel {
  items: VaultFootnoteViewItem[];
  truncated: boolean;
}

interface FootnoteDefinitionSource {
  line: number;
  markdown: string;
}

const footnoteDefinitionPattern = /^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$/u;
const openingFencePattern = /^\s{0,3}(`{3,}|~{3,})/u;

function normalizeFootnoteLabel(label: string) {
  return label.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function footnoteDefinitionsFromSource(source: string) {
  const lines = normalizeMarkdownLineEndings(source).split("\n");
  const definitions = new Map<string, FootnoteDefinitionSource>();
  let fence: { marker: string; length: number } | null = null;
  let frontmatter = lines[0] === "---";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && (line === "---" || line === "...")) frontmatter = false;
      index += 1;
      continue;
    }
    if (fence) {
      const closing = line.match(/^\s{0,3}(`+|~+)\s*$/u);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = null;
      index += 1;
      continue;
    }
    const openingFence = line.match(openingFencePattern);
    if (openingFence) {
      fence = { marker: openingFence[1][0], length: openingFence[1].length };
      index += 1;
      continue;
    }
    const first = line.match(footnoteDefinitionPattern);
    if (!first) {
      index += 1;
      continue;
    }
    const body = [first[2]];
    let end = index + 1;
    while (end < lines.length) {
      const continuation = lines[end].match(/^(?: {4}|\t)(.*)$/u);
      if (continuation) {
        body.push(continuation[1]);
        end += 1;
        continue;
      }
      if (!lines[end].trim() && /^(?: {4}|\t)/u.test(lines[end + 1] ?? "")) {
        body.push("");
        end += 1;
        continue;
      }
      break;
    }
    const normalizedLabel = normalizeFootnoteLabel(first[1]);
    if (!definitions.has(normalizedLabel)) {
      definitions.set(normalizedLabel, { line: index + 1, markdown: body.join("\n") });
    }
    index = end;
  }
  return definitions;
}

function inlineText(tokens: readonly MarkdownInlineToken[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "text":
      case "code":
      case "math":
        return token.value;
      case "line-break":
        return "\n";
      case "footnote-reference":
        return token.inline ? inlineText(token.inline) : `[^${token.label}]`;
      case "emphasis":
      case "strong":
      case "delete":
      case "link":
        return inlineText(token.children);
      case "wikilink":
        return token.display;
      case "tag":
        return token.raw;
    }
  }).join("");
}

function blockText(block: MarkdownBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlineText(block.children);
    case "code-block":
    case "math-block":
    case "frontmatter":
      return block.value;
    case "list":
      return block.items.map((item) => inlineText(item.children)).join(" ");
    case "quote":
      return block.blocks.map(blockText).join(" ");
    case "callout":
      return `${inlineText(block.title)} ${block.blocks.map(blockText).join(" ")}`;
    case "table":
      return [...block.header, ...block.rows.flat()].map((cell) => inlineText(cell.children)).join(" ");
    case "thematic-break":
      return "";
  }
}

function footnotePreview(footnote: MarkdownFootnote) {
  return footnote.blocks
    .map(blockText)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_FOOTNOTE_PREVIEW_CHARACTERS);
}

export function buildVaultFootnoteView(source: string): VaultFootnoteViewModel {
  if (source.length > MAX_FOOTNOTES_SOURCE_CHARACTERS) {
    throw new Error("각주 보기는 1,000,000자 이하 노트에서 사용할 수 있습니다.");
  }
  const document = tokenizeMarkdown(source);
  const definitions = footnoteDefinitionsFromSource(source);
  const footnotes = document.footnotes.slice(0, MAX_FOOTNOTES_VIEW_ITEMS);
  return {
    items: footnotes.map((footnote) => {
      const sourceDefinition = definitions.get(normalizeFootnoteLabel(footnote.label)) ?? null;
      const inline = footnote.label.startsWith("__inline-") && !sourceDefinition;
      const definition = inline ? null : sourceDefinition;
      return {
        definitionMarkdown: definition?.markdown ?? null,
        definitionLine: definition?.line ?? null,
        inline,
        label: inline ? `인라인 각주 ${footnote.number}` : footnote.label,
        number: footnote.number,
        preview: footnotePreview(footnote),
        referenceCount: footnote.referenceCount
      };
    }),
    truncated: document.footnotes.length > footnotes.length
  };
}
