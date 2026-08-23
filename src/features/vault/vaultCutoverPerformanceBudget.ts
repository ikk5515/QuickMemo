export interface PendingVaultCutoverLeaseCostInput {
  /** Contending tabs fail at the profile + integrity-marker boundary. */
  busyBeginInvocationCount: number;
  releaseInvocationCount: number;
  renewInvocationCount: number;
}

export interface PendingVaultCutoverCostInput {
  activeNoteCount: number;
  deletedNoteCount: number;
  folderCount: number;
  /** Exact count returned by the first server reconciliation. */
  initialObservedClaimCount: number;
  /** One entry/folder mutation API request for each target missing its claim. */
  migrationMutationCount: number;
  /** Exact claim count expected when the final seal runs. */
  postMigrationClaimCount: number;
  /** Non-zero forces the seal's bounded normalize-then-rescan path. */
  legacyNormalizationMutationCount?: number;
  lease?: Partial<PendingVaultCutoverLeaseCostInput>;
}

export interface PendingVaultCutoverCostEstimate {
  clientFullScanQueryCount: number;
  clientMigrationMutationCount: number;
  clientInventoryDocumentReadUpperBound: number;
  estimatedDocumentReadUpperBound: number;
  finalReconciliationRequired: boolean;
  integrityApiInvocationCount: number;
  lease: PendingVaultCutoverLeaseCostInput & {
    documentReadUpperBound: number;
    serverInvocationCount: number;
  };
  migrationDocumentReadUpperBound: number;
  serverApiInvocationCount: number;
  serverDocumentReadUpperBound: number;
  serverFullScanQueryCount: number;
}

/**
 * Firebase's no-cost daily Firestore allowance is 50,000 document reads. The
 * cutover is allowed at most 41,000 so normal post-login work keeps at least
 * 9,000 reads of deterministic headroom. Spark rejects excess traffic rather
 * than silently turning this application into a metered migration.
 */
export const PENDING_VAULT_CUTOVER_5000_CEILINGS = Object.freeze({
  clientMigrationMutationCount: 5_000,
  estimatedDocumentReadUpperBound: 41_000,
  firestoreNoCostDailyDocumentReadLimit: 50_000,
  minimumReadHeadroom: 9_000,
  serverApiInvocationCount: 5_130,
  serverFullScanQueryCount: 4,
  wallTimeMilliseconds: 15_000
});

