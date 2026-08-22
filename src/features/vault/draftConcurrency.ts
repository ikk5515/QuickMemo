export interface RevisionedEditableDraft {
  baseRevision: number;
  body: string;
  dirty: boolean;
  folderId: string | null;
  title: string;
}

export function sameDraftPayload(
  left: Pick<RevisionedEditableDraft, "body" | "folderId" | "title">,
  right: Pick<RevisionedEditableDraft, "body" | "folderId" | "title">
): boolean {
  return left.body === right.body
    && left.folderId === right.folderId
    && left.title === right.title;
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
 * Advances a live edit buffer after an older snapshot was saved. Edits made
 * while the request was in flight stay dirty and are never replaced by the
 * submitted snapshot.
 */
export function reconcileDraftAfterSave<T extends RevisionedEditableDraft>(
  latest: T,
  submitted: Pick<T, "body" | "folderId" | "title">,
  savedRevision: number
): T {
  return {
    ...latest,
    baseRevision: savedRevision,
    dirty: !sameDraftPayload(latest, submitted)
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
    return {
      ...latest,
      ...merged,
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
