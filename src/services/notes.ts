import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { getBytes, ref } from "firebase/storage";
import { maxEncryptedAttachmentBytes } from "../lib/attachments";
import { encryptedAttachmentSizeLimit, type AttachmentEncryptionMetadata, type EncryptedAttachmentSource } from "../lib/attachmentCrypto";
import { db, storage } from "../lib/firebase";
import {
  deleteBlobAttachment,
  fetchBlobAttachmentBytes,
  fetchBlobAttachmentResponse,
  uploadNoteAttachmentBlob,
  type BlobAttachmentUploadProgressHandler
} from "./blobAttachments";
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
  historySummary?: EncryptedPayload;
  historySnapshot?: EncryptedPayload;
}

export interface NoteMutationResult {
  lastMutationId: string;
  noteId: string;
  revision: number;
}

export interface CreatedRevisionedNoteResult extends NoteMutationResult {
  noteRef: ReturnType<typeof doc>;
}

export interface UpdateRevisionedEncryptedNoteInput {
  changedFields?: string[];
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  expectedRevision: number;
  historySnapshot?: EncryptedPayload;
  historySummary?: EncryptedPayload;
  noteId: string;
  readerUids: string[];
  uid: string;
}

export interface UpdateRevisionedNoteAccessInput {
  expectedRevision: number;
  folderId?: string | null;
  noteId: string;
  participantUids: string[];
  type: NoteKind;
  uid: string;
  wrappedKeys: Record<string, WrappedNoteKey>;
}

export interface RevisionedNoteLifecycleInput {
  expectedRevision: number;
  noteId: string;
  readerUids: string[];
  uid: string;
}

export class NoteRevisionConflictError extends Error {
  readonly actualRevision: number;
  readonly code = "note/revision-conflict";
  readonly expectedRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`노트가 다른 곳에서 변경되었습니다. 예상 revision ${expectedRevision}, 현재 revision ${actualRevision}.`);
    this.name = "NoteRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface SaveNoteAttachmentInput {
  noteId: string;
  fileName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  encryptedBlob: Blob;
  encryption: AttachmentEncryptionMetadata;
  uploadedBy: string;
  onUploadProgress?: BlobAttachmentUploadProgressHandler;
}

type StoredAttachmentDocument = Pick<
  NoteAttachmentDocument,
  | "algorithm"
  | "blobPath"
  | "chunkCount"
  | "chunkIvs"
  | "chunkSize"
  | "encryptedData"
  | "encryptedSize"
  | "iv"
  | "noteId"
  | "originalSize"
  | "storagePath"
  | "version"
> & {
  id?: string;
};

export interface PurgeNoteInput {
  noteId: string;
  ownerUid: string;
  uid: string;
  encryptedTitle: EncryptedPayload;
  encryptedBody: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
}

const initialNoteRevision = 1;
const maxNoteRevision = 999_999_999_999;

function expectedNoteRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > maxNoteRevision) {
    throw new RangeError(`예상 노트 revision은 0 이상 ${maxNoteRevision} 이하의 정수여야 합니다.`);
  }

  return revision;
}

function storedNoteRevision(note: Pick<NoteDocument, "revision">) {
  const revision = note.revision ?? 0;

  if (!Number.isSafeInteger(revision) || revision < 0 || revision > maxNoteRevision) {
    throw new Error("저장된 노트 revision이 올바르지 않습니다.");
  }

  return revision;
}

function storedAttachmentRevision(note: Pick<NoteDocument, "attachmentRevision">) {
  const revision = note.attachmentRevision ?? 0;

  if (!Number.isSafeInteger(revision) || revision < 0 || revision > maxNoteRevision) {
    throw new Error("저장된 첨부파일 revision이 올바르지 않습니다.");
  }

  return revision;
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

const legacyDeletionMetadataRepairs = new Set<string>();

function hasDeletionMetadata(document: NoteSnapshot) {
  return Object.prototype.hasOwnProperty.call(document, "isDeleted");
}

function normalizeLegacyDeletionMetadata(notes: NoteSnapshot[]) {
  notes.forEach((note) => {
    if (hasDeletionMetadata(note) || !visibleNote(note) || legacyDeletionMetadataRepairs.has(note.id)) {
      return;
    }

    legacyDeletionMetadataRepairs.add(note.id);
    void updateDoc(doc(db, "notes", note.id), { isDeleted: false }).catch(() => {
      legacyDeletionMetadataRepairs.delete(note.id);
    });
  });
}

function sortedByUpdatedAt(notes: NoteSnapshot[]) {
  return [...notes].sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt));
}

