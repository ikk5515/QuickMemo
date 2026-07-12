import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");
const documentPreviewSource = readFileSync(join(process.cwd(), "src/lib/documentPreview.ts"), "utf8");
const pdfPreviewCanvasSource = readFileSync(join(process.cwd(), "src/lib/pdfPreviewCanvas.ts"), "utf8");

describe("NotesPage security controls", () => {
  it("keeps bounded document parsing in the shared preview module", () => {
    expect(notesPageSource).toContain('from "../lib/documentPreview"');
    expect(notesPageSource).not.toContain("function safeZipPreviewEntries");
    expect(notesPageSource).not.toContain("function decompressHwpSectionBytes");
    expect(documentPreviewSource).toContain("export async function renderSafeDocxPreviewSrcDoc");
    expect(documentPreviewSource).toContain("export async function extractHwpPreviewHtml");
    expect(documentPreviewSource).toContain("export function extractHwpxPreviewHtml");
    expect(documentPreviewSource).toContain("export function extractXlsxPreviewHtml");
  });

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
    const docxRenderHelper = documentPreviewSource.match(/async function renderSafeDocxPreviewSrcDoc[\s\S]*?function docxSandboxSrcDoc/)?.[0] ?? "";
    const docxSrcDocHelper = documentPreviewSource.match(/function docxSandboxSrcDoc[\s\S]*?function sanitizeDocxPreviewTree/)?.[0] ?? "";

    expect(docxPreviewBranch).toContain("<iframe");
    expect(docxPreviewBranch).toContain('sandbox=""');
    expect(docxPreviewBranch).toContain("srcDoc={preview.srcDoc ?? \"\"}");
    expect(docxPreviewBranch).not.toContain("allow-scripts");
    expect(docxPreviewBranch).not.toContain("allow-same-origin");
    expect(docxPreviewBranch).not.toContain("dangerouslySetInnerHTML");
    expect(docxRenderHelper).toContain("sanitizeDocxPreviewTree");
    expect(docxRenderHelper).not.toContain("renderAsync(preview.bytes");
    expect(docxSrcDocHelper).toContain("Content-Security-Policy");
    expect(documentPreviewSource).toContain("script-src 'none'");
    expect(notesPageSource).toContain('document.documentElement.dataset.theme === "dark" ? "dark" : "light"');
    expect(docxSrcDocHelper).toContain("data-theme=\"${theme}\"");
    expect(docxSrcDocHelper).toContain("background:#09090b");
  });

  it("filters active DOCX preview links, resources, and event attributes before sandboxing", () => {
    expect(documentPreviewSource).toContain("function sanitizeDocxPreviewAttributes");
    expect(documentPreviewSource).toContain("attributeName.startsWith(\"on\")");
    expect(documentPreviewSource).toContain("function safeDocxPreviewHref");
    expect(documentPreviewSource).toContain("url.protocol === \"http:\" || url.protocol === \"https:\"");
    expect(documentPreviewSource).toContain("function safeDocxPreviewImageSrc");
    expect(documentPreviewSource).toContain("return safeRasterDataUrl(trimmedValue)");
    expect(documentPreviewSource).toContain("sanitizeDocxPreviewCss");
  });

  it("bounds ZIP-container previews before inflating DOCX, HWPX, and XLSX attachments", () => {
    const docxRenderHelper = documentPreviewSource.match(/async function renderSafeDocxPreviewSrcDoc[\s\S]*?function docxSandboxSrcDoc/)?.[0] ?? "";
    const zipGuardHelper = documentPreviewSource.match(/function safeZipPreviewEntries[\s\S]*?interface HwpPreviewResult/)?.[0] ?? "";
    const hwpxExtractor = documentPreviewSource.match(/function extractHwpxPreviewHtml[\s\S]*?function extractXlsxPreviewHtml/)?.[0] ?? "";
    const xlsxExtractor = documentPreviewSource.match(/function extractXlsxPreviewHtml[\s\S]*?function xlsxPreviewEntryAllowed/)?.[0] ?? "";

    expect(documentPreviewSource).toContain("const maxZipPreviewEntries = 512");
    expect(documentPreviewSource).toContain("const maxDocxPreviewUncompressedBytes = 12_000_000");
    expect(documentPreviewSource).toContain("const maxZipPreviewCompressionRatio = 120");
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
    expect(documentPreviewSource).not.toContain("unzipSync(bytes);");
  });

  it("routes dragged attachment files through the controlled upload flow", () => {
    expect(notesPageSource).toContain("function dataTransferHasFiles");
    expect(notesPageSource).toContain("event.dataTransfer.dropEffect = \"copy\"");
    expect(notesPageSource).toContain("onDragEnter={handleEditorFrameDragEnter}");
    expect(notesPageSource).toContain("onDragOver={handleEditorFrameDragOver}");
    expect(notesPageSource).toContain("onDrop={handleEditorFrameDrop}");
    expect(notesPageSource).toContain("void handleFiles(files)");
    expect(notesPageSource).toContain("accept={attachmentInputAccept}");
  });

  it("surfaces controlled Blob upload progress without exposing attachment bytes", () => {
    const attachmentUploadFlow =
      notesPageSource.match(/async function uploadAttachmentFiles[\s\S]*?async function noteKeyForDownload/)?.[0] ?? "";

    expect(notesPageSource).toContain("AttachmentUploadProgressToast");
    expect(notesPageSource).toContain("role=\"progressbar\"");
    expect(notesPageSource).toContain("onUploadProgress: (progress) =>");
    expect(notesPageSource).toContain("attachmentUploadOverallPercent");
    expect(notesPageSource).toContain("encryptAttachmentBlob(file, noteTarget.noteKey");
    expect(notesPageSource).toContain("reencryptAttachmentBlob(");
    expect(attachmentUploadFlow).not.toContain("new Uint8Array(await file.arrayBuffer())");
    expect(attachmentUploadFlow).not.toContain("encryptBytes(fileBytes");
    expect(attachmentUploadFlow).not.toContain("setAttachmentUploadProgress(encryptedFile");
    expect(notesPageSource).toContain(
      "safeRasterImageBytes(new Uint8Array(await file.arrayBuffer()), mimeType)",
    );
  });

  it("bounds XLSX XML parsing and shared-string enumeration after safe unzip", () => {
    const xlsxXmlHelper =
      documentPreviewSource.match(/function xlsxXmlDocument[\s\S]*?function xlsxEntryText/)?.[0] ?? "";
    const xlsxTextHelper =
      documentPreviewSource.match(/function xlsxEntryText[\s\S]*?interface XlsxFontStyle/)?.[0] ?? "";
    const sharedStringsHelper =
      documentPreviewSource.match(/function xlsxSharedStrings[\s\S]*?function xlsxWorkbookSheets/)?.[0] ?? "";
    const worksheetHelper =
      documentPreviewSource.match(/function renderXlsxWorksheet[\s\S]*?function renderXlsxRow/)?.[0] ?? "";
    const stylesHelper =
      documentPreviewSource.match(/function xlsxStyles[\s\S]*?function xlsxFontStyle/)?.[0] ?? "";

    expect(documentPreviewSource).toContain("const maxXlsxSharedStringsXmlCharacters = 1_500_000");
    expect(documentPreviewSource).toContain("const maxXlsxWorksheetXmlCharacters = 1_500_000");
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
      notesPageSource.match(/function freshRemoteCursorTimestamp[\s\S]*?function nextParticipantList/)?.[0] ?? "";
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
    expect(activeEditorSync.indexOf("if (editor.dirty && !contentMatches)")).toBeLessThan(
      activeEditorSync.indexOf("title: remoteDraft.title")
    );
    expect(previewModalSync).toContain("if (isEditing && draftDirty)");
    expect(previewModalSync.indexOf("if (isEditing && draftDirty)")).toBeLessThan(previewModalSync.indexOf("setDraft(remoteDraft)"));
    expect(previewModalSync).toContain("현재 편집 중인 내용은 유지했습니다.");
    expect(previewModalSync).not.toContain("}, [isEditing, note]);");
  });

  it("does not persist public share URL keys or content keys in browser storage", () => {
    expect(notesPageSource).toContain("const publicShareUrlMemoryCache = new Map<string, string>();");
    expect(notesPageSource).toContain("const publicShareContentKeyMemoryCache = new Map<string, string>();");
    expect(notesPageSource).not.toContain("window.localStorage.setItem(publicShareUrlStorageKey");
    expect(notesPageSource).not.toContain("window.localStorage.getItem(publicShareUrlStorageKey");
    expect(notesPageSource).not.toContain("window.localStorage.setItem(publicShareContentKeyStorageKey");
    expect(notesPageSource).not.toContain("window.localStorage.getItem(publicShareContentKeyStorageKey");
  });

  it("keeps attachment upload, preview, download, and delete pending states independent", () => {
    expect(notesPageSource).toContain("interface AttachmentActionBusyState");
    expect(notesPageSource).toContain("deletingIds: string[];");
    expect(notesPageSource).toContain("downloadingId: string | null;");
    expect(notesPageSource).toContain("previewingId: string | null;");
    expect(notesPageSource).toContain("attachmentUploadInFlightRef");
    expect(notesPageSource).not.toContain("disabled={Boolean(busyId)}");
    expect(notesPageSource).not.toContain("setAttachmentBusyId(\"upload\")");
  });

  it("serializes autosaves and flushes pending dirty drafts on lifecycle changes", () => {
    expect(notesPageSource).toContain("const saveInFlightRef = useRef<Promise<PersistedNoteResult | null> | null>(null);");
    expect(notesPageSource).toContain("saveQueuedRef.current = true;");
    expect(notesPageSource).toContain("flushCurrentNoteSaveRef.current(false)");
    expect(notesPageSource).toContain("window.addEventListener(\"pagehide\", flushPendingSave)");
    expect(notesPageSource).toContain("window.addEventListener(\"beforeunload\", handleBeforeUnload)");
    expect(notesPageSource).toContain("confirmLeaveCurrentEditor(note.id)");
  });

  it("bounds XLSX merge ranges before materializing skipped preview cells", () => {
    const worksheetHelper =
      documentPreviewSource.match(/function renderXlsxWorksheet[\s\S]*?function renderXlsxRow/)?.[0] ?? "";
    const mergeHelper =
      documentPreviewSource.match(/function xlsxMergeInfo[\s\S]*?function xlsxMaxColumnIndex/)?.[0] ?? "";
    const referenceHelper =
      documentPreviewSource.match(/function xlsxCellReference[\s\S]*?function safeXlsxRowNumber/)?.[0] ?? "";

    expect(documentPreviewSource).toContain("const xlsxPreviewMaxColumns = 50");
    expect(documentPreviewSource).toContain("const xlsxPreviewMaxRows = 100");
    expect(documentPreviewSource).toContain("const xlsxPreviewMaxMergeRanges = 200");
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

  it("bounds compressed HWP preview sections and never invokes full-file rich rendering", () => {
    const hwpAttachmentBranch =
      notesPageSource.match(/if \(attachment\.extension === "hwp"\) \{[\s\S]*?if \(attachment\.extension === "hwpx"\)/)?.[0] ?? "";
    const hwpExtractor =
      documentPreviewSource.match(/async function extractHwpPreviewHtml[\s\S]*?function extractHwpxPreviewHtml/)?.[0] ?? "";
    const hwpDecompressor =
      documentPreviewSource.match(/function decompressHwpSectionBytes[\s\S]*?function appendHwpSectionBlocks/)?.[0] ?? "";

    expect(documentPreviewSource).toContain("const maxHwpPreviewSectionBytes = 1_500_000");
    expect(documentPreviewSource).toContain("const maxHwpPreviewTotalBytes = 4_000_000");
    expect(hwpAttachmentBranch).toContain("kind: \"html\"");
    expect(hwpExtractor).toContain("safeForRichPreview: false");
    expect(documentPreviewSource).not.toContain('import("hwp.js")');
    expect(hwpExtractor).toContain("boundedHwpSectionBytes");
    expect(hwpDecompressor).toContain("new Decompress");
    expect(hwpDecompressor).toContain("decodedLength > sectionLimit");
    expect(hwpDecompressor).toContain("hwpPreviewCompressedChunkBytes");
    expect(hwpDecompressor).not.toContain("decompressSync");
  });

  it("guards every user-facing note mutation with an explicit base revision", () => {
    expect(notesPageSource).toContain("baseRevision: number;");
    expect(notesPageSource).toContain("baseRevision: note.revision ?? 0");
    expect(notesPageSource).toContain("createRevisionedEncryptedNote({");
    expect(notesPageSource).toContain("updateRevisionedEncryptedNote({");
    expect(notesPageSource).toContain("updateRevisionedNoteAccess({");
    expect(notesPageSource).toContain("deleteRevisionedNote({");
    expect(notesPageSource).toContain("restoreRevisionedNote({");
    expect(notesPageSource).toContain("expectedRevision: editor.baseRevision");
    expect(notesPageSource).toContain("expectedRevision: note.revision ?? 0");
    expect(notesPageSource).toContain("revisionConflictNoteId.current === editor.noteId");
    expect(notesPageSource).toContain("현재 편집 내용은 그대로 유지했습니다.");
    expect(notesPageSource).toContain("onSave(note, savedDraft, editBaseRevision)");
  });
});
