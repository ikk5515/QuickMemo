import { bytesToBase64 } from "../../lib/crypto";
import { previewTextFromHtml } from "../../lib/editorContent";
import { db } from "../../lib/firebase";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import {
  collection,
  getDocsFromServer,
  limit,
  query,
  where
} from "firebase/firestore";
import {
  buildVaultPaths,
  resolvedNoteContentFormat,
  resolvedVaultEntryKind,
  vaultEntryPath,
  vaultEntryStorageIdentityState,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "./vaultData";
import type { RevisionedVaultIndexEntry } from "../knowledge";
import { canonicalVaultPathRewriteInventory } from "../../../shared/vault-path-rewrite-inventory.js";
import {
  canonicalVaultInventoryManifestBinding,
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  validVaultInventoryManifestDigest,
  vaultInventoryManifestCollectionPath,
  vaultInventoryManifestContract,
  vaultInventoryManifestShardIndexFromEntryKey
} from "../../../shared/vault-inventory-manifest.js";

const encoder = new TextEncoder();

export interface VaultPathRewriteInventoryManifestBinding {
  epoch: number;
  root: string;
  shardCount: number;
  version: number;
}

export type VaultPathRewriteInventoryBinding =
  | { inventoryFingerprint: string; inventoryManifest?: never }
  | { inventoryFingerprint?: never; inventoryManifest: VaultPathRewriteInventoryManifestBinding };

interface StoredVaultInventoryManifestDocument extends Record<string, unknown> {
  __id: string;
}

export class VaultPathRewriteInventoryInvalidError extends Error {
  readonly code = "vault_inventory_manifest_invalid";

  constructor(message: string) {
    super(message);
    this.name = "VaultPathRewriteInventoryInvalidError";
  }
}

export class VaultPathRewriteInventorySnapshotLagError extends Error {
  readonly code = "vault_inventory_manifest_snapshot_lag";

  constructor() {
    super("서버 Vault 경로 인벤토리가 현재 암호화 스냅샷보다 앞서 있습니다.");
    this.name = "VaultPathRewriteInventorySnapshotLagError";
  }
}

function base64Url(bytes: ArrayBuffer) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameOpaqueEntries(left: Record<string, string>, right: Record<string, string>) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

async function expectedManifestEntryMaps(input: {
  uid: string;
  notes: readonly NoteSnapshot[];
  folders: readonly NoteFolderSnapshot[];
}) {
  const maps = Array.from(
    { length: vaultInventoryManifestContract.shardCount },
    () => ({} as Record<string, string>)
  );
  const documents: Array<{ document: Record<string, unknown>; kind: "note" | "folder" }> = [
    ...input.notes.map((document) => ({
      document: document as unknown as Record<string, unknown>,
      kind: "note" as const
    })),
    ...input.folders.map((document) => ({
      document: document as unknown as Record<string, unknown>,
      kind: "folder" as const
    }))
  ];

  // Bound WebCrypto fan-out so a large Vault cannot monopolize the UI task
  // queue while the fixed manifest is being verified.
  const batchSize = 128;
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const digests = await Promise.all(documents.slice(offset, offset + batchSize).map(async ({ document, kind }) => {
      const key = await sha256(canonicalVaultInventoryManifestEntryKey({
        uid: input.uid,
        kind,
        document
      }));
      const canonicalToken = canonicalVaultInventoryManifestEntryToken({
        uid: input.uid,
        kind,
        document
      });
      return {
        key,
        token: canonicalToken === null ? null : await sha256(canonicalToken)
      };
    }));
    for (const item of digests) {
      if (item.token === null) continue;
      const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(item.key);
      if (Object.prototype.hasOwnProperty.call(maps[shardIndex], item.key)) {
        throw new VaultPathRewriteInventoryInvalidError(
          "Vault 경로 인벤토리에 중복된 불투명 항목이 있습니다."
        );
      }
      maps[shardIndex][item.key] = item.token;
    }
  }
  return maps;
}

