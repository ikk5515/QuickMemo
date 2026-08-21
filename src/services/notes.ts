import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { getBytes, ref } from "firebase/storage";
import { maxEncryptedAttachmentBytes } from "../lib/attachments";
import { encryptedAttachmentSizeLimit, type AttachmentEncryptionMetadata, type EncryptedAttachmentSource } from "../lib/attachmentCrypto";
import { db, getLegacyStorage } from "../lib/firebase";
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
  VaultContentFormat,
  VaultEntryKind,
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
  contentFormat?: VaultContentFormat;
  entryKind?: VaultEntryKind;
  folderId?: string | null;
  historySummary?: EncryptedPayload;
  historySnapshot?: EncryptedPayload;
}

export interface NoteMutationResult {
  lastMutationId: string;
  noteId: string;
  revision: number;
}

export interface CreateEncryptedNoteFolderInput {
  color: string;
  encryptedName: EncryptedPayload;
  order: number;
  ownerUid: string;
  parentId: string | null;
  wrappedKey: WrappedNoteKey;
}

export interface UpdateEncryptedNoteFolderInput {
  encryptedName?: EncryptedPayload;
  expectedRevision: number;
  folderId: string;
  order?: number;
  ownerUid: string;
  parentId?: string | null;
}

export interface MigrateLegacyNoteFolderInput extends CreateEncryptedNoteFolderInput {
  expectedName: string;
  folderId: string;
}

export interface CreatedRevisionedNoteResult extends NoteMutationResult {
  noteRef: ReturnType<typeof doc>;
}

export interface CreateSecureShareCopyingNoteInput extends SaveNoteInput {
  copyJobId: string;
  expectedAttachmentCount: number;
}

export interface SecureShareCopyingNoteLifecycleInput {
  copyJobId: string;
  expectedRevision: number;
  noteId: string;
  uid: string;
}

export interface UpdateRevisionedEncryptedNoteInput {
  changedFields?: string[];
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  expectedContentFormat: VaultContentFormat;
  expectedEntryKind: VaultEntryKind;
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

export interface UpdateRevisionedNoteFolderInput {
  expectedRevision: number;
  folderId: string | null;
  noteId: string;
  readerUids: string[];
  uid: string;
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

export class NoteFolderLimitError extends Error {
  readonly code = "note-folder/resource-limit-exceeded";
  readonly context: "create" | "subscription";
  readonly maxFolders: number;

