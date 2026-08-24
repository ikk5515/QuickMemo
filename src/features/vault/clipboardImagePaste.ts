import {
  safeRasterImageBytes,
  safeRasterMimeType,
  type SafeRasterMimeType
} from "../../lib/safeRasterImage";
import {
  MAX_INLINE_VAULT_ASSET_BYTES,
  MAX_VAULT_RASTER_PREVIEW_DIMENSION,
  MAX_VAULT_RASTER_PREVIEW_PIXELS,
  safeVaultAssetPreviewKind
} from "./vaultAsset";
import { normalizeVaultPath } from "./interop/path";

export const MAX_VAULT_CLIPBOARD_IMAGES = 8;
export const MAX_VAULT_CLIPBOARD_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_VAULT_CLIPBOARD_TRANSCODE_MS = 8_000;
export const MAX_VAULT_CLIPBOARD_TRANSCODE_DIMENSION = 2_048;
export const MAX_VAULT_CLIPBOARD_TRANSCODE_PIXELS = 4_000_000;
export const VAULT_MARKDOWN_IMAGE_ACCEPT = [
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  "image/jpeg",
  "image/png",
  "image/webp"
].join(",");

const genericClipboardMimeTypes = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream"
]);
const rasterMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
const transcodeQualities = [0.88, 0.76, 0.64, 0.52] as const;
const maximumResizePasses = 4;

export interface PreparedVaultClipboardImage {
  bytes: Uint8Array;
  extension: "jpg" | "png" | "webp";
  mimeType: SafeRasterMimeType;
}

interface ClipboardImageTransfer {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{
    getAsFile(): File | null;
    kind: string;
    type: string;
  }> | null;
}

export interface VaultClipboardImageTranscodeInput {
  bytes: Uint8Array;
  deadline?: number;
  mimeType: SafeRasterMimeType;
  signal?: AbortSignal;
}

export interface VaultClipboardImageTranscodeResult {
  bytes: Uint8Array;
  mimeType: SafeRasterMimeType;
}

export type VaultClipboardImageTranscoder = (
  input: VaultClipboardImageTranscodeInput
) => Promise<VaultClipboardImageTranscodeResult>;

interface ClipboardFileCandidate {
  advertisedType: string;
  file: File;
}

function normalizedMimeType(value: string | undefined) {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function normalizedSafeRasterMimeType(value: string | undefined) {
  const normalized = normalizedMimeType(value);
  if (normalized === "image/x-png") return "image/png";
  if (normalized === "image/pjpeg") return "image/jpeg";
  return safeRasterMimeType(normalized);
}

function genericClipboardMimeType(value: string | undefined) {
  return genericClipboardMimeTypes.has(normalizedMimeType(value));
}

function classifyCandidate({ advertisedType, file }: ClipboardFileCandidate) {
  const advertised = normalizedMimeType(advertisedType) || normalizedMimeType(file.type);
  if (normalizedSafeRasterMimeType(advertised)) return "supported" as const;
  if (genericClipboardMimeType(advertised)) return "generic" as const;
  if (advertised.startsWith("image/")) return "unsupported-image" as const;
  return "other" as const;
}

function uniqueCandidateFiles(candidates: readonly ClipboardFileCandidate[]) {
  const seen = new Set<File>();
  return candidates.flatMap(({ file }) => {
    if (seen.has(file)) return [];
    seen.add(file);
    return [file];
  });
}

function usableClipboardFiles(candidates: readonly ClipboardFileCandidate[]) {
  return uniqueCandidateFiles(candidates.filter((candidate) => {
    const classification = classifyCandidate(candidate);
    return classification === "supported" || classification === "generic";
  }));
}

function imageFilesFromItems(items: ClipboardImageTransfer["items"]) {
  return Array.from(items ?? []).flatMap((item): ClipboardFileCandidate[] => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [{ advertisedType: item.type, file }] : [];
  });
}