function safeCount(value: number, label: string, maximum = 25_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function queryReadCount(documentCount: number) {
  // Firestore charges at least one document read for an empty query.
  return Math.max(1, documentCount);
}

function leaseCost(input: PendingVaultCutoverCostInput["lease"]) {
  const lease: PendingVaultCutoverLeaseCostInput = {
    busyBeginInvocationCount: safeCount(input?.busyBeginInvocationCount ?? 0, "lease.busyBeginInvocationCount"),
    releaseInvocationCount: safeCount(input?.releaseInvocationCount ?? 0, "lease.releaseInvocationCount"),
    renewInvocationCount: safeCount(input?.renewInvocationCount ?? 0, "lease.renewInvocationCount")
  };
  const serverInvocationCount = lease.busyBeginInvocationCount
    + lease.releaseInvocationCount
    + lease.renewInvocationCount;
  return {
    ...lease,
    // Successful acquisition is folded into the initial reconciliation: it
    // adds one marker transaction read, but no extra HTTP/API invocation or
    // profile read. Busy/renew/release requests each add profile + marker.
    documentReadUpperBound: 1 + serverInvocationCount * 2,
    serverInvocationCount
  };
}

/**
 * Deterministic Firestore cost proxy for one pending-Vault cutover tab.
 *
 * Common collision-free flow:
 *
 * 1. one owner-only client inventory query;
 * 2. acquire the hashed marker lease inside the initial reconciliation;
 * 3. query claims first and skip note/folder reconciliation scans when the
 *    exact observed claim count is zero;
 * 4. one revision-aware mutation request per missing target claim;
 * 5. skip the final reconciliation only when the initial observed claim count
 *    was exactly zero;
 * 6. seal notes, folders and claims in one transaction inventory pass when no
 *    legacy deletion metadata needs a write.
 *
 * The model deliberately counts browser and server reads together because
 * both consume the same Firebase project quota. It does not claim to measure
 * network latency or production billing exports.
 */
export function estimatePendingVaultCutoverCost(
  input: PendingVaultCutoverCostInput
): PendingVaultCutoverCostEstimate {
  const activeNoteCount = safeCount(input.activeNoteCount, "activeNoteCount", 20_000);
  const deletedNoteCount = safeCount(input.deletedNoteCount, "deletedNoteCount", 20_000);
  const folderCount = safeCount(input.folderCount, "folderCount", 2_000);
  const initialObservedClaimCount = safeCount(
    input.initialObservedClaimCount,
    "initialObservedClaimCount"
  );
  const migrationMutationCount = safeCount(
    input.migrationMutationCount,
    "migrationMutationCount"
  );
  const postMigrationClaimCount = safeCount(
    input.postMigrationClaimCount,
    "postMigrationClaimCount"
  );
  const legacyNormalizationMutationCount = safeCount(
    input.legacyNormalizationMutationCount ?? 0,
    "legacyNormalizationMutationCount"
  );
  const noteCount = activeNoteCount + deletedNoteCount;
  if (noteCount > 20_000) {
    throw new RangeError("total note count exceeds the cutover inventory limit");
  }
  if (migrationMutationCount > noteCount + folderCount) {
    throw new RangeError("migrationMutationCount exceeds the Vault target count");
  }
  if (legacyNormalizationMutationCount > noteCount + folderCount) {
    throw new RangeError("legacyNormalizationMutationCount exceeds the Vault target count");
  }

  const lease = leaseCost(input.lease);
  const clientInventoryDocumentReadUpperBound = queryReadCount(noteCount);
  // The initial reconciliation rechecks the profile and opens one fenced
  // marker transaction; lease.documentReadUpperBound separately accounts for
  // the successful one-marker acquisition folded into this same API request.
  // Claims are queried first, so an empty claim inventory proves notes/folders
  // cannot contribute a stale claim and avoids both large scans.
  const initialReconciliationReads = 2
    + queryReadCount(initialObservedClaimCount)
    + (initialObservedClaimCount > 0
      ? queryReadCount(noteCount) + queryReadCount(folderCount)
      : 0);
  const finalReconciliationRequired = initialObservedClaimCount > 0;
  const finalReconciliationReads = finalReconciliationRequired
    ? 3
      + queryReadCount(postMigrationClaimCount)
      + queryReadCount(noteCount)
      + queryReadCount(folderCount)
    : 0;
  // Root-level note backfill currently performs one handler profile read and a
  // transaction read of note + user + marker + the missing claim.
  const migrationDocumentReadUpperBound = migrationMutationCount * 5;
  // Fast seal: profile + marker/tree transaction docs + 3 inventory queries.
  // A real normalization write rolls back that transaction and repeats the
  // marker/tree + notes/folders inventory before reading claims and sealing.
  const sealReads = 3
    + queryReadCount(noteCount)
    + queryReadCount(folderCount)
    + queryReadCount(postMigrationClaimCount)
    + (legacyNormalizationMutationCount > 0
      ? 2
        + queryReadCount(noteCount)
        + queryReadCount(folderCount)
        + queryReadCount(postMigrationClaimCount)
      : 0);
  const serverDocumentReadUpperBound = lease.documentReadUpperBound
    + initialReconciliationReads
    + finalReconciliationReads
    + migrationDocumentReadUpperBound
    + sealReads;
  const integrityApiInvocationCount = 2 + (finalReconciliationRequired ? 1 : 0);

  return {
    clientFullScanQueryCount: 1,
    clientMigrationMutationCount: migrationMutationCount,
    clientInventoryDocumentReadUpperBound,
    estimatedDocumentReadUpperBound:
      clientInventoryDocumentReadUpperBound + serverDocumentReadUpperBound,
    finalReconciliationRequired,
    integrityApiInvocationCount,
    lease,
    migrationDocumentReadUpperBound,
    serverApiInvocationCount:
      migrationMutationCount + integrityApiInvocationCount + lease.serverInvocationCount,
    serverDocumentReadUpperBound,
    serverFullScanQueryCount:
      (initialObservedClaimCount > 0 ? 3 : 1)
      + (finalReconciliationRequired ? 3 : 0)
      + 3
      + (legacyNormalizationMutationCount > 0 ? 3 : 0)
  };
}