  constructor(maxFolders: number, context: "create" | "subscription" = "create") {
    super(context === "subscription"
      ? `폴더가 ${maxFolders.toLocaleString("ko-KR")}개를 초과해 전체 목록을 표시하지 않았습니다. 기존 폴더를 삭제한 뒤 다시 확인해주세요.`
      : `폴더는 최대 ${maxFolders.toLocaleString("ko-KR")}개까지 만들 수 있습니다. 새 폴더를 만들려면 기존 폴더를 삭제해주세요.`);
    this.name = "NoteFolderLimitError";
    this.context = context;
    this.maxFolders = maxFolders;
  }
}

export function isLegacyHtmlNoteDocument(
  note: Pick<NoteDocument, "contentFormat" | "entryKind">
) {
  return (
    (!note.contentFormat && !note.entryKind)
    || (note.contentFormat === "legacy-html-v1" && note.entryKind === "legacy-html")
  );
}

function noteStorageIdentityMatches(
  note: Pick<NoteDocument, "contentFormat" | "entryKind">,
  expectedContentFormat: VaultContentFormat,
  expectedEntryKind: VaultEntryKind
) {
  if (isLegacyHtmlNoteDocument(note)) {
    return expectedContentFormat === "legacy-html-v1" && expectedEntryKind === "legacy-html";
  }
  return note.contentFormat === expectedContentFormat && note.entryKind === expectedEntryKind;
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
  secureShareCopyJobId?: string;
  onUploadProgress?: BlobAttachmentUploadProgressHandler;
  signal?: AbortSignal;
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
const maxEncryptedTitleCharacters = 4_096;
const maxEncryptedBodyCharacters = 700_000;
const maxEncryptedHistorySummaryCharacters = 8_192;
const maxEncryptedHistorySnapshotCharacters = 700_000;
const maxEncryptedIvCharacters = 256;
export const maxNoteFoldersPerOwner = 5_000;
const noteFolderSubscriptionSentinelLimit = maxNoteFoldersPerOwner + 1;

function assertEncryptedPayloadSize(
  payload: EncryptedPayload | undefined,
  label: string,
  maxCipherTextCharacters: number
) {
  if (!payload) {
    return;
  }
  if (
    payload.algorithm !== "AES-GCM"
    || payload.version !== 1
    || !payload.cipherText
    || payload.cipherText.length > maxCipherTextCharacters
    || !payload.iv
    || payload.iv.length > maxEncryptedIvCharacters
  ) {
    throw new Error(`${label} 암호문 크기 또는 형식이 올바르지 않습니다.`);
  }
}

function assertEncryptedNotePayloadSizes(input: Pick<
  SaveNoteInput,
  "encryptedBody" | "encryptedTitle" | "historySnapshot" | "historySummary"
>) {
  assertEncryptedPayloadSize(input.encryptedTitle, "노트 제목", maxEncryptedTitleCharacters);
  assertEncryptedPayloadSize(input.encryptedBody, "노트 본문", maxEncryptedBodyCharacters);
  assertEncryptedPayloadSize(input.historySummary, "노트 이력 요약", maxEncryptedHistorySummaryCharacters);
  assertEncryptedPayloadSize(input.historySnapshot, "노트 이력 스냅샷", maxEncryptedHistorySnapshotCharacters);
}

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
  return document.isDeleted !== true
    && document.secureShareCopyState !== "copying"
    && document.secureShareCopyState !== "aborted"
    && !purgedNote(document);
}

function deletedNote(document: NoteSnapshot) {
  return document.isDeleted === true
    && document.secureShareCopyState !== "copying"
    && document.secureShareCopyState !== "aborted"
    && !purgedNote(document);
}

const legacyDeletionMetadataRepairs = new Map<string, Promise<boolean>>();
interface LegacyDeletionMetadataMigrationState {
  completed: boolean;
  cursor?: { id: string };
  inFlight?: Promise<void>;
}

const legacyDeletionMetadataMigrationStates = new Map<string, LegacyDeletionMetadataMigrationState>();
const legacyDeletionMetadataMigrationPageSize = 100;
const legacyDeletionMetadataMigrationMaxDocuments = 500;

function hasDeletionMetadata(document: NoteSnapshot) {
  return Object.prototype.hasOwnProperty.call(document, "isDeleted");
}

function normalizeLegacyDeletionMetadata(notes: NoteSnapshot[]) {
  return notes.flatMap((note) => {
    const existingRepair = legacyDeletionMetadataRepairs.get(note.id);
    if (existingRepair) {
      return [existingRepair];
    }
    if (hasDeletionMetadata(note) || !visibleNote(note)) {
      return [];
    }

    const repair = updateDoc(doc(db, "notes", note.id), { isDeleted: false })
      .then(() => true)
      .catch(() => {
        legacyDeletionMetadataRepairs.delete(note.id);
        return false;
      });
    legacyDeletionMetadataRepairs.set(note.id, repair);
    return [repair];
  });
}

function migrateLegacyDeletionMetadata(uid: string, adminScope: boolean) {
  const migrationKey = adminScope ? "admin" : `owner:${uid}`;
  const state = legacyDeletionMetadataMigrationStates.get(migrationKey) ?? { completed: false };
  legacyDeletionMetadataMigrationStates.set(migrationKey, state);

  if (state.completed) {
    return Promise.resolve();
  }
  if (state.inFlight) {
    return state.inFlight;
  }

  const migrationRun = (async () => {
    let scannedDocuments = 0;

    while (scannedDocuments < legacyDeletionMetadataMigrationMaxDocuments) {
      const pageLimit = Math.min(
        legacyDeletionMetadataMigrationPageSize,
        legacyDeletionMetadataMigrationMaxDocuments - scannedDocuments
      );
      const baseConstraints = adminScope
        ? [orderBy("updatedAt", "desc")]
        : [where("ownerUid", "==", uid), orderBy("updatedAt", "desc")];
      const pageQuery = query(
        collection(db, "notes"),
        ...baseConstraints,
        ...(state.cursor ? [startAfter(state.cursor)] : []),
        limit(pageLimit)
      );
      const snapshot = await getDocs(pageQuery);

      if (!snapshot.docs.length) {
        state.completed = true;
        break;
      }

      scannedDocuments += snapshot.docs.length;
      const notes = snapshot.docs.map((document) => ({
        id: document.id,
        ...(document.data() as NoteDocument)
      }));
      const repairs = await Promise.all(normalizeLegacyDeletionMetadata(notes));

      // Do not move past a document whose normalization failed. A later
      // subscription can safely retry this same page without rescanning the
      // already-completed newest pages.
      if (repairs.some((repaired) => !repaired)) {
        break;
      }

      if (snapshot.docs.length < pageLimit) {
        state.completed = true;
        break;
      }

      state.cursor = snapshot.docs.at(-1);
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      if (state.inFlight === migrationRun) {
        state.inFlight = undefined;
      }
    });

  state.inFlight = migrationRun;
  return migrationRun;
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
  onError?: (error: Error) => void,
  maximumNotes?: number
) {
  const noteFilter = deleted ? deletedNote : visibleNote;

  if (ownerUids === null) {
    if (!deleted && maximumNotes) {
      void migrateLegacyDeletionMetadata(uid, true);
      const boundedMaximum = Math.min(2_000, Math.max(1, Math.floor(maximumNotes)));
      const notesQuery = query(
        collection(db, "notes"),
        where("isDeleted", "==", false),
        orderBy("updatedAt", "desc"),
        limit(boundedMaximum)
      );

      return onSnapshot(
        notesQuery,
        (snapshot) => {
          callback(noteSnapshotList(snapshot, noteFilter).slice(0, boundedMaximum));
        },
        (error) => onError?.(error)
      );
    }

    const notesQuery = deleted
      ? query(
          collection(db, "notes"),
          where("isDeleted", "==", true),
          where("participantUids", "array-contains", uid),
          orderBy("updatedAt", "desc")
        )
      : query(
          collection(db, "notes"),
          where("isDeleted", "==", false),
          where("participantUids", "array-contains", uid),
          orderBy("updatedAt", "desc")
        );

    if (!deleted) {
      void migrateLegacyDeletionMetadata(uid, true);
    }

    return onSnapshot(
      notesQuery,
      (snapshot) => {
        callback(noteSnapshotList(snapshot, noteFilter));
      },
      (error) => onError?.(error)
    );
  }

  const normalizedOwnerUids = Array.from(new Set(deleted ? [uid] : [uid, ...ownerUids])).filter(Boolean);
  const boundedMaximum = maximumNotes
    ? Math.min(2_000, Math.max(1, Math.floor(maximumNotes)))
    : null;
  const notesByOwner = new Map<string, NoteSnapshot[]>();
  let closed = false;

  if (!deleted) {
    void migrateLegacyDeletionMetadata(uid, false);
  }

  const emitNotes = () => {
    if (closed) {
      return;
    }

    const merged = Array.from(notesByOwner.values())
      .flat()
      .sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt));
    callback(boundedMaximum ? merged.slice(0, boundedMaximum) : merged);
  };

