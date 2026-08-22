import { ListEnd } from "lucide-react";
import { useDeferredValue, useMemo } from "react";
import { buildVaultFootnoteView, type VaultFootnoteViewItem } from "./footnotes";
import "./core.css";

export interface VaultFootnotesViewProps {
  onNavigate?: (footnote: VaultFootnoteViewItem) => void;
  source: string;
}
export function VaultFootnotesView({ onNavigate, source }: VaultFootnotesViewProps) {
  const deferredSource = useDeferredValue(source);
  const model = useMemo(() => {
    try {
      return { error: "", view: buildVaultFootnoteView(deferredSource) };
    } catch {
      return { error: "각주 구조를 분석하지 못했습니다.", view: { items: [], truncated: false } };
    }
  }, [deferredSource]);

  return (
    <section aria-label="Footnotes view" className="vault-core-panel vault-footnotes-view">
      <header><ListEnd aria-hidden="true" size={16} /><strong>Footnotes</strong></header>
      {model.error ? <p role="alert">{model.error}</p> : null}
      {!model.error && model.view.items.length === 0 ? <p role="status">이 노트에는 참조된 각주가 없습니다.</p> : null}
      <ol>
        {model.view.items.map((item) => (
          <li key={`${item.number}:${item.label}`}>
            <div>
              <strong>{item.number}. {item.label}</strong>
              <span>{item.referenceCount}개 참조{item.inline ? " · 인라인" : ""}</span>
            </div>
            <p>{item.preview || "내용 없음"}</p>
            {item.definitionLine !== null && onNavigate ? (
              <button onClick={() => onNavigate(item)} type="button">
                {item.definitionLine}번째 줄로 이동
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {model.view.truncated ? <p role="status">성능 보호를 위해 처음 500개 각주만 표시합니다.</p> : null}
    </section>
  );
}
