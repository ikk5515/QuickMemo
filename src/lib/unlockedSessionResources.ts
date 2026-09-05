type SessionResourceCleanup = () => void;

// Only cleanup callbacks live here; no keys, note bodies, or browser storage.
const resourceCleanups = new Set<SessionResourceCleanup>();

export function registerUnlockedSessionResource(cleanup: SessionResourceCleanup) {
  resourceCleanups.add(cleanup);
  return () => { resourceCleanups.delete(cleanup); };
}

export function clearUnlockedSessionResources() {
  const cleanups = [...resourceCleanups];
  resourceCleanups.clear();
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // One resource must never prevent the remaining resources or auth key
      // from being cleared. Cleanup callbacks must be synchronous.
    }
  }
}
