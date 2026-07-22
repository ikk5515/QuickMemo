import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLibraryOcrLanguages, runLibraryImageOcr, validateLibraryOcrImage } from "./libraryImageOcr";

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

describe("local library image OCR", () => {
  it("accepts only supported language models", () => {
    expect(normalizeLibraryOcrLanguages(["kor", "eng", "jpn", "kor"])).toEqual(["kor", "eng"]);
    expect(normalizeLibraryOcrLanguages([])).toEqual(["kor", "eng"]);
  });

  it("rejects spoofed and oversized raster dimensions before loading the OCR engine", () => {
    expect(validateLibraryOcrImage(pngHeader(1280, 720), "image/png")).toBeNull();
    expect(validateLibraryOcrImage(pngHeader(10_000, 10_000), "image/png")).toContain("안전한 정적 이미지");
    expect(validateLibraryOcrImage(new Uint8Array([1, 2, 3]), "image/png")).toContain("안전한 정적 이미지");
  });

  it("fails an unsafe blob without importing or invoking Tesseract", async () => {
    const bytes = new TextEncoder().encode("not-an-image");
    const image = {
      arrayBuffer: async () => bytes.buffer,
      size: bytes.byteLength,
      type: "image/png"
    } as Blob;

    await expect(runLibraryImageOcr(image)).rejects.toThrow(
      "안전한 정적 이미지"
    );
  });

  it("keeps OCR in a same-origin non-blob worker and avoids remote OCR services", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/libraryImageOcr.ts"), "utf8");

    expect(source).toContain('workerPath: "/api/library-ocr-worker?v=7.0.0"');
    expect(source).toContain("workerBlobURL: false");
    expect(source).not.toMatch(/https?:\/\//u);
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });
});
