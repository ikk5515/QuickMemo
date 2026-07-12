import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const publicSharePageSource = source("src/pages/PublicSharePage.tsx");
const documentPreviewSource = source("src/lib/documentPreview.ts");
const previewModalSource = source("src/components/PublicAttachmentPreviewModal.tsx");
const pdfPreviewSource = source("src/components/PublicPdfCanvasPreview.tsx");
const viteConfigSource = source("vite.config.ts");

describe("PublicSharePage preview resource boundaries", () => {
  it("keeps the editor and document preview implementations outside the initial public share module graph", () => {
    expect(publicSharePageSource).not.toMatch(/from\s+["']\.\/NotesPage["']/u);
    expect(publicSharePageSource).not.toContain('import("./NotesPage")');
    expect(publicSharePageSource).toContain('lazy(() => import("../components/PublicAttachmentPreviewModal"))');
    expect(publicSharePageSource).toContain('await import("../lib/documentPreview")');
    expect(documentPreviewSource).not.toContain("NotesPage");
    expect(documentPreviewSource).not.toContain("@tiptap/");
    expect(documentPreviewSource).not.toContain("firebase/");
    expect(previewModalSource).toContain('lazy(() => import("./PublicPdfCanvasPreview"))');
    expect(pdfPreviewSource).toContain('await import("pdfjs-dist")');
    expect(previewModalSource).not.toContain("hwp.js");
  });

  it("does not let the PDF worker URL collapse the lazy PDF implementation into a static chunk", () => {
    expect(viteConfigSource).toContain('id.includes("/pdfjs-dist/") && !id.includes("?url")');
    expect(viteConfigSource).toContain('return "pdf-preview"');
    expect(viteConfigSource).toContain('return "hwp-parser"');
  });

  it("releases preview, download, PDF task, and canvas resources", () => {
    expect(publicSharePageSource).toContain("downloadCleanupTimersRef");
    expect(publicSharePageSource).toContain("revokeDownloadUrls");
    expect(pdfPreviewSource).toContain("task.cancel()");
    expect(pdfPreviewSource).toContain("pdfDocument.destroy()");
    expect(pdfPreviewSource).toContain("canvas.width = 0");
    expect(pdfPreviewSource).toContain("canvas.height = 0");
  });

  it("retains sandboxing and sanitization around document HTML", () => {
    expect(previewModalSource).toContain('sandbox=""');
    expect(previewModalSource).toContain('referrerPolicy="no-referrer"');
    expect(previewModalSource).toContain("sanitizeEditorHtml(preview.html");
    expect(previewModalSource).toContain("sanitizeEditorHtml(preview.fallbackHtml");
  });

  it("checks raster dimensions and rejects animated GIF preview before browser decode", () => {
    expect(publicSharePageSource).toContain("safeRasterImageBytes(bytes, imageMimeType)");
    expect(publicSharePageSource).toContain("움직이는 GIF");
  });
});
