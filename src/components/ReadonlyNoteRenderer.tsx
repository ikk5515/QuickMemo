import {
  Fragment,
  createElement,
  useMemo,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";
import {
  linkifyEditorHtml,
  normalizePlainTextLineEndings,
  type ReadonlyEditorContentFormat
} from "../lib/editorContent";
import { isReadonlyNoteRendererV2Enabled } from "../lib/readViewFeatureFlags";

const readonlyNoteMaximumCharacters = 1_000_000;
const readonlyNoteMaximumDepth = 96;
const readonlyNoteMaximumNodes = 20_000;
const readonlyNoteTags = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "COL",
  "COLGROUP",
  "DEL",
  "DIV",
  "EM",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "IMG",
  "INPUT",
  "LABEL",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "SPAN",
  "STRIKE",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "U",
  "UL"
]);
const attributionBlockTags = new Set(["P", "LI", "TD", "TH"]);

export type ReadonlyNoteContentFormat = ReadonlyEditorContentFormat;

export interface ReadonlyNoteRendererProps
  extends Omit<HTMLAttributes<HTMLElement>, "children" | "dangerouslySetInnerHTML"> {
  as?: "article" | "div";
  content: string;
  contentFormat?: ReadonlyNoteContentFormat;
  emptyText?: string;
  fontSize?: number;
  showAttribution?: boolean;
}

interface RenderBudget {
  failed: boolean;
  nodes: number;
}

export function ReadonlyNoteRenderer({
  as = "div",
  className = "",
  content,
  contentFormat = "html",
  emptyText = "내용 없음",
  fontSize = 17,
  showAttribution = false,
  style,
  ...attributes
}: ReadonlyNoteRendererProps) {
  const rendererV2Enabled = isReadonlyNoteRendererV2Enabled();
  const renderedContent = useMemo(
    () => readonlyNoteContent(
      content,
      contentFormat,
      emptyText,
      showAttribution,
      rendererV2Enabled
    ),
    [content, contentFormat, emptyText, rendererV2Enabled, showAttribution]
  );
  const mergedStyle = {
    ...style,
    "--editor-font-size": `${fontSize}px`
  } as CSSProperties;
  const mergedClassName = [
    "note-content",
    "note-content--readonly",
    contentFormat === "plain-text" || contentFormat === "markdown" ? "note-content--plain" : "",
    className
  ].filter(Boolean).join(" ");

  return createElement(
    as,
    {
      ...attributes,
      className: mergedClassName,
      style: mergedStyle
    },
    renderedContent
  );
}

function readonlyNoteContent(
  content: string,
  contentFormat: ReadonlyNoteContentFormat,
  emptyText: string,
  showAttribution: boolean,
  preserveEmptyParagraphLines: boolean
) {
  if (contentFormat === "plain-text" || contentFormat === "markdown") {
    return normalizePlainTextLineEndings(content) || emptyText;
  }

  if (
    typeof document === "undefined"
    || content.length > readonlyNoteMaximumCharacters
    || !readonlySourceWithinBudget(content)
  ) {
    return createElement("p", null, emptyText);
  }

  let safeHtml = "";

  try {
    safeHtml = linkifyEditorHtml(content);
  } catch {
    return createElement("p", null, emptyText);
  }

  if (!safeHtml) {
    return createElement("p", null, emptyText);
  }

  const template = document.createElement("template");
  template.innerHTML = safeHtml;
  const budget: RenderBudget = { failed: false, nodes: 0 };
  const nodes = Array.from(template.content.childNodes)
    .map((node, index) =>
      readonlyReactNode(
        node,
        `root-${index}`,
        0,
        budget,
        showAttribution,
        preserveEmptyParagraphLines
      )
    )
    .filter((node): node is ReactNode => node !== null);

  return budget.failed || !nodes.length
    ? createElement("p", null, emptyText)
    : nodes;
}

