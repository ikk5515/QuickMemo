export class LibraryVaultUserError extends Error {
  readonly code: string = "library-vault/user-error";

  constructor(message: string) {
    super(message);
    this.name = "LibraryVaultUserError";
  }
}

export type LibraryVaultPromotionStage =
  | "cleanup-import-job"
  | "commit-import-job"
  | "create-vault-entry"
  | "ensure-import-job"
  | "load-import-job"
  | "read-existing-target"
  | "verify-vault-entry";

/**
 * Keeps a non-sensitive operation stage for acceptance diagnostics while the
 * user-facing boundary continues to show one generic internal-error message.
 * The cause is never rendered, serialized, or logged by this class.
 */
export class LibraryVaultPromotionStageError extends Error {
  readonly code = "library-vault/internal-stage-failed";
  readonly stage: LibraryVaultPromotionStage;

  constructor(stage: LibraryVaultPromotionStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Vault promotion stage failed", { cause });
    this.name = "LibraryVaultPromotionStageError";
    this.stage = stage;
  }
}

export function libraryVaultPromotionErrorMessage(error: unknown) {
  return error instanceof LibraryVaultUserError
    ? error.message
    : "Vault 노트로 저장하지 못했습니다. 서버 연결과 Vault 상태를 확인한 뒤 다시 시도해주세요.";
}
