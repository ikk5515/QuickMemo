export type CreatableVaultEntryKind = "markdown" | "canvas" | "base";

export interface PendingVaultEntryCreation {
  entryId: string | null;
  kind: CreatableVaultEntryKind;
}
export interface VaultEntryCreationReadiness {
  activeEntryId: string | null;
  hasActiveDraft: boolean;
  hasActiveNote: boolean;
}

export function shouldReleaseVaultEntryCreation(
  pending: PendingVaultEntryCreation | null,
  readiness: VaultEntryCreationReadiness
): boolean {
  return pending?.entryId !== null
    && pending?.entryId !== undefined
    && readiness.activeEntryId === pending.entryId
    && readiness.hasActiveNote
    && readiness.hasActiveDraft;
}
