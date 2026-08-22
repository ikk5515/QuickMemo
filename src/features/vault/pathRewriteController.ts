import type { PreparedVaultPathRewriteJob } from "./pathRewriteJob";
import type {
  RecoverPreparedVaultPathRewriteJobResult,
  ResumeVaultPathRewriteJobResult,
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
  for (const entryId of entryIds) {
    await input.waitForMutation(entryId);
    await input.save(entryId);
  }
  return entryIds.filter((entryId) => input.isDirty(entryId));
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
      next = await resume();
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
  commitPathMutation: () => Promise<void>;
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

  try {
    await input.commitPathMutation();
  } catch (cause) {
    throw new VaultPathRewriteControllerError(
      "prepared",
      "경로 변경을 저장하지 못해 준비된 참조 갱신 작업을 실행하지 않았습니다.",
      { cause, job: preparedSummary }
    );
  }
  input.onStage?.("path-committed", preparedSummary);

  let activated: VaultPathRewriteJobSummary;
  try {
    activated = await input.activate();
  } catch (cause) {
    throw new VaultPathRewriteControllerError(
      "path-committed",
      "경로는 변경했지만 참조 갱신 활성화를 확인하지 못했습니다. 다시 열면 안전하게 복구합니다.",
      { cause, job: preparedSummary }
    );
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
  if (current.status === "preparing") {
    throw new VaultPathRewriteControllerError(
      "preparing",
      "참조 갱신 준비가 완료되지 않았습니다.",
      { job: current }
    );
  }
  if (current.status === "prepared" || current.lastErrorCode === "path-state-conflict") {
    const recovered = await input.recoverPrepared();
    current = recovered.job;
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
