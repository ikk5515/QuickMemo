import {
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc
} from "firebase/firestore";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { db } from "../lib/firebase";
import {
  defaultMatrixLabels,
  normalizeMatrixLabels,
  sanitizeMatrixLabelsForSave,
  validateMatrixLabels
} from "../lib/matrixLabels";
import { defaultScheduleCategoryFilter, normalizeScheduleCategoryFilter } from "../lib/scheduleCategory";
import { normalizeThemePreference } from "../lib/theme";
import type {
  ActiveScheduleView,
  DefaultHomeView,
  EncryptedPayload,
  MatrixLabels,
  ScheduleCategoryFilter,
  ScheduleView,
  ThemePreference,
  UserPreferencesDocument,
  UserProfile,
  WrappedNoteKey
} from "../types";

export const encryptedMatrixLabelsFormat = "matrix-labels-v1" as const;

export interface UserPreferencesCryptoContext {
  privateKey: CryptoKey;
  profile: Pick<UserProfile, "publicKeyJwk" | "uid">;
}

interface StoredUserPreferencesDocument {
  createdAt?: UserPreferencesDocument["createdAt"];
  defaultHome?: UserPreferencesDocument["defaultHome"];
  encryptedMatrixLabels?: EncryptedPayload;
  matrixLabels?: Partial<MatrixLabels>;
  matrixLabelsFormat?: typeof encryptedMatrixLabelsFormat;
  matrixLabelsWrappedKey?: WrappedNoteKey;
  scheduleDefaultCategory?: UserPreferencesDocument["scheduleDefaultCategory"];
  scheduleDefaultView?: UserPreferencesDocument["scheduleDefaultView"];
  theme?: UserPreferencesDocument["theme"];
  uid?: string;
  updatedAt?: UserPreferencesDocument["updatedAt"];
}

interface MatrixLabelsEnvelopeV1 {
  labels: MatrixLabels;
  version: 1;
}

type EncryptedMatrixLabelsFields = Pick<
  StoredUserPreferencesDocument,
  "encryptedMatrixLabels" | "matrixLabelsFormat" | "matrixLabelsWrappedKey"
>;

const preferencesCachePrefix = "quickmemo:userPreferences:";
const matrixLabelKeys = Object.keys(defaultMatrixLabels) as Array<keyof MatrixLabels>;
const validDefaultHomeViews = new Set<DefaultHomeView>(["notes", "library", "schedule"]);
const validScheduleViews = new Set<ScheduleView>(["todo", "calendar", "matrix", "recurring", "completed"]);
const validThemes = new Set<ThemePreference>(["light", "dark", "system"]);

export const defaultUserPreferences: Pick<
  UserPreferencesDocument,
  "defaultHome" | "matrixLabels" | "scheduleDefaultCategory" | "scheduleDefaultView" | "theme"
> = {
  defaultHome: "notes",
  matrixLabels: defaultMatrixLabels,
  scheduleDefaultCategory: defaultScheduleCategoryFilter,
  scheduleDefaultView: "calendar",
  theme: "system"
};

export interface SaveUserPreferencesInput {
  defaultHome?: UserPreferencesDocument["defaultHome"];
  matrixLabels?: Partial<MatrixLabels>;
  scheduleDefaultCategory?: ScheduleCategoryFilter;
  scheduleDefaultView?: ActiveScheduleView;
  theme?: ThemePreference;
}

function preferencesRef(uid: string) {
  return doc(db, "userPreferences", uid);
}

function preferencesCacheKey(uid: string) {
  return `${preferencesCachePrefix}${uid}`;
}

