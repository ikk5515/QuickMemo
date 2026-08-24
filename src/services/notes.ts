import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
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
  assertVaultFolderLifecyclePreflight,
  partitionVaultFolderTrash
} from "../features/vault/folderTrash";
import {
  deleteBlobAttachment,
  fetchBlobAttachmentBytes,
  fetchBlobAttachmentResponse,
  uploadNoteAttachmentBlob,
  type BlobAttachmentUploadProgressHandler
} from "./blobAttachments";
import {
  ensureVaultFolderTree,
  mutateVaultFolder,
  repairVaultFolderTree
} from "./vaultFolderMutations";
import {
  mutateVaultNote,
  vaultNoteAccessPayload,
  VaultNoteApiError,
  vaultNoteCreatePayload,
  vaultNoteImportCreatePayload,
  vaultNoteLifecyclePayload,
  vaultNoteMigrateLegacyPayload,
  vaultNotePurgePayload,
  vaultNoteSecureCopyCreatePayload,
  vaultNoteSecureCopyLifecyclePayload,
  type VaultNoteApiPayload,
  type VaultNoteMutationResultFor
} from "./vaultNoteMutations";
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
import type { VaultPathRewriteActivationInput } from "./vaultPathRewriteJobs";

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

export interface ServerSnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
  serverComplete: boolean;
}

const maximumVaultCutoverOwnedNotes = 20_000;

/**
 * Returns a server-confirmed, owner-only cutover snapshot. Historical active
 * notes without `isDeleted` remain visible in this one-time inventory so their
 * revision-aware migration can normalize them. The browser deliberately does
 * not repair them here: after marker activation those direct writes are denied,
 * and the server cutover seal owns the final normalization and verification.
 */
export interface OwnedVaultCutoverInventory {
  /** Complete raw owner inventory; callers apply the same lifecycle filter as the server fence. */
  allNotes: NoteSnapshot[];
  activeNotes: NoteSnapshot[];
  deletedNotes: NoteSnapshot[];
}

export async function loadOwnedVaultCutoverInventory(
  uid: string
): Promise<OwnedVaultCutoverInventory> {
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new Error("Vault 소유자를 확인할 수 없습니다.");
  }
  const ownedQuery = query(
    collection(db, "notes"),
    where("ownerUid", "==", uid),
    limit(maximumVaultCutoverOwnedNotes + 1)
  );
  const readOwned = async () => {
    const snapshot = await getDocsFromServer(ownedQuery);
    if (snapshot.docs.length > maximumVaultCutoverOwnedNotes) {
      throw new Error("Vault 이름 예약 전환 한도를 초과했습니다.");
    }
    return snapshot.docs.map((document) => ({
      id: document.id,
      ...(document.data() as NoteDocument)
    }));
  };

  const notes = await readOwned();
  return {
    allNotes: notes,
    activeNotes: sortedByUpdatedAt(notes.filter(visibleNote)),
    deletedNotes: sortedByUpdatedAt(notes.filter(deletedNote))
  };
}

export async function loadOwnedVaultCutoverNotes(uid: string) {
  return (await loadOwnedVaultCutoverInventory(uid)).activeNotes;
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
  nameClaim?: VaultNameClaimReservationInput;
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
  nameClaim: VaultNameClaimReservationInput;
}

export interface VaultCutoverLeaseInput {
  leaseGeneration?: string;
  leaseId?: string;
}

export interface UpdateEncryptedNoteFolderInput extends VaultCutoverLeaseInput {
  encryptedName?: EncryptedPayload;
  expectedRevision: number;
  folderId: string;
  order?: number;
  ownerUid: string;
  parentId?: string | null;
  nameClaim: VaultNameClaimReservationInput;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
}

interface ResolveEncryptedNoteFolderCollisionInputBase extends VaultCutoverLeaseInput {
  expectedRevision: number;
  folderId: string;
  nameClaim: VaultNameClaimReservationInput;
  ownerUid: string;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
}

export type ResolveEncryptedNoteFolderCollisionInput =
  ResolveEncryptedNoteFolderCollisionInputBase & (
    | { encryptedName: EncryptedPayload; parentId?: string | null }
    | { encryptedName?: EncryptedPayload; parentId: string | null }
  );

export interface RevisionedEncryptedFolderLifecycleInput {
  expectedRevision: number;
  folderId: string;
  /** Complete owner folder snapshot from a server-confirmed subscription. */
  folders: readonly NoteFolderSnapshot[];
  ownerUid: string;
}

export interface VaultNameClaimReservationInput {
  claimId: string;
  indexVersion: 1;
  parentId: string | null;
}

export interface MigrateLegacyNoteFolderInput extends CreateEncryptedNoteFolderInput, VaultCutoverLeaseInput {
  expectedName: string;
  folderId: string;
}

export type ResolveLegacyNoteFolderCollisionInput = Omit<
  MigrateLegacyNoteFolderInput,
  "leaseGeneration" | "leaseId"
>;

export interface CreatedRevisionedNoteResult extends NoteMutationResult {
  noteRef: ReturnType<typeof doc>;
}

export interface CreateSecureShareCopyingNoteInput extends SaveNoteInput {
  copyJobId: string;
  expectedAttachmentCount: number;
  noteId: string;
}

