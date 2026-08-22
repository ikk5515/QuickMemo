import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot
} from "firebase/firestore";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { db } from "../lib/firebase";
import type { EncryptedPayload, WrappedNoteKey } from "../types";
import {
  MAX_VAULT_PATH_REWRITE_MANIFEST_BYTES,
  MAX_VAULT_PATH_REWRITE_SOURCE_BYTES,
  MAX_VAULT_PATH_REWRITE_STEPS,
  VAULT_PATH_REWRITE_JOB_VERSION,
  classifyVaultPathRewriteSourceState,
  type PreparedVaultPathRewriteJob,
  type VaultPathRewriteManifestV1,
  type VaultPathRewriteSourceKind,
  type VaultPathRewriteStepV1
} from "../features/vault/pathRewriteJob";
import { normalizeVaultPath } from "../features/vault/interop/path";

export type VaultPathRewriteJobStatus = "preparing" | "prepared" | "ready" | "running" | "blocked" | "completed";
export type VaultPathRewriteSafeErrorCode =
  | "content-conflict"
  | "job-corrupt"
  | "missing-source"
  | "path-state-conflict"
  | "revision-conflict"
  | "write-failed";

export interface VaultPathRewriteProfile {
  uid: string;
  publicKeyJwk: JsonWebKey;
}

export interface VaultPathRewriteJobSummary {
  jobId: string;
  status: VaultPathRewriteJobStatus;
  stepCount: number;
  cursor: number;
  confirmedCount: number;
  attemptCount: number;
  retryCount: number;
  lastErrorCode: VaultPathRewriteSafeErrorCode | null;
  revision: number;
  manifest: VaultPathRewriteManifestV1;
}

export interface VaultPathRewriteSourceSnapshot {
  sourceEntryId: string;
  sourceKind: VaultPathRewriteSourceKind;
  revision: number;
  source: string;
}

export interface ResumeVaultPathRewriteJobResult extends VaultPathRewriteJobSummary {
  processedSteps: number;
}

export type RecoverPreparedVaultPathRewriteJobResult =
  | { recovery: "activated"; job: VaultPathRewriteJobSummary }
  | { recovery: "not-applied"; job: VaultPathRewriteJobSummary }
  | { recovery: "conflict"; job: VaultPathRewriteJobSummary };

interface StoredVaultPathRewriteJob {
  ownerUid: string;
  kind: "path-rewrite-v1";
  version: typeof VAULT_PATH_REWRITE_JOB_VERSION;
  planFingerprint: string;
  status: VaultPathRewriteJobStatus;
  stepCount: number;
  cursor: number;
  confirmedCount: number;
  attemptCount: number;
  retryCount: number;
  lastErrorCode: VaultPathRewriteSafeErrorCode | null;
  revision: number;
  encryptedManifest: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
}

interface StoredVaultPathRewriteStep {
  ownerUid: string;
  jobId: string;
  stepId: string;
  ordinal: number;
  encryptedStep: EncryptedPayload;
}

const encoder = new TextEncoder();
const maxJobsPerVault = 50;
const maxJobTotalSourceBytes = 16 * 1024 * 1024;
const maxStoredCipherTextLength = 900_000;
const writeBatchSize = 50;
const maxResumeSteps = 100;
const recoverableJobStatuses: VaultPathRewriteJobStatus[] = [
  "preparing",
  "prepared",
  "ready",
  "running",
  "blocked"
];

export class VaultPathRewriteJobError extends Error {
  readonly code: "conflict" | "corrupt" | "invalid" | "not-ready";

  constructor(code: VaultPathRewriteJobError["code"], message: string) {
    super(message);
    this.name = "VaultPathRewriteJobError";
    this.code = code;
  }
}

function validateUid(uid: string) {
  if (!uid || uid !== uid.trim() || uid.length > 128 || uid.includes("/")) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 작업 사용자를 확인할 수 없습니다.");
  }
  return uid;
}

function validateJobId(jobId: string) {
  if (!/^pr1_[A-Za-z0-9_-]{43}$/.test(jobId)) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 작업 식별자가 올바르지 않습니다.");
  }
  return jobId;
}

function jobCollection(uid: string) {
  return collection(db, "vaultMaintenanceJobs", validateUid(uid), "pathRewrites");
}

function jobRef(uid: string, jobId: string) {
  return doc(jobCollection(uid), validateJobId(jobId));
}

function stepId(ordinal: number) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_VAULT_PATH_REWRITE_STEPS) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 단계 번호가 올바르지 않습니다.");
  }
  return `step-${String(ordinal).padStart(6, "0")}`;
}

function stepCollection(reference: DocumentReference<DocumentData>) {
  return collection(reference, "steps");
}

function stepRef(reference: DocumentReference<DocumentData>, ordinal: number) {
  return doc(stepCollection(reference), stepId(ordinal));
}

function validEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncryptedPayload>;
  return candidate.version === 1
    && candidate.algorithm === "AES-GCM"
    && typeof candidate.cipherText === "string"
    && candidate.cipherText.length > 0
    && candidate.cipherText.length <= maxStoredCipherTextLength
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

function validStatus(value: unknown): value is VaultPathRewriteJobStatus {
  return value === "preparing"
    || value === "prepared"
    || value === "ready"
    || value === "running"
    || value === "blocked"
    || value === "completed";
}

function validErrorCode(value: unknown): value is VaultPathRewriteSafeErrorCode | null {
  return value === null
    || value === "content-conflict"
    || value === "job-corrupt"
    || value === "missing-source"
    || value === "path-state-conflict"
    || value === "revision-conflict"
    || value === "write-failed";
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validateStoredJob(value: unknown, uid: string, expectedJobId: string): StoredVaultPathRewriteJob {
  if (!value || typeof value !== "object") {
    throw new VaultPathRewriteJobError("corrupt", "저장된 경로 재작성 작업을 확인할 수 없습니다.");
  }
  const candidate = value as Partial<StoredVaultPathRewriteJob>;
  if (
    candidate.ownerUid !== uid
    || candidate.kind !== "path-rewrite-v1"
    || candidate.version !== VAULT_PATH_REWRITE_JOB_VERSION
    || candidate.planFingerprint !== expectedJobId
    || !validStatus(candidate.status)
    || !safeInteger(candidate.stepCount, 0, MAX_VAULT_PATH_REWRITE_STEPS)
    || !safeInteger(candidate.cursor, 0, candidate.stepCount ?? 0)
    || candidate.confirmedCount !== candidate.cursor
    || !safeInteger(candidate.attemptCount, 0, 999_999)
    || !safeInteger(candidate.retryCount, 0, candidate.attemptCount ?? 0)
    || !validErrorCode(candidate.lastErrorCode)
    || !safeInteger(candidate.revision, 1, 999_999_999_999)
    || !validEncryptedPayload(candidate.encryptedManifest)
    || !validWrappedKey(candidate.wrappedKey)
    || (candidate.status === "completed" && candidate.cursor !== candidate.stepCount)
    || (candidate.status !== "completed" && candidate.stepCount > 0 && candidate.cursor === candidate.stepCount)
  ) {
    throw new VaultPathRewriteJobError("corrupt", "저장된 경로 재작성 작업을 확인할 수 없습니다.");
  }
  return candidate as StoredVaultPathRewriteJob;
}

function validateStoredStep(
  value: unknown,
  uid: string,
  jobId: string,
  ordinal: number
): StoredVaultPathRewriteStep {
  if (!value || typeof value !== "object") {
    throw new VaultPathRewriteJobError("corrupt", "저장된 경로 재작성 단계를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<StoredVaultPathRewriteStep>;
  if (
    candidate.ownerUid !== uid
    || candidate.jobId !== jobId
    || candidate.stepId !== stepId(ordinal)
    || candidate.ordinal !== ordinal
    || !validEncryptedPayload(candidate.encryptedStep)
  ) {
    throw new VaultPathRewriteJobError("corrupt", "저장된 경로 재작성 단계를 확인할 수 없습니다.");
  }
  return candidate as StoredVaultPathRewriteStep;
}

function validateManifest(value: unknown, uid: string, stepCount: number): VaultPathRewriteManifestV1 {
  if (!value || typeof value !== "object") {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<VaultPathRewriteManifestV1>;
  if (
    candidate.version !== VAULT_PATH_REWRITE_JOB_VERSION
    || candidate.ownerUid !== uid
    || !Array.isArray(candidate.pathChanges)
    || !Array.isArray(candidate.steps)
    || candidate.steps.length !== stepCount
  ) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest를 확인할 수 없습니다.");
  }
  const serialized = JSON.stringify(candidate);
  if (encoder.encode(serialized).byteLength > MAX_VAULT_PATH_REWRITE_MANIFEST_BYTES) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest 크기가 올바르지 않습니다.");
  }
  if (!candidate.pathChanges.length || candidate.pathChanges.length > MAX_VAULT_PATH_REWRITE_STEPS) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest의 경로 변경 수가 올바르지 않습니다.");
  }
  const pathEntryIds = new Set<string>();
  const oldPaths = new Set<string>();
  for (const pathChange of candidate.pathChanges) {
    if (
      !pathChange
      || typeof pathChange !== "object"
      || typeof pathChange.entryId !== "string"
      || !pathChange.entryId
      || pathChange.entryId !== pathChange.entryId.trim()
      || pathChange.entryId.length > 120
      || pathChange.entryId.includes("/")
      || typeof pathChange.oldPath !== "string"
      || typeof pathChange.newPath !== "string"
      || pathEntryIds.has(pathChange.entryId)
    ) {
      throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest의 경로 변경이 올바르지 않습니다.");
    }
    let oldPath: string;
    let newPath: string;
    try {
      oldPath = normalizeVaultPath(pathChange.oldPath);
      newPath = normalizeVaultPath(pathChange.newPath);
    } catch {
      throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest의 Vault 경로가 올바르지 않습니다.");
    }
    const oldPathKey = oldPath.toLocaleLowerCase("en-US");
    if (
      oldPath !== pathChange.oldPath
      || newPath !== pathChange.newPath
      || oldPathKey === newPath.toLocaleLowerCase("en-US")
      || oldPaths.has(oldPathKey)
    ) {
      throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest의 Vault 경로가 일관되지 않습니다.");
    }
    pathEntryIds.add(pathChange.entryId);
    oldPaths.add(oldPathKey);
  }
  const sourceIds = new Set<string>();
  for (const [ordinal, step] of candidate.steps.entries()) {
    if (
      !step
      || typeof step !== "object"
      || step.ordinal !== ordinal
      || typeof step.sourceEntryId !== "string"
      || !step.sourceEntryId
      || step.sourceEntryId !== step.sourceEntryId.trim()
      || step.sourceEntryId.length > 120
      || step.sourceEntryId.includes("/")
      || sourceIds.has(step.sourceEntryId)
      || (step.sourceKind !== "markdown" && step.sourceKind !== "canvas")
      || !safeInteger(step.expectedRevision, 0, 999_999_999_999)
      || !/^[A-Za-z0-9_-]{43}$/.test(step.originalSourceDigest)
      || !/^[A-Za-z0-9_-]{43}$/.test(step.rewrittenSourceDigest)
      || step.originalSourceDigest === step.rewrittenSourceDigest
      || !safeInteger(step.changeCount, 1, 100_000)
    ) {
      throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest의 source 단계가 올바르지 않습니다.");
    }
    sourceIds.add(step.sourceEntryId);
  }
  return candidate as VaultPathRewriteManifestV1;
}

function validateStep(value: unknown, summary: VaultPathRewriteManifestV1["steps"][number]): VaultPathRewriteStepV1 {
  if (!value || typeof value !== "object") {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 단계 payload를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<VaultPathRewriteStepV1>;
  if (
    candidate.version !== VAULT_PATH_REWRITE_JOB_VERSION
    || candidate.ordinal !== summary.ordinal
    || candidate.sourceEntryId !== summary.sourceEntryId
    || candidate.sourceKind !== summary.sourceKind
    || candidate.expectedRevision !== summary.expectedRevision
    || candidate.originalSourceDigest !== summary.originalSourceDigest
    || candidate.rewrittenSourceDigest !== summary.rewrittenSourceDigest
    || candidate.changeCount !== summary.changeCount
    || typeof candidate.rewrittenSource !== "string"
    || encoder.encode(candidate.rewrittenSource).byteLength > MAX_VAULT_PATH_REWRITE_SOURCE_BYTES
  ) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 단계 payload를 확인할 수 없습니다.");
  }
  return candidate as VaultPathRewriteStepV1;
}

async function validateDecryptedStep(
  value: unknown,
  summary: VaultPathRewriteManifestV1["steps"][number]
) {
  const step = validateStep(value, summary);
  const contentState = await classifyVaultPathRewriteSourceState(step, {
    revision: step.expectedRevision + 1,
    source: step.rewrittenSource
  });
  if (contentState.state !== "confirmed") {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 단계의 source digest가 일치하지 않습니다.");
  }
  return step;
}

function parseJson(value: string, label: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new VaultPathRewriteJobError("corrupt", `${label} 암호화 payload를 해석할 수 없습니다.`);
  }
}

