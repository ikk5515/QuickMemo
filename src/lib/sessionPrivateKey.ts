const legacyDatabaseName = "quickmemo-private-key-session";

export const privateKeySessionDurationMs = 60 * 60 * 1000;

interface SessionPrivateKeyRecord {
  expiresAt: number;
  privateKey: CryptoKey;
  uid: string;
}

const sessionPrivateKeys = new Map<string, SessionPrivateKeyRecord>();
const sessionPrivateKeyMutationVersions = new Map<string, number>();
let legacyDatabaseDeleteComplete = false;
let legacyDatabaseDeletePromise: Promise<void> | null = null;

function nextSessionPrivateKeyMutationVersion(uid: string) {
  const version = (sessionPrivateKeyMutationVersions.get(uid) ?? 0) + 1;

  sessionPrivateKeyMutationVersions.set(uid, version);
  return version;
}

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
  const mutationVersion = nextSessionPrivateKeyMutationVersion(uid);

  await deletePersistedSessionPrivateKeyStore();

  if (sessionPrivateKeyMutationVersions.get(uid) !== mutationVersion) {
    return null;
  }

  sessionPrivateKeys.set(uid, { expiresAt, privateKey, uid });
  return mutationVersion;
}

export async function deleteSessionPrivateKey(uid: string, expectedMutationVersion?: number) {
  if (expectedMutationVersion !== undefined
    && sessionPrivateKeyMutationVersions.get(uid) !== expectedMutationVersion) {
    return false;
  }

  const mutationVersion = nextSessionPrivateKeyMutationVersion(uid);

  sessionPrivateKeys.delete(uid);
  await deletePersistedSessionPrivateKeyStore();

  if (sessionPrivateKeyMutationVersions.get(uid) === mutationVersion) {
    sessionPrivateKeys.delete(uid);
  }
  return true;
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
