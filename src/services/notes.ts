import {
  addDoc,
  Bytes,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { db } from "../lib/firebase";
import type {
  EncryptedPayload,
  NoteAttachmentDocument,
  NoteDocument,
  NoteHistoryAction,
  NoteHistoryDocument,
  NoteKind,
  NoteUserStateDocument,
  WrappedNoteKey
} from "../types";

export interface NoteSnapshot extends NoteDocument {
  id: string;
}

export interface NoteAttachmentSnapshot extends NoteAttachmentDocument {
  id: string;
}

export interface NoteUserStateSnapshot extends NoteUserStateDocument {
  id: string;
}

export interface NoteHistorySnapshot extends NoteHistoryDocument {
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
  historySummary?: EncryptedPayload;
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

export interface PurgeNoteInput {
  noteId: string;
  uid: string;
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
}

const contentHistoryBucketMs = 60_000;

function timestampMillis(value: NoteDocument["updatedAt"]) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

function purgedNote(document: NoteSnapshot) {
  return document.isPurged === true;
}

function visibleNote(document: NoteSnapshot) {
  return document.isDeleted !== true && !purgedNote(document);
}

function deletedNote(document: NoteSnapshot) {
  return document.isDeleted === true && !purgedNote(document);
}

function subscribeNotesByDeletedState(
  uid: string,
  ownerUids: string[] | null,
  deleted: boolean,
  callback: (notes: NoteSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const noteFilter = deleted ? deletedNote : visibleNote;

  if (ownerUids === null) {
    const notesQuery = query(
      collection(db, "notes"),
      where("participantUids", "array-contains", uid),
      orderBy("updatedAt", "desc")
    );

    return onSnapshot(
      notesQuery,
      (snapshot) => {
        callback(snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as NoteDocument) })).filter(noteFilter));
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
        notesByOwner.set(
          ownerUid,
          snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as NoteDocument) })).filter(noteFilter)
        );
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

export function subscribeVisibleNotes(
  uid: string,
  ownerUids: string[] | null,
  callback: (notes: NoteSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  return subscribeNotesByDeletedState(uid, ownerUids, false, callback, onError);
}

export function subscribeDeletedNotes(
  uid: string,
  ownerUids: string[] | null,
  callback: (notes: NoteSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  return subscribeNotesByDeletedState(uid, ownerUids, true, callback, onError);
}

export function subscribeAllNotesForAdmin(callback: (notes: NoteSnapshot[]) => void, onError?: (error: Error) => void) {
  const notesQuery = query(collection(db, "notes"), orderBy("updatedAt", "desc"));

  return onSnapshot(
    notesQuery,
    (snapshot) => {
      callback(snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as NoteDocument) })).filter(visibleNote));
    },
    (error) => onError?.(error)
  );
}

