import { describe, expect, it, vi } from "vitest";
import {
  extractLibraryAttachmentText,
  libraryAttachmentExtractionMode,
  libraryExtractedTextUtf8BudgetForTest
} from "./libraryAttachmentExtraction";

describe("library attachment text extraction", () => {
  it("detects only PDF and safe static raster formats", () => {
    expect(libraryAttachmentExtractionMode("PDF")).toBe("pdf-text");
    expect(libraryAttachmentExtractionMode("png")).toBe("image-ocr");
    expect(libraryAttachmentExtractionMode("gif")).toBeNull();
    expect(libraryAttachmentExtractionMode("svg")).toBeNull();
  });

  it("converts PDF pages into bounded reader blocks without duplicating plaintext", async () => {
    const extractPdf = vi.fn().mockResolvedValue({
      characterCount: 12,
      likelyScanned: false,
      pageCount: 2,
      pages: [
        { itemCount: 1, pageNumber: 1, text: "첫 페이지", truncated: false },
        { itemCount: 1, pageNumber: 2, text: "둘째 페이지", truncated: false }
      ],
      processedPageCount: 2,
      text: "첫 페이지\n\n둘째 페이지",
      textItemCount: 2,
      truncated: false
    });

    const result = await extractLibraryAttachmentText(new Uint8Array([1, 2]), {
      extension: "pdf",
      extractPdf,
      mimeType: "application/pdf"
    });

    expect(result.mode).toBe("pdf-text");
    expect(result.readerBlocks.map((block) => block.text).join(" ")).toContain("PDF 1쪽");
    expect(result.readerBlocks.map((block) => block.text).join(" ")).toContain("둘째 페이지");
    expect(result.truncated).toBe(false);
  });

  it("runs Korean and English image OCR and enforces a UTF-8 storage budget", async () => {
    const source = "한".repeat(180_000);
    const runImageOcr = vi.fn().mockResolvedValue({ confidence: 92, languages: ["kor", "eng"], text: source });

    const result = await extractLibraryAttachmentText(new Uint8Array([1, 2]), {
      extension: "png",
      mimeType: "image/png",
      runImageOcr
    });
    const stored = result.readerBlocks.map((block) => block.text).join("");

    expect(runImageOcr).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/png" }),
      expect.objectContaining({ languages: ["kor", "eng"] })
    );
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(libraryExtractedTextUtf8BudgetForTest);
    expect(result.truncated).toBe(true);
    expect(result.confidence).toBe(92);
  });

  it("rejects unsupported active or archive formats before decryption output is persisted", async () => {
    await expect(extractLibraryAttachmentText(new Uint8Array([1]), {
      extension: "svg",
      mimeType: "image/svg+xml"
    })).rejects.toThrow("지원하지 않습니다");
  });
});
