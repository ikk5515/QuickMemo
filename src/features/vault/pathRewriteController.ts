import type { PreparedVaultPathRewriteJob } from "./pathRewriteJob";
import type {
  RecoverPreparedVaultPathRewriteJobResult,
  ResumeVaultPathRewriteJobResult,
  VaultPathRewriteActivationInput,
  VaultPathRewriteJobSummary
} from "../../services/vaultPathRewriteJobs";

export type VaultPathRewriteStage =
  | "preparing"
  | "prepared"
  | "path-committed"
  | "resuming"
  | "completed"
  | "blocked";

export class VaultPathRewriteControllerError extends Error {
  readonly stage: VaultPathRewriteStage;
  readonly job?: VaultPathRewriteJobSummary;

  constructor(
    stage: VaultPathRewriteStage,
    message: string,
    options?: { cause?: unknown; job?: VaultPathRewriteJobSummary }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VaultPathRewriteControllerError";
    this.stage = stage;
    this.job = options?.job;
  }
}

interface ResumeToCompletionInput {
  initial: VaultPathRewriteJobSummary;
  resume: () => Promise<ResumeVaultPathRewriteJobResult>;
  onStage?: (stage: VaultPathRewriteStage, job: VaultPathRewriteJobSummary) => void;
}

const maximumDraftFlushConcurrency = 4;
const maximumTransientResumeAttempts = 3;
const maximumAutomaticRecoveryBackoffAttempts = 5;

function errorCode(cause: unknown) {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return "";
  return String(cause.code).replace(/^firestore\//u, "");
}

/**
 * Firestore transactions and direct-server reads are idempotent in the path
 * rewrite service. Retry only transport/lease failures here; semantic,
 * authorization, integrity, and revision failures remain fail-closed.
 */
export function retryableVaultPathRewriteFailure(cause: unknown) {
  const code = errorCode(cause);
  return cause instanceof TypeError
    || code === "aborted"
    || code === "cancelled"
    || code === "deadline-exceeded"
    || code === "network-request-failed"
    || code === "network_error"
    || code === "network_timeout"
    || code === "unavailable";
}

/**
 * A foreground recovery loop may retry transport and draft-flush failures,
 * but it must converge instead of polling forever on a permanent outage.
 */
export function automaticVaultPathRewriteRetryDelayMs(failureCount: number) {
  if (
    !Number.isSafeInteger(failureCount)
    || failureCount < 1
    || failureCount > maximumAutomaticRecoveryBackoffAttempts
  ) return null;
  return 1_000 * (2 ** (failureCount - 1));
}

/**
 * Guards every async recovery continuation against both effect cleanup and a
 * Vault access-scope change. The caller owns the monotonic generation counter;
 * this helper keeps the fail-closed predicate identical at each await boundary.
 */
export function vaultPathRewriteRecoveryContinuationIsCurrent(input: {
  cancelled: boolean;
  currentGeneration: number;
  generation: number;
}) {
  return !input.cancelled && input.generation === input.currentGeneration;
}

/**
 * Preparing/prepared/not-applied jobs never rewrite content unless the paired
 * path mutation is confirmed. Atomic receipt status is authoritative; legacy
 * jobs require a read-first path-state check. Atomic path-state conflicts are
 * stale receipts that can be abandoned without reading or changing source
 * content, so they converge automatically. Other semantic conflicts require
 * an explicit user retry from the recovery notice.
 * A write-failed job is safe to retry once per fresh recovery scan because every
 * source is re-read and digest-checked first.
 */
export function shouldAutomaticallyRecoverVaultPathRewriteJob(job: VaultPathRewriteJobSummary) {
  const atomicPathConflict = job.status === "blocked"
    && job.lastErrorCode === "path-state-conflict"
    && (job.jobId.startsWith("pr2_") || job.jobId.startsWith("pr3_"));
  return job.status === "preparing"
    || job.status === "prepared"
    || job.status === "not-applied"
    || job.status === "ready"
    || job.status === "running"
    || atomicPathConflict
    || (job.status === "blocked" && job.lastErrorCode === "write-failed");
}

/**
 * Saves the exact dirty set captured after the caller has acquired the Vault
 * path lock. A recovery caller must stop when this returns any entry id: a
 * durable rewrite may never run underneath an unconfirmed in-memory draft.
 */
export async function flushVaultDraftsBeforePathRewriteRecovery(input: {
  dirtyEntryIds: readonly string[];
  isDirty: (entryId: string) => boolean;
  save: (entryId: string) => Promise<void>;
  waitForMutation: (entryId: string) => Promise<void> | undefined;
}) {
  const entryIds = Array.from(new Set(input.dirtyEntryIds));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < entryIds.length) {
      const entryId = entryIds[nextIndex];
      nextIndex += 1;
      try {
        await input.waitForMutation(entryId);
        await input.save(entryId);
      } catch {
        // Recovery must inspect every captured draft and return the still-dirty
        // set. One failed save must not hide independently saveable drafts or
        // collapse into a generic maintenance error.
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(maximumDraftFlushConcurrency, entryIds.length) },
    worker
  ));
  return entryIds.filter((entryId) => input.isDirty(entryId));
}

