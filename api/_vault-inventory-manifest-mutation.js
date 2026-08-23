import { createHash } from "node:crypto";
import {
  HttpError,
  cleanDocumentMetadata,
  createDocumentWrite,
  firestoreBatchGet,
  toFirestoreValue,
  updateDocumentWrite
} from "./_secure-share-common.js";
import {
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  validVaultInventoryManifestDigest,
  vaultInventoryManifestContract,
  vaultInventoryManifestMarkerPath,
  vaultInventoryManifestShardId,
  vaultInventoryManifestShardIndexFromEntryKey,
  vaultInventoryManifestShardPath
} from "../shared/vault-inventory-manifest.js";

const maximumRevision = 999_999_999_999;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function encodedManifestEntries(entries) {
  return {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(entries).map(([key, token]) => [key, toFirestoreValue(token)])
      )
    }
  };
}

function createManifestShardWrite(projectId, path, fields) {
  const { entries, ...rest } = fields;
  const write = createDocumentWrite(projectId, path, rest);
  write.update.fields.entries = encodedManifestEntries(entries);
  return write;
}

function updateManifestShardWrite(projectId, path, fields, updateTime) {
  const { entries, ...rest } = fields;
  const write = updateDocumentWrite(
    projectId,
    path,
    rest,
    [...Object.keys(rest), "entries"],
    updateTime
  );
  write.update.fields.entries = encodedManifestEntries(entries);
  return write;
}

function timestampLike(value) {
  if (typeof value === "string") return Number.isFinite(Date.parse(value));
  if (!value || typeof value !== "object") return false;
  try {
    return typeof value.toMillis === "function" && Number.isFinite(value.toMillis());
  } catch {
    return false;
  }
}

function manifestCorrupt(message = "Vault inventory manifest is invalid") {
  return new HttpError(409, "vault_inventory_manifest_invalid", message, { expose: false });
}

function assertMarker(marker, uid) {
  if (
    !marker
    || marker.__id !== vaultInventoryManifestContract.markerId
    || marker.ownerUid !== uid
    || marker.version !== vaultInventoryManifestContract.version
    || marker.shardCount !== vaultInventoryManifestContract.shardCount
    || !Number.isSafeInteger(marker.epoch)
    || marker.epoch < 1
    || marker.epoch > maximumRevision
    || !timestampLike(marker.createdAt)
    || !timestampLike(marker.updatedAt)
  ) {
    throw manifestCorrupt();
  }
  return marker;
}

function assertShard(shard, marker, uid, shardIndex) {
  if (
    !shard
    || shard.__id !== vaultInventoryManifestShardId(shardIndex)
    || shard.ownerUid !== uid
    || shard.version !== vaultInventoryManifestContract.version
    || shard.epoch !== marker.epoch
    || shard.shardIndex !== shardIndex
    || !Number.isSafeInteger(shard.revision)
    || shard.revision < 1
    || shard.revision >= maximumRevision
    || !validVaultInventoryManifestDigest(shard.root)
    || !timestampLike(shard.createdAt)
    || !timestampLike(shard.updatedAt)
    || !shard.entries
    || typeof shard.entries !== "object"
    || Array.isArray(shard.entries)
    || !shard.__updateTime
  ) {
    throw manifestCorrupt();
  }
  let actualRoot;
  try {
    actualRoot = digest(canonicalVaultInventoryManifestShard({
      uid,
      epoch: marker.epoch,
      entries: shard.entries,
      revision: shard.revision,
      shardIndex
    }));
  } catch {
    throw manifestCorrupt();
  }
  if (actualRoot !== shard.root) throw manifestCorrupt();
  return shard;
}

function documentForInventory(document, id) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  return { ...cleanDocumentMetadata(document), id };
}

function entryDigests(uid, kind, id, document) {
  const key = digest(canonicalVaultInventoryManifestEntryKey({ uid, kind, id }));
  const canonicalToken = document
    ? canonicalVaultInventoryManifestEntryToken({
        uid,
        kind,
        document: documentForInventory(document, id)
      })
    : null;
  return {
    key,
    token: canonicalToken === null ? null : digest(canonicalToken)
  };
}

