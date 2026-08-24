import {
  HttpError,
  activeUserFromRequest,
  applySecureResponseHeaders,
  assertOnlyKeys,
  createDocumentWrite,
  createFirestoreContext,
  deleteDocumentWrite,
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
import { prepareAtomicPathRewriteActivation } from "./_vault-path-rewrite-activation.js";
import {
  nextVaultInventoryDocument,
  prepareVaultInventoryManifestMutation
} from "./_vault-inventory-manifest-mutation.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  VAULT_FOLDER_TREE_MAX_FOLDERS,
  VAULT_FOLDER_TREE_SCHEMA_VERSION,
  assertVaultFolderId,
  buildVaultFolderTree,
  createVaultFolderNode,
  moveVaultFolderNode,
  setVaultFolderLifecycle,
  validateVaultFolderTree,
  vaultFolderAncestors,
  vaultFolderTreeDocumentWrite,
  vaultFolderTreeMatchesFolders
} from "./_vault-folder-tree.js";
import {
  integrityPath,
  requireVaultCutoverLease,
  requireVaultIntegrityMarker,
  vaultCutoverLeaseCredential
} from "./_vault-integrity-marker.js";

const maximumStoredFoldersPerOwner = 5_000;
const claimPattern = /^[A-Za-z0-9_-]{43}$/u;
const importJobPattern = /^vi1_[A-Za-z0-9_-]{43}$/u;
const vaultPasteLockPattern = /^vpl1_[A-Za-z0-9_-]{43}$/u;
const vaultPasteLockTtlMilliseconds = 120_000;
const liveImportJobStatuses = Object.freeze([
  "preparing",
  "staging",
  "rolling-back",
  "blocked"
]);
const liveImportJobStatusSet = new Set(liveImportJobStatuses);
const supportedActions = new Set([
  "audit",
  "bootstrap",
  "create",
  "migrate",
  "move",
  "paste-lock-acquire",
  "paste-lock-release",
  "repair",
  "resolve-collision",
  "restore",
  "trash",
  "update"
]);

class VaultFolderTransactionConflict extends Error {
  constructor() {
    super("Vault folder transaction conflicted");
    this.name = "VaultFolderTransactionConflict";
  }
}

function transactionRetryDelay(attempt) {
  const jitterMilliseconds = 12 + Math.floor(Math.random() * 29) + attempt * 20;
  return delay(jitterMilliseconds);
}

function requirePost(request) {
  if (request.method !== "POST") {
    throw new HttpError(405, "method_not_allowed");
  }
}

function requireRequestMarker(request) {
  if (headerValue(request, "x-quickmemo-vault-folder-tree") !== "1") {
    throw new HttpError(403, "request_rejected", "Vault folder request marker is missing");
  }
}

function assertInteger(value, fieldName, minimum = 0, maximum = 999_999_999_999) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertVaultPasteLockId(value) {
  if (typeof value !== "string" || !vaultPasteLockPattern.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid Vault paste lock id");
  }
  return value;
}

function storedVaultPasteLock(folder, nowMilliseconds = Date.now()) {
  if (!folder || !Object.prototype.hasOwnProperty.call(folder, "vaultPasteLock")) {
    return null;
  }
  const lock = folder.vaultPasteLock;
  const keys = lock && typeof lock === "object" && !Array.isArray(lock)
    ? Object.keys(lock).sort()
    : [];
  const expiresAt = typeof lock?.expiresAt === "string"
    ? Date.parse(lock.expiresAt)
    : Number.NaN;
  if (
    keys.join("\u0000") !== "expiresAt\u0000id"
    || typeof lock.id !== "string"
    || !vaultPasteLockPattern.test(lock.id)
    || !Number.isFinite(expiresAt)
    || expiresAt > nowMilliseconds + vaultPasteLockTtlMilliseconds
  ) {
    throw new HttpError(
      409,
      "vault_paste_locked",
      "Vault pasted-image folder lock is invalid",
      { expose: false }
    );
  }
  return {
    active: expiresAt > nowMilliseconds,
    expiresAt,
    id: lock.id
  };
}

function assertVaultPasteFolderMutationUnlocked(folder, nowMilliseconds = Date.now()) {
  const lock = storedVaultPasteLock(folder, nowMilliseconds);
  if (lock?.active) {
    throw new HttpError(
      409,
      "vault_paste_locked",
      "Vault pasted-image folder is in use"
    );
  }
}

function assertOwnedVaultPasteFolderMutationUnlocked(folder, uid) {
  if (folder?.ownerUid === uid) {
    assertVaultPasteFolderMutationUnlocked(folder);
  }
}

function assertParentId(value) {
  if (value === null) return null;
  return assertVaultFolderId(value, "parentId");
}

