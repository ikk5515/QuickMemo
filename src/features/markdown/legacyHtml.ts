import { isSafeExternalHttpUrl } from "./parser";

export type LegacyHtmlConversionWarningCode =
  | "active-content-removed"
  | "unsafe-link-removed"
  | "unsafe-image-removed"
  | "unsupported-formatting"
  | "unsupported-environment";

export interface LegacyHtmlConversionWarning {
  code: LegacyHtmlConversionWarningCode;
  message: string;
}

export interface LegacyHtmlConversionPreview {
  markdown: string;
  warnings: LegacyHtmlConversionWarning[];
  lossy: boolean;
  sourcePreserved: true;
}

interface ConversionContext {
  warnings: Map<LegacyHtmlConversionWarningCode, LegacyHtmlConversionWarning>;
}

const removedActiveTags = new Set([
  "SCRIPT",
  "STYLE",
  "SVG",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "META",
  "LINK"
]);
const maximumLegacyHtmlNestingDepth = 64;
const maximumLegacyTraversalNodes = 100_000;
const legacyVoidTags = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);

export function previewLegacyHtmlToMarkdown(html: string): LegacyHtmlConversionPreview {
  if (typeof document === "undefined") {
    const warning: LegacyHtmlConversionWarning = {
      code: "unsupported-environment",
      message: "이 환경에서는 HTML 구조를 분석할 수 없어 원문을 안전한 텍스트로 표시했습니다."
    };
    return {
      markdown: escapeHtmlAsText(html),
      warnings: [warning],
      lossy: true,
      sourcePreserved: true
    };
  }

  if (legacyHtmlNestingExceedsLimit(html)) {
    return legacyHtmlTextFallback(html);
  }

  const template = document.createElement("template");
  try {
    template.innerHTML = html;
  } catch {
    return legacyHtmlTextFallback(html);
  }
  const context: ConversionContext = { warnings: new Map() };
  let markdown: string;
  try {
    markdown = Array.from(template.content.childNodes)
      .map((node) => convertNode(node, context, 0))
      .join("")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  } catch {
    warn(context, "unsupported-formatting", "HTML 구조가 너무 복잡해 안전한 텍스트만 보존했습니다.");
    markdown = safeDescendantText(template.content, context);
  }
  const warnings = Array.from(context.warnings.values());

  return {
    markdown,
    warnings,
    lossy: warnings.length > 0,
    sourcePreserved: true
  };
}

function legacyHtmlNestingExceedsLimit(html: string) {
  const tagPattern = /<(\/)?([a-z][a-z\d:-]*)(?:\s[^<>]*?)?(\/?)>/giu;
  let depth = 0;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[2].toUpperCase();
    if (match[1]) {
      depth = Math.max(0, depth - 1);
    } else if (!match[3] && !legacyVoidTags.has(tag)) {
      depth += 1;
      if (depth > maximumLegacyHtmlNestingDepth) {
        return true;
      }
    }
  }
  return false;
}