function storageAvailable() {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function normalizedPreferences(
  uid: string,
  value: StoredUserPreferencesDocument | null | undefined,
  matrixLabels: MatrixLabels = defaultMatrixLabels
): UserPreferencesDocument {
  const defaultHome = validDefaultHomeViews.has(value?.defaultHome as DefaultHomeView)
    ? (value?.defaultHome as DefaultHomeView)
    : defaultUserPreferences.defaultHome;
  const scheduleDefaultView = validScheduleViews.has(value?.scheduleDefaultView as ScheduleView)
    ? (value?.scheduleDefaultView as ScheduleView)
    : defaultUserPreferences.scheduleDefaultView;
  const scheduleDefaultCategory = normalizeScheduleCategoryFilter(value?.scheduleDefaultCategory);
  const theme = validThemes.has(value?.theme as ThemePreference)
    ? normalizeThemePreference(value?.theme)
    : defaultUserPreferences.theme;

  return {
    uid,
    defaultHome,
    matrixLabels: normalizeMatrixLabels(matrixLabels),
    scheduleDefaultCategory,
    scheduleDefaultView,
    theme,
    createdAt: value?.createdAt,
    updatedAt: value?.updatedAt
  };
}

function cachedPreferenceProjection(preferences: UserPreferencesDocument) {
  return {
    defaultHome: preferences.defaultHome,
    scheduleDefaultCategory: preferences.scheduleDefaultCategory,
    scheduleDefaultView: preferences.scheduleDefaultView,
    theme: preferences.theme
  };
}

function writeCachedUserPreferences(preferences: UserPreferencesDocument) {
  if (!storageAvailable()) {
    return;
  }

  try {
    // Matrix labels can contain user-authored wording. They deliberately never
    // enter browser storage, even after successful decryption.
    window.localStorage.setItem(
      preferencesCacheKey(preferences.uid),
      JSON.stringify(cachedPreferenceProjection(preferences))
    );
  } catch {
    // Local cache is only used to avoid UI flicker; Firestore remains the source of truth.
  }
}

export function clearLegacyMatrixLabelPreferenceCaches() {
  if (!storageAvailable()) {
    return;
  }

  const scrubStorage = (storage: Storage, retainNonSensitiveProjection: boolean) => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(preferencesCachePrefix)) keys.push(key);
    }

    for (const key of keys) {
      const uid = key.slice(preferencesCachePrefix.length);
      try {
        const rawValue = storage.getItem(key);
        const parsed = rawValue ? JSON.parse(rawValue) as StoredUserPreferencesDocument : null;
        if (!parsed || !uid || !retainNonSensitiveProjection) {
          storage.removeItem(key);
          continue;
        }
        storage.setItem(
          key,
          JSON.stringify(cachedPreferenceProjection(normalizedPreferences(uid, parsed)))
        );
      } catch {
        storage.removeItem(key);
      }
    }
  };

  try {
    scrubStorage(window.localStorage, true);
  } catch {
    // A disabled browser store is equivalent to an empty cache.
  }
  try {
    // Preferences have never needed a session cache. Remove any historical or
    // injected copy wholesale so user-authored labels cannot survive there.
    scrubStorage(window.sessionStorage, false);
  } catch {
    // A disabled browser store is equivalent to an empty cache.
  }
}

// Purge every known account cache when this module loads. getCachedUserPreferences
// repeats the projection so a legacy tab cannot reintroduce a plaintext label.
clearLegacyMatrixLabelPreferenceCaches();

export function getCachedUserPreferences(uid: string) {
  if (!storageAvailable()) {
    return null;
  }

  clearLegacyMatrixLabelPreferenceCaches();
  try {
    const rawValue = window.localStorage.getItem(preferencesCacheKey(uid));
    if (!rawValue) return null;
    const preferences = normalizedPreferences(uid, JSON.parse(rawValue) as StoredUserPreferencesDocument);
    writeCachedUserPreferences(preferences);
    return preferences;
  } catch {
    window.localStorage.removeItem(preferencesCacheKey(uid));
    return null;
  }
}

export function fallbackUserPreferences(uid: string): UserPreferencesDocument {
  return {
    uid,
    ...defaultUserPreferences
  };
}

function assertCryptoContext(uid: string, context: UserPreferencesCryptoContext | undefined) {
  if (
    !context
    || context.profile.uid !== uid
    || !context.profile.publicKeyJwk
    || !context.privateKey
  ) {
    throw new Error("매트릭스 명칭을 사용하려면 암호화 키를 먼저 열어주세요.");
  }
  return context;
}

