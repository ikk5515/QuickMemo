export type PrivateKeyAutoLockGuard = () => boolean;

const guards = new Set<PrivateKeyAutoLockGuard>();

export function registerPrivateKeyAutoLockGuard(guard: PrivateKeyAutoLockGuard) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function shouldDelayPrivateKeyAutoLock() {
  for (const guard of guards) {
    try {
      if (guard()) {
        return true;
      }
    } catch {
      // A mounted encrypted workspace that cannot report its save state should
      // receive the same bounded grace as an explicitly pending save. The auth
      // boundary still locks after its fixed deadline.
      return true;
    }
  }
  return false;
}
