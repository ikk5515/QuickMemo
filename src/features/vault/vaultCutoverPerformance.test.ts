import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultNote } from "./vaultData";
import {
  PENDING_VAULT_CUTOVER_5000_CEILINGS,
  estimatePendingVaultCutoverCost
} from "./vaultCutoverPerformanceBudget";
import { migrateVaultNameReservations } from "./vaultNameMigration";

const mocks = vi.hoisted(() => ({
  claimMatches: vi.fn(),
  migrateEntry: vi.fn(),
  migrateFolder: vi.fn(),
  saveEntry: vi.fn(),
  updateFolder: vi.fn()
}));

vi.mock("../../services/notes", () => ({
  updateEncryptedNoteFolder: mocks.updateFolder,
  VaultNameConflictError: class VaultNameConflictError extends Error {},
  vaultNameClaimReservationMatches: mocks.claimMatches
}));
vi.mock("./vaultData", async (importOriginal) => ({
  ...await importOriginal<typeof import("./vaultData")>(),
  migrateLegacyVaultFolder: mocks.migrateFolder
}));
vi.mock("./vaultPersistence", () => ({
  backfillVaultEntryNameClaim: mocks.saveEntry,
  migrateLegacyVaultEntryIdentity: mocks.migrateEntry
}));

const NOTE_COUNT = 5_000;
const privateKey = { kind: "private" } as unknown as CryptoKey;
const encryptedPayload = {
  algorithm: "AES-GCM" as const,
  cipherText: "cipher",
  iv: "iv",
  version: 1 as const
};
const wrappedKey = {
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: "wrapped"
};
const profile = { publicKeyJwk: { kty: "RSA" }, uid: "benchmark-owner" };
const cutoverLease = {
  leaseGeneration: "g".repeat(43),
  leaseId: "l".repeat(43)
};
let vaultIntegrityKey: CryptoKey;

function benchmarkNote(index: number): DecryptedVaultNote {
  const suffix = String(index).padStart(4, "0");
  return {
    body: `# fixture ${suffix}`,
    contentFormat: "markdown-v1",
    encryptedBody: encryptedPayload,
    encryptedTitle: encryptedPayload,
    entryKind: "markdown",
    folderId: null,
    id: `note-${suffix}`,
    isDeleted: false,
    ownerUid: profile.uid,
    participantUids: [profile.uid],
    revision: 1,
    title: `Fixture ${suffix}`,
    type: "personal",
    updatedBy: profile.uid,
    wrappedKeys: { [profile.uid]: wrappedKey }
  };
}

function occurrences(source: string, token: string) {
  return source.split(token).length - 1;
}

