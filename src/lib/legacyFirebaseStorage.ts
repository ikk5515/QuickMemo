import { app, firebaseEmulatorsEnabled, legacyFirebaseStorageEnabled } from "./firebase";

type FirebaseStorageModule = typeof import("firebase/storage");
type FirebaseStorageInstance = ReturnType<FirebaseStorageModule["getStorage"]>;

let legacyStorage: FirebaseStorageInstance | null = null;

export function createRetryableModuleLoader<T>(loader: () => Promise<T>) {
  let pending: Promise<T> | null = null;

  return () => {
    pending ??= loader().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

const loadStorageModule = createRetryableModuleLoader<FirebaseStorageModule>(
  () => import("firebase/storage")
);

/**
 * Firebase Storage is a legacy-read-only fallback. The SDK stays outside the
 * initial application graph and is loaded only for an explicit legacy path.
 */
async function getLegacyStorage() {
  if (!legacyFirebaseStorageEnabled) {
    throw new Error("Legacy attachment storage is unavailable");
  }

  const storageModule = await loadStorageModule();
  if (legacyStorage) return { storage: legacyStorage, storageModule };

  legacyStorage = storageModule.getStorage(app);
  if (firebaseEmulatorsEnabled) {
    storageModule.connectStorageEmulator(legacyStorage, "127.0.0.1", 9199);
  }

  return { storage: legacyStorage, storageModule };
}

export async function getLegacyStorageBytes(storagePath: string, maximumBytes: number) {
  const { storage, storageModule } = await getLegacyStorage();
  return new Uint8Array(
    await storageModule.getBytes(storageModule.ref(storage, storagePath), maximumBytes)
  );
}
