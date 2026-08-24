import { describe, expect, it, vi } from "vitest";
import {
  automaticVaultPathRewriteRetryDelayMs,
  executeVaultPathRewrite,
  flushVaultDraftsBeforePathRewriteRecovery,
  recoverVaultPathRewrite,
  retryableVaultPathRewriteFailure,
  resumeVaultPathRewriteToCompletion,
  shouldAutomaticallyRecoverVaultPathRewriteJob,
  vaultPathRewriteRecoveryContinuationIsCurrent,
  VaultPathRewriteControllerError
} from "./pathRewriteController";
import type { PreparedVaultPathRewriteJob } from "./pathRewriteJob";
import type { VaultPathRewriteJobSummary } from "../../services/vaultPathRewriteJobs";

function summary(
  status: VaultPathRewriteJobSummary["status"],
  overrides: Partial<VaultPathRewriteJobSummary> = {}
): VaultPathRewriteJobSummary {
  return {
    attemptCount: 0,
    confirmedCount: status === "completed" ? 1 : 0,
    cursor: status === "completed" ? 1 : 0,
    jobId: "pr1_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    lastErrorCode: null,
    manifest: { ownerUid: "owner", pathChanges: [], steps: [], version: 1 },
    retryCount: 0,
    revision: 1,
    status,
    stepCount: 1,
    ...overrides
  };
}

const prepared = { jobId: summary("prepared").jobId } as PreparedVaultPathRewriteJob;