export interface MigrateLegacyVaultNoteInput extends VaultCutoverLeaseInput {
  expectedContentFormat: "legacy-html-v1";
  expectedEntryKind: "legacy-html";
  expectedRevision: number;
  historySummary?: EncryptedPayload;
  nameClaim?: VaultNameClaimReservationInput;
  noteId: string;
  readerUids: string[];
  uid: string;
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
  nameClaim?: VaultNameClaimReservationInput;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
}

export interface BackfillRevisionedVaultNameClaimInput extends VaultCutoverLeaseInput {
  expectedContentFormat: VaultContentFormat;
  expectedEntryKind: VaultEntryKind;
  expectedRevision: number;
  historySummary?: EncryptedPayload;
  nameClaim: VaultNameClaimReservationInput;
  noteId: string;
  readerUids: string[];
  uid: string;
}

export interface ResolveRevisionedVaultNameCollisionInput extends VaultCutoverLeaseInput {
  changedFields: Array<"folder" | "name-claim" | "title">;
  encryptedTitle?: EncryptedPayload;
  expectedContentFormat: VaultContentFormat;
  expectedEntryKind: VaultEntryKind;
  expectedRevision: number;
  folderId?: string | null;
  historySummary?: EncryptedPayload;
  nameClaim: VaultNameClaimReservationInput;
  noteId: string;
  readerUids: string[];
  uid: string;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
}

export interface UpdateRevisionedEncryptedNoteAndFolderInput extends UpdateRevisionedEncryptedNoteInput {
  folderId: string | null;
}

export interface UpdateRevisionedNoteAccessInput {
  expectedRevision: number;
  folderId?: string | null;
  nameClaim?: VaultNameClaimReservationInput;
  noteId: string;
  participantUids: string[];
  pathRewriteActivation?: VaultPathRewriteActivationInput;
  type: NoteKind;
  uid: string;
  wrappedKeys: Record<string, WrappedNoteKey>;
}

export interface UpdateRevisionedNoteFolderInput {
  expectedRevision: number;
  folderId: string | null;
  historySummary?: EncryptedPayload;
  nameClaim: VaultNameClaimReservationInput;
  noteId: string;
  readerUids: string[];
  uid: string;
  pathRewriteActivation?: VaultPathRewriteActivationInput;
}

export interface RevisionedNoteLifecycleInput {
  expectedRevision: number;
  nameClaim?: VaultNameClaimReservationInput;
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

export class VaultNameConflictError extends Error {
  readonly code = "vault/name-conflict";
  readonly claimId: string;

