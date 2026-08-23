export const VAULT_CUTOVER_VERSION: 1;
export const VAULT_INTEGRITY_STATES: Readonly<{
  pending: "pending";
  ready: "ready";
}>;
export const VAULT_CUTOVER_LEASE_FIELD_PATHS: readonly [
  "cutoverLeaseAcquiredAt",
  "cutoverLeaseExpiresAt",
  "cutoverLeaseGeneration",
  "cutoverLeaseHash",
  "cutoverLeaseVersion"
];

export interface VaultCutoverLeaseCredential {
  generation: string;
  hash: string;
}

export interface ParsedVaultCutoverLease extends VaultCutoverLeaseCredential {
  acquiredAt: string;
  expiresAt: number;
  version: 1;
}

export interface ParsedVaultIntegrityMarker {
  document: Record<string, unknown>;
  lease?: ParsedVaultCutoverLease;
  legacy: boolean;
  state: "pending" | "ready";
}

export function integrityPath(uid: string): string;
export function claimPath(uid: string, claimId: string): string;
export function parseVaultIntegrityMarker(
  marker: unknown,
  uid: string
): ParsedVaultIntegrityMarker;
export function requireVaultIntegrityMarker(
  marker: unknown,
  uid: string,
  requirement?: "any" | "pending" | "ready"
): ParsedVaultIntegrityMarker;
export function requireVaultCutoverLease(
  marker: unknown,
  uid: string,
  credential: VaultCutoverLeaseCredential,
  nowMilliseconds?: number
): ParsedVaultIntegrityMarker & { lease: ParsedVaultCutoverLease };
export function vaultCutoverLeaseCredential(
  leaseId: string,
  leaseGeneration: string
): VaultCutoverLeaseCredential;
export function vaultIntegrityReadyFields(now: Date): {
  cutoverState: "ready";
  cutoverVersion: 1;
  updatedAt: Date;
  verifiedAt: Date;
};
