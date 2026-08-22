import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference
} from "firebase/firestore";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { db } from "../lib/firebase";
import type { EncryptedPayload, NoteDocument, NoteFolderDocument, WrappedNoteKey } from "../types";
import {
  MAX_VAULT_IMPORT_FOLDERS,
  MAX_VAULT_IMPORT_MANIFEST_CHUNKS,
  MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK,
  MAX_VAULT_IMPORT_TARGETS,
  VAULT_IMPORT_JOB_VERSION,
  assembleVaultImportManifest,
  chunkVaultImportManifest,
  planVaultImportRollback,
  validateVaultImportManifest,
  VaultImportRollbackConflictError,
  type VaultImportManifestChunkV1,
  type VaultImportManifestV1
} from "../features/vault/importRollback";
import {
  deleteRevisionedNote,
  maxNoteFoldersPerOwner,
  trashRevisionedEncryptedFolderSubtree,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "./notes";

export type VaultImportJobStatus =
  | "preparing"
  | "staging"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "blocked";

export type VaultImportSafeErrorCode =
  | "job-corrupt"
  | "rollback-conflict"
  | "snapshot-incomplete"
  | "write-failed";

export interface VaultImportProfile {
  uid: string;
  publicKeyJwk: JsonWebKey;
}

export interface VaultImportJobSummary {
  jobId: string;
  status: VaultImportJobStatus;
  itemCount: number;
  entryCount: number;
  folderCount: number;
  rootFolderCount: number;
  chunkCount: number;
  remainingChunkCount: number;
  revision: number;
  lastErrorCode: VaultImportSafeErrorCode | null;
  manifest: VaultImportManifestV1 | null;
}

export interface VaultImportRollbackSummary extends VaultImportJobSummary {
  entrySoftDeleted: number;
  folderRootsTrashed: number;
  alreadyCleaned: number;
}

interface StoredVaultImportJob {
  ownerUid: string;
  kind: "vault-import-v1";
  version: typeof VAULT_IMPORT_JOB_VERSION;
  status: VaultImportJobStatus;
  itemCount: number;
  entryCount: number;
  folderCount: number;
  rootFolderCount: number;
  chunkCount: number;
  remainingChunkCount: number;
  revision: number;
  lastErrorCode: VaultImportSafeErrorCode | null;
  wrappedKey: WrappedNoteKey;
}

interface StoredVaultImportChunk {
  ownerUid: string;
  jobId: string;
  ordinal: number;
  itemCount: number;
  encryptedManifest: EncryptedPayload;
}

const maximumOwnedNotesForRollback = 20_000;
const maximumRecoverableJobs = 20;
const maximumRetainedJobs = 50;
const manifestWriteBatchSize = 25;
const maxStoredChunkCipherTextLength = 200_000;

export class VaultImportJobError extends Error {
  readonly code: "blocked" | "conflict" | "corrupt" | "invalid" | "not-found";
  readonly job?: VaultImportJobSummary;

  constructor(
    code: VaultImportJobError["code"],
    message: string,
    options?: { cause?: unknown; job?: VaultImportJobSummary }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VaultImportJobError";
    this.code = code;
    this.job = options?.job;
  }
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function randomOpaqueId(prefix: string) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64Url(bytes)}`;
}

export function createVaultImportJobId() {
  return randomOpaqueId("vi1_");
}

export function createVaultImportTargetId() {
  return randomOpaqueId("vit1_");
}

function validateUid(uid: string) {
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new VaultImportJobError("invalid", "가져오기 작업 사용자를 확인할 수 없습니다.");
  }
  return uid;
}

function validateJobId(jobId: string) {
  if (!/^vi1_[A-Za-z0-9_-]{43}$/u.test(jobId)) {
    throw new VaultImportJobError("invalid", "가져오기 작업 식별자가 올바르지 않습니다.");
  }
  return jobId;
}

function jobCollection(uid: string) {
  return collection(db, "vaultMaintenanceJobs", validateUid(uid), "imports");
}

function jobRef(uid: string, jobId: string) {
  return doc(jobCollection(uid), validateJobId(jobId));
}

function chunkCollection(reference: DocumentReference<DocumentData>) {
  return collection(reference, "chunks");
}

function chunkId(ordinal: number) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_VAULT_IMPORT_MANIFEST_CHUNKS) {
    throw new VaultImportJobError("invalid", "가져오기 manifest chunk 번호가 올바르지 않습니다.");
  }
  return `chunk-${String(ordinal).padStart(3, "0")}`;
}

function chunkRef(reference: DocumentReference<DocumentData>, ordinal: number) {
  return doc(chunkCollection(reference), chunkId(ordinal));
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncryptedPayload>;
  return candidate.version === 1
    && candidate.algorithm === "AES-GCM"
    && typeof candidate.cipherText === "string"
    && candidate.cipherText.length > 0
    && candidate.cipherText.length <= maxStoredChunkCipherTextLength
    && typeof candidate.iv === "string"
    && candidate.iv.length > 0
    && candidate.iv.length <= 128;
}

function validWrappedKey(value: unknown): value is WrappedNoteKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WrappedNoteKey>;
  return candidate.version === 1
    && candidate.algorithm === "RSA-OAEP"
    && typeof candidate.wrappedKey === "string"
    && candidate.wrappedKey.length > 0
    && candidate.wrappedKey.length <= 4_096;
}

function validStatus(value: unknown): value is VaultImportJobStatus {
  return value === "preparing"
    || value === "staging"
    || value === "committed"
    || value === "rolling-back"
    || value === "rolled-back"
    || value === "blocked";
}

function validErrorCode(value: unknown): value is VaultImportSafeErrorCode | null {
  return value === null
    || value === "job-corrupt"
    || value === "rollback-conflict"
    || value === "snapshot-incomplete"
    || value === "write-failed";
}

function validateStoredJob(value: unknown, uid: string): StoredVaultImportJob {
  if (!value || typeof value !== "object") {
    throw new VaultImportJobError("corrupt", "저장된 가져오기 작업을 확인할 수 없습니다.");
  }
  const candidate = value as Partial<StoredVaultImportJob>;
  if (
    candidate.ownerUid !== uid
    || candidate.kind !== "vault-import-v1"
    || candidate.version !== VAULT_IMPORT_JOB_VERSION
    || !validStatus(candidate.status)
    || !safeInteger(candidate.itemCount, 1, MAX_VAULT_IMPORT_TARGETS)
    || !safeInteger(candidate.entryCount, 1, candidate.itemCount ?? 0)
    || !safeInteger(candidate.folderCount, 0, Math.min(MAX_VAULT_IMPORT_FOLDERS, candidate.itemCount ?? 0))
    || candidate.entryCount + candidate.folderCount !== candidate.itemCount
    || !safeInteger(candidate.rootFolderCount, 0, candidate.folderCount ?? 0)
    || !safeInteger(candidate.chunkCount, 1, MAX_VAULT_IMPORT_MANIFEST_CHUNKS)
    || candidate.chunkCount !== Math.ceil(
      (candidate.itemCount ?? 0) / MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK
    )
    || !safeInteger(candidate.remainingChunkCount, 0, candidate.chunkCount ?? 0)
    || (
      candidate.status !== "committed"
      && candidate.status !== "rolled-back"
      && candidate.remainingChunkCount !== candidate.chunkCount
    )
    || !safeInteger(candidate.revision, 1, 999_999_999_999)
    || !validErrorCode(candidate.lastErrorCode)
    || !validWrappedKey(candidate.wrappedKey)
    || ((candidate.status === "blocked") !== (candidate.lastErrorCode !== null))
  ) {
    throw new VaultImportJobError("corrupt", "저장된 가져오기 작업 상태가 올바르지 않습니다.");
  }
  return candidate as StoredVaultImportJob;
}

function validateStoredChunk(
  value: unknown,
  uid: string,
  jobId: string,
  ordinal: number
): StoredVaultImportChunk {
  if (!value || typeof value !== "object") {
    throw new VaultImportJobError("corrupt", "저장된 가져오기 manifest chunk를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<StoredVaultImportChunk>;
  if (
    candidate.ownerUid !== uid
    || candidate.jobId !== jobId
    || candidate.ordinal !== ordinal
    || !safeInteger(candidate.itemCount, 1, MAX_VAULT_IMPORT_MANIFEST_TARGETS_PER_CHUNK)
    || !validEncryptedPayload(candidate.encryptedManifest)
  ) {
    throw new VaultImportJobError("corrupt", "저장된 가져오기 manifest chunk가 올바르지 않습니다.");
  }
  return candidate as StoredVaultImportChunk;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new VaultImportJobError("corrupt", "암호화된 가져오기 manifest를 해석할 수 없습니다.");
  }
}

function summary(
  stored: StoredVaultImportJob,
  jobId: string,
  manifest: VaultImportManifestV1 | null
): VaultImportJobSummary {
  return {
    jobId,
    status: stored.status,
    itemCount: stored.itemCount,
    entryCount: stored.entryCount,
    folderCount: stored.folderCount,
    rootFolderCount: stored.rootFolderCount,
    chunkCount: stored.chunkCount,
    remainingChunkCount: stored.remainingChunkCount,
    revision: stored.revision,
    lastErrorCode: stored.lastErrorCode,
    manifest
  };
}

async function readManifest(
  reference: DocumentReference<DocumentData>,
  stored: StoredVaultImportJob,
  uid: string,
  jobId: string,
  jobKey: CryptoKey,
  allowIncomplete = false
) {
  const snapshot = await getDocsFromServer(chunkCollection(reference));
  if (snapshot.docs.length !== stored.chunkCount) {
    if (allowIncomplete) return null;
    throw new VaultImportJobError("corrupt", "가져오기 manifest chunk가 완전하지 않습니다.");
  }
  const chunks: VaultImportManifestChunkV1[] = [];
  for (let ordinal = 0; ordinal < stored.chunkCount; ordinal += 1) {
    const document = snapshot.docs.find((candidate) => candidate.id === chunkId(ordinal));
    if (!document) {
      if (allowIncomplete) return null;
      throw new VaultImportJobError("corrupt", "가져오기 manifest chunk 순서가 완전하지 않습니다.");
    }
    const chunk = validateStoredChunk(document.data(), uid, jobId, ordinal);
    const decrypted = parseJson(await decryptText(chunk.encryptedManifest, jobKey)) as VaultImportManifestChunkV1;
    if (decrypted.targets?.length !== chunk.itemCount) {
      throw new VaultImportJobError("corrupt", "가져오기 manifest chunk 개수가 일치하지 않습니다.");
    }
    chunks.push(decrypted);
  }
  const manifest = assembleVaultImportManifest(uid, chunks);
  const folderCount = manifest.targets.filter((target) => target.type === "folder").length;
  const rootFolderCount = manifest.targets.filter((target) => target.type === "folder" && target.root).length;
  if (
    manifest.targets.length !== stored.itemCount
    || folderCount !== stored.folderCount
    || manifest.targets.length - folderCount !== stored.entryCount
    || rootFolderCount !== stored.rootFolderCount
  ) {
    throw new VaultImportJobError("corrupt", "가져오기 manifest 집계가 작업과 일치하지 않습니다.");
  }
  return manifest;
}

async function loadStoredJob(uid: string, jobId: string) {
  const reference = jobRef(uid, jobId);
  const snapshot = await getDocFromServer(reference);
  if (!snapshot.exists()) return null;
  return { reference, stored: validateStoredJob(snapshot.data(), uid) };
}

async function loadWithManifest(
  uid: string,
  privateKey: CryptoKey,
  jobId: string,
  allowIncomplete = false
) {
  const loaded = await loadStoredJob(uid, jobId);
  if (!loaded) return null;
  const jobKey = await unwrapNoteKey(loaded.stored.wrappedKey, privateKey);
  const manifest = await readManifest(
    loaded.reference,
    loaded.stored,
    uid,
    jobId,
    jobKey,
    allowIncomplete
  );
  return { ...loaded, jobKey, manifest };
}

export async function ensureVaultImportJob(input: {
  profile: VaultImportProfile;
  privateKey: CryptoKey;
  jobId: string;
  manifest: VaultImportManifestV1;
}) {
  const uid = validateUid(input.profile.uid);
  const jobId = validateJobId(input.jobId);
  const manifest = validateVaultImportManifest(input.manifest);
  if (manifest.ownerUid !== uid || !input.profile.publicKeyJwk || !input.privateKey) {
    throw new VaultImportJobError("invalid", "가져오기 작업 소유자가 일치하지 않습니다.");
  }
  const retainedJobs = await getDocsFromServer(query(
    jobCollection(uid),
    limit(maximumRetainedJobs + 1)
  ));
  if (
    retainedJobs.docs.length >= maximumRetainedJobs
    && !retainedJobs.docs.some((document) => document.id === jobId)
  ) {
    throw new VaultImportJobError("blocked", "보존된 가져오기 작업 수가 안전한 한도를 초과했습니다.");
  }
  const preparedChunks = chunkVaultImportManifest(manifest);
  const folderCount = manifest.targets.filter((target) => target.type === "folder").length;
  const rootFolderCount = manifest.targets.filter((target) => target.type === "folder" && target.root).length;
  const reference = jobRef(uid, jobId);
  const candidateKey = await generateNoteKey();
  const candidateWrappedKey = await wrapNoteKey(candidateKey, input.profile.publicKeyJwk);
  const selected = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists()) return validateStoredJob(snapshot.data(), uid);
    const stored: StoredVaultImportJob = {
      ownerUid: uid,
      kind: "vault-import-v1",
      version: VAULT_IMPORT_JOB_VERSION,
      status: "preparing",
      itemCount: manifest.targets.length,
      entryCount: manifest.targets.length - folderCount,
      folderCount,
      rootFolderCount,
      chunkCount: preparedChunks.length,
      remainingChunkCount: preparedChunks.length,
      revision: 1,
      lastErrorCode: null,
      wrappedKey: candidateWrappedKey
    };
    transaction.set(reference, {
      ...stored,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return stored;
  });
  const jobKey = selected.wrappedKey.wrappedKey === candidateWrappedKey.wrappedKey
    ? candidateKey
    : await unwrapNoteKey(selected.wrappedKey, input.privateKey);
  if (
    selected.itemCount !== manifest.targets.length
    || selected.folderCount !== folderCount
    || selected.rootFolderCount !== rootFolderCount
    || selected.chunkCount !== preparedChunks.length
  ) {
    throw new VaultImportJobError("conflict", "같은 가져오기 작업 식별자에 다른 계획이 저장되어 있습니다.");
  }
  if (selected.status !== "preparing" && selected.status !== "staging") {
    const persisted = await readManifest(reference, selected, uid, jobId, jobKey);
    if (JSON.stringify(persisted) !== JSON.stringify(manifest)) {
      throw new VaultImportJobError("conflict", "저장된 가져오기 계획이 현재 계획과 다릅니다.");
    }
    return summary(selected, jobId, persisted);
  }

  const existingSnapshot = await getDocsFromServer(chunkCollection(reference));
  if (existingSnapshot.docs.length > preparedChunks.length) {
    throw new VaultImportJobError("corrupt", "가져오기 작업에 알 수 없는 manifest chunk가 있습니다.");
  }
  const existingIds = new Set(existingSnapshot.docs.map((document) => document.id));
  for (const document of existingSnapshot.docs) {
    const ordinal = Number(document.id.replace(/^chunk-/u, ""));
    if (!Number.isSafeInteger(ordinal) || chunkId(ordinal) !== document.id) {
      throw new VaultImportJobError("corrupt", "가져오기 manifest chunk 식별자가 올바르지 않습니다.");
    }
    const storedChunk = validateStoredChunk(document.data(), uid, jobId, ordinal);
    const decrypted = parseJson(await decryptText(storedChunk.encryptedManifest, jobKey));
    if (JSON.stringify(decrypted) !== JSON.stringify(preparedChunks[ordinal])) {
      throw new VaultImportJobError("conflict", "같은 chunk에 다른 가져오기 계획이 저장되어 있습니다.");
    }
  }
  const missingChunks = preparedChunks.filter((chunk) => !existingIds.has(chunkId(chunk.ordinal)));
  for (let index = 0; index < missingChunks.length; index += manifestWriteBatchSize) {
    const batch = writeBatch(db);
    const chunkSlice = missingChunks.slice(index, index + manifestWriteBatchSize);
    const encrypted = await Promise.all(chunkSlice.map(async (chunk) => ({
      chunk,
      payload: await encryptText(JSON.stringify(chunk), jobKey)
    })));
    for (const item of encrypted) {
      if (item.payload.cipherText.length > maxStoredChunkCipherTextLength) {
        throw new VaultImportJobError("invalid", "가져오기 manifest chunk 암호문이 한도를 초과했습니다.");
      }
      batch.set(chunkRef(reference, item.chunk.ordinal), {
        ownerUid: uid,
        jobId,
        ordinal: item.chunk.ordinal,
        itemCount: item.chunk.targets.length,
        encryptedManifest: item.payload,
        createdAt: serverTimestamp()
      } satisfies StoredVaultImportChunk & { createdAt: ReturnType<typeof serverTimestamp> });
    }
    await batch.commit();
  }
  const persistedManifest = await readManifest(reference, selected, uid, jobId, jobKey);
  if (JSON.stringify(persistedManifest) !== JSON.stringify(manifest)) {
    throw new VaultImportJobError("conflict", "저장된 가져오기 계획을 확인하지 못했습니다.");
  }

  const staged = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new VaultImportJobError("not-found", "가져오기 작업이 사라졌습니다.");
    const current = validateStoredJob(snapshot.data(), uid);
    if (current.status === "staging") return current;
    if (current.status !== "preparing") {
      throw new VaultImportJobError("conflict", "가져오기 작업이 준비 상태를 벗어났습니다.");
    }
    const next: StoredVaultImportJob = {
      ...current,
      status: "staging",
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      revision: next.revision,
      preparedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return next;
  });
  return summary(staged, jobId, persistedManifest);
}

export async function loadVaultImportJob(uid: string, privateKey: CryptoKey, jobId: string) {
  const loaded = await loadWithManifest(validateUid(uid), privateKey, validateJobId(jobId), true);
  return loaded ? summary(loaded.stored, jobId, loaded.manifest) : null;
}

export async function listRecoverableVaultImportJobs(uid: string, privateKey: CryptoKey) {
  const validatedUid = validateUid(uid);
  const snapshot = await getDocsFromServer(query(
    jobCollection(validatedUid),
    where("status", "in", ["preparing", "staging", "rolling-back", "blocked"]),
    limit(maximumRecoverableJobs + 1)
  ));
  if (snapshot.docs.length > maximumRecoverableJobs) {
    throw new VaultImportJobError("blocked", "중단된 가져오기 작업 수가 복구 한도를 초과했습니다.");
  }
  const jobs: VaultImportJobSummary[] = [];
  for (const document of snapshot.docs) {
    validateJobId(document.id);
    const stored = validateStoredJob(document.data(), validatedUid);
    const key = await unwrapNoteKey(stored.wrappedKey, privateKey);
    const manifest = await readManifest(
      document.ref,
      stored,
      validatedUid,
      document.id,
      key,
      stored.status === "preparing"
    );
    jobs.push(summary(stored, document.id, manifest));
  }
  return jobs;
}

export async function commitVaultImportJob(uid: string, jobId: string) {
  const validatedUid = validateUid(uid);
  const reference = jobRef(validatedUid, jobId);
  const stored = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new VaultImportJobError("not-found", "가져오기 작업을 찾을 수 없습니다.");
    const current = validateStoredJob(snapshot.data(), validatedUid);
    if (current.status === "committed") return current;
    if (current.status !== "staging") {
      throw new VaultImportJobError("conflict", "준비가 끝난 가져오기 작업만 완료할 수 있습니다.");
    }
    const next: StoredVaultImportJob = {
      ...current,
      status: "committed",
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      revision: next.revision,
      committedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return next;
  });
  return summary(stored, jobId, null);
}

export async function cleanupTerminalVaultImportJob(uid: string, jobId: string) {
  const validatedUid = validateUid(uid);
  const validatedJobId = validateJobId(jobId);
  const loaded = await loadStoredJob(validatedUid, validatedJobId);
  if (!loaded) return { cleaned: true as const, removedChunks: 0 };
  if (loaded.stored.status !== "committed" && loaded.stored.status !== "rolled-back") {
    throw new VaultImportJobError("conflict", "완료되지 않은 가져오기 작업은 정리할 수 없습니다.");
  }
  const chunks = await getDocsFromServer(chunkCollection(loaded.reference));
  if (
    chunks.docs.length !== loaded.stored.remainingChunkCount
    || chunks.docs.some((document) => {
      const ordinal = Number(document.id.replace(/^chunk-/u, ""));
      return !Number.isSafeInteger(ordinal)
        || ordinal < 0
        || ordinal >= loaded.stored.remainingChunkCount
        || chunkId(ordinal) !== document.id;
    })
  ) {
    throw new VaultImportJobError("corrupt", "가져오기 작업의 manifest chunk 수가 일치하지 않습니다.");
  }
  let removedChunks = 0;
  const documentsByOrdinal = new Map(chunks.docs.map((document) => [
    Number(document.id.replace(/^chunk-/u, "")),
    document
  ]));
  for (let ordinal = loaded.stored.remainingChunkCount - 1; ordinal >= 0; ordinal -= 1) {
    const document = documentsByOrdinal.get(ordinal);
    if (!document) {
      throw new VaultImportJobError("corrupt", "가져오기 manifest chunk 순서가 일치하지 않습니다.");
    }
    const removed = await runTransaction(db, async (transaction) => {
      const [jobSnapshot, chunkSnapshot] = await Promise.all([
        transaction.get(loaded.reference),
        transaction.get(document.ref)
      ]);
      if (!jobSnapshot.exists()) {
        if (chunkSnapshot.exists()) {
          throw new VaultImportJobError("corrupt", "가져오기 작업 없이 manifest chunk가 남아 있습니다.");
        }
        return false;
      }
      const current = validateStoredJob(jobSnapshot.data(), validatedUid);
      if (current.status !== "committed" && current.status !== "rolled-back") {
        throw new VaultImportJobError("conflict", "완료되지 않은 가져오기 작업은 정리할 수 없습니다.");
      }
      if (!chunkSnapshot.exists()) {
        if (current.remainingChunkCount !== ordinal) {
          throw new VaultImportJobError("corrupt", "manifest chunk 정리 진행 상태가 일치하지 않습니다.");
        }
        return false;
      }
      if (current.remainingChunkCount !== ordinal + 1) {
        throw new VaultImportJobError("conflict", "manifest chunk 정리 순서가 충돌했습니다.");
      }
      transaction.delete(document.ref);
      transaction.update(loaded.reference, {
        remainingChunkCount: ordinal,
        revision: current.revision + 1,
        updatedAt: serverTimestamp()
      });
      return true;
    });
    if (removed) removedChunks += 1;
  }
  const [remaining, terminalJob] = await Promise.all([
    getDocsFromServer(chunkCollection(loaded.reference)),
    getDocFromServer(loaded.reference)
  ]);
  if (remaining.docs.length) {
    throw new VaultImportJobError("blocked", "가져오기 manifest chunk 정리를 확인하지 못했습니다.");
  }
  if (!terminalJob.exists()) {
    return { cleaned: true as const, removedChunks };
  }
  if (validateStoredJob(terminalJob.data(), validatedUid).remainingChunkCount !== 0) {
    throw new VaultImportJobError("blocked", "가져오기 manifest chunk 정리 상태를 확인하지 못했습니다.");
  }
  try {
    await deleteDoc(loaded.reference);
  } catch (cause) {
    const confirmed = await getDocFromServer(loaded.reference);
    if (confirmed.exists()) throw cause;
  }
  return { cleaned: true as const, removedChunks };
}

export async function cleanupRetainedTerminalVaultImportJobs(uid: string) {
  const validatedUid = validateUid(uid);
  const snapshot = await getDocsFromServer(query(
    jobCollection(validatedUid),
    where("status", "in", ["committed", "rolled-back"]),
    limit(maximumRetainedJobs + 1)
  ));
  if (snapshot.docs.length > maximumRetainedJobs) {
    throw new VaultImportJobError("blocked", "완료된 가져오기 작업 수가 정리 한도를 초과했습니다.");
  }
  let removedChunks = 0;
  for (const document of snapshot.docs) {
    const result = await cleanupTerminalVaultImportJob(validatedUid, document.id);
    removedChunks += result.removedChunks;
  }
  return { cleanedJobs: snapshot.docs.length, removedChunks };
}

async function transitionRollbackStatus(
  uid: string,
  jobId: string,
  targetStatus: "rolling-back" | "rolled-back" | "blocked",
  errorCode: VaultImportSafeErrorCode | null
) {
  const reference = jobRef(uid, jobId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new VaultImportJobError("not-found", "가져오기 작업을 찾을 수 없습니다.");
    const current = validateStoredJob(snapshot.data(), uid);
    if (current.status === "committed" || current.status === "rolled-back") return current;
    if (targetStatus === "rolling-back" && current.status === "rolling-back") return current;
    const next: StoredVaultImportJob = {
      ...current,
      status: targetStatus,
      lastErrorCode: errorCode,
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      ...(targetStatus === "rolled-back" ? { rolledBackAt: serverTimestamp() } : {}),
      ...(targetStatus === "rolling-back" ? { rollbackStartedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp()
    });
    return next;
  });
}

async function loadCompleteOwnerSnapshot(uid: string, manifest: VaultImportManifestV1) {
  const entryTargetIds = manifest.targets
    .filter((target) => target.type === "entry")
    .map((target) => target.targetId);
  const [notesSnapshot, foldersSnapshot] = await Promise.all([
    getDocsFromServer(query(
      collection(db, "notes"),
      where("ownerUid", "==", uid),
      where("isDeleted", "==", false),
      limit(maximumOwnedNotesForRollback + 1)
    )),
    getDocsFromServer(query(
      collection(db, "noteFolders"),
      where("ownerUid", "==", uid),
      limit(maxNoteFoldersPerOwner + 1)
    ))
  ]);
  if (
    notesSnapshot.docs.length > maximumOwnedNotesForRollback
    || foldersSnapshot.docs.length > maxNoteFoldersPerOwner
  ) {
    throw new VaultImportJobError("blocked", "서버 전체 snapshot이 안전한 복구 한도를 초과했습니다.");
  }
  const targetNotes: NoteSnapshot[] = [];
  let nextTargetIndex = 0;
  async function targetReader() {
    while (nextTargetIndex < entryTargetIds.length) {
      const targetId = entryTargetIds[nextTargetIndex];
      nextTargetIndex += 1;
      const target = await getDocFromServer(doc(db, "notes", targetId));
      if (target.exists()) {
        targetNotes.push({ id: target.id, ...(target.data() as NoteDocument) });
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(8, entryTargetIds.length) },
    () => targetReader()
  ));
  const noteById = new Map<string, NoteSnapshot>();
  notesSnapshot.docs.forEach((document) => {
    noteById.set(document.id, { id: document.id, ...(document.data() as NoteDocument) });
  });
  targetNotes.forEach((note) => noteById.set(note.id, note));
  return {
    notes: [...noteById.values()],
    folders: foldersSnapshot.docs.map((document) => ({
      id: document.id,
      ...(document.data() as NoteFolderDocument)
    })) satisfies NoteFolderSnapshot[]
  };
}

async function confirmEntryWasCleaned(
  uid: string,
  jobId: string,
  target: VaultImportManifestV1["targets"][number]
) {
  if (target.type !== "entry") return false;
  const snapshot = await getDocFromServer(doc(db, "notes", target.targetId));
  if (!snapshot.exists()) return false;
  const note = snapshot.data() as NoteDocument;
  return note.ownerUid === uid
    && note.vaultNameClaimId === target.claimId
    && note.vaultNameIndexVersion === 1
    && note.vaultImportJobId === jobId
    && note.revision === 2
    && note.isDeleted === true;
}

async function confirmFolderRootWasCleaned(
  uid: string,
  jobId: string,
  target: VaultImportManifestV1["targets"][number]
) {
  if (target.type !== "folder") return false;
  const snapshot = await getDocFromServer(doc(db, "noteFolders", target.targetId));
  if (!snapshot.exists()) return false;
  const folder = snapshot.data() as NoteFolderDocument;
  return folder.ownerUid === uid
    && folder.vaultNameClaimId === target.claimId
    && folder.vaultNameIndexVersion === 1
    && folder.vaultImportJobId === jobId
    && folder.revision === 2
    && folder.isDeleted === true;
}

/**
 * Compensates an incomplete import without hard-deleting encrypted documents
 * or history. The complete owner snapshot is planned before the first write;
 * any unrelated descendant or revision change blocks the whole cleanup.
 */
export async function rollbackVaultImportJob(input: {
  uid: string;
  privateKey: CryptoKey;
  jobId: string;
}): Promise<VaultImportRollbackSummary> {
  const uid = validateUid(input.uid);
  const jobId = validateJobId(input.jobId);
  let loaded = await loadWithManifest(uid, input.privateKey, jobId, true);
  if (!loaded) throw new VaultImportJobError("not-found", "가져오기 작업을 찾을 수 없습니다.");
  if (loaded.stored.status === "committed") {
    return { ...summary(loaded.stored, jobId, loaded.manifest), entrySoftDeleted: 0, folderRootsTrashed: 0, alreadyCleaned: 0 };
  }
  if (loaded.stored.status === "rolled-back") {
    return { ...summary(loaded.stored, jobId, loaded.manifest), entrySoftDeleted: 0, folderRootsTrashed: 0, alreadyCleaned: 0 };
  }
  if (loaded.stored.status === "preparing") {
    const rolledBack = await transitionRollbackStatus(uid, jobId, "rolled-back", null);
    return { ...summary(rolledBack, jobId, null), entrySoftDeleted: 0, folderRootsTrashed: 0, alreadyCleaned: 0 };
  }
  if (!loaded.manifest) {
    throw new VaultImportJobError("corrupt", "복구할 가져오기 manifest가 완전하지 않습니다.");
  }
  const manifest = loaded.manifest;
  await transitionRollbackStatus(uid, jobId, "rolling-back", null);
  let entrySoftDeleted = 0;
  let folderRootsTrashed = 0;
  let alreadyCleaned = 0;
  try {
    let snapshot = await loadCompleteOwnerSnapshot(uid, manifest);
    let plan = planVaultImportRollback({ jobId, manifest, ...snapshot });
    alreadyCleaned += plan.alreadyCleanedEntries + plan.alreadyCleanedFolderRoots;
    const entryTargetById = new Map(manifest.targets
      .filter((target) => target.type === "entry")
      .map((target) => [target.targetId, target]));
    for (const entry of plan.entryDeletes) {
      try {
        await deleteRevisionedNote({
          expectedRevision: entry.revision,
          noteId: entry.noteId,
          readerUids: [uid],
          uid
        });
        entrySoftDeleted += 1;
      } catch (cause) {
        const target = entryTargetById.get(entry.noteId);
        if (!target || !await confirmEntryWasCleaned(uid, jobId, target)) throw cause;
        entrySoftDeleted += 1;
      }
    }

    // Re-read after entry compensation. This both makes the next preflight
    // idempotent and narrows the race before a root tombstone.
    snapshot = await loadCompleteOwnerSnapshot(uid, manifest);
    plan = planVaultImportRollback({ jobId, manifest, ...snapshot });
    const folderTargetById = new Map(manifest.targets
      .filter((target) => target.type === "folder")
      .map((target) => [target.targetId, target]));
    for (const folderRoot of plan.folderRootDeletes) {
      try {
        await trashRevisionedEncryptedFolderSubtree({
          expectedRevision: folderRoot.revision,
          folderId: folderRoot.folderId,
          folders: snapshot.folders,
          ownerUid: uid
        });
        folderRootsTrashed += 1;
      } catch (cause) {
        const target = folderTargetById.get(folderRoot.folderId);
        if (!target || !await confirmFolderRootWasCleaned(uid, jobId, target)) throw cause;
        folderRootsTrashed += 1;
      }
    }
    const rolledBack = await transitionRollbackStatus(uid, jobId, "rolled-back", null);
    loaded = { ...loaded, stored: rolledBack };
    return {
      ...summary(rolledBack, jobId, manifest),
      entrySoftDeleted,
      folderRootsTrashed,
      alreadyCleaned
    };
  } catch (cause) {
    const errorCode: VaultImportSafeErrorCode = cause instanceof VaultImportRollbackConflictError
      ? "rollback-conflict"
      : cause instanceof VaultImportJobError && cause.message.includes("snapshot")
        ? "snapshot-incomplete"
        : "write-failed";
    const blocked = await transitionRollbackStatus(uid, jobId, "blocked", errorCode).catch(() => loaded?.stored);
    const blockedSummary = blocked ? summary(blocked, jobId, manifest) : undefined;
    throw new VaultImportJobError(
      "blocked",
      cause instanceof Error ? cause.message : "가져오기 롤백을 완료하지 못했습니다.",
      { cause, job: blockedSummary }
    );
  }
}
