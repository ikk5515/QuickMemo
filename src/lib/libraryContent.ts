import { bytesToBase64, decryptText, encryptText } from "./crypto";
import type {
  EncryptedPayload,
  LibraryHighlight,
  LibraryHighlightColor,
  LibraryItemContent,
  LibraryReaderBlock,
  LibraryReaderBlockKind
} from "../types";

export const libraryTitleMaxLength = 240;
export const libraryUrlMaxLength = 4096;
export const libraryDescriptionMaxLength = 4000;
export const librarySiteNameMaxLength = 160;
export const libraryCollectionMaxLength = 80;
export const libraryTagMaxLength = 40;
export const libraryTagMaxCount = 20;
export const librarySelectionTextMaxLength = 20_000;
export const libraryReaderBlockMaxCount = 600;
export const libraryReaderBlockTextMaxLength = 5000;
export const libraryReaderTextMaxLength = 180_000;
export const libraryHighlightMaxCount = 500;
export const libraryHighlightNoteMaxLength = 2000;
export const libraryOcrTextMaxLength = 180_000;
export const librarySourceFileNameMaxLength = 180;
export const libraryPlaintextMaxBytes = 480_000;

const encoder = new TextEncoder();
const nullCharacter = String.fromCharCode(0);
const whitespacePattern = /\s+/gu;
const trackingParameterNames = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"]);
const readerBlockKinds = new Set<LibraryReaderBlockKind>(["heading", "paragraph", "quote", "list-item", "code"]);
const highlightColors = new Set<LibraryHighlightColor>(["yellow", "green", "blue", "pink"]);
const idPattern = /^[A-Za-z0-9_-]{8,160}$/u;
const sourceDocumentIdPattern = /^[A-Za-z0-9_-]{1,180}$/u;
const fingerprintKeyCache = new WeakMap<CryptoKey, Promise<CryptoKey>>();

export function emptyLibraryItemContent(): LibraryItemContent {
  return {
    version: 1,
    title: "",
    url: "",
    description: "",
    siteName: "",
    collection: "",
    tags: [],
    selectionText: "",
    readerBlocks: [],
    highlights: [],
    ocrText: "",
    sourceFileName: "",
    archivedAt: null
  };
}

export function normalizeLibraryUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > libraryUrlMaxLength) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  const keptParameters = Array.from(url.searchParams.entries())
    .filter(([name]) => !name.toLowerCase().startsWith("utm_") && !trackingParameterNames.has(name.toLowerCase()))
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    );

  url.search = "";
  keptParameters.forEach(([name, value]) => url.searchParams.append(name, value));

  return url.toString();
}

export function safeLibraryExternalUrl(value: string) {
  return normalizeLibraryUrl(value);
}

export async function libraryUrlFingerprint(value: string, vaultKey: CryptoKey) {
  const normalized = normalizeLibraryUrl(value);

  if (!normalized) {
    return null;
  }

  return keyedLibraryFingerprint(`url/v1\n${normalized}`, vaultKey);
}

export async function libraryAttachmentFingerprint(noteId: string, attachmentId: string, vaultKey: CryptoKey) {
  if (!sourceDocumentIdPattern.test(noteId) || !sourceDocumentIdPattern.test(attachmentId)) {
    throw new Error("원본 첨부파일 식별자를 확인할 수 없습니다.");
  }

  return keyedLibraryFingerprint(`attachment/v1\n${noteId}\n${attachmentId}`, vaultKey);
}

async function keyedLibraryFingerprint(value: string, vaultKey: CryptoKey) {
  let hmacKeyPromise = fingerprintKeyCache.get(vaultKey);

  if (!hmacKeyPromise) {
    hmacKeyPromise = crypto.subtle.exportKey("raw", vaultKey).then((rawVaultKey) => crypto.subtle.importKey(
      "raw",
      rawVaultKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ));
    fingerprintKeyCache.set(vaultKey, hmacKeyPromise);
  }

  let hmacKey: CryptoKey;
  try {
    hmacKey = await hmacKeyPromise;
  } catch (error) {
    fingerprintKeyCache.delete(vaultKey);
    throw error;
  }
  const digest = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`quickmemo/library/${value}`));

  return base64Url(bytesToBase64(digest));
}

export function normalizeLibraryReaderBlocks(blocks: unknown): LibraryReaderBlock[] {
  if (!Array.isArray(blocks)) {
    return [];
  }

  const normalized: LibraryReaderBlock[] = [];
  let totalCharacters = 0;

  for (const candidate of blocks.slice(0, libraryReaderBlockMaxCount)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const source = candidate as Partial<LibraryReaderBlock>;
    const id = typeof source.id === "string" && idPattern.test(source.id) ? source.id : nextLibraryId();
    const kind = readerBlockKinds.has(source.kind as LibraryReaderBlockKind)
      ? (source.kind as LibraryReaderBlockKind)
      : "paragraph";
    const text = normalizeReaderBlockText(source.text, kind).slice(0, libraryReaderBlockTextMaxLength);

    if (!text) {
      continue;
    }

    if (totalCharacters + text.length > libraryReaderTextMaxLength) {
      const remaining = libraryReaderTextMaxLength - totalCharacters;

      if (remaining > 0) {
        normalized.push({ id, kind, text: text.slice(0, remaining) });
      }

      break;
    }

    normalized.push({ id, kind, text });
    totalCharacters += text.length;
  }

  return normalized;
}