function assertEncryptedPayload(value, fieldName) {
  assertOnlyKeys(value, ["algorithm", "cipherText", "iv", "version"]);
  if (
    value.version !== 1
    || value.algorithm !== "AES-GCM"
    || typeof value.cipherText !== "string"
    || value.cipherText.length < 1
    || value.cipherText.length > 2_048
    || typeof value.iv !== "string"
    || value.iv.length < 1
    || value.iv.length > 256
  ) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertWrappedKey(value) {
  assertOnlyKeys(value, ["algorithm", "version", "wrappedKey"]);
  if (
    value.version !== 1
    || value.algorithm !== "RSA-OAEP"
    || typeof value.wrappedKey !== "string"
    || value.wrappedKey.length < 1
    || value.wrappedKey.length > 4_096
  ) {
    throw new HttpError(400, "invalid_request", "Invalid wrappedKey");
  }
  return value;
}

function assertNameClaim(value, parentId) {
  assertOnlyKeys(value, ["claimId", "indexVersion", "parentId"]);
  if (
    value.indexVersion !== 1
    || typeof value.claimId !== "string"
    || !claimPattern.test(value.claimId)
    || value.parentId !== parentId
  ) {
    throw new HttpError(400, "invalid_request", "Invalid name claim");
  }
  return value;
}

function assertCommonFolderFields(body) {
  const parentId = assertParentId(body.parentId);
  if (typeof body.color !== "string" || body.color.length < 1 || body.color.length > 24) {
    throw new HttpError(400, "invalid_request", "Invalid color");
  }
  return {
    color: body.color,
    encryptedName: assertEncryptedPayload(body.encryptedName, "encryptedName"),
    nameClaim: assertNameClaim(body.nameClaim, parentId),
    order: assertInteger(body.order, "order", 0, 999_999_999),
    parentId,
    wrappedKey: assertWrappedKey(body.wrappedKey)
  };
}

function claimPath(uid, claimId) {
  return `vaultIntegrity/${uid}/nameClaims/${claimId}`;
}

function folderPath(folderId) {
  return `noteFolders/${folderId}`;
}

function treePath(uid) {
  return `vaultFolderTrees/${uid}`;
}

function importJobPath(uid, jobId) {
  return `vaultMaintenanceJobs/${uid}/imports/${jobId}`;
}

function storedImportJobId(folder) {
  if (!folder || !Object.prototype.hasOwnProperty.call(folder, "vaultImportJobId")) return null;
  if (typeof folder.vaultImportJobId !== "string" || !importJobPattern.test(folder.vaultImportJobId)) {
    throw new HttpError(409, "vault_import_invalid", "Vault import provenance is invalid", { expose: false });
  }
  return folder.vaultImportJobId;
}

function assertOwnedImportJob(job, uid, jobId) {
  if (
    !job
    || job.ownerUid !== uid
    || job.kind !== "vault-import-v1"
    || job.version !== 1
    || ![
      "preparing",
      "staging",
      "committed",
      "rolling-back",
      "rolled-back",
      "blocked"
    ].includes(job.status)
  ) {
    throw new HttpError(409, "vault_import_invalid", "Vault import job is invalid", { expose: false });
  }
  if (!importJobPattern.test(jobId)) {
    throw new HttpError(409, "vault_import_invalid", "Vault import job id is invalid", { expose: false });
  }
  return job;
}

function claimTargets(document, uid, folderId, parentId) {
  return document
    && document.ownerUid === uid
    && document.indexVersion === 1
    && document.parentId === parentId
    && document.targetId === folderId
    && document.targetType === "folder";
}

function claimFields(uid, folderId, parentId, now) {
  return {
    createdAt: now,
    indexVersion: 1,
    ownerUid: uid,
    parentId,
    targetId: folderId,
    targetType: "folder",
    updatedAt: now
  };
}

function storedClaimId(folder) {
  return typeof folder?.vaultNameClaimId === "string" && claimPattern.test(folder.vaultNameClaimId)
    ? folder.vaultNameClaimId
    : null;
}

function treeFromDocument(document, uid) {
  if (!document) return null;
  if (document.ownerUid !== uid) {
    throw new HttpError(409, "vault_tree_invalid", "Vault folder tree owner mismatch", { expose: false });
  }
  return validateVaultFolderTree({
    folderCount: document.folderCount,
    nodes: document.nodes,
    revision: document.revision,
    schemaVersion: document.schemaVersion
  });
}

function folderQuery(uid) {
  return {
    from: [{ collectionId: "noteFolders" }],
    limit: maximumStoredFoldersPerOwner + 1,
    select: {
      fields: [
        { fieldPath: "encryptedName.version" },
        { fieldPath: "isDeleted" },
        { fieldPath: "parentId" },
        { fieldPath: "vaultLineageGeneration" },
        { fieldPath: "wrappedKey.version" }
      ]
    },
    where: {
      fieldFilter: {
        field: { fieldPath: "ownerUid" },
        op: "EQUAL",
        value: { stringValue: uid }
      }
    }
  };
}

function liveImportJobQuery() {
  return {
    select: {
      fields: ["kind", "ownerUid", "status", "version"].map((fieldPath) => ({ fieldPath }))
    },
    from: [{ collectionId: "imports" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "status" },
        op: "IN",
        value: {
          arrayValue: {
            values: liveImportJobStatuses.map((status) => ({ stringValue: status }))
          }
        }
      }
    },
    limit: 1
  };
}

async function loadOwnedFoldersInTransaction(context, transaction, uid) {
  const folders = await firestoreRunQuery(context, folderQuery(uid), "", transaction);
  if (folders.length > maximumStoredFoldersPerOwner) {
    throw new HttpError(409, "vault_tree_capacity", "Stored folder count exceeds the safe migration limit");
  }
  return folders;
}

function repairTreeRevision(treeDocument) {
  const revision = treeDocument?.revision;
  if (Number.isSafeInteger(revision) && revision >= 1 && revision < 999_999_999_999) {
    return revision + 1;
  }
  if (revision === 999_999_999_999) {
    throw new HttpError(409, "vault_tree_invalid", "Vault folder tree revision is exhausted", {
      expose: false
    });
  }
  return 1;
}

function newTreeDocumentState(treeDocument, tree, allowMetadataRepair = false) {
  const createdAt = treeDocument?.createdAt
    ? new Date(treeDocument.createdAt)
    : new Date();
  if (!Number.isFinite(createdAt.getTime())) {
    if (!allowMetadataRepair) {
      throw new HttpError(409, "vault_tree_invalid", "Vault tree timestamp is invalid", {
        expose: false
      });
    }
    return { createdAt: new Date(), tree, updateTime: treeDocument?.__updateTime ?? "" };
  }
  return { createdAt, tree, updateTime: treeDocument?.__updateTime ?? "" };
}

function folderLineage(tree, folderId) {
  const ancestors = vaultFolderAncestors(tree, folderId);
  return {
    vaultAncestorIds: ancestors,
    vaultLineageDepth: ancestors.length,
    vaultLineageGeneration: tree.nodes[folderId].generation,
    vaultLineagePath: [...ancestors, folderId].join("/"),
    vaultLineageVersion: 3
  };
}

function folderCreateFields(uid, folderId, input, tree, now, importJobId) {
  return {
    color: input.color,
    createdAt: now,
    encryptedName: input.encryptedName,
    isDeleted: false,
    name: "암호화 폴더",
    order: input.order,
    ownerUid: uid,
    parentId: input.parentId,
    revision: 1,
    updatedAt: now,
    vaultNameClaimId: input.nameClaim.claimId,
    vaultNameIndexVersion: 1,
    wrappedKey: input.wrappedKey,
    ...folderLineage(tree, folderId),
    ...(importJobId ? { vaultImportJobId: importJobId } : {})
  };
}

function encryptedPayloadMatches(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 4
    && value.algorithm === expected.algorithm
    && value.cipherText === expected.cipherText
    && value.iv === expected.iv
    && value.version === expected.version;
}

function wrappedKeyMatches(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.algorithm === expected.algorithm
    && value.version === expected.version
    && value.wrappedKey === expected.wrappedKey;
}

function folderLineageMatches(folder, tree, folderId) {
  const expected = folderLineage(tree, folderId);
  return Array.isArray(folder.vaultAncestorIds)
    && folder.vaultAncestorIds.length === expected.vaultAncestorIds.length
    && folder.vaultAncestorIds.every((ancestorId, index) => ancestorId === expected.vaultAncestorIds[index])
    && folder.vaultLineageDepth === expected.vaultLineageDepth
    && folder.vaultLineageGeneration === expected.vaultLineageGeneration
    && folder.vaultLineagePath === expected.vaultLineagePath
    && folder.vaultLineageVersion === expected.vaultLineageVersion;
}

