import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");

describe("NotesPage security controls", () => {
  it("renders PDF previews as an object without script or same-origin iframe grants", () => {
    const pdfObject = notesPageSource.match(/<object[\s\S]*?className="pdf-preview-frame"[\s\S]*?>/)?.[0] ?? "";

    expect(pdfObject).toContain('type="application/pdf"');
    expect(pdfObject).not.toContain("allow-scripts");
    expect(pdfObject).not.toContain("allow-same-origin");
    expect(notesPageSource).not.toContain("dangerouslySetInnerHTML={preview");
  });

  it("renders DOCX previews through sanitized sandboxed srcDoc instead of the live app DOM", () => {
    const docxPreviewBranch = notesPageSource.match(/preview\.kind === "docx" \? \([\s\S]*?\) : preview\.kind === "hwp"/)?.[0] ?? "";
    const docxRenderHelper = notesPageSource.match(/async function renderSafeDocxPreviewSrcDoc[\s\S]*?function docxSandboxSrcDoc/)?.[0] ?? "";
    const docxSrcDocHelper = notesPageSource.match(/function docxSandboxSrcDoc[\s\S]*?function sanitizeDocxPreviewTree/)?.[0] ?? "";

    expect(docxPreviewBranch).toContain("<iframe");
    expect(docxPreviewBranch).toContain('sandbox=""');
    expect(docxPreviewBranch).toContain("srcDoc={preview.srcDoc ?? \"\"}");
    expect(docxPreviewBranch).not.toContain("allow-scripts");
    expect(docxPreviewBranch).not.toContain("allow-same-origin");
    expect(docxPreviewBranch).not.toContain("dangerouslySetInnerHTML");
    expect(docxRenderHelper).toContain("sanitizeDocxPreviewTree");
    expect(docxRenderHelper).not.toContain("renderAsync(preview.bytes");
    expect(docxSrcDocHelper).toContain("Content-Security-Policy");
    expect(notesPageSource).toContain("script-src 'none'");
  });

  it("filters active DOCX preview links, resources, and event attributes before sandboxing", () => {
    expect(notesPageSource).toContain("function sanitizeDocxPreviewAttributes");
    expect(notesPageSource).toContain("attributeName.startsWith(\"on\")");
    expect(notesPageSource).toContain("function safeDocxPreviewHref");
    expect(notesPageSource).toContain("url.protocol === \"http:\" || url.protocol === \"https:\"");
    expect(notesPageSource).toContain("function safeDocxPreviewImageSrc");
    expect(notesPageSource).toContain("sanitizeDocxPreviewCss");
  });
});
