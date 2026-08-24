import {
  collection,
  deleteField,
  deleteDoc,
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
  type VaultPathRewriteInventoryManifestBindingV1,
  type VaultPathRewriteManifestV1,
  type VaultPathRewriteSourceKind,
  type VaultPathRewriteStepV1
} from "../features/vault/pathRewriteJob";
import { normalizeVaultPath } from "../features/vault/interop/path";

export type VaultPathRewriteJobStatus =
  | "preparing"
  | "prepared"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "not-applied"
  | "abandoned";
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
  /** Remaining server-heartbeat lease before automatic abandonment is safe. */
  recoveryAfterMs?: number;
}

export interface VaultPathRewriteRecoveryScan {
  /** A bounded page. Terminal jobs are excluded by the server status query. */
  jobs: VaultPathRewriteJobSummary[];
  /** True when another bounded scan is required after this page is resolved. */
  hasMore: boolean;
  /** The full page contains work that this scan can make terminal now. */
  shouldContinueImmediately: boolean;
}

export interface VaultPathRewriteActivationInput {
  expectedRevision: number;
  jobId: string;
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
  | { recovery: "deferred"; job: VaultPathRewriteJobSummary }
  | { recovery: "conflict"; job: VaultPathRewriteJobSummary };

type VaultPathRewriteAtomicActivationMode = "atomic-v1" | "atomic-manifest-v1";

interface StoredVaultPathRewriteJob {
  activationMode?: VaultPathRewriteAtomicActivationMode;
  inventoryFingerprint?: string;
  inventoryManifestVersion?: number;
  inventoryManifestEpoch?: number;
  inventoryManifestShardCount?: number;
  inventoryManifestRoot?: string;
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
  preparedStepCount?: number;
  mutationExpectedRevision?: number;
  mutationTargetId?: string;
  mutationTargetKind?: "entry" | "folder";
  encryptedManifest: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
  recoveryCheckCount?: number;
  lastRecoveryCheckAt?: unknown;
  remainingStepCount?: number;
  activatedAt?: unknown;
  recoveredAt?: unknown;
  abandonedAt?: unknown;
  completedAt?: unknown;
  cleanupStartedAt?: unknown;
  lastCleanupStepId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface StoredVaultPathRewriteStep {
  ownerUid: string;
  jobId: string;
  stepId: string;
  ordinal: number;
  encryptedStep: EncryptedPayload;
}

const encoder = new TextEncoder();
// A rewrite step encrypts both the original and rewritten source. New atomic
// jobs use the smaller advisory cap, while the recovery scan must preserve the
// previous production contract that allowed as many as 50 legacy pr1 jobs.
// The +1 page detects concurrent atomic cap overshoot without treating a
// recoverable backlog as corruption.
const maxAtomicJobsPerVault = 8;
const maxLegacyJobsPerVault = 50;
const maxRecoverableJobsPerVault = maxAtomicJobsPerVault + maxLegacyJobsPerVault;
const recoverableJobQueryLimit = maxRecoverableJobsPerVault + 1;
const maxJobTotalSourceBytes = 16 * 1024 * 1024;
const maxStoredCipherTextLength = 900_000;
const writeBatchSize = 50;
const maxResumeSteps = 100;
const maxAdapterReadAttempts = 3;
const maxTransientApplyAttempts = 2;
const terminalCleanupJobsPerPass = 3;
const terminalCleanupStepsPerPass = 50;
const terminalCleanupNoProgressLimit = 3;
const terminalCleanupQueryLimit = recoverableJobQueryLimit;
// Automatic cleanup runs in the foreground browser session and must not turn a
// completed 5,000-step rewrite into thousands of immediate Firestore
// transactions. One small pass per unlocked session keeps free-tier bursts and
// UI/network contention bounded; the encrypted terminal root records the exact
// remaining cursor so a later unlock can safely continue. The explicit drain
// helper below intentionally retains the full bounded-loop behavior for tests
// and operator-invoked maintenance.
const scheduledTerminalCleanupJobsPerPass = 1;
const scheduledTerminalCleanupStepsPerPass = 8;
const scheduledTerminalCleanupQueryLimit = 8;
const scheduledTerminalCleanupPassesPerSession = 1;
const terminalCleanupPumps = new Map<string, Promise<void>>();
const terminalCleanupSessionPasses = new Map<string, number>();
// A different tab must not classify a job that is still being prepared or
// committed as abandoned. Preparation heartbeats refresh this server timestamp
// fence before every step batch; two minutes is also longer than the paired
// server mutation request window.
const atomicRecoveryStaleAfterMs = 2 * 60_000;
// Legacy pr1 preparation had no heartbeat. It still predates path mutation,
// but gets a wider fence so an older tab finishing a large encrypted upload is
// never abandoned by a newly opened tab.
const legacyPreparingRecoveryStaleAfterMs = 15 * 60_000;
// Zero-step jobs contain no step ciphertext, but their small completed root is
// retained briefly as durable proof for a mutating tab whose HTTP response was
// lost. Non-zero completed jobs and every abandoned job remain immediately
// eligible for cleanup.
const zeroStepCompletionProofMs = 2 * 60_000;
const dormantRecoveryBackoffMs = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const;
const recoverableJobStatuses: VaultPathRewriteJobStatus[] = [
  "ready",
  "running",
  "blocked",
  "prepared",
  "preparing",
  "not-applied"
];

function adapterErrorCode(cause: unknown) {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return "";
  return String(cause.code).replace(/^firestore\//u, "");
}

function retryableAdapterWriteFailure(cause: unknown) {
  const code = adapterErrorCode(cause);
  return cause instanceof TypeError
    || code === "aborted"
    || code === "cancelled"
    || code === "deadline-exceeded"
    || code === "network-request-failed"
    || code === "network_error"
    || code === "network_timeout"
    || code === "unavailable";
}

async function readRewriteSourceWithRetry(
  readSource: (sourceEntryId: string) => Promise<VaultPathRewriteSourceSnapshot | null>,
  sourceEntryId: string
) {
  let lastCause: unknown;
  for (let attempt = 1; attempt <= maxAdapterReadAttempts; attempt += 1) {
    try {
      return await readSource(sourceEntryId);
    } catch (cause) {
      lastCause = cause;
      if (attempt === maxAdapterReadAttempts || !retryableAdapterWriteFailure(cause)) {
        throw cause;
      }
      await Promise.resolve();
    }
  }
  throw lastCause;
}

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
  if (!/^pr[123]_[A-Za-z0-9_-]{43}$/.test(jobId)) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 작업 식별자가 올바르지 않습니다.");
  }
  return jobId;
}

function activationModeForJobId(jobId: string): VaultPathRewriteAtomicActivationMode | null {
  if (jobId.startsWith("pr2_")) return "atomic-v1";
  if (jobId.startsWith("pr3_")) return "atomic-manifest-v1";
  return null;
}

function atomicActivationMode(value: StoredVaultPathRewriteJob | Partial<StoredVaultPathRewriteJob>) {
  return value.activationMode === "atomic-v1" || value.activationMode === "atomic-manifest-v1";
}

function validInventoryManifestBinding(value: Partial<StoredVaultPathRewriteJob>) {
  return value.inventoryManifestVersion === 1
    && value.inventoryManifestShardCount === 32
    && safeInteger(value.inventoryManifestEpoch, 1, 999_999_999_999)
    && typeof value.inventoryManifestRoot === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(value.inventoryManifestRoot);
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
    || value === "completed"
    || value === "not-applied"
    || value === "abandoned";
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

function timestampMillis(value: unknown) {
  if (!value || typeof value !== "object" || !("toMillis" in value)) return null;
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  if (typeof toMillis !== "function") return null;
  try {
    const milliseconds = toMillis.call(value) as unknown;
    return typeof milliseconds === "number" && Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function dormantRecoveryDelay(checkCount: number) {
  const index = Math.min(Math.max(checkCount, 1) - 1, dormantRecoveryBackoffMs.length - 1);
  return dormantRecoveryBackoffMs[index];
}

function preparationRecoveryDelayMs(stored: StoredVaultPathRewriteJob, now = Date.now()) {
  const staleAfterMs = atomicActivationMode(stored)
    && (stored.status === "preparing" || stored.status === "prepared")
    ? atomicRecoveryStaleAfterMs
    : !atomicActivationMode(stored) && stored.status === "preparing"
      ? legacyPreparingRecoveryStaleAfterMs
      : 0;
  if (staleAfterMs === 0) return 0;
  const updatedAt = timestampMillis(stored.updatedAt);
  // A missing/non-server timestamp cannot prove that a preparation lease is
  // stale. Fail closed and leave it for explicit operator recovery.
  return updatedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, updatedAt + staleAfterMs - now);
}

function preparationRecoveryIsDue(stored: StoredVaultPathRewriteJob, now = Date.now()) {
  return preparationRecoveryDelayMs(stored, now) === 0;
}

function dormantRecoveryDelayMs(stored: StoredVaultPathRewriteJob, now = Date.now()) {
  if (stored.status !== "not-applied") return 0;
  const checkedAt = timestampMillis(stored.lastRecoveryCheckAt);
  if (checkedAt === null) return 0;
  const checkCount = safeInteger(stored.recoveryCheckCount, 1, 999_999)
    ? stored.recoveryCheckCount
    : 1;
  return Math.max(0, checkedAt + dormantRecoveryDelay(checkCount) - now);
}

function terminalCleanupEligibility(stored: StoredVaultPathRewriteJob, now = Date.now()) {
  if (stored.status !== "completed" || stored.stepCount !== 0) {
    return { eligible: true, retryAfterMs: 0 };
  }
  const completedAt = timestampMillis(stored.completedAt);
  if (completedAt === null) {
    throw new VaultPathRewriteJobError("corrupt", "완료된 경로 재작성 작업의 확인 시각이 올바르지 않습니다.");
  }
  const retryAfterMs = Math.max(0, completedAt + zeroStepCompletionProofMs - now);
  return { eligible: retryAfterMs === 0, retryAfterMs };
}

function terminalJob(stored: StoredVaultPathRewriteJob) {
  return stored.status === "completed" || stored.status === "abandoned";
}

function validateStoredJob(value: unknown, uid: string, expectedJobId: string): StoredVaultPathRewriteJob {
  if (!value || typeof value !== "object") {
    throw new VaultPathRewriteJobError("corrupt", "저장된 경로 재작성 작업을 확인할 수 없습니다.");
  }
  const candidate = value as Partial<StoredVaultPathRewriteJob>;
  const expectedActivationMode = activationModeForJobId(expectedJobId);
  const atomic = expectedActivationMode !== null;
  const pr2 = expectedActivationMode === "atomic-v1";
  const pr3 = expectedActivationMode === "atomic-manifest-v1";
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
    || timestampMillis(candidate.createdAt) === null
    || timestampMillis(candidate.updatedAt) === null
    || (
      atomic
      && (
        candidate.activationMode !== expectedActivationMode
        || (
          pr2
          && (
            !/^[A-Za-z0-9_-]{43}$/u.test(candidate.inventoryFingerprint ?? "")
            || candidate.inventoryManifestVersion !== undefined
            || candidate.inventoryManifestEpoch !== undefined
            || candidate.inventoryManifestShardCount !== undefined
            || candidate.inventoryManifestRoot !== undefined
          )
        )
        || (
          pr3
          && (
            candidate.inventoryFingerprint !== undefined
            || !validInventoryManifestBinding(candidate)
          )
        )
        || !safeInteger(candidate.preparedStepCount, 0, candidate.stepCount ?? 0)
        || (
          candidate.status !== "preparing"
          && candidate.status !== "abandoned"
          && candidate.preparedStepCount !== candidate.stepCount
        )
        || (candidate.mutationTargetKind !== "entry" && candidate.mutationTargetKind !== "folder")
        || typeof candidate.mutationTargetId !== "string"
        || !candidate.mutationTargetId
        || candidate.mutationTargetId.length > 120
        || candidate.mutationTargetId.includes("/")
        || !safeInteger(candidate.mutationExpectedRevision, 0, 999_999_999_999)
      )
    )
    || (
      !atomic
      && (
        candidate.activationMode !== undefined
        || candidate.inventoryFingerprint !== undefined
        || candidate.inventoryManifestVersion !== undefined
        || candidate.inventoryManifestEpoch !== undefined
        || candidate.inventoryManifestShardCount !== undefined
        || candidate.inventoryManifestRoot !== undefined
        || candidate.preparedStepCount !== undefined
        || candidate.mutationTargetKind !== undefined
        || candidate.mutationTargetId !== undefined
        || candidate.mutationExpectedRevision !== undefined
      )
    )
    || (
      candidate.recoveryCheckCount !== undefined
      && !safeInteger(candidate.recoveryCheckCount, 0, 999_999)
    )
    || (
      candidate.remainingStepCount !== undefined
      && !safeInteger(candidate.remainingStepCount, 0, candidate.stepCount ?? 0)
    )
    || (candidate.lastRecoveryCheckAt !== undefined && timestampMillis(candidate.lastRecoveryCheckAt) === null)
    || (candidate.activatedAt !== undefined && timestampMillis(candidate.activatedAt) === null)
    || (candidate.recoveredAt !== undefined && timestampMillis(candidate.recoveredAt) === null)
    || (candidate.abandonedAt !== undefined && timestampMillis(candidate.abandonedAt) === null)
    || (candidate.recoveredAt !== undefined && candidate.activatedAt === undefined)
    || (candidate.completedAt !== undefined && timestampMillis(candidate.completedAt) === null)
    || (
      (candidate.status === "completed" || candidate.status === "abandoned")
      && timestampMillis(candidate.completedAt) === null
    )
    || (candidate.cleanupStartedAt !== undefined && timestampMillis(candidate.cleanupStartedAt) === null)
    || (
      candidate.lastCleanupStepId !== undefined
      && !/^step-[0-9]{6}$/.test(candidate.lastCleanupStepId)
    )
    || (candidate.status === "completed" && candidate.cursor !== candidate.stepCount)
    || (
      candidate.status === "abandoned"
      && (
        candidate.cursor !== 0
        || candidate.confirmedCount !== 0
        || candidate.lastErrorCode !== null
      )
    )
    || (
      candidate.status === "not-applied"
      && (
        candidate.cursor !== 0
        || candidate.confirmedCount !== 0
        || candidate.lastErrorCode !== null
        || (
          candidate.recoveryCheckCount !== undefined
          && candidate.recoveryCheckCount < 1
        )
      )
    )
    || (
      candidate.status !== "completed"
      && candidate.status !== "abandoned"
      && candidate.stepCount > 0
      && candidate.cursor === candidate.stepCount
    )
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

function validateManifest(
  value: unknown,
  uid: string,
  stepCount: number,
  activationMode: VaultPathRewriteAtomicActivationMode | null
): VaultPathRewriteManifestV1 {
  if (!value || typeof value !== "object") {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 manifest를 확인할 수 없습니다.");
  }
  const candidate = value as Partial<VaultPathRewriteManifestV1>;
  if (
    candidate.version !== VAULT_PATH_REWRITE_JOB_VERSION
    || candidate.ownerUid !== uid
    || (activationMode === "atomic-v1" && (
      !/^[A-Za-z0-9_-]{43}$/u.test(candidate.inventoryFingerprint ?? "")
      || candidate.inventoryManifest !== undefined
    ))
    || (activationMode === "atomic-manifest-v1" && (
      candidate.inventoryFingerprint !== undefined
      || !validManifestBinding(candidate.inventoryManifest)
    ))
    || (activationMode === null && (
      candidate.inventoryFingerprint !== undefined
      || candidate.inventoryManifest !== undefined
    ))
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
  if (
    candidate.pathChanges.length > MAX_VAULT_PATH_REWRITE_STEPS
    || (activationMode === null && candidate.pathChanges.length === 0)
  ) {
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

function validManifestBinding(value: unknown): value is VaultPathRewriteInventoryManifestBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<VaultPathRewriteInventoryManifestBindingV1>;
  return candidate.version === 1
    && candidate.shardCount === 32
    && safeInteger(candidate.epoch, 1, 999_999_999_999)
    && typeof candidate.root === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(candidate.root);
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
  const activationMode = atomicActivationMode(stored) ? stored.activationMode! : null;
  const manifest = validateManifest(
    parseJson(serialized, "경로 재작성 manifest"),
    uid,
    stored.stepCount,
    activationMode
  );
  if (activationMode === "atomic-v1" && stored.inventoryFingerprint !== manifest.inventoryFingerprint) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 서버 인벤토리 지문이 일치하지 않습니다.");
  }
  if (activationMode === "atomic-manifest-v1" && (
    !manifest.inventoryManifest
    || stored.inventoryManifestVersion !== manifest.inventoryManifest.version
    || stored.inventoryManifestEpoch !== manifest.inventoryManifest.epoch
    || stored.inventoryManifestShardCount !== manifest.inventoryManifest.shardCount
    || stored.inventoryManifestRoot !== manifest.inventoryManifest.root
  )) {
    throw new VaultPathRewriteJobError("corrupt", "경로 재작성 고정 인벤토리 binding이 일치하지 않습니다.");
  }
  return manifest;
}

function summary(stored: StoredVaultPathRewriteJob, jobId: string, manifest: VaultPathRewriteManifestV1) {
  const recoveryAfterMs = Math.max(
    preparationRecoveryDelayMs(stored),
    dormantRecoveryDelayMs(stored)
  );
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
    manifest,
    ...(recoveryAfterMs > 0 ? { recoveryAfterMs } : {})
  } satisfies VaultPathRewriteJobSummary;
}

function recoveryResult(
  stored: StoredVaultPathRewriteJob,
  jobId: string,
  manifest: VaultPathRewriteManifestV1
): RecoverPreparedVaultPathRewriteJobResult {
  const job = summary(stored, jobId, manifest);
  if (!preparationRecoveryIsDue(stored)) {
    return { recovery: "deferred", job };
  }
  if (stored.status === "ready" || stored.status === "running" || stored.status === "completed") {
    return { recovery: "activated", job };
  }
  if (
    stored.status === "prepared"
    || stored.status === "not-applied"
    || stored.status === "abandoned"
  ) {
    return { recovery: "not-applied", job };
  }
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
  let existing = await getDoc(reference);
  if (existing.exists()) {
    const stored = validateStoredJob(existing.data(), uid, prepared.jobId);
    if (stored.status === "abandoned" && atomicActivationMode(stored)) {
      // An abandoned atomic job proves that its paired path mutation never
      // committed. Verify the encrypted deterministic plan before reviving it,
      // then fence any concurrent cleanup through the job document revision.
      const existingKey = await unwrapNoteKey(stored.wrappedKey, privateKey);
      const existingManifest = await decryptManifest(stored, uid, existingKey);
      if (JSON.stringify(existingManifest) !== JSON.stringify(prepared.manifest)) {
        throw new VaultPathRewriteJobError(
          "conflict",
          "같은 작업 식별자에 다른 경로 재작성 계획이 저장되어 있습니다."
        );
      }
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists()) return;
        const current = validateStoredJob(snapshot.data(), uid, prepared.jobId);
        if (current.status !== "abandoned" || !atomicActivationMode(current)) return;
        transaction.update(reference, {
          status: "preparing",
          preparedStepCount: 0,
          remainingStepCount: current.stepCount,
          abandonedAt: deleteField(),
          completedAt: deleteField(),
          cleanupStartedAt: deleteField(),
          lastCleanupStepId: deleteField(),
          revision: current.revision + 1,
          updatedAt: serverTimestamp()
        });
      });
      existing = await getDoc(reference);
    }
  }
  if (!existing.exists()) {
    const incomplete = await getDocs(query(
      jobCollection(uid),
      where("status", "in", recoverableJobStatuses),
      limit(recoverableJobQueryLimit)
    ));
    const atomicCount = incomplete.docs.reduce((count, document) => {
      const jobId = validateJobId(document.id);
      const stored = validateStoredJob(document.data(), uid, jobId);
      return count + (atomicActivationMode(stored) ? 1 : 0);
    }, 0);
    if (atomicCount >= maxAtomicJobsPerVault) {
      throw new VaultPathRewriteJobError(
        "conflict",
        "중단되었거나 확인 대기 중인 경로 재작성 작업이 보관 한도에 도달했습니다. 기존 작업을 먼저 복구해주세요."
      );
    }
  }
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
    // A zero-step atomic job is complete at creation time: there are no child
    // payloads to stage. Persist it directly as prepared so concurrent UI
    // effects cannot race through a redundant preparing -> prepared write.
    const initialStatus: VaultPathRewriteJobStatus = prepared.steps.length === 0
      ? "prepared"
      : "preparing";
    const inventoryManifest = prepared.manifest.inventoryManifest;
    const stored: StoredVaultPathRewriteJob = {
      activationMode: inventoryManifest ? "atomic-manifest-v1" : "atomic-v1",
      ...(inventoryManifest
        ? {
            inventoryManifestVersion: inventoryManifest.version,
            inventoryManifestEpoch: inventoryManifest.epoch,
            inventoryManifestShardCount: inventoryManifest.shardCount,
            inventoryManifestRoot: inventoryManifest.root
          }
        : { inventoryFingerprint: prepared.manifest.inventoryFingerprint }),
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
      preparedStepCount: 0,
      mutationExpectedRevision: prepared.mutationTarget.expectedRevision,
      mutationTargetId: prepared.mutationTarget.id,
      mutationTargetKind: prepared.mutationTarget.kind,
      encryptedManifest: candidateEncryptedManifest,
      wrappedKey: candidateWrappedKey,
      recoveryCheckCount: 0,
      remainingStepCount: prepared.steps.length
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
  if (selected.status === "prepared" && selected.stepCount === 0) {
    // The root transaction is the complete durable payload for a zero-step
    // plan. There are no child ciphertexts to enumerate and no preparation
    // transition to confirm, so avoid two extra Firestore round trips on the
    // common rename/move path where no incoming references exist.
    return summary(selected, prepared.jobId, manifest);
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
    // Refresh the parent immediately before each bounded write. Recovery may
    // abandon only a server-timestamp-stale parent, so a concurrent tab cannot
    // terminalize the job between an expensive encryption pass and this batch.
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) {
        throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 준비 중 삭제되었습니다.");
      }
      const current = validateStoredJob(snapshot.data(), uid, prepared.jobId);
      if (current.status !== "preparing") {
        throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업 준비 상태가 다른 세션에서 변경되었습니다.");
      }
      transaction.update(reference, {
        revision: current.revision + 1,
        updatedAt: serverTimestamp()
      });
    });
    await batch.commit();
  }

  const ready = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 준비 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, prepared.jobId);
    if (current.status === "not-applied") {
      const next: StoredVaultPathRewriteJob = {
        ...current,
        status: "prepared",
        revision: current.revision + 1
      };
      transaction.update(reference, {
        status: next.status,
        revision: next.revision,
        updatedAt: serverTimestamp()
      });
      return next;
    }
    if (current.status !== "preparing") return current;
    const next: StoredVaultPathRewriteJob = { ...current, status: "prepared", revision: current.revision + 1 };
    transaction.update(reference, {
      status: next.status,
      preparedStepCount: current.stepCount,
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
    if (current.status !== "prepared" && current.status !== "not-applied") return current;
    if (atomicActivationMode(current)) {
      throw new VaultPathRewriteJobError(
        "not-ready",
        "원자적 경로 변경은 서버 경로 transaction에서만 활성화할 수 있습니다."
      );
    }
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
  const activated = summary(stored, validatedJobId, loaded.manifest);
  if (terminalJob(stored)) {
    void scheduleTerminalVaultPathRewriteCleanup(validatedUid).catch(() => undefined);
  }
  return activated;
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

async function scanIncompleteVaultPathRewriteJobs(
  uid: string,
  privateKey: CryptoKey
): Promise<VaultPathRewriteRecoveryScan> {
  const validatedUid = validateUid(uid);
  if (!privateKey) {
    throw new VaultPathRewriteJobError("invalid", "경로 재작성 암호화 세션을 확인할 수 없습니다.");
  }
  const snapshots: DocumentSnapshot<DocumentData>[] = [];
  let hasMore = false;
  // Query one status at a time so no composite index is required and a full
  // page of deferred preparation cannot hide an already-ready job. Ready and
  // running work is deliberately first; total decrypted roots remain bounded
  // by recoverableJobQueryLimit across all status queries.
  for (const status of recoverableJobStatuses) {
    const remaining = recoverableJobQueryLimit - snapshots.length;
    if (remaining <= 0) {
      hasMore = true;
      break;
    }
    const page = await getDocs(query(
      jobCollection(validatedUid),
      where("status", "==", status),
      limit(remaining)
    ));
    snapshots.push(...page.docs);
    if (page.size >= remaining) {
      hasMore = true;
      break;
    }
  }
  const jobs: VaultPathRewriteJobSummary[] = [];
  for (const snapshot of snapshots) {
    const jobId = validateJobId(snapshot.id);
    const stored = validateStoredJob(snapshot.data(), validatedUid, jobId);
    if (stored.status === "completed") continue;
    // Dormant jobs remain in the result with a bounded recoveryAfterMs. The UI
    // schedules one due-time retry instead of rescanning paths on every login.
    const jobKey = await unwrapNoteKey(stored.wrappedKey, privateKey);
    const manifest = await decryptManifest(stored, validatedUid, jobKey);
    jobs.push(summary(stored, jobId, manifest));
  }
  return {
    jobs: jobs.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    // A full page may be exactly complete; one harmless empty follow-up keeps
    // concurrent cap overshoot recoverable without an unbounded query.
    hasMore,
    shouldContinueImmediately: hasMore
      && jobs.some((job) => (job.recoveryAfterMs ?? 0) <= 0)
  };
}

/** Includes due dormant jobs so a stale all-old observation cannot hide a committed move. */
export async function listRecoverableVaultPathRewriteJobs(uid: string, privateKey: CryptoKey) {
  return (await scanIncompleteVaultPathRewriteJobs(uid, privateKey)).jobs;
}

export async function scanRecoverableVaultPathRewriteJobs(uid: string, privateKey: CryptoKey) {
  return scanIncompleteVaultPathRewriteJobs(uid, privateKey);
}

export async function listResumableVaultPathRewriteJobs(uid: string, privateKey: CryptoKey) {
  return (await scanIncompleteVaultPathRewriteJobs(uid, privateKey)).jobs.filter((job) =>
    job.status === "ready"
    || job.status === "running"
    || (job.status === "blocked" && job.lastErrorCode !== "path-state-conflict")
  );
}

async function initializeTerminalPathRewriteCleanup(uid: string, jobId: string) {
  const reference = jobRef(uid, jobId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) return null;
    const current = validateStoredJob(snapshot.data(), uid, jobId);
    if (!terminalJob(current)) return current;
    if (current.cleanupStartedAt !== undefined && current.remainingStepCount !== undefined) return current;
    const next: StoredVaultPathRewriteJob = {
      ...current,
      remainingStepCount: current.remainingStepCount ?? current.stepCount,
      revision: current.revision + 1
    };
    transaction.update(reference, {
      remainingStepCount: next.remainingStepCount,
      cleanupStartedAt: serverTimestamp(),
      revision: next.revision,
      updatedAt: serverTimestamp()
    });
    return next;
  });
}

