import { ReadonlyNoteRenderer } from "../../components/ReadonlyNoteRenderer";

interface VaultLegacyNoteProps {
  body: string;
  entryId: string;
  onCreateMarkdownCopy: (entryId: string) => void;
}

export function VaultLegacyNote({ body, entryId, onCreateMarkdownCopy }: VaultLegacyNoteProps) {
  return <div className="vault-legacy-note">
    <div className="vault-legacy-banner">
      <span>기존 HTML 노트 — 원본을 보존하고 있습니다.</span>
      <button onClick={() => onCreateMarkdownCopy(entryId)} title="원본을 유지하고 편집할 수 있는 Markdown 복사본 만들기" type="button">Markdown 복사본 만들기</button>
    </div>
    <ReadonlyNoteRenderer as="article" content={body} />
  </div>;
}
