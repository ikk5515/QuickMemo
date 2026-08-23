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
  handleApiError,
  headerValue,
  jsonResponse,
  randomToken,
  readJsonBody,
  requestId,
  toFirestoreValue,
  updateDocumentWrite,
  verifySecureShareAppCheck
} from "./_secure-share-common.js";
import { validateVaultFolderTree } from "./_vault-folder-tree.js";

const maximumRevision = 999_999_999_999;
const maximumParticipants = 200;
const maximumRequestBytes = 1_600_000;
const claimPattern = /^[A-Za-z0-9_-]{43}$/u;
const importJobPattern = /^vi1_[A-Za-z0-9_-]{43}$/u;
const identifierPattern = /^[A-Za-z0-9_-]{1,160}$/u;
const noteIdentifierPattern = /^[A-Za-z0-9_-]{1,120}$/u;
const allowedHistoryFields = new Set([
  "body",
  "deleted",
  "folder",
  "name-claim",
  "participants",
  "restored",
  "storage-identity",
  "title"
]);
const storageIdentities = new Map([
  ["legacy-html-v1", "legacy-html"],
  ["markdown-v1", "markdown"],
  ["json-canvas-v1", "canvas"],
  ["base-v1", "base"],
  ["asset-v1", "asset"]
]);
const supportedActions = new Set([
  "access",
  "backfill-claim",
  "create",
  "import-create",
  "migrate-legacy",
  "move",
  "purge",
  "resolve-collision",
  "restore",
  "secure-copy-abort",
  "secure-copy-activate",
  "secure-copy-create",
  "trash",
  "update"
]);

function requirePost(request) {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
}

function requireRequestMarker(request) {
  if (headerValue(request, "x-quickmemo-vault-notes") !== "1") {
    throw new HttpError(403, "request_rejected", "Vault note request marker is missing");
  }
}

function notePath(noteId) {
  return `notes/${noteId}`;
}

function historyPath(noteId, historyId) {
  return `notes/${noteId}/history/${historyId}`;
}

function claimPath(uid, claimId) {
  return `vaultIntegrity/${uid}/nameClaims/${claimId}`;
}

function integrityPath(uid) {
  return `vaultIntegrity/${uid}`;
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

function userPath(uid) {
  return `users/${uid}`;
}

function cleanupQueuePath(noteId) {
  return `notePurgeCleanupQueue/${noteId}`;
}

function assertIdentifier(value, fieldName = "id") {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertNoteId(value) {
  if (typeof value !== "string" || !noteIdentifierPattern.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid noteId");
  }
  return value;
}

function assertFolderId(value, fieldName = "folderId") {
  if (value === null) return null;
  if (typeof value !== "string" || !noteIdentifierPattern.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertRevision(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximumRevision) {
    throw new HttpError(400, "invalid_request", "Invalid expectedRevision");
  }
  return value;
}

function revisionConflict(actualRevision, message = "Vault note revision changed") {
  const error = new HttpError(409, "revision_conflict", message);
  error.actualRevision = actualRevision;
  return error;
}

function storedRevision(note) {
  const revision = note?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > maximumRevision) {
    throw new HttpError(409, "vault_note_invalid", "Stored Vault note revision is invalid", {
      expose: false
    });
  }
  return revision;
}

function assertEncryptedPayload(value, fieldName, maximumCipherTextLength) {
  assertOnlyKeys(value, ["algorithm", "cipherText", "iv", "version"]);
  if (
    value.version !== 1
    || value.algorithm !== "AES-GCM"
    || typeof value.cipherText !== "string"
    || value.cipherText.length < 1
    || value.cipherText.length > maximumCipherTextLength
    || typeof value.iv !== "string"
    || value.iv.length < 1
    || value.iv.length > 256
  ) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertOptionalEncryptedPayload(value, fieldName, maximumCipherTextLength) {
  return value === undefined
    ? undefined
    : assertEncryptedPayload(value, fieldName, maximumCipherTextLength);
}

function assertWrappedKey(value, fieldName = "wrappedKey") {
  assertOnlyKeys(value, ["algorithm", "version", "wrappedKey"]);
  if (
    value.version !== 1
    || value.algorithm !== "RSA-OAEP"
    || typeof value.wrappedKey !== "string"
    || value.wrappedKey.length < 8
    || value.wrappedKey.length > 4_096
  ) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function assertStoredVaultIntegrityMarker(marker, uid) {
  const storedKeys = marker && typeof marker === "object"
    ? Object.keys(marker).filter((key) => !key.startsWith("__")).sort()
    : [];
  const expectedKeys = ["createdAt", "indexVersion", "ownerUid", "updatedAt", "wrappedKey"];
  const wrappedKey = marker?.wrappedKey;
  const validWrappedKey = Boolean(
    wrappedKey
    && typeof wrappedKey === "object"
    && !Array.isArray(wrappedKey)
    && Object.keys(wrappedKey).sort().join("\u0000") === ["algorithm", "version", "wrappedKey"].join("\u0000")
    && wrappedKey.version === 1
    && wrappedKey.algorithm === "RSA-OAEP"
    && typeof wrappedKey.wrappedKey === "string"
    && wrappedKey.wrappedKey.length >= 8
    && wrappedKey.wrappedKey.length <= 4_096
  );
  if (
    !marker
    || marker.ownerUid !== uid
    || marker.indexVersion !== 1
    || storedKeys.join("\u0000") !== expectedKeys.join("\u0000")
    || typeof marker.createdAt !== "string"
    || !Number.isFinite(Date.parse(marker.createdAt))
    || typeof marker.updatedAt !== "string"
    || !Number.isFinite(Date.parse(marker.updatedAt))
    || !validWrappedKey
  ) {
    throw new HttpError(
      409,
      "vault_integrity_not_ready",
      "Vault integrity setup must be completed before this operation"
    );
  }
  return marker;
}

function assertParticipants(value, uid, type) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumParticipants) {
    throw new HttpError(400, "invalid_request", "Invalid participantUids");
  }
  const participants = value.map((candidate) => assertIdentifier(candidate, "participant uid"));
  if (
    new Set(participants).size !== participants.length
    || !participants.includes(uid)
    || (type === "personal" && (participants.length !== 1 || participants[0] !== uid))
    || (type === "shared" && participants.length < 2)
    || !["personal", "shared"].includes(type)
  ) {
    throw new HttpError(400, "invalid_request", "Invalid note participants");
  }
  return participants;
}

function assertReaderUids(value, expected) {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((uid, index) => uid !== expected[index])
  ) {
    throw new HttpError(400, "invalid_request", "readerUids must match note participants");
  }
  return expected;
}

function assertWrappedKeys(value, participants) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Invalid wrappedKeys");
  }
  const keys = Object.keys(value).sort();
  const expected = [...participants].sort();
  if (keys.length !== expected.length || keys.some((uid, index) => uid !== expected[index])) {
    throw new HttpError(400, "invalid_request", "wrappedKeys must match note participants");
  }
  for (const uid of keys) assertWrappedKey(value[uid], `wrappedKeys.${uid}`);
  return value;
}

function assertStorageIdentity(contentFormat, entryKind) {
  if (storageIdentities.get(contentFormat) !== entryKind) {
    throw new HttpError(400, "invalid_request", "Invalid Vault storage identity");
  }
  return { contentFormat, entryKind };
}

function storageIdentityMatches(note, contentFormat, entryKind) {
  return note.contentFormat === contentFormat && note.entryKind === entryKind;
}

function missingLegacyHtmlIdentity(note) {
  return !Object.prototype.hasOwnProperty.call(note ?? {}, "contentFormat")
    && !Object.prototype.hasOwnProperty.call(note ?? {}, "entryKind")
    && !Object.prototype.hasOwnProperty.call(note ?? {}, "vaultNameClaimId")
    && !Object.prototype.hasOwnProperty.call(note ?? {}, "vaultNameIndexVersion");
}

