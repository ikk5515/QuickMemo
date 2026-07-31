import { describe, expect, it } from "vitest";
import {
  attachmentDownloadName,
  attachmentValidationError,
  isPublicShareRasterImageExtension,
  maxAttachmentFileBytes,
  maxAttachmentStorageBytes,
  publicShareAttachmentMimeMatchesExtension,
  safeAttachmentBaseName,
  safePublicShareAttachmentMimeType
} from "./attachments";

describe("public share attachment MIME helpers", () => {
  it("returns canonical safe MIME types for public share attachments", () => {
    expect(safePublicShareAttachmentMimeType("png")).toBe("image/png");
    expect(safePublicShareAttachmentMimeType("jpg")).toBe("image/jpeg");
    expect(safePublicShareAttachmentMimeType("jpeg")).toBe("image/jpeg");
    expect(safePublicShareAttachmentMimeType("pdf")).toBe("application/pdf");
    expect(safePublicShareAttachmentMimeType("zip")).toBe("application/zip");
    expect(safePublicShareAttachmentMimeType("unknown")).toBe("application/octet-stream");
  });

  it("only treats safe raster image extensions as public image previews", () => {
    expect(isPublicShareRasterImageExtension("png")).toBe(true);
    expect(isPublicShareRasterImageExtension("webp")).toBe(true);
    expect(isPublicShareRasterImageExtension("svg")).toBe(false);
    expect(isPublicShareRasterImageExtension("html")).toBe(false);
  });

  it("requires public share attachment MIME types to match their extension exactly", () => {
    expect(publicShareAttachmentMimeMatchesExtension("pdf", "application/pdf")).toBe(true);
    expect(publicShareAttachmentMimeMatchesExtension("pdf", "text/html")).toBe(false);
    expect(publicShareAttachmentMimeMatchesExtension("pdf", "image/svg+xml")).toBe(false);
    expect(publicShareAttachmentMimeMatchesExtension("png", "image/png")).toBe(true);
    expect(publicShareAttachmentMimeMatchesExtension("png", "image/svg+xml")).toBe(false);
    expect(publicShareAttachmentMimeMatchesExtension("png", "text/html")).toBe(false);
    expect(publicShareAttachmentMimeMatchesExtension("png", "image/jpeg")).toBe(false);
    expect(publicShareAttachmentMimeMatchesExtension("zip", "application/zip")).toBe(true);
    expect(publicShareAttachmentMimeMatchesExtension("zip", "application/x-msdownload")).toBe(false);
  });

  it("allows ZIP files through the 150MB upload limit and rejects larger files", () => {
    const file = new File([new Uint8Array(1024)], "archive.zip", { type: "application/zip" });
    const boundaryFile = new File([new Uint8Array(1)], "boundary.zip", { type: "application/zip" });
    const tooLargeFile = new File([new Uint8Array(1)], "large.zip", { type: "application/zip" });
    Object.defineProperty(boundaryFile, "size", { value: maxAttachmentFileBytes });
    Object.defineProperty(tooLargeFile, "size", { value: maxAttachmentFileBytes + 1 });

    expect(attachmentValidationError(file)).toBeNull();
    expect(attachmentValidationError(boundaryFile)).toBeNull();
    expect(maxAttachmentFileBytes).toBe(150 * 1024 * 1024);
    expect(attachmentValidationError(tooLargeFile)).toContain("최대 150MB까지 업로드할 수 있습니다.");
  });

  it("keeps per-user blob attachment storage capped at 1 GB", () => {
    expect(maxAttachmentStorageBytes).toBe(1024 * 1024 * 1024);
  });

  it.each([
    "invoice\u202Efdp.exe.pdf",
    "isolated\u2066name\u2069.pdf",
    "zero\u200Bwidth.pdf",
    "control\u0085name.pdf",
    "line\nbreak.pdf"
  ])("removes invisible and directional control characters from attachment names", (fileName) => {
    const hasUnsafeControlCharacter = Array.from(safeAttachmentBaseName(fileName)).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31
        || (codePoint >= 127 && codePoint <= 159)
        || /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(character);
    });

    expect(hasUnsafeControlCharacter).toBe(false);
  });

  it("sanitizes legacy attachment names again at the download boundary", () => {
    const downloadName = attachmentDownloadName({
      extension: "pdf",
      fileName: "invoice\u202Efdp.exe"
    });

    expect(downloadName).toBe("invoice_fdp.exe.pdf");
  });
});
