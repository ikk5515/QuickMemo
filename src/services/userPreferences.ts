import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { defaultMatrixLabels, normalizeMatrixLabels, sanitizeMatrixLabelsForSave } from "../lib/matrixLabels";
import { normalizeThemePreference } from "../lib/theme";
import type { DefaultHomeView, MatrixLabels, ScheduleView, ThemePreference, UserPreferencesDocument } from "../types";

export const defaultUserPreferences: Pick<UserPreferencesDocument, "defaultHome" | "matrixLabels" | "scheduleDefaultView" | "theme"> = {
  defaultHome: "notes",
  matrixLabels: defaultMatrixLabels,
  scheduleDefaultView: "todo",
  theme: "system"
};

const validDefaultHomeViews = new Set<DefaultHomeView>(["notes", "schedule"]);
const validScheduleViews = new Set<ScheduleView>(["todo", "calendar", "matrix", "recurring", "completed"]);
const validThemes = new Set<ThemePreference>(["light", "dark", "system"]);

export interface SaveUserPreferencesInput {
  defaultHome?: UserPreferencesDocument["defaultHome"];
  matrixLabels?: Partial<MatrixLabels>;
  scheduleDefaultView?: ScheduleView;
  theme?: ThemePreference;
}

function preferencesRef(uid: string) {
  return doc(db, "userPreferences", uid);
}

function preferencesCacheKey(uid: string) {
  return `quickmemo:userPreferences:${uid}`;
}

function storageAvailable() {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function normalizeUserPreferences(uid: string, value: Partial<UserPreferencesDocument> | null | undefined): UserPreferencesDocument {
  const defaultHome = validDefaultHomeViews.has(value?.defaultHome as DefaultHomeView)
    ? (value?.defaultHome as DefaultHomeView)
    : defaultUserPreferences.defaultHome;
  const scheduleDefaultView = validScheduleViews.has(value?.scheduleDefaultView as ScheduleView)
    ? (value?.scheduleDefaultView as ScheduleView)
    : defaultUserPreferences.scheduleDefaultView;
  const matrixLabels = normalizeMatrixLabels(value?.matrixLabels);
  const theme = validThemes.has(value?.theme as ThemePreference)
    ? normalizeThemePreference(value?.theme)
    : defaultUserPreferences.theme;

  return {
    uid,
    defaultHome,
    matrixLabels,
    scheduleDefaultView,
    theme,
    createdAt: value?.createdAt,
    updatedAt: value?.updatedAt
  };
}

export function getCachedUserPreferences(uid: string) {
  if (!storageAvailable()) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(preferencesCacheKey(uid));
    return rawValue ? normalizeUserPreferences(uid, JSON.parse(rawValue) as Partial<UserPreferencesDocument>) : null;
  } catch {
    return null;
  }
}

function writeCachedUserPreferences(
  preferences: Pick<UserPreferencesDocument, "defaultHome" | "matrixLabels" | "scheduleDefaultView" | "theme" | "uid">
) {
  if (!storageAvailable()) {
    return;
  }

  try {
    window.localStorage.setItem(
      preferencesCacheKey(preferences.uid),
      JSON.stringify({
        defaultHome: preferences.defaultHome,
        matrixLabels: preferences.matrixLabels,
        scheduleDefaultView: preferences.scheduleDefaultView,
        theme: preferences.theme
      })
    );
  } catch {
    // Local cache is only used to avoid UI flicker; Firestore remains the source of truth.
  }
}

export function fallbackUserPreferences(uid: string): UserPreferencesDocument {
  return {
    uid,
    ...defaultUserPreferences
  };
}

export async function getUserPreferences(uid: string) {
  const snapshot = await getDoc(preferencesRef(uid));
  const preferences = snapshot.exists()
    ? normalizeUserPreferences(uid, snapshot.data() as UserPreferencesDocument)
    : fallbackUserPreferences(uid);

  writeCachedUserPreferences(preferences);
  return preferences;
}

export function subscribeUserPreferences(
  uid: string,
  callback: (preferences: UserPreferencesDocument) => void,
  onError?: (error: Error) => void
) {
  return onSnapshot(
    preferencesRef(uid),
    (snapshot) => {
      const preferences = snapshot.exists()
        ? normalizeUserPreferences(uid, snapshot.data() as UserPreferencesDocument)
        : fallbackUserPreferences(uid);

      writeCachedUserPreferences(preferences);
      callback(preferences);
    },
    (error) => onError?.(error)
  );
}

export async function saveUserPreferences(uid: string, input: SaveUserPreferencesInput) {
  const snapshot = await getDoc(preferencesRef(uid));
  const current = snapshot.exists()
    ? normalizeUserPreferences(uid, snapshot.data() as UserPreferencesDocument)
    : fallbackUserPreferences(uid);
  const payload = {
    defaultHome: input.defaultHome ?? current.defaultHome,
    matrixLabels: input.matrixLabels ? sanitizeMatrixLabelsForSave(input.matrixLabels) : current.matrixLabels,
    scheduleDefaultView: input.scheduleDefaultView ?? current.scheduleDefaultView,
    theme: input.theme ? normalizeThemePreference(input.theme) : current.theme,
    updatedAt: serverTimestamp()
  };
  writeCachedUserPreferences({ uid, ...payload });

  if (snapshot.exists()) {
    await updateDoc(preferencesRef(uid), payload);
    return;
  }

  await setDoc(preferencesRef(uid), {
    uid,
    ...payload,
    createdAt: serverTimestamp()
  });
}