/**
 * Verifies a server-confirmed marker plus every fixed shard against the exact
 * encrypted subscription generation used by the path planner. Partial,
 * malformed, stale, or extra manifest state fails closed; only a completely
 * absent collection may use the one-time pr2 bootstrap path.
 */
export async function verifyVaultPathRewriteInventoryManifest(input: {
  uid: string;
  notes: readonly NoteSnapshot[];
  folders: readonly NoteFolderSnapshot[];
  documents: readonly StoredVaultInventoryManifestDocument[];
}): Promise<VaultPathRewriteInventoryManifestBinding | null> {
  if (input.documents.length === 0) return null;
  if (input.documents.length !== vaultInventoryManifestContract.shardCount + 1) {
    throw new VaultPathRewriteInventoryInvalidError(
      "Vault 경로 인벤토리가 일부만 준비되어 있어 변경을 안전하게 시작할 수 없습니다."
    );
  }
  const marker = input.documents.find((document) => (
    document.__id === vaultInventoryManifestContract.markerId
  ));
  const shards = input.documents.filter((document) => (
    document.__id !== vaultInventoryManifestContract.markerId
  ));
  if (!marker || shards.length !== vaultInventoryManifestContract.shardCount) {
    throw new VaultPathRewriteInventoryInvalidError(
      "Vault 경로 인벤토리 문서 구성이 올바르지 않습니다."
    );
  }

  let canonicalBinding: string;
  try {
    canonicalBinding = canonicalVaultInventoryManifestBinding({
      uid: input.uid,
      marker,
      shards
    });
  } catch {
    throw new VaultPathRewriteInventoryInvalidError(
      "Vault 경로 인벤토리 서명을 확인할 수 없습니다."
    );
  }
  const expectedMaps = await expectedManifestEntryMaps(input);
  for (let shardIndex = 0; shardIndex < vaultInventoryManifestContract.shardCount; shardIndex += 1) {
    const shardId = `${vaultInventoryManifestContract.shardIdPrefix}${String(shardIndex).padStart(2, "0")}`;
    const shard = shards.find((candidate) => candidate.__id === shardId);
    const entries = objectRecord(shard?.entries);
    if (
      !shard
      || shard.shardIndex !== shardIndex
      || !Number.isSafeInteger(shard.revision)
      || typeof shard.root !== "string"
      || !validVaultInventoryManifestDigest(shard.root)
      || !entries
    ) {
      throw new VaultPathRewriteInventoryInvalidError(
        "Vault 경로 인벤토리 shard를 확인할 수 없습니다."
      );
    }
    const typedEntries: Record<string, string> = {};
    for (const [key, token] of Object.entries(entries)) {
      if (!validVaultInventoryManifestDigest(key) || !validVaultInventoryManifestDigest(token)) {
        throw new VaultPathRewriteInventoryInvalidError(
          "Vault 경로 인벤토리 항목이 손상되었습니다."
        );
      }
      typedEntries[key] = token;
    }
    let actualShardRoot: string;
    try {
      actualShardRoot = await sha256(canonicalVaultInventoryManifestShard({
        uid: input.uid,
        epoch: marker.epoch as number,
        entries: typedEntries,
        revision: shard.revision as number,
        shardIndex
      }));
    } catch {
      throw new VaultPathRewriteInventoryInvalidError(
        "Vault 경로 인벤토리 shard 서명을 확인할 수 없습니다."
      );
    }
    if (actualShardRoot !== shard.root) {
      throw new VaultPathRewriteInventoryInvalidError(
        "Vault 경로 인벤토리 shard 서명이 저장된 root와 일치하지 않습니다."
      );
    }
    if (!sameOpaqueEntries(typedEntries, expectedMaps[shardIndex])) {
      throw new VaultPathRewriteInventorySnapshotLagError();
    }
  }
  return {
    epoch: marker.epoch as number,
    root: await sha256(canonicalBinding),
    shardCount: vaultInventoryManifestContract.shardCount,
    version: vaultInventoryManifestContract.version
  };
}