async function cleanupTerminalPathRewriteJob(uid: string, jobId: string, maximumSteps: number) {
  const reference = jobRef(uid, jobId);
  let current = await initializeTerminalPathRewriteCleanup(uid, jobId);
  if (
    current
    && terminalJob(current)
    && (current.cleanupStartedAt === undefined || current.remainingStepCount === undefined)
  ) {
    const initialized = await getDoc(reference);
    current = initialized.exists() ? validateStoredJob(initialized.data(), uid, jobId) : null;
  }
  if (
    !current
    || !terminalJob(current)
    || current.cleanupStartedAt === undefined
    || current.remainingStepCount === undefined
  ) {
    return { cleaned: false, removedSteps: 0 };
  }

  if (current.status === "abandoned") {
    const abandonedSteps = await getDocs(query(
      stepCollection(reference),
      limit(maximumSteps)
    ));
    if (abandonedSteps.size > 0) {
      const batch = writeBatch(db);
      for (const stepSnapshot of abandonedSteps.docs) {
        const ordinal = Number(stepSnapshot.id.replace(/^step-/, ""));
        validateStoredStep(stepSnapshot.data(), uid, jobId, ordinal);
        batch.delete(stepSnapshot.ref);
      }
      await batch.commit();
      return { cleaned: false, removedSteps: abandonedSteps.size };
    }
    current = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) return null;
      const stored = validateStoredJob(snapshot.data(), uid, jobId);
      if (stored.status !== "abandoned") return stored;
      const next: StoredVaultPathRewriteJob = {
        ...stored,
        remainingStepCount: 0,
        revision: stored.revision + 1
      };
      transaction.update(reference, {
        remainingStepCount: 0,
        revision: next.revision,
        updatedAt: serverTimestamp()
      });
      return next;
    });
    if (!current || current.status !== "abandoned" || current.remainingStepCount !== 0) {
      return { cleaned: false, removedSteps: 0 };
    }
    try {
      await deleteDoc(reference);
    } catch (cause) {
      const confirmed = await getDoc(reference);
      if (confirmed.exists()) throw cause;
    }
    return { cleaned: true, removedSteps: 0 };
  }

  let removedSteps = 0;
  while ((current.remainingStepCount ?? 0) > 0 && removedSteps < maximumSteps) {
    current = await runTransaction(db, async (transaction) => {
      const jobSnapshot = await transaction.get(reference);
      if (!jobSnapshot.exists()) {
        throw new VaultPathRewriteJobError("conflict", "완료된 경로 재작성 작업이 정리 중 삭제되었습니다.");
      }
      const stored = validateStoredJob(jobSnapshot.data(), uid, jobId);
      if (
        !terminalJob(stored)
        || stored.cleanupStartedAt === undefined
        || stored.remainingStepCount === undefined
      ) {
        throw new VaultPathRewriteJobError("conflict", "완료된 경로 재작성 작업의 정리 상태가 변경되었습니다.");
      }
      if (stored.remainingStepCount === 0) return stored;
      const ordinal = stored.remainingStepCount - 1;
      const storedStepReference = stepRef(reference, ordinal);
      const stepSnapshot = await transaction.get(storedStepReference);
      if (!stepSnapshot.exists()) {
        throw new VaultPathRewriteJobError("corrupt", "완료된 경로 재작성 단계의 정리 순서를 확인할 수 없습니다.");
      }
      validateStoredStep(stepSnapshot.data(), uid, jobId, ordinal);
      const next: StoredVaultPathRewriteJob = {
        ...stored,
        remainingStepCount: ordinal,
        revision: stored.revision + 1
      };
      transaction.delete(storedStepReference);
      transaction.update(reference, {
        remainingStepCount: next.remainingStepCount,
        lastCleanupStepId: stepId(ordinal),
        revision: next.revision,
        updatedAt: serverTimestamp()
      });
      return next;
    });
    removedSteps += 1;
  }

  if ((current.remainingStepCount ?? 0) > 0) {
    return { cleaned: false, removedSteps };
  }
  try {
    await deleteDoc(reference);
  } catch (cause) {
    const confirmed = await getDoc(reference);
    if (confirmed.exists()) throw cause;
  }
  return { cleaned: true, removedSteps };
}