function folderCreateAfterStateMatches(folder, uid, folderId, input, tree, importJobId = "") {
  const node = tree.nodes[folderId];
  return folder
    && folder.ownerUid === uid
    && folder.revision === 1
    && folder.isDeleted === false
    && folder.name === "암호화 폴더"
    && folder.color === input.color
    && folder.order === input.order
    && (folder.parentId ?? null) === input.parentId
    && folder.vaultNameClaimId === input.nameClaim.claimId
    && folder.vaultNameIndexVersion === input.nameClaim.indexVersion
    && (folder.vaultImportJobId ?? "") === importJobId
    && encryptedPayloadMatches(folder.encryptedName, input.encryptedName)
    && wrappedKeyMatches(folder.wrappedKey, input.wrappedKey)
    && node?.active === true
    && node.selfActive === true
    && node.parentId === input.parentId
    && folderLineageMatches(folder, tree, folderId);
}

function assertOwnedEncryptedFolder(folder, uid, folderId, expectedRevision, allowMissingClaim = false) {
  if (!folder || folder.ownerUid !== uid || !folder.encryptedName || !folder.wrappedKey) {
    throw new HttpError(404, "vault_folder_not_found", "Vault folder was not found");
  }
  const revision = assertInteger(folder.revision, "stored revision", 1);
  if (revision !== expectedRevision) {
    throw new HttpError(409, "revision_conflict", "Vault folder revision changed");
  }
  if (revision >= 999_999_999_999) {
    throw new HttpError(409, "vault_folder_revision_exhausted", "Vault folder revision exhausted");
  }
  const claimId = storedClaimId(folder);
  const claimMetadataAbsent = !Object.prototype.hasOwnProperty.call(folder, "vaultNameClaimId")
    && !Object.prototype.hasOwnProperty.call(folder, "vaultNameIndexVersion");
  if (
    !folderId
    || (claimId ? folder.vaultNameIndexVersion !== 1 : !(allowMissingClaim && claimMetadataAbsent))
  ) {
    throw new HttpError(409, "vault_folder_invalid", "Vault folder metadata is invalid", { expose: false });
  }
  return revision;
}

function assertFolderMatchesTree(folder, tree, folderId) {
  const node = tree.nodes[folderId];
  if (!node || node.parentId !== (folder.parentId ?? null) || node.selfActive !== (folder.isDeleted !== true)) {
    throw new HttpError(409, "vault_tree_stale", "Vault folder tree needs repair");
  }
  return node;
}

async function transactionState(context, uid, action, body) {
  const folderId = body.folderId ? assertVaultFolderId(body.folderId) : null;
  const parentId = Object.prototype.hasOwnProperty.call(body, "parentId")
    ? assertParentId(body.parentId)
    : null;
  const claimId = body.nameClaim?.claimId;
  const paths = [treePath(uid), integrityPath(uid)];
  if (folderId) paths.push(folderPath(folderId));
  if (typeof claimId === "string" && claimPattern.test(claimId)) paths.push(claimPath(uid, claimId));
  const { documents, transaction } = await firestoreBatchGetNewTransaction(context, paths);
  try {
    let offset = 0;
    const treeDocument = documents[offset++];
    const integrityMarker = documents[offset++];
    const folder = folderId ? documents[offset++] : null;
    const requestedClaim = typeof claimId === "string" && claimPattern.test(claimId)
      ? documents[offset++]
      : null;
    let tree = null;
    let treeDocumentValid = false;
    try {
      tree = treeFromDocument(treeDocument, uid);
      treeDocumentValid = Boolean(treeDocument);
    } catch (error) {
      const maintenanceRepair = action === "audit" || action === "bootstrap" || action === "repair";
      const repairableTreeError = error?.code === "vault_tree_invalid"
        || error?.code === "vault_depth_exceeded";
      if (
        !treeDocument
        || treeDocument.ownerUid !== uid
        || !repairableTreeError
      ) {
        throw error;
      }
      if (!maintenanceRepair) {
        throw new HttpError(
          409,
          "vault_tree_repair_required",
          "Vault folder tree must be repaired before this mutation"
        );
      }
      // A same-owner malformed tree can be reconstructed from the authoritative
      // encrypted folder documents. Owner mismatches always fail closed above.
    }
    if (treeDocumentValid && treeDocument?.createdAt) {
      const storedCreatedAt = new Date(treeDocument.createdAt);
      if (!Number.isFinite(storedCreatedAt.getTime())) {
        const maintenanceRepair = action === "audit" || action === "bootstrap" || action === "repair";
        if (!maintenanceRepair) {
          throw new HttpError(
            409,
            "vault_tree_repair_required",
            "Vault folder tree must be repaired before this mutation"
          );
        }
        tree = null;
        treeDocumentValid = false;
      }
    }
    let ownedFolders = null;
    if (!tree) {
      ownedFolders = await loadOwnedFoldersInTransaction(context, transaction, uid);
      tree = buildVaultFolderTree(
        ownedFolders,
        treeDocument ? repairTreeRevision(treeDocument) : 1
      );
    }
    return {
      action,
      folder,
      folderId,
      liveImportJob: null,
      liveImportJobLoaded: false,
      importJobs: new Map(),
      integrityMarker,
      ownedFolders,
      parentId,
      requestedClaim,
      transaction,
      treeDocument,
      treeDocumentValid,
      treeState: newTreeDocumentState(treeDocument, tree, Boolean(treeDocument && !treeDocumentValid))
    };
  } catch (error) {
    try {
      await firestoreRollback(context, transaction);
    } catch {
      // The original validation/read failure is authoritative.
    }
    throw error;
  }
}

async function readPreviousClaim(context, state, uid, nextClaimId = "") {
  const previousClaimId = storedClaimId(state.folder);
  if (!previousClaimId || previousClaimId === nextClaimId) return null;
  const [claim] = await firestoreBatchGet(
    context,
    [claimPath(uid, previousClaimId)],
    state.transaction
  );
  if (claim && !claimTargets(claim, uid, state.folderId, state.folder.parentId ?? null)) {
    throw new HttpError(409, "vault_claim_invalid", "Stored Vault claim does not match", { expose: false });
  }
  return claim;
}

async function readImportJob(context, state, uid, jobId) {
  if (state.importJobs.has(jobId)) return state.importJobs.get(jobId);
  const [job] = await firestoreBatchGet(
    context,
    [importJobPath(uid, jobId)],
    state.transaction
  );
  const value = job ?? null;
  state.importJobs.set(jobId, value);
  return value;
}

