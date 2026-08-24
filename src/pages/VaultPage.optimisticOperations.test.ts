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

  it("automatically converges atomic path receipts but leaves other semantic conflicts manual", () => {
    expect(source).toContain("eligibleJobs.filter(shouldAutomaticallyRecoverVaultPathRewriteJob)");
    expect(source).toContain("중단된 내부 참조 작업은 현재 원본을 보존하고 직접 재확인을 기다립니다.");
    expect(source).toContain("if (job.status === \"blocked\")");
    expect(source).toContain("복구 알림에서 현재 서버 상태를 직접 재확인할 수 있습니다.");
    expect(source).toContain("if (job.stepCount > 0)");
    expect(source).toContain("automaticJobs.some((job) => job.stepCount > 0)");
  });

  it("commits a dirty path target once instead of pre-saving another history revision", () => {
    expect(source).not.toContain("flushPathTargetBody");
    expect(source.match(/const planningEntries = resolvingNameCollision/g)).toHaveLength(2);
    expect(source).toContain("entries: planningEntries");
    expect(source).toContain("content: refreshedDraft.body, revision: refreshedDraft.baseRevision");
  });

  it("reconciles a response-lost autosave without forcing the server revision backwards", () => {
    expect(source).toContain("ambiguousEntrySaveAttemptsRef");
    expect(source).toContain("findConfirmedDraftSubmission");
    expect(source).toContain("remote = await readCurrentServerVaultEntry(entryId)");
    expect(source).toContain("result = await saveEncryptedVaultEntry(\n            note,");
  });

  it("reconciles response-lost rename and move commits from a bounded server read", () => {
    expect(source.match(/let pathMutationLocallyConfirmed = false/g)).toHaveLength(2);
    expect(source).toContain("commitMovedTarget({");
    expect(source).toContain("commitRenamedTarget({");
    expect(source).toContain("서버에서 완료된 이동 결과의 revision과 암호화 payload");
    expect(source).toContain("서버에서 완료된 이름 변경 결과의 revision과 암호화 payload");
  });

  it("never lets a late save, move, or rename response roll back a newer subscription", () => {
    expect(source.match(/latestBeforeCommit && latestBeforeCommit\.baseRevision > result\.revision/g)).toHaveLength(3);
    expect(source.match(/if \(revisionRelation !== "apply"\) return candidate;/g)).toHaveLength(3);
    expect(source.match(/let pathMutationSupersededRevision: number \| null = null;/g)).toHaveLength(2);
    expect(source.match(/if \(latest\?\.baseRevision === result\.revision\)/g)).toHaveLength(2);
    expect(source.match(/pathMutationSupersededHasConflict = true;/g)).toHaveLength(4);
  });

  it("commits rename drafts with the same NFC title that is encrypted", () => {
    expect(source).toContain("canonicalizeDraftTitle(captureRevisionedDraft(draft))");
    expect(source).toContain("const canonicalRewritten = canonicalizeDraftTitle(rewrittenDraft);");
    expect(source).toContain("?.trim()\n      .normalize(\"NFC\")");
  });
});
