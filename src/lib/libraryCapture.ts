export const libraryCaptureVersion = 1 as const;
export const maxLibraryCapturePayloadBytes = 512 * 1024;
export const maxLibraryCaptureTitleCharacters = 300;
export const maxLibraryCaptureUrlCharacters = 4_096;
export const maxLibraryCaptureSelectionCharacters = 100_000;
export const maxLibraryCaptureBlocks = 400;
export const maxLibraryCaptureBlockCharacters = 12_000;
export const maxLibraryCaptureBlockCharactersTotal = 350_000;

export const libraryCaptureSources = ["extension", "bookmarklet", "paste"] as const;
export const libraryCaptureBlockKinds = ["heading", "paragraph", "quote", "list-item", "code"] as const;

export type LibraryCaptureSource = (typeof libraryCaptureSources)[number];
export type LibraryCaptureBlockKind = (typeof libraryCaptureBlockKinds)[number];

export interface LibraryCaptureBlock {
  kind: LibraryCaptureBlockKind;
  text: string;
}

export interface LibraryCapturePayload {
  version: typeof libraryCaptureVersion;
  source: LibraryCaptureSource;
  title: string;
  url: string | null;
  selectionText?: string;
  blocks: LibraryCaptureBlock[];
  capturedAt?: string;
}

export interface LibraryCaptureHandoff {
  extensionId: string;
  nonce: string;
}

export interface LibraryCaptureLoginState {
  returnTo: "/library";
  captureFragment: string;
}

export class LibraryCaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryCaptureValidationError";
  }
}

const captureSourceSet = new Set<string>(libraryCaptureSources);
const captureBlockKindSet = new Set<string>(libraryCaptureBlockKinds);
const rootPayloadKeys = new Set(["version", "source", "title", "url", "selectionText", "blocks", "capturedAt"]);
const blockKeys = new Set(["kind", "text"]);
const extensionResponseKeys = new Set(["ok", "payload"]);
const extensionFailureResponseKeys = new Set(["ok", "error"]);
const handoffKeys = new Set(["capture", "extension"]);
const loginStateKeys = new Set(["returnTo", "captureFragment"]);
const forbiddenCaptureContainerSelector = "script, style, noscript, nav, header, footer, form, button, input, textarea, select, svg, canvas, iframe";
const captureBlockSelector = "h1, h2, h3, h4, h5, h6, p, blockquote, li, pre, code";
const sensitiveQueryParameterPattern = /(?:^|[_-])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|code|credential|api[_-]?key|client[_-]?secret|private[_-]?key|key|pass(?:word)?|secret|session|signature|sig)(?:$|[_-])/i;
const sensitiveUrlCredentialAssignmentPattern = /(?:^|[\s"'([{/?#&,;])(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|code|credential|api[_-]?key|client[_-]?secret|private[_-]?key|key|pass(?:word)?|secret|session|signature|sig)\s*["']?\s*(?:=|:)\s*["']?\s*[^\s"'})\]/?#&,;]+/i;
const stronglySensitivePathLabelPattern = /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|authorization|credential|api[_-]?key|client[_-]?secret|private[_-]?key|pass(?:word)?|secret|session|signature|sig)$/i;
const weaklySensitivePathLabelPattern = /^(?:token|auth|code|key)$/i;
const opaqueCredentialAtomPattern = /^[A-Za-z0-9._~+/=-]{16,}$/;
const jwtLikeUrlCredentialPattern = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
// eslint-disable-next-line no-control-regex
const disallowedTextCharactersPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const sensitiveCredentialPatterns = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];
const chromeExtensionIdPattern = /^[a-p]{32}$/;
const captureNoncePattern = /^[A-Za-z0-9_-]{43}$/;

export interface LibraryCaptureExternalRuntime {
  lastError?: { message?: string };
  sendMessage: (
    extensionId: string,
    message: { nonce: string; type: "quickmemo.consumeCapture" },
    callback: (response: unknown) => void
  ) => void;
}

interface LibraryCaptureLocation {
  hash: string;
  pathname: string;
  search: string;
}

