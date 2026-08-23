import {
  HttpError,
  activeUserFromRequest,
  applySecureResponseHeaders,
  assertOnlyKeys,
  constantTimeStringEqual,
  createFirestoreContext,
  deleteDocumentWrite,
  ensureSameOrigin,
  firestoreBatchGetNewTransaction,
  firestoreCommit,
  firestoreRollback,
  firestoreRunQuery,
  handleApiError,
  headerValue,
  jsonResponse,
  randomToken,
  readJsonBody,
  requestId,
  sha256Digest,
  updateDocumentWrite,
  verifySecureShareAppCheck
} from "./_secure-share-common.js";
import { logVaultApiRejection } from "./_vault-api-observability.js";
import {
  VAULT_FOLDER_TREE_MAX_FOLDERS,
  validateVaultFolderTree,
  vaultFolderTreeMatchesFolders
} from "./_vault-folder-tree.js";
import {
  VAULT_CUTOVER_VERSION,
  VAULT_CUTOVER_LEASE_FIELD_PATHS,
  claimPath,
  integrityPath,
  requireVaultCutoverLease,
  requireVaultIntegrityMarker,
  vaultIntegrityReadyFields
} from "./_vault-integrity-marker.js";

const maximumOwnedNotes = 20_000;
const maximumOwnedFolders = VAULT_FOLDER_TREE_MAX_FOLDERS;
const maximumNameClaims = 25_000;
const maximumNormalizationWrites = 400;
const maximumReconciliationWrites = 400;
const maximumRequestBytes = 32 * 1024;
const maximumRevision = 999_999_999_999;
const cutoverLeaseTtlSeconds = 90;
const cutoverLeaseVersion = 1;
const maximumLeaseAcquireAttempts = 3;
const claimPattern = /^[A-Za-z0-9_-]{43}$/u;
const ownerPattern = /^[A-Za-z0-9_-]{1,160}$/u;
const leaseTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const targetPattern = /^[A-Za-z0-9_-]{1,120}$/u;
const supportedActions = new Set([
  "reconcile-stale-claims",
  "release-cutover-lease",
  "renew-cutover-lease",
  "seal-ready"
]);
const storageIdentities = new Map([
  ["legacy-html-v1", "legacy-html"],
  ["markdown-v1", "markdown"],
  ["json-canvas-v1", "canvas"],
  ["base-v1", "base"],
  ["asset-v1", "asset"]
]);
const secureCopyStates = new Set(["active", "aborted", "copying"]);

/**
 * Explicit read/write ceilings make the one-time cutover auditable without
 * logging owner ids, document ids, titles, paths, or blinded claim ids. Query
 * limits include the single overflow row used to fail closed.
 */
export const VAULT_INTEGRITY_OPERATION_BOUNDS = Object.freeze({
  lease: Object.freeze({
    maximumDocumentReads: 1,
    maximumDocumentWrites: 1,
    retryAfterSeconds: 30,
    ttlSeconds: cutoverLeaseTtlSeconds
  }),
  reconcile: Object.freeze({
    maximumClaimlessDocumentReads: 4,
    maximumDocumentReads: 47_006,
    maximumDocumentWrites: maximumReconciliationWrites + 2
  }),
  seal: Object.freeze({
    maximumFastPathDocumentReads: 47_006,
    maximumDocumentReads: 94_066,
    maximumDocumentWrites: maximumOwnedNotes + maximumOwnedFolders + 56
  })
});

function requirePost(request) {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
}

function requireRequestMarker(request) {
  if (headerValue(request, "x-quickmemo-vault-integrity") !== "1") {
    throw new HttpError(403, "request_rejected", "Vault integrity request marker is missing");
  }
}

function treePath(uid) {
  return `vaultFolderTrees/${uid}`;
}

function notePath(noteId) {
  return `notes/${noteId}`;
}

function folderPath(folderId) {
  return `noteFolders/${folderId}`;
}

