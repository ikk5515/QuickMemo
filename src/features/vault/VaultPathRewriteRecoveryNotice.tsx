import type {
  VaultPathRewriteJobSummary,
  VaultPathRewriteSafeErrorCode
} from "../../services/vaultPathRewriteJobs";

interface VaultPathRewriteRecoveryCopy {
  actionLabel: string | null;
  description: string;
  title: string;
}

const recoveryCopyByErrorCode: Record<VaultPathRewriteSafeErrorCode, VaultPathRewriteRecoveryCopy> = {
  "content-conflict": {
    actionLabel: "현재 원본 다시 확인",
    description: "원본의 종류나 내용이 계획 이후 바뀌었습니다. 현재 편집본은 자동으로 합치거나 덮어쓰지 않습니다. 다른 탭의 저장이 끝났다면 서버 원본을 다시 대조할 수 있습니다.",
    title: "내부 참조 원본 충돌"
  },
  "job-corrupt": {
    actionLabel: null,
    description: "암호화된 작업 단계 또는 무결성 정보를 확인할 수 없습니다. 원본 파일은 변경하지 않으며 이 작업을 자동 실행하지 않습니다.",
    title: "내부 참조 작업 확인 필요"
  },
  "missing-source": {
    actionLabel: "복원 상태 다시 확인",
    description: "갱신할 원본 항목을 서버에서 찾지 못했습니다. 해당 항목을 휴지통에서 복원하거나 다른 탭의 처리가 끝난 뒤 다시 확인할 수 있습니다.",
    title: "내부 참조 원본 없음"
  },
  "path-state-conflict": {
    actionLabel: "경로 상태 다시 대조",
    description: "이동 전·후 경로가 섞여 있어 원본 참조를 수정하지 않았습니다. 모든 대상의 현재 서버 경로를 다시 대조한 뒤, 한 상태로 확인될 때만 재개합니다.",
    title: "내부 참조 경로 충돌"
  },
  "revision-conflict": {
    actionLabel: "현재 revision 다시 확인",
    description: "원본 revision이 계획 이후 바뀌었습니다. 현재 편집본은 자동 병합하거나 덮어쓰지 않습니다. 다른 탭에서 같은 작업을 끝냈는지만 다시 확인할 수 있습니다.",
    title: "내부 참조 revision 충돌"
  },
  "write-failed": {
    actionLabel: "안전하게 다시 시도",
    description: "암호화 저장 또는 네트워크 확인을 완료하지 못했습니다. 최신 서버 revision을 다시 읽고 정확히 일치할 때만 이어서 처리합니다.",
    title: "내부 참조 저장 중단"
  }
};

function recoveryCopy(errorCode: VaultPathRewriteSafeErrorCode | null): VaultPathRewriteRecoveryCopy {
  if (errorCode) return recoveryCopyByErrorCode[errorCode];
  return {
    actionLabel: null,
    description: "중단 원인을 안전하게 확인할 수 없어 원본 파일을 변경하지 않습니다.",
    title: "내부 참조 작업 확인 필요"
  };
}

export function VaultPathRewriteRecoveryNotice({
  busy,
  job,
  online,
  ready,
  onRetry
}: {
  busy: boolean;
  job: VaultPathRewriteJobSummary;
  online: boolean;
  ready: boolean;
  onRetry: () => void;
}) {
  const copy = recoveryCopy(job.lastErrorCode);
  const disabledReason = !online
    ? "온라인 연결 후 다시 확인할 수 있습니다."
    : !ready
      ? "서버의 최신 Vault 상태를 확인한 뒤 다시 시도할 수 있습니다."
      : busy
        ? "현재 서버 상태를 확인하는 중입니다."
        : null;

  return (
    <aside
      aria-busy={busy}
      aria-label="내부 참조 갱신 충돌"
      className="vault-workspace-conflict vault-path-rewrite-recovery"
      data-error-code={job.lastErrorCode ?? "unknown"}
      role="alert"
    >
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.description}</p>
        <p className="vault-path-rewrite-progress">
          경로 대상 {job.manifest.pathChanges.length}개 · 참조 원본 {job.cursor}/{job.stepCount}개 확인됨 · 재확인 {job.retryCount}회
        </p>
        {disabledReason && copy.actionLabel ? (
          <p className="vault-path-rewrite-disabled-reason" role="status">{disabledReason}</p>
        ) : null}
      </div>
      {copy.actionLabel ? (
        <div>
          <button
            disabled={Boolean(disabledReason)}
            onClick={onRetry}
            type="button"
          >
            {busy ? "확인 중…" : copy.actionLabel}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