  const unsubscribes = normalizedOwnerUids.map((ownerUid) => {
    const baseConstraints = [
      where("ownerUid", "==", ownerUid),
      where("isDeleted", "==", deleted),
      where("participantUids", "array-contains", uid),
      orderBy("updatedAt", "desc")
    ];
    const notesQuery = boundedMaximum
      ? query(collection(db, "notes"), ...baseConstraints, limit(boundedMaximum))
      : query(collection(db, "notes"), ...baseConstraints);

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
  onError?: (error: Error) => void,
  maximumNotes?: number
) {
  return subscribeNotesByDeletedState(uid, ownerUids, false, callback, onError, maximumNotes);
}

export async function getVisibleNotesByIds(uid: string, noteIds: string[]) {
  const uniqueIds = Array.from(new Set(noteIds)).filter(Boolean).slice(0, 1_200);
  const notes: NoteSnapshot[] = [];
  const resolvedNoteIds: string[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueIds.length) {
      const noteId = uniqueIds[nextIndex];
      nextIndex += 1;

      try {
        const snapshot = await getDoc(doc(db, "notes", noteId));
        resolvedNoteIds.push(noteId);

        if (!snapshot.exists()) {
          continue;
        }

        const note = { id: snapshot.id, ...(snapshot.data() as NoteDocument) };

        if (visibleNote(note) && note.participantUids.includes(uid)) {
          notes.push(note);
        }
      } catch {
        // One deleted, revoked, or temporarily unreadable source must not hide
        // the user's other independently authorized source notes.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(8, uniqueIds.length) }, worker));

  normalizeLegacyDeletionMetadata(notes);
  return { notes: sortedByUpdatedAt(notes), resolvedNoteIds };
}

export function subscribeVisibleNoteById(
  uid: string,
  noteId: string,
  callback: (note: NoteSnapshot) => void,
  onUnavailable: (error?: Error) => void
) {
  return onSnapshot(
    doc(db, "notes", noteId),
    (snapshot) => {
      if (!snapshot.exists()) {
        onUnavailable();
        return;
      }

      const note = { id: snapshot.id, ...(snapshot.data() as NoteDocument) };

      if (!visibleNote(note) || !note.participantUids.includes(uid)) {
        onUnavailable();
        return;
      }

      callback(note);
    },
    (error) => onUnavailable(error)
  );
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

export async function getAllNoteAttachments(noteId: string) {
  const attachmentsQuery = query(collection(db, "notes", noteId, "attachments"), orderBy("createdAt", "desc"));
  const snapshot = await getDocs(attachmentsQuery);

  return snapshot.docs.map((document) => ({
    id: document.id,
    ...(document.data() as NoteAttachmentDocument)
  })) satisfies NoteAttachmentSnapshot[];
}

export async function listStaleSecureShareCopyingNotes(
  uid: string,
  updatedBefore: Date,
  maximumNotes = 20
) {
  if (!uid || !Number.isFinite(updatedBefore.getTime())) {
    throw new Error("보안 공유 복사 작업 조회 조건이 올바르지 않습니다.");
  }

  const boundedMaximum = Math.min(50, Math.max(1, Math.floor(maximumNotes)));
  const snapshot = await getDocs(query(
    collection(db, "notes"),
    where("ownerUid", "==", uid),
    where("secureShareCopyState", "==", "copying"),
    where("secureShareCopyUpdatedAt", "<=", updatedBefore),
    orderBy("secureShareCopyUpdatedAt", "asc"),
    limit(boundedMaximum)
  ));

  return snapshot.docs.map((document) => ({
    id: document.id,
    ...(document.data() as NoteDocument)
  })) satisfies NoteSnapshot[];
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

async function createRevisionedEncryptedNoteWithFields(
  input: SaveNoteInput,
  additionalFields: Record<string, unknown> = {}
): Promise<CreatedRevisionedNoteResult> {
  assertEncryptedNotePayloadSizes(input);
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
    ...additionalFields,
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

export async function createRevisionedEncryptedNote(input: SaveNoteInput): Promise<CreatedRevisionedNoteResult> {
  return createRevisionedEncryptedNoteWithFields(input);
}

export async function createSecureShareCopyingNote(
  input: CreateSecureShareCopyingNoteInput
): Promise<CreatedRevisionedNoteResult> {
  if (
    input.type !== "personal"
    || input.ownerUid.length === 0
    || input.participantUids.length !== 1
    || input.participantUids[0] !== input.ownerUid
    || !/^[A-Za-z0-9_-]{16,160}$/u.test(input.copyJobId)
    || !Number.isSafeInteger(input.expectedAttachmentCount)
    || input.expectedAttachmentCount < 0
    || input.expectedAttachmentCount > 100
  ) {
    throw new Error("보안 공유 복사 작업 정보가 올바르지 않습니다.");
  }

  const {
    copyJobId,
    expectedAttachmentCount,
    ...noteInput
  } = input;

  return createRevisionedEncryptedNoteWithFields(noteInput, {
    secureShareCopyExpectedAttachmentCount: expectedAttachmentCount,
    secureShareCopyJobId: copyJobId,
    secureShareCopyReadyAttachmentCount: 0,
    secureShareCopyReservedAttachmentCount: 0,
    secureShareCopyStartedAt: serverTimestamp(),
    secureShareCopyState: "copying",
    secureShareCopyUpdatedAt: serverTimestamp()
  });
}

export async function activateSecureShareCopyingNote(
  input: SecureShareCopyingNoteLifecycleInput
): Promise<{ noteId: string; state: "active" }> {
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const noteRef = doc(db, "notes", input.noteId);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(noteRef);

    if (!snapshot.exists()) {
      throw new Error("활성화할 복사 노트를 찾을 수 없습니다.");
    }

    const note = snapshot.data() as NoteDocument;

    if (
      note.ownerUid !== input.uid
      || note.secureShareCopyJobId !== input.copyJobId
      || storedNoteRevision(note) !== expectedRevision
    ) {
      throw new Error("보안 공유 복사 작업이 현재 노트와 일치하지 않습니다.");
    }

    if (note.secureShareCopyState === "active") {
      return { noteId: input.noteId, state: "active" as const };
    }

    const expectedCount = note.secureShareCopyExpectedAttachmentCount;
    const reservedCount = note.secureShareCopyReservedAttachmentCount;
    const readyCount = note.secureShareCopyReadyAttachmentCount;

    if (
      note.secureShareCopyState !== "copying"
      || note.isDeleted === true
      || Boolean(
        note.secureShareCopyCleanupClaimId
        || note.secureShareCopyCleanupClaimedAt
      )
      || !Number.isSafeInteger(expectedCount)
      || reservedCount !== expectedCount
      || readyCount !== expectedCount
    ) {
      throw new Error("복사할 첨부파일이 모두 준비되지 않았습니다.");
    }

    transaction.update(noteRef, {
      savedAt: serverTimestamp(),
      secureShareCopyFinishedAt: serverTimestamp(),
      secureShareCopyState: "active",
      secureShareCopyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    });

    return { noteId: input.noteId, state: "active" as const };
  });
}

export async function createEncryptedNote(input: SaveNoteInput) {
  return (await createRevisionedEncryptedNote(input)).noteRef;
}

export async function updateRevisionedEncryptedNote(input: UpdateRevisionedEncryptedNoteInput) {
  assertEncryptedNotePayloadSizes(input);
  return commitRevisionedNoteMutation({
    action: "content",
    changedFields: input.changedFields ?? ["title", "body"],
    encryptedSnapshot: input.historySnapshot,
    encryptedSummary: input.historySummary,
    expectedRevision: expectedNoteRevision(input.expectedRevision),
    noteId: input.noteId,
    readerUids: input.readerUids,
    uid: input.uid,
    validateCurrent: (note) => noteStorageIdentityMatches(
      note,
      input.expectedContentFormat,
      input.expectedEntryKind
    ),
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
    validateCurrent: isLegacyHtmlNoteDocument,
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

export async function updateRevisionedNoteFolder(input: UpdateRevisionedNoteFolderInput) {
  return commitRevisionedNoteMutation({
    action: "share",
    changedFields: ["folder"],
    expectedRevision: expectedNoteRevision(input.expectedRevision),
    noteId: input.noteId,
    readerUids: input.readerUids,
    uid: input.uid,
    update: {
      folderId: input.folderId,
      isDeleted: false,
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    },
    validateCurrent: (note) => (
      note.ownerUid === input.uid
      && note.type === "personal"
      && (note.folderId ?? null) !== input.folderId
    )
  });
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
  changedFields: string[] | ((currentNote: NoteDocument) => string[]);
  encryptedSnapshot?: EncryptedPayload;
  encryptedSummary?: EncryptedPayload;
  expectedRevision?: number;
  noteId: string;
  readerUids: string[];
  uid: string;
  update: Record<string, unknown>;
  validateCurrent?: (note: NoteDocument) => boolean;
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

    const currentNote = snapshot.data() as NoteDocument;
    const currentRevision = storedNoteRevision(currentNote);

    if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision) {
      throw new NoteRevisionConflictError(input.expectedRevision, currentRevision);
    }
    if (currentRevision >= maxNoteRevision) {
      throw new Error("노트 revision이 안전한 저장 범위를 초과했습니다.");
    }
    if (input.validateCurrent && !input.validateCurrent(currentNote)) {
      throw new Error("현재 노트 상태가 요청한 작업과 일치하지 않습니다.");
    }

    const revision = currentRevision + 1;
    const changedFields = typeof input.changedFields === "function"
      ? input.changedFields(currentNote)
      : input.changedFields;
    const historyDocument = noteHistoryDocument(
      input.noteId,
      input.uid,
      input.action,
      changedFields,
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
  const nextFolderId = input.type === "personal" ? input.folderId ?? null : null;

  return commitRevisionedNoteMutation({
    action: "share",
    changedFields: (currentNote) => {
      const currentWrappedKeys = currentNote.wrappedKeys ?? {};
      const currentWrappedKeyIds = Object.keys(currentWrappedKeys).sort();
      const nextWrappedKeyIds = Object.keys(input.wrappedKeys).sort();
      const wrappedKeysChanged = currentWrappedKeyIds.length !== nextWrappedKeyIds.length
        || currentWrappedKeyIds.some((uid, index) => {
          const current = currentWrappedKeys[uid];
          const next = input.wrappedKeys[nextWrappedKeyIds[index]];
          return uid !== nextWrappedKeyIds[index]
            || current?.version !== next?.version
            || current?.algorithm !== next?.algorithm
            || current?.wrappedKey !== next?.wrappedKey;
        });
      const currentParticipantUids = currentNote.participantUids ?? [];
      const participantsChanged = currentNote.type !== input.type
        || currentParticipantUids.length !== normalizedParticipantUids.length
        || currentParticipantUids.some((uid, index) => uid !== normalizedParticipantUids[index])
        || wrappedKeysChanged;
      const folderChanged = (currentNote.folderId ?? null) !== nextFolderId;
      return [
        ...(participantsChanged ? ["participants"] : []),
        ...(folderChanged ? ["folder"] : [])
      ];
    },
    expectedRevision,
    noteId: input.noteId,
    readerUids: normalizedParticipantUids,
    uid: input.uid,
    update: {
      type: input.type,
      participantUids: normalizedParticipantUids,
      wrappedKeys: input.wrappedKeys,
      folderId: nextFolderId,
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
    secureShareCopyJobId: input.secureShareCopyJobId,
    signal: input.signal,
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

  return new Uint8Array(
    await getBytes(ref(getLegacyStorage(), attachment.storagePath), maxEncryptedAttachmentBytes)
  );
}

export async function getEncryptedNoteAttachmentSource(
  attachment: StoredAttachmentDocument,
  signal?: AbortSignal
): Promise<EncryptedAttachmentSource> {
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
        encryptedAttachmentSizeLimit(attachment),
        signal
      )
    };
  }

  if (!attachment.storagePath) {
    throw new Error("첨부파일 암호문 위치를 찾을 수 없습니다.");
  }

  return {
    bytes: new Uint8Array(
      await getBytes(ref(getLegacyStorage(), attachment.storagePath), maxEncryptedAttachmentBytes)
    )
  };
}

export function subscribeNoteFolders(
  uid: string,
  callback: (folders: NoteFolderSnapshot[]) => void,
  onError: (error: Error) => void
) {
  const foldersQuery = query(
    collection(db, "noteFolders"),
    where("ownerUid", "==", uid),
    limit(noteFolderSubscriptionSentinelLimit)
  );
  let limitExceeded = false;

  return onSnapshot(
    foldersQuery,
    (snapshot) => {
      if (snapshot.docs.length > maxNoteFoldersPerOwner) {
        if (!limitExceeded) {
          onError(new NoteFolderLimitError(maxNoteFoldersPerOwner, "subscription"));
        }
        limitExceeded = true;
        return;
      }

      limitExceeded = false;
      callback(
        snapshot.docs
          .map((document) => ({ id: document.id, ...(document.data() as NoteFolderDocument) }))
          .sort((left, right) => {
            const orderDifference = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
            return orderDifference || left.name.localeCompare(right.name, "ko");
          })
      );
    },
    onError
  );
}

export async function createNoteFolder(uid: string, name: string, color: string) {
  const folderCount = await getCountFromServer(query(
    collection(db, "noteFolders"),
    where("ownerUid", "==", uid),
    limit(maxNoteFoldersPerOwner)
  ));
  if (folderCount.data().count >= maxNoteFoldersPerOwner) {
    throw new NoteFolderLimitError(maxNoteFoldersPerOwner);
  }

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

export async function createEncryptedNoteFolder(input: CreateEncryptedNoteFolderInput) {
  assertEncryptedPayloadSize(input.encryptedName, "폴더 이름", 2_048);
  if (
    !input.ownerUid
    || input.ownerUid.length > 160
    || !Number.isSafeInteger(input.order)
    || input.order < 0
    || input.order > 999_999_999
    || (input.parentId !== null && (
      !input.parentId
      || input.parentId.length > 120
      || input.parentId.includes("/")
    ))
  ) {
    throw new Error("암호화 폴더 정보가 올바르지 않습니다.");
  }
  const folderRef = doc(collection(db, "noteFolders"));
  await runTransaction(db, async (transaction) => {
    if (input.parentId) {
      const parentSnapshot = await transaction.get(doc(db, "noteFolders", input.parentId));
      if (!parentSnapshot.exists()) {
        throw new Error("상위 폴더를 찾을 수 없습니다.");
      }
      const parent = parentSnapshot.data() as NoteFolderDocument;
      if (
        parent.ownerUid !== input.ownerUid
        || !parent.encryptedName
        || !parent.wrappedKey
        || !Number.isSafeInteger(parent.revision)
      ) {
        throw new Error("상위 폴더를 먼저 암호화해주세요.");
      }
    }

    transaction.set(folderRef, {
      ownerUid: input.ownerUid,
      // Historical clients require a non-empty name. It deliberately contains
      // no user folder text; unlocked vault clients render encryptedName.
      name: "암호화 폴더",
      color: input.color,
      encryptedName: input.encryptedName,
      wrappedKey: input.wrappedKey,
      parentId: input.parentId,
      order: input.order,
      revision: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    } satisfies Omit<NoteFolderDocument, "createdAt" | "updatedAt"> & {
      createdAt: ReturnType<typeof serverTimestamp>;
      updatedAt: ReturnType<typeof serverTimestamp>;
    });
  });
  return folderRef;
}

export async function updateEncryptedNoteFolder(input: UpdateEncryptedNoteFolderInput) {
  expectedNoteRevision(input.expectedRevision);
  if (!input.folderId || input.folderId.length > 120 || input.folderId.includes("/")) {
    throw new Error("폴더 식별자가 올바르지 않습니다.");
  }
  if (input.encryptedName) {
    assertEncryptedPayloadSize(input.encryptedName, "폴더 이름", 2_048);
  }
  if (
    input.order !== undefined
    && (!Number.isSafeInteger(input.order) || input.order < 0 || input.order > 999_999_999)
  ) {
    throw new Error("폴더 정렬 순서가 올바르지 않습니다.");
  }
  if (
    input.parentId !== undefined
    && input.parentId !== null
    && (!input.parentId || input.parentId.length > 120 || input.parentId.includes("/"))
  ) {
    throw new Error("상위 폴더 식별자가 올바르지 않습니다.");
  }
  const folderRef = doc(db, "noteFolders", input.folderId);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(folderRef);

    if (!snapshot.exists()) {
      throw new Error("변경할 폴더를 찾을 수 없습니다.");
    }

    const folder = snapshot.data() as NoteFolderDocument;
    const revision = folder.revision ?? 0;

    if (folder.ownerUid !== input.ownerUid || revision !== input.expectedRevision) {
      throw new NoteRevisionConflictError(input.expectedRevision, revision);
    }
    if (revision >= maxNoteRevision) {
      throw new Error("폴더 revision이 안전한 저장 범위를 초과했습니다.");
    }

    if (input.parentId !== undefined) {
      if (input.parentId === input.folderId) {
        throw new Error("폴더를 자기 자신 아래로 이동할 수 없습니다.");
      }

      const visited = new Set([input.folderId]);
      let ancestorId = input.parentId;
      let depth = 0;
      while (ancestorId !== null) {
        if (visited.has(ancestorId)) {
          throw new Error("하위 폴더 아래로 이동할 수 없습니다.");
        }
        if (depth >= 64) {
          throw new Error("폴더 중첩 깊이가 허용 범위를 초과했습니다.");
        }
        visited.add(ancestorId);
        const ancestorSnapshot = await transaction.get(doc(db, "noteFolders", ancestorId));
        if (!ancestorSnapshot.exists()) {
          throw new Error("상위 폴더를 찾을 수 없습니다.");
        }
        const ancestor = ancestorSnapshot.data() as NoteFolderDocument;
        if (
          ancestor.ownerUid !== input.ownerUid
          || !ancestor.encryptedName
          || !ancestor.wrappedKey
          || !Number.isSafeInteger(ancestor.revision)
        ) {
          throw new Error("다른 사용자의 폴더 아래로 이동할 수 없습니다.");
        }
        ancestorId = ancestor.parentId ?? null;
        depth += 1;
      }
    }

    const update: Record<string, unknown> = {
      revision: revision + 1,
      updatedAt: serverTimestamp()
    };

    if (input.encryptedName) {
      update.encryptedName = input.encryptedName;
    }
    if (input.parentId !== undefined) {
      update.parentId = input.parentId;
    }
    if (input.order !== undefined) {
      update.order = input.order;
    }

    transaction.update(folderRef, update);
    return { folderId: input.folderId, revision: revision + 1 };
  });
}

export async function migrateLegacyNoteFolder(input: MigrateLegacyNoteFolderInput) {
  const folderRef = doc(db, "noteFolders", input.folderId);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(folderRef);
    if (!snapshot.exists()) {
      throw new Error("마이그레이션할 폴더를 찾을 수 없습니다.");
    }

    const folder = snapshot.data() as NoteFolderDocument;
    if (folder.ownerUid !== input.ownerUid) {
      throw new Error("이 폴더를 변경할 권한이 없습니다.");
    }
    if (folder.encryptedName && folder.wrappedKey) {
      return { folderId: input.folderId, revision: folder.revision ?? 1 };
    }
    if (folder.name !== input.expectedName) {
      throw new Error("다른 탭에서 폴더 이름이 변경되었습니다. 다시 잠금 해제한 뒤 마이그레이션해주세요.");
    }

    transaction.update(folderRef, {
      name: "암호화 폴더",
      encryptedName: input.encryptedName,
      wrappedKey: input.wrappedKey,
      parentId: input.parentId,
      order: input.order,
      revision: 1,
      updatedAt: serverTimestamp()
    });
    return { folderId: input.folderId, revision: 1 };
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

export async function abortSecureShareCopyingNote(
  input: SecureShareCopyingNoteLifecycleInput
) {
  return commitRevisionedNoteMutation({
    action: "delete",
    changedFields: ["deleted"],
    expectedRevision: expectedNoteRevision(input.expectedRevision),
    noteId: input.noteId,
    readerUids: [input.uid],
    uid: input.uid,
    update: {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      deletedBy: input.uid,
      secureShareCopyFinishedAt: serverTimestamp(),
      secureShareCopyState: "aborted",
      secureShareCopyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: input.uid
    },
    validateCurrent: (note) =>
      note.ownerUid === input.uid
      && note.secureShareCopyJobId === input.copyJobId
      && note.secureShareCopyState === "copying"
      && !note.secureShareCopyCleanupClaimId
      && !note.secureShareCopyCleanupClaimedAt
      && note.secureShareCopyReadyAttachmentCount === 0
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