/**
 * Clipboard implementations expose image files through either `items` or
 * `files`. Prefer `items` so the same image is not uploaded twice when a
 * browser populates both collections.
 */
export function vaultClipboardImageFiles(transfer: ClipboardImageTransfer | null) {
  if (!transfer) return [];
  const itemCandidates = imageFilesFromItems(transfer.items);
  const itemFiles = usableClipboardFiles(itemCandidates);
  if (itemFiles.length) return itemFiles;

  const fileCandidates = Array.from(transfer.files ?? []).map((file) => ({
    advertisedType: file.type,
    file
  }));
  const files = usableClipboardFiles(fileCandidates);
  if (files.length) return files;

  const unsupported = [...itemCandidates, ...fileCandidates].find((candidate) => (
    classifyCandidate(candidate) === "unsupported-image"
  ));
  return unsupported ? [unsupported.file] : [];
}

export function vaultSelectedImageFiles(files: ArrayLike<File> | null | undefined) {
  const candidates = Array.from(files ?? []).map((file) => ({
    advertisedType: file.type,
    file
  }));
  const usable = usableClipboardFiles(candidates);
  if (usable.length) return usable;
  const unsupported = candidates.find((candidate) => {
    const classification = classifyCandidate(candidate);
    return classification === "unsupported-image";
  });
  return unsupported ? [unsupported.file] : [];
}

function extensionForMimeType(mimeType: SafeRasterMimeType): PreparedVaultClipboardImage["extension"] {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function detectedSafeRasterMimeType(bytes: Uint8Array): SafeRasterMimeType | null {
  const detected = rasterMimeTypes.filter((mimeType) => (
    safeVaultAssetPreviewKind({ bytes, mimeType }) === "image"
  ));
  return detected.length === 1 ? detected[0] : null;
}

function validatedClipboardRasterMimeType(bytes: Uint8Array, declaredType: string) {
  const declared = normalizedSafeRasterMimeType(declaredType);
  if (declared) {
    return safeVaultAssetPreviewKind({ bytes, mimeType: declared }) === "image"
      ? declared
      : null;
  }
  return genericClipboardMimeType(declaredType)
    ? detectedSafeRasterMimeType(bytes)
    : null;
}

function detectedSafeSourceRasterMimeType(bytes: Uint8Array): SafeRasterMimeType | null {
  const detected = rasterMimeTypes.filter((mimeType) => safeRasterImageBytes(bytes, mimeType));
  return detected.length === 1 ? detected[0] : null;
}

function validatedClipboardSourceRasterMimeType(bytes: Uint8Array, declaredType: string) {
  const declared = normalizedSafeRasterMimeType(declaredType);
  if (declared) {
    return safeRasterImageBytes(bytes, declared) ? declared : null;
  }
  return genericClipboardMimeType(declaredType)
    ? detectedSafeSourceRasterMimeType(bytes)
    : null;
}

function rasterBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : Uint8Array.from(bytes).buffer;
}

interface DecodedClipboardRaster {
  height: number;
  release(): void;
  source: CanvasImageSource;
  width: number;
}

function waitForClipboardOperation<T>(operation: Promise<T>, signal?: AbortSignal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(
      signal.reason ?? new DOMException("이미지 추가가 취소되었습니다.", "AbortError")
    ));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

async function readClipboardBlobBytes(blob: Blob, signal: AbortSignal) {
  const operation = blob.arrayBuffer();
  try {
    return new Uint8Array(await waitForClipboardOperation(operation, signal));
  } catch (caught) {
    if (signal.aborted) {
      void operation.then((buffer) => {
        new Uint8Array(buffer).fill(0);
      }, () => undefined);
    }
    throw caught;
  }
}