function hasAnyEncryptedMatrixLabelField(data: StoredUserPreferencesDocument) {
  return data.encryptedMatrixLabels !== undefined
    || data.matrixLabelsFormat !== undefined
    || data.matrixLabelsWrappedKey !== undefined;
}

function hasCompleteEncryptedMatrixLabelFields(
  data: StoredUserPreferencesDocument
): data is StoredUserPreferencesDocument & Required<EncryptedMatrixLabelsFields> {
  return data.matrixLabelsFormat === encryptedMatrixLabelsFormat
    && Boolean(data.encryptedMatrixLabels)
    && Boolean(data.matrixLabelsWrappedKey);
}

function hasExactMatrixLabelKeys(value: unknown): value is MatrixLabels {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === matrixLabelKeys.length
    && keys.every((key) => matrixLabelKeys.includes(key as keyof MatrixLabels));
}

function validDecryptedMatrixLabels(value: unknown): MatrixLabels {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("암호화된 매트릭스 명칭 형식이 올바르지 않습니다.");
  }
  const envelope = value as Partial<MatrixLabelsEnvelopeV1>;
  if (
    envelope.version !== 1
    || !hasExactMatrixLabelKeys(envelope.labels)
    || Object.keys(envelope).some((key) => key !== "version" && key !== "labels")
    || validateMatrixLabels(envelope.labels) !== null
  ) {
    throw new Error("암호화된 매트릭스 명칭 형식이 올바르지 않습니다.");
  }
  return sanitizeMatrixLabelsForSave(envelope.labels);
}

async function prepareEncryptedMatrixLabels(
  labels: MatrixLabels,
  context: UserPreferencesCryptoContext
): Promise<Required<EncryptedMatrixLabelsFields>> {
  if (!hasExactMatrixLabelKeys(labels) || validateMatrixLabels(labels) !== null) {
    throw new Error("매트릭스 명칭 형식이 올바르지 않습니다.");
  }
  const labelsKey = await generateNoteKey();
  const envelope: MatrixLabelsEnvelopeV1 = { labels, version: 1 };
  const [encryptedMatrixLabels, matrixLabelsWrappedKey] = await Promise.all([
    encryptText(JSON.stringify(envelope), labelsKey),
    wrapNoteKey(labelsKey, context.profile.publicKeyJwk)
  ]);
  return {
    encryptedMatrixLabels,
    matrixLabelsFormat: encryptedMatrixLabelsFormat,
    matrixLabelsWrappedKey
  };
}

async function decryptStoredMatrixLabels(
  data: StoredUserPreferencesDocument,
  context: UserPreferencesCryptoContext
) {
  if (!hasAnyEncryptedMatrixLabelField(data)) {
    return defaultMatrixLabels;
  }
  if (!hasCompleteEncryptedMatrixLabelFields(data)) {
    throw new Error("암호화된 매트릭스 명칭 저장값이 완전하지 않습니다.");
  }
  const labelsKey = await unwrapNoteKey(data.matrixLabelsWrappedKey, context.privateKey);
  const plaintext = await decryptText(data.encryptedMatrixLabels, labelsKey);
  return validDecryptedMatrixLabels(JSON.parse(plaintext) as unknown);
}

function legacyMatrixLabels(data: StoredUserPreferencesDocument) {
  if (data.matrixLabels === undefined) return null;
  if (
    !hasExactMatrixLabelKeys(data.matrixLabels)
    || validateMatrixLabels(data.matrixLabels) !== null
  ) {
    // Never normalize malformed historical plaintext into defaults and then
    // overwrite it. Keep the source document untouched for manual recovery.
    throw new Error("기존 매트릭스 명칭 형식이 올바르지 않아 자동 이전하지 않았습니다.");
  }
  return sanitizeMatrixLabelsForSave(data.matrixLabels);
}

function sameMatrixLabels(left: MatrixLabels, right: MatrixLabels) {
  return matrixLabelKeys.every((key) => left[key] === right[key]);
}