async function decryptManifest(
  stored: StoredVaultPathRewriteJob,
  uid: string,
  jobKey: CryptoKey
) {
  const serialized = await decryptText(stored.encryptedManifest, jobKey);
  return validateManifest(parseJson(serialized, "경로 재작성 manifest"), uid, stored.stepCount);
}

function summary(stored: StoredVaultPathRewriteJob, jobId: string, manifest: VaultPathRewriteManifestV1) {
  return {
    jobId,
    status: stored.status,
    stepCount: stored.stepCount,
    cursor: stored.cursor,
    confirmedCount: stored.confirmedCount,
    attemptCount: stored.attemptCount,
    retryCount: stored.retryCount,
    lastErrorCode: stored.lastErrorCode,
    revision: stored.revision,
    manifest
  } satisfies VaultPathRewriteJobSummary;
}

function recoveryResult(
  stored: StoredVaultPathRewriteJob,
  jobId: string,
  manifest: VaultPathRewriteManifestV1
): RecoverPreparedVaultPathRewriteJobResult {
  const job = summary(stored, jobId, manifest);
  if (stored.status === "ready" || stored.status === "running" || stored.status === "completed") {
    return { recovery: "activated", job };
  }
  if (stored.status === "prepared") return { recovery: "not-applied", job };
  return { recovery: "conflict", job };
}