function expectedEntryMaps(uid, notes, folders) {
  const maps = Array.from(
    { length: vaultInventoryManifestContract.shardCount },
    () => ({})
  );
  for (const [kind, documents] of [["note", notes], ["folder", folders]]) {
    for (const document of documents) {
      const id = typeof document?.__id === "string" ? document.__id : document?.id;
      const item = entryDigests(uid, kind, id, document);
      if (item.token === null) continue;
      const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(item.key);
      if (Object.prototype.hasOwnProperty.call(maps[shardIndex], item.key)) {
        throw manifestCorrupt("Vault inventory manifest contains a duplicate entry");
      }
      maps[shardIndex][item.key] = item.token;
    }
  }
  if (maps.some((entries) => (
    Object.keys(entries).length > vaultInventoryManifestContract.maximumEntriesPerShard
  ))) {
    throw new HttpError(
      409,
      "vault_inventory_manifest_capacity",
      "Vault inventory manifest shard exceeds its safe capacity"
    );
  }
  return maps;
}

function sameEntries(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && left[key] === right[key]
    ));
}

function inventoryAfterTransition(uid, notes, folders, transition) {
  if (!transition) return { folders, notes };
  const { kind, id, currentDocument, nextDocument } = transition;
  if ((kind !== "note" && kind !== "folder") || typeof id !== "string" || !id) {
    throw new TypeError("A valid Vault inventory bootstrap transition is required");
  }
  const source = kind === "note" ? notes : folders;
  const index = source.findIndex((document) => document?.__id === id || document?.id === id);
  if (index < 0) throw manifestCorrupt("Vault inventory bootstrap target is missing");
  const scanned = entryDigests(uid, kind, id, source[index]);
  const current = entryDigests(uid, kind, id, currentDocument);
  if (scanned.key !== current.key || scanned.token !== current.token) {
    throw manifestCorrupt("Vault inventory bootstrap target changed");
  }
  const nextSource = [...source];
  nextSource[index] = { ...cleanDocumentMetadata(nextDocument), id };
  return kind === "note"
    ? { folders, notes: nextSource }
    : { folders: nextSource, notes };
}

/**
 * First successful pr2 activation initializes the fixed manifest once. If it
 * already exists, the full legacy inventory must exactly match every opaque
 * shard map; partial or stale server state fails closed.
 */
export async function prepareVaultInventoryManifestBootstrap(
  context,
  transaction,
  uid,
  notes,
  folders,
  now,
  transition = null
) {
  const paths = [
    vaultInventoryManifestMarkerPath(uid),
    ...Array.from(
      { length: vaultInventoryManifestContract.shardCount },
      (_, shardIndex) => vaultInventoryManifestShardPath(uid, shardIndex)
    )
  ];
  const stored = await firestoreBatchGet(context, paths, transaction);
  const existingCount = stored.filter(Boolean).length;
  const currentEntryMaps = expectedEntryMaps(uid, notes, folders);
  if (existingCount === 0) {
    const nextInventory = inventoryAfterTransition(uid, notes, folders, transition);
    const entryMaps = expectedEntryMaps(uid, nextInventory.notes, nextInventory.folders);
    const epoch = 1;
    const marker = {
      createdAt: now,
      epoch,
      ownerUid: uid,
      shardCount: vaultInventoryManifestContract.shardCount,
      updatedAt: now,
      version: vaultInventoryManifestContract.version
    };
    const writes = [createDocumentWrite(
      context.projectId,
      vaultInventoryManifestMarkerPath(uid),
      marker
    )];
    for (let shardIndex = 0; shardIndex < vaultInventoryManifestContract.shardCount; shardIndex += 1) {
      const entries = entryMaps[shardIndex];
      const revision = 1;
      const root = digest(canonicalVaultInventoryManifestShard({
        uid,
        epoch,
        entries,
        revision,
        shardIndex
      }));
      writes.push(createManifestShardWrite(
        context.projectId,
        vaultInventoryManifestShardPath(uid, shardIndex),
        {
          createdAt: now,
          entries,
          epoch,
          ownerUid: uid,
          revision,
          root,
          shardIndex,
          updatedAt: now,
          version: vaultInventoryManifestContract.version
        }
      ));
    }
    return writes;
  }
  if (existingCount !== paths.length) throw manifestCorrupt();
  const marker = assertMarker(stored[0], uid);
  for (let shardIndex = 0; shardIndex < vaultInventoryManifestContract.shardCount; shardIndex += 1) {
    const shard = assertShard(stored[shardIndex + 1], marker, uid, shardIndex);
    if (!sameEntries(shard.entries, currentEntryMaps[shardIndex])) {
      throw manifestCorrupt("Vault inventory manifest does not match the owner inventory");
    }
  }
  return [];
}

