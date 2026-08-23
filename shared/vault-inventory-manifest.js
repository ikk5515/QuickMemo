import { canonicalVaultPathRewriteInventory } from "./vault-path-rewrite-inventory.js";

const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const identifierPattern = /^[A-Za-z0-9_-]{1,120}$/u;
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const maximumRevision = 999_999_999_999;

export const vaultInventoryManifestContract = Object.freeze({
  collectionId: "pathRewriteInventory",
  markerId: "marker",
  maximumEntriesPerShard: 1_200,
  shardCount: 32,
  shardIdPrefix: "shard-",
  version: 1
});

/**
 * Stored document contract (all values are opaque except ownership/version):
 *
 * marker: { ownerUid, version, epoch, shardCount, createdAt, updatedAt }
 * shard:  { ownerUid, version, epoch, shardIndex, revision, entries,
 *           root, createdAt, updatedAt }
 *
 * `entries` maps SHA-256/base64url entry-key digests to SHA-256/base64url
 * entry-token digests. A mutation reads exactly its target shard, validates
 * the stored `root` by hashing canonicalVaultInventoryManifestShard(), applies
 * the old->new token transition, increments `revision`, recomputes `root`, and
 * commits the source document plus shard in one Firestore transaction.
 */

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function validUid(value) {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= 128
    && !value.includes("/");
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximumRevision;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximumRevision;
}

function validTimestampLike(value) {
  if (typeof value === "string") return Number.isFinite(Date.parse(value));
  if (!value || typeof value !== "object") return false;
  try {
    return typeof value.toMillis === "function" && Number.isFinite(value.toMillis());
  } catch {
    return false;
  }
}

function documentId(value) {
  const candidate = record(value);
  const id = typeof candidate.id === "string"
    ? candidate.id
    : typeof candidate.__id === "string" ? candidate.__id : "";
  if (!identifierPattern.test(id)) {
    throw new TypeError("Invalid Vault inventory manifest entry id");
  }
  return id;
}

function storedDocumentId(value) {
  const candidate = record(value);
  return typeof candidate.__id === "string"
    ? candidate.__id
    : typeof candidate.id === "string" ? candidate.id : "";
}

