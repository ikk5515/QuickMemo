export interface VaultIntegritySealInput {
  action: "seal-ready";
  expectedActiveNoteCount: number;
  expectedDeletedNoteCount: number;
  expectedFolderCount: number;
}

export interface VaultIntegritySealResult {
  activeNoteCount: number;
  cutoverVersion: 1;
  deletedNoteCount: number;
  folderCount: number;
  state: "ready";
  verifiedAt: string;
}

export const __vaultIntegrityTesting: {
  claimInventoryQuery(): Record<string, unknown>;
  folderInventoryQuery(uid: string): Record<string, unknown>;
  normalizeLegacyDeletionMetadata(
    context: { accessToken: string; projectId: string },
    uid: string
  ): Promise<{ normalizedCount: number }>;
  noteInventoryQuery(uid: string): Record<string, unknown>;
  performAction(
    context: { accessToken: string; projectId: string },
    uid: string,
    body: VaultIntegritySealInput
  ): Promise<VaultIntegritySealResult>;
  validateVaultIntegrityInventory(
    uid: string,
    inventory: {
      claims: Array<Record<string, unknown>>;
      folders: Array<Record<string, unknown>>;
      notes: Array<Record<string, unknown>>;
      treeDocument: Record<string, unknown> | null;
    },
    expected: Omit<VaultIntegritySealInput, "action">
  ): {
    activeNoteCount: number;
    deletedNoteCount: number;
    folderCount: number;
  };
};

export default function handler(request: unknown, response: unknown): Promise<void>;