interface LibraryCaptureHistory {
  readonly state: unknown;
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(record: Record<string, unknown>, allowedKeys: Set<string>, context: string) {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new LibraryCaptureValidationError(`${context}에 허용되지 않은 필드가 있습니다.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new LibraryCaptureValidationError(`${context}에는 일반 데이터 필드만 사용할 수 있습니다.`);
    }
  }
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function assertSerializedCaptureSize(value: unknown) {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new LibraryCaptureValidationError("캡처 데이터 형식이 올바르지 않습니다.");
  }

  if (typeof serialized !== "string" || utf8ByteLength(serialized) > maxLibraryCapturePayloadBytes) {
    throw new LibraryCaptureValidationError("캡처 데이터가 허용 크기를 초과했습니다.");
  }
}

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(disallowedTextCharactersPattern, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeBoundedText(value: unknown, maxCharacters: number, fieldName: string) {
  if (typeof value !== "string") {
    throw new LibraryCaptureValidationError(`${fieldName} 형식이 올바르지 않습니다.`);
  }

  const normalized = normalizeText(value);

  if (sensitiveCredentialPatterns.some((pattern) => pattern.test(normalized))) {
    throw new LibraryCaptureValidationError(`${fieldName}에 저장할 수 없는 인증 정보가 포함되어 있습니다.`);
  }

  if (normalized.length > maxCharacters) {
    throw new LibraryCaptureValidationError(`${fieldName}이(가) 허용 길이를 초과했습니다.`);
  }

  return normalized;
}

function repeatedlyDecodeUrlComponent(value: string) {
  let decoded = value;

  // URL and URLSearchParams may already decode one layer. Two additional
  // rounds cover percent- and double-encoded nested redirect values without
  // allowing an unbounded decoder loop.
  for (let round = 0; round < 3; round += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      // One malformed percent sign must not shield otherwise valid encoded
      // ASCII credential markers in the same component.
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
}

function containsCredentialLikeUrlValue(value: string) {
  const decoded = repeatedlyDecodeUrlComponent(value);
  return sensitiveUrlCredentialAssignmentPattern.test(decoded)
    || jwtLikeUrlCredentialPattern.test(decoded)
    || sensitiveCredentialPatterns.some((pattern) => pattern.test(decoded));
}

function looksLikeOpaqueCredentialAtom(value: string) {
  const decoded = repeatedlyDecodeUrlComponent(value);
  return sensitiveCredentialPatterns.some((pattern) => pattern.test(decoded))
    || jwtLikeUrlCredentialPattern.test(decoded)
    || (
      opaqueCredentialAtomPattern.test(decoded)
      && /[A-Z0-9._~+/=]/.test(decoded)
    );
}

function decodedPathContainsCredentialPair(value: string) {
  const parts = value.split("/").filter(Boolean);

  return parts.some((part, index) => {
    const nextPart = parts[index + 1];
    if (!nextPart) {
      return false;
    }
    return stronglySensitivePathLabelPattern.test(part)
      || (weaklySensitivePathLabelPattern.test(part) && looksLikeOpaqueCredentialAtom(nextPart));
  });
}

function sanitizeCapturePathname(pathname: string) {
  const segments = pathname.split("/");
  const decodedSegments = segments.map(repeatedlyDecodeUrlComponent);
  const removedIndexes = new Set<number>();

  for (let index = 0; index < decodedSegments.length; index += 1) {
    const segment = decodedSegments[index] ?? "";
    if (
      containsCredentialLikeUrlValue(segment)
      || decodedPathContainsCredentialPair(segment)
    ) {
      removedIndexes.add(index);
      continue;
    }

    const nextSegment = decodedSegments[index + 1];
    if (!nextSegment) {
      continue;
    }

    if (
      stronglySensitivePathLabelPattern.test(segment)
      || (weaklySensitivePathLabelPattern.test(segment) && looksLikeOpaqueCredentialAtom(nextSegment))
    ) {
      removedIndexes.add(index);
      removedIndexes.add(index + 1);
      index += 1;
    }
  }

  const sanitized = segments.filter((_segment, index) => !removedIndexes.has(index)).join("/");
  return sanitized || "/";
}

function normalizeCaptureUrl(value: unknown) {
  if (typeof value !== "string") {
    throw new LibraryCaptureValidationError("캡처 URL 형식이 올바르지 않습니다.");
  }

  const trimmed = normalizeText(value);

  if (trimmed.length === 0 || trimmed.length > maxLibraryCaptureUrlCharacters) {
    throw new LibraryCaptureValidationError("캡처 URL 길이가 올바르지 않습니다.");
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LibraryCaptureValidationError("캡처 URL이 올바르지 않습니다.");
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new LibraryCaptureValidationError("http 또는 https URL만 캡처할 수 있습니다.");
  }

  parsed.hash = "";
  parsed.pathname = sanitizeCapturePathname(parsed.pathname);

  const safeSearchParameters: Array<[string, string]> = [];
  for (const [key, parameterValue] of parsed.searchParams.entries()) {
    const decodedKey = repeatedlyDecodeUrlComponent(key);
    if (
      sensitiveQueryParameterPattern.test(decodedKey)
      || containsCredentialLikeUrlValue(parameterValue)
    ) {
      continue;
    }
    safeSearchParameters.push([key, parameterValue]);
  }
  parsed.search = "";
  for (const [key, parameterValue] of safeSearchParameters) {
    parsed.searchParams.append(key, parameterValue);
  }

  const normalized = parsed.toString();
  if (normalized.length > maxLibraryCaptureUrlCharacters) {
    throw new LibraryCaptureValidationError("캡처 URL이 허용 길이를 초과했습니다.");
  }

  return normalized;
}

function normalizeCapturedAt(value: unknown) {
  if (typeof value !== "string") {
    throw new LibraryCaptureValidationError("캡처 시각 형식이 올바르지 않습니다.");
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new LibraryCaptureValidationError("캡처 시각 형식이 올바르지 않습니다.");
  }

  return new Date(milliseconds).toISOString();
}

function truncateText(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) {
    return value;
  }

  let end = maxCharacters;
  const previousCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    end -= 1;
  }

  return value.slice(0, end).trimEnd();
}

function blockKindForElement(element: Element): LibraryCaptureBlockKind {
  const tagName = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tagName)) {
    return "heading";
  }
  if (tagName === "blockquote") {
    return "quote";
  }
  if (tagName === "li") {
    return "list-item";
  }
  if (tagName === "pre" || tagName === "code") {
    return "code";
  }
  return "paragraph";
}

function blocksFromPlainText(text: string) {
  const blocks: LibraryCaptureBlock[] = [];
  let totalCharacters = 0;
  const paragraphs = text.split(/\n{2,}/);

  for (const paragraph of paragraphs) {
    const normalized = normalizeText(paragraph);
    if (!normalized) {
      continue;
    }

    let offset = 0;
    while (offset < normalized.length && blocks.length < maxLibraryCaptureBlocks) {
      const available = maxLibraryCaptureBlockCharactersTotal - totalCharacters;
      if (available <= 0) {
        return blocks;
      }

      const chunkLength = Math.min(maxLibraryCaptureBlockCharacters, available);
      const chunk = truncateText(normalized.slice(offset), chunkLength);
      if (!chunk) {
        break;
      }
      blocks.push({ kind: "paragraph", text: chunk });
      totalCharacters += chunk.length;
      offset += chunk.length;
    }
  }

  return blocks;
}

export function normalizeLibraryCapturePayload(value: unknown): LibraryCapturePayload {
  if (!isPlainRecord(value)) {
    throw new LibraryCaptureValidationError("캡처 데이터 형식이 올바르지 않습니다.");
  }
  assertOnlyKeys(value, rootPayloadKeys, "캡처 데이터");
  assertSerializedCaptureSize(value);

  if (value.version !== libraryCaptureVersion) {
    throw new LibraryCaptureValidationError("지원하지 않는 캡처 데이터 버전입니다.");
  }
  if (typeof value.source !== "string" || !captureSourceSet.has(value.source)) {
    throw new LibraryCaptureValidationError("캡처 출처가 올바르지 않습니다.");
  }

  const source = value.source as LibraryCaptureSource;
  const title = normalizeBoundedText(value.title, maxLibraryCaptureTitleCharacters, "캡처 제목");
  const url = value.url === null ? null : normalizeCaptureUrl(value.url);
  if (source !== "paste" && url === null) {
    throw new LibraryCaptureValidationError("확장 프로그램과 북마클릿 캡처에는 URL이 필요합니다.");
  }

  if (!Array.isArray(value.blocks) || value.blocks.length > maxLibraryCaptureBlocks) {
    throw new LibraryCaptureValidationError("캡처 본문 블록 수가 허용 범위를 벗어났습니다.");
  }

  let blockCharacters = 0;
  const blocks = value.blocks.map((block, index): LibraryCaptureBlock => {
    if (!isPlainRecord(block)) {
      throw new LibraryCaptureValidationError(`${index + 1}번째 캡처 본문 형식이 올바르지 않습니다.`);
    }
    assertOnlyKeys(block, blockKeys, `${index + 1}번째 캡처 본문`);
    if (typeof block.kind !== "string" || !captureBlockKindSet.has(block.kind)) {
      throw new LibraryCaptureValidationError(`${index + 1}번째 캡처 본문 종류가 올바르지 않습니다.`);
    }

    const text = normalizeBoundedText(block.text, maxLibraryCaptureBlockCharacters, `${index + 1}번째 캡처 본문`);
    if (!text) {
      throw new LibraryCaptureValidationError("빈 캡처 본문 블록은 저장할 수 없습니다.");
    }
    blockCharacters += text.length;
    if (blockCharacters > maxLibraryCaptureBlockCharactersTotal) {
      throw new LibraryCaptureValidationError("캡처 본문 전체 길이가 허용 범위를 초과했습니다.");
    }

    return { kind: block.kind as LibraryCaptureBlockKind, text };
  });

  const normalized: LibraryCapturePayload = {
    version: libraryCaptureVersion,
    source,
    title,
    url,
    blocks
  };

  if (value.selectionText !== undefined) {
    const selectionText = normalizeBoundedText(
      value.selectionText,
      maxLibraryCaptureSelectionCharacters,
      "선택한 텍스트"
    );
    if (selectionText) {
      normalized.selectionText = selectionText;
    }
  }
  if (value.capturedAt !== undefined) {
    normalized.capturedAt = normalizeCapturedAt(value.capturedAt);
  }

  assertSerializedCaptureSize(normalized);
  return normalized;
}

export function parseLibraryCaptureJson(serialized: string) {
  if (typeof serialized !== "string" || utf8ByteLength(serialized) > maxLibraryCapturePayloadBytes) {
    throw new LibraryCaptureValidationError("캡처 데이터가 허용 크기를 초과했습니다.");
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new LibraryCaptureValidationError("캡처 JSON을 읽을 수 없습니다.");
  }
  return normalizeLibraryCapturePayload(value);
}

export function libraryCaptureFromPaste(input: string): LibraryCapturePayload {
  if (typeof input !== "string") {
    throw new LibraryCaptureValidationError("붙여넣기 데이터 형식이 올바르지 않습니다.");
  }

  const normalizedInput = normalizeText(input);
  if (!normalizedInput) {
    throw new LibraryCaptureValidationError("붙여넣을 내용이 없습니다.");
  }

  if (normalizedInput.startsWith("{") || normalizedInput.startsWith("[")) {
    const payload = parseLibraryCaptureJson(normalizedInput);
    if (payload.source === "extension") {
      throw new LibraryCaptureValidationError("확장 프로그램 데이터는 보안 핸드오프로만 가져올 수 있습니다.");
    }
    return payload;
  }

  try {
    const url = normalizeCaptureUrl(normalizedInput);
    return normalizeLibraryCapturePayload({
      version: libraryCaptureVersion,
      source: "paste",
      title: new URL(url).hostname,
      url,
      blocks: []
    });
  } catch (error) {
    if (!(error instanceof LibraryCaptureValidationError)) {
      throw error;
    }
  }

  if (normalizedInput.length > maxLibraryCaptureSelectionCharacters) {
    throw new LibraryCaptureValidationError("붙여넣은 텍스트가 허용 길이를 초과했습니다.");
  }

  const firstLine = normalizedInput.split("\n", 1)[0] ?? "";
  const payload = {
    version: libraryCaptureVersion,
    source: "paste",
    title: truncateText(firstLine, 80) || "붙여넣은 자료",
    url: null,
    selectionText: normalizedInput,
    blocks: blocksFromPlainText(normalizedInput)
  } satisfies LibraryCapturePayload;

  return normalizeLibraryCapturePayload(payload);
}

export function extractLibraryCaptureBlocks(root: ParentNode) {
  const blocks: LibraryCaptureBlock[] = [];
  let totalCharacters = 0;

  for (const element of root.querySelectorAll<HTMLElement>(captureBlockSelector)) {
    if (element.closest(forbiddenCaptureContainerSelector)) {
      continue;
    }
    if (element.tagName.toLowerCase() === "code" && element.closest("pre")) {
      continue;
    }
    if (element.tagName.toLowerCase() === "p" && element.closest("blockquote, li")) {
      continue;
    }

    const text = normalizeText(element.textContent ?? "");
    if (!text) {
      continue;
    }

    const available = maxLibraryCaptureBlockCharactersTotal - totalCharacters;
    if (available <= 0 || blocks.length >= maxLibraryCaptureBlocks) {
      break;
    }

    const boundedText = truncateText(text, Math.min(maxLibraryCaptureBlockCharacters, available));
    if (!boundedText) {
      continue;
    }
    blocks.push({ kind: blockKindForElement(element), text: boundedText });
    totalCharacters += boundedText.length;
  }

  return blocks;
}

export function captureLibraryDocument(
  captureDocument: Document = document,
  source: Extract<LibraryCaptureSource, "bookmarklet" | "extension"> = "bookmarklet"
) {
  const roots = [...captureDocument.querySelectorAll("article"), ...captureDocument.querySelectorAll("main")];
  let blocks: LibraryCaptureBlock[] = [];
  for (const root of roots) {
    blocks = extractLibraryCaptureBlocks(root);
    if (blocks.length > 0) {
      break;
    }
  }

  const selectionText = normalizeText(captureDocument.getSelection?.()?.toString() ?? "");
  const payload: LibraryCapturePayload = {
    version: libraryCaptureVersion,
    source,
    title: truncateText(normalizeText(captureDocument.title), maxLibraryCaptureTitleCharacters),
    url: captureDocument.location?.href ?? null,
    blocks,
    capturedAt: new Date().toISOString()
  };
  if (selectionText) {
    payload.selectionText = truncateText(selectionText, maxLibraryCaptureSelectionCharacters);
  }

  return normalizeLibraryCapturePayload(payload);
}

export function parseLibraryCaptureHandoffFragment(fragment: string): LibraryCaptureHandoff | null {
  const rawFragment = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!rawFragment) {
    return null;
  }

  const parameters = new URLSearchParams(rawFragment);
  if (!parameters.has("capture")) {
    return null;
  }
  for (const key of parameters.keys()) {
    if (!handoffKeys.has(key) || parameters.getAll(key).length !== 1) {
      throw new LibraryCaptureValidationError("캡처 핸드오프 주소가 올바르지 않습니다.");
    }
  }

  const nonce = parameters.get("capture") ?? "";
  const extensionId = parameters.get("extension") ?? "";
  if (!captureNoncePattern.test(nonce) || !chromeExtensionIdPattern.test(extensionId)) {
    throw new LibraryCaptureValidationError("캡처 핸드오프 주소가 올바르지 않습니다.");
  }

  return { extensionId, nonce };
}

/**
 * Produces the only fragment shape that may cross the unauthenticated login
 * boundary. The destination path is deliberately not caller-controlled.
 */
export function normalizeLibraryCaptureHandoffFragment(fragment: string) {
  const handoff = parseLibraryCaptureHandoffFragment(fragment);
  if (!handoff) {
    return null;
  }

  return `#capture=${handoff.nonce}&extension=${handoff.extensionId}`;
}

export function createLibraryCaptureLoginState(pathname: string, fragment: string): LibraryCaptureLoginState | null {
  if (pathname !== "/library") {
    return null;
  }

  const captureFragment = normalizeLibraryCaptureHandoffFragment(fragment);
  if (!captureFragment) {
    return null;
  }

  return { returnTo: "/library", captureFragment };
}

export function parseLibraryCaptureLoginState(value: unknown): LibraryCaptureLoginState | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isPlainRecord(value)) {
    throw new LibraryCaptureValidationError("캡처 로그인 정보가 올바르지 않습니다.");
  }
  assertOnlyKeys(value, loginStateKeys, "캡처 로그인 정보");
  const returnTo = Object.getOwnPropertyDescriptor(value, "returnTo")?.value;
  const captureFragmentValue = Object.getOwnPropertyDescriptor(value, "captureFragment")?.value;
  if (returnTo !== "/library" || typeof captureFragmentValue !== "string") {
    throw new LibraryCaptureValidationError("캡처 로그인 정보가 올바르지 않습니다.");
  }

