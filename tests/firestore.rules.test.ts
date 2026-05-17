import fs from "node:fs";
import path from "node:path";
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const describeRules = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

const encryptedPayload = {
  version: 1,
  algorithm: "AES-GCM",
  cipherText: "cipher",
  iv: "iv"
};

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

  it("allows participants to read notes and blocks outsiders", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
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

  it("prevents participants from changing access lists during content edits", async () => {
    const userDb = testEnv.authenticatedContext("user-a").firestore();
    await assertSucceeds(
      setDoc(doc(userDb, "notes/note-a"), {
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

    await expect(getDoc(doc(userDb, "notes/note-a"))).resolves.toBeTruthy();
    await assertFails(
      setDoc(doc(userDb, "notes/note-a"), {
        type: "shared",
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
});
