import { describe, expect, it, vi } from "vitest";
import {
  executeVaultPathRewrite,
  flushVaultDraftsBeforePathRewriteRecovery,
  recoverVaultPathRewrite,
  resumeVaultPathRewriteToCompletion,
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

    expect(events).toEqual(["wait:note-a", "save:note-a", "wait:note-b", "save:note-b"]);
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

  it("requires cursor progress and a confirmed completed status", async () => {
    await expect(resumeVaultPathRewriteToCompletion({
      initial: summary("ready"),
      resume: async () => ({ ...summary("running"), processedSteps: 0 })
    })).rejects.toBeInstanceOf(VaultPathRewriteControllerError);
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
});
