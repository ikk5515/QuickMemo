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

  it("logs redacted backend error summaries instead of raw exception objects", () => {
    expect(deleteManagedUserSource).toContain("function safeErrorSummary(error)");
    expect(deleteManagedUserSource).toContain("redactLogMessage(error.message)");
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

    for (const projectedDocument of ["history", "note", "user", "bootstrap"]) {
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
    expect(deleteManagedUserSource).toContain('selectFieldPaths: ["__name__", "ownerUid", "participantUids", "wrappedKeys"]');
    expect(deleteManagedUserSource).toContain('["isAdmin", "isActive"]');
    expect(deleteManagedUserSource).toContain('["ownerUid", "attachmentRevision"]');
    expect(deleteManagedUserSource).toContain('["uid", "attachmentCount", "usedBytes"]');
  });

  it("deletes note purge queues atomically with the owned note root", () => {
    expect(deleteManagedUserSource).toContain("async function finalizeNoteTreeDeletion");
    expect(deleteManagedUserSource).toContain('`notePurgeCleanupQueue/${noteId}`');
    expect(deleteManagedUserSource).toContain("currentDocument: { updateTime: cleanupQueue.updateTime }");
    expect(deleteManagedUserSource).toContain("stats.notePurgeQueuesDeleted += 1");
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

    expect(deleteManagedUserSource).toContain("isActive: { booleanValue: false }");
    expect(deleteManagedUserSource).toContain("firestorePatchFieldsIfExists");
    expect(deactivateIndex).toBeGreaterThan(-1);
    expect(authDeleteIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(deactivateIndex).toBeLessThan(cleanupIndex);
    expect(authDeleteIndex).toBeLessThan(cleanupIndex);
  });
});