async function decodeClipboardRaster(
  blob: Blob,
  signal?: AbortSignal
): Promise<DecodedClipboardRaster> {
  signal?.throwIfAborted();
  if (typeof createImageBitmap === "function") {
    let bitmapOperation: Promise<ImageBitmap> | null = null;
    try {
      bitmapOperation = createImageBitmap(blob, { imageOrientation: "from-image" });
      const bitmap = await waitForClipboardOperation(bitmapOperation, signal);
      if (signal?.aborted) {
        bitmap.close();
        signal.throwIfAborted();
      }
      return {
        height: bitmap.height,
        release: () => bitmap.close(),
        source: bitmap,
        width: bitmap.width
      };
    } catch (caught) {
      if (signal?.aborted) {
        if (bitmapOperation) {
          void bitmapOperation.then((bitmap) => bitmap.close(), () => undefined);
        }
        throw caught;
      }
    }
  }

  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("이 브라우저에서는 큰 이미지를 안전하게 축소할 수 없습니다.");
  }
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(objectUrl);
  };
  const abort = () => {
    image.src = "";
    release();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  image.decoding = "async";
  image.src = objectUrl;
  try {
    await waitForClipboardOperation(image.decode(), signal);
    signal?.throwIfAborted();
    signal?.removeEventListener("abort", abort);
    return {
      height: image.naturalHeight,
      release,
      source: image,
      width: image.naturalWidth
    };
  } catch (caught) {
    signal?.removeEventListener("abort", abort);
    image.src = "";
    release();
    throw caught;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: "image/jpeg" | "image/webp",
  quality: number,
  signal: AbortSignal | undefined,
  deadline: number
) {
  return new Promise<Blob | null>((resolve, reject) => {
    signal?.throwIfAborted();
    const remaining = Math.max(1, deadline - Date.now());
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(
      signal?.reason ?? new DOMException("이미지 추가가 취소되었습니다.", "AbortError")
    ));
    const timeout = window.setTimeout(() => finish(() => reject(
      new Error("이미지 축소 시간이 초과되었습니다.")
    )), remaining);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    canvas.toBlob((blob) => finish(() => resolve(blob)), mimeType, quality);
  });
}

async function encodedClipboardRaster(
  canvas: HTMLCanvasElement,
  mimeType: "image/jpeg" | "image/webp",
  signal: AbortSignal,
  deadline: number
) {
  for (const quality of transcodeQualities) {
    const blob = await canvasToBlob(canvas, mimeType, quality, signal, deadline);
    if (!blob || normalizedSafeRasterMimeType(blob.type) !== mimeType) continue;
    if (blob.size <= 0 || blob.size > MAX_INLINE_VAULT_ASSET_BYTES) continue;
    const bytes = await readClipboardBlobBytes(blob, signal);
    try {
      signal?.throwIfAborted();
      if (
        bytes.byteLength === blob.size
        && safeVaultAssetPreviewKind({ bytes, mimeType }) === "image"
      ) {
        return { bytes, mimeType } satisfies VaultClipboardImageTranscodeResult;
      }
    } catch (caught) {
      bytes.fill(0);
      throw caught;
    }
    bytes.fill(0);
  }
  return null;
}

