// Remote encrypted saves perform WebCrypto, history snapshot generation and a
// revision-aware API mutation. A short thinking pause must not overlap those
// tasks with the next IME/wiki-link input burst. Explicit save/navigation
// still flushes immediately.
export const MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS = 5_000;
// Canvas text editing rebuilds a JSON document draft locally on every change.
// Keep the encrypted network write well outside an ordinary typing pause so a
// one-character edit cannot immediately put the card through save/reconcile.
// Navigation, tab changes and the explicit Save action still flush the dirty
// draft immediately, and beforeunload protection remains the final safety net.
export const CANVAS_ENTRY_AUTOSAVE_IDLE_MS = 15_000;
const MAXIMUM_ENTRY_AUTOSAVE_RETRY_ATTEMPTS = 5;

export function vaultEntryAutosaveIdleMs(entryKind: string | undefined) {
  return entryKind === "canvas"
    ? CANVAS_ENTRY_AUTOSAVE_IDLE_MS
    : MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS;
}

/**
 * Retries a failed encrypted save quickly enough to self-heal a short outage,
 * while a strict cap prevents a validation/auth failure from polling forever.
 */
export function entryAutosaveRetryDelayMs(failureCount: number) {
  if (
    !Number.isSafeInteger(failureCount)
    || failureCount < 1
    || failureCount > MAXIMUM_ENTRY_AUTOSAVE_RETRY_ATTEMPTS
  ) return null;
  return 1_000 * (2 ** (failureCount - 1));
}

export interface EntryIdleDebounceClock {
  clearTimeout(handle: number): void;
  setTimeout(task: () => void, delayMs: number): number;
}

interface PendingEntryIdleTask {
  handle: number;
  version: unknown;
}

/**
 * Keeps one independent idle timer per Vault entry. A change in one entry
 * never extends another entry's save deadline, while an unchanged render does
 * not restart its timer.
 */
export class EntryIdleDebounce {
  private readonly pending = new Map<string, PendingEntryIdleTask>();

  constructor(private readonly clock: EntryIdleDebounceClock = {
    clearTimeout: (handle) => window.clearTimeout(handle),
    setTimeout: (task, delayMs) => window.setTimeout(task, delayMs)
  }) {}

  schedule(entryId: string, version: unknown, delayMs: number, task: () => void) {
    const current = this.pending.get(entryId);
    if (current?.version === version) {
      return;
    }
    if (current) {
      this.clock.clearTimeout(current.handle);
    }
    let handle = 0;
    handle = this.clock.setTimeout(() => {
      if (this.pending.get(entryId)?.handle !== handle) {
        return;
      }
      this.pending.delete(entryId);
      task();
    }, delayMs);
    this.pending.set(entryId, { handle, version });
  }

  cancel(entryId: string) {
    const current = this.pending.get(entryId);
    if (!current) {
      return;
    }
    this.clock.clearTimeout(current.handle);
    this.pending.delete(entryId);
  }

  retain(entryIds: ReadonlySet<string>) {
    for (const entryId of this.pending.keys()) {
      if (!entryIds.has(entryId)) {
        this.cancel(entryId);
      }
    }
  }

  cancelAll() {
    for (const entryId of [...this.pending.keys()]) {
      this.cancel(entryId);
    }
  }

  has(entryId: string) {
    return this.pending.has(entryId);
  }
}
