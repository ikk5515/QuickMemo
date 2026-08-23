export interface VaultPathRewriteInventoryDocument extends Record<string, unknown> {
  id?: string;
  __id?: string;
  ownerUid?: string;
}

export function vaultPathRewriteInventoryFingerprint(
  uid: string,
  notes: readonly VaultPathRewriteInventoryDocument[],
  folders: readonly VaultPathRewriteInventoryDocument[]
): string;

export function vaultInventoryManifestBindingRoot(
  uid: string,
  marker: Record<string, unknown>,
  shards: readonly Record<string, unknown>[]
): string;

export function pathRewriteJobPath(uid: string, jobId: string): string;

export const __vaultPathRewriteActivationTesting: Readonly<Record<string, unknown>>;