export async function loadVaultPathRewriteInventoryBinding(input: {
  uid: string;
  notes: readonly NoteSnapshot[];
  folders: readonly NoteFolderSnapshot[];
}): Promise<VaultPathRewriteInventoryBinding> {
  const path = vaultInventoryManifestCollectionPath(input.uid).split("/");
  const snapshot = await getDocsFromServer(query(
    collection(db, path[0], path[1], path[2]),
    where("ownerUid", "==", input.uid),
    limit(vaultInventoryManifestContract.shardCount + 2)
  ));
  const documents = snapshot.docs.map((document) => ({
    __id: document.id,
    ...document.data()
  }));
  const inventoryManifest = await verifyVaultPathRewriteInventoryManifest({
    ...input,
    documents
  });
  if (inventoryManifest) return { inventoryManifest };
  return {
    inventoryFingerprint: await vaultPathRewriteInventoryFingerprint(input)
  };
}

function compareTupleId(left: readonly unknown[], right: readonly unknown[]) {
  const leftId = String(left[0]);
  const rightId = String(right[0]);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function rawNoteGenerationTuple(note: NoteSnapshot) {
  return [
    note.id,
    note.revision ?? 0,
    note.folderId ?? null,
    note.type,
    resolvedNoteContentFormat(note),
    resolvedVaultEntryKind(note)
  ] as const;
}

function decryptedNoteGenerationTuple(note: DecryptedVaultNote) {
  return [
    note.id,
    note.revision ?? 0,
    note.folderId ?? null,
    note.type,
    note.contentFormat,
    note.entryKind
  ] as const;
}

function rawFolderGenerationTuple(folder: NoteFolderSnapshot) {
  return [folder.id, folder.revision ?? 0, folder.parentId ?? null] as const;
}

function decryptedFolderGenerationTuple(folder: DecryptedVaultFolder) {
  return [folder.id, folder.revision ?? 0, folder.parentId ?? null] as const;
}

function encryptedPayloadMatches(
  left: NoteSnapshot["encryptedBody"] | undefined,
  right: NoteSnapshot["encryptedBody"] | undefined
) {
  return Boolean(left && right)
    && left?.algorithm === right?.algorithm
    && left?.cipherText === right?.cipherText
    && left?.iv === right?.iv
    && left?.version === right?.version;
}

function wrappedKeyMatches(
  left: NoteSnapshot["wrappedKeys"][string] | undefined,
  right: NoteSnapshot["wrappedKeys"][string] | undefined
) {
  return Boolean(left && right)
    && left?.algorithm === right?.algorithm
    && left?.version === right?.version
    && left?.wrappedKey === right?.wrappedKey;
}

function optionalEncryptedPayloadMatches(
  left: NoteSnapshot["encryptedBody"] | undefined,
  right: NoteSnapshot["encryptedBody"] | undefined
) {
  return left === undefined && right === undefined
    ? true
    : encryptedPayloadMatches(left, right);
}

function optionalWrappedKeyMatches(
  left: NoteSnapshot["wrappedKeys"][string] | undefined,
  right: NoteSnapshot["wrappedKeys"][string] | undefined
) {
  return left === undefined && right === undefined
    ? true
    : wrappedKeyMatches(left, right);
}

/**
 * Proves that plaintext used by the rewrite planner belongs to the same
 * server-complete subscription generation as its raw encrypted snapshots.
 * Ciphertext and the current-user wrapped key are compared directly without
 * serializing them into the tuple. This rejects an optimistic plaintext row
 * whose revision advanced locally before the authoritative subscription sent
 * the matching ciphertext.
 */
export function vaultPathRewriteGenerationAligned(input: {
  uid: string;
  rawNotes: readonly NoteSnapshot[];
  rawFolders: readonly NoteFolderSnapshot[];
  decryptedNotes: readonly DecryptedVaultNote[];
  decryptedFolders: readonly DecryptedVaultFolder[];
}) {
  if (
    input.rawNotes.some((note) => note.ownerUid !== input.uid)
    || input.rawFolders.some((folder) => folder.ownerUid !== input.uid)
    || input.decryptedNotes.some((note) => note.ownerUid !== input.uid)
    || input.decryptedFolders.some((folder) => folder.ownerUid !== input.uid)
    || input.rawNotes.some((note) => vaultEntryStorageIdentityState(note) === "invalid")
  ) {
    return false;
  }
  const decryptedNoteById = new Map(input.decryptedNotes.map((note) => [note.id, note]));
  if (input.rawNotes.some((raw) => {
    const decrypted = decryptedNoteById.get(raw.id);
    return !decrypted
      || !encryptedPayloadMatches(raw.encryptedTitle, decrypted.encryptedTitle)
      || !encryptedPayloadMatches(raw.encryptedBody, decrypted.encryptedBody)
      || !wrappedKeyMatches(raw.wrappedKeys?.[input.uid], decrypted.wrappedKeys?.[input.uid]);
  })) {
    return false;
  }
  const decryptedFolderById = new Map(input.decryptedFolders.map((folder) => [folder.id, folder]));
  if (input.rawFolders.some((raw) => {
    const decrypted = decryptedFolderById.get(raw.id);
    return !decrypted
      || !optionalEncryptedPayloadMatches(raw.encryptedName, decrypted.encryptedName)
      || !optionalWrappedKeyMatches(raw.wrappedKey, decrypted.wrappedKey)
      || (raw.encryptedName === undefined && raw.wrappedKey === undefined && raw.name !== decrypted.displayName);
  })) {
    return false;
  }
  const rawNotes = input.rawNotes.map(rawNoteGenerationTuple).sort(compareTupleId);
  const decryptedNotes = input.decryptedNotes.map(decryptedNoteGenerationTuple).sort(compareTupleId);
  const rawFolders = input.rawFolders.map(rawFolderGenerationTuple).sort(compareTupleId);
  const decryptedFolders = input.decryptedFolders.map(decryptedFolderGenerationTuple).sort(compareTupleId);
  return JSON.stringify(rawNotes) === JSON.stringify(decryptedNotes)
    && JSON.stringify(rawFolders) === JSON.stringify(decryptedFolders);
}

export async function vaultPathRewriteInventoryFingerprint(input: {
  uid: string;
  notes: readonly NoteSnapshot[];
  folders: readonly NoteFolderSnapshot[];
}) {
  const canonical = canonicalVaultPathRewriteInventory({
    uid: input.uid,
    notes: input.notes as unknown as readonly Record<string, unknown>[],
    folders: input.folders as unknown as readonly Record<string, unknown>[]
  });
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)));
}

