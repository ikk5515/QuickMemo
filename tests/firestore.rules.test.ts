import fs from "node:fs";
import path from "node:path";
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, writeBatch } from "firebase/firestore";
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

    await assertFails(updateDoc(doc(adminDb, "users/user-b"), { loginEmail: "changed@quickmemo.local" }));
  });

  it("allows participants to read notes and blocks outsiders", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
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

    await assertSucceeds(getDoc(doc(testEnv.authenticatedContext("user-b").firestore(), "notes/note-a")));
    await assertFails(getDoc(doc(testEnv.authenticatedContext("user-c").firestore(), "notes/note-a")));
  });

  it("allows note owners to update sharing and blocks non-owners", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
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

  it("allows participants to update note deadlines and blocks outsiders", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
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