export async function transcodeVaultClipboardImage({
  bytes,
  deadline: requestedDeadline,
  mimeType,
  signal
}: VaultClipboardImageTranscodeInput): Promise<VaultClipboardImageTranscodeResult> {
  const now = Date.now();
  const deadline = requestedDeadline === undefined
    ? now + MAX_VAULT_CLIPBOARD_TRANSCODE_MS
    : Math.min(requestedDeadline, now + MAX_VAULT_CLIPBOARD_TRANSCODE_MS);
  if (!Number.isFinite(deadline) || deadline <= now) {
    throw new Error("이미지 배치 축소 시간이 초과되었습니다.");
  }
  const deadlineController = new AbortController();
  let deadlineExceeded = false;
  const abortFromCaller = () => deadlineController.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
  }
  const timeout = globalThis.setTimeout(() => {
    deadlineExceeded = true;
    deadlineController.abort(new Error("이미지 배치 축소 시간이 초과되었습니다."));
  }, deadline - now);
  const boundedSignal = deadlineController.signal;
  try {
    boundedSignal.throwIfAborted();
    if (!safeRasterImageBytes(bytes, mimeType)) {
      throw new Error("이미지 형식이나 크기가 안전한 미리보기 제한을 벗어났습니다.");
    }
    if (typeof document === "undefined") {
      throw new Error("이 브라우저에서는 큰 이미지를 안전하게 축소할 수 없습니다.");
    }

    const decoded = await decodeClipboardRaster(
      new Blob([rasterBlobPart(bytes)], { type: mimeType }),
      boundedSignal
    );
    try {
      if (
        !Number.isSafeInteger(decoded.width)
        || !Number.isSafeInteger(decoded.height)
        || decoded.width <= 0
        || decoded.height <= 0
        || decoded.width > MAX_VAULT_RASTER_PREVIEW_DIMENSION
        || decoded.height > MAX_VAULT_RASTER_PREVIEW_DIMENSION
        || decoded.width * decoded.height > MAX_VAULT_RASTER_PREVIEW_PIXELS
      ) {
        throw new Error("이미지 해상도가 안전한 축소 제한을 벗어났습니다.");
      }

      const initialScale = Math.min(
        1,
        MAX_VAULT_CLIPBOARD_TRANSCODE_DIMENSION / decoded.width,
        MAX_VAULT_CLIPBOARD_TRANSCODE_DIMENSION / decoded.height,
        Math.sqrt(MAX_VAULT_CLIPBOARD_TRANSCODE_PIXELS / (decoded.width * decoded.height))
      );
      let width = Math.max(1, Math.floor(decoded.width * initialScale));
      let height = Math.max(1, Math.floor(decoded.height * initialScale));
      for (let pass = 0; pass < maximumResizePasses; pass += 1) {
        boundedSignal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("이미지 축소 시간이 초과되었습니다.");
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("이 브라우저에서는 큰 이미지를 안전하게 축소할 수 없습니다.");
        context.clearRect(0, 0, width, height);
        context.drawImage(decoded.source, 0, 0, width, height);

        const webp = await encodedClipboardRaster(canvas, "image/webp", boundedSignal, deadline);
        if (webp) return webp;

        context.save();
        context.globalCompositeOperation = "destination-over";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.restore();
        const jpeg = await encodedClipboardRaster(canvas, "image/jpeg", boundedSignal, deadline);
        if (jpeg) return jpeg;

        width = Math.max(1, Math.floor(width * 0.72));
        height = Math.max(1, Math.floor(height * 0.72));
      }
    } finally {
      decoded.release();
    }
    throw new Error("이미지를 350KB 이하의 안전한 정적 형식으로 축소하지 못했습니다.");
  } catch (caught) {
    if (deadlineExceeded) {
      throw new Error("이미지 배치 축소 시간이 초과되었습니다.");
    }
    throw caught;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function prepareVaultClipboardImages(
  files: readonly File[],
  options: {
    signal?: AbortSignal;
    transcode?: VaultClipboardImageTranscoder;
  } = {}
): Promise<PreparedVaultClipboardImage[]> {
  if (!files.length) return [];
  if (files.length > MAX_VAULT_CLIPBOARD_IMAGES) {
    throw new Error(`이미지는 한 번에 ${MAX_VAULT_CLIPBOARD_IMAGES}개까지 추가할 수 있습니다.`);
  }

  let batchBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error("빈 이미지나 크기를 확인할 수 없는 이미지는 추가할 수 없습니다.");
    }
    if (file.size > MAX_VAULT_CLIPBOARD_SOURCE_BYTES) {
      throw new Error(`원본 이미지는 파일당 ${Math.floor(MAX_VAULT_CLIPBOARD_SOURCE_BYTES / (1024 * 1024))}MB 이하만 안전하게 처리할 수 있습니다.`);
    }
    batchBytes += file.size;
    if (!Number.isSafeInteger(batchBytes) || batchBytes > MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES) {
      throw new Error(`한 번에 추가할 원본 이미지 합계는 ${Math.floor(MAX_VAULT_CLIPBOARD_BATCH_SOURCE_BYTES / (1024 * 1024))}MB 이하만 안전하게 처리할 수 있습니다.`);
    }
  }

  const prepared: PreparedVaultClipboardImage[] = [];
  const batchDeadline = Date.now() + MAX_VAULT_CLIPBOARD_TRANSCODE_MS;
  const batchController = new AbortController();
  const abortBatchFromCaller = () => batchController.abort(options.signal?.reason);
  if (options.signal?.aborted) abortBatchFromCaller();
  else {
    options.signal?.addEventListener("abort", abortBatchFromCaller, { once: true });
    if (options.signal?.aborted) abortBatchFromCaller();
  }
  const batchTimeout = globalThis.setTimeout(() => {
    batchController.abort(new Error("이미지 배치 준비 시간이 초과되었습니다."));
  }, MAX_VAULT_CLIPBOARD_TRANSCODE_MS);
  const batchSignal = batchController.signal;
  try {
    for (const file of files) {
      batchSignal.throwIfAborted();
      const bytes = await readClipboardBlobBytes(file, batchSignal);
      try {
        batchSignal.throwIfAborted();
      } catch (caught) {
        bytes.fill(0);
        throw caught;
      }
      if (bytes.byteLength !== file.size) {
        bytes.fill(0);
        throw new Error("이미지 크기를 안전하게 확인하지 못했습니다.");
      }
      const mimeType = bytes.byteLength > MAX_INLINE_VAULT_ASSET_BYTES
        ? validatedClipboardSourceRasterMimeType(bytes, file.type)
        : validatedClipboardRasterMimeType(bytes, file.type);
      if (!mimeType) {
        bytes.fill(0);
        throw new Error("서명과 해상도를 확인한 정적 PNG, JPG, WEBP 이미지만 추가할 수 있습니다.");
      }

      if (bytes.byteLength <= MAX_INLINE_VAULT_ASSET_BYTES) {
        prepared.push({
          bytes,
          extension: extensionForMimeType(mimeType),
          mimeType
        });
        continue;
      }

      let transcoded: VaultClipboardImageTranscodeResult | null = null;
      try {
        transcoded = await (options.transcode ?? transcodeVaultClipboardImage)({
          bytes,
          deadline: batchDeadline,
          mimeType,
          signal: batchSignal
        });
      } finally {
        bytes.fill(0);
      }
      try {
        batchSignal.throwIfAborted();
        const transcodedMimeType = normalizedSafeRasterMimeType(transcoded.mimeType);
        if (
          !transcodedMimeType
          || transcodedMimeType !== transcoded.mimeType
          || transcoded.bytes.byteLength <= 0
          || transcoded.bytes.byteLength > MAX_INLINE_VAULT_ASSET_BYTES
          || safeVaultAssetPreviewKind({
            bytes: transcoded.bytes,
            mimeType: transcodedMimeType
          }) !== "image"
        ) {
          throw new Error("축소한 이미지의 형식이나 크기를 안전하게 확인하지 못했습니다.");
        }
        prepared.push({
          bytes: transcoded.bytes,
          extension: extensionForMimeType(transcodedMimeType),
          mimeType: transcodedMimeType
        });
      } catch (caught) {
        transcoded.bytes.fill(0);
        throw caught;
      }
    }
    return prepared;
  } catch (error) {
    clearPreparedVaultClipboardImages(prepared);
    throw error;
  } finally {
    globalThis.clearTimeout(batchTimeout);
    options.signal?.removeEventListener("abort", abortBatchFromCaller);
  }
}