function legacyHtmlTextFallback(html: string): LegacyHtmlConversionPreview {
  const activePattern = /<(script|style|svg|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
  const activeRemoved = activePattern.test(html);
  const withoutActiveContent = html.replace(activePattern, "");
  const text = withoutActiveContent
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
  const warnings: LegacyHtmlConversionWarning[] = [{
    code: "unsupported-formatting",
    message: "HTML 구조가 너무 깊거나 복잡해 안전한 텍스트만 보존했습니다."
  }];
  if (activeRemoved) {
    warnings.push({
      code: "active-content-removed",
      message: "실행 가능한 HTML은 안전한 텍스트 변환에서 제거했습니다."
    });
  }
  return {
    markdown: escapeMarkdownText(text),
    warnings,
    lossy: true,
    sourcePreserved: true
  };
}

function convertNode(node: Node, context: ConversionContext, depth: number): string {
  if (node.nodeType === 3) {
    return escapeMarkdownText(node.nodeValue ?? "");
  }
  if (node.nodeType !== 1) {
    return "";
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toUpperCase();
  if (removedActiveTags.has(tag)) {
    warn(
      context,
      "active-content-removed",
      "스크립트, 스타일, 임베드 같은 실행 가능한 HTML은 변환에서 제거했습니다."
    );
    return "";
  }
  if (depth >= maximumLegacyHtmlNestingDepth) {
    warn(context, "unsupported-formatting", "깊게 중첩된 HTML은 안전한 텍스트로 단순화했습니다.");
    return safeDescendantText(element, context);
  }

  const children = () => Array.from(element.childNodes)
    .map((child) => convertNode(child, context, depth + 1))
    .join("");

  switch (tag) {
    case "BR":
      return "\n";
    case "P":
    case "DIV":
    case "SECTION":
    case "ARTICLE":
      return `${children().trim()}\n\n`;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `${"#".repeat(Number(tag.slice(1)))} ${children().trim()}\n\n`;
    case "STRONG":
    case "B":
      return wrapInline("**", children());
    case "EM":
    case "I":
      return wrapInline("*", children());
    case "DEL":
    case "S":
    case "STRIKE":
      return wrapInline("~~", children());
    case "U":
      warn(context, "unsupported-formatting", "밑줄은 표준 Markdown에 없어 일반 텍스트로 변환했습니다.");
      return children();
    case "CODE":
      if (element.parentElement?.tagName === "PRE") {
        return element.textContent ?? "";
      }
      return inlineCode(element.textContent ?? "");
    case "PRE":
      return fencedCode(element.textContent ?? "", element.querySelector("code")?.className ?? "");
    case "BLOCKQUOTE": {
      const value = children().trim();
      return `${value.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    case "UL":
      return convertList(element, false, context, 0, depth + 1);
    case "OL":
      return convertList(element, true, context, 0, depth + 1);
    case "LI":
      return children();
    case "A":
      return convertAnchor(element, children(), context);
    case "IMG":
      return convertImage(element, context);
    case "TABLE":
      return convertTable(element, context, depth + 1);
    case "HR":
      return "---\n\n";
    case "INPUT":
      return "";
    case "SPAN":
    case "LABEL":
    case "FIGURE":
    case "FIGCAPTION":
    case "TBODY":
    case "THEAD":
    case "TFOOT":
    case "TR":
    case "TH":
    case "TD":
      return children();
    default:
      warn(
        context,
        "unsupported-formatting",
        "일부 HTML 서식은 표준 Markdown에 없어 내용만 보존했습니다."
      );
      return children();
  }
}

function convertList(
  element: HTMLElement,
  ordered: boolean,
  context: ConversionContext,
  depth: number,
  nodeDepth: number
): string {
  if (nodeDepth >= maximumLegacyHtmlNestingDepth) {
    warn(context, "unsupported-formatting", "깊게 중첩된 목록은 안전한 텍스트로 단순화했습니다.");
    return safeDescendantText(element, context);
  }
  const items = Array.from(element.children).filter((child) => child.tagName === "LI");
  const lines: string[] = [];
  items.forEach((item, index) => {
    const nested = Array.from(item.children).filter((child) => child.tagName === "UL" || child.tagName === "OL");
    const content = Array.from(item.childNodes)
      .filter((child) => !(child.nodeType === 1 && ["UL", "OL"].includes((child as HTMLElement).tagName)))
      .map((child) => convertNode(child, context, nodeDepth + 1))
      .join("")
      .trim();
    const checkbox = item.querySelector(":scope > input[type='checkbox'], :scope > label input[type='checkbox']") as HTMLInputElement | null;
    const taskPrefix = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";
    const marker = ordered ? `${index + 1}. ` : "- ";
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${marker}${taskPrefix}${content}`.trimEnd());
    for (const child of nested) {
      lines.push(convertList(
        child as HTMLElement,
        child.tagName === "OL",
        context,
        depth + 1,
        nodeDepth + 1
      ).trimEnd());
    }
  });
  return `${lines.join("\n")}\n\n`;
}

function convertAnchor(element: HTMLElement, label: string, context: ConversionContext) {
  const href = element.getAttribute("href")?.trim() ?? "";
  if (!isSafeExternalHttpUrl(href)) {
    warn(
      context,
      "unsafe-link-removed",
      "http 또는 https가 아닌 링크는 주소를 제거하고 표시 텍스트만 보존했습니다."
    );
    return label;
  }
  return `[${label.replace(/\]/g, "\\]")}](${href.replace(/\)/g, "%29")})`;
}

function convertImage(element: HTMLElement, context: ConversionContext) {
  const source = element.getAttribute("src")?.trim() ?? "";
  const alt = (element.getAttribute("alt") ?? "이미지").replace(/\]/g, "\\]");
  if (!isSafeExternalHttpUrl(source)) {
    warn(
      context,
      "unsafe-image-removed",
      "안전한 원격 주소가 아닌 이미지는 변환에서 제거했습니다."
    );
    return alt ? `[${alt} 제거됨]` : "";
  }
  return `![${alt}](${source.replace(/\)/g, "%29")})`;
}

function convertTable(element: HTMLElement, context: ConversionContext, depth: number) {
  const rows = Array.from(element.querySelectorAll("tr"));
  if (!rows.length) {
    return "";
  }
  const converted = rows.map((row) => Array.from(row.children)
    .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
    .map((cell) => Array.from(cell.childNodes)
      .map((child) => convertNode(child, context, depth + 1))
      .join("")
      .trim()
      .replace(/\|/g, "\\|")
      .replace(/\n+/g, " ")));
  const width = Math.max(...converted.map((row) => row.length));
  if (width === 0) {
    return "";
  }
  const normalized = converted.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => "")
  ]);
  const [header, ...body] = normalized;
  const delimiter = Array.from({ length: width }, () => "---");
  return `${[header, delimiter, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
}

function safeDescendantText(root: Node, context: ConversionContext) {
  const stack = Array.from(root.childNodes).reverse();
  const parts: string[] = [];
  let visited = 0;
  while (stack.length && visited < maximumLegacyTraversalNodes) {
    const node = stack.pop() as Node;
    visited += 1;
    if (node.nodeType === 3) {
      parts.push(escapeMarkdownText(node.nodeValue ?? ""));
      continue;
    }
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as HTMLElement;
    if (removedActiveTags.has(element.tagName.toUpperCase())) {
      warn(context, "active-content-removed", "실행 가능한 HTML은 안전한 텍스트 변환에서도 제거했습니다.");
      continue;
    }
    const children = Array.from(element.childNodes);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  if (stack.length) {
    warn(context, "unsupported-formatting", "HTML 노드 수가 너무 많아 일부 내용을 생략했습니다.");
  }
  return parts.join("");
}

function inlineCode(value: string) {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const marker = "`".repeat(Math.max(1, longest + 1));
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${marker}${padding}${value}${padding}${marker}`;
}

function fencedCode(value: string, className: string) {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const marker = "`".repeat(Math.max(3, longest + 1));
  const language = className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? "";
  return `${marker}${language}\n${value.replace(/\n$/, "")}\n${marker}\n\n`;
}

function wrapInline(marker: string, value: string) {
  return value ? `${marker}${value}${marker}` : "";
}

function escapeMarkdownText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/([\\`*_[\]<>])/g, "\\$1");
}

function escapeHtmlAsText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function warn(
  context: ConversionContext,
  code: LegacyHtmlConversionWarningCode,
  message: string
) {
  if (!context.warnings.has(code)) {
    context.warnings.set(code, { code, message });
  }
}
