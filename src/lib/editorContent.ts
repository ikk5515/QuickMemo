const fontSizePattern = /^<!--qm-font-size:(\d+)-->/;
const htmlTagPattern =
  /<(a|p|div|br|strong|b|em|i|u|span|img|figure|ul|ol|li|blockquote|pre|code|table|tbody|thead|tr|td|th|colgroup|col|label|input)\b/i;
const linkableUrlPattern = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const trailingUrlPunctuationPattern = /[.,!?;:]+$/;
const imageWidthOptions = new Set([25, 50, 75, 100]);
const textSizeOptions = new Set([14, 16, 17, 18, 20, 22, 24, 28]);
const tableCellColors = new Set(["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#fce7f3", "#f1f5f9"]);
const textAlignments = new Set(["left", "center", "right"]);
const allowedTags = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "COL",
  "COLGROUP",
  "DIV",
  "EM",
  "FIGURE",
  "I",
  "IMG",
  "INPUT",
  "LABEL",
  "LI",
  "OL",
  "P",
  "PRE",
  "SPAN",
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

export interface ParsedEditorContent {
  html: string;
  fontSize: number;
}

export function parseEditorContent(storedValue: string, fallbackFontSize = 17): ParsedEditorContent {
  const fontSizeMatch = storedValue.match(fontSizePattern);
  const fontSize = clampFontSize(fontSizeMatch ? Number(fontSizeMatch[1]) : fallbackFontSize);
  const body = fontSizeMatch ? storedValue.replace(fontSizePattern, "") : storedValue;

  return {
    html: body.trim() ? normalizeEditorHtml(body) : "",
    fontSize
  };
}

export function serializeEditorContent(html: string, fontSize: number) {
  return `<!--qm-font-size:${clampFontSize(fontSize)}-->${sanitizeEditorHtml(html)}`;
}

export function normalizeEditorHtml(value: string) {
  if (!value.trim()) {
    return "";
  }

  return htmlTagPattern.test(value) ? sanitizeEditorHtml(value) : plainTextToHtml(value);
}

export function previewTextFromHtml(value: string) {
  const { html } = parseEditorContent(value);

  if (typeof document === "undefined") {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  const container = document.createElement("div");
  container.innerHTML = sanitizeEditorHtml(html);
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function sanitizeEditorHtml(html: string) {
  if (typeof document === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = document.createDocumentFragment();

  template.content.childNodes.forEach((node) => {
    const sanitized = sanitizeNode(node);

    if (sanitized) {
      fragment.appendChild(sanitized);
    }
  });

  const container = document.createElement("div");
  container.appendChild(fragment);
  return container.innerHTML;
}

export function linkifyEditorHtml(html: string) {
  if (typeof document === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = sanitizeEditorHtml(html);

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(
    template.content,
    4,
    {
      acceptNode(node) {
        const parent = node.parentElement;

        if (parent?.closest("a")) {
          return 2;
        }

        return 1;
      }
    }
  );

  let currentNode = walker.nextNode();

  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  textNodes.forEach(linkifyTextNode);

  const container = document.createElement("div");
  container.appendChild(template.content);
  return container.innerHTML;
}

export function imageHtml(src: string, alt: string) {
  const image = document.createElement("img");
  image.src = src;
  image.alt = alt;
  image.loading = "lazy";

  const figure = document.createElement("figure");
  figure.appendChild(image);

  const container = document.createElement("div");
  container.appendChild(figure);
  container.insertAdjacentHTML("beforeend", "<p><br></p>");
  return container.innerHTML;
}

function sanitizeNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent ?? "");
  }

  if (!(node instanceof HTMLElement) || !allowedTags.has(node.tagName)) {
    return null;
  }

  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";

    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src)) {
      return null;
    }

    const image = document.createElement("img");
    image.src = src;
    image.alt = node.getAttribute("alt")?.slice(0, 120) ?? "첨부 이미지";
    image.loading = "lazy";
    applySafeImageWidth(image, node);
    return image;
  }

  if (node.tagName === "A") {
    return sanitizeAnchor(node);
  }

  if (node.tagName === "INPUT") {
    return sanitizeCheckbox(node);
  }

  const element = document.createElement(node.tagName.toLowerCase());
  copySafeAttributes(element, node);

  node.childNodes.forEach((childNode) => {
    const sanitizedChild = sanitizeNode(childNode);

    if (sanitizedChild) {
      element.appendChild(sanitizedChild);
    }
  });

  return element;
}

