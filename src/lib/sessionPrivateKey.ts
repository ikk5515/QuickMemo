const legacyDatabaseName = "quickmemo-private-key-session";

export const privateKeySessionDurationMs = 60 * 60 * 1000;

interface SessionPrivateKeyRecord {
  expiresAt: number;
  privateKey: CryptoKey;
  uid: string;
}

const sessionPrivateKeys = new Map<string, SessionPrivateKeyRecord>();
let legacyDatabaseDeleteComplete = false;
let legacyDatabaseDeletePromise: Promise<void> | null = null;

export async function readSessionPrivateKey(uid: string, now = Date.now()) {
  await deletePersistedSessionPrivateKeyStore();

  const record = sessionPrivateKeys.get(uid);

  if (!record || record.uid !== uid || record.expiresAt <= now) {
    sessionPrivateKeys.delete(uid);
    return null;
  }

  return record.privateKey;
}

export async function writeSessionPrivateKey(uid: string, privateKey: CryptoKey, expiresAt = Date.now() + privateKeySessionDurationMs) {
  await deletePersistedSessionPrivateKeyStore();
  sessionPrivateKeys.set(uid, { expiresAt, privateKey, uid });
}

export async function deleteSessionPrivateKey(uid: string) {
  sessionPrivateKeys.delete(uid);
  await deletePersistedSessionPrivateKeyStore();
}

export async function deletePersistedSessionPrivateKeyStore() {
  if (legacyDatabaseDeleteComplete || typeof indexedDB === "undefined") {
    return;
  }

  if (legacyDatabaseDeletePromise) {
    return legacyDatabaseDeletePromise;
  }

  legacyDatabaseDeletePromise = new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(legacyDatabaseName);

    request.addEventListener("success", () => {
      legacyDatabaseDeleteComplete = true;
      legacyDatabaseDeletePromise = null;
      resolve();
    });
    request.addEventListener("error", () => {
      legacyDatabaseDeletePromise = null;
      resolve();
    });
    request.addEventListener("blocked", () => {
      legacyDatabaseDeletePromise = null;
      resolve();
    });
  });

  return legacyDatabaseDeletePromise;
}