/**
 * Removes immutable completed/abandoned ciphertext immediately. A terminal
 * rewrite is already fully confirmed (or an atomic path mutation provably did
 * not commit), so retaining its encrypted steps adds quota risk without a
 * recovery benefit. Work remains capped per call and callers may schedule
 * another best-effort pass until `hasMore` becomes false.
 */
async function cleanupRetainedTerminalVaultPathRewriteJobsPass(
  uid: string,
  limits: {
    jobsPerPass: number;
    queryLimit: number;
    stepsPerPass: number;
  }
) {
  const validatedUid = validateUid(uid);
  const snapshot = await getDocs(query(
    jobCollection(validatedUid),
    where("status", "in", ["completed", "abandoned"]),
    limit(limits.queryLimit)
  ));
  let cleanedJobs = 0;
  let removedSteps = 0;
  let remainingStepBudget = limits.stepsPerPass;
  const now = Date.now();
  let retryAfterMs = 0;
  const terminalDocuments = snapshot.docs
    .map((document) => ({
      document,
      stored: validateStoredJob(document.data(), validatedUid, validateJobId(document.id))
    }))
    .filter(({ stored }) => terminalJob(stored))
    .sort((left, right) => (
      timestampMillis(left.stored.completedAt) ?? 0
    ) - (
      timestampMillis(right.stored.completedAt) ?? 0
    ));
  const retained = terminalDocuments
    .filter(({ stored }) => {
      const eligibility = terminalCleanupEligibility(stored, now);
      if (!eligibility.eligible) {
        retryAfterMs = retryAfterMs === 0
          ? eligibility.retryAfterMs
          : Math.min(retryAfterMs, eligibility.retryAfterMs);
      }
      return eligibility.eligible;
    })
    .slice(0, limits.jobsPerPass);
  for (const { document } of retained) {
    if (remainingStepBudget <= 0) break;
    const result = await cleanupTerminalPathRewriteJob(
      validatedUid,
      document.id,
      remainingStepBudget
    );
    removedSteps += result.removedSteps;
    remainingStepBudget -= result.removedSteps;
    if (result.cleaned) cleanedJobs += 1;
  }
  return {
    cleanedJobs,
    // A full page may hide older terminal documents. Force one empty-page
    // confirmation after every full page so historical backlogs cannot starve.
    hasMore: snapshot.size >= limits.queryLimit || snapshot.size > cleanedJobs,
    removedSteps,
    retryAfterMs
  };
}

