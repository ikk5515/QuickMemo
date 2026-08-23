import type { MouseEvent as ReactMouseEvent } from "react";

export type MarkdownViewMode = "source" | "live-preview" | "reading";

export interface MarkdownTextToken {
  type: "text";
  value: string;
}

export interface MarkdownLineBreakToken {
  type: "line-break";
}

export interface MarkdownCodeToken {
  type: "code";
  value: string;
}

export interface MarkdownMathToken {
  type: "math";
  value: string;
}

export interface MarkdownFootnoteReferenceToken {
  type: "footnote-reference";
  raw: string;
  label: string;
  inline: MarkdownInlineToken[] | null;
  number: number | null;
  referenceIndex: number | null;
}

export interface MarkdownEmphasisToken {
  type: "emphasis" | "strong" | "delete";
  children: MarkdownInlineToken[];
}

export interface MarkdownWikiLinkToken {
  type: "wikilink";
  raw: string;
  target: string;
  path: string;
  subpath: string | null;
  display: string;
  embed: boolean;
}

export interface MarkdownLinkToken {
  type: "link";
  raw: string;
  href: string;
  external: boolean;
  safe: boolean;
  embed: boolean;
  children: MarkdownInlineToken[];
}

export interface MarkdownTagToken {
  type: "tag";
  raw: string;
  tag: string;
  normalizedTag: string;
}

export type MarkdownInlineToken =
  | MarkdownTextToken
  | MarkdownLineBreakToken
  | MarkdownCodeToken
  | MarkdownMathToken
  | MarkdownFootnoteReferenceToken
  | MarkdownEmphasisToken
  | MarkdownWikiLinkToken
  | MarkdownLinkToken
  | MarkdownTagToken;

export interface MarkdownHeadingBlock {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: MarkdownInlineToken[];
}

export interface MarkdownParagraphBlock {
  type: "paragraph";
  children: MarkdownInlineToken[];
}

export interface MarkdownCodeBlock {
  type: "code-block";
  language: string;
  value: string;
}

export interface MarkdownMathBlock {
  type: "math-block";
  value: string;
}

export interface MarkdownListItem {
  checked: boolean | null;
  children: MarkdownInlineToken[];
}

export interface MarkdownListBlock {
  type: "list";
  ordered: boolean;
  start: number;
  items: MarkdownListItem[];
}

export interface MarkdownQuoteBlock {
  type: "quote";
  blocks: MarkdownBlock[];
}

export interface MarkdownCalloutBlock {
  type: "callout";
  calloutType: string;
  title: MarkdownInlineToken[];
  foldable: boolean;
  open: boolean;
  blocks: MarkdownBlock[];
}

export interface MarkdownTableCell {
  children: MarkdownInlineToken[];
}

export interface MarkdownTableBlock {
  type: "table";
  alignments: Array<"left" | "center" | "right" | null>;
  header: MarkdownTableCell[];
  rows: MarkdownTableCell[][];
}

export interface MarkdownThematicBreakBlock {
  type: "thematic-break";
}

export interface MarkdownFrontmatterBlock {
  type: "frontmatter";
  value: string;
}

export type MarkdownBlock =
  | MarkdownHeadingBlock
  | MarkdownParagraphBlock
  | MarkdownCodeBlock
  | MarkdownMathBlock
  | MarkdownListBlock
  | MarkdownQuoteBlock
  | MarkdownCalloutBlock
  | MarkdownTableBlock
  | MarkdownThematicBreakBlock
  | MarkdownFrontmatterBlock;

export interface MarkdownDocument {
  blocks: MarkdownBlock[];
  footnotes: MarkdownFootnote[];
}

export interface MarkdownFootnote {
  label: string;
  number: number;
  blocks: MarkdownBlock[];
  referenceCount: number;
}

export interface MarkdownLinkReference {
  kind: "wikilink" | "markdown-internal" | "external";
  raw: string;
  target: string;
  path: string;
  subpath: string | null;
  display: string;
  embed: boolean;
  href?: string;
}

export type MarkdownLinkClickHandler = (
  reference: MarkdownLinkReference,
  event: ReactMouseEvent<HTMLElement>
) => void;

export type MarkdownLinkPreviewSource = "focus" | "pointer";

export interface MarkdownLinkPreviewInteraction {
  active: boolean;
  anchor: HTMLElement;
  source: MarkdownLinkPreviewSource;
}

export type MarkdownLinkPreviewHandler = (
  reference: MarkdownLinkReference,
  interaction: MarkdownLinkPreviewInteraction
) => void;

export type MarkdownTagClickHandler = (
  tag: string,
  event: ReactMouseEvent<HTMLButtonElement>
) => void;
