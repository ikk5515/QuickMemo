import { Copy, FileWarning } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkdownRenderer } from "../../markdown";
import {
  planLegacyVaultFormatConversion,
  type LegacyVaultEntryForConversion,
  type VaultMarkdownCopyDraft
} from "./formatConverter";
import "./core.css";

export interface VaultFormatConverterProps {
  onCreateMarkdownCopy: (draft: VaultMarkdownCopyDraft) => Promise<void> | void;
  source: LegacyVaultEntryForConversion;
}

export function VaultFormatConverter({ onCreateMarkdownCopy, source }: VaultFormatConverterProps) {
  const plan = useMemo(() => planLegacyVaultFormatConversion(source), [source]);
  const [acceptedLoss, setAcceptedLoss] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [copyTitle, setCopyTitle] = useState(plan.copy.title);
  const [error, setError] = useState("");

  useEffect(() => {
    setAcceptedLoss(false);
    setCreating(false);
    setCreated(false);
    setCopyTitle(plan.copy.title);
    setError("");
  }, [plan.copy.title, source.id, source.revision]);

  async function createCopy() {
    const normalizedTitle = copyTitle.trim().normalize("NFC");
    if (creating || created || (plan.preview.lossy && !acceptedLoss)) return;
    if (!normalizedTitle || normalizedTitle.length > 180 || normalizedTitle.includes("\n")) {
      setError("Markdown 복사본 이름은 한 줄 1~180자로 입력해주세요.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      await onCreateMarkdownCopy({ ...plan.copy, title: normalizedTitle });
      setCreated(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Markdown 복사본을 만들지 못했습니다.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section aria-label="Format converter" className="vault-core-panel vault-format-converter">
      <header><FileWarning aria-hidden="true" size={16} /><strong>Format converter</strong></header>
      <p>원본 HTML을 덮어쓰지 않고 같은 폴더에 새 Markdown 노트를 만듭니다.</p>
      <p>첨부파일과 공유 설정은 원본에 그대로 남으며 복사본으로 자동 이전되지 않습니다.</p>
      {plan.preview.warnings.length ? (
        <div className="vault-format-converter__warnings" role="status">
          <strong>변환 전 확인</strong>
          <ul>{plan.preview.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>
        </div>
      ) : <p role="status">손실 경고 없이 변환할 수 있습니다.</p>}
      <label className="vault-format-converter__title">
        Markdown 복사본 이름
        <input
          disabled={creating || created}
          onChange={(event) => setCopyTitle(event.currentTarget.value)}
          value={copyTitle}
        />
      </label>
      <details open>
        <summary>{copyTitle || "이름 없는 복사본"} 미리보기</summary>
        <div className="vault-format-converter__preview">
          <MarkdownRenderer source={plan.preview.markdown} />
        </div>
      </details>
      {plan.preview.lossy ? (
        <label className="vault-core-check">
          <input
            checked={acceptedLoss}
            onChange={(event) => setAcceptedLoss(event.currentTarget.checked)}
            type="checkbox"
          />
          경고를 확인했고 원본을 보존한 복사본 생성을 진행합니다.
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {created ? <p role="status">원본을 보존하고 Markdown 복사본을 만들었습니다.</p> : null}
      <button
        disabled={creating || created || !copyTitle.trim() || (plan.preview.lossy && !acceptedLoss)}
        onClick={() => void createCopy()}
        type="button"
      >
        <Copy aria-hidden="true" size={14} /> {creating ? "복사본 만드는 중…" : created ? "복사본 생성 완료" : "Markdown 복사본 만들기"}
      </button>
    </section>
  );
}
