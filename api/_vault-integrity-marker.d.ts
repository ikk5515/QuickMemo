export const VAULT_CUTOVER_VERSION: 1;
export const VAULT_INTEGRITY_STATES: Readonly<{
  pending: "pending";
  ready: "ready";
}>;

export interface ParsedVaultIntegrityMarker {
  document: Record<string, unknown>;
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
export function vaultIntegrityReadyFields(now: Date): {
  cutoverState: "ready";
  cutoverVersion: 1;
  updatedAt: Date;
  verifiedAt: Date;
};