async function loadStoredJob(uid: string, jobId: string) {
  const reference = jobRef(uid, jobId);
  const snapshot = await getDoc(reference);
  if (!snapshot.exists()) return null;
  return { reference, stored: validateStoredJob(snapshot.data(), uid, jobId) };
}

async function loadJobWithKey(uid: string, privateKey: CryptoKey, jobId: string) {
  const loaded = await loadStoredJob(uid, jobId);
  if (!loaded) return null;
  const jobKey = await unwrapNoteKey(loaded.stored.wrappedKey, privateKey);
  const manifest = await decryptManifest(loaded.stored, uid, jobKey);
  return { ...loaded, jobKey, manifest };
}

/**
 * Creates every encrypted step before exposing a job as ready. Repeating this
 * call with the same deterministic plan fills only missing preparation steps,
 * so a network interruption cannot create a partially runnable operation.
 */
export async function ensureVaultPathRewriteJob(
  profile: VaultPathRewriteProfile,
  privateKey: CryptoKey,
  prepared: PreparedVaultPathRewriteJob
): Promise<VaultPathRewriteJobSummary> {
  const uid = validateUid(profile.uid);
  validateJobId(prepared.jobId);
  if (
    !profile.publicKeyJwk
    || !privateKey
    || prepared.manifest.ownerUid !== uid
    || prepared.steps.length !== prepared.manifest.steps.length
  ) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 계획 소유자 또는 단계 수가 일치하지 않습니다.");
  }
  const totalSourceBytes = prepared.steps.reduce(
    (total, step) => total + encoder.encode(step.rewrittenSource).byteLength,
    0
  );
  if (totalSourceBytes > maxJobTotalSourceBytes) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 작업의 전체 source 크기가 한도를 초과했습니다.");
  }

  const reference = jobRef(uid, prepared.jobId);
  const candidateKey = await generateNoteKey();
  const [candidateEncryptedManifest, candidateWrappedKey] = await Promise.all([
    encryptText(JSON.stringify(prepared.manifest), candidateKey),
    wrapNoteKey(candidateKey, profile.publicKeyJwk)
  ]);
  const selected = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists()) {
      return validateStoredJob(snapshot.data(), uid, prepared.jobId);
    }
    const initialStatus: VaultPathRewriteJobStatus = "preparing";
    const stored: StoredVaultPathRewriteJob = {
      ownerUid: uid,
      kind: "path-rewrite-v1",
      version: VAULT_PATH_REWRITE_JOB_VERSION,
      planFingerprint: prepared.jobId,
      status: initialStatus,
      stepCount: prepared.steps.length,
      cursor: 0,
      confirmedCount: 0,
      attemptCount: 0,
      retryCount: 0,
      lastErrorCode: null,
      revision: 1,
      encryptedManifest: candidateEncryptedManifest,
      wrappedKey: candidateWrappedKey
    };
    transaction.set(reference, {
      ...stored,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return stored;
  });

  const jobKey = selected.wrappedKey === candidateWrappedKey
    ? candidateKey
    : await unwrapNoteKey(selected.wrappedKey, privateKey);
  const manifest = await decryptManifest(selected, uid, jobKey);
  if (JSON.stringify(manifest) !== JSON.stringify(prepared.manifest)) {
    throw new VaultPathRewriteJobError("conflict", "같은 작업 식별자에 다른 경로 재작성 계획이 저장되어 있습니다.");
  }
  const existingSnapshots = await getDocs(stepCollection(reference));
  if (existingSnapshots.size > prepared.steps.length) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 작업에 알 수 없는 단계가 저장되어 있습니다.");
  }
  const existingOrdinals = new Set<number>();
  const existingByOrdinal = new Map<number, DocumentSnapshot<DocumentData>>();
  existingSnapshots.forEach((snapshot) => {
    const ordinal = Number(snapshot.id.replace(/^step-/, ""));
    if (!Number.isSafeInteger(ordinal) || stepId(ordinal) !== snapshot.id || existingOrdinals.has(ordinal)) {
      throw new VaultPathRewriteJobError("corrupt", "경로 재작성 단계 순서가 올바르지 않습니다.");
    }
    validateStoredStep(snapshot.data(), uid, prepared.jobId, ordinal);
    existingOrdinals.add(ordinal);
    existingByOrdinal.set(ordinal, snapshot);
  });
  for (const [ordinal, snapshot] of existingByOrdinal) {
    const storedStep = validateStoredStep(snapshot.data(), uid, prepared.jobId, ordinal);
    const serialized = await decryptText(storedStep.encryptedStep, jobKey);
    const step = await validateDecryptedStep(parseJson(serialized, "경로 재작성 단계"), manifest.steps[ordinal]);
    if (JSON.stringify(step) !== JSON.stringify(prepared.steps[ordinal])) {
      throw new VaultPathRewriteJobError("conflict", "저장된 경로 재작성 단계가 현재 계획과 일치하지 않습니다.");
    }
  }

  for (let offset = 0; offset < prepared.steps.length; offset += writeBatchSize) {
    const pending = prepared.steps
      .slice(offset, offset + writeBatchSize)
      .filter((step) => !existingOrdinals.has(step.ordinal));
    if (!pending.length) continue;
    const batch = writeBatch(db);
    for (const step of pending) {
      const serialized = JSON.stringify(step);
      const encryptedStep = await encryptText(serialized, jobKey);
      if (encryptedStep.cipherText.length > maxStoredCipherTextLength) {
        throw new VaultPathRewriteJobError("invalid", "암호화된 경로 재작성 단계가 저장 한도를 초과했습니다.");
      }
      batch.set(stepRef(reference, step.ordinal), {
        ownerUid: uid,
        jobId: prepared.jobId,
        stepId: stepId(step.ordinal),
        ordinal: step.ordinal,
        encryptedStep,
        createdAt: serverTimestamp()
      } satisfies StoredVaultPathRewriteStep & { createdAt: ReturnType<typeof serverTimestamp> });
    }
    await batch.commit();
  }

  const ready = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 준비 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, prepared.jobId);
    if (current.status !== "preparing") return current;
    const next: StoredVaultPathRewriteJob = { ...current, status: "prepared", revision: current.revision + 1 };
    transaction.update(reference, {
      status: next.status,
      revision: next.revision,
      updatedAt: serverTimestamp()
    });
    return next;
  });
  return summary(ready, prepared.jobId, manifest);
}

