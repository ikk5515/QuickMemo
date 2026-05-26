import { describe, expect, it } from "vitest";
import {
  attachmentValidationError,
  isPublicShareRasterImageExtension,
  maxAttachmentFileBytes,
  maxAttachmentStorageBytes,
  publicShareAttachmentMimeMatchesExtension,
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

  it("allows ZIP files up to the encrypted Storage attachment limit", () => {
    const file = new File([new Uint8Array(1024)], "archive.zip", { type: "application/zip" });
    const tooLargeFile = new File([new Uint8Array(1)], "large.zip", { type: "application/zip" });
    Object.defineProperty(tooLargeFile, "size", { value: maxAttachmentFileBytes + 1 });

    expect(attachmentValidationError(file)).toBeNull();
    expect(attachmentValidationError(tooLargeFile)).toContain("10.00 MB");
  });

  it("caps per-user blob attachment storage at 50 MB", () => {
    expect(maxAttachmentStorageBytes).toBe(50 * 1024 * 1024);
  });
});
