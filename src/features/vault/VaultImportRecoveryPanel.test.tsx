import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VaultImportJobSummary } from "../../services/vaultImportJobs";
import { VaultImportRecoveryPanel } from "./VaultImportRecoveryPanel";

function job(overrides: Partial<VaultImportJobSummary> = {}): VaultImportJobSummary {
  return {
    jobId: "vi1_recovery_job",
    status: "staging",
    itemCount: 5,
    entryCount: 3,
    folderCount: 2,
    rootFolderCount: 1,
    chunkCount: 1,
    remainingChunkCount: 1,
    revision: 2,
    lastErrorCode: null,
    manifest: null,
    ...overrides
  };
}

describe("VaultImportRecoveryPanel", () => {
  it("separates uncertain staging from an explicit rollback decision", () => {
    const onRollback = vi.fn();
    const onRecheck = vi.fn();
    render(
      <VaultImportRecoveryPanel
        jobs={[job()]}
        onClose={vi.fn()}
        onRecheck={onRecheck}
        onRollback={onRollback}
      />
    );

    expect(screen.getByText("항목 저장 여부 확인 필요", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("다른 탭에서 아직 실행 중인지 확인한 뒤 롤백을 선택하세요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "서버 상태 다시 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "생성분 안전 롤백" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onRollback).toHaveBeenCalledWith(expect.objectContaining({ jobId: "vi1_recovery_job" }));
  });

  it("fails closed when the encrypted recovery job is corrupt", () => {
    render(
      <VaultImportRecoveryPanel
        jobs={[job({ status: "blocked", lastErrorCode: "job-corrupt" })]}
        onClose={vi.fn()}
        onRecheck={vi.fn()}
        onRollback={vi.fn()}
      />
    );

    expect(screen.getByText("복구 정보의 무결성을 확인할 수 없어 자동 작업을 차단했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "생성분 안전 롤백" })).not.toBeInTheDocument();
  });

  it("keeps controls disabled while one recovery is running", () => {
    render(
      <VaultImportRecoveryPanel
        busyJobId="vi1_recovery_job"
        jobs={[job()]}
        onClose={vi.fn()}
        onRecheck={vi.fn()}
        onRollback={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "안전 롤백 확인 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "서버 상태 다시 확인" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ZIP 가져오기 복구 패널 닫기" })).toBeDisabled();
  });

  it("moves keyboard focus into the panel and supports an Escape close", () => {
    const onClose = vi.fn();
    render(
      <VaultImportRecoveryPanel
        jobs={[job()]}
        onClose={onClose}
        onRecheck={vi.fn()}
        onRollback={vi.fn()}
      />
    );

    const panel = screen.getByRole("region", { name: "ZIP 가져오기 복구" });
    expect(panel).toHaveFocus();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
