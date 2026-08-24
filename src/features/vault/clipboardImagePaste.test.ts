import { describe, expect, it } from "vitest";
import {
  MAX_VAULT_CLIPBOARD_IMAGES,
  clearPreparedVaultClipboardImages,
  prepareVaultClipboardImages,
  reserveVaultClipboardImageTitles,
  vaultClipboardImageEmbedSource,
  vaultClipboardImageFiles
} from "./clipboardImagePaste";
import { MAX_INLINE_VAULT_ASSET_BYTES } from "./vaultAsset";

function pngBytes(width = 2, height = 2) {
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

function imageFile(bytes: Uint8Array, name: string, type: string) {
  const fileBytes = bytes.slice().buffer as ArrayBuffer;
  const file = new File([fileBytes], name, { type });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => fileBytes.slice(0)
  });
  return file;
}

describe("encrypted Vault clipboard image preparation", () => {
  it("prefers clipboard items over duplicate files and keeps unsupported image types for rejection", () => {
    const png = imageFile(pngBytes(), "clipboard.png", "image/png");
    const svg = imageFile(new TextEncoder().encode("<svg/>"), "clipboard.svg", "image/svg+xml");

    expect(vaultClipboardImageFiles({
      files: [png],
      items: [
        { getAsFile: () => png, kind: "file", type: "image/png" },
        { getAsFile: () => svg, kind: "file", type: "image/svg+xml" },
        { getAsFile: () => null, kind: "string", type: "text/plain" }
      ]
    })).toEqual([png, svg]);
  });

  it("accepts a signature-matched static image and clears plaintext bytes on demand", async () => {
    const prepared = await prepareVaultClipboardImages([
      imageFile(pngBytes(), "clipboard.png", "image/png")
    ]);

    expect(prepared).toMatchObject([{ extension: "png", mimeType: "image/png" }]);
    expect(prepared[0].bytes.some((byte) => byte !== 0)).toBe(true);
    clearPreparedVaultClipboardImages(prepared);
    expect(prepared[0].bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects SVG, mismatched signatures, oversized images, and excessive batches", async () => {
    await expect(prepareVaultClipboardImages([
      imageFile(new TextEncoder().encode("<svg><script/></svg>"), "unsafe.svg", "image/svg+xml")
    ])).rejects.toThrow("PNG, JPG, WEBP");
    await expect(prepareVaultClipboardImages([
      imageFile(new TextEncoder().encode("not png"), "fake.png", "image/png")
    ])).rejects.toThrow("안전한 미리보기");
    await expect(prepareVaultClipboardImages([
      imageFile(new Uint8Array(MAX_INLINE_VAULT_ASSET_BYTES + 1), "large.png", "image/png")
    ])).rejects.toThrow("350KB 이하");
    await expect(prepareVaultClipboardImages(Array.from(
      { length: MAX_VAULT_CLIPBOARD_IMAGES + 1 },
      () => imageFile(pngBytes(), "many.png", "image/png")
    ))).rejects.toThrow(`${MAX_VAULT_CLIPBOARD_IMAGES}개`);
  });

  it("reserves deterministic extension-preserving names and produces only wiki embeds", () => {
    const now = new Date(2026, 7, 24, 9, 7, 5);
    const titles = reserveVaultClipboardImageTitles(
      ["붙여넣은 이미지 2026-08-24 09-07-05 1.png"],
      [{ extension: "png" }, { extension: "jpg" }],
      now
    );

    expect(titles).toEqual([
      "붙여넣은 이미지 2026-08-24 09-07-05 1 2.png",
      "붙여넣은 이미지 2026-08-24 09-07-05 2.jpg"
    ]);
    expect(vaultClipboardImageEmbedSource(titles)).toBe(
      "![[붙여넣은 이미지 2026-08-24 09-07-05 1 2.png]]\n"
      + "![[붙여넣은 이미지 2026-08-24 09-07-05 2.jpg]]"
    );
    expect(() => vaultClipboardImageEmbedSource(["unsafe|alias.png"]))
      .toThrow("안전한 내부 링크");
  });
});