function timestampMillis(value: DecryptedVaultNote["updatedAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : undefined;
}

/** Builds the plaintext index only after its raw subscription generation matches exactly. */
export async function buildAlignedVaultPathRewriteIndex(input: {
  uid: string;
  rawVisibleNotes: readonly NoteSnapshot[];
  rawActiveFolders: readonly NoteFolderSnapshot[];
  decryptedNotes: readonly DecryptedVaultNote[];
  decryptedFolders: readonly DecryptedVaultFolder[];
}) {
  if (!vaultPathRewriteGenerationAligned({
    uid: input.uid,
    rawNotes: input.rawVisibleNotes,
    rawFolders: input.rawActiveFolders,
    decryptedNotes: input.decryptedNotes,
    decryptedFolders: input.decryptedFolders
  })) return null;
  const folderPaths = buildVaultPaths([...input.decryptedFolders]);
  const entries = input.decryptedNotes.map((note): RevisionedVaultIndexEntry => ({
    id: note.id,
    path: vaultEntryPath(note, folderPaths),
    kind: note.entryKind,
    content: note.entryKind === "asset"
      ? undefined
      : note.contentFormat === "legacy-html-v1"
        ? previewTextFromHtml(note.body)
        : note.body,
    createdAt: timestampMillis(note.createdAt),
    updatedAt: timestampMillis(note.updatedAt),
    revision: note.revision ?? 0
  }));
  return { entries, folderPaths };
}
