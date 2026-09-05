import { ChevronDown, Download, FileCode2 } from "lucide-react";
import { useState } from "react";
import { downloadBlob } from "./browserDownload";

interface VaultArchivedFilePreviewProps {
  fileName: string;
  source: string;
}

/** Preserve retired file formats without executing or mounting their editors. */
export function VaultArchivedFilePreview({ fileName, source }: VaultArchivedFilePreviewProps) {
  const [sourceOpen, setSourceOpen] = useState(false);

  return (
    <section aria-label="보관된 파일" className="vault-archived-file">
      <FileCode2 aria-hidden="true" size={30} />
      <h2>{fileName}</h2>
      <p>보관된 원본 파일입니다. 내용을 확인하거나 내려받을 수 있습니다.</p>
      <button
        onClick={() => downloadBlob(new Blob([source], { type: "application/octet-stream" }), fileName)}
        type="button"
      ><Download aria-hidden="true" size={16} />원본 내려받기</button>
      <details onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
        <summary><ChevronDown aria-hidden="true" size={16} />원문 보기</summary>
        {sourceOpen ? <pre>{source}</pre> : null}
      </details>
    </section>
  );
}
