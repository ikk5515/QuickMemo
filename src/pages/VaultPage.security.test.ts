import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const vaultPageSource = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");

describe("VaultPage security boundaries", () => {
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
    expect(cleanup).toContain("notesRef.current = []");
    expect(cleanup).toContain("foldersRef.current = []");
    expect(cleanup).toContain("draftsRef.current = {}");
    expect(cleanup).toContain("knowledgeEntriesRef.current.clear()");

    const decryptEffect = vaultPageSource.match(
      /const generation = decryptGeneration\.current \+ 1;[\s\S]*?\n\s{2}\}, \[commitFolders/u
    )?.[0] ?? "";
    expect(decryptEffect).toContain("cancelled || decryptGeneration.current !== generation");
    expect(decryptEffect).toContain("cancelled = true");
  });

  it("wipes note-derived plaintext when the authorized folder listener fails", () => {
    const folderSubscription = vaultPageSource.match(
      /return subscribeNoteFolders\(profile\.uid,[\s\S]*?\n\s{2}\}, \[clearVaultPlaintextForAccessScope, privateKey, profile, vaultIntegrityRetryAttempt\]\);/u
    )?.[0] ?? "";

    expect(folderSubscription).toContain("clearVaultPlaintextForAccessScope();");
    expect(folderSubscription).toContain("setFolderServerReservationSignature(null)");
    expect(folderSubscription).toContain("setNoteServerReservationSignature(null)");
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
      /const saveEntry = useCallback[\s\S]*?useEffect\(\(\) => \{\n\s+saveEntryRef\.current/u
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
    expect(vaultPageSource).toContain("onEditProperty={deletingEntryIds.has(activeNote.id) || pathRewriteContentLocked || entryCreationContentLocked ? undefined");
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

  it("uses a ready marker as an O(1) fast path and seals a pending Vault after one owner inventory", () => {
    expect(vaultPageSource.match(/loadOwnedVaultCutoverInventory\(/gu)?.length ?? 0).toBe(1);
    expect(vaultPageSource).toContain('if (prepared.cutoverState === "ready")');
    expect(vaultPageSource).toContain("setVaultIntegrityKey(prepared.key)");
    expect(vaultPageSource).toContain('|| preparedVaultIntegrityKey.cutoverState === "ready"');
    expect(vaultPageSource).toContain("const inventory = await loadOwnedVaultCutoverInventory(currentProfile.uid)");

    const slowPath = vaultPageSource.match(
      /const pending = \(async \(\) => \{[\s\S]*?vaultNameMigrationPromiseRef\.current = pending;/u
    )?.[0] ?? "";
    expect(slowPath).toContain("activeNotes: inventory.activeNotes");
    expect(slowPath).toContain("deletedNotes: inventory.deletedNotes");
    expect(slowPath.indexOf("preflightVaultNameCutover({")).toBeLessThan(
      slowPath.indexOf("activatePreparedVaultIntegrityKey(preparedVaultIntegrityKey")
    );
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
  });

  it("does not flash the migration warning during the normal marker fast path", () => {
    const bannerGate = vaultPageSource.match(
      /!workspaceConflict[\s\S]*?\? \(\n\s+<aside[\s\S]*?aria-label="Vault 이름 무결성 준비"/u
    )?.[0] ?? "";
    expect(bannerGate).toContain('vaultNameMigrationStatus === "waiting"');
    expect(bannerGate).toContain('vaultNameMigrationStatus === "running"');
    expect(bannerGate).toContain('vaultNameMigrationStatus === "blocked"');
    expect(bannerGate).not.toContain('vaultNameMigrationStatus === "checking"');
    expect(bannerGate).not.toContain('vaultNameMigrationStatus === "ready"');
  });

  it("connects a server-confirmed encrypted Vault trash restore with claim collision checks", () => {
    expect(vaultPageSource).toContain("subscribeDeletedNotes(");
    expect(vaultPageSource).toContain("subscribeDeletedNoteFolders(");
    expect(vaultPageSource).toContain("setTrashNotesServerReady(metadata.serverComplete)");
    expect(vaultPageSource).toContain("setTrashFoldersServerReady(metadata.serverComplete)");
    expect(vaultPageSource).toContain("claimId: await vaultNameFingerprint");
    expect(vaultPageSource).toContain("await restoreRevisionedNote({");
    expect(vaultPageSource).toContain("expectedRevision: note.revision ?? 0,\n        nameClaim,");
    expect(vaultPageSource).toContain("<VaultTrashDialog");
    expect(vaultPageSource).toContain('aria-label="Vault 휴지통"');
    expect(vaultPageSource).not.toContain("기존 노트 관리의 휴지통에서 복구");
  });

  it("routes Canvas operating-system drops through the existing encrypted asset boundary", () => {
    const importer = vaultPageSource.match(
      /async function importCanvasExternalFiles[\s\S]*?async function createConvertedMarkdownCopy/u
    )?.[0] ?? "";

    expect(importer).toContain("MAX_INLINE_VAULT_ASSET_BYTES");
    expect(importer).toContain("await createEncryptedVaultAsset(profile, vaultIntegrityKey");
    expect(importer).toContain("bytes?.fill(0)");
    expect(importer).not.toContain("localStorage");
    expect(importer).not.toContain("sessionStorage");
    expect(vaultPageSource).toContain("onImportExternalFiles={importCanvasExternalFiles}");
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
    expect(serverRead).toContain("decryptVaultNotes(result.notes, profile.uid, privateKey)");
    expect(serverRead).toContain("remote.participantUids.includes(profile.uid)");
    expect(serverRead).toContain("remote.wrappedKeys[profile.uid]");

    const saveEntry = vaultPageSource.match(
      /const saveEntry = useCallback[\s\S]*?useEffect\(\(\) => \{\n\s+saveEntryRef\.current/u
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
