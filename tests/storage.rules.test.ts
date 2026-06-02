import fs from "node:fs";
import path from "node:path";
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import { Bytes, doc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const describeStorageRules =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST ? describe : describe.skip;

const encryptedPayload = {
  version: 1,
  algorithm: "AES-GCM",
  cipherText: "cipher",
  iv: "iv"
};
const bucketUrl = "gs://quickmemo-rules-test.appspot.com";
const noteStoragePath = "notes/note-a/attachments/attachment-a/data";
const revokedNoteStoragePath = "notes/revoked-share/attachments/revoked-attachment/data";
const revokedUploadStoragePath = "notes/revoked-share/attachments/revoked-upload/data";
const shareStoragePath = "publicNoteShares/share-a/attachments/attachment-a/data";

function encryptedBytes(size = 32) {
  return new Uint8Array(size);
}

function encryptedUploadMetadata(extraMetadata: Record<string, string>) {
  return {
    contentType: "application/octet-stream",
    customMetadata: {
      version: "1",
      algorithm: "AES-GCM",
      originalSize: "16",
      ...extraMetadata
    }
  };
}

function uploadTaskPromise(task: {
  then: (onFulfilled: (value: unknown) => void, onRejected: (reason: unknown) => void) => unknown;
}) {
  return new Promise((resolve, reject) => {
    task.then(resolve, reject);
  });
}

describeStorageRules("storage security rules", () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "quickmemo-rules-test",
      firestore: {
        rules: fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8")
      },
      storage: {
        rules: fs.readFileSync(path.join(process.cwd(), "storage.rules"), "utf8")
      }
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it("only allows note attachment uploads that match Firestore metadata", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), {
        uid: "user-a",
        isActive: true,
        isAdmin: false
      });
      await setDoc(doc(db, "notes/note-a"), {
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
      await setDoc(doc(db, "notes/note-a/attachments/attachment-a"), {
        noteId: "note-a",
        version: 1,
        algorithm: "AES-GCM",
        fileName: "archive",
        extension: "zip",
        mimeType: "application/zip",
        originalSize: 16,
        storagePath: noteStoragePath,
        encryptedSize: 32,
        isReady: false,
        iv: Bytes.fromUint8Array(new Uint8Array(12)),
        uploadedBy: "user-a",
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
      await setDoc(doc(db, "notes/note-a/attachments/attachment-b"), {
        noteId: "note-a",
        version: 1,
        algorithm: "AES-GCM",
        fileName: "mismatch",
        extension: "zip",
        mimeType: "application/zip",
        originalSize: 16,
        storagePath: noteStoragePath,
        encryptedSize: 32,
        isReady: false,
        iv: Bytes.fromUint8Array(new Uint8Array(12)),
        uploadedBy: "user-a",
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    const userStorage = testEnv.authenticatedContext("user-a").storage(bucketUrl);

    await assertSucceeds(
      uploadTaskPromise(
        userStorage.ref(noteStoragePath).put(
          encryptedBytes(),
          encryptedUploadMetadata({
            noteId: "note-a",
            attachmentId: "attachment-a",
            uploadedBy: "user-a"
          })
        )
      )
    );
    await assertFails(
      uploadTaskPromise(
        userStorage.ref("notes/note-a/attachments/attachment-b/data").put(
          encryptedBytes(),
          encryptedUploadMetadata({
            noteId: "note-a",
            attachmentId: "attachment-b",
            uploadedBy: "user-a"
          })
        )
      )
    );
    await assertFails(
      uploadTaskPromise(
        userStorage.ref(noteStoragePath).put(
          encryptedBytes(),
          encryptedUploadMetadata({
            noteId: "note-a",
            attachmentId: "attachment-a",
            uploadedBy: "other-user"
          })
        )
      )
    );

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a/attachments/attachment-a"), {
        isReady: true
      });
    });
    await assertSucceeds(userStorage.ref(noteStoragePath).getMetadata());
  });

  it("blocks owner-revoked participants from reading note attachment objects", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), {
        uid: "user-a",
        isActive: true,
        isAdmin: false,
        allowedShareTargetUids: ["user-a"]
      });
      await setDoc(doc(db, "users/user-b"), {
        uid: "user-b",
        isActive: true,
        isAdmin: false
      });
      await setDoc(doc(db, "notes/revoked-share"), {
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
        await setDoc(doc(db, "notes/revoked-share/attachments/revoked-attachment"), {
          noteId: "revoked-share",
        version: 1,
        algorithm: "AES-GCM",
        fileName: "archive",
        extension: "zip",
        mimeType: "application/zip",
        originalSize: 16,
        storagePath: revokedNoteStoragePath,
        encryptedSize: 32,
        isReady: true,
        iv: Bytes.fromUint8Array(new Uint8Array(12)),
          uploadedBy: "user-a",
          createdAt: new Date("2026-05-18T08:00:00.000Z")
        });
        await setDoc(doc(db, "notes/revoked-share/attachments/revoked-upload"), {
          noteId: "revoked-share",
          version: 1,
          algorithm: "AES-GCM",
          fileName: "archive",
          extension: "zip",
          mimeType: "application/zip",
          originalSize: 16,
          storagePath: revokedUploadStoragePath,
          encryptedSize: 32,
          isReady: false,
          iv: Bytes.fromUint8Array(new Uint8Array(12)),
          uploadedBy: "user-b",
          createdAt: new Date("2026-05-18T08:00:00.000Z")
        });
        await uploadTaskPromise(
          context.storage(bucketUrl).ref(revokedNoteStoragePath).put(
            encryptedBytes(),
            encryptedUploadMetadata({
              noteId: "revoked-share",
              attachmentId: "revoked-attachment",
              uploadedBy: "user-a"
            })
          )
        );
      });

    const ownerStorage = testEnv.authenticatedContext("user-a").storage(bucketUrl);
    const revokedStorage = testEnv.authenticatedContext("user-b").storage(bucketUrl);

    await assertSucceeds(ownerStorage.ref(revokedNoteStoragePath).getMetadata());
    await assertFails(revokedStorage.ref(revokedNoteStoragePath).getMetadata());
    await assertFails(
      uploadTaskPromise(
        revokedStorage.ref(revokedUploadStoragePath).put(
          encryptedBytes(),
          encryptedUploadMetadata({
            noteId: "revoked-share",
            attachmentId: "revoked-upload",
            uploadedBy: "user-b"
          })
        )
      )
    );
  });

  it("allows active public share attachment reads but validates owner uploads", async () => {
    const expiresAt = new Date(Date.now() + 60_000);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "publicNoteShares/share-a"), {
        sourceNoteId: "note-a",
        ownerUid: "user-a",
        version: 1,
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        attachmentCount: 1,
        ready: true,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        expiresAt
      });
      await setDoc(doc(db, "publicNoteShares/share-a/attachments/attachment-a"), {
        version: 1,
        algorithm: "AES-GCM",
        fileName: "archive",
        extension: "zip",
        mimeType: "application/zip",
        originalSize: 16,
        storagePath: shareStoragePath,
        encryptedSize: 32,
        isReady: false,
        iv: Bytes.fromUint8Array(new Uint8Array(12)),
        sourceAttachmentId: "source-a",
        expiresAt,
        createdAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    const ownerStorage = testEnv.authenticatedContext("user-a").storage(bucketUrl);
    const otherStorage = testEnv.authenticatedContext("user-b").storage(bucketUrl);
    const publicStorage = testEnv.unauthenticatedContext().storage(bucketUrl);

    await assertFails(
      uploadTaskPromise(
        otherStorage.ref(shareStoragePath).put(
          encryptedBytes(),
          encryptedUploadMetadata({
            shareId: "share-a",
            attachmentId: "attachment-a"
          })
        )
      )
    );
    await assertSucceeds(
      uploadTaskPromise(
        ownerStorage.ref(shareStoragePath).put(
          encryptedBytes(),
          encryptedUploadMetadata({
            shareId: "share-a",
            attachmentId: "attachment-a"
          })
        )
      )
    );
    await assertSucceeds(publicStorage.ref(shareStoragePath).getMetadata());
  });
});