/**
 * Returns the one opaque shard write that must be committed with a source
 * note/folder mutation. An uninitialized manifest deliberately yields no
 * write, but the missing marker and target shard are still transaction reads
 * so a concurrent first-time bootstrap conflicts and retries safely.
 */
export async function prepareVaultInventoryManifestMutation(
  context,
  transaction,
  input
) {
  const { uid, kind, id, currentDocument, nextDocument, now } = input ?? {};
  if (
    typeof uid !== "string"
    || !uid
    || uid.length > 128
    || uid.includes("/")
    || (kind !== "note" && kind !== "folder")
    || typeof id !== "string"
    || !id
    || id.length > 120
    || id.includes("/")
    || !(now instanceof Date)
    || !Number.isFinite(now.getTime())
  ) {
    throw new TypeError("A valid Vault inventory manifest mutation is required");
  }

  let digests;
  try {
    digests = entryDigests(uid, kind, id, nextDocument);
  } catch {
    throw manifestCorrupt("Vault inventory manifest mutation cannot be canonicalized");
  }
  const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(digests.key);
  const [marker, storedShard] = await firestoreBatchGet(
    context,
    [
      vaultInventoryManifestMarkerPath(uid),
      vaultInventoryManifestShardPath(uid, shardIndex)
    ],
    transaction
  );

  if (!marker && !storedShard) return [];
  if (!marker || !storedShard) throw manifestCorrupt();
  const validatedMarker = assertMarker(marker, uid);
  const shard = assertShard(storedShard, validatedMarker, uid, shardIndex);

  let currentDigests;
  try {
    currentDigests = entryDigests(uid, kind, id, currentDocument);
  } catch {
    throw manifestCorrupt("Vault inventory manifest source cannot be canonicalized");
  }
  if (currentDigests.key !== digests.key) throw manifestCorrupt();
  const storedToken = Object.prototype.hasOwnProperty.call(shard.entries, digests.key)
    ? shard.entries[digests.key]
    : null;
  if (storedToken !== currentDigests.token) {
    throw manifestCorrupt("Vault inventory manifest does not match the source document");
  }
  if (currentDigests.token === digests.token) return [];

  const entries = { ...shard.entries };
  if (digests.token === null) delete entries[digests.key];
  else entries[digests.key] = digests.token;
  if (Object.keys(entries).length > vaultInventoryManifestContract.maximumEntriesPerShard) {
    throw new HttpError(
      409,
      "vault_inventory_manifest_capacity",
      "Vault inventory manifest shard exceeds its safe capacity"
    );
  }
  const revision = shard.revision + 1;
  let root;
  try {
    root = digest(canonicalVaultInventoryManifestShard({
      uid,
      epoch: validatedMarker.epoch,
      entries,
      revision,
      shardIndex
    }));
  } catch {
    throw manifestCorrupt();
  }
  const fields = { entries, revision, root, updatedAt: now };
  return [updateManifestShardWrite(
    context.projectId,
    vaultInventoryManifestShardPath(uid, shardIndex),
    fields,
    shard.__updateTime
  )];
}

export function nextVaultInventoryDocument(currentDocument, update, deleteFields = []) {
  const next = {
    ...cleanDocumentMetadata(currentDocument),
    ...(update ?? {})
  };
  for (const field of deleteFields) delete next[field];
  return next;
}

export const __vaultInventoryManifestMutationTesting = Object.freeze({
  assertMarker,
  assertShard,
  createManifestShardWrite,
  digest,
  encodedManifestEntries,
  entryDigests,
  expectedEntryMaps,
  inventoryAfterTransition,
  sameEntries,
  updateManifestShardWrite
});
