import {
  HttpError,
  activeUserFromRequest,
  applySecureResponseHeaders,
  assertOnlyKeys,
  createFirestoreContext,
  ensureSameOrigin,
  firestoreBatchGet,
  firestoreBatchGetNewTransaction,
  firestoreCommit,
  firestoreRollback,
  firestoreRunQuery,
  handleApiError,
  headerValue,
  jsonResponse,
  readJsonBody,
  requestId,
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
  integrityPath,
  requireVaultIntegrityMarker,
  vaultIntegrityReadyFields
} from "./_vault-integrity-marker.js";

const maximumOwnedNotes = 20_000;
const maximumOwnedFolders = VAULT_FOLDER_TREE_MAX_FOLDERS;
const maximumNameClaims = 25_000;
const maximumNormalizationWrites = 400;
const maximumRequestBytes = 32 * 1024;
const maximumRevision = 999_999_999_999;
const claimPattern = /^[A-Za-z0-9_-]{43}$/u;
const ownerPattern = /^[A-Za-z0-9_-]{1,160}$/u;
const targetPattern = /^[A-Za-z0-9_-]{1,120}$/u;
const supportedActions = new Set(["seal-ready"]);
const storageIdentities = new Map([
  ["legacy-html-v1", "legacy-html"],
  ["markdown-v1", "markdown"],
  ["json-canvas-v1", "canvas"],
  ["base-v1", "base"],
  ["asset-v1", "asset"]
]);
const secureCopyStates = new Set(["active", "aborted", "copying"]);

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

async function commitNormalizationWrites(context, writes) {
  for (let offset = 0; offset < writes.length; offset += maximumNormalizationWrites) {
    try {
      await firestoreCommit(context, writes.slice(offset, offset + maximumNormalizationWrites));
    } catch (error) {
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

async function normalizeLegacyDeletionMetadata(context, uid) {
  const [notes, folders] = await Promise.all([
    firestoreRunQuery(context, noteInventoryQuery(uid)),
    firestoreRunQuery(context, folderInventoryQuery(uid))
  ]);
  if (notes.length > maximumOwnedNotes || folders.length > maximumOwnedFolders) {
    failIncomplete("Vault inventory exceeded its safe normalization limit");
  }
  const writes = [
    ...normalizationWrites(context, notes, "note"),
    ...normalizationWrites(context, folders, "folder")
  ];
  await commitNormalizationWrites(context, writes);
  return { normalizedCount: writes.length };
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

async function sealReady(context, uid, expected) {
  const [initialMarker] = await firestoreBatchGet(context, [integrityPath(uid)]);
  const initial = requireVaultIntegrityMarker(initialMarker, uid, "any");
  if (initial.state === "ready") return readyResult(initial.document, expected);

  await normalizeLegacyDeletionMetadata(context, uid);
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
    const counts = validateVaultIntegrityInventory(uid, {
      claims,
      folders,
      notes,
      treeDocument: documents[1]
    }, expected);
    const now = new Date();
    const readyFields = vaultIntegrityReadyFields(now);
    try {
      await firestoreCommit(context, [updateDocumentWrite(
        context.projectId,
        integrityPath(uid),
        readyFields,
        Object.keys(readyFields),
        documents[0].__updateTime
      )], transaction);
    } catch (error) {
      if (error?.statusCode === 409 || error?.upstreamCode === "ABORTED") {
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
  assertOnlyKeys(body, [
    "action",
    "expectedActiveNoteCount",
    "expectedDeletedNoteCount",
    "expectedFolderCount"
  ]);
  if (body.action !== "seal-ready") {
    throw new HttpError(400, "invalid_request", "Invalid Vault integrity action");
  }
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
  return sealReady(context, uid, expected);
}

export const __vaultIntegrityTesting = Object.freeze({
  claimInventoryQuery,
  folderInventoryQuery,
  normalizeLegacyDeletionMetadata,
  noteInventoryQuery,
  performAction,
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
