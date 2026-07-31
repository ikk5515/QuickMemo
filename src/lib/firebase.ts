import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  browserSessionPersistence,
  connectAuthEmulator,
  initializeAuth
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore
} from "firebase/firestore";
import { connectStorageEmulator, getStorage, type FirebaseStorage } from "firebase/storage";

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || "quickmemo-demo";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "demo-api-key",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "000000000000",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:000000000000:web:quickmemo",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined
};

export const hasFirebaseConfig = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY &&
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN &&
    import.meta.env.VITE_FIREBASE_PROJECT_ID &&
    import.meta.env.VITE_FIREBASE_APP_ID
);

export const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, {
  // QuickMemo uses password credentials only. Omitting the popup/redirect
  // resolver prevents Firebase Auth from proactively loading GAPI on Safari.
  persistence: browserSessionPersistence
});
export const firebaseEmulatorsEnabled =
  !import.meta.env.PROD
  && import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";
const forceE2eFirestoreLongPolling =
  firebaseEmulatorsEnabled
  && import.meta.env.VITE_E2E_FIRESTORE_FORCE_LONG_POLLING === "true";
export const db = forceE2eFirestoreLongPolling
  ? initializeFirestore(app, {
      // WebKit can indefinitely buffer the emulator's WebChannel stream.
      // The emulator-only E2E gate leaves development and production unchanged.
      experimentalAutoDetectLongPolling: false,
      experimentalForceLongPolling: true
    })
  : getFirestore(app);
let legacyStorage: FirebaseStorage | null = null;
export const legacyFirebaseStorageEnabled =
  firebaseEmulatorsEnabled
  || import.meta.env.VITE_LEGACY_FIREBASE_STORAGE_ENABLED === "true";

/**
 * Firebase Storage is a legacy-read-only fallback. New attachments use
 * authenticated Vercel Blob routes, so production must not initialize the
 * Storage SDK unless a document explicitly contains a legacy storagePath.
 */
export function getLegacyStorage() {
  if (!legacyFirebaseStorageEnabled) {
    throw new Error("Legacy attachment storage is unavailable");
  }
  if (legacyStorage) return legacyStorage;

  legacyStorage = getStorage(app);
  if (firebaseEmulatorsEnabled) {
    connectStorageEmulator(legacyStorage, "127.0.0.1", 9199);
  }

  return legacyStorage;
}
export const appCheckSiteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
export const appCheck =
  appCheckSiteKey && !firebaseEmulatorsEnabled
    ? initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true
      })
    : null;
if (firebaseEmulatorsEnabled) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export const authPersistenceReady = auth.authStateReady().catch(() => undefined);