async function readLiveImportJob(context, state, uid) {
  if (state.liveImportJobLoaded) return state.liveImportJob;
  const jobs = await firestoreRunQuery(
    context,
    liveImportJobQuery(),
    `vaultMaintenanceJobs/${uid}`,
    state.transaction
  );
  if (jobs.length > 1) {
    throw new HttpError(409, "vault_import_invalid", "Vault import query exceeded its safe bound", { expose: false });
  }
  const job = jobs[0] ?? null;
  if (job) {
    assertOwnedImportJob(job, uid, job.__id);
    if (!liveImportJobStatusSet.has(job.status)) {
      throw new HttpError(409, "vault_import_invalid", "Vault import job state is invalid", { expose: false });
    }
  }
  state.liveImportJob = job;
  state.liveImportJobLoaded = true;
  return job;
}

async function readOwnedParentFolder(context, state, uid, parentId) {
  if (parentId === null) return null;
  if (state.folderId === parentId && state.folder) return state.folder;
  const [parent] = await firestoreBatchGet(
    context,
    [folderPath(parentId)],
    state.transaction
  );
  if (!parent || parent.ownerUid !== uid || parent.isDeleted === true) {
    throw new HttpError(409, "vault_parent_unavailable", "Vault parent folder is unavailable");
  }
  return parent;
}

async function assertImportedCreateAllowed(context, state, uid, importJobId) {
  if (!importJobId) return;
  const job = assertOwnedImportJob(
    await readImportJob(context, state, uid, importJobId),
    uid,
    importJobId
  );
  if (job.status !== "staging") {
    throw new HttpError(409, "vault_import_locked", "Vault import is not accepting new targets");
  }
}

async function assertImportParentPlacementAllowed(
  context,
  state,
  uid,
  parentId,
  targetImportJobId = null
) {
  if (parentId === null) return;
  const parent = await readOwnedParentFolder(context, state, uid, parentId);
  const parentImportJobId = storedImportJobId(parent);
  if (!parentImportJobId) return;
  const storedJob = await readImportJob(context, state, uid, parentImportJobId);
  if (!storedJob) return;
  const job = assertOwnedImportJob(storedJob, uid, parentImportJobId);
  if (job.status === "committed") return;
  if (job.status === "staging" && targetImportJobId === parentImportJobId) return;
  throw new HttpError(409, "vault_import_locked", "Vault import parent is locked");
}

async function assertImportSourceMutationAllowed(context, state, uid, action) {
  const sourceImportJobId = storedImportJobId(state.folder);
  if (!sourceImportJobId) return { importJobId: null, rollbackTrash: false };
  const storedJob = await readImportJob(context, state, uid, sourceImportJobId);
  if (!storedJob) return { importJobId: sourceImportJobId, rollbackTrash: false };
  const job = assertOwnedImportJob(storedJob, uid, sourceImportJobId);
  if (job.status === "committed") {
    return { importJobId: sourceImportJobId, rollbackTrash: false };
  }
  if (action === "trash" && job.status === "rolling-back") {
    return { importJobId: sourceImportJobId, rollbackTrash: true };
  }
  throw new HttpError(409, "vault_import_locked", "Vault import target is locked");
}

async function assertWorkspaceImportMutationAllowed(context, state, uid, sourceImportState) {
  if (sourceImportState.rollbackTrash) return;
  if (await readLiveImportJob(context, state, uid)) {
    throw new HttpError(
      409,
      "vault_import_locked",
      "Vault import or recovery is locking existing folder changes"
    );
  }
}

function treeWrite(context, uid, state, tree, now) {
  return vaultFolderTreeDocumentWrite(context.projectId, uid, tree, {
    createdAt: state.treeState.createdAt,
    updatedAt: now,
    updateTime: state.treeState.updateTime
  });
}

async function commitOrConflict(context, writes, transaction) {
  try {
    return await firestoreCommit(context, writes, transaction);
  } catch (error) {
    if (error?.statusCode === 409 || error?.upstreamCode === "ABORTED") {
      throw new VaultFolderTransactionConflict();
    }
    throw error;
  }
}

async function handleBootstrapOrAudit(context, uid, state, action) {
  const tree = state.treeState.tree;
  if (action === "bootstrap" && state.treeDocumentValid) {
    await firestoreRollback(context, state.transaction);
    return {
      folderCount: tree.folderCount,
      revision: tree.revision,
      schemaVersion: tree.schemaVersion,
      status: "ready"
    };
  }
  const folders = state.ownedFolders ?? await loadOwnedFoldersInTransaction(
    context,
    state.transaction,
    uid
  );
  const matches = state.treeDocumentValid
    ? vaultFolderTreeMatchesFolders(tree, folders)
    : false;
  if (action === "audit") {
    await firestoreRollback(context, state.transaction);
    return {
      folderCount: tree.folderCount,
      matches,
      revision: tree.revision,
      schemaVersion: tree.schemaVersion,
      status: !state.treeDocument ? "missing" : matches ? "ok" : "stale"
    };
  }
  if (state.treeDocumentValid && matches) {
    await firestoreRollback(context, state.transaction);
    return {
      folderCount: tree.folderCount,
      revision: tree.revision,
      schemaVersion: tree.schemaVersion,
      status: "ready"
    };
  }
  const repairedTree = state.treeDocumentValid
    ? buildVaultFolderTree(folders, tree.revision + 1)
    : tree;
  const now = new Date();
  await commitOrConflict(
    context,
    [treeWrite(context, uid, state, repairedTree, now)],
    state.transaction
  );
  return {
    folderCount: repairedTree.folderCount,
    revision: repairedTree.revision,
    schemaVersion: repairedTree.schemaVersion,
    status: "created"
  };
}