export function subscribeNoteUserStates(
  noteId: string,
  callback: (states: NoteUserStateSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  return onSnapshot(
    collection(db, "noteUserStates", noteId, "users"),
    (snapshot) => {
      callback(
        snapshot.docs.map((document) => ({
          id: document.id,
          ...(document.data() as NoteUserStateDocument)
        }))
      );
    },
    (error) => onError?.(error)
  );
}

export function subscribeMyNoteStates(
  uid: string,
  noteIds: string[],
  callback: (statesByNoteId: Record<string, NoteUserStateSnapshot | undefined>) => void,
  onError?: (error: Error) => void
) {
  const uniqueNoteIds = Array.from(new Set(noteIds)).filter(Boolean);

  if (!uniqueNoteIds.length) {
    callback({});
    return () => undefined;
  }

  const statesByNoteId: Record<string, NoteUserStateSnapshot | undefined> = {};
  let closed = false;

  const emitStates = () => {
    if (!closed) {
      callback({ ...statesByNoteId });
    }
  };

  const unsubscribes = uniqueNoteIds.map((noteId) =>
    onSnapshot(
      doc(db, "noteUserStates", noteId, "users", uid),
      (snapshot) => {
        statesByNoteId[noteId] = snapshot.exists()
          ? ({ id: snapshot.id, ...(snapshot.data() as NoteUserStateDocument) } satisfies NoteUserStateSnapshot)
          : undefined;
        emitStates();
      },
      (error) => onError?.(error)
    )
  );

  return () => {
    closed = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}

export function subscribeNoteHistory(
  noteId: string,
  callback: (history: NoteHistorySnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const historyQuery = query(collection(db, "notes", noteId, "history"), orderBy("createdAt", "desc"), limit(80));

  return onSnapshot(
    historyQuery,
    (snapshot) => {
      callback(
        snapshot.docs.map((document) => ({
          id: document.id,
          ...(document.data() as NoteHistoryDocument)
        }))
      );
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
  const { historySummary, ...noteInput } = input;
  const created = await addDoc(collection(db, "notes"), {
    ...noteInput,
    participantUids: Array.from(new Set(input.participantUids)),
    createdAt: serverTimestamp(),
    dueAt: input.dueAt ?? null,
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: input.ownerUid
  });

  await createNoteHistory(created.id, input.ownerUid, "create", ["title", "body", "dueAt"], historySummary).catch(
    () => undefined
  );
  return created;
}

export async function updateEncryptedNote(
  noteId: string,
  uid: string,
  encryptedTitle: EncryptedPayload,
  encryptedBody: EncryptedPayload,
  changedFields: string[] = ["title", "body"],
  historySummary?: EncryptedPayload
) {
  await updateDoc(doc(db, "notes", noteId), {
    encryptedTitle,
    encryptedBody,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  await createNoteHistory(noteId, uid, "content", changedFields, historySummary).catch(() => undefined);
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
  await createNoteHistory(noteId, uid, "share", ["participants"]).catch(() => undefined);
}

export async function updateNoteDeadline(noteId: string, uid: string, dueAt: Timestamp | null) {
  await updateDoc(doc(db, "notes", noteId), {
    dueAt,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  await createNoteHistory(noteId, uid, "deadline", ["dueAt"]).catch(() => undefined);
}

export async function setNotePinned(noteId: string, uid: string, isPinned: boolean) {
  await setDoc(
    doc(db, "noteUserStates", noteId, "users", uid),
    {
      uid,
      noteId,
      isPinned,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function markNoteRead(noteId: string, uid: string) {
  await setDoc(
    doc(db, "noteUserStates", noteId, "users", uid),
    {
      uid,
      noteId,
      readAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function confirmNoteRead(noteId: string, uid: string) {
  await setDoc(
    doc(db, "noteUserStates", noteId, "users", uid),
    {
      uid,
      noteId,
      readAt: serverTimestamp(),
      confirmedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function publishNoteCursor(
  noteId: string,
  uid: string,
  clientId: string,
  cursorOffset: number | null,
  cursorVisible: boolean
) {
  await setDoc(
    doc(db, "noteUserStates", noteId, "users", uid),
    {
      uid,
      noteId,
      cursorOffset,
      cursorVisible,
      cursorClientId: clientId,
      cursorUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function createNoteHistory(
  noteId: string,
  uid: string,
  action: NoteHistoryAction,
  changedFields: string[],
  encryptedSummary?: EncryptedPayload
) {
  const normalizedFields = Array.from(new Set(changedFields)).filter(Boolean);

  if (!normalizedFields.length) {
    return null;
  }

  const historyDocument = {
    noteId,
    actorUid: uid,
    action,
    changedFields: normalizedFields,
    ...(encryptedSummary ? { encryptedSummary } : {}),
    createdAt: serverTimestamp()
  } satisfies Omit<NoteHistoryDocument, "createdAt"> & { createdAt: ReturnType<typeof serverTimestamp> };

  if (action === "content" && encryptedSummary) {
    const bucket = Math.floor(Date.now() / contentHistoryBucketMs);
    return setDoc(doc(db, "notes", noteId, "history", `content_${uid}_${bucket}`), historyDocument);
  }

  return addDoc(collection(db, "notes", noteId, "history"), historyDocument);
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

async function deleteCollectionDocuments(pathSegments: string[]) {
  const [headSegment, ...tailSegments] = pathSegments;

  if (!headSegment) {
    return;
  }

  const snapshot = await getDocs(collection(db, headSegment, ...tailSegments));
  const refsToDelete = snapshot.docs.map((documentSnapshot) => documentSnapshot.ref);
  const chunkSize = 450;

  for (let index = 0; index < refsToDelete.length; index += chunkSize) {
    const batch = writeBatch(db);
    refsToDelete.slice(index, index + chunkSize).forEach((documentRef) => {
      batch.delete(documentRef);
    });
    await batch.commit();
  }
}

export async function deleteNote(noteId: string, uid: string) {
  await updateDoc(doc(db, "notes", noteId), {
    isDeleted: true,
    deletedAt: serverTimestamp(),
    deletedBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  await createNoteHistory(noteId, uid, "delete", ["deleted"]).catch(() => undefined);

  await deleteCollectionDocuments(["notes", noteId, "attachments"]);
}

export async function restoreNote(noteId: string, uid: string) {
  await updateDoc(doc(db, "notes", noteId), {
    isDeleted: deleteField(),
    deletedAt: deleteField(),
    deletedBy: deleteField(),
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  await createNoteHistory(noteId, uid, "restore", ["restored"]).catch(() => undefined);
}

export async function purgeNote(input: PurgeNoteInput) {
  await deleteCollectionDocuments(["notes", input.noteId, "attachments"]);
  await deleteCollectionDocuments(["notes", input.noteId, "history"]);

  await updateDoc(doc(db, "notes", input.noteId), {
    type: "personal",
    participantUids: [input.uid],
    wrappedKeys: {
      [input.uid]: input.wrappedKey
    },
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    isDeleted: true,
    isPurged: true,
    purgedAt: serverTimestamp(),
    purgedBy: input.uid,
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: input.uid
  });
}
