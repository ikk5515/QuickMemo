export interface VaultIntegrityLeaseInput {
  leaseGeneration: string;
  leaseId: string;
}

export interface VaultIntegrityReconcileInput {
  action: "reconcile-stale-claims";
  leaseId: string;
}

export interface VaultIntegrityRenewInput extends VaultIntegrityLeaseInput {
  action: "renew-cutover-lease";
}

export interface VaultIntegrityReleaseInput extends VaultIntegrityLeaseInput {
  action: "release-cutover-lease";
}

export interface VaultIntegritySealInput extends VaultIntegrityLeaseInput {
  action: "seal-ready";
  expectedActiveNoteCount: number;
  expectedDeletedNoteCount: number;
  expectedFolderCount: number;
}

export interface VaultIntegrityReconcileResult {
  hasMore: boolean;
  leaseGeneration: string;
  observedClaimCount: number;
  removedClaimCount: number;
  state: "pending";
}

export interface VaultIntegrityRenewResult {
  leaseExpiresInSeconds: number;
  state: "pending" | "ready";
}

export interface VaultIntegrityReleaseResult {
  released: boolean;
  state: "released";
}

export interface VaultIntegritySealResult {
  activeNoteCount: number;
  cutoverVersion: 1;
  deletedNoteCount: number;
  folderCount: number;
  state: "ready";
  verifiedAt: string;
}

export type VaultIntegrityActionInput =
  | VaultIntegrityReconcileInput
  | VaultIntegrityReleaseInput
  | VaultIntegrityRenewInput
  | VaultIntegritySealInput;

export type VaultIntegrityActionResult =
  | VaultIntegrityReconcileResult
  | VaultIntegrityReleaseResult
  | VaultIntegrityRenewResult
  | VaultIntegritySealResult;

interface VaultIntegrityInventory {
  claims: Array<Record<string, unknown>>;
  folders: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
}

interface VaultIntegrityContext {
  accessToken: string;
  projectId: string;
}

interface ServerLeaseCredential {
  generation: string;
  hash: string;
}

export const VAULT_INTEGRITY_OPERATION_BOUNDS: Readonly<{
  lease: Readonly<{
    maximumDocumentReads: number;
    maximumDocumentWrites: number;
    retryAfterSeconds: number;
    ttlSeconds: number;
  }>;
  reconcile: Readonly<{
    maximumClaimlessDocumentReads: number;
    maximumDocumentReads: number;
    maximumDocumentWrites: number;
  }>;
  seal: Readonly<{
    maximumFastPathDocumentReads: number;
    maximumDocumentReads: number;
    maximumDocumentWrites: number;
  }>;
}>;

export const __vaultIntegrityTesting: {
  claimInventoryQuery(): Record<string, unknown>;
  folderInventoryQuery(uid: string): Record<string, unknown>;
  noteInventoryQuery(uid: string): Record<string, unknown>;
  operationBounds: typeof VAULT_INTEGRITY_OPERATION_BOUNDS;
  performAction(
    context: VaultIntegrityContext,
    uid: string,
    body: VaultIntegrityActionInput
  ): Promise<VaultIntegrityActionResult>;
  reconcileStaleClaims(
    context: VaultIntegrityContext,
    uid: string,
    lease: ServerLeaseCredential
  ): Promise<VaultIntegrityReconcileResult>;
  releaseCutoverLease(
    context: VaultIntegrityContext,
    uid: string,
    lease: ServerLeaseCredential
  ): Promise<boolean>;
  renewHeldCutoverLease(
    context: VaultIntegrityContext,
    uid: string,
    lease: ServerLeaseCredential
  ): Promise<{ state: "pending" | "ready" }>;
  staleClaimDocuments(
    uid: string,
    inventory: VaultIntegrityInventory
  ): Array<{
    document: Record<string, unknown>;
    value: {
      claimId: string;
      parentId: string | null;
      targetId: string;
      targetType: "entry" | "folder";
    };
  }>;
  validateVaultIntegrityInventory(
    uid: string,
    inventory: VaultIntegrityInventory & {
      treeDocument: Record<string, unknown> | null;
    },
    expected: Pick<
      VaultIntegritySealInput,
      "expectedActiveNoteCount" | "expectedDeletedNoteCount" | "expectedFolderCount"
    >
  ): {
    activeNoteCount: number;
    deletedNoteCount: number;
    folderCount: number;
  };
};

export default function handler(request: unknown, response: unknown): Promise<void>;