export function normalizeLibraryHighlights(highlights: unknown, readerBlocks: LibraryReaderBlock[]): LibraryHighlight[] {
  if (!Array.isArray(highlights)) {
    return [];
  }

  const blockById = new Map(readerBlocks.map((block) => [block.id, block]));
  const acceptedByBlock = new Map<string, Array<{ startOffset: number; endOffset: number }>>();
  const normalized: LibraryHighlight[] = [];

  for (const candidate of highlights.slice(0, libraryHighlightMaxCount)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const source = candidate as Partial<LibraryHighlight>;
    const blockId = typeof source.blockId === "string" ? source.blockId : "";
    const block = blockById.get(blockId);
    const startOffset = Number.isInteger(source.startOffset) ? Number(source.startOffset) : -1;
    const endOffset = Number.isInteger(source.endOffset) ? Number(source.endOffset) : -1;

    if (!block || startOffset < 0 || endOffset <= startOffset || endOffset > block.text.length) {
      continue;
    }

    const quote = block.text.slice(startOffset, endOffset);

    if (!quote.trim()) {
      continue;
    }

    const ranges = acceptedByBlock.get(blockId) ?? [];

    if (ranges.some((range) => startOffset < range.endOffset && endOffset > range.startOffset)) {
      continue;
    }

    ranges.push({ startOffset, endOffset });
    acceptedByBlock.set(blockId, ranges);
    normalized.push({
      id: typeof source.id === "string" && idPattern.test(source.id) ? source.id : nextLibraryId(),
      blockId,
      startOffset,
      endOffset,
      quote,
      note: normalizeMultiline(source.note, libraryHighlightNoteMaxLength),
      color: highlightColors.has(source.color as LibraryHighlightColor)
        ? (source.color as LibraryHighlightColor)
        : "yellow",
      createdAt: validIsoDate(source.createdAt) ?? new Date().toISOString()
    });
  }

  return normalized;
}

export function normalizeLibraryItemContent(value: unknown): LibraryItemContent {
  const source = value && typeof value === "object" ? (value as Partial<LibraryItemContent>) : {};
  const readerBlocks = normalizeLibraryReaderBlocks(source.readerBlocks);
  const normalized: LibraryItemContent = {
    version: 1,
    title: normalizeSingleLine(source.title, libraryTitleMaxLength),
    url: normalizeLibraryUrl(typeof source.url === "string" ? source.url : "") ?? "",
    description: normalizeMultiline(source.description, libraryDescriptionMaxLength),
    siteName: normalizeSingleLine(source.siteName, librarySiteNameMaxLength),
    collection: normalizeSingleLine(source.collection, libraryCollectionMaxLength),
    tags: normalizeLibraryTags(source.tags),
    selectionText: normalizeMultiline(source.selectionText, librarySelectionTextMaxLength),
    readerBlocks,
    highlights: normalizeLibraryHighlights(source.highlights, readerBlocks),
    ocrText: normalizeMultiline(source.ocrText, libraryOcrTextMaxLength),
    sourceFileName: normalizeSingleLine(source.sourceFileName, librarySourceFileNameMaxLength),
    archivedAt: validIsoDate(source.archivedAt)
  };

  const serialized = JSON.stringify(normalized);

  if (encoder.encode(serialized).byteLength > libraryPlaintextMaxBytes) {
    throw new Error("자료실 항목이 안전한 저장 크기를 초과했습니다.");
  }

  return normalized;
}

export async function encryptLibraryItemContent(content: LibraryItemContent, itemKey: CryptoKey): Promise<EncryptedPayload> {
  return encryptText(JSON.stringify(normalizeLibraryItemContent(content)), itemKey);
}

export async function decryptLibraryItemContent(payload: EncryptedPayload, itemKey: CryptoKey) {
  return normalizeLibraryItemContent(JSON.parse(await decryptText(payload, itemKey)) as unknown);
}

export function librarySearchText(content: LibraryItemContent) {
  return [
    content.title,
    content.url,
    content.description,
    content.siteName,
    content.collection,
    content.tags.join(" "),
    content.selectionText,
    content.readerBlocks.map((block) => block.text).join(" "),
    content.highlights.map((highlight) => `${highlight.quote} ${highlight.note}`).join(" "),
    content.ocrText,
    content.sourceFileName
  ]
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(whitespacePattern, " ")
    .trim();
}

export function nextLibraryId() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64Url(bytesToBase64(bytes));
}

function normalizeLibraryTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    const tag = normalizeSingleLine(candidate, libraryTagMaxLength);
    const identity = tag.normalize("NFKC").toLocaleLowerCase("ko-KR");

    if (!tag || seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    tags.push(tag);

    if (tags.length >= libraryTagMaxCount) {
      break;
    }
  }

  return tags;
}

function normalizeReaderBlockText(value: unknown, kind: LibraryReaderBlockKind) {
  const text = typeof value === "string" ? value.normalize("NFKC").replaceAll(nullCharacter, "") : "";

  if (kind === "code") {
    return text.replace(/\r\n?/gu, "\n").trim();
  }

  return text.replace(whitespacePattern, " ").trim();
}

function normalizeSingleLine(value: unknown, maxLength: number, collapseWhitespace = true) {
  const text = typeof value === "string" ? value.normalize("NFKC").replaceAll(nullCharacter, "") : "";
  const normalized = collapseWhitespace ? text.replace(whitespacePattern, " ").trim() : text.trim();
  return normalized.slice(0, maxLength);
}

function normalizeMultiline(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.normalize("NFKC").replaceAll(nullCharacter, "") : "";
  return text.replace(/\r\n?/gu, "\n").replace(/[\t ]+\n/gu, "\n").trim().slice(0, maxLength);
}

function validIsoDate(value: unknown) {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function base64Url(value: string) {
  return value.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}