function sanitizeCheckbox(node: HTMLElement): Node | null {
  if (node.getAttribute("type") !== "checkbox") {
    return null;
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.disabled = true;

  if (node.hasAttribute("checked")) {
    checkbox.checked = true;
    checkbox.setAttribute("checked", "");
  }

  return checkbox;
}

function sanitizeAnchor(node: HTMLElement): Node {
  const href = normalizedHttpHref(node.getAttribute("href") ?? "");
  const fragment = document.createDocumentFragment();

  node.childNodes.forEach((childNode) => {
    const sanitizedChild = sanitizeNode(childNode);

    if (sanitizedChild) {
      fragment.appendChild(sanitizedChild);
    }
  });

  if (!href) {
    return fragment;
  }

  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";

  if (fragment.textContent || fragment.childNodes.length) {
    anchor.appendChild(fragment);
  } else {
    anchor.textContent = href;
  }

  return anchor;
}

function applySafeImageWidth(image: HTMLImageElement, source: HTMLElement) {
  const width = safeImageWidth(source.getAttribute("data-qm-width") ?? source.style.width);

  if (!width) {
    return;
  }

  image.dataset.qmWidth = String(width);
  image.style.width = `${width}%`;
  image.style.maxWidth = "100%";
  image.style.height = "auto";
}

function copySafeAttributes(target: HTMLElement, source: HTMLElement) {
  copyTaskAttributes(target, source);
  copyTextAlign(target, source);
  copyTextSize(target, source);
  copyTableAttributes(target, source);
}

function copyTaskAttributes(target: HTMLElement, source: HTMLElement) {
  const dataType = source.getAttribute("data-type");

  if ((target.tagName === "UL" && dataType === "taskList") || (target.tagName === "LI" && dataType === "taskItem")) {
    target.dataset.type = dataType;
  }

  if (target.tagName === "LI") {
    const checked = source.getAttribute("data-checked");

    if (checked === "true" || checked === "false") {
      target.dataset.checked = checked;
    }
  }
}

function copyTextAlign(target: HTMLElement, source: HTMLElement) {
  const alignment = safeTextAlign(source.style.textAlign || source.getAttribute("data-text-align"));

  if (!alignment || !["P", "DIV", "LI", "TD", "TH"].includes(target.tagName)) {
    return;
  }

  target.style.textAlign = alignment;
}

function copyTextSize(target: HTMLElement, source: HTMLElement) {
  const size = safeTextSize(source.getAttribute("data-qm-font-size") || source.style.fontSize);

  if (!size || target.tagName !== "SPAN") {
    return;
  }

  target.dataset.qmFontSize = String(size);
  target.style.fontSize = `${size}px`;
}

function copyTableAttributes(target: HTMLElement, source: HTMLElement) {
  if (target.tagName === "TABLE") {
    copyTableWidthAttribute(target, source);
  }

  if (target.tagName === "TD" || target.tagName === "TH") {
    copyPositiveIntegerAttribute(target, source, "colspan", 12);
    copyPositiveIntegerAttribute(target, source, "rowspan", 12);
    copyColumnWidthAttribute(target, source);
    copyCellColorAttribute(target, source);
  }

  if (target.tagName === "COL") {
    const width = safePixelWidth(source.style.width);

    if (width) {
      target.style.width = width;
    }
  }
}

function copyTableWidthAttribute(target: HTMLElement, source: HTMLElement) {
  const width = safeTableWidth(source.getAttribute("data-qm-table-width") ?? source.style.width);

  if (!width) {
    return;
  }

  target.dataset.qmTableWidth = String(width);
  target.style.width = `${width}%`;
  target.style.maxWidth = "100%";
}

function copyPositiveIntegerAttribute(target: HTMLElement, source: HTMLElement, attribute: string, max: number) {
  const value = Number(source.getAttribute(attribute));

  if (Number.isInteger(value) && value > 0 && value <= max) {
    target.setAttribute(attribute, String(value));
  }
}

function copyColumnWidthAttribute(target: HTMLElement, source: HTMLElement) {
  const rawValue = source.getAttribute("colwidth");

  if (!rawValue) {
    return;
  }

  const widths = rawValue
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 24 && value <= 1600);

  if (widths.length) {
    target.setAttribute("colwidth", widths.join(","));
  }
}

