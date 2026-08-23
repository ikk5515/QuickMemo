import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VaultPathRewriteJobSummary } from "../../services/vaultPathRewriteJobs";
import { VaultPathRewriteRecoveryNotice } from "./VaultPathRewriteRecoveryNotice";

function blockedJob(
  lastErrorCode: VaultPathRewriteJobSummary["lastErrorCode"]
): VaultPathRewriteJobSummary {
  return {
    attemptCount: 2,
    confirmedCount: 3,
    cursor: 3,
    jobId: "pr1_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    lastErrorCode,
    manifest: { ownerUid: "owner", pathChanges: [], steps: [], version: 1 },
    retryCount: 1,
    revision: 4,
    status: "blocked",
    stepCount: 7
  };
}

describe("VaultPathRewriteRecoveryNotice", () => {
  it("offers only a revision-aware server recheck for a path-state conflict", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <VaultPathRewriteRecoveryNotice
        busy={false}
        job={blockedJob("path-state-conflict")}
        online
        ready
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole("alert", { name: "내부 참조 갱신 충돌" })).toHaveAttribute(
      "data-error-code",
      "path-state-conflict"
    );
    expect(screen.getByText("3/7개 확인됨 · 재확인 1회")).toBeInTheDocument();
    expect(screen.getByText(/원본 참조를 수정하지 않았습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /취소|건너뛰기|완료/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "경로 상태 다시 대조" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not expose an unsafe retry or destructive clear for a corrupt job", () => {
    render(
      <VaultPathRewriteRecoveryNotice
        busy={false}
        job={blockedJob("job-corrupt")}
        online
        ready
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText(/원본 파일은 변경하지 않으며/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps recovery disabled until the online server snapshot is ready", () => {
    const { rerender } = render(
      <VaultPathRewriteRecoveryNotice
        busy={false}
        job={blockedJob("write-failed")}
        online={false}
        ready={false}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "안전하게 다시 시도" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("온라인 연결 후");

    rerender(
      <VaultPathRewriteRecoveryNotice
        busy
        job={blockedJob("write-failed")}
        online
        ready
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "확인 중…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "true");
  });
});
