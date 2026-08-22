export interface AlreadyPersistedWorkspaceSaveInput<T> {
  debouncePending: boolean;
  pendingState: T | null;
  scheduledState: T;
}

export interface AlreadyPersistedWorkspaceSaveResult<T> {
  pendingState: T | null;
  savePending: boolean;
}

/**
 * A later render can enqueue the same serialized workspace while an earlier
 * write is still in flight. When the later task reaches the queue, the earlier
 * task has already persisted it. Clear only that exact queued object; a newer
 * workspace state or debounce must remain pending.
 */
export function resolveAlreadyPersistedWorkspaceSave<T>({
  debouncePending,
  pendingState,
  scheduledState
}: AlreadyPersistedWorkspaceSaveInput<T>): AlreadyPersistedWorkspaceSaveResult<T> {
  const nextPendingState = pendingState === scheduledState ? null : pendingState;
  return {
    pendingState: nextPendingState,
    savePending: nextPendingState !== null || debouncePending
  };
}