async function handleCreate(context, uid, state, body) {
  assertOnlyKeys(body, ["action", "color", "encryptedName", "folderId", "importJobId", "nameClaim", "order", "parentId", "wrappedKey"]);
  const input = assertCommonFolderFields(body);
  const folderId = assertVaultFolderId(body.folderId);
  const importJobId = body.importJobId === undefined
    ? ""
    : typeof body.importJobId === "string" && importJobPattern.test(body.importJobId)
      ? body.importJobId
      : (() => { throw new HttpError(400, "invalid_request", "Invalid importJobId"); })();
  if (state.folder) {
    if (
      folderCreateAfterStateMatches(
        state.folder,
        uid,
        folderId,
        input,
        state.treeState.tree,
        importJobId
      )
      && claimTargets(state.requestedClaim, uid, folderId, input.parentId)
    ) {
      await firestoreRollback(context, state.transaction);
      return { folderId, revision: 1, treeRevision: state.treeState.tree.revision };
    }
    throw new HttpError(409, "vault_folder_conflict", "Vault folder id already exists");
  }
  if (state.requestedClaim) {
    throw new HttpError(409, "vault_name_conflict", "Vault folder name is already reserved");
  }
  await assertImportedCreateAllowed(context, state, uid, importJobId);
  await assertImportParentPlacementAllowed(
    context,
    state,
    uid,
    input.parentId,
    importJobId || null
  );
  const tree = createVaultFolderNode(state.treeState.tree, { folderId, parentId: input.parentId });
  const now = new Date();
  const folderFields = folderCreateFields(uid, folderId, input, tree, now, importJobId);
  const writes = [
    treeWrite(context, uid, state, tree, now),
    createDocumentWrite(context.projectId, folderPath(folderId), folderFields),
    createDocumentWrite(
      context.projectId,
      claimPath(uid, input.nameClaim.claimId),
      claimFields(uid, folderId, input.parentId, now)
    )
  ];
  writes.push(...await prepareVaultInventoryManifestMutation(
    context,
    state.transaction,
    {
      uid,
      kind: "folder",
      id: folderId,
      currentDocument: null,
      nextDocument: folderFields,
      now
    }
  ));
  await commitOrConflict(context, writes, state.transaction);
  return { folderId, revision: 1, treeRevision: tree.revision };
}

async function handleUpdateOrMove(context, uid, state, body, allowMissingClaim = false) {
  assertOnlyKeys(body, [
    "action", "encryptedName", "expectedRevision", "folderId", "leaseGeneration", "leaseId",
    "nameClaim", "order", "parentId", "pathRewriteActivation"
  ]);
  const expectedRevision = assertInteger(body.expectedRevision, "expectedRevision", 1);
  const folderId = assertVaultFolderId(body.folderId);
  assertOwnedVaultPasteFolderMutationUnlocked(state.folder, uid);
  const revision = assertOwnedEncryptedFolder(
    state.folder,
    uid,
    folderId,
    expectedRevision,
    allowMissingClaim
  );
  if (state.folder.isDeleted === true) {
    throw new HttpError(409, "vault_folder_unavailable", "Restore the folder before changing it");
  }
  assertFolderMatchesTree(state.folder, state.treeState.tree, folderId);
  const sourceImportState = await assertImportSourceMutationAllowed(
    context,
    state,
    uid,
    body.action
  );
  await assertWorkspaceImportMutationAllowed(context, state, uid, sourceImportState);
  const parentId = body.parentId === undefined ? state.folder.parentId ?? null : assertParentId(body.parentId);
  await assertImportParentPlacementAllowed(
    context,
    state,
    uid,
    parentId,
    sourceImportState.importJobId
  );
  const nameClaim = assertNameClaim(body.nameClaim, parentId);
  if (body.encryptedName !== undefined) assertEncryptedPayload(body.encryptedName, "encryptedName");
  if (body.order !== undefined) assertInteger(body.order, "order", 0, 999_999_999);
  if (state.requestedClaim && !claimTargets(state.requestedClaim, uid, folderId, parentId)) {
    throw new HttpError(409, "vault_name_conflict", "Vault folder name is already reserved");
  }
  const previousClaim = await readPreviousClaim(context, state, uid, nameClaim.claimId);
  let tree = state.treeState.tree;
  const moved = parentId !== (state.folder.parentId ?? null);
  if (moved) tree = moveVaultFolderNode(tree, { folderId, parentId });
  const currentClaimId = storedClaimId(state.folder);
  const pathIdentityChanged = Boolean(currentClaimId)
    && (moved || currentClaimId !== nameClaim.claimId);
  if (!allowMissingClaim && pathIdentityChanged && body.pathRewriteActivation === undefined) {
    throw new HttpError(
      409,
      "vault_path_rewrite_required",
      "A prepared path rewrite is required before changing the Vault path"
    );
  }
  if (!allowMissingClaim && !pathIdentityChanged && body.pathRewriteActivation !== undefined) {
    throw new HttpError(400, "invalid_request", "Path rewrite activation requires a path change");
  }
  const now = new Date();
  const fields = {
    revision: revision + 1,
    updatedAt: now,
    vaultNameClaimId: nameClaim.claimId,
    vaultNameIndexVersion: 1,
    ...folderLineage(tree, folderId),
    ...(body.encryptedName === undefined ? {} : { encryptedName: body.encryptedName }),
    ...(body.order === undefined ? {} : { order: body.order }),
    ...(body.parentId === undefined ? {} : { parentId })
  };
  const writes = [];
  if (moved || !state.treeDocument) {
    writes.push(treeWrite(context, uid, state, tree, now));
  }
  writes.push(updateDocumentWrite(
    context.projectId,
    folderPath(folderId),
    fields,
    Object.keys(fields),
    state.folder.__updateTime
  ));
  if (!state.requestedClaim) {
    writes.push(createDocumentWrite(
      context.projectId,
      claimPath(uid, nameClaim.claimId),
      claimFields(uid, folderId, parentId, now)
    ));
  }
  if (previousClaim) {
    writes.push(deleteDocumentWrite(
      context.projectId,
      claimPath(uid, previousClaim.__id),
      previousClaim.__updateTime
    ));
  }
  const pathRewriteActivationWrites = await prepareAtomicPathRewriteActivation(
    context,
    state.transaction,
    uid,
    body.pathRewriteActivation,
    {
      expectedRevision,
      id: folderId,
      kind: "folder",
      currentDocument: state.folder,
      nextDocument: nextVaultInventoryDocument(state.folder, fields)
    },
    now
  );
  writes.push(
    ...pathRewriteActivationWrites,
    ...await prepareVaultInventoryManifestMutation(
      context,
      state.transaction,
      {
        uid,
        kind: "folder",
        id: folderId,
        currentDocument: state.folder,
        nextDocument: nextVaultInventoryDocument(state.folder, fields),
        now
      }
    )
  );
  await commitOrConflict(context, writes, state.transaction);
  return { folderId, revision: revision + 1, treeRevision: tree.revision };
}

