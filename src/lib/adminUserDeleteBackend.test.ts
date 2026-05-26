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

  it("checks the caller admin profile and cleans schedule-owned data", () => {
    const forbiddenBackendPattern = new RegExp(`firebase-${"admin"}|firebase-${"functions"}`, "i");

    expect(deleteManagedUserSource).toContain("isActive");
    expect(deleteManagedUserSource).toContain("isAdmin");
    expect(deleteManagedUserSource).toContain("cannot_delete_self");
    expect(deleteManagedUserSource).toContain("last_active_admin");
    expect(deleteManagedUserSource).toContain("scheduleTasks");
    expect(deleteManagedUserSource).toContain("recurringHabits");
    expect(deleteManagedUserSource).toContain("recurringHabitCheckIns");
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
    expect(deleteManagedUserSource).toContain('queryDocumentsByStringField(projectId, "attachments", "uploadedBy", uid, accessToken, true)');
    expect(deleteManagedUserSource).toContain('queryDocumentsByStringField(projectId, "history", "actorUid", uid, accessToken, true)');
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
