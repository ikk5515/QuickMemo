import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_VAULT_ASSET_BYTES,
  MAX_VAULT_RASTER_PREVIEW_DIMENSION,
  decodeVaultAsset,
  encodeVaultAsset,
  normalizeVaultAssetMimeType,
  safeVaultAssetPreviewKind
} from "./vaultAsset";

function pngBytes(width: number, height: number) {
  const bytes = new Uint8Array(57);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, 0);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  view.setUint32(45, 0);
  bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}

function jpegBytes(width: number, height: number) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
    0x01,
    0xff, 0xd9
  ]);
}

function webpLosslessBytes(width: number, height: number) {
  const bytes = new Uint8Array(26);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  view.setUint32(16, 5, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) + ((height - 1) * 16_384), true);
  return bytes;
}

function writeVp8Payload(bytes: Uint8Array, offset: number, width: number, height: number) {
  bytes.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a], offset);
  bytes[offset + 6] = width & 0xff;
  bytes[offset + 7] = (width >>> 8) & 0x3f;
  bytes[offset + 8] = height & 0xff;
  bytes[offset + 9] = (height >>> 8) & 0x3f;
}

function webpLossyBytes(width: number, height: number) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8 "), 8);
  view.setUint32(16, 10, true);
  writeVp8Payload(bytes, 20, width, height);
  return bytes;
}

function webpExtendedBytes(width: number, height: number, animated = false) {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  view.setUint32(16, 10, true);
  bytes[20] = animated ? 0x02 : 0;
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  bytes.set([
    widthMinusOne & 0xff,
    (widthMinusOne >>> 8) & 0xff,
    (widthMinusOne >>> 16) & 0xff
  ], 24);
  bytes.set([
    heightMinusOne & 0xff,
    (heightMinusOne >>> 8) & 0xff,
    (heightMinusOne >>> 16) & 0xff
  ], 27);
  bytes.set(new TextEncoder().encode("VP8 "), 30);
  view.setUint32(34, 10, true);
  writeVp8Payload(bytes, 38, width, height);
  return bytes;
}

describe("encrypted Vault asset payload", () => {
  it("round-trips canonical bytes and MIME metadata without plaintext fields", () => {
    const encoded = encodeVaultAsset(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), " IMAGE/PNG ");
    expect(JSON.parse(encoded)).toMatchObject({ version: 1, byteLength: 8, mimeType: "image/png" });
    expect(decodeVaultAsset(encoded)).toEqual({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: "image/png"
    });
  });

  it("rejects oversized, malformed and non-canonical payloads", () => {
    expect(() => encodeVaultAsset(new Uint8Array(MAX_INLINE_VAULT_ASSET_BYTES + 1), "image/png")).toThrow("이하");
    expect(() => decodeVaultAsset('{"version":1,"byteLength":1,"data":"YQ","mimeType":"text/plain"}')).toThrow("형식");
    expect(() => decodeVaultAsset('{"version":1,"byteLength":2,"data":"YQ==","mimeType":"text/plain"}')).toThrow("손상");
    expect(normalizeVaultAssetMimeType("text/html; charset=utf-8")).toBe("application/octet-stream");
  });

  it("embeds only signature-matched static images and PDFs", () => {
    expect(safeVaultAssetPreviewKind({
      bytes: jpegBytes(1_920, 1_080),
      mimeType: "image/jpeg"
    })).toBe("image");
    expect(safeVaultAssetPreviewKind({
      bytes: pngBytes(800, 600),
      mimeType: "image/png"
    })).toBe("image");
    expect(safeVaultAssetPreviewKind({
      bytes: webpLosslessBytes(640, 480),
      mimeType: "image/webp"
    })).toBe("image");
    expect(safeVaultAssetPreviewKind({
      bytes: webpLossyBytes(1_280, 720),
      mimeType: "image/webp"
    })).toBe("image");
    expect(safeVaultAssetPreviewKind({
      bytes: webpExtendedBytes(1_280, 720),
      mimeType: "image/webp"
    })).toBe("image");
    expect(safeVaultAssetPreviewKind({
      bytes: new TextEncoder().encode("%PDF-1.7"),
      mimeType: "application/pdf"
    })).toBe("pdf");
    expect(safeVaultAssetPreviewKind({
      bytes: new TextEncoder().encode("<svg><script/></svg>"),
      mimeType: "image/svg+xml"
    })).toBeNull();
    expect(safeVaultAssetPreviewKind({
      bytes: new TextEncoder().encode("<html>"),
      mimeType: "image/png"
    })).toBeNull();
  });

  it("keeps malformed and decompression-bomb raster headers download-only", () => {
    expect(safeVaultAssetPreviewKind({
      bytes: pngBytes(MAX_VAULT_RASTER_PREVIEW_DIMENSION + 1, 1),
      mimeType: "image/png"
    })).toBeNull();
    expect(safeVaultAssetPreviewKind({
      bytes: jpegBytes(8_000, 5_000),
      mimeType: "image/jpeg"
    })).toBeNull();
    expect(safeVaultAssetPreviewKind({
      bytes: webpLosslessBytes(MAX_VAULT_RASTER_PREVIEW_DIMENSION + 1, 1),
      mimeType: "image/webp"
    })).toBeNull();
    expect(safeVaultAssetPreviewKind({
      bytes: pngBytes(320, 240).subarray(0, 24),
      mimeType: "image/png"
    })).toBeNull();
    expect(safeVaultAssetPreviewKind({
      bytes: jpegBytes(320, 240).subarray(0, 9),
      mimeType: "image/jpeg"
    })).toBeNull();
    const malformedWebp = webpLosslessBytes(320, 240);
    malformedWebp[4] = 0;
    expect(safeVaultAssetPreviewKind({ bytes: malformedWebp, mimeType: "image/webp" })).toBeNull();
    expect(safeVaultAssetPreviewKind({
      bytes: webpExtendedBytes(320, 240, true),
      mimeType: "image/webp"
    })).toBeNull();
    const mismatchedCanvas = webpExtendedBytes(320, 240);
    mismatchedCanvas[24] = 0;
    expect(safeVaultAssetPreviewKind({ bytes: mismatchedCanvas, mimeType: "image/webp" })).toBeNull();
    const jpegWithoutScan = jpegBytes(320, 240).subarray(0, 21);
    expect(safeVaultAssetPreviewKind({ bytes: jpegWithoutScan, mimeType: "image/jpeg" })).toBeNull();
    const jpegWithoutEnd = jpegBytes(320, 240).subarray(0, -2);
    expect(safeVaultAssetPreviewKind({ bytes: jpegWithoutEnd, mimeType: "image/jpeg" })).toBeNull();
    const malformedScan = jpegBytes(320, 240);
    malformedScan[23] = 0x02;
    expect(safeVaultAssetPreviewKind({ bytes: malformedScan, mimeType: "image/jpeg" })).toBeNull();
  });
});