async function handleResolveCollision(context, uid, state, body) {
  const folderId = assertVaultFolderId(body.folderId);
  const folder = state.folder;
  if (!folder || folder.ownerUid !== uid) {
    throw new HttpError(404, "vault_folder_not_found", "Vault folder was not found");
  }
  assertVaultPasteFolderMutationUnlocked(folder);
  const hasEncryptedName = Boolean(folder.encryptedName);
  const hasWrappedKey = Boolean(folder.wrappedKey);
  if (hasEncryptedName !== hasWrappedKey) {
    throw new HttpError(409, "vault_folder_state_mismatch", "Vault folder encryption state is incomplete");
  }
  if (!hasEncryptedName) {
    assertOnlyKeys(body, [
      "action", "color", "encryptedName", "expectedName", "folderId", "nameClaim", "order",
      "parentId", "wrappedKey"
    ]);
    const input = assertCommonFolderFields(body);
    if (typeof body.expectedName !== "string" || body.expectedName.length < 1 || body.expectedName.length > 40) {
      throw new HttpError(400, "invalid_request", "Invalid expectedName");
    }
    if (folder.name !== body.expectedName) {
      throw new HttpError(409, "revision_conflict", "Legacy folder changed before collision recovery");
    }
    if (
      folder.isDeleted === true
      || Object.prototype.hasOwnProperty.call(folder, "vaultNameClaimId")
      || Object.prototype.hasOwnProperty.call(folder, "vaultNameIndexVersion")
    ) {
      throw new HttpError(409, "vault_folder_state_mismatch", "Legacy folder collision cannot be resolved");
    }
    const sourceImportState = await assertImportSourceMutationAllowed(
      context,
      state,
      uid,
      "resolve-collision"
    );
    await assertWorkspaceImportMutationAllowed(context, state, uid, sourceImportState);
    await assertImportParentPlacementAllowed(
      context,
      state,
      uid,
      input.parentId,
      sourceImportState.importJobId
    );
    if (state.requestedClaim) {
      throw new HttpError(409, "vault_name_conflict", "Vault folder name is already reserved");
    }
    const tree = createVaultFolderNode(state.treeState.tree, { folderId, parentId: input.parentId });
    const now = new Date();
    const fields = {
      encryptedName: input.encryptedName,
      isDeleted: false,
      name: "암호화 폴더",
      order: input.order,
      parentId: input.parentId,
      revision: 1,
      updatedAt: now,
      vaultNameClaimId: input.nameClaim.claimId,
      vaultNameIndexVersion: 1,
      wrappedKey: input.wrappedKey,
      ...folderLineage(tree, folderId)
    };
    const writes = [
      treeWrite(context, uid, state, tree, now),
      updateDocumentWrite(
        context.projectId,
        folderPath(folderId),
        fields,
        Object.keys(fields),
        folder.__updateTime
      ),
      createDocumentWrite(
        context.projectId,
        claimPath(uid, input.nameClaim.claimId),
        claimFields(uid, folderId, input.parentId, now)
      )
    ];
    writes.push(...await prepareVaultInventoryManifestMutation(
      context,
      state.transaction,
      {
        uid,
        kind: "folder",
        id: folderId,
        currentDocument: folder,
        nextDocument: nextVaultInventoryDocument(folder, fields),
        now
      }
    ));
    await commitOrConflict(context, writes, state.transaction);
    return { folderId, revision: 1, treeRevision: tree.revision };
  }
  assertOnlyKeys(body, [
    "action", "encryptedName", "expectedRevision", "folderId", "leaseGeneration", "leaseId",
    "nameClaim", "parentId", "pathRewriteActivation"
  ]);
  const revision = assertInteger(folder.revision, "stored revision", 1);
  const expectedRevision = assertInteger(body.expectedRevision, "expectedRevision", 1);
  if (revision !== expectedRevision) {
    throw new HttpError(409, "revision_conflict", "Vault folder revision changed");
  }
  if (revision >= 999_999_999_999) {
    throw new HttpError(409, "vault_folder_revision_exhausted", "Vault folder revision exhausted");
  }
  if (
    folder.isDeleted === true
    || Object.prototype.hasOwnProperty.call(folder, "vaultNameClaimId")
    || Object.prototype.hasOwnProperty.call(folder, "vaultNameIndexVersion")
  ) {
    throw new HttpError(409, "vault_folder_state_mismatch", "Vault folder collision cannot be resolved");
  }
  assertFolderMatchesTree(folder, state.treeState.tree, folderId);
  const sourceImportState = await assertImportSourceMutationAllowed(
    context,
    state,
    uid,
    "resolve-collision"
  );
  await assertWorkspaceImportMutationAllowed(context, state, uid, sourceImportState);
  const parentId = body.parentId === undefined
    ? folder.parentId ?? null
    : assertParentId(body.parentId);
  await assertImportParentPlacementAllowed(
    context,
    state,
    uid,
    parentId,
    sourceImportState.importJobId
  );
  const nameClaim = assertNameClaim(body.nameClaim, parentId);
  const encryptedName = body.encryptedName === undefined
    ? undefined
    : assertEncryptedPayload(body.encryptedName, "encryptedName");
  const moved = parentId !== (folder.parentId ?? null);
  const renamed = encryptedName !== undefined
    && !encryptedPayloadMatches(folder.encryptedName, encryptedName);
  if (!moved && !renamed) {
    throw new HttpError(400, "invalid_request", "Collision recovery must change the folder name or parent");
  }
  if (state.requestedClaim) {
    throw new HttpError(409, "vault_name_conflict", "Vault folder name is already reserved");
  }

  let tree = state.treeState.tree;
  if (moved) tree = moveVaultFolderNode(tree, { folderId, parentId });
  const now = new Date();
  const fields = {
    revision: revision + 1,
    updatedAt: now,
    vaultNameClaimId: nameClaim.claimId,
    vaultNameIndexVersion: 1,
    ...folderLineage(tree, folderId),
    ...(encryptedName === undefined ? {} : { encryptedName }),
    ...(body.parentId === undefined ? {} : { parentId })
  };
  const writes = [];
  if (moved || !state.treeDocument) {
    writes.push(treeWrite(context, uid, state, tree, now));
  }
  writes.push(
    updateDocumentWrite(
      context.projectId,
      folderPath(folderId),
      fields,
      Object.keys(fields),
      folder.__updateTime
    ),
    createDocumentWrite(
      context.projectId,
      claimPath(uid, nameClaim.claimId),
      claimFields(uid, folderId, parentId, now)
    )
  );
  const pathRewriteActivationWrites = await prepareAtomicPathRewriteActivation(
    context,
    state.transaction,
    uid,
    body.pathRewriteActivation,
    {
      expectedRevision,
      id: folderId,
      kind: "folder",
      currentDocument: folder,
      nextDocument: nextVaultInventoryDocument(folder, fields)
    },
    now
  );
  writes.push(
    ...pathRewriteActivationWrites,
    ...await prepareVaultInventoryManifestMutation(
      context,
      state.transaction,
      {
        uid,
        kind: "folder",
        id: folderId,
        currentDocument: folder,
        nextDocument: nextVaultInventoryDocument(folder, fields),
        now
      }
    )
  );
  await commitOrConflict(context, writes, state.transaction);
  return { folderId, revision: revision + 1, treeRevision: tree.revision };
}