/**
 * Activates a fully prepared job only after the caller has durably committed
 * the matching entry/folder path mutation. Prepared jobs are intentionally
 * absent from the resumable list, preventing a reload between preparation and
 * the path write from applying references to a path that never changed.
 */
export async function activateVaultPathRewriteJob(
  uid: string,
  privateKey: CryptoKey,
  jobId: string
): Promise<VaultPathRewriteJobSummary> {
  const validatedUid = validateUid(uid);
  const validatedJobId = validateJobId(jobId);
  if (!privateKey) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 암호화 세션을 확인할 수 없습니다.");
  }
  const loaded = await loadJobWithKey(validatedUid, privateKey, validatedJobId);
  if (!loaded) {
    throw new VaultPathRewriteJobError("invalid", "활성화할 경로 재작성 작업을 찾을 수 없습니다.");
  }
  const stored = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(loaded.reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 활성화 전 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), validatedUid, validatedJobId);
    if (current.status === "preparing") {
      throw new VaultPathRewriteJobError("not-ready", "경로 재작성 단계가 아직 모두 준비되지 않았습니다.");
    }
    if (current.status !== "prepared") return current;
    const status: VaultPathRewriteJobStatus = current.stepCount === 0 ? "completed" : "ready";
    const next: StoredVaultPathRewriteJob = {
      ...current,
      status,
      revision: current.revision + 1
    };
    transaction.update(loaded.reference, {
      status: next.status,
      revision: next.revision,
      activatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(status === "completed" ? { completedAt: serverTimestamp() } : {})
    });
    return next;
  });
  return summary(stored, validatedJobId, loaded.manifest);
}

export async function loadVaultPathRewriteJob(
  uid: string,
  privateKey: CryptoKey,
  jobId: string
): Promise<VaultPathRewriteJobSummary | null> {
  if (!privateKey) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 암호화 세션을 확인할 수 없습니다.");
  }
  const loaded = await loadJobWithKey(validateUid(uid), privateKey, validateJobId(jobId));
  return loaded ? summary(loaded.stored, jobId, loaded.manifest) : null;
}

async function listIncompleteVaultPathRewriteJobs(uid: string, privateKey: CryptoKey) {
  const validatedUid = validateUid(uid);
  if (!privateKey) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 암호화 세션을 확인할 수 없습니다.");
  }
  const snapshots = await getDocs(query(
    jobCollection(validatedUid),
    where("status", "in", recoverableJobStatuses),
    limit(maxJobsPerVault + 1)
  ));
  if (snapshots.size > maxJobsPerVault) {
    throw new VaultPathRewriteJobError("corrupt", "재개 가능한 Vault 유지보수 작업 수가 한도를 초과했습니다.");
  }
  const jobs: VaultPathRewriteJobSummary[] = [];
  for (const snapshot of snapshots.docs) {
    const jobId = validateJobId(snapshot.id);
    const stored = validateStoredJob(snapshot.data(), validatedUid, jobId);
    if (stored.status === "completed") continue;
    const jobKey = await unwrapNoteKey(stored.wrappedKey, privateKey);
    const manifest = await decryptManifest(stored, validatedUid, jobKey);
    jobs.push(summary(stored, jobId, manifest));
  }
  return jobs.sort((left, right) => left.jobId.localeCompare(right.jobId));
}