async function resumeWithTransientRetry(resume: ResumeToCompletionInput["resume"]) {
  let lastCause: unknown;
  for (let attempt = 1; attempt <= maximumTransientResumeAttempts; attempt += 1) {
    try {
      return await resume();
    } catch (cause) {
      lastCause = cause;
      if (attempt === maximumTransientResumeAttempts || !retryableVaultPathRewriteFailure(cause)) {
        throw cause;
      }
      // Yield before an idempotent retry so Firebase can settle an aborted
      // transaction without adding a user-visible backoff delay.
      await Promise.resolve();
    }
  }
  throw lastCause;
}

/**
 * Repeats only a bounded service call. Each service invocation owns its own
 * cursor transaction and processes at most the adapter's configured step
 * limit. The controller refuses to report success until the durable cursor is
 * confirmed at `completed`.
 */
export async function resumeVaultPathRewriteToCompletion({
  initial,
  resume,
  onStage
}: ResumeToCompletionInput): Promise<VaultPathRewriteJobSummary> {
  let current = initial;
  if (current.status === "completed") {
    onStage?.("completed", current);
    return current;
  }

  const maximumBatches = Math.max(1, current.stepCount + 1);
  for (let batch = 0; batch < maximumBatches; batch += 1) {
    onStage?.("resuming", current);
    let next: ResumeVaultPathRewriteJobResult;
    try {
      next = await resumeWithTransientRetry(resume);
    } catch (cause) {
      throw new VaultPathRewriteControllerError(
        "blocked",
        "내부 참조 갱신을 재개하지 못했습니다.",
        { cause, job: current }
      );
    }
    current = next;
    if (current.status === "completed") {
      onStage?.("completed", current);
      return current;
    }
    if (current.status === "blocked") {
      onStage?.("blocked", current);
      throw new VaultPathRewriteControllerError(
        "blocked",
        "내부 참조 갱신이 충돌로 중단되었습니다.",
        { job: current }
      );
    }
    if (next.processedSteps < 1) {
      throw new VaultPathRewriteControllerError(
        "blocked",
        "내부 참조 갱신 cursor가 진행되지 않아 중단했습니다.",
        { job: current }
      );
    }
  }

  throw new VaultPathRewriteControllerError(
    "blocked",
    "내부 참조 갱신이 안전한 실행 한도를 초과했습니다.",
    { job: current }
  );
}

