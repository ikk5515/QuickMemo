import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deleteManagedUserSource = readFileSync(join(process.cwd(), "api/delete-managed-user.js"), "utf8");

describe("managed user backend deletion", () => {
  it("deletes Firebase Auth users through an admin-verified backend route", () => {
    expect(deleteManagedUserSource).toContain("accounts:lookup");
    expect(deleteManagedUserSource).toContain("accounts:delete");
    expect(deleteManagedUserSource).toContain("idToken");
    expect(deleteManagedUserSource).not.toContain("management_credentials_missing");
  });

  it("validates the caller token before loading cleanup credentials", () => {
    const callerLookupIndex = deleteManagedUserSource.indexOf("const callerUid = await lookupCallerUid(idToken)");
    const credentialsIndex = deleteManagedUserSource.indexOf("const credentials = firebaseCredentials()");
    const invalidTokenResponseIndex = deleteManagedUserSource.indexOf('error: "invalid_auth_token"');

    expect(deleteManagedUserSource).toContain("VITE_FIREBASE_API_KEY");
    expect(deleteManagedUserSource).toContain("/accounts:lookup?key=");
    expect(callerLookupIndex).toBeGreaterThan(-1);
    expect(credentialsIndex).toBeGreaterThan(-1);
    expect(invalidTokenResponseIndex).toBeGreaterThan(-1);
    expect(callerLookupIndex).toBeLessThan(credentialsIndex);
    expect(invalidTokenResponseIndex).toBeLessThan(credentialsIndex);
  });

  it("rejects disabled callers and requires recent authentication before cleanup", () => {
    const lookupSource = deleteManagedUserSource.match(
      /async function lookupCallerUid[\s\S]*?async function deleteAuthUser/u
    )?.[0] ?? "";
    const handlerSource = deleteManagedUserSource.match(
      /export default async function handler[\s\S]*$/u
    )?.[0] ?? "";

    expect(deleteManagedUserSource).toContain("const identityToolkitRequestTimeoutMs = 8_000");
    expect(deleteManagedUserSource).toContain(
      "const recentAdminAuthenticationMaxAgeMs = 15 * 60 * 1000"
    );
    expect(lookupSource).toContain("AbortSignal.timeout(identityToolkitRequestTimeoutMs)");
    expect(lookupSource).toContain('responseBody.includes("USER_DISABLED")');
    expect(lookupSource).toContain("user.disabled !== true");
    expect(deleteManagedUserSource).toContain("function idTokenHasRecentAuthentication(");
    expect(handlerSource).toContain("if (!idTokenHasRecentAuthentication(");
    expect(handlerSource).toContain("credentials.projectId");
    expect(handlerSource).toContain('error: "recent_auth_required"');
    expect(handlerSource.indexOf("await lookupCallerUid(idToken)")).toBeLessThan(
      handlerSource.indexOf("idTokenHasRecentAuthentication(")
    );
    expect(handlerSource.indexOf("const credentials = firebaseCredentials()")).toBeLessThan(
      handlerSource.indexOf("idTokenHasRecentAuthentication(")
    );
    expect(handlerSource.indexOf("idTokenHasRecentAuthentication(")).toBeLessThan(
      handlerSource.indexOf("const accessToken = await fetchAccessToken(credentials)")
    );
  });

  it("logs metadata-only backend error summaries instead of exception messages", () => {
    const summarySource = deleteManagedUserSource.match(
      /function errorNumberField[\s\S]*?function parseJsonCredential/u
    )?.[0] ?? "";

    expect(deleteManagedUserSource).toContain("function safeErrorSummary(error)");
    expect(summarySource).toContain('kind: error instanceof Error ? "error" : "non_error"');
    expect(summarySource).toContain("value >= 100 && value <= 599");
    expect(summarySource).not.toContain("error.message");
    expect(summarySource).not.toContain("error.name");
    expect(deleteManagedUserSource).toContain('console.error("managed user delete failed", safeErrorSummary(error))');
    expect(deleteManagedUserSource).not.toContain('console.error("managed user delete failed", error)');
  });

  it("checks the caller admin profile and cleans schedule-owned data", () => {
    const forbiddenBackendPattern = new RegExp(`firebase-${"admin"}|firebase-${"functions"}`, "i");

    expect(deleteManagedUserSource).toContain("isActive");
    expect(deleteManagedUserSource).toContain("isAdmin");
    expect(deleteManagedUserSource).toContain("cannot_delete_self");
    expect(deleteManagedUserSource).toContain("last_active_admin");
    expect(deleteManagedUserSource).toContain("scheduleTasks");
    expect(deleteManagedUserSource).toContain(
      'queryDocumentsByStringField(\n    projectId,\n    "googleCalendarTaskTombstones",\n    "ownerUid",'
    );
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedGoogleCalendarTaskTombstones(projectId, targetUid, accessToken, stats)"
    );
    expect(deleteManagedUserSource).toContain("googleCalendarTaskTombstonesDeleted");
    expect(deleteManagedUserSource).toContain("googleCalendarTaskSyncReceipts");
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedGoogleCalendarTaskSyncReceipts(projectId, targetUid, accessToken, stats)"
    );
    expect(deleteManagedUserSource).toContain("googleCalendarTaskSyncReceiptsDeleted");
    expect(deleteManagedUserSource).toContain("googleCalendarOAuthStates");
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedGoogleCalendarOAuthStates(projectId, targetUid, accessToken, stats)"
    );
    expect(deleteManagedUserSource).toContain("googleCalendarOAuthStatesDeleted");
    expect(deleteManagedUserSource).toContain("recurringHabits");
    expect(deleteManagedUserSource).toContain("recurringHabitCheckIns");
    expect(deleteManagedUserSource).toContain('`googleCalendarConnections/${targetUid}`');
    expect(deleteManagedUserSource).toContain('`googleCalendarConnectionEpochs/${targetUid}`');
    expect(deleteManagedUserSource).toContain("disconnectGoogleCalendarForManagedUser(projectId, accessToken, targetUid)");
    expect(deleteManagedUserSource).toContain("Google Calendar credential cleanup failures must not block permanent user deletion");
    expect(deleteManagedUserSource).toContain("userPreferences");
    expect(deleteManagedUserSource).not.toMatch(forbiddenBackendPattern);
  });

  it("purges deleted users' owned content and Firestore subcollections", () => {
    expect(deleteManagedUserSource).toContain("notes");
    expect(deleteManagedUserSource).toContain("noteFolders");
    expect(deleteManagedUserSource).toContain("publicNoteShares");
    expect(deleteManagedUserSource).toContain("publicShareCleanupQueue");
    expect(deleteManagedUserSource).toContain("publicShareAttachmentCleanupQueue");
    expect(deleteManagedUserSource).toContain("attachments");
    expect(deleteManagedUserSource).toContain("storage.googleapis.com");
    expect(deleteManagedUserSource).toContain("storagePath");
    expect(deleteManagedUserSource).toContain("storageObjectsDeleted");
    expect(deleteManagedUserSource).toContain("history");
    expect(deleteManagedUserSource).toContain("noteUserStates");
    expect(deleteManagedUserSource).toContain('queryDocumentsByStringField(projectId, "attachments", "uploadedBy", uid, accessToken, {');
    expect(deleteManagedUserSource).toContain('queryDocumentsByStringField(projectId, "history", "actorUid", uid, accessToken, {');
  });

  it("purges owner-scoped secure-share policy, session, recipient, comment, and audit state", () => {
    for (const collectionId of [
      "publicSharePolicies",
      "publicShareRecipients",
      "publicShareAccessSessions",
      "publicShareEmailChallenges",
      "publicShareEmailDeliveries",
      "publicShareCopyGrantRequests",
      "publicShareSourceGuards",
      "publicShareUnlockGrants",
      "publicShareRateLimits",
      "publicShareComments",
      "publicShareAuditEvents"
    ]) {
      expect(deleteManagedUserSource).toContain(collectionId);
    }

    expect(deleteManagedUserSource).toContain("async function deleteSecureShareStateByShareId");
    expect(deleteManagedUserSource).toContain('"shareId",\n    shareId,');
    expect(deleteManagedUserSource).toContain('"ownerUid",\n    ownerUid,');
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedSecureSharePolicies("
    );
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedSecureShareContainers("
    );
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedSecureShareOrphanState(projectId, targetUid, accessToken, stats)"
    );
    expect(deleteManagedUserSource).toContain("maxManagedUserDeleteIterations");
    expect(deleteManagedUserSource).toContain("Secure share ownership changed during cleanup");
    expect(deleteManagedUserSource).toContain("secureShareEmailDeliveriesDeleted");
    expect(deleteManagedUserSource).toContain("secureShareCopyGrantRequestsDeleted");
    expect(deleteManagedUserSource).toContain("secureShareSourceGuardsDeleted");
    expect(deleteManagedUserSource).toContain(
      "deleteSecureShareCopyGrantRequestsByRequester("
    );
    expect(deleteManagedUserSource).toContain('"requesterUid",');
    expect(deleteManagedUserSource).not.toContain(
      'collectionId: "publicShareEmailQuotaBuckets"'
    );
  });

  it("deletes only finalized email quota state during managed-user cleanup", () => {
    const helperSource = deleteManagedUserSource.match(
      /async function deleteSecureShareEmailStateRepeatedly[\s\S]*?async function deleteChildDocumentsRepeatedly/u
    )?.[0] ?? "";
    const shareStateSource = deleteManagedUserSource.match(
      /async function deleteSecureShareStateByShareId[\s\S]*?async function finalizePublicShareTreeDeletion/u
    )?.[0] ?? "";
    const orphanStateSource = deleteManagedUserSource.match(
      /async function deleteOwnedSecureShareOrphanState[\s\S]*?async function deleteSecureShareCopyGrantRequestsByRequester/u
    )?.[0] ?? "";
    const querySource = deleteManagedUserSource.match(
      /async function querySecureShareRootStateByShareId[\s\S]*?async function querySecureShareCopyGrantRequestsByRequester/u
    )?.[0] ?? "";

    expect(deleteManagedUserSource).toContain(
      'collectionId === "publicShareEmailDeliveries"'
    );
    expect(deleteManagedUserSource).toContain(
      'collectionId === "publicShareEmailSendAttempts"'
    );
    expect(querySource).toContain(
      '["__name__", secureShareEmailStateField(collectionId)]'
    );
    expect(helperSource).toContain('state !== "sent" && state !== "failed"');
    expect(helperSource).toContain(
      "Secure share email quota reconciliation is still in progress"
    );
    expect(helperSource.indexOf("hasUnresolvedDelivery")).toBeLessThan(
      helperSource.indexOf("deleteProjectedDocumentForStat(")
    );
    expect(shareStateSource).toContain(
      "await deleteSecureShareEmailStateRepeatedly({"
    );
    expect(orphanStateSource).toContain(
      "await deleteSecureShareEmailStateRepeatedly({"
    );
    expect(helperSource).toContain("deleteProjectedDocumentForStat(");
    expect(deleteManagedUserSource).toContain(
      "{ delete: document.name, currentDocument: { updateTime: document.updateTime } }"
    );
    expect(deleteManagedUserSource).toContain(
      'throw new ManagedUserCleanupInProgressError("Concurrent Firestore delete requires a fresh cleanup pass")'
    );
  });

  it("deletes owner-scoped library items and the target user's immutable vault", () => {
    expect(deleteManagedUserSource).toContain(
      'queryDocumentsByStringField(projectId, "libraryItems", "ownerUid", ownerUid, accessToken)'
    );
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedLibraryItems(projectId, targetUid, accessToken, stats)"
    );
    expect(deleteManagedUserSource).toContain(
      "await deleteOwnedLibraryVault(projectId, targetUid, accessToken, stats)"
    );
    expect(deleteManagedUserSource).toContain('`libraryVaults/${ownerUid}`');
    expect(deleteManagedUserSource).toContain("libraryItemsDeleted");
    expect(deleteManagedUserSource).toContain("libraryVaultsDeleted");
  });

  it("purges bounded owner-scoped Vault maintenance trees before their roots", () => {
    const vaultCleanupSource = deleteManagedUserSource.match(
      /export async function deleteManagedUserVaultServerState[\s\S]*?async function deleteOwnedScheduleTasks/u
    )?.[0] ?? "";

    expect(deleteManagedUserSource).toContain("const managedUserVaultReadBudget = 500");
    expect(deleteManagedUserSource).toContain("const managedUserVaultWriteBudget = 500");
    expect(vaultCleanupSource).toContain('collectionId: "nameClaims"');
    expect(vaultCleanupSource).toContain('jobCollectionId: "pathRewrites"');
    expect(vaultCleanupSource).toContain('childCollectionId: "steps"');
    expect(vaultCleanupSource).toContain('jobCollectionId: "imports"');
    expect(vaultCleanupSource).toContain('childCollectionId: "chunks"');
    expect(vaultCleanupSource).toContain('collectionId: "pathRewriteInventory"');
    expect(vaultCleanupSource).toContain('`vaultFolderTrees/${targetUid}`');
    expect(vaultCleanupSource).toContain('`vaultWorkspaces/${targetUid}`');
    expect(deleteManagedUserSource).toContain(
      "currentDocument: { updateTime: document.updateTime }"
    );
    expect(deleteManagedUserSource).toContain(
      'stringField(document, "ownerUid") !== targetUid'
    );
    expect(deleteManagedUserSource).toContain("await deleteManagedUserVaultServerState({");
    expect(vaultCleanupSource.indexOf('collectionId: "nameClaims"')).toBeLessThan(
      vaultCleanupSource.indexOf('[integrityPath, "vaultIntegrityRootsDeleted"]')
    );
  });

  it("claims attachment deletion before objects and finalizes metadata with optimistic preconditions", () => {
    const cleanupFunction = deleteManagedUserSource.slice(
      deleteManagedUserSource.indexOf("async function cleanupManagedAttachmentDocument"),
      deleteManagedUserSource.indexOf("function documentIsUnderPath")
    );
    const beginIndex = cleanupFunction.indexOf("await beginManagedAttachmentDeletion");
    const objectIndex = cleanupFunction.indexOf("await deleteManagedAttachmentObjects");
    const finalizeIndex = cleanupFunction.indexOf("await finalizeManagedAttachmentDeletion");

    expect(beginIndex).toBeGreaterThan(-1);
    expect(objectIndex).toBeGreaterThan(beginIndex);
    expect(finalizeIndex).toBeGreaterThan(objectIndex);
    expect(deleteManagedUserSource).toContain('updateMask: { fieldPaths: ["deletionStarted", "attachmentRevisionBumped"] }');
    expect(deleteManagedUserSource).toContain("currentDocument: { updateTime: attachment.updateTime }");
    expect(deleteManagedUserSource).toContain("currentDocument: { updateTime: claim.attachmentUpdateTime }");
    expect(deleteManagedUserSource).toContain("currentDocument: { updateTime: claim.quota.quotaUpdateTime }");
  });

  it("bumps another owner's source attachment revision exactly once for ready and legacy-ready uploads", () => {
    expect(deleteManagedUserSource).toContain("shouldBumpAttachmentRevisionOnDelete");
    expect(deleteManagedUserSource).toContain('scope: mustProtectSourceRevision ? "note" : "publicShare"');
    expect(deleteManagedUserSource).toContain('hasReadyField: hasField(attachment, "isReady")');
    expect(deleteManagedUserSource).toContain('isReady: boolField(attachment, "isReady")');
    expect(deleteManagedUserSource).toContain('stringField(note, "ownerUid") !== deletedOwnerUid');
    expect(deleteManagedUserSource).toContain('attachmentRevisionBumped: { booleanValue: revisionBumped || shouldBumpRevision }');
    expect(deleteManagedUserSource).toContain('updateMask: { fieldPaths: ["attachmentRevision"] }');
    expect(deleteManagedUserSource).toContain("currentDocument: { updateTime: note.updateTime }");
    expect(deleteManagedUserSource).toContain("bumpSourceNoteRevision: true");
  });

  it("releases each attachment's actual uploader quota atomically and preserves legacy accounting", () => {
    expect(deleteManagedUserSource).toContain('stringField(attachment, "uploadedBy") || stringField(attachment, "ownerUid")');
    expect(deleteManagedUserSource).toContain("quotaReleaseAfterAttachmentClaim");
    expect(deleteManagedUserSource).toContain('stringField(attachment, "storageProvider") === "vercel-blob"');
    expect(deleteManagedUserSource).toContain('Boolean(stringField(attachment, "blobPath"))');
    expect(deleteManagedUserSource).toContain('updateMask: { fieldPaths: ["uid", "attachmentCount", "usedBytes"] }');
    expect(deleteManagedUserSource).toContain("attachmentQuotaReservationsReleased");
    expect(deleteManagedUserSource).toContain("legacyAttachmentQuotaBytesReleased");
  });

  it("keeps attachment cleanup bounded and rechecks children before parent deletion", () => {
    expect(deleteManagedUserSource).toContain("const attachmentCleanupBatchSize = 20");
    expect(deleteManagedUserSource).toContain("const historyCleanupBatchSize = 50");
    expect(deleteManagedUserSource).toContain("const managedUserAttachmentDeleteBudget = 20");
    expect(deleteManagedUserSource).toContain("maxDocuments = historyCleanupBatchSize");
    expect(deleteManagedUserSource).toContain("Math.min(managedUserDeleteQueryLimit, remaining)");
    expect(deleteManagedUserSource).toContain('listChildDocuments(shareName, "attachments", accessToken, 1)');
    expect(deleteManagedUserSource).toContain('listChildDocuments(noteName, "attachments", accessToken, 1)');
    expect(deleteManagedUserSource).toContain("deleteChildAttachmentsRepeatedly");
    expect(deleteManagedUserSource).toContain("managedUserAttachmentDeleteBudget - stats.attachmentObjectsProcessed");
    expect(deleteManagedUserSource).toContain("Managed user attachment cleanup requires another request");
    expect(deleteManagedUserSource).not.toContain("deleteStorageObjectsForDocuments");
  });

  it("returns an explicit retryable progress response instead of logging bounded cleanup as a failure", () => {
    expect(deleteManagedUserSource).toContain("class ManagedUserCleanupInProgressError extends Error");
    expect(deleteManagedUserSource).toContain("throw new ManagedUserCleanupInProgressError");
    expect(deleteManagedUserSource).toContain("error instanceof ManagedUserCleanupInProgressError");
    expect(deleteManagedUserSource).toContain('jsonResponse(response, 202, { ok: false, error: "cleanup_in_progress", retryable: true })');

    const progressResponseIndex = deleteManagedUserSource.indexOf("error instanceof ManagedUserCleanupInProgressError");
    const failureLogIndex = deleteManagedUserSource.indexOf('console.error("managed user delete failed"');
    expect(progressResponseIndex).toBeGreaterThan(-1);
    expect(failureLogIndex).toBeGreaterThan(progressResponseIndex);
  });

  it("preconditions projected authorization updates and retries concurrent changes from fresh data", () => {
    expect(deleteManagedUserSource).toContain('query.append("currentDocument.updateTime", updateTime)');
    expect(deleteManagedUserSource).toContain("async function firestorePatchProjectedFields");
    expect(deleteManagedUserSource).toContain('errorNumberField(error, "statusCode")');
    expect(deleteManagedUserSource).toContain("[400, 409].includes");
    expect(deleteManagedUserSource).toContain("document?.updateTime");
    expect(deleteManagedUserSource).toContain("async function deleteProjectedDocumentForStat");
    expect(deleteManagedUserSource).toContain(
      "{ delete: document.name, currentDocument: { updateTime: document.updateTime } }"
    );
    expect(deleteManagedUserSource).toContain(
      'deleteProjectedDocumentForStat(history, accessToken, stats, "noteHistoryDeleted")'
    );

    for (const projectedDocument of ["history", "user", "bootstrap"]) {
      expect(deleteManagedUserSource).toMatch(
        new RegExp(`accessToken,\\s+${projectedDocument}\\s*\\)`, "u")
      );
    }
  });

  it("projects discovery queries so encrypted attachment and history payloads are not batch-loaded", () => {
    expect(deleteManagedUserSource).toContain('fieldMask = ["__name__"]');
    expect(deleteManagedUserSource).toContain('query.append("mask.fieldPaths", fieldPath)');
    expect(deleteManagedUserSource).toContain('selectFieldPaths = ["__name__"]');
    expect(deleteManagedUserSource).toContain("fields: selectFieldPaths.map");
    expect(deleteManagedUserSource).toContain("limit = attachmentCleanupBatchSize");
    expect(deleteManagedUserSource).toContain("limit: historyCleanupBatchSize");
    expect(deleteManagedUserSource).toContain("limit: participantNoteCleanupBatchSize");
    expect(deleteManagedUserSource).toContain("notes.length < participantNoteCleanupBatchSize");
    expect(deleteManagedUserSource).toContain('selectFieldPaths: ["__name__", "readerUids"]');
    expect(deleteManagedUserSource).toContain('selectFieldPaths: ["__name__"]');
    expect(deleteManagedUserSource).toContain("firestoreBatchGetNewTransaction(context, [notePath])");
    expect(deleteManagedUserSource).toContain("prepareVaultInventoryManifestMutation(");
    expect(deleteManagedUserSource).toContain("revision: nextRevision");
    expect(deleteManagedUserSource).toContain("await firestoreCommit(context, writes, transaction)");
    expect(deleteManagedUserSource).toContain('["isAdmin", "isActive"]');
    expect(deleteManagedUserSource).toContain('["ownerUid", "attachmentRevision"]');
    expect(deleteManagedUserSource).toContain('["uid", "attachmentCount", "usedBytes"]');
  });

  it("closes attachment reservations atomically with the owned note root and purge queue", () => {
    const finalizeSource = deleteManagedUserSource.match(
      /async function finalizeNoteTreeDeletion[\s\S]*?async function deleteNoteTreeByName/u
    )?.[0] ?? "";
    const counterReadIndex = finalizeSource.indexOf("NOTE_ATTACHMENT_COUNTER_FIELD_PATHS");
    const attachmentRecheckIndex = finalizeSource.indexOf("const remainingAttachment");
    const counterWriteIndex = finalizeSource.indexOf("noteAttachmentCounterWrite({");
    const noteDeleteIndex = finalizeSource.indexOf("{ delete: noteName");
    const commitIndex = finalizeSource.indexOf(
      "await firestoreCommitWrites(noteName, writes, accessToken)"
    );

    expect(deleteManagedUserSource).toContain('from "./_note-attachment-counter.js"');
    expect(deleteManagedUserSource).toContain("NOTE_ATTACHMENT_COUNTER_FIELD_PATHS");
    expect(finalizeSource).toContain('`notePurgeCleanupQueue/${noteId}`');
    expect(finalizeSource).toContain("noteAttachmentCounterName(projectId, noteId)");
    expect(finalizeSource).toContain('listChildDocuments(\n      noteName,\n      "attachments",');
    expect(finalizeSource).toContain("counterDocument: attachmentCounter");
    expect(finalizeSource).toContain("reservedCount: 0");
    expect(finalizeSource).toContain('state: "closed"');
    expect(finalizeSource).toContain("currentDocument: { updateTime: cleanupQueue.updateTime }");
    expect(finalizeSource).toContain("noteAttachmentCounterState(attachmentCounter, noteId) === \"closed\"");
    expect(finalizeSource).toContain("Concurrent note attachment reservation requires a fresh cleanup pass");
    expect(finalizeSource).toContain("Concurrent note finalization requires a fresh cleanup pass");
    expect(finalizeSource).toContain("stats.notePurgeQueuesDeleted += 1");
    expect(counterReadIndex).toBeGreaterThan(-1);
    expect(attachmentRecheckIndex).toBeGreaterThan(counterReadIndex);
    expect(counterWriteIndex).toBeGreaterThan(attachmentRecheckIndex);
    expect(noteDeleteIndex).toBeGreaterThan(counterWriteIndex);
    expect(commitIndex).toBeGreaterThan(noteDeleteIndex);
  });

  it("pauses managed-user mutation during the stage-one attachment drain", () => {
    const deleteSource = deleteManagedUserSource.match(
      /async function deleteManagedUser\([\s\S]*?const targetProfile/u
    )?.[0] ?? "";
    const gateIndex = deleteSource.indexOf("if (NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE)");
    const targetReadIndex = deleteSource.indexOf("const targetProfile");

    expect(deleteManagedUserSource).toContain("NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE");
    expect(deleteSource).toContain('error: "attachment_rollout_in_progress"');
    expect(deleteSource).toContain("retryable: true");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(targetReadIndex).toBeGreaterThan(gateIndex);
  });

  it("removes deleted users from shared-note and share-target references", () => {
    expect(deleteManagedUserSource).toContain("participantUids");
    expect(deleteManagedUserSource).toContain("wrappedKeys");
    expect(deleteManagedUserSource).toContain("allowedShareTargetUids");
    expect(deleteManagedUserSource).toContain("sharedNoteMembershipsRemoved");
    expect(deleteManagedUserSource).toContain("shareTargetReferencesRemoved");
  });

  it("deprovisions the target before long cleanup routines can fail", () => {
    const deactivateIndex = deleteManagedUserSource.indexOf("await deactivateManagedUserBeforeCleanup");
    const authDeleteIndex = deleteManagedUserSource.indexOf("stats.authUserDeleted = await deleteAuthUser");
    const cleanupIndex = deleteManagedUserSource.indexOf("await removeDeletedUserFromShareTargets");
    const libraryCleanupIndex = deleteManagedUserSource.indexOf("await deleteOwnedLibraryItems");

    expect(deleteManagedUserSource).toContain("isActive: { booleanValue: false }");
    expect(deleteManagedUserSource).toContain("firestorePatchFieldsIfExists");
    expect(deactivateIndex).toBeGreaterThan(-1);
    expect(authDeleteIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(libraryCleanupIndex).toBeGreaterThan(-1);
    expect(deactivateIndex).toBeLessThan(cleanupIndex);
    expect(authDeleteIndex).toBeLessThan(cleanupIndex);
    expect(deactivateIndex).toBeLessThan(libraryCleanupIndex);
    expect(authDeleteIndex).toBeLessThan(libraryCleanupIndex);
  });
});