describe("path rewrite controller", () => {
  it("rejects cancelled and stale access-scope recovery continuations", () => {
    expect(vaultPathRewriteRecoveryContinuationIsCurrent({
      cancelled: false,
      currentGeneration: 7,
      generation: 7
    })).toBe(true);
    expect(vaultPathRewriteRecoveryContinuationIsCurrent({
      cancelled: true,
      currentGeneration: 7,
      generation: 7
    })).toBe(false);
    expect(vaultPathRewriteRecoveryContinuationIsCurrent({
      cancelled: false,
      currentGeneration: 8,
      generation: 7
    })).toBe(false);
  });

  it("flushes the captured dirty drafts before recovery and reports every draft still dirty", async () => {
    const events: string[] = [];
    const dirty = new Set(["note-a", "note-b"]);

    await expect(flushVaultDraftsBeforePathRewriteRecovery({
      dirtyEntryIds: ["note-a", "note-b", "note-a"],
      isDirty: (entryId) => dirty.has(entryId),
      save: async (entryId) => {
        events.push(`save:${entryId}`);
        if (entryId === "note-a") dirty.delete(entryId);
      },
      waitForMutation: async (entryId) => { events.push(`wait:${entryId}`); }
    })).resolves.toEqual(["note-b"]);

    expect(events).toEqual(expect.arrayContaining([
      "wait:note-a", "save:note-a", "wait:note-b", "save:note-b"
    ]));
  });

  it("flushes independent drafts concurrently and contains an individual save failure", async () => {
    const dirty = new Set(["note-a", "note-b", "note-c"]);
    let active = 0;
    let maximumActive = 0;

    await expect(flushVaultDraftsBeforePathRewriteRecovery({
      dirtyEntryIds: [...dirty],
      isDirty: (entryId) => dirty.has(entryId),
      save: async (entryId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        if (entryId === "note-b") throw new Error("offline");
        dirty.delete(entryId);
      },
      waitForMutation: () => undefined
    })).resolves.toEqual(["note-b"]);

    expect(maximumActive).toBeGreaterThan(1);
  });

  it("automatically retries only transport-safe failures and resumable job states", () => {
    expect(retryableVaultPathRewriteFailure({ code: "firestore/unavailable" })).toBe(true);
    expect(retryableVaultPathRewriteFailure({ code: "network_error" })).toBe(true);
    expect(retryableVaultPathRewriteFailure({ code: "network_timeout" })).toBe(true);
    expect(retryableVaultPathRewriteFailure({ code: "permission-denied" })).toBe(false);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("preparing"))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("prepared"))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("not-applied"))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("running"))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("blocked", {
      lastErrorCode: "write-failed"
    }))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("blocked", {
      jobId: `pr3_${"A".repeat(43)}`,
      lastErrorCode: "path-state-conflict"
    }))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("blocked", {
      lastErrorCode: "path-state-conflict",
      stepCount: 0
    }))).toBe(true);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("blocked", {
      lastErrorCode: "path-state-conflict"
    }))).toBe(false);
    expect(shouldAutomaticallyRecoverVaultPathRewriteJob(summary("blocked", {
      lastErrorCode: "revision-conflict"
    }))).toBe(false);
    expect(automaticVaultPathRewriteRetryDelayMs(1)).toBe(1_000);
    expect(automaticVaultPathRewriteRetryDelayMs(5)).toBe(16_000);
    expect(automaticVaultPathRewriteRetryDelayMs(6)).toBeNull();
  });

  it("never commits a path before every encrypted step is prepared", async () => {
    const calls: string[] = [];
    await executeVaultPathRewrite({
      activate: async () => {
        calls.push("activate");
        return summary("completed");
      },
      commitPathMutation: async () => { calls.push("commit"); },
      ensurePrepared: async () => {
        calls.push("ensure");
        return summary("prepared");
      },
      prepared,
      resume: vi.fn()
    });
    expect(calls).toEqual(["ensure", "commit", "activate"]);
  });

  it("reports path-committed activation failures for reload recovery", async () => {
    await expect(executeVaultPathRewrite({
      activate: async () => { throw new Error("offline"); },
      commitPathMutation: async () => undefined,
      ensurePrepared: async () => summary("prepared"),
      prepared,
      resume: vi.fn()
    })).rejects.toMatchObject({ stage: "path-committed" });
  });

  it("continues immediately when an atomic commit succeeded but its HTTP response was lost", async () => {
    const activate = vi.fn(async () => summary("ready"));
    const resume = vi.fn(async () => ({ ...summary("completed"), processedSteps: 1 }));
    await expect(executeVaultPathRewrite({
      activate,
      commitPathMutation: async () => { throw new Error("response lost"); },
      ensurePrepared: async () => summary("prepared"),
      prepared,
      resume
    })).resolves.toMatchObject({ status: "completed" });
    expect(activate).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("uses a zero-step ready receipt to disambiguate a lost mutation response", async () => {
    const ready = summary("ready", { stepCount: 0 });
    const completed = summary("completed", {
      confirmedCount: 0,
      cursor: 0,
      stepCount: 0
    });
    const resume = vi.fn(async () => ({ ...completed, processedSteps: 0 }));
    await expect(executeVaultPathRewrite({
      activate: async () => ready,
      commitPathMutation: async () => { throw new Error("response lost"); },
      ensurePrepared: async () => summary("prepared", { stepCount: 0 }),
      prepared,
      resume
    })).resolves.toMatchObject({ status: "completed", stepCount: 0 });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not mask a genuine path commit failure while the job is still prepared", async () => {
    await expect(executeVaultPathRewrite({
      activate: async () => { throw new Error("atomic job remains prepared"); },
      commitPathMutation: async () => { throw new Error("revision conflict"); },
      ensurePrepared: async () => summary("prepared"),
      prepared,
      resume: vi.fn()
    })).rejects.toMatchObject({ stage: "prepared" });
  });

  it("requires cursor progress and a confirmed completed status", async () => {
    await expect(resumeVaultPathRewriteToCompletion({
      initial: summary("ready"),
      resume: async () => ({ ...summary("running"), processedSteps: 0 })
    })).rejects.toBeInstanceOf(VaultPathRewriteControllerError);
  });

  it("retries a transient resume failure without replaying semantic failures", async () => {
    const transientResume = vi.fn()
      .mockRejectedValueOnce({ code: "firestore/unavailable" })
      .mockResolvedValueOnce({ ...summary("completed"), processedSteps: 1 });
    await expect(resumeVaultPathRewriteToCompletion({
      initial: summary("ready"),
      resume: transientResume
    })).resolves.toMatchObject({ status: "completed" });
    expect(transientResume).toHaveBeenCalledTimes(2);

    const deniedResume = vi.fn().mockRejectedValue({ code: "permission-denied" });
    await expect(resumeVaultPathRewriteToCompletion({
      initial: summary("ready"),
      resume: deniedResume
    })).rejects.toBeInstanceOf(VaultPathRewriteControllerError);
    expect(deniedResume).toHaveBeenCalledOnce();
  });

  it("recovers a prepared activation gap before resuming", async () => {
    const resume = vi.fn(async () => ({ ...summary("completed"), processedSteps: 1 }));
    await expect(recoverVaultPathRewrite({
      job: summary("prepared"),
      recoverPrepared: async () => ({ recovery: "activated", job: summary("ready") }),
      resume
    })).resolves.toMatchObject({ outcome: "completed" });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("leaves a prepared job inert when server paths are still old", async () => {
    const job = summary("prepared");
    await expect(recoverVaultPathRewrite({
      job,
      recoverPrepared: async () => ({ recovery: "not-applied", job }),
      resume: vi.fn()
    })).resolves.toEqual({ outcome: "not-applied", job });
  });

  it("defers a fresh atomic job without starting any rewrite step", async () => {
    const job = { ...summary("prepared"), recoveryAfterMs: 120_000 };
    const resume = vi.fn();
    await expect(recoverVaultPathRewrite({
      job,
      recoverPrepared: async () => ({ recovery: "deferred", job }),
      resume
    })).resolves.toEqual({ outcome: "deferred", job });
    expect(resume).not.toHaveBeenCalled();
  });

  it("lets recovery abandon an interrupted atomic preparing job", async () => {
    const abandoned = summary("abandoned");
    const recoverPrepared = vi.fn(async () => ({
      recovery: "not-applied" as const,
      job: abandoned
    }));
    await expect(recoverVaultPathRewrite({
      job: summary("preparing"),
      recoverPrepared,
      resume: vi.fn()
    })).resolves.toEqual({ outcome: "not-applied", job: abandoned });
    expect(recoverPrepared).toHaveBeenCalledOnce();
  });
});
