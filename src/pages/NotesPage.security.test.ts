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

  it("does not trust shared attribution UIDs from the next rich-text draft", () => {
    const annotateHelper =
      notesPageSource.match(/function annotateSharedNoteBody[\s\S]*?function sharedBlockMetadataFromHtml/)?.[0] ?? "";

    expect(annotateHelper).not.toContain("parseUidList(block.dataset.qmAuthorUids)");
    expect(annotateHelper).not.toContain("parseUidList(block.dataset.qmEditorUids)");
    expect(annotateHelper).not.toContain("parseUid(block.dataset.qmLastEditorUid)");
    expect(annotateHelper).toContain("const finalLastEditorUid = changed ? actorUid : previousLastEditorUid");
  });

  it("renders shared attribution from authenticated history actors instead of body attributes", () => {
    const previewHelper =
      notesPageSource.match(/function sharedAttributionHtml[\s\S]*?function renderSharedAttributionNote/)?.[0] ?? "";
    const historyHelper =
      notesPageSource.match(/function trustedSharedBlockMetadataFromHistory[\s\S]*?function sharedAttributionBlocks/)?.[0] ?? "";

    expect(historyHelper).toContain("entry.actorUid");
    expect(historyHelper).toContain("deriveSharedBlockMetadataForActor");
    expect(previewHelper).not.toContain("parseUidList(block.dataset.qmAuthorUids)");
    expect(previewHelper).not.toContain("parseUidList(block.dataset.qmEditorUids)");
    expect(previewHelper).not.toContain("parseUid(block.dataset.qmLastEditorUid)");
    expect(previewHelper).toContain("clearSharedAttributionAttributes(block)");
    expect(notesPageSource).toContain("trustedSharedBlockMetadataFromHistory(note, history, historySnapshots)");
  });

  it("bounds XLSX merge ranges before materializing skipped preview cells", () => {
    const worksheetHelper =
      notesPageSource.match(/function renderXlsxWorksheet[\s\S]*?function renderXlsxRow/)?.[0] ?? "";
    const mergeHelper =
      notesPageSource.match(/function xlsxMergeInfo[\s\S]*?function xlsxMaxColumnIndex/)?.[0] ?? "";
    const referenceHelper =
      notesPageSource.match(/function xlsxCellReference[\s\S]*?function safeXlsxRowNumber/)?.[0] ?? "";

    expect(notesPageSource).toContain("const xlsxPreviewMaxColumns = 50");
    expect(notesPageSource).toContain("const xlsxPreviewMaxRows = 100");
    expect(notesPageSource).toContain("const xlsxPreviewMaxMergeRanges = 200");
    expect(worksheetHelper).toContain("visibleRowNumbers");
    expect(worksheetHelper).toContain("xlsxMergeInfo(document, {");
    expect(mergeHelper).toContain(".slice(0, xlsxPreviewMaxMergeRanges)");
    expect(mergeHelper).toContain("clampedEndColumn");
    expect(mergeHelper).toContain("visibleRowsInRange.forEach");
    expect(mergeHelper).not.toContain("for (let row = range.startRow");
    expect(mergeHelper).not.toContain("column <= range.endColumn");
    expect(referenceHelper).toContain("row > xlsxExcelMaxRows");
    expect(referenceHelper).toContain("column >= xlsxExcelMaxColumns");
  });

  it("bounds compressed HWP preview sections before rich rendering", () => {
    const hwpAttachmentBranch =
      notesPageSource.match(/if \(attachment\.extension === "hwp"\) \{[\s\S]*?if \(attachment\.extension === "hwpx"\)/)?.[0] ?? "";
    const hwpExtractor =
      notesPageSource.match(/async function extractHwpPreviewHtml[\s\S]*?function extractHwpxPreviewHtml/)?.[0] ?? "";
    const hwpDecompressor =
      notesPageSource.match(/function decompressHwpSectionBytes[\s\S]*?function appendHwpSectionBlocks/)?.[0] ?? "";

    expect(notesPageSource).toContain("const maxHwpPreviewSectionBytes = 1_500_000");
    expect(notesPageSource).toContain("const maxHwpPreviewTotalBytes = 4_000_000");
    expect(hwpAttachmentBranch).toContain("preview.safeForRichPreview");
    expect(hwpAttachmentBranch).toContain("kind: \"html\"");
    expect(hwpExtractor).toContain("safeForRichPreview = false");
    expect(hwpExtractor).toContain("boundedHwpSectionBytes");
    expect(hwpDecompressor).toContain("new Decompress");
    expect(hwpDecompressor).toContain("decodedLength > sectionLimit");
    expect(hwpDecompressor).toContain("hwpPreviewCompressedChunkBytes");
    expect(hwpDecompressor).not.toContain("decompressSync");
  });
});
