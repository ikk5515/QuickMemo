import { createServer } from "node:http";
import { createHash } from "node:crypto";
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

const leaseId = "l".repeat(43);
const leaseGeneration = "g".repeat(43);

function leaseHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function pendingMarkerFields(uid: string, options: {
  acquiredAt?: Date;
  expiresAt?: Date;
  generation?: string;
  leased?: boolean;
  token?: string;
  updatedAt?: Date;
} = {}) {
  const now = new Date();
  const updatedAt = options.updatedAt ?? now;
  const acquiredAt = options.acquiredAt ?? updatedAt;
  const expiresAt = options.expiresAt ?? new Date(updatedAt.getTime() + 90_000);
  return {
    createdAt: now,
    cutoverState: "pending",
    cutoverVersion: 1,
    indexVersion: 1,
    ownerUid: uid,
    updatedAt,
    ...(options.leased === false ? {} : {
      cutoverLeaseAcquiredAt: acquiredAt,
      cutoverLeaseExpiresAt: expiresAt,
      cutoverLeaseGeneration: options.generation ?? leaseGeneration,
      cutoverLeaseHash: leaseHash(options.token ?? leaseId),
      cutoverLeaseVersion: 1
    }),
    wrappedKey
  };
}

function readyMarkerFields(uid: string) {
  const now = new Date();
  return {
    ...pendingMarkerFields(uid, { leased: false }),
    cutoverState: "ready",
    updatedAt: now,
    verifiedAt: now
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

function folderClaimFields(uid: string, folderId: string) {
  return {
    indexVersion: 1,
    ownerUid: uid,
    parentId: null,
    targetId: folderId,
    targetType: "folder"
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

  async function requestPreferences(body: Record<string, unknown>, options: { token?: string; resource?: string; marker?: string } = {}) {
    const response = await fetch(`${harness.origin}/api/vault-integrity${options.resource ?? "?resource=workspace-preferences"}`, {
      method: "POST", headers: { ...apiHeaders(harness.origin, { authorization: options.token ?? idToken }), [options.marker ?? "x-quickmemo-workspace-preferences"]: "1" }, body: JSON.stringify(body)
    });
    return { response, body: await response.json() as Record<string, unknown> };
  }

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
      body: JSON.stringify({
        action: "seal-ready",
        leaseGeneration,
        leaseId,
        ...expected
      })
    });
    return {
      body: await response.json() as Record<string, unknown>,
      response
    };
  }

  async function requestReconciliation(extra: Record<string, unknown> = {}) {
    const response = await fetch(`${harness.origin}/api/vault-integrity`, {
      method: "POST",
      headers: {
        ...apiHeaders(harness.origin, { authorization: idToken }),
        "x-quickmemo-vault-integrity": "1"
      },
      body: JSON.stringify({ action: "reconcile-stale-claims", leaseId, ...extra })
    });
    return {
      body: await response.json() as Record<string, unknown>,
      response
    };
  }

  async function requestLeaseAction(
    action: "release-cutover-lease" | "renew-cutover-lease",
    credential = { leaseGeneration, leaseId }
  ) {
    const response = await fetch(`${harness.origin}/api/vault-integrity`, {
      method: "POST",
      headers: {
        ...apiHeaders(harness.origin, { authorization: idToken }),
        "x-quickmemo-vault-integrity": "1"
      },
      body: JSON.stringify({ action, ...credential })
    });
    return {
      body: await response.json() as Record<string, unknown>,
      response
    };
  }

  async function seedPendingVault(
    documents: Array<{ fields: Record<string, unknown>; path: string }> = [],
    marker: Record<string, unknown> = pendingMarkerFields(uid)
  ) {
    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: marker
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

  it("serves isolated UI preferences through the existing endpoint without touching Vault integrity", async () => {
    const preferencesPath = `workspaceUiPreferences/${leaseHash(uid)}`;
    expect((await requestPreferences({ action: "get" })).body).toEqual({ memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } });
    const updates = await Promise.all([
      requestPreferences({ action: "set", kind: "memo", value: { width: 220, collapsed: true } }),
      requestPreferences({ action: "set", kind: "wiki", value: { width: 360, collapsed: false } })
    ]);
    expect(updates.map(({ response }) => response.status)).toEqual([200, 200]);
    const saved = await requestPreferences({ action: "get" });
    expect(saved.body).toEqual({ memo: { width: 220, collapsed: true }, wiki: { width: 360, collapsed: false } });
    expect(saved.response.headers.get("cache-control")).toContain("no-store");
    expect(await readEmulatorDocument(preferencesPath)).toMatchObject({ ownerUid: uid, memo: { width: 220 }, wiki: { width: 360 } });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).toBeNull();
    const other = await createEmulatorOwner(`preference-other-${Date.now()}@example.test`, "emulator-owner-password");
    await writeEmulatorDocuments([{ path: `users/${other.localId}`, fields: { uid: other.localId, isActive: true, isAdmin: false, featureAccess: { notes: true } } }]);
    expect((await requestPreferences({ action: "get" }, { token: other.idToken })).body).toEqual({ memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } });
    expect((await requestPreferences({ action: "get", uid }, { token: other.idToken })).response.status).toBe(400);
    // These collections remain unavailable through the client Firestore API,
    // even to the owner authenticated with a real emulator ID token.
    const direct = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${secureShareApiEmulatorProjectId}/databases/(default)/documents/${preferencesPath}`, { headers: { authorization: `Bearer ${idToken}` } });
    expect(direct.status).toBe(403);
  });

  it("does not mix preference and integrity request contracts or permit inactive callers", async () => {
    const get = { action: "get" };
    expect((await requestPreferences(get, { token: "" })).response.status).toBe(401);
    expect((await requestPreferences(get, { resource: "" })).response.status).toBe(403);
    expect((await requestPreferences(get, { marker: "x-quickmemo-vault-integrity" })).response.status).toBe(403);
    expect((await requestPreferences(get, { resource: "?resource=other" })).response.status).toBe(400);
    expect((await requestPreferences(get, { resource: "?resource=workspace-preferences&resource=workspace-preferences" })).response.status).toBe(400);
    expect((await requestPreferences({ action: "seal-ready" })).response.status).toBe(400);
    await writeEmulatorDocuments([{ path: `users/${uid}`, fields: { uid, isActive: false, isAdmin: false, featureAccess: { notes: true } } }]);
    expect((await requestPreferences(get)).response.status).toBe(403);
    expect(await readEmulatorDocument(`workspaceUiPreferences/${leaseHash(uid)}`)).toBeNull();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).toBeNull();
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

  it("acquires a hashed marker lease without persisting the raw token", async () => {
    await seedPendingVault([], pendingMarkerFields(uid, { leased: false }));

    const result = await requestReconciliation();
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      hasMore: false,
      observedClaimCount: 0,
      ok: true,
      removedClaimCount: 0,
      state: "pending"
    });
    expect(result.body.leaseGeneration).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const marker = await readEmulatorDocument(`vaultIntegrity/${uid}`);
    expect(marker).toMatchObject({
      cutoverLeaseGeneration: result.body.leaseGeneration,
      cutoverLeaseHash: leaseHash(leaseId),
      cutoverLeaseVersion: 1
    });
    expect(JSON.stringify(marker)).not.toContain(leaseId);
  });

  it("allows only one of two competing tabs to acquire the pending marker lease", async () => {
    await seedPendingVault([], pendingMarkerFields(uid, { leased: false }));
    const competingLeaseId = "x".repeat(43);

    const results = await Promise.all([
      requestReconciliation(),
      requestReconciliation({ leaseId: competingLeaseId })
    ]);
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
    const busy = results.find((result) => result.response.status === 409);
    expect(busy?.body).toMatchObject({ error: "vault_cutover_busy", ok: false });
    expect(Number(busy?.response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(busy?.response.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(JSON.stringify(busy?.body)).not.toContain(uid);
    expect(JSON.stringify(busy?.body)).not.toContain(leaseId);
    expect(JSON.stringify(busy?.body)).not.toContain(competingLeaseId);
  });

  it("recovers an expired lease with a new generation fence", async () => {
    const now = Date.now();
    await seedPendingVault([], pendingMarkerFields(uid, {
      acquiredAt: new Date(now - 80_000),
      expiresAt: new Date(now - 1_000),
      updatedAt: new Date(now - 70_000)
    }));
    const replacementLeaseId = "r".repeat(43);

    const result = await requestReconciliation({ leaseId: replacementLeaseId });
    expect(result.response.status).toBe(200);
    expect(result.body.leaseGeneration).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.body.leaseGeneration).not.toBe(leaseGeneration);
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).toMatchObject({
      cutoverLeaseGeneration: result.body.leaseGeneration,
      cutoverLeaseHash: leaseHash(replacementLeaseId)
    });
  });

  it("does not misreport an invalid stored marker as a transient competing lease", async () => {
    await seedPendingVault([], {
      ...pendingMarkerFields(uid, { leased: false }),
      unexpectedServerField: "invalid"
    });

    const result = await requestReconciliation();
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: "request_failed", ok: false });
    expect(result.body.error).not.toBe("vault_cutover_busy");
    expect(result.response.headers.get("retry-after")).toBeNull();
  });

  it("releases only the matching generation and keeps release idempotent", async () => {
    await seedPendingVault();

    const first = await requestLeaseAction("release-cutover-lease");
    expect(first.response.status).toBe(200);
    expect(first.body).toEqual({ ok: true, released: true, state: "released" });
    const marker = await readEmulatorDocument(`vaultIntegrity/${uid}`);
    expect(marker).not.toHaveProperty("cutoverLeaseHash");
    expect(marker).not.toHaveProperty("cutoverLeaseGeneration");

    const second = await requestLeaseAction("release-cutover-lease");
    expect(second.response.status).toBe(200);
    expect(second.body).toEqual({ ok: true, released: false, state: "released" });
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
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).not.toHaveProperty("cutoverLeaseHash");
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
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).not.toHaveProperty("cutoverLeaseHash");
  });

  it("reconciles only deleted-target and unreferenced orphan claims, idempotently", async () => {
    const activeClaimId = "E".repeat(43);
    const deletedClaimId = "F".repeat(43);
    const orphanClaimId = "G".repeat(43);
    const deletedFolderClaimId = "O".repeat(43);
    const deletedAt = new Date();
    await seedPendingVault([
      {
        path: "notes/active-claim-owner",
        fields: activeNoteFields(uid, activeClaimId)
      },
      {
        path: "notes/deleted-claim-owner",
        fields: {
          ...activeNoteFields(uid, deletedClaimId),
          deletedAt,
          deletedBy: uid,
          isDeleted: true
        }
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${activeClaimId}`,
        fields: entryClaimFields(uid, "active-claim-owner")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${deletedClaimId}`,
        fields: entryClaimFields(uid, "deleted-claim-owner")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${orphanClaimId}`,
        fields: entryClaimFields(uid, "missing-orphan-target")
      },
      {
        path: "noteFolders/deleted-claim-folder",
        fields: {
          isDeleted: true,
          ownerUid: uid,
          parentId: null,
          vaultNameClaimId: deletedFolderClaimId,
          vaultNameIndexVersion: 1
        }
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${deletedFolderClaimId}`,
        fields: folderClaimFields(uid, "deleted-claim-folder")
      }
    ]);

    const first = await requestReconciliation();
    expect(first.response.status).toBe(200);
    expect(first.body).toEqual({
      hasMore: false,
      leaseGeneration,
      observedClaimCount: 4,
      ok: true,
      removedClaimCount: 3,
      state: "pending"
    });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${activeClaimId}`))
      .toMatchObject({ targetId: "active-claim-owner" });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${deletedClaimId}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${orphanClaimId}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${deletedFolderClaimId}`))
      .toBeNull();
    await expectMarkerPending();

    const second = await requestReconciliation();
    expect(second.response.status).toBe(200);
    expect(second.body).toEqual({
      hasMore: false,
      leaseGeneration,
      observedClaimCount: 1,
      ok: true,
      removedClaimCount: 0,
      state: "pending"
    });
  });

  it("preserves active and ambiguous claims while removing only a superseded active-target claim", async () => {
    const activeClaimId = "H".repeat(43);
    const ambiguousClaimId = "I".repeat(43);
    const copyingClaimId = "J".repeat(43);
    const supersededClaimId = "K".repeat(43);
    const legacyActiveClaimId = "Q".repeat(43);
    const legacySupersededClaimId = "S".repeat(43);
    const activeFolderClaimId = "P".repeat(43);
    const ambiguousFields = activeNoteFields(uid, ambiguousClaimId, {
      deletedAt: new Date(),
      includeDeletionFlag: false
    });
    await seedPendingVault([
      {
        path: "notes/active-reconciled-target",
        fields: activeNoteFields(uid, activeClaimId)
      },
      {
        path: "notes/ambiguous-reconciled-target",
        fields: ambiguousFields
      },
      {
        path: "notes/copying-reconciled-target",
        fields: {
          ...activeNoteFields(uid, copyingClaimId),
          secureShareCopyState: "copying"
        }
      },
      {
        path: "notes/legacy-active-reconciled-target",
        fields: activeNoteFields(uid, legacyActiveClaimId, { includeDeletionFlag: false })
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${activeClaimId}`,
        fields: entryClaimFields(uid, "active-reconciled-target")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${ambiguousClaimId}`,
        fields: entryClaimFields(uid, "ambiguous-reconciled-target")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${copyingClaimId}`,
        fields: entryClaimFields(uid, "copying-reconciled-target")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${supersededClaimId}`,
        fields: entryClaimFields(uid, "active-reconciled-target")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${legacyActiveClaimId}`,
        fields: entryClaimFields(uid, "legacy-active-reconciled-target")
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${legacySupersededClaimId}`,
        fields: entryClaimFields(uid, "legacy-active-reconciled-target")
      },
      {
        path: "noteFolders/active-reconciled-folder",
        fields: {
          isDeleted: false,
          ownerUid: uid,
          parentId: null,
          vaultNameClaimId: activeFolderClaimId,
          vaultNameIndexVersion: 1
        }
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${activeFolderClaimId}`,
        fields: folderClaimFields(uid, "active-reconciled-folder")
      }
    ]);

    const result = await requestReconciliation();
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      hasMore: false,
      leaseGeneration,
      observedClaimCount: 7,
      ok: true,
      removedClaimCount: 2,
      state: "pending"
    });
    for (const claimId of [
      activeClaimId,
      ambiguousClaimId,
      copyingClaimId,
      legacyActiveClaimId,
      activeFolderClaimId
    ]) {
      expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${claimId}`)).not.toBeNull();
    }
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${supersededClaimId}`))
      .toBeNull();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${legacySupersededClaimId}`))
      .toBeNull();
  });

  it("fails closed on malformed claims without deleting an otherwise removable orphan", async () => {
    const malformedClaimId = "L".repeat(43);
    const orphanClaimId = "M".repeat(43);
    await seedPendingVault([
      {
        path: `vaultIntegrity/${uid}/nameClaims/${malformedClaimId}`,
        fields: {
          ...entryClaimFields(uid, "malformed-target"),
          indexVersion: 2
        }
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${orphanClaimId}`,
        fields: entryClaimFields(uid, "other-missing-target")
      }
    ]);

    const result = await requestReconciliation();
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: "vault_claim_invalid", ok: false });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${malformedClaimId}`))
      .not.toBeNull();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${orphanClaimId}`))
      .not.toBeNull();
    await expectMarkerPending();
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}`)).not.toHaveProperty("cutoverLeaseHash");
  });

  it("never reconciles a ready marker", async () => {
    const orphanClaimId = "N".repeat(43);
    await writeEmulatorDocuments([
      {
        path: `vaultIntegrity/${uid}`,
        fields: readyMarkerFields(uid)
      },
      {
        path: `vaultIntegrity/${uid}/nameClaims/${orphanClaimId}`,
        fields: entryClaimFields(uid, "ready-orphan-target")
      }
    ]);

    const result = await requestReconciliation();
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: "vault_cutover_complete", ok: false });
    expect(await readEmulatorDocument(`vaultIntegrity/${uid}/nameClaims/${orphanClaimId}`))
      .not.toBeNull();
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
