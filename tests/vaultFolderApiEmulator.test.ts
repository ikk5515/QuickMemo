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
  secureShareApiEmulatorProjectId,
  type SecureShareApiHarness,
  writeEmulatorDocuments
} from "./helpers/secureShareApiEmulator.js";

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const encryptedName = {
  algorithm: "AES-GCM",
  cipherText: "cipher",
  iv: "iv",
  version: 1
} as const;

const wrappedKey = {
  algorithm: "RSA-OAEP",
  version: 1,
  wrappedKey: "wrapped-key"
} as const;
const leaseId = "l".repeat(43);
const leaseGeneration = "g".repeat(43);

async function startVaultFolderHarness(): Promise<SecureShareApiHarness> {
  const moduleUrl = new URL("../api/vault-folders.js", import.meta.url);
  moduleUrl.searchParams.set("integration-instance", String(Date.now()));
  const module = await import(/* @vite-ignore */ moduleUrl.href) as typeof import("../api/vault-folders.js");
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

function createBody(folderId: string, parentId: string | null, claimCharacter: string) {
  return {
    action: "create",
    color: "#7c5cff",
    encryptedName,
    folderId,
    nameClaim: {
      claimId: claimCharacter.repeat(43),
      indexVersion: 1,
      parentId
    },
    order: 0,
    parentId,
    wrappedKey
  };
}

function unclaimedFolderFields(
  ownerUid: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    color: "#7c5cff",
    encryptedName,
    isDeleted: false,
    name: "암호화 폴더",
    order: 0,
    ownerUid,
    parentId: null,
    revision: 1,
    vaultLineageGeneration: 1,
    wrappedKey,
    ...overrides
  };
}

function resolveCollisionBody(
  folderId: string,
  claimCharacter: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    action: "resolve-collision",
    encryptedName: { ...encryptedName, cipherText: `resolved-${claimCharacter}` },
    expectedRevision: 1,
    folderId,
    nameClaim: {
      claimId: claimCharacter.repeat(43),
      indexVersion: 1,
      parentId: null
    },
    ...overrides
  };
}

async function deleteEmulatorDocument(path: string) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error("FIRESTORE_EMULATOR_HOST is required");
  const response = await fetch(
    `http://${host}/v1/projects/${secureShareApiEmulatorProjectId}/databases/(default)/documents/${path}`,
    {
      method: "DELETE",
      headers: { authorization: "Bearer owner" }
    }
  );
  if (!response.ok) throw new Error(`Failed to delete emulator document: ${response.status}`);
}

