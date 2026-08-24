import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");

describe("Vault entry mutation responsiveness", () => {
  it("keeps canonical encrypted entries separate from the optimistic explorer projection", () => {
    expect(source).toContain("projectOptimisticVaultEntries(notes, optimisticEntryPatches)");
    expect(source).toContain("notes={optimisticFileTreeNotes}");
    expect(source).toContain("stageOptimisticEntryPatch(entryId, { folderId })");
    expect(source).toContain("stageOptimisticEntryPatch(entryId, { hidden: true })");
    expect(source).toContain("finishOptimisticEntryPatch(entryId, optimisticOperationId)");
    expect(source).not.toContain("notesRef.current = optimisticFileTreeNotes");
  });

  it("does not automatically replay durable semantic conflicts on every unlock", () => {
    expect(source).toContain("eligibleJobs.filter(shouldAutomaticallyRecoverVaultPathRewriteJob)");
    expect(source).toContain("중단된 내부 참조 작업은 현재 원본을 보존하고 직접 재확인을 기다립니다.");
    expect(source).toContain("if (job.status === \"blocked\")");
    expect(source).toContain("복구 알림에서 현재 서버 상태를 직접 재확인할 수 있습니다.");
  });
});
