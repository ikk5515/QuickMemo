const databaseName = "quickmemo-private-key-session";
const databaseVersion = 1;
const storeName = "privateKeys";
const sessionIdStorageKey = "quickmemo-private-key-session-id";

export const privateKeySessionDurationMs = 60 * 60 * 1000;

interface CachedPrivateKeyRecord {
  expiresAt: number;
  privateKey: CryptoKey;
  sessionId: string;
  uid: string;
}

export async function readSessionPrivateKey(uid: string, now = Date.now()) {
  const sessionId = currentSessionId(false);

  if (!sessionId) {
    return null;
  }

  const database = await openPrivateKeyDatabase();
  const record = await requestToPromise<CachedPrivateKeyRecord | undefined>(
    database.transaction(storeName, "readonly").objectStore(storeName).get(uid)
  );

  if (!record || record.uid !== uid || record.sessionId !== sessionId || record.expiresAt <= now) {
    if (record) {
      await deleteSessionPrivateKey(uid).catch(() => undefined);
    }

    return null;
  }

  return isCryptoKey(record.privateKey) ? record.privateKey : null;
}

export async function writeSessionPrivateKey(uid: string, privateKey: CryptoKey, expiresAt = Date.now() + privateKeySessionDurationMs) {
  const sessionId = currentSessionId(true);

  if (!sessionId) {
    return;
  }

  const database = await openPrivateKeyDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put({ expiresAt, privateKey, sessionId, uid } satisfies CachedPrivateKeyRecord);
  await transactionComplete(transaction);
}

export async function deleteSessionPrivateKey(uid: string) {
  if (!canUseIndexedDb()) {
    return;
  }

  const database = await openPrivateKeyDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(uid);
  await transactionComplete(transaction);
}

function currentSessionId(create: boolean) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const existingSessionId = window.sessionStorage.getItem(sessionIdStorageKey);

    if (existingSessionId || !create) {
      return existingSessionId;
    }

    const nextSessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(sessionIdStorageKey, nextSessionId);
    return nextSessionId;
  } catch {
    return null;
  }
}

function canUseIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey === "undefined" ? Boolean(value) : value instanceof CryptoKey;
}

function openPrivateKeyDatabase() {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error("IndexedDB를 사용할 수 없습니다."));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: "uid" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("세션 키 저장소를 열 수 없습니다.")));
    request.addEventListener("blocked", () => reject(new Error("세션 키 저장소가 다른 탭에서 사용 중입니다.")));
  });
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("세션 키 저장소 작업에 실패했습니다.")));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("세션 키 저장소 작업이 중단되었습니다.")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("세션 키 저장소 작업에 실패했습니다.")));
  });
}
