import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "../lib/firebase";
import type { EncryptedPayload, NoteDocument, NoteKind, WrappedNoteKey } from "../types";

export interface NoteSnapshot extends NoteDocument {
  id: string;
}

export interface SaveNoteInput {
  type: NoteKind;
  ownerUid: string;
  participantUids: string[];
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  wrappedKeys: Record<string, WrappedNoteKey>;
}

export function subscribeVisibleNotes(
  uid: string,
  callback: (notes: NoteSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const notesQuery = query(
    collection(db, "notes"),
    where("participantUids", "array-contains", uid),
    orderBy("updatedAt", "desc")
  );

  return onSnapshot(
    notesQuery,
    (snapshot) => {
      callback(snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as NoteDocument) })));
    },
    (error) => onError?.(error)
  );
}

export async function createEncryptedNote(input: SaveNoteInput) {
  return addDoc(collection(db, "notes"), {
    ...input,
    participantUids: Array.from(new Set(input.participantUids)),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: input.ownerUid
  });
}

export async function updateEncryptedNote(
  noteId: string,
  uid: string,
  encryptedTitle: EncryptedPayload,
  encryptedBody: EncryptedPayload
) {
  await updateDoc(doc(db, "notes", noteId), {
    encryptedTitle,
    encryptedBody,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
}

export async function deleteNote(noteId: string) {
  await deleteDoc(doc(db, "notes", noteId));
}
