const fingerprintPattern = /^[A-Za-z0-9_-]{43}$/u;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function boundedStringOrNull(value, maximumLength) {
  if (typeof value !== "string") return null;
  if (value.length > maximumLength) throw new RangeError("Vault inventory field exceeds its safe limit");
  return value;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function integerOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999
    ? value
    : 0;
}

function documentId(value) {
  const candidate = record(value);
  const id = stringOrNull(candidate.id) ?? stringOrNull(candidate.__id);
  if (!id || id !== id.trim() || id.length > 120 || id.includes("/")) {
    throw new TypeError("Invalid Vault inventory document id");
  }
  return id;
}

function encryptedPayloadIdentity(value) {
  const payload = record(value);
  return [
    boundedStringOrNull(payload.algorithm, 32),
    Number.isSafeInteger(payload.version) ? payload.version : null
  ];
}

function wrappedKeyIdentity(value) {
  const key = record(value);
  return [
    boundedStringOrNull(key.algorithm, 32),
    Number.isSafeInteger(key.version) ? key.version : null
  ];
}

function activeOwnerNote(note) {
  return note.isDeleted !== true
    && note.isPurged !== true
    && note.secureShareCopyState !== "copying"
    && note.secureShareCopyState !== "aborted";
}

function compareDocumentTuple(left, right) {
  const leftId = String(left[1]);
  const rightId = String(right[1]);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function noteTuple(value) {
  const note = record(value);
  return [
    "note",
    documentId(note),
    integerOrZero(note.revision),
    boundedStringOrNull(note.folderId, 120),
    boundedStringOrNull(note.type, 32),
    boundedStringOrNull(note.contentFormat, 32),
    boundedStringOrNull(note.entryKind, 32),
    encryptedPayloadIdentity(note.encryptedTitle),
    encryptedPayloadIdentity(note.encryptedBody),
    boundedStringOrNull(note.vaultNameClaimId, 128),
    Number.isSafeInteger(note.vaultNameIndexVersion) ? note.vaultNameIndexVersion : null,
    boundedStringOrNull(note.vaultImportJobId, 128)
  ];
}

function folderTuple(value) {
  const folder = record(value);
  return [
    "folder",
    documentId(folder),
    integerOrZero(folder.revision),
    boundedStringOrNull(folder.parentId, 120),
    booleanOrNull(folder.isDeleted),
    boundedStringOrNull(folder.deletedBy, 128),
    boundedStringOrNull(folder.name, 120),
    encryptedPayloadIdentity(folder.encryptedName),
    wrappedKeyIdentity(folder.wrappedKey),
    boundedStringOrNull(folder.vaultNameClaimId, 128),
    Number.isSafeInteger(folder.vaultNameIndexVersion) ? folder.vaultNameIndexVersion : null,
    boundedStringOrNull(folder.vaultImportJobId, 128),
    Number.isSafeInteger(folder.vaultLineageVersion) ? folder.vaultLineageVersion : null,
    Number.isSafeInteger(folder.vaultLineageGeneration) ? folder.vaultLineageGeneration : null
  ];
}

function assertOwnerDocuments(documents, uid, label) {
  const ids = new Set();
  for (const value of documents) {
    const document = record(value);
    if (document.ownerUid !== uid) {
      throw new TypeError(`${label} owner mismatch`);
    }
    const id = documentId(document);
    if (ids.has(id)) throw new TypeError(`Duplicate ${label} id`);
    ids.add(id);
  }
}

/**
 * Canonical, plaintext-free-at-rest preimage for the pr2 inventory fence.
 * The returned value exists only in memory; callers persist only SHA-256.
 */
export function canonicalVaultPathRewriteInventory(input) {
  const uid = stringOrNull(input?.uid);
  const notes = Array.isArray(input?.notes) ? input.notes : [];
  const folders = Array.isArray(input?.folders) ? input.folders : [];
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new TypeError("Invalid Vault inventory owner");
  }
  if (notes.length > 20_000 || folders.length > 2_000) {
    throw new RangeError("Vault path rewrite inventory exceeds its safe limit");
  }
  assertOwnerDocuments(notes, uid, "note");
  assertOwnerDocuments(folders, uid, "folder");

  const activeNotes = notes
    .filter((note) => activeOwnerNote(record(note)))
    .map(noteTuple)
    .sort(compareDocumentTuple);
  const ownerFolders = folders
    .map(folderTuple)
    .sort(compareDocumentTuple);
  const canonical = JSON.stringify([
    "quickmemo/vault-path-rewrite/inventory-v1",
    uid,
    activeNotes,
    ownerFolders
  ]);
  if (canonical.length > 32 * 1024 * 1024) {
    throw new RangeError("Vault path rewrite inventory preimage exceeds its safe limit");
  }
  return canonical;
}

export function validVaultPathRewriteInventoryFingerprint(value) {
  return typeof value === "string" && fingerprintPattern.test(value);
}

export const vaultPathRewriteInventoryLimits = Object.freeze({
  folders: 2_000,
  notes: 20_000
});