function assertNameClaim(value, expectedParentId) {
  assertOnlyKeys(value, ["claimId", "indexVersion", "parentId"]);
  if (
    value.indexVersion !== 1
    || typeof value.claimId !== "string"
    || !claimPattern.test(value.claimId)
    || value.parentId !== expectedParentId
  ) {
    throw new HttpError(400, "invalid_request", "Invalid Vault name claim");
  }
  return value;
}

function storedClaimId(note) {
  return typeof note?.vaultNameClaimId === "string" && claimPattern.test(note.vaultNameClaimId)
    ? note.vaultNameClaimId
    : null;
}

function claimTargets(claim, uid, noteId, parentId) {
  return claim
    && claim.ownerUid === uid
    && claim.indexVersion === 1
    && claim.parentId === parentId
    && claim.targetId === noteId
    && claim.targetType === "entry";
}

function claimFields(uid, noteId, parentId, now) {
  return {
    createdAt: now,
    indexVersion: 1,
    ownerUid: uid,
    parentId,
    targetId: noteId,
    targetType: "entry",
    updatedAt: now
  };
}

function encryptedPayloadMatches(left, right) {
  return Boolean(
    left
    && right
    && left.version === right.version
    && left.algorithm === right.algorithm
    && left.cipherText === right.cipherText
    && left.iv === right.iv
  );
}

function wrappedKeysMatch(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((uid, index) => (
    uid === rightKeys[index]
    && left[uid]?.version === right[uid]?.version
    && left[uid]?.algorithm === right[uid]?.algorithm
    && left[uid]?.wrappedKey === right[uid]?.wrappedKey
  ));
}

function assertProfile(profile, uid) {
  const features = profile?.featureAccess;
  if (
    !profile
    || profile.uid !== uid
    || profile.isActive !== true
    || (
      profile.isAdmin !== true
      && Object.prototype.hasOwnProperty.call(profile, "featureAccess")
      && (!features || typeof features !== "object" || features.notes !== true)
    )
  ) {
    throw new HttpError(403, "access_denied", "Inactive user or notes access denied");
  }
  return profile;
}

function assertAllowedParticipants(profile, uid, participants) {
  if (profile.isAdmin === true || participants.every((participantUid) => participantUid === uid)) {
    return;
  }
  const allowed = Array.isArray(profile.allowedShareTargetUids)
    ? new Set(profile.allowedShareTargetUids)
    : new Set();
  if (participants.some((participantUid) => participantUid !== uid && !allowed.has(participantUid))) {
    throw new HttpError(403, "share_target_denied", "A note participant is not allowed");
  }
}

function profileHasNotes(profile) {
  if (!profile || profile.isActive !== true) return false;
  if (profile.isAdmin === true) return true;
  if (!Object.prototype.hasOwnProperty.call(profile, "featureAccess")) return true;
  return profile.featureAccess
    && typeof profile.featureAccess === "object"
    && profile.featureAccess.notes === true;
}

function profileAllowsParticipant(profile, ownerUid, participantUid) {
  if (!profileHasNotes(profile)) return false;
  if (profile.isAdmin === true || participantUid === ownerUid) return true;
  return Array.isArray(profile.allowedShareTargetUids)
    && profile.allowedShareTargetUids.includes(participantUid);
}

function assertHistoryFields(value, required = null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new HttpError(400, "invalid_request", "Invalid changedFields");
  }
  const fields = [...new Set(value)];
  if (
    fields.length !== value.length
    || fields.some((field) => typeof field !== "string" || !allowedHistoryFields.has(field))
    || (required && required.some((field) => !fields.includes(field)))
  ) {
    throw new HttpError(400, "invalid_request", "Invalid changedFields");
  }
  return fields;
}

function noteHistoryDocument(noteId, uid, action, changedFields, readerUids, revision, body, now) {
  return {
    action,
    actorUid: uid,
    changedFields,
    createdAt: now,
    noteId,
    readerUids,
    revision,
    ...(body.historySummary === undefined ? {} : {
      encryptedSummary: assertOptionalEncryptedPayload(body.historySummary, "historySummary", 8_192)
    }),
    ...(body.historySnapshot === undefined ? {} : {
      encryptedSnapshot: assertOptionalEncryptedPayload(body.historySnapshot, "historySnapshot", 700_000)
    })
  };
}

function importedCreateHistoryMatches(history, input) {
  return history
    && history.noteId === input.noteId
    && history.actorUid === input.uid
    && history.action === "create"
    && history.revision === 1
    && Array.isArray(history.changedFields)
    && history.changedFields.length === 2
    && history.changedFields[0] === "title"
    && history.changedFields[1] === "body"
    && Array.isArray(history.readerUids)
    && history.readerUids.length === input.participants.length
    && history.readerUids.every((uid, index) => uid === input.participants[index])
    && (
      input.historySummary === undefined
        ? history.encryptedSummary === undefined
        : encryptedPayloadMatches(history.encryptedSummary, input.historySummary)
    )
    && (
      input.historySnapshot === undefined
        ? history.encryptedSnapshot === undefined
        : encryptedPayloadMatches(history.encryptedSnapshot, input.historySnapshot)
    );
}

function encodedWrappedKeys(wrappedKeys) {
  return {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(wrappedKeys).map(([uid, wrappedKey]) => [uid, toFirestoreValue(wrappedKey)])
      )
    }
  };
}

function createNoteWrite(projectId, path, fields) {
  const { wrappedKeys, ...otherFields } = fields;
  const write = createDocumentWrite(projectId, path, otherFields);
  if (wrappedKeys !== undefined) write.update.fields.wrappedKeys = encodedWrappedKeys(wrappedKeys);
  return write;
}

function updateNoteWrite(projectId, path, fields, fieldPaths, updateTime) {
  const { wrappedKeys, ...otherFields } = fields;
  const write = updateDocumentWrite(projectId, path, otherFields, fieldPaths, updateTime);
  if (wrappedKeys !== undefined) write.update.fields.wrappedKeys = encodedWrappedKeys(wrappedKeys);
  return write;
}

async function commitOrConflict(context, writes, transaction) {
  try {
    return await firestoreCommit(context, writes, transaction);
  } catch (error) {
    if (error?.statusCode === 409 || error?.upstreamCode === "ABORTED") {
      throw new HttpError(409, "revision_conflict", "Vault note changed concurrently");
    }
    throw error;
  }
}

function assertOwnedNote(note, uid) {
  if (!note || note.ownerUid !== uid) {
    throw new HttpError(404, "vault_note_not_found", "Vault note was not found");
  }
  return note;
}

function assertExpectedRevision(note, expectedRevision) {
  const actualRevision = storedRevision(note);
  if (actualRevision !== expectedRevision) {
    throw revisionConflict(actualRevision);
  }
  if (actualRevision >= maximumRevision) {
    throw new HttpError(409, "vault_note_revision_exhausted", "Vault note revision exhausted");
  }
  return actualRevision;
}

function noteActive(note) {
  return note.isDeleted !== true && note.isPurged !== true;
}

function secureCopyUsable(note) {
  return note.secureShareCopyState === undefined || note.secureShareCopyState === "active";
}

function assertImportJob(job, uid, jobId) {
  if (
    !job
    || job.ownerUid !== uid
    || job.kind !== "vault-import-v1"
    || job.version !== 1
    || !["preparing", "staging", "committed", "rolling-back", "rolled-back", "blocked"].includes(job.status)
    || !importJobPattern.test(jobId)
  ) {
    throw new HttpError(409, "vault_import_invalid", "Vault import job is invalid", {
      expose: false
    });
  }
  return job;
}

