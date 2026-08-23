export interface VaultPathRewriteInventoryInput {
  uid: string;
  notes: readonly Record<string, unknown>[];
  folders: readonly Record<string, unknown>[];
}

export function canonicalVaultPathRewriteInventory(
  input: VaultPathRewriteInventoryInput
): string;

export function validVaultPathRewriteInventoryFingerprint(value: unknown): value is string;

export const vaultPathRewriteInventoryLimits: Readonly<{
  folders: 2000;
  notes: 20000;
}>;