async function handleLifecycle(context, uid, state, body, active) {
  assertOnlyKeys(body, ["action", "expectedRevision", "folderId"]);
  const folderId = assertVaultFolderId(body.folderId);
  const expectedRevision = assertInteger(body.expectedRevision, "expectedRevision", 1);
  assertOwnedVaultPasteFolderMutationUnlocked(state.folder, uid);
  const revision = assertOwnedEncryptedFolder(state.folder, uid, folderId, expectedRevision);
  assertFolderMatchesTree(state.folder, state.treeState.tree, folderId);
  const sourceImportState = await assertImportSourceMutationAllowed(
    context,
    state,
    uid,
    active ? "restore" : "trash"
  );
  await assertWorkspaceImportMutationAllowed(context, state, uid, sourceImportState);
  if (active) {
    await assertImportParentPlacementAllowed(
      context,
      state,
      uid,
      state.folder.parentId ?? null,
      sourceImportState.importJobId
    );
  }
  const claimId = storedClaimId(state.folder);
  const parentId = state.folder.parentId ?? null;
  const [claim] = await firestoreBatchGet(context, [claimPath(uid, claimId)], state.transaction);
  if (!active && !claimTargets(claim, uid, folderId, parentId)) {
    throw new HttpError(409, "vault_claim_invalid", "Vault folder claim is missing", { expose: false });
  }
  if (active && claim && !claimTargets(claim, uid, folderId, parentId)) {
    throw new HttpError(409, "vault_name_conflict", "Vault folder name is already reserved");
  }
  const tree = setVaultFolderLifecycle(state.treeState.tree, { folderId, active });
  const now = new Date();
  const fields = {
    isDeleted: !active,
    revision: revision + 1,
    updatedAt: now,
    ...folderLineage(tree, folderId),
    ...(active ? {} : { deletedAt: now, deletedBy: uid })
  };
  const fieldPaths = Object.keys(fields);
  if (active) {
    // A REST update mask deletes omitted fields, so include lifecycle fields in
    // the mask while intentionally leaving them out of the document fields.
    fieldPaths.push("deletedAt", "deletedBy");
  }
  const writes = [
    treeWrite(context, uid, state, tree, now),
    updateDocumentWrite(
      context.projectId,
      folderPath(folderId),
      fields,
      fieldPaths,
      state.folder.__updateTime
    )
  ];
  if (active && !claim) {
    writes.push(createDocumentWrite(
      context.projectId,
      claimPath(uid, claimId),
      claimFields(uid, folderId, parentId, now)
    ));
  } else if (!active) {
    writes.push(deleteDocumentWrite(context.projectId, claimPath(uid, claimId), claim.__updateTime));
  }
  writes.push(...await prepareVaultInventoryManifestMutation(
    context,
    state.transaction,
    {
      uid,
      kind: "folder",
      id: folderId,
      currentDocument: state.folder,
      nextDocument: nextVaultInventoryDocument(
        state.folder,
        fields,
        active ? ["deletedAt", "deletedBy"] : []
      ),
      now
    }
  ));
  await commitOrConflict(context, writes, state.transaction);
  return { folderId, revision: revision + 1, treeRevision: tree.revision };
}

async function handleMigrate(context, uid, state, body) {
  assertOnlyKeys(body, [
    "action", "color", "encryptedName", "expectedName", "folderId", "leaseGeneration", "leaseId",
    "nameClaim", "order", "parentId", "wrappedKey"
  ]);
  const input = assertCommonFolderFields(body);
  const folderId = assertVaultFolderId(body.folderId);
  if (typeof body.expectedName !== "string" || body.expectedName.length < 1 || body.expectedName.length > 40) {
    throw new HttpError(400, "invalid_request", "Invalid expectedName");
  }
  if (!state.folder || state.folder.ownerUid !== uid) {
    throw new HttpError(404, "vault_folder_not_found", "Vault folder was not found");
  }
  assertVaultPasteFolderMutationUnlocked(state.folder);
  if (state.folder.encryptedName || state.folder.wrappedKey) {
    if (
      folderCreateAfterStateMatches(
        state.folder,
        uid,
        folderId,
        input,
        state.treeState.tree
      )
      && claimTargets(state.requestedClaim, uid, folderId, input.parentId)
    ) {
      await firestoreRollback(context, state.transaction);
      return { folderId, revision: 1, treeRevision: state.treeState.tree.revision };
    }
    throw new HttpError(409, "revision_conflict", "Legacy folder changed before migration");
  }
  if (state.folder.name !== body.expectedName) {
    throw new HttpError(409, "revision_conflict", "Legacy folder changed before migration");
  }
  if (state.folder.isDeleted === true) {
    throw new HttpError(409, "vault_folder_unavailable", "Restore the folder before migration");
  }
  if (state.requestedClaim) {
    throw new HttpError(409, "vault_name_conflict", "Vault folder name is already reserved");
  }
  const sourceImportState = await assertImportSourceMutationAllowed(
    context,
    state,
    uid,
    "migrate"
  );
  await assertWorkspaceImportMutationAllowed(context, state, uid, sourceImportState);
  await assertImportParentPlacementAllowed(
    context,
    state,
    uid,
    input.parentId,
    sourceImportState.importJobId
  );
  const tree = createVaultFolderNode(state.treeState.tree, { folderId, parentId: input.parentId });
  const now = new Date();
  const fields = {
    encryptedName: input.encryptedName,
    isDeleted: false,
    name: "암호화 폴더",
    order: input.order,
    parentId: input.parentId,
    revision: 1,
    updatedAt: now,
    vaultNameClaimId: input.nameClaim.claimId,
    vaultNameIndexVersion: 1,
    wrappedKey: input.wrappedKey,
    ...folderLineage(tree, folderId)
  };
  const writes = [
    treeWrite(context, uid, state, tree, now),
    updateDocumentWrite(
      context.projectId,
      folderPath(folderId),
      fields,
      Object.keys(fields),
      state.folder.__updateTime
    ),
    createDocumentWrite(
      context.projectId,
      claimPath(uid, input.nameClaim.claimId),
      claimFields(uid, folderId, input.parentId, now)
    )
  ];
  writes.push(...await prepareVaultInventoryManifestMutation(
    context,
    state.transaction,
    {
      uid,
      kind: "folder",
      id: folderId,
      currentDocument: state.folder,
      nextDocument: nextVaultInventoryDocument(state.folder, fields),
      now
    }
  ));
  await commitOrConflict(context, writes, state.transaction);
  return { folderId, revision: 1, treeRevision: tree.revision };
}

