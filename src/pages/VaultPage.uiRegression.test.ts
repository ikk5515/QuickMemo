import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
const styles = readFileSync(join(process.cwd(), "src/styles/vault.css"), "utf8");
const attachmentRegionSource = readFileSync(
  join(process.cwd(), "src/features/vault/VaultNoteAttachmentsRegion.tsx"),
  "utf8"
);
const pathRewriteInventorySource = readFileSync(
  join(process.cwd(), "src/features/vault/pathRewriteInventory.ts"),
  "utf8"
);

function sourceBetween(start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function ruleBodiesForSelector(css: string, selector: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1]
      .split(",")
      .some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]);
}

describe("Vault workspace UI regression contract", () => {
  it("pins legacy conversion to the chosen panel and opens its new Wiki copy without replacing the HTML source", () => {
    expect(source).toContain('<VaultLegacyNote body={note.body} entryId={note.id} onCreateMarkdownCopy={stableConvertLegacyNote} />');
    expect(source).toContain('<VaultLegacyNote body={activeNote.body} entryId={activeNote.id} onCreateMarkdownCopy={convertLegacyNote} />');
    expect(sourceBetween("function convertLegacyNote(", "async function createNormalizedMarkdownCopy("))
      .toContain('openCoreTool("format", entryId)');
    const openTool = sourceBetween("function openCoreTool(", "function handleCommand(");
    expect(openTool).toContain("notesRef.current.find((note) => note.id === entryId)");
    expect(openTool).toContain("setFormatSourceEntryId(formatSource?.id ?? null)");
    const converter = sourceBetween("<LazyVaultFormatConverter", "<LazyVaultNoteComposer");
    for (const property of ["body", "folderId", "id", "revision", "title"]) {
      expect(converter).toContain(`formatSourceNote.${property}`);
      expect(converter).not.toContain(`activeNote.${property}`);
    }
    const createCopy = sourceBetween("async function createConvertedMarkdownCopy(", "function openCoreTool(");
    expect(createCopy).toContain('if (surface === "wiki")');
    expect(createCopy).toContain("setWikiOpenDocumentRequest({ id: result.noteId");
    expect(createCopy).toContain("setActiveCoreTool(null)");
    expect(createCopy).not.toMatch(/updateRevisionedNote|updateEncryptedNote|deleteRevisionedNote/u);
  });

  it("keeps resize dividers stationary during pointer and keyboard changes while animating ordinary collapse", () => {
    expect(ruleBodiesForSelector(styles, ".vault-workspace:not(.vault-workspace--wiki)")).toEqual(expect.arrayContaining([
      expect.stringMatching(/transition:\s*grid-template-columns\s+180ms\s+ease;/u)
    ]));
    for (const selector of [
      '.vault-workspace:has(.qm-sidebar-resizer[data-resizing="true"])',
      ".vault-workspace:has(.qm-sidebar-resizer:focus)",
      ".vault-workspace:has(.vault-right-panel-resizer:active)",
      ".vault-workspace:has(.vault-right-panel-resizer:focus)"
    ]) {
      expect(ruleBodiesForSelector(styles, selector)).toEqual(expect.arrayContaining([
        expect.stringMatching(/transition:\s*none;/u)
      ]));
    }
  });

  it("overrides global button minimums for compact mouse controls while preserving touch targets", () => {
    expect(ruleBodiesForSelector(styles, ".vault-tree-row")).toEqual(expect.arrayContaining([
      expect.stringMatching(/height:\s*28px;[\s\S]*min-height:\s*28px;/u),
      expect.stringMatching(/height:\s*44px;[\s\S]*min-height:\s*44px;/u)
    ]));
    for (const selector of [".vault-panel-toolbar button", ".vault-left-panel header > button"]) {
      expect(ruleBodiesForSelector(styles, selector)).toEqual(expect.arrayContaining([
        expect.stringMatching(/height:\s*32px;[\s\S]*min-height:\s*32px;/u),
        expect.stringMatching(/min-height:\s*44px;/u)
      ]));
    }
  });

  it("keeps path rewrite policy static while lazy-loading async controller work", () => {
    expect(source).toContain('from "../features/vault/pathRewriteControllerCore";');
    expect(source).toContain(
      'vaultPathRewriteControllerModulePromise ??= import("../features/vault/pathRewriteController")'
    );
    expect(source).toContain("vaultPathRewriteControllerModulePromise = null;");
    expect(source).not.toMatch(
      /from\s+"\.\.\/features\/vault\/pathRewriteController";/u
    );
  });

  it("loads Daily Notes settings only with the calendar surface", () => {
    expect(source).toContain('lazy(() => import("../features/calendar/DailyNotesSettings"))');
    expect(source).not.toContain("function DailyNotesSettings(");
    expect(source.match(/<LazyDailyNotesSettings/gu)).toHaveLength(2);
  });

  it("lets source mode fill the pane while constraining reading surfaces", () => {
    expect(ruleBodiesForSelector(
      styles,
      ".vault-note-content > .vault-codemirror:not(.vault-codemirror--live-preview)"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(/max-width:\s*none;[\s\S]*min-height:\s*100%;[\s\S]*width:\s*100%;/u)
    ]));

    for (const selector of [
      ".vault-note-content > .vault-codemirror--live-preview",
      ".vault-note-content > .vault-markdown-renderer",
      ".vault-legacy-note"
    ]) {
      expect(ruleBodiesForSelector(styles, selector)).toEqual(expect.arrayContaining([
        expect.stringMatching(/margin-inline:\s*auto;[\s\S]*max-width:\s*860px;/u)
      ]));
    }
  });

  it("keeps one shared attachment shelf above the single live Markdown editor", () => {
    const markdownContent = sourceBetween(
      '<div className="vault-note-content">',
      '<div className="vault-empty-state">'
    );
    const shelfIndex = markdownContent.indexOf("<LazyVaultNoteAttachmentsRegion");
    const pluginIndex = markdownContent.indexOf("activeMarkdownPluginView ?");
    const livePreviewIndex = markdownContent.indexOf("<VaultMarkdownEditor");

    expect(source).toContain('import("../features/vault/VaultNoteAttachmentsRegion")');
    expect(attachmentRegionSource).toContain("useVaultNoteAttachments(access.allowed ? note.id : null)");
    expect(attachmentRegionSource).toContain("<VaultNoteAttachmentsInline");
    expect(attachmentRegionSource).toContain("<LazyVaultNoteAttachmentsDialog");
    expect(markdownContent).not.toContain("vault-note-markdown-surface");
    expect(markdownContent).not.toContain("vault-note-markdown-body");
    expect(markdownContent).not.toContain("<MarkdownRenderer");
    expect(markdownContent).toMatch(/<VaultMarkdownEditor[\s\S]*?\s+livePreview\s/u);
    expect(shelfIndex).toBeGreaterThanOrEqual(0);
    expect(pluginIndex).toBeGreaterThan(shelfIndex);
    expect(livePreviewIndex).toBeGreaterThan(shelfIndex);
    expect(attachmentRegionSource).toContain("const [returnFocusTo, setReturnFocusTo]");
    expect(attachmentRegionSource).toContain("onManage={setReturnFocusTo}");
    expect(attachmentRegionSource).toContain("onClose={() => setReturnFocusTo(null)}");
    expect(source).not.toContain("subscribeNoteAttachments(");
  });

  it("keeps the empty workspace inside transiently narrow pane bounds", () => {
    expect(ruleBodiesForSelector(styles, ".vault-empty-state")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /box-sizing:\s*border-box;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*width:\s*100%;/u
        )
      ])
    );
    for (const selector of [".vault-empty-state h2", ".vault-empty-state p"]) {
      expect(ruleBodiesForSelector(styles, selector)).toEqual(expect.arrayContaining([
        expect.stringMatching(/max-width:\s*100%;[\s\S]*overflow-wrap:\s*anywhere;/u)
      ]));
    }
  });

  it("themes the CodeMirror editor and gutter from Vault colors", () => {
    expect(ruleBodiesForSelector(styles, ".vault-codemirror-editor > .cm-editor")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/background:\s*var\(--vault-bg\);[\s\S]*color:\s*var\(--vault-text\);/u)
      ])
    );
    expect(ruleBodiesForSelector(styles, ".vault-codemirror-editor > .cm-editor .cm-gutters")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/background:\s*var\(--vault-panel-muted\);[\s\S]*color:\s*var\(--vault-text-muted\);/u)
      ])
    );
  });

  it("themes CodeMirror completion surfaces and every readable completion state", () => {
    expect(ruleBodiesForSelector(
      styles,
      ".vault-codemirror-editor > .cm-editor .cm-tooltip.cm-tooltip-autocomplete"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /background:\s*var\(--vault-panel\);[\s\S]*border:\s*1px solid var\(--vault-border\);[\s\S]*color:\s*var\(--vault-text\);/u
      )
    ]));
    expect(ruleBodiesForSelector(
      styles,
      ".vault-codemirror-editor > .cm-editor .cm-tooltip-autocomplete > ul"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(/background:\s*var\(--vault-panel\);[\s\S]*color:\s*var\(--vault-text\);/u)
    ]));
    expect(ruleBodiesForSelector(
      styles,
      ".vault-codemirror-editor > .cm-editor .cm-tooltip-autocomplete > ul > li[aria-selected=\"true\"]"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(/background:\s*color-mix\([\s\S]*var\(--vault-accent\)[\s\S]*color:\s*var\(--vault-text\);/u)
    ]));
    expect(ruleBodiesForSelector(
      styles,
      ".vault-codemirror-editor > .cm-editor .cm-tooltip-autocomplete .cm-completionMatchedText"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(/color:\s*color-mix\([\s\S]*font-weight:\s*750;[\s\S]*text-decoration:\s*none;/u)
    ]));
    expect(ruleBodiesForSelector(
      styles,
      ".vault-codemirror-editor > .cm-editor .cm-tooltip-autocomplete .cm-completionDetail"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(/color:\s*var\(--vault-text-muted\);[\s\S]*opacity:\s*1;/u)
    ]));
  });

  it("keeps image tools compact and leaves editors without upload tools full-height", () => {
    expect(ruleBodiesForSelector(styles, ".vault-codemirror")).toEqual(expect.arrayContaining([
      expect.stringMatching(/display:\s*grid;[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\);/u)
    ]));
    expect(ruleBodiesForSelector(styles, ".vault-codemirror--with-image-tools")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/grid-template-rows:\s*auto minmax\(0, 1fr\);/u)
      ])
    );
    expect(ruleBodiesForSelector(styles, ".vault-codemirror-image-tools")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /background:\s*var\(--vault-panel-muted\);[\s\S]*border-bottom:\s*1px solid var\(--vault-border\);/u
        )
      ])
    );
  });

  it("starts panels closed and restores encrypted or first-time defaults without flashing", () => {
    expect(source).toContain("const [leftOpen, setLeftOpen] = useState(false);");
    expect(source).toContain("const [rightOpen, setRightOpen] = useState(false);");
    expect(source).toContain("const desktopLeftOpenRef = useRef(false);");
    expect(source).toContain("const desktopRightOpenRef = useRef(false);");
    expect(source).toContain("applyRestoredWorkspace(remoteState, record?.revision, record === null)");
    expect(source).toContain("const restorePanels = !mobileVaultLayoutSnapshot();");
  });

  it("uses a discoverable desktop chevron while preserving the mobile close and ribbon reopen controls", () => {
    expect(source).toContain('className="vault-left-panel-collapse"');
    expect(source).toContain('aria-label={mobileLayout ? "왼쪽 패널 닫기" : "왼쪽 패널 접기"}');
    expect(source).toContain('mobileLayout ? <X aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={18} />');
    expect(source).toContain('aria-controls="vault-left-panel" aria-expanded={leftOpen}');
    expect(ruleBodiesForSelector(
      styles,
      ".vault-left-panel > header > .vault-left-panel-collapse"
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /background:\s*var\(--vault-panel-muted\);[\s\S]*border:\s*1px solid var\(--vault-border\);[\s\S]*color:\s*var\(--vault-text\);/u
      )
    ]));
  });

  it("auto-opens the first note only for a new Vault and preserves an intentional empty workspace", () => {
    const restore = sourceBetween(
      "const applyRestoredWorkspace = useCallback((",
      "function keepCurrentWorkspaceAfterConflict()"
    );
    expect(restore).toContain("allowInitialEntryAutoOpen = false");
    expect(restore).toContain("initialEntryAutoOpenPendingRef.current = allowInitialEntryAutoOpen;");
    expect(source).toContain("applyRestoredWorkspace(remoteState, record?.revision, record === null)");

    const autoOpen = sourceBetween(
      "useEffect(() => {\n    if (!workspaceReady) return;\n    const requestedEntryId = searchParams.get(\"entry\");",
      "useEffect(() => {\n    setTabs((current) => current.map((tab) => {"
    );
    expect(autoOpen).toContain('requestedWorkspaceView === "graph" || tabs.length');
    expect(autoOpen).toContain("if (!initialEntryAutoOpenPendingRef.current) return;");
    expect(autoOpen).toContain("initialEntryAutoOpenPendingRef.current = false;");
    expect(autoOpen.indexOf("if (!initialEntryAutoOpenPendingRef.current) return;")).toBeLessThan(
      autoOpen.indexOf("const firstEntry = notes[0];")
    );

    const closeTab = sourceBetween("function closeTab(tabId: string)", "function activateTabInGroup(");
    expect(closeTab).toContain("initialEntryAutoOpenPendingRef.current = false;");
    expect(closeTab).toContain("setTabs((current) => current.filter((tab) => tab.id !== tabId))");
  });

  it("consumes each route panel intent once so the hamburger can stay closed", () => {
    const consumeIntent = sourceBetween("const consumeWorkspacePanelIntent = useCallback(", "const closeLeftPanel = useCallback(");
    expect(consumeIntent).toContain("handledWorkspaceRouteIntentRef.current = JSON.stringify(");
    expect(consumeIntent).toContain("new URLSearchParams(searchParams)");
    expect(consumeIntent).toContain('next.delete("panel")');
    expect(consumeIntent).toContain("{ replace: true, state: location.state }");
    expect(consumeIntent).toContain("hash: location.hash");
    expect(consumeIntent).not.toContain('next.delete("entry")');
    for (const [start, end] of [["const closeLeftPanel = useCallback(", "const closeRightPanel = useCallback("], ["const toggleLeftPanel = useCallback(", "const toggleRightPanel = useCallback("]]) {
      expect(sourceBetween(start, end)).toContain("consumeWorkspacePanelIntent();");
    }
    expect(source).toContain("const handledWorkspaceRouteIntentRef = useRef<string | null>(null);");
    const routeIntent = sourceBetween(
      "const routeIntentKey = JSON.stringify([",
      "function closeTab(tabId: string)"
    );
    expect(routeIntent).toContain("profile.uid,");
    expect(routeIntent).toContain("location.key,");
    expect(routeIntent).toContain("requestedWorkspaceView,");
    expect(routeIntent).toContain("requestedWorkspacePanel");
    expect(routeIntent).toContain("handledWorkspaceRouteIntentRef.current === routeIntentKey");
    expect(routeIntent).toContain("handledWorkspaceRouteIntentRef.current = routeIntentKey;");
    expect(routeIntent.indexOf("handledWorkspaceRouteIntentRef.current = routeIntentKey;")).toBeLessThan(
      routeIntent.indexOf('requestedWorkspaceView === "graph"')
    );

    const showLeftPanel = sourceBetween(
      "const showLeftPanel = useCallback(",
      "const showRightPanel = useCallback("
    );
    expect(showLeftPanel).not.toContain("[leftOpen,");
    expect(showLeftPanel).toContain("[consumeWorkspacePanelIntent, mobileLayout, rememberMobileDrawerTrigger]");
  });

  it("offers a copy-only Markdown normalization for complete HTML blocks", () => {
    const conversion = sourceBetween(
      "async function createNormalizedMarkdownCopy()",
      "async function exportObsidianZip()"
    );
    expect(conversion).toContain("previewMarkdownHtmlNormalization(activeDraft.body)");
    expect(conversion).toContain("preview.changedBlockCount < 1");
    expect(conversion).toContain("preview.warnings[0]?.message");
    expect(conversion).toContain("원본과 첨부·공유 설정은 변경하지 않습니다");
    expect(conversion).toContain("preview.markdown");
    expect(conversion).toContain("{ folderId: activeDraft.folderId }");
    expect(source).toContain("HTML → Markdown 복사");
  });

  it("includes bounded, integrity-indexed attachments in explicit Vault ZIP exports", () => {
    const vaultExport = sourceBetween(
      "async function exportObsidianZip()",
      "async function importObsidianZip(file: File)"
    );
    expect(vaultExport).toContain("collectVaultAttachmentBackup");
    expect(vaultExport).toContain("vaultAttachmentBackupByteBudget(baseSources)");
    expect(vaultExport).toContain("occupiedPaths: baseSources.map((source) => source.path)");
    expect(vaultExport).toContain("signal: abortController.signal");
    expect(vaultExport).toContain("attachmentBackup.manifestSource");
    expect(vaultExport).toContain("복호화된 노트와 첨부파일");
    expect(source).toContain('aria-label="노트와 첨부파일을 복호화해 Obsidian ZIP 내보내기"');
    expect(source).toContain("QuickMemo-Attachments-Manifest.json");
  });

  it("unwraps durable rewrite errors into actionable concurrent rename and move messages", () => {
    const moveEntry = sourceBetween("async function moveEntryToFolder", "async function moveFolder(");
    const moveFolder = sourceBetween("async function moveFolder(", "async function moveContextTarget(");
    const renameFolder = sourceBetween("async function renameFolder(", "async function renameEntry(");
    const renameEntry = sourceBetween("async function renameEntry(", "async function restoreTrashEntry(");
    for (const section of [moveEntry, moveFolder, renameFolder, renameEntry]) {
      expect(section).toContain("caught instanceof VaultPathRewriteControllerError");
      expect(section).toContain("caught.cause");
    }
    expect(moveEntry).toContain("underlyingError instanceof VaultNameConflictError");
    expect(moveFolder).toContain("underlyingError instanceof VaultFolderApiError");
    expect(renameFolder).toContain("underlyingError instanceof VaultNameConflictError");
    expect(renameEntry).toContain("underlyingError instanceof NoteRevisionConflictError");
    expect(renameEntry).toContain("setConflictedEntryIds");
  });

  it("plans from one aligned subscription generation and a fixed server manifest", () => {
    const loader = sourceBetween(
      "function captureCurrentRevisionedIndexGeneration()",
      "async function flushOwnedRewriteDrafts("
    );
    expect(loader).not.toContain("loadOwnedVaultCutoverInventory");
    expect(loader).not.toContain("loadOwnedVaultFolderInventory");
    expect(loader).not.toContain("getDocsFromServer");
    expect(loader).not.toContain("decryptVaultNotes");
    expect(loader).not.toContain("decryptVaultFolders");
    expect(loader).toContain("noteSubscriptionServerReadyRef.current");
    expect(loader).toContain("folderSubscriptionServerReadyRef.current");
    expect(loader).toContain("buildAlignedVaultPathRewriteIndex({");
    expect(loader).not.toContain("rawFingerprintNotes:");
    expect(loader).not.toContain("rawFingerprintFolders:");
    expect(loader).toContain("loadVaultPathRewriteInventoryBinding({");
    expect(loader).toContain("notes: generation.rawOwnerNotes");
    expect(loader).toContain("folders: generation.rawOwnerFolders");
    expect(loader).not.toContain("folderPathsRef.current");
    expect(pathRewriteInventorySource).toContain("vaultPathRewriteGenerationAligned({");
    expect(pathRewriteInventorySource).toContain("const folderPaths = buildVaultPaths([...input.decryptedFolders]);");
    expect(pathRewriteInventorySource).toContain("path: vaultEntryPath(note, folderPaths)");
    expect(pathRewriteInventorySource).toContain("if (inventoryManifest) return { inventoryManifest };");
    expect(pathRewriteInventorySource).toContain(
      "inventoryFingerprint: await vaultPathRewriteInventoryFingerprint(input)"
    );
    expect(pathRewriteInventorySource).toContain(
      "throw new VaultPathRewriteInventorySnapshotLagError();"
    );

    const indexBuilder = sourceBetween(
      "async function buildCurrentRevisionedIndexEntries()",
      "async function flushOwnedRewriteDrafts("
    );
    expect(indexBuilder).toContain("generationDeadline ??= Date.now() + 2_000;");
    expect(indexBuilder).toContain("generationChangeCount <= 3");
    expect(indexBuilder).toContain("waitForVaultPathRewriteGenerationChange(");
    expect(indexBuilder).toContain("VaultPathRewriteInventorySnapshotLagError");
    expect(indexBuilder).not.toContain("attempt < 40");

    for (const section of [
      sourceBetween("async function moveEntryToFolder", "async function moveFolder("),
      sourceBetween("async function moveFolder(", "async function moveContextTarget("),
      sourceBetween("async function renameFolder(", "async function renameEntry("),
      sourceBetween("async function renameEntry(", "async function restoreTrashEntry(")
    ]) {
      expect(section).toContain("...server.inventoryBinding");
      expect(section).toContain("server.folderPaths");
    }
  });

  it("runs bounded terminal path cleanup once per unlocked profile after recovery", () => {
    expect(source).toContain("const pathRewriteCleanupOwnerRef = useRef<string | null>(null);");
    const recoveryEffect = sourceBetween(
      "const generation = pathRewriteRecoveryGenerationRef.current + 1;",
      "\n  }, ["
    );
    expect(recoveryEffect).toContain("pathRewriteCleanupOwnerRef.current !== profile.uid");
    expect(recoveryEffect).toContain("pathRewriteCleanupOwnerRef.current = profile.uid;");
    expect(recoveryEffect).toContain("const eligibleJobs = jobs.filter");
    expect(recoveryEffect).toContain("deferredRecoveryTimer = window.setTimeout");
    expect(recoveryEffect).toContain(
      "scheduleDeferredRecovery(recovered.job.recoveryAfterMs ?? 250);"
    );
    expect(recoveryEffect).toContain("setPathRewriteJob(recovered.job);");
    expect(recoveryEffect).toContain("const scheduleFailedRecovery = () => {");
    expect(recoveryEffect).toContain("automaticVaultPathRewriteRetryDelayMs(failureCount)");
    expect(recoveryEffect).toContain('job.lastErrorCode === "write-failed"');
    expect(recoveryEffect).toContain("if (hasMore && shouldContinueImmediately)");
    expect(recoveryEffect).toContain("automaticJobs.some((job) => job.stepCount > 0)");
    expect(recoveryEffect.indexOf("if (eligibleJobs.length === 0) {")).toBeLessThan(
      recoveryEffect.indexOf("pathRewriteBusyRef.current = true;")
    );
    expect(recoveryEffect).toContain("flushVaultDraftsBeforePathRewriteRecovery({");
    expect(recoveryEffect.indexOf("flushVaultDraftsBeforePathRewriteRecovery({")).toBeLessThan(
      recoveryEffect.indexOf("recoverDurablePathRewriteJob(job, continuationIsCurrent)")
    );
    expect(recoveryEffect).toContain(
      "void scheduleTerminalVaultPathRewriteCleanup(profile.uid).catch(() => undefined);"
    );
    expect(recoveryEffect.indexOf("}).finally(() => {")).toBeLessThan(
      recoveryEffect.indexOf("scheduleTerminalVaultPathRewriteCleanup(profile.uid)")
    );
  });

  it("debounces dirty entries independently and never immediately retries edits made during a save", () => {
    const saveEntry = sourceBetween(
      "const saveEntry = useCallback(async (",
      "useLayoutEffect(() => {\n    saveEntryRef.current = saveEntry;"
    );
    expect(saveEntry).toContain("entryAutosaveRef.current?.cancel(entryId);");
    expect(saveEntry).toContain("const latest = draftsRef.current[entryId];");
    expect(saveEntry).toContain("const reconciled = reconcileDraftAfterSave(latest, canonicalSubmitted, result.revision);");
    expect(saveEntry).toContain("persistedRevisionRelation(currentCandidate.revision, result.revision)");
    expect(saveEntry).toContain('revisionRelation === "superseded"');
    expect(saveEntry).toContain("latestBeforeCommit.baseRevision > result.revision");
    expect(saveEntry).toContain("const nextDrafts = { ...draftsRef.current, [entryId]: reconciled };");
    expect(saveEntry).toContain("setDrafts(nextDrafts);");
    expect(saveEntry).toContain("entryAutosaveRetryDelayMs(failureCount)");
    expect(saveEntry).toContain('result === "retryable-failure"');
    expect(saveEntry).toContain("() => void saveEntryRef.current(entryId)");
    expect(saveEntry).not.toContain("window.setTimeout(() => void saveEntryRef.current(entryId), 0)");
    expect(saveEntry).toContain("if (!draft.title.trim()) {");
    expect(saveEntry).toContain("draft = { ...draft, title: note.title };");
    expect(saveEntry.indexOf("draft = { ...draft, title: note.title };")).toBeLessThan(
      saveEntry.indexOf("result = await saveEncryptedVaultEntry(")
    );
    expect(saveEntry).toContain("빈 이름은 저장하지 않고 기존 이름을 유지했으며 Markdown 본문은 암호화 저장했습니다.");

    const autosaveEffect = sourceBetween(
      "const dirtyEntryIds = new Set<string>();",
      "function updateEntryDraft("
    );
    expect(autosaveEffect).toContain("autosave.schedule(");
    expect(autosaveEffect).toContain("entryId,\n        draft,\n        vaultEntryAutosaveIdleMs(entryKind)");
    expect(autosaveEffect).toContain("() => void saveEntryRef.current(entryId)");
    expect(autosaveEffect).toContain("autosave.retain(dirtyEntryIds);");
    expect(autosaveEffect).toContain("entryAutosaveRef.current?.cancelAll();");
  });
});