export function cleanupRetainedTerminalVaultPathRewriteJobs(uid: string) {
  return cleanupRetainedTerminalVaultPathRewriteJobsPass(uid, {
    jobsPerPass: terminalCleanupJobsPerPass,
    queryLimit: terminalCleanupQueryLimit,
    stepsPerPass: terminalCleanupStepsPerPass
  });
}

/**
 * Drains all terminal rewrite ciphertext in bounded Firestore passes while
 * yielding between passes. Every pass is capped, but a healthy unlocked
 * session converges even for a 5,000-step job. Repeated zero-progress passes
 * fail closed instead of creating an unbounded request loop.
 */
export async function drainTerminalVaultPathRewriteJobs(uid: string) {
  const validatedUid = validateUid(uid);
  let cleanedJobs = 0;
  let removedSteps = 0;
  let noProgressPasses = 0;
  for (;;) {
    const progress = await cleanupRetainedTerminalVaultPathRewriteJobs(validatedUid);
    cleanedJobs += progress.cleanedJobs;
    removedSteps += progress.removedSteps;
    if (!progress.hasMore) return { cleanedJobs, removedSteps };
    if (progress.retryAfterMs > 0 && progress.cleanedJobs === 0 && progress.removedSteps === 0) {
      noProgressPasses = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, progress.retryAfterMs));
      continue;
    }
    if (progress.cleanedJobs === 0 && progress.removedSteps === 0) {
      noProgressPasses += 1;
      if (noProgressPasses >= terminalCleanupNoProgressLimit) {
        throw new VaultPathRewriteJobError(
          "conflict",
          "완료된 경로 재작성 작업 정리가 진행되지 않았습니다."
        );
      }
    } else {
      noProgressPasses = 0;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Starts a fresh cleanup budget for one unlocked Vault session. Callers invoke
 * this once after server-confirmed Vault readiness; repeating normal renders or
 * rewrite completions must not reset the budget.
 */
export function beginTerminalVaultPathRewriteCleanupSession(uid: string) {
  terminalCleanupSessionPasses.set(validateUid(uid), 0);
}

/**
 * Dedupe cleanup pumps per unlocked owner without retaining plaintext. Unlike
 * the explicit drain helper, the automatic path performs at most one small
 * pass per session and leaves a durable, resumable remainder.
 */
export function scheduleTerminalVaultPathRewriteCleanup(uid: string) {
  const validatedUid = validateUid(uid);
  const existing = terminalCleanupPumps.get(validatedUid);
  if (existing) return existing;
  const passes = terminalCleanupSessionPasses.get(validatedUid) ?? 0;
  if (passes >= scheduledTerminalCleanupPassesPerSession) return Promise.resolve();
  terminalCleanupSessionPasses.set(validatedUid, passes + 1);
  const pump = cleanupRetainedTerminalVaultPathRewriteJobsPass(validatedUid, {
    jobsPerPass: scheduledTerminalCleanupJobsPerPass,
    queryLimit: scheduledTerminalCleanupQueryLimit,
    stepsPerPass: scheduledTerminalCleanupStepsPerPass
  })
    .then((progress) => {
      // A readiness-time probe with no terminal root should not consume the
      // session budget. A retained proof or any progress does consume it, so
      // repeated calls cannot create a read/write burst.
      if (
        progress.cleanedJobs === 0
        && progress.removedSteps === 0
        && !progress.hasMore
        && progress.retryAfterMs === 0
      ) {
        const currentPasses = terminalCleanupSessionPasses.get(validatedUid);
        if (currentPasses === passes + 1) {
          terminalCleanupSessionPasses.set(validatedUid, passes);
        }
      }
    })
    .finally(() => {
      if (terminalCleanupPumps.get(validatedUid) === pump) {
        terminalCleanupPumps.delete(validatedUid);
      }
    });
  terminalCleanupPumps.set(validatedUid, pump);
  return pump;
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
      && current.status !== "not-applied"
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

async function abandonUnactivatedAtomicPathRewriteJob(uid: string, jobId: string) {
  const reference = jobRef(uid, jobId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 복구 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, jobId);
    if (
      !atomicActivationMode(current)
      || !preparationRecoveryIsDue(current)
      || current.activatedAt !== undefined
      || current.recoveredAt !== undefined
      || current.completedAt !== undefined
      || current.abandonedAt !== undefined
      || current.cleanupStartedAt !== undefined
      || (
        current.status !== "prepared"
        && !(current.status === "blocked" && current.lastErrorCode === "path-state-conflict")
      )
    ) return current;
    const next: StoredVaultPathRewriteJob = {
      ...current,
      status: "abandoned",
      lastErrorCode: null,
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      abandonedAt: serverTimestamp(),
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return next;
  });
}

/**
 * A historical client could leave a zero-source receipt blocked while
 * rechecking the target path. There is no encrypted source step to apply in
 * this state, so the durable activation receipt is the only safe discriminator:
 * an activated job is complete, while an unactivated job is abandoned without
 * claiming whether a legacy path mutation committed. Neither branch reads or
 * changes the target path or any source content.
 */
async function resolveZeroStepPathRewriteConflict(uid: string, jobId: string) {
  const reference = jobRef(uid, jobId);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 복구 중 삭제되었습니다.");
    }
    const current = validateStoredJob(snapshot.data(), uid, jobId);
    if (
      current.status !== "blocked"
      || current.lastErrorCode !== "path-state-conflict"
      || current.stepCount !== 0
      || current.cursor !== 0
      || current.confirmedCount !== 0
      || current.completedAt !== undefined
      || current.abandonedAt !== undefined
      || current.cleanupStartedAt !== undefined
    ) return current;

    if (current.activatedAt !== undefined) {
      const next: StoredVaultPathRewriteJob = {
        ...current,
        status: "completed",
        lastErrorCode: null,
        revision: current.revision + 1
      };
      transaction.update(reference, {
        status: next.status,
        lastErrorCode: next.lastErrorCode,
        revision: next.revision,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      return next;
    }

    if (current.recoveredAt !== undefined) return current;
    const next: StoredVaultPathRewriteJob = {
      ...current,
      status: "abandoned",
      lastErrorCode: null,
      revision: current.revision + 1
    };
    transaction.update(reference, {
      status: next.status,
      lastErrorCode: next.lastErrorCode,
      revision: next.revision,
      abandonedAt: serverTimestamp(),
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return next;
  });
}

/**
 * Closes the legacy non-atomic gap in the client-only flow. Atomic pr2/pr3
 * mutations commit the target path and `ready` receipt together, so a due job
 * that remains prepared cannot have committed its paired mutation and is
 * abandoned without reading mutable paths. A blocked zero-step receipt is
 * terminalized from activation evidence alone because it has no source work.
 * Other legacy pr1 jobs still require one server-confirmed current-path
 * snapshot: all-new activates, all-old remains inert, and any mixed, missing,
 * or third state stays blocked.
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
  if (!preparationRecoveryIsDue(loaded.stored)) {
    return { recovery: "deferred", job: summary(loaded.stored, jobId, loaded.manifest) };
  }
  if (loaded.stored.status === "preparing") {
    const abandoned = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(loaded.reference);
      if (!snapshot.exists()) {
        throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 복구 중 삭제되었습니다.");
      }
      const current = validateStoredJob(snapshot.data(), uid, jobId);
      if (current.status !== "preparing") return current;
      if (!preparationRecoveryIsDue(current)) return current;
      const next: StoredVaultPathRewriteJob = {
        ...current,
        status: "abandoned",
        lastErrorCode: null,
        revision: current.revision + 1
      };
      transaction.update(loaded.reference, {
        status: next.status,
        lastErrorCode: next.lastErrorCode,
        revision: next.revision,
        abandonedAt: serverTimestamp(),
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      return next;
    });
    if (terminalJob(abandoned)) {
      void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
    }
    return recoveryResult(abandoned, jobId, loaded.manifest);
  }
  if (loaded.stored.status === "abandoned") {
    void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
    return { recovery: "not-applied", job: summary(loaded.stored, jobId, loaded.manifest) };
  }
  if (
    loaded.stored.status === "ready"
    || loaded.stored.status === "running"
    || loaded.stored.status === "completed"
  ) {
    if (loaded.stored.status === "completed") {
      void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
    }
    return { recovery: "activated", job: summary(loaded.stored, jobId, loaded.manifest) };
  }
  if (loaded.stored.status === "blocked" && loaded.stored.lastErrorCode !== "path-state-conflict") {
    return { recovery: "conflict", job: summary(loaded.stored, jobId, loaded.manifest) };
  }
  if (
    loaded.stored.status === "blocked"
    && loaded.stored.lastErrorCode === "path-state-conflict"
    && loaded.stored.stepCount === 0
  ) {
    const resolved = await resolveZeroStepPathRewriteConflict(uid, jobId);
    if (terminalJob(resolved)) {
      void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
    }
    return recoveryResult(resolved, jobId, loaded.manifest);
  }
  if (atomicActivationMode(loaded.stored)) {
    const resolved = await abandonUnactivatedAtomicPathRewriteJob(uid, jobId);
    if (terminalJob(resolved)) {
      void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
    }
    return recoveryResult(resolved, jobId, loaded.manifest);
  }

  // An unavailable or unauthorized direct read is not proof that paths are
  // mixed. Let it reject without changing the durable job so transport retry
  // handling can distinguish an incomplete observation from a complete
  // conflicting one.
  const currentPaths = await input.readCurrentPaths(
    loaded.manifest.pathChanges.map((change) => change.entryId)
  );
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
    if (!preparationRecoveryIsDue(current)) return current;
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
      const recoveryCheckCount = (current.recoveryCheckCount ?? 0) + 1;
      const next: StoredVaultPathRewriteJob = {
        ...current,
        status: "not-applied",
        lastErrorCode: null,
        recoveryCheckCount,
        revision: current.revision + 1
      };
      transaction.update(loaded.reference, {
        status: next.status,
        lastErrorCode: next.lastErrorCode,
        recoveryCheckCount: next.recoveryCheckCount,
        lastRecoveryCheckAt: serverTimestamp(),
        revision: next.revision,
        ...(current.status === "not-applied" ? {} : { notAppliedAt: serverTimestamp() }),
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

  if (terminalJob(transitioned)) {
    void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
  }
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
  if (
    loaded.stored.status === "preparing"
    || loaded.stored.status === "prepared"
    || loaded.stored.status === "not-applied"
    || loaded.stored.status === "abandoned"
  ) {
    throw new VaultPathRewriteJobError("not-ready", "경로 재작성 단계가 아직 모두 준비되지 않았습니다.");
  }
  if (loaded.stored.status === "blocked" && loaded.stored.lastErrorCode === "path-state-conflict") {
    throw new VaultPathRewriteJobError(
      "not-ready",
      "경로 변경 상태가 섞여 있어 source 재작성 전에 복구 확인이 필요합니다."
    );
  }
  if (loaded.stored.status === "completed") {
    void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
    return { ...summary(loaded.stored, jobId, loaded.manifest), processedSteps: 0 };
  }

  let current = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(loaded.reference);
    if (!snapshot.exists()) {
      throw new VaultPathRewriteJobError("conflict", "경로 재작성 작업이 실행 전 삭제되었습니다.");
    }
    const stored = validateStoredJob(snapshot.data(), uid, jobId);
    if (
      stored.status === "preparing"
      || stored.status === "prepared"
      || stored.status === "not-applied"
      || stored.status === "abandoned"
      || stored.status === "completed"
    ) return stored;
    if (
      atomicActivationMode(stored)
      && stored.status === "ready"
      && stored.stepCount === 0
      && stored.cursor === 0
    ) {
      const next: StoredVaultPathRewriteJob = {
        ...stored,
        status: "completed",
        revision: stored.revision + 1
      };
      transaction.update(loaded.reference, {
        status: next.status,
        revision: next.revision,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      return next;
    }
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
      sourceSnapshot = await readRewriteSourceWithRetry(input.readSource, step.sourceEntryId);
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
      let stepBlocked = false;
      let retryableApplyFailureExhausted = false;
      for (let applyAttempt = 1; applyAttempt <= maxTransientApplyAttempts; applyAttempt += 1) {
        let applyFailed = false;
        let applyFailure: unknown;
        try {
          await input.applyStep(step, sourceSnapshot);
        } catch (cause) {
          applyFailed = true;
          applyFailure = cause;
        }
        // Always re-read after an apply attempt. If the encrypted write
        // committed but its response was lost, the exact rewritten digest and
        // revision are durable proof and applying it a second time is avoided.
        try {
          sourceSnapshot = await readRewriteSourceWithRetry(input.readSource, step.sourceEntryId);
        } catch {
          current = await markBlocked(uid, jobId, ordinal, "write-failed");
          stepBlocked = true;
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
          stepBlocked = true;
          break;
        }
        try {
          sourceState = await classifyVaultPathRewriteSourceState(step, sourceSnapshot);
        } catch {
          current = await markBlocked(uid, jobId, ordinal, "content-conflict");
          stepBlocked = true;
          break;
        }
        const retryableApplyFailure = applyFailed && retryableAdapterWriteFailure(applyFailure);
        if (
          sourceState.state === "pending"
          && retryableApplyFailure
          && applyAttempt === maxTransientApplyAttempts
        ) {
          retryableApplyFailureExhausted = true;
        }
        if (
          sourceState.state !== "pending"
          || !applyFailed
          || !retryableApplyFailure
          || applyAttempt === maxTransientApplyAttempts
        ) break;
      }
      if (stepBlocked) break;
      if (sourceState.state === "pending" && retryableApplyFailureExhausted) {
        current = await markBlocked(uid, jobId, ordinal, "write-failed");
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

  if (current.status === "completed") {
    void scheduleTerminalVaultPathRewriteCleanup(uid).catch(() => undefined);
  }
  return { ...summary(current, jobId, loaded.manifest), processedSteps };
}
