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
    await writeEmulatorDocuments([{
      path: `users/${uid}`,
      fields: {
        displayName: "Vault folder owner",
        featureAccess: { notes: true },
        isActive: true,
        isAdmin: false,
        uid
      }
    }]);
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