async function migrateLegacyMatrixLabels(
  uid: string,
  labels: MatrixLabels,
  context: UserPreferencesCryptoContext
) {
  const encryptedFields = await prepareEncryptedMatrixLabels(labels, context);
  await runTransaction(db, async (transaction) => {
    const reference = preferencesRef(uid);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) return;
    const current = snapshot.data() as StoredUserPreferencesDocument;
    if (current.uid !== uid) {
      throw new Error("사용자 설정 소유자가 일치하지 않습니다.");
    }
    if (current.matrixLabels === undefined) return;

    if (hasCompleteEncryptedMatrixLabelFields(current)) {
      transaction.update(reference, {
        matrixLabels: deleteField(),
        updatedAt: serverTimestamp()
      });
      return;
    }

    const currentLabels = legacyMatrixLabels(current);
    if (!currentLabels || !sameMatrixLabels(currentLabels, labels)) {
      throw new Error("매트릭스 명칭이 동시에 변경되어 마이그레이션을 다시 확인해야 합니다.");
    }
    transaction.update(reference, {
      ...encryptedFields,
      matrixLabels: deleteField(),
      updatedAt: serverTimestamp()
    });
  });
}

async function resolveStoredPreferences(
  uid: string,
  data: StoredUserPreferencesDocument,
  cryptoContext?: UserPreferencesCryptoContext
) {
  const base = normalizedPreferences(uid, data);

  if (data.matrixLabels !== undefined) {
    // Non-sensitive routing/theme preferences remain readable while locked,
    // but legacy user-authored labels are neither normalized nor returned.
    if (!cryptoContext) return base;
    const legacyLabels = legacyMatrixLabels(data);
    if (!legacyLabels) return base;
    const context = assertCryptoContext(uid, cryptoContext);
    // If a previous migration wrote the encrypted envelope but failed before
    // deleting the legacy field, the encrypted value is already canonical.
    // Decrypt it before cleanup so stale plaintext can never win.
    const labels = hasCompleteEncryptedMatrixLabelFields(data)
      ? await decryptStoredMatrixLabels(data, context)
      : legacyLabels;
    await migrateLegacyMatrixLabels(uid, legacyLabels, context);
    return { ...base, matrixLabels: labels };
  }
  if (!hasAnyEncryptedMatrixLabelField(data)) {
    return base;
  }
  if (!cryptoContext) return base;
  const context = assertCryptoContext(uid, cryptoContext);
  return { ...base, matrixLabels: await decryptStoredMatrixLabels(data, context) };
}

export async function getUserPreferences(uid: string, cryptoContext?: UserPreferencesCryptoContext) {
  const snapshot = await getDoc(preferencesRef(uid));
  if (!snapshot.exists()) {
    const preferences = fallbackUserPreferences(uid);
    writeCachedUserPreferences(preferences);
    return preferences;
  }
  const preferences = await resolveStoredPreferences(
    uid,
    snapshot.data() as StoredUserPreferencesDocument,
    cryptoContext
  );
  writeCachedUserPreferences(preferences);
  return preferences;
}

export function subscribeUserPreferences(
  uid: string,
  callback: (preferences: UserPreferencesDocument) => void,
  onError?: (error: Error) => void,
  cryptoContext?: UserPreferencesCryptoContext
) {
  let active = true;
  let generation = 0;

  const unsubscribe = onSnapshot(
    preferencesRef(uid),
    (snapshot) => {
      const currentGeneration = generation + 1;
      generation = currentGeneration;
      const data = snapshot.exists()
        ? snapshot.data() as StoredUserPreferencesDocument
        : null;
      const base = data ? normalizedPreferences(uid, data) : fallbackUserPreferences(uid);
      writeCachedUserPreferences(base);
      // Clear labels from a previous key/account scope before any asynchronous
      // unwrap operation completes.
      callback(base);
      if (!data || (!data.matrixLabels && !hasAnyEncryptedMatrixLabelField(data))) return;

      void resolveStoredPreferences(uid, data, cryptoContext)
        .then((preferences) => {
          if (!active || generation !== currentGeneration) return;
          writeCachedUserPreferences(preferences);
          callback(preferences);
        })
        .catch((error: unknown) => {
          if (!active || generation !== currentGeneration) return;
          onError?.(error instanceof Error ? error : new Error("사용자 설정을 복호화하지 못했습니다."));
        });
    },
    (error) => {
      if (!active) return;
      generation += 1;
      // A terminal listener error invalidates the authorized server scope.
      // Clear decrypted labels immediately while retaining only the bounded,
      // non-sensitive cache projection for navigation/theme continuity.
      callback(getCachedUserPreferences(uid) ?? fallbackUserPreferences(uid));
      onError?.(error);
    }
  );

  return () => {
    active = false;
    generation += 1;
    unsubscribe();
  };
}