function copyCellColorAttribute(target: HTMLElement, source: HTMLElement) {
  const color = safeCellColor(source.getAttribute("data-qm-bg") || source.style.backgroundColor);

  if (!color) {
    return;
  }

  target.dataset.qmBg = color;
  target.style.backgroundColor = color;
}

function safeImageWidth(value: string | null) {
  const normalizedValue = Number(String(value ?? "").replace("%", "").trim());

  return imageWidthOptions.has(normalizedValue) ? normalizedValue : null;
}

function safeTableWidth(value: string | null) {
  const normalizedValue = Number(String(value ?? "").replace("%", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= 30 && normalizedValue <= 100 ? normalizedValue : null;
}

function safeTextSize(value: string | null) {
  const normalizedValue = Number(String(value ?? "").replace("px", "").trim());

  return textSizeOptions.has(normalizedValue) ? normalizedValue : null;
}

function safeTextAlign(value: string | null) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  return textAlignments.has(normalizedValue) ? normalizedValue : null;
}

function safeCellColor(value: string | null) {
  const normalizedValue = normalizeColor(value);

  return normalizedValue && tableCellColors.has(normalizedValue) ? normalizedValue : null;
}

function safePixelWidth(value: string | null) {
  const match = String(value ?? "").trim().match(/^(\d{1,4})px$/);

  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  return width >= 24 && width <= 1600 ? `${width}px` : null;
}

function normalizeColor(value: string | null) {
  const rawValue = String(value ?? "").trim().toLowerCase();

  if (rawValue.startsWith("#")) {
    return rawValue;
  }

  const rgbMatch = rawValue.match(/^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/);

  if (!rgbMatch) {
    return null;
  }

  const channels = rgbMatch.slice(1).map((channel) => Number(channel));

  if (channels.some((channel) => channel < 0 || channel > 255)) {
    return null;
  }

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function linkifyTextNode(node: Text) {
  const text = node.textContent ?? "";
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let changed = false;

  for (const match of text.matchAll(linkableUrlPattern)) {
    const rawText = match[0];
    const startIndex = match.index ?? 0;
    const { linkText, suffix } = splitUrlToken(rawText);
    const href = normalizedHttpHref(linkText);

    if (!href) {
      continue;
    }

    fragment.appendChild(document.createTextNode(text.slice(lastIndex, startIndex)));

    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = linkText;
    fragment.appendChild(anchor);

    if (suffix) {
      fragment.appendChild(document.createTextNode(suffix));
    }

    lastIndex = startIndex + rawText.length;
    changed = true;
  }

  if (!changed) {
    return;
  }

  fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  node.replaceWith(fragment);
}

function splitUrlToken(value: string) {
  const suffix = value.match(trailingUrlPunctuationPattern)?.[0] ?? "";

  return {
    linkText: suffix ? value.slice(0, -suffix.length) : value,
    suffix
  };
}

function normalizedHttpHref(value: string) {
  const rawValue = value.trim();

  if (!rawValue) {
    return null;
  }

  const normalizedValue = /^www\./i.test(rawValue) ? `https://${rawValue}` : rawValue;

  try {
    const url = new URL(normalizedValue);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    if (!url.hostname) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function plainTextToHtml(value: string) {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split(/\n/).map(escapeHtml).join("<br>");
      return `<p>${lines || "<br>"}</p>`;
    })
    .join("");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clampFontSize(value: number) {
  if (!Number.isFinite(value)) {
    return 17;
  }

  return Math.min(28, Math.max(14, Math.round(value)));
}
