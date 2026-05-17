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
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
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

const userKeyPayload = {
  version: 1,
  algorithm: "AES-GCM",
  cipherText: "private-key",
  iv: "iv"
};

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

function softDeleteFields(uid: string) {
  return {
    isDeleted: true,
    deletedAt: new Date("2026-05-18T10:00:00.000Z"),
    deletedBy: uid,
    updatedAt: new Date("2026-05-18T10:00:00.000Z"),
    updatedBy: uid
  };
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
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const batch = writeBatch(adminDb);

    batch.set(doc(adminDb, "system/bootstrap"), { adminUid: "admin-a" });
    batch.set(doc(adminDb, "quickLoginKeys/1"), quickLoginKey("admin-a", 1));
    batch.set(doc(adminDb, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
    batch.set(doc(adminDb, "publicLoginRoster/admin-a"), rosterProfile("admin-a", { isAdmin: true, role: "admin" }));
    batch.set(doc(adminDb, "userKeys/admin-a"), userKey("admin-a"));

    await assertSucceeds(batch.commit());
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
        updatedBy: "user-a"
      })
    );
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
          where("participantUids", "array-contains", "user-b"),
          orderBy("updatedAt", "desc")
        )
      )
    );
    await assertFails(getDoc(doc(testEnv.authenticatedContext("user-c").firestore(), "notes/note-a")));
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
        updatedBy: "user-a"
      });
    });

    await assertSucceeds(getDoc(doc(testEnv.authenticatedContext("user-a").firestore(), "notes/revoked-share")));
    const revokedParticipantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertFails(getDoc(doc(revokedParticipantDb, "notes/revoked-share")));
    await assertFails(
      getDocs(
        query(
          collection(revokedParticipantDb, "notes"),
          where("ownerUid", "==", "user-a"),
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
        updatedBy: "user-b"
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
        updatedBy: "admin-a"
      })
    );
  });

  it("allows participants to update note deadlines and blocks outsiders", async () => {
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
        updatedBy: "user-a"
      });
    });

    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-c").firestore();

    await assertSucceeds(
      updateDoc(doc(participantDb, "notes/note-a"), {
        dueAt: new Date("2026-05-20T10:00:00.000Z"),
        updatedBy: "user-b"
      })
    );
    await assertSucceeds(
      updateDoc(doc(participantDb, "notes/note-a"), {
        dueAt: null,
        updatedBy: "user-b"
      })
    );
    await assertFails(
      updateDoc(doc(outsiderDb, "notes/note-a"), {
        dueAt: new Date("2026-05-21T10:00:00.000Z"),
        updatedBy: "user-c"
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
        updatedBy: "user-a"
      });
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-c").firestore();

    await assertSucceeds(getDoc(doc(adminDb, "notes/note-personal")));
    await assertSucceeds(getDocs(query(collection(adminDb, "notes"), orderBy("updatedAt", "desc"))));
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
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    await assertSucceeds(setDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a"), attachmentDocument("note-a")));
    await assertSucceeds(getDoc(doc(participantDb, "notes/note-a/attachments/attachment-a")));
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
        updatedBy: "user-a"
      });
      await setDoc(doc(context.firestore(), "notes/note-a/attachments/attachment-a"), attachmentDocument("note-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();

    await assertFails(deleteDoc(doc(ownerDb, "notes/note-a")));
    await assertSucceeds(updateDoc(doc(ownerDb, "notes/note-a"), softDeleteFields("user-a")));
    await assertFails(setDoc(doc(ownerDb, "notes/note-a/attachments/attachment-b"), attachmentDocument("note-a")));
    await assertSucceeds(deleteDoc(doc(ownerDb, "notes/note-a/attachments/attachment-a")));
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
