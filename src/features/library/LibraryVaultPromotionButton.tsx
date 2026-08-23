import { Check, FileUp, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  LibraryVaultPromotionStageError,
  libraryVaultPromotionErrorMessage,
  type LibraryVaultPromotionStage
} from "./libraryVaultErrors";
import "./libraryVaultPromotion.css";

export function LibraryVaultPromotionButton({
  disabled = false,
  onOpen,
  onPromote
}: {
  disabled?: boolean;
  onOpen?: (entryId: string) => void;
  onPromote: () => Promise<{ noteId: string; state: "created" | "existing" | "recovered" }>;
}) {
  const [busy, setBusy] = useState(false);
  const [diagnosticStage, setDiagnosticStage] = useState<LibraryVaultPromotionStage | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function promote() {
    if (busy || disabled) return;
    setBusy(true);
    setDiagnosticStage(null);
    setMessage(null);
    try {
      const result = await onPromote();
      setEntryId(result.noteId);
      setMessage(result.state === "created"
        ? "원본 자료는 그대로 두고 암호화된 Markdown 노트로 저장했습니다."
        : result.state === "recovered"
          ? "끊긴 저장 응답을 서버에서 재확인했습니다. 원본 자료는 그대로이며 Vault 노트도 안전합니다."
          : "원본 자료는 그대로이며, 이미 만든 Vault 노트를 확인했습니다.");
    } catch (caught) {
      if (
        import.meta.env.MODE === "test"
        && import.meta.env.VITE_E2E_NAVIGATION_BRIDGE === "true"
        && caught instanceof LibraryVaultPromotionStageError
      ) {
        setDiagnosticStage(caught.stage);
      }
      setMessage(libraryVaultPromotionErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="library-vault-promotion"
      data-e2e-promotion-stage={diagnosticStage ?? undefined}
    >
      <button
        aria-busy={busy}
        className="secondary-button library-vault-promotion-button"
        disabled={disabled || busy}
        onClick={() => void promote()}
        type="button"
      >
        {busy ? <Loader2 aria-hidden="true" className="spin" size={15} /> : <FileUp aria-hidden="true" size={15} />}
        {busy ? "Vault에 저장 중…" : "Vault Markdown으로 저장"}
      </button>
      {entryId && onOpen ? (
        <button className="secondary-button library-vault-open-button" onClick={() => onOpen(entryId)} type="button">
          <Check aria-hidden="true" size={15} />
          Vault에서 열기
        </button>
      ) : null}
      {message ? (
        <span aria-live="polite" className="library-vault-promotion-status" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