/** Includes `prepared` jobs so a reload after the path write can recover the activation gap. */
export async function listRecoverableVaultPathRewriteJobs(uid: string, privateKey: CryptoKey) {
  return listIncompleteVaultPathRewriteJobs(uid, privateKey);
}

export async function listResumableVaultPathRewriteJobs(uid: string, privateKey: CryptoKey) {
  return (await listIncompleteVaultPathRewriteJobs(uid, privateKey)).filter((job) =>
    job.status === "ready"
    || job.status === "running"
    || (job.status === "blocked" && job.lastErrorCode !== "path-state-conflict")
  );
}

async function markBlocked(
  uid: string,
  jobId: string,
  expectedCursor: number,
  code: VaultPathRewriteSafeErrorCode
) {
  const reference = jobRef(uid, jobId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 실행 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, jobId);
    if (current.cursor !== expectedCursor || current.status === "completed") return current;
    const next: StoredVaultPathRewriteJob = {
      ...current,
      status: "blocked",
      retryCount: current.retryCount + 1,
      lastErrorCode: code,
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      retryCount: next.retryCount,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      updatedAt: serverTimestamp()
    });
    return next;
  });
}

async function markPathStateConflict(uid: string, jobId: string) {
  const reference = jobRef(uid, jobId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 복구 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, jobId);
    if (
      current.status !== "prepared"
      && !(current.status === "blocked" && current.lastErrorCode === "path-state-conflict")
    ) return current;
    const next: StoredVaultPathRewriteJob = {
      ...current,
      status: "blocked",
      attemptCount: current.attemptCount + 1,
      retryCount: current.retryCount + 1,
      lastErrorCode: "path-state-conflict",
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      attemptCount: next.attemptCount,
      retryCount: next.retryCount,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      updatedAt: serverTimestamp()
    });
    return next;
  });
}

/**
 * Closes the only non-atomic gap in the client-only flow: the tab may close
 * after the path mutation commits but before `activateVaultPathRewriteJob`.
 * The caller supplies one server-confirmed current-path snapshot. All paths at
 * `newPath` activates the job, all at `oldPath` leaves it inert, and any mixed,
 * missing, or third state is blocked from normal resume.
 */