  let captureFragment: string | null;
  try {
    captureFragment = normalizeLibraryCaptureHandoffFragment(captureFragmentValue);
  } catch {
    throw new LibraryCaptureValidationError("캡처 로그인 정보가 올바르지 않습니다.");
  }
  if (!captureFragment || captureFragment !== captureFragmentValue) {
    throw new LibraryCaptureValidationError("캡처 로그인 정보가 올바르지 않습니다.");
  }

  return { returnTo: "/library", captureFragment };
}

/**
 * Reads only the nonce handoff and removes it from the address before any
 * extension round trip starts. Capture bodies never belong in browser history.
 */
export function takeLibraryCaptureHandoffFromLocation(
  captureLocation: LibraryCaptureLocation = window.location,
  captureHistory: LibraryCaptureHistory = window.history
) {
  const rawFragment = captureLocation.hash.startsWith("#")
    ? captureLocation.hash.slice(1)
    : captureLocation.hash;
  if (!rawFragment || !new URLSearchParams(rawFragment).has("capture")) {
    return null;
  }

  try {
    return parseLibraryCaptureHandoffFragment(captureLocation.hash);
  } finally {
    captureHistory.replaceState(captureHistory.state, "", `${captureLocation.pathname}${captureLocation.search}`);
  }
}