export async function saveUserPreferences(
  uid: string,
  input: SaveUserPreferencesInput,
  cryptoContext?: UserPreferencesCryptoContext
) {
  let snapshot = await getDoc(preferencesRef(uid));
  let stored = snapshot.exists()
    ? snapshot.data() as StoredUserPreferencesDocument
    : null;
  const legacyLabels = stored ? legacyMatrixLabels(stored) : null;

  if (legacyLabels && input.matrixLabels === undefined) {
    const context = assertCryptoContext(uid, cryptoContext);
    await migrateLegacyMatrixLabels(uid, legacyLabels, context);
    snapshot = await getDoc(preferencesRef(uid));
    stored = snapshot.exists() ? snapshot.data() as StoredUserPreferencesDocument : null;
  }

  const current = stored
    ? normalizedPreferences(uid, stored)
    : fallbackUserPreferences(uid);
  const payload: Record<string, unknown> = {
    defaultHome: input.defaultHome ?? current.defaultHome,
    scheduleDefaultCategory: normalizeScheduleCategoryFilter(
      input.scheduleDefaultCategory ?? current.scheduleDefaultCategory
    ),
    scheduleDefaultView: input.scheduleDefaultView ?? current.scheduleDefaultView,
    theme: input.theme ? normalizeThemePreference(input.theme) : current.theme,
    updatedAt: serverTimestamp()
  };

  if (input.matrixLabels !== undefined) {
    const context = assertCryptoContext(uid, cryptoContext);
    const nextLabels = sanitizeMatrixLabelsForSave(input.matrixLabels);
    payload.matrixLabels = deleteField();
    if (sameMatrixLabels(nextLabels, defaultMatrixLabels)) {
      payload.encryptedMatrixLabels = deleteField();
      payload.matrixLabelsFormat = deleteField();
      payload.matrixLabelsWrappedKey = deleteField();
    } else {
      Object.assign(payload, await prepareEncryptedMatrixLabels(nextLabels, context));
    }
  }

  if (snapshot.exists()) {
    await updateDoc(preferencesRef(uid), payload);
  } else {
    const createPayload = { ...payload };
    // deleteField sentinels are invalid in a new document. A missing encrypted
    // label envelope canonically means the built-in defaults.
    if (input.matrixLabels !== undefined) {
      delete createPayload.matrixLabels;
      if (sameMatrixLabels(sanitizeMatrixLabelsForSave(input.matrixLabels), defaultMatrixLabels)) {
        delete createPayload.encryptedMatrixLabels;
        delete createPayload.matrixLabelsFormat;
        delete createPayload.matrixLabelsWrappedKey;
      }
    }
    await setDoc(preferencesRef(uid), {
      uid,
      ...createPayload,
      createdAt: serverTimestamp()
    });
  }

  writeCachedUserPreferences(normalizedPreferences(uid, {
    ...stored,
    defaultHome: payload.defaultHome as DefaultHomeView,
    scheduleDefaultCategory: payload.scheduleDefaultCategory as ScheduleCategoryFilter,
    scheduleDefaultView: payload.scheduleDefaultView as ScheduleView,
    theme: payload.theme as ThemePreference
  }));
}
