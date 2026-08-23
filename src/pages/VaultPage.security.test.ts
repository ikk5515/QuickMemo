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
      /return subscribeNoteFolders\(profile\.uid,[\s\S]*?\n\s{2}\}, \[clearVaultPlaintextForAccessScope, privateKey, profile\]\);/u
    )?.[0] ?? "";

    expect(folderSubscription).toContain("clearVaultPlaintextForAccessScope();");
    expect(folderSubscription).toContain("setFolderServerReservationSignature(null)");
    expect(folderSubscription).toContain("setNoteServerReservationSignature(null)");
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
    expect(vaultPageSource).toContain("if (finalAudit.deferredTargetIds.length)");
    expect(vaultPageSource).toContain("setVaultNameCollisionTargetIds(new Set(finalAudit.deferredTargetIds))");
    expect(vaultPageSource).toContain("legacyActiveNoteIds: preflight.legacyActiveNoteIds");
    expect(vaultPageSource).toContain("legacyDeletedNoteIds: preflight.legacyDeletedNoteIds");
  });

  it("seals the marker only after a full owner inventory preflight and reaches ready only after a final server audit", () => {
    expect(vaultPageSource.match(/loadOwnedVaultCutoverInventory\(profile\.uid\)/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(vaultPageSource).toContain("activeNotes: inventory.activeNotes");
    expect(vaultPageSource).toContain("deletedNotes: inventory.deletedNotes");
    expect(vaultPageSource).toContain("const finalInventory = await loadOwnedVaultCutoverInventory(profile.uid)");
    expect(vaultPageSource).toContain("finalPreflight.legacyActiveNoteIds.size || finalPreflight.legacyDeletedNoteIds.size");
    expect(vaultPageSource).toContain("await auditVaultNameReservations({");
    expect(vaultPageSource).toContain("setAuditedServerInventorySignature(ownedVaultCutoverInventorySignature");
    expect(vaultPageSource).toContain('setVaultNameMigrationStatus("audited")');
    expect(vaultPageSource).toContain("currentServerReservationSignature === auditedServerReservationSignature");
  });

  it("bounds the listener catch-up state and re-audits a stable mismatched signature", () => {
    expect(vaultPageSource).toContain('vaultNameMigrationStatus !== "audited"');
    expect(vaultPageSource).toContain("const retryTimer = window.setTimeout");
    expect(vaultPageSource).toContain("최종 확인 중 새 Vault 변경을 감지해 전체 inventory를 다시 검사합니다");
    expect(vaultPageSource).toContain("}, 3_000)");
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
