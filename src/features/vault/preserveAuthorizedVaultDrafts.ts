import type { NoteSnapshot } from "../../services/notes";
import { vaultNoteDecryptionAuthority } from "./vaultDecryptionSession";

interface DraftSessionScope {
  uid: string;
  privateKey: CryptoKey | null;
}

/**
 * A folder snapshot can hide one subtree without revoking another dirty note.
 * Carry only those edit buffers across the global cache wipe whose complete
 * note authority still exists in the new active encrypted inventory. This
 * never restores decrypted note caches, keys, workers, or in-flight saves.
 */
export function preserveAuthorizedVaultDrafts<
  Draft extends { dirty: boolean; baseRevision: number },
  Base extends { baseRevision: number }
>({ previousScope, currentScope, previousNotes, nextNotes, drafts, baseSnapshots }: {
  previousScope: DraftSessionScope;
  currentScope: DraftSessionScope;
  previousNotes: readonly NoteSnapshot[];
  nextNotes: readonly NoteSnapshot[];
  drafts: Readonly<Record<string, Draft>>;
  baseSnapshots: ReadonlyMap<string, Base>;
}) {
  const preservedDrafts: Record<string, Draft> = Object.create(null) as Record<string, Draft>;
  const preservedBases = new Map<string, Base>();
  const entryIds = new Set<string>();
  if (!currentScope.privateKey || currentScope.privateKey !== previousScope.privateKey
    || !currentScope.uid || currentScope.uid !== previousScope.uid) {
    return { drafts: preservedDrafts, baseSnapshots: preservedBases, entryIds };
  }
  const previousById = new Map(previousNotes.map((note) => [note.id, note]));
  const nextById = new Map(nextNotes.map((note) => [note.id, note]));
  for (const [entryId, draft] of Object.entries(drafts)) {
    if (!draft.dirty) continue;
    const previous = previousById.get(entryId);
    const next = nextById.get(entryId);
    if (!previous || !next || previous.isDeleted || previous.isPurged || next.isDeleted || next.isPurged) continue;
    const authority = vaultNoteDecryptionAuthority(previous, currentScope.uid);
    if (!authority || authority !== vaultNoteDecryptionAuthority(next, currentScope.uid)) continue;
    preservedDrafts[entryId] = { ...draft };
    entryIds.add(entryId);
    const base = baseSnapshots.get(entryId);
    if (base?.baseRevision === draft.baseRevision) preservedBases.set(entryId, { ...base });
  }
  return { drafts: preservedDrafts, baseSnapshots: preservedBases, entryIds };
}
