import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
  documentId,
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
let testEnv: RulesTestEnvironment;

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
const validLibraryWrappedKey3072 = "B".repeat(512);
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

function vaultWorkspace(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    encryptedState: encryptedPayload,
    wrappedKey: ownerWrappedShareKey,
    revision: 1,
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
  const versionedVaultEntry = Boolean(note.contentFormat || note.entryKind);
  const claimId = vaultTestClaimId(noteId);

  batch.set(doc(firestore, "notes", noteId), {
    ...note,
    ...(versionedVaultEntry ? {
      attachmentRevision: Object.prototype.hasOwnProperty.call(note, "attachmentRevision")
        ? note.attachmentRevision
        : 0,
      folderId: Object.prototype.hasOwnProperty.call(note, "folderId")
        ? note.folderId
        : null,
      vaultNameClaimId: claimId,
      vaultNameIndexVersion: 1
    } : {}),
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
  if (versionedVaultEntry) {
    batch.set(doc(firestore, "vaultIntegrity", actorUid, "nameClaims", claimId), {
      ownerUid: actorUid,
      indexVersion: 1,
      parentId: typeof note.folderId === "string" ? note.folderId : null,
      targetId: noteId,
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  return batch.commit();
}

function vaultTestClaimId(value: string) {
  return createHash("sha256").update(`quickmemo-rules-test:${value}`).digest("base64url");
}

function vaultIntegrity(uid: string) {
  return {
    ownerUid: uid,
    indexVersion: 1,
    wrappedKey: ownerWrappedShareKey,
    createdAt: new Date("2026-05-18T08:00:00.000Z"),
    updatedAt: new Date("2026-05-18T08:00:00.000Z")
  };
}

function vaultPathRewriteJob(
  uid: string,
  jobId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    ownerUid: uid,
    kind: "path-rewrite-v1",
    version: 1,
    planFingerprint: jobId,
    status: "preparing",
    stepCount: 2,
    cursor: 0,
    confirmedCount: 0,
    attemptCount: 0,
    retryCount: 0,
    lastErrorCode: null,
    revision: 1,
    encryptedManifest: encryptedPayload,
    wrappedKey: ownerWrappedShareKey,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

function vaultPathRewriteStep(uid: string, jobId: string, ordinal: number) {
  const stepId = `step-${String(ordinal).padStart(6, "0")}`;
  return {
    ownerUid: uid,
    jobId,
    stepId,
    ordinal,
    encryptedStep: encryptedPayload,
    createdAt: serverTimestamp()
  };
}

function vaultImportJob(
  uid: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    ownerUid: uid,
    kind: "vault-import-v1",
    version: 1,
    status: "preparing",
    itemCount: 2,
    entryCount: 1,
    folderCount: 1,
    rootFolderCount: 1,
    chunkCount: 1,
    remainingChunkCount: 1,
    revision: 1,
    lastErrorCode: null,
    wrappedKey: ownerWrappedShareKey,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides
  };
}

function vaultImportChunk(uid: string, jobId: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: uid,
    jobId,
    ordinal: 0,
    itemCount: 2,
    encryptedManifest: { ...encryptedPayload, cipherText: "encrypted-import-manifest" },
    createdAt: serverTimestamp(),
    ...overrides
  };
}

function createAuditedVaultFolderDirect(
  firestore: RulesFirestore,
  folderId: string,
  uid: string,
  folder: Record<string, unknown>
) {
  const claimId = vaultTestClaimId(`folder:${folderId}`);
  const parentId = typeof folder.parentId === "string" ? folder.parentId : null;
  const ancestorIds = Array.isArray(folder.vaultAncestorIds)
    ? folder.vaultAncestorIds.filter((value): value is string => typeof value === "string")
    : [];
  const batch = writeBatch(firestore);
  batch.set(doc(firestore, "noteFolders", folderId), {
    vaultAncestorIds: [],
    vaultLineageDepth: 0,
    vaultLineageGeneration: 1,
    vaultLineageVersion: 3,
    vaultLineagePath: [...ancestorIds, folderId].join("/"),
    ...folder,
    vaultNameClaimId: claimId,
    vaultNameIndexVersion: 1
  });
  batch.set(doc(firestore, "vaultIntegrity", uid, "nameClaims", claimId), {
    ownerUid: uid,
    indexVersion: 1,
    parentId,
    targetId: folderId,
    targetType: "folder",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return batch.commit();
}

async function createAuditedVaultFolder(
  _firestore: RulesFirestore,
  folderId: string,
  uid: string,
  folder: Record<string, unknown>
) {
  return testEnv.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    const claimId = vaultTestClaimId(`folder:${folderId}`);
    const parentId = typeof folder.parentId === "string" ? folder.parentId : null;
    const ancestorIds = Array.isArray(folder.vaultAncestorIds)
      ? folder.vaultAncestorIds.filter((value): value is string => typeof value === "string")
      : [];
    const treeRef = doc(firestore, "vaultFolderTrees", uid);
    const treeSnapshot = await getDoc(treeRef);
    const storedTree = treeSnapshot.data() ?? {};
    const nodes = { ...((storedTree.nodes as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const selfActive = folder.isDeleted !== true;
    const parentActive = parentId === null || nodes[parentId]?.active === true;
    nodes[folderId] = {
      active: selfActive && parentActive,
      generation: 1,
      parentId,
      selfActive
    };
    const batch = writeBatch(firestore);
    batch.set(doc(firestore, "noteFolders", folderId), {
      vaultAncestorIds: ancestorIds,
      vaultLineageDepth: ancestorIds.length,
      vaultLineageGeneration: 1,
      vaultLineageVersion: 3,
      vaultLineagePath: [...ancestorIds, folderId].join("/"),
      ...folder,
      vaultNameClaimId: claimId,
      vaultNameIndexVersion: 1
    });
    batch.set(doc(firestore, "vaultIntegrity", uid, "nameClaims", claimId), {
      ownerUid: uid,
      indexVersion: 1,
      parentId,
      targetId: folderId,
      targetType: "folder",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    batch.set(treeRef, {
      createdAt: storedTree.createdAt ?? serverTimestamp(),
      folderCount: Object.keys(nodes).length,
      nodes,
      ownerUid: uid,
      revision: typeof storedTree.revision === "number" ? storedTree.revision + 1 : 1,
      schemaVersion: 1,
      updatedAt: serverTimestamp()
    });
    return batch.commit();
  });
}

async function seedServerVaultFolderLifecycle(uid: string, folderId: string, active: boolean) {
  return testEnv.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    const treeRef = doc(firestore, "vaultFolderTrees", uid);
    const folderRef = doc(firestore, "noteFolders", folderId);
    const [treeSnapshot, folderSnapshot] = await Promise.all([
      getDoc(treeRef),
      getDoc(folderRef)
    ]);
    const tree = treeSnapshot.data();
    const folder = folderSnapshot.data();
    if (!tree || !folder) throw new Error("missing server-seeded folder state");
    const nodes = structuredClone(tree.nodes) as Record<string, {
      active: boolean;
      generation: number;
      parentId: string | null;
      selfActive: boolean;
    }>;
    nodes[folderId].selfActive = active;
    nodes[folderId].generation += 1;
    const activeFor = (id: string, visiting = new Set<string>()): boolean => {
      if (visiting.has(id)) throw new Error("cycle in test tree");
      visiting.add(id);
      const node = nodes[id];
      const result = node.selfActive
        && (node.parentId === null || activeFor(node.parentId, visiting));
      visiting.delete(id);
      return result;
    };
    Object.keys(nodes).forEach((id) => { nodes[id].active = activeFor(id); });
    const now = new Date("2026-08-23T00:00:00.000Z");
    const batch = writeBatch(firestore);
    batch.update(treeRef, {
      nodes,
      revision: Number(tree.revision) + 1,
      updatedAt: now
    });
    batch.update(folderRef, {
      isDeleted: !active,
      revision: Number(folder.revision) + 1,
      vaultLineageGeneration: Number(folder.vaultLineageGeneration) + 1,
      updatedAt: now,
      ...(active
        ? { deletedAt: deleteField(), deletedBy: deleteField() }
        : { deletedAt: now, deletedBy: uid })
    });
    const claimId = String(folder.vaultNameClaimId);
    const claimRef = doc(firestore, "vaultIntegrity", uid, "nameClaims", claimId);
    if (active) {
      batch.set(claimRef, {
        ownerUid: uid,
        indexVersion: 1,
        parentId: folder.parentId ?? null,
        targetId: folderId,
        targetType: "folder",
        createdAt: now,
        updatedAt: now
      });
    } else {
      batch.delete(claimRef);
    }
    return batch.commit();
  });
}

async function updateAuditedNote(
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
  const noteRef = doc(firestore, "notes", noteId);
  const currentSnapshot = await getDoc(noteRef);
  const current = currentSnapshot.data() ?? {};
  const currentClaimId = typeof current.vaultNameClaimId === "string" ? current.vaultNameClaimId : null;
  const claimChanges = currentClaimId && changedFields.some((field) => field === "title" || field === "folder");
  const auditedChangedFields = claimChanges && !changedFields.includes("name-claim")
    ? [...changedFields, "name-claim"]
    : changedFields;
  const nextClaimId = claimChanges ? vaultTestClaimId(`${noteId}:claim:${revision}`) : currentClaimId;
  const nextParentId = Object.prototype.hasOwnProperty.call(updates, "folderId")
    ? (typeof updates.folderId === "string" ? updates.folderId : null)
    : typeof current.folderId === "string" ? current.folderId : null;
  const batch = writeBatch(firestore);

  batch.update(noteRef, {
    ...updates,
    ...(claimChanges ? {
      vaultNameClaimId: nextClaimId,
      vaultNameIndexVersion: 1
    } : {}),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
    revision,
    lastMutationId: historyId
  });
  batch.set(
    doc(firestore, "notes", noteId, "history", historyId),
    noteHistory(noteId, actorUid, { action, changedFields: auditedChangedFields, readerUids, revision })
  );

  if (action === "delete" && currentClaimId) {
    batch.delete(doc(firestore, "vaultIntegrity", actorUid, "nameClaims", currentClaimId));
  } else if (action === "restore" && currentClaimId) {
    batch.set(doc(firestore, "vaultIntegrity", actorUid, "nameClaims", currentClaimId), {
      ownerUid: actorUid,
      indexVersion: 1,
      parentId: nextParentId,
      targetId: noteId,
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else if (claimChanges && nextClaimId) {
    batch.set(doc(firestore, "vaultIntegrity", actorUid, "nameClaims", nextClaimId), {
      ownerUid: actorUid,
      indexVersion: 1,
      parentId: nextParentId,
      targetId: noteId,
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    batch.delete(doc(firestore, "vaultIntegrity", actorUid, "nameClaims", currentClaimId));
  }

  return batch.commit();
}

async function updateExactAuditedVaultContent(
  firestore: RulesFirestore,
  input: {
    actorUid: string;
    changedFields: string[];
    encryptedBody: Record<string, unknown>;
    encryptedTitle: Record<string, unknown>;
    noteId: string;
    ownerSuppliesNameClaim: boolean;
    readerUids: string[];
    replacementClaimId?: string;
    revision: number;
  }
) {
  const historyId = `mutation-${String(input.revision).padStart(12, "0")}`;
  return runTransaction(firestore, async (transaction) => {
    const noteRef = doc(firestore, "notes", input.noteId);
    const currentSnapshot = await transaction.get(noteRef);
    const current = currentSnapshot.data() ?? {};
    const currentClaimId = typeof current.vaultNameClaimId === "string"
      ? current.vaultNameClaimId
      : null;
    const nextClaimId = input.ownerSuppliesNameClaim
      ? input.replacementClaimId ?? currentClaimId
      : null;
    const nextClaimRef = nextClaimId
      ? doc(firestore, "vaultIntegrity", current.ownerUid as string, "nameClaims", nextClaimId)
      : null;
    const previousClaimRef = input.ownerSuppliesNameClaim
      && currentClaimId
      && currentClaimId !== nextClaimId
      ? doc(firestore, "vaultIntegrity", current.ownerUid as string, "nameClaims", currentClaimId)
      : null;

    if (nextClaimRef) {
      await transaction.get(nextClaimRef);
    }
    if (previousClaimRef) {
      await transaction.get(previousClaimRef);
    }

    const claimChanged = Boolean(nextClaimId && nextClaimId !== currentClaimId);
    transaction.update(noteRef, {
      encryptedTitle: input.encryptedTitle,
      encryptedBody: input.encryptedBody,
      isDeleted: false,
      ...(nextClaimId ? {
        vaultNameClaimId: nextClaimId,
        vaultNameIndexVersion: 1
      } : {}),
      updatedAt: serverTimestamp(),
      updatedBy: input.actorUid,
      revision: input.revision,
      lastMutationId: historyId
    });
    transaction.set(
      doc(firestore, "notes", input.noteId, "history", historyId),
      noteHistory(input.noteId, input.actorUid, {
        action: "content",
        changedFields: claimChanged && !input.changedFields.includes("name-claim")
          ? [...input.changedFields, "name-claim"]
          : input.changedFields,
        readerUids: input.readerUids,
        revision: input.revision
      })
    );
    if (claimChanged && nextClaimRef) {
      transaction.set(nextClaimRef, {
        ownerUid: current.ownerUid,
        indexVersion: 1,
        parentId: typeof current.folderId === "string" ? current.folderId : null,
        targetId: input.noteId,
        targetType: "entry",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    if (previousClaimRef) {
      transaction.delete(previousClaimRef);
    }
  });
}

async function commitOwnerTitleOnlyNameMutation(
  firestore: RulesFirestore,
  input: {
    access?: {
      participantUids: string[];
      type: "personal" | "shared";
      wrappedKeys: Record<string, unknown>;
    };
    caseId: string;
    createNewClaim?: boolean;
    deletePreviousClaim?: boolean;
    encryptedBody?: Record<string, unknown>;
    folderId?: string | null;
    historyChangedFields?: string[];
    historyRevision?: number;
    newClaimTargetId?: string;
    noteId: string;
  }
) {
  const noteRef = doc(firestore, "notes", input.noteId);
  const currentSnapshot = await getDoc(noteRef);
  const current = currentSnapshot.data() ?? {};
  const ownerUid = String(current.ownerUid);
  const currentClaimId = String(current.vaultNameClaimId);
  const revision = Number(current.revision) + 1;
  const historyId = `title-only-${input.caseId}-${revision}`;
  const nextClaimId = vaultTestClaimId(`${input.noteId}:${input.caseId}:${revision}`);
  const nextParentId = Object.prototype.hasOwnProperty.call(input, "folderId")
    ? input.folderId ?? null
    : typeof current.folderId === "string" ? current.folderId : null;
  const batch = writeBatch(firestore);

  batch.update(noteRef, {
    encryptedTitle: { ...encryptedPayload, cipherText: `title-${input.caseId}` },
    ...(input.encryptedBody ? { encryptedBody: input.encryptedBody } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "folderId") ? { folderId: input.folderId } : {}),
    ...(input.access ?? {}),
    vaultNameClaimId: nextClaimId,
    vaultNameIndexVersion: 1,
    updatedAt: serverTimestamp(),
    updatedBy: ownerUid,
    revision,
    lastMutationId: historyId
  });
  batch.set(
    doc(firestore, "notes", input.noteId, "history", historyId),
    noteHistory(input.noteId, ownerUid, {
      action: "content",
      changedFields: input.historyChangedFields ?? ["title", "name-claim"],
      readerUids: input.access?.participantUids ?? current.participantUids as string[],
      revision: input.historyRevision ?? revision
    })
  );
  if (input.createNewClaim !== false) {
    batch.set(doc(firestore, "vaultIntegrity", ownerUid, "nameClaims", nextClaimId), {
      ownerUid,
      indexVersion: 1,
      parentId: nextParentId,
      targetId: input.newClaimTargetId ?? input.noteId,
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }
  if (input.deletePreviousClaim !== false) {
    batch.delete(doc(firestore, "vaultIntegrity", ownerUid, "nameClaims", currentClaimId));
  }
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

  it("allows only bounded active public roster listings and reserves direct reads for admins", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true }));
      await setDoc(doc(db, "publicLoginRoster/user-a"), rosterProfile("user-a"));
      await setDoc(
        doc(db, "publicLoginRoster/user-b"),
        rosterProfile("user-b", { isActive: false, order: 2, quickKey: 2 })
      );
    });

    const publicDb = testEnv.unauthenticatedContext().firestore();
    const roster = collection(publicDb, "publicLoginRoster");

    await assertFails(getDoc(doc(publicDb, "publicLoginRoster/user-a")));
    await assertFails(getDoc(doc(publicDb, "publicLoginRoster/user-b")));
    await assertFails(getDocs(roster));
    await assertFails(getDocs(query(roster, limit(100))));
    await assertFails(getDocs(query(roster, where("isActive", "==", true))));
    await assertFails(getDocs(query(roster, where("isActive", "==", true), limit(101))));

    const activeRoster = await assertSucceeds(
      getDocs(query(roster, where("isActive", "==", true), limit(100)))
    );
    expect(activeRoster.docs.map((snapshot) => snapshot.id)).toEqual(["user-a"]);

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    await assertSucceeds(getDoc(doc(adminDb, "publicLoginRoster/user-a")));
    await assertSucceeds(getDoc(doc(adminDb, "publicLoginRoster/user-b")));
  });

  it("requires active users and bounded queries for user profile listings", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b", { order: 2, quickKey: 2 }));
      await setDoc(
        doc(db, "users/inactive-user"),
        userProfile("inactive-user", { isActive: false, order: 3, quickKey: 3 })
      );
    });

    const publicDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(query(collection(publicDb, "users"), limit(100))));

    const activeDb = testEnv.authenticatedContext("user-a").firestore();
    const users = collection(activeDb, "users");
    await assertSucceeds(getDoc(doc(activeDb, "users/user-b")));
    await assertFails(getDocs(users));
    await assertFails(getDocs(query(users, orderBy("order", "asc"), limit(101))));

    const boundedUsers = await assertSucceeds(getDocs(query(users, orderBy("order", "asc"), limit(100))));
    expect(boundedUsers.size).toBe(3);

    const inactiveDb = testEnv.authenticatedContext("inactive-user").firestore();
    await assertSucceeds(getDoc(doc(inactiveDb, "users/inactive-user")));
    await assertFails(getDocs(query(collection(inactiveDb, "users"), orderBy("order", "asc"), limit(100))));
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

  it("prevents an administrator from demoting or deactivating itself", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "system/bootstrap"), { adminUid: "admin-a" });
      await setDoc(doc(db, "quickLoginKeys/1"), quickLoginKey("admin-a", 1));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", {
        isAdmin: true,
        role: "admin"
      }));
      await setDoc(doc(db, "publicLoginRoster/admin-a"), rosterProfile("admin-a", {
        isAdmin: true,
        role: "admin"
      }));
      await setDoc(doc(db, "quickLoginKeys/2"), quickLoginKey("admin-b", 2));
      await setDoc(doc(db, "users/admin-b"), userProfile("admin-b", {
        isAdmin: true,
        order: 2,
        quickKey: 2,
        role: "admin"
      }));
      await setDoc(doc(db, "publicLoginRoster/admin-b"), rosterProfile("admin-b", {
        isAdmin: true,
        order: 2,
        quickKey: 2,
        role: "admin"
      }));
    });

    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const selfDemotion = writeBatch(adminDb);
    selfDemotion.update(doc(adminDb, "users/admin-a"), {
      isAdmin: false,
      role: "user"
    });
    selfDemotion.update(doc(adminDb, "publicLoginRoster/admin-a"), {
      isAdmin: false
    });
    await assertFails(selfDemotion.commit());

    const selfDeactivation = writeBatch(adminDb);
    selfDeactivation.update(doc(adminDb, "users/admin-a"), { isActive: false });
    selfDeactivation.update(doc(adminDb, "publicLoginRoster/admin-a"), { isActive: false });
    await assertFails(selfDeactivation.commit());

    const otherAdminDemotion = writeBatch(adminDb);
    otherAdminDemotion.update(doc(adminDb, "users/admin-b"), {
      isAdmin: false,
      role: "user"
    });
    otherAdminDemotion.update(doc(adminDb, "publicLoginRoster/admin-b"), {
      isAdmin: false
    });
    await assertSucceeds(otherAdminDemotion.commit());
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

    const customMatrixLabels = {
      todayOverdue: "오늘/지연",
      importantUrgent: "중요·긴급",
      urgent: "긴급 업무",
      important: "중요 업무",
      waiting: "대기 업무"
    };
    const encryptedMatrixLabels = {
      ...encryptedPayload,
      cipherText: "M".repeat(24),
      iv: "I".repeat(16)
    };
    const matrixLabelsWrappedKey = {
      version: 1,
      algorithm: "RSA-OAEP",
      wrappedKey: validLibraryWrappedKey
    };

    await assertFails(
      setDoc(
        doc(ownerDb, "userPreferences/user-a"),
        userPreferences("user-a", {
          defaultHome: "schedule",
          matrixLabels: customMatrixLabels,
          scheduleDefaultView: "matrix",
          scheduleDefaultCategory: "all",
          theme: "dark"
        })
      )
    );
    await assertSucceeds(
      setDoc(
        doc(ownerDb, "userPreferences/user-a"),
        userPreferences("user-a", {
          defaultHome: "schedule",
          encryptedMatrixLabels,
          matrixLabelsFormat: "matrix-labels-v1",
          matrixLabelsWrappedKey,
          scheduleDefaultView: "matrix",
          scheduleDefaultCategory: "all",
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
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultCategory: "work", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultCategory: "personal", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultCategory: "all", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { theme: "light", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), { theme: "system", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      encryptedMatrixLabels: { ...encryptedMatrixLabels, cipherText: "N".repeat(24) },
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
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      encryptedMatrixLabels: deleteField(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      encryptedMatrixLabels: { ...encryptedMatrixLabels, cipherText: "short" },
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(doc(ownerDb, "userPreferences/user-a"), {
      encryptedMatrixLabels: deleteField(),
      matrixLabelsFormat: deleteField(),
      matrixLabelsWrappedKey: deleteField(),
      updatedAt: serverTimestamp()
    }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "userPreferences/user-a"), {
        uid: "user-a",
        defaultHome: "notes",
        matrixLabels: customMatrixLabels,
        scheduleDefaultView: "todo",
        theme: "system",
        updatedAt: serverTimestamp()
      });
    });
    await assertFails(
      updateDoc(doc(ownerDb, "userPreferences/user-a"), {
        defaultHome: "schedule",
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "userPreferences/user-a"), {
        defaultHome: "schedule",
        encryptedMatrixLabels,
        matrixLabels: deleteField(),
        matrixLabelsFormat: "matrix-labels-v1",
        matrixLabelsWrappedKey,
        scheduleDefaultView: "matrix",
        scheduleDefaultCategory: "personal",
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), { defaultHome: "admin", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultCategory: "shared", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(ownerDb, "userPreferences/user-a"), { scheduleDefaultCategory: null, updatedAt: serverTimestamp() }));
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
    await assertSucceeds(
      setDoc(doc(ownerDb, "libraryItems/bookmarklet-item"), libraryItem("user-a", {
        captureSource: "bookmarklet",
        generationId: "bookmarklet-generation-1",
        lastMutationId: "bookmarklet-mutation-1"
      }))
    );
    await assertFails(
      setDoc(doc(ownerDb, "libraryItems/unknown-capture-item"), libraryItem("user-a", {
        captureSource: "safari-script",
        generationId: "unknown-capture-generation-1",
        lastMutationId: "unknown-capture-mutation-1"
      }))
    );
    await assertSucceeds(getDoc(itemRef));
    await assertSucceeds(
      getDocs(query(
        collection(ownerDb, "libraryItems"),
        where("ownerUid", "==", "user-a"),
        orderBy("updatedAt", "desc"),
        orderBy(documentId(), "desc"),
        limit(121)
      ))
    );
    await assertSucceeds(
      updateDoc(itemRef, {
        status: "reading",
        isFavorite: true,
        revision: 2,
        lastMutationId: "library-mutation-2",
        reviewCount: 1,
        lastReviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(deleteDoc(itemRef));
  });

  it("requires owner-scoped bounded library list queries", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "libraryItems/item-a"), libraryItem("user-a"));
      await setDoc(doc(db, "libraryItems/item-b"), libraryItem("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const ownerItems = collection(ownerDb, "libraryItems");
    const ownQuery = (maximum?: number) => query(
      ownerItems,
      where("ownerUid", "==", "user-a"),
      orderBy("updatedAt", "desc"),
      orderBy(documentId(), "desc"),
      ...(maximum === undefined ? [] : [limit(maximum)])
    );

    await assertSucceeds(getDocs(ownQuery(121)));
    await assertFails(getDocs(ownQuery()));
    await assertFails(getDocs(ownQuery(122)));
    await assertFails(getDocs(query(
      ownerItems,
      where("ownerUid", "==", "user-b"),
      orderBy("updatedAt", "desc"),
      orderBy(documentId(), "desc"),
      limit(121)
    )));
  });

  it("isolates last-open tracking from revisioned library mutations", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "users/user-inactive"), userProfile("user-inactive", { isActive: false }));
      await setDoc(doc(db, "libraryItems/item-a"), libraryItem("user-a"));
      await setDoc(doc(db, "libraryItems/item-inactive"), libraryItem("user-inactive"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const inactiveDb = testEnv.authenticatedContext("user-inactive").firestore();
    const itemRef = doc(ownerDb, "libraryItems/item-a");

    await assertSucceeds(updateDoc(itemRef, { lastOpenedAt: serverTimestamp() }));
    const openedAt = (await getDoc(itemRef)).data()?.lastOpenedAt;

    await assertFails(updateDoc(itemRef, {
      lastOpenedAt: serverTimestamp(),
      lastMutationId: "library-mutation-open-revision",
      revision: 2
    }));
    await assertFails(updateDoc(itemRef, {
      lastOpenedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(itemRef, {
      isFavorite: true,
      lastOpenedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(otherDb, "libraryItems/item-a"), {
      lastOpenedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(inactiveDb, "libraryItems/item-inactive"), {
      lastOpenedAt: serverTimestamp()
    }));

    await assertSucceeds(updateDoc(itemRef, {
      lastMutationId: "library-mutation-after-open",
      revision: 2,
      status: "reading",
      updatedAt: serverTimestamp()
    }));
    const afterRevision = (await getDoc(itemRef)).data();
    expect(afterRevision?.lastOpenedAt.isEqual(openedAt)).toBe(true);

    await assertFails(updateDoc(itemRef, {
      lastMutationId: "library-mutation-reopens",
      lastOpenedAt: serverTimestamp(),
      revision: 3,
      updatedAt: serverTimestamp()
    }));
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
    await assertSucceeds(
      setDoc(
        doc(ownerDb, "libraryItems/rsa-3072-key"),
        libraryItem("user-a", {
          wrappedKeys: {
            "user-a": {
              version: 1,
              algorithm: "RSA-OAEP",
              wrappedKey: validLibraryWrappedKey3072
            }
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
    const secondOwnerDb = testEnv.authenticatedContext("user-b").firestore();
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
    await assertSucceeds(
      setDoc(
        doc(secondOwnerDb, "libraryVaults/user-b"),
        libraryVault("user-b", {
          wrappedKey: {
            version: 1,
            algorithm: "RSA-OAEP",
            wrappedKey: validLibraryWrappedKey3072
          }
        })
      )
    );
    await assertFails(getDocs(collection(ownerDb, "libraryVaults")));
    await assertFails(getDoc(doc(outsiderDb, "libraryVaults/user-a")));
    await assertFails(getDoc(doc(adminDb, "libraryVaults/user-a")));
    await assertFails(setDoc(doc(outsiderDb, "libraryVaults/user-a"), libraryVault("user-a")));
    await assertFails(setDoc(doc(inactiveDb, "libraryVaults/user-inactive"), libraryVault("user-inactive")));
    await assertFails(updateDoc(vaultRef, { updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(vaultRef));
  });

  it("stores encrypted vault workspace state for its active notes owner with revision checks", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "users/admin-a"), userProfile("admin-a", { isAdmin: true, role: "admin" }));
      await setDoc(doc(db, "users/user-inactive"), userProfile("user-inactive", { isActive: false }));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const adminDb = testEnv.authenticatedContext("admin-a").firestore();
    const inactiveDb = testEnv.authenticatedContext("user-inactive").firestore();
    const workspaceRef = doc(ownerDb, "vaultWorkspaces/user-a");

    const missingWorkspace = await assertSucceeds(getDoc(workspaceRef));
    expect(missingWorkspace.exists()).toBe(false);
    await assertSucceeds(setDoc(workspaceRef, vaultWorkspace("user-a")));
    await assertSucceeds(getDoc(workspaceRef));
    await assertFails(getDocs(collection(ownerDb, "vaultWorkspaces")));
    await assertFails(getDoc(doc(otherDb, "vaultWorkspaces/user-a")));
    await assertFails(getDoc(doc(adminDb, "vaultWorkspaces/user-a")));
    await assertFails(setDoc(doc(otherDb, "vaultWorkspaces/user-a"), vaultWorkspace("user-a")));
    await assertFails(
      setDoc(doc(inactiveDb, "vaultWorkspaces/user-inactive"), vaultWorkspace("user-inactive"))
    );
    await assertSucceeds(
      updateDoc(workspaceRef, {
        encryptedState: { ...encryptedPayload, cipherText: "next-cipher" },
        revision: 2,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(workspaceRef, {
        encryptedState: { ...encryptedPayload, cipherText: "skipped-revision" },
        revision: 4,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(workspaceRef, {
        wrappedKey: { ...ownerWrappedShareKey, wrappedKey: "replaced-key" },
        revision: 3,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(deleteDoc(workspaceRef));
  });

  it("keeps encrypted path rewrite jobs owner-only and enforces crash-safe state transitions", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const jobId = `pr1_${"A".repeat(43)}`;
    const jobRef = doc(ownerDb, "vaultMaintenanceJobs", "user-a", "pathRewrites", jobId);
    const otherJobRef = doc(otherDb, "vaultMaintenanceJobs", "user-a", "pathRewrites", jobId);
    const jobsQuery = query(
      collection(ownerDb, "vaultMaintenanceJobs", "user-a", "pathRewrites"),
      where("status", "in", ["preparing", "prepared", "ready", "running", "blocked"]),
      limit(51)
    );

    await assertSucceeds(setDoc(jobRef, vaultPathRewriteJob("user-a", jobId)));
    await assertSucceeds(getDoc(jobRef));
    await assertSucceeds(getDocs(jobsQuery));
    await assertFails(getDoc(otherJobRef));
    await assertFails(getDocs(query(
      collection(otherDb, "vaultMaintenanceJobs", "user-a", "pathRewrites"),
      where("status", "in", ["preparing", "prepared", "ready", "running", "blocked"]),
      limit(51)
    )));
    await assertFails(setDoc(
      doc(ownerDb, "vaultMaintenanceJobs", "user-a", "pathRewrites", `pr1_${"B".repeat(43)}`),
      vaultPathRewriteJob("user-a", jobId)
    ));
    await assertFails(setDoc(
      doc(otherDb, "vaultMaintenanceJobs", "user-b", "pathRewrites", `pr1_${"C".repeat(43)}`),
      vaultPathRewriteJob("user-a", `pr1_${"C".repeat(43)}`)
    ));

    const stepZeroRef = doc(jobRef, "steps", "step-000000");
    await assertSucceeds(setDoc(stepZeroRef, vaultPathRewriteStep("user-a", jobId, 0)));
    await assertFails(setDoc(
      doc(jobRef, "steps", "step-000001"),
      vaultPathRewriteStep("user-a", jobId, 0)
    ));
    await assertFails(setDoc(
      doc(jobRef, "steps", "step-000002"),
      vaultPathRewriteStep("user-a", jobId, 2)
    ));
    await assertFails(setDoc(
      doc(jobRef, "steps", "forged-step"),
      { ...vaultPathRewriteStep("user-a", jobId, 1), stepId: "forged-step" }
    ));

    await assertSucceeds(updateDoc(jobRef, {
      status: "prepared",
      revision: 2,
      updatedAt: serverTimestamp()
    }));
    await assertFails(setDoc(
      doc(jobRef, "steps", "step-000001"),
      vaultPathRewriteStep("user-a", jobId, 1)
    ));
    await assertFails(updateDoc(stepZeroRef, { encryptedStep: { ...encryptedPayload, cipherText: "changed" } }));
    await assertFails(deleteDoc(stepZeroRef));
    await assertFails(updateDoc(jobRef, {
      status: "running",
      attemptCount: 1,
      revision: 3,
      lastAttemptAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));

    await assertSucceeds(updateDoc(jobRef, {
      status: "ready",
      revision: 3,
      activatedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(jobRef, {
      status: "running",
      attemptCount: 1,
      lastAttemptAt: serverTimestamp(),
      revision: 4,
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(jobRef, {
      cursor: 2,
      confirmedCount: 2,
      status: "completed",
      completedAt: serverTimestamp(),
      revision: 5,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(jobRef, {
      cursor: 1,
      confirmedCount: 1,
      revision: 5,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(jobRef, {
      cursor: 2,
      confirmedCount: 2,
      status: "completed",
      completedAt: serverTimestamp(),
      revision: 6,
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(jobRef, { revision: 7, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(jobRef));

    const recoveryJobId = `pr1_${"D".repeat(43)}`;
    const recoveryRef = doc(ownerDb, "vaultMaintenanceJobs", "user-a", "pathRewrites", recoveryJobId);
    await assertSucceeds(setDoc(recoveryRef, vaultPathRewriteJob("user-a", recoveryJobId, { stepCount: 1 })));
    await assertSucceeds(updateDoc(recoveryRef, {
      status: "prepared",
      revision: 2,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(recoveryRef, {
      status: "blocked",
      attemptCount: 1,
      retryCount: 1,
      lastErrorCode: "path-state-conflict",
      revision: 3,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(recoveryRef, {
      status: "prepared",
      lastErrorCode: null,
      revision: 4,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(recoveryRef, {
      status: "ready",
      revision: 5,
      activatedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));

    const directRecoveryJobId = `pr1_${"E".repeat(43)}`;
    const directRecoveryRef = doc(
      ownerDb,
      "vaultMaintenanceJobs",
      "user-a",
      "pathRewrites",
      directRecoveryJobId
    );
    await assertSucceeds(setDoc(
      directRecoveryRef,
      vaultPathRewriteJob("user-a", directRecoveryJobId, { stepCount: 1 })
    ));
    await assertSucceeds(updateDoc(directRecoveryRef, {
      status: "prepared",
      revision: 2,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(directRecoveryRef, {
      status: "blocked",
      attemptCount: 1,
      retryCount: 1,
      lastErrorCode: "path-state-conflict",
      revision: 3,
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(directRecoveryRef, {
      status: "ready",
      lastErrorCode: null,
      revision: 4,
      activatedAt: serverTimestamp(),
      recoveredAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
  });

  it("keeps direct missing-note reads closed while owner-and-import-job probes disclose nothing", async () => {
    const probeJobId = `vi1_${"P".repeat(43)}`;
    const ownedProbeJobId = `vi1_${"Q".repeat(43)}`;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "notes/foreign-deterministic-target"), {
        type: "personal",
        ownerUid: "user-b",
        participantUids: ["user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: { "user-b": ownerWrappedShareKey },
        vaultImportJobId: probeJobId,
        isDeleted: false,
        updatedBy: "user-b"
      });
      await setDoc(doc(db, "notes/owned-deterministic-target"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: { "user-a": ownerWrappedShareKey },
        vaultImportJobId: ownedProbeJobId,
        isDeleted: false,
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    await assertFails(getDoc(doc(ownerDb, "notes/missing-deterministic-target")));
    const missingProbe = await assertSucceeds(getDocs(query(
      collection(ownerDb, "notes"),
      where("ownerUid", "==", "user-a"),
      where("vaultImportJobId", "==", probeJobId),
      limit(2)
    )));
    expect(missingProbe.empty).toBe(true);

    await assertFails(getDoc(doc(ownerDb, "notes/foreign-deterministic-target")));
    const foreignHiddenProbe = await assertSucceeds(getDocs(query(
      collection(ownerDb, "notes"),
      where("ownerUid", "==", "user-a"),
      where("vaultImportJobId", "==", probeJobId),
      limit(2)
    )));
    expect(foreignHiddenProbe.empty).toBe(true);
    const ownedProbe = await assertSucceeds(getDocs(query(
      collection(ownerDb, "notes"),
      where("ownerUid", "==", "user-a"),
      where("vaultImportJobId", "==", ownedProbeJobId),
      limit(2)
    )));
    expect(ownedProbe.docs.map((document) => document.id)).toEqual([
      "owned-deterministic-target"
    ]);
    await assertFails(getDocs(query(
      collection(ownerDb, "notes"),
      where("ownerUid", "==", "user-b"),
      where("vaultImportJobId", "==", probeJobId),
      limit(2)
    )));
  });

  it("locks durable Vault import targets and placements until an exact rollback tombstones them", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b"));
      await setDoc(doc(db, "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
      // Recovery intentionally queries only active owned notes. A purged row
      // must not make that server-only query fail authorization.
      await setDoc(doc(db, "notes/purged-before-import"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: { "user-a": ownerWrappedShareKey },
        isDeleted: true,
        isPurged: true,
        purgedAt: new Date("2026-05-18T08:00:00.000Z"),
        purgedBy: "user-a",
        updatedBy: "user-a"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const jobId = `vi1_${"I".repeat(43)}`;
    const jobRef = doc(ownerDb, "vaultMaintenanceJobs", "user-a", "imports", jobId);
    const otherJobRef = doc(otherDb, "vaultMaintenanceJobs", "user-a", "imports", jobId);
    const chunkRef = doc(jobRef, "chunks", "chunk-000");

    await assertSucceeds(createAuditedVaultFolder(ownerDb, "ordinary-folder", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: null,
      order: 0,
      revision: 1,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(createAuditedNote(ownerDb, "ordinary-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: null,
      isDeleted: false
    }, ["user-a"]));

    await assertSucceeds(setDoc(jobRef, vaultImportJob("user-a", {
      itemCount: 3,
      entryCount: 1,
      folderCount: 2,
      rootFolderCount: 1
    })));
    await assertSucceeds(getDoc(jobRef));
    await assertFails(getDoc(otherJobRef));
    await assertSucceeds(getDocs(query(
      collection(ownerDb, "vaultMaintenanceJobs", "user-a", "imports"),
      where("status", "in", ["preparing", "staging", "rolling-back", "blocked"]),
      limit(21)
    )));
    await assertFails(getDocs(query(
      collection(otherDb, "vaultMaintenanceJobs", "user-a", "imports"),
      where("status", "in", ["preparing", "staging", "rolling-back", "blocked"]),
      limit(21)
    )));
    await assertFails(setDoc(
      doc(ownerDb, "vaultMaintenanceJobs", "user-a", "imports", `vi1_${"X".repeat(43)}`),
      vaultImportJob("user-a", { remainingChunkCount: 0 })
    ));
    await assertSucceeds(setDoc(chunkRef, vaultImportChunk("user-a", jobId, { itemCount: 3 })));
    await assertFails(updateDoc(chunkRef, {
      encryptedManifest: { ...encryptedPayload, cipherText: "changed" }
    }));
    await assertFails(deleteDoc(chunkRef));
    await assertFails(updateDoc(jobRef, {
      status: "committed",
      revision: 2,
      committedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(updateDoc(jobRef, {
      status: "staging",
      revision: 2,
      preparedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));

    // createRevisionedEncryptedNoteAtId deliberately does not probe a missing
    // note document. Its claim-first create uses a blind set, so prove that a
    // same-id collision is treated as an update and cannot attach an import
    // job or overwrite the original ciphertext/history/name reservation.
    const collisionClaimId = vaultTestClaimId("import-collision-at-ordinary-note");
    const collisionHistoryId = "import-collision-history";
    const collisionBatch = writeBatch(ownerDb);
    collisionBatch.set(doc(ownerDb, "notes/ordinary-note"), {
      attachmentRevision: 0,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      encryptedBody: { ...encryptedPayload, cipherText: "collision-body" },
      encryptedTitle: { ...encryptedPayload, cipherText: "collision-title" },
      folderId: null,
      isDeleted: false,
      lastMutationId: collisionHistoryId,
      ownerUid: "user-a",
      participantUids: ["user-a"],
      revision: 1,
      type: "personal",
      updatedBy: "user-a",
      vaultImportJobId: jobId,
      vaultNameClaimId: collisionClaimId,
      vaultNameIndexVersion: 1,
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      createdAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    collisionBatch.set(
      doc(ownerDb, "notes/ordinary-note/history", collisionHistoryId),
      noteHistory("ordinary-note", "user-a", {
        action: "create",
        changedFields: ["title", "body"],
        readerUids: ["user-a"],
        revision: 1
      })
    );
    collisionBatch.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", collisionClaimId),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "ordinary-note",
        targetType: "entry",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    await assertFails(collisionBatch.commit());
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const collisionOriginal = await getDoc(doc(db, "notes/ordinary-note"));
      expect(collisionOriginal.data()?.vaultImportJobId).toBeUndefined();
      expect(collisionOriginal.data()?.vaultNameClaimId).toBe(vaultTestClaimId("ordinary-note"));
      expect(collisionOriginal.data()?.encryptedTitle).toEqual(encryptedPayload);
      expect((await getDoc(
        doc(db, "notes/ordinary-note/history", collisionHistoryId)
      )).exists()).toBe(false);
      expect((await getDoc(
        doc(db, "vaultIntegrity", "user-a", "nameClaims", collisionClaimId)
      )).exists()).toBe(false);
    });

    await assertFails(setDoc(
      doc(jobRef, "chunks", "chunk-001"),
      vaultImportChunk("user-a", jobId, { ordinal: 1, itemCount: 1 })
    ));

    await assertSucceeds(createAuditedVaultFolder(ownerDb, "import-root", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: null,
      order: 1,
      revision: 1,
      vaultImportJobId: jobId,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(createAuditedVaultFolder(ownerDb, "import-child", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: "import-root",
      vaultAncestorIds: ["import-root"],
      vaultLineageDepth: 1,
      order: 2,
      revision: 1,
      vaultImportJobId: jobId,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(createAuditedNote(ownerDb, "import-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      vaultImportJobId: jobId,
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "import-child",
      isDeleted: false
    }, ["user-a"]));

    // No unrelated entry or folder may enter the subtree while the manifest
    // is live, even though the same owner controls both documents.
    await assertFails(createAuditedNote(ownerDb, "ordinary-in-import", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "import-root",
      isDeleted: false
    }, ["user-a"]));
    await assertFails(createAuditedVaultFolderDirect(ownerDb, "ordinary-in-import-folder", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: "import-root",
      order: 3,
      revision: 1,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateAuditedNote(
      ownerDb,
      "ordinary-note",
      "user-a",
      2,
      "content",
      ["folder"],
      ["user-a"],
      { folderId: "import-root", isDeleted: false }
    ));
    const ordinaryFolderMove = writeBatch(ownerDb);
    const ordinaryFolderOldClaim = vaultTestClaimId("folder:ordinary-folder");
    const ordinaryFolderMovedClaim = vaultTestClaimId("folder:ordinary-folder:moved");
    ordinaryFolderMove.update(doc(ownerDb, "noteFolders/ordinary-folder"), {
      parentId: "import-root",
      revision: 2,
      vaultNameClaimId: ordinaryFolderMovedClaim,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp()
    });
    ordinaryFolderMove.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", ordinaryFolderMovedClaim),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: "import-root",
        targetId: "ordinary-folder",
        targetType: "folder",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    ordinaryFolderMove.delete(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", ordinaryFolderOldClaim)
    );
    await assertFails(ordinaryFolderMove.commit());

    // Source locks also prevent another tab from editing or moving imported
    // descendants out after the server-complete rollback preflight.
    await assertFails(updateAuditedNote(
      ownerDb,
      "import-note",
      "user-a",
      2,
      "content",
      ["body"],
      ["user-a"],
      { encryptedBody: { ...encryptedPayload, cipherText: "edited" }, isDeleted: false }
    ));
    await assertFails(updateDoc(doc(ownerDb, "noteFolders/import-root"), {
      color: "#ff0000",
      revision: 2,
      updatedAt: serverTimestamp()
    }));

    const exactTrashImportRoot = () => {
      const batch = writeBatch(ownerDb);
      batch.update(doc(ownerDb, "noteFolders/import-root"), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a",
        revision: 2,
        vaultLineageGeneration: 2,
        updatedAt: serverTimestamp()
      });
      batch.delete(doc(
        ownerDb,
        "vaultIntegrity",
        "user-a",
        "nameClaims",
        vaultTestClaimId("folder:import-root")
      ));
      return batch.commit();
    };
    await assertFails(updateAuditedNote(
      ownerDb,
      "import-note",
      "user-a",
      2,
      "delete",
      ["deleted"],
      ["user-a"],
      {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a"
      }
    ));
    await assertFails(exactTrashImportRoot());

    await assertSucceeds(updateDoc(jobRef, {
      status: "blocked",
      revision: 3,
      lastErrorCode: "rollback-conflict",
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateAuditedNote(
      ownerDb,
      "import-note",
      "user-a",
      2,
      "delete",
      ["deleted"],
      ["user-a"],
      {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a"
      }
    ));
    await assertFails(exactTrashImportRoot());
    await assertSucceeds(updateDoc(jobRef, {
      status: "rolling-back",
      revision: 4,
      lastErrorCode: null,
      rollbackStartedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    const importedChildMove = writeBatch(ownerDb);
    const importedChildOldClaim = vaultTestClaimId("folder:import-child");
    const importedChildMovedClaim = vaultTestClaimId("folder:import-child:moved");
    importedChildMove.update(doc(ownerDb, "noteFolders/import-child"), {
      parentId: null,
      revision: 2,
      vaultNameClaimId: importedChildMovedClaim,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp()
    });
    importedChildMove.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", importedChildMovedClaim),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "import-child",
        targetType: "folder",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    importedChildMove.delete(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", importedChildOldClaim)
    );
    await assertFails(importedChildMove.commit());
    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "import-note",
      "user-a",
      2,
      "delete",
      ["deleted"],
      ["user-a"],
      {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a"
      }
    ));
    await seedServerVaultFolderLifecycle("user-a", "import-root", false);
    await assertSucceeds(updateDoc(jobRef, {
      status: "rolled-back",
      revision: 5,
      rolledBackAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));

    await assertFails(deleteDoc(jobRef));
    const cleanupChunk = writeBatch(ownerDb);
    cleanupChunk.delete(chunkRef);
    cleanupChunk.update(jobRef, {
      remainingChunkCount: 0,
      revision: 6,
      updatedAt: serverTimestamp()
    });
    await assertSucceeds(cleanupChunk.commit());
    await assertSucceeds(deleteDoc(jobRef));
    expect((await getDoc(jobRef)).exists()).toBe(false);

    await assertSucceeds(getDocs(query(
      collection(ownerDb, "notes"),
      where("ownerUid", "==", "user-a"),
      where("isDeleted", "==", false),
      limit(20_001)
    )));
  });

  it("unlocks committed import targets while keeping terminal manifest deletion bounded", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a"));
      await setDoc(doc(db, "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
    });
    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const jobId = `vi1_${"C".repeat(43)}`;
    const jobRef = doc(ownerDb, "vaultMaintenanceJobs", "user-a", "imports", jobId);
    const chunkRef = doc(jobRef, "chunks", "chunk-000");
    await assertSucceeds(setDoc(jobRef, vaultImportJob("user-a")));
    await assertSucceeds(setDoc(chunkRef, vaultImportChunk("user-a", jobId)));
    await assertSucceeds(updateDoc(jobRef, {
      status: "staging",
      revision: 2,
      preparedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(createAuditedVaultFolder(ownerDb, "committed-import-root", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: null,
      order: 1,
      revision: 1,
      vaultImportJobId: jobId,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(createAuditedNote(ownerDb, "committed-import-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      vaultImportJobId: jobId,
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "committed-import-root",
      isDeleted: false
    }, ["user-a"]));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "staging-import-locked",
      noteId: "committed-import-note"
    }));
    await assertSucceeds(updateDoc(jobRef, {
      status: "committed",
      revision: 3,
      committedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "noteFolders/committed-import-root"), {
      order: 2,
      revision: 2,
      updatedAt: serverTimestamp()
    }));
    // A terminal root cannot be removed first; the only accepted cleanup is
    // highest ordinal chunk + one counter revision, then the job document.
    await assertFails(deleteDoc(jobRef));
    await assertFails(deleteDoc(chunkRef));
    const cleanup = writeBatch(ownerDb);
    cleanup.delete(chunkRef);
    cleanup.update(jobRef, {
      remainingChunkCount: 0,
      revision: 4,
      updatedAt: serverTimestamp()
    });
    await assertSucceeds(cleanup.commit());
    await assertSucceeds(deleteDoc(jobRef));

    // Terminal cleanup removes the durable job but deliberately retains the
    // immutable provenance marker on each target. A later rename may replace
    // the blinded claim only when that before/after marker is unchanged.
    await assertSucceeds(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "post-cleanup-import-rename",
      noteId: "committed-import-note"
    }));
    const renamedImportedNote = await getDoc(doc(ownerDb, "notes/committed-import-note"));
    expect(renamedImportedNote.data()?.vaultImportJobId).toBe(jobId);
    expect(renamedImportedNote.data()?.revision).toBe(2);

    const missingJobId = `vi1_${"Z".repeat(43)}`;
    await assertFails(createAuditedNote(ownerDb, "forged-import-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      vaultImportJobId: missingJobId,
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: null,
      isDeleted: false
    }, ["user-a"]));

    await assertSucceeds(createAuditedNote(ownerDb, "post-commit-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "committed-import-root",
      isDeleted: false
    }, ["user-a"]));
    await assertSucceeds(createAuditedVaultFolder(ownerDb, "post-commit-folder", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: "committed-import-root",
      vaultAncestorIds: ["committed-import-root"],
      vaultLineageDepth: 1,
      order: 2,
      revision: 1,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
  });

  it("accepts the exact encrypted Vault create and immediate-save transactions without crossing the Rules expression budget", async () => {
    const sharedClaimId = vaultTestClaimId("real-shared-participant");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/user-a"), userProfile("user-a", {
        allowedShareTargetUids: ["user-a", "user-b"],
        featureAccess: featureAccess()
      }));
      await setDoc(doc(db, "users/user-b"), userProfile("user-b", {
        featureAccess: featureAccess()
      }));
      await setDoc(doc(db, "users/user-c"), userProfile("user-c", {
        featureAccess: featureAccess({ notes: false })
      }));
      await setDoc(doc(db, "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
      await setDoc(doc(db, "vaultIntegrity/user-b"), vaultIntegrity("user-b"));
      await setDoc(doc(db, "vaultIntegrity/user-c"), vaultIntegrity("user-c"));
      await setDoc(doc(db, "notes/real-shared-participant"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        vaultNameClaimId: sharedClaimId,
        vaultNameIndexVersion: 1,
        wrappedKeys: {
          "user-a": ownerWrappedShareKey,
          "user-b": ownerWrappedShareKey
        },
        folderId: null,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 1,
        lastMutationId: noteRevisionId(1),
        attachmentRevision: 0,
        isDeleted: false
      });
      await setDoc(doc(db, "vaultIntegrity", "user-a", "nameClaims", sharedClaimId), {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "real-shared-participant",
        targetType: "entry",
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    await assertSucceeds(createAuditedNote(ownerDb, "real-create-shape", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: null,
      isDeleted: false
    }, ["user-a"]));
    await assertSucceeds(updateExactAuditedVaultContent(ownerDb, {
      actorUid: "user-a",
      changedFields: ["body"],
      encryptedTitle: encryptedPayload,
      encryptedBody: { ...encryptedPayload, cipherText: "templated-body" },
      noteId: "real-create-shape",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a"],
      revision: 2
    }));
    await assertSucceeds(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "root-valid",
      noteId: "real-create-shape"
    }));
    const renamedTitle = { ...encryptedPayload, cipherText: "title-root-valid" };
    await assertSucceeds(updateExactAuditedVaultContent(ownerDb, {
      actorUid: "user-a",
      changedFields: ["body"],
      encryptedTitle: renamedTitle,
      encryptedBody: { ...encryptedPayload, cipherText: "body-only-save" },
      noteId: "real-create-shape",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a"],
      revision: 4
    }));

    await assertSucceeds(createAuditedVaultFolder(ownerDb, "real-create-folder", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId: null,
      order: 0,
      revision: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(createAuditedNote(ownerDb, "real-create-in-folder", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "real-create-folder",
      isDeleted: false
    }, ["user-a"]));
    await assertSucceeds(updateExactAuditedVaultContent(ownerDb, {
      actorUid: "user-a",
      changedFields: ["body"],
      encryptedTitle: encryptedPayload,
      encryptedBody: { ...encryptedPayload, cipherText: "nested-templated-body" },
      noteId: "real-create-in-folder",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a"],
      revision: 2
    }));
    await assertSucceeds(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "nested-valid",
      noteId: "real-create-in-folder"
    }));
    await assertSucceeds(updateExactAuditedVaultContent(ownerDb, {
      actorUid: "user-a",
      changedFields: ["body"],
      encryptedTitle: { ...encryptedPayload, cipherText: "title-nested-valid" },
      encryptedBody: { ...encryptedPayload, cipherText: "nested-body-only-save" },
      noteId: "real-create-in-folder",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a"],
      revision: 4
    }));

    await assertSucceeds(createAuditedNote(ownerDb, "title-only-negative", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "real-create-folder",
      isDeleted: false
    }, ["user-a"]));
    const negativeOriginalClaimId = vaultTestClaimId("title-only-negative");

    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "extra-body",
      encryptedBody: { ...encryptedPayload, cipherText: "unaudited-body" },
      noteId: "title-only-negative"
    }));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "extra-folder",
      folderId: null,
      noteId: "title-only-negative"
    }));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      access: {
        participantUids: ["user-a", "user-b"],
        type: "shared",
        wrappedKeys: {
          "user-a": ownerWrappedShareKey,
          "user-b": ownerWrappedShareKey
        }
      },
      caseId: "extra-access",
      noteId: "title-only-negative"
    }));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "old-claim-retained",
      deletePreviousClaim: false,
      noteId: "title-only-negative"
    }));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "new-claim-missing",
      createNewClaim: false,
      noteId: "title-only-negative"
    }));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "new-claim-wrong-target",
      newClaimTargetId: "different-entry",
      noteId: "title-only-negative"
    }));
    await assertFails(commitOwnerTitleOnlyNameMutation(ownerDb, {
      caseId: "history-mismatch",
      historyChangedFields: ["body", "name-claim"],
      noteId: "title-only-negative"
    }));

    const unchangedNegativeNote = await getDoc(doc(ownerDb, "notes/title-only-negative"));
    expect(unchangedNegativeNote.data()?.revision).toBe(1);
    expect(unchangedNegativeNote.data()?.vaultNameClaimId).toBe(negativeOriginalClaimId);
    expect((await getDoc(doc(
      ownerDb,
      "vaultIntegrity",
      "user-a",
      "nameClaims",
      negativeOriginalClaimId
    ))).exists()).toBe(true);

    const participantDb = testEnv.authenticatedContext("user-b").firestore();
    await assertSucceeds(updateExactAuditedVaultContent(participantDb, {
      actorUid: "user-b",
      changedFields: ["body"],
      encryptedTitle: encryptedPayload,
      encryptedBody: { ...encryptedPayload, cipherText: "participant-body-only" },
      noteId: "real-shared-participant",
      ownerSuppliesNameClaim: false,
      readerUids: ["user-a", "user-b"],
      revision: 2
    }));
    await assertFails(updateExactAuditedVaultContent(participantDb, {
      actorUid: "user-b",
      changedFields: ["title", "body"],
      encryptedTitle: { ...encryptedPayload, cipherText: "participant-title-change" },
      encryptedBody: { ...encryptedPayload, cipherText: "participant-body-change" },
      noteId: "real-shared-participant",
      ownerSuppliesNameClaim: false,
      readerUids: ["user-a", "user-b"],
      revision: 3
    }));

    const notesDisabledDb = testEnv.authenticatedContext("user-c").firestore();
    await assertFails(createAuditedNote(notesDisabledDb, "feature-blocked-create", "user-c", {
      type: "personal",
      ownerUid: "user-c",
      participantUids: ["user-c"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-c": ownerWrappedShareKey },
      folderId: null,
      isDeleted: false
    }, ["user-c"]));
  });

  it("treats a Vault marker created in the same batch as an active cutover boundary", async () => {
    const uid = "cutover-user";
    const existingNoteId = "cutover-existing-legacy";
    const legacyFolderId = "cutover-legacy-folder";
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, `users/${uid}`), userProfile(uid));
      await setDoc(doc(db, `notes/${existingNoteId}`), {
        type: "personal",
        ownerUid: uid,
        participantUids: [uid],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: { [uid]: ownerWrappedShareKey },
        folderId: null,
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: uid,
        revision: 1,
        lastMutationId: noteRevisionId(1)
      });
      await setDoc(doc(db, `noteFolders/${legacyFolderId}`), {
        ownerUid: uid,
        name: "marker 이전 폴더",
        color: "#2f7d70",
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });

    const db = testEnv.authenticatedContext(uid).firestore();
    const markerRef = doc(db, `vaultIntegrity/${uid}`);
    const marker = {
      ownerUid: uid,
      indexVersion: 1,
      wrappedKey: ownerWrappedShareKey,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const unclaimedVersionedId = "same-batch-unclaimed-versioned";
    const versionedHistoryId = noteRevisionId(1);
    const fakeClaimId = vaultTestClaimId(unclaimedVersionedId);
    const unclaimedVersionedBatch = writeBatch(db);
    unclaimedVersionedBatch.set(markerRef, marker);
    unclaimedVersionedBatch.set(doc(db, `notes/${unclaimedVersionedId}`), {
      type: "personal",
      ownerUid: uid,
      participantUids: [uid],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      attachmentRevision: 0,
      vaultNameClaimId: fakeClaimId,
      vaultNameIndexVersion: 1,
      wrappedKeys: { [uid]: ownerWrappedShareKey },
      folderId: null,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: uid,
      revision: 1,
      lastMutationId: versionedHistoryId
    });
    unclaimedVersionedBatch.set(
      doc(db, `notes/${unclaimedVersionedId}/history/${versionedHistoryId}`),
      noteHistory(unclaimedVersionedId, uid, {
        action: "create",
        changedFields: ["title", "body"],
        readerUids: [uid],
        revision: 1
      })
    );
    await assertFails(unclaimedVersionedBatch.commit());

    const legacyCreateId = "same-batch-legacy-create";
    const legacyCreateBatch = writeBatch(db);
    legacyCreateBatch.set(markerRef, marker);
    legacyCreateBatch.set(doc(db, `notes/${legacyCreateId}`), {
      type: "personal",
      ownerUid: uid,
      participantUids: [uid],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: { [uid]: ownerWrappedShareKey },
      folderId: null,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: uid,
      revision: 1,
      lastMutationId: noteRevisionId(1)
    });
    legacyCreateBatch.set(
      doc(db, `notes/${legacyCreateId}/history/${noteRevisionId(1)}`),
      noteHistory(legacyCreateId, uid, {
        action: "create",
        changedFields: ["title", "body"],
        readerUids: [uid],
        revision: 1
      })
    );
    await assertFails(legacyCreateBatch.commit());

    const legacyUpdateBatch = writeBatch(db);
    legacyUpdateBatch.set(markerRef, marker);
    legacyUpdateBatch.update(doc(db, `notes/${existingNoteId}`), {
      encryptedBody: { ...encryptedPayload, cipherText: "same-batch-cutover-body" },
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: uid,
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    legacyUpdateBatch.set(
      doc(db, `notes/${existingNoteId}/history/${noteRevisionId(2)}`),
      noteHistory(existingNoteId, uid, {
        changedFields: ["body"],
        readerUids: [uid],
        revision: 2
      })
    );
    await assertFails(legacyUpdateBatch.commit());

    const legacyFolderDeleteBatch = writeBatch(db);
    legacyFolderDeleteBatch.set(markerRef, marker);
    legacyFolderDeleteBatch.delete(doc(db, `noteFolders/${legacyFolderId}`));
    await assertFails(legacyFolderDeleteBatch.commit());
  });

  it("atomically reserves blinded Vault names across concurrent entry and folder mutations", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", {
        allowedShareTargetUids: ["user-a", "user-b"]
      }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "notes/unclaimed-entry"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        folderId: null,
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 1,
        lastMutationId: "legacy-revision-1"
      });
      await setDoc(doc(context.firestore(), "notes/collision-loser"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "legacy-html-v1",
        entryKind: "legacy-html",
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        folderId: null,
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 1,
        lastMutationId: "legacy-revision-1"
      });
      await setDoc(doc(context.firestore(), "notes/missing-deletion-metadata"), {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        folderId: null,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 1,
        lastMutationId: "legacy-revision-1"
      });
      await setDoc(doc(context.firestore(), "notes/shared-unclaimed"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        folderId: null,
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 1,
        lastMutationId: "legacy-revision-1"
      });
      await setDoc(doc(context.firestore(), "notes/shared-invalid-folder"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        folderId: "historical-folder",
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 1,
        lastMutationId: "legacy-revision-1"
      });
      for (const noteId of ["deleted-unclaimed", "deleted-unclaimed-conflict"]) {
        await setDoc(doc(context.firestore(), `notes/${noteId}`), {
          type: "personal",
          ownerUid: "user-a",
          participantUids: ["user-a"],
          encryptedTitle: encryptedPayload,
          encryptedBody: encryptedPayload,
          contentFormat: "legacy-html-v1",
          entryKind: "legacy-html",
          wrappedKeys: {
            "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
          },
          folderId: null,
          isDeleted: true,
          deletedAt: new Date("2026-05-18T08:30:00.000Z"),
          deletedBy: "user-a",
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedAt: new Date("2026-05-18T08:30:00.000Z"),
          savedAt: new Date("2026-05-18T08:00:00.000Z"),
          updatedBy: "user-a",
          revision: 4,
          lastMutationId: "legacy-delete-revision-4"
        });
      }
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const otherDb = testEnv.authenticatedContext("user-b").firestore();
    const integrityRef = doc(ownerDb, "vaultIntegrity/user-a");
    await assertSucceeds(setDoc(integrityRef, {
      ownerUid: "user-a",
      indexVersion: 1,
      wrappedKey: ownerWrappedShareKey,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(getDoc(integrityRef));
    await assertFails(getDoc(doc(otherDb, "vaultIntegrity/user-a")));
    await assertFails(updateDoc(integrityRef, { updatedAt: serverTimestamp() }));

    const backfillClaimId = vaultTestClaimId("unclaimed-entry");
    const backfillBatch = writeBatch(ownerDb);
    backfillBatch.update(doc(ownerDb, "notes/unclaimed-entry"), {
      vaultNameClaimId: backfillClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    backfillBatch.set(
      doc(ownerDb, "notes/unclaimed-entry/history", noteRevisionId(2)),
      noteHistory("unclaimed-entry", "user-a", {
        action: "content",
        changedFields: ["name-claim"],
        readerUids: ["user-a"],
        revision: 2
      })
    );
    backfillBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", backfillClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: null,
      targetId: "unclaimed-entry",
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertSucceeds(backfillBatch.commit());

    await assertSucceeds(updateDoc(doc(ownerDb, "notes/missing-deletion-metadata"), {
      isDeleted: false
    }));
    await assertFails(updateDoc(doc(otherDb, "notes/missing-deletion-metadata"), {
      isDeleted: false
    }));

    const recoveryClaimId = vaultTestClaimId("collision-loser-recovered");
    const invalidRecoveryBatch = writeBatch(ownerDb);
    invalidRecoveryBatch.update(doc(ownerDb, "notes/collision-loser"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "replacement-title" },
      encryptedBody: { ...encryptedPayload, cipherText: "forbidden-body-rewrite" },
      vaultNameClaimId: recoveryClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    invalidRecoveryBatch.set(
      doc(ownerDb, "notes/collision-loser/history", noteRevisionId(2)),
      noteHistory("collision-loser", "user-a", {
        action: "content",
        changedFields: ["title", "body", "name-claim"],
        readerUids: ["user-a"],
        revision: 2
      })
    );
    invalidRecoveryBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", recoveryClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: null,
      targetId: "collision-loser",
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertFails(invalidRecoveryBatch.commit());

    const recoveryBatch = writeBatch(ownerDb);
    recoveryBatch.update(doc(ownerDb, "notes/collision-loser"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "replacement-title" },
      vaultNameClaimId: recoveryClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    recoveryBatch.set(
      doc(ownerDb, "notes/collision-loser/history", noteRevisionId(2)),
      noteHistory("collision-loser", "user-a", {
        action: "content",
        changedFields: ["title", "name-claim"],
        readerUids: ["user-a"],
        revision: 2
      })
    );
    recoveryBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", recoveryClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: null,
      targetId: "collision-loser",
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertSucceeds(recoveryBatch.commit());

    const sharedClaimId = vaultTestClaimId("shared-unclaimed");
    const sharedBackfillBatch = writeBatch(ownerDb);
    sharedBackfillBatch.update(doc(ownerDb, "notes/shared-unclaimed"), {
      vaultNameClaimId: sharedClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    sharedBackfillBatch.set(
      doc(ownerDb, "notes/shared-unclaimed/history", noteRevisionId(2)),
      noteHistory("shared-unclaimed", "user-a", {
        action: "content",
        changedFields: ["name-claim"],
        readerUids: ["user-a", "user-b"],
        revision: 2
      })
    );
    sharedBackfillBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", sharedClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: null,
      targetId: "shared-unclaimed",
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertSucceeds(sharedBackfillBatch.commit());

    const participantBodyBatch = writeBatch(otherDb);
    participantBodyBatch.update(doc(otherDb, "notes/shared-unclaimed"), {
      encryptedBody: { ...encryptedPayload, cipherText: "participant-body" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 3,
      lastMutationId: noteRevisionId(3)
    });
    participantBodyBatch.set(
      doc(otherDb, "notes/shared-unclaimed/history", noteRevisionId(3)),
      noteHistory("shared-unclaimed", "user-b", {
        action: "content",
        changedFields: ["body"],
        readerUids: ["user-a", "user-b"],
        revision: 3
      })
    );
    await assertSucceeds(participantBodyBatch.commit());

    const participantTitleBatch = writeBatch(otherDb);
    participantTitleBatch.update(doc(otherDb, "notes/shared-unclaimed"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "participant-title" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 4,
      lastMutationId: noteRevisionId(4)
    });
    participantTitleBatch.set(
      doc(otherDb, "notes/shared-unclaimed/history", noteRevisionId(4)),
      noteHistory("shared-unclaimed", "user-b", {
        action: "content",
        changedFields: ["title"],
        readerUids: ["user-a", "user-b"],
        revision: 4
      })
    );
    await assertFails(participantTitleBatch.commit());

    const sharedFolderRepairClaimId = vaultTestClaimId("shared-invalid-folder-root");
    const sharedFolderRepairBatch = writeBatch(ownerDb);
    sharedFolderRepairBatch.update(doc(ownerDb, "notes/shared-invalid-folder"), {
      folderId: null,
      vaultNameClaimId: sharedFolderRepairClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    sharedFolderRepairBatch.set(
      doc(ownerDb, "notes/shared-invalid-folder/history", noteRevisionId(2)),
      noteHistory("shared-invalid-folder", "user-a", {
        action: "content",
        changedFields: ["folder", "name-claim"],
        readerUids: ["user-a", "user-b"],
        revision: 2
      })
    );
    sharedFolderRepairBatch.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", sharedFolderRepairClaimId),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "shared-invalid-folder",
        targetType: "entry",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    await assertSucceeds(sharedFolderRepairBatch.commit());

    const restoredClaimId = vaultTestClaimId("deleted-unclaimed-restored");
    const restoreLegacyDeletedBatch = writeBatch(ownerDb);
    restoreLegacyDeletedBatch.update(doc(ownerDb, "notes/deleted-unclaimed"), {
      isDeleted: false,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      vaultNameClaimId: restoredClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 5,
      lastMutationId: noteRevisionId(5)
    });
    restoreLegacyDeletedBatch.set(
      doc(ownerDb, "notes/deleted-unclaimed/history", noteRevisionId(5)),
      noteHistory("deleted-unclaimed", "user-a", {
        action: "restore",
        changedFields: ["restored", "name-claim"],
        readerUids: ["user-a"],
        revision: 5
      })
    );
    restoreLegacyDeletedBatch.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", restoredClaimId),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "deleted-unclaimed",
        targetType: "entry",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    await assertSucceeds(restoreLegacyDeletedBatch.commit());

    const conflictingRestoreBatch = writeBatch(ownerDb);
    conflictingRestoreBatch.update(doc(ownerDb, "notes/deleted-unclaimed-conflict"), {
      isDeleted: false,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      vaultNameClaimId: restoredClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 5,
      lastMutationId: noteRevisionId(5)
    });
    conflictingRestoreBatch.set(
      doc(ownerDb, "notes/deleted-unclaimed-conflict/history", noteRevisionId(5)),
      noteHistory("deleted-unclaimed-conflict", "user-a", {
        action: "restore",
        changedFields: ["restored", "name-claim"],
        readerUids: ["user-a"],
        revision: 5
      })
    );
    conflictingRestoreBatch.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", restoredClaimId),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "deleted-unclaimed-conflict",
        targetType: "entry",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    await assertFails(conflictingRestoreBatch.commit());

    await assertFails(createAuditedNote(ownerDb, "legacy-after-cutover", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      folderId: null,
      isDeleted: false
    }, ["user-a"]));

    const versionedNote = {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      folderId: null,
      isDeleted: false
    };
    const missingClaimId = vaultTestClaimId("missing-claim-entry");
    const missingClaimBatch = writeBatch(ownerDb);
    missingClaimBatch.set(doc(ownerDb, "notes/missing-claim-entry"), {
      ...versionedNote,
      vaultNameClaimId: missingClaimId,
      vaultNameIndexVersion: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 1,
      lastMutationId: noteRevisionId(1)
    });
    missingClaimBatch.set(
      doc(ownerDb, "notes/missing-claim-entry/history", noteRevisionId(1)),
      noteHistory("missing-claim-entry", "user-a", {
        action: "create",
        changedFields: ["title", "body"],
        readerUids: ["user-a"],
        revision: 1
      })
    );
    await assertFails(missingClaimBatch.commit());

    await assertSucceeds(createAuditedNote(
      ownerDb,
      "claimed-entry",
      "user-a",
      versionedNote,
      ["user-a"]
    ));

    const firstClaimId = vaultTestClaimId("claimed-entry");
    const duplicateBatch = writeBatch(ownerDb);
    duplicateBatch.set(doc(ownerDb, "notes/duplicate-entry"), {
      ...versionedNote,
      vaultNameClaimId: firstClaimId,
      vaultNameIndexVersion: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 1,
      lastMutationId: noteRevisionId(1)
    });
    duplicateBatch.set(
      doc(ownerDb, "notes/duplicate-entry/history", noteRevisionId(1)),
      noteHistory("duplicate-entry", "user-a", {
        action: "create",
        changedFields: ["title", "body"],
        readerUids: ["user-a"],
        revision: 1
      })
    );
    duplicateBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", firstClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: null,
      targetId: "duplicate-entry",
      targetType: "entry",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertFails(duplicateBatch.commit());

    const staleRenameBatch = writeBatch(ownerDb);
    staleRenameBatch.update(doc(ownerDb, "notes/claimed-entry"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "stale-rename" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    staleRenameBatch.set(
      doc(ownerDb, "notes/claimed-entry/history", noteRevisionId(2)),
      noteHistory("claimed-entry", "user-a", {
        action: "content",
        changedFields: ["title"],
        readerUids: ["user-a"],
        revision: 2
      })
    );
    await assertFails(staleRenameBatch.commit());

    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "claimed-entry",
      "user-a",
      2,
      "content",
      ["title"],
      ["user-a"],
      { encryptedTitle: { ...encryptedPayload, cipherText: "renamed" }, isDeleted: false }
    ));
    const renamedEntry = await getDoc(doc(ownerDb, "notes/claimed-entry"));
    const renamedClaimId = renamedEntry.data()?.vaultNameClaimId as string;
    expect(renamedClaimId).not.toBe(firstClaimId);
    expect((await assertSucceeds(getDoc(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", firstClaimId)))).exists())
      .toBe(false);

    const deleteWithoutRelease = writeBatch(ownerDb);
    deleteWithoutRelease.update(doc(ownerDb, "notes/claimed-entry"), {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: "user-a",
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 3,
      lastMutationId: noteRevisionId(3)
    });
    deleteWithoutRelease.set(
      doc(ownerDb, "notes/claimed-entry/history", noteRevisionId(3)),
      noteHistory("claimed-entry", "user-a", {
        action: "delete",
        changedFields: ["deleted"],
        readerUids: ["user-a"],
        revision: 3
      })
    );
    await assertFails(deleteWithoutRelease.commit());

    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "claimed-entry",
      "user-a",
      3,
      "delete",
      ["deleted"],
      ["user-a"],
      {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a"
      }
    ));
    expect((await assertSucceeds(getDoc(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", renamedClaimId)))).exists())
      .toBe(false);

    const restoreWithoutClaim = writeBatch(ownerDb);
    restoreWithoutClaim.update(doc(ownerDb, "notes/claimed-entry"), {
      isDeleted: false,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 4,
      lastMutationId: noteRevisionId(4)
    });
    restoreWithoutClaim.set(
      doc(ownerDb, "notes/claimed-entry/history", noteRevisionId(4)),
      noteHistory("claimed-entry", "user-a", {
        action: "restore",
        changedFields: ["restored"],
        readerUids: ["user-a"],
        revision: 4
      })
    );
    await assertFails(restoreWithoutClaim.commit());

    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "claimed-entry",
      "user-a",
      4,
      "restore",
      ["restored"],
      ["user-a"],
      {
        isDeleted: false,
        deletedAt: deleteField(),
        deletedBy: deleteField()
      }
    ));
    expect((await assertSucceeds(getDoc(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", renamedClaimId)))).exists())
      .toBe(true);

    await assertSucceeds(createAuditedVaultFolder(ownerDb, "claimed-folder", "user-a", {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
      parentId: null,
      order: 0,
      revision: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(setDoc(doc(ownerDb, "noteFolders/missing-claim-folder"), {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
      parentId: null,
      order: 1,
      revision: 1,
      vaultNameClaimId: vaultTestClaimId("folder:missing-claim-folder"),
      vaultNameIndexVersion: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
    const folderClaimId = vaultTestClaimId("folder:claimed-folder");
    const duplicateFolderBatch = writeBatch(ownerDb);
    duplicateFolderBatch.set(doc(ownerDb, "noteFolders/duplicate-folder"), {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
      parentId: null,
      order: 1,
      revision: 1,
      vaultNameClaimId: folderClaimId,
      vaultNameIndexVersion: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    duplicateFolderBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", folderClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: null,
      targetId: "duplicate-folder",
      targetType: "folder",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertFails(duplicateFolderBatch.commit());
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
    await assertSucceeds(updateDoc(doc(ownerDb, "scheduleTasks/task-a"), {
      encryptedCategory: JSON.stringify(encryptedPayload),
      updatedBy: "user-a",
      updatedAt: serverTimestamp()
    }));
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

  it("allows production-shaped self and approved-owner note subscriptions while rejecting revoked owner scopes", async () => {
    const profileTimestamp = new Date("2026-05-18T07:00:00.000Z");
    const noteTimestamp = new Date("2026-05-18T08:00:00.000Z");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/new-user"), userProfile("new-user", {
        allowedShareTargetUids: ["new-user"],
        featureAccess: featureAccess(),
        createdAt: profileTimestamp,
        updatedAt: profileTimestamp
      }));
      await setDoc(doc(db, "users/approved-owner"), userProfile("approved-owner", {
        allowedShareTargetUids: ["approved-owner", "new-user"],
        featureAccess: featureAccess(),
        createdAt: profileTimestamp,
        updatedAt: profileTimestamp
      }));
      await setDoc(doc(db, "users/revoked-owner"), userProfile("revoked-owner", {
        allowedShareTargetUids: ["revoked-owner"],
        featureAccess: featureAccess(),
        createdAt: profileTimestamp,
        updatedAt: profileTimestamp
      }));
      const sharedNote = (ownerUid: string) => ({
        type: "shared",
        ownerUid,
        participantUids: [ownerUid, "new-user"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        wrappedKeys: {
          [ownerUid]: ownerWrappedShareKey,
          "new-user": ownerWrappedShareKey
        },
        folderId: null,
        createdAt: noteTimestamp,
        updatedAt: noteTimestamp,
        savedAt: noteTimestamp,
        updatedBy: ownerUid,
        revision: 1,
        lastMutationId: noteRevisionId(1),
        attachmentRevision: 0,
        isDeleted: false
      });
      await setDoc(doc(db, "notes/approved-shared-note"), sharedNote("approved-owner"));
      await setDoc(doc(db, "notes/revoked-shared-note"), sharedNote("revoked-owner"));
    });

    const newUserDb = testEnv.authenticatedContext("new-user").firestore();
    const visibleOwnerNotes = (ownerUid: string) => query(
      collection(newUserDb, "notes"),
      where("ownerUid", "==", ownerUid),
      where("isDeleted", "==", false),
      where("participantUids", "array-contains", "new-user"),
      orderBy("updatedAt", "desc"),
      limit(80)
    );

    await assertSucceeds(getDocs(visibleOwnerNotes("new-user")));
    await assertSucceeds(getDocs(visibleOwnerNotes("approved-owner")));
    await assertSucceeds(getDoc(doc(newUserDb, "notes/approved-shared-note")));
    await assertFails(getDocs(visibleOwnerNotes("revoked-owner")));
    await assertFails(getDoc(doc(newUserDb, "notes/revoked-shared-note")));
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
    await assertSucceeds(
      getDocs(
        query(
          collection(ownerDb, "publicNoteShares"),
          where("ownerUid", "==", "user-a"),
          where("version", "==", 1),
          where("ready", "==", true),
          where("expiresAt", ">", new Date()),
          orderBy("expiresAt", "asc"),
          limit(500)
        )
      )
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

  it("keeps secure share v2 content and server state behind the server API", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

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
        revision: 1,
        attachmentRevision: 0,
        isDeleted: false,
        updatedBy: "user-a"
      });
      await setDoc(doc(db, "publicNoteShares/secure-v2"), {
        ...publicShareDocument("note-a", "user-a", {
          attachmentCount: 1,
          createdAt: new Date("2026-07-28T00:00:00.000Z"),
          expiresAt,
          ready: true,
          updatedAt: new Date("2026-07-28T00:00:00.000Z")
        }),
        schemaVersion: 2,
        policyVersion: 1,
        status: "active"
      });
      await setDoc(
        doc(db, "publicNoteShares/secure-v2/attachments/attachment-a"),
        publicShareAttachment({
          createdAt: new Date("2026-07-28T00:00:00.000Z"),
          expiresAt
        })
      );
      await setDoc(doc(db, "publicSharePolicies/secure-v2"), {
        ownerUid: "user-a",
        policyVersion: 1
      });
      await setDoc(doc(db, "publicShareRecipients/secure-v2/items/recipient-a"), {
        emailHash: "server-only"
      });
      await setDoc(doc(db, "publicShareAccessSessions/session-a"), {
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareEmailChallenges/challenge-a"), {
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareEmailQuotaBuckets/day-2026-07-29"), {
        scope: "daily"
      });
      await setDoc(doc(db, "publicShareEmailDeliveries/delivery-a"), {
        ownerUid: "user-a",
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareEmailSendAttempts/attempt-a"), {
        ownerUid: "user-a",
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareEmailProviderHealth/gmail-smtp"), {
        status: "healthy"
      });
      await setDoc(doc(db, "secureShareEmailSettings/current"), {
        enabled: false,
        schemaVersion: 1
      });
      await setDoc(doc(db, "secureShareEmailAdminAudit/event-a"), {
        action: "stage"
      });
      await setDoc(doc(db, "secureShareEmailAdminRateLimits/rate-a"), {
        count: 1
      });
      await setDoc(doc(db, "secureShareEmailAdminIdempotency/request-a"), {
        action: "stage"
      });
      await setDoc(doc(db, "publicShareCopyGrantRequests/request-a"), {
        ownerUid: "user-a",
        requesterUid: "user-b",
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareSourceGuards/source-a"), {
        ownerUid: "user-a",
        shareId: "secure-v2",
        sourceNoteId: "note-a"
      });
      await setDoc(doc(db, "publicShareUnlockGrants/grant-a"), {
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareRateLimits/rate-a"), {
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareComments/secure-v2/items/comment-a"), {
        body: "server only"
      });
      await setDoc(doc(db, "publicShareParticipants/secure-v2/items/participant-a"), {
        displayName: "guest1",
        participantId: "participant-a",
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareParticipantNames/secure-v2/items/name-a"), {
        participantId: "participant-a",
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareParticipantRenameRequests/secure-v2/items/request-a"), {
        participantId: "participant-a",
        shareId: "secure-v2",
        status: "succeeded"
      });
      await setDoc(doc(db, "publicShareParticipantCounters/secure-v2"), {
        nextGuestNumber: 2,
        participantCount: 1,
        shareId: "secure-v2"
      });
      await setDoc(doc(db, "publicShareAuditEvents/secure-v2/items/event-a"), {
        eventType: "access"
      });
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const publicDb = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(publicDb, "publicNoteShares/secure-v2")));
    await assertSucceeds(getDoc(doc(ownerDb, "publicNoteShares/secure-v2")));
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/secure-v2/attachments/attachment-a")));
    await assertSucceeds(getDoc(doc(ownerDb, "publicNoteShares/secure-v2/attachments/attachment-a")));
    await assertFails(updateDoc(doc(ownerDb, "publicNoteShares/secure-v2"), {
      encryptedBody: { ...encryptedPayload, cipherText: "direct-write" },
      updatedAt: serverTimestamp()
    }));
    await assertFails(updateDoc(doc(ownerDb, "publicNoteShares/secure-v2"), {
      schemaVersion: deleteField(),
      updatedAt: serverTimestamp()
    }));
    await assertFails(deleteDoc(doc(ownerDb, "publicNoteShares/secure-v2")));

    for (const path of [
      "publicSharePolicies/secure-v2",
      "publicShareRecipients/secure-v2/items/recipient-a",
      "publicShareAccessSessions/session-a",
      "publicShareEmailChallenges/challenge-a",
      "publicShareEmailQuotaBuckets/day-2026-07-29",
      "publicShareEmailDeliveries/delivery-a",
      "publicShareEmailSendAttempts/attempt-a",
      "publicShareEmailProviderHealth/gmail-smtp",
      "secureShareEmailSettings/current",
      "secureShareEmailAdminAudit/event-a",
      "secureShareEmailAdminRateLimits/rate-a",
      "secureShareEmailAdminIdempotency/request-a",
      "publicShareCopyGrantRequests/request-a",
      "publicShareSourceGuards/source-a",
      "publicShareUnlockGrants/grant-a",
      "publicShareRateLimits/rate-a",
      "publicShareComments/secure-v2/items/comment-a",
      "publicShareParticipants/secure-v2/items/participant-a",
      "publicShareParticipantNames/secure-v2/items/name-a",
      "publicShareParticipantRenameRequests/secure-v2/items/request-a",
      "publicShareParticipantCounters/secure-v2",
      "publicShareAuditEvents/secure-v2/items/event-a"
    ]) {
      await assertFails(getDoc(doc(ownerDb, path)));
      await assertFails(getDoc(doc(publicDb, path)));
      await assertFails(setDoc(doc(ownerDb, path), { forged: true }));
    }
  });

  it("preserves the last-good v1 snapshot on source revision drift while keeping owner flips revision-bound", async () => {
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
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
    await assertSucceeds(
      getDoc(doc(publicDb, "publicNoteShares/share-revision-bound/attachments/generation-a"))
    );
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
    await assertSucceeds(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
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
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
    await assertFails(
      updateDoc(doc(ownerDb, "publicNoteShares/share-revision-bound/attachments/pending-ready"), { isReady: true })
    );
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/note-a"), { isDeleted: false });
    });
    await assertSucceeds(
      updateDoc(shareRef, { revokedAt: serverTimestamp(), revokedBy: "user-a", updatedAt: serverTimestamp() })
    );
    await assertFails(getDoc(doc(publicDb, "publicNoteShares/share-revision-bound")));
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

  it("uses one server tree lookup for deep notes and denies direct topology forgery", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
    });
    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const base = {
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      order: 0,
      revision: 1,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    await createAuditedVaultFolder(ownerDb, "deep-a", "user-a", {
      ...base, parentId: null, vaultAncestorIds: []
    });
    await createAuditedVaultFolder(ownerDb, "deep-b", "user-a", {
      ...base, parentId: "deep-a", vaultAncestorIds: ["deep-a"]
    });
    await createAuditedVaultFolder(ownerDb, "deep-c", "user-a", {
      ...base, parentId: "deep-b", vaultAncestorIds: ["deep-a", "deep-b"]
    });
    await createAuditedVaultFolder(ownerDb, "deep-d", "user-a", {
      ...base, parentId: "deep-c", vaultAncestorIds: ["deep-a", "deep-b", "deep-c"]
    });
    await assertSucceeds(createAuditedNote(ownerDb, "deep-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "deep-d",
      isDeleted: false
    }, ["user-a"]));

    await assertFails(getDoc(doc(ownerDb, "vaultFolderTrees/user-a")));
    await assertFails(updateDoc(doc(ownerDb, "vaultFolderTrees/user-a"), {
      "nodes.deep-a.parentId": "deep-d"
    }));
    await assertFails(updateDoc(doc(ownerDb, "noteFolders/deep-a"), {
      parentId: "deep-d",
      revision: 2,
      vaultAncestorIds: ["deep-b", "deep-c", "deep-d"],
      vaultLineageDepth: 3,
      vaultLineageGeneration: 2,
      vaultLineagePath: "deep-b/deep-c/deep-d/deep-a",
      updatedAt: serverTimestamp()
    }));
    await assertFails(createAuditedVaultFolderDirect(ownerDb, "direct-folder", "user-a", {
      ...base,
      parentId: null,
      vaultAncestorIds: []
    }));

    await seedServerVaultFolderLifecycle("user-a", "deep-a", false);
    await assertFails(updateAuditedNote(
      ownerDb,
      "deep-note",
      "user-a",
      2,
      "content",
      ["body"],
      ["user-a"],
      { encryptedBody: { ...encryptedPayload, cipherText: "blocked" }, isDeleted: false }
    ));
  });

  it("rejects forged deep lineage, three-node cycles, and writes below a tombstoned ancestor", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", {
        allowedShareTargetUids: ["user-a", "user-b"]
      }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const folder = (parentId: string | null, ancestorIds: string[], order: number) => ({
      ownerUid: "user-a",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: ownerWrappedShareKey,
      parentId,
      order,
      revision: 1,
      vaultAncestorIds: ancestorIds,
      vaultLineageDepth: ancestorIds.length,
      vaultLineageGeneration: 1,
      vaultLineageVersion: 3,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    await assertSucceeds(createAuditedVaultFolder(ownerDb, "lineage-a", "user-a", folder(null, [], 0)));
    await assertSucceeds(createAuditedVaultFolder(ownerDb, "lineage-b", "user-a", folder("lineage-a", ["lineage-a"], 1)));
    await assertSucceeds(createAuditedVaultFolder(ownerDb, "lineage-root-d", "user-a", folder(null, [], 2)));
    await assertSucceeds(createAuditedNote(ownerDb, "lineage-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "lineage-b",
      isDeleted: false
    }, ["user-a"]));
    await assertSucceeds(createAuditedNote(ownerDb, "lineage-deleted-note", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "lineage-b",
      isDeleted: false
    }, ["user-a"]));
    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "lineage-deleted-note",
      "user-a",
      2,
      "delete",
      ["deleted"],
      ["user-a"],
      { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: "user-a" }
    ));
    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "lineage-deleted-note",
      "user-a",
      3,
      "restore",
      ["restored"],
      ["user-a"],
      { isDeleted: false, deletedAt: deleteField(), deletedBy: deleteField() }
    ));
    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "lineage-deleted-note",
      "user-a",
      4,
      "delete",
      ["deleted"],
      ["user-a"],
      { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: "user-a" }
    ));

    // Seed a pre-contract shared note in the nested folder. Current product
    // flows do not place a newly shared note there, but a participant must not
    // be able to use that historical shape to bypass a later ancestor tombstone.
    const sharedClaimId = vaultTestClaimId("lineage-shared-note");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "notes/lineage-shared-note"), {
        type: "shared",
        ownerUid: "user-a",
        participantUids: ["user-a", "user-b"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        wrappedKeys: {
          "user-a": ownerWrappedShareKey,
          "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
        },
        folderId: "lineage-b",
        attachmentRevision: 0,
        vaultNameClaimId: sharedClaimId,
        vaultNameIndexVersion: 1,
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z"),
        savedAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedBy: "user-a",
        revision: 3,
        lastMutationId: "seeded-pre-contract-shared-note"
      });
      await setDoc(doc(
        context.firestore(),
        "vaultIntegrity",
        "user-a",
        "nameClaims",
        sharedClaimId
      ), {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: "lineage-b",
        targetId: "lineage-shared-note",
        targetType: "entry",
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z")
      });
    });
    const participantDb = testEnv.authenticatedContext("user-b").firestore();

    // Simulate a deeper pre-contract folder that may exist during dual-read.
    // The new Rules must not let a direct owner SDK use it to complete a cycle.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "noteFolders/lineage-c"),
        folder("lineage-b", ["lineage-a", "lineage-b"], 2)
      );
    });

    // A root may already have children, which Rules cannot enumerate. Moving
    // it below another root would silently turn those children into a depth-two
    // tree, so the v1 contract rejects even an otherwise complete direct-SDK
    // move/name-claim transaction.
    const rootMoveClaimId = vaultTestClaimId("folder:lineage-a:root-move");
    const forgedRootMove = writeBatch(ownerDb);
    forgedRootMove.update(doc(ownerDb, "noteFolders/lineage-a"), {
      parentId: "lineage-root-d",
      revision: 2,
      vaultAncestorIds: ["lineage-root-d"],
      vaultLineageDepth: 1,
      vaultLineageGeneration: 2,
      vaultNameClaimId: rootMoveClaimId,
      updatedAt: serverTimestamp()
    });
    forgedRootMove.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", rootMoveClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: "lineage-root-d",
      targetId: "lineage-a",
      targetType: "folder",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    forgedRootMove.delete(doc(
      ownerDb,
      "vaultIntegrity",
      "user-a",
      "nameClaims",
      vaultTestClaimId("folder:lineage-a")
    ));
    await assertFails(forgedRootMove.commit());

    const cycleClaimId = vaultTestClaimId("folder:lineage-a:cycle");
    const forgedCycle = writeBatch(ownerDb);
    forgedCycle.update(doc(ownerDb, "noteFolders/lineage-a"), {
      parentId: "lineage-c",
      revision: 2,
      vaultAncestorIds: ["lineage-b", "lineage-c"],
      vaultLineageDepth: 2,
      vaultLineageGeneration: 2,
      vaultNameClaimId: cycleClaimId,
      updatedAt: serverTimestamp()
    });
    forgedCycle.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", cycleClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: "lineage-c",
      targetId: "lineage-a",
      targetType: "folder",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    forgedCycle.delete(doc(
      ownerDb,
      "vaultIntegrity",
      "user-a",
      "nameClaims",
      vaultTestClaimId("folder:lineage-a")
    ));
    await assertFails(forgedCycle.commit());

    await assertFails(createAuditedVaultFolderDirect(
      ownerDb,
      "forged-short-lineage",
      "user-a",
      {
        ...folder("lineage-b", ["lineage-a"], 3),
        vaultLineageDepth: 1,
        vaultLineagePath: "lineage-a/forged-short-lineage"
      }
    ));

    const forgedRootLifecycle = writeBatch(ownerDb);
    forgedRootLifecycle.update(doc(ownerDb, "noteFolders/lineage-a"), {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: "user-a",
      revision: 2,
      vaultAncestorIds: ["lineage-b"],
      vaultLineageDepth: 1,
      vaultLineageGeneration: 2,
      updatedAt: serverTimestamp()
    });
    forgedRootLifecycle.delete(doc(
      ownerDb,
      "vaultIntegrity",
      "user-a",
      "nameClaims",
      vaultTestClaimId("folder:lineage-a")
    ));
    await assertFails(forgedRootLifecycle.commit());

    // Browser SDK lifecycle writes are denied. Seed the exact state that the
    // authenticated Vercel transaction commits and verify descendants fail
    // closed from the central authoritative map.
    await seedServerVaultFolderLifecycle("user-a", "lineage-a", false);

    await assertFails(createAuditedNote(ownerDb, "hidden-descendant-write", "user-a", {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      folderId: "lineage-b",
      isDeleted: false
    }, ["user-a"]));
    await assertFails(updateExactAuditedVaultContent(ownerDb, {
      actorUid: "user-a",
      changedFields: ["body"],
      encryptedTitle: encryptedPayload,
      encryptedBody: { ...encryptedPayload, cipherText: "blocked-under-deleted-ancestor" },
      noteId: "lineage-note",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a"],
      revision: 2
    }));
    await assertFails(updateAuditedNote(
      ownerDb,
      "lineage-deleted-note",
      "user-a",
      5,
      "restore",
      ["restored"],
      ["user-a"],
      { isDeleted: false, deletedAt: deleteField(), deletedBy: deleteField() }
    ));
    await assertFails(updateExactAuditedVaultContent(participantDb, {
      actorUid: "user-b",
      changedFields: ["body"],
      encryptedTitle: encryptedPayload,
      encryptedBody: { ...encryptedPayload, cipherText: "participant-after-trash" },
      noteId: "lineage-shared-note",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a", "user-b"],
      revision: 4
    }));
  });

  it("allows owners to manage personal note folders and blocks cross-user assignments", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a", { allowedShareTargetUids: ["user-a", "user-b"] }));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
      await setDoc(doc(context.firestore(), "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
      await setDoc(doc(context.firestore(), "noteFolders/legacy-folder-to-migrate"), {
        ownerUid: "user-a",
        name: "기존 폴더 이름",
        color: "#2f7d70",
        isDeleted: false,
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z")
      });
      await setDoc(doc(context.firestore(), "noteFolders/user-b-parent"), {
        ownerUid: "user-b",
        name: "다른 사용자 폴더",
        color: "#2f7d70",
        createdAt: new Date("2026-05-18T08:00:00.000Z"),
        updatedAt: new Date("2026-05-18T08:00:00.000Z")
      });
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
      createAuditedVaultFolder(ownerDb, "folder-a", "user-a", {
        ownerUid: "user-a",
        name: "암호화 폴더",
        color: "#7c5cff",
        encryptedName: encryptedPayload,
        wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
        parentId: null,
        order: 0,
        revision: 1,
        isDeleted: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    const folderPlacementNote = {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      wrappedKeys: { "user-a": ownerWrappedShareKey },
      isDeleted: false
    };
    await assertSucceeds(createAuditedNote(ownerDb, "note-in-folder-a", "user-a", {
      ...folderPlacementNote,
      folderId: "folder-a"
    }, ["user-a"]));
    await assertSucceeds(createAuditedNote(ownerDb, "note-to-move-into-folder-a", "user-a", {
      ...folderPlacementNote,
      folderId: null
    }, ["user-a"]));
    await assertFails(
      createAuditedVaultFolderDirect(ownerDb, "plaintext-name-folder", "user-a", {
        ownerUid: "user-a",
        name: "서버에 노출되면 안 되는 실제 폴더 이름",
        color: "#7c5cff",
        encryptedName: encryptedPayload,
        wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
        parentId: null,
        order: 1,
        revision: 1,
        isDeleted: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      setDoc(doc(otherDb, "noteFolders/legacy-user-b-folder"), {
        ownerUid: "user-b",
        name: "marker 이전 폴더",
        color: "#2f7d70",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertSucceeds(
      updateDoc(doc(otherDb, "noteFolders/legacy-user-b-folder"), {
        name: "marker 이전 폴더 수정",
        updatedAt: serverTimestamp()
      })
    );
    const atomicCutoverClaimId = vaultTestClaimId("folder:atomic-cutover-folder");
    const unsafeAtomicCutover = writeBatch(otherDb);
    unsafeAtomicCutover.set(doc(otherDb, "vaultIntegrity/user-b"), {
      ownerUid: "user-b",
      indexVersion: 1,
      wrappedKey: ownerWrappedShareKey,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    unsafeAtomicCutover.set(doc(otherDb, "noteFolders/atomic-cutover-folder"), {
      ownerUid: "user-b",
      name: "암호화 폴더",
      color: "#7c5cff",
      encryptedName: encryptedPayload,
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
      parentId: null,
      order: 1,
      revision: 1,
      vaultNameClaimId: atomicCutoverClaimId,
      vaultNameIndexVersion: 1,
      isDeleted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await assertFails(unsafeAtomicCutover.commit());
    const legacyMigrationClaimId = vaultTestClaimId("folder:legacy-folder-to-migrate");
    const unsafeLegacyMigration = writeBatch(ownerDb);
    unsafeLegacyMigration.update(doc(ownerDb, "noteFolders/legacy-folder-to-migrate"), {
      name: "기존 폴더 이름",
      encryptedName: encryptedPayload,
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
      parentId: null,
      order: 2,
      revision: 1,
      vaultNameClaimId: legacyMigrationClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp()
    });
    unsafeLegacyMigration.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", legacyMigrationClaimId),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "legacy-folder-to-migrate",
        targetType: "folder",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    await assertFails(unsafeLegacyMigration.commit());
    const safeLegacyMigration = writeBatch(ownerDb);
    safeLegacyMigration.update(doc(ownerDb, "noteFolders/legacy-folder-to-migrate"), {
      name: "암호화 폴더",
      encryptedName: encryptedPayload,
      wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
      parentId: null,
      order: 2,
      revision: 1,
      vaultAncestorIds: [],
      vaultLineagePath: "legacy-folder-to-migrate",
      vaultLineageDepth: 0,
      vaultLineageGeneration: 1,
      vaultLineageVersion: 3,
      vaultNameClaimId: legacyMigrationClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp()
    });
    safeLegacyMigration.set(
      doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", legacyMigrationClaimId),
      {
        ownerUid: "user-a",
        indexVersion: 1,
        parentId: null,
        targetId: "legacy-folder-to-migrate",
        targetType: "folder",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );
    await assertFails(safeLegacyMigration.commit());
    await assertFails(
      setDoc(doc(ownerDb, "noteFolders/legacy-folder"), {
        ownerUid: "user-a",
        name: "기존 폴더",
        color: "#2f7d70",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(getDoc(doc(otherDb, "noteFolders/folder-a")));
    await assertSucceeds(
      createAuditedVaultFolder(ownerDb, "encrypted-folder", "user-a", {
        ownerUid: "user-a",
        name: "암호화 폴더",
        color: "#7c5cff",
        encryptedName: encryptedPayload,
        wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
        parentId: "folder-a",
        vaultAncestorIds: ["folder-a"],
        vaultLineageDepth: 1,
        order: 1,
        revision: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "noteFolders/folder-a"), {
        // encrypted-folder already points to folder-a. getAfter(parent)
        // must reject completing the reverse edge even via a direct SDK write.
        parentId: "encrypted-folder",
        revision: 2,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "noteFolders/encrypted-folder"), {
        encryptedName: { ...encryptedPayload, cipherText: "renamed" },
        order: 2,
        revision: 2,
        updatedAt: serverTimestamp()
      })
    );
    const currentFolderClaimId = vaultTestClaimId("folder:encrypted-folder");
    const renamedFolderClaimId = vaultTestClaimId("folder:encrypted-folder:renamed");
    const renameFolderBatch = writeBatch(ownerDb);
    renameFolderBatch.update(doc(ownerDb, "noteFolders/encrypted-folder"), {
      encryptedName: { ...encryptedPayload, cipherText: "renamed" },
      order: 2,
      revision: 2,
      vaultNameClaimId: renamedFolderClaimId,
      vaultNameIndexVersion: 1,
      updatedAt: serverTimestamp()
    });
    renameFolderBatch.set(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", renamedFolderClaimId), {
      ownerUid: "user-a",
      indexVersion: 1,
      parentId: "folder-a",
      targetId: "encrypted-folder",
      targetType: "folder",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    renameFolderBatch.delete(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", currentFolderClaimId));
    await assertFails(renameFolderBatch.commit());
    await assertFails(
      updateDoc(doc(ownerDb, "noteFolders/encrypted-folder"), {
        parentId: null,
        revision: 4,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      setDoc(doc(ownerDb, "noteFolders/incomplete-encrypted-folder"), {
        ownerUid: "user-a",
        name: "암호화 폴더",
        color: "#7c5cff",
        encryptedName: encryptedPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      setDoc(doc(ownerDb, "noteFolders/oversized-encrypted-name"), {
        ownerUid: "user-a",
        name: "암호화 폴더",
        color: "#7c5cff",
        encryptedName: { ...encryptedPayload, cipherText: "A".repeat(2049) },
        wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
        parentId: null,
        order: 1,
        revision: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      setDoc(doc(ownerDb, "noteFolders/legacy-parent-child"), {
        ownerUid: "user-a",
        name: "암호화 폴더",
        color: "#7c5cff",
        encryptedName: encryptedPayload,
        wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
        parentId: "legacy-folder",
        order: 1,
        revision: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(deleteDoc(doc(ownerDb, "noteFolders/folder-a")));
    await assertFails(
      updateDoc(doc(otherDb, "noteFolders/folder-a"), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-b",
        revision: 2,
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "noteFolders/folder-a"), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a",
        revision: 2,
        updatedAt: serverTimestamp()
      })
    );
    const trashedFolderClaimId = vaultTestClaimId("folder:folder-a");
    await seedServerVaultFolderLifecycle("user-a", "folder-a", false);
    expect((await assertSucceeds(getDoc(doc(ownerDb, "vaultIntegrity", "user-a", "nameClaims", trashedFolderClaimId)))).exists())
      .toBe(false);
    await assertFails(createAuditedNote(ownerDb, "note-created-in-trashed-folder", "user-a", {
      ...folderPlacementNote,
      folderId: "folder-a"
    }, ["user-a"]));
    await assertFails(updateExactAuditedVaultContent(ownerDb, {
      actorUid: "user-a",
      changedFields: ["body"],
      encryptedTitle: encryptedPayload,
      encryptedBody: { ...encryptedPayload, cipherText: "body-save-under-trashed-folder" },
      noteId: "note-in-folder-a",
      ownerSuppliesNameClaim: true,
      readerUids: ["user-a"],
      revision: 2
    }));
    await assertFails(updateAuditedNote(
      ownerDb,
      "note-to-move-into-folder-a",
      "user-a",
      2,
      "content",
      ["body", "folder"],
      ["user-a"],
      {
        encryptedBody: { ...encryptedPayload, cipherText: "move-into-trashed-folder" },
        folderId: "folder-a",
        isDeleted: false
      }
    ));
    await assertFails(
      createAuditedVaultFolderDirect(ownerDb, "child-under-trashed-parent", "user-a", {
        ownerUid: "user-a",
        name: "암호화 폴더",
        color: "#7c5cff",
        encryptedName: encryptedPayload,
        wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
        parentId: "folder-a",
        order: 2,
        revision: 1,
        isDeleted: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );
    await assertFails(
      updateDoc(doc(ownerDb, "noteFolders/folder-a"), {
        isDeleted: false,
        deletedAt: deleteField(),
        deletedBy: deleteField(),
        revision: 3,
        updatedAt: serverTimestamp()
      })
    );
    await seedServerVaultFolderLifecycle("user-a", "folder-a", true);
    for (const [folderId, parentId, revision] of [
      ["wrong-initial-revision", null, 2],
      ["self-parent", "self-parent", 1],
      ["missing-parent", "does-not-exist", 1],
      ["cross-user-parent", "user-b-parent", 1]
    ] as const) {
      await assertFails(
        setDoc(doc(ownerDb, `noteFolders/${folderId}`), {
          ownerUid: "user-a",
          name: "거부할 암호화 폴더",
          color: "#7c5cff",
          encryptedName: encryptedPayload,
          wrappedKey: { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped-folder-key" },
          parentId,
          order: 1,
          revision,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    }
    await assertFails(
      createAuditedNote(ownerDb, "oversized-vault-note", "user-a", {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: { ...encryptedPayload, cipherText: "A".repeat(700_001) },
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: false
      }, ["user-a"])
    );
    await assertSucceeds(
      createAuditedNote(ownerDb, "revisioned-folder-note", "user-a", {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        isDeleted: false
      }, ["user-a"])
    );
    await assertSucceeds(
      createAuditedNote(ownerDb, "atomic-content-folder-note", "user-a", {
        type: "personal",
        ownerUid: "user-a",
        participantUids: ["user-a"],
        encryptedTitle: encryptedPayload,
        encryptedBody: encryptedPayload,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
        wrappedKeys: {
          "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
        },
        folderId: null,
        isDeleted: false
      }, ["user-a"])
    );
    await assertSucceeds(
      updateAuditedNote(
        ownerDb,
        "atomic-content-folder-note",
        "user-a",
        2,
        "content",
        ["body", "folder"],
        ["user-a"],
        {
          encryptedBody: { ...encryptedPayload, cipherText: "atomic-moved-body" },
          folderId: "folder-a",
          isDeleted: false
        }
      )
    );
    await assertFails(
      updateAuditedNote(
        ownerDb,
        "atomic-content-folder-note",
        "user-a",
        3,
        "content",
        ["folder"],
        ["user-a"],
        {
          encryptedBody: { ...encryptedPayload, cipherText: "undeclared-body-change" },
          folderId: null,
          isDeleted: false
        }
      )
    );
    await assertSucceeds(
      updateAuditedNote(
        ownerDb,
        "revisioned-folder-note",
        "user-a",
        2,
        "share",
        ["folder"],
        ["user-a"],
        { folderId: "folder-a", isDeleted: false }
      )
    );
    await assertFails(
      updateAuditedNote(
        ownerDb,
        "revisioned-folder-note",
        "user-a",
        3,
        "share",
        ["participants"],
        ["user-a"],
        { folderId: null, isDeleted: false }
      )
    );
    await assertFails(
      updateDoc(doc(ownerDb, "notes/revisioned-folder-note"), {
        folderId: null,
        updatedAt: serverTimestamp(),
        updatedBy: "user-a"
      })
    );
    await assertFails(
      updateAuditedNote(
        ownerDb,
        "revisioned-folder-note",
        "user-a",
        3,
        "share",
        ["participants"],
        ["user-a", "user-b"],
        {
          type: "shared",
          participantUids: ["user-a", "user-b"],
          wrappedKeys: {
            "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
            "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
          },
          folderId: null,
          isDeleted: false
        }
      )
    );
    await assertSucceeds(
      updateAuditedNote(
        ownerDb,
        "revisioned-folder-note",
        "user-a",
        3,
        "share",
        ["participants", "folder"],
        ["user-a", "user-b"],
        {
          type: "shared",
          participantUids: ["user-a", "user-b"],
          wrappedKeys: {
            "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" },
            "user-b": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "b" }
          },
          folderId: null,
          isDeleted: false
        }
      )
    );
    await assertFails(
      updateDoc(doc(ownerDb, "notes/personal-note"), {
        folderId: "legacy-folder",
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

  it("requires matching vault content formats and entry kinds", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "vaultIntegrity/user-a"), vaultIntegrity("user-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const vaultNote = {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      isDeleted: false
    };

    await assertSucceeds(createAuditedNote(ownerDb, "markdown-entry", "user-a", {
      ...vaultNote,
      contentFormat: "markdown-v1",
      entryKind: "markdown"
    }, ["user-a"]));
    await assertSucceeds(createAuditedNote(ownerDb, "canvas-entry", "user-a", {
      ...vaultNote,
      contentFormat: "json-canvas-v1",
      entryKind: "canvas"
    }, ["user-a"]));
    await assertSucceeds(createAuditedNote(ownerDb, "asset-entry", "user-a", {
      ...vaultNote,
      contentFormat: "asset-v1",
      entryKind: "asset"
    }, ["user-a"]));
    await assertFails(createAuditedNote(ownerDb, "asset-mismatched-entry", "user-a", {
      ...vaultNote,
      contentFormat: "asset-v1",
      entryKind: "markdown"
    }, ["user-a"]));
    await assertFails(createAuditedNote(ownerDb, "mismatched-entry", "user-a", {
      ...vaultNote,
      contentFormat: "markdown-v1",
      entryKind: "canvas"
    }, ["user-a"]));
    await assertFails(createAuditedNote(ownerDb, "missing-kind", "user-a", {
      ...vaultNote,
      contentFormat: "base-v1"
    }, ["user-a"]));
    await assertFails(createAuditedNote(ownerDb, "unknown-format", "user-a", {
      ...vaultNote,
      contentFormat: "executable-v1",
      entryKind: "markdown"
    }, ["user-a"]));
    await assertFails(createAuditedNote(ownerDb, "unknown-field", "user-a", {
      ...vaultNote,
      executablePayload: "alert(1)"
    }, ["user-a"]));
    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "markdown-entry",
      "user-a",
      2,
      "content",
      ["body"],
      ["user-a"],
      {
        encryptedBody: { ...encryptedPayload, cipherText: "changed" },
        isDeleted: false
      }
    ));
    await assertFails(updateAuditedNote(
      ownerDb,
      "markdown-entry",
      "user-a",
      3,
      "content",
      ["body"],
      ["user-a"],
      {
        encryptedBody: { ...encryptedPayload, cipherText: "A".repeat(700_001) },
        isDeleted: false
      }
    ));
    await assertFails(updateAuditedNote(
      ownerDb,
      "markdown-entry",
      "user-a",
      3,
      "content",
      ["body"],
      ["user-a"],
      {
        encryptedBody: { ...encryptedPayload, cipherText: "changed" },
        executablePayload: "alert(1)",
        isDeleted: false
      }
    ));
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
        attachmentRevision: 0,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
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
        attachmentRevision: 0,
        contentFormat: "markdown-v1",
        entryKind: "markdown",
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

    const unknownFieldBatch = writeBatch(ownerDb);
    unknownFieldBatch.update(doc(ownerDb, "notes/note-a"), {
      ...purgeUpdates,
      plaintextLeak: "must-not-be-stored"
    });
    unknownFieldBatch.set(doc(ownerDb, "notePurgeCleanupQueue/note-a"), {
      noteId: "note-a",
      ownerUid: "user-a",
      createdAt: serverTimestamp()
    });
    await assertFails(unknownFieldBatch.commit());

    const removedFormatBatch = writeBatch(ownerDb);
    removedFormatBatch.update(doc(ownerDb, "notes/note-a"), {
      ...purgeUpdates,
      contentFormat: deleteField()
    });
    removedFormatBatch.set(doc(ownerDb, "notePurgeCleanupQueue/note-a"), {
      noteId: "note-a",
      ownerUid: "user-a",
      createdAt: serverTimestamp()
    });
    await assertFails(removedFormatBatch.commit());

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

    const participantTitleBatch = writeBatch(participantDb);
    participantTitleBatch.update(doc(participantDb, "notes/note-a"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "updated-title" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-b",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    participantTitleBatch.set(
      doc(participantDb, "notes/note-a/history", noteRevisionId(2)),
      noteHistory("note-a", "user-b", { changedFields: ["title"], revision: 2 })
    );
    await assertFails(participantTitleBatch.commit());

    const secondBatch = writeBatch(ownerDb);
    const secondHistoryRef = doc(ownerDb, "notes/note-a/history", noteRevisionId(2));
    secondBatch.update(doc(ownerDb, "notes/note-a"), {
      encryptedTitle: { ...encryptedPayload, cipherText: "updated-title" },
      updatedAt: serverTimestamp(),
      updatedBy: "user-a",
      revision: 2,
      lastMutationId: noteRevisionId(2)
    });
    secondBatch.set(secondHistoryRef, noteHistory("note-a", "user-a", { changedFields: ["title"], revision: 2 }));
    await assertSucceeds(secondBatch.commit());

    for (const [historyId, historyOverrides] of [
      ["oversized-summary", {
        encryptedSummary: { ...encryptedPayload, cipherText: "s".repeat(8_193) }
      }],
      ["oversized-snapshot", {
        encryptedSnapshot: { ...encryptedPayload, cipherText: "s".repeat(700_001) }
      }],
      ["oversized-history-iv", {
        encryptedSnapshot: { ...encryptedPayload, iv: "i".repeat(257) }
      }]
    ] as const) {
      const oversizedHistoryBatch = writeBatch(participantDb);
      oversizedHistoryBatch.update(doc(participantDb, "notes/note-a"), {
        encryptedBody: { ...encryptedPayload, cipherText: historyId },
        updatedAt: serverTimestamp(),
        updatedBy: "user-b",
        revision: 3,
        lastMutationId: historyId
      });
      oversizedHistoryBatch.set(
        doc(participantDb, "notes/note-a/history", historyId),
        noteHistory("note-a", "user-b", {
          changedFields: ["body"],
          revision: 3,
          ...historyOverrides
        })
      );
      await assertFails(oversizedHistoryBatch.commit());
    }

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

  it("keeps secure-share copies hidden until server-counted attachments atomically activate", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
      await setDoc(doc(context.firestore(), "users/user-b"), userProfile("user-b"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const outsiderDb = testEnv.authenticatedContext("user-b").firestore();
    const copyJobId = "copy_job_1234567890";
    const copyingNote = {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      attachmentRevision: 0,
      secureShareCopyState: "copying",
      secureShareCopyJobId: copyJobId,
      secureShareCopyExpectedAttachmentCount: 2,
      secureShareCopyReservedAttachmentCount: 0,
      secureShareCopyReadyAttachmentCount: 0,
      secureShareCopyStartedAt: serverTimestamp(),
      secureShareCopyUpdatedAt: serverTimestamp(),
      isDeleted: false
    };

    await assertSucceeds(
      createAuditedNote(ownerDb, "secure-copy-a", "user-a", copyingNote, ["user-a"])
    );
    await assertSucceeds(getDoc(doc(ownerDb, "notes/secure-copy-a")));
    await assertFails(getDoc(doc(outsiderDb, "notes/secure-copy-a")));
    await assertFails(updateDoc(doc(ownerDb, "notes/secure-copy-a"), {
      secureShareCopyReadyAttachmentCount: 1
    }));
    await assertFails(updateDoc(doc(ownerDb, "notes/secure-copy-a"), {
      secureShareCopyState: "active",
      secureShareCopyFinishedAt: serverTimestamp(),
      secureShareCopyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "user-a"
    }));
    await assertFails(
      createAuditedNote(ownerDb, "forged-claimed-copy", "user-a", {
        ...copyingNote,
        secureShareCopyCleanupClaimId: "copy_cleanup_claim_forged",
        secureShareCopyCleanupClaimedAt: serverTimestamp()
      }, ["user-a"])
    );

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/secure-copy-a"), {
        secureShareCopyCleanupClaimId:
          "copy_cleanup_claim_1234567890abcdef1234567890abcdef",
        secureShareCopyCleanupClaimedAt: serverTimestamp(),
        secureShareCopyReservedAttachmentCount: 2,
        secureShareCopyReadyAttachmentCount: 2,
        secureShareCopyUpdatedAt: serverTimestamp()
      });
    });

    const activateCopy = {
      secureShareCopyState: "active",
      secureShareCopyFinishedAt: serverTimestamp(),
      secureShareCopyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      savedAt: serverTimestamp(),
      updatedBy: "user-a"
    };

    await assertFails(updateDoc(doc(ownerDb, "notes/secure-copy-a"), activateCopy));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes/secure-copy-a"), {
        secureShareCopyCleanupClaimId: deleteField(),
        secureShareCopyCleanupClaimedAt: deleteField()
      });
    });

    await assertSucceeds(updateDoc(doc(ownerDb, "notes/secure-copy-a"), activateCopy));

    await assertFails(
      createAuditedNote(ownerDb, "forged-active-copy", "user-a", {
        ...copyingNote,
        secureShareCopyState: "active",
        secureShareCopyExpectedAttachmentCount: 0,
        secureShareCopyFinishedAt: serverTimestamp()
      }, ["user-a"])
    );
  });

  it("allows an audited copy abort only after server-side attachment compensation reaches zero", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/user-a"), userProfile("user-a"));
    });

    const ownerDb = testEnv.authenticatedContext("user-a").firestore();
    const copyJobId = "copy_job_1234567890";
    const copyingNote = {
      type: "personal",
      ownerUid: "user-a",
      participantUids: ["user-a"],
      encryptedTitle: encryptedPayload,
      encryptedBody: encryptedPayload,
      wrappedKeys: {
        "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "a" }
      },
      attachmentRevision: 0,
      secureShareCopyState: "copying",
      secureShareCopyJobId: copyJobId,
      secureShareCopyExpectedAttachmentCount: 1,
      secureShareCopyReservedAttachmentCount: 0,
      secureShareCopyReadyAttachmentCount: 0,
      secureShareCopyStartedAt: serverTimestamp(),
      secureShareCopyUpdatedAt: serverTimestamp(),
      isDeleted: false
    };

    await assertSucceeds(
      createAuditedNote(ownerDb, "secure-copy-abort", "user-a", copyingNote, ["user-a"])
    );
    await assertSucceeds(updateAuditedNote(
      ownerDb,
      "secure-copy-abort",
      "user-a",
      2,
      "delete",
      ["deleted"],
      ["user-a"],
      {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: "user-a",
        secureShareCopyState: "aborted",
        secureShareCopyFinishedAt: serverTimestamp(),
        secureShareCopyUpdatedAt: serverTimestamp()
      }
    ));

    await assertFails(updateAuditedNote(
      ownerDb,
      "secure-copy-abort",
      "user-a",
      3,
      "restore",
      ["restored"],
      ["user-a"],
      {
        isDeleted: false,
        deletedAt: deleteField(),
        deletedBy: deleteField()
      }
    ));
  });
});
