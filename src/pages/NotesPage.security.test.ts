import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");
const attachmentPreviewSource = readFileSync(
  join(process.cwd(), "src/components/PublicAttachmentPreviewModal.tsx"),
  "utf8"
);
const publicPdfPreviewSource = readFileSync(
  join(process.cwd(), "src/components/PublicPdfCanvasPreview.tsx"),
  "utf8"
);
const documentPreviewSource = readFileSync(join(process.cwd(), "src/lib/documentPreview.ts"), "utf8");
const pdfPreviewCanvasSource = readFileSync(join(process.cwd(), "src/lib/pdfPreviewCanvas.ts"), "utf8");

describe("NotesPage security controls", () => {
  it("fails closed at the folder cap without optimistically appending an unconfirmed folder", () => {
    const folderSubscriptionFlow = notesPageSource.match(
      /return subscribeNoteFolders\(profile\.uid[\s\S]*?\n\s*\}, \[privateKey, profile\]\);/
    )?.[0] ?? "";
    const folderCreationFlow = notesPageSource.match(
      /async function createFolder[\s\S]*?async function removeFolder/
    )?.[0] ?? "";

    expect(folderSubscriptionFlow).toContain("subscriptionError instanceof NoteFolderLimitError");
    expect(folderSubscriptionFlow).toContain("subscriptionError.message");
    expect(folderCreationFlow).toContain("folders.length >= maxNoteFoldersPerOwner");
    expect(folderCreationFlow.indexOf("folders.length >= maxNoteFoldersPerOwner"))
      .toBeLessThan(folderCreationFlow.indexOf("createNoteFolder("));
    expect(folderCreationFlow).toContain("folderCreationInFlightRef.current");
    expect(folderCreationFlow).toContain("folderCreationInFlightRef.current = false");
    expect(folderCreationFlow).toContain("createError instanceof NoteFolderLimitError");
    expect(folderCreationFlow).not.toContain("setFolders(");
  });

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
    const pdfPreviewBranch = attachmentPreviewSource.match(/preview\.kind === "pdf" && preview\.bytes \? \([\s\S]*?\) : preview\.kind === "docx"/)?.[0] ?? "";

    expect(notesPageSource).toContain('import AttachmentPreviewModal from "../components/PublicAttachmentPreviewModal"');
    expect(notesPageSource).not.toContain("function PdfCanvasPreview");
    expect(pdfPreviewBranch).toContain("<PublicPdfCanvasPreview");
    expect(pdfPreviewBranch).toContain("bytes={preview.bytes}");
    expect(pdfPreviewBranch).not.toContain("<iframe");
    expect(pdfPreviewBranch).not.toContain("<object");
    expect(pdfPreviewBranch).not.toContain("<embed");
    expect(attachmentPreviewSource).toContain('lazy(() => import("./PublicPdfCanvasPreview"))');
    expect(publicPdfPreviewSource).toContain("maxPdfPreviewCanvasPixels");
    expect(publicPdfPreviewSource).toContain("retainedCanvasPixels");
    expect(publicPdfPreviewSource).toContain("remainingCanvasPixels");
    expect(publicPdfPreviewSource).toContain("pdfPreviewCanvasLayout");
    expect(publicPdfPreviewSource).toContain("layout.canvasPixels > maxPdfPreviewCanvasPixels");
    expect(publicPdfPreviewSource).toContain("layout.canvasPixels > remainingCanvasPixels");
    expect(publicPdfPreviewSource).toContain("disableFontFace: true");
    expect(publicPdfPreviewSource).toContain("enableXfa: false");
    expect(publicPdfPreviewSource).toContain("useWorkerFetch: false");
    expect(publicPdfPreviewSource).toContain("annotationMode: pdfjs.AnnotationMode.DISABLE");
    expect(publicPdfPreviewSource).toContain("releaseCanvases");
    expect(publicPdfPreviewSource).toContain("page.cleanup()");
    expect(pdfPreviewCanvasSource).toContain("maxPdfPreviewPageCssHeight");
    expect(pdfPreviewCanvasSource).toContain("maxPdfPreviewTotalCanvasPixels");
    expect(pdfPreviewCanvasSource).not.toContain("Math.max(0.25");
  });

  it("renders DOCX previews through sanitized sandboxed srcDoc instead of the live app DOM", () => {
    const docxPreviewBranch = attachmentPreviewSource.match(/preview\.kind === "docx" \? \([\s\S]*?\) : preview\.kind === "hwp"/)?.[0] ?? "";
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

  it("sanitizes rich attachment preview HTML at the shared rendering boundary", () => {
    const htmlPreviewBranch = attachmentPreviewSource.match(/preview\.kind === "html" \? \([\s\S]*?\) : \(/)?.[0] ?? "";

    expect(htmlPreviewBranch).toContain("sanitizeEditorHtml(preview.html ?? \"\")");
    expect(htmlPreviewBranch).not.toContain("__html: preview.html");
    expect(notesPageSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("filters active DOCX preview links, resources, and event attributes before sandboxing", () => {
    expect(documentPreviewSource).toContain("function sanitizeDocxPreviewAttributes");
    expect(documentPreviewSource).toContain("attributeName.startsWith(\"on\")");
    expect(documentPreviewSource).toContain("function safeDocxPreviewHref");
    expect(documentPreviewSource).toContain("url.protocol === \"http:\" || url.protocol === \"https:\"");
    expect(documentPreviewSource).toContain("!url.username");
    expect(documentPreviewSource).toContain("!url.password");
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

  it("bounds uploads, preflights server state, and shares one cancellable signal", () => {
    const attachmentUploadFlow =
      notesPageSource.match(/async function uploadAttachmentFiles[\s\S]*?async function noteKeyForDownload/)?.[0] ?? "";

    expect(notesPageSource).toContain("AttachmentUploadProgressToast");
    expect(notesPageSource).toContain("role=\"progressbar\"");
    expect(notesPageSource).toContain("const maximumAttachmentBatchFiles = 20");
    expect(attachmentUploadFlow).toContain("files.slice(0, maximumAttachmentBatchFiles)");
    expect(attachmentUploadFlow).toContain(
      "getAllNoteAttachmentsFromServer(noteTarget.noteId, controller.signal)"
    );
    expect(attachmentUploadFlow).toContain(
      "serverAttachments.length + validFiles.length > publicNoteShareMaxAttachmentCount"
    );
    expect(notesPageSource).toContain("onUploadProgress: (progress) =>");
    expect(notesPageSource).toContain("attachmentUploadOverallPercent");
    expect(notesPageSource).toContain("encryptAttachmentBlob(file, noteTarget.noteKey");
    expect(attachmentUploadFlow).toContain("}, controller.signal)");
    expect(attachmentUploadFlow).toContain("signal: controller.signal");
    expect(attachmentUploadFlow).toContain("privateNoteAttachmentNameFields(");
    expect(notesPageSource).toContain("reencryptAttachmentBlob(");
    expect(attachmentUploadFlow).not.toContain("new Uint8Array(await file.arrayBuffer())");
    expect(attachmentUploadFlow).not.toContain("encryptBytes(fileBytes");
    expect(attachmentUploadFlow).not.toContain("setAttachmentUploadProgress(encryptedFile");
    expect(attachmentUploadFlow).toContain("let completedFileCount = 0");
    expect(attachmentUploadFlow).toContain("completedFileCount += 1");
    expect(attachmentUploadFlow).toContain("`${completedFileCount}/${validFiles.length}개 파일은 암호화해 첨부했습니다.`");
    expect(notesPageSource).toContain("onCancel={() => attachmentUploadControllerRef.current?.abort()}");
    expect(notesPageSource).toContain("업로드 취소");
  });

  it("uses the bounded clipboard image pipeline with abort and cleanup", () => {
    const imagePreparationFlow = notesPageSource.match(
      /async function imageFileToResizedDataUrl[\s\S]*?export function decodeTextAttachmentPreview/
    )?.[0] ?? "";

    expect(imagePreparationFlow).toContain("prepareVaultClipboardImages([file], { signal })");
    expect(imagePreparationFlow).toContain("signal?.throwIfAborted()");
    expect(imagePreparationFlow).toContain("bytesToBase64(image.bytes)");
    expect(imagePreparationFlow).toContain("clearPreparedVaultClipboardImages(prepared)");
    expect(notesPageSource).toContain("inlineImageControllerRef.current?.abort()");
    expect(notesPageSource).toContain("previewImageControllerRef.current?.abort()");
    expect(notesPageSource).not.toContain("canvas.toDataURL(");
  });

  it("keeps attachment actions in read and edit views with replaceable cancellation", () => {
    const notePreviewFlow = notesPageSource.match(
      /function NotePreviewModal[\s\S]*?function NoteInsightModal/
    )?.[0] ?? "";
    const closePreviewFlow = notesPageSource.match(
      /function closeAttachmentPreview[\s\S]*?function cancelAttachmentDownload/
    )?.[0] ?? "";
    const previewDownloadFlow = notesPageSource.match(
      /async function previewAttachment[\s\S]*?async function uploadPreviewAttachments/
    )?.[0] ?? "";

    expect(notePreviewFlow).toContain("<RichMemoEditor");
    expect(notePreviewFlow).toContain("<ReadonlyNoteRenderer");
    expect(notePreviewFlow).toContain(")}\n        <AttachmentList");
    expect(notesPageSource).toContain("{editor.noteId && activeRemoteNote && (");
    expect(closePreviewFlow).toContain("attachmentPreviewControllerRef.current?.abort()");
    expect(closePreviewFlow).toContain("URL.revokeObjectURL(attachmentPreviewUrl.current)");
    expect(previewDownloadFlow).toContain("attachmentPreviewControllerRef.current?.abort()");
    expect(previewDownloadFlow).toContain("attachmentDownloadControllerRef.current?.abort()");
    expect(previewDownloadFlow).toContain("attachmentDownloadGeneration.current += 1");
    expect(previewDownloadFlow).toContain("closeAttachmentPreview()");
    expect(previewDownloadFlow).toContain("decryptAttachmentFile(noteId, attachment, controller.signal)");
    expect(previewDownloadFlow).toContain("decryptAttachmentBlob(noteId, attachment, controller.signal)");
    expect(previewDownloadFlow).toContain("downloadBlob(blob, attachmentDownloadName(attachment))");
    expect(notesPageSource).toContain(
      "onClick={() => previewing ? onCancelPreview() : onPreview(attachment)}"
    );
    expect(notesPageSource).toContain(
      "onClick={() => downloading ? onCancelDownload() : onDownload(attachment)}"
    );
  });

  it("offers upload cancellation only while the active phase can honor it", () => {
    const progressToastFlow = notesPageSource.match(
      /function AttachmentUploadProgressToast[\s\S]*?function AttachmentList/
    )?.[0] ?? "";

    expect(progressToastFlow).toContain('progress.phase === "preparing"');
    expect(progressToastFlow).toContain('progress.phase === "encrypting"');
    expect(progressToastFlow).toContain('progress.phase === "uploading"');
    expect(progressToastFlow).toContain("{canCancel ? (");
    expect(progressToastFlow).not.toContain("{!isTerminal ? (");
  });

  it("allows only validated static raster attachments in the note preview", () => {
    expect(notesPageSource).toContain('"png", "jpg", "jpeg", "webp"');
    expect(notesPageSource).toContain(
      'isPublicShareRasterImageExtension(attachment.extension) && attachment.extension !== "gif"'
    );
    expect(notesPageSource).toContain("safeRasterImageBytes(plainBytes, mimeType)");
    expect(notesPageSource).toContain('kind: "image"');
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
      notesPageSource.match(/function sharedAttributionHtml[\s\S]*?function sharedAttributionLabel/)?.[0] ?? "";
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

  it("keeps the last-good v1 snapshot when an edit cannot be synchronized", () => {
    const syncFlow =
      notesPageSource.match(/async function syncPublicSharesForNote[\s\S]*?async function migrateLegacyPublicShare/)?.[0] ?? "";

    expect(syncFlow).toContain("throw new NoteRevisionConflictError(expectedSourceRevision, sourceState.revision)");
    expect(syncFlow).toContain("legacySnapshotWithoutKey = true");
    expect(syncFlow).toContain("마지막으로 성공한 내용을 유지합니다.");
    expect(syncFlow).not.toContain("failClosedPublicShare");
    expect(syncFlow).not.toContain("revokePublicNoteShare");
    expect(syncFlow).not.toContain("deletePublicNoteShare");
    expect(syncFlow).not.toContain("removeStoredPublicShareUrl");
    expect(syncFlow).not.toContain("removeStoredPublicShareContentKey");
    expect(notesPageSource).not.toContain("async function failClosedPublicShare");
  });

  it("fails closed instead of creating a legacy share while v2 is required", () => {
    const openShareDialog =
      notesPageSource.match(/async function openPublicShareDialog\(\)[\s\S]*?async function secureShareOwnerIdToken/)?.[0] ?? "";
    const createLegacyShare =
      notesPageSource.match(/async function createCurrentPublicShare\(password = ""\)[\s\S]*?async function copyPublicShareUrl/)?.[0] ?? "";

    expect(openShareDialog).toContain("secureShareFlags.clientV2Enabled");
    expect(openShareDialog).toContain("!secureShareFlags.v2Enabled");
    expect(openShareDialog).toContain("새 공유 링크 생성을 차단했습니다.");
    expect(openShareDialog.indexOf("새 공유 링크 생성을 차단했습니다.")).toBeLessThan(
      openShareDialog.indexOf("setPublicShareOpen(true)")
    );
    expect(createLegacyShare).toContain("if (secureShareFlags.clientV2Enabled)");
    expect(createLegacyShare).toContain("기존 방식의 공유 링크를 새로 만들 수 없습니다.");
    expect(createLegacyShare.indexOf("if (secureShareFlags.clientV2Enabled)")).toBeLessThan(
      createLegacyShare.indexOf("const shareId = await createPublicNoteShare")
    );
  });

  it("refreshes server feature readiness before opening secure share settings", () => {
    const refreshHelper =
      notesPageSource.match(/async function refreshSecureShareSettingsFeatureFlags[\s\S]*?async function openSecureShareSettingsForCreate/)?.[0] ?? "";
    const createFlow =
      notesPageSource.match(/async function openSecureShareSettingsForCreate[\s\S]*?async function selectSecureShareForManagement/)?.[0] ?? "";
    const editFlow =
      notesPageSource.match(/async function openSecureShareSettingsForEdit[\s\S]*?async function saveSecureShareSettings/)?.[0] ?? "";

    expect(refreshHelper).toContain("await getSecureShareFeatureStatus()");
    expect(refreshHelper).toContain("assertCurrentSecureShareOwnerOperation(operation)");
    expect(refreshHelper).toContain("if (!nextFlags.v2Enabled)");
    expect(refreshHelper.indexOf("setSecureShareFlags(nextFlags)"))
      .toBeLessThan(refreshHelper.indexOf("if (!nextFlags.v2Enabled)"));
    expect(createFlow).toContain("await refreshSecureShareSettingsFeatureFlags(operation)");
    expect(createFlow.indexOf("await refreshSecureShareSettingsFeatureFlags(operation)"))
      .toBeLessThan(createFlow.indexOf("setSecureShareSettingsOpen(true)"));
    expect(editFlow).toContain("await refreshSecureShareSettingsFeatureFlags(operation)");
    expect(editFlow.indexOf("await refreshSecureShareSettingsFeatureFlags(operation)"))
      .toBeLessThan(editFlow.indexOf("setSecureShareSettingsOpen(true)"));
  });

  it("keeps email draft handoff client-only, fail-closed, and outside share rollback", () => {
    const draftBoundary =
      notesPageSource.match(/function requestSecureShareEmailDraft\([\s\S]*?function forgetSecureShareUrl/)?.[0] ?? "";
    const saveFlow =
      notesPageSource.match(/async function saveSecureShareSettings[\s\S]*?function composeSecureShareEmail/)?.[0] ?? "";
    const composeFlow =
      notesPageSource.match(/function composeSecureShareEmail[\s\S]*?async function copySecureShareUrl/)?.[0] ?? "";

    expect(draftBoundary).toContain("requestSecureShareEmailDraftWithoutRollback");
    expect(draftBoundary).toContain("expectedOrigin: window.location.origin");
    expect(draftBoundary).toContain("expectedShareId: shareId");
    expect(draftBoundary).not.toContain("caught.message");
    expect(draftBoundary).not.toContain("console.");
    expect(saveFlow).toContain("requestSecureShareEmailDraft(");
    expect(saveFlow).not.toContain("launchSecureShareEmailDraft(");
    expect(saveFlow.indexOf("const updatedShare = parseSecureShareMutationResponse"))
      .toBeLessThan(saveFlow.indexOf("requestSecureShareEmailDraft("));
    expect(saveFlow.lastIndexOf("const activeShare = parseSecureShareMutationResponse"))
      .toBeLessThan(saveFlow.lastIndexOf("requestSecureShareEmailDraft("));
    expect(composeFlow).toContain("!secureShareFlags.emailEnabled");
    expect(composeFlow).not.toContain("getSecureShareOwnerDetails");
  });

  it("clears transient invitation recipients across every owner identity lifecycle", () => {
    const ownerLifecycle =
      notesPageSource.match(/useEffect\(\(\) => {\n {4}const pageGeneration = secureShareOwnerPageGeneration\.current \+ 1;[\s\S]*?\}, \[firebaseUser, privateKey, profile\?\.uid\]\);/)?.[0] ?? "";

    expect(ownerLifecycle).toContain("const emailRecipientMemory = secureShareEmailRecipientsById.current");
    expect(ownerLifecycle.indexOf("emailRecipientMemory.clear()"))
      .toBeLessThan(ownerLifecycle.indexOf("if ("));
    expect(ownerLifecycle.lastIndexOf("emailRecipientMemory.clear()"))
      .toBeGreaterThan(ownerLifecycle.indexOf("controller.abort()"));
  });

  it("keeps attachment upload, preview, download, and delete pending states independent", () => {
    expect(notesPageSource).toContain("interface AttachmentActionBusyState");
    expect(notesPageSource).toContain("deletingIds: string[];");
    expect(notesPageSource).toContain("downloadingId: string | null;");
    expect(notesPageSource).toContain("previewingId: string | null;");
    expect(notesPageSource).toContain("attachmentUploadInFlightRef");
    expect(notesPageSource).not.toContain("disabled={Boolean(busyId)}");
    expect(notesPageSource).not.toContain("setAttachmentBusyId(\"upload\")");
    expect(notesPageSource).toContain("mimeType: safePublicShareAttachmentMimeType(extension)");
    expect(notesPageSource).not.toContain('mimeType: (file.type || "application/octet-stream")');
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

  it("keeps Vault storage formats out of the legacy TipTap editor and validates saves", () => {
    const createLegacyNote = notesPageSource.match(
      /const created = await createRevisionedEncryptedNote\(\{[\s\S]*?\n\s*\}\);/u
    )?.[0] ?? "";

    expect(notesPageSource).toContain("nextNotes.filter(isLegacyHtmlNoteDocument)");
    expect(notesPageSource).toContain("notes.filter(isLegacyHtmlNoteDocument)");
    expect(notesPageSource).toContain("!isLegacyHtmlNoteDocument(rawNote)");
    expect(notesPageSource).toContain('expectedContentFormat: "legacy-html-v1"');
    expect(notesPageSource).toContain('expectedEntryKind: "legacy-html"');
    // Missing format fields are the backward-compatible legacy identity. This
    // keeps a flag-off/code-first deployment compatible with the live Rules
    // and with the historical unrevisioned folder compatibility path.
    expect(createLegacyNote).not.toContain("contentFormat:");
    expect(createLegacyNote).not.toContain("entryKind:");
  });

  it("preserves deletion-metadata-free owned legacy notes while scoping foreign reads", () => {
    const legacySubscription = notesPageSource.match(
      /export function subscribeLegacyNotesReadOnly[\s\S]*?function legacyExportFileName/u
    )?.[0] ?? "";
    const ownerQuery = legacySubscription.match(
      /ownerUid === uid[\s\S]*?: query\(/u
    )?.[0] ?? "";
    const foreignQuery = legacySubscription.slice(ownerQuery.length);

    expect(ownerQuery).toContain('where("ownerUid", "==", uid)');
    expect(ownerQuery).not.toContain('where("isDeleted", "==", false)');
    expect(ownerQuery).not.toContain('where("participantUids", "array-contains", uid)');
    expect(foreignQuery).toContain('where("ownerUid", "==", ownerUid)');
    expect(foreignQuery).toContain('where("isDeleted", "==", false)');
    expect(foreignQuery).toContain('where("participantUids", "array-contains", uid)');
  });
});