async function assertSourceImportMutationAllowed(context, transaction, note, uid, action) {
  if (typeof note.vaultImportJobId !== "string") return;
  if (!importJobPattern.test(note.vaultImportJobId)) {
    throw new HttpError(409, "vault_import_invalid", "Vault import provenance is invalid", {
      expose: false
    });
  }
  const [storedJob] = await firestoreBatchGet(
    context,
    [importJobPath(note.ownerUid, note.vaultImportJobId)],
    transaction
  );
  if (!storedJob) return;
  const job = assertImportJob(storedJob, note.ownerUid, note.vaultImportJobId);
  if (job.status === "committed") return;
  if (action === "trash" && job.status === "rolling-back" && uid === note.ownerUid) return;
  throw new HttpError(409, "vault_import_locked", "Vault import target is locked");
}

async function assertFolderAvailable(context, transaction, uid, folderId, targetImportJobId = "") {
  if (folderId === null) return;
  const [folder, treeDocument] = await firestoreBatchGet(
    context,
    [folderPath(folderId), treePath(uid)],
    transaction
  );
  if (!folder || folder.ownerUid !== uid || folder.isDeleted === true) {
    throw new HttpError(409, "vault_parent_unavailable", "Vault note folder is unavailable");
  }
  if (folder.encryptedName || folder.wrappedKey) {
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
    if (tree.nodes[folderId]?.active !== true) {
      throw new HttpError(409, "vault_parent_unavailable", "Vault note folder is unavailable");
    }
  }
  if (folder.vaultImportJobId === undefined) return;
  if (typeof folder.vaultImportJobId !== "string" || !importJobPattern.test(folder.vaultImportJobId)) {
    throw new HttpError(409, "vault_import_invalid", "Vault folder import provenance is invalid", {
      expose: false
    });
  }
  const [storedJob] = await firestoreBatchGet(
    context,
    [importJobPath(uid, folder.vaultImportJobId)],
    transaction
  );
  if (!storedJob) return;
  const job = assertImportJob(storedJob, uid, folder.vaultImportJobId);
  if (job.status === "committed") return;
  if (job.status === "staging" && targetImportJobId === folder.vaultImportJobId) return;
  throw new HttpError(409, "vault_import_locked", "Vault import folder is locked");
}

async function transactionState(context, uid, noteId) {
  const { documents, transaction } = await firestoreBatchGetNewTransaction(
    context,
    [notePath(noteId), userPath(uid)]
  );
  try {
    const profile = assertProfile(documents[1], uid);
    return { note: documents[0], profile, transaction };
  } catch (error) {
    await firestoreRollback(context, transaction).catch(() => undefined);
    throw error;
  }
}

async function assertPreCutoverLegacyMutation(context, transaction, note) {
  if (!missingLegacyHtmlIdentity(note)) return false;
  const [integrityMarker] = await firestoreBatchGet(
    context,
    [integrityPath(note.ownerUid)],
    transaction
  );
  if (integrityMarker) {
    throw new HttpError(
      409,
      "vault_cutover_required",
      "Legacy HTML note must be converted before this Vault mutation"
    );
  }
  return true;
}

async function authorizeRevisionedMutation(context, transaction, note, uid, profile, actionName) {
  if (note.ownerUid === uid) return;
  if (actionName === "trash" && profile.isAdmin === true) return;
  if (
    actionName !== "update"
    || note.type !== "shared"
    || !noteActive(note)
    || !secureCopyUsable(note)
    || !Array.isArray(note.participantUids)
    || !note.participantUids.includes(uid)
  ) {
    throw new HttpError(404, "vault_note_not_found", "Vault note was not found");
  }
  const [ownerProfile] = await firestoreBatchGet(
    context,
    [userPath(note.ownerUid)],
    transaction
  );
  if (!profileAllowsParticipant(ownerProfile, note.ownerUid, uid)) {
    throw new HttpError(404, "vault_note_not_found", "Vault note was not found");
  }
}

function baseCreateInput(body, uid) {
  const type = body.type;
  const participants = assertParticipants(body.participantUids, uid, type);
  const wrappedKeys = assertWrappedKeys(body.wrappedKeys, participants);
  const folderId = type === "personal" ? assertFolderId(body.folderId ?? null) : null;
  if (type === "shared" && body.folderId !== undefined && body.folderId !== null) {
    throw new HttpError(400, "invalid_request", "Shared notes cannot be assigned to a folder");
  }
  const encryptedTitle = assertEncryptedPayload(body.encryptedTitle, "encryptedTitle", 4_096);
  const encryptedBody = assertEncryptedPayload(body.encryptedBody, "encryptedBody", 700_000);
  const storage = assertStorageIdentity(body.contentFormat, body.entryKind);
  return {
    encryptedBody,
    encryptedTitle,
    folderId,
    participants,
    storage,
    type,
    wrappedKeys
  };
}

