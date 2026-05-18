const fontSizePattern = /^<!--qm-font-size:(\d+)-->/;
const htmlTagPattern =
  /<(a|p|div|br|strong|b|em|i|u|s|del|strike|span|img|figure|ul|ol|li|blockquote|pre|code|table|tbody|thead|tr|td|th|colgroup|col|label|input)\b/i;
const linkableUrlPattern = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const trailingUrlPunctuationPattern = /[.,!?;:]+$/;
const imageWidthOptions = new Set([25, 50, 75, 100]);
const imagePixelWidthBounds = { min: 120, max: 1200 };
const tablePixelWidthBounds = { min: 280, max: 1800 };
const tablePixelHeightBounds = { min: 96, max: 2000 };
const tableRowPixelHeightBounds = { min: 28, max: 900 };
const tableColumnPixelWidthBounds = { min: 48, max: 900 };
const textSizeBounds = { min: 10, max: 72 };
const lineHeightBounds = { min: 1, max: 3 };
const tableCellColors = new Set(["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#fce7f3", "#f1f5f9"]);
const textAlignments = new Set(["left", "center", "right"]);
const safeHexColorPattern = /^#[0-9a-f]{6}$/;
const safeBlockIdPattern = /^[A-Za-z0-9_-]{12,64}$/;
const safeUidListPattern = /^[A-Za-z0-9_,:.-]{1,600}$/;
const safeUidPattern = /^[A-Za-z0-9_:.-]{1,128}$/;
const attributionLabelMaxLength = 160;
const lineHeightTags = new Set(["P", "DIV", "LI", "TD", "TH", "SPAN"]);
const attributionTags = new Set(["P", "DIV", "LI", "TD", "TH"]);
const allowedTags = new Set([
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
  const pixelWidth = safeImagePixelWidth(source.getAttribute("data-qm-image-width") ?? source.style.width);

  if (pixelWidth) {
    image.dataset.qmImageWidth = String(pixelWidth);
    image.style.width = `${pixelWidth}px`;
    image.style.maxWidth = "100%";
    image.style.height = "auto";
    return;
  }

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
  copyLineHeight(target, source);
  copyTextSize(target, source);
  copyTextColor(target, source);
  copySharedAttribution(target, source);
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

function copyLineHeight(target: HTMLElement, source: HTMLElement) {
  const lineHeight = safeLineHeight(source.getAttribute("data-qm-line-height") || source.style.lineHeight);

  if (!lineHeight || !lineHeightTags.has(target.tagName)) {
    return;
  }

  target.dataset.qmLineHeight = String(lineHeight);
  target.style.lineHeight = String(lineHeight);
}

function copyTextSize(target: HTMLElement, source: HTMLElement) {
  const size = safeTextSize(source.getAttribute("data-qm-font-size") || source.style.fontSize);

  if (!size || target.tagName !== "SPAN") {
    return;
  }

  target.dataset.qmFontSize = String(size);
  target.style.fontSize = `${size}px`;
}

function copyTextColor(target: HTMLElement, source: HTMLElement) {
  const color = safeColor(source.getAttribute("data-qm-text-color") || source.style.color);

  if (!color || target.tagName !== "SPAN") {
    return;
  }

  target.dataset.qmTextColor = color;
  target.style.color = color;
}

function copySharedAttribution(target: HTMLElement, source: HTMLElement) {
  if (!attributionTags.has(target.tagName)) {
    return;
  }

  const blockId = safeBlockId(source.getAttribute("data-qm-block-id"));
  const authorUids = safeUidList(source.getAttribute("data-qm-author-uids"));
  const editorUids = safeUidList(source.getAttribute("data-qm-editor-uids"));
  const lastEditorUid = safeUid(source.getAttribute("data-qm-last-editor-uid"));
  const attributionLabel = safeAttributionLabel(source.getAttribute("data-qm-attribution-label"));

  if (blockId) {
    target.dataset.qmBlockId = blockId;
  }

  if (authorUids) {
    target.dataset.qmAuthorUids = authorUids;
  }

  if (editorUids) {
    target.dataset.qmEditorUids = editorUids;
  }

  if (lastEditorUid) {
    target.dataset.qmLastEditorUid = lastEditorUid;
  }

  if (attributionLabel) {
    target.dataset.qmAttributionLabel = attributionLabel;
  }
}

function copyTableAttributes(target: HTMLElement, source: HTMLElement) {
  if (target.tagName === "TABLE") {
    copyTableWidthAttribute(target, source);
    copyTableHeightAttribute(target, source);
  }

  if (target.tagName === "TR") {
    copyTableRowHeightAttribute(target, source);
  }

  if (target.tagName === "TD" || target.tagName === "TH") {
    copyPositiveIntegerAttribute(target, source, "colspan", 12);
    copyPositiveIntegerAttribute(target, source, "rowspan", 12);
    copyColumnWidthAttribute(target, source);
    copyCellWidthAttribute(target, source);
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
  const pixelWidth = safeTablePixelWidth(source.getAttribute("data-qm-table-width-px") ?? source.style.width);

  if (pixelWidth) {
    target.dataset.qmTableWidthPx = String(pixelWidth);
    target.style.width = `${pixelWidth}px`;
    target.style.maxWidth = "100%";
    return;
  }

  const width = safeTableWidth(source.getAttribute("data-qm-table-width") ?? source.style.width);

  if (!width) {
    return;
  }

  target.dataset.qmTableWidth = String(width);
  target.style.width = `${width}%`;
  target.style.maxWidth = "100%";
}

function copyTableHeightAttribute(target: HTMLElement, source: HTMLElement) {
  const pixelHeight = safeTablePixelHeight(source.getAttribute("data-qm-table-height-px") ?? source.style.height);

  if (!pixelHeight) {
    return;
  }

  target.dataset.qmTableHeightPx = String(pixelHeight);
  target.style.height = `${pixelHeight}px`;
}

function copyTableRowHeightAttribute(target: HTMLElement, source: HTMLElement) {
  const pixelHeight = safeTableRowPixelHeight(source.getAttribute("data-qm-row-height-px") ?? source.style.height);

  if (!pixelHeight) {
    return;
  }

  target.dataset.qmRowHeightPx = String(pixelHeight);
  target.style.height = `${pixelHeight}px`;
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

function copyCellWidthAttribute(target: HTMLElement, source: HTMLElement) {
  const pixelWidth = safeTableColumnPixelWidth(source.getAttribute("data-qm-cell-width-px") ?? source.style.width);

  if (!pixelWidth) {
    return;
  }

  target.dataset.qmCellWidthPx = String(pixelWidth);
  target.style.width = `${pixelWidth}px`;
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

function safeImagePixelWidth(value: string | null) {
  const rawValue = String(value ?? "").trim();

  if (!rawValue.endsWith("px") && !/^\d+$/.test(rawValue)) {
    return null;
  }

  const normalizedValue = Number(rawValue.replace("px", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= imagePixelWidthBounds.min && normalizedValue <= imagePixelWidthBounds.max
    ? normalizedValue
    : null;
}

function safeTableWidth(value: string | null) {
  const normalizedValue = Number(String(value ?? "").replace("%", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= 30 && normalizedValue <= 100 ? normalizedValue : null;
}

function safeTablePixelWidth(value: string | null) {
  const rawValue = String(value ?? "").trim();

  if (!rawValue.endsWith("px") && !/^\d+$/.test(rawValue)) {
    return null;
  }

  const normalizedValue = Number(rawValue.replace("px", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= tablePixelWidthBounds.min && normalizedValue <= tablePixelWidthBounds.max
    ? normalizedValue
    : null;
}

function safeTablePixelHeight(value: string | null) {
  const rawValue = String(value ?? "").trim();

  if (!rawValue.endsWith("px") && !/^\d+$/.test(rawValue)) {
    return null;
  }

  const normalizedValue = Number(rawValue.replace("px", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= tablePixelHeightBounds.min && normalizedValue <= tablePixelHeightBounds.max
    ? normalizedValue
    : null;
}

function safeTableRowPixelHeight(value: string | null) {
  const rawValue = String(value ?? "").trim();

  if (!rawValue.endsWith("px") && !/^\d+$/.test(rawValue)) {
    return null;
  }

  const normalizedValue = Number(rawValue.replace("px", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= tableRowPixelHeightBounds.min && normalizedValue <= tableRowPixelHeightBounds.max
    ? normalizedValue
    : null;
}

function safeTableColumnPixelWidth(value: string | null) {
  const rawValue = String(value ?? "").trim();

  if (!rawValue.endsWith("px") && !/^\d+$/.test(rawValue)) {
    return null;
  }

  const normalizedValue = Number(rawValue.replace("px", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= tableColumnPixelWidthBounds.min && normalizedValue <= tableColumnPixelWidthBounds.max
    ? normalizedValue
    : null;
}

function safeTextSize(value: string | null) {
  const normalizedValue = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(normalizedValue) && normalizedValue >= textSizeBounds.min && normalizedValue <= textSizeBounds.max
    ? normalizedValue
    : null;
}

function safeLineHeight(value: string | null) {
  const normalizedValue = Math.round(Number(String(value ?? "").trim()) * 100) / 100;

  return Number.isFinite(normalizedValue) && normalizedValue >= lineHeightBounds.min && normalizedValue <= lineHeightBounds.max
    ? normalizedValue
    : null;
}

function safeTextAlign(value: string | null) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  return textAlignments.has(normalizedValue) ? normalizedValue : null;
}

function safeCellColor(value: string | null) {
  return safeColor(value);
}

function safeColor(value: string | null) {
  const normalizedValue = normalizeColor(value);

  return normalizedValue && (tableCellColors.has(normalizedValue) || safeHexColorPattern.test(normalizedValue)) ? normalizedValue : null;
}

function safeUidList(value: string | null) {
  const normalizedValue = String(value ?? "").trim();

  return safeUidListPattern.test(normalizedValue) ? normalizedValue : null;
}

function safeUid(value: string | null) {
  const normalizedValue = String(value ?? "").trim();

  return safeUidPattern.test(normalizedValue) ? normalizedValue : null;
}

function safeBlockId(value: string | null) {
  const normalizedValue = String(value ?? "").trim();

  return safeBlockIdPattern.test(normalizedValue) ? normalizedValue : null;
}

function safeAttributionLabel(value: string | null) {
  const normalizedValue = String(value ?? "").replace(/\s+/g, " ").trim();

  if (!normalizedValue || normalizedValue.length > attributionLabelMaxLength || hasUnsafeAttributionLabelCharacter(normalizedValue)) {
    return null;
  }

  return normalizedValue;
}

function hasUnsafeAttributionLabelCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || `<>"'\``.includes(character);
  });
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

  return Math.min(textSizeBounds.max, Math.max(textSizeBounds.min, Math.round(value)));
}
