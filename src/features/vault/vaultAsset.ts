import { base64ToBytes, bytesToBase64 } from "../../lib/crypto";
import { maxSafeRasterDimension, maxSafeRasterPixels } from "../../lib/safeRasterImage";

export const VAULT_ASSET_FORMAT_VERSION = 1 as const;

// Assets are stored inside the same encrypted Firestore note envelope as the
// rest of the Vault. The raw limit leaves room for base64 expansion, JSON,
// AES-GCM expansion and the encrypted revision snapshot under Firestore's
// document limit. Larger files must not silently spill into plaintext storage.
export const MAX_INLINE_VAULT_ASSET_BYTES = 350 * 1024;
export const MAX_VAULT_RASTER_PREVIEW_DIMENSION = maxSafeRasterDimension;
export const MAX_VAULT_RASTER_PREVIEW_PIXELS = maxSafeRasterPixels;

const MAX_RASTER_CONTAINER_CHUNKS = 256;
const MAX_JPEG_HEADER_SCAN_BYTES = 64 * 1024;

export interface VaultAssetPayloadV1 {
  version: typeof VAULT_ASSET_FORMAT_VERSION;
  byteLength: number;
  data: string;
  mimeType: string;
}

export interface DecodedVaultAsset {
  bytes: Uint8Array;
  mimeType: string;
}

export type SafeVaultAssetPreviewKind = "image" | "pdf";

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function normalizeVaultAssetMimeType(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase("en-US") ?? "";
  return MIME_TYPE_PATTERN.test(normalized) ? normalized : "application/octet-stream";
}

export function encodeVaultAsset(bytes: Uint8Array, mimeType?: string) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INLINE_VAULT_ASSET_BYTES) {
    throw new Error(`첨부 파일은 ${Math.floor(MAX_INLINE_VAULT_ASSET_BYTES / 1024)}KB 이하만 Vault에 암호화해 저장할 수 있습니다.`);
  }
  return JSON.stringify({
    version: VAULT_ASSET_FORMAT_VERSION,
    byteLength: bytes.byteLength,
    data: bytesToBase64(bytes),
    mimeType: normalizeVaultAssetMimeType(mimeType)
  } satisfies VaultAssetPayloadV1);
}

export function decodeVaultAsset(source: string): DecodedVaultAsset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }
  const candidate = parsed as Partial<VaultAssetPayloadV1>;
  if (
    candidate.version !== VAULT_ASSET_FORMAT_VERSION
    || !Number.isSafeInteger(candidate.byteLength)
    || (candidate.byteLength ?? -1) < 0
    || (candidate.byteLength ?? 0) > MAX_INLINE_VAULT_ASSET_BYTES
    || typeof candidate.data !== "string"
    || candidate.data.length > Math.ceil(MAX_INLINE_VAULT_ASSET_BYTES / 3) * 4
    || !BASE64_PATTERN.test(candidate.data)
    || typeof candidate.mimeType !== "string"
    || candidate.mimeType !== normalizeVaultAssetMimeType(candidate.mimeType)
  ) {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(candidate.data);
  } catch {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }
  if (bytes.byteLength !== candidate.byteLength || bytesToBase64(bytes) !== candidate.data) {
    throw new Error("암호화 첨부 데이터가 손상되었습니다.");
  }
  return { bytes, mimeType: candidate.mimeType };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return bytes.byteLength >= signature.length
    && signature.every((value, index) => bytes[index] === value);
}

interface RasterDimensions {
  height: number;
  width: number;
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
  return (bytes[offset] * 256) + bytes[offset + 1];
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] + (bytes[offset + 1] * 256);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] + (bytes[offset + 1] * 256) + (bytes[offset + 2] * 65_536);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
  return (bytes[offset] * 16_777_216)
    + (bytes[offset + 1] * 65_536)
    + (bytes[offset + 2] * 256)
    + bytes[offset + 3];
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset]
    + (bytes[offset + 1] * 256)
    + (bytes[offset + 2] * 65_536)
    + (bytes[offset + 3] * 16_777_216);
}