async function createNote(context, uid, body, options = {}) {
  const allowedKeys = options.secureCopy
    ? [
        "action", "contentFormat", "copyJobId", "encryptedBody", "encryptedTitle", "entryKind",
        "expectedAttachmentCount", "folderId", "historySnapshot", "historySummary", "nameClaim",
        "noteId", "participantUids", "type", "wrappedKeys"
      ]
    : [
        "action", "contentFormat", "encryptedBody", "encryptedTitle", "entryKind", "folderId",
        "historySnapshot", "historySummary", "nameClaim", "participantUids", "type", "wrappedKeys"
      ];
  if (options.imported) allowedKeys.push("importJobId", "noteId");
  if (options.secureCopy) allowedKeys.push("copyJobId", "expectedAttachmentCount");
  assertOnlyKeys(body, allowedKeys);
  const input = baseCreateInput(body, uid);
  const noteId = options.imported || options.secureCopy
    ? assertNoteId(body.noteId)
    : randomToken(18);
  const historyId = randomToken(18);
  const claim = assertNameClaim(body.nameClaim, input.folderId);
  const importJobId = options.imported
    ? (typeof body.importJobId === "string" && importJobPattern.test(body.importJobId)
        ? body.importJobId
        : (() => { throw new HttpError(400, "invalid_request", "Invalid importJobId"); })())
    : "";
  const copyJobId = options.secureCopy
    ? (
        typeof body.copyJobId === "string"
        && /^[A-Za-z0-9_-]{16,160}$/u.test(body.copyJobId)
          ? body.copyJobId
          : (() => { throw new HttpError(400, "invalid_request", "Invalid copyJobId"); })()
      )
    : "";
  const expectedAttachmentCount = options.secureCopy
    ? body.expectedAttachmentCount
    : 0;
  if (
    options.secureCopy
    && (
      input.type !== "personal"
      || input.storage.contentFormat !== "legacy-html-v1"
      || input.storage.entryKind !== "legacy-html"
      || !Number.isSafeInteger(expectedAttachmentCount)
      || expectedAttachmentCount < 0
      || expectedAttachmentCount > 100
    )
  ) {
    throw new HttpError(400, "invalid_request", "Invalid secure copy note");
  }
  const state = await transactionState(context, uid, noteId);
  try {
    assertAllowedParticipants(state.profile, uid, input.participants);
    const [integrityMarker] = await firestoreBatchGet(
      context,
      [integrityPath(uid)],
      state.transaction
    );
    assertStoredVaultIntegrityMarker(integrityMarker, uid);
    let importJob = null;
    if (options.imported) {
      const [job] = await firestoreBatchGet(context, [importJobPath(uid, importJobId)], state.transaction);
      importJob = assertImportJob(job, uid, importJobId);
    }
    await assertFolderAvailable(context, state.transaction, uid, input.folderId, importJobId);
    const [storedClaim] = claim
      ? await firestoreBatchGet(context, [claimPath(uid, claim.claimId)], state.transaction)
      : [null];

    if (state.note || storedClaim) {
      if (
        options.secureCopy
        && state.note
        && claimTargets(storedClaim, uid, noteId, input.folderId)
        && state.note.ownerUid === uid
        && state.note.secureShareCopyJobId === copyJobId
        && state.note.secureShareCopyExpectedAttachmentCount === expectedAttachmentCount
        && state.note.secureShareCopyReservedAttachmentCount === 0
        && state.note.secureShareCopyReadyAttachmentCount === 0
        && state.note.secureShareCopyState === "copying"
        && state.note.revision === 1
        && state.note.attachmentRevision === 0
        && state.note.isDeleted === false
        && state.note.type === input.type
        && Array.isArray(state.note.participantUids)
        && state.note.participantUids.length === input.participants.length
        && state.note.participantUids.every(
          (participantUid, index) => participantUid === input.participants[index]
        )
        && state.note.folderId === input.folderId
        && state.note.contentFormat === input.storage.contentFormat
        && state.note.entryKind === input.storage.entryKind
        && state.note.vaultNameClaimId === claim.claimId
        && state.note.vaultNameIndexVersion === 1
        && encryptedPayloadMatches(state.note.encryptedTitle, input.encryptedTitle)
        && encryptedPayloadMatches(state.note.encryptedBody, input.encryptedBody)
        && wrappedKeysMatch(state.note.wrappedKeys, input.wrappedKeys)
      ) {
        const currentMutationId = state.note.lastMutationId;
        if (typeof currentMutationId !== "string" || !identifierPattern.test(currentMutationId)) {
          throw new HttpError(409, "vault_note_conflict", "Secure copy history is invalid");
        }
        const [history] = await firestoreBatchGet(
          context,
          [historyPath(noteId, currentMutationId)],
          state.transaction
        );
        if (!importedCreateHistoryMatches(history, {
          historySnapshot: body.historySnapshot,
          historySummary: body.historySummary,
          noteId,
          participants: input.participants,
          uid
        })) {
          throw new HttpError(409, "vault_note_conflict", "Secure copy history does not match");
        }
        await firestoreRollback(context, state.transaction);
        return { lastMutationId: currentMutationId, noteId, revision: 1 };
      }
      if (
        options.imported
        && state.note
        && claimTargets(storedClaim, uid, noteId, input.folderId)
        && state.note.ownerUid === uid
        && state.note.vaultImportJobId === importJobId
        && state.note.revision === 1
        && state.note.attachmentRevision === 0
        && state.note.isDeleted === false
        && state.note.type === input.type
        && Array.isArray(state.note.participantUids)
        && state.note.participantUids.length === input.participants.length
        && state.note.participantUids.every(
          (participantUid, index) => participantUid === input.participants[index]
        )
        && state.note.folderId === input.folderId
        && state.note.contentFormat === input.storage.contentFormat
        && state.note.entryKind === input.storage.entryKind
        && state.note.vaultNameClaimId === claim.claimId
        && encryptedPayloadMatches(state.note.encryptedTitle, input.encryptedTitle)
        && encryptedPayloadMatches(state.note.encryptedBody, input.encryptedBody)
        && wrappedKeysMatch(state.note.wrappedKeys, input.wrappedKeys)
      ) {
        const currentMutationId = state.note.lastMutationId;
        if (typeof currentMutationId !== "string" || !identifierPattern.test(currentMutationId)) {
          throw new HttpError(409, "vault_note_conflict", "Imported Vault history is invalid");
        }
        const [history] = await firestoreBatchGet(
          context,
          [historyPath(noteId, currentMutationId)],
          state.transaction
        );
        if (!importedCreateHistoryMatches(history, {
          historySnapshot: body.historySnapshot,
          historySummary: body.historySummary,
          noteId,
          participants: input.participants,
          uid
        })) {
          throw new HttpError(409, "vault_note_conflict", "Imported Vault history does not match");
        }
        await firestoreRollback(context, state.transaction);
        return {
          lastMutationId: currentMutationId,
          noteId,
          revision: 1
        };
      }
      throw new HttpError(409, storedClaim ? "vault_name_conflict" : "vault_note_conflict");
    }
    if (importJob && importJob.status !== "staging") {
      throw new HttpError(409, "vault_import_locked", "Vault import is not accepting entries");
    }

    const now = new Date();
    const history = noteHistoryDocument(
      noteId,
      uid,
      "create",
      ["title", "body"],
      input.participants,
      1,
      body,
      now
    );
    const noteFields = {
      attachmentRevision: 0,
      createdAt: now,
      encryptedBody: input.encryptedBody,
      encryptedTitle: input.encryptedTitle,
      folderId: input.folderId,
      isDeleted: false,
      lastMutationId: historyId,
      ownerUid: uid,
      participantUids: input.participants,
      revision: 1,
      savedAt: now,
      type: input.type,
      updatedAt: now,
      updatedBy: uid,
      wrappedKeys: input.wrappedKeys,
      contentFormat: input.storage.contentFormat,
      entryKind: input.storage.entryKind,
      vaultNameClaimId: claim.claimId,
      vaultNameIndexVersion: 1,
      ...(options.secureCopy ? {
        secureShareCopyExpectedAttachmentCount: expectedAttachmentCount,
        secureShareCopyJobId: copyJobId,
        secureShareCopyReadyAttachmentCount: 0,
        secureShareCopyReservedAttachmentCount: 0,
        secureShareCopyStartedAt: now,
        secureShareCopyState: "copying",
        secureShareCopyUpdatedAt: now
      } : (importJobId ? { vaultImportJobId: importJobId } : {}))
    };
    const writes = [
      createNoteWrite(context.projectId, notePath(noteId), noteFields),
      createDocumentWrite(context.projectId, historyPath(noteId, historyId), history)
    ];
    writes.push(createDocumentWrite(
      context.projectId,
      claimPath(uid, claim.claimId),
      claimFields(uid, noteId, input.folderId, now)
    ));
    await commitOrConflict(context, writes, state.transaction);
    return { lastMutationId: historyId, noteId, revision: 1 };
  } catch (error) {
    await firestoreRollback(context, state.transaction).catch(() => undefined);
    throw error;
  }
}

async function mutateRevisionedNote(context, uid, body, specification) {
  const noteId = assertNoteId(body.noteId);
  const expectedRevision = assertRevision(body.expectedRevision);
  const state = await transactionState(context, uid, noteId);
  try {
    const note = state.note;
    if (!note) throw new HttpError(404, "vault_note_not_found", "Vault note was not found");
    await authorizeRevisionedMutation(
      context,
      state.transaction,
      note,
      uid,
      state.profile,
      specification.actionName
    );
    const revision = assertExpectedRevision(note, expectedRevision);
    await assertSourceImportMutationAllowed(context, state.transaction, note, uid, specification.actionName);
    const mutation = await specification.prepare({
      context,
      note,
      noteId,
      profile: state.profile,
      transaction: state.transaction,
      uid
    });
    const nextRevision = revision + 1;
    const historyId = randomToken(18);
    const now = new Date();
    const history = noteHistoryDocument(
      noteId,
      uid,
      mutation.historyAction,
      mutation.changedFields,
      mutation.readerUids,
      nextRevision,
      body,
      now
    );
    const update = {
      ...mutation.update,
      lastMutationId: historyId,
      revision: nextRevision,
      updatedAt: now,
      updatedBy: uid
    };
    const fieldPaths = [
      ...Object.keys(update),
      ...(mutation.deleteFields ?? [])
    ];
    const writes = [
      updateNoteWrite(
        context.projectId,
        notePath(noteId),
        update,
        fieldPaths,
        note.__updateTime
      ),
      createDocumentWrite(context.projectId, historyPath(noteId, historyId), history),
      ...(mutation.additionalWrites ?? [])
    ];
    await commitOrConflict(context, writes, state.transaction);
    return {
      lastMutationId: historyId,
      noteId,
      revision: nextRevision,
      ...(mutation.result ?? {})
    };
  } catch (error) {
    await firestoreRollback(context, state.transaction).catch(() => undefined);
    throw error;
  }
}

