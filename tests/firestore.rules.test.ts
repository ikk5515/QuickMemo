import fs from "node:fs";
import path from "node:path";
import {
  RulesTestEnvironment,
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
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const describeRules = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

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

function purgeFields(uid: string) {
  return {
    type: "personal",
    participantUids: [uid],
    wrappedKeys: {
      [uid]: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
    },
    encryptedTitle: encryptedPayload,
    encryptedBody: encryptedPayload,
    isPurged: true,
    purgedAt: new Date("2026-05-18T12:00:00.000Z"),
    purgedBy: uid,
    updatedAt: new Date("2026-05-18T12:00:00.000Z"),
    savedAt: new Date("2026-05-18T12:00:00.000Z"),
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
    encryptedSummary: encryptedPayload,
    encryptedSnapshot: encryptedPayload,
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function publicShareDocument(sourceNoteId = "note-a", ownerUid = "user-a", overrides: Record<string, unknown> = {}) {
  return {
    sourceNoteId,
    ownerUid,
    version: 1,
    encryptedTitle: encryptedPayload,
    encryptedBody: encryptedPayload,
    ownerWrappedShareKey,
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

  return {
    version: 1,
    algorithm: "AES-GCM",
    fileName: "shared-report",
    extension: "pdf",
    mimeType: "application/pdf",
    originalSize,
    encryptedData: Bytes.fromUint8Array(new Uint8Array(originalSize + 16)),
    iv: Bytes.fromUint8Array(new Uint8Array(12)),
    sourceAttachmentId: "attachment-a",
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function storedPublicShareAttachment(shareId: string, attachmentId: string, overrides: Record<string, unknown> = {}) {
  const originalSize = typeof overrides.originalSize === "number" ? overrides.originalSize : 10 * 1024 * 1024;

  return {
    version: 1,
    algorithm: "AES-GCM",
    fileName: "shared-archive",
    extension: "zip",
    mimeType: "application/zip",
    originalSize,
    storagePath: `publicNoteShares/${shareId}/attachments/${attachmentId}/data`,
    encryptedSize: originalSize + 16,
    isReady: false,
    iv: Bytes.fromUint8Array(new Uint8Array(12)),
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
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        updatedBy: "user-a",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
        dueDate: "2028-02-29",
        startDate: "2028-02-29",
        endDate: "2028-02-29",
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
    await assertSucceeds(deleteDoc(doc(ownerDb, "scheduleTasks/task-a")));
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

    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a")));
    await assertSucceeds(
      getDocs(
        query(
          collection(participantDb, "notes"),
          where("ownerUid", "==", "user-a"),
          where("isDeleted", "==", false),
          where("participantUids", "array-contains", "user-b"),
          orderBy("updatedAt", "desc")
        )
      )
    );
    await assertFails(getDoc(doc(testEnv.authenticatedContext("user-c").firestore(), "notes/note-a")));
  });

  it("allows owners to publish temporary public note shares while blocking expired or revoked links", async () => {
    const shareExpiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

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
    await assertSucceeds(
      createPublicShareAttachmentBatch(ownerDb, "share-a", "attachment-a", publicShareAttachment({ expiresAt: shareExpiresAt }))
    );
    await assertSucceeds(updateDoc(doc(ownerDb, "publicNoteShares/share-a"), { ready: true, attachmentCount: 1, updatedAt: serverTimestamp() }));
    await assertSucceeds(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "png-ok",
        publicShareAttachment({ expiresAt: shareExpiresAt, extension: "png", fileName: "safe-image", mimeType: "image/png" })
      )
    );
    await assertSucceeds(
      createPublicShareAttachmentBatch(
        ownerDb,
        "share-a",
        "zip-storage",
        storedPublicShareAttachment("share-a", "zip-storage", { expiresAt: shareExpiresAt })
      )
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a/attachments/zip-storage"), {
        isReady: true
      })
    );
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
    await assertSucceeds(getDocs(collection(publicDb, "publicNoteShares/share-a/attachments")));
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
        encryptedTitle: { ...encryptedPayload, cipherText: "new-title" },
        encryptedBody: { ...encryptedPayload, cipherText: "new-body" },
        passwordHash: { ...publicSharePasswordHash, hash: "bmV3LWhhc2gtYnl0ZXMtZm9yLXRlc3Q=" },
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertSucceeds(
      updateDoc(doc(ownerDb, "publicNoteShares/share-a"), {
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        passwordHash: deleteField(),
        updatedAt: serverTimestamp()
      })
    );

    await assertSucceeds(updateDoc(doc(ownerDb, "publicNoteShares/share-a"), { revokedAt: serverTimestamp(), revokedBy: "user-a", updatedAt: serverTimestamp() }));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-a")));
    await assertFails(getDocs(collection(publicDb, "publicNoteShares/share-a/attachments")));
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
    await assertSucceeds(ownerDeleteBatch.commit());

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
      setDoc(doc(ownerDb, "notes/note-a"), {
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
      })
    );

    await expect(getDoc(doc(ownerDb, "notes/note-a"))).resolves.toBeTruthy();
    await assertSucceeds(
      setDoc(doc(ownerDb, "notes/note-a"), {
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

    await assertSucceeds(
      setDoc(doc(ownerDb, "notes/note-a"), {
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
      updateDoc(doc(ownerDb, "notes/revoked-share"), {
        type: "personal",
        participantUids: ["user-a"],
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        updatedBy: "user-a"
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
      setDoc(doc(ownerDb, "notes/approved-share"), {
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
      })
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
      setDoc(doc(adminDb, "notes/admin-open-share"), {
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
    await assertSucceeds(getDocs(query(collection(adminDb, "notes"), where("isDeleted", "==", false), orderBy("updatedAt", "desc"))));
    await assertFails(getDoc(doc(outsiderDb, "notes/note-personal")));
    await assertFails(deleteDoc(doc(adminDb, "notes/note-personal")));
    await assertSucceeds(updateDoc(doc(adminDb, "notes/note-personal"), softDeleteFields("admin-a")));
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
      updateDoc(doc(testEnv.authenticatedContext("admin-b").firestore(), "notes/note-user-shared"), softDeleteFields("admin-b"))
    );
    await assertSucceeds(
      updateDoc(doc(testEnv.authenticatedContext("admin-a").firestore(), "notes/note-admin-shared"), softDeleteFields("admin-a"))
    );
  });

  it("allows note participants to create and read encrypted attachments", async () => {
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

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(setDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a"), attachmentDocument("note-a")));
    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a/attachments/attachment-a")));
  });

  it("allows Storage-backed ZIP attachments up to 10 MiB and validates their storage metadata", async () => {
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
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();

    await assertSucceeds(
      setDoc(
        doc(ownerDb, "notes/note-a/attachments/storage-zip"),
        storedAttachmentDocument("note-a", "storage-zip")
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
    await assertSucceeds(
      updateDoc(doc(ownerDb, "notes/note-a/attachments/storage-zip"), {
        isReady: true
      })
    );
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

  it("blocks direct note deletes and keeps attachments deletable after soft delete", async () => {
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
    await assertSucceeds(updateDoc(doc(ownerDb, "notes/note-a"), softDeleteFields("user-a")));
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
    await assertSucceeds(deleteDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
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
    await assertSucceeds(updateDoc(doc(ownerDb, "notes/note-a"), restoreFields("user-a")));
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
    await assertSucceeds(deleteDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a/history/history-a")));
    await assertSucceeds(updateDoc(doc(ownerDb, "notes/note-a"), restoreFields("user-a")));
    await assertSucceeds(updateDoc(doc(ownerDb, "notes/note-a"), softDeleteFields("user-a")));
    await assertSucceeds(updateDoc(doc(ownerDb, "notes/note-a"), purgeFields("user-a")));
    await assertFails(updateDoc(doc(ownerDb, "notes/note-a"), restoreFields("user-a")));
    await assertSucceeds(deleteDoc(doc(ownerDb, "notes/note-a/history/history-a")));
    await assertFails(getDoc(doc(participantDb, "notes/note-a")));
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
      updatedBy: "user-a"
    });
    createBatch.set(
      doc(ownerDb, "notes/note-created/history/create-a"),
      noteHistory("note-created", "user-a", { action: "create", changedFields: ["title", "body"] })
    );
    await assertSucceeds(createBatch.commit());

    const historyRef = doc(participantDb, "notes/note-a/history/history-a");

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
      updatedBy: "user-b"
    });
    firstBatch.set(historyRef, noteHistory("note-a", "user-b", { changedFields: ["body"] }));
    await assertSucceeds(firstBatch.commit());

    const secondBatch = writeBatch(participantDb);
    secondBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "updated-title" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b"
    });
    secondBatch.set(historyRef, noteHistory("note-a", "user-b", { changedFields: ["title"] }));
    await assertSucceeds(secondBatch.commit());

    await assertSucceeds(getDoc(historyRef));
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
      updatedBy: "user-b"
    });
    mismatchedReaderBatch.set(
      doc(participantDb, "notes/note-a/history/reader-mismatch"),
      noteHistory("note-a", "user-b", { changedFields: ["body"], readerUids: ["user-b"] })
    );
    await assertFails(mismatchedReaderBatch.commit());
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
  });
});