describe("5k pending Vault cutover performance and cost contract", () => {
  beforeAll(async () => {
    vaultIntegrityKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    mocks.saveEntry.mockImplementation(async (note: DecryptedVaultNote) => ({
      noteId: note.id,
      revision: (note.revision ?? 0) + 1
    }));
  });

  it("keeps the server fast path aligned with four bounded collection sweeps", () => {
    const apiSource = readFileSync(join(process.cwd(), "api/vault-integrity.js"), "utf8");
    const pageSource = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
    const reconcileFlow = apiSource.slice(
      apiSource.indexOf("async function reconcileStaleClaims"),
      apiSource.indexOf("function readyResult")
    );
    const sealFlow = apiSource.slice(
      apiSource.indexOf("async function sealReady"),
      apiSource.indexOf("async function performAction")
    );

    expect(occurrences(reconcileFlow, "firestoreRunQuery(")).toBe(3);
    expect(reconcileFlow).toContain("observedClaimCount: claims.length");
    expect(reconcileFlow).toContain("if (claims.length > 0)");
    expect(occurrences(sealFlow, "firestoreRunQuery(")).toBe(3);
    expect(sealFlow).toContain("legacyNormalizationWrites.length");
    expect(sealFlow).toContain("return sealReady(");
    expect(pageSource).toContain("if (initialReconciliation.observedClaimCount > 0)");
    expect(pageSource).toContain("onLeaseCheckpoint: renewCutoverLeaseBetweenBatches");
    expect(pageSource).not.toContain("window.setInterval(renewCutoverLease");
  });

  it("plans 5,000 collision-free pending notes below the no-cost read ceiling", async () => {
    vi.clearAllMocks();
    mocks.saveEntry.mockImplementation(async (note: DecryptedVaultNote) => ({
      noteId: note.id,
      revision: (note.revision ?? 0) + 1
    }));
    const notes = Array.from({ length: NOTE_COUNT }, (_, index) => benchmarkNote(index));
    let leaseCheckpoints = 0;
    let progressEvents = 0;
    const startedAt = performance.now();
    const result = await migrateVaultNameReservations({
      cutoverLease,
      deletedNotes: [],
      expectedDeletedNoteCount: 0,
      expectedFolderCount: 0,
      expectedNoteCount: NOTE_COUNT,
      folders: [],
      legacyActiveNoteIds: new Set(),
      legacyDeletedNoteIds: new Set(),
      notes,
      onLeaseCheckpoint: async () => { leaseCheckpoints += 1; },
      onProgress: () => { progressEvents += 1; },
      privateKey,
      profile,
      vaultIntegrityKey
    });
    const wallTimeMilliseconds = Math.round((performance.now() - startedAt) * 100) / 100;
    const estimate = estimatePendingVaultCutoverCost({
      activeNoteCount: NOTE_COUNT,
      deletedNoteCount: 0,
      folderCount: 0,
      initialObservedClaimCount: 0,
      migrationMutationCount: result.migrated,
      postMigrationClaimCount: result.migrated
    });

    expect(result).toMatchObject({
      completed: NOTE_COUNT,
      deferredTargetIds: [],
      migrated: NOTE_COUNT,
      skipped: 0,
      total: NOTE_COUNT
    });
    expect(progressEvents).toBe(NOTE_COUNT);
    expect(leaseCheckpoints).toBe(314);
    expect(mocks.saveEntry).toHaveBeenCalledTimes(NOTE_COUNT);
    expect(mocks.claimMatches).not.toHaveBeenCalled();
    expect(estimate).toMatchObject({
      clientFullScanQueryCount: 1,
      clientInventoryDocumentReadUpperBound: NOTE_COUNT,
      clientMigrationMutationCount: NOTE_COUNT,
      estimatedDocumentReadUpperBound: 40_008,
      finalReconciliationRequired: false,
      integrityApiInvocationCount: 2,
      lease: {
        busyBeginInvocationCount: 0,
        documentReadUpperBound: 1,
        releaseInvocationCount: 0,
        renewInvocationCount: 0,
        serverInvocationCount: 0
      },
      migrationDocumentReadUpperBound: 25_000,
      serverApiInvocationCount: 5_002,
      serverDocumentReadUpperBound: 35_008,
      serverFullScanQueryCount: 4
    });
    expect(estimate.clientMigrationMutationCount)
      .toBeLessThanOrEqual(PENDING_VAULT_CUTOVER_5000_CEILINGS.clientMigrationMutationCount);
    expect(estimate.estimatedDocumentReadUpperBound)
      .toBeLessThanOrEqual(PENDING_VAULT_CUTOVER_5000_CEILINGS.estimatedDocumentReadUpperBound);
    expect(estimate.serverApiInvocationCount)
      .toBeLessThanOrEqual(PENDING_VAULT_CUTOVER_5000_CEILINGS.serverApiInvocationCount);
    expect(estimate.serverFullScanQueryCount)
      .toBeLessThanOrEqual(PENDING_VAULT_CUTOVER_5000_CEILINGS.serverFullScanQueryCount);
    expect(wallTimeMilliseconds)
      .toBeLessThanOrEqual(PENDING_VAULT_CUTOVER_5000_CEILINGS.wallTimeMilliseconds);
    expect(
      PENDING_VAULT_CUTOVER_5000_CEILINGS.firestoreNoCostDailyDocumentReadLimit
      - estimate.estimatedDocumentReadUpperBound
    ).toBeGreaterThanOrEqual(PENDING_VAULT_CUTOVER_5000_CEILINGS.minimumReadHeadroom);

    process.stdout.write(
      `vault-cutover-5k ${JSON.stringify({ ...estimate, wallTimeMilliseconds })}\n`
    );
  }, 30_000);

  it("links long-running and multi-tab lease calls to the same free-quota budget", () => {
    const estimate = estimatePendingVaultCutoverCost({
      activeNoteCount: NOTE_COUNT,
      deletedNoteCount: 0,
      folderCount: 0,
      initialObservedClaimCount: 0,
      lease: {
        busyBeginInvocationCount: 1,
        releaseInvocationCount: 1,
        renewInvocationCount: 64
      },
      migrationMutationCount: NOTE_COUNT,
      postMigrationClaimCount: NOTE_COUNT
    });
    expect(estimate.lease).toEqual({
      busyBeginInvocationCount: 1,
      documentReadUpperBound: 133,
      releaseInvocationCount: 1,
      renewInvocationCount: 64,
      serverInvocationCount: 66
    });
    expect(estimate.estimatedDocumentReadUpperBound).toBe(40_140);
    expect(estimate.serverApiInvocationCount).toBe(5_068);
    expect(estimate.estimatedDocumentReadUpperBound)
      .toBeLessThan(PENDING_VAULT_CUTOVER_5000_CEILINGS.firestoreNoCostDailyDocumentReadLimit);
  });

  it("retains the conservative rescans for pre-existing claims or real normalization writes", () => {
    const withExistingClaims = estimatePendingVaultCutoverCost({
      activeNoteCount: NOTE_COUNT,
      deletedNoteCount: 0,
      folderCount: 0,
      initialObservedClaimCount: 100,
      migrationMutationCount: 4_900,
      postMigrationClaimCount: NOTE_COUNT
    });
    expect(withExistingClaims.finalReconciliationRequired).toBe(true);
    expect(withExistingClaims.serverFullScanQueryCount).toBe(9);

    const withNormalization = estimatePendingVaultCutoverCost({
      activeNoteCount: NOTE_COUNT,
      deletedNoteCount: 0,
      folderCount: 0,
      initialObservedClaimCount: 0,
      legacyNormalizationMutationCount: 1,
      migrationMutationCount: NOTE_COUNT,
      postMigrationClaimCount: NOTE_COUNT
    });
    expect(withNormalization.serverFullScanQueryCount).toBe(7);
    expect(withNormalization.estimatedDocumentReadUpperBound).toBeGreaterThan(40_008);
  });
});
