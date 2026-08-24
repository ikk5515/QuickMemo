import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");

describe("VaultPage built-in knowledge tool wiring", () => {
  it("keeps heavy Dataview, Drawing and Kanban views lazy-loaded", () => {
    expect(source).toContain('const LazyDataviewBlock = lazy(');
    expect(source).toContain('const LazyDrawingView = lazy(');
    expect(source).toContain('const LazyKanbanBoard = lazy(');
    expect(source).toContain('<LazyDrawingView');
    expect(source).toContain('<LazyKanbanBoard');
  });

  it("lazy-loads and mounts the six Core workflow tools inside the unlocked Vault", () => {
    for (const component of [
      "LazyVaultAudioRecorder",
      "LazyVaultFootnotesView",
      "LazyVaultFormatConverter",
      "LazyVaultNoteComposer",
      "LazyVaultSlides",
      "LazyVaultWebViewer"
    ]) {
      expect(source).toContain(`const ${component} = lazy(`);
      expect(source).toContain(`<${component}`);
    }
    expect(source).toContain('className="vault-core-dialog-backdrop"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('if (event.key === "Tab")');
    expect(source).toContain("last.focus()");
    expect(source).toContain("onCapture={saveRecordedAudio}");
    expect(source).toContain("assertFormatConversionSourceUnchanged");
    expect(source).toContain("const noteComposerAdapter: NoteComposerAdapter");
    expect(source).toContain("ensureVaultImportJob({");
    expect(source).toContain("readComposerEntryFromServer(targetId)");
  });

  it("keeps the CodeMirror runtime out of the initial Vault route chunk", () => {
    expect(source).toContain('const LazyCodeMirrorMarkdownEditor = lazy(');
    expect(source).toContain('<LazyCodeMirrorMarkdownEditor {...props} />');
    expect(source).not.toContain('import { CodeMirrorMarkdownEditor }');
  });

  it("connects Daily Notes and its encrypted workspace state", () => {
    expect(source).toContain('<LazyDailyNotesCalendar');
    expect(source).toContain('onOpenDate={openDailyNoteForDate}');
    expect(source).toContain('folderId: input.dailyNotesFolderId');
    expect(source).toContain('templateEntryId: input.dailyNotesTemplateEntryId');
    expect(source).toContain('setCalendarCursorMonth(restored.plugins.calendar.cursorMonth)');
    expect(source).toContain('setDailyNotesFolderId(restored.plugins.calendar.folderId ?? null)');
    expect(source).toContain('onOpenMonth={openMonthlyNote}');
    expect(source).toContain('onOpenWeek={openWeeklyNote}');
    expect(source).toContain('monthNoteKeys={periodicNoteKeys.months}');
    expect(source).toContain('weekNoteKeys={periodicNoteKeys.weeks}');
  });

  it("persists Templater folder scope and preserves selection/cursor semantics", () => {
    expect(source).toContain("folderPath: input.templatesFolderPath");
    expect(source).toContain("includeDescendants: input.templatesIncludeDescendants");
    expect(source).toContain("setTemplatesFolderPath(restored.plugins.templates.folderPath ?? null)");
    expect(source).toContain("setTemplatesIncludeDescendants(restored.plugins.templates.includeDescendants)");
    expect(source).toContain("selection: selectedText");
    expect(source).toContain("applyTemplateInsertion(");
    expect(source).toContain("cursorOffset: result.cursorOffset");
    expect(source).toContain("currentSelection={templateDialogMode === \"insert\"");
  });

  it("renders safe Dataview but explicitly refuses DataviewJS", () => {
    const renderer = source.match(/function renderMarkdownCodeBlock[\s\S]*?const legacyFolderCount/u)?.[0] ?? "";
    expect(renderer).toContain('normalized === "dataview"');
    expect(renderer).toContain('<LazyDataviewBlock');
    expect(renderer).toContain('normalized === "dataviewjs"');
    expect(renderer).toContain('DataviewJS는 실행하지 않습니다.');
    expect(renderer).not.toMatch(/\beval\s*\(|\bFunction\s*\(/u);
  });

  it("passes Worker link occurrences to the shared Base and Dataview engine", () => {
    expect(source).toContain("links: summary.links");
  });

  it("preserves creation timestamps so Global Graph Animate is not inert", () => {
    expect(source).toContain("createdAt: node.createdAt");
  });

  it("exposes Drawing and Kanban creation through commands and the ribbon", () => {
    expect(source).toContain('{ id: "new-drawing"');
    expect(source).toContain('{ id: "new-kanban"');
    expect(source).toContain('aria-label="새 QuickMemo Drawing"');
    expect(source).toContain('aria-label="새 Kanban"');
    expect(source).not.toContain('"새 드로잉.excalidraw"');
  });

  it("creates an encrypted Markdown index from the current search result without mislabeling it as a curated MOC", () => {
    expect(source).toContain('{ id: "create-search-index"');
    expect(source).toContain("async function createIndexFromCurrentSearch()");
    expect(source).toContain("const candidates = filteredNotes.flatMap");
    expect(source).toContain("const result = createSearchIndexMarkdown");
    expect(source).toContain('await createEntry("markdown", requestedTitle, result.source');
    expect(source).toContain('case "create-search-index": void createIndexFromCurrentSearch()');
  });

  it("connects editable Bases, Kanban source-note links and encrypted File Recovery", () => {
    expect(source).toContain("onEditProperty={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked ? undefined : editBaseProperty}");
    expect(source).toContain("onOpenLink={openKanbanLink}");
    expect(source).toContain("<LazyVaultHistoryPanel");
    expect(source).toContain('{ icon: History, label: "File Recovery", mode: "history" }');
    expect(source).toContain(") : activeNote ? (");
    const restoreHistory = source.match(
      /function restoreHistorySnapshot[\s\S]*?const legacyFolderCount/u
    )?.[0] ?? "";
    expect(restoreHistory).toContain("dirty: true");
    expect(restoreHistory).toContain("window.setTimeout(() => void saveEntryRef.current(entryId), 0)");
  });

  it("keeps a recovery lookup lock-free but claims the path lock for an actual rewrite", () => {
    const recoveryStart = source.indexOf("void scanRecoverableVaultPathRewriteJobs");
    const recoveryEnd = source.indexOf("}, [isOnline, pathRewriteRecoveryRetry", recoveryStart);
    const recovery = recoveryStart >= 0 && recoveryEnd > recoveryStart
      ? source.slice(recoveryStart, recoveryEnd)
      : "";
    expect(recovery).toContain("if (eligibleJobs.length === 0) {");
    expect(recovery.indexOf("scanRecoverableVaultPathRewriteJobs")).toBeLessThan(
      recovery.indexOf("pathRewriteBusyRef.current = true")
    );
    expect(recovery).toContain("pathRewriteRecoveryBusyOwnerRef.current = generation");
    expect(source).toContain("const pathRewriteContentLocked = pathRewriteBusy");
    expect(source).toContain("readOnly={viewMode === \"reading\" || deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked}");
  });

  it("uses one CodeMirror editor surface for inline live preview", () => {
    expect(source).toContain('mode === "live-preview" ? "라이브 프리뷰" : "읽기 보기"');
    expect(source).toContain('mode === "live-preview" ? "라이브" : "읽기"');
    expect(source).toContain("<VaultMarkdownEditor");
    expect(source).toContain("livePreview");
    expect(source).not.toContain('className="vault-live-preview"');
  });

  it("limits Page Preview to resolved links in sanitized reading and live-preview views", () => {
    expect(source).toContain("function handleMarkdownLinkPreviewInteraction");
    expect(source).toContain('(viewMode !== "reading" && viewMode !== "live-preview") || reference.kind === "external"');
    expect(source).toContain("const target = resolution?.targetEntryId");
    expect(source).toContain("noteById.get(resolution.targetEntryId)");
    expect(source).toContain("onLinkPreviewInteraction={handleMarkdownLinkPreviewInteraction}");
    expect(source).toContain("createVaultPagePreviewContent({");
    expect(source).toContain("onLinkPreviewInteraction={handleMarkdownLinkPreviewInteraction}");
    expect(source.match(/onLinkPreviewInteraction=/gu)).toHaveLength(2);
    expect(source).toContain("plaintext popup before paint");
  });

  it("reports template note creation only after the encrypted create succeeds", () => {
    const applyTemplate = source.match(
      /async function applyTemplate[\s\S]*?function revealOutlineHeading/u
    )?.[0] ?? "";
    expect(applyTemplate).toContain('const created = await createEntry("markdown"');
    expect(applyTemplate).toContain("if (!created) return");
    expect(applyTemplate.indexOf("await createEntry")).toBeLessThan(
      applyTemplate.indexOf("템플릿으로 새 노트를 만들었습니다")
    );
    expect(applyTemplate).not.toContain('void createEntry("markdown"');
  });
});