export async function recoverPreparedVaultPathRewriteJob(input: {
  uid: string;
  privateKey: CryptoKey;
  jobId: string;
  readCurrentPaths: (
    entryIds: readonly string[]
  ) => Promise<readonly { entryId: string; path: string }[]>;
}): Promise<RecoverPreparedVaultPathRewriteJobResult> {
  const uid = validateUid(input.uid);
  const jobId = validateJobId(input.jobId);
  if (!input.privateKey) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 암호화 세션을 확인할 수 없습니다.");
  }
  const loaded = await loadJobWithKey(uid, input.privateKey, jobId);
  if (!loaded) {
    throw new VaultPathRewriteJobError("invalid", "복구할 경로 재작성 작업을 찾을 수 없습니다.");
  }
  if (loaded.stored.status === "preparing") {
    throw new VaultPathRewriteJobError("not-ready", "경로 재작성 단계가 아직 모두 준비되지 않았습니다.");
  }
  if (
    loaded.stored.status === "ready"
    || loaded.stored.status === "running"
    || loaded.stored.status === "completed"
  ) {
    return { recovery: "activated", job: summary(loaded.stored, jobId, loaded.manifest) };
  }
  if (loaded.stored.status === "blocked" && loaded.stored.lastErrorCode !== "path-state-conflict") {
    return { recovery: "conflict", job: summary(loaded.stored, jobId, loaded.manifest) };
  }

  let currentPaths: readonly { entryId: string; path: string }[];
  try {
    currentPaths = await input.readCurrentPaths(loaded.manifest.pathChanges.map((change) => change.entryId));
  } catch {
    const blocked = await markPathStateConflict(uid, jobId);
    return recoveryResult(blocked, jobId, loaded.manifest);
  }
  const currentPathByEntryId = new Map<string, string>();
  const expectedEntryIds = new Set(loaded.manifest.pathChanges.map((change) => change.entryId));
  for (const current of currentPaths) {
    if (
      !current
      || typeof current.entryId !== "string"
      || typeof current.path !== "string"
      || !expectedEntryIds.has(current.entryId)
      || currentPathByEntryId.has(current.entryId)
    ) {
      const blocked = await markPathStateConflict(uid, jobId);
      return recoveryResult(blocked, jobId, loaded.manifest);
    }
    try {
      currentPathByEntryId.set(current.entryId, normalizeVaultPath(current.path));
    } catch {
      const blocked = await markPathStateConflict(uid, jobId);
      return recoveryResult(blocked, jobId, loaded.manifest);
    }
  }
  if (currentPathByEntryId.size !== expectedEntryIds.size) {
    const blocked = await markPathStateConflict(uid, jobId);
    return recoveryResult(blocked, jobId, loaded.manifest);
  }

  let oldPathCount = 0;
  let newPathCount = 0;
  for (const change of loaded.manifest.pathChanges) {
    const currentPath = currentPathByEntryId.get(change.entryId)?.toLocaleLowerCase("en-US");
    if (currentPath === change.oldPath.toLocaleLowerCase("en-US")) oldPathCount += 1;
    if (currentPath === change.newPath.toLocaleLowerCase("en-US")) newPathCount += 1;
  }
  const allOld = oldPathCount === loaded.manifest.pathChanges.length;
  const allNew = newPathCount === loaded.manifest.pathChanges.length;

  const transitioned = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(loaded.reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 복구 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, jobId);
    if (
      current.status === "ready"
      || current.status === "running"
      || current.status === "completed"
    ) return current;
    if (current.status === "preparing") {
      throw new VaultPathRewriteJobError("not-ready", "경로 재작성 단계가 아직 모두 준비되지 않았습니다.");
    }
    if (current.status === "blocked" && current.lastErrorCode !== "path-state-conflict") return current;

    if (allNew) {
      const status: VaultPathRewriteJobStatus = current.stepCount === 0 ? "completed" : "ready";
      const next: StoredVaultPathRewriteJob = {
        ...current,
        status,
        lastErrorCode: null,
        revision: current.revision + 1
      };
      transaction.update(loaded.reference, {
        status: next.status,
        lastErrorCode: next.lastErrorCode,
        revision: next.revision,
        activatedAt: serverTimestamp(),
        recoveredAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...(status === "completed" ? { completedAt: serverTimestamp() } : {})
      });
      return next;
    }
    if (allOld) {
      if (current.status === "prepared" && current.lastErrorCode === null) return current;
      const next: StoredVaultPathRewriteJob = {
        ...current,
        status: "prepared",
        lastErrorCode: null,
        revision: current.revision + 1
      };
      transaction.update(loaded.reference, {
        status: next.status,
        lastErrorCode: next.lastErrorCode,
        revision: next.revision,
        updatedAt: serverTimestamp()
      });
      return next;
    }

    const next: StoredVaultPathRewriteJob = {
      ...current,
      status: "blocked",
      attemptCount: current.attemptCount + 1,
      retryCount: current.retryCount + 1,
      lastErrorCode: "path-state-conflict",
      revision: current.revision + 1
    };
    transaction.update(loaded.reference, {
      status: next.status,
      attemptCount: next.attemptCount,
      retryCount: next.retryCount,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      updatedAt: serverTimestamp()
    });
    return next;
  });

  return recoveryResult(transitioned, jobId, loaded.manifest);
}

/**
 * Processes only a bounded number of steps. The service reads each source
 * before and after the adapter write and computes its digest itself. An exact
 * `expectedRevision + 1` rewritten source is therefore also an idempotent
 * confirmation after a crash between the note write and cursor update.
 */
