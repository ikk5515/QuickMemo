import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import type { ActiveNoteDocument } from "../types";

export function subscribeActiveNote(
  uid: string,
  callback: (activeNote: ActiveNoteDocument | null) => void,
  onError?: (error: Error) => void
) {
  return onSnapshot(
    doc(db, "activeNotes", uid),
    (snapshot) => {
      callback(snapshot.exists() ? (snapshot.data() as ActiveNoteDocument) : null);
    },
    (error) => onError?.(error)
  );
}

export async function publishActiveNote(uid: string, noteId: string | null, clientId: string) {
  await setDoc(doc(db, "activeNotes", uid), {
    uid,
    noteId,
    updatedAt: serverTimestamp(),
    updatedByClientId: clientId
  });
}
