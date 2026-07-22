import { safePublicShareAttachmentMimeType } from "./attachments";
import { extractLibraryPdfText, type LibraryPdfTextResult } from "./libraryPdfText";
import { runLibraryImageOcr, type LibraryImageOcrOptions, type LibraryImageOcrResult } from "./libraryImageOcr";
import { libraryReaderBlockMaxCount, libraryReaderBlockTextMaxLength, libraryReaderTextMaxLength, nextLibraryId } from "./libraryContent";
import type { LibraryReaderBlock } from "../types";

export type LibraryAttachmentExtractionMode = "image-ocr" | "pdf-text";

export interface LibraryAttachmentExtractionResult {
  confidence: number | null;
  likelyScanned: boolean;
  mode: LibraryAttachmentExtractionMode;
  readerBlocks: LibraryReaderBlock[];
  sourceTextCharacters: number;
  storedTextCharacters: number;
  truncated: boolean;
}

export interface ExtractLibraryAttachmentOptions {
  extension: string;
  mimeType: string;
  onOcrProgress?: LibraryImageOcrOptions["onProgress"];
  signal?: AbortSignal;
  extractPdf?: typeof extractLibraryPdfText;
  runImageOcr?: typeof runLibraryImageOcr;
}

const imageExtensions = new Set(["png", "jpg", "jpeg", "webp"]);
const extractedTextUtf8Budget = 320_000;
const encoder = new TextEncoder();

export function libraryAttachmentExtractionMode(extension: string): LibraryAttachmentExtractionMode | null {
  const normalized = extension.trim().toLowerCase();

  if (normalized === "pdf") {
    return "pdf-text";
  }

  return imageExtensions.has(normalized) ? "image-ocr" : null;
}

function normalizeExtractedText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

function sliceToUtf8Budget(value: string, byteBudget: number) {
  if (encoder.encode(value).byteLength <= byteBudget) {
    return value;
  }

  let low = 0;
  let high = Math.min(value.length, libraryReaderTextMaxLength);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);

    if (encoder.encode(candidate).byteLength <= byteBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let end = low;
  const previousCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end).trimEnd();
}

function extractedReaderBlocks(value: string) {
  const normalized = normalizeExtractedText(value);
  const characterBounded = normalized.slice(0, libraryReaderTextMaxLength);
  const bounded = sliceToUtf8Budget(characterBounded, extractedTextUtf8Budget);
  const blocks: LibraryReaderBlock[] = [];

  let offset = 0;

  while (offset < bounded.length && blocks.length < libraryReaderBlockMaxCount) {
    let end = Math.min(bounded.length, offset + libraryReaderBlockTextMaxLength);

    if (end < bounded.length) {
      const lineBreak = bounded.lastIndexOf("\n", end);
      const whitespace = bounded.lastIndexOf(" ", end);
      const naturalBreak = Math.max(lineBreak, whitespace);
      if (naturalBreak > offset + Math.floor(libraryReaderBlockTextMaxLength / 2)) {
        end = naturalBreak + 1;
      }
    }

    const previousCodeUnit = bounded.charCodeAt(end - 1);
    const nextCodeUnit = bounded.charCodeAt(end);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
      end -= 1;
    }

    const text = bounded.slice(offset, end).trim();
    if (text) {
      blocks.push({ id: nextLibraryId(), kind: "paragraph", text });
    }
    offset = end;
  }

  return {
    blocks,
    normalizedCharacters: normalized.length,
    storedCharacters: blocks.reduce((total, block) => total + block.text.length, 0),
    truncated: bounded.length < normalized.length
  };
}

function pdfText(result: LibraryPdfTextResult) {
  return result.pages
    .filter((page) => page.text)
    .map((page) => `PDF ${page.pageNumber}쪽\n${page.text}`)
    .join("\n\n");
}

export async function extractLibraryAttachmentText(
  bytes: Uint8Array,
  options: ExtractLibraryAttachmentOptions
): Promise<LibraryAttachmentExtractionResult> {
  const mode = libraryAttachmentExtractionMode(options.extension);

  if (!mode) {
    throw new Error("이 첨부파일 형식은 텍스트 추출을 지원하지 않습니다.");
  }

  if (mode === "pdf-text") {
    const result = await (options.extractPdf ?? extractLibraryPdfText)(bytes, { signal: options.signal });
    const converted = extractedReaderBlocks(pdfText(result));

    return {
      confidence: null,
      likelyScanned: result.likelyScanned,
      mode,
      readerBlocks: converted.blocks,
      sourceTextCharacters: converted.normalizedCharacters,
      storedTextCharacters: converted.storedCharacters,
      truncated: result.truncated || converted.truncated
    };
  }

  const mimeType = safePublicShareAttachmentMimeType(options.extension);
  if (!mimeType || !imageExtensions.has(options.extension.trim().toLowerCase())) {
    throw new Error("PNG, JPEG, WebP 이미지만 OCR을 실행할 수 있습니다.");
  }

  const result: LibraryImageOcrResult = await (options.runImageOcr ?? runLibraryImageOcr)(
    new Blob([bytes.slice().buffer], { type: mimeType }),
    {
      languages: ["kor", "eng"],
      onProgress: options.onOcrProgress,
      signal: options.signal
    }
  );
  const converted = extractedReaderBlocks(result.text);

  return {
    confidence: result.confidence,
    likelyScanned: false,
    mode,
    readerBlocks: converted.blocks,
    sourceTextCharacters: converted.normalizedCharacters,
    storedTextCharacters: converted.storedCharacters,
    truncated: converted.truncated
  };
}

export const libraryExtractedTextUtf8BudgetForTest = extractedTextUtf8Budget;
