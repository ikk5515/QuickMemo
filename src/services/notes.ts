import {
  addDoc,
  Bytes,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { db } from "../lib/firebase";
import type { EncryptedPayload, NoteAttachmentDocument, NoteDocument, NoteKind, WrappedNoteKey } from "../types";

export interface NoteSnapshot extends NoteDocument {
  id: string;
}

export interface NoteAttachmentSnapshot extends NoteAttachmentDocument {
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

export interface SaveNoteAttachmentInput {
  noteId: string;
  fileName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  encryptedData: Uint8Array;
  iv: Uint8Array;
  uploadedBy: string;
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

export function subscribeNoteAttachments(
  noteId: string,
  callback: (attachments: NoteAttachmentSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const attachmentsQuery = query(collection(db, "notes", noteId, "attachments"), orderBy("createdAt", "desc"));

  return onSnapshot(
    attachmentsQuery,
    (snapshot) => {
      callback(
        snapshot.docs.map((document) => ({
          id: document.id,
          ...(document.data() as NoteAttachmentDocument)
        }))
      );
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

export async function createNoteAttachment(input: SaveNoteAttachmentInput) {
  return addDoc(collection(db, "notes", input.noteId, "attachments"), {
    noteId: input.noteId,
    version: 1,
    algorithm: "AES-GCM",
    fileName: input.fileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    encryptedData: Bytes.fromUint8Array(input.encryptedData),
    iv: Bytes.fromUint8Array(input.iv),
    uploadedBy: input.uploadedBy,
    createdAt: serverTimestamp()
  } satisfies Omit<NoteAttachmentDocument, "createdAt"> & { createdAt: ReturnType<typeof serverTimestamp> });
}

export async function deleteNoteAttachment(noteId: string, attachmentId: string) {
  await deleteDoc(doc(db, "notes", noteId, "attachments", attachmentId));
}

export async function deleteNote(noteId: string) {
  const attachmentsSnapshot = await getDocs(collection(db, "notes", noteId, "attachments"));
  const refsToDelete = [...attachmentsSnapshot.docs.map((attachmentDocument) => attachmentDocument.ref), doc(db, "notes", noteId)];
  const chunkSize = 450;

  for (let index = 0; index < refsToDelete.length; index += chunkSize) {
    const batch = writeBatch(db);
    refsToDelete.slice(index, index + chunkSize).forEach((documentRef) => {
      batch.delete(documentRef);
    });
    await batch.commit();
  }
}
