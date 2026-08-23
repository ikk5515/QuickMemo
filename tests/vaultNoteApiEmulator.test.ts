import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiHeaders,
  clearSecureShareEmulators,
  configureSecureShareApiEmulatorEnvironment,
  createEmulatorOwner,
  readEmulatorDocument,
  type SecureShareApiHarness,
  writeEmulatorDocuments
} from "./helpers/secureShareApiEmulator.js";
import {
  vaultInventoryManifestBindingRoot,
  vaultPathRewriteInventoryFingerprint
} from "../api/_vault-path-rewrite-activation.js";
import {
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  vaultInventoryManifestContract,
  vaultInventoryManifestMarkerPath,
  vaultInventoryManifestShardId,
  vaultInventoryManifestShardIndexFromEntryKey,
  vaultInventoryManifestShardPath
} from "../shared/vault-inventory-manifest.js";

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const title = {
  algorithm: "AES-GCM",
  cipherText: "encrypted-title",
  iv: "title-iv",
  version: 1
} as const;

const body = {
  algorithm: "AES-GCM",
  cipherText: "encrypted-body",
  iv: "body-iv",
  version: 1
} as const;

const wrappedKey = {
  algorithm: "RSA-OAEP",
  version: 1,
  wrappedKey: "wrapped-key"
} as const;
const leaseId = "l".repeat(43);
const leaseGeneration = "g".repeat(43);

function vaultIntegrityMarkerFields(
  uid: string,
  state: "legacy" | "pending" | "ready" = "ready"
) {
  const now = new Date();
  return {
    createdAt: now,
    indexVersion: 1,
    ownerUid: uid,
    updatedAt: now,
    ...(state === "legacy" ? {} : {
      cutoverState: state,
      cutoverVersion: 1
    }),
    ...(state === "ready" ? { verifiedAt: now } : {}),
    ...(state === "pending" ? {
      cutoverLeaseAcquiredAt: now,
      cutoverLeaseExpiresAt: new Date(now.getTime() + 90_000),
      cutoverLeaseGeneration: leaseGeneration,
      cutoverLeaseHash: createHash("sha256").update(leaseId, "utf8").digest("base64url"),
      cutoverLeaseVersion: 1
    } : {}),
    wrappedKey
  };
}