function extensionFailureMessage(code: unknown) {
  if (code === "MISSING_OR_EXPIRED" || code === "ALREADY_CONSUMED") {
    return "캡처 요청이 만료되었거나 이미 사용되었습니다. 원본 페이지에서 다시 캡처해주세요.";
  }
  if (code === "UNAVAILABLE") {
    return "Chrome 확장 프로그램이 응답하지 않습니다. 확장 프로그램을 확인한 뒤 다시 시도해주세요.";
  }
  return "확장 프로그램에서 캡처 데이터를 가져오지 못했습니다. 원본 페이지에서 다시 시도해주세요.";
}

export function normalizeLibraryCaptureExtensionResponse(value: unknown) {
  if (!isPlainRecord(value)) {
    throw new LibraryCaptureValidationError("확장 프로그램 응답 형식이 올바르지 않습니다.");
  }
  const okDescriptor = Object.getOwnPropertyDescriptor(value, "ok");
  if (!okDescriptor || !("value" in okDescriptor)) {
    throw new LibraryCaptureValidationError("확장 프로그램 응답 형식이 올바르지 않습니다.");
  }
  if (okDescriptor.value !== true) {
    assertOnlyKeys(value, extensionFailureResponseKeys, "확장 프로그램 응답");
    throw new LibraryCaptureValidationError(extensionFailureMessage(value.error));
  }
  assertOnlyKeys(value, extensionResponseKeys, "확장 프로그램 응답");

  const payload = normalizeLibraryCapturePayload(value.payload);
  if (payload.source !== "extension") {
    throw new LibraryCaptureValidationError("확장 프로그램 캡처 출처가 올바르지 않습니다.");
  }
  return payload;
}

