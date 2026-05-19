const authSessionStorageKey = "quickmemo-auth-session";
const authSessionVersion = 1;

export const firebaseAuthSessionDurationMs = 60 * 60 * 1000;

interface AuthSessionRecord {
  createdAt: number;
  expiresAt: number;
  uid: string;
  version: number;
}

function storage() {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readRecord() {
  const store = storage();

  if (!store) {
    return null;
  }

  try {
    const parsed = JSON.parse(store.getItem(authSessionStorageKey) || "null") as Partial<AuthSessionRecord> | null;

    if (
      !parsed ||
      parsed.version !== authSessionVersion ||
      typeof parsed.uid !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.expiresAt !== "number"
    ) {
      store.removeItem(authSessionStorageKey);
      return null;
    }

    return parsed as AuthSessionRecord;
  } catch {
    store.removeItem(authSessionStorageKey);
    return null;
  }
}

export function startAuthSession(uid: string, now = Date.now()) {
  const record: AuthSessionRecord = {
    createdAt: now,
    expiresAt: now + firebaseAuthSessionDurationMs,
    uid,
    version: authSessionVersion
  };

  storage()?.setItem(authSessionStorageKey, JSON.stringify(record));
  return record;
}

export function clearAuthSession() {
  storage()?.removeItem(authSessionStorageKey);
}

export function readAuthSession(uid: string, now = Date.now()) {
  const record = readRecord();

  if (!record || record.uid !== uid || record.expiresAt <= now) {
    clearAuthSession();
    return null;
  }

  return record;
}

