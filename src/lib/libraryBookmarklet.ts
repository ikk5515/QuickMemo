export const maxLibraryBookmarkletUrlBytes = 16 * 1024;
const javascriptUrlPrefix = "javascript:";

function normalizeLibraryBookmarkletOrigin(value: string) {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("QuickMemo 북마클릿 origin이 올바르지 않습니다.");
  }

  const localHttp = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("QuickMemo 북마클릿은 HTTPS 또는 로컬 개발 주소에서만 만들 수 있습니다.");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("QuickMemo 북마클릿에는 origin만 사용할 수 있습니다.");
  }

  return parsed.origin;
}

/**
 * This function is serialized into the Safari bookmark. Keep every dependency
 * inside the function so the installed bookmarklet stays self-contained.
 */
function libraryCaptureBookmarkletRuntime(quickMemoOrigin: string) {
  "use strict";

  const maxPayloadBytes = 512 * 1024;
  const maxTitleCharacters = 300;
  const maxUrlCharacters = 4_096;
  const maxSelectionCharacters = 100_000;
  const maxBlocks = 400;
  const maxBlockCharacters = 12_000;
  const maxBlockCharactersTotal = 350_000;
  const captureTtlMilliseconds = 2 * 60 * 1000;
  const blockSelector = "h1, h2, h3, h4, h5, h6, p, blockquote, li, pre, code";
  const forbiddenContainerSelector = "script, style, noscript, nav, header, footer, form, button, input, textarea, select, svg, canvas, iframe";
  // eslint-disable-next-line no-control-regex
  const disallowedTextCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
  const sensitiveQueryParameter = /(?:^|[_-])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|code|credential|api[_-]?key|client[_-]?secret|private[_-]?key|key|pass(?:word)?|secret|session|signature|sig)(?:$|[_-])/i;
  const sensitiveUrlCredentialAssignment = /(?:^|[\s"'([{/?#&,;])(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|code|credential|api[_-]?key|client[_-]?secret|private[_-]?key|key|pass(?:word)?|secret|session|signature|sig)\s*["']?\s*(?:=|:)\s*["']?\s*[^\s"'})\]/?#&,;]+/i;
  const stronglySensitivePathLabel = /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|authorization|credential|api[_-]?key|client[_-]?secret|private[_-]?key|pass(?:word)?|secret|session|signature|sig)$/i;
  const weaklySensitivePathLabel = /^(?:token|auth|code|key)$/i;
  const opaqueCredentialAtom = /^[A-Za-z0-9._~+/=-]{16,}$/;
  const jwtLikeUrlCredential = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
  const sensitiveCredentials = [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
  ];
  let popup: Window | null = null;

  const containsSensitiveCredential = (value: string) =>
    sensitiveCredentials.some((pattern) => pattern.test(value));

  const normalizeText = (value: unknown) => String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(disallowedTextCharacters, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  const truncateText = (value: string, limit: number) => {
    if (value.length <= limit) {
      return value;
    }
    let end = limit;
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end -= 1;
    }
    return value.slice(0, end).trimEnd();
  };

  const safeText = (value: unknown, limit: number) => {
    const normalized = normalizeText(value);
    if (containsSensitiveCredential(normalized)) {
      throw new Error("SENSITIVE_CAPTURE");
    }
    return truncateText(normalized, limit);
  };

  const repeatedlyDecode = (value: string) => {
    let decoded = value;
    for (let round = 0; round < 3; round += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch {
        const next = decoded.replace(/%([0-7][0-9A-F])/gi, (_match, hexadecimal: string) =>
          String.fromCharCode(Number.parseInt(hexadecimal, 16))
        );
        if (next === decoded) {
          break;
        }
        decoded = next;
      }
    }
    return decoded;
  };

  const containsCredentialLikeUrlValue = (value: string) => {
    const decoded = repeatedlyDecode(value);
    return sensitiveUrlCredentialAssignment.test(decoded)
      || jwtLikeUrlCredential.test(decoded)
      || sensitiveCredentials.some((pattern) => pattern.test(decoded));
  };

  const looksLikeOpaqueCredentialAtom = (value: string) => {
    const decoded = repeatedlyDecode(value);
    return sensitiveCredentials.some((pattern) => pattern.test(decoded))
      || jwtLikeUrlCredential.test(decoded)
      || (opaqueCredentialAtom.test(decoded) && /[A-Z0-9._~+/=]/.test(decoded));
  };

  const decodedPathContainsCredentialPair = (value: string) => {
    const parts = value.split("/").filter(Boolean);
    return parts.some((part, index) => {
      const nextPart = parts[index + 1];
      return Boolean(nextPart) && (
        stronglySensitivePathLabel.test(part)
        || (weaklySensitivePathLabel.test(part) && looksLikeOpaqueCredentialAtom(nextPart))
      );
    });
  };

  const sanitizePathname = (pathname: string) => {
    const segments = pathname.split("/");
    const decodedSegments = segments.map(repeatedlyDecode);
    const removedIndexes = new Set<number>();

    for (let index = 0; index < decodedSegments.length; index += 1) {
      const segment = decodedSegments[index] ?? "";
      if (containsCredentialLikeUrlValue(segment) || decodedPathContainsCredentialPair(segment)) {
        removedIndexes.add(index);
        continue;
      }

      const nextSegment = decodedSegments[index + 1];
      if (nextSegment && (
        stronglySensitivePathLabel.test(segment)
        || (weaklySensitivePathLabel.test(segment) && looksLikeOpaqueCredentialAtom(nextSegment))
      )) {
        removedIndexes.add(index);
        removedIndexes.add(index + 1);
        index += 1;
      }
    }

    return segments.filter((_segment, index) => !removedIndexes.has(index)).join("/") || "/";
  };

  const sanitizeUrl = (value: string) => {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new Error("UNSUPPORTED_PAGE");
    }

    parsed.hash = "";
    parsed.pathname = sanitizePathname(parsed.pathname);
    const keptParameters: Array<[string, string]> = [];
    for (const [key, parameterValue] of parsed.searchParams.entries()) {
      if (
        sensitiveQueryParameter.test(repeatedlyDecode(key))
        || containsCredentialLikeUrlValue(parameterValue)
      ) {
        continue;
      }
      keptParameters.push([key, parameterValue]);
    }
    parsed.search = "";
    for (const [key, parameterValue] of keptParameters) {
      parsed.searchParams.append(key, parameterValue);
    }

    let normalized = parsed.toString();
    if (normalized.length > maxUrlCharacters) {
      parsed.search = "";
      normalized = parsed.toString();
    }
    if (normalized.length > maxUrlCharacters) {
      throw new Error("UNSUPPORTED_PAGE");
    }
    return normalized;
  };

  const blockKind = (element: Element) => {
    const tagName = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) return "heading";
    if (tagName === "blockquote") return "quote";
    if (tagName === "li") return "list-item";
    if (tagName === "pre" || tagName === "code") return "code";
    return "paragraph";
  };

  const extractBlocks = (root: Element) => {
    const blocks: Array<{ kind: string; text: string }> = [];
    let totalCharacters = 0;

    for (const element of root.querySelectorAll(blockSelector)) {
      const tagName = element.tagName.toLowerCase();
      if (element.closest(forbiddenContainerSelector)) continue;
      if (tagName === "code" && element.closest("pre")) continue;
      if (tagName === "p" && element.closest("blockquote, li")) continue;

      const remaining = maxBlockCharactersTotal - totalCharacters;
      if (remaining <= 0 || blocks.length >= maxBlocks) break;
      const text = safeText(element.textContent, Math.min(maxBlockCharacters, remaining));
      if (!text) continue;
      blocks.push({ kind: blockKind(element), text });
      totalCharacters += text.length;
    }
    return blocks;
  };

  try {
    const roots = [...document.querySelectorAll("article"), ...document.querySelectorAll("main")];
    let blocks: Array<{ kind: string; text: string }> = [];
    for (const root of roots) {
      blocks = extractBlocks(root);
      if (blocks.length > 0) break;
    }

    const payload: {
      version: 1;
      source: "bookmarklet";
      title: string;
      url: string;
      selectionText?: string;
      blocks: Array<{ kind: string; text: string }>;
      capturedAt: string;
    } = {
      version: 1,
      source: "bookmarklet",
      title: safeText(document.title, maxTitleCharacters),
      url: sanitizeUrl(location.href),
      blocks,
      capturedAt: new Date().toISOString()
    };
    const selectionText = safeText(document.getSelection?.()?.toString(), maxSelectionCharacters);
    if (selectionText) {
      payload.selectionText = selectionText;
    }

    const serializedSize = () => new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    while (payload.blocks.length > 0 && serializedSize() > maxPayloadBytes) {
      payload.blocks.pop();
    }
    if (payload.selectionText && serializedSize() > maxPayloadBytes) {
      const originalSelection = payload.selectionText;
      let lower = 0;
      let upper = originalSelection.length;
      while (lower < upper) {
        const midpoint = Math.ceil((lower + upper) / 2);
        payload.selectionText = truncateText(originalSelection, midpoint);
        if (serializedSize() <= maxPayloadBytes) {
          lower = midpoint;
        } else {
          upper = midpoint - 1;
        }
      }
      payload.selectionText = truncateText(originalSelection, lower);
      if (!payload.selectionText) {
        delete payload.selectionText;
      }
    }
    if (serializedSize() > maxPayloadBytes) {
      throw new Error("CAPTURE_TOO_LARGE");
    }
    const aggregateCaptureText = [
      payload.title,
      payload.selectionText ?? "",
      ...payload.blocks.map((block) => block.text)
    ].filter(Boolean).join("\n");
    if (containsSensitiveCredential(aggregateCaptureText)) {
      throw new Error("SENSITIVE_CAPTURE");
    }

    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    let nonceBinary = "";
    for (const byte of nonceBytes) {
      nonceBinary += String.fromCharCode(byte);
    }
    const nonce = btoa(nonceBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const targetUrl = `${quickMemoOrigin}/library#capture=${encodeURIComponent(nonce)}&source=bookmarklet`;

    popup = window.open("about:blank", "_blank");
    if (!popup) {
      throw new Error("POPUP_BLOCKED");
    }

    const popupDocument = popup.document;
    const referrerMeta = popupDocument.createElement("meta");
    referrerMeta.name = "referrer";
    referrerMeta.content = "no-referrer";
    (popupDocument.head ?? popupDocument.documentElement).append(referrerMeta);
    const navigationLink = popupDocument.createElement("a");
    navigationLink.href = targetUrl;
    navigationLink.target = "_self";
    navigationLink.referrerPolicy = "no-referrer";
    navigationLink.hidden = true;
    navigationLink.textContent = "QuickMemo";
    (popupDocument.body ?? popupDocument.documentElement).append(navigationLink);
    navigationLink.click();
    popup.focus();

    let pendingPayload: unknown = payload;
    const cleanup = () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      pendingPayload = null;
    };
    const sendCapture = () => {
      if (pendingPayload === null) return;
      try {
        if (popup?.closed) {
          cleanup();
          return;
        }
        popup?.postMessage(
          { type: "quickmemo.libraryCapture.bookmarklet", nonce, payload: pendingPayload },
          quickMemoOrigin
        );
      } catch {
        if (popup?.closed) cleanup();
      }
    };

    const intervalId = window.setInterval(sendCapture, 400);
    const timeoutId = window.setTimeout(cleanup, captureTtlMilliseconds);
    sendCapture();
  } catch (error) {
    try {
      popup?.close();
    } catch {
      // The transient window may already be gone.
    }

    const code = error instanceof Error ? error.message : "";
    if (code === "SENSITIVE_CAPTURE") {
      window.alert("QuickMemo: 인증 정보로 보이는 텍스트가 있어 캡처를 중단했습니다.");
    } else if (code === "POPUP_BLOCKED") {
      window.alert("QuickMemo 창을 열 수 없습니다. Safari의 팝업 허용 상태를 확인해주세요.");
    } else if (code === "CAPTURE_TOO_LARGE") {
      window.alert("QuickMemo: 현재 페이지의 읽을 본문이 너무 커서 캡처하지 못했습니다.");
    } else {
      window.alert("QuickMemo: 이 페이지에서는 안전한 캡처를 시작할 수 없습니다.");
    }
  }
}

export function createLibraryCaptureBookmarkletUrl(origin: string) {
  const safeOrigin = normalizeLibraryBookmarkletOrigin(origin);
  const invocation = `(${libraryCaptureBookmarkletRuntime.toString()})(${JSON.stringify(safeOrigin)});void 0`;
  // URL parsing removes raw TAB/LF/CR before a javascript: URL is evaluated.
  // Vite can also turn "\n" string literals into template literals containing
  // a raw LF. Preserve the serialized function exactly by escaping existing
  // percent signs first, then every parser-sensitive control character. The
  // javascript: evaluation algorithm decodes these sequences exactly once.
  const encodedInvocation = invocation
    .replace(/%/g, "%25")
    .replace(/\t/g, "%09")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D");
  const bookmarkletUrl = `${javascriptUrlPrefix}${encodedInvocation}`;

  if (new TextEncoder().encode(bookmarkletUrl).byteLength > maxLibraryBookmarkletUrlBytes) {
    throw new Error("Safari 북마클릿 코드가 허용 길이를 초과했습니다.");
  }

  return bookmarkletUrl;
}
