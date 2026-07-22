import fs from "node:fs";
import path from "node:path";
import {
  RulesTestEnvironment,
  type RulesTestContext,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  Bytes,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const describeRules = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
type RulesFirestore = ReturnType<RulesTestContext["firestore"]>;

const encryptedPayload = {
  version: 1,
  algorithm: "AES-GCM",
  cipherText: "cipher",
  iv: "iv"
};

const publicSharePasswordHash = {
  version: 2,
  algorithm: "PBKDF2-SHA-256",
  salt: "c2FsdC1ieXRlcy1mb3ItdGVzdA==",
  iterations: 210000,
  hash: "aGFzaC1ieXRlcy1mb3ItdGVzdA=="
};
const legacyPublicSharePasswordHash = {
  ...publicSharePasswordHash,
  version: 1
};
const ownerWrappedShareKey = {
  version: 1,
  algorithm: "RSA-OAEP",
  wrappedKey: "b3duZXItd3JhcHBlZC1wdWJsaWMtc2hhcmUta2V5"
};

const userKeyPayload = {
  version: 1,
  algorithm: "AES-GCM",
  cipherText: "private-key",
  iv: "iv"
};
const bootstrapSetupTokenHash = "a".repeat(64);

function featureAccess(overrides: Partial<Record<"notes" | "library" | "schedule", boolean>> = {}) {
  return {
    notes: true,
    library: true,
    schedule: true,
    ...overrides
  };
}

function userProfile(uid: string, overrides: Record<string, unknown> = {}) {
  const isAdmin = Boolean(overrides.isAdmin);

  return {
    uid,
    displayName: uid,
    avatarText: uid.slice(0, 1).toUpperCase(),
    color: "#2f7d70",
    order: 1,
    quickKey: 1,
    loginEmail: `${uid}@quickmemo.local`,
    isActive: true,
    isAdmin,
    role: isAdmin ? "admin" : "user",
    publicKeyJwk: { kty: "RSA", kid: uid },
    allowedShareTargetUids: [uid],
    needsKeyRecovery: false,
    ...overrides
  };
}

function rosterProfile(uid: string, overrides: Record<string, unknown> = {}) {
  const profile = userProfile(uid, overrides);

  return {
    uid,
    displayName: profile.displayName,
    avatarText: profile.avatarText,
    color: profile.color,
    order: profile.order,
    quickKey: profile.quickKey,
    loginEmail: profile.loginEmail,
    isActive: profile.isActive,
    isAdmin: profile.isAdmin
  };
}

function userKey(uid: string) {
  return {
    uid,
    publicKeyJwk: { kty: "RSA", kid: uid },
    encryptedPrivateKeyJwk: userKeyPayload,
    kdfSalt: "salt",
    kdfIterations: 210000
  };
}

function userPreferences(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    defaultHome: "notes",
    scheduleDefaultView: "todo",
    theme: "system",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

const validLibraryWrappedKey = "A".repeat(342) + "==";
const validLibraryUrlFingerprint = "F".repeat(43);
const validLibraryEncryptedPayload = {
  ...encryptedPayload,
  cipherText: "A".repeat(24),
  iv: "A".repeat(16)
};

function libraryItem(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    generationId: "library-generation-1",
    kind: "link",
    status: "inbox",
    captureSource: "manual",
    isFavorite: false,
    encryptedContent: validLibraryEncryptedPayload,
    urlFingerprint: validLibraryUrlFingerprint,
    sourceNoteId: null,
    sourceAttachmentId: null,
    wrappedKeys: {
      [uid]: { version: 1, algorithm: "RSA-OAEP", wrappedKey: validLibraryWrappedKey }
    },
    revision: 1,
    lastMutationId: "library-mutation-1",
    reviewCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastOpenedAt: null,
    lastReviewedAt: null,
    ...overrides
  };
}

function libraryVault(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: validLibraryWrappedKey },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

function scheduleTask(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    status: "active",
    dueDate: "2026-05-19",
    dueTimeMinutes: 960,
    startDate: "2026-05-19",
    endDate: "2026-05-19",
    startTimeMinutes: 960,
    endTimeMinutes: null,
    sortOrder: null,
    progressPercent: 0,
    isImportant: true,
    isUrgent: false,
    encryptedTitle: encryptedPayload,
    encryptedDetails: encryptedPayload,
    wrappedKeys: {
      [uid]: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-key" }
    },
    createdBy: uid,
    updatedBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
    ...overrides
  };
}