async function claimMutation(context, transaction, note, noteId, uid, nextClaim) {
  if (nextClaim) {
    const [integrityMarker] = await firestoreBatchGet(
      context,
      [integrityPath(note.ownerUid)],
      transaction
    );
    assertStoredVaultIntegrityMarker(integrityMarker, note.ownerUid);
  }
  const previousClaimId = storedClaimId(note);
  const paths = [];
  if (nextClaim) paths.push(claimPath(note.ownerUid, nextClaim.claimId));
  if (previousClaimId && previousClaimId !== nextClaim?.claimId) {
    paths.push(claimPath(note.ownerUid, previousClaimId));
  }
  const documents = paths.length ? await firestoreBatchGet(context, paths, transaction) : [];
  let offset = 0;
  const nextClaimDocument = nextClaim ? documents[offset++] : null;
  const previousClaimDocument = previousClaimId && previousClaimId !== nextClaim?.claimId
    ? documents[offset++]
    : nextClaimDocument;
  if (
    nextClaimDocument
    && !claimTargets(nextClaimDocument, note.ownerUid, noteId, nextClaim.parentId)
  ) {
    throw new HttpError(409, "vault_name_conflict", "Vault entry name is already reserved");
  }
  if (
    previousClaimDocument
    && !claimTargets(
      previousClaimDocument,
      note.ownerUid,
      noteId,
      previousClaimId === nextClaim?.claimId ? nextClaim.parentId : note.folderId ?? null
    )
  ) {
    throw new HttpError(409, "vault_claim_invalid", "Stored Vault claim does not match", {
      expose: false
    });
  }
  const now = new Date();
  const writes = [];
  if (nextClaim && !nextClaimDocument) {
    writes.push(createDocumentWrite(
      context.projectId,
      claimPath(note.ownerUid, nextClaim.claimId),
      claimFields(note.ownerUid, noteId, nextClaim.parentId, now)
    ));
  }
  if (previousClaimId && previousClaimId !== nextClaim?.claimId && previousClaimDocument) {
    writes.push(deleteDocumentWrite(
      context.projectId,
      claimPath(note.ownerUid, previousClaimId),
      previousClaimDocument.__updateTime
    ));
  }
  return writes;
}

async function handleUpdate(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "changedFields", "encryptedBody", "encryptedTitle", "expectedContentFormat",
    "expectedEntryKind", "expectedRevision", "folderId", "historySnapshot", "historySummary",
    "nameClaim", "noteId", "readerUids"
  ]);
  const encryptedTitle = assertEncryptedPayload(body.encryptedTitle, "encryptedTitle", 4_096);
  const encryptedBody = assertEncryptedPayload(body.encryptedBody, "encryptedBody", 700_000);
  assertStorageIdentity(body.expectedContentFormat, body.expectedEntryKind);
  return mutateRevisionedNote(context, uid, body, {
    actionName: "update",
    prepare: async ({ context: innerContext, note, noteId, transaction }) => {
      const preCutoverLegacy = missingLegacyHtmlIdentity(note)
        ? await assertPreCutoverLegacyMutation(innerContext, transaction, note)
        : false;
      const expectedLegacyIdentity = body.expectedContentFormat === "legacy-html-v1"
        && body.expectedEntryKind === "legacy-html";
      if (
        !noteActive(note)
        || !secureCopyUsable(note)
        || (
          !storageIdentityMatches(note, body.expectedContentFormat, body.expectedEntryKind)
          && !(preCutoverLegacy && expectedLegacyIdentity)
        )
      ) {
        throw new HttpError(409, "vault_note_state_mismatch", "Vault note state does not match");
      }
      if (!Array.isArray(note.participantUids) || !note.participantUids.includes(uid)) {
        throw new HttpError(403, "access_denied", "Not a note participant");
      }
      assertReaderUids(body.readerUids, note.participantUids);
      const titleChanged = !encryptedPayloadMatches(note.encryptedTitle, encryptedTitle);
      const bodyChanged = !encryptedPayloadMatches(note.encryptedBody, encryptedBody);
      const folderIncluded = Object.prototype.hasOwnProperty.call(body, "folderId");
      const nextFolderId = folderIncluded ? assertFolderId(body.folderId) : note.folderId ?? null;
      const folderChanged = folderIncluded && nextFolderId !== (note.folderId ?? null);
      if (preCutoverLegacy && folderChanged) {
        throw new HttpError(400, "invalid_request", "Use access to move a legacy HTML note");
      }
      if (!titleChanged && !bodyChanged && !folderChanged) {
        throw new HttpError(400, "invalid_request", "Vault note update has no changes");
      }
      const ownerUpdate = note.ownerUid === uid;
      if (!ownerUpdate) {
        if (
          note.type !== "shared"
          || titleChanged
          || folderChanged
          || !bodyChanged
          || (!storedClaimId(note) && !preCutoverLegacy)
        ) {
          throw new HttpError(403, "access_denied", "Participants may update only the body");
        }
      }
      const changedFields = assertHistoryFields(
        body.changedFields ?? [
          ...(titleChanged ? ["title"] : []),
          ...(bodyChanged ? ["body"] : []),
          ...(folderChanged ? ["folder"] : [])
        ],
        [
          ...(titleChanged ? ["title"] : []),
          ...(bodyChanged ? ["body"] : []),
          ...(folderChanged ? ["folder"] : [])
        ]
      );
      if (!ownerUpdate && (changedFields.length !== 1 || changedFields[0] !== "body")) {
        throw new HttpError(400, "invalid_request", "Participant history must describe body only");
      }
      const currentClaimId = storedClaimId(note);
      let nextClaim = null;
      if (preCutoverLegacy) {
        if (body.nameClaim !== undefined || changedFields.includes("name-claim")) {
          throw new HttpError(400, "invalid_request", "Legacy HTML update cannot add a Vault claim");
        }
      } else if (titleChanged || folderChanged) {
        if (!currentClaimId) {
          throw new HttpError(409, "vault_name_claim_required", "Backfill the Vault name claim first");
        }
        if (folderChanged && (note.type !== "personal" || !ownerUpdate)) {
          throw new HttpError(403, "access_denied", "Only an owner may move a personal note");
        }
        await assertFolderAvailable(innerContext, transaction, note.ownerUid, nextFolderId);
        nextClaim = assertNameClaim(body.nameClaim, nextFolderId);
        if (!changedFields.includes("name-claim")) {
          throw new HttpError(400, "invalid_request", "Name-changing history must include name-claim");
        }
      } else if (body.nameClaim !== undefined) {
        nextClaim = assertNameClaim(body.nameClaim, note.folderId ?? null);
        if (nextClaim.claimId !== currentClaimId) {
          throw new HttpError(400, "invalid_request", "Body-only update cannot change the name claim");
        }
      }
      const additionalWrites = nextClaim
        ? await claimMutation(innerContext, transaction, note, noteId, uid, nextClaim)
        : [];
      return {
        additionalWrites,
        changedFields,
        historyAction: "content",
        readerUids: note.participantUids,
        update: {
          ...(titleChanged ? { encryptedTitle } : {}),
          ...(bodyChanged ? { encryptedBody } : {}),
          ...(folderChanged ? { folderId: nextFolderId } : {}),
          ...(nextClaim ? {
            vaultNameClaimId: nextClaim.claimId,
            vaultNameIndexVersion: 1
          } : {})
        }
      };
    }
  });
}