function asciiChunkType(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function dimensionsFitPreviewLimit(dimensions: RasterDimensions | null): dimensions is RasterDimensions {
  return dimensions !== null
    && Number.isSafeInteger(dimensions.width)
    && Number.isSafeInteger(dimensions.height)
    && dimensions.width > 0
    && dimensions.height > 0
    && dimensions.width <= MAX_VAULT_RASTER_PREVIEW_DIMENSION
    && dimensions.height <= MAX_VAULT_RASTER_PREVIEW_DIMENSION
    && dimensions.width * dimensions.height <= MAX_VAULT_RASTER_PREVIEW_PIXELS;
}

function pngDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return null;
  }
  let dimensions: RasterDimensions | null = null;
  let offset = 8;
  let chunkCount = 0;
  let sawImageData = false;

  while (offset < bytes.byteLength && chunkCount < MAX_RASTER_CONTAINER_CHUNKS) {
    if (offset + 12 > bytes.byteLength) {
      return null;
    }
    const length = readUint32BigEndian(bytes, offset);
    const type = asciiChunkType(bytes, offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + length + 4;
    if (chunkEnd > bytes.byteLength) {
      return null;
    }
    if (chunkCount === 0) {
      if (type !== "IHDR" || length !== 13) {
        return null;
      }
      dimensions = {
        height: readUint32BigEndian(bytes, dataOffset + 4),
        width: readUint32BigEndian(bytes, dataOffset)
      };
      if (
        bytes[dataOffset + 10] !== 0
        || bytes[dataOffset + 11] !== 0
        || bytes[dataOffset + 12] > 1
      ) {
        return null;
      }
    } else if (type === "IHDR") {
      return null;
    }
    if (type === "acTL") {
      return null;
    }
    if (type === "IDAT") {
      sawImageData = true;
    }
    if (type === "IEND") {
      return length === 0 && sawImageData && chunkEnd === bytes.byteLength ? dimensions : null;
    }
    offset = chunkEnd;
    chunkCount += 1;
  }
  return null;
}

function jpegStartOfFrame(marker: number) {
  // Restrict previews to the sequential/progressive Huffman formats implemented
  // consistently by browsers. Lossless, differential and arithmetic-coded JPEG
  // variants remain authorized downloads instead of entering an image decoder.
  return marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
}

function jpegDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (!startsWith(bytes, [0xff, 0xd8])) {
    return null;
  }
  let dimensions: RasterDimensions | null = null;
  let sawScan = false;
  let markerCount = 0;
  let offset = 2;
  while (offset < bytes.byteLength && markerCount < MAX_RASTER_CONTAINER_CHUNKS) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      return null;
    }
    const marker = bytes[offset];
    offset += 1;
    markerCount += 1;
    if (marker === 0xd9) {
      return dimensions && sawScan && offset === bytes.byteLength ? dimensions : null;
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      return null;
    }
    if (marker === 0x01) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      return null;
    }
    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2) {
      return null;
    }
    const segmentEnd = offset + segmentLength;
    if (
      segmentEnd > bytes.byteLength
      || (!dimensions && segmentEnd > MAX_JPEG_HEADER_SCAN_BYTES)
    ) {
      return null;
    }
    if (jpegStartOfFrame(marker)) {
      if (dimensions || segmentLength < 11 || ![8, 12].includes(bytes[offset + 2])) {
        return null;
      }
      const componentCount = bytes[offset + 7];
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 8 + (componentCount * 3)) {
        return null;
      }
      const componentIds = new Set<number>();
      for (let component = 0; component < componentCount; component += 1) {
        const componentOffset = offset + 8 + (component * 3);
        const componentId = bytes[componentOffset];
        const samplingFactors = bytes[componentOffset + 1];
        const horizontalSampling = samplingFactors >>> 4;
        const verticalSampling = samplingFactors & 0x0f;
        if (
          componentIds.has(componentId)
          || horizontalSampling < 1
          || horizontalSampling > 4
          || verticalSampling < 1
          || verticalSampling > 4
          || bytes[componentOffset + 2] > 3
        ) {
          return null;
        }
        componentIds.add(componentId);
      }
      dimensions = {
        height: readUint16BigEndian(bytes, offset + 3),
        width: readUint16BigEndian(bytes, offset + 5)
      };
    }
    offset = segmentEnd;
    if (marker !== 0xda) {
      continue;
    }

    if (!dimensions) {
      return null;
    }
    const scanComponentCount = bytes[segmentEnd - segmentLength + 2];
    if (
      scanComponentCount < 1
      || scanComponentCount > 4
      || segmentLength !== 6 + (scanComponentCount * 2)
    ) {
      return null;
    }
    const spectralStart = bytes[segmentEnd - 3];
    const spectralEnd = bytes[segmentEnd - 2];
    const approximation = bytes[segmentEnd - 1];
    if (spectralStart > spectralEnd || spectralEnd > 63 || (approximation >>> 4) > 13 || (approximation & 0x0f) > 13) {
      return null;
    }

    let entropyBytes = 0;
    while (offset < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        entropyBytes += 1;
        offset += 1;
        continue;
      }
      const markerStart = offset;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.byteLength) {
        return null;
      }
      const entropyMarker = bytes[offset];
      if (entropyMarker === 0x00) {
        entropyBytes += 1;
        offset += 1;
        continue;
      }
      if (entropyMarker >= 0xd0 && entropyMarker <= 0xd7) {
        offset += 1;
        continue;
      }
      if (entropyBytes === 0) {
        return null;
      }
      offset = markerStart;
      break;
    }
    sawScan = true;
  }
  return null;
}