export function clearPreparedVaultClipboardImages(images: readonly PreparedVaultClipboardImage[]) {
  for (const image of images) {
    image.bytes.fill(0);
  }
}

const MAX_VAULT_PASTED_IMAGE_TITLE_LENGTH = 180;
const MAX_VAULT_PASTED_IMAGE_ORDINAL_DIGITS = 8;
const pastedImageExtensions = new Set(["jpg", "png", "webp"]);

function truncateWithoutSplittingSurrogate(value: string, maximumLength: number) {
  let truncated = value.slice(0, maximumLength);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trimEnd();
}

export function vaultClipboardImageTitleStem(noteTitle: string) {
  const normalized = noteTitle.trim().normalize("NFC").replace(/\.md$/iu, "");
  const embedSafe = normalized
    .replace(/[\p{Cc}%/\\|#[\]]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim() || "노트";
  const longestSuffixLength = ` -${"9".repeat(MAX_VAULT_PASTED_IMAGE_ORDINAL_DIGITS)}.webp`.length;
  return truncateWithoutSplittingSurrogate(
    embedSafe,
    MAX_VAULT_PASTED_IMAGE_TITLE_LENGTH - longestSuffixLength
  ) || "노트";
}

function vaultClipboardImageTitleFromStem(
  image: Pick<PreparedVaultClipboardImage, "extension">,
  stem: string,
  ordinal: number
) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal >= 10 ** MAX_VAULT_PASTED_IMAGE_ORDINAL_DIGITS) {
    throw new Error("붙여넣은 이미지 순번을 안전하게 만들 수 없습니다.");
  }
  return `${stem} -${ordinal}.${image.extension}`;
}

