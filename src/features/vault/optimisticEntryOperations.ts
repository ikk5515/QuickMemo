export interface OptimisticVaultEntryPatch {
  folderId?: string | null;
  hidden?: boolean;
  operationId: number;
  title?: string;
}

interface VaultEntryProjectionTarget {
  folderId?: string | null;
  id: string;
  title: string;
}

/**
 * Projects only non-sensitive, in-memory explorer fields while a revisioned
 * server mutation is pending. Canonical decrypted entries, ciphertext,
 * revisions, and name reservations remain untouched and keep driving every
 * integrity/path-rewrite check.
 */
export function projectOptimisticVaultEntries<TEntry extends VaultEntryProjectionTarget>(
  entries: readonly TEntry[],
  patches: ReadonlyMap<string, OptimisticVaultEntryPatch>
) {
  if (patches.size === 0) return entries;
  const projected: TEntry[] = [];
  for (const entry of entries) {
    const patch = patches.get(entry.id);
    if (patch?.hidden) continue;
    projected.push(!patch
      ? entry
      : {
          ...entry,
          ...(Object.prototype.hasOwnProperty.call(patch, "folderId")
            ? { folderId: patch.folderId }
            : {}),
          ...(patch.title === undefined ? {} : { title: patch.title })
        });
  }
  return projected;
}

export function clearOptimisticVaultEntryPatch(
  patches: ReadonlyMap<string, OptimisticVaultEntryPatch>,
  entryId: string,
  operationId: number
) {
  if (patches.get(entryId)?.operationId !== operationId) return patches;
  const next = new Map(patches);
  next.delete(entryId);
  return next;
}