export async function executeVaultPathRewrite(input: {
  prepared: PreparedVaultPathRewriteJob;
  ensurePrepared: () => Promise<VaultPathRewriteJobSummary>;
  commitPathMutation: (activation: VaultPathRewriteActivationInput) => Promise<void>;
  activate: () => Promise<VaultPathRewriteJobSummary>;
  resume: () => Promise<ResumeVaultPathRewriteJobResult>;
  onStage?: (stage: VaultPathRewriteStage, job?: VaultPathRewriteJobSummary) => void;
}) {
  input.onStage?.("preparing");
  let preparedSummary: VaultPathRewriteJobSummary;
  try {
    preparedSummary = await input.ensurePrepared();
  } catch (cause) {
    throw new VaultPathRewriteControllerError(
      "preparing",
      "암호화된 내부 참조 갱신 작업을 준비하지 못했습니다.",
      { cause }
    );
  }
  if (preparedSummary.status !== "prepared") {
    throw new VaultPathRewriteControllerError(
      "preparing",
      "내부 참조 갱신 작업이 준비 상태와 일치하지 않습니다.",
      { job: preparedSummary }
    );
  }
  input.onStage?.("prepared", preparedSummary);

  let activated: VaultPathRewriteJobSummary | null = null;
  try {
    await input.commitPathMutation({
      expectedRevision: preparedSummary.revision,
      jobId: preparedSummary.jobId
    });
  } catch (cause) {
    // The Firestore transaction may have committed even when its HTTP response
    // was lost. A ready/running/completed atomic job is durable proof that the
    // paired path write committed; a still-prepared job makes `activate` fail
    // closed and preserves the original mutation error.
    try {
      const confirmed = await input.activate();
      if (
        confirmed.status !== "ready"
        && confirmed.status !== "running"
        && confirmed.status !== "completed"
      ) {
        throw new Error("Path rewrite activation did not confirm the path transaction");
      }
      activated = confirmed;
    } catch {
      throw new VaultPathRewriteControllerError(
        "prepared",
        "경로 변경을 저장하지 못해 준비된 참조 갱신 작업을 실행하지 않았습니다.",
        { cause, job: preparedSummary }
      );
    }
  }
  input.onStage?.("path-committed", preparedSummary);

  if (!activated) {
    try {
      activated = await input.activate();
    } catch (cause) {
      throw new VaultPathRewriteControllerError(
        "path-committed",
        "경로는 변경했지만 참조 갱신 활성화를 확인하지 못했습니다. 다시 열면 안전하게 복구합니다.",
        { cause, job: preparedSummary }
      );
    }
  }

  return resumeVaultPathRewriteToCompletion({
    initial: activated,
    resume: input.resume,
    onStage: (stage, job) => input.onStage?.(stage, job)
  });
}

export async function recoverVaultPathRewrite(input: {
  job: VaultPathRewriteJobSummary;
  recoverPrepared: () => Promise<RecoverPreparedVaultPathRewriteJobResult>;
  resume: () => Promise<ResumeVaultPathRewriteJobResult>;
  onStage?: (stage: VaultPathRewriteStage, job: VaultPathRewriteJobSummary) => void;
}) {
  let current = input.job;
  if (
    current.status === "preparing"
    || current.status === "prepared"
    || current.status === "not-applied"
    || current.lastErrorCode === "path-state-conflict"
  ) {
    const recovered = await input.recoverPrepared();
    current = recovered.job;
    if (recovered.recovery === "deferred") {
      return { outcome: "deferred" as const, job: current };
    }
    if (recovered.recovery === "not-applied") {
      return { outcome: "not-applied" as const, job: current };
    }
    if (recovered.recovery === "conflict") {
      input.onStage?.("blocked", current);
      throw new VaultPathRewriteControllerError(
        "blocked",
        "저장된 경로 상태가 섞여 있어 참조 갱신을 자동 재개하지 않았습니다.",
        { job: current }
      );
    }
  }

  const completed = await resumeVaultPathRewriteToCompletion({
    initial: current,
    resume: input.resume,
    onStage: input.onStage
  });
  return { outcome: "completed" as const, job: completed };
}