async function handleMove(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "expectedRevision", "folderId", "historySummary", "nameClaim", "noteId", "readerUids"
  ]);
  const folderId = assertFolderId(body.folderId);
  return mutateRevisionedNote(context, uid, body, {
    actionName: "move",
    prepare: async ({ context: innerContext, note, noteId, transaction }) => {
      assertOwnedNote(note, uid);
      if (!noteActive(note) || !secureCopyUsable(note) || note.type !== "personal") {
        throw new HttpError(409, "vault_note_state_mismatch", "Vault note cannot be moved");
      }
      assertReaderUids(body.readerUids, note.participantUids);
      if ((note.folderId ?? null) === folderId) {
        throw new HttpError(400, "invalid_request", "Vault note is already in this folder");
      }
      await assertFolderAvailable(innerContext, transaction, uid, folderId);
      const nextClaim = assertNameClaim(body.nameClaim, folderId);
      if (!storedClaimId(note)) {
        throw new HttpError(409, "vault_name_claim_required", "Resolve the Vault name claim first");
      }
      const additionalWrites = await claimMutation(
        innerContext,
        transaction,
        note,
        noteId,
        uid,
        nextClaim
      );
      return {
        additionalWrites,
        changedFields: ["folder", "name-claim"],
        historyAction: "share",
        readerUids: note.participantUids,
        update: {
          folderId,
          vaultNameClaimId: nextClaim.claimId,
          vaultNameIndexVersion: 1
        }
      };
    }
  });
}

async function handleAccess(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "expectedRevision", "folderId", "nameClaim", "noteId", "participantUids",
    "type", "wrappedKeys"
  ]);
  const participants = assertParticipants(body.participantUids, uid, body.type);
  const wrappedKeys = assertWrappedKeys(body.wrappedKeys, participants);
  const folderId = body.type === "personal" ? assertFolderId(body.folderId ?? null) : null;
  if (body.type === "shared" && body.folderId !== undefined && body.folderId !== null) {
    throw new HttpError(400, "invalid_request", "Shared notes cannot be assigned to a folder");
  }
  return mutateRevisionedNote(context, uid, body, {
    actionName: "access",
    prepare: async ({ context: innerContext, note, noteId, profile, transaction }) => {
      assertOwnedNote(note, uid);
      const preCutoverLegacy = missingLegacyHtmlIdentity(note)
        ? await assertPreCutoverLegacyMutation(innerContext, transaction, note)
        : false;
      if (
        !noteActive(note)
        || !secureCopyUsable(note)
        || (!preCutoverLegacy && !storedClaimId(note))
      ) {
        throw new HttpError(409, "vault_note_state_mismatch", "Vault note access cannot be changed");
      }
      assertAllowedParticipants(profile, uid, participants);
      await assertFolderAvailable(innerContext, transaction, uid, folderId);
      const participantsChanged = note.type !== body.type
        || !Array.isArray(note.participantUids)
        || note.participantUids.length !== participants.length
        || note.participantUids.some((participantUid, index) => participantUid !== participants[index])
        || !wrappedKeysMatch(note.wrappedKeys, wrappedKeys);
      const folderChanged = (note.folderId ?? null) !== folderId;
      if (!participantsChanged && !folderChanged) {
        throw new HttpError(400, "invalid_request", "Vault note access has no changes");
      }
      if (preCutoverLegacy && body.nameClaim !== undefined) {
        throw new HttpError(400, "invalid_request", "Legacy HTML access cannot add a Vault claim");
      }
      if (!folderChanged && body.nameClaim !== undefined) {
        throw new HttpError(400, "invalid_request", "Unchanged folder does not accept a name claim");
      }
      const nextClaim = folderChanged && !preCutoverLegacy
        ? assertNameClaim(body.nameClaim, folderId)
        : null;
      const additionalWrites = nextClaim
        ? await claimMutation(innerContext, transaction, note, noteId, uid, nextClaim)
        : [];
      return {
        additionalWrites,
        changedFields: [
          ...(participantsChanged ? ["participants"] : []),
          ...(folderChanged ? ["folder", ...(preCutoverLegacy ? [] : ["name-claim"])] : [])
        ],
        historyAction: "share",
        readerUids: participants,
        update: {
          folderId,
          participantUids: participants,
          type: body.type,
          wrappedKeys,
          ...(nextClaim ? {
            vaultNameClaimId: nextClaim.claimId,
            vaultNameIndexVersion: 1
          } : {})
        }
      };
    }
  });
}

async function handleBackfill(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "expectedContentFormat", "expectedEntryKind", "expectedRevision", "historySummary",
    "nameClaim", "noteId", "readerUids"
  ]);
  assertStorageIdentity(body.expectedContentFormat, body.expectedEntryKind);
  return mutateRevisionedNote(context, uid, body, {
    actionName: "backfill-claim",
    prepare: async ({ context: innerContext, note, noteId, transaction }) => {
      assertOwnedNote(note, uid);
      if (
        !noteActive(note)
        || !secureCopyUsable(note)
        || storedClaimId(note)
        || !storageIdentityMatches(note, body.expectedContentFormat, body.expectedEntryKind)
      ) {
        throw new HttpError(409, "vault_note_state_mismatch", "Vault name claim cannot be backfilled");
      }
      assertReaderUids(body.readerUids, note.participantUids);
      const nextClaim = assertNameClaim(body.nameClaim, note.folderId ?? null);
      await assertFolderAvailable(innerContext, transaction, uid, note.folderId ?? null);
      const additionalWrites = await claimMutation(
        innerContext,
        transaction,
        note,
        noteId,
        uid,
        nextClaim
      );
      return {
        additionalWrites,
        changedFields: ["name-claim"],
        historyAction: "content",
        readerUids: note.participantUids,
        update: {
          vaultNameClaimId: nextClaim.claimId,
          vaultNameIndexVersion: 1
        }
      };
    }
  });
}

async function handleMigrateLegacy(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "expectedContentFormat", "expectedEntryKind", "expectedRevision", "historySummary",
    "nameClaim", "noteId", "readerUids"
  ]);
  if (
    body.expectedContentFormat !== "legacy-html-v1"
    || body.expectedEntryKind !== "legacy-html"
  ) {
    throw new HttpError(400, "invalid_request", "Only legacy HTML identity can be migrated");
  }
  return mutateRevisionedNote(context, uid, body, {
    actionName: "migrate-legacy",
    prepare: async ({ context: innerContext, note, noteId, transaction }) => {
      assertOwnedNote(note, uid);
      if (
        !missingLegacyHtmlIdentity(note)
        || note.isPurged === true
        || !secureCopyUsable(note)
      ) {
        throw new HttpError(409, "vault_note_state_mismatch", "Legacy Vault identity cannot be migrated");
      }
      const [integrityMarker] = await firestoreBatchGet(
        innerContext,
        [integrityPath(uid)],
        transaction
      );
      assertStoredVaultIntegrityMarker(integrityMarker, uid);
      assertReaderUids(body.readerUids, note.participantUids);
      const deleted = note.isDeleted === true;
      if (deleted && body.nameClaim !== undefined) {
        throw new HttpError(400, "invalid_request", "Deleted legacy note cannot reserve a name");
      }
      const nextClaim = deleted || body.nameClaim === undefined
        ? null
        : assertNameClaim(body.nameClaim, note.folderId ?? null);
      if (nextClaim) {
        await assertFolderAvailable(innerContext, transaction, uid, note.folderId ?? null);
      }
      const additionalWrites = nextClaim
        ? await claimMutation(innerContext, transaction, note, noteId, uid, nextClaim)
        : [];
      return {
        additionalWrites,
        changedFields: ["storage-identity", ...(nextClaim ? ["name-claim"] : [])],
        historyAction: "content",
        readerUids: note.participantUids,
        result: {
          claimState: nextClaim ? "reserved" : deleted ? "deleted" : "deferred"
        },
        update: {
          contentFormat: "legacy-html-v1",
          entryKind: "legacy-html",
          ...(!Object.prototype.hasOwnProperty.call(note, "isDeleted") ? { isDeleted: false } : {}),
          ...(nextClaim ? {
            vaultNameClaimId: nextClaim.claimId,
            vaultNameIndexVersion: 1
          } : {})
        }
      };
    }
  });
}

