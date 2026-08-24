export interface RevisionedEditableDraft {
  baseRevision: number;
  body: string;
  dirty: boolean;
  folderId: string | null;
  title: string;
}

export type PersistedRevisionRelation = "apply" | "current" | "superseded";

export function canonicalizeDraftTitle<T extends { title: string }>(draft: T): T {
  return { ...draft, title: draft.title.trim().normalize("NFC") };
}

export function persistedRevisionRelation(
  currentRevision: number | undefined,
  incomingRevision: number
): PersistedRevisionRelation {
  const current = currentRevision ?? 0;
  if (current > incomingRevision) return "superseded";
  if (current === incomingRevision) return "current";
  return "apply";
}

export function sameDraftPayload(
  left: Pick<RevisionedEditableDraft, "body" | "folderId" | "title">,
  right: Pick<RevisionedEditableDraft, "body" | "folderId" | "title">
): boolean {
  return left.body === right.body
    && left.folderId === right.folderId
    && left.title.trim().normalize("NFC") === right.title.trim().normalize("NFC");
}

export function captureRevisionedDraft<T extends RevisionedEditableDraft>(draft: T): RevisionedEditableDraft {
  return {
    baseRevision: draft.baseRevision,
    body: draft.body,
    dirty: draft.dirty,
    folderId: draft.folderId,
    title: draft.title
  };
}

export function sameRevisionedDraft(
  left: RevisionedEditableDraft | undefined,
  right: RevisionedEditableDraft
): boolean {
  return Boolean(
    left
    && left.baseRevision === right.baseRevision
    && left.dirty === right.dirty
    && sameDraftPayload(left, right)
  );
}

/**
 * Confirms a response-lost save only from an authoritative decrypted server
 * snapshot. A revision advancing by exactly one and an exact payload match
 * proves that one of the bounded submissions from this base became durable.
 */
export function findConfirmedDraftSubmission<T extends RevisionedEditableDraft>(
  persisted: Pick<RevisionedEditableDraft, "body" | "folderId" | "title"> & { revision: number },
  submissions: readonly T[]
): T | null {
  const confirmed = submissions.find((submission) => (
    persisted.revision === submission.baseRevision + 1
    && persisted.body === submission.body
    && persisted.folderId === submission.folderId
    && persisted.title === submission.title.trim().normalize("NFC")
  ));
  return confirmed ? canonicalizeDraftTitle(confirmed) : null;
}

/**
 * Advances a live edit buffer after an older snapshot was saved. Edits made
 * while the request was in flight stay dirty and are never replaced by the
 * submitted snapshot.
 */
export function reconcileDraftAfterSave<T extends RevisionedEditableDraft>(
  latest: T,
  submitted: Pick<T, "body" | "folderId" | "title">,
  savedRevision: number
): T {
  const canonicalSubmitted = canonicalizeDraftTitle(submitted);
  if (sameDraftPayload(latest, canonicalSubmitted)) {
    return {
      ...latest,
      ...canonicalSubmitted,
      baseRevision: savedRevision,
      dirty: false
    };
  }
  return {
    ...latest,
    baseRevision: savedRevision,
    dirty: true
  };
}

/**
 * Commits an explicitly selected merge only when the local buffer did not
 * change while the revision-aware request was in flight. Later keystrokes are
 * retained as a dirty draft based on the newly persisted merge.
 */
export function reconcileDraftAfterConflictSave<T extends RevisionedEditableDraft>(
  latest: T,
  capturedLocal: RevisionedEditableDraft,
  merged: Pick<T, "body" | "folderId" | "title">,
  savedRevision: number
): T {
  if (sameRevisionedDraft(latest, capturedLocal)) {
    const canonicalMerged = canonicalizeDraftTitle(merged);
    return {
      ...latest,
      ...canonicalMerged,
      baseRevision: savedRevision,
      dirty: false
    };
  }
  return {
    ...latest,
    baseRevision: savedRevision,
    dirty: true
  };
}
