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
  NoteFolderDocument,
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

export interface NoteFolderSnapshot extends NoteFolderDocument {
  id: string;
}

export interface SaveNoteInput {
  type: NoteKind;
  ownerUid: string;
  participantUids: string[];
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  wrappedKeys: Record<string, WrappedNoteKey>;
  folderId?: string | null;
  dueAt?: Timestamp | null;
  historySummary?: EncryptedPayload;
  historySnapshot?: EncryptedPayload;
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
      where("isDeleted", "==", deleted),
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

  const normalizedOwnerUids = Array.from(new Set(deleted ? [uid] : [uid, ...ownerUids])).filter(Boolean);
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
      where("isDeleted", "==", deleted),
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
  const notesQuery = query(collection(db, "notes"), where("isDeleted", "==", false), orderBy("updatedAt", "desc"));

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
  const { historySnapshot, historySummary, ...noteInput } = input;
  const noteRef = doc(collection(db, "notes"));
  const batch = writeBatch(db);

  batch.set(noteRef, {
    ...noteInput,
    participantUids: Array.from(new Set(input.participantUids)),
    folderId: input.type === "personal" ? input.folderId ?? null : null,
    createdAt: serverTimestamp(),
    dueAt: input.dueAt ?? null,
    isDeleted: false,
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: input.ownerUid
  });
  setNoteHistory(batch, noteRef.id, input.ownerUid, "create", ["title", "body", "dueAt"], historySummary, historySnapshot);

  await batch.commit();
  return noteRef;
}

export async function updateEncryptedNote(
  noteId: string,
  uid: string,
  encryptedTitle: EncryptedPayload,
  encryptedBody: EncryptedPayload,
  changedFields: string[] = ["title", "body"],
  historySummary?: EncryptedPayload,
  historySnapshot?: EncryptedPayload
) {
  const batch = writeBatch(db);
  const noteRef = doc(db, "notes", noteId);

  batch.update(noteRef, {
    encryptedTitle,
    encryptedBody,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  setNoteHistory(batch, noteId, uid, "content", changedFields, historySummary, historySnapshot);
  await batch.commit();
}

export async function updateNoteAccess(
  noteId: string,
  uid: string,
  type: NoteKind,
  participantUids: string[],
  wrappedKeys: Record<string, WrappedNoteKey>,
  folderId: string | null = null
) {
  const batch = writeBatch(db);
  const noteRef = doc(db, "notes", noteId);

  batch.update(noteRef, {
    type,
    participantUids: Array.from(new Set(participantUids)),
    wrappedKeys,
    folderId: type === "personal" ? folderId : null,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  setNoteHistory(batch, noteId, uid, "share", ["participants"]);
  await batch.commit();
}

export async function updateNoteFolder(noteId: string, uid: string, folderId: string | null) {
  await updateDoc(doc(db, "notes", noteId), {
    folderId,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
}

export async function updateNoteDeadline(noteId: string, uid: string, dueAt: Timestamp | null) {
  const batch = writeBatch(db);
  const noteRef = doc(db, "notes", noteId);

  batch.update(noteRef, {
    dueAt,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  setNoteHistory(batch, noteId, uid, "deadline", ["dueAt"]);
  await batch.commit();
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

function noteHistoryRef(noteId: string) {
  return doc(collection(db, "notes", noteId, "history"));
}

function setNoteHistory(
  batch: ReturnType<typeof writeBatch>,
  noteId: string,
  uid: string,
  action: NoteHistoryAction,
  changedFields: string[],
  encryptedSummary?: EncryptedPayload,
  encryptedSnapshot?: EncryptedPayload
) {
  const normalizedFields = Array.from(new Set(changedFields)).filter(Boolean);

  if (!normalizedFields.length) {
    return;
  }

  const historyDocument = {
    noteId,
    actorUid: uid,
    action,
    changedFields: normalizedFields,
    ...(encryptedSummary ? { encryptedSummary } : {}),
    ...(encryptedSnapshot ? { encryptedSnapshot } : {}),
    createdAt: serverTimestamp()
  } satisfies Omit<NoteHistoryDocument, "createdAt"> & { createdAt: ReturnType<typeof serverTimestamp> };

  batch.set(noteHistoryRef(noteId), historyDocument);
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

export function subscribeNoteFolders(
  uid: string,
  callback: (folders: NoteFolderSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const foldersQuery = query(collection(db, "noteFolders"), where("ownerUid", "==", uid));

  return onSnapshot(
    foldersQuery,
    (snapshot) => {
      callback(
        snapshot.docs
          .map((document) => ({ id: document.id, ...(document.data() as NoteFolderDocument) }))
          .sort((left, right) => left.name.localeCompare(right.name, "ko"))
      );
    },
    (error) => onError?.(error)
  );
}

export async function createNoteFolder(uid: string, name: string, color: string) {
  return addDoc(collection(db, "noteFolders"), {
    ownerUid: uid,
    name: name.trim(),
    color,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  } satisfies Omit<NoteFolderDocument, "createdAt" | "updatedAt"> & {
    createdAt: ReturnType<typeof serverTimestamp>;
    updatedAt: ReturnType<typeof serverTimestamp>;
  });
}

export async function deleteNoteFolder(uid: string, folderId: string, noteIds: string[] = []) {
  const folderRef = doc(db, "noteFolders", folderId);
  const uniqueNoteIds = Array.from(new Set(noteIds)).filter(Boolean);
  const chunkSize = 450;

  if (!uniqueNoteIds.length) {
    await deleteDoc(folderRef);
    return;
  }

  for (let index = 0; index < uniqueNoteIds.length; index += chunkSize) {
    const batch = writeBatch(db);
    const chunk = uniqueNoteIds.slice(index, index + chunkSize);

    chunk.forEach((noteId) => {
      batch.update(doc(db, "notes", noteId), {
        folderId: null,
        updatedAt: serverTimestamp(),
        updatedBy: uid
      });
    });

    if (index + chunkSize >= uniqueNoteIds.length) {
      batch.delete(folderRef);
    }

    await batch.commit();
  }
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
  const batch = writeBatch(db);
  const noteRef = doc(db, "notes", noteId);

  batch.update(noteRef, {
    isDeleted: true,
    deletedAt: serverTimestamp(),
    deletedBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  setNoteHistory(batch, noteId, uid, "delete", ["deleted"]);
  await batch.commit();

  await deleteCollectionDocuments(["notes", noteId, "attachments"]);
}

export async function restoreNote(noteId: string, uid: string) {
  const batch = writeBatch(db);
  const noteRef = doc(db, "notes", noteId);

  batch.update(noteRef, {
    isDeleted: false,
    deletedAt: deleteField(),
    deletedBy: deleteField(),
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
  setNoteHistory(batch, noteId, uid, "restore", ["restored"]);
  await batch.commit();
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
