const fontSizePattern = /^<!--qm-font-size:(\d+)-->/;
const htmlTagPattern = /<(a|p|div|br|strong|b|em|i|u|span|img|figure|ul|ol|li|blockquote|pre|code)\b/i;
const linkableUrlPattern = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const trailingUrlPunctuationPattern = /[.,!?;:]+$/;
const imageWidthOptions = new Set([25, 50, 75, 100]);
const allowedTags = new Set([
  "A",
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

  const element = document.createElement(node.tagName.toLowerCase());

  node.childNodes.forEach((childNode) => {
    const sanitizedChild = sanitizeNode(childNode);

    if (sanitizedChild) {
      element.appendChild(sanitizedChild);
    }
  });

  return element;
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

function safeImageWidth(value: string | null) {
  const normalizedValue = Number(String(value ?? "").replace("%", "").trim());

  return imageWidthOptions.has(normalizedValue) ? normalizedValue : null;
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
