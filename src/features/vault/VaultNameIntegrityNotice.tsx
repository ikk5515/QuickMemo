interface VaultNameIntegrityNoticeProps {
  collisionLabels: readonly string[];
  failure: string | null;
  migrationStatus: "checking" | "waiting" | "running" | "ready" | "blocked";
  online: boolean;
  progress: { completed: number; total: number } | null;
  repairBusy: boolean;
  repairCount: number;
  onRepair: () => void;
  onRetry: () => void;
}

export default function VaultNameIntegrityNotice({
  collisionLabels,
  failure,
  migrationStatus,
  online,
  progress,
  repairBusy,
  repairCount,
  onRepair,
  onRetry
}: VaultNameIntegrityNoticeProps) {
  const message = !online
    ? "온라인 연결을 기다리고 있습니다. 현재 편집 버퍼는 그대로 유지됩니다."
    : migrationStatus === "running"
      ? `${progress?.completed ?? 0}/${progress?.total ?? 0}개를 한 번만 확인 중입니다. 제목 평문은 서버에 저장하지 않습니다.`
      : migrationStatus === "blocked" && collisionLabels.length
        ? `이름 또는 위치를 정리해야 합니다: ${collisionLabels.join(", ")}${repairCount > collisionLabels.length ? " 외" : ""}`
        : migrationStatus === "blocked"
          ? failure ?? "무결성 확인을 완료하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해주세요. 현재 편집 버퍼는 유지됩니다."
          : failure ?? "처음 전환이 필요한 Vault만 서버의 전체 노트·폴더 목록을 한 번 확인합니다. 현재 편집 버퍼는 유지됩니다.";

  return (
    <aside
      aria-busy={migrationStatus === "running" || repairBusy}
      aria-label="Vault 이름 무결성 준비"
      className="vault-workspace-conflict vault-name-migration"
      role={migrationStatus === "blocked" ? "alert" : "status"}
    >
      <div>
        <strong>암호화된 이름 무결성 준비</strong>
        <p>{message}</p>
      </div>
      {migrationStatus === "blocked" ? (
        <div>
          {repairCount ? (
            <button disabled={repairBusy} onClick={onRepair} type="button">
              {repairBusy ? "정리 중…" : "충돌 이름 바꾸기"}
            </button>
          ) : null}
          <button disabled={repairBusy} onClick={onRetry} type="button">다시 확인</button>
        </div>
      ) : null}
    </aside>
  );
}