async function startVaultNoteHarness(): Promise<SecureShareApiHarness> {
  const moduleUrl = new URL("../api/vault-notes.js", import.meta.url);
  moduleUrl.searchParams.set("integration-instance", String(Date.now()));
  const module = await import(/* @vite-ignore */ moduleUrl.href) as typeof import("../api/vault-notes.js");
  const server = createServer((request, response) => {
    void module.default(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

describeEmulator("Vault note API emulator transaction", () => {
  let harness: SecureShareApiHarness;
  let idToken = "";
  let participantIdToken = "";
  let participantUid = "";
  let uid = "";

  async function request(requestBody: Record<string, unknown>, token = idToken) {
    const response = await fetch(`${harness.origin}/api/vault-notes`, {
      method: "POST",
      headers: {
        ...apiHeaders(harness.origin, { authorization: token }),
        "x-quickmemo-vault-notes": "1"
      },
      body: JSON.stringify(requestBody)
    });
    return {
      body: await response.json() as Record<string, unknown>,
      response
    };
  }

  function createBody(claimCharacter = "A") {
    return {
      action: "create",
      contentFormat: "markdown-v1",
      encryptedBody: body,
      encryptedTitle: title,
      entryKind: "markdown",
      folderId: null,
      nameClaim: {
        claimId: claimCharacter.repeat(43),
        indexVersion: 1,
        parentId: null
      },
      participantUids: [uid],
      type: "personal",
      wrappedKeys: { [uid]: wrappedKey }
    };
  }

  async function activateVaultIntegrityMarker() {
    await writeEmulatorDocuments([{
      path: `vaultIntegrity/${uid}`,
      fields: vaultIntegrityMarkerFields(uid)
    }]);
  }

  function legacyNoteFields(options: { deleted?: boolean; shared?: boolean } = {}) {
    const participants = options.shared ? [uid, participantUid] : [uid];
    return {
      attachmentRevision: 0,
      createdAt: new Date(),
      encryptedBody: body,
      encryptedTitle: title,
      folderId: null,
      isDeleted: options.deleted === true,
      ...(options.deleted ? { deletedAt: new Date(), deletedBy: uid } : {}),
      lastMutationId: "legacy-seed-mutation",
      ownerUid: uid,
      participantUids: participants,
      revision: 1,
      savedAt: new Date(),
      type: options.shared ? "shared" : "personal",
      updatedAt: new Date(),
      updatedBy: uid,
      wrappedKeys: Object.fromEntries(participants.map((participant) => [participant, wrappedKey]))
    };
  }

  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    harness = await startVaultNoteHarness();
  });

  beforeEach(async () => {
    await clearSecureShareEmulators();
    const owner = await createEmulatorOwner(
      `vault-note-${Date.now()}@example.test`,
      "emulator-owner-password"
    );
    idToken = owner.idToken;
    uid = owner.localId;
    const participant = await createEmulatorOwner(
      `vault-note-participant-${Date.now()}@example.test`,
      "emulator-participant-password"
    );
    participantIdToken = participant.idToken;
    participantUid = participant.localId;
    await writeEmulatorDocuments([
      {
        path: `users/${uid}`,
        fields: {
          allowedShareTargetUids: [participantUid],
          displayName: "Vault note owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid
        }
      },
      {
        path: `users/${participantUid}`,
        fields: {
          displayName: "Vault note participant",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid: participantUid
        }
      }
    ]);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("atomically creates, revisions, restores, and purges an encrypted note", async () => {
    const rejectedBeforeCutover = await request(createBody("A"));
    expect(rejectedBeforeCutover.response.status).toBe(409);
    expect(rejectedBeforeCutover.body).toMatchObject({
      error: "vault_integrity_not_ready",
      ok: false
    });
    await activateVaultIntegrityMarker();
    const created = await request(createBody("A"));
    expect(created.response.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, revision: 1 });
    const noteId = String(created.body.noteId);
    const firstMutationId = String(created.body.lastMutationId);

    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({
      contentFormat: "markdown-v1",
      encryptedBody: body,
      encryptedTitle: title,
      entryKind: "markdown",
      ownerUid: uid,
      revision: 1,
      vaultNameClaimId: "A".repeat(43)
    });
    expect(await readEmulatorDocument(`notes/${noteId}/history/${firstMutationId}`)).toMatchObject({
      action: "create",
      actorUid: uid,
      changedFields: ["title", "body"],
      revision: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"A".repeat(43)}`))
      .toMatchObject({ targetId: noteId, targetType: "entry" });

    const updatedTitle = { ...title, cipherText: "renamed-title" };
    const renamePayload = {
      action: "update",
      changedFields: ["title", "name-claim"],
      encryptedBody: body,
      encryptedTitle: updatedTitle,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 1,
      nameClaim: { claimId: "B".repeat(43), indexVersion: 1, parentId: null },
      noteId,
      readerUids: [uid]
    };
    const missingRewrite = await request(renamePayload);
    expect(missingRewrite.response.status).toBe(409);
    expect(missingRewrite.body).toMatchObject({
      error: "vault_path_rewrite_required",
      ok: false
    });
    const currentNote = await readEmulatorDocument(`notes/${noteId}`);
    if (!currentNote) throw new Error("created note fixture is missing");
    const renameJobId = `pr2_${"required-note-rename".padEnd(43, "0")}`;
    await writeEmulatorDocuments([{
      path: `vaultMaintenanceJobs/${uid}/pathRewrites/${renameJobId}`,
      fields: {
        activationMode: "atomic-v1",
        confirmedCount: 0,
        cursor: 0,
        inventoryFingerprint: vaultPathRewriteInventoryFingerprint(
          uid,
          [{ ...currentNote, __id: noteId }],
          []
        ),
        kind: "path-rewrite-v1",
        lastErrorCode: null,
        mutationExpectedRevision: 1,
        mutationTargetId: noteId,
        mutationTargetKind: "entry",
        ownerUid: uid,
        planFingerprint: renameJobId,
        preparedStepCount: 0,
        revision: 2,
        status: "prepared",
        stepCount: 0,
        updatedAt: new Date(),
        version: 1
      }
    }]);
    const updated = await request({
      ...renamePayload,
      pathRewriteActivation: { expectedRevision: 2, jobId: renameJobId }
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({ revision: 2 });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"A".repeat(43)}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"B".repeat(43)}`))
      .toMatchObject({ targetId: noteId });

    const stale = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "stale-body" },
      encryptedTitle: updatedTitle,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 1,
      noteId,
      readerUids: [uid]
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({
      actualRevision: 2,
      error: "revision_conflict",
      ok: false
    });

    expect((await request({
      action: "trash",
      expectedRevision: 2,
      noteId,
      readerUids: [uid]
    })).body).toMatchObject({ revision: 3 });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"B".repeat(43)}`))
      .toBeNull();

    expect((await request({
      action: "restore",
      expectedRevision: 3,
      noteId,
      readerUids: [uid]
    })).body).toMatchObject({ revision: 4 });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"B".repeat(43)}`))
      .toMatchObject({ targetId: noteId });

    expect((await request({
      action: "trash",
      expectedRevision: 4,
      noteId,
      readerUids: [uid]
    })).body).toMatchObject({ revision: 5 });
    const purged = await request({
      action: "purge",
      encryptedBody: { ...body, cipherText: "purged-body" },
      encryptedTitle: { ...title, cipherText: "purged-title" },
      expectedRevision: 5,
      noteId,
      wrappedKey
    });
    expect(purged.response.status).toBe(200);
    expect(purged.body).toMatchObject({ noteId, revision: 5 });
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({
      isDeleted: true,
      isPurged: true,
      ownerUid: uid,
      participantUids: [uid],
      revision: 5
    });
    expect(await readEmulatorDocument(`notePurgeCleanupQueue/${noteId}`))
      .toMatchObject({ noteId, ownerUid: uid });
  });

  it("atomically moves a historical revision-zero note with its bound rewrite activation", async () => {
    await activateVaultIntegrityMarker();
    const now = new Date();
    const noteId = "revision-zero-atomic-move";
    const folderId = "revision-zero-destination";
    const sourceClaimId = "S".repeat(43);
    const targetClaimId = "T".repeat(43);
    const jobId = `pr2_${"revision-zero".padEnd(43, "0")}`;
    const jobPath = `vaultMaintenanceJobs/${uid}/pathRewrites/${jobId}`;
    const noteFields = {
      attachmentRevision: 0,
      contentFormat: "markdown-v1",
      createdAt: now,
      encryptedBody: body,
      encryptedTitle: title,
      entryKind: "markdown",
      folderId: null,
      isDeleted: false,
      lastMutationId: "revision-zero-seed",
      ownerUid: uid,
      participantUids: [uid],
      savedAt: now,
      type: "personal",
      updatedAt: now,
      updatedBy: uid,
      vaultNameClaimId: sourceClaimId,
      vaultNameIndexVersion: 1,
      wrappedKeys: { [uid]: wrappedKey }
    } as const;
    const folderFields = {
      encryptedName: title,
      isDeleted: false,
      ownerUid: uid,
      parentId: null,
      revision: 1,
      wrappedKey
    } as const;
    const inventoryFingerprint = vaultPathRewriteInventoryFingerprint(
      uid,
      [{ __id: noteId, ...noteFields }],
      [{ __id: folderId, ...folderFields }]
    );
    await writeEmulatorDocuments([
      {
        path: `notes/${noteId}`,
        fields: noteFields
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${sourceClaimId}`,
        fields: {
          createdAt: now,
          indexVersion: 1,
          ownerUid: uid,
          parentId: null,
          targetId: noteId,
          targetType: "entry",
          updatedAt: now
        }
      },
      {
        path: `noteFolders/${folderId}`,
        fields: folderFields
      },
      {
        path: `vaultFolderTrees/${uid}`,
        fields: {
          createdAt: now,
          folderCount: 1,
          nodes: {
            [folderId]: { active: true, generation: 1, parentId: null, selfActive: true }
          },
          ownerUid: uid,
          revision: 1,
          schemaVersion: 1,
          updatedAt: now
        }
      },
      {
        path: jobPath,
        fields: {
          activationMode: "atomic-v1",
          confirmedCount: 0,
          cursor: 0,
          inventoryFingerprint,
          kind: "path-rewrite-v1",
          lastErrorCode: null,
          mutationExpectedRevision: 0,
          mutationTargetId: noteId,
          mutationTargetKind: "entry",
          ownerUid: uid,
          planFingerprint: jobId,
          preparedStepCount: 1,
          revision: 2,
          status: "prepared",
          stepCount: 1,
          updatedAt: now,
          version: 1
        }
      }
    ]);

    const moved = await request({
      action: "move",
      expectedRevision: 0,
      folderId,
      nameClaim: { claimId: targetClaimId, indexVersion: 1, parentId: folderId },
      noteId,
      pathRewriteActivation: { expectedRevision: 2, jobId },
      readerUids: [uid]
    });
    expect(moved.response.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ noteId, revision: 1 });
    const movedNote = await readEmulatorDocument(`notes/${noteId}`);
    expect(movedNote).toMatchObject({ folderId, revision: 1 });
    expect(await readEmulatorDocument(jobPath)).toMatchObject({ revision: 3, status: "ready" });
    const manifestMarker = await readEmulatorDocument(vaultInventoryManifestMarkerPath(uid));
    expect(manifestMarker)
      .toMatchObject({ epoch: 1, ownerUid: uid, shardCount: 32, version: 1 });
    if (!movedNote) throw new Error("moved note fixture is missing");
    const manifestEntryKey = createHash("sha256")
      .update(canonicalVaultInventoryManifestEntryKey({ uid, kind: "note", id: noteId }), "utf8")
      .digest("base64url");
    const manifestEntryTokenCanonical = canonicalVaultInventoryManifestEntryToken({
      uid,
      kind: "note",
      document: { ...movedNote, id: noteId }
    });
    if (manifestEntryTokenCanonical === null) throw new Error("moved note must be active");
    const manifestEntryToken = createHash("sha256")
      .update(manifestEntryTokenCanonical, "utf8")
      .digest("base64url");
    const manifestShard = await readEmulatorDocument(vaultInventoryManifestShardPath(
      uid,
      vaultInventoryManifestShardIndexFromEntryKey(manifestEntryKey)
    ));
    expect(manifestShard?.entries).toMatchObject({ [manifestEntryKey]: manifestEntryToken });

    if (!manifestMarker) throw new Error("manifest marker is missing");
    const manifestShards = await Promise.all(Array.from(
      { length: vaultInventoryManifestContract.shardCount },
      async (_, shardIndex) => {
        const shard = await readEmulatorDocument(vaultInventoryManifestShardPath(uid, shardIndex));
        if (!shard) throw new Error(`manifest shard ${shardIndex} is missing`);
        return { ...shard, __id: vaultInventoryManifestShardId(shardIndex) };
      }
    ));
    const pr3JobId = `pr3_${"manifest-note-move".padEnd(43, "0")}`;
    const pr3JobPath = `vaultMaintenanceJobs/${uid}/pathRewrites/${pr3JobId}`;
    await writeEmulatorDocuments([{
      path: pr3JobPath,
      fields: {
        activationMode: "atomic-manifest-v1",
        confirmedCount: 0,
        cursor: 0,
        inventoryManifestEpoch: manifestMarker.epoch,
        inventoryManifestRoot: vaultInventoryManifestBindingRoot(
          uid,
          { ...manifestMarker, __id: "marker" },
          manifestShards
        ),
        inventoryManifestShardCount: vaultInventoryManifestContract.shardCount,
        inventoryManifestVersion: vaultInventoryManifestContract.version,
        kind: "path-rewrite-v1",
        lastErrorCode: null,
        mutationExpectedRevision: 1,
        mutationTargetId: noteId,
        mutationTargetKind: "entry",
        ownerUid: uid,
        planFingerprint: pr3JobId,
        preparedStepCount: 0,
        revision: 2,
        status: "prepared",
        stepCount: 0,
        updatedAt: now,
        version: 1
      }
    }]);
    const movedBack = await request({
      action: "move",
      expectedRevision: 1,
      folderId: null,
      nameClaim: { claimId: "W".repeat(43), indexVersion: 1, parentId: null },
      noteId,
      pathRewriteActivation: { expectedRevision: 2, jobId: pr3JobId },
      readerUids: [uid]
    });
    expect(movedBack.response.status, JSON.stringify(movedBack.body)).toBe(200);
    expect(movedBack.body).toMatchObject({ noteId, revision: 2 });
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({ folderId: null, revision: 2 });
    expect(await readEmulatorDocument(pr3JobPath)).toMatchObject({ revision: 3, status: "ready" });

    const raceJobId = `pr2_${"concurrent-note-create".padEnd(43, "0")}`;
    const raceJobPath = `vaultMaintenanceJobs/${uid}/pathRewrites/${raceJobId}`;
    const currentNote = await readEmulatorDocument(`notes/${noteId}`);
    const currentFolder = await readEmulatorDocument(`noteFolders/${folderId}`);
    if (!currentNote || !currentFolder) throw new Error("atomic race fixture is missing");
    const raceFingerprint = vaultPathRewriteInventoryFingerprint(
      uid,
      [{ ...currentNote, __id: noteId }],
      [{ ...currentFolder, __id: folderId }]
    );
    await writeEmulatorDocuments([
      {
        path: raceJobPath,
        fields: {
          activationMode: "atomic-v1",
          confirmedCount: 0,
          cursor: 0,
          inventoryFingerprint: raceFingerprint,
          kind: "path-rewrite-v1",
          lastErrorCode: null,
          mutationExpectedRevision: 2,
          mutationTargetId: noteId,
          mutationTargetKind: "entry",
          ownerUid: uid,
          planFingerprint: raceJobId,
          preparedStepCount: 0,
          revision: 2,
          status: "prepared",
          stepCount: 0,
          updatedAt: now,
          version: 1
        }
      },
      {
        path: "notes/concurrent-created-note",
        fields: {
          ...noteFields,
          folderId,
          lastMutationId: "concurrent-create",
          revision: 1,
          vaultNameClaimId: "V".repeat(43)
        }
      }
    ]);
    const raced = await request({
      action: "move",
      expectedRevision: 2,
      folderId,
      nameClaim: { claimId: "U".repeat(43), indexVersion: 1, parentId: folderId },
      noteId,
      pathRewriteActivation: { expectedRevision: 2, jobId: raceJobId },
      readerUids: [uid]
    });
    expect(raced.response.status).toBe(409);
    expect(raced.body).toMatchObject({ error: "vault_path_rewrite_inventory_changed", ok: false });
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({ folderId: null, revision: 2 });
    expect(await readEmulatorDocument(raceJobPath)).toMatchObject({ revision: 2, status: "prepared" });
  });

  it("atomically reserves secure-share copy names and releases them only after zero-counter abort", async () => {
    const secureCreate = {
      action: "secure-copy-create",
      contentFormat: "legacy-html-v1",
      copyJobId: "secure-copy-job-123456",
      encryptedBody: body,
      encryptedTitle: title,
      entryKind: "legacy-html",
      expectedAttachmentCount: 0,
      folderId: null,
      nameClaim: { claimId: "S".repeat(43), indexVersion: 1, parentId: null },
      noteId: "secure-copy-note-a",
      participantUids: [uid],
      type: "personal",
      wrappedKeys: { [uid]: wrappedKey }
    };
    const rejectedBeforeCutover = await request(secureCreate);
    expect(rejectedBeforeCutover.response.status).toBe(409);
    expect(rejectedBeforeCutover.body).toMatchObject({
      error: "vault_integrity_not_ready",
      ok: false
    });
    expect(await readEmulatorDocument(`notes/${secureCreate.noteId}`)).toBeNull();
    expect(await readEmulatorDocument(
      `vaultIntegrity/${uid}/nameClaims/${"S".repeat(43)}`
    )).toBeNull();
    await activateVaultIntegrityMarker();
    const created = await request(secureCreate);
    expect(created.response.status).toBe(200);
    const noteId = String(created.body.noteId);
    expect(noteId).toBe(secureCreate.noteId);
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      secureShareCopyExpectedAttachmentCount: 0,
      secureShareCopyReadyAttachmentCount: 0,
      secureShareCopyReservedAttachmentCount: 0,
      secureShareCopyState: "copying",
      vaultNameClaimId: "S".repeat(43)
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"S".repeat(43)}`))
      .toMatchObject({ targetId: noteId, targetType: "entry" });
    const retriedCreate = await request(secureCreate);
    expect(retriedCreate.response.status).toBe(200);
    expect(retriedCreate.body).toMatchObject({ noteId, revision: 1 });

    const activated = await request({
      action: "secure-copy-activate",
      copyJobId: secureCreate.copyJobId,
      expectedRevision: 1,
      noteId
    });
    expect(activated.response.status).toBe(200);
    expect(activated.body).toMatchObject({ noteId, revision: 1, state: "active" });

    const abortable = await request({
      ...secureCreate,
      copyJobId: "secure-copy-job-654321",
      nameClaim: { claimId: "T".repeat(43), indexVersion: 1, parentId: null },
      noteId: "secure-copy-note-b"
    });
    const abortableNoteId = String(abortable.body.noteId);
    const aborted = await request({
      action: "secure-copy-abort",
      copyJobId: "secure-copy-job-654321",
      expectedRevision: 1,
      noteId: abortableNoteId
    });
    expect(aborted.response.status).toBe(200);
    expect(aborted.body).toMatchObject({ noteId: abortableNoteId, revision: 2 });
    expect(await readEmulatorDocument(`notes/${abortableNoteId}`)).toMatchObject({
      isDeleted: true,
      secureShareCopyState: "aborted"
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"T".repeat(43)}`))
      .toBeNull();
  });

  it("refuses secure-copy abort while any attachment reservation remains", async () => {
    const claimId = "U".repeat(43);
    await activateVaultIntegrityMarker();
    await writeEmulatorDocuments([
      {
        path: "notes/secure-copy-reserved",
        fields: {
          ...legacyNoteFields(),
          contentFormat: "legacy-html-v1",
          entryKind: "legacy-html",
          secureShareCopyExpectedAttachmentCount: 1,
          secureShareCopyJobId: "secure-copy-job-reserved",
          secureShareCopyReadyAttachmentCount: 0,
          secureShareCopyReservedAttachmentCount: 1,
          secureShareCopyState: "copying",
          vaultNameClaimId: claimId,
          vaultNameIndexVersion: 1
        }
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${claimId}`,
        fields: {
          indexVersion: 1,
          ownerUid: uid,
          parentId: null,
          targetId: "secure-copy-reserved",
          targetType: "entry"
        }
      }
    ]);

    const aborted = await request({
      action: "secure-copy-abort",
      copyJobId: "secure-copy-job-reserved",
      expectedRevision: 1,
      noteId: "secure-copy-reserved"
    });
    expect(aborted.response.status).toBe(409);
    expect(aborted.body).toMatchObject({ error: "secure_copy_abort_denied", ok: false });
    expect(await readEmulatorDocument("notes/secure-copy-reserved"))
      .toMatchObject({ secureShareCopyState: "copying" });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${claimId}`))
      .toMatchObject({ targetId: "secure-copy-reserved" });
  });

  it("requires an atomic rewrite when access moves a versioned note out of a folder", async () => {
    await activateVaultIntegrityMarker();
    const now = new Date();
    const folderId = "access-path-folder";
    await writeEmulatorDocuments([
      {
        path: `noteFolders/${folderId}`,
        fields: {
          encryptedName: title,
          isDeleted: false,
          ownerUid: uid,
          parentId: null,
          revision: 1,
          wrappedKey
        }
      },
      {
        path: `vaultFolderTrees/${uid}`,
        fields: {
          createdAt: now,
          folderCount: 1,
          nodes: {
            [folderId]: { active: true, generation: 1, parentId: null, selfActive: true }
          },
          ownerUid: uid,
          revision: 1,
          schemaVersion: 1,
          updatedAt: now
        }
      }
    ]);
    const created = await request({
      ...createBody("Q"),
      folderId,
      nameClaim: { claimId: "Q".repeat(43), indexVersion: 1, parentId: folderId }
    });
    expect(created.response.status, JSON.stringify(created.body)).toBe(200);
    const noteId = String(created.body.noteId);
    const accessPayload = {
      action: "access",
      expectedRevision: 1,
      folderId: null,
      nameClaim: { claimId: "R".repeat(43), indexVersion: 1, parentId: null },
      noteId,
      participantUids: [uid, participantUid],
      type: "shared",
      wrappedKeys: { [uid]: wrappedKey, [participantUid]: wrappedKey }
    };
    const missingRewrite = await request(accessPayload);
    expect(missingRewrite.response.status).toBe(409);
    expect(missingRewrite.body).toMatchObject({ error: "vault_path_rewrite_required", ok: false });

    const [storedNote, storedFolder] = await Promise.all([
      readEmulatorDocument(`notes/${noteId}`),
      readEmulatorDocument(`noteFolders/${folderId}`)
    ]);
    if (!storedNote || !storedFolder) throw new Error("access path fixture is missing");
    const jobId = `pr2_${"access-path-rewrite".padEnd(43, "0")}`;
    await writeEmulatorDocuments([{
      path: `vaultMaintenanceJobs/${uid}/pathRewrites/${jobId}`,
      fields: {
        activationMode: "atomic-v1",
        confirmedCount: 0,
        cursor: 0,
        inventoryFingerprint: vaultPathRewriteInventoryFingerprint(
          uid,
          [{ ...storedNote, __id: noteId }],
          [{ ...storedFolder, __id: folderId }]
        ),
        kind: "path-rewrite-v1",
        lastErrorCode: null,
        mutationExpectedRevision: 1,
        mutationTargetId: noteId,
        mutationTargetKind: "entry",
        ownerUid: uid,
        planFingerprint: jobId,
        preparedStepCount: 0,
        revision: 2,
        status: "prepared",
        stepCount: 0,
        updatedAt: now,
        version: 1
      }
    }]);
    const shared = await request({
      ...accessPayload,
      pathRewriteActivation: { expectedRevision: 2, jobId }
    });
    expect(shared.response.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body).toMatchObject({ revision: 2 });
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({
      folderId: null,
      type: "shared",
      vaultNameClaimId: "R".repeat(43)
    });
    expect(await readEmulatorDocument(`vaultMaintenanceJobs/${uid}/pathRewrites/${jobId}`))
      .toMatchObject({ revision: 3, status: "ready" });
  });

  it("authorizes a participant before CAS and hides revisions after policy, membership, or lifecycle removal", async () => {
    await activateVaultIntegrityMarker();
    const created = await request(createBody("P"));
    const noteId = String(created.body.noteId);
    const sharedWrappedKeys = {
      [uid]: wrappedKey,
      [participantUid]: wrappedKey
    };
    const shared = await request({
      action: "access",
      expectedRevision: 1,
      folderId: null,
      noteId,
      participantUids: [uid, participantUid],
      type: "shared",
      wrappedKeys: sharedWrappedKeys
    });
    expect(shared.response.status).toBe(200);
    expect(shared.body).toMatchObject({ revision: 2 });

    const participantUpdate = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "participant-body" },
      encryptedTitle: title,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 2,
      noteId,
      readerUids: [uid, participantUid]
    }, participantIdToken);
    expect(participantUpdate.response.status).toBe(200);
    expect(participantUpdate.body).toMatchObject({ revision: 3 });

    await writeEmulatorDocuments([{
      path: `users/${uid}`,
      fields: {
        allowedShareTargetUids: [],
        displayName: "Vault note owner",
        featureAccess: { notes: true },
        isActive: true,
        isAdmin: false,
        uid
      }
    }]);
    const policyRemovedProbe = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "policy-removed-probe" },
      encryptedTitle: title,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 0,
      noteId,
      readerUids: [uid, participantUid]
    }, participantIdToken);
    expect(policyRemovedProbe.response.status).toBe(404);
    expect(policyRemovedProbe.body).not.toHaveProperty("actualRevision");

    await writeEmulatorDocuments([{
      path: `users/${uid}`,
      fields: {
        allowedShareTargetUids: [participantUid],
        displayName: "Vault note owner",
        featureAccess: { notes: true },
        isActive: true,
        isAdmin: false,
        uid
      }
    }]);
    const removed = await request({
      action: "access",
      expectedRevision: 3,
      folderId: null,
      noteId,
      participantUids: [uid],
      type: "personal",
      wrappedKeys: { [uid]: wrappedKey }
    });
    expect(removed.body).toMatchObject({ revision: 4 });

    const removedParticipantProbe = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "removed-participant-probe" },
      encryptedTitle: title,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 0,
      noteId,
      readerUids: [uid, participantUid]
    }, participantIdToken);
    expect(removedParticipantProbe.response.status).toBe(404);
    expect(removedParticipantProbe.body).not.toHaveProperty("actualRevision");

    expect((await request({
      action: "access",
      expectedRevision: 4,
      folderId: null,
      noteId,
      participantUids: [uid, participantUid],
      type: "shared",
      wrappedKeys: sharedWrappedKeys
    })).body).toMatchObject({ revision: 5 });
    expect((await request({
      action: "trash",
      expectedRevision: 5,
      noteId,
      readerUids: [uid, participantUid]
    })).body).toMatchObject({ revision: 6 });

    const deletedParticipantProbe = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "deleted-participant-probe" },
      encryptedTitle: title,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 0,
      noteId,
      readerUids: [uid, participantUid]
    }, participantIdToken);
    expect(deletedParticipantProbe.response.status).toBe(404);
    expect(deletedParticipantProbe.body).not.toHaveProperty("actualRevision");
  });

  it("allows only explicit legacy recovery before the ready cutover", async () => {
    await writeEmulatorDocuments([{
      path: "notes/legacy-pre-cutover",
      fields: legacyNoteFields()
    }]);

    const updated = await request({
      action: "update",
      changedFields: ["title", "body"],
      encryptedBody: { ...body, cipherText: "legacy-updated-body" },
      encryptedTitle: { ...title, cipherText: "legacy-updated-title" },
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      noteId: "legacy-pre-cutover",
      readerUids: [uid]
    });
    expect(updated.response.status).toBe(409);
    expect(updated.body).toMatchObject({ error: "vault_integrity_not_ready", ok: false });
    expect(await readEmulatorDocument("notes/legacy-pre-cutover")).not.toHaveProperty("contentFormat");
    expect(await readEmulatorDocument("notes/legacy-pre-cutover")).not.toHaveProperty("vaultNameClaimId");

    const prematureMigration = await request({
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      noteId: "legacy-pre-cutover",
      readerUids: [uid]
    });
    expect(prematureMigration.response.status).toBe(409);
    expect(prematureMigration.body).toMatchObject({
      error: "vault_integrity_not_ready",
      ok: false
    });
    expect(await readEmulatorDocument("notes/legacy-pre-cutover"))
      .not.toHaveProperty("contentFormat");

    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: vaultIntegrityMarkerFields(uid, "pending")
      },
      {
        path: "notes/legacy-post-cutover",
        fields: legacyNoteFields()
      },
      {
        path: "notes/legacy-post-cutover-deleted",
        fields: legacyNoteFields({ deleted: true })
      },
      {
        path: "notes/legacy-post-cutover-deferred",
        fields: legacyNoteFields()
      },
      {
        path: "notes/claim-metadata-only",
        fields: {
          ...legacyNoteFields(),
          contentFormat: "markdown-v1",
          entryKind: "markdown",
          vaultNameClaimId: "B".repeat(43),
          vaultNameIndexVersion: 1
        }
      }
    ]);

    const repairedMissingClaim = await request({
      action: "backfill-claim",
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 1,
      leaseGeneration,
      leaseId,
      nameClaim: { claimId: "B".repeat(43), indexVersion: 1, parentId: null },
      noteId: "claim-metadata-only",
      readerUids: [uid]
    });
    expect(repairedMissingClaim.response.status).toBe(200);
    expect(repairedMissingClaim.body).toMatchObject({ revision: 2 });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"B".repeat(43)}`))
      .toMatchObject({
        ownerUid: uid,
        parentId: null,
        targetId: "claim-metadata-only",
        targetType: "entry"
      });

    const rejectedRequests = [
      {
        action: "update",
        changedFields: ["body"],
        encryptedBody: { ...body, cipherText: "post-cutover-body" },
        encryptedTitle: title,
        expectedContentFormat: "legacy-html-v1",
        expectedEntryKind: "legacy-html",
        expectedRevision: 1,
        noteId: "legacy-post-cutover",
        readerUids: [uid]
      },
      {
        action: "access",
        expectedRevision: 1,
        folderId: null,
        noteId: "legacy-post-cutover",
        participantUids: [uid, participantUid],
        type: "shared",
        wrappedKeys: { [uid]: wrappedKey, [participantUid]: wrappedKey }
      },
      {
        action: "trash",
        expectedRevision: 1,
        noteId: "legacy-post-cutover",
        readerUids: [uid]
      },
      {
        action: "restore",
        expectedRevision: 1,
        noteId: "legacy-post-cutover-deleted",
        readerUids: [uid]
      }
    ];
    for (const rejectedRequest of rejectedRequests) {
      const rejected = await request(rejectedRequest);
      expect(rejected.response.status).toBe(409);
      expect(rejected.body).toMatchObject({ error: "vault_integrity_not_ready", ok: false });
    }
    expect(await readEmulatorDocument("notes/legacy-post-cutover")).toMatchObject({ revision: 1 });
    expect(await readEmulatorDocument("notes/legacy-post-cutover-deleted")).toMatchObject({
      isDeleted: true,
      revision: 1
    });

    const unfencedMigration = await request({
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      nameClaim: { claimId: "M".repeat(43), indexVersion: 1, parentId: null },
      noteId: "legacy-post-cutover",
      readerUids: [uid]
    });
    expect(unfencedMigration.response.status).toBe(400);
    expect(unfencedMigration.body).toMatchObject({ error: "invalid_request", ok: false });
    const wrongLeaseMigration = await request({
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      leaseGeneration,
      leaseId: "x".repeat(43),
      nameClaim: { claimId: "M".repeat(43), indexVersion: 1, parentId: null },
      noteId: "legacy-post-cutover",
      readerUids: [uid]
    });
    expect(wrongLeaseMigration.response.status).toBe(409);
    expect(wrongLeaseMigration.body).toMatchObject({ error: "vault_cutover_busy", ok: false });
    expect(await readEmulatorDocument("notes/legacy-post-cutover")).not.toHaveProperty("contentFormat");

    const migratedActive = await request({
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      leaseGeneration,
      leaseId,
      nameClaim: { claimId: "M".repeat(43), indexVersion: 1, parentId: null },
      noteId: "legacy-post-cutover",
      readerUids: [uid]
    });
    expect(migratedActive.response.status).toBe(200);
    expect(migratedActive.body).toMatchObject({ claimState: "reserved", revision: 2 });
    expect(await readEmulatorDocument("notes/legacy-post-cutover")).toMatchObject({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      vaultNameClaimId: "M".repeat(43),
      vaultNameIndexVersion: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"M".repeat(43)}`))
      .toMatchObject({ targetId: "legacy-post-cutover" });

    const migratedDeferred = await request({
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      leaseGeneration,
      leaseId,
      noteId: "legacy-post-cutover-deferred",
      readerUids: [uid]
    });
    expect(migratedDeferred.response.status).toBe(200);
    expect(migratedDeferred.body).toMatchObject({ claimState: "deferred", revision: 2 });
    expect(await readEmulatorDocument("notes/legacy-post-cutover-deferred")).toMatchObject({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      isDeleted: false
    });
    expect(await readEmulatorDocument("notes/legacy-post-cutover-deferred"))
      .not.toHaveProperty("vaultNameClaimId");

    const migratedDeleted = await request({
      action: "migrate-legacy",
      expectedContentFormat: "legacy-html-v1",
      expectedEntryKind: "legacy-html",
      expectedRevision: 1,
      leaseGeneration,
      leaseId,
      noteId: "legacy-post-cutover-deleted",
      readerUids: [uid]
    });
    expect(migratedDeleted.response.status).toBe(200);
    expect(migratedDeleted.body).toMatchObject({ claimState: "deleted", revision: 2 });
    expect(await readEmulatorDocument("notes/legacy-post-cutover-deleted")).toMatchObject({
      contentFormat: "legacy-html-v1",
      entryKind: "legacy-html",
      isDeleted: true
    });
    expect(await readEmulatorDocument("notes/legacy-post-cutover-deleted"))
      .not.toHaveProperty("vaultNameClaimId");

    await writeEmulatorDocuments([{
      path: `vaultIntegrity/${uid}`,
      fields: vaultIntegrityMarkerFields(uid, "ready")
    }]);

    const restoredDeleted = await request({
      action: "restore",
      expectedRevision: 2,
      nameClaim: { claimId: "N".repeat(43), indexVersion: 1, parentId: null },
      noteId: "legacy-post-cutover-deleted",
      readerUids: [uid]
    });
    expect(restoredDeleted.response.status).toBe(200);
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"N".repeat(43)}`))
      .toMatchObject({ targetId: "legacy-post-cutover-deleted" });
    expect(await readEmulatorDocument("notes/legacy-post-cutover-deleted")).toMatchObject({
      isDeleted: false,
      vaultNameClaimId: "N".repeat(43),
      vaultNameIndexVersion: 1
    });
  });

  it("atomically repairs only an owner-owned historical shared folder path", async () => {
    const noteId = "historical-shared-folder";
    const claimId = "R".repeat(43);
    const repairedTitle = { ...title, cipherText: "historical-shared-repaired-title" };
    const historySummary = { ...body, cipherText: "historical-shared-repair-summary" };
    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: vaultIntegrityMarkerFields(uid, "pending")
      },
      {
        path: `notes/${noteId}`,
        fields: {
          ...legacyNoteFields({ shared: true }),
          contentFormat: "markdown-v1",
          entryKind: "markdown",
          folderId: "legacy-folder"
        }
      }
    ]);

    const repaired = await request({
      action: "resolve-collision",
      changedFields: ["folder", "name-claim", "title"],
      encryptedTitle: repairedTitle,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 1,
      folderId: null,
      historySummary,
      nameClaim: { claimId, indexVersion: 1, parentId: null },
      noteId,
      readerUids: [uid, participantUid]
    });

    expect(repaired.response.status).toBe(200);
    expect(repaired.body).toMatchObject({ noteId, revision: 2 });
    const mutationId = String(repaired.body.lastMutationId);
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({
      contentFormat: "markdown-v1",
      encryptedBody: body,
      encryptedTitle: repairedTitle,
      entryKind: "markdown",
      folderId: null,
      ownerUid: uid,
      participantUids: [uid, participantUid],
      revision: 2,
      type: "shared",
      vaultNameClaimId: claimId,
      vaultNameIndexVersion: 1,
      wrappedKeys: {
        [uid]: wrappedKey,
        [participantUid]: wrappedKey
      }
    });
    expect(await readEmulatorDocument(`notes/${noteId}/history/${mutationId}`)).toMatchObject({
      action: "content",
      actorUid: uid,
      changedFields: ["folder", "name-claim", "title"],
      encryptedSummary: historySummary,
      noteId,
      readerUids: [uid, participantUid],
      revision: 2
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${claimId}`))
      .toMatchObject({
        ownerUid: uid,
        parentId: null,
        targetId: noteId,
        targetType: "entry"
      });
  });

  it("rejects every broader shared-folder collision mutation and rolls back claim conflicts", async () => {
    const rootNoteId = "shared-root-move-rejected";
    const otherFolderNoteId = "shared-other-folder-rejected";
    const participantNoteId = "shared-participant-rejected";
    const rollbackNoteId = "shared-claim-rollback";
    const rootClaimId = "S".repeat(43);
    const otherClaimId = "T".repeat(43);
    const participantClaimId = "U".repeat(43);
    const occupiedClaimId = "V".repeat(43);
    const sharedFields = {
      ...legacyNoteFields({ shared: true }),
      contentFormat: "markdown-v1",
      entryKind: "markdown"
    };
    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: vaultIntegrityMarkerFields(uid, "pending")
      },
      {
        path: `notes/${rootNoteId}`,
        fields: sharedFields
      },
      {
        path: `notes/${otherFolderNoteId}`,
        fields: { ...sharedFields, folderId: "legacy-folder" }
      },
      {
        path: `notes/${participantNoteId}`,
        fields: { ...sharedFields, folderId: "legacy-folder" }
      },
      {
        path: `notes/${rollbackNoteId}`,
        fields: { ...sharedFields, folderId: "legacy-folder" }
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${occupiedClaimId}`,
        fields: {
          indexVersion: 1,
          ownerUid: uid,
          parentId: null,
          targetId: "different-active-target",
          targetType: "entry"
        }
      }
    ]);

    const collisionRequest = (
      noteId: string,
      claimId: string,
      folderId: string | null,
      encryptedTitle: Record<string, unknown> = title
    ) => ({
      action: "resolve-collision",
      changedFields: ["folder", "name-claim", "title"],
      encryptedTitle,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 1,
      folderId,
      nameClaim: { claimId, indexVersion: 1, parentId: folderId },
      noteId,
      readerUids: [uid, participantUid]
    });

    const rootToFolder = await request(collisionRequest(
      rootNoteId,
      rootClaimId,
      "new-folder",
      { ...title, cipherText: "root-to-folder-rejected" }
    ));
    expect(rootToFolder.response.status).toBe(409);
    expect(rootToFolder.body).toMatchObject({ error: "vault_note_state_mismatch", ok: false });

    const folderToOtherFolder = await request(collisionRequest(
      otherFolderNoteId,
      otherClaimId,
      "different-folder",
      { ...title, cipherText: "folder-to-other-rejected" }
    ));
    expect(folderToOtherFolder.response.status).toBe(409);
    expect(folderToOtherFolder.body).toMatchObject({
      error: "vault_note_state_mismatch",
      ok: false
    });

    const participantRepair = await request(collisionRequest(
      participantNoteId,
      participantClaimId,
      null,
      { ...title, cipherText: "participant-repair-rejected" }
    ), participantIdToken);
    expect(participantRepair.response.status).toBe(404);
    expect(participantRepair.body).not.toHaveProperty("actualRevision");

    const occupiedClaim = await request(collisionRequest(
      rollbackNoteId,
      occupiedClaimId,
      null,
      { ...title, cipherText: "must-roll-back" }
    ));
    expect(occupiedClaim.response.status).toBe(409);
    expect(occupiedClaim.body).toMatchObject({ error: "vault_name_conflict", ok: false });

    for (const [noteId, folderId] of [
      [rootNoteId, null],
      [otherFolderNoteId, "legacy-folder"],
      [participantNoteId, "legacy-folder"],
      [rollbackNoteId, "legacy-folder"]
    ] as const) {
      expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({
        encryptedBody: body,
        encryptedTitle: title,
        folderId,
        lastMutationId: "legacy-seed-mutation",
        participantUids: [uid, participantUid],
        revision: 1,
        type: "shared"
      });
    }
    for (const claimId of [rootClaimId, otherClaimId, participantClaimId]) {
      expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${claimId}`)).toBeNull();
    }
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${occupiedClaimId}`))
      .toMatchObject({ targetId: "different-active-target" });
  });

  it("lets an active admin trash but never restore or rewrite another owner's note", async () => {
    await activateVaultIntegrityMarker();
    const created = await request(createBody("F"));
    expect(created.response.status).toBe(200);
    const noteId = String(created.body.noteId);

    const admin = await createEmulatorOwner(
      `vault-note-admin-${Date.now()}@example.test`,
      "emulator-admin-password"
    );
    await writeEmulatorDocuments([{
      path: `users/${admin.localId}`,
      fields: {
        displayName: "Vault note admin",
        featureAccess: { notes: true },
        isActive: true,
        isAdmin: true,
        uid: admin.localId
      }
    }]);

    const hiddenRevisionProbe = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "admin-rewrite" },
      encryptedTitle: title,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 0,
      noteId,
      readerUids: [uid]
    }, admin.idToken);
    expect(hiddenRevisionProbe.response.status).toBe(404);
    expect(hiddenRevisionProbe.body).not.toHaveProperty("actualRevision");

    const trashed = await request({
      action: "trash",
      expectedRevision: 1,
      noteId,
      readerUids: [uid]
    }, admin.idToken);
    expect(trashed.response.status).toBe(200);
    expect(trashed.body).toMatchObject({ revision: 2 });
    const historyId = String(trashed.body.lastMutationId);
    expect(await readEmulatorDocument(`notes/${noteId}/history/${historyId}`)).toMatchObject({
      action: "delete",
      actorUid: admin.localId,
      revision: 2
    });

    const adminRestore = await request({
      action: "restore",
      expectedRevision: 2,
      noteId,
      readerUids: [uid]
    }, admin.idToken);
    expect(adminRestore.response.status).toBe(404);

    const adminRewrite = await request({
      action: "update",
      changedFields: ["body"],
      encryptedBody: { ...body, cipherText: "admin-rewrite" },
      encryptedTitle: title,
      expectedContentFormat: "markdown-v1",
      expectedEntryKind: "markdown",
      expectedRevision: 2,
      noteId,
      readerUids: [uid]
    }, admin.idToken);
    expect(adminRewrite.response.status).toBe(404);
    expect(adminRewrite.body).not.toHaveProperty("actualRevision");

    const restored = await request({
      action: "restore",
      expectedRevision: 2,
      noteId,
      readerUids: [uid]
    });
    expect(restored.response.status).toBe(200);
    expect(restored.body).toMatchObject({ revision: 3 });
  });

  it("enforces staging import provenance and returns an exact idempotent retry", async () => {
    const importJobId = `vi1_${"I".repeat(43)}`;
    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: vaultIntegrityMarkerFields(uid)
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${importJobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "staging",
          version: 1
        }
      }
    ]);
    const importedBody = {
      ...createBody("I"),
      action: "import-create",
      importJobId,
      noteId: "imported-note"
    };
    const created = await request(importedBody);
    expect(created.response.status).toBe(200);
    const retry = await request(importedBody);
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      lastMutationId: created.body.lastMutationId,
      noteId: "imported-note",
      revision: 1
    });

    const forged = await request({
      ...createBody("F"),
      action: "import-create",
      importJobId: `vi1_${"Z".repeat(43)}`,
      noteId: "forged-import-note"
    });
    expect(forged.response.status).toBe(409);
    expect(await readEmulatorDocument("notes/forged-import-note")).toBeNull();
  });

  it("rejects unknown fields before any service-account write", async () => {
    const rejected = await request({
      ...createBody("X"),
      ownerUid: "attacker-controlled"
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: "invalid_request", ok: false });
  });
});