export function vaultClipboardImageBaseTitle(
  image: Pick<PreparedVaultClipboardImage, "extension">,
  noteTitle: string,
  ordinal: number
) {
  return vaultClipboardImageTitleFromStem(image, vaultClipboardImageTitleStem(noteTitle), ordinal);
}

function collisionKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function reserveVaultClipboardImageTitles(
  existingTitles: Iterable<string>,
  images: readonly Pick<PreparedVaultClipboardImage, "extension">[],
  noteTitle: string
) {
  const stem = vaultClipboardImageTitleStem(noteTitle);
  const reservedTitles = new Set<string>();
  const reservedOrdinals = new Set<number>();
  const ordinalPrefix = collisionKey(`${stem} -`);
  for (const existingTitle of existingTitles) {
    const key = collisionKey(existingTitle);
    reservedTitles.add(key);
    if (!key.startsWith(ordinalPrefix)) continue;
    const remainder = key.slice(ordinalPrefix.length);
    const dotIndex = remainder.lastIndexOf(".");
    const extension = dotIndex > 0 ? remainder.slice(dotIndex + 1) : "";
    const ordinalText = dotIndex > 0 ? remainder.slice(0, dotIndex) : "";
    if (/^[1-9]\d{0,7}$/u.test(ordinalText) && pastedImageExtensions.has(extension)) {
      reservedOrdinals.add(Number(ordinalText));
    }
  }

  let nextOrdinal = 1;
  return images.map((image) => {
    while (reservedOrdinals.has(nextOrdinal)) nextOrdinal += 1;
    let title = vaultClipboardImageTitleFromStem(image, stem, nextOrdinal);
    while (reservedTitles.has(collisionKey(title))) {
      nextOrdinal += 1;
      while (reservedOrdinals.has(nextOrdinal)) nextOrdinal += 1;
      title = vaultClipboardImageTitleFromStem(image, stem, nextOrdinal);
    }
    reservedOrdinals.add(nextOrdinal);
    reservedTitles.add(collisionKey(title));
    nextOrdinal += 1;
    return title;
  });
}

export function vaultClipboardImageEmbedSource(paths: readonly string[]) {
  const normalizedPaths = paths.map((path) => {
    if (!path || /[\r\n|#]/u.test(path) || path.includes("[[") || path.includes("]]")) {
      throw new Error("붙여넣은 이미지의 안전한 내부 링크를 만들 수 없습니다.");
    }
    try {
      return normalizeVaultPath(path);
    } catch {
      throw new Error("붙여넣은 이미지의 안전한 내부 링크를 만들 수 없습니다.");
    }
  });
  return normalizedPaths.map((path) => `![[${path}]]`).join("\n");
}
