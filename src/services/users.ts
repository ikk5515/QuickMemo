import { collection, doc, getDoc, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { sortRoster } from "../lib/roster";
import type { PublicRosterUser, UserKeyDocument, UserProfile } from "../types";

export function subscribeRoster(callback: (users: PublicRosterUser[]) => void, onError?: (error: Error) => void) {
  const rosterQuery = query(collection(db, "publicLoginRoster"), orderBy("order", "asc"));

  return onSnapshot(
    rosterQuery,
    (snapshot) => {
      const users = snapshot.docs
        .map((document) => document.data() as PublicRosterUser)
        .filter((user) => user.isActive);
      callback(sortRoster(users));
    },
    (error) => onError?.(error)
  );
}

export function subscribeUsers(callback: (users: UserProfile[]) => void, onError?: (error: Error) => void) {
  const usersQuery = query(collection(db, "users"), orderBy("order", "asc"));

  return onSnapshot(
    usersQuery,
    (snapshot) => {
      callback(snapshot.docs.map((document) => document.data() as UserProfile));
    },
    (error) => onError?.(error)
  );
}

export async function getUserProfile(uid: string) {
  const snapshot = await getDoc(doc(db, "users", uid));
  return snapshot.exists() ? (snapshot.data() as UserProfile) : null;
}

export async function getUserKeyDocument(uid: string) {
  const snapshot = await getDoc(doc(db, "userKeys", uid));
  return snapshot.exists() ? (snapshot.data() as UserKeyDocument) : null;
}