function activeOwnerNote(value) {
  const note = record(value);
  return note.isDeleted !== true
    && note.isPurged !== true
    && note.secureShareCopyState !== "copying"
    && note.secureShareCopyState !== "aborted";
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validVaultInventoryManifestDigest(value) {
  return typeof value === "string" && digestPattern.test(value);
}

export function vaultInventoryManifestCollectionPath(uid) {
  if (!validUid(uid)) throw new TypeError("Invalid Vault inventory manifest owner");
  return `vaultMaintenanceJobs/${uid}/${vaultInventoryManifestContract.collectionId}`;
}

export function vaultInventoryManifestMarkerPath(uid) {
  return `${vaultInventoryManifestCollectionPath(uid)}/${vaultInventoryManifestContract.markerId}`;
}

export function vaultInventoryManifestShardId(shardIndex) {
  if (
    !Number.isSafeInteger(shardIndex)
    || shardIndex < 0
    || shardIndex >= vaultInventoryManifestContract.shardCount
  ) {
    throw new RangeError("Invalid Vault inventory manifest shard index");
  }
  return `${vaultInventoryManifestContract.shardIdPrefix}${String(shardIndex).padStart(2, "0")}`;
}

export function vaultInventoryManifestShardPath(uid, shardIndex) {
  return `${vaultInventoryManifestCollectionPath(uid)}/${vaultInventoryManifestShardId(shardIndex)}`;
}

/**
 * Hash this returned string with SHA-256/base64url. The digest is both the
 * opaque entry-map key and the shard selector input; plaintext ids are never
 * stored in the manifest documents.
 */
export function canonicalVaultInventoryManifestEntryKey(input) {
  const uid = input?.uid;
  const kind = input?.kind;
  if (!validUid(uid) || (kind !== "note" && kind !== "folder")) {
    throw new TypeError("Invalid Vault inventory manifest entry key");
  }
  const id = documentId(input?.document ?? { id: input?.id });
  return JSON.stringify([
    "quickmemo/vault-inventory-manifest/entry-key-v1",
    uid,
    kind,
    id
  ]);
}

/**
 * Hash this returned string with SHA-256/base64url to obtain an entry token.
 * A null result means the note is outside the active path-rewrite inventory.
 * The one-document canonical inventory intentionally reuses the pr2 tuple
 * normalization so browser and API generations cannot drift.
 */
export function canonicalVaultInventoryManifestEntryToken(input) {
  const uid = input?.uid;
  const kind = input?.kind;
  const document = record(input?.document);
  if (!validUid(uid) || (kind !== "note" && kind !== "folder")) {
    throw new TypeError("Invalid Vault inventory manifest entry token");
  }
  // Canonicalization validates owner/id/field bounds even for an inactive note.
  const canonical = canonicalVaultPathRewriteInventory({
    uid,
    notes: kind === "note" ? [document] : [],
    folders: kind === "folder" ? [document] : []
  });
  if (kind === "note" && !activeOwnerNote(document)) return null;
  return JSON.stringify([
    "quickmemo/vault-inventory-manifest/entry-token-v1",
    canonical
  ]);
}

export function vaultInventoryManifestShardIndexFromEntryKey(entryKeyDigest) {
  if (!validVaultInventoryManifestDigest(entryKeyDigest)) {
    throw new TypeError("Invalid Vault inventory manifest entry-key digest");
  }
  const firstSixBits = base64UrlAlphabet.indexOf(entryKeyDigest[0]);
  if (firstSixBits < 0) throw new TypeError("Invalid Vault inventory manifest entry-key digest");
  return firstSixBits % vaultInventoryManifestContract.shardCount;
}

function normalizedEntries(entries, shardIndex) {
  const source = record(entries);
  const keys = Object.keys(source).sort(compareStrings);
  if (keys.length > vaultInventoryManifestContract.maximumEntriesPerShard) {
    throw new RangeError("Vault inventory manifest shard exceeds its safe entry limit");
  }
  return keys.map((key) => {
    const token = source[key];
    if (
      !validVaultInventoryManifestDigest(key)
      || !validVaultInventoryManifestDigest(token)
      || vaultInventoryManifestShardIndexFromEntryKey(key) !== shardIndex
    ) {
      throw new TypeError("Invalid Vault inventory manifest shard entry");
    }
    return [key, token];
  });
}

/** Hash this canonical string to produce the stored shard `root`. */
export function canonicalVaultInventoryManifestShard(input) {
  const uid = input?.uid;
  const epoch = input?.epoch;
  const shardIndex = input?.shardIndex;
  const revision = input?.revision;
  if (
    !validUid(uid)
    || !validEpoch(epoch)
    || !validRevision(revision)
    || !Number.isSafeInteger(shardIndex)
    || shardIndex < 0
    || shardIndex >= vaultInventoryManifestContract.shardCount
  ) {
    throw new TypeError("Invalid Vault inventory manifest shard");
  }
  return JSON.stringify([
    "quickmemo/vault-inventory-manifest/shard-v1",
    uid,
    epoch,
    shardIndex,
    revision,
    normalizedEntries(input?.entries, shardIndex)
  ]);
}

function markerDocument(input, uid) {
  const marker = record(input);
  if (
    storedDocumentId(marker) !== vaultInventoryManifestContract.markerId
    || marker.ownerUid !== uid
    || marker.version !== vaultInventoryManifestContract.version
    || marker.shardCount !== vaultInventoryManifestContract.shardCount
    || !validEpoch(marker.epoch)
    || !validTimestampLike(marker.createdAt)
    || !validTimestampLike(marker.updatedAt)
  ) {
    throw new TypeError("Invalid Vault inventory manifest marker");
  }
  return marker;
}

function shardSummaryDocument(input, uid, epoch) {
  const shard = record(input);
  const shardIndex = shard.shardIndex;
  if (
    storedDocumentId(shard) !== vaultInventoryManifestShardId(shardIndex)
    || shard.ownerUid !== uid
    || shard.version !== vaultInventoryManifestContract.version
    || shard.epoch !== epoch
    || !validRevision(shard.revision)
    || !validVaultInventoryManifestDigest(shard.root)
    || !validTimestampLike(shard.createdAt)
    || !validTimestampLike(shard.updatedAt)
  ) {
    throw new TypeError("Invalid Vault inventory manifest shard summary");
  }
  return shard;
}

/**
 * Validates one marker plus all 32 shard summaries and returns a stable
 * canonical binding. Hash it with SHA-256/base64url for a pr3 job root.
 */
export function canonicalVaultInventoryManifestBinding(input) {
  const uid = input?.uid;
  if (!validUid(uid)) throw new TypeError("Invalid Vault inventory manifest owner");
  const marker = markerDocument(input?.marker, uid);
  const shards = Array.isArray(input?.shards) ? input.shards : [];
  if (shards.length !== vaultInventoryManifestContract.shardCount) {
    throw new TypeError("Vault inventory manifest is incomplete");
  }
  const normalized = shards
    .map((shard) => shardSummaryDocument(shard, uid, marker.epoch))
    .sort((left, right) => left.shardIndex - right.shardIndex);
  if (normalized.some((shard, index) => shard.shardIndex !== index)) {
    throw new TypeError("Vault inventory manifest shard set is invalid");
  }
  return JSON.stringify([
    "quickmemo/vault-inventory-manifest/binding-v1",
    uid,
    marker.epoch,
    vaultInventoryManifestContract.shardCount,
    normalized.map((shard) => [shard.shardIndex, shard.revision, shard.root])
  ]);
}
