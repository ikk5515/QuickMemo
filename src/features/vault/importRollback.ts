export interface CreatedVaultImportEntry {
  noteId: string;
  revision: number;
}

export interface VaultImportRollbackResult {
  attempted: number;
  cleanupFailed: number;
  softDeleted: number;
}

/**
 * Runs a compensating revision-aware soft-delete for entries created by the
 * current import, newest first. This is not an atomic rollback: the encrypted
 * note document, delete history, and quota usage remain, and folders are not
 * deleted by this operation.
 */
export async function compensateCreatedVaultImportEntries(
  entries: readonly CreatedVaultImportEntry[],
  softDelete: (entry: CreatedVaultImportEntry) => Promise<unknown>
): Promise<VaultImportRollbackResult> {
  let cleanupFailed = 0;
  let softDeleted = 0;
  for (const entry of [...entries].reverse()) {
    try {
      await softDelete(entry);
      softDeleted += 1;
    } catch {
      cleanupFailed += 1;
    }
  }
  return { attempted: entries.length, cleanupFailed, softDeleted };
}
