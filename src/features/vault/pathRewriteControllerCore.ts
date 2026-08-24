import type { VaultPathRewriteJobSummary } from "../../services/vaultPathRewriteJobs";

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
 * Removes only the exact blocked notice observed before a server recovery scan
 * when that job is no longer recoverable. Terminal jobs are intentionally
 * absent from the scan; a stale generation or a different concurrently shown
 * job must remain untouched.
 */
export function reconcileVaultPathRewriteJobAfterRecoveryScan(input: {
  continuationIsCurrent: boolean;
  current: VaultPathRewriteJobSummary | null;
  observedBlockedJobId: string | null;
  observedBlockedRevision: number | null;
  scanComplete: boolean;
  scannedJobs: readonly VaultPathRewriteJobSummary[];
}) {
  if (
    !input.continuationIsCurrent
    || !input.scanComplete
    || input.observedBlockedJobId === null
    || input.observedBlockedRevision === null
    || input.current?.status !== "blocked"
    || input.current.jobId !== input.observedBlockedJobId
    || input.current.revision !== input.observedBlockedRevision
    || input.scannedJobs.some((job) => job.jobId === input.observedBlockedJobId)
  ) return input.current;
  return null;
}

/**
 * Preparing/prepared/not-applied jobs never rewrite content unless the paired
 * path mutation is confirmed. Atomic receipt status is authoritative; legacy
 * jobs require a read-first path-state check. Atomic path-state conflicts are
 * stale receipts that can be resolved without reading or changing source
 * content. A legacy zero-step conflict is equally safe to settle because it
 * contains no source rewrite work. Other semantic conflicts require an
 * explicit user retry from the recovery notice.
 * A write-failed job is safe to retry once per fresh recovery scan because every
 * source is re-read and digest-checked first.
 */
export function shouldAutomaticallyRecoverVaultPathRewriteJob(job: VaultPathRewriteJobSummary) {
  const safelyResolvablePathConflict = job.status === "blocked"
    && job.lastErrorCode === "path-state-conflict"
    && (
      job.stepCount === 0
      || job.jobId.startsWith("pr2_")
      || job.jobId.startsWith("pr3_")
    );
  return job.status === "preparing"
    || job.status === "prepared"
    || job.status === "not-applied"
    || job.status === "ready"
    || job.status === "running"
    || safelyResolvablePathConflict
    || (job.status === "blocked" && job.lastErrorCode === "write-failed");
}
