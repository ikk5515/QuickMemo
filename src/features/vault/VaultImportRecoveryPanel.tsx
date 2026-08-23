import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type {
  VaultImportJobStatus,
  VaultImportJobSummary,
  VaultImportSafeErrorCode
} from "../../services/vaultImportJobs";
import "./vaultImportRecovery.css";

const statusLabels: Record<VaultImportJobStatus, string> = {
  preparing: "복구 정보 준비 중",
  staging: "항목 저장 여부 확인 필요",
  committed: "가져오기 완료",
  "rolling-back": "롤백 진행 중",
  "rolled-back": "롤백 완료",
  blocked: "안전 잠금"
};

const errorMessages: Record<VaultImportSafeErrorCode, string> = {
  "job-corrupt": "복구 정보의 무결성을 확인할 수 없어 자동 작업을 차단했습니다.",
  "rollback-conflict": "가져온 항목이 이후 수정되어 자동 삭제하지 않았습니다.",
  "snapshot-incomplete": "서버 항목 목록을 완전하게 확인하지 못해 삭제하지 않았습니다.",
  "write-failed": "서버 쓰기가 끝나지 않아 다시 확인해야 합니다."
};

function canRequestRollback(job: VaultImportJobSummary) {
  return job.status !== "committed"
    && job.status !== "rolled-back"
    && job.lastErrorCode !== "job-corrupt";
}

export interface VaultImportRecoveryPanelProps {
  busyJobId?: string | null;
  jobs: readonly VaultImportJobSummary[];
  onClose: () => void;
  onRecheck: () => void | Promise<void>;
  onRollback: (job: VaultImportJobSummary) => void | Promise<void>;
}

export function VaultImportRecoveryPanel({
  busyJobId,
  jobs,
  onClose,
  onRecheck,
  onRollback
}: VaultImportRecoveryPanelProps) {
  const busy = Boolean(busyJobId);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return (
    <section
      aria-label="ZIP 가져오기 복구"
      className="vault-import-recovery"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        onClose();
      }}
      ref={panelRef}
      role="region"
      tabIndex={-1}
    >
      <header>
        <span aria-hidden="true" className="vault-import-recovery-icon"><AlertTriangle size={18} /></span>
        <div>
          <h2>중단된 ZIP 가져오기</h2>
          <p>서버 상태를 확인한 뒤 새로 생성된 항목만 복구합니다. 기존 노트는 자동으로 덮어쓰거나 삭제하지 않습니다.</p>
        </div>
        <button aria-label="ZIP 가져오기 복구 패널 닫기" disabled={busy} onClick={onClose} type="button">
          <X aria-hidden="true" size={17} />
        </button>
      </header>

      <ul aria-live="polite">
        {jobs.map((job, index) => {
          const processing = busyJobId === job.jobId;
          const terminal = job.status === "committed" || job.status === "rolled-back";
          return (
            <li key={job.jobId}>
              <div className="vault-import-recovery-summary">
                {terminal
                  ? <CheckCircle2 aria-hidden="true" size={17} />
                  : <AlertTriangle aria-hidden="true" size={17} />}
                <div>
                  <strong>가져오기 작업 {index + 1} · {statusLabels[job.status]}</strong>
                  <span>{job.entryCount}개 항목 · {job.folderCount}개 폴더</span>
                </div>
              </div>
              {job.lastErrorCode ? (
                <p className="vault-import-recovery-error" role="status">{errorMessages[job.lastErrorCode]}</p>
              ) : job.status === "staging" ? (
                <p>다른 탭에서 아직 실행 중인지 확인한 뒤 롤백을 선택하세요.</p>
              ) : null}
              <div className="vault-import-recovery-actions">
                <button disabled={busy} onClick={() => void onRecheck()} type="button">
                  <RefreshCw aria-hidden="true" size={15} /> 서버 상태 다시 확인
                </button>
                {canRequestRollback(job) ? (
                  <button
                    className="danger-text"
                    disabled={busy}
                    onClick={() => void onRollback(job)}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" size={15} />
                    {processing ? "안전 롤백 확인 중…" : "생성분 안전 롤백"}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