export async function resumeVaultPathRewriteJob(input: {
  uid: string;
  privateKey: CryptoKey;
  jobId: string;
  maxSteps?: number;
  readSource: (sourceEntryId: string) => Promise<VaultPathRewriteSourceSnapshot | null>;
  applyStep: (
    step: VaultPathRewriteStepV1,
    current: VaultPathRewriteSourceSnapshot
  ) => Promise<void>;
}): Promise<ResumeVaultPathRewriteJobResult> {
  const uid = validateUid(input.uid);
  const jobId = validateJobId(input.jobId);
  if (!input.privateKey) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 암호화 세션을 확인할 수 없습니다.");
  }
  const limit = input.maxSteps ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxResumeSteps) {
    throw new VaultPathRewriteJobError("invalid", `한 번에 재개할 단계 수는 1~${maxResumeSteps}여야 합니다.`);
  }
  const loaded = await loadJobWithKey(uid, input.privateKey, jobId);
  if (!loaded) {
    throw new VaultPathRewriteJobError("invalid", "재개할 경로 재작성 작업을 찾을 수 없습니다.");
  }
  if (loaded.stored.status === "preparing" || loaded.stored.status === "prepared") {
    throw new VaultPathRewriteJobError("not-ready", "경로 재작성 단계가 아직 모두 준비되지 않았습니다.");
  }
  if (loaded.stored.status === "blocked" && loaded.stored.lastErrorCode === "path-state-conflict") {
    throw new VaultPathRewriteJobError(
      "not-ready",
      "경로 변경 상태가 섞여 있어 source 재작성 전에 복구 확인이 필요합니다."
    );
  }
  if (loaded.stored.status === "completed") {
    return { ...summary(loaded.stored, jobId, loaded.manifest), processedSteps: 0 };
  }

  let current = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(loaded.reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 실행 전 삭제되었습니다.");
    }
    const stored = validateStoredJob(snapshot.data(), uid, jobId);
    if (stored.status === "preparing" || stored.status === "prepared" || stored.status === "completed") return stored;
    const next: StoredVaultPathRewriteJob = {
      ...stored,
      status: "running",
      attemptCount: stored.attemptCount + 1,
      lastErrorCode: null,
      revision: stored.revision + 1
    };
    transaction.update(loaded.reference, {
      status: next.status,
      attemptCount: next.attemptCount,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      lastAttemptAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return next;
  });

  let processedSteps = 0;
  while (current.status !== "completed" && processedSteps < limit) {
    const ordinal = current.cursor;
    const summaryForStep = loaded.manifest.steps[ordinal];
    if (!summaryForStep || summaryForStep.ordinal !== ordinal) {
      current = await markBlocked(uid, jobId, ordinal, "job-corrupt");
      break;
    }

    let step: VaultPathRewriteStepV1;
    try {
      const snapshot = await getDoc(stepRef(loaded.reference, ordinal));
      if (!snapshot.exists()) {
        current = await markBlocked(uid, jobId, ordinal, "job-corrupt");
        break;
      }
      const storedStep = validateStoredStep(snapshot.data(), uid, jobId, ordinal);
      const serialized = await decryptText(storedStep.encryptedStep, loaded.jobKey);
      step = await validateDecryptedStep(parseJson(serialized, "경로 재작성 단계"), summaryForStep);
    } catch {
      current = await markBlocked(uid, jobId, ordinal, "job-corrupt");
      break;
    }

    let sourceSnapshot: VaultPathRewriteSourceSnapshot | null;
    try {
      sourceSnapshot = await input.readSource(step.sourceEntryId);
    } catch {
      current = await markBlocked(uid, jobId, ordinal, "write-failed");
      break;
    }
    if (!sourceSnapshot) {
      current = await markBlocked(uid, jobId, ordinal, "missing-source");
      break;
    }
    if (
      sourceSnapshot.sourceEntryId !== step.sourceEntryId
      || sourceSnapshot.sourceKind !== step.sourceKind
    ) {
      current = await markBlocked(uid, jobId, ordinal, "content-conflict");
      break;
    }

    let sourceState;
    try {
      sourceState = await classifyVaultPathRewriteSourceState(step, sourceSnapshot);
    } catch {
      current = await markBlocked(uid, jobId, ordinal, "content-conflict");
      break;
    }
    if (sourceState.state === "pending") {
      try {
        await input.applyStep(step, sourceSnapshot);
        sourceSnapshot = await input.readSource(step.sourceEntryId);
      } catch {
        current = await markBlocked(uid, jobId, ordinal, "write-failed");
        break;
      }
      if (
        !sourceSnapshot
        || sourceSnapshot.sourceEntryId !== step.sourceEntryId
        || sourceSnapshot.sourceKind !== step.sourceKind
      ) {
        current = await markBlocked(
          uid,
          jobId,
          ordinal,
          sourceSnapshot ? "content-conflict" : "missing-source"
        );
        break;
      }
      try {
        sourceState = await classifyVaultPathRewriteSourceState(step, sourceSnapshot);
      } catch {
        current = await markBlocked(uid, jobId, ordinal, "content-conflict");
        break;
      }
    }
    if (sourceState.state !== "confirmed") {
      current = await markBlocked(
        uid,
        jobId,
        ordinal,
        sourceState.state === "blocked" && sourceState.reason === "revision-mismatch"
          ? "revision-conflict"
          : "content-conflict"
      );
      break;
    }

    current = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(loaded.reference);
      if (!snapshot.exists()) {
        throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 확인 중 삭제되었습니다.");
      }
      const stored = validateStoredJob(snapshot.data(), uid, jobId);
      if (stored.cursor > ordinal || stored.status === "completed") return stored;
      if (stored.cursor !== ordinal) {
        throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업 순서가 다른 세션에서 변경되었습니다.");
      }
      const cursor = ordinal + 1;
      const status: VaultPathRewriteJobStatus = cursor === stored.stepCount ? "completed" : "running";
      const next: StoredVaultPathRewriteJob = {
        ...stored,
        cursor,
        confirmedCount: cursor,
        status,
        lastErrorCode: null,
        revision: stored.revision + 1
      };
      transaction.update(loaded.reference, {
        cursor: next.cursor,
        confirmedCount: next.confirmedCount,
        status: next.status,
        lastErrorCode: next.lastErrorCode,
        revision: next.revision,
        updatedAt: serverTimestamp(),
        ...(status === "completed" ? { completedAt: serverTimestamp() } : {})
      });
      return next;
    });
    processedSteps += 1;
  }

  return { ...summary(current, jobId, loaded.manifest), processedSteps };
}
