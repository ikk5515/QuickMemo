/* global document, location, TextEncoder, URL */

(() => {
  "use strict";

  const MAX_PAYLOAD_BYTES = 512 * 1024;
  const MAX_TITLE_CHARACTERS = 300;
  const MAX_URL_CHARACTERS = 4096;
  const MAX_SELECTION_CHARACTERS = 100000;
  const MAX_BLOCKS = 400;
  const MAX_BLOCK_CHARACTERS = 12000;
  const MAX_BLOCK_CHARACTERS_TOTAL = 350000;
  const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, blockquote, li, pre, code";
  const FORBIDDEN_CONTAINER_SELECTOR = "script, style, noscript, nav, header, footer, form, button, input, textarea, select, svg, canvas, iframe";
  // eslint-disable-next-line no-control-regex
  const DISALLOWED_TEXT_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
  const SENSITIVE_QUERY_PARAMETER = /(?:^|[_-])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|code|credential|key|pass(?:word)?|secret|session|signature|sig)(?:$|[_-])/i;
  const SENSITIVE_CREDENTIALS = [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
  ];

  const normalizeText = (value) => String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(DISALLOWED_TEXT_CHARACTERS, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  const truncateText = (value, limit) => {
    if (value.length <= limit) {
      return value;
    }
    let end = limit;
    const previousCodeUnit = value.charCodeAt(end - 1);
    const nextCodeUnit = value.charCodeAt(end);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
      end -= 1;
    }
    return value.slice(0, end).trimEnd();
  };

  const safeText = (value, limit) => {
    const normalized = normalizeText(value);
    if (SENSITIVE_CREDENTIALS.some((pattern) => pattern.test(normalized))) {
      return "";
    }
    return truncateText(normalized, limit);
  };

  const sanitizeUrl = (value) => {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new Error("unsupported URL");
    }
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    let normalized = parsed.toString();
    if (normalized.length > MAX_URL_CHARACTERS) {
      parsed.search = "";
      normalized = parsed.toString();
    }
    if (normalized.length > MAX_URL_CHARACTERS) {
      throw new Error("URL is too long");
    }
    return normalized;
  };

  const blockKind = (element) => {
    const tagName = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) return "heading";
    if (tagName === "blockquote") return "quote";
    if (tagName === "li") return "list-item";
    if (tagName === "pre" || tagName === "code") return "code";
    return "paragraph";
  };

  const extractBlocks = (root) => {
    const blocks = [];
    let totalCharacters = 0;

    for (const element of root.querySelectorAll(BLOCK_SELECTOR)) {
      const tagName = element.tagName.toLowerCase();
      if (element.closest(FORBIDDEN_CONTAINER_SELECTOR)) continue;
      if (tagName === "code" && element.closest("pre")) continue;
      if (tagName === "p" && element.closest("blockquote, li")) continue;

      const remaining = MAX_BLOCK_CHARACTERS_TOTAL - totalCharacters;
      if (remaining <= 0 || blocks.length >= MAX_BLOCKS) break;
      const text = safeText(element.textContent, Math.min(MAX_BLOCK_CHARACTERS, remaining));
      if (!text) continue;

      blocks.push({ kind: blockKind(element), text });
      totalCharacters += text.length;
    }
    return blocks;
  };

  const roots = [...document.querySelectorAll("article"), ...document.querySelectorAll("main")];
  let blocks = [];
  for (const root of roots) {
    blocks = extractBlocks(root);
    if (blocks.length > 0) break;
  }

  let url;
  try {
    url = sanitizeUrl(location.href);
  } catch {
    return null;
  }

  const payload = {
    version: 1,
    source: "extension",
    title: safeText(document.title, MAX_TITLE_CHARACTERS),
    url,
    blocks,
    capturedAt: new Date().toISOString()
  };
  const selectionText = safeText(document.getSelection?.()?.toString(), MAX_SELECTION_CHARACTERS);
  if (selectionText) {
    payload.selectionText = selectionText;
  }

  const serializedSize = () => new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  while (payload.blocks.length > 0 && serializedSize() > MAX_PAYLOAD_BYTES) {
    payload.blocks.pop();
  }

  if (payload.selectionText && serializedSize() > MAX_PAYLOAD_BYTES) {
    let lower = 0;
    let upper = payload.selectionText.length;
    while (lower < upper) {
      const midpoint = Math.ceil((lower + upper) / 2);
      const candidate = truncateText(payload.selectionText, midpoint);
      payload.selectionText = candidate;
      if (serializedSize() <= MAX_PAYLOAD_BYTES) {
        lower = midpoint;
      } else {
        upper = midpoint - 1;
      }
      payload.selectionText = selectionText;
    }
    payload.selectionText = truncateText(selectionText, lower);
    if (!payload.selectionText) {
      delete payload.selectionText;
    }
  }

  return serializedSize() <= MAX_PAYLOAD_BYTES ? payload : null;
})();
