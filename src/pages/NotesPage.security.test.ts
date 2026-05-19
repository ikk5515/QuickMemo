import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");
const pdfPreviewCanvasSource = readFileSync(join(process.cwd(), "src/lib/pdfPreviewCanvas.ts"), "utf8");

describe("NotesPage security controls", () => {
  it("renders PDF previews through bounded canvas rendering without plugin or iframe surfaces", () => {
    const pdfPreviewBranch = notesPageSource.match(/preview\.kind === "pdf" && preview\.bytes \? \([\s\S]*?\) : preview\.kind === "docx"/)?.[0] ?? "";

    expect(pdfPreviewBranch).toContain("<PdfCanvasPreview");
    expect(pdfPreviewBranch).toContain("bytes={preview.bytes}");
    expect(pdfPreviewBranch).not.toContain("<iframe");
    expect(pdfPreviewBranch).not.toContain("<object");
    expect(pdfPreviewBranch).not.toContain("<embed");
    expect(notesPageSource).toContain("maxPdfPreviewPages");
    expect(notesPageSource).toContain("maxPdfPreviewCanvasPixels");
    expect(notesPageSource).toContain("maxPdfPreviewTotalCanvasPixels");
    expect(notesPageSource).toContain("retainedCanvasPixels");
    expect(notesPageSource).toContain("remainingCanvasPixels");
    expect(notesPageSource).toContain("pdfPreviewCanvasLayout");
    expect(notesPageSource).toContain("layout.canvasPixels > maxPdfPreviewCanvasPixels");
    expect(notesPageSource).toContain("layout.canvasPixels > remainingCanvasPixels");
    expect(notesPageSource).toContain("disableFontFace: true");
    expect(notesPageSource).toContain("enableXfa: false");
    expect(notesPageSource).toContain("useWorkerFetch: false");
    expect(notesPageSource).toContain("annotationMode: pdfjs.AnnotationMode.DISABLE");
    expect(pdfPreviewCanvasSource).toContain("maxPdfPreviewPageCssHeight");
    expect(pdfPreviewCanvasSource).toContain("maxPdfPreviewTotalCanvasPixels");
    expect(pdfPreviewCanvasSource).not.toContain("Math.max(0.25");
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

  it("bounds ZIP-container previews before inflating DOCX, HWPX, and XLSX attachments", () => {
    const docxRenderHelper = notesPageSource.match(/async function renderSafeDocxPreviewSrcDoc[\s\S]*?function docxSandboxSrcDoc/)?.[0] ?? "";
    const zipGuardHelper = notesPageSource.match(/function safeZipPreviewEntries[\s\S]*?interface HwpPreviewResult/)?.[0] ?? "";
    const hwpxExtractor = notesPageSource.match(/function extractHwpxPreviewHtml[\s\S]*?function extractXlsxPreviewHtml/)?.[0] ?? "";
    const xlsxExtractor = notesPageSource.match(/function extractXlsxPreviewHtml[\s\S]*?function xlsxPreviewEntryAllowed/)?.[0] ?? "";

    expect(notesPageSource).toContain("const maxZipPreviewEntries = 512");
    expect(notesPageSource).toContain("const maxDocxPreviewUncompressedBytes = 12_000_000");
    expect(notesPageSource).toContain("const maxZipPreviewCompressionRatio = 120");
    expect(docxRenderHelper).toContain("safeZipPreviewEntries(bytes");
    expect(docxRenderHelper.indexOf("safeZipPreviewEntries(bytes")).toBeGreaterThanOrEqual(0);
    expect(docxRenderHelper.indexOf("safeZipPreviewEntries(bytes")).toBeLessThan(docxRenderHelper.indexOf("renderAsync"));
    expect(zipGuardHelper).toContain("filter: (file) => shouldInflateZipPreviewEntry(file, limits, state)");
    expect(zipGuardHelper).toContain("state.entryCount > limits.maxEntries");
    expect(zipGuardHelper).toContain("file.originalSize > limits.maxEntryUncompressedBytes");
    expect(zipGuardHelper).toContain("nextTotalBytes > limits.maxTotalUncompressedBytes");
    expect(zipGuardHelper).toContain("compressionRatio > maxZipPreviewCompressionRatio");
    expect(zipGuardHelper).toContain("state.selectedCount > limits.maxSelectedEntries");
    expect(hwpxExtractor).toContain("safeZipPreviewEntries(bytes");
    expect(hwpxExtractor).toContain("includeEntry: (name) => hwpxPreviewEntryPriority(name) > 0");
    expect(xlsxExtractor).toContain("safeZipPreviewEntries(bytes");
    expect(xlsxExtractor).toContain("includeEntry: xlsxPreviewEntryAllowed");
    expect(notesPageSource).not.toContain("unzipSync(bytes);");
  });

  it("bounds XLSX XML parsing and shared-string enumeration after safe unzip", () => {
    const xlsxXmlHelper =
      notesPageSource.match(/function xlsxXmlDocument[\s\S]*?function xlsxEntryText/)?.[0] ?? "";
    const xlsxTextHelper =
      notesPageSource.match(/function xlsxEntryText[\s\S]*?interface XlsxFontStyle/)?.[0] ?? "";
    const sharedStringsHelper =
      notesPageSource.match(/function xlsxSharedStrings[\s\S]*?function xlsxWorkbookSheets/)?.[0] ?? "";
    const worksheetHelper =
      notesPageSource.match(/function renderXlsxWorksheet[\s\S]*?function renderXlsxRow/)?.[0] ?? "";
    const stylesHelper =
      notesPageSource.match(/function xlsxStyles[\s\S]*?function xlsxFontStyle/)?.[0] ?? "";

    expect(notesPageSource).toContain("const maxXlsxSharedStringsXmlCharacters = 1_500_000");
    expect(notesPageSource).toContain("const maxXlsxWorksheetXmlCharacters = 1_500_000");
    expect(xlsxXmlHelper).toContain("xlsxEntryText(entry, maxCharacters)");
    expect(xlsxTextHelper).toContain("entry.length > maxCharacters");
    expect(xlsxTextHelper).toContain("markup.length <= maxCharacters");
    expect(sharedStringsHelper).toContain('xlsxElementsByLocalName(document.documentElement, "si", maxXlsxSharedStrings)');
    expect(sharedStringsHelper).toContain(".slice(0, maxXlsxSharedStringCharacters)");
    expect(worksheetHelper).toContain("xlsxEntryText(bytes, maxXlsxWorksheetXmlCharacters)");
    expect(worksheetHelper).toContain('xlsxElementsByLocalName(document.documentElement, "row", xlsxPreviewMaxRows * 4)');
    expect(stylesHelper).toContain('xlsxElementsByLocalName(document.documentElement, "numFmt", maxXlsxStyleRecords)');
    expect(stylesHelper).toContain(".slice(0, maxXlsxStyleRecords)");
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

  it("rejects future remote cursor timestamps when checking collaborator freshness", () => {
    const cursorFreshnessHelper =
      notesPageSource.match(/function freshRemoteCursorTimestamp[\s\S]*?function timestampsEqual/)?.[0] ?? "";
    const cursorFilter =
      notesPageSource.match(/const remoteEditorCursors = useMemo[\s\S]*?\.map\(\(state\) =>/)?.[0] ?? "";

    expect(cursorFreshnessHelper).toContain("const ageMs = clockMs - updatedAt.getTime()");
    expect(cursorFreshnessHelper).toContain("ageMs >= 0");
    expect(cursorFreshnessHelper).toContain("ageMs <= remoteCursorFreshMs");
    expect(cursorFilter).toContain("freshRemoteCursorTimestamp(cursorUpdatedAt, cursorClock)");
    expect(cursorFilter).not.toContain("cursorClock - cursorUpdatedAt.getTime() <= remoteCursorFreshMs");
  });

  it("preserves dirty editor drafts when remote note updates arrive", () => {
    const activeEditorSync =
      notesPageSource.match(/const remoteDraft = draftFromNote\(activeRemoteNote\);[\s\S]*?setStatus\(activeRemoteNote\.type === "shared"/)?.[0] ?? "";
    const previewModalSync =
      notesPageSource.match(/useEffect\(\(\) => \{\n {4}const remoteDraft = draftFromNote\(note\);[\s\S]*?\}, \[draftDirty, isEditing, note\]\);/)?.[0] ?? "";

    expect(activeEditorSync).toContain("if (editor.dirty && !contentMatches)");
    expect(activeEditorSync.indexOf("if (editor.dirty && !contentMatches)")).toBeLessThan(activeEditorSync.indexOf("setEditor((current) =>"));
    expect(previewModalSync).toContain("if (isEditing && draftDirty)");
    expect(previewModalSync.indexOf("if (isEditing && draftDirty)")).toBeLessThan(previewModalSync.indexOf("setDraft(remoteDraft)"));
    expect(previewModalSync).toContain("현재 편집 중인 내용은 유지했습니다.");
    expect(previewModalSync).not.toContain("}, [isEditing, note]);");
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
    expect(mergeHelper).toContain('xlsxElementsByLocalName(document.documentElement, "mergeCell", xlsxPreviewMaxMergeRanges)');
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