async function handleCollision(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "changedFields", "encryptedTitle", "expectedContentFormat", "expectedEntryKind",
    "expectedRevision", "folderId", "historySummary", "nameClaim", "noteId", "readerUids"
  ]);
  assertStorageIdentity(body.expectedContentFormat, body.expectedEntryKind);
  const changedFields = assertHistoryFields(body.changedFields, ["name-claim"]);
  const titleChanged = changedFields.includes("title");
  const folderChanged = changedFields.includes("folder");
  if ((!titleChanged && !folderChanged) || changedFields.some((field) => !["title", "folder", "name-claim"].includes(field))) {
    throw new HttpError(400, "invalid_request", "Invalid collision recovery fields");
  }
  const encryptedTitle = titleChanged
    ? assertEncryptedPayload(body.encryptedTitle, "encryptedTitle", 4_096)
    : undefined;
  if (titleChanged !== (body.encryptedTitle !== undefined) || folderChanged !== Object.prototype.hasOwnProperty.call(body, "folderId")) {
    throw new HttpError(400, "invalid_request", "Collision recovery payload does not match changedFields");
  }
  const folderId = folderChanged ? assertFolderId(body.folderId) : undefined;
  return mutateRevisionedNote(context, uid, body, {
    actionName: "resolve-collision",
    prepare: async ({ context: innerContext, note, noteId, transaction }) => {
      assertOwnedNote(note, uid);
      if (
        !noteActive(note)
        || !secureCopyUsable(note)
        || storedClaimId(note)
        || !storageIdentityMatches(note, body.expectedContentFormat, body.expectedEntryKind)
        || (folderChanged && note.type !== "personal")
      ) {
        throw new HttpError(409, "vault_note_state_mismatch", "Vault collision cannot be resolved");
      }
      assertReaderUids(body.readerUids, note.participantUids);
      const nextFolderId = folderChanged ? folderId : note.folderId ?? null;
      await assertFolderAvailable(innerContext, transaction, uid, nextFolderId);
      if (titleChanged && encryptedPayloadMatches(note.encryptedTitle, encryptedTitle)) {
        throw new HttpError(400, "invalid_request", "Collision recovery title is unchanged");
      }
      if (folderChanged && (note.folderId ?? null) === nextFolderId) {
        throw new HttpError(400, "invalid_request", "Collision recovery folder is unchanged");
      }
      const nextClaim = assertNameClaim(body.nameClaim, nextFolderId);
      const additionalWrites = await claimMutation(
        innerContext,
        transaction,
        note,
        noteId,
        uid,
        nextClaim
      );
      return {
        additionalWrites,
        changedFields,
        historyAction: "content",
        readerUids: note.participantUids,
        update: {
          ...(titleChanged ? { encryptedTitle } : {}),
          ...(folderChanged ? { folderId: nextFolderId } : {}),
          vaultNameClaimId: nextClaim.claimId,
          vaultNameIndexVersion: 1
        }
      };
    }
  });
}

async function handleLifecycle(context, uid, body, restoring) {
  assertOnlyKeys(body, [
    "action", "expectedRevision", "nameClaim", "noteId", "readerUids"
  ]);
  return mutateRevisionedNote(context, uid, body, {
    actionName: restoring ? "restore" : "trash",
    prepare: async ({ context: innerContext, note, noteId, profile, transaction }) => {
      if (!note || (note.ownerUid !== uid && (restoring || profile.isAdmin !== true))) {
        throw new HttpError(404, "vault_note_not_found", "Vault note was not found");
      }
      const preCutoverLegacy = missingLegacyHtmlIdentity(note)
        ? await assertPreCutoverLegacyMutation(innerContext, transaction, note)
        : false;
      assertReaderUids(body.readerUids, note.participantUids);
      if (
        !secureCopyUsable(note)
        || note.isPurged === true
        || (restoring ? note.isDeleted !== true : note.isDeleted === true)
      ) {
        throw new HttpError(409, "vault_note_state_mismatch", "Vault note lifecycle state does not match");
      }
      let nextClaim = null;
      if (restoring) {
        await assertFolderAvailable(innerContext, transaction, note.ownerUid, note.folderId ?? null);
        if (preCutoverLegacy) {
          if (body.nameClaim !== undefined) {
            throw new HttpError(400, "invalid_request", "Legacy HTML restore cannot add a Vault claim");
          }
        } else {
          const currentClaimId = storedClaimId(note);
          nextClaim = currentClaimId
            ? { claimId: currentClaimId, indexVersion: 1, parentId: note.folderId ?? null }
            : assertNameClaim(body.nameClaim, note.folderId ?? null);
        }
      } else if (body.nameClaim !== undefined) {
        throw new HttpError(400, "invalid_request", "Trash does not accept a name claim");
      }
      const additionalWrites = await claimMutation(
        innerContext,
        transaction,
        note,
        noteId,
        uid,
        nextClaim
      );
      const backfillsClaimMetadata = Boolean(
        restoring
        && nextClaim
        && !storedClaimId(note)
      );
      return {
        additionalWrites,
        changedFields: restoring
          ? [
              "restored",
              ...(!preCutoverLegacy && !storedClaimId(note) ? ["name-claim"] : [])
            ]
          : ["deleted"],
        deleteFields: restoring ? ["deletedAt", "deletedBy"] : [],
        historyAction: restoring ? "restore" : "delete",
        readerUids: note.participantUids,
        update: restoring
          ? {
              isDeleted: false,
              ...(backfillsClaimMetadata ? {
                vaultNameClaimId: nextClaim.claimId,
                vaultNameIndexVersion: 1
              } : {})
            }
          : { deletedAt: new Date(), deletedBy: uid, isDeleted: true }
      };
    }
  });
}

async function handlePurge(context, uid, body) {
  assertOnlyKeys(body, [
    "action", "encryptedBody", "encryptedTitle", "expectedRevision", "noteId", "wrappedKey"
  ]);
  const noteId = assertNoteId(body.noteId);
  const expectedRevision = assertRevision(body.expectedRevision);
  const encryptedTitle = assertEncryptedPayload(body.encryptedTitle, "encryptedTitle", 4_096);
  const encryptedBody = assertEncryptedPayload(body.encryptedBody, "encryptedBody", 700_000);
  const wrappedKey = assertWrappedKey(body.wrappedKey);
  const state = await transactionState(context, uid, noteId);
  try {
    const note = assertOwnedNote(state.note, uid);
    const revision = storedRevision(note);
    if (revision !== expectedRevision) {
      throw revisionConflict(revision);
    }
    if (note.isDeleted !== true || note.isPurged === true || !secureCopyUsable(note)) {
      throw new HttpError(409, "vault_note_state_mismatch", "Vault note cannot be purged");
    }
    await assertSourceImportMutationAllowed(context, state.transaction, note, uid, "purge");
    const [cleanupQueue] = await firestoreBatchGet(
      context,
      [cleanupQueuePath(noteId)],
      state.transaction
    );
    if (cleanupQueue) {
      throw new HttpError(409, "vault_note_conflict", "Vault note purge is already queued");
    }
    const now = new Date();
    const fields = {
      encryptedBody,
      encryptedTitle,
      isDeleted: true,
      isPurged: true,
      participantUids: [uid],
      purgedAt: now,
      purgedBy: uid,
      savedAt: now,
      type: "personal",
      updatedAt: now,
      updatedBy: uid,
      wrappedKeys: { [uid]: wrappedKey }
    };
    const fieldPaths = [
      ...Object.keys(fields),
      "deletedAt",
      "deletedBy",
      "dueAt",
      "folderId"
    ];
    await commitOrConflict(context, [
      updateNoteWrite(
        context.projectId,
        notePath(noteId),
        fields,
        fieldPaths,
        note.__updateTime
      ),
      createDocumentWrite(context.projectId, cleanupQueuePath(noteId), {
        createdAt: now,
        noteId,
        ownerUid: uid
      })
    ], state.transaction);
    return { noteId, revision };
  } catch (error) {
    await firestoreRollback(context, state.transaction).catch(() => undefined);
    throw error;
  }
}

