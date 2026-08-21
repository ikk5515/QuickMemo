import type { MarkdownHeading } from "../knowledge";

export interface VaultOutlineProps {
  headings: readonly MarkdownHeading[];
  onNavigate: (heading: MarkdownHeading) => void;
}

export function VaultOutline({ headings, onNavigate }: VaultOutlineProps) {
  if (headings.length === 0) {
    return <p className="vault-panel-empty">이 노트에는 제목이 없습니다.</p>;
  }

  return (
    <nav aria-label="현재 노트 목차" className="vault-outline">
      <ol>
        {headings.map((heading, index) => (
          <li key={`${heading.line}:${heading.slug}:${index}`}>
            <button
              onClick={() => onNavigate(heading)}
              style={{ paddingInlineStart: `${8 + Math.max(0, heading.level - 1) * 14}px` }}
              title={`${heading.line}번째 줄로 이동`}
              type="button"
            >
              <span aria-hidden="true">H{heading.level}</span>
              <strong>{heading.text}</strong>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