function noteSnapshotList(snapshot: { docs: Array<{ id: string; data: () => unknown }> }, noteFilter: (note: NoteSnapshot) => boolean) {
  const notes = snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as NoteDocument) })).filter(noteFilter);
  normalizeLegacyDeletionMetadata(notes);
  return sortedByUpdatedAt(notes);
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
    const notesQuery = deleted
      ? query(
          collection(db, "notes"),
          where("isDeleted", "==", true),
          where("participantUids", "array-contains", uid),
          orderBy("updatedAt", "desc")
        )
      : query(collection(db, "notes"), where("participantUids", "array-contains", uid));

    return onSnapshot(
      notesQuery,
      (snapshot) => {
        callback(noteSnapshotList(snapshot, noteFilter));
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
    const notesQuery =
      !deleted && ownerUid === uid
        ? query(collection(db, "notes"), where("ownerUid", "==", ownerUid))
        : query(
            collection(db, "notes"),
            where("ownerUid", "==", ownerUid),
            where("isDeleted", "==", deleted),
            where("participantUids", "array-contains", uid),
            orderBy("updatedAt", "desc")
          );

    return onSnapshot(
      notesQuery,
      (snapshot) => {
        notesByOwner.set(ownerUid, noteSnapshotList(snapshot, noteFilter));
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
  const notesQuery = query(collection(db, "notes"));

  return onSnapshot(
    notesQuery,
    (snapshot) => {
      callback(noteSnapshotList(snapshot, visibleNote));
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
  let emitQueued = false;

  const scheduleEmitStates = () => {
    if (closed || emitQueued) {
      return;
    }

    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;

      if (!closed) {
        callback({ ...statesByNoteId });
      }
    });
  };

  const unsubscribes = uniqueNoteIds.map((noteId) =>
    onSnapshot(
      doc(db, "noteUserStates", noteId, "users", uid),
      (snapshot) => {
        statesByNoteId[noteId] = snapshot.exists()
          ? ({ id: snapshot.id, ...(snapshot.data() as NoteUserStateDocument) } satisfies NoteUserStateSnapshot)
          : undefined;
        scheduleEmitStates();
      },
      (error) => {
        if (!closed) {
          onError?.(error);
        }
      }
    )
  );

  return () => {
    closed = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}

export function subscribeNoteHistory(
  noteId: string,
  uid: string,
  includeAllReadableHistory: boolean,
  callback: (history: NoteHistorySnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const historyCollection = collection(db, "notes", noteId, "history");
  const historyQuery = includeAllReadableHistory
    ? query(historyCollection, orderBy("createdAt", "desc"), limit(80))
    : query(
        historyCollection,
        where("readerUids", "array-contains", uid),
        orderBy("createdAt", "desc"),
        limit(80)
      );

  return onSnapshot(
    historyQuery,
    (snapshot) => {
      const history = snapshot.docs.map((document) => ({
          id: document.id,
          ...(document.data() as NoteHistoryDocument)
        }));

      callback(history);
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
        snapshot.docs
          .map((document) => ({
            id: document.id,
            ...(document.data() as NoteAttachmentDocument)
          }))
          .filter((attachment) => attachment.isReady !== false)
      );
    },
    (error) => onError?.(error)
  );
}

export async function getNoteAttachments(noteId: string) {
  const attachmentsQuery = query(collection(db, "notes", noteId, "attachments"), orderBy("createdAt", "desc"));
  const snapshot = await getDocs(attachmentsQuery);

  return snapshot.docs
    .map((document) => ({
      id: document.id,
      ...(document.data() as NoteAttachmentDocument)
    }))
    .filter((attachment) => attachment.isReady !== false) satisfies NoteAttachmentSnapshot[];
}

export async function getNoteRevisionState(noteId: string) {
  const snapshot = await getDoc(doc(db, "notes", noteId));

  if (!snapshot.exists()) {
    throw new Error("노트 revision을 확인할 수 없습니다.");
  }

  const note = snapshot.data() as NoteDocument;
  return {
    attachmentRevision: storedAttachmentRevision(note),
    revision: storedNoteRevision(note)
  };
}

export async function createRevisionedEncryptedNote(input: SaveNoteInput): Promise<CreatedRevisionedNoteResult> {
  const { historySnapshot, historySummary, ...noteInput } = input;
  const noteRef = doc(collection(db, "notes"));
  const historyRef = doc(collection(db, "notes", noteRef.id, "history"));
  const batch = writeBatch(db);
  const participantUids = Array.from(new Set(input.participantUids));
  const revision = initialNoteRevision;
  const lastMutationId = historyRef.id;
  const historyDocument = noteHistoryDocument(
    noteRef.id,
    input.ownerUid,
    "create",
    ["title", "body"],
    participantUids,
    revision,
    historySummary,
    historySnapshot
  );

  if (!historyDocument) {
    throw new Error("노트 생성 이력을 만들 수 없습니다.");
  }

  batch.set(noteRef, {
    ...noteInput,
    attachmentRevision: 0,
    participantUids,
    folderId: input.type === "personal" ? input.folderId ?? null : null,
    createdAt: serverTimestamp(),
    isDeleted: false,
    lastMutationId,
    revision,
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: input.ownerUid
  });
  batch.set(historyRef, historyDocument);

  await batch.commit();
  return { lastMutationId, noteId: noteRef.id, noteRef, revision };
}

export async function createEncryptedNote(input: SaveNoteInput) {
  return (await createRevisionedEncryptedNote(input)).noteRef;
}

export async function updateRevisionedEncryptedNote(input: UpdateRevisionedEncryptedNoteInput) {
  return commitRevisionedNoteMutation({
    action: "content",
    changedFields: input.changedFields ?? ["title", "body"],
    encryptedSnapshot: input.historySnapshot,
    encryptedSummary: input.historySummary,
    expectedRevision: expectedNoteRevision(input.expectedRevision),
    noteId: input.noteId,
    readerUids: input.readerUids,
    uid: input.uid,
    update: {
      encryptedTitle: input.encryptedTitle,
      encryptedBody: input.encryptedBody,
      isDeleted: false,
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    }
  });
}

export async function updateEncryptedNote(
  noteId: string,
  uid: string,
  encryptedTitle: EncryptedPayload,
  encryptedBody: EncryptedPayload,
  changedFields: string[] = ["title", "body"],
  readerUids: string[],
  historySummary?: EncryptedPayload,
  historySnapshot?: EncryptedPayload
) {
  return commitRevisionedNoteMutation({
    action: "content",
    changedFields,
    encryptedSnapshot: historySnapshot,
    encryptedSummary: historySummary,
    noteId,
    readerUids,
    uid,
    update: {
      encryptedTitle,
      encryptedBody,
      isDeleted: false,
      updatedAt: serverTimestamp(),
      updatedBy: uid
    }
  });
}

export async function updateRevisionedNoteAccess(input: UpdateRevisionedNoteAccessInput) {
  return commitRevisionedNoteAccess(input, expectedNoteRevision(input.expectedRevision));
}

export async function updateNoteAccess(
  noteId: string,
  uid: string,
  type: NoteKind,
  participantUids: string[],
  wrappedKeys: Record<string, WrappedNoteKey>,
  folderId: string | null = null
) {
  return commitRevisionedNoteAccess({ noteId, uid, type, participantUids, wrappedKeys, folderId });
}

export async function updateNoteFolder(noteId: string, uid: string, folderId: string | null) {
  await updateDoc(doc(db, "notes", noteId), {
    folderId,
    isDeleted: false,
    updatedAt: serverTimestamp(),
    updatedBy: uid
  });
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

function noteHistoryDocument(
  noteId: string,
  uid: string,
  action: NoteHistoryAction,
  changedFields: string[],
  readerUids: string[],
  revision: number,
  encryptedSummary?: EncryptedPayload,
  encryptedSnapshot?: EncryptedPayload
) {
  const normalizedFields = Array.from(new Set(changedFields)).filter(Boolean);
  const normalizedReaderUids = Array.from(new Set(readerUids)).filter(Boolean);

  if (!normalizedFields.length || !normalizedReaderUids.length) {
    return null;
  }

  return {
    noteId,
    actorUid: uid,
    action,
    changedFields: normalizedFields,
    readerUids: normalizedReaderUids,
    ...(encryptedSummary ? { encryptedSummary } : {}),
    ...(encryptedSnapshot ? { encryptedSnapshot } : {}),
    revision,
    createdAt: serverTimestamp()
  } satisfies Omit<NoteHistoryDocument, "createdAt"> & { createdAt: ReturnType<typeof serverTimestamp> };
}

interface RevisionedNoteMutationInput {
  action: NoteHistoryAction;
  changedFields: string[];
  encryptedSnapshot?: EncryptedPayload;
  encryptedSummary?: EncryptedPayload;
  expectedRevision?: number;
  noteId: string;
  readerUids: string[];
  uid: string;
  update: Record<string, unknown>;
}

async function commitRevisionedNoteMutation(input: RevisionedNoteMutationInput): Promise<NoteMutationResult> {
  const noteRef = doc(db, "notes", input.noteId);
  const historyRef = doc(collection(db, "notes", input.noteId, "history"));
  const lastMutationId = historyRef.id;

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(noteRef);

    if (!snapshot.exists()) {
      throw new Error("저장할 노트를 찾을 수 없습니다.");
    }

    const currentRevision = storedNoteRevision(snapshot.data() as NoteDocument);

    if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision) {
      throw new NoteRevisionConflictError(input.expectedRevision, currentRevision);
    }

    const revision = currentRevision + 1;
    const historyDocument = noteHistoryDocument(
      input.noteId,
      input.uid,
      input.action,
      input.changedFields,
      input.readerUids,
      revision,
      input.encryptedSummary,
      input.encryptedSnapshot
    );

    if (!historyDocument) {
      throw new Error("노트 변경 이력을 만들 수 없습니다.");
    }

    transaction.update(noteRef, {
      ...input.update,
      lastMutationId,
      revision
    });
    transaction.set(historyRef, historyDocument);

    return { lastMutationId, noteId: input.noteId, revision };
  });
}

type CompatibleRevisionedNoteAccessInput = Omit<UpdateRevisionedNoteAccessInput, "expectedRevision"> & {
  expectedRevision?: number;
};

function commitRevisionedNoteAccess(input: CompatibleRevisionedNoteAccessInput, expectedRevision?: number) {
  const normalizedParticipantUids = Array.from(new Set(input.participantUids));

  return commitRevisionedNoteMutation({
    action: "share",
    changedFields: ["participants"],
    expectedRevision,
    noteId: input.noteId,
    readerUids: normalizedParticipantUids,
    uid: input.uid,
    update: {
      type: input.type,
      participantUids: normalizedParticipantUids,
      wrappedKeys: input.wrappedKeys,
      folderId: input.type === "personal" ? input.folderId ?? null : null,
      isDeleted: false,
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    }
  });
}

export async function createNoteAttachment(input: SaveNoteAttachmentInput) {
  const attachmentRef = doc(collection(db, "notes", input.noteId, "attachments"));

  await uploadNoteAttachmentBlob({
    attachmentId: attachmentRef.id,
    noteId: input.noteId,
    fileName: input.fileName,
    extension: input.extension,
    mimeType: input.mimeType,
    originalSize: input.originalSize,
    encryptedBlob: input.encryptedBlob,
    encryption: input.encryption,
    onUploadProgress: input.onUploadProgress,
    uploadedBy: input.uploadedBy
  });

  return attachmentRef;
}

export async function getEncryptedNoteAttachmentBytes(attachment: StoredAttachmentDocument) {
  if (attachment.encryptedData) {
    return attachment.encryptedData.toUint8Array();
  }

  if (attachment.blobPath) {
    if (!attachment.id) {
      throw new Error("첨부파일 식별자를 찾을 수 없습니다.");
    }

    return fetchBlobAttachmentBytes(
      { scope: "note", noteId: attachment.noteId, attachmentId: attachment.id },
      encryptedAttachmentSizeLimit(attachment)
    );
  }

  if (!attachment.storagePath) {
    throw new Error("첨부파일 암호문 위치를 찾을 수 없습니다.");
  }

  return new Uint8Array(await getBytes(ref(storage, attachment.storagePath), maxEncryptedAttachmentBytes));
}

export async function getEncryptedNoteAttachmentSource(attachment: StoredAttachmentDocument): Promise<EncryptedAttachmentSource> {
  if (attachment.encryptedData) {
    return { bytes: attachment.encryptedData.toUint8Array() };
  }

  if (attachment.blobPath) {
    if (!attachment.id) {
      throw new Error("첨부파일 식별자를 찾을 수 없습니다.");
    }

    return {
      response: await fetchBlobAttachmentResponse(
        { scope: "note", noteId: attachment.noteId, attachmentId: attachment.id },
        encryptedAttachmentSizeLimit(attachment)
      )
    };
  }

  if (!attachment.storagePath) {
    throw new Error("첨부파일 암호문 위치를 찾을 수 없습니다.");
  }

  return { bytes: new Uint8Array(await getBytes(ref(storage, attachment.storagePath), maxEncryptedAttachmentBytes)) };
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
  await deleteBlobAttachment({ scope: "note", noteId, attachmentId });
}

export async function deleteRevisionedNote(input: RevisionedNoteLifecycleInput) {
  return commitRevisionedNoteMutation({
    action: "delete",
    changedFields: ["deleted"],
    expectedRevision: expectedNoteRevision(input.expectedRevision),
    noteId: input.noteId,
    readerUids: input.readerUids,
    uid: input.uid,
    update: {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: input.uid,
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    }
  });
}

export async function deleteNote(noteId: string, uid: string, readerUids: string[]) {
  return commitRevisionedNoteMutation({
    action: "delete",
    changedFields: ["deleted"],
    noteId,
    readerUids,
    uid,
    update: {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid
    }
  });
}

export async function restoreRevisionedNote(input: RevisionedNoteLifecycleInput) {
  return commitRevisionedNoteMutation({
    action: "restore",
    changedFields: ["restored"],
    expectedRevision: expectedNoteRevision(input.expectedRevision),
    noteId: input.noteId,
    readerUids: input.readerUids,
    uid: input.uid,
    update: {
      isDeleted: false,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    }
  });
}

export async function restoreNote(noteId: string, uid: string, readerUids: string[]) {
  return commitRevisionedNoteMutation({
    action: "restore",
    changedFields: ["restored"],
    noteId,
    readerUids,
    uid,
    update: {
      isDeleted: false,
      deletedAt: deleteField(),
      deletedBy: deleteField(),
      updatedAt: serverTimestamp(),
      updatedBy: uid
    }
  });
}

export async function purgeNote(input: PurgeNoteInput) {
  const noteRef = doc(db, "notes", input.noteId);
  const cleanupQueueRef = doc(db, "notePurgeCleanupQueue", input.noteId);
  const batch = writeBatch(db);

  batch.update(noteRef, {
    type: "personal",
    participantUids: [input.uid],
    wrappedKeys: {
      [input.uid]: input.wrappedKey
    },
    encryptedTitle: input.encryptedTitle,
    encryptedBody: input.encryptedBody,
    folderId: deleteField(),
    dueAt: deleteField(),
    deletedAt: deleteField(),
    deletedBy: deleteField(),
    isDeleted: true,
    isPurged: true,
    purgedAt: serverTimestamp(),
    purgedBy: input.uid,
    updatedAt: serverTimestamp(),
    savedAt: serverTimestamp(),
    updatedBy: input.uid
  });
  batch.set(cleanupQueueRef, {
    noteId: input.noteId,
    ownerUid: input.ownerUid,
    createdAt: serverTimestamp()
  });

  await batch.commit();
}
