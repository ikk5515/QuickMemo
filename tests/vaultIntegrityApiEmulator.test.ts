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

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const encryptedTitle = {
  algorithm: "AES-GCM",
  cipherText: "encrypted-title",
  iv: "title-iv",
  version: 1
} as const;

const encryptedBody = {
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

function pendingMarkerFields(uid: string) {
  const now = new Date();
  return {
    createdAt: now,
    cutoverState: "pending",
    cutoverVersion: 1,
    indexVersion: 1,
    ownerUid: uid,
    updatedAt: now,
    wrappedKey
  };
}

function emptyFolderTreeFields(uid: string) {
  return {
    folderCount: 0,
    nodes: {},
    ownerUid: uid,
    revision: 1,
    schemaVersion: 1
  };
}

function activeNoteFields(
  uid: string,
  claimId: string,
  options: { deletedAt?: Date; includeDeletionFlag?: boolean } = {}
) {
  return {
    contentFormat: "markdown-v1",
    ...(options.deletedAt
      ? { deletedAt: options.deletedAt, deletedBy: uid }
      : {}),
    encryptedBody,
    encryptedTitle,
    entryKind: "markdown",
    folderId: null,
    ...(options.includeDeletionFlag === false ? {} : { isDeleted: false }),
    ownerUid: uid,
    type: "personal",
    vaultNameClaimId: claimId,
    vaultNameIndexVersion: 1
  };
}

function entryClaimFields(uid: string, noteId: string) {
  return {
    indexVersion: 1,
    ownerUid: uid,
    parentId: null,
    targetId: noteId,
    targetType: "entry"
  };
}

async function startVaultIntegrityHarness(): Promise<SecureShareApiHarness> {
  const moduleUrl = new URL("../api/vault-integrity.js", import.meta.url);
  moduleUrl.searchParams.set("integration-instance", String(Date.now()));
  const module = await import(/* @vite-ignore */ moduleUrl.href) as typeof import("../api/vault-integrity.js");
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

describeEmulator("Vault integrity API emulator attestation", () => {
  let harness: SecureShareApiHarness;
  let idToken = "";
  let uid = "";

  async function requestSeal(
    expected: {
      expectedActiveNoteCount: number;
      expectedDeletedNoteCount: number;
      expectedFolderCount: number;
    }
  ) {
    const response = await fetch(`${harness.origin}/api/vault-integrity`, {
      method: "POST",
      headers: {
        ...apiHeaders(harness.origin, { authorization: idToken }),
        "x-quickmemo-vault-integrity": "1"
      },
      body: JSON.stringify({ action: "seal-ready", ...expected })
    });
    return {
      body: await response.json() as Record<string, unknown>,
      response
    };
  }

  async function seedPendingVault(
    documents: Array<{ fields: Record<string, unknown>; path: string }> = []
  ) {
    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: pendingMarkerFields(uid)
      },
      {
        path: `vaultFolderTrees/${uid}`,
        fields: emptyFolderTreeFields(uid)
      },
      ...documents
    ]);
  }

  async function expectMarkerPending() {
    const marker = await readEmulatorDocument(`vaultIntegrity/${uid}`);
    expect(marker).toMatchObject({
      cutoverState: "pending",
      cutoverVersion: 1,
      ownerUid: uid
    });
    expect(marker).not.toHaveProperty("verifiedAt");
  }

  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    harness = await startVaultIntegrityHarness();
  });

  beforeEach(async () => {
    await clearSecureShareEmulators();
    const owner = await createEmulatorOwner(
      `vault-integrity-${Date.now()}@example.test`,
      "emulator-owner-password"
    );
    idToken = owner.idToken;
    uid = owner.localId;
    await writeEmulatorDocuments([{
      path: `users/${uid}`,
      fields: {
        displayName: "Vault integrity owner",
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

  it("seals an empty pending Vault and keeps the ready attestation idempotent", async () => {
    await seedPendingVault();

    const first = await requestSeal({
      expectedActiveNoteCount: 0,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0
    });
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      activeNoteCount: 0,
      cutoverVersion: 1,
      deletedNoteCount: 0,
      folderCount: 0,
      ok: true,
      state: "ready"
    });
    expect(typeof first.body.verifiedAt).toBe("string");
    expect(Number.isFinite(Date.parse(String(first.body.verifiedAt)))).toBe(true);

    const firstMarker = await readEmulatorDocument(`vaultIntegrity/${uid}`);
    expect(firstMarker).toMatchObject({
      cutoverState: "ready",
      cutoverVersion: 1,
      ownerUid: uid,
      verifiedAt: first.body.verifiedAt
    });
    const firstUpdatedAt = firstMarker?.updatedAt;

    const second = await requestSeal({
      expectedActiveNoteCount: 0,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0
    });
    expect(second.response.status).toBe(200);
    expect(second.body).toMatchObject({
      activeNoteCount: 0,
      cutoverVersion: 1,
      deletedNoteCount: 0,
      folderCount: 0,
      ok: true,
      state: "ready",
      verifiedAt: first.body.verifiedAt
    });
    const secondMarker = await readEmulatorDocument(`vaultIntegrity/${uid}`);
    expect(secondMarker?.updatedAt).toBe(firstUpdatedAt);
    expect(secondMarker?.verifiedAt).toBe(first.body.verifiedAt);
  });

  it("rejects an active note whose referenced claim is missing without sealing", async () => {
    const noteId = "missing-claim-note";
    const claimId = "A".repeat(43);
    await seedPendingVault([{
      path: `notes/${noteId}`,
      fields: activeNoteFields(uid, claimId)
    }]);

    const result = await requestSeal({
      expectedActiveNoteCount: 1,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0
    });
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: "vault_claim_invalid", ok: false });
    await expectMarkerPending();
  });

  it("rejects an orphan claim without sealing", async () => {
    const claimId = "B".repeat(43);
    await seedPendingVault([{
      path: `vaultIntegrity/${uid}/nameClaims/${claimId}`,
      fields: entryClaimFields(uid, "missing-target-note")
    }]);

    const result = await requestSeal({
      expectedActiveNoteCount: 0,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0
    });
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: "vault_claim_invalid", ok: false });
    await expectMarkerPending();
  });

  it("normalizes an unambiguous legacy isDeleted omission before sealing", async () => {
    const noteId = "legacy-active-note";
    const claimId = "C".repeat(43);
    await seedPendingVault([
      {
        path: `notes/${noteId}`,
        fields: activeNoteFields(uid, claimId, { includeDeletionFlag: false })
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${claimId}`,
        fields: entryClaimFields(uid, noteId)
      }
    ]);

    const result = await requestSeal({
      expectedActiveNoteCount: 1,
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0
    });
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      activeNoteCount: 1,
      deletedNoteCount: 0,
      ok: true,
      state: "ready"
    });
    expect(await readEmulatorDocument(`notes/${noteId}`)).toMatchObject({ isDeleted: false });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).toMatchObject({
      cutoverState: "ready",
      cutoverVersion: 1,
      ownerUid: uid
    });
  });

  it("keeps ambiguous legacy deletion metadata pending and unchanged", async () => {
    const noteId = "ambiguous-deleted-note";
    const claimId = "D".repeat(43);
    const deletedAt = new Date();
    await seedPendingVault([
      {
        path: `notes/${noteId}`,
        fields: activeNoteFields(uid, claimId, {
          deletedAt,
          includeDeletionFlag: false
        })
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${claimId}`,
        fields: entryClaimFields(uid, noteId)
      }
    ]);

    const result = await requestSeal({
      expectedActiveNoteCount: 0,
      expectedDeletedNoteCount: 1,
      expectedFolderCount: 0
    });
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: "vault_cutover_incomplete", ok: false });
    const note = await readEmulatorDocument(`notes/${noteId}`);
    expect(note).not.toHaveProperty("isDeleted");
    expect(note).toMatchObject({
      deletedAt: deletedAt.toISOString(),
      deletedBy: uid
    });
    await expectMarkerPending();
  });
});
