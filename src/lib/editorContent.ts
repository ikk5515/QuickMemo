const fontSizePattern = /^<!--qm-font-size:(\d+)-->/;
const htmlTagPattern = /<(p|div|br|strong|b|em|i|u|span|img|figure|ul|ol|li|blockquote|pre|code)\b/i;
const allowedTags = new Set([
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DIV",
  "EM",
  "FIGURE",
  "I",
  "IMG",
  "LI",
  "OL",
  "P",
  "PRE",
  "SPAN",
  "STRONG",
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
    return image;
  }

  const element = document.createElement(node.tagName.toLowerCase());

  node.childNodes.forEach((childNode) => {
    const sanitizedChild = sanitizeNode(childNode);

    if (sanitizedChild) {
      element.appendChild(sanitizedChild);
    }
  });

  return element;
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