async function handleSecureCopyActivate(context, uid, body) {
  assertOnlyKeys(body, ["action", "copyJobId", "expectedRevision", "noteId"]);
  const noteId = assertNoteId(body.noteId);
  const expectedRevision = assertRevision(body.expectedRevision, 1);
  const copyJobId = assertIdentifier(body.copyJobId, "copyJobId");
  const state = await transactionState(context, uid, noteId);
  try {
    const note = assertOwnedNote(state.note, uid);
    const revision = storedRevision(note);
    if (revision !== expectedRevision || note.secureShareCopyJobId !== copyJobId) {
      throw revisionConflict(revision, "Secure copy note changed");
    }
    const claimId = storedClaimId(note);
    const [storedClaim] = claimId
      ? await firestoreBatchGet(context, [claimPath(uid, claimId)], state.transaction)
      : [null];
    if (
      !storageIdentityMatches(note, "legacy-html-v1", "legacy-html")
      || note.vaultNameIndexVersion !== 1
      || !claimId
      || !claimTargets(storedClaim, uid, noteId, note.folderId ?? null)
    ) {
      throw new HttpError(409, "secure_copy_not_ready", "Secure copy Vault identity is not ready");
    }
    if (note.secureShareCopyState === "active") {
      await firestoreRollback(context, state.transaction);
      return { noteId, revision, state: "active" };
    }
    if (
      note.secureShareCopyState !== "copying"
      || note.isDeleted === true
      || note.secureShareCopyCleanupClaimId !== undefined
      || note.secureShareCopyCleanupClaimedAt !== undefined
      || !Number.isSafeInteger(note.secureShareCopyExpectedAttachmentCount)
      || note.secureShareCopyExpectedAttachmentCount < 0
      || note.secureShareCopyExpectedAttachmentCount > 100
      || !Number.isSafeInteger(note.secureShareCopyReservedAttachmentCount)
      || !Number.isSafeInteger(note.secureShareCopyReadyAttachmentCount)
      || note.secureShareCopyReservedAttachmentCount !== note.secureShareCopyExpectedAttachmentCount
      || note.secureShareCopyReadyAttachmentCount !== note.secureShareCopyExpectedAttachmentCount
    ) {
      throw new HttpError(409, "secure_copy_not_ready", "Secure copy attachments are not ready");
    }
    const now = new Date();
    const update = {
      savedAt: now,
      secureShareCopyFinishedAt: now,
      secureShareCopyState: "active",
      secureShareCopyUpdatedAt: now,
      updatedAt: now,
      updatedBy: uid
    };
    await commitOrConflict(context, [updateNoteWrite(
      context.projectId,
      notePath(noteId),
      update,
      Object.keys(update),
      note.__updateTime
    )], state.transaction);
    return { noteId, revision, state: "active" };
  } catch (error) {
    await firestoreRollback(context, state.transaction).catch(() => undefined);
    throw error;
  }
}

async function handleSecureCopyAbort(context, uid, body) {
  assertOnlyKeys(body, ["action", "copyJobId", "expectedRevision", "noteId"]);
  const copyJobId = assertIdentifier(body.copyJobId, "copyJobId");
  return mutateRevisionedNote(context, uid, body, {
    actionName: "secure-copy-abort",
    prepare: async ({ context: innerContext, note, noteId, transaction }) => {
      assertOwnedNote(note, uid);
      const expectedCount = note.secureShareCopyExpectedAttachmentCount;
      const reservedCount = note.secureShareCopyReservedAttachmentCount;
      const readyCount = note.secureShareCopyReadyAttachmentCount;
      if (
        note.secureShareCopyJobId !== copyJobId
        || note.secureShareCopyState !== "copying"
        || note.secureShareCopyCleanupClaimId !== undefined
        || note.secureShareCopyCleanupClaimedAt !== undefined
        || !storageIdentityMatches(note, "legacy-html-v1", "legacy-html")
        || note.vaultNameIndexVersion !== 1
        || !storedClaimId(note)
        || !Number.isSafeInteger(expectedCount)
        || !Number.isSafeInteger(reservedCount)
        || !Number.isSafeInteger(readyCount)
        || expectedCount < 0
        || expectedCount > 100
        || readyCount < 0
        || reservedCount < readyCount
        || reservedCount > expectedCount
        || reservedCount !== 0
        || readyCount !== 0
      ) {
        throw new HttpError(409, "secure_copy_abort_denied", "Secure copy cannot be aborted");
      }
      const additionalWrites = await claimMutation(
        innerContext,
        transaction,
        note,
        noteId,
        uid,
        null
      );
      return {
        additionalWrites,
        changedFields: ["deleted"],
        historyAction: "delete",
        readerUids: [uid],
        update: {
          deletedAt: new Date(),
          deletedBy: uid,
          isDeleted: true,
          secureShareCopyFinishedAt: new Date(),
          secureShareCopyState: "aborted",
          secureShareCopyUpdatedAt: new Date()
        }
      };
    }
  });
}

async function performAction(context, uid, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Expected a JSON object");
  }
  const action = body.action;
  if (typeof action !== "string" || !supportedActions.has(action)) {
    throw new HttpError(400, "invalid_request", "Invalid Vault note action");
  }
  if (action === "create") return createNote(context, uid, body);
  if (action === "import-create") return createNote(context, uid, body, { imported: true });
  if (action === "secure-copy-create") return createNote(context, uid, body, { secureCopy: true });
  if (action === "update") return handleUpdate(context, uid, body);
  if (action === "move") return handleMove(context, uid, body);
  if (action === "access") return handleAccess(context, uid, body);
  if (action === "backfill-claim") return handleBackfill(context, uid, body);
  if (action === "migrate-legacy") return handleMigrateLegacy(context, uid, body);
  if (action === "resolve-collision") return handleCollision(context, uid, body);
  if (action === "trash" || action === "restore") {
    return handleLifecycle(context, uid, body, action === "restore");
  }
  if (action === "purge") return handlePurge(context, uid, body);
  if (action === "secure-copy-activate") return handleSecureCopyActivate(context, uid, body);
  return handleSecureCopyAbort(context, uid, body);
}

export const __vaultNoteTesting = Object.freeze({
  assertEncryptedPayload,
  assertNameClaim,
  assertParticipants,
  assertStorageIdentity,
  assertWrappedKeys,
  performAction
});

export default async function handler(request, response) {
  const id = requestId();
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
    const result = await performAction(context, user.uid, body);
    jsonResponse(response, 200, { ok: true, ...result });
  } catch (error) {
    if (
      error instanceof HttpError
      && error.code === "revision_conflict"
      && Number.isSafeInteger(error.actualRevision)
      && error.actualRevision >= 0
      && error.actualRevision <= maximumRevision
      && !response.headersSent
    ) {
      jsonResponse(response, 409, {
        actualRevision: error.actualRevision,
        error: "revision_conflict",
        ok: false,
        requestId: id
      });
      return;
    }
    handleApiError(error, response, id);
  }
}