  constructor(claimId: string) {
    super("같은 위치에 동일한 이름의 Vault 항목이 있습니다.");
    this.name = "VaultNameConflictError";
    this.claimId = claimId;
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

const maxEncryptedVaultFoldersPerOwner = 2_000;
const repairableVaultTreeCodes = new Set([
  "vault_parent_unavailable",
  "vault_tree_invalid",
  "vault_tree_repair_required",
  "vault_tree_stale"
]);

function vaultTreeRepairableError(error: unknown) {
  return error && typeof error === "object" && "code" in error
    && repairableVaultTreeCodes.has(String(error.code));
}

async function commitVaultFolderMutation(
  ownerUid: string,
  payload: Parameters<typeof mutateVaultFolder>[1],
  claimId?: string,
  signal?: AbortSignal
) {
  const commit = () => signal
    ? mutateVaultFolder(ownerUid, payload, signal)
    : mutateVaultFolder(ownerUid, payload);
  let commitError: unknown;
  try {
    return await commit();
  } catch (error) {
    commitError = error;
  }
  if (vaultTreeRepairableError(commitError)) {
    signal?.throwIfAborted();
    await repairVaultFolderTree(ownerUid, signal);
    signal?.throwIfAborted();
    try {
      return await commit();
    } catch (error) {
      commitError = error;
    }
  }
  {
    const code = commitError && typeof commitError === "object" && "code" in commitError
      ? String(commitError.code)
      : "";
    if (code === "vault_name_conflict" && claimId) {
      throw new VaultNameConflictError(claimId);
    }
    if (code === "vault_tree_capacity") {
      throw new NoteFolderLimitError(maxEncryptedVaultFoldersPerOwner);
    }
    throw commitError;
  }
}

async function commitServerVaultNoteMutation<TPayload extends VaultNoteApiPayload>(
  ownerUid: string,
  payload: TPayload,
  options: { claimId?: string; expectedRevision?: number; signal?: AbortSignal } = {}
): Promise<VaultNoteMutationResultFor<TPayload>> {
  const commit = () => options.signal
    ? mutateVaultNote(ownerUid, payload, options.signal)
    : mutateVaultNote(ownerUid, payload);
  try {
    return await commit();
  } catch (error) {
    let commitError = error;
    if (commitError instanceof VaultNoteApiError && vaultTreeRepairableError(commitError)) {
      options.signal?.throwIfAborted();
      await repairVaultFolderTree(ownerUid, options.signal);
      options.signal?.throwIfAborted();
      try {
        return await commit();
      } catch (retryError) {
        commitError = retryError;
      }
    }
    if (commitError instanceof VaultNoteApiError) {
      if (commitError.code === "vault_name_conflict" && options.claimId) {
        throw new VaultNameConflictError(options.claimId);
      }
      if (
        commitError.code === "revision_conflict"
        && options.expectedRevision !== undefined
        && commitError.actualRevision !== undefined
      ) {
        throw new NoteRevisionConflictError(
          options.expectedRevision,
          commitError.actualRevision
        );
      }
    }
    throw commitError;
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
  expectedRevision: number;
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

function assertVaultNameClaim(
  claim: VaultNameClaimReservationInput,
  expectedParentId: string | null
) {
  if (
    !claim
    || claim.indexVersion !== 1
    || !/^[A-Za-z0-9_-]{43}$/u.test(claim.claimId)
    || claim.parentId !== expectedParentId
  ) {
    throw new Error("Vault 이름 예약 정보가 올바르지 않습니다.");
  }
  return claim;
}

function vaultNameClaimRef(uid: string, claimId: string) {
  return doc(db, "vaultIntegrity", uid, "nameClaims", claimId);
}

function vaultNameClaimDocument(
  uid: string,
  targetId: string,
  targetType: "entry" | "folder",
  claim: VaultNameClaimReservationInput
) {
  return {
    createdAt: serverTimestamp(),
    indexVersion: claim.indexVersion,
    ownerUid: uid,
    parentId: claim.parentId,
    targetId,
    targetType,
    updatedAt: serverTimestamp()
  };
}

function storedVaultNameClaimId(data: Pick<NoteDocument, "vaultNameClaimId"> | Pick<NoteFolderDocument, "vaultNameClaimId">) {
  const value = data.vaultNameClaimId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

function claimTargets(
  value: unknown,
  uid: string,
  targetId: string,
  targetType: "entry" | "folder",
  parentId?: string | null
) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const claim = value as Record<string, unknown>;
  return claim.ownerUid === uid
    && claim.targetId === targetId
    && claim.targetType === targetType
    && claim.indexVersion === 1
    && (parentId === undefined || claim.parentId === parentId);
}

export async function vaultNameClaimReservationMatches(input: {
  claimId: string;
  ownerUid: string;
  parentId: string | null;
  targetId: string;
  targetType: "entry" | "folder";
}) {
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(input.claimId)
    || !input.ownerUid
    || !input.targetId
    || input.targetId.length > 120
    || input.targetId.includes("/")
  ) {
    throw new Error("Vault 이름 예약 조회 정보가 올바르지 않습니다.");
  }
  const snapshot = await getDoc(vaultNameClaimRef(input.ownerUid, input.claimId));
  return snapshot.exists() && claimTargets(
    snapshot.data(),
    input.ownerUid,
    input.targetId,
    input.targetType,
    input.parentId
  );
}

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

function serverSnapshotMetadata(snapshot: {
  metadata?: { fromCache?: boolean; hasPendingWrites?: boolean };
}) {
  const fromCache = snapshot.metadata?.fromCache === true;
  const hasPendingWrites = snapshot.metadata?.hasPendingWrites === true;
  return {
    fromCache,
    hasPendingWrites,
    serverComplete: !fromCache && !hasPendingWrites
  } satisfies ServerSnapshotMetadata;
}

function subscribeNotesByDeletedState(
  uid: string,
  ownerUids: string[] | null,
  deleted: boolean,
  callback: (notes: NoteSnapshot[], metadata: ServerSnapshotMetadata) => void,
  onError?: (error: Error) => void,
  maximumNotes?: number,
  repairLegacyDeletionMetadata = true
) {
  const noteFilter = deleted ? deletedNote : visibleNote;

  if (ownerUids === null) {
    if (!deleted && maximumNotes) {
      if (repairLegacyDeletionMetadata) {
        void migrateLegacyDeletionMetadata(uid, true);
      }
      const boundedMaximum = Math.min(2_000, Math.max(1, Math.floor(maximumNotes)));
      let failed = false;
      const notesQuery = query(
        collection(db, "notes"),
        where("isDeleted", "==", false),
        orderBy("updatedAt", "desc"),
        limit(boundedMaximum)
      );

      return onSnapshot(
        notesQuery,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (failed) {
            return;
          }
          callback(
            noteSnapshotList(snapshot, noteFilter).slice(0, boundedMaximum),
            serverSnapshotMetadata(snapshot)
          );
        },
        (error) => {
          if (failed) {
            return;
          }
          // Listener errors can represent a revoked authorization boundary.
          // Clear the previous encrypted rows before surfacing the error so a
          // consumer cannot keep rendering already-decrypted note plaintext.
          failed = true;
          callback([], { fromCache: false, hasPendingWrites: false, serverComplete: false });
          onError?.(error);
        }
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

    if (!deleted && repairLegacyDeletionMetadata) {
      void migrateLegacyDeletionMetadata(uid, true);
    }

    let failed = false;
    return onSnapshot(
      notesQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (failed) {
          return;
        }
        callback(noteSnapshotList(snapshot, noteFilter), serverSnapshotMetadata(snapshot));
      },
      (error) => {
        if (failed) {
          return;
        }
        failed = true;
        callback([], { fromCache: false, hasPendingWrites: false, serverComplete: false });
        onError?.(error);
      }
    );
  }

  const normalizedOwnerUids = Array.from(new Set(deleted ? [uid] : [uid, ...ownerUids])).filter(Boolean);
  const boundedMaximum = maximumNotes
    ? Math.min(2_000, Math.max(1, Math.floor(maximumNotes)))
    : null;
  const notesByOwner = new Map<string, NoteSnapshot[]>();
  const fromCacheByOwner = new Map<string, boolean>();
  const pendingWritesByOwner = new Map<string, boolean>();
  const failedOwners = new Set<string>();
  let closed = false;

  if (!deleted && repairLegacyDeletionMetadata) {
    void migrateLegacyDeletionMetadata(uid, false);
  }

  const emitNotes = () => {
    if (closed) {
      return;
    }

    const merged = Array.from(notesByOwner.values())
      .flat()
      .sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt));
    const fromCache = Array.from(fromCacheByOwner.values()).some(Boolean);
    const hasPendingWrites = Array.from(pendingWritesByOwner.values()).some(Boolean);
    callback(boundedMaximum ? merged.slice(0, boundedMaximum) : merged, {
      fromCache,
      hasPendingWrites,
      serverComplete: fromCacheByOwner.size === normalizedOwnerUids.length
        && pendingWritesByOwner.size === normalizedOwnerUids.length
        && failedOwners.size === 0
        && !fromCache
        && !hasPendingWrites
    });
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
      { includeMetadataChanges: true },
      (snapshot) => {
        if (failedOwners.has(ownerUid)) {
          return;
        }
        notesByOwner.set(ownerUid, noteSnapshotList(snapshot, noteFilter));
        const metadata = serverSnapshotMetadata(snapshot);
        fromCacheByOwner.set(ownerUid, metadata.fromCache);
        pendingWritesByOwner.set(ownerUid, metadata.hasPendingWrites);
        emitNotes();
      },
      (error) => {
        failedOwners.add(ownerUid);
        notesByOwner.delete(ownerUid);
        fromCacheByOwner.delete(ownerUid);
        pendingWritesByOwner.delete(ownerUid);
        emitNotes();
        onError?.(error);
      }
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
  callback: (notes: NoteSnapshot[], metadata: ServerSnapshotMetadata) => void,
  onError?: (error: Error) => void,
  maximumNotes?: number,
  options?: { repairLegacyDeletionMetadata?: boolean }
) {
  return subscribeNotesByDeletedState(
    uid,
    ownerUids,
    false,
    callback,
    onError,
    maximumNotes,
    options?.repairLegacyDeletionMetadata !== false
  );
}

async function getVisibleNotesByIdsWithReader(
  uid: string,
  noteIds: string[],
  readDocument: typeof getDoc
) {
  const uniqueIds = Array.from(new Set(noteIds)).filter(Boolean).slice(0, 1_200);
  const notes: NoteSnapshot[] = [];
  const resolvedNoteIds: string[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueIds.length) {
      const noteId = uniqueIds[nextIndex];
      nextIndex += 1;

      try {
        const snapshot = await readDocument(doc(db, "notes", noteId));
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

export function getVisibleNotesByIds(uid: string, noteIds: string[]) {
  return getVisibleNotesByIdsWithReader(uid, noteIds, getDoc);
}

/**
 * Reads every direct note strictly from Firestore's backend. Durable Vault
 * maintenance must never treat an offline cache fallback as a current path or
 * revision snapshot, because doing so could activate a stale rewrite plan.
 */
export function getVisibleNotesByIdsFromServer(uid: string, noteIds: string[]) {
  return getVisibleNotesByIdsWithReader(uid, noteIds, getDocFromServer);
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
  callback: (notes: NoteSnapshot[], metadata: ServerSnapshotMetadata) => void,
  onError?: (error: Error) => void,
  maximumNotes = 500
) {
  return subscribeNotesByDeletedState(uid, ownerUids, true, callback, onError, maximumNotes);
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
  input: SaveNoteInput
): Promise<CreatedRevisionedNoteResult> {
  assertEncryptedNotePayloadSizes(input);
  if (input.type === "personal" && input.folderId) {
    await ensureVaultFolderTree(input.ownerUid);
  }
  const versionedVaultEntry = Boolean(input.contentFormat || input.entryKind);
  if (versionedVaultEntry) {
    const validatedClaim = assertVaultNameClaim(
      input.nameClaim as VaultNameClaimReservationInput,
      input.folderId ?? null
    );
    const result = await commitServerVaultNoteMutation(
      input.ownerUid,
      vaultNoteCreatePayload(input),
      { claimId: validatedClaim.claimId }
    );
    return {
      lastMutationId: result.lastMutationId,
      noteId: result.noteId,
      noteRef: doc(db, "notes", result.noteId),
      revision: result.revision
    };
  }
  const { historySnapshot, historySummary, nameClaim: _nameClaim, ...noteInput } = input;
  void _nameClaim;
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

export async function createRevisionedEncryptedNote(input: SaveNoteInput): Promise<CreatedRevisionedNoteResult> {
  return createRevisionedEncryptedNoteWithFields(input);
}

function assertExplicitVaultTargetId(targetId: string, label: string) {
  if (
    !targetId
    || targetId !== targetId.trim()
    || targetId.length > 120
    || targetId.includes("/")
  ) {
    throw new Error(`${label} 식별자가 올바르지 않습니다.`);
  }
  return targetId;
}

function assertVaultImportJobId(jobId: string) {
  if (!/^vi1_[A-Za-z0-9_-]{43}$/u.test(jobId)) {
    throw new Error("가져오기 작업 식별자가 올바르지 않습니다.");
  }
  return jobId;
}

/**
 * Creates a Vault entry at a preallocated opaque id. A retry after a lost
 * commit response returns the exact revision-one entry only when its owner,
 * name claim and storage identity still match. It never overwrites an existing
 * document, even if a caller accidentally reuses an id.
 */
export async function createRevisionedEncryptedNoteAtId(
  input: SaveNoteInput,
  targetId: string,
  importJobId: string
): Promise<CreatedRevisionedNoteResult> {
  assertEncryptedNotePayloadSizes(input);
  if (input.folderId) {
    await ensureVaultFolderTree(input.ownerUid);
  }
  const noteId = assertExplicitVaultTargetId(targetId, "가져오기 항목");
  const vaultImportJobId = assertVaultImportJobId(importJobId);
  const validatedClaim = assertVaultNameClaim(
    input.nameClaim as VaultNameClaimReservationInput,
    input.folderId ?? null
  );
  if (!input.contentFormat || !input.entryKind || input.type !== "personal") {
    throw new Error("명시적 식별자 생성은 암호화 Vault 항목에서만 사용할 수 있습니다.");
  }
  const result = await commitServerVaultNoteMutation(
    input.ownerUid,
    vaultNoteImportCreatePayload(input, noteId, vaultImportJobId),
    { claimId: validatedClaim.claimId }
  );
  return {
    lastMutationId: result.lastMutationId,
    noteId: result.noteId,
    noteRef: doc(db, "notes", result.noteId),
    revision: result.revision
  };
}

export async function createSecureShareCopyingNote(
  input: CreateSecureShareCopyingNoteInput
): Promise<CreatedRevisionedNoteResult> {
  const legacyHtmlCopy = input.contentFormat === "legacy-html-v1"
    && input.entryKind === "legacy-html";
  const markdownCopy = input.contentFormat === "markdown-v1"
    && input.entryKind === "markdown"
    && input.expectedAttachmentCount === 0;
  if (
    input.type !== "personal"
    || input.ownerUid.length === 0
    || input.participantUids.length !== 1
    || input.participantUids[0] !== input.ownerUid
    || (!legacyHtmlCopy && !markdownCopy)
    || !/^[A-Za-z0-9_-]{1,120}$/u.test(input.noteId)
    || !/^[A-Za-z0-9_-]{16,160}$/u.test(input.copyJobId)
    || !Number.isSafeInteger(input.expectedAttachmentCount)
    || input.expectedAttachmentCount < 0
    || input.expectedAttachmentCount > 100
  ) {
    throw new Error("보안 공유 복사 작업 정보가 올바르지 않습니다.");
  }

  assertEncryptedNotePayloadSizes(input);
  assertVaultNameClaim(
    input.nameClaim as VaultNameClaimReservationInput,
    input.folderId ?? null
  );

  const payload = vaultNoteSecureCopyCreatePayload(input);
  let result;
  try {
    result = await commitServerVaultNoteMutation(input.ownerUid, payload);
  } catch (error) {
    if (
      !(error instanceof VaultNoteApiError)
      || (error.code !== "network_error" && error.code !== "invalid_response")
    ) {
      throw error;
    }
    result = await commitServerVaultNoteMutation(input.ownerUid, payload);
  }
  return {
    lastMutationId: result.lastMutationId,
    noteId: result.noteId,
    noteRef: doc(db, "notes", result.noteId),
    revision: result.revision
  };
}

export async function activateSecureShareCopyingNote(
  input: SecureShareCopyingNoteLifecycleInput
): Promise<{ noteId: string; state: "active" }> {
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const result = await commitServerVaultNoteMutation(input.uid, {
    action: "secure-copy-activate",
    copyJobId: input.copyJobId,
    expectedRevision,
    noteId: input.noteId
  }, { expectedRevision });
  return { noteId: result.noteId, state: result.state };
}

export async function migrateLegacyVaultNote(
  input: MigrateLegacyVaultNoteInput,
  signal?: AbortSignal
) {
  if (
    input.expectedContentFormat !== "legacy-html-v1"
    || input.expectedEntryKind !== "legacy-html"
  ) {
    throw new Error("기존 HTML 노트 저장 형식을 확인할 수 없습니다.");
  }
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const result = await commitServerVaultNoteMutation(
    input.uid,
    vaultNoteMigrateLegacyPayload({ ...input, expectedRevision }),
    {
      claimId: input.nameClaim?.claimId,
      expectedRevision,
      signal
    }
  );
  return {
    claimState: result.claimState,
    lastMutationId: result.lastMutationId,
    noteId: result.noteId,
    revision: result.revision
  };
}

export async function createEncryptedNote(input: SaveNoteInput) {
  return (await createRevisionedEncryptedNote(input)).noteRef;
}

export async function updateRevisionedEncryptedNote(input: UpdateRevisionedEncryptedNoteInput) {
  assertEncryptedNotePayloadSizes(input);
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const { uid, ...payload } = input;
  return commitServerVaultNoteMutation(uid, {
    ...payload,
    action: "update",
    expectedRevision
  }, {
    claimId: input.nameClaim?.claimId,
    expectedRevision
  });
}

/**
 * Adds only the blinded name reservation envelope. Existing ciphertext is not
 * rewritten, snapshotted, or revalidated against current create-size limits;
 * this keeps historical data intact while still recording a revision event.
 */
export async function backfillRevisionedVaultNameClaim(
  input: BackfillRevisionedVaultNameClaimInput,
  signal?: AbortSignal
) {
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const { uid, ...payload } = input;
  return commitServerVaultNoteMutation(uid, {
    ...payload,
    action: "backfill-claim",
    expectedRevision
  }, {
    claimId: input.nameClaim.claimId,
    expectedRevision,
    signal
  });
}

/** Resolves an unclaimed collision without touching the existing body. */
export async function resolveRevisionedVaultNameCollision(
  input: ResolveRevisionedVaultNameCollisionInput
) {
  const changedFields = Array.from(new Set(input.changedFields));
  if (
    !changedFields.includes("name-claim")
    || (!changedFields.includes("title") && !changedFields.includes("folder"))
    || changedFields.some((field) => !["folder", "name-claim", "title"].includes(field))
    || (changedFields.includes("title") !== Boolean(input.encryptedTitle))
    || (changedFields.includes("folder") !== Object.prototype.hasOwnProperty.call(input, "folderId"))
  ) {
    throw new Error("Vault 이름 충돌 복구 변경 정보가 올바르지 않습니다.");
  }
  assertEncryptedPayloadSize(input.encryptedTitle, "노트 제목", maxEncryptedTitleCharacters);
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const { uid, ...payload } = input;
  return commitServerVaultNoteMutation(uid, {
    ...payload,
    action: "resolve-collision",
    changedFields,
    expectedRevision
  }, {
    claimId: input.nameClaim.claimId,
    expectedRevision
  });
}

export async function updateRevisionedEncryptedNoteAndFolder(
  input: UpdateRevisionedEncryptedNoteAndFolderInput
) {
  assertEncryptedNotePayloadSizes(input);
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const { uid, ...payload } = input;
  return commitServerVaultNoteMutation(uid, {
    ...payload,
    action: "update",
    expectedRevision
  }, {
    claimId: input.nameClaim?.claimId,
    expectedRevision
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
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  return commitServerVaultNoteMutation(
    input.uid,
    vaultNoteAccessPayload({ ...input, expectedRevision }),
    { expectedRevision }
  );
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
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  const { uid, ...payload } = input;
  return commitServerVaultNoteMutation(uid, {
    ...payload,
    action: "move",
    expectedRevision
  }, { claimId: input.nameClaim.claimId, expectedRevision });
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
  nameClaim?: VaultNameClaimReservationInput;
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

    const currentClaimId = storedVaultNameClaimId(currentNote);
    if (
      input.action === "restore"
      && (currentNote.contentFormat !== undefined || currentNote.entryKind !== undefined)
      && !currentClaimId
      && !input.nameClaim
    ) {
      throw new Error("삭제된 Vault 항목의 이름 예약 정보가 없어 복구할 수 없습니다.");
    }
    const nextParentId = Object.prototype.hasOwnProperty.call(input.update, "folderId")
      ? (input.update.folderId as string | null)
      : currentNote.folderId ?? null;
    const nextClaim = input.nameClaim
      ? assertVaultNameClaim(input.nameClaim, nextParentId)
      : null;
    const restoringClaim = input.action === "restore" && currentClaimId
      ? {
          claimId: currentClaimId,
          indexVersion: 1 as const,
          parentId: currentNote.folderId ?? null
        }
      : null;
    const activeClaim = nextClaim ?? restoringClaim;
    let activeClaimExists = false;

    if (activeClaim) {
      const claimSnapshot = await transaction.get(vaultNameClaimRef(currentNote.ownerUid, activeClaim.claimId));
      if (claimSnapshot.exists()) {
        if (!claimTargets(
          claimSnapshot.data(),
          currentNote.ownerUid,
          input.noteId,
          "entry",
          activeClaim.parentId
        )) {
          throw new VaultNameConflictError(activeClaim.claimId);
        }
        activeClaimExists = true;
      }
    }

    const releasingClaimId = currentClaimId && (
      input.action === "delete"
      || (nextClaim && nextClaim.claimId !== currentClaimId)
    ) ? currentClaimId : null;
    let releasingClaimRef: ReturnType<typeof doc> | null = null;
    if (releasingClaimId) {
      releasingClaimRef = vaultNameClaimRef(currentNote.ownerUid, releasingClaimId);
      const releasingSnapshot = await transaction.get(releasingClaimRef);
      if (
        releasingSnapshot.exists()
        && !claimTargets(releasingSnapshot.data(), currentNote.ownerUid, input.noteId, "entry")
      ) {
        throw new Error("기존 Vault 이름 예약이 현재 항목과 일치하지 않습니다.");
      }
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
      ...(nextClaim ? {
        vaultNameClaimId: nextClaim.claimId,
        vaultNameIndexVersion: nextClaim.indexVersion
      } : {}),
      lastMutationId,
      revision
    });
    transaction.set(historyRef, historyDocument);
    if (activeClaim && !activeClaimExists) {
      transaction.set(
        vaultNameClaimRef(currentNote.ownerUid, activeClaim.claimId),
        vaultNameClaimDocument(currentNote.ownerUid, input.noteId, "entry", activeClaim)
      );
    }
    if (releasingClaimRef) {
      transaction.delete(releasingClaimRef);
    }

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
  callback: (folders: NoteFolderSnapshot[], metadata: ServerSnapshotMetadata) => void,
  onError: (error: Error) => void,
  onCompleteSnapshot?: (folders: NoteFolderSnapshot[], metadata: ServerSnapshotMetadata) => void
) {
  const foldersQuery = query(
    collection(db, "noteFolders"),
    where("ownerUid", "==", uid),
    limit(noteFolderSubscriptionSentinelLimit)
  );
  let limitExceeded = false;

  return onSnapshot(
    foldersQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.docs.length > maxNoteFoldersPerOwner) {
        if (!limitExceeded) {
          onError(new NoteFolderLimitError(maxNoteFoldersPerOwner, "subscription"));
        }
        limitExceeded = true;
        return;
      }

      limitExceeded = false;
      const metadata = serverSnapshotMetadata(snapshot);
      const allFolders = snapshot.docs
        .map((document) => ({ id: document.id, ...(document.data() as NoteFolderDocument) }));
      const { activeFolders } = partitionVaultFolderTrash(allFolders);
      if (metadata.serverComplete) {
        void ensureVaultFolderTree(uid).catch((error: unknown) => {
          onError(error instanceof Error ? error : new Error("Vault 폴더 트리를 준비하지 못했습니다."));
        });
      }
      onCompleteSnapshot?.(allFolders, metadata);
      callback(
        activeFolders
          .sort((left, right) => {
            const orderDifference = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
            return orderDifference || left.name.localeCompare(right.name, "ko");
          }),
        metadata
      );
    },
    onError
  );
}

export function subscribeDeletedNoteFolders(
  uid: string,
  callback: (folders: NoteFolderSnapshot[], metadata: ServerSnapshotMetadata) => void,
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
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.docs.length > maxNoteFoldersPerOwner) {
        if (!limitExceeded) onError(new NoteFolderLimitError(maxNoteFoldersPerOwner, "subscription"));
        limitExceeded = true;
        return;
      }
      limitExceeded = false;
      const allFolders = snapshot.docs
        .map((document) => ({ id: document.id, ...(document.data() as NoteFolderDocument) }));
      const { hiddenFolderIds } = partitionVaultFolderTrash(allFolders);
      callback(
        allFolders.filter((folder) => hiddenFolderIds.has(folder.id)),
        serverSnapshotMetadata(snapshot)
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
  const nameClaim = assertVaultNameClaim(input.nameClaim, input.parentId);
  const folderRef = doc(collection(db, "noteFolders"));
  await commitVaultFolderMutation(input.ownerUid, {
    action: "create",
    color: input.color,
    encryptedName: input.encryptedName,
    folderId: folderRef.id,
    nameClaim,
    order: input.order,
    parentId: input.parentId,
    wrappedKey: input.wrappedKey
  }, nameClaim.claimId);
  return folderRef;
}

/**
 * Creates an encrypted folder at a preallocated opaque id. Retrying the same
 * create after a lost response is accepted only while the stored folder is the
 * untouched revision-one target for the same owner, parent, and name claim.
 */
export async function createEncryptedNoteFolderAtId(
  input: CreateEncryptedNoteFolderInput,
  targetId: string,
  importJobId: string
) {
  assertEncryptedPayloadSize(input.encryptedName, "폴더 이름", 2_048);
  const folderId = assertExplicitVaultTargetId(targetId, "가져오기 폴더");
  const vaultImportJobId = assertVaultImportJobId(importJobId);
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
  const nameClaim = assertVaultNameClaim(input.nameClaim, input.parentId);
  const folderRef = doc(db, "noteFolders", folderId);
  await commitVaultFolderMutation(input.ownerUid, {
    action: "create",
    color: input.color,
    encryptedName: input.encryptedName,
    folderId,
    importJobId: vaultImportJobId,
    nameClaim,
    order: input.order,
    parentId: input.parentId,
    wrappedKey: input.wrappedKey
  }, nameClaim.claimId);
  return folderRef;
}

export async function updateEncryptedNoteFolder(
  input: UpdateEncryptedNoteFolderInput,
  signal?: AbortSignal
) {
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
  const nameClaim = assertVaultNameClaim(
    input.nameClaim,
    input.parentId === undefined ? input.nameClaim.parentId : input.parentId
  );
  return commitVaultFolderMutation(input.ownerUid, {
    action: input.parentId === undefined ? "update" : "move",
    expectedRevision: input.expectedRevision,
    folderId: input.folderId,
    ...(input.leaseId === undefined ? {} : {
      leaseGeneration: input.leaseGeneration,
      leaseId: input.leaseId
    }),
    nameClaim,
    ...(input.encryptedName === undefined ? {} : { encryptedName: input.encryptedName }),
    ...(input.order === undefined ? {} : { order: input.order }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.pathRewriteActivation ? { pathRewriteActivation: input.pathRewriteActivation } : {})
  }, nameClaim.claimId, signal);
}

export async function resolveEncryptedNoteFolderCollision(
  input: ResolveEncryptedNoteFolderCollisionInput
) {
  if (
    !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1
    || input.expectedRevision > maxNoteRevision
  ) {
    throw new RangeError(`예상 폴더 revision은 1 이상 ${maxNoteRevision} 이하의 정수여야 합니다.`);
  }
  if (!input.folderId || input.folderId.length > 120 || input.folderId.includes("/")) {
    throw new Error("폴더 식별자가 올바르지 않습니다.");
  }
  if (input.encryptedName) {
    assertEncryptedPayloadSize(input.encryptedName, "폴더 이름", 2_048);
  }
  if (input.encryptedName === undefined && input.parentId === undefined) {
    throw new Error("폴더 이름 충돌을 해결하려면 이름 또는 위치를 변경해주세요.");
  }
  if (
    input.parentId !== undefined
    && input.parentId !== null
    && (!input.parentId || input.parentId.length > 120 || input.parentId.includes("/"))
  ) {
    throw new Error("상위 폴더 식별자가 올바르지 않습니다.");
  }
  const nameClaim = assertVaultNameClaim(
    input.nameClaim,
    input.parentId === undefined ? input.nameClaim.parentId : input.parentId
  );
  const mutationBase = {
    action: "resolve-collision",
    expectedRevision: input.expectedRevision,
    folderId: input.folderId,
    ...(input.leaseId === undefined ? {} : {
      leaseGeneration: input.leaseGeneration,
      leaseId: input.leaseId
    }),
    nameClaim,
    ...(input.pathRewriteActivation ? { pathRewriteActivation: input.pathRewriteActivation } : {})
  } as const;
  let mutation: Parameters<typeof mutateVaultFolder>[1];
  if (input.encryptedName !== undefined) {
    mutation = {
      ...mutationBase,
      encryptedName: input.encryptedName,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId })
    };
  } else {
    if (input.parentId === undefined) {
      throw new Error("폴더 이름 충돌을 해결하려면 이름 또는 위치를 변경해주세요.");
    }
    mutation = {
      ...mutationBase,
      parentId: input.parentId
    };
  }
  return commitVaultFolderMutation(input.ownerUid, mutation, nameClaim.claimId);
}

export async function migrateLegacyNoteFolder(
  input: MigrateLegacyNoteFolderInput,
  signal?: AbortSignal
) {
  const nameClaim = assertVaultNameClaim(input.nameClaim, input.parentId);
  return commitVaultFolderMutation(input.ownerUid, {
    action: "migrate",
    color: input.color,
    encryptedName: input.encryptedName,
    expectedName: input.expectedName,
    folderId: input.folderId,
    ...(input.leaseId === undefined ? {} : {
      leaseGeneration: input.leaseGeneration,
      leaseId: input.leaseId
    }),
    nameClaim,
    order: input.order,
    parentId: input.parentId,
    wrappedKey: input.wrappedKey
  }, nameClaim.claimId, signal);
}

/**
 * Encrypts and claims a deferred legacy collision loser atomically. Unlike the
 * bulk migrate action this explicit owner repair is intentionally lease-free,
 * so the user can rename or move the blocked folder after the bulk lease has
 * been released.
 */
export async function resolveLegacyNoteFolderCollision(
  input: ResolveLegacyNoteFolderCollisionInput,
  signal?: AbortSignal
) {
  const nameClaim = assertVaultNameClaim(input.nameClaim, input.parentId);
  return commitVaultFolderMutation(input.ownerUid, {
    action: "resolve-collision",
    color: input.color,
    encryptedName: input.encryptedName,
    expectedName: input.expectedName,
    folderId: input.folderId,
    nameClaim,
    order: input.order,
    parentId: input.parentId,
    wrappedKey: input.wrappedKey
  }, nameClaim.claimId, signal);
}

export async function deleteNoteFolder(uid: string, folderId: string, noteIds: string[] = []) {
  const folderRef = doc(db, "noteFolders", folderId);
  const folderSnapshot = await getDoc(folderRef);
  if (
    folderSnapshot.exists()
    && (folderSnapshot.data() as NoteFolderDocument).encryptedName
  ) {
    throw new Error("암호화 Vault 폴더는 하위 트리 휴지통으로만 이동할 수 있습니다.");
  }
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

async function commitRevisionedEncryptedFolderLifecycle(
  input: RevisionedEncryptedFolderLifecycleInput,
  operation: "delete" | "restore"
) {
  if (!input.folderId || input.folderId.length > 120 || input.folderId.includes("/")) {
    throw new Error("폴더 식별자가 올바르지 않습니다.");
  }
  assertVaultFolderLifecyclePreflight({ ...input, operation });
  expectedNoteRevision(input.expectedRevision);
  const claimId = input.folders.find((folder) => folder.id === input.folderId)?.vaultNameClaimId;
  return commitVaultFolderMutation(input.ownerUid, {
    action: operation === "delete" ? "trash" : "restore",
    expectedRevision: input.expectedRevision,
    folderId: input.folderId
  }, claimId);
}

/**
 * One root tombstone logically trashes its whole subtree in one atomic write.
 * Descendant folders and entries remain encrypted and revision-stable; active
 * subscriptions hide anything whose ancestor is tombstoned.
 */
export function trashRevisionedEncryptedFolderSubtree(input: RevisionedEncryptedFolderLifecycleInput) {
  return commitRevisionedEncryptedFolderLifecycle(input, "delete");
}

export function restoreRevisionedEncryptedFolderSubtree(input: RevisionedEncryptedFolderLifecycleInput) {
  return commitRevisionedEncryptedFolderLifecycle(input, "restore");
}

export async function deleteNoteAttachment(noteId: string, attachmentId: string) {
  await deleteBlobAttachment({ scope: "note", noteId, attachmentId });
}

export async function deleteRevisionedNote(input: RevisionedNoteLifecycleInput) {
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  return commitServerVaultNoteMutation(
    input.uid,
    vaultNoteLifecyclePayload({ ...input, expectedRevision }, "trash"),
    { expectedRevision }
  );
}

export async function abortSecureShareCopyingNote(
  input: SecureShareCopyingNoteLifecycleInput
) {
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  return commitServerVaultNoteMutation(
    input.uid,
    vaultNoteSecureCopyLifecyclePayload(
      { ...input, expectedRevision },
      "secure-copy-abort"
    ),
    { expectedRevision }
  );
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
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  return commitServerVaultNoteMutation(
    input.uid,
    vaultNoteLifecyclePayload({ ...input, expectedRevision }, "restore"),
    {
      claimId: input.nameClaim?.claimId,
      expectedRevision
    }
  );
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
  const expectedRevision = expectedNoteRevision(input.expectedRevision);
  return commitServerVaultNoteMutation(
    input.uid,
    vaultNotePurgePayload(input),
    { expectedRevision }
  );
}