function recurringHabit(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    status: "active",
    slot: "morning",
    icon: "work",
    color: "#6fa99f",
    encryptedTitle: encryptedPayload,
    encryptedDetails: encryptedPayload,
    wrappedKeys: {
      [uid]: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-key" }
    },
    createdBy: uid,
    updatedBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

function recurringHabitCheckIn(uid: string, habitId: string, date: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    habitId,
    date,
    completed: true,
    progressPercent: 100,
    checkedItemIds: [],
    checkedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

function quickLoginKey(uid: string, quickKey: number) {
  return {
    uid,
    quickKey
  };
}

function attachmentDocument(noteId: string, overrides: Record<string, unknown> = {}) {
  const originalSize = typeof overrides.originalSize === "number" ? overrides.originalSize : 4;

  return {
    noteId,
    version: 1,
    algorithm: "AES-GCM",
    fileName: "report",
    extension: "pdf",
    mimeType: "application/pdf",
    originalSize,
    encryptedData: Bytes.fromUint8Array(new Uint8Array(originalSize + 16)),
    iv: Bytes.fromUint8Array(new Uint8Array(12)),
    uploadedBy: "user-a",
    createdAt: new Date("2026-05-18T08:00:00.000Z"),
    ...overrides
  };
}

function storedAttachmentDocument(noteId: string, attachmentId: string, overrides: Record<string, unknown> = {}) {
  const originalSize = typeof overrides.originalSize === "number" ? overrides.originalSize : 10 * 1024 * 1024;

  return {
    noteId,
    version: 1,
    algorithm: "AES-GCM",
    fileName: "archive",
    extension: "zip",
    mimeType: "application/zip",
    originalSize,
    storagePath: `notes/${noteId}/attachments/${attachmentId}/data`,
    encryptedSize: originalSize + 16,
    isReady: false,
    iv: Bytes.fromUint8Array(new Uint8Array(12)),
    uploadedBy: "user-a",
    createdAt: new Date("2026-05-18T08:00:00.000Z"),
    ...overrides
  };
}

function softDeleteFields(uid: string) {
  return {
    isDeleted: true,
    deletedAt: new Date("2026-05-18T10:00:00.000Z"),
    deletedBy: uid,
    updatedAt: new Date("2026-05-18T10:00:00.000Z"),
    updatedBy: uid
  };
}

function restoreFields(uid: string) {
  return {
    isDeleted: false,
    deletedAt: deleteField(),
    deletedBy: deleteField(),
    updatedAt: new Date("2026-05-18T11:00:00.000Z"),
    updatedBy: uid
  };
}

function noteUserState(noteId: string, uid: string, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    noteId,
    isPinned: true,
    readAt: new Date("2026-05-18T09:00:00.000Z"),
    cursorOffset: 4,
    cursorVisible: true,
    cursorClientId: "client-a",
    cursorUpdatedAt: new Date("2026-05-18T09:00:00.000Z"),
    updatedAt: new Date("2026-05-18T09:00:00.000Z"),
    ...overrides
  };
}

function noteHistory(noteId: string, actorUid: string, overrides: Record<string, unknown> = {}) {
  return {
    noteId,
    actorUid,
    action: "content",
    changedFields: ["title", "body"],
    readerUids: ["user-a", "user-b"],
    revision: 1,
    encryptedSummary: encryptedPayload,
    encryptedSnapshot: encryptedPayload,
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function noteRevisionId(revision: number) {
  return `revision-${String(revision).padStart(12, "0")}`;
}

function createAuditedNote(
  firestore: RulesFirestore,
  noteId: string,
  actorUid: string,
  note: Record<string, unknown>,
  readerUids: string[]
) {
  const revision = 1;
  const historyId = noteRevisionId(revision);
  const batch = writeBatch(firestore);

  batch.set(doc(firestore, "notes", noteId), {
    ...note,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: actorUid,
    revision,
    lastMutationId: historyId
  });
  batch.set(
    doc(firestore, "notes", noteId, "history", historyId),
    noteHistory(noteId, actorUid, {
      action: "create",
      changedFields: ["title", "body"],
      readerUids,
      revision
    })
  );

  return batch.commit();
}

function updateAuditedNote(
  firestore: RulesFirestore,
  noteId: string,
  actorUid: string,
  revision: number,
  action: "content" | "share" | "delete" | "restore",
  changedFields: string[],
  readerUids: string[],
  updates: Record<string, unknown>
) {
  const historyId = noteRevisionId(revision);
  const batch = writeBatch(firestore);

  batch.update(doc(firestore, "notes", noteId), {
    ...updates,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
    revision,
    lastMutationId: historyId
  });
  batch.set(
    doc(firestore, "notes", noteId, "history", historyId),
    noteHistory(noteId, actorUid, { action, changedFields, readerUids, revision })
  );

  return batch.commit();
}

function publicShareDocument(sourceNoteId = "note-a", ownerUid = "user-a", overrides: Record<string, unknown> = {}) {
  return {
    sourceNoteId,
    sourceRevision: 0,
    sourceAttachmentRevision: 0,
    ownerUid,
    version: 1,
    encryptedTitle: encryptedPayload,
    encryptedBody: encryptedPayload,
    ownerWrappedShareKey,
    currentGeneration: "generation-a",
    attachmentCount: 0,
    ready: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    ...overrides
  };
}

function publicShareAttachment(overrides: Record<string, unknown> = {}) {
  const originalSize = typeof overrides.originalSize === "number" ? overrides.originalSize : 4;
  const extension = typeof overrides.extension === "string" ? overrides.extension : "pdf";

  return {
    version: 1,
    privacyVersion: 1,
    algorithm: "AES-GCM",
    fileName: `shared-${extension}-attachment`,
    encryptedFileName: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: "A".repeat(24),
      iv: "A".repeat(16)
    },
    extension,
    mimeType: "application/pdf",
    originalSize,
    encryptedData: Bytes.fromUint8Array(new Uint8Array(originalSize + 16)),
    iv: Bytes.fromUint8Array(new Uint8Array(12)),
    generation: "generation-a",
    sourceAttachmentId: "attachment-a",
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function legacyPublicShareAttachment(overrides: Record<string, unknown> = {}) {
  const attachment = publicShareAttachment(overrides) as Record<string, unknown>;
  delete attachment.privacyVersion;
  delete attachment.encryptedFileName;
  attachment.fileName = "legacy-plaintext-report";
  return attachment;
}

function storedPublicShareAttachment(shareId: string, attachmentId: string, overrides: Record<string, unknown> = {}) {
  const originalSize = typeof overrides.originalSize === "number" ? overrides.originalSize : 10 * 1024 * 1024;

  return {
    version: 1,
    privacyVersion: 1,
    algorithm: "AES-GCM",
    fileName: "shared-zip-attachment",
    encryptedFileName: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: "A".repeat(24),
      iv: "A".repeat(16)
    },
    extension: "zip",
    mimeType: "application/zip",
    originalSize,
    storagePath: `publicNoteShares/${shareId}/attachments/${attachmentId}/data`,
    encryptedSize: originalSize + 16,
    isReady: false,
    iv: Bytes.fromUint8Array(new Uint8Array(12)),
    generation: "generation-a",
    sourceAttachmentId: "attachment-a",
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function publicShareCleanupQueue(shareId: string, expiresAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    shareId,
    expiresAt,
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function publicShareAttachmentCleanupQueue(
  shareId: string,
  attachmentId: string,
  expiresAt: Date,
  overrides: Record<string, unknown> = {}
) {
  return {
    shareId,
    attachmentId,
    expiresAt,
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function createPublicShareBatch(
  db: any,
  shareId: string,
  data: ReturnType<typeof publicShareDocument>
) {
  const batch = writeBatch(db);
  batch.set(doc(db, `publicNoteShares/${shareId}`), data);
  batch.set(doc(db, `publicShareCleanupQueue/${shareId}`), publicShareCleanupQueue(shareId, data.expiresAt as Date));
  return batch.commit();
}

function createPublicShareAttachmentBatch(
  db: any,
  shareId: string,
  attachmentId: string,
  data: ReturnType<typeof publicShareAttachment> | ReturnType<typeof storedPublicShareAttachment>
) {
  const batch = writeBatch(db);
  batch.set(doc(db, `publicNoteShares/${shareId}/attachments/${attachmentId}`), data);
  batch.set(
    doc(db, `publicShareCleanupQueue/${shareId}/publicShareAttachmentCleanupQueue/${attachmentId}`),
    publicShareAttachmentCleanupQueue(shareId, attachmentId, data.expiresAt as Date)
  );
  return batch.commit();
}

describeRules("firestore security rules", () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "quickmemo-rules-test",
      firestore: {
        rules: fs.readFileSync(path.resolve("firestore.rules"), "utf8")
      }
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it("allows public roster reads without authentication", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "publicLoginRoster/user-a"), {
        uid: "user-a",
        displayName: "Alpha",
        avatarText: "A",
        color: "#2f7d70",
        order: 1,
        quickKey: 1,
        loginEmail: "a@quickmemo.local",
        isActive: true,
        isAdmin: false
      });
    });

    const publicDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(publicDb, "publicLoginRoster/user-a")));
  });

  it("blocks every client from Google Calendar server-only collections", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true }));
      await setDoc(doc(db, "googleCalendarConnections/user-a"), {
        uid: "user-a",
        calendarId: "primary",
        encryptedRefreshToken: "server-only"
      });
      await setDoc(doc(db, "googleCalendarOAuthStates/state-a"), {
        uid: "user-a",
        stateHash: "server-only",
        expiresAt: new Date("2026-05-18T09:00:00.000Z")
      });
      await setDoc(doc(db, "googleCalendarConnectionEpochs/user-a"), {
        ownerUid: "user-a",
        connectionEpoch: "server-only"
      });
    });

    const clientDatabases = [
      testEnv.unauthenticatedContext().firestore(),
      testEnv.authenticatedContext("user-a").firestore(),
      testEnv.authenticatedContext("user-b").firestore(),
      testEnv.authenticatedContext("admin-a").firestore()
    ];
    const serverOnlyCollections = [
      "googleCalendarConnectionEpochs",
      "googleCalendarConnections",
      "googleCalendarOAuthStates"
    ];

    for (const db of clientDatabases) {
      for (const collectionName of serverOnlyCollections) {
        const existingId = collectionName === "googleCalendarOAuthStates" ? "state-a" : "user-a";
        const existingDocument = doc(db, collectionName, existingId);

        await assertFails(getDoc(existingDocument));
        await assertFails(getDocs(collection(db, collectionName)));
        await assertFails(setDoc(doc(db, collectionName, "client-created"), { value: "blocked" }));
        await assertFails(updateDoc(existingDocument, { value: "blocked" }));
        await assertFails(deleteDoc(existingDocument));
      }
    }
  });

  it("allows the first signed-in user to bootstrap the first admin", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "system/bootstrapGate"), {
        setupTokenHash: bootstrapSetupTokenHash,
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const batch = writeBatch(adminDb);

    batch.set(doc(adminDb, "system/bootstrap"), { adminUid: "admin-a", createdAt: serverTimestamp() });
    batch.set(doc(adminDb, "system/bootstrapAttempts/attempts/admin-a"), {
      uid: "admin-a",
      setupTokenHash: bootstrapSetupTokenHash,
      createdAt: serverTimestamp()
    });
    batch.set(doc(adminDb, "quickLoginKeys/1"), quickLoginKey("admin-a", 1));
    batch.set(doc(adminDb, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
    batch.set(doc(adminDb, "publicLoginRoster/admin-a"), rosterProfile("admin-a", { isAdmin: true, role: "admin" }));
    batch.set(doc(adminDb, "userKeys/admin-a"), userKey("admin-a"));

    await assertSucceeds(batch.commit());
  });

  it("blocks first admin bootstrap without the operator setup gate", async () => {
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const missingGateBatch = writeBatch(adminDb);

    missingGateBatch.set(doc(adminDb, "system/bootstrap"), { adminUid: "admin-a", createdAt: serverTimestamp() });
    missingGateBatch.set(doc(adminDb, "system/bootstrapAttempts/attempts/admin-a"), {
      uid: "admin-a",
      setupTokenHash: bootstrapSetupTokenHash,
      createdAt: serverTimestamp()
    });
    missingGateBatch.set(doc(adminDb, "quickLoginKeys/1"), quickLoginKey("admin-a", 1));
    missingGateBatch.set(doc(adminDb, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
    missingGateBatch.set(doc(adminDb, "publicLoginRoster/admin-a"), rosterProfile("admin-a", { isAdmin: true, role: "admin" }));
    missingGateBatch.set(doc(adminDb, "userKeys/admin-a"), userKey("admin-a"));

    await assertFails(missingGateBatch.commit());

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "system/bootstrapGate"), {
        setupTokenHash: bootstrapSetupTokenHash,
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), "system/bootstrap")));

    const wrongTokenBatch = writeBatch(adminDb);
    wrongTokenBatch.set(doc(adminDb, "system/bootstrap"), { adminUid: "admin-a", createdAt: serverTimestamp() });
    wrongTokenBatch.set(doc(adminDb, "system/bootstrapAttempts/attempts/admin-a"), {
      uid: "admin-a",
      setupTokenHash: "b".repeat(64),
      createdAt: serverTimestamp()
    });
    wrongTokenBatch.set(doc(adminDb, "quickLoginKeys/1"), quickLoginKey("admin-a", 1));
    wrongTokenBatch.set(doc(adminDb, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
    wrongTokenBatch.set(doc(adminDb, "publicLoginRoster/admin-a"), rosterProfile("admin-a", { isAdmin: true, role: "admin" }));
    wrongTokenBatch.set(doc(adminDb, "userKeys/admin-a"), userKey("admin-a"));

    await assertFails(wrongTokenBatch.commit());
  });

  it("allows admins to create managed users and blocks non-admins", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "system/bootstrap"), { adminUid: "admin-a" });
      await setDoc(doc(context.firestore(), "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const adminBatch = writeBatch(adminDb);
    adminBatch.set(doc(adminDb, "quickLoginKeys/2"), quickLoginKey("user-b", 2));
    adminBatch.set(doc(adminDb, "users/user-b"), userProfile("user-b", { order: 2, quickKey: 2 }));
    adminBatch.set(doc(adminDb, "publicLoginRoster/user-b"), rosterProfile("user-b", { order: 2, quickKey: 2 }));
    adminBatch.set(doc(adminDb, "userKeys/user-b"), userKey("user-b"));

    await assertSucceeds(adminBatch.commit());

    const userDb = testEnv.authenticatedContext("user-b").firestore();
    const userBatch = writeBatch(userDb);
    userBatch.set(doc(userDb, "quickLoginKeys/3"), quickLoginKey("user-c", 3));
    userBatch.set(doc(userDb, "users/user-c"), userProfile("user-c", { order: 3, quickKey: 3 }));
    userBatch.set(doc(userDb, "publicLoginRoster/user-c"), rosterProfile("user-c", { order: 3, quickKey: 3 }));
    userBatch.set(doc(userDb, "userKeys/user-c"), userKey("user-c"));

    await assertFails(userBatch.commit());
  });

  it("allows admins to hard-delete managed user account documents in one batch", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "system/bootstrap"), { adminUid: "admin-a" });
      await setDoc(doc(context.firestore(), "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(context.firestore(), "quickLoginKeys/2"), quickLoginKey("user-b", 2));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b", { order: 2, quickKey: 2 }));
      await setDoc(doc(context.firestore(), "publicLoginRoster/user-b"), rosterProfile("user-b", { order: 2, quickKey: 2 }));
      await setDoc(doc(context.firestore(), "userKeys/user-b"), userKey("user-b"));
      await setDoc(doc(context.firestore(), "quickLoginKeys/3"), quickLoginKey("user-c", 3));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c", { order: 3, quickKey: 3 }));
      await setDoc(doc(context.firestore(), "publicLoginRoster/user-c"), rosterProfile("user-c", { order: 3, quickKey: 3 }));
      await setDoc(doc(context.firestore(), "userKeys/user-c"), userKey("user-c"));
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const adminBatch = writeBatch(adminDb);
    adminBatch.delete(doc(adminDb, "quickLoginKeys/2"));
    adminBatch.delete(doc(adminDb, "users/user-b"));
    adminBatch.delete(doc(adminDb, "publicLoginRoster/user-b"));
    adminBatch.delete(doc(adminDb, "userKeys/user-b"));

    await assertSucceeds(adminBatch.commit());
    const deletedUserSnapshot = await assertSucceeds(getDoc(doc(adminDb, "users/user-b")));
    expect(deletedUserSnapshot.exists()).toBe(false);

    const userDb = testEnv.authenticatedContext("user-c").firestore();
    const userBatch = writeBatch(userDb);
    userBatch.delete(doc(userDb, "quickLoginKeys/3"));
    userBatch.delete(doc(userDb, "users/user-c"));
    userBatch.delete(doc(userDb, "publicLoginRoster/user-c"));
    userBatch.delete(doc(userDb, "userKeys/user-c"));

    await assertFails(userBatch.commit());

    const selfBatch = writeBatch(adminDb);
    selfBatch.delete(doc(adminDb, "users/admin-a"));
    await assertFails(selfBatch.commit());
  });

  it("prevents admins from changing immutable user identity fields", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "system/bootstrap"), { adminUid: "admin-a" });
      await setDoc(doc(context.firestore(), "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(context.firestore(), "quickLoginKeys/2"), quickLoginKey("user-b", 2));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b", { order: 2, quickKey: 2 }));
      await setDoc(doc(context.firestore(), "publicLoginRoster/user-b"), rosterProfile("user-b", { order: 2, quickKey: 2 }));
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();

    await assertSucceeds(updateDoc(doc(adminDb, "users/user-b"), { allowedShareTargetUids: ["user-b", "admin-a"] }));
    await assertFails(updateDoc(doc(adminDb, "users/user-b"), { loginEmail: "changed@quickmemo.local" }));
  });

  it("allows only admins to persist a strictly shaped per-user feature access map", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "system/bootstrap"), { adminUid: "admin-a" });
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(db, "quickLoginKeys/2"), quickLoginKey("user-b", 2));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b", { order: 2, quickKey: 2 }));
      await setDoc(doc(db, "publicLoginRoster/user-b"), rosterProfile("user-b", { order: 2, quickKey: 2 }));
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const userDb = testEnv.authenticatedContext("user-b").firestore();
    const userRef = doc(adminDb, "users/user-b");

    await assertSucceeds(
      updateDoc(userRef, {
        featureAccess: featureAccess({ library: false, schedule: false })
      })
    );
    await assertFails(
      updateDoc(userRef, {
        featureAccess: { notes: true, library: true }
      })
    );
    await assertFails(
      updateDoc(userRef, {
        featureAccess: { ...featureAccess(), billing: true }
      })
    );
    await assertFails(
      updateDoc(userRef, {
        featureAccess: { ...featureAccess(), schedule: "yes" }
      })
    );
    await assertFails(
      updateDoc(doc(userDb, "users/user-b"), {
        featureAccess: featureAccess()
      })
    );
  });

  it("blocks inactive users from sensitive reads and note creation", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { isActive: false }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "userKeys/user-a"), userKey("user-a"));
      await setDoc(doc(context.firestore(), "activeNotes/user-a"), {
        uid: "user-a",
        noteId: null,
        updatedByClientId: "client-a"
      });
    });

    const inactiveDb = testEnv.authenticatedContext("user-a").firestore();

    await assertSucceeds(getDoc(doc(inactiveDb, "users/user-a")));
    await assertFails(getDocs(query(collection(inactiveDb, "users"), orderBy("order", "asc"))));
    await assertFails(getDoc(doc(inactiveDb, "userKeys/user-a")));
    await assertFails(getDoc(doc(inactiveDb, "activeNotes/user-a")));
    await assertFails(
      setDoc(doc(inactiveDb, "notes/inactive-created"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      })
    );
  });

  it("enforces independent feature access while preserving legacy users and the admin bypass", async () => {
    const accessByUid: Record<string, Record<string, unknown>> = {
      "legacy-user": {},
      "notes-user": { featureAccess: featureAccess({ library: false, schedule: false }) },
      "library-user": { featureAccess: featureAccess({ notes: false, schedule: false }) },
      "schedule-user": { featureAccess: featureAccess({ notes: false, library: false }) },
      "admin-a": { isAdmin: true, role: "admin", featureAccess: featureAccess({ notes: false, library: false, schedule: false }) },
      "malformed-user": { featureAccess: { notes: true, library: true } }
    };

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      for (const [uid, overrides] of Object.entries(accessByUid)) {
        await setDoc(doc(db, `users/${uid}`), userProfile(uid, overrides));
        await setDoc(doc(db, `libraryVaults/${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `libraryItems/item-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `scheduleTasks/task-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `recurringHabits/habit-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `recurringHabitCheckIns/check-in-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `googleCalendarTaskSyncReceipts/receipt-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `googleCalendarTaskTombstones/tombstone-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `noteFolders/folder-${uid}`), { ownerUid: uid });
        await setDoc(doc(db, `notes/note-${uid}`), {
          ownerUid: uid,
          participantUids: [uid],
          isDeleted: false
        });
        await setDoc(doc(db, `notes/note-${uid}/history/history-a`), {
          readerUids: [uid]
        });
        await setDoc(doc(db, `notes/note-${uid}/attachments/attachment-a`), {
          noteId: `note-${uid}`
        });
        await setDoc(doc(db, `noteUserStates/note-${uid}/users/${uid}`), {
          uid,
          noteId: `note-${uid}`
        });
        await setDoc(doc(db, `activeNotes/${uid}`), {
          uid,
          noteId: null,
          updatedByClientId: "feature-test"
        });
      }

      await setDoc(doc(db, "notes/library-source"), {
        ownerUid: "library-user",
        participantUids: ["library-user"],
        isDeleted: false,
        isPurged: false
      });
      await setDoc(doc(db, "notes/library-source/attachments/source-attachment"), {
        noteId: "library-source",
        isReady: true
      });
    });

    const legacyDb = testEnv.authenticatedContext("legacy-user").firestore();
    await assertSucceeds(getDoc(doc(legacyDb, "notes/note-legacy-user")));
    await assertSucceeds(getDoc(doc(legacyDb, "libraryItems/item-legacy-user")));
    await assertSucceeds(getDoc(doc(legacyDb, "scheduleTasks/task-legacy-user")));

    const notesDb = testEnv.authenticatedContext("notes-user").firestore();
    await assertSucceeds(getDoc(doc(notesDb, "notes/note-notes-user")));
    await assertSucceeds(getDoc(doc(notesDb, "noteFolders/folder-notes-user")));
    await assertSucceeds(getDoc(doc(notesDb, "notes/note-notes-user/history/history-a")));
    await assertSucceeds(getDoc(doc(notesDb, "notes/note-notes-user/attachments/attachment-a")));
    await assertSucceeds(getDoc(doc(notesDb, "noteUserStates/note-notes-user/users/notes-user")));
    await assertSucceeds(getDoc(doc(notesDb, "activeNotes/notes-user")));
    await assertFails(getDoc(doc(notesDb, "libraryItems/item-notes-user")));
    await assertFails(getDoc(doc(notesDb, "scheduleTasks/task-notes-user")));

    const libraryDb = testEnv.authenticatedContext("library-user").firestore();
    await assertSucceeds(getDoc(doc(libraryDb, "libraryVaults/library-user")));
    await assertSucceeds(getDoc(doc(libraryDb, "libraryItems/item-library-user")));
    await assertSucceeds(setDoc(doc(libraryDb, "libraryItems/new-link"), libraryItem("library-user")));
    await assertFails(
      setDoc(
        doc(libraryDb, "libraryItems/note-derived-file"),
        libraryItem("library-user", {
          kind: "attachment",
          captureSource: "attachment-ocr",
          urlFingerprint: null,
          sourceNoteId: "library-source",
          sourceAttachmentId: "source-attachment"
        })
      )
    );
    await assertFails(getDoc(doc(libraryDb, "notes/note-library-user")));
    await assertFails(getDoc(doc(libraryDb, "scheduleTasks/task-library-user")));

    const scheduleDb = testEnv.authenticatedContext("schedule-user").firestore();
    await assertSucceeds(getDoc(doc(scheduleDb, "scheduleTasks/task-schedule-user")));
    await assertSucceeds(getDoc(doc(scheduleDb, "recurringHabits/habit-schedule-user")));
    await assertSucceeds(getDoc(doc(scheduleDb, "recurringHabitCheckIns/check-in-schedule-user")));
    await assertSucceeds(
      getDocs(
        query(
          collection(scheduleDb, "googleCalendarTaskSyncReceipts"),
          where("ownerUid", "==", "schedule-user")
        )
      )
    );
    await assertSucceeds(
      getDocs(
        query(
          collection(scheduleDb, "googleCalendarTaskTombstones"),
          where("ownerUid", "==", "schedule-user")
        )
      )
    );
    await assertFails(getDoc(doc(scheduleDb, "notes/note-schedule-user")));
    await assertFails(getDoc(doc(scheduleDb, "libraryItems/item-schedule-user")));

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    await assertSucceeds(getDoc(doc(adminDb, "notes/note-admin-a")));
    await assertSucceeds(getDoc(doc(adminDb, "libraryItems/item-admin-a")));
    await assertSucceeds(getDoc(doc(adminDb, "scheduleTasks/task-admin-a")));

    const malformedDb = testEnv.authenticatedContext("malformed-user").firestore();
    await assertFails(getDoc(doc(malformedDb, "notes/note-malformed-user")));
    await assertFails(getDoc(doc(malformedDb, "libraryItems/item-malformed-user")));
    await assertFails(getDoc(doc(malformedDb, "scheduleTasks/task-malformed-user")));
  });

  it("allows users to rotate only their own encrypted private key material", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "userKeys/user-a"), userKey("user-a"));
    });

    const userDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(
      updateDoc(doc(userDb, "userKeys/user-a"), {
        pendingEncryptedPrivateKeyJwk: { ...userKeyPayload, cipherText: "pending-key" },
        pendingKdfSalt: "pending-salt",
        pendingKdfIterations: 210000,
        pendingCreatedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(userDb, "userKeys/user-a"), {
        encryptedPrivateKeyJwk: { ...userKeyPayload, cipherText: "next-key" },
        kdfSalt: "next-salt",
        kdfIterations: 210000,
        pendingEncryptedPrivateKeyJwk: deleteField(),
        pendingKdfSalt: deleteField(),
        pendingKdfIterations: deleteField(),
        pendingCreatedAt: deleteField(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(updateDoc(doc(userDb, "userKeys/user-a"), { publicKeyJwk: { kty: "RSA", kid: "changed" } }));
    await assertFails(
      updateDoc(doc(otherDb, "userKeys/user-a"), {
        pendingEncryptedPrivateKeyJwk: { ...userKeyPayload, cipherText: "stolen" },
        pendingKdfSalt: "pending-salt",
        pendingKdfIterations: 210000,
        pendingCreatedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
  });

  it("keeps user preferences owner-only with strict values", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(
      setDoc(
        doc(ownerDb, "userPreferences/user-a"),
        userPreferences("user-a", {
          defaultHome: "schedule",
          matrixLabels: {
            todayOverdue: "오늘/지연",
            importantUrgent: "중요·긴급",
            urgent: "긴급 업무",
            important: "중요 업무",
            waiting: "대기 업무"
          },
          scheduleDefaultView: "matrix",
          theme: "dark"
        })
      )
    );
    await assertSucceeds(getDoc(doc(ownerDb, "userPreferences/user-a")));
    await assertFails(getDoc(doc(otherDb, "userPreferences/user-a")));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { defaultHome: "library", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultView: "calendar", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultView: "completed", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultView: "recurring", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { theme: "light", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { theme: "system", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      matrixLabels: {
        todayOverdue: "오늘 처리",
        importantUrgent: "바로 처리",
        urgent: "위임 업무",
        important: "집중 업무",
        waiting: "대기 목록"
      },
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      matrixLabels: {
        todayOverdue: "오늘 처리",
        importantUrgent: "바로 처리",
        urgent: "",
        important: "집중 업무",
        waiting: "대기 목록"
      },
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      matrixLabels: {
        todayOverdue: "오늘 처리",
        importantUrgent: "가".repeat(17),
        urgent: "위임 업무",
        important: "집중 업무",
        waiting: "대기 목록"
      },
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      matrixLabels: {
        importantUrgent: "바로 처리",
        urgent: "위임 업무",
        important: "집중 업무"
      },
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      matrixLabels: {
        todayOverdue: "오늘 처리",
        importantUrgent: "바로 처리",
        urgent: "위임 업무",
        important: "집중 업무",
        waiting: "대기 목록",
        extra: "추가"
      },
      updatedAt: serverTimestamp()
    }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "userPreferences/user-a"), {
        uid: "user-a",
        defaultHome: "notes",
        scheduleDefaultView: "todo",
        theme: "system",
        updatedAt: serverTimestamp()
      });
    });
    await assertSucceeds(
      updateDoc(doc(ownerDb, "userPreferences/user-a"), {
        defaultHome: "schedule",
        scheduleDefaultView: "matrix",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), { defaultHome: "admin", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), { theme: "midnight", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(otherDb, "userPreferences/user-a"), userPreferences("user-a")));
  });

  it("allows active owners to create, revise, query, and delete their library items", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, `notes/${"n".repeat(180)}`), {
        ownerUid: "user-a",
        isDeleted: false,
        isPurged: false
      });
      await setDoc(doc(db, `notes/${"n".repeat(180)}/attachments/${"a".repeat(180)}`), {
        noteId: "n".repeat(180)
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const itemRef = doc(ownerDb, "libraryItems/item-a");

    await assertSucceeds(
      setDoc(itemRef, libraryItem("user-a", {
        kind: "attachment",
        captureSource: "attachment-ocr",
        urlFingerprint: null,
        sourceNoteId: "n".repeat(180),
        sourceAttachmentId: "a".repeat(180)
      }))
    );
    await assertSucceeds(getDoc(itemRef));
    await assertSucceeds(
      getDocs(query(collection(ownerDb, "libraryItems"), where("ownerUid", "==", "user-a"), orderBy("updatedAt", "desc")))
    );
    await assertSucceeds(
      updateDoc(itemRef, {
        status: "reading",
        isFavorite: true,
        revision: 2,
        lastMutationId: "library-mutation-2",
        reviewCount: 1,
        lastOpenedAt: serverTimestamp(),
        lastReviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(deleteDoc(itemRef));
  });

  it("keeps missing library item reads private while allowing create-first deterministic writes", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const itemRef = doc(ownerDb, "libraryItems/link-deterministic");

    await assertFails(runTransaction(ownerDb, async (transaction) => {
      const snapshot = await transaction.get(itemRef);

      if (!snapshot.exists()) {
        transaction.set(itemRef, libraryItem("user-a"));
      }
    }));
    await assertSucceeds(setDoc(itemRef, libraryItem("user-a")));
    await assertFails(setDoc(itemRef, libraryItem("user-a")));
    await assertSucceeds(getDoc(itemRef));
    await assertFails(getDoc(doc(otherDb, "libraryItems/link-deterministic")));
    await assertFails(setDoc(
      doc(otherDb, "libraryItems/link-deterministic"),
      libraryItem("user-b")
    ));
  });

  it("only lets a note owner persist an OCR copy of an existing ready attachment", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "notes/owned-note"), {
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        isDeleted: false,
        isPurged: false
      });
      await setDoc(doc(db, "notes/owned-note/attachments/inline-ready"), {
        noteId: "owned-note"
      });
      await setDoc(doc(db, "notes/owned-note/attachments/stored-ready"), {
        noteId: "owned-note",
        isReady: true
      });
      await setDoc(doc(db, "notes/owned-note/attachments/stored-pending"), {
        noteId: "owned-note",
        isReady: false
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    const attachmentItem = (attachmentId: string) => libraryItem("user-a", {
      kind: "attachment",
      captureSource: "attachment-ocr",
      urlFingerprint: null,
      sourceNoteId: "owned-note",
      sourceAttachmentId: attachmentId
    });

    await assertSucceeds(
      setDoc(doc(ownerDb, "libraryItems/inline-ready"), attachmentItem("inline-ready"))
    );
    await assertSucceeds(
      setDoc(doc(ownerDb, "libraryItems/stored-ready"), attachmentItem("stored-ready"))
    );
    await assertFails(
      setDoc(doc(ownerDb, "libraryItems/stored-pending"), attachmentItem("stored-pending"))
    );
    await assertFails(
      setDoc(doc(ownerDb, "libraryItems/missing-source"), attachmentItem("missing"))
    );
    await assertFails(
      setDoc(
        doc(participantDb, "libraryItems/shared-source-copy"),
        libraryItem("user-b", {
          kind: "attachment",
          captureSource: "attachment-ocr",
          urlFingerprint: null,
          sourceNoteId: "owned-note",
          sourceAttachmentId: "inline-ready"
        })
      )
    );
  });

  it("keeps library items private from outsiders, admins, and inactive owners", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(db, "users/user-inactive"), userProfile("user-inactive", { isActive: false }));
      await setDoc(doc(db, "libraryItems/item-a"), libraryItem("user-a"));
      await setDoc(doc(db, "libraryItems/item-inactive"), libraryItem("user-inactive"));
    });

    const outsiderDb = testEnv.authenticatedContext("user-b").firestore();
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const inactiveDb = testEnv.authenticatedContext("user-inactive").firestore();

    await assertFails(getDoc(doc(outsiderDb, "libraryItems/item-a")));
    await assertFails(deleteDoc(doc(outsiderDb, "libraryItems/item-a")));
    await assertFails(getDoc(doc(adminDb, "libraryItems/item-a")));
    await assertFails(deleteDoc(doc(adminDb, "libraryItems/item-a")));
    await assertFails(getDoc(doc(inactiveDb, "libraryItems/item-inactive")));
    await assertFails(deleteDoc(doc(inactiveDb, "libraryItems/item-inactive")));
    await assertFails(setDoc(doc(inactiveDb, "libraryItems/inactive-created"), libraryItem("user-inactive")));
  });

  it("rejects forged, unbounded, extra-field, shared-key, and skipped-revision library writes", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();

    await assertFails(setDoc(doc(ownerDb, "libraryItems/forged-owner"), libraryItem("user-b")));
    await assertFails(setDoc(doc(ownerDb, "libraryItems/invalid-generation"), libraryItem("user-a", { generationId: "short" })));
    await assertFails(setDoc(doc(ownerDb, "libraryItems/extra-field"), libraryItem("user-a", { extra: true })));
    await assertFails(
      setDoc(
        doc(ownerDb, "libraryItems/invalid-iv"),
        libraryItem("user-a", { encryptedContent: { ...validLibraryEncryptedPayload, iv: "too-short" } })
      )
    );
    await assertFails(
      setDoc(doc(ownerDb, "libraryItems/unbound-link"), libraryItem("user-a", { urlFingerprint: null }))
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "libraryItems/forged-attachment-binding"),
        libraryItem("user-a", {
          kind: "attachment",
          captureSource: "attachment-ocr",
          urlFingerprint: null,
          sourceNoteId: "note_12345678",
          sourceAttachmentId: null
        })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "libraryItems/short-wrapped-key"),
        libraryItem("user-a", {
          wrappedKeys: {
            "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "too-short" }
          }
        })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "libraryItems/shared-key"),
        libraryItem("user-a", {
          wrappedKeys: {
            "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: validLibraryWrappedKey },
            "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "B".repeat(342) + "==" }
          }
        })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "libraryItems/oversized"),
        libraryItem("user-a", {
          encryptedContent: { ...validLibraryEncryptedPayload, cipherText: "a".repeat(700001) }
        })
      )
    );

    const itemRef = doc(ownerDb, "libraryItems/item-a");
    await assertSucceeds(setDoc(itemRef, libraryItem("user-a")));
    await assertFails(
      updateDoc(itemRef, {
        revision: 3,
        lastMutationId: "library-mutation-3",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(itemRef, {
        revision: 2,
        lastMutationId: "library-mutation-review-without-time",
        reviewCount: 1,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(itemRef, {
        generationId: "library-generation-2",
        revision: 2,
        lastMutationId: "library-mutation-generation-change",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(itemRef, {
        kind: "clip",
        revision: 2,
        lastMutationId: "library-mutation-2",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(itemRef, {
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "B".repeat(342) + "==" }
        },
        revision: 2,
        lastMutationId: "library-mutation-2",
        updatedAt: serverTimestamp()
      })
    );
  });

  it("creates one immutable library vault per active owner and isolates it from admins", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(db, "users/user-inactive"), userProfile("user-inactive", { isActive: false }));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-b").firestore();
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const inactiveDb = testEnv.authenticatedContext("user-inactive").firestore();
    const vaultRef = doc(ownerDb, "libraryVaults/user-a");

    const missingVault = await assertSucceeds(getDoc(vaultRef));
    expect(missingVault.exists()).toBe(false);
    await assertSucceeds(runTransaction(ownerDb, async (transaction) => {
      const snapshot = await transaction.get(vaultRef);

      if (!snapshot.exists()) {
        transaction.set(vaultRef, libraryVault("user-a"));
      }
    }));
    await assertSucceeds(getDoc(vaultRef));
    await assertFails(getDocs(collection(ownerDb, "libraryVaults")));
    await assertFails(getDoc(doc(outsiderDb, "libraryVaults/user-a")));
    await assertFails(getDoc(doc(adminDb, "libraryVaults/user-a")));
    await assertFails(setDoc(doc(outsiderDb, "libraryVaults/user-a"), libraryVault("user-a")));
    await assertFails(setDoc(doc(inactiveDb, "libraryVaults/user-inactive"), libraryVault("user-inactive")));
    await assertFails(updateDoc(vaultRef, { updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(vaultRef));
  });

  it("keeps personal schedule tasks owner-only and blocks forged attribution", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(setDoc(doc(ownerDb, "scheduleTasks/task-a"), scheduleTask("user-a")));
    await assertSucceeds(getDoc(doc(ownerDb, "scheduleTasks/task-a")));
    await assertSucceeds(
      getDocs(query(collection(ownerDb, "scheduleTasks"), where("ownerUid", "==", "user-a")))
    );
    const legacyTask = scheduleTask("user-a") as Record<string, unknown>;
    delete legacyTask.startDate;
    delete legacyTask.endDate;
    delete legacyTask.startTimeMinutes;
    delete legacyTask.endTimeMinutes;
    await assertSucceeds(setDoc(doc(ownerDb, "scheduleTasks/task-legacy"), legacyTask));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-legacy"), {
        status: "completed",
        completedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(getDoc(doc(otherDb, "scheduleTasks/task-a")));
    await assertFails(setDoc(doc(otherDb, "scheduleTasks/forged-owner"), scheduleTask("user-a")));
    await assertFails(updateDoc(doc(ownerDb, "scheduleTasks/task-a"), { ownerUid: "user-b", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ownerDb, "scheduleTasks/task-a"), { updatedBy: "user-b", updatedAt: serverTimestamp() }));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        status: "completed",
        completedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        color: "#7f99c2",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        sortOrder: 3,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        progressPercent: 80,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        color: "javascript:alert(1)",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        sortOrder: -1,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        sortOrder: "first",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        progressPercent: -10,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        progressPercent: 110,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        progressPercent: "done",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-05-15",
        dueTimeMinutes: 540,
        startDate: "2026-05-15",
        endDate: "2026-05-20",
        startTimeMinutes: 540,
        endTimeMinutes: 600,
        isUrgent: true,
        calendarUpdatedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        calendarUpdatedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2028-02-29",
        startDate: "2028-02-29",
        endDate: "2028-02-29",
        calendarUpdatedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: null,
        dueTimeMinutes: null,
        startDate: null,
        endDate: null,
        startTimeMinutes: null,
        endTimeMinutes: null,
        calendarUpdatedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-99-99",
        startDate: "2026-99-99",
        endDate: "2026-99-99",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: deleteField(),
        calendarUpdatedAt: serverTimestamp(),
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-02-29",
        startDate: "2026-02-29",
        endDate: "2026-02-29",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "05/19/2026",
        startDate: "05/19/2026",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-12-31",
        startDate: "2026-12-31",
        endDate: "2027-01-01",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-05-20",
        startDate: "2026-05-20",
        endDate: "2026-05-15",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueTimeMinutes: 600,
        startTimeMinutes: 600,
        endTimeMinutes: 540,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(updateDoc(doc(ownerDb, "scheduleTasks/task-a"), { dueTimeMinutes: 1440, startTimeMinutes: 1440, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ownerDb, "scheduleTasks/task-a"), { status: "archived", updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(otherDb, "scheduleTasks/task-a")));
    await assertFails(deleteDoc(doc(ownerDb, "scheduleTasks/task-a")));
    await assertSucceeds(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-a"), {
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: "a".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
      progressPercent: 42,
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(deleteDoc(doc(ownerDb, "scheduleTasks/task-a")));
  });

  it("accepts only timestamp Google Calendar task revisions without weakening task ownership", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const legacyRef = doc(ownerDb, "scheduleTasks/task-calendar-legacy");
    const projectedRef = doc(ownerDb, "scheduleTasks/task-calendar-projected");

    await assertSucceeds(setDoc(legacyRef, scheduleTask("user-a")));
    await assertSucceeds(setDoc(
      projectedRef,
      scheduleTask("user-a", { calendarUpdatedAt: serverTimestamp() })
    ));
    await assertFails(setDoc(
      doc(ownerDb, "scheduleTasks/task-calendar-invalid"),
      scheduleTask("user-a", { calendarUpdatedAt: "not-a-timestamp" })
    ));
    await assertFails(updateDoc(legacyRef, {
      calendarUpdatedAt: serverTimestamp(),
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(legacyRef, {
      dueDate: "2026-05-20",
      startDate: "2026-05-20",
      endDate: "2026-05-20",
      calendarUpdatedAt: serverTimestamp(),
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(projectedRef, {
      calendarUpdatedAt: serverTimestamp(),
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(projectedRef, {
      dueDate: "2026-05-20",
      startDate: "2026-05-20",
      endDate: "2026-05-20",
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(projectedRef, {
      dueDate: "2026-05-20",
      startDate: "2026-05-20",
      endDate: "2026-05-20",
      calendarUpdatedAt: serverTimestamp(),
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(projectedRef, {
      progressPercent: 10,
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(projectedRef, {
      calendarUpdatedAt: "not-a-timestamp",
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(otherDb, "scheduleTasks/task-calendar-projected"), {
      calendarUpdatedAt: serverTimestamp(),
      updatedBy: "user-b",
      updatedAt: serverTimestamp()
    }));
  });

  it("fails closed when the Google connection changes after a deletion tombstone is created", async () => {
    const generationA = "a".repeat(43);
    const generationB = "b".repeat(43);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-disconnected"), scheduleTask("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-stale-null"), scheduleTask("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-connected"), scheduleTask("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-generation-changed"), scheduleTask("user-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const tombstone = (taskId: string, connectionGeneration: string | null) => ({
      ownerUid: "user-a",
      taskId,
      deletionAttemptId: taskId === "task-connected" ? "b".repeat(32) : "a".repeat(32),
      connectionGeneration,
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    });

    await assertSucceeds(setDoc(
      doc(ownerDb, "googleCalendarTaskTombstones/task-disconnected"),
      tombstone("task-disconnected", null)
    ));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "googleCalendarConnections/user-a"), {
        connectionGeneration: generationA,
        connectionStatus: "connected"
      });
    });

    // A connection created after a null-generation tombstone invalidates the
    // local delete, and a stale null tombstone cannot be created afterwards.
    await assertFails(deleteDoc(doc(ownerDb, "scheduleTasks/task-disconnected")));
    await assertFails(setDoc(
      doc(ownerDb, "googleCalendarTaskTombstones/task-stale-null"),
      tombstone("task-stale-null", null)
    ));

    await assertSucceeds(setDoc(
      doc(ownerDb, "googleCalendarTaskTombstones/task-connected"),
      tombstone("task-connected", generationA)
    ));
    await assertSucceeds(deleteDoc(doc(ownerDb, "scheduleTasks/task-connected")));

    await assertSucceeds(setDoc(
      doc(ownerDb, "googleCalendarTaskTombstones/task-generation-changed"),
      tombstone("task-generation-changed", generationA)
    ));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "googleCalendarConnections/user-a"), {
        connectionGeneration: generationB
      });
    });
    await assertFails(deleteDoc(doc(ownerDb, "scheduleTasks/task-generation-changed")));
  });

  it("allows only revision-bound Google Calendar sync receipts for the current connection", async () => {
    const generationA = "a".repeat(43);
    const generationB = "b".repeat(43);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "scheduleTasks/task-receipt"), scheduleTask("user-a"));
      await setDoc(doc(db, "googleCalendarConnections/user-a"), {
        connectionGeneration: generationA,
        connectionStatus: "connected"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const taskRef = doc(ownerDb, "scheduleTasks/task-receipt");
    const originalTask = await getDoc(taskRef);
    const originalCreatedAt = originalTask.data()?.createdAt;
    const receiptRef = doc(ownerDb, "googleCalendarTaskSyncReceipts/task-receipt");
    const receipt = (connectionGeneration: string, taskUpdatedAt: unknown, extra = {}) => ({
      ownerUid: "user-a",
      taskId: "task-receipt",
      connectionGeneration,
      taskUpdatedAt,
      syncedAt: serverTimestamp(),
      ...extra
    });

    await assertSucceeds(setDoc(receiptRef, receipt(generationA, originalCreatedAt)));
    await assertSucceeds(getDoc(receiptRef));
    await assertSucceeds(getDocs(query(
      collection(ownerDb, "googleCalendarTaskSyncReceipts"),
      where("ownerUid", "==", "user-a")
    )));
    await assertFails(getDocs(collection(ownerDb, "googleCalendarTaskSyncReceipts")));
    await assertFails(getDoc(doc(otherDb, "googleCalendarTaskSyncReceipts/task-receipt")));
    await assertSucceeds(updateDoc(taskRef, {
      progressPercent: 60,
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    const revisedTask = await getDoc(taskRef);
    const revisedUpdatedAt = revisedTask.data()?.updatedAt;

    await assertSucceeds(setDoc(receiptRef, receipt(generationA, originalCreatedAt)));
    await assertFails(setDoc(receiptRef, receipt(generationA, revisedUpdatedAt)));
    await assertFails(setDoc(receiptRef, receipt(generationB, originalCreatedAt)));
    await assertFails(setDoc(receiptRef, receipt(generationA, originalCreatedAt, { extra: true })));
    await assertFails(setDoc(doc(otherDb, "googleCalendarTaskSyncReceipts/task-receipt"), {
      ...receipt(generationA, originalCreatedAt),
      ownerUid: "user-b"
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskSyncReceipts/missing-task"), {
      ...receipt(generationA, originalCreatedAt),
      taskId: "missing-task"
    }));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "googleCalendarConnections/user-a"), {
        connectionGeneration: generationB
      });
    });
    await assertFails(setDoc(receiptRef, receipt(generationA, originalCreatedAt)));
    await assertSucceeds(setDoc(receiptRef, receipt(generationB, originalCreatedAt)));
    await assertSucceeds(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-receipt"), {
      ownerUid: "user-a",
      taskId: "task-receipt",
      deletionAttemptId: "c".repeat(32),
      connectionGeneration: generationB,
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertSucceeds(runTransaction(ownerDb, async (transaction) => {
      const currentReceipt = await transaction.get(receiptRef);

      expect(currentReceipt.exists()).toBe(true);
      transaction.delete(taskRef);
      transaction.delete(receiptRef);
    }));
  });

  it("uses the exact Google Calendar revision projection for sync receipts", async () => {
    const generation = "a".repeat(43);
    const createdRevision = new Date("2026-05-18T08:00:00.000Z");
    const updatedRevision = new Date("2026-05-18T09:00:00.000Z");
    const calendarRevision = new Date("2026-05-18T10:00:00.000Z");
    const updatedOnlyRevision = new Date("2026-05-18T11:00:00.000Z");

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const updatedOnlyTask = scheduleTask("user-a", {
        updatedAt: updatedOnlyRevision
      }) as Record<string, unknown>;

      delete updatedOnlyTask.createdAt;
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-calendar-projection"), scheduleTask("user-a", {
        createdAt: createdRevision,
        updatedAt: updatedRevision,
        calendarUpdatedAt: calendarRevision
      }));
      await setDoc(doc(db, "scheduleTasks/task-updated-fallback"), updatedOnlyTask);
      await setDoc(doc(db, "googleCalendarConnections/user-a"), {
        connectionGeneration: generation,
        connectionStatus: "connected"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const receipt = (taskId: string, taskUpdatedAt: Date) => ({
      ownerUid: "user-a",
      taskId,
      connectionGeneration: generation,
      taskUpdatedAt,
      syncedAt: serverTimestamp()
    });
    const projectedReceiptRef = doc(
      ownerDb,
      "googleCalendarTaskSyncReceipts/task-calendar-projection"
    );

    await assertFails(setDoc(projectedReceiptRef, {
      ...receipt("task-calendar-projection", calendarRevision),
      taskUpdatedAt: {
        seconds: Math.floor(calendarRevision.getTime() / 1000),
        nanoseconds: 0
      }
    }));
    await assertSucceeds(setDoc(
      projectedReceiptRef,
      receipt("task-calendar-projection", calendarRevision)
    ));
    await assertFails(setDoc(
      projectedReceiptRef,
      receipt("task-calendar-projection", createdRevision)
    ));
    await assertFails(setDoc(
      projectedReceiptRef,
      receipt("task-calendar-projection", updatedRevision)
    ));
    await assertFails(setDoc(
      projectedReceiptRef,
      receipt("task-calendar-projection", new Date("2026-05-18T12:00:00.000Z"))
    ));
    await assertSucceeds(setDoc(
      doc(ownerDb, "googleCalendarTaskSyncReceipts/task-updated-fallback"),
      receipt("task-updated-fallback", updatedOnlyRevision)
    ));
  });

  it("keeps Google Calendar deletion tombstones owner-only with bounded lease takeover", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true }));
      await setDoc(doc(db, "users/user-inactive"), userProfile("user-inactive", { isActive: false }));
      await setDoc(doc(db, "scheduleTasks/task-a"), scheduleTask("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-b"), scheduleTask("user-b"));
      await setDoc(doc(db, "scheduleTasks/task-inactive"), scheduleTask("user-inactive"));
      await setDoc(doc(db, "scheduleTasks/task-persist"), scheduleTask("user-a"));
      await setDoc(doc(db, "scheduleTasks/task-expired"), scheduleTask("user-a"));
      await setDoc(doc(db, "googleCalendarTaskTombstones/task-inactive"), {
        ownerUid: "user-inactive",
        taskId: "task-inactive",
        deletionAttemptId: "c".repeat(32),
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        leaseExpiresAt: new Date("2026-05-18T08:05:00.000Z")
      });
      await setDoc(doc(db, "googleCalendarTaskTombstones/task-expired"), {
        ownerUid: "user-a",
        taskId: "task-expired",
        deletionAttemptId: "d".repeat(32),
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        leaseExpiresAt: new Date("2026-05-18T08:05:00.000Z")
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const inactiveDb = testEnv.authenticatedContext("user-inactive").firestore();
    const publicDb = testEnv.unauthenticatedContext().firestore();
    const attemptId = "a".repeat(32);
    const tombstoneRef = doc(ownerDb, "googleCalendarTaskTombstones/task-a");

    await assertSucceeds(getDoc(tombstoneRef).then((snapshot) => {
      expect(snapshot.exists()).toBe(false);
    }));
    await assertFails(getDoc(doc(otherDb, "googleCalendarTaskTombstones/task-a")));
    await assertFails(getDoc(doc(ownerDb, "googleCalendarTaskTombstones/missing-task")));

    await assertSucceeds(runTransaction(ownerDb, async (transaction) => {
      const taskSnapshot = await transaction.get(doc(ownerDb, "scheduleTasks/task-a"));
      const tombstoneSnapshot = await transaction.get(tombstoneRef);

      expect(taskSnapshot.exists()).toBe(true);
      expect(tombstoneSnapshot.exists()).toBe(false);
      transaction.set(tombstoneRef, {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: attemptId,
        createdAt: serverTimestamp(),
        leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
      });
    }));

    await assertSucceeds(getDoc(tombstoneRef));
    await assertSucceeds(
      getDocs(query(collection(ownerDb, "googleCalendarTaskTombstones"), where("ownerUid", "==", "user-a")))
    );
    await assertFails(getDocs(collection(ownerDb, "googleCalendarTaskTombstones")));
    await assertFails(
      getDocs(query(collection(ownerDb, "googleCalendarTaskTombstones"), where("ownerUid", "==", "user-b")))
    );
    await assertSucceeds(updateDoc(doc(ownerDb, "scheduleTasks/task-expired"), {
      isUrgent: true,
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
    await assertFails(deleteDoc(doc(ownerDb, "scheduleTasks/task-expired")));
    await assertFails(setDoc(tombstoneRef, {
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: "f".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertSucceeds(runTransaction(ownerDb, async (transaction) => {
      const expiredRef = doc(ownerDb, "googleCalendarTaskTombstones/task-expired");

      await transaction.get(doc(ownerDb, "scheduleTasks/task-expired"));
      await transaction.get(expiredRef);
      transaction.set(expiredRef, {
        ownerUid: "user-a",
        taskId: "task-expired",
        deletionAttemptId: "e".repeat(32),
        createdAt: serverTimestamp(),
        leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
      });
    }));
    await assertFails(getDoc(doc(otherDb, "googleCalendarTaskTombstones/task-a")));
    await assertFails(getDoc(doc(adminDb, "googleCalendarTaskTombstones/task-a")));
    await assertFails(getDoc(doc(publicDb, "googleCalendarTaskTombstones/task-a")));
    await assertFails(getDoc(doc(inactiveDb, "googleCalendarTaskTombstones/task-inactive")));
    await assertFails(updateDoc(tombstoneRef, { deletionAttemptId: "b".repeat(32) }));
    await assertFails(deleteDoc(doc(otherDb, "googleCalendarTaskTombstones/task-a")));
    await assertFails(deleteDoc(doc(adminDb, "googleCalendarTaskTombstones/task-a")));
    await assertFails(deleteDoc(doc(inactiveDb, "googleCalendarTaskTombstones/task-inactive")));

    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/missing-task"), {
      ownerUid: "user-a",
      taskId: "missing-task",
      deletionAttemptId: attemptId,
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-b"), {
      ownerUid: "user-a",
      taskId: "task-b",
      deletionAttemptId: attemptId,
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/forged-task"), {
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-persist"), {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "A".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-persist"), {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "b".repeat(32),
      connectionGeneration: "short",
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-persist"), {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "b".repeat(32),
      createdAt: new Date("2026-05-18T08:00:00.000Z"),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-persist"), {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "b".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() - 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-persist"), {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "b".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 6 * 60 * 1000)
    }));
    await assertFails(setDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-persist"), {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "b".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000),
      extra: "blocked"
    }));
    await assertFails(setDoc(doc(inactiveDb, "googleCalendarTaskTombstones/task-inactive"), {
      ownerUid: "user-inactive",
      taskId: "task-inactive",
      deletionAttemptId: attemptId,
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));

    const persistentTombstoneRef = doc(ownerDb, "googleCalendarTaskTombstones/task-persist");
    await assertSucceeds(setDoc(persistentTombstoneRef, {
      ownerUid: "user-a",
      taskId: "task-persist",
      deletionAttemptId: "b".repeat(32),
      createdAt: serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + 4 * 60 * 1000)
    }));
    await assertSucceeds(deleteDoc(doc(ownerDb, "scheduleTasks/task-persist")));
    await assertSucceeds(getDoc(persistentTombstoneRef));
    await assertSucceeds(deleteDoc(persistentTombstoneRef));
    await assertSucceeds(deleteDoc(tombstoneRef));
    await assertSucceeds(deleteDoc(doc(ownerDb, "googleCalendarTaskTombstones/task-expired")));
  });

  it("allows only active habit owners to create the first check-in transactionally", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "users/user-inactive"), userProfile("user-inactive", { isActive: false }));
      await setDoc(doc(context.firestore(), "recurringHabits/habit-transaction"), recurringHabit("user-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const inactiveDb = testEnv.authenticatedContext("user-inactive").firestore();
    const firstCheckInRef = doc(ownerDb, "recurringHabitCheckIns/habit-transaction_2026-05-20");

    await assertSucceeds(runTransaction(ownerDb, async (transaction) => {
      const missingCheckIn = await transaction.get(firstCheckInRef);

      expect(missingCheckIn.exists()).toBe(false);
      transaction.set(firstCheckInRef, recurringHabitCheckIn("user-a", "habit-transaction", "2026-05-20"));
    }));
    await assertSucceeds(getDoc(firstCheckInRef));
    await assertFails(getDoc(doc(otherDb, "recurringHabitCheckIns/habit-transaction_2026-05-21")));
    await assertFails(getDoc(doc(ownerDb, "recurringHabitCheckIns/malformed-check-in")));
    await assertFails(getDoc(doc(inactiveDb, "recurringHabitCheckIns/habit-transaction_2026-05-21")));
  });

  it("keeps recurring habits and check-ins owner-only with strict values", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "recurringHabits/habit-b"), recurringHabit("user-b"));
      await setDoc(
        doc(context.firestore(), "recurringHabits/habit-archived"),
        recurringHabit("user-a", { status: "archived" })
      );
      await setDoc(
        doc(context.firestore(), "recurringHabitCheckIns/habit-archived_2026-05-21"),
        recurringHabitCheckIn("user-a", "habit-archived", "2026-05-21")
      );
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(setDoc(doc(ownerDb, "recurringHabits/habit-a"), recurringHabit("user-a")));
    await assertSucceeds(setDoc(doc(ownerDb, "recurringHabits/habit-recovery"), recurringHabit("user-a")));
    await assertSucceeds(setDoc(doc(ownerDb, "recurringHabits/AbCdEfGhIjKlMnOpQrSt"), recurringHabit("user-a")));
    await assertSucceeds(getDoc(doc(ownerDb, "recurringHabits/habit-a")));
    await assertSucceeds(getDocs(query(collection(ownerDb, "recurringHabits"), where("ownerUid", "==", "user-a"))));
    await assertFails(getDoc(doc(otherDb, "recurringHabits/habit-a")));
    await assertFails(setDoc(doc(otherDb, "recurringHabits/forged-owner"), recurringHabit("user-a")));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "recurringHabits/habit-recovery"), {
        status: "archived",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-recovery"), {
        status: "active",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-recovery"), {
        color: "#123456",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabits/plaintext-extra"),
        recurringHabit("user-a", { encryptedTitle: { ...encryptedPayload, plaintext: "not-allowed" } })
      )
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        slot: "afternoon",
        icon: "reading",
        color: "#7f99c2",
        sortOrder: 2,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        slot: "weekend",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        icon: "https://example.com/icon.png",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        color: "javascript:alert(1)",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        sortOrder: -1,
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        sortOrder: "first",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );

    await assertSucceeds(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21"),
        recurringHabitCheckIn("user-a", "habit-a", "2026-05-21")
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-23"),
        recurringHabitCheckIn("user-a", "habit-a", "2026-05-23", {
          completed: true,
          progressPercent: 50
        })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-24"),
        recurringHabitCheckIn("user-a", "habit-a", "2026-05-24", {
          checkedAt: null,
          completed: false,
          progressPercent: 100
        })
      )
    );
    const missingCompleted = recurringHabitCheckIn("user-a", "habit-a", "2026-05-25") as Record<string, unknown>;
    delete missingCompleted.completed;
    await assertFails(
      setDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-25"), missingCompleted)
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-archived_2026-05-22"),
        recurringHabitCheckIn("user-a", "habit-archived", "2026-05-22")
      )
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabitCheckIns/habit-archived_2026-05-21"), {
        checkedItemIds: [],
        completed: true,
        progressPercent: 100,
        checkedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/AbCdEfGhIjKlMnOpQrSt_2026-05-21"),
        recurringHabitCheckIn("user-a", "AbCdEfGhIjKlMnOpQrSt", "2026-05-21")
      )
    );
    await assertSucceeds(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-22"),
        recurringHabitCheckIn("user-a", "habit-a", "2026-05-22", {
          checkedAt: null,
          checkedItemIds: [],
          completed: false,
          progressPercent: 60
        })
      )
    );
    await assertSucceeds(getDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21")));
    await assertSucceeds(getDocs(query(collection(ownerDb, "recurringHabitCheckIns"), where("ownerUid", "==", "user-a"))));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21"), {
        checkedItemIds: ["first-item"],
        completed: false,
        progressPercent: 50,
        checkedAt: null,
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21"), {
        checkedItemIds: ["first-item", "second-item"],
        completed: true,
        progressPercent: 100,
        checkedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(getDoc(doc(otherDb, "recurringHabitCheckIns/habit-a_2026-05-21")));
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21"), {
        progressPercent: -1,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21"), {
        progressPercent: "done",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21"), {
        checkedItemIds: Array.from({ length: 101 }, (_, index) => `item-${index}`),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-99-99"),
        recurringHabitCheckIn("user-a", "habit-a", "2026-99-99")
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/habit-b_2026-05-21"),
        recurringHabitCheckIn("user-a", "habit-b", "2026-05-21")
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "recurringHabitCheckIns/wrong-id"),
        recurringHabitCheckIn("user-a", "habit-a", "2026-05-22")
      )
    );
    await assertFails(deleteDoc(doc(otherDb, "recurringHabitCheckIns/habit-a_2026-05-21")));
    await assertSucceeds(deleteDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-21")));
    await assertFails(deleteDoc(doc(otherDb, "recurringHabits/habit-a")));
    await assertFails(deleteDoc(doc(ownerDb, "recurringHabits/habit-a")));
    await assertSucceeds(deleteDoc(doc(ownerDb, "recurringHabitCheckIns/habit-a_2026-05-22")));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "recurringHabits/habit-a"), {
        status: "archived",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(deleteDoc(doc(ownerDb, "recurringHabits/habit-a")));
    const remainingOwnedHabits = await assertSucceeds(getDocs(query(
      collection(ownerDb, "recurringHabits"),
      where("ownerUid", "==", "user-a")
    )));
    expect(remainingOwnedHabits.docs.some((snapshot) => snapshot.id === "habit-a")).toBe(false);
  });

  it("allows participants to read notes and blocks outsiders", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a")));
    await assertSucceeds(
      getDocs(
        query(
          collection(participantDb, "notes"),
          where("ownerUid", "==", "user-a"),
          where("isDeleted", "==", false),
          where("participantUids", "array-contains", "user-b"),
          orderBy("updatedAt", "desc"),
          limit(80)
        )
      )
    );
    await assertSucceeds(
      getDocs(
        query(
          collection(ownerDb, "notes"),
          where("ownerUid", "==", "user-a"),
          orderBy("updatedAt", "desc"),
          limit(80)
        )
      )
    );
    await assertFails(getDoc(doc(testEnv.authenticatedContext("user-c").firestore(), "notes/note-a")));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), {
        featureAccess: featureAccess({ notes: false })
      });
    });
    await assertFails(getDoc(doc(ownerDb, "notes/note-a")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a")));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await updateDoc(doc(db, "users/user-a"), { featureAccess: featureAccess() });
      await updateDoc(doc(db, "users/user-b"), {
        featureAccess: featureAccess({ notes: false })
      });
    });
    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a")));
  });

  it("allows owners to publish temporary public note shares while blocking expired or revoked links", async () => {
    const shareExpiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const legacySourceAttachmentShare = publicShareDocument("note-a", "user-a", {
      ready: true,
      createdAt: new Date("2026-05-18T08:00:00.000Z"),
      updatedAt: new Date("2026-05-18T08:00:00.000Z"),
      expiresAt: shareExpiresAt
    });
    Reflect.deleteProperty(legacySourceAttachmentShare, "sourceAttachmentRevision");

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/expired-share"), {
        ...publicShareDocument("note-a", "user-a", {
          ready: true,
          attachmentCount: 0,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: new Date("2026-05-18T09:00:00.000Z")
        })
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/revoked-share"), {
        ...publicShareDocument("note-a", "user-a", {
          ready: true,
          attachmentCount: 0,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
          revokedAt: new Date("2026-05-18T08:30:00.000Z"),
          revokedBy: "user-a"
        })
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/missing-source-share"), {
        ...publicShareDocument("missing-note", "user-a", {
          ready: true,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: shareExpiresAt
        })
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/owner-mismatch-share"), {
        ...publicShareDocument("note-a", "user-b", {
          ready: true,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: shareExpiresAt
        })
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/legacy-protected-share"), {
        ...publicShareDocument("note-a", "user-a", {
          attachmentCount: 1,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: shareExpiresAt,
          passwordHash: legacyPublicSharePasswordHash,
          ready: true,
          updatedAt: new Date("2026-05-18T08:00:00.000Z")
        })
      });
      await setDoc(
        doc(context.firestore(), "publicNoteShares/legacy-protected-share/attachments/attachment-a"),
        publicShareAttachment({ createdAt: new Date("2026-05-18T08:00:00.000Z"), expiresAt: shareExpiresAt })
      );
      await setDoc(doc(context.firestore(), "publicNoteShares/legacy-source-attachment-share"), legacySourceAttachmentShare);
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const publicDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(
      createPublicShareBatch(
        ownerDb,
        "share-a",
        publicShareDocument("note-a", "user-a", { expiresAt: shareExpiresAt, passwordHash: publicSharePasswordHash })
      )
    );
    await assertFails(
      createPublicShareAttachmentBatch(ownerDb, "share-a", "attachment-a", publicShareAttachment({ expiresAt: shareExpiresAt }))
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "publicNoteShares/share-a/attachments/attachment-a"),
        publicShareAttachment({ createdAt: new Date("2026-05-18T08:00:00.000Z"), expiresAt: shareExpiresAt })
      );
      await setDoc(
        doc(context.firestore(), "publicNoteShares/share-a/attachments/legacy-plaintext-name"),
        legacyPublicShareAttachment({ createdAt: new Date("2026-05-18T08:00:00.000Z"), expiresAt: shareExpiresAt })
      );
    });
    await assertSucceeds(updateDoc(doc(ownerDb, "publicNoteShares/share-a"), { ready: true, attachmentCount: 1, updatedAt: serverTimestamp() }));
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "png-ok",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "png", fileName: "safe-image", mimeType: "image/png" })
      )
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "zip-storage",
        storedPublicShareAttachment("share-a", "zip-storage", { expiresAt: shareExpiresAt })
      )
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "publicNoteShares/share-a/attachments/zip-storage"),
        storedPublicShareAttachment("share-a", "zip-storage", {
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: shareExpiresAt
        })
      );
    });
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a/attachments/zip-storage"), {
        isReady: true
      })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "publicNoteShares/share-a/attachments/zip-storage"), { isReady: true });
      await deleteDoc(doc(context.firestore(), "publicNoteShares/share-a/attachments/zip-storage"));
    });
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "generation-b-attachment",
        publicShareAttachment({ expiresAt: shareExpiresAt, generation: "generation-b" })
      )
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "publicNoteShares/share-a/attachments/generation-b-attachment"),
        publicShareAttachment({
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: shareExpiresAt,
          generation: "generation-b"
        })
      );
    });
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a/attachments/generation-b-attachment")));
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "zip-wrong-path",
        storedPublicShareAttachment("share-a", "zip-wrong-path", {
          expiresAt: shareExpiresAt,
          storagePath: "publicNoteShares/share-a/attachments/other/data"
        })
      )
    );

    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a/attachments/legacy-plaintext-name")));
    await assertSucceeds(getDoc(doc(ownerDb, "publicNoteShares/share-a/attachments/legacy-plaintext-name")));
    await assertSucceeds(
      getDocs(
        query(
          collection(publicDb, "publicNoteShares/share-a/attachments"),
          where("generation", "==", "generation-a"),
          where("privacyVersion", "==", 1)
        )
      )
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { isDeleted: true });
    });
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a/attachments/attachment-a")));
    await assertSucceeds(getDoc(doc(ownerDb, "publicNoteShares/share-a")));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { isDeleted: false });
      await updateDoc(doc(context.firestore(), "users/user-a"), { isActive: false });
    });
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), { isActive: true });
    });
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), {
        featureAccess: featureAccess({ notes: false })
      });
    });
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertFails(getDoc(doc(ownerDb, "publicNoteShares/share-a")));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), {
        featureAccess: featureAccess()
      });
    });
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertSucceeds(
      getDocs(query(collection(ownerDb, "publicNoteShares"), where("ownerUid", "==", "user-a"), where("sourceNoteId", "==", "note-a")))
    );
    await assertFails(
      setDoc(doc(ownerDb, "publicNoteShares/unqueued-share"), publicShareDocument("note-a", "user-a", { expiresAt: shareExpiresAt }))
    );
    await assertFails(
      setDoc(doc(ownerDb, "publicNoteShares/share-a/attachments/unqueued-attachment"), publicShareAttachment({ expiresAt: shareExpiresAt }))
    );

    await assertFails(getDoc(doc(publicDb, "publicNoteShares/expired-share")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/revoked-share")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/missing-source-share")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/owner-mismatch-share")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/legacy-protected-share")));
    await assertFails(getDocs(collection(publicDb, "publicNoteShares/legacy-protected-share/attachments")));
    await assertSucceeds(getDoc(doc(ownerDb, "publicNoteShares/legacy-protected-share")));
    await assertFails(
      createPublicShareBatch(
        ownerDb,
        "legacy-created-share",
        publicShareDocument("note-a", "user-a", { passwordHash: legacyPublicSharePasswordHash })
      )
    );
    await assertFails(createPublicShareBatch(otherDb, "forged-share", publicShareDocument("note-a", "user-b")));
    const shareWithoutOwnerKey = { ...publicShareDocument("note-a", "user-a") };
    Reflect.deleteProperty(shareWithoutOwnerKey, "ownerWrappedShareKey");
    await assertFails(createPublicShareBatch(ownerDb, "missing-owner-key-share", shareWithoutOwnerKey));
    const shareWithoutSourceAttachmentRevision = { ...publicShareDocument("note-a", "user-a") };
    Reflect.deleteProperty(shareWithoutSourceAttachmentRevision, "sourceAttachmentRevision");
    await assertFails(
      createPublicShareBatch(ownerDb, "missing-source-attachment-revision", shareWithoutSourceAttachmentRevision)
    );
    await assertFails(
      createPublicShareBatch(
        ownerDb,
        "invalid-source-attachment-revision",
        publicShareDocument("note-a", "user-a", { sourceAttachmentRevision: -1 })
      )
    );
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/legacy-source-attachment-share"), {
        encryptedBody: { ...encryptedPayload, cipherText: "legacy-without-attachment-revision" },
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "publicNoteShares/legacy-source-attachment-share"), {
        encryptedBody: { ...encryptedPayload, cipherText: "legacy-migrated" },
        sourceAttachmentRevision: 0,
        currentGeneration: "generation-b",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "png-svg",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "png", fileName: "unsafe-image", mimeType: "image/svg+xml" })
      )
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "png-html",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "png", fileName: "unsafe-html", mimeType: "text/html" })
      )
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "png-jpeg",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "png", fileName: "mismatched-image", mimeType: "image/jpeg" })
      )
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "pdf-html",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "pdf", fileName: "unsafe-pdf", mimeType: "text/html" })
      )
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "pdf-svg",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "pdf", fileName: "unsafe-pdf", mimeType: "image/svg+xml" })
      )
    );

    await assertFails(updateDoc(doc(otherDb, "publicNoteShares/share-a"), { passwordHash: publicSharePasswordHash, updatedAt: serverTimestamp() }));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a"), {
        encryptedBody: { ...encryptedPayload, cipherText: "text-only-sync" },
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a"), {
        attachmentCount: 2,
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a"), {
        encryptedTitle: { ...encryptedPayload, cipherText: "new-title" },
        encryptedBody: { ...encryptedPayload, cipherText: "new-body" },
        currentGeneration: "generation-b",
        passwordHash: { ...publicSharePasswordHash, hash: "bmV3LWhhc2gtYnl0ZXMtZm9yLXRlc3Q=" },
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-a/attachments/generation-b-attachment")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a/attachments/attachment-a")));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a"), {
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        currentGeneration: "generation-c",
        passwordHash: deleteField(),
        updatedAt: serverTimestamp()
      })
    );

    await assertSucceeds(updateDoc(doc(ownerDb, "publicNoteShares/share-a"), { revokedAt: serverTimestamp(), revokedBy: "user-a", updatedAt: serverTimestamp() }));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertFails(getDocs(collection(publicDb, "publicNoteShares/share-a/attachments")));
  });

  it("fails public reads closed on source revision drift and permits only backend staging before an owner flip", async () => {
    const expiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "notes/note-a"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        revision: 5,
        lastMutationId: "mutation-initial-0001",
        attachmentRevision: 2,
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(
        doc(db, "publicNoteShares/share-revision-bound"),
        publicShareDocument("note-a", "user-a", {
          sourceRevision: 5,
          sourceAttachmentRevision: 2,
          ready: true,
          attachmentCount: 1,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt
        })
      );
      await setDoc(
        doc(db, "publicNoteShares/share-revision-bound/attachments/generation-a"),
        publicShareAttachment({
          generation: "generation-a",
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt
        })
      );
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const publicDb = testEnv.unauthenticatedContext().firestore();
    const shareRef = doc(ownerDb, "publicNoteShares/share-revision-bound");

    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
    await assertSucceeds(
      getDoc(doc(publicDb, "publicNoteShares/share-revision-bound/attachments/generation-a"))
    );

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { attachmentRevision: 3 });
    });
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
    await assertFails(
      updateDoc(shareRef, {
        encryptedBody: { ...encryptedPayload, cipherText: "unsafe-revision-only-flip" },
        sourceAttachmentRevision: 3,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-revision-bound",
        "generation-b",
        publicShareAttachment({ generation: "generation-b", expiresAt })
      )
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "publicNoteShares/share-revision-bound/attachments/generation-b"),
        publicShareAttachment({
          generation: "generation-b",
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt
        })
      );
    });
    await assertSucceeds(
      updateDoc(shareRef, {
        encryptedBody: { ...encryptedPayload, cipherText: "attachment-revision-3" },
        sourceAttachmentRevision: 3,
        currentGeneration: "generation-b",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
    await assertSucceeds(
      getDoc(doc(publicDb, "publicNoteShares/share-revision-bound/attachments/generation-b"))
    );
    await assertFails(
      getDoc(doc(publicDb, "publicNoteShares/share-revision-bound/attachments/generation-a"))
    );

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { revision: 6 });
    });
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
    await assertSucceeds(
      updateDoc(shareRef, {
        encryptedBody: { ...encryptedPayload, cipherText: "content-revision-6" },
        sourceRevision: 6,
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));

    await assertFails(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-revision-bound",
        "pending-ready",
        storedPublicShareAttachment("share-revision-bound", "pending-ready", {
          generation: "generation-b",
          expiresAt
        })
      )
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "publicNoteShares/share-revision-bound/attachments/pending-ready"),
        storedPublicShareAttachment("share-revision-bound", "pending-ready", {
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          generation: "generation-b",
          expiresAt
        })
      );
    });
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/share-revision-bound/attachments/pending-ready"), { isReady: true })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { isDeleted: true });
    });
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/share-revision-bound/attachments/pending-ready"), { isReady: true })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { isDeleted: false });
    });
    await assertSucceeds(
      updateDoc(shareRef, { revokedAt: serverTimestamp(), revokedBy: "user-a", updatedAt: serverTimestamp() })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/share-revision-bound/attachments/pending-ready"), { isReady: true })
    );
  });

  it("keeps cleanup queues immutable to users while enforcing queue creation for server cleanup", async () => {
    const expiredAt = new Date(Date.now() - 60 * 60 * 1000);
    const futureExpiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "publicNoteShares/expired-queued"), {
        ...publicShareDocument("note-a", "user-a", {
          attachmentCount: 1,
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: expiredAt,
          ready: true,
          updatedAt: new Date("2026-05-18T08:00:00.000Z")
        })
      });
      await setDoc(
        doc(context.firestore(), "publicNoteShares/expired-queued/attachments/attachment-a"),
        publicShareAttachment({ createdAt: new Date("2026-05-18T08:00:00.000Z"), expiresAt: expiredAt })
      );
      await setDoc(doc(context.firestore(), "publicShareCleanupQueue/expired-queued"), {
        shareId: "expired-queued",
        expiresAt: expiredAt,
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
      await setDoc(doc(context.firestore(), "publicShareCleanupQueue/expired-queued/publicShareAttachmentCleanupQueue/attachment-a"), {
        shareId: "expired-queued",
        attachmentId: "attachment-a",
        expiresAt: expiredAt,
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/expired-without-queue"), {
        ...publicShareDocument("note-a", "user-a", {
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: expiredAt,
          ready: true,
          updatedAt: new Date("2026-05-18T08:00:00.000Z")
        })
      });
      await setDoc(doc(context.firestore(), "publicNoteShares/active-queued"), {
        ...publicShareDocument("note-a", "user-a", {
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          expiresAt: futureExpiresAt,
          ready: true,
          updatedAt: new Date("2026-05-18T08:00:00.000Z")
        })
      });
      await setDoc(doc(context.firestore(), "publicShareCleanupQueue/active-queued"), {
        shareId: "active-queued",
        expiresAt: futureExpiresAt,
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const publicDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(ownerDb, "publicShareCleanupQueue/expired-queued")));
    await assertSucceeds(getDocs(collection(ownerDb, "publicShareCleanupQueue/expired-queued/publicShareAttachmentCleanupQueue")));
    await assertFails(getDoc(doc(publicDb, "publicShareCleanupQueue/expired-queued")));
    await assertFails(getDocs(collection(publicDb, "publicShareCleanupQueue/expired-queued/publicShareAttachmentCleanupQueue")));
    await assertFails(getDoc(doc(publicDb, "publicShareCleanupQueue/active-queued")));
    await assertFails(deleteDoc(doc(publicDb, "publicNoteShares/active-queued")));
    await assertFails(deleteDoc(doc(publicDb, "publicNoteShares/expired-without-queue")));
    await assertFails(deleteDoc(doc(publicDb, "publicShareCleanupQueue/expired-queued")));
    await assertFails(deleteDoc(doc(ownerDb, "publicShareCleanupQueue/expired-queued")));
    await assertFails(
      deleteDoc(doc(ownerDb, "publicShareCleanupQueue/expired-queued/publicShareAttachmentCleanupQueue/attachment-a"))
    );

    const unsafeOwnerDeleteBatch = writeBatch(ownerDb);
    unsafeOwnerDeleteBatch.delete(doc(ownerDb, "publicNoteShares/expired-queued/attachments/attachment-a"));
    unsafeOwnerDeleteBatch.delete(doc(ownerDb, "publicShareCleanupQueue/expired-queued/publicShareAttachmentCleanupQueue/attachment-a"));
    unsafeOwnerDeleteBatch.delete(doc(ownerDb, "publicNoteShares/expired-queued"));
    unsafeOwnerDeleteBatch.delete(doc(ownerDb, "publicShareCleanupQueue/expired-queued"));
    await assertFails(unsafeOwnerDeleteBatch.commit());

    const ownerDeleteBatch = writeBatch(ownerDb);
    ownerDeleteBatch.delete(doc(ownerDb, "publicNoteShares/expired-queued/attachments/attachment-a"));
    ownerDeleteBatch.delete(doc(ownerDb, "publicNoteShares/expired-queued"));
    await assertFails(ownerDeleteBatch.commit());

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await deleteDoc(doc(context.firestore(), "publicNoteShares/expired-queued/attachments/attachment-a"));
    });
    await assertSucceeds(deleteDoc(doc(ownerDb, "publicNoteShares/expired-queued")));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      expect((await getDoc(doc(context.firestore(), "publicShareCleanupQueue/expired-queued"))).exists()).toBe(true);
      expect(
        (
          await getDoc(
            doc(context.firestore(), "publicShareCleanupQueue/expired-queued/publicShareAttachmentCleanupQueue/attachment-a")
          )
        ).exists()
      ).toBe(true);
    });
  });

  it("treats legacy active notes without deletion metadata as readable and normalizable", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
      await setDoc(doc(context.firestore(), "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(context.firestore(), "notes/legacy-note"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a"
      });
      await setDoc(
        doc(context.firestore(), "notes/legacy-note/history/history-a"),
        noteHistory("legacy-note", "user-a", { readerUids: ["user-a", "user-b"], createdAt: new Date("2026-05-18T08:01:00.000Z") })
      );
      await setDoc(doc(context.firestore(), "notes/legacy-note/attachments/attachment-a"), attachmentDocument("legacy-note"));
      await setDoc(doc(context.firestore(), "notes/admin-legacy-note"), {
        type: "personal",
        ownerUid: "user-c",
        participantUids: ["user-c"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-c": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "c" }
        },
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-c"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-c").firestore();
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();

    await assertSucceeds(getDoc(doc(participantDb, "notes/legacy-note")));
    await assertSucceeds(getDoc(doc(participantDb, "notes/legacy-note/history/history-a")));
    await assertSucceeds(getDoc(doc(participantDb, "notes/legacy-note/attachments/attachment-a")));
    await assertFails(getDoc(doc(outsiderDb, "notes/legacy-note")));
    await assertSucceeds(getDocs(query(collection(ownerDb, "notes"), where("ownerUid", "==", "user-a"))));
    await assertSucceeds(updateDoc(doc(participantDb, "notes/legacy-note"), { isDeleted: false }));
    await assertSucceeds(updateDoc(doc(adminDb, "notes/admin-legacy-note"), { isDeleted: false }));
    await assertFails(updateDoc(doc(participantDb, "notes/legacy-note"), { isDeleted: deleteField() }));
  });

  it("blocks revoked participants from reading existing shared notes", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/revoked-share"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    await assertSucceeds(getDoc(doc(testEnv.authenticatedContext("user-a").firestore(), "notes/revoked-share")));
    const revokedParticipantDb = testEnv.authenticatedContext("user-b").firestore();

	    await assertFails(getDoc(doc(revokedParticipantDb, "notes/revoked-share")));
	    await assertFails(
	      setDoc(
	        doc(revokedParticipantDb, "notes/revoked-share/attachments/revoked-upload"),
	        attachmentDocument("revoked-share", { uploadedBy: "user-b" })
	      )
	    );
	    await assertFails(
	      getDocs(
        query(
          collection(revokedParticipantDb, "notes"),
          where("ownerUid", "==", "user-a"),
          where("isDeleted", "==", false),
          where("participantUids", "array-contains", "user-b"),
          orderBy("updatedAt", "desc")
        )
      )
    );
  });

  it("allows note owners to update sharing and blocks non-owners", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    await assertSucceeds(
      createAuditedNote(ownerDb, "note-a", "user-a", {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false
      }, ["user-a", "user-b"])
    );

    await expect(getDoc(doc(ownerDb, "notes/note-a"))).resolves.toBeTruthy();
    await assertSucceeds(
      updateAuditedNote(ownerDb, "note-a", "user-a", 2, "share", ["participants"], ["user-a"], {
        type: "personal",
        participantUids: ["user-a"],
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        folderId: null,
        isDeleted: false
      })
    );

    await assertSucceeds(
      updateAuditedNote(ownerDb, "note-a", "user-a", 3, "share", ["participants"], ["user-a", "user-b"], {
        type: "shared",
        participantUids: ["user-a", "user-b"],
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        folderId: null,
        isDeleted: false
      })
    );

    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    await assertFails(
      setDoc(doc(participantDb, "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-b"
      })
    );
  });

  it("allows owners to manage personal note folders and blocks cross-user assignments", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/personal-note"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/shared-note"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(
      setDoc(doc(ownerDb, "noteFolders/folder-a"), {
        ownerUid: "user-a",
        name: "업무",
        color: "#2f7d70",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(getDoc(doc(otherDb, "noteFolders/folder-a")));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "notes/personal-note"), {
        folderId: "folder-a",
        updatedAt: serverTimestamp(),
        updatedBy: "user-a"
      })
    );
    await assertFails(
      updateDoc(doc(otherDb, "notes/personal-note"), {
        folderId: "folder-a",
        updatedAt: serverTimestamp(),
        updatedBy: "user-b"
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "notes/shared-note"), {
        folderId: "folder-a",
        updatedAt: serverTimestamp(),
        updatedBy: "user-a"
      })
    );
  });

  it("rejects malformed note timestamp fields", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "notes/valid-note"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T09:00:00.000Z"),
        savedAt: new Date("2026-05-18T09:00:00.000Z"),
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const baseNote = {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      isDeleted: false,
      updatedBy: "user-a"
    };

    for (const field of ["createdAt", "updatedAt", "savedAt"] as const) {
      await assertFails(
        setDoc(doc(ownerDb, `notes/malformed-${field}`), {
          ...baseNote,
          [field]: "not-a-timestamp"
        })
      );
    }

    await assertSucceeds(
      createAuditedNote(ownerDb, "valid-attachment-revision", "user-a", { ...baseNote, attachmentRevision: 0 }, ["user-a"])
    );
    await assertFails(
      createAuditedNote(ownerDb, "negative-attachment-revision", "user-a", { ...baseNote, attachmentRevision: -1 }, ["user-a"])
    );
    await assertFails(
      createAuditedNote(ownerDb, "fractional-attachment-revision", "user-a", { ...baseNote, attachmentRevision: 1.5 }, ["user-a"])
    );

    await assertFails(
      updateDoc(doc(ownerDb, "notes/valid-note"), {
        updatedAt: "not-a-timestamp"
      })
    );
  });

  it("blocks content updates until revoked participants are removed", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/revoked-share"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();

    await assertFails(
      updateDoc(doc(ownerDb, "notes/revoked-share"), {
        encryptedBody: { ...encryptedPayload, cipherText: "changed" },
        updatedBy: "user-a"
      })
    );

    await assertSucceeds(
      updateAuditedNote(ownerDb, "revoked-share", "user-a", 1, "share", ["participants"], ["user-a"], {
        type: "personal",
        participantUids: ["user-a"],
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        folderId: null,
        isDeleted: false
      })
    );
  });

  it("allows users to share only with admin-approved targets", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();

    await assertSucceeds(
      createAuditedNote(ownerDb, "approved-share", "user-a", {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false
      }, ["user-a", "user-b"])
    );

    await assertFails(
      setDoc(doc(ownerDb, "notes/blocked-share"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-c"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-c": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "c" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      })
    );
  });

  it("allows admin note owners to share with any user", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "users/admin-a"),
        userProfile("admin-a", { isAdmin: true, role: "admin", allowedShareTargetUids: ["admin-a"] })
      );
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();

    await assertSucceeds(
      createAuditedNote(adminDb, "admin-open-share", "admin-a", {
        type: "shared",
        ownerUid: "admin-a",
        participantUids: ["admin-a", "user-c"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "admin-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "admin" },
          "user-c": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "c" }
        },
        isDeleted: false
      }, ["admin-a", "user-c"])
    );
  });

  it("blocks inactive admin note owners from broad sharing", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "users/admin-a"),
        userProfile("admin-a", { isActive: false, isAdmin: true, role: "admin", allowedShareTargetUids: ["admin-a"] })
      );
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
    });

    const inactiveAdminDb = testEnv.authenticatedContext("admin-a").firestore();

    await assertFails(
      setDoc(doc(inactiveAdminDb, "notes/inactive-admin-share"), {
        type: "shared",
        ownerUid: "admin-a",
        participantUids: ["admin-a", "user-c"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "admin-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "admin" },
          "user-c": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "c" }
        },
        isDeleted: false,
        updatedBy: "admin-a"
      })
    );
  });

  it("blocks note deadline updates", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(
      updateDoc(doc(participantDb, "notes/note-a"), {
        dueAt: new Date("2026-05-20T10:00:00.000Z"),
        updatedBy: "user-b"
      })
    );
    await assertFails(
      updateDoc(doc(participantDb, "notes/note-a"), {
        dueAt: null,
        updatedBy: "user-b"
      })
    );
  });

  it("allows admins to inspect and soft-delete all notes while blocking non-admin outsiders", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
      await setDoc(doc(context.firestore(), "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(context.firestore(), "notes/note-personal"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T09:00:00.000Z"),
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-c").firestore();

    await assertSucceeds(getDoc(doc(adminDb, "notes/note-personal")));
    await assertSucceeds(
      getDocs(
        query(
          collection(adminDb, "notes"),
          where("isDeleted", "==", false),
          orderBy("updatedAt", "desc"),
          limit(80)
        )
      )
    );
    await assertFails(getDoc(doc(outsiderDb, "notes/note-personal")));
    await assertFails(deleteDoc(doc(adminDb, "notes/note-personal")));
    await assertSucceeds(
      updateAuditedNote(adminDb, "note-personal", "admin-a", 1, "delete", ["deleted"], ["user-a"], {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "admin-a"
      })
    );
  });

  it("allows admins to soft-delete shared notes and blocks other non-owner participants", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(context.firestore(), "users/admin-b"), userProfile("admin-b", { isAdmin: true, role: "admin" }));
      await setDoc(doc(context.firestore(), "notes/note-admin-shared"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b", "admin-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" },
          "admin-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "admin-a" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-user-shared"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    await assertFails(updateDoc(doc(testEnv.authenticatedContext("user-b").firestore(), "notes/note-user-shared"), softDeleteFields("user-b")));
    await assertFails(deleteDoc(doc(testEnv.authenticatedContext("admin-b").firestore(), "notes/note-user-shared")));
    await assertSucceeds(
      updateAuditedNote(
        testEnv.authenticatedContext("admin-b").firestore(),
        "note-user-shared",
        "admin-b",
        1,
        "delete",
        ["deleted"],
        ["user-a", "user-b"],
        { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: "admin-b" }
      )
    );
    await assertSucceeds(
      updateAuditedNote(
        testEnv.authenticatedContext("admin-a").firestore(),
        "note-admin-shared",
        "admin-a",
        1,
        "delete",
        ["deleted"],
        ["user-a", "user-b", "admin-a"],
        { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: "admin-a" }
      )
    );
  });

  it("allows participants to read backend-created encrypted attachments while blocking direct client creation", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-a/attachments/backend-created"), attachmentDocument("note-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(setDoc(doc(ownerDb, "notes/note-a/attachments/client-created"), attachmentDocument("note-a")));
    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a/attachments/backend-created")));
  });

  it("keeps backend-created Storage attachment metadata readable while denying client reservations and ready writes", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(
        doc(context.firestore(), "notes/note-a/attachments/storage-zip"),
        storedAttachmentDocument("note-a", "storage-zip")
      );
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();

    await assertFails(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/client-reservation"),
        storedAttachmentDocument("note-a", "client-reservation")
      )
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), { isActive: false });
    });
    await assertFails(
      updateDoc(doc(ownerDb, "notes/note-a/attachments/storage-zip"), {
        isReady: true
      })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), { isActive: true });
    });
    await assertFails(
      updateDoc(doc(ownerDb, "notes/note-a/attachments/storage-zip"), {
        isReady: true
      })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a/attachments/storage-zip"), { isReady: true });
    });
    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a/attachments/storage-zip")));
    await assertFails(
      updateDoc(doc(ownerDb, "notes/note-a/attachments/storage-zip"), {
        storagePath: "notes/note-a/attachments/other/data"
      })
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/wrong-path"),
        storedAttachmentDocument("note-a", "wrong-path", {
          storagePath: "notes/note-a/attachments/other/data"
        })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/too-large"),
        storedAttachmentDocument("note-a", "too-large", {
          originalSize: 50 * 1024 * 1024 + 1,
          encryptedSize: 50 * 1024 * 1024 + 17
        })
      )
    );
  });

  it("blocks every client attachment ready/delete mutation, including after revocation or source deletion", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      for (const attachmentId of ["allowed-ready", "revoked-ready", "deleted-ready"]) {
        await setDoc(
          doc(db, `notes/note-a/attachments/${attachmentId}`),
          storedAttachmentDocument("note-a", attachmentId, { uploadedBy: "user-b" })
        );
      }
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(
      updateDoc(doc(participantDb, "notes/note-a/attachments/allowed-ready"), { isReady: true })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a/attachments/allowed-ready"), { isReady: true });
    });
    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a/attachments/allowed-ready")));
    await assertFails(deleteDoc(doc(participantDb, "notes/note-a/attachments/revoked-ready")));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), { allowedShareTargetUids: ["user-a"] });
    });
    await assertFails(
      updateDoc(doc(participantDb, "notes/note-a/attachments/revoked-ready"), { isReady: true })
    );

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "users/user-a"), { allowedShareTargetUids: ["user-a", "user-b"] });
      await updateDoc(doc(context.firestore(), "notes/note-a"), { isDeleted: true });
    });
    await assertFails(
      updateDoc(doc(participantDb, "notes/note-a/attachments/deleted-ready"), { isReady: true })
    );
    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a/attachments/deleted-ready")));
  });

  it("blocks direct note and attachment deletes so cleanup must use the trusted API", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-a/attachments/attachment-a"), attachmentDocument("note-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a")));
    await assertSucceeds(
      updateAuditedNote(ownerDb, "note-a", "user-a", 1, "delete", ["deleted"], ["user-a", "user-b"], {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a"
      })
    );
    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a")));
    await assertSucceeds(
      getDocs(
        query(
          collection(ownerDb, "notes"),
          where("ownerUid", "==", "user-a"),
          where("isDeleted", "==", true),
          where("participantUids", "array-contains", "user-a"),
          orderBy("updatedAt", "desc")
        )
      )
    );
    await assertFails(
      getDocs(
        query(
          collection(participantDb, "notes"),
          where("ownerUid", "==", "user-a"),
          where("participantUids", "array-contains", "user-b"),
          orderBy("updatedAt", "desc")
        )
      )
    );
    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a/attachments/attachment-a")));
    await assertFails(setDoc(doc(ownerDb, "notes/note-a/attachments/attachment-b"), attachmentDocument("note-a")));
    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
  });

  it("allows owners to restore soft-deleted notes and blocks non-owners", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        ...softDeleteFields("user-a")
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(updateDoc(doc(participantDb, "notes/note-a"), restoreFields("user-b")));
    await assertSucceeds(
      updateAuditedNote(ownerDb, "note-a", "user-a", 1, "restore", ["restored"], ["user-a", "user-b"], {
        isDeleted: false,
        deletedAt: deleteField(),
        deletedBy: deleteField()
      })
    );
  });

  it("allows history cleanup only after the soft-deleted note is irreversibly purged", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        ...softDeleteFields("user-a")
      });
      await setDoc(doc(context.firestore(), "notes/note-a/attachments/attachment-a"), attachmentDocument("note-a"));
      await setDoc(doc(context.firestore(), "notes/note-a/history/history-a"), noteHistory("note-a", "user-a", { action: "delete", changedFields: ["deleted"] }));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a")));
    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a/history/history-a")));
    await assertSucceeds(
      updateAuditedNote(ownerDb, "note-a", "user-a", 1, "restore", ["restored"], ["user-a", "user-b"], {
        isDeleted: false,
        deletedAt: deleteField(),
        deletedBy: deleteField()
      })
    );
    await assertSucceeds(
      updateAuditedNote(ownerDb, "note-a", "user-a", 2, "delete", ["deleted"], ["user-a", "user-b"], {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a"
      })
    );
    const purgeUpdates = {
      type: "personal",
      participantUids: ["user-a"],
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      isPurged: true,
      purgedAt: serverTimestamp(),
      purgedBy: "user-a",
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "user-a"
    };

    await assertFails(updateDoc(doc(ownerDb, "notes/note-a"), purgeUpdates));
    await assertFails(
      setDoc(doc(participantDb, "notePurgeCleanupQueue/note-a"), {
        noteId: "note-a",
        ownerUid: "user-a",
        createdAt: serverTimestamp()
      })
    );

    const wrongQueueBatch = writeBatch(ownerDb);
    wrongQueueBatch.update(doc(ownerDb, "notes/note-a"), purgeUpdates);
    wrongQueueBatch.set(doc(ownerDb, "notePurgeCleanupQueue/note-a"), {
      noteId: "note-a",
      ownerUid: "user-b",
      createdAt: serverTimestamp()
    });
    await assertFails(wrongQueueBatch.commit());

    const purgeBatch = writeBatch(ownerDb);
    purgeBatch.update(doc(ownerDb, "notes/note-a"), purgeUpdates);
    purgeBatch.set(doc(ownerDb, "notePurgeCleanupQueue/note-a"), {
      noteId: "note-a",
      ownerUid: "user-a",
      createdAt: serverTimestamp()
    });
    await assertSucceeds(purgeBatch.commit());
    await assertFails(getDoc(doc(ownerDb, "notePurgeCleanupQueue/note-a")));
    await assertFails(getDoc(doc(participantDb, "notePurgeCleanupQueue/note-a")));
    await assertFails(updateDoc(doc(ownerDb, "notes/note-a"), restoreFields("user-a")));
    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
    await assertSucceeds(deleteDoc(doc(ownerDb, "notes/note-a/history/history-a")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a")));
  });

  it("allows an active admin to enqueue cleanup for a purged note while preserving the source owner id", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true }));
      await setDoc(doc(db, "notes/note-a"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        ...softDeleteFields("user-a")
      });
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const batch = writeBatch(adminDb);
    batch.update(doc(adminDb, "notes/note-a"), {
      type: "personal",
      participantUids: ["admin-a"],
      wrappedKeys: {
        "admin-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "admin" }
      },
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      isPurged: true,
      purgedAt: serverTimestamp(),
      purgedBy: "admin-a",
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "admin-a"
    });
    batch.set(doc(adminDb, "notePurgeCleanupQueue/note-a"), {
      noteId: "note-a",
      ownerUid: "user-a",
      createdAt: serverTimestamp()
    });

    await assertSucceeds(batch.commit());
    await assertFails(getDoc(doc(adminDb, "notes/note-a")));
    await assertFails(getDoc(doc(adminDb, "notePurgeCleanupQueue/note-a")));
  });

  it("allows users to manage only their own note state for accessible notes", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-c").firestore();

    await assertSucceeds(setDoc(doc(participantDb, "noteUserStates/note-a/users/user-b"), noteUserState("note-a", "user-b")));
    await assertSucceeds(getDoc(doc(participantDb, "noteUserStates/note-a/users/user-b")));
    await assertSucceeds(
      setDoc(
        doc(participantDb, "noteUserStates/note-a/users/user-b"),
        noteUserState("note-a", "user-b", {
          cursorOffset: null,
          cursorVisible: false,
          cursorClientId: "client-a"
        })
      )
    );
    await assertFails(setDoc(doc(participantDb, "noteUserStates/note-a/users/user-a"), noteUserState("note-a", "user-a")));
    await assertFails(setDoc(doc(outsiderDb, "noteUserStates/note-a/users/user-c"), noteUserState("note-a", "user-c")));
    await assertFails(
      setDoc(
        doc(participantDb, "noteUserStates/note-a/users/user-b"),
        noteUserState("note-a", "user-b", {
          cursorOffset: -1
        })
      )
    );
    await assertFails(
      setDoc(
        doc(participantDb, "noteUserStates/note-a/users/user-b"),
        noteUserState("note-a", "user-b", {
          cursorUpdatedAt: new Date("2099-01-01T00:00:00.000Z")
        })
      )
    );
  });

  it("requires history writes to match same-batch note mutations", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const createdNoteRef = doc(ownerDb, "notes/note-created");
    const createBatch = writeBatch(ownerDb);
    const createHistoryId = noteRevisionId(1);

    createBatch.set(createdNoteRef, {
      type: "shared",
      ownerUid: "user-a",
      participantUids: ["user-a", "user-b"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
        "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
      },
      createdAt: serverTimestamp(),
      isDeleted: false,
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 1,
      lastMutationId: createHistoryId
    });
    createBatch.set(
      doc(ownerDb, "notes/note-created/history", createHistoryId),
      noteHistory("note-created", "user-a", { action: "create", changedFields: ["title", "body"], revision: 1 })
    );
    await assertSucceeds(createBatch.commit());

    const historyRef = doc(participantDb, "notes/note-a/history", noteRevisionId(1));

    await assertFails(setDoc(historyRef, noteHistory("note-a", "user-b")));
    await assertFails(
      setDoc(
        doc(participantDb, "notes/note-a/history/client-time"),
        noteHistory("note-a", "user-b", { createdAt: new Date("2026-05-18T09:00:00.000Z") })
      )
    );

    const firstBatch = writeBatch(participantDb);
    firstBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedBody: { ...encryptedPayload, cipherText: "updated-body" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 1,
      lastMutationId: noteRevisionId(1)
    });
    firstBatch.set(historyRef, noteHistory("note-a", "user-b", { changedFields: ["body"], revision: 1 }));
    await assertSucceeds(firstBatch.commit());

    const secondBatch = writeBatch(participantDb);
    const secondHistoryRef = doc(participantDb, "notes/note-a/history", noteRevisionId(2));
    secondBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "updated-title" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    secondBatch.set(secondHistoryRef, noteHistory("note-a", "user-b", { changedFields: ["title"], revision: 2 }));
    await assertSucceeds(secondBatch.commit());

    await assertSucceeds(getDoc(historyRef));
    await assertFails(
      updateDoc(doc(participantDb, "notes/note-a"), {
        encryptedBody: { ...encryptedPayload, cipherText: "missing-history" },
        updatedAt: serverTimestamp(),
        updatedBy: "user-b",
        revision: 3,
        lastMutationId: noteRevisionId(3)
      })
    );
    const forgedActorBatch = writeBatch(participantDb);
    forgedActorBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedBody: { ...encryptedPayload, cipherText: "forged-actor" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 3,
      lastMutationId: noteRevisionId(3)
    });
    forgedActorBatch.set(
      doc(participantDb, "notes/note-a/history", noteRevisionId(3)),
      noteHistory("note-a", "user-b", { changedFields: ["body"], revision: 3 })
    );
    await assertFails(forgedActorBatch.commit());
    const skippedRevisionBatch = writeBatch(participantDb);
    skippedRevisionBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedBody: { ...encryptedPayload, cipherText: "skipped-revision" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 4,
      lastMutationId: noteRevisionId(4)
    });
    skippedRevisionBatch.set(
      doc(participantDb, "notes/note-a/history", noteRevisionId(4)),
      noteHistory("note-a", "user-b", { changedFields: ["body"], revision: 4 })
    );
    await assertFails(skippedRevisionBatch.commit());
    const forgedTimestampBatch = writeBatch(participantDb);
    forgedTimestampBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedBody: { ...encryptedPayload, cipherText: "forged-time" },
      updatedAt: new Date("2026-05-18T09:00:00.000Z"),
      updatedBy: "user-b",
      revision: 3,
      lastMutationId: noteRevisionId(3)
    });
    forgedTimestampBatch.set(
      doc(participantDb, "notes/note-a/history", noteRevisionId(3)),
      noteHistory("note-a", "user-b", { changedFields: ["body"], revision: 3 })
    );
    await assertFails(forgedTimestampBatch.commit());
    await assertFails(
      setDoc(historyRef, noteHistory("note-a", "user-b", { changedFields: ["body"], revision: 1 }))
    );
    await assertFails(
      setDoc(
        doc(participantDb, "notes/note-a/history/forged-share"),
        noteHistory("note-a", "user-b", { action: "share", changedFields: ["participants"] })
      )
    );
    await assertFails(setDoc(doc(participantDb, "notes/note-a/history/forged-actor"), noteHistory("note-a", "user-a")));
    await assertFails(
      setDoc(
        doc(participantDb, "notes/note-a/history/unsafe-field"),
        noteHistory("note-a", "user-b", { changedFields: ["privateKey"] })
      )
    );
    await assertFails(
      setDoc(
        doc(participantDb, "notes/note-a/history/unsafe-snapshot"),
        noteHistory("note-a", "user-b", { encryptedSnapshot: { version: 1, algorithm: "AES-GCM", cipherText: 12, iv: "iv" } })
      )
    );

    const mismatchedReaderBatch = writeBatch(participantDb);
    mismatchedReaderBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedBody: { ...encryptedPayload, cipherText: "reader-mismatch" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 3,
      lastMutationId: noteRevisionId(3)
    });
    mismatchedReaderBatch.set(
      doc(participantDb, "notes/note-a/history", noteRevisionId(3)),
      noteHistory("note-a", "user-b", { changedFields: ["body"], readerUids: ["user-b"], revision: 3 })
    );
    await assertFails(mismatchedReaderBatch.commit());
  });

  it("allows random mutation ids to advance even when a deterministic future history id was pre-reserved", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    const commitContentMutation = async (revision: number, historyId: string, cipherText: string) => {
      const batch = writeBatch(participantDb);
      batch.update(doc(participantDb, "notes/note-a"), {
        encryptedBody: { ...encryptedPayload, cipherText },
        updatedAt: serverTimestamp(),
        updatedBy: "user-b",
        revision,
        lastMutationId: historyId
      });
      batch.set(
        doc(participantDb, "notes/note-a/history", historyId),
        noteHistory("note-a", "user-b", { changedFields: ["body"], revision })
      );
      return batch.commit();
    };

    const preReservedFutureId = noteRevisionId(3);
    await assertSucceeds(commitContentMutation(1, preReservedFutureId, "reserved-future-id"));
    await assertSucceeds(commitContentMutation(2, "mutation-random-id-0002", "random-revision-2"));
    await assertSucceeds(commitContentMutation(3, "mutation-random-id-0003", "random-revision-3"));

    const noteSnapshot = await getDoc(doc(participantDb, "notes/note-a"));
    const reservedSnapshot = await getDoc(doc(participantDb, "notes/note-a/history", preReservedFutureId));
    expect(noteSnapshot.data()?.revision).toBe(3);
    expect(noteSnapshot.data()?.lastMutationId).toBe("mutation-random-id-0003");
    expect(reservedSnapshot.data()?.revision).toBe(1);
  });

  it("limits history snapshot reads to users authorized when the snapshot was created", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-a/history/legacy-snapshot"), {
        noteId: "note-a",
        actorUid: "user-a",
        action: "content",
        changedFields: ["body"],
        encryptedSummary: encryptedPayload,
        encryptedSnapshot: encryptedPayload,
        createdAt: new Date("2026-05-18T09:00:00.000Z")
      });
      await setDoc(
        doc(context.firestore(), "notes/note-a/history/pre-share-snapshot"),
        noteHistory("note-a", "user-a", {
          changedFields: ["body"],
          readerUids: ["user-a"],
          createdAt: new Date("2026-05-18T10:00:00.000Z")
        })
      );
      await setDoc(
        doc(context.firestore(), "notes/note-a/history/post-share-snapshot"),
        noteHistory("note-a", "user-a", {
          changedFields: ["body"],
          readerUids: ["user-a", "user-b"],
          createdAt: new Date("2026-05-18T11:00:00.000Z")
        })
      );
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a/history/legacy-snapshot")));
    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a/history/pre-share-snapshot")));
    await assertSucceeds(getDoc(doc(ownerDb, "notes/note-a/history/post-share-snapshot")));

    await assertFails(getDoc(doc(participantDb, "notes/note-a/history/legacy-snapshot")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a/history/pre-share-snapshot")));
    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a/history/post-share-snapshot")));
    await assertSucceeds(
      getDocs(query(collection(participantDb, "notes/note-a/history"), where("readerUids", "array-contains", "user-b")))
    );
  });

  it("blocks unsafe attachment writes", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-c"), userProfile("user-c"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-c").firestore();

    await assertFails(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/bad-extension"),
        attachmentDocument("note-a", { extension: "exe" })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/bad-size"),
        attachmentDocument("note-a", {
          originalSize: 1_000_001,
          encryptedData: Bytes.fromUint8Array(new Uint8Array(1_000_017))
        })
      )
    );
    await assertFails(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/mismatched-cipher-size"),
        attachmentDocument("note-a", {
          originalSize: 4,
          encryptedData: Bytes.fromUint8Array(new Uint8Array(18))
        })
      )
    );
    await assertFails(
      setDoc(
        doc(outsiderDb, "notes/note-a/attachments/outsider"),
        attachmentDocument("note-a", { uploadedBy: "user-c" })
      )
    );
    await assertFails(getDoc(doc(outsiderDb, "notes/note-a/attachments/outsider")));
  });

  it("allows users to publish only their own active accessible note", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/note-a"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-b"), {
        type: "personal",
        ownerUid: "user-b",
        participantUids: ["user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        isDeleted: false,
        updatedBy: "user-b"
      });
      await setDoc(doc(context.firestore(), "notes/note-deleted"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: true,
        deletedAt: new Date("2026-05-18T10:00:00.000Z"),
        deletedBy: "user-a",
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-purged"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: true,
        isPurged: true,
        purgedAt: new Date("2026-05-18T11:00:00.000Z"),
        purgedBy: "user-a",
        updatedBy: "user-a"
      });
    });

    const userDb = testEnv.authenticatedContext("user-a").firestore();

    await assertSucceeds(
      setDoc(doc(userDb, "activeNotes/user-a"), {
        uid: "user-a",
        noteId: "note-a",
        updatedByClientId: "client-a"
      })
    );
    await assertSucceeds(
      setDoc(doc(userDb, "activeNotes/user-a"), {
        uid: "user-a",
        noteId: null,
        updatedByClientId: "client-a"
      })
    );
    await assertFails(
      setDoc(doc(userDb, "activeNotes/user-b"), {
        uid: "user-b",
        noteId: "note-a",
        updatedByClientId: "client-a"
      })
    );
    await assertFails(
      setDoc(doc(userDb, "activeNotes/user-a"), {
        uid: "user-a",
        noteId: "note-b",
        updatedByClientId: "client-a"
      })
    );
    await assertFails(
      setDoc(doc(userDb, "activeNotes/user-a"), {
        uid: "user-a",
        noteId: "note-deleted",
        updatedByClientId: "client-a"
      })
    );
    await assertFails(
      setDoc(doc(userDb, "activeNotes/user-a"), {
        uid: "user-a",
        noteId: "note-purged",
        updatedByClientId: "client-a"
      })
    );
  });
});
