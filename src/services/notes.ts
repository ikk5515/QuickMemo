import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
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
  dueAt?: Timestamp | null;
}

function timestampMillis(value: NoteDocument["updatedAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

export function subscribeVisibleNotes(
  uid: string,
  ownerUids: string[] | null,
  callback: (notes: NoteSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  if (ownerUids === null) {
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

  const normalizedOwnerUids = Array.from(new Set([uid, ...ownerUids])).filter(Boolean);
  const notesByOwner = new Map<string, NoteSnapshot[]>();
  let closed = false;

  const emitNotes = () => {
    if (closed) {
      return;
    }

    callback(
      Array.from(notesByOwner.values())
        .flat()
        .sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt))
    );
  };

  const unsubscribes = normalizedOwnerUids.map((ownerUid) => {
    const notesQuery = query(
      collection(db, "notes"),
      where("ownerUid", "==", ownerUid),
      where("participantUids", "array-contains", uid),
      orderBy("updatedAt", "desc")
    );

    return onSnapshot(
      notesQuery,
      (snapshot) => {
        notesByOwner.set(ownerUid, snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as NoteDocument) })));
        emitNotes();
      },
      (error) => onError?.(error)
    );
  });

  return () => {
    closed = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}

export function subscribeAllNotesForAdmin(callback: (notes: NoteSnapshot[]) => void, onError?: (error: Error) => void) {
  const notesQuery = query(collection(db, "notes"), orderBy("updatedAt", "desc"));

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
    dueAt: input.dueAt ?? null,
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

export async function updateNoteAccess(
  noteId: string,
  uid: string,
  type: NoteKind,
  participantUids: string[],
  wrappedKeys: Record<string, WrappedNoteKey>
) {
  await updateDoc(doc(db, "notes", noteId), {
    type,
    participantUids: Array.from(new Set(participantUids)),
    wrappedKeys,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
}

export async function updateNoteDeadline(noteId: string, uid: string, dueAt: Timestamp | null) {
  await updateDoc(doc(db, "notes", noteId), {
    dueAt,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
}

export async function deleteNote(noteId: string) {
  await deleteDoc(doc(db, "notes", noteId));
}