describeEmulator("Vault folder API emulator transaction", () => {
  let harness: SecureShareApiHarness;
  let idToken = "";
  let uid = "";

  async function request(body: Record<string, unknown>) {
    const response = await fetch(`${harness.origin}/api/vault-folders`, {
      method: "POST",
      headers: {
        ...apiHeaders(harness.origin, { authorization: idToken }),
        "x-quickmemo-vault-folder-tree": "1"
      },
      body: JSON.stringify(body)
    });
    return {
      body: await response.json() as Record<string, unknown>,
      response
    };
  }

  async function setPendingIntegrityMarker(leased = false) {
    const now = new Date();
    await writeEmulatorDocuments([{
      path: `vaultIntegrity/${uid}`,
      fields: {
        createdAt: now,
        cutoverState: "pending",
        cutoverVersion: 1,
        indexVersion: 1,
        ownerUid: uid,
        updatedAt: now,
        ...(leased ? {
          cutoverLeaseAcquiredAt: now,
          cutoverLeaseExpiresAt: new Date(now.getTime() + 90_000),
          cutoverLeaseGeneration: leaseGeneration,
          cutoverLeaseHash: createHash("sha256").update(leaseId, "utf8").digest("base64url"),
          cutoverLeaseVersion: 1
        } : {}),
        wrappedKey: {
          algorithm: "RSA-OAEP",
          version: 1,
          wrappedKey: "wrapped-integrity-key"
        }
      }
    }]);
  }

  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    harness = await startVaultFolderHarness();
  });

  beforeEach(async () => {
    await clearSecureShareEmulators();
    const owner = await createEmulatorOwner(
      `vault-folder-${Date.now()}@example.test`,
      "emulator-owner-password"
    );
    idToken = owner.idToken;
    uid = owner.localId;
    const now = new Date("2026-08-23T00:00:00.000Z");
    await writeEmulatorDocuments([
      {
        path: `users/${uid}`,
        fields: {
          displayName: "Vault folder owner",
          featureAccess: { notes: true },
          isActive: true,
          isAdmin: false,
          uid
        }
      },
      {
        path: `vaultIntegrity/${uid}`,
        fields: {
          createdAt: now,
          cutoverState: "ready",
          cutoverVersion: 1,
          indexVersion: 1,
          ownerUid: uid,
          updatedAt: now,
          verifiedAt: now,
          wrappedKey: {
            algorithm: "RSA-OAEP",
            version: 1,
            wrappedKey: "wrapped-integrity-key"
          }
        }
      }
    ]);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("atomically creates the tree, folder, and claim and rejects a mismatched response-loss retry", async () => {
    const payload = createBody("root", null, "R");
    const created = await request(payload);
    expect(created.response.status).toBe(200);
    expect(created.body).toMatchObject({ folderId: "root", revision: 1, treeRevision: 2 });

    expect(await readEmulatorDocument(`noteFolders/root`)).toMatchObject({
      encryptedName,
      ownerUid: uid,
      revision: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"R".repeat(43)}`))
      .toMatchObject({ targetId: "root", targetType: "folder" });
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toMatchObject({
      folderCount: 1,
      nodes: { root: { active: true, parentId: null, selfActive: true } }
    });

    const retry = await request(payload);
    expect(retry.response.status).toBe(200);

    const mismatched = await request({
      ...payload,
      encryptedName: { ...encryptedName, cipherText: "different-ciphertext" }
    });
    expect(mismatched.response.status).toBe(409);
    expect(await readEmulatorDocument(`noteFolders/root`)).toMatchObject({ encryptedName });
  });

  it("atomically resolves an unclaimed encrypted folder collision", async () => {
    await writeEmulatorDocuments([
      {
        path: "noteFolders/duplicate-folder",
        fields: {
          color: "#7c5cff",
          encryptedName,
          isDeleted: false,
          name: "암호화 폴더",
          order: 0,
          ownerUid: uid,
          parentId: null,
          revision: 1,
          vaultLineageGeneration: 1,
          wrappedKey
        }
      }
    ]);

    const ordinaryUpdate = await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "ordinary-update" },
      expectedRevision: 1,
      folderId: "duplicate-folder",
      nameClaim: { claimId: "D".repeat(43), indexVersion: 1, parentId: null }
    });
    expect(ordinaryUpdate.response.status).toBe(409);
    await setPendingIntegrityMarker();

    await writeEmulatorDocuments([{
      path: `vaultIntegrity/${uid}/nameClaims/${"E".repeat(43)}`,
      fields: {
        indexVersion: 1,
        ownerUid: uid,
        parentId: null,
        targetId: "another-folder",
        targetType: "folder"
      }
    }]);
    const occupied = await request({
      action: "resolve-collision",
      encryptedName: { ...encryptedName, cipherText: "must-not-overwrite" },
      expectedRevision: 1,
      folderId: "duplicate-folder",
      nameClaim: { claimId: "E".repeat(43), indexVersion: 1, parentId: null }
    });
    expect(occupied.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/duplicate-folder")).toMatchObject({
      encryptedName,
      revision: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"E".repeat(43)}`))
      .toMatchObject({ targetId: "another-folder" });

    const resolved = await request({
      action: "resolve-collision",
      encryptedName: { ...encryptedName, cipherText: "resolved-name" },
      expectedRevision: 1,
      folderId: "duplicate-folder",
      nameClaim: { claimId: "D".repeat(43), indexVersion: 1, parentId: null }
    });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body).toMatchObject({ folderId: "duplicate-folder", revision: 2 });
    expect(await readEmulatorDocument("noteFolders/duplicate-folder")).toMatchObject({
      encryptedName: { ...encryptedName, cipherText: "resolved-name" },
      revision: 2,
      vaultNameClaimId: "D".repeat(43),
      vaultNameIndexVersion: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"D".repeat(43)}`))
      .toMatchObject({
        ownerUid: uid,
        parentId: null,
        targetId: "duplicate-folder",
        targetType: "folder"
      });
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toMatchObject({
      folderCount: 1,
      nodes: {
        "duplicate-folder": {
          active: true,
          generation: 1,
          parentId: null,
          selfActive: true
        }
      },
      ownerUid: uid,
      schemaVersion: 1
    });
  });

  it("atomically encrypts and resolves a deferred legacy folder collision without a bulk lease", async () => {
    await writeEmulatorDocuments([{
      path: "noteFolders/legacy-duplicate",
      fields: {
        color: "#7c5cff",
        isDeleted: false,
        name: "Project",
        order: 7,
        ownerUid: uid,
        parentId: null
      }
    }]);
    await setPendingIntegrityMarker();

    const resolved = await request({
      action: "resolve-collision",
      color: "#7c5cff",
      encryptedName: { ...encryptedName, cipherText: "legacy-resolved" },
      expectedName: "Project",
      folderId: "legacy-duplicate",
      nameClaim: { claimId: "L".repeat(43), indexVersion: 1, parentId: null },
      order: 7,
      parentId: null,
      wrappedKey
    });

    expect(resolved.response.status).toBe(200);
    expect(resolved.body).toMatchObject({ folderId: "legacy-duplicate", revision: 1 });
    expect(await readEmulatorDocument("noteFolders/legacy-duplicate")).toMatchObject({
      encryptedName: { ...encryptedName, cipherText: "legacy-resolved" },
      name: "암호화 폴더",
      parentId: null,
      revision: 1,
      vaultNameClaimId: "L".repeat(43),
      vaultNameIndexVersion: 1,
      wrappedKey
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"L".repeat(43)}`))
      .toMatchObject({
        ownerUid: uid,
        parentId: null,
        targetId: "legacy-duplicate",
        targetType: "folder"
      });
  });

  it("backfills the first claim for an already encrypted folder only under the pending cutover lease", async () => {
    await writeEmulatorDocuments([{
      path: "noteFolders/encrypted-without-claim",
      fields: {
        color: "#7c5cff",
        encryptedName,
        isDeleted: false,
        name: "암호화 폴더",
        order: 3,
        ownerUid: uid,
        parentId: null,
        revision: 1,
        wrappedKey
      }
    }]);
    await setPendingIntegrityMarker(true);

    const unfenced = await request({
      action: "update",
      expectedRevision: 1,
      folderId: "encrypted-without-claim",
      nameClaim: { claimId: "F".repeat(43), indexVersion: 1, parentId: null }
    });
    expect(unfenced.response.status).toBe(400);

    const repaired = await request({
      action: "update",
      expectedRevision: 1,
      folderId: "encrypted-without-claim",
      leaseGeneration,
      leaseId,
      nameClaim: { claimId: "F".repeat(43), indexVersion: 1, parentId: null }
    });
    expect(repaired.response.status).toBe(200);
    expect(repaired.body).toMatchObject({ folderId: "encrypted-without-claim", revision: 2 });
    expect(await readEmulatorDocument("noteFolders/encrypted-without-claim")).toMatchObject({
      revision: 2,
      vaultNameClaimId: "F".repeat(43),
      vaultNameIndexVersion: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"F".repeat(43)}`))
      .toMatchObject({
        ownerUid: uid,
        parentId: null,
        targetId: "encrypted-without-claim",
        targetType: "folder"
      });
  });

  it("keeps concurrent explicit collision recovery revision-and-claim atomic without a bulk lease", async () => {
    await setPendingIntegrityMarker();
    await writeEmulatorDocuments([{
      path: "noteFolders/concurrent-collision",
      fields: unclaimedFolderFields(uid)
    }]);

    const results = await Promise.all([
      request(resolveCollisionBody("concurrent-collision", "A")),
      request(resolveCollisionBody("concurrent-collision", "B"))
    ]);
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
    const stored = await readEmulatorDocument("noteFolders/concurrent-collision");
    expect(stored).toMatchObject({ revision: 2, vaultNameIndexVersion: 1 });
    const winningClaimId = String(stored?.vaultNameClaimId);
    expect(["A".repeat(43), "B".repeat(43)]).toContain(winningClaimId);
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${winningClaimId}`))
      .toMatchObject({ targetId: "concurrent-collision", targetType: "folder" });
    const losingClaimId = winningClaimId === "A".repeat(43) ? "B".repeat(43) : "A".repeat(43);
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${losingClaimId}`)).toBeNull();
  });

  it("fences pending legacy folder migration with the marker lease pair", async () => {
    await setPendingIntegrityMarker(true);
    await writeEmulatorDocuments([{
      path: "noteFolders/leased-legacy-folder",
      fields: {
        color: "#7c5cff",
        isDeleted: false,
        name: "Legacy leased folder",
        order: 0,
        ownerUid: uid,
        parentId: null
      }
    }]);
    const migrationBody = {
      action: "migrate",
      color: "#7c5cff",
      encryptedName,
      expectedName: "Legacy leased folder",
      folderId: "leased-legacy-folder",
      nameClaim: { claimId: "Z".repeat(43), indexVersion: 1, parentId: null },
      order: 0,
      parentId: null,
      wrappedKey
    };

    const missingLease = await request(migrationBody);
    expect(missingLease.response.status).toBe(400);
    expect(missingLease.body).toMatchObject({ error: "invalid_request", ok: false });
    const wrongLease = await request({
      ...migrationBody,
      leaseGeneration,
      leaseId: "x".repeat(43)
    });
    expect(wrongLease.response.status).toBe(409);
    expect(wrongLease.body).toMatchObject({ error: "vault_cutover_busy", ok: false });
    expect(await readEmulatorDocument("noteFolders/leased-legacy-folder"))
      .not.toHaveProperty("encryptedName");

    const migrated = await request({ ...migrationBody, leaseGeneration, leaseId });
    expect(migrated.response.status).toBe(200);
    expect(await readEmulatorDocument("noteFolders/leased-legacy-folder")).toMatchObject({
      encryptedName,
      revision: 1,
      vaultNameClaimId: "Z".repeat(43)
    });
  });

  it("rejects full or partial claim metadata and preserves the claimed folder", async () => {
    await setPendingIntegrityMarker();
    const cases = [
      {
        label: "full",
        fields: {
          vaultNameClaimId: "F".repeat(43),
          vaultNameIndexVersion: 1
        }
      },
      {
        label: "claim-id-only",
        fields: { vaultNameClaimId: "P".repeat(43) }
      },
      {
        label: "index-only",
        fields: { vaultNameIndexVersion: 1 }
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const folderId = `claimed-${testCase.label}`;
      const claimCharacter = String(index + 1);
      await writeEmulatorDocuments([{
        path: `noteFolders/${folderId}`,
        fields: unclaimedFolderFields(uid, testCase.fields)
      }]);

      const rejected = await request(resolveCollisionBody(folderId, claimCharacter));
      expect(rejected.response.status).toBe(409);
      expect(rejected.body).toMatchObject({ error: "vault_folder_state_mismatch", ok: false });
      expect(await readEmulatorDocument(`noteFolders/${folderId}`)).toMatchObject({
        encryptedName,
        revision: 1,
        ...testCase.fields
      });
      expect(await readEmulatorDocument(
        `vaultIntegrity/${uid}/nameClaims/${claimCharacter.repeat(43)}`
      )).toBeNull();
    }
  });

  it("rejects deleted, unchanged, and unknown-field collision requests without writes", async () => {
    await setPendingIntegrityMarker();
    await writeEmulatorDocuments([
      {
        path: "noteFolders/deleted-collision",
        fields: unclaimedFolderFields(uid, { isDeleted: true })
      },
      {
        path: "noteFolders/unchanged-collision",
        fields: unclaimedFolderFields(uid)
      },
      {
        path: "noteFolders/unknown-field-collision",
        fields: unclaimedFolderFields(uid)
      }
    ]);

    const deleted = await request(resolveCollisionBody("deleted-collision", "G"));
    expect(deleted.response.status).toBe(409);
    expect(deleted.body).toMatchObject({ error: "vault_folder_state_mismatch", ok: false });

    const unchanged = await request(resolveCollisionBody("unchanged-collision", "H", {
      encryptedName
    }));
    expect(unchanged.response.status).toBe(400);
    expect(unchanged.body).toMatchObject({ error: "invalid_request", ok: false });

    const unknownField = await request(resolveCollisionBody("unknown-field-collision", "K", {
      plaintextName: "must-not-be-accepted"
    }));
    expect(unknownField.response.status).toBe(400);
    expect(unknownField.body).toMatchObject({ error: "invalid_request", ok: false });
    expect(JSON.stringify(unknownField.body)).not.toContain("must-not-be-accepted");

    for (const [folderId, claimCharacter, deletedState] of [
      ["deleted-collision", "G", true],
      ["unchanged-collision", "H", false],
      ["unknown-field-collision", "K", false]
    ] as const) {
      expect(await readEmulatorDocument(`noteFolders/${folderId}`)).toMatchObject({
        encryptedName,
        isDeleted: deletedState,
        revision: 1
      });
      expect(await readEmulatorDocument(
        `vaultIntegrity/${uid}/nameClaims/${claimCharacter.repeat(43)}`
      )).toBeNull();
    }
  });

  it("keeps an imported collision target locked while its source import is nonterminal", async () => {
    await setPendingIntegrityMarker();
    const jobId = `vi1_${"S".repeat(43)}`;
    await writeEmulatorDocuments([
      {
        path: "noteFolders/source-locked-collision",
        fields: unclaimedFolderFields(uid, { vaultImportJobId: jobId })
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${jobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "staging",
          version: 1
        }
      }
    ]);

    const rejected = await request(resolveCollisionBody("source-locked-collision", "S"));
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "vault_import_locked", ok: false });
    expect(await readEmulatorDocument("noteFolders/source-locked-collision")).toMatchObject({
      encryptedName,
      revision: 1,
      vaultImportJobId: jobId
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"S".repeat(43)}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toBeNull();
  });

  it("keeps ordinary collision recovery locked while any workspace import is live", async () => {
    await setPendingIntegrityMarker();
    const jobId = `vi1_${"W".repeat(43)}`;
    await writeEmulatorDocuments([
      {
        path: "noteFolders/workspace-locked-collision",
        fields: unclaimedFolderFields(uid)
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${jobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "preparing",
          version: 1
        }
      }
    ]);

    const rejected = await request(resolveCollisionBody("workspace-locked-collision", "W"));
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "vault_import_locked", ok: false });
    expect(await readEmulatorDocument("noteFolders/workspace-locked-collision")).toMatchObject({
      encryptedName,
      revision: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"W".repeat(43)}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toBeNull();
  });

  it("rejects collision recovery into a parent owned by an unfinished import", async () => {
    await setPendingIntegrityMarker();
    const jobId = `vi1_${"Q".repeat(43)}`;
    await writeEmulatorDocuments([
      {
        path: "noteFolders/import-parent",
        fields: unclaimedFolderFields(uid, {
          vaultImportJobId: jobId,
          vaultNameClaimId: "Q".repeat(43),
          vaultNameIndexVersion: 1
        })
      },
      {
        path: "noteFolders/parent-locked-collision",
        fields: unclaimedFolderFields(uid)
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${jobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "rolled-back",
          version: 1
        }
      }
    ]);

    const rejected = await request(resolveCollisionBody("parent-locked-collision", "T", {
      nameClaim: {
        claimId: "T".repeat(43),
        indexVersion: 1,
        parentId: "import-parent"
      },
      parentId: "import-parent"
    }));
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "vault_import_locked", ok: false });
    expect(await readEmulatorDocument("noteFolders/parent-locked-collision")).toMatchObject({
      parentId: null,
      revision: 1
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"T".repeat(43)}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toBeNull();
  });

  it("blocks legacy folder migration while its source import job is live and rolls back", async () => {
    const jobId = `vi1_${"L".repeat(43)}`;
    const claimId = "L".repeat(43);
    await writeEmulatorDocuments([
      {
        path: "noteFolders/legacy-source-locked",
        fields: {
          color: "#7c5cff",
          isDeleted: false,
          name: "Legacy source locked",
          order: 0,
          ownerUid: uid,
          parentId: null,
          vaultImportJobId: jobId
        }
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${jobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "staging",
          version: 1
        }
      }
    ]);

    const rejected = await request({
      action: "migrate",
      color: "#7c5cff",
      encryptedName,
      expectedName: "Legacy source locked",
      folderId: "legacy-source-locked",
      nameClaim: { claimId, indexVersion: 1, parentId: null },
      order: 0,
      parentId: null,
      wrappedKey
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "vault_import_locked", ok: false });
    const folder = await readEmulatorDocument("noteFolders/legacy-source-locked");
    expect(folder).toMatchObject({
      isDeleted: false,
      name: "Legacy source locked",
      ownerUid: uid,
      parentId: null,
      vaultImportJobId: jobId
    });
    expect(folder).not.toHaveProperty("encryptedName");
    expect(folder).not.toHaveProperty("wrappedKey");
    expect(folder).not.toHaveProperty("vaultNameClaimId");
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${claimId}`)).toBeNull();
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toBeNull();
  });

  it("blocks legacy folder migration while an unrelated workspace import is live and rolls back", async () => {
    const jobId = `vi1_${"U".repeat(43)}`;
    const claimId = "U".repeat(43);
    await writeEmulatorDocuments([
      {
        path: "noteFolders/legacy-workspace-locked",
        fields: {
          color: "#7c5cff",
          isDeleted: false,
          name: "Legacy workspace locked",
          order: 0,
          ownerUid: uid,
          parentId: null
        }
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${jobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "preparing",
          version: 1
        }
      }
    ]);

    const rejected = await request({
      action: "migrate",
      color: "#7c5cff",
      encryptedName,
      expectedName: "Legacy workspace locked",
      folderId: "legacy-workspace-locked",
      nameClaim: { claimId, indexVersion: 1, parentId: null },
      order: 0,
      parentId: null,
      wrappedKey
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "vault_import_locked", ok: false });
    const folder = await readEmulatorDocument("noteFolders/legacy-workspace-locked");
    expect(folder).toMatchObject({
      isDeleted: false,
      name: "Legacy workspace locked",
      ownerUid: uid,
      parentId: null
    });
    expect(folder).not.toHaveProperty("encryptedName");
    expect(folder).not.toHaveProperty("wrappedKey");
    expect(folder).not.toHaveProperty("vaultNameClaimId");
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${claimId}`)).toBeNull();
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toBeNull();
  });

  it("rejects a move cycle without partial writes and atomically fails a tombstoned subtree closed", async () => {
    expect((await request(createBody("root", null, "R"))).response.status).toBe(200);
    expect((await request(createBody("child", "root", "C"))).response.status).toBe(200);

    const cycle = await request({
      action: "move",
      expectedRevision: 1,
      folderId: "root",
      nameClaim: { claimId: "R".repeat(43), indexVersion: 1, parentId: "child" },
      parentId: "child"
    });
    expect(cycle.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/root")).toMatchObject({ parentId: null, revision: 1 });
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toMatchObject({
      nodes: {
        child: { active: true, parentId: "root" },
        root: { active: true, parentId: null }
      },
      revision: 3
    });

    const trashed = await request({
      action: "trash",
      expectedRevision: 1,
      folderId: "root"
    });
    expect(trashed.response.status).toBe(200);
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toMatchObject({
      nodes: {
        child: { active: false, parentId: "root", selfActive: true },
        root: { active: false, parentId: null, selfActive: false }
      }
    });

    const restored = await request({
      action: "restore",
      expectedRevision: 2,
      folderId: "root"
    });
    expect(restored.response.status).toBe(200);
    expect(await readEmulatorDocument(`vaultFolderTrees/${uid}`)).toMatchObject({
      nodes: {
        child: { active: true, selfActive: true },
        root: { active: true, selfActive: true }
      }
    });
  });

  it("enforces import provenance across the service-account folder boundary", async () => {
    const jobId = `vi1_${"I".repeat(43)}`;
    const otherJobId = `vi1_${"J".repeat(43)}`;
    const missingJobId = `vi1_${"Z".repeat(43)}`;
    const jobPath = `vaultMaintenanceJobs/${uid}/imports/${jobId}`;

    const forged = await request({
      ...createBody("forged-import-root", null, "F"),
      importJobId: missingJobId
    });
    expect(forged.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/forged-import-root")).toBeNull();

    await writeEmulatorDocuments([
      {
        path: jobPath,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "staging",
          version: 1
        }
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${otherJobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "staging",
          version: 1
        }
      }
    ]);

    expect((await request({
      ...createBody("import-root", null, "I"),
      importJobId: jobId
    })).response.status).toBe(200);
    expect((await request(createBody("ordinary-root", null, "O"))).response.status).toBe(200);

    await writeEmulatorDocuments([{
      path: "noteFolders/legacy-folder",
      fields: {
        color: "#7c5cff",
        isDeleted: false,
        name: "Legacy folder",
        order: 0,
        ownerUid: uid,
        parentId: null
      }
    }]);
    const legacyMigration = {
      action: "migrate",
      color: "#7c5cff",
      encryptedName,
      expectedName: "Legacy folder",
      folderId: "legacy-folder",
      nameClaim: { claimId: "L".repeat(43), indexVersion: 1, parentId: "import-root" },
      order: 0,
      parentId: "import-root",
      wrappedKey
    };
    const stagingLegacyMigration = await request(legacyMigration);
    expect(stagingLegacyMigration.response.status).toBe(409);
    const stagingLegacyFolder = await readEmulatorDocument("noteFolders/legacy-folder");
    expect(stagingLegacyFolder).toMatchObject({
      name: "Legacy folder",
      ownerUid: uid,
      parentId: null
    });
    expect(stagingLegacyFolder).not.toHaveProperty("encryptedName");
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${"L".repeat(43)}`))
      .toBeNull();

    const unrelatedChild = await request(createBody("unrelated-child", "import-root", "U"));
    expect(unrelatedChild.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/unrelated-child")).toBeNull();

    const mismatchedImportChild = await request({
      ...createBody("mismatched-import-child", "import-root", "M"),
      importJobId: otherJobId
    });
    expect(mismatchedImportChild.response.status).toBe(409);

    expect((await request({
      ...createBody("import-child", "import-root", "C"),
      importJobId: jobId
    })).response.status).toBe(200);

    const stagingRename = await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "renamed-during-staging" },
      expectedRevision: 1,
      folderId: "import-child",
      nameClaim: { claimId: "D".repeat(43), indexVersion: 1, parentId: "import-root" }
    });
    expect(stagingRename.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/import-child")).toMatchObject({
      encryptedName,
      revision: 1
    });

    const unrelatedMove = await request({
      action: "move",
      expectedRevision: 1,
      folderId: "ordinary-root",
      nameClaim: { claimId: "P".repeat(43), indexVersion: 1, parentId: "import-root" },
      parentId: "import-root"
    });
    expect(unrelatedMove.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/ordinary-root")).toMatchObject({
      parentId: null,
      revision: 1
    });

    await writeEmulatorDocuments([
      {
        path: jobPath,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "committed",
          version: 1
        }
      },
      {
        path: `vaultMaintenanceJobs/${uid}/imports/${otherJobId}`,
        fields: {
          kind: "vault-import-v1",
          ownerUid: uid,
          status: "committed",
          version: 1
        }
      }
    ]);

    const committedLegacyMigration = await request(legacyMigration);
    expect(committedLegacyMigration.response.status).toBe(200);
    const committedLegacyFolder = await readEmulatorDocument("noteFolders/legacy-folder");
    expect(committedLegacyFolder).toMatchObject({
      encryptedName,
      name: "암호화 폴더",
      ownerUid: uid,
      parentId: "import-root",
      revision: 1
    });
    expect(committedLegacyFolder).not.toHaveProperty("vaultImportJobId");

    const committedRename = await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "renamed-after-commit" },
      expectedRevision: 1,
      folderId: "import-child",
      nameClaim: { claimId: "D".repeat(43), indexVersion: 1, parentId: "import-root" }
    });
    expect(committedRename.response.status).toBe(200);
    expect(await readEmulatorDocument("noteFolders/import-child")).toMatchObject({
      encryptedName: { ...encryptedName, cipherText: "renamed-after-commit" },
      revision: 2,
      vaultImportJobId: jobId
    });

    await deleteEmulatorDocument(jobPath);
    const cleanedJobRename = await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "renamed-after-cleanup" },
      expectedRevision: 2,
      folderId: "import-child",
      nameClaim: { claimId: "E".repeat(43), indexVersion: 1, parentId: "import-root" }
    });
    expect(cleanedJobRename.response.status).toBe(200);
    expect(await readEmulatorDocument("noteFolders/import-child")).toMatchObject({
      encryptedName: { ...encryptedName, cipherText: "renamed-after-cleanup" },
      revision: 3,
      vaultImportJobId: jobId
    });

    const committedParentMove = await request({
      action: "move",
      expectedRevision: 1,
      folderId: "ordinary-root",
      nameClaim: { claimId: "P".repeat(43), indexVersion: 1, parentId: "import-root" },
      parentId: "import-root"
    });
    expect(committedParentMove.response.status).toBe(200);
  });

  it("locks existing folder topology while a nonterminal import may contain descendants", async () => {
    const jobId = `vi1_${"A".repeat(43)}`;
    const rolledBackJobId = `vi1_${"B".repeat(43)}`;
    const jobPath = `vaultMaintenanceJobs/${uid}/imports/${jobId}`;
    expect((await request(createBody("ordinary-ancestor", null, "A"))).response.status).toBe(200);
    expect((await request(createBody("destination", null, "B"))).response.status).toBe(200);
    expect((await request(createBody("restore-after-import", null, "C"))).response.status).toBe(200);
    expect((await request({
      action: "trash",
      expectedRevision: 1,
      folderId: "restore-after-import"
    })).response.status).toBe(200);

    await writeEmulatorDocuments([{
      path: jobPath,
      fields: {
        kind: "vault-import-v1",
        ownerUid: uid,
        status: "staging",
        version: 1
      }
    }]);
    expect((await request({
      ...createBody("staged-import-child", "ordinary-ancestor", "D"),
      importJobId: jobId
    })).response.status).toBe(200);
    await writeEmulatorDocuments([{
      path: "notes/staged-import-note",
      fields: {
        folderId: "ordinary-ancestor",
        ownerUid: uid,
        vaultImportJobId: jobId
      }
    }]);

    const lockedRename = await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "locked-rename" },
      expectedRevision: 1,
      folderId: "ordinary-ancestor",
      nameClaim: { claimId: "E".repeat(43), indexVersion: 1, parentId: null }
    });
    expect(lockedRename.response.status).toBe(409);
    const lockedMove = await request({
      action: "move",
      expectedRevision: 1,
      folderId: "ordinary-ancestor",
      nameClaim: { claimId: "F".repeat(43), indexVersion: 1, parentId: "destination" },
      parentId: "destination"
    });
    expect(lockedMove.response.status).toBe(409);
    expect((await request({
      action: "trash",
      expectedRevision: 1,
      folderId: "ordinary-ancestor"
    })).response.status).toBe(409);
    expect((await request({
      action: "restore",
      expectedRevision: 2,
      folderId: "restore-after-import"
    })).response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/ordinary-ancestor")).toMatchObject({
      isDeleted: false,
      parentId: null,
      revision: 1
    });
    expect(await readEmulatorDocument("notes/staged-import-note")).toMatchObject({
      folderId: "ordinary-ancestor",
      vaultImportJobId: jobId
    });

    await writeEmulatorDocuments([{
      path: jobPath,
      fields: {
        kind: "vault-import-v1",
        ownerUid: uid,
        status: "committed",
        version: 1
      }
    }]);
    expect((await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "allowed-after-commit" },
      expectedRevision: 1,
      folderId: "ordinary-ancestor",
      nameClaim: { claimId: "E".repeat(43), indexVersion: 1, parentId: null }
    })).response.status).toBe(200);
    expect((await request({
      action: "restore",
      expectedRevision: 2,
      folderId: "restore-after-import"
    })).response.status).toBe(200);

    await writeEmulatorDocuments([{
      path: `vaultMaintenanceJobs/${uid}/imports/${rolledBackJobId}`,
      fields: {
        kind: "vault-import-v1",
        ownerUid: uid,
        status: "rolled-back",
        version: 1
      }
    }]);
    expect((await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "allowed-with-rolled-back-job" },
      expectedRevision: 2,
      folderId: "ordinary-ancestor",
      nameClaim: { claimId: "E".repeat(43), indexVersion: 1, parentId: null }
    })).response.status).toBe(200);

    await deleteEmulatorDocument(jobPath);
    await deleteEmulatorDocument(`vaultMaintenanceJobs/${uid}/imports/${rolledBackJobId}`);
    expect((await request({
      action: "update",
      encryptedName: { ...encryptedName, cipherText: "allowed-after-cleanup" },
      expectedRevision: 3,
      folderId: "ordinary-ancestor",
      nameClaim: { claimId: "E".repeat(43), indexVersion: 1, parentId: null }
    })).response.status).toBe(200);
  });

  it("allows only rollback trash while an imported folder job is rolling back", async () => {
    const jobId = `vi1_${"R".repeat(43)}`;
    const jobPath = `vaultMaintenanceJobs/${uid}/imports/${jobId}`;
    await writeEmulatorDocuments([{
      path: jobPath,
      fields: {
        kind: "vault-import-v1",
        ownerUid: uid,
        status: "staging",
        version: 1
      }
    }]);
    expect((await request({
      ...createBody("rollback-root", null, "R"),
      importJobId: jobId
    })).response.status).toBe(200);

    await writeEmulatorDocuments([{
      path: jobPath,
      fields: {
        kind: "vault-import-v1",
        ownerUid: uid,
        status: "rolling-back",
        version: 1
      }
    }]);
    const trashed = await request({
      action: "trash",
      expectedRevision: 1,
      folderId: "rollback-root"
    });
    expect(trashed.response.status).toBe(200);

    await writeEmulatorDocuments([{
      path: jobPath,
      fields: {
        kind: "vault-import-v1",
        ownerUid: uid,
        status: "rolled-back",
        version: 1
      }
    }]);
    const restored = await request({
      action: "restore",
      expectedRevision: 2,
      folderId: "rollback-root"
    });
    expect(restored.response.status).toBe(409);
    expect(await readEmulatorDocument("noteFolders/rollback-root")).toMatchObject({
      isDeleted: true,
      revision: 2
    });
  });
});