function expectedCount(value, fieldName, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertLeaseToken(value, fieldName) {
  if (typeof value !== "string" || !leaseTokenPattern.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function selectedFields(fieldPaths) {
  return { fields: fieldPaths.map((fieldPath) => ({ fieldPath })) };
}

function ownedCollectionQuery(uid, collectionId, limit, fields) {
  return {
    from: [{ collectionId }],
    limit,
    select: selectedFields(fields),
    where: {
      fieldFilter: {
        field: { fieldPath: "ownerUid" },
        op: "EQUAL",
        value: { stringValue: uid }
      }
    }
  };
}

function noteInventoryQuery(uid) {
  return ownedCollectionQuery(uid, "notes", maximumOwnedNotes + 1, [
    "contentFormat",
    "deletedAt",
    "deletedBy",
    "encryptedBody.version",
    "encryptedTitle.version",
    "entryKind",
    "folderId",
    "isDeleted",
    "isPurged",
    "ownerUid",
    "purgedAt",
    "purgedBy",
    "secureShareCopyState",
    "type",
    "vaultImportJobId",
    "vaultNameClaimId",
    "vaultNameIndexVersion"
  ]);
}

function folderInventoryQuery(uid) {
  return ownedCollectionQuery(uid, "noteFolders", maximumOwnedFolders + 1, [
    "deletedAt",
    "deletedBy",
    "encryptedName.version",
    "isDeleted",
    "ownerUid",
    "parentId",
    "revision",
    "vaultImportJobId",
    "vaultLineageGeneration",
    "vaultNameClaimId",
    "vaultNameIndexVersion",
    "wrappedKey.version"
  ]);
}

function claimInventoryQuery() {
  return {
    from: [{ collectionId: "nameClaims" }],
    limit: maximumNameClaims + 1,
    select: selectedFields([
      "indexVersion",
      "ownerUid",
      "parentId",
      "targetId",
      "targetType"
    ])
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isOptimisticLeaseConflict(error) {
  return !(error instanceof HttpError) && (
    error?.statusCode === 409
    || error?.upstreamCode === "ABORTED"
    || error?.upstreamCode === "FAILED_PRECONDITION"
  );
}

function cutoverBusy(lease = null, nowMilliseconds = Date.now()) {
  return new HttpError(
    409,
    "vault_cutover_busy",
    "Another Vault cutover operation is active",
    {
      retryAfter: lease && lease.expiresAt > nowMilliseconds
        ? Math.min(30, Math.max(1, Math.ceil((lease.expiresAt - nowMilliseconds) / 1_000)))
        : 1
    }
  );
}

function cutoverLeaseFields(leaseHash, leaseGeneration, options) {
  const now = options.now;
  return {
    cutoverLeaseAcquiredAt: options.acquiredAt ?? now,
    cutoverLeaseExpiresAt: new Date(now.getTime() + cutoverLeaseTtlSeconds * 1_000),
    cutoverLeaseGeneration: leaseGeneration,
    cutoverLeaseHash: leaseHash,
    cutoverLeaseVersion,
    cutoverState: "pending",
    cutoverVersion: VAULT_CUTOVER_VERSION,
    updatedAt: now,
  };
}

function cutoverLeaseWrite(context, uid, markerDocument, fields) {
  return updateDocumentWrite(
    context.projectId,
    integrityPath(uid),
    fields,
    Object.keys(fields),
    markerDocument.__updateTime
  );
}

function clearCutoverLeaseWrite(context, uid, markerDocument, now = new Date()) {
  return updateDocumentWrite(
    context.projectId,
    integrityPath(uid),
    { updatedAt: now },
    ["updatedAt", ...VAULT_CUTOVER_LEASE_FIELD_PATHS],
    markerDocument.__updateTime
  );
}

function leaseCredential(body, options = {}) {
  const leaseId = assertLeaseToken(body.leaseId, "leaseId");
  const generation = options.generation === false
    ? ""
    : assertLeaseToken(body.leaseGeneration, "leaseGeneration");
  return {
    generation,
    hash: sha256Digest(leaseId)
  };
}

async function acquireCutoverLease(context, uid, leaseId) {
  const leaseHash = sha256Digest(assertLeaseToken(leaseId, "leaseId"));
  for (let attempt = 0; attempt < maximumLeaseAcquireAttempts; attempt += 1) {
    const { documents, transaction } = await firestoreBatchGetNewTransaction(context, [
      integrityPath(uid)
    ]);
    let finalized = false;
    try {
      const marker = requireVaultIntegrityMarker(documents[0], uid, "any");
      if (marker.state === "ready") {
        await firestoreRollback(context, transaction);
        finalized = true;
        return { marker: marker.document, state: "ready" };
      }

      const now = new Date();
      const existing = marker.lease ?? null;
      if (
        existing
        && existing.expiresAt > now.getTime()
        && !constantTimeStringEqual(existing.hash, leaseHash)
      ) {
        await firestoreRollback(context, transaction);
        finalized = true;
        throw cutoverBusy(existing, now.getTime());
      }
      const sameLiveLease = existing
        && existing.expiresAt > now.getTime()
        && constantTimeStringEqual(existing.hash, leaseHash);
      const generation = sameLiveLease ? existing.generation : randomToken(32);
      const fields = cutoverLeaseFields(leaseHash, generation, {
        acquiredAt: sameLiveLease ? new Date(existing.acquiredAt) : now,
        now,
      });
      await firestoreCommit(context, [
        cutoverLeaseWrite(context, uid, marker.document, fields)
      ], transaction);
      finalized = true;
      return {
        generation,
        hash: leaseHash,
        state: "active"
      };
    } catch (error) {
      if (!finalized) await firestoreRollback(context, transaction).catch(() => undefined);
      if (error instanceof HttpError && error.code === "vault_cutover_busy") throw error;
      if (isOptimisticLeaseConflict(error) && attempt < maximumLeaseAcquireAttempts - 1) {
        continue;
      }
      if (isOptimisticLeaseConflict(error)) throw cutoverBusy();
      throw error;
    }
  }
  throw cutoverBusy();
}

function renewedCutoverLeaseWrite(context, uid, markerDocument, leaseRequest) {
  const marker = requireVaultCutoverLease(markerDocument, uid, leaseRequest);
  const lease = marker.lease;
  const now = new Date();
  return cutoverLeaseWrite(context, uid, markerDocument, cutoverLeaseFields(
    lease.hash,
    lease.generation,
    {
      acquiredAt: new Date(lease.acquiredAt),
      now
    }
  ));
}

async function renewHeldCutoverLease(context, uid, leaseRequest) {
  for (let attempt = 0; attempt < maximumLeaseAcquireAttempts; attempt += 1) {
    const { documents, transaction } = await firestoreBatchGetNewTransaction(context, [
      integrityPath(uid)
    ]);
    let finalized = false;
    try {
      const marker = requireVaultIntegrityMarker(documents[0], uid, "any");
      if (marker.state === "ready") {
        await firestoreRollback(context, transaction);
        finalized = true;
        return { state: "ready" };
      }
      const lease = requireVaultCutoverLease(marker.document, uid, leaseRequest).lease;
      const now = new Date();
      const fields = cutoverLeaseFields(lease.hash, lease.generation, {
        acquiredAt: new Date(lease.acquiredAt),
        now
      });
      await firestoreCommit(context, [
        cutoverLeaseWrite(context, uid, marker.document, fields)
      ], transaction);
      finalized = true;
      return { state: "pending" };
    } catch (error) {
      if (!finalized) await firestoreRollback(context, transaction).catch(() => undefined);
      if (error instanceof HttpError && error.code === "vault_cutover_busy") throw error;
      if (isOptimisticLeaseConflict(error) && attempt < maximumLeaseAcquireAttempts - 1) continue;
      if (isOptimisticLeaseConflict(error)) throw cutoverBusy();
      throw error;
    }
  }
  throw cutoverBusy();
}

async function releaseCutoverLease(context, uid, leaseRequest) {
  for (let attempt = 0; attempt < maximumLeaseAcquireAttempts; attempt += 1) {
    const { documents, transaction } = await firestoreBatchGetNewTransaction(context, [
      integrityPath(uid)
    ]);
    let finalized = false;
    try {
      const marker = requireVaultIntegrityMarker(documents[0], uid, "any");
      const existing = marker.lease ?? null;
      if (
        marker.state === "ready"
        || !existing
        || !constantTimeStringEqual(existing.hash, leaseRequest.hash)
        || !constantTimeStringEqual(existing.generation, leaseRequest.generation)
      ) {
        await firestoreRollback(context, transaction);
        finalized = true;
        return false;
      }
      await firestoreCommit(context, [
        clearCutoverLeaseWrite(context, uid, marker.document)
      ], transaction);
      finalized = true;
      return true;
    } catch (error) {
      if (!finalized) await firestoreRollback(context, transaction).catch(() => undefined);
      if (isOptimisticLeaseConflict(error) && attempt < maximumLeaseAcquireAttempts - 1) continue;
      if (isOptimisticLeaseConflict(error)) return false;
      throw error;
    }
  }
  return false;
}

function failIncomplete(message = "Vault cutover inventory is incomplete") {
  throw new HttpError(409, "vault_cutover_incomplete", message);
}

function failChanged(message = "Vault cutover inventory changed") {
  throw new HttpError(409, "vault_cutover_changed", message);
}

function assertOwnerUid(value, uid) {
  if (typeof value !== "string" || !ownerPattern.test(value) || value !== uid) {
    failIncomplete("Vault inventory owner is invalid");
  }
}

function assertTargetId(value, fieldName = "target id") {
  if (typeof value !== "string" || !targetPattern.test(value)) {
    failIncomplete(`Vault ${fieldName} is invalid`);
  }
  return value;
}

function optionalParentId(value) {
  if (value === undefined || value === null) return null;
  return assertTargetId(value, "parent id");
}

function projectedEnvelope(value) {
  return Boolean(value && typeof value === "object" && value.version === 1);
}

function explicitBoolean(document, fieldName) {
  if (typeof document?.[fieldName] !== "boolean") {
    failIncomplete(`Vault ${fieldName} metadata is incomplete`);
  }
  return document[fieldName];
}

function claimMetadata(document) {
  const hasId = hasOwn(document, "vaultNameClaimId");
  const hasVersion = hasOwn(document, "vaultNameIndexVersion");
  if (!hasId && !hasVersion) return null;
  if (
    !hasId
    || !hasVersion
    || typeof document.vaultNameClaimId !== "string"
    || !claimPattern.test(document.vaultNameClaimId)
    || document.vaultNameIndexVersion !== 1
  ) {
    throw new HttpError(409, "vault_claim_invalid", "Stored Vault claim metadata is invalid");
  }
  return document.vaultNameClaimId;
}

function assertStorageIdentity(note) {
  if (
    typeof note.contentFormat !== "string"
    || typeof note.entryKind !== "string"
    || storageIdentities.get(note.contentFormat) !== note.entryKind
    || !projectedEnvelope(note.encryptedTitle)
    || !projectedEnvelope(note.encryptedBody)
  ) {
    failIncomplete("Vault note storage identity is incomplete");
  }
}

function claimTargetKey(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

function normalizedClaim(claim, uid) {
  assertOwnerUid(claim?.ownerUid, uid);
  if (
    typeof claim?.__id !== "string"
    || !claimPattern.test(claim.__id)
    || claim.indexVersion !== 1
    || !["entry", "folder"].includes(claim.targetType)
  ) {
    throw new HttpError(409, "vault_claim_invalid", "Stored Vault name claim is invalid");
  }
  return {
    claimId: claim.__id,
    parentId: optionalParentId(claim.parentId),
    targetId: assertTargetId(claim.targetId),
    targetType: claim.targetType
  };
}

function normalizeNoteTarget(note, uid) {
  assertOwnerUid(note?.ownerUid, uid);
  const targetId = assertTargetId(note?.__id, "note id");
  const isDeleted = explicitBoolean(note, "isDeleted");
  if (hasOwn(note, "isPurged") && typeof note.isPurged !== "boolean") {
    failIncomplete("Vault purge metadata is invalid");
  }
  const isPurged = note.isPurged === true;
  const copyState = note.secureShareCopyState;
  if (copyState !== undefined && !secureCopyStates.has(copyState)) {
    failIncomplete("Vault secure copy state is invalid");
  }
  if (isPurged && !isDeleted) failIncomplete("Purged Vault note is not deleted");
  if (copyState === "aborted" && !isDeleted) {
    failIncomplete("Aborted Vault secure copy is not deleted");
  }
  if (copyState === "copying" && (isDeleted || isPurged)) {
    failIncomplete("Pending Vault secure copy lifecycle is invalid");
  }

  const visible = !isDeleted && !isPurged && copyState !== "copying" && copyState !== "aborted";
  const deletedVisible = isDeleted && !isPurged && copyState !== "copying" && copyState !== "aborted";
  const needsClaim = !isDeleted && !isPurged && copyState !== "aborted";
  if (needsClaim || visible || deletedVisible) assertStorageIdentity(note);
  if (!["personal", "shared"].includes(note.type)) {
    failIncomplete("Vault note type is invalid");
  }
  const parentId = optionalParentId(note.folderId);
  if (note.type === "shared" && parentId !== null) {
    failIncomplete("Shared Vault note has a folder");
  }
  const claimId = claimMetadata(note);
  if (needsClaim && !claimId) {
    throw new HttpError(409, "vault_name_claim_required", "Vault note claim is missing");
  }
  return {
    claimId,
    deletedVisible,
    needsClaim,
    parentId,
    targetId,
    targetType: "entry",
    visible
  };
}

function normalizeFolderTarget(folder, uid) {
  assertOwnerUid(folder?.ownerUid, uid);
  const targetId = assertTargetId(folder?.__id, "folder id");
  const isDeleted = explicitBoolean(folder, "isDeleted");
  if (
    !projectedEnvelope(folder.encryptedName)
    || !projectedEnvelope(folder.wrappedKey)
    || !Number.isSafeInteger(folder.revision)
    || folder.revision < 1
    || folder.revision > maximumRevision
    || !Number.isSafeInteger(folder.vaultLineageGeneration)
    || folder.vaultLineageGeneration < 1
    || folder.vaultLineageGeneration > maximumRevision
  ) {
    failIncomplete("Vault folder identity is incomplete");
  }
  const claimId = claimMetadata(folder);
  if (!isDeleted && !claimId) {
    throw new HttpError(409, "vault_name_claim_required", "Vault folder claim is missing");
  }
  return {
    claimId,
    needsClaim: !isDeleted,
    parentId: optionalParentId(folder.parentId),
    targetId,
    targetType: "folder"
  };
}

function reconciliationTargetState(document, kind) {
  if (hasOwn(document, "isDeleted") && typeof document.isDeleted !== "boolean") {
    failIncomplete("Vault deletion metadata is invalid");
  }
  if (kind === "folder") {
    if (!hasOwn(document, "isDeleted")) {
      if (
        ambiguousLegacyDeletion(document, kind)
        || !projectedEnvelope(document.encryptedName)
        || !projectedEnvelope(document.wrappedKey)
      ) {
        return "ambiguous";
      }
      return "active";
    }
    return document.isDeleted === true
      ? "inactive"
      : "active";
  }

  if (hasOwn(document, "isPurged") && typeof document.isPurged !== "boolean") {
    failIncomplete("Vault purge metadata is invalid");
  }
  const copyState = document.secureShareCopyState;
  if (copyState !== undefined && !secureCopyStates.has(copyState)) {
    failIncomplete("Vault secure copy state is invalid");
  }
  if (document.isDeleted === false && (document.isPurged === true || copyState === "aborted")) {
    failIncomplete("Vault inactive lifecycle metadata is inconsistent");
  }
  if (document.isDeleted === true && copyState === "copying") {
    failIncomplete("Vault pending copy lifecycle metadata is inconsistent");
  }
  if (document.isDeleted === true) return "inactive";
  if (document.isDeleted === false) return "active";
  return ambiguousLegacyDeletion(document, kind) ? "ambiguous" : "active";
}

function reconciliationTarget(document, uid, targetType) {
  assertOwnerUid(document?.ownerUid, uid);
  return {
    claimId: claimMetadata(document),
    parentId: optionalParentId(targetType === "entry" ? document.folderId : document.parentId),
    state: reconciliationTargetState(document, targetType === "entry" ? "note" : "folder"),
    targetId: assertTargetId(document?.__id, targetType === "entry" ? "note id" : "folder id"),
    targetType
  };
}

function claimMatchesReconciliationTarget(claim, target) {
  return claim.targetId === target.targetId
    && claim.targetType === target.targetType
    && claim.parentId === target.parentId;
}

/**
 * Returns only claims that are safe to remove without knowing a plaintext
 * Vault name. Active and ambiguous targets are preserved unless their target
 * has a different, complete claim that is already present and points back to
 * the same target. An orphan is removable only when no active or ambiguous
 * target document references its claim id.
 */
function staleClaimDocuments(uid, inventory) {
  const targets = [
    ...inventory.notes.map((note) => reconciliationTarget(note, uid, "entry")),
    ...inventory.folders.map((folder) => reconciliationTarget(folder, uid, "folder"))
  ];
  const targetByKey = new Map();
  const referencesByClaimId = new Map();
  for (const target of targets) {
    const key = claimTargetKey(target.targetType, target.targetId);
    if (targetByKey.has(key)) failIncomplete("Vault inventory contains a duplicate target");
    targetByKey.set(key, target);
    if (target.claimId) {
      const references = referencesByClaimId.get(target.claimId) ?? [];
      references.push(target);
      referencesByClaimId.set(target.claimId, references);
    }
  }

  const normalizedClaims = inventory.claims.map((document) => ({
    document,
    value: normalizedClaim(document, uid)
  }));
  const claimById = new Map();
  for (const claim of normalizedClaims) {
    if (claimById.has(claim.value.claimId)) {
      throw new HttpError(409, "vault_claim_invalid", "Vault name claims are not unique");
    }
    claimById.set(claim.value.claimId, claim.value);
  }

  return normalizedClaims.filter(({ document, value: claim }) => {
    if (typeof document.__updateTime !== "string" || !document.__updateTime) {
      failIncomplete("Vault claim update precondition is missing");
    }
    const target = targetByKey.get(claimTargetKey(claim.targetType, claim.targetId)) ?? null;
    const protectedReference = (referencesByClaimId.get(claim.claimId) ?? []).some(
      (reference) => reference.state !== "inactive" && !claimMatchesReconciliationTarget(claim, reference)
    );

    if (!target || target.state === "inactive") {
      return !protectedReference;
    }
    if (target.state !== "active" || !target.claimId || target.claimId === claim.claimId) {
      return false;
    }
    const replacement = claimById.get(target.claimId);
    return Boolean(
      replacement
      && claimMatchesReconciliationTarget(replacement, target)
      && !protectedReference
    );
  });
}

function validateTree(treeDocument, folders, uid) {
  if (!treeDocument || treeDocument.ownerUid !== uid) {
    throw new HttpError(409, "vault_tree_invalid", "Vault folder tree is unavailable", {
      expose: false
    });
  }
  const tree = validateVaultFolderTree({
    folderCount: treeDocument.folderCount,
    nodes: treeDocument.nodes,
    revision: treeDocument.revision,
    schemaVersion: treeDocument.schemaVersion
  });
  if (!vaultFolderTreeMatchesFolders(tree, folders)) {
    throw new HttpError(409, "vault_tree_stale", "Vault folder tree needs repair");
  }
  return tree;
}

function validateVaultIntegrityInventory(uid, inventory, expected) {
  if (!ownerPattern.test(uid)) throw new TypeError("A valid Vault owner is required");
  if (
    !inventory
    || !Array.isArray(inventory.notes)
    || !Array.isArray(inventory.folders)
    || !Array.isArray(inventory.claims)
  ) {
    throw new TypeError("A complete Vault inventory is required");
  }
  if (inventory.notes.length > maximumOwnedNotes) {
    failIncomplete("Vault note inventory exceeded its safe limit");
  }
  if (inventory.folders.length > maximumOwnedFolders) {
    failIncomplete("Vault folder inventory exceeded its safe limit");
  }
  if (inventory.claims.length > maximumNameClaims) {
    failIncomplete("Vault claim inventory exceeded its safe limit");
  }

  const tree = validateTree(inventory.treeDocument, inventory.folders, uid);
  const targets = [
    ...inventory.notes.map((note) => normalizeNoteTarget(note, uid)),
    ...inventory.folders.map((folder) => normalizeFolderTarget(folder, uid))
  ];
  const targetByKey = new Map();
  for (const target of targets) {
    const key = claimTargetKey(target.targetType, target.targetId);
    if (targetByKey.has(key)) failIncomplete("Vault inventory contains a duplicate target");
    targetByKey.set(key, target);
  }

  const claimById = new Map();
  const claimByTarget = new Map();
  for (const document of inventory.claims) {
    const claim = normalizedClaim(document, uid);
    const targetKey = claimTargetKey(claim.targetType, claim.targetId);
    if (claimById.has(claim.claimId) || claimByTarget.has(targetKey)) {
      throw new HttpError(409, "vault_claim_invalid", "Vault name claims are not unique");
    }
    claimById.set(claim.claimId, claim);
    claimByTarget.set(targetKey, claim);
  }

  const consumedClaimIds = new Set();
  for (const target of targets) {
    const targetKey = claimTargetKey(target.targetType, target.targetId);
    const targetClaim = claimByTarget.get(targetKey) ?? null;
    if (!target.needsClaim) {
      if (targetClaim) {
        throw new HttpError(409, "vault_claim_invalid", "Inactive Vault target retained a live claim");
      }
      continue;
    }
    const claim = target.claimId ? claimById.get(target.claimId) : null;
    if (
      !claim
      || claim !== targetClaim
      || claim.targetId !== target.targetId
      || claim.targetType !== target.targetType
      || claim.parentId !== target.parentId
    ) {
      throw new HttpError(409, "vault_claim_invalid", "Vault target and name claim do not match");
    }
    consumedClaimIds.add(claim.claimId);
  }
  if (consumedClaimIds.size !== claimById.size) {
    throw new HttpError(409, "vault_claim_invalid", "Vault contains an orphan name claim");
  }

  const activeNoteCount = targets.filter(
    (target) => target.targetType === "entry" && target.visible
  ).length;
  const deletedNoteCount = targets.filter(
    (target) => target.targetType === "entry" && target.deletedVisible
  ).length;
  const folderCount = Object.values(tree.nodes).filter((node) => node.active === true).length;
  if (
    activeNoteCount !== expected.expectedActiveNoteCount
    || deletedNoteCount !== expected.expectedDeletedNoteCount
    || folderCount !== expected.expectedFolderCount
  ) {
    failChanged();
  }
  return { activeNoteCount, deletedNoteCount, folderCount };
}

function ambiguousLegacyDeletion(document, kind) {
  if (kind === "note") {
    return hasOwn(document, "deletedAt")
      || hasOwn(document, "deletedBy")
      || hasOwn(document, "purgedAt")
      || hasOwn(document, "purgedBy")
      || document.isPurged === true
      || document.secureShareCopyState === "aborted";
  }
  return hasOwn(document, "deletedAt") || hasOwn(document, "deletedBy");
}

function normalizationWrites(context, documents, kind) {
  const writes = [];
  for (const document of documents) {
    if (hasOwn(document, "isDeleted")) {
      if (typeof document.isDeleted !== "boolean") {
        failIncomplete("Vault deletion metadata is invalid");
      }
      continue;
    }
    if (ambiguousLegacyDeletion(document, kind)) {
      failIncomplete("Legacy Vault deletion metadata is ambiguous");
    }
    if (
      kind === "folder"
      && (!projectedEnvelope(document.encryptedName) || !projectedEnvelope(document.wrappedKey))
    ) {
      continue;
    }
    const targetId = assertTargetId(document.__id, `${kind} id`);
    if (typeof document.__updateTime !== "string" || !document.__updateTime) {
      failIncomplete("Vault update precondition is missing");
    }
    writes.push(updateDocumentWrite(
      context.projectId,
      kind === "note" ? notePath(targetId) : folderPath(targetId),
      { isDeleted: false },
      ["isDeleted"],
      document.__updateTime
    ));
  }
  return writes;
}

async function commitNormalizationWrites(context, uid, writes, leaseRequest) {
  for (let offset = 0; offset < writes.length; offset += maximumNormalizationWrites) {
    const { documents, transaction } = await firestoreBatchGetNewTransaction(context, [
      integrityPath(uid)
    ]);
    let committed = false;
    try {
      requireVaultCutoverLease(documents[0], uid, leaseRequest);
      await firestoreCommit(context, [
        ...writes.slice(offset, offset + maximumNormalizationWrites),
        renewedCutoverLeaseWrite(context, uid, documents[0], leaseRequest)
      ], transaction);
      committed = true;
    } catch (error) {
      if (!committed) await firestoreRollback(context, transaction).catch(() => undefined);
      if (error instanceof HttpError && error.code === "vault_cutover_busy") throw error;
      if (
        error?.statusCode === 409
        || error?.upstreamCode === "ABORTED"
        || error?.upstreamCode === "FAILED_PRECONDITION"
      ) {
        throw new HttpError(409, "vault_cutover_changed", "Vault changed during normalization");
      }
      throw error;
    }
  }
}

async function reconcileStaleClaims(context, uid, leaseRequest) {
  const { documents, transaction } = await firestoreBatchGetNewTransaction(context, [
    integrityPath(uid)
  ]);
  let committed = false;
  try {
    requireVaultCutoverLease(documents[0], uid, leaseRequest);
    const claims = await firestoreRunQuery(
      context,
      claimInventoryQuery(),
      integrityPath(uid),
      transaction
    );
    if (claims.length > maximumNameClaims) {
      failIncomplete("Vault claim inventory exceeded its safe limit");
    }
    let notes = [];
    let folders = [];
    if (claims.length > 0) {
      notes = await firestoreRunQuery(context, noteInventoryQuery(uid), "", transaction);
      if (notes.length > maximumOwnedNotes) {
        failIncomplete("Vault note inventory exceeded its safe limit");
      }
      folders = await firestoreRunQuery(context, folderInventoryQuery(uid), "", transaction);
      if (folders.length > maximumOwnedFolders) {
        failIncomplete("Vault folder inventory exceeded its safe limit");
      }
    }
    const staleClaims = claims.length > 0
      ? staleClaimDocuments(uid, { claims, folders, notes })
      : [];
    const selected = staleClaims.slice(0, maximumReconciliationWrites);
    const writes = [
      ...selected.map(({ document, value }) => deleteDocumentWrite(
        context.projectId,
        claimPath(uid, value.claimId),
        document.__updateTime
      )),
      renewedCutoverLeaseWrite(context, uid, documents[0], leaseRequest)
    ];
    try {
      await firestoreCommit(context, writes, transaction);
    } catch (error) {
      if (
        error?.statusCode === 409
        || error?.upstreamCode === "ABORTED"
        || error?.upstreamCode === "FAILED_PRECONDITION"
      ) {
        throw new HttpError(409, "vault_cutover_changed", "Vault changed during claim reconciliation");
      }
      throw error;
    }
    committed = true;
    return {
      hasMore: staleClaims.length > selected.length,
      leaseGeneration: leaseRequest.generation,
      observedClaimCount: claims.length,
      removedClaimCount: selected.length,
      state: "pending"
    };
  } catch (error) {
    if (!committed) await firestoreRollback(context, transaction).catch(() => undefined);
    throw error;
  }
}

function readyResult(marker, expected) {
  return {
    activeNoteCount: expected.expectedActiveNoteCount,
    cutoverVersion: VAULT_CUTOVER_VERSION,
    deletedNoteCount: expected.expectedDeletedNoteCount,
    folderCount: expected.expectedFolderCount,
    state: "ready",
    verifiedAt: marker.verifiedAt
  };
}

async function sealReady(context, uid, expected, leaseRequest, normalizationPass = 0) {
  const { documents, transaction } = await firestoreBatchGetNewTransaction(context, [
    integrityPath(uid),
    treePath(uid)
  ]);
  let committed = false;
  try {
    const marker = requireVaultIntegrityMarker(documents[0], uid, "any");
    if (marker.state === "ready") {
      await firestoreRollback(context, transaction);
      return readyResult(marker.document, expected);
    }
    requireVaultCutoverLease(marker.document, uid, leaseRequest);
    const notes = await firestoreRunQuery(context, noteInventoryQuery(uid), "", transaction);
    if (notes.length > maximumOwnedNotes) failIncomplete("Vault note inventory exceeded its safe limit");
    const folders = await firestoreRunQuery(context, folderInventoryQuery(uid), "", transaction);
    if (folders.length > maximumOwnedFolders) failIncomplete("Vault folder inventory exceeded its safe limit");
    const claims = await firestoreRunQuery(
      context,
      claimInventoryQuery(),
      integrityPath(uid),
      transaction
    );
    if (claims.length > maximumNameClaims) failIncomplete("Vault claim inventory exceeded its safe limit");
    const legacyNormalizationWrites = [
      ...normalizationWrites(context, notes, "note"),
      ...normalizationWrites(context, folders, "folder")
    ];
    if (legacyNormalizationWrites.length) {
      await firestoreRollback(context, transaction);
      committed = true;
      if (normalizationPass >= 1) {
        failChanged("Vault deletion metadata changed during normalization");
      }
      await commitNormalizationWrites(
        context,
        uid,
        legacyNormalizationWrites,
        leaseRequest
      );
      return sealReady(context, uid, expected, leaseRequest, normalizationPass + 1);
    }
    const counts = validateVaultIntegrityInventory(uid, {
      claims,
      folders,
      notes,
      treeDocument: documents[1]
    }, expected);
    const now = new Date();
    const readyFields = vaultIntegrityReadyFields(now);
    try {
      await firestoreCommit(context, [
        updateDocumentWrite(
          context.projectId,
          integrityPath(uid),
          readyFields,
          [...Object.keys(readyFields), ...VAULT_CUTOVER_LEASE_FIELD_PATHS],
          documents[0].__updateTime
        )
      ], transaction);
    } catch (error) {
      if (
        error?.statusCode === 409
        || error?.upstreamCode === "ABORTED"
        || error?.upstreamCode === "FAILED_PRECONDITION"
      ) {
        throw new HttpError(409, "vault_cutover_changed", "Vault changed while sealing cutover");
      }
      throw error;
    }
    committed = true;
    return {
      ...counts,
      cutoverVersion: VAULT_CUTOVER_VERSION,
      state: "ready",
      verifiedAt: now.toISOString()
    };
  } catch (error) {
    if (!committed) await firestoreRollback(context, transaction).catch(() => undefined);
    throw error;
  }
}

async function performAction(context, uid, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Expected a JSON object");
  }
  const action = body.action;
  if (typeof action !== "string" || !supportedActions.has(action)) {
    throw new HttpError(400, "invalid_request", "Invalid Vault integrity action");
  }
  if (body.action === "reconcile-stale-claims") {
    assertOnlyKeys(body, ["action", "leaseId"]);
    const lease = await acquireCutoverLease(context, uid, body.leaseId);
    if (lease.state === "ready") {
      throw new HttpError(409, "vault_cutover_complete", "Vault cutover migration is already complete");
    }
    try {
      return await reconcileStaleClaims(context, uid, lease);
    } catch (error) {
      await releaseCutoverLease(context, uid, lease).catch(() => undefined);
      throw error;
    }
  }
  if (body.action === "renew-cutover-lease") {
    assertOnlyKeys(body, ["action", "leaseGeneration", "leaseId"]);
    const result = await renewHeldCutoverLease(context, uid, leaseCredential(body));
    return {
      leaseExpiresInSeconds: result.state === "pending" ? cutoverLeaseTtlSeconds : 0,
      state: result.state
    };
  }
  if (body.action === "release-cutover-lease") {
    assertOnlyKeys(body, ["action", "leaseGeneration", "leaseId"]);
    return {
      released: await releaseCutoverLease(context, uid, leaseCredential(body)),
      state: "released"
    };
  }
  assertOnlyKeys(body, [
    "action",
    "expectedActiveNoteCount",
    "expectedDeletedNoteCount",
    "expectedFolderCount",
    "leaseGeneration",
    "leaseId"
  ]);
  const expected = {
    expectedActiveNoteCount: expectedCount(
      body.expectedActiveNoteCount,
      "expectedActiveNoteCount",
      maximumOwnedNotes
    ),
    expectedDeletedNoteCount: expectedCount(
      body.expectedDeletedNoteCount,
      "expectedDeletedNoteCount",
      maximumOwnedNotes
    ),
    expectedFolderCount: expectedCount(
      body.expectedFolderCount,
      "expectedFolderCount",
      maximumOwnedFolders
    )
  };
  if (expected.expectedActiveNoteCount + expected.expectedDeletedNoteCount > maximumOwnedNotes) {
    throw new HttpError(400, "invalid_request", "Expected Vault note count exceeds its safe limit");
  }
  const lease = leaseCredential(body);
  try {
    return await sealReady(context, uid, expected, lease);
  } catch (error) {
    await releaseCutoverLease(context, uid, lease).catch(() => undefined);
    throw error;
  }
}

export const __vaultIntegrityTesting = Object.freeze({
  claimInventoryQuery,
  folderInventoryQuery,
  noteInventoryQuery,
  performAction,
  operationBounds: VAULT_INTEGRITY_OPERATION_BOUNDS,
  reconcileStaleClaims,
  releaseCutoverLease,
  renewHeldCutoverLease,
  staleClaimDocuments,
  validateVaultIntegrityInventory
});

export default async function handler(request, response) {
  const id = requestId();
  let action = "unknown";
  applySecureResponseHeaders(response, id);
  try {
    requirePost(request);
    ensureSameOrigin(request);
    requireRequestMarker(request);
    const context = await createFirestoreContext();
    const appCheck = await verifySecureShareAppCheck(request, context);
    if (appCheck.enforced === true && appCheck.valid !== true) {
      throw new HttpError(403, "request_rejected", "App Check validation failed");
    }
    const user = await activeUserFromRequest(request, context);
    const body = await readJsonBody(request, maximumRequestBytes);
    action = typeof body?.action === "string" ? body.action : "unknown";
    const result = await performAction(context, user.uid, body);
    jsonResponse(response, 200, { ok: true, ...result });
  } catch (error) {
    logVaultApiRejection({
      action,
      error,
      requestId: id,
      route: "/api/vault-integrity",
      supportedActions
    });
    handleApiError(error, response, id);
  }
}
