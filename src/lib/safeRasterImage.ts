const maxInlineImageBase64Characters = 1_400_000;
export const maxSafeRasterDimension = 8192;
export const maxSafeRasterPixels = 20_000_000;

export type SafeRasterMimeType = "image/jpeg" | "image/png" | "image/webp";

interface RasterDimensions {
  height: number;
  width: number;
}

export function safeRasterMimeType(value: string): SafeRasterMimeType | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "image/jpg" || normalized === "image/jpeg") {
    return "image/jpeg";
  }

  return normalized === "image/png" || normalized === "image/webp"
    ? normalized
    : null;
}

export function safeRasterImageBytes(bytes: Uint8Array, mimeType: string) {
  const normalizedMimeType = safeRasterMimeType(mimeType);
  const dimensions = normalizedMimeType ? rasterDimensions(bytes, normalizedMimeType) : null;

  return Boolean(dimensions && safeDimensions(dimensions));
}

export function safeRasterDataUrl(value: string) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);

  if (!match || match[2].length > maxInlineImageBase64Characters || match[2].length % 4 !== 0) {
    return false;
  }

  const mimeType = safeRasterMimeType(match[1]);

  if (!mimeType) {
    return false;
  }

  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return safeRasterImageBytes(bytes, mimeType);
  } catch {
    return false;
  }
}

function safeDimensions({ height, width }: RasterDimensions) {
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width > 0
    && height > 0
    && width <= maxSafeRasterDimension
    && height <= maxSafeRasterDimension
    && width * height <= maxSafeRasterPixels;
}

function rasterDimensions(bytes: Uint8Array, mimeType: SafeRasterMimeType): RasterDimensions | null {
  if (mimeType === "image/png") {
    return pngDimensions(bytes);
  }

  if (mimeType === "image/jpeg") {
    return jpegDimensions(bytes);
  }

  return webpDimensions(bytes);
}

function pngDimensions(bytes: Uint8Array): RasterDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  if (
    bytes.length < 33
    || !signature.every((value, index) => bytes[index] === value)
    || ascii(bytes, 12, 16) !== "IHDR"
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(8) !== 13 || pngHasAnimation(bytes, view)) {
    return null;
  }

  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pngHasAnimation(bytes: Uint8Array, view: DataView) {
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const chunkLength = view.getUint32(offset);
    const chunkType = ascii(bytes, offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;

    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      return false;
    }

    if (chunkType === "acTL") {
      return true;
    }

    if (chunkType === "IDAT" || chunkType === "IEND") {
      return false;
    }

    offset = nextOffset;
  }

  return false;
}

function jpegDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }

    if (offset + 1 >= bytes.length) {
      return null;
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];

    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }

    const isStartOfFrame =
      marker >= 0xc0
      && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker);

    if (isStartOfFrame) {
      if (segmentLength < 7) {
        return null;
      }

      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6]
      };
    }

    offset += segmentLength;
  }

  return null;
}

function webpDimensions(bytes: Uint8Array): RasterDimensions | null {
  if (
    bytes.length < 30
    || ascii(bytes, 0, 4) !== "RIFF"
    || ascii(bytes, 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const chunkType = ascii(bytes, 12, 16);

  if (chunkType === "VP8X") {
    if ((bytes[20] & 0x02) !== 0) {
      return null;
    }

    return {
      width: 1 + uint24LittleEndian(bytes, 24),
      height: 1 + uint24LittleEndian(bytes, 27)
    };
  }

  if (chunkType === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: ((bytes[27] << 8) | bytes[26]) & 0x3fff,
      height: ((bytes[29] << 8) | bytes[28]) & 0x3fff
    };
  }

  if (chunkType === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    return {
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + ((bytes[24] & 0x0f) << 10) + (bytes[23] << 2) + (bytes[22] >> 6)
    };
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function uint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
