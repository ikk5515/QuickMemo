export interface VaultInventoryManifestDocument extends Record<string, unknown> {
  id?: string;
  __id?: string;
  ownerUid?: string;
}

export interface VaultInventoryManifestContract {
  collectionId: string;
  markerId: string;
  maximumEntriesPerShard: number;
  shardCount: number;
  shardIdPrefix: string;
  version: number;
}

export const vaultInventoryManifestContract: Readonly<VaultInventoryManifestContract>;

export function validVaultInventoryManifestDigest(value: unknown): value is string;
export function vaultInventoryManifestCollectionPath(uid: string): string;
export function vaultInventoryManifestMarkerPath(uid: string): string;
export function vaultInventoryManifestShardId(shardIndex: number): string;
export function vaultInventoryManifestShardPath(uid: string, shardIndex: number): string;

export function canonicalVaultInventoryManifestEntryKey(input: {
  uid: string;
  kind: "note" | "folder";
  id?: string;
  document?: VaultInventoryManifestDocument;
}): string;

export function canonicalVaultInventoryManifestEntryToken(input: {
  uid: string;
  kind: "note" | "folder";
  document: VaultInventoryManifestDocument;
}): string | null;

export function vaultInventoryManifestShardIndexFromEntryKey(entryKeyDigest: string): number;

export function canonicalVaultInventoryManifestShard(input: {
  uid: string;
  epoch: number;
  shardIndex: number;
  revision: number;
  entries: Record<string, string>;
}): string;

export function canonicalVaultInventoryManifestBinding(input: {
  uid: string;
  marker: VaultInventoryManifestDocument;
  shards: readonly VaultInventoryManifestDocument[];
}): string;