function browserLibraryCaptureRuntime() {
  const browserGlobal = globalThis as typeof globalThis & {
    chrome?: { runtime?: LibraryCaptureExternalRuntime };
  };
  return browserGlobal.chrome?.runtime ?? null;
}

export function consumeLibraryCaptureHandoff(
  handoff: LibraryCaptureHandoff,
  runtime: LibraryCaptureExternalRuntime | null = browserLibraryCaptureRuntime(),
  timeoutMilliseconds = 8_000
) {
  if (!chromeExtensionIdPattern.test(handoff.extensionId) || !captureNoncePattern.test(handoff.nonce)) {
    return Promise.reject(new LibraryCaptureValidationError("캡처 핸드오프 주소가 올바르지 않습니다."));
  }
  if (!runtime || typeof runtime.sendMessage !== "function") {
    return Promise.reject(new LibraryCaptureValidationError(
      "Chrome 확장 프로그램에 연결할 수 없습니다. Chrome에서 확장 프로그램을 확인해주세요."
    ));
  }

  return new Promise<LibraryCapturePayload>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeout);
      action();
    };
    const timeout = globalThis.setTimeout(() => {
      finish(() => reject(new LibraryCaptureValidationError(
        "Chrome 확장 프로그램 응답 시간이 초과됐습니다. 원본 페이지에서 다시 캡처해주세요."
      )));
    }, Math.max(1, timeoutMilliseconds));

    try {
      runtime.sendMessage(
        handoff.extensionId,
        { nonce: handoff.nonce, type: "quickmemo.consumeCapture" },
        (response) => {
          const runtimeError = runtime.lastError;
          if (runtimeError) {
            finish(() => reject(new LibraryCaptureValidationError(
              "Chrome 확장 프로그램이 응답하지 않습니다. 확장 프로그램을 확인한 뒤 다시 시도해주세요."
            )));
            return;
          }

          try {
            const payload = normalizeLibraryCaptureExtensionResponse(response);
            finish(() => resolve(payload));
          } catch (error) {
            finish(() => reject(error));
          }
        }
      );
    } catch {
      finish(() => reject(new LibraryCaptureValidationError(
        "Chrome 확장 프로그램을 호출하지 못했습니다. 확장 프로그램을 확인해주세요."
      )));
    }
  });
}