function assertOwnedEncryptedPasteLockFolder(folder, uid, folderId) {
  if (!folder || folder.ownerUid !== uid || !folder.encryptedName || !folder.wrappedKey) {
    throw new HttpError(404, "vault_folder_not_found", "Vault folder was not found");
  }
  const revision = assertInteger(folder.revision, "stored revision", 1);
  const claimId = storedClaimId(folder);
  if (
    !folderId
    || !claimId
    || folder.vaultNameIndexVersion !== 1
  ) {
    throw new HttpError(409, "vault_folder_invalid", "Vault folder metadata is invalid", {
      expose: false
    });
  }
  return revision;
}

function pasteLockResult(state, folderId, revision) {
  return {
    folderId,
    revision,
    treeRevision: state.treeState.tree.revision
  };
}

async function handlePasteLockAcquire(context, uid, state, body) {
  assertOnlyKeys(body, ["action", "expectedRevision", "folderId", "lockId"]);
  const folderId = assertVaultFolderId(body.folderId);
  const lockId = assertVaultPasteLockId(body.lockId);
  const expectedRevision = assertInteger(body.expectedRevision, "expectedRevision", 1);
  const revision = assertOwnedEncryptedPasteLockFolder(state.folder, uid, folderId);
  if (revision !== expectedRevision) {
    throw new HttpError(409, "revision_conflict", "Vault folder revision changed");
  }
  const node = assertFolderMatchesTree(state.folder, state.treeState.tree, folderId);
  if (
    state.folder.isDeleted === true
    || (state.folder.parentId ?? null) !== null
    || node.active !== true
    || node.selfActive !== true
  ) {
    throw new HttpError(
      409,
      "vault_folder_unavailable",
      "Only an active root Vault folder can be locked for pasted images"
    );
  }

  const now = new Date();
  const existing = storedVaultPasteLock(state.folder, now.getTime());
  if (existing?.active && existing.id !== lockId) {
    throw new HttpError(409, "vault_paste_locked", "Vault pasted-image folder is in use");
  }

  await commitOrConflict(context, [updateDocumentWrite(
    context.projectId,
    folderPath(folderId),
    {
      vaultPasteLock: {
        expiresAt: new Date(now.getTime() + vaultPasteLockTtlMilliseconds),
        id: lockId
      }
    },
    ["vaultPasteLock"],
    state.folder.__updateTime
  )], state.transaction);
  return pasteLockResult(state, folderId, revision);
}

async function handlePasteLockRelease(context, uid, state, body) {
  assertOnlyKeys(body, ["action", "folderId", "lockId"]);
  const folderId = assertVaultFolderId(body.folderId);
  const lockId = assertVaultPasteLockId(body.lockId);
  const revision = assertOwnedEncryptedPasteLockFolder(state.folder, uid, folderId);
  const existing = storedVaultPasteLock(state.folder);
  if (!existing || existing.id !== lockId) {
    await firestoreRollback(context, state.transaction);
    return pasteLockResult(state, folderId, revision);
  }
  await commitOrConflict(context, [updateDocumentWrite(
    context.projectId,
    folderPath(folderId),
    {},
    ["vaultPasteLock"],
    state.folder.__updateTime
  )], state.transaction);
  return pasteLockResult(state, folderId, revision);
}

async function performActionOnce(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "color", "encryptedName", "expectedName", "expectedRevision", "folderId",
    "importJobId", "leaseGeneration", "leaseId", "lockId", "nameClaim", "order", "parentId",
    "pathRewriteActivation", "wrappedKey"
  ]);
  const action = body.action;
  if (typeof action !== "string" || !supportedActions.has(action)) {
    throw new HttpError(400, "invalid_request", "Invalid Vault folder action");
  }
  const state = await transactionState(context, uid, action, body);
  try {
    if (action === "audit" || action === "bootstrap" || action === "repair") {
      return await handleBootstrapOrAudit(context, uid, state, action);
    }
    const integrityRequirement = action === "resolve-collision"
      ? "pending"
      : ["migrate", "move", "paste-lock-release", "update"].includes(action)
        ? "any"
        : "ready";
    const integrityMarker = requireVaultIntegrityMarker(
      state.integrityMarker,
      uid,
      integrityRequirement
    );
    if (
      integrityMarker.state === "pending"
      && action !== "paste-lock-release"
      && action !== "resolve-collision"
    ) {
      requireVaultCutoverLease(
        integrityMarker.document,
        uid,
        vaultCutoverLeaseCredential(body.leaseId, body.leaseGeneration)
      );
    }
    if (action === "paste-lock-acquire") {
      return await handlePasteLockAcquire(context, uid, state, body);
    }
    if (action === "paste-lock-release") {
      return await handlePasteLockRelease(context, uid, state, body);
    }
    if (action === "create") return await handleCreate(context, uid, state, body);
    if (action === "migrate") return await handleMigrate(context, uid, state, body);
    if (action === "resolve-collision") {
      return await handleResolveCollision(context, uid, state, body);
    }
    if (action === "update" || action === "move") {
      return await handleUpdateOrMove(
        context,
        uid,
        state,
        body,
        integrityMarker.state === "pending"
      );
    }
    return await handleLifecycle(context, uid, state, body, action === "restore");
  } catch (error) {
    try {
      await firestoreRollback(context, state.transaction);
    } catch {
      // A successful/ambiguous commit consumes the transaction. The original
      // result remains authoritative and callers can retry by revision.
    }
    throw error;
  }
}

async function performAction(context, uid, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await performActionOnce(context, uid, body);
    } catch (error) {
      if (!(error instanceof VaultFolderTransactionConflict)) throw error;
      if (attempt === 2) {
        throw new HttpError(409, "revision_conflict", "Vault folder changed concurrently");
      }
      await transactionRetryDelay(attempt);
    }
  }
  throw new HttpError(409, "revision_conflict", "Vault folder changed concurrently");
}

export const __vaultFolderTreeTesting = Object.freeze({
  folderQuery,
  performAction,
  treeFromDocument
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
    const body = await readJsonBody(request, 32 * 1024);
    action = typeof body?.action === "string" ? body.action : "unknown";
    const result = await performAction(context, user.uid, body);
    jsonResponse(response, 200, {
      ok: true,
      schemaVersion: VAULT_FOLDER_TREE_SCHEMA_VERSION,
      maximumFolderCount: VAULT_FOLDER_TREE_MAX_FOLDERS,
      ...result
    });
  } catch (error) {
    logVaultApiRejection({
      action,
      error,
      requestId: id,
      route: "/api/vault-folders",
      supportedActions
    });
    handleApiError(error, response, id);
  }
}
