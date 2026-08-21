import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_VAULT_ASSET_BYTES,
  decodeVaultAsset,
  encodeVaultAsset,
  normalizeVaultAssetMimeType,
  safeVaultAssetPreviewKind
} from "./vaultAsset";

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
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      mimeType: "image/jpeg"
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
});
