import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const vaultPageSource = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
const vaultTrashDialogSource = readFileSync(
  join(process.cwd(), "src/features/vault/VaultTrashDialog.tsx"),
  "utf8"
);
const vaultClipboardPasteFlowSource = readFileSync(
  join(process.cwd(), "src/features/vault/vaultClipboardPasteFlow.ts"),
  "utf8"
);
const vaultPastedImageFolderSource = readFileSync(
  join(process.cwd(), "src/features/vault/vaultPastedImageFolder.ts"),
  "utf8"
);
const codeMirrorMarkdownEditorSource = readFileSync(
  join(process.cwd(), "src/features/vault/CodeMirrorMarkdownEditor.tsx"),
  "utf8"
);
const vaultArchivedFilePreviewSource = readFileSync(
  join(process.cwd(), "src/features/vault/VaultArchivedFilePreview.tsx"),
  "utf8"
);

describe("VaultPage security boundaries", () => {
  it("binds the image readiness wait to the original session and scope before the guarded save", () => {
    const paste = vaultPageSource.match(/async function pasteImagesIntoMarkdownEntry[\s\S]*?async function /u)?.[0] ?? "";
    const commit = paste.match(/commitSource: async[\s\S]*?confirmAssetDestination:/u)?.[0] ?? "";
    expect(paste.indexOf("const sourceSessionSignal = decryptionSession.signal"))
      .toBeLessThan(paste.indexOf("await import("));
    expect(commit).toContain("requireCurrentAccessScope()");
    expect(commit).toContain("decryptionSession.assertSession(profile.uid, privateKey)");
    expect(commit).toContain("sessionSignal: sourceSessionSignal");
    expect(commit).toContain("isReady: () => vaultNameWritesReadyRef.current");
    expect(commit.indexOf("await pasteModule.waitForVaultClipboardSourceReadiness"))
      .toBeLessThan(commit.indexOf("await saveEntryRef.current"));
    expect(commit).toContain("candidate.body.includes(source)");
    expect(commit).toContain("(candidate.revision ?? 0) > minimumRevision");
    expect(commit).toContain("vaultPasteLockId: destination.lockId");
  });

  it("routes asset embeds through the signature-checked Blob preview instead of rendering asset JSON", () => {
    const embedRenderer = vaultPageSource.match(
      /function renderMarkdownEmbed[\s\S]*?async function copyCurrent/u
    )?.[0] ?? "";
    const assetBranch = embedRenderer.match(
      /if \(target\.entryKind === "asset"\)[\s\S]*?const targetBody/u
    )?.[0] ?? "";

    expect(assetBranch).toContain("decodedAssetForEntry(target.id)");
    expect(assetBranch).toContain("<VaultAssetPreview");
    expect(assetBranch).not.toContain("previewTextFromHtml");
    expect(assetBranch).not.toContain("target.body");
  });

  it("invalidates late decrypt continuations and wipes decrypted refs on unmount", () => {
    const cleanup = vaultPageSource.match(
      /useEffect\(\(\) => \(\) => \{[\s\S]*?\n\s{2}\}, \[\]\);/u
    )?.[0] ?? "";
    expect(cleanup).toContain("decryptGeneration.current += 1");
    expect(cleanup).toContain("workspaceAccessScopeGenerationRef.current += 1");
    expect(cleanup).toContain("notesRef.current = []");
    expect(cleanup).toContain("foldersRef.current = []");
    expect(cleanup).toContain("draftsRef.current = {}");
    expect(cleanup).toContain("knowledgeEntriesRef.current.clear()");
    expect(cleanup).toContain("workspaceInteractionDuringLoadRef.current.clear()");

    const decryptEffect = vaultPageSource.match(
      /const generation = decryptGeneration\.current \+ 1;[\s\S]*?\n\s{2}\}, \[commitFolders/u
    )?.[0] ?? "";
    expect(decryptEffect).toContain("cancelled || decryptGeneration.current !== generation");
    expect(decryptEffect).toContain("cancelled = true");
  });

  it("wipes note-derived plaintext when the authorized folder listener fails", () => {
    const folderSubscription = vaultPageSource.match(
      /return subscribeNoteFolders\(profile\.uid,[\s\S]*?\n\s{2}\}, \[clearVaultPlaintextForAccessScope, decryptionSession, privateKey, profile\.uid, vaultIntegrityRetryAttempt\]\);/u
    )?.[0] ?? "";
    const errorCallback = folderSubscription.match(/\}, \(\) => \{[\s\S]*?\}, \(allFolders, metadata\) =>/u)?.[0] ?? "";
    expect(errorCallback).toContain("clearVaultPlaintextForAccessScope();");
    expect(errorCallback).toContain("setFolderServerReservationSignature(null)");
    expect(errorCallback).toContain("setNoteServerReservationSignature(null)");
    expect(errorCallback).not.toContain("preserveAuthorizedVaultDrafts");
  });

  it("restores only reauthorized dirty drafts after a folder contraction clears all plaintext caches", () => {
    const folderCallback = vaultPageSource.match(/return subscribeNoteFolders\(profile\.uid,[\s\S]*?\}, \(\) => \{/u)?.[0] ?? "";
    expect(folderCallback).toContain("decryptionSession.matches(profile.uid, privateKey) ? privateKey : null");
    expect(folderCallback).toContain("previousNotes: activeNoteSnapshotsRef.current");
    expect(folderCallback).toContain("nextNotes: activeNotes");
    expect(folderCallback.indexOf("preserveAuthorizedVaultDrafts({"))
      .toBeLessThan(folderCallback.indexOf("clearVaultPlaintextForAccessScope();"));
    expect(folderCallback.indexOf("clearVaultPlaintextForAccessScope();"))
      .toBeLessThan(folderCallback.indexOf("draftsRef.current = preserved.drafts"));
    expect(folderCallback).toContain("draftBaseSnapshotsRef.current = preserved.baseSnapshots");
    expect(folderCallback).toContain("[...preserved.entryIds].map((entryId)");
    expect(folderCallback).not.toContain("notesRef.current =");
    expect(folderCallback).not.toContain("setDecryptedNotes(");
  });

  it("keeps unfinished IME input inside the authorized session across exit and close actions", () => {
    const flush = vaultPageSource.slice(vaultPageSource.indexOf("async function flushDirtyEntries("), vaultPageSource.indexOf("async function flushWorkspaceBeforeExit("));
    expect(flush.indexOf("if (composingEntryIdsRef.current.size)")).toBeLessThan(flush.indexOf("const dirtyEntryIds"));
    expect(flush).toMatch(/if \(composingEntryIdsRef\.current\.size\) \{[\s\S]*?return false;/u);
    expect(vaultPageSource).toContain("const hasDirtyDrafts = composingEntryIdsRef.current.size > 0 ||");
    expect(vaultPageSource).toContain("composingEntryIdsRef.current.has(closingTab.entryId)");
    expect(vaultPageSource).toContain('beforeCloseDocument={async (id) => {\n                if (composingEntryIdsRef.current.has(id))');
    expect(vaultPageSource).toContain("|| composingEntryIdsRef.current.size > 0");
  });

  it("invalidates path-rewrite continuations at every Vault access-scope boundary", () => {
    const scopeClear = vaultPageSource.match(
      /const clearVaultPlaintextForAccessScope = useCallback\(\(\) => \{[\s\S]*?\n\s{2}\}, \[decryptionSession, editorSessionStore, memoTabMotion, resetPastedImageFolderRuntime\]\);/u
    )?.[0] ?? "";
    expect(scopeClear).toContain("memoTabMotion.clear();");
    expect(scopeClear).toContain("pathRewriteRecoveryGenerationRef.current += 1;");
    expect(scopeClear).toContain("editorSessionStore.clear()");
    expect(scopeClear).toContain("composingEntryIdsRef.current.clear()");
    expect(scopeClear).toContain("pathRewriteCleanupSessionRef.current = null;");
    expect(scopeClear).toContain("pathRewriteCleanupOwnerRef.current = null;");
    expect(scopeClear).toContain("pathRewriteRecoveryFailureCountRef.current = 0;");
    expect(scopeClear).toContain("pathRewriteRecoveryBusyOwnerRef.current = null;");
    expect(scopeClear).toContain("setPathRewriteJob(null);");
    expect(scopeClear.indexOf("pathRewriteRecoveryGenerationRef.current += 1;"))
      .toBeLessThan(scopeClear.indexOf("setPathRewriteJob(null);"));

    const manualRecovery = vaultPageSource.match(
      /async function retryBlockedPathRewriteJob\(\)[\s\S]*?\n\s{2}useEffect\(\(\) => \{/u
    )?.[0] ?? "";
    expect(manualRecovery).toContain("const generation = pathRewriteRecoveryGenerationRef.current;");
    expect(manualRecovery).toContain("pathRewriteRecoveryBusyOwnerRef.current = generation;");
    expect(manualRecovery).toMatch(
      /await flushVaultDraftsBeforePathRewriteRecovery\(\{[\s\S]*?\n\s+if \(!continuationIsCurrent\(\)\) return;/u
    );
    expect(manualRecovery).toMatch(
      /await recoverDurablePathRewriteJob\(job, continuationIsCurrent\);\n\s+if \(!continuationIsCurrent\(\)\) return;/u
    );
    expect(manualRecovery).toContain("if (!continuationIsCurrent()) return;\n      const blockedJob");

    const automaticRecovery = vaultPageSource.match(
      /const generation = pathRewriteRecoveryGenerationRef\.current \+ 1;[\s\S]*?\n {2}\}, \[/u
    )?.[0] ?? "";
    expect(automaticRecovery).toContain("cancelled,");
    expect(automaticRecovery).toContain(
      'const observedBlockedJobId = pathRewriteJob?.status === "blocked"'
    );
    expect(automaticRecovery).toContain(
      'const observedBlockedRevision = pathRewriteJob?.status === "blocked"'
    );
    expect(automaticRecovery).toContain(
      "setPathRewriteJob((current) => reconcileVaultPathRewriteJobAfterRecoveryScan({"
    );
    expect(automaticRecovery).toContain("continuationIsCurrent: continuationIsCurrent(),");
    expect(automaticRecovery).toContain("observedBlockedRevision,");
    expect(automaticRecovery).toContain("scanComplete: !hasMore,");
    expect(automaticRecovery).toMatch(
      /await flushVaultDraftsBeforePathRewriteRecovery\(\{[\s\S]*?\n\s+if \(!continuationIsCurrent\(\)\) return;/u
    );
    expect(automaticRecovery).toMatch(
      /await recoverDurablePathRewriteJob\(job, continuationIsCurrent\);\n\s+if \(!continuationIsCurrent\(\)\) return;/u
    );
    const guardedRecoveryAdapter = vaultPageSource.match(
      /function recoverDurablePathRewriteJob\([\s\S]*?\n\s{2}async function retryBlockedPathRewriteJob/u
    )?.[0] ?? "";
    expect(guardedRecoveryAdapter).toContain(
      "if (continuationIsCurrent()) setPathRewriteStage(stage, stageJob);"
    );
  });

  it("drops prior server-ready signatures before replacing note and folder subscriptions", () => {
    const noteSubscription = vaultPageSource.match(
      /const subscriptionGeneration = noteSubscriptionGenerationRef\.current \+ 1;[\s\S]*?const unsubscribe = subscribeVisibleNotes\(/u
    )?.[0] ?? "";
    expect(noteSubscription).toContain("noteSubscriptionServerReadyRef.current = false");
    expect(noteSubscription).toContain("setNoteServerReservationSignature(null)");
    expect(noteSubscription.indexOf("setNoteServerReservationSignature(null)"))
      .toBeLessThan(noteSubscription.indexOf("subscribeVisibleNotes("));

    const folderSubscription = vaultPageSource.match(
      /useEffect\(\(\) => \{\n\s{4}folderSubscriptionServerReadyRef\.current = false;\n\s{4}setFolderServerReservationSignature\(null\);[\s\S]*?return subscribeNoteFolders\(/u
    )?.[0] ?? "";
    expect(folderSubscription).toContain("setFolderServerReservationSignature(null)");
    expect(folderSubscription.indexOf("setFolderServerReservationSignature(null)"))
      .toBeLessThan(folderSubscription.indexOf("subscribeNoteFolders("));
  });

  it("does not let another owner's valid shared filename block body-only saves or owner-scoped creates", () => {
    const saveEntry = vaultPageSource.match(
      /const saveEntry = useCallback[\s\S]*?useLayoutEffect\(\(\) => \{\n\s+saveEntryRef\.current/u
    )?.[0] ?? "";
    expect(saveEntry).not.toContain("const duplicate = currentNotes.some");

    const createEntry = vaultPageSource.match(
      /async function createEntry[\s\S]*?async function createUnresolvedMarkdownEntry/u
    )?.[0] ?? "";
    expect(createEntry).toContain("notes.filter((note) => note.ownerUid === profile.uid)");
    expect(createEntry).toContain("uniqueTitle(ownedNotes");
  });

  it("locks the previous plaintext editor until an encrypted create owns an active decrypted draft", () => {
    const createEntry = vaultPageSource.match(
      /async function createEntry[\s\S]*?async function createUnresolvedMarkdownEntry/u
    )?.[0] ?? "";
    const titleInput = vaultPageSource.match(
      /<input\s+aria-label="노트 이름"[\s\S]*?value=\{activeDraft\.title\}/u
    )?.[0] ?? "";
    const inactivePane = vaultPageSource.match(
      /<InactiveWorkspacePane[\s\S]*?tab=\{groupActiveTab\}/u
    )?.[0] ?? "";

    expect(createEntry).toContain("if (pendingEntryCreationRef.current)");
    expect(createEntry).toContain("{ entryId: result.noteId, kind }");
    expect(vaultPageSource).toContain("shouldReleaseVaultEntryCreation(pendingEntryCreation");
    expect(vaultPageSource).toContain("const entryCreationContentLocked = pendingEntryCreation !== null;");
    expect(titleInput).toContain("|| entryCreationContentLocked");
    expect(inactivePane).toContain("|| entryCreationContentLocked");
    expect(vaultPageSource).toContain("readOnly={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked || conflictedEntryIds.has(activeNote.id)}");
    expect(vaultPageSource).not.toContain("onEditProperty=");
    expect(vaultPageSource).not.toMatch(/const entryCreationContentLocked[^;]*savingEntryIds/u);
  });

  it("fails closed with an explicit notice for regex queries in non-preemptible fallback mode", () => {
    expect(vaultPageSource).toContain("graphViewSettingsUsesRegex(settings)");
    expect(vaultPageSource).toContain("vaultSearchQueryUsesRegex(searchQuery)");
    expect(vaultPageSource).toContain("현재 안전 모드에서는 정규식 검색·그래프 필터를 실행하지 않습니다.");
  });

  it("write-locks every deferred name-migration target, not only direct collision pairs", () => {
    expect(vaultPageSource).toContain("if (result.deferredTargetIds.length)");
    expect(vaultPageSource).toContain("setVaultNameCollisionTargetIds(new Set(outcome.result.deferredTargetIds))");
    expect(vaultPageSource).toContain("legacyActiveNoteIds: preflight.legacyActiveNoteIds");
    expect(vaultPageSource).toContain("legacyDeletedNoteIds: preflight.legacyDeletedNoteIds");
  });

  it("uses a ready marker as an O(1) fast path and refreshes pending inventory after reconciliation", () => {
    // Both full server reads belong only to the one-time cutover flow. Path
    // mutations use the complete live subscription plus an atomic projected
    // server fence instead of re-downloading every ciphertext.
    expect(vaultPageSource.match(/loadOwnedVaultCutoverInventory\(/gu)?.length ?? 0).toBe(2);
    expect(vaultPageSource).toContain('if (prepared.cutoverState === "ready")');
    expect(vaultPageSource).toContain("setVaultIntegrityKey(prepared.key)");
    expect(vaultPageSource).toContain('|| preparedVaultIntegrityKey.cutoverState === "ready"');
    expect(vaultPageSource).toContain("const inventory = await loadOwnedVaultCutoverInventory(currentProfile.uid)");
    expect(vaultPageSource).toContain("const candidateInventory = await loadOwnedVaultCutoverInventory(currentProfile.uid)");

    const slowPath = vaultPageSource.match(
      /const pending = \(async \(\) => \{[\s\S]*?vaultNameMigrationPromiseRef\.current = pending;/u
    )?.[0] ?? "";
    expect(slowPath).toContain("activeNotes: inventory.activeNotes");
    expect(slowPath).toContain("deletedNotes: inventory.deletedNotes");
    expect(slowPath.indexOf("preflightVaultNameCutover({")).toBeLessThan(
      slowPath.indexOf("const activated = await activatePreparedVaultIntegrityKey(")
    );
    expect(slowPath.indexOf("const initialReconciledClaimCount"))
      .toBeLessThan(slowPath.indexOf("const inventory = await loadOwnedVaultCutoverInventory"));
    expect(slowPath.indexOf("await migrateVaultNameReservations({")).toBeLessThan(
      slowPath.indexOf("await sealVaultIntegrityCutover(currentProfile.uid")
    );
    expect(slowPath).not.toContain("auditVaultNameReservations");
    expect(vaultPageSource).not.toContain("auditedServerReservationSignature");
    expect(vaultPageSource).not.toContain("auditedServerInventorySignature");
  });

  it("bounds listener catch-up, retries subscriptions, and preserves dirty drafts", () => {
    expect(vaultPageSource).toContain("const timeout = window.setTimeout");
    expect(vaultPageSource).toContain("}, 30_000)");
    expect(vaultPageSource).toContain("vaultIntegritySealAbortRef.current?.abort()");
    expect(vaultPageSource).toContain("setVaultIntegrityRetryAttempt((attempt) => attempt + 1)");
    expect(vaultPageSource).toContain("{ repairLegacyDeletionMetadata: false }");

    const retry = vaultPageSource.match(
      /function retryVaultNameMigration\(\) \{[\s\S]*?\n {2}\}/u
    )?.[0] ?? "";
    expect(retry).toContain("setNoteServerReservationSignature(null)");
    expect(retry).toContain("setFolderServerReservationSignature(null)");
    expect(retry).not.toContain("setDrafts(");
    expect(retry).not.toContain("clearVaultPlaintextForAccessScope");
    expect(vaultPageSource).toContain("cancelledWhileCurrent");
    expect(vaultPageSource).toContain("vaultIntegritySealAbortRef.current === controller");
    expect(vaultPageSource).toContain("controller.abort();");
    expect(vaultPageSource).toContain("setVaultNameMigrationResumeAttempt((attempt) => attempt + 1)");
  });

  it("does not flash the migration warning during the normal marker fast path", () => {
    const bannerGate = vaultPageSource.match(
      /!workspaceConflict[\s\S]*?\? \(\n\s+<FeatureErrorBoundary[\s\S]*?<LazyVaultNameIntegrityNotice/u
    )?.[0] ?? "";
    expect(bannerGate).toContain('vaultNameMigrationStatus === "waiting"');
    expect(bannerGate).toContain('vaultNameMigrationStatus === "running"');
    expect(bannerGate).toContain('vaultNameMigrationStatus === "blocked"');
    expect(bannerGate).not.toContain('vaultNameMigrationStatus === "checking"');
    expect(bannerGate).not.toContain('vaultNameMigrationStatus === "ready"');
  });

  it("contains a lazy message-batch failure without replacing the Vault draft tree", () => {
    expect(vaultPageSource).toContain(
      'lazy(() => import("../features/markdown/MarkdownMessageBatchDialog")'
    );
    const messageBatchGate = vaultPageSource.match(
      /\{discordMessageBatch \? \([\s\S]*?<LazyMarkdownMessageBatchDialog[\s\S]*?\) : null\}/u
    )?.[0] ?? "";

    expect(messageBatchGate).toContain("<FeatureErrorBoundary");
    expect(messageBatchGate).toContain('role="alert"');
    expect(messageBatchGate).toContain("편집 내용은 유지됩니다.");
    expect(messageBatchGate).toContain("setDiscordMessageBatch(null)");
    expect(messageBatchGate).toContain("<Suspense");
  });

  it("connects a server-confirmed encrypted Vault trash restore with claim collision checks", () => {
    expect(vaultPageSource).toContain("subscribeDeletedNotes(");
    expect(vaultPageSource).toContain("subscribeDeletedNoteFolders(");
    expect(vaultPageSource).toContain("setTrashNotesServerReady(metadata.serverComplete)");
    expect(vaultPageSource).toContain("setTrashFoldersServerReady(metadata.serverComplete)");
    expect(vaultPageSource).toContain("claimId: await vaultNameFingerprint");
    expect(vaultPageSource).toContain("await restoreRevisionedNote({");
    expect(vaultPageSource).toContain("expectedRevision: note.revision ?? 0,\n        nameClaim,");
    expect(vaultPageSource).toContain("<LazyVaultTrashDialog");
    expect(vaultTrashDialogSource).toContain("aria-labelledby={titleId}");
    expect(vaultTrashDialogSource).toContain("<h2 id={titleId}>Vault 휴지통</h2>");
    expect(vaultPageSource).not.toContain("기존 노트 관리의 휴지통에서 복구");
  });

  it("keeps retired files as inert text without Canvas drop or editing handlers", () => {
    expect(vaultPageSource).not.toContain("importCanvasExternalFiles");
    expect(vaultPageSource).not.toContain("onImportExternalFiles");
    expect(vaultPageSource).not.toContain("LazyVaultJsonCanvasPane");
    expect(vaultArchivedFilePreviewSource).toContain("<pre>{source}</pre>");
    expect(vaultArchivedFilePreviewSource).toContain('type: "application/octet-stream"');
    expect(vaultArchivedFilePreviewSource).not.toContain("dangerouslySetInnerHTML");
    expect(vaultArchivedFilePreviewSource).not.toContain("<iframe");
    expect(vaultArchivedFilePreviewSource).not.toContain("localStorage");
    expect(vaultArchivedFilePreviewSource).not.toContain("sessionStorage");
  });

  it("routes Markdown pasted, selected, and dropped images through encrypted asset-v1 storage", () => {
    const pasteHandler = vaultPageSource.match(
      /async function pasteImagesIntoMarkdownEntry[\s\S]*?async function createConvertedMarkdownCopy/u
    )?.[0] ?? "";

    expect(pasteHandler).toContain('note.ownerUid !== profile.uid || note.type !== "personal"');
    expect(pasteHandler).toContain("beginVaultClipboardPastePendingGuard({");
    expect(vaultClipboardPasteFlowSource).toContain("input.counts.set(input.entryId");
    expect(pasteHandler).toContain("const result = await pasteModule.pasteVaultClipboardImages({");
    expect(pasteHandler).toContain("resolveAssetDestination: async (resolveSignal) => {");
    expect(pasteHandler).toContain("assertAssetDestinationCurrent: (target) => {");
    expect(pasteHandler).toContain("confirmAssetDestination: (lease) => {");
    expect(pasteHandler).toContain("vaultPasteFolderRevision: destination.folderRevision");
    expect(pasteHandler).toContain("pasteModule.rollbackVaultClipboardSource(latestDraft.body, rollback)");
    expect(pasteHandler).toContain('outcome === "rollback-blocked"');
    expect(pasteHandler).toContain("const accessScopeGeneration = workspaceAccessScopeGenerationRef.current;");
    expect(pasteHandler).toContain("if (!accessScopeIsCurrent()) {");
    expect(pasteHandler).toContain("if (accessScopeIsCurrent() && !signal.aborted)");
    const saveEntry = vaultPageSource.match(
      /const saveEntry = useCallback[\s\S]*?useLayoutEffect\(\(\) => \{\n\s+saveEntryRef\.current/u
    )?.[0] ?? "";
    expect(saveEntry).toContain("pendingClipboardPasteCountsRef.current.has(entryId)");
    expect(saveEntry).toContain("pastedImageSourceCommit");
    expect(vaultClipboardPasteFlowSource).toContain(
      "prepareVaultClipboardImages(files, { signal: preflightController.signal })"
    );
    expect(vaultClipboardPasteFlowSource).toContain("await createEncryptedVaultAsset(profile, integrityKey");
    expect(vaultClipboardPasteFlowSource).toContain("await withVaultClipboardSourceReadDeadline(");
    expect(vaultClipboardPasteFlowSource).toContain("getVisibleNotesByIdsFromServer(ownerUid, [note.id])");
    expect(vaultClipboardPasteFlowSource).toContain('server.type !== "personal"');
    expect(vaultClipboardPasteFlowSource).toContain("server.folderId ?? null");
    expect(vaultClipboardPasteFlowSource).toContain("`${folderPath}/${title}`");
    expect(vaultClipboardPasteFlowSource).toContain("clearPreparedVaultClipboardImages(prepared)");
    expect(vaultClipboardPasteFlowSource).toContain("if (signal.aborted)");
    expect(vaultClipboardPasteFlowSource).toContain("onDiscard: discardPaste");
    expect(vaultClipboardPasteFlowSource).toContain("await confirmAssetDestination(destination)");
    expect(vaultClipboardPasteFlowSource).toContain("persisted = await commitSource(source, destination)");
    expect(vaultPastedImageFolderSource).toContain("acquireVaultPastedImageFolderLock(input.ownerUid");
    expect(vaultPastedImageFolderSource).toContain("releaseVaultPastedImageFolderLock(input.ownerUid");
    expect(vaultClipboardPasteFlowSource).toContain("await deleteRevisionedNote({");
    expect(vaultClipboardPasteFlowSource).not.toContain("data:");
    expect(vaultClipboardPasteFlowSource).not.toContain("localStorage");
    expect(vaultClipboardPasteFlowSource).not.toContain("sessionStorage");
    expect(vaultPageSource.match(/onPasteImages=\{pasteImagesIntoActiveMarkdown\}/gu)).toHaveLength(1);
    expect(vaultPageSource).toContain("onPasteImages={(files, pasteContext) => stablePasteImagesIntoMarkdownEntry(note.id, files, pasteContext)}");
    expect(vaultPageSource).toContain("useStableEvent(pasteImagesIntoMarkdownEntry)");
    expect(codeMirrorMarkdownEditorSource).toContain("accept={VAULT_MARKDOWN_IMAGE_ACCEPT}");
    expect(codeMirrorMarkdownEditorSource).toContain("vaultSelectedImageFiles(event.currentTarget.files)");
    expect(codeMirrorMarkdownEditorSource).toContain("vaultClipboardImageFiles(event.dataTransfer)");
    expect(codeMirrorMarkdownEditorSource).toContain("EditorSelection.cursor(position)");
    expect(codeMirrorMarkdownEditorSource).toContain("multiple");
    expect(codeMirrorMarkdownEditorSource).not.toContain("readAsDataURL");
  });

  it("keeps pasted asset guards until the exact decrypted subscription acknowledgement", () => {
    const acknowledgement = vaultPageSource.match(
      /useEffect\(\(\) => \{\n\s+for \(const note of notes\) \{\n\s+const pendingTitleKey = pendingClipboardAssetTitleKeyByIdRef[\s\S]*?\n\s{2}\}, \[notes, profile\.uid\]\);/u
    )?.[0] ?? "";

    expect(acknowledgement).toContain("note.ownerUid !== profile.uid");
    expect(acknowledgement).toContain('note.entryKind !== "asset"');
    expect(acknowledgement).toContain("(note.folderId ?? null) !== reservation.folderId");
    expect(acknowledgement).toContain("note.title !== reservation.title");
    expect(acknowledgement).toContain("pendingClipboardAssetIdsRef.current.delete(note.id)");
    expect(vaultClipboardPasteFlowSource).not.toContain("clearCreatedAssetReservations");
  });

  it("opens the lazy share manager only from a stable saved snapshot and carries asset ACL blocks forward", () => {
    expect(vaultPageSource).toContain(
      'lazy(() => import("../features/vault/VaultShareManagerDialog")'
    );
    expect(vaultPageSource).toContain(
      'lazy(() => import("../features/vault/VaultParticipantShareDialog")'
    );

    const openShare = vaultPageSource.match(
      /async function openVaultShareManager[\s\S]*?async function moveEntryToTrash/u
    )?.[0] ?? "";
    expect(openShare.match(/clipboardAssetsPendingForEntry\(entryId\)/gu)).toHaveLength(3);
    expect(openShare).toContain("await existingMutation");
    expect(openShare).toContain("draftsRef.current[entryId]?.dirty");
    expect(openShare).toContain("await saveEntryRef.current(entryId)");
    expect(openShare).toContain("savedDraft?.dirty");
    expect(openShare).toContain("conflictedEntryIds.has(entryId)");
    expect(openShare).toContain("entryMutationPromisesRef.current.has(entryId)");
    expect(openShare).toContain("await import(\n      \"../features/vault/vaultShareEligibility\"");
    expect(openShare).toContain("const latestSavedNote = notesRef.current.find");
    expect(openShare.lastIndexOf("clipboardAssetsPendingForEntry(entryId)"))
      .toBeGreaterThan(openShare.indexOf('import(\n      "../features/vault/vaultShareEligibility"'));
    expect(openShare).toContain("setShareTarget({ hasUnsharedAssetEmbeds, note: latestSavedNote, returnFocusTo })");
    expect(openShare.indexOf("await saveEntryRef.current(entryId)"))
      .toBeLessThan(openShare.indexOf("setShareTarget({ hasUnsharedAssetEmbeds, note: latestSavedNote, returnFocusTo })"));
    expect(openShare).toContain("embeddedVaultAssetIdsForShare(");
    expect(openShare).toContain("indexEntries");
    expect(vaultPageSource).toContain(
      "hasUnsharedAssetEmbeds={shareTarget.hasUnsharedAssetEmbeds === true}"
    );
    expect(vaultPageSource).toContain(
      "hasUnsharedAssetEmbeds={participantShareTarget.hasUnsharedAssetEmbeds === true}"
    );
  });

  it("revokes source-scoped secure shares before either entry or folder trash persistence", () => {
    const folderTrash = vaultPageSource.match(
      /async function moveFolderToTrash[\s\S]*?async function openVaultShareManager/u
    )?.[0] ?? "";
    expect(folderTrash).toContain("revokeVaultSecureSharesBeforeSourcesTrash");
    expect(folderTrash).toContain("folderTrashLockedFolderIdsRef.current.add(hiddenFolderId)");
    expect(folderTrash).toContain("deletingEntryIdsRef.current.add(entryId)");
    expect(folderTrash).toContain("if (pathRewriteBusyRef.current) {");
    expect(folderTrash).toContain("ownsPathLock = true");
    expect(folderTrash).toContain("await flushDirtyEntries(false)");
    expect(folderTrash.indexOf("await flushDirtyEntries(false)"))
      .toBeLessThan(folderTrash.indexOf("await trashRevisionedEncryptedFolderSubtree({"));
    expect(folderTrash).toContain("Object.values(draftsRef.current).some((draft) => draft.dirty)");
    expect(folderTrash.match(/clipboardAssetsPendingForEntry/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(folderTrash).toContain("sourceNoteIds: shareableSourceNoteIds");
    expect(folderTrash).toContain("await trashRevisionedEncryptedFolderSubtree({");
    expect(folderTrash.indexOf("await revokeVaultSecureSharesBeforeSourcesTrash({"))
      .toBeLessThan(folderTrash.indexOf("await trashRevisionedEncryptedFolderSubtree({"));

    const entryTrash = vaultPageSource.match(
      /async function moveEntryToTrash[\s\S]*?function ownedVaultTreeTargets/u
    )?.[0] ?? "";
    expect(entryTrash).toContain("revokeVaultSecureSharesBeforeTrash");
    expect(entryTrash).toContain("sourceNoteId: entryId");
    expect(entryTrash).toContain("await deleteRevisionedNote({");
    expect(entryTrash.indexOf("await revokeVaultSecureSharesBeforeTrash({"))
      .toBeLessThan(entryTrash.indexOf("await deleteRevisionedNote({"));
  });

  it("creates Markdown conversion copies only from a server-confirmed source", () => {
    const conversion = vaultPageSource.match(
      /async function createConvertedMarkdownCopy[\s\S]*?function openCoreTool/u
    )?.[0] ?? "";

    expect(conversion).toContain("getVisibleNotesByIdsFromServer(profile.uid, [draft.sourceEntryId])");
    expect(conversion).toContain("assertFormatConversionSourceUnchanged(previewPlan");
    expect(conversion).toContain("const verifiedPlan = formatConverter.planLegacyVaultFormatConversion");
    expect(conversion).toContain("body: verifiedPlan.copy.body");
    expect(conversion).toContain("folderId: targetFolderId");
    expect(conversion).not.toContain("body: draft.body");
    expect(conversion).not.toContain("folderId: draft.folderId");
  });

  it("never silently rolls back an interrupted ZIP import and exposes explicit recovery", () => {
    const startupRecovery = vaultPageSource.match(
      /void cleanupRetainedTerminalVaultImportJobs[\s\S]*?async function recheckRecoverableImportJobs/u
    )?.[0] ?? "";
    expect(startupRecovery).toContain("setRecoverableImportJobs(jobs)");
    expect(startupRecovery).toContain("setImportRecoveryOpen(true)");
    expect(startupRecovery).not.toContain("rollbackVaultImportJob");

    const explicitRollback = vaultPageSource.match(
      /async function rollbackRecoverableImportJob[\s\S]*?async function moveEntryToFolder/u
    )?.[0] ?? "";
    expect(explicitRollback).toContain("window.confirm");
    expect(explicitRollback).toContain("loadVaultImportJob");
    expect(explicitRollback).toContain("rollbackVaultImportJob");
    expect(explicitRollback).toContain("revision 확인 후 휴지통 처리");
    expect(vaultPageSource).toContain("<LazyVaultImportRecoveryPanel");
  });

  it("preserves a dirty draft when path rewrite wraps a server revision conflict", () => {
    const move = vaultPageSource.match(
      /async function moveEntryToFolder[\s\S]*?async function moveFolder/u
    )?.[0] ?? "";
    expect(move).toContain("caught instanceof VaultPathRewriteControllerError");
    expect(move).toContain("? caught.cause");
    expect(move).toContain("underlyingError instanceof NoteRevisionConflictError");
    expect(move).toContain("prepareDraftMergeConflict(entryId, false)");
  });

  it("keeps a revision-scoped Markdown base and wipes conflict plaintext at every access boundary", () => {
    const capture = vaultPageSource.match(
      /const captureMarkdownDraftBase = useCallback[\s\S]*?const readCurrentServerVaultEntry/u
    )?.[0] ?? "";
    expect(capture).toContain("baseRevision: draft.baseRevision");
    expect(capture).toContain("body: draft.body");
    expect(capture).toContain("draftBaseSnapshotsRef.current.set(entryId, snapshot)");
    expect(vaultPageSource).toContain("captureMarkdownDraftBase(entryId, note, currentDraft)");

    const accessClear = vaultPageSource.match(
      /const clearVaultPlaintextForAccessScope = useCallback[\s\S]*?useLayoutEffect/u
    )?.[0] ?? "";
    expect(accessClear).toContain("draftMergeRequestGenerationRef.current += 1");
    expect(accessClear).toContain("draftBaseSnapshotsRef.current.clear()");
    expect(accessClear).toContain("setDraftMergeConflict(null)");

    const unmount = vaultPageSource.match(
      /useEffect\(\(\) => \(\) => \{[\s\S]*?\n\s{2}\}, \[\]\);/u
    )?.[0] ?? "";
    expect(unmount).toContain("draftBaseSnapshotsRef.current.clear()");
    expect(unmount).toContain("draftMergeRequestGenerationRef.current += 1");
  });

  it("reads and decrypts the server revision after a 409 and again before merge persistence", () => {
    const serverRead = vaultPageSource.match(
      /const readCurrentServerVaultEntry = useCallback[\s\S]*?const prepareDraftMergeConflict/u
    )?.[0] ?? "";
    expect(serverRead).toContain("getVisibleNotesByIdsFromServer(profile.uid, [entryId])");
    expect(serverRead).toContain("decryptVaultNotes(result.notes, profile.uid, privateKey, {");
    expect(serverRead).toContain("session: decryptionSession");
    expect(serverRead).toContain("signal: sessionSignal");
    expect(serverRead.indexOf("const sessionSignal = decryptionSession.signal"))
      .toBeLessThan(serverRead.indexOf("await getVisibleNotesByIdsFromServer"));
    expect(serverRead).toContain("remote.participantUids.includes(profile.uid)");
    expect(serverRead).toContain("remote.wrappedKeys[profile.uid]");

    const saveEntry = vaultPageSource.match(
      /const saveEntry = useCallback[\s\S]*?useLayoutEffect\(\(\) => \{\n\s+saveEntryRef\.current/u
    )?.[0] ?? "";
    expect(saveEntry).toContain("caught instanceof NoteRevisionConflictError");
    expect(saveEntry).toContain("prepareDraftMergeConflict(entryId, false)");

    const applyMerge = vaultPageSource.match(
      /async function applyDraftMergeResolution[\s\S]*?async function reloadConflictedEntry/u
    )?.[0] ?? "";
    expect(applyMerge).toContain("const remote = await readCurrentServerVaultEntry(entryId)");
    expect(applyMerge).toContain("sameRevisionedDraft(latestBeforeSave, conflict.local)");
    expect(applyMerge).toContain("saveEncryptedVaultEntry(");
    expect(applyMerge).toContain("{ ...remote, revision: remote.revision ?? 0 }");
    expect(applyMerge).toContain("caught instanceof NoteRevisionConflictError");
    expect(applyMerge).toContain("await prepareDraftMergeConflict(entryId, true)");
    expect(applyMerge).not.toContain("caught.message");
    expect(applyMerge).not.toMatch(/console\.(?:log|warn|error|debug)/u);
  });

  it("requires explicit confirmation before replacing a dirty draft with a direct server read", () => {
    const reload = vaultPageSource.match(
      /async function reloadConflictedEntry[\s\S]*?async function preserveConflictedEntry/u
    )?.[0] ?? "";
    expect(reload).toContain("window.confirm");
    expect(reload).toContain("const remote = await readCurrentServerVaultEntry(entryId)");
    expect(reload).toContain("sameRevisionedDraft(draftsRef.current[entryId], captured)");
    expect(reload).not.toContain("caught.message");
    expect(vaultPageSource).toContain("<LazyVaultDraftConflictResolver");
    expect(vaultPageSource).toContain("baseMarkdown={draftMergeConflict.base.body}");
    expect(vaultPageSource).toContain("localMarkdown={draftMergeConflict.local.body}");
    expect(vaultPageSource).toContain("remoteMarkdown={draftMergeConflict.remote.body}");
    expect(vaultPageSource).not.toContain("<LazyVaultDraftConflictResolver entryId=");
  });
});
