export const firebaseAuthSessionDurationMs = 60 * 60 * 1000;

const authSessionStoragePrefix = "quickmemo-auth-session:";

function authSessionStorageKey(uid: string) {
  return `${authSessionStoragePrefix}${uid}`;
}

function readExpiresAt(uid: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const rawValue = window.sessionStorage.getItem(authSessionStorageKey(uid));
  const expiresAt = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;

  return Number.isFinite(expiresAt) ? expiresAt : null;
}

export function startFirebaseAuthSession(uid: string, expiresAt = Date.now() + firebaseAuthSessionDurationMs) {
  if (typeof window === "undefined") {
    return expiresAt;
  }

  window.sessionStorage.setItem(authSessionStorageKey(uid), String(expiresAt));
  return expiresAt;
}

export function ensureFirebaseAuthSession(uid: string, now = Date.now()) {
  const expiresAt = readExpiresAt(uid);

  if (!expiresAt) {
    return startFirebaseAuthSession(uid, now + firebaseAuthSessionDurationMs);
  }

  return expiresAt;
}

export function firebaseAuthSessionRemainingMs(uid: string, now = Date.now()) {
  const expiresAt = readExpiresAt(uid);

  return expiresAt ? expiresAt - now : null;
}

export function firebaseAuthSessionExpired(uid: string, now = Date.now()) {
  const remainingMs = firebaseAuthSessionRemainingMs(uid, now);

  return remainingMs !== null && remainingMs <= 0;
}

export function clearFirebaseAuthSession(uid: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(authSessionStorageKey(uid));
}