function vp8Dimensions(bytes: Uint8Array, start: number, end: number): RasterDimensions | null {
  if (
    end - start < 10
    || (bytes[start] & 0x01) !== 0
    || !startsWith(bytes.subarray(start + 3, end), [0x9d, 0x01, 0x2a])
  ) {
    return null;
  }
  return {
    height: readUint16LittleEndian(bytes, start + 8) % 16_384,
    width: readUint16LittleEndian(bytes, start + 6) % 16_384
  };
}

function vp8LosslessDimensions(bytes: Uint8Array, start: number, end: number): RasterDimensions | null {
  if (end - start < 5 || bytes[start] !== 0x2f) {
    return null;
  }
  const packed = readUint32LittleEndian(bytes, start + 1);
  if (Math.floor(packed / 536_870_912) !== 0) {
    return null;
  }
  return {
    height: (Math.floor(packed / 16_384) % 16_384) + 1,
    width: (packed % 16_384) + 1
  };
}

function webpDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (
    bytes.byteLength < 20
    || !startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    || !startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
    || readUint32LittleEndian(bytes, 4) + 8 !== bytes.byteLength
  ) {
    return null;
  }

  let canvas: RasterDimensions | null = null;
  let firstChunkType = "";
  let image: RasterDimensions | null = null;
  let imageChunkCount = 0;
  let offset = 12;
  let chunkCount = 0;
  while (offset < bytes.byteLength && chunkCount < MAX_RASTER_CONTAINER_CHUNKS) {
    if (offset + 8 > bytes.byteLength) {
      return null;
    }
    const type = asciiChunkType(bytes, offset);
    const length = readUint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const paddedEnd = dataEnd + (length % 2);
    if (dataEnd > bytes.byteLength || paddedEnd > bytes.byteLength) {
      return null;
    }
    if (chunkCount === 0) {
      firstChunkType = type;
      if (!["VP8 ", "VP8L", "VP8X"].includes(type)) {
        return null;
      }
    }
    if (type === "ANIM" || type === "ANMF") {
      return null;
    }
    if (type === "VP8X") {
      if (
        chunkCount !== 0
        || length !== 10
        || (bytes[dataOffset] & 0xc3) !== 0
        || bytes[dataOffset + 1] !== 0
        || bytes[dataOffset + 2] !== 0
        || bytes[dataOffset + 3] !== 0
      ) {
        return null;
      }
      canvas = {
        height: readUint24LittleEndian(bytes, dataOffset + 7) + 1,
        width: readUint24LittleEndian(bytes, dataOffset + 4) + 1
      };
    }
    if (type === "VP8 " || type === "VP8L") {
      imageChunkCount += 1;
      image = type === "VP8 "
        ? vp8Dimensions(bytes, dataOffset, dataEnd)
        : vp8LosslessDimensions(bytes, dataOffset, dataEnd);
      if (!image) {
        return null;
      }
    }
    offset = paddedEnd;
    chunkCount += 1;
  }
  if (offset !== bytes.byteLength || imageChunkCount !== 1 || !image) {
    return null;
  }
  if (firstChunkType === "VP8X") {
    return canvas && canvas.width === image.width && canvas.height === image.height ? canvas : null;
  }
  return firstChunkType === "VP8 " || firstChunkType === "VP8L" ? image : null;
}

/**
 * Allows only static raster images with matching signatures and PDFs. SVG,
 * HTML and mismatched MIME claims remain download-only and are never embedded.
 */
export function safeVaultAssetPreviewKind(asset: DecodedVaultAsset): SafeVaultAssetPreviewKind | null {
  if (asset.mimeType === "image/png" && dimensionsFitPreviewLimit(pngDimensions(asset.bytes))) {
    return "image";
  }
  if (asset.mimeType === "image/jpeg" && dimensionsFitPreviewLimit(jpegDimensions(asset.bytes))) {
    return "image";
  }
  if (asset.mimeType === "image/webp" && dimensionsFitPreviewLimit(webpDimensions(asset.bytes))) {
    return "image";
  }
  if (
    asset.mimeType === "application/pdf"
    && startsWith(asset.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
  ) {
    return "pdf";
  }
  return null;
}