function readonlySourceWithinBudget(content: string) {
  try {
    const template = document.createElement("template");
    template.innerHTML = content;
    const pending = Array.from(template.content.childNodes).map((node) => ({
      depth: 0,
      node
    }));
    let nodes = 0;

    while (pending.length) {
      const current = pending.pop()!;
      nodes += 1;

      if (
        nodes > readonlyNoteMaximumNodes
        || current.depth > readonlyNoteMaximumDepth
      ) {
        return false;
      }

      current.node.childNodes.forEach((node) => {
        pending.push({ depth: current.depth + 1, node });
      });
    }

    return true;
  } catch {
    return false;
  }
}

function readonlyReactNode(
  node: Node,
  key: string,
  depth: number,
  budget: RenderBudget,
  showAttribution: boolean,
  preserveEmptyParagraphLines: boolean
): ReactNode | null {
  budget.nodes += 1;
  if (
    budget.failed
    || budget.nodes > readonlyNoteMaximumNodes
    || depth > readonlyNoteMaximumDepth
  ) {
    budget.failed = true;
    return null;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (!(node instanceof HTMLElement) || !readonlyNoteTags.has(node.tagName)) {
    return null;
  }

  const tagName = node.tagName.toLowerCase();
  const props = readonlyElementProps(node, key);
  const voidElement = ["br", "col", "hr", "img", "input"].includes(tagName);
  const children = voidElement
    ? []
    : Array.from(node.childNodes)
        .map((child, index) =>
          readonlyReactNode(
            child,
            `${key}-${index}`,
            depth + 1,
            budget,
            showAttribution,
            preserveEmptyParagraphLines
          )
        )
        .filter((child): child is ReactNode => child !== null);

  if (
    preserveEmptyParagraphLines
    && node.tagName === "P"
    && children.length === 0
  ) {
    children.push(createElement("br", { key: `${key}-empty-line` }));
  }

  const attributionLabel = showAttribution && attributionBlockTags.has(node.tagName)
    ? node.getAttribute("data-qm-attribution-label")
    : null;
  const attribution = attributionLabel
    ? createElement(
        "small",
        { className: "qm-attribution-note", key: `${key}-attribution` },
        attributionLabel
      )
    : null;

  if (attribution && node.tagName !== "P") {
    children.push(attribution);
  }

  const element = createElement(tagName, props, ...children);
  return attribution && node.tagName === "P"
    ? createElement(Fragment, { key }, element, attribution)
    : element;
}

function readonlyElementProps(element: HTMLElement, key: string) {
  const props: Record<string, unknown> = { key };

  element.getAttributeNames().forEach((attributeName) => {
    if (attributeName === "style") {
      return;
    }

    const value = element.getAttribute(attributeName) ?? "";
    if (attributeName === "class") {
      props.className = value;
      return;
    }
    if (attributeName === "colspan") {
      props.colSpan = Number(value);
      return;
    }
    if (attributeName === "rowspan") {
      props.rowSpan = Number(value);
      return;
    }
    if (attributeName === "checked" || attributeName === "disabled") {
      props[attributeName] = true;
      return;
    }

    props[attributeName] = value;
  });

  if (element.tagName === "INPUT") {
    props.readOnly = true;
  }

  const safeStyle = readonlyElementStyle(element);
  if (safeStyle) {
    props.style = safeStyle;
  }

  return props;
}

function readonlyElementStyle(element: HTMLElement) {
  const style: CSSProperties = {};

  if (element.style.backgroundColor) {
    style.backgroundColor = element.style.backgroundColor;
  }
  if (element.style.color) {
    style.color = element.style.color;
  }
  if (element.style.fontSize) {
    style.fontSize = element.style.fontSize;
  }
  if (element.style.height) {
    style.height = element.style.height;
  }
  if (element.style.lineHeight) {
    style.lineHeight = element.style.lineHeight;
  }
  if (element.style.maxWidth) {
    style.maxWidth = element.style.maxWidth;
  }
  if (element.style.textAlign) {
    style.textAlign = element.style.textAlign as CSSProperties["textAlign"];
  }
  if (element.style.width) {
    style.width = element.style.width;
  }

  return Object.keys(style).length ? style : null;
}

export default ReadonlyNoteRenderer;
