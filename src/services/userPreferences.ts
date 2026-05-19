import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import type { ScheduleView, UserPreferencesDocument } from "../types";

export const defaultUserPreferences: Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView"> = {
  defaultHome: "notes",
  scheduleDefaultView: "todo"
};

export interface SaveUserPreferencesInput {
  defaultHome?: UserPreferencesDocument["defaultHome"];
  scheduleDefaultView?: ScheduleView;
}

function preferencesRef(uid: string) {
  return doc(db, "userPreferences", uid);
}

export function fallbackUserPreferences(uid: string): UserPreferencesDocument {
  return {
    uid,
    ...defaultUserPreferences
  };
}

export async function getUserPreferences(uid: string) {
  const snapshot = await getDoc(preferencesRef(uid));
  return snapshot.exists() ? (snapshot.data() as UserPreferencesDocument) : fallbackUserPreferences(uid);
}

export function subscribeUserPreferences(
  uid: string,
  callback: (preferences: UserPreferencesDocument) => void,
  onError?: (error: Error) => void
) {
  return onSnapshot(
    preferencesRef(uid),
    (snapshot) => {
      callback(snapshot.exists() ? (snapshot.data() as UserPreferencesDocument) : fallbackUserPreferences(uid));
    },
    (error) => onError?.(error)
  );
}

export async function saveUserPreferences(uid: string, input: SaveUserPreferencesInput) {
  const snapshot = await getDoc(preferencesRef(uid));
  const current = snapshot.exists() ? (snapshot.data() as UserPreferencesDocument) : fallbackUserPreferences(uid);
  const payload = {
    defaultHome: input.defaultHome ?? current.defaultHome,
    scheduleDefaultView: input.scheduleDefaultView ?? current.scheduleDefaultView,
    updatedAt: serverTimestamp()
  };

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
