import { describe, expect, it } from "vitest";
import { safeRasterDataUrl, safeRasterImageBytes } from "./safeRasterImage";

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function dataUrl(bytes: Uint8Array) {
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

describe("safe raster image headers", () => {
  it("accepts bounded PNG headers and rejects oversized dimensions", () => {
    expect(safeRasterImageBytes(pngHeader(1280, 720), "image/png")).toBe(true);
    expect(safeRasterImageBytes(pngHeader(10_000, 10_000), "image/png")).toBe(false);
    expect(safeRasterDataUrl(dataUrl(pngHeader(1, 1)))).toBe(true);
    expect(safeRasterDataUrl(dataUrl(pngHeader(10_000, 10_000)))).toBe(false);
  });

  it("rejects GIF animation surfaces, mismatched formats, and malformed base64", () => {
    const gif = new TextEncoder().encode("GIF89a");
    expect(safeRasterImageBytes(gif, "image/gif")).toBe(false);
    expect(safeRasterImageBytes(pngHeader(1, 1), "image/jpeg")).toBe(false);
    expect(safeRasterDataUrl("data:image/png;base64,abc")).toBe(false);
    expect(safeRasterDataUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toBe(false);
  });

  it("rejects APNG and animated WebP containers before decode", () => {
    const apng = new Uint8Array(53);
    apng.set(pngHeader(320, 240));
    const apngView = new DataView(apng.buffer);
    apngView.setUint32(33, 8);
    apng.set([0x61, 0x63, 0x54, 0x4c], 37);

    const animatedWebp = new Uint8Array(30);
    animatedWebp.set(new TextEncoder().encode("RIFF"), 0);
    animatedWebp.set(new TextEncoder().encode("WEBP"), 8);
    animatedWebp.set(new TextEncoder().encode("VP8X"), 12);
    animatedWebp[20] = 0x02;

    expect(safeRasterImageBytes(apng, "image/png")).toBe(false);
    expect(safeRasterDataUrl(dataUrl(apng))).toBe(false);
    expect(safeRasterImageBytes(animatedWebp, "image/webp")).toBe(false);
  });

  it("reads bounded JPEG start-of-frame dimensions", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x02, 0xd0,
      0x05, 0x00,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00
    ]);

    expect(safeRasterImageBytes(jpeg, "image/jpeg")).toBe(true);
  });
});
