import { ExternalLink, Globe2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { safeWebViewerUrl } from "./webViewer";
import "./core.css";

export interface VaultWebViewerProps {
  /** Finite CSP-reviewed hosts only. An empty list uses the safe external-tab fallback. */
  embeddedHosts?: readonly string[];
  initialUrl?: string;
}

const EMPTY_EMBEDDED_HOSTS: readonly string[] = Object.freeze([]);

export function VaultWebViewer({ embeddedHosts = EMPTY_EMBEDDED_HOSTS, initialUrl = "" }: VaultWebViewerProps) {
  const initialSafeUrl = safeWebViewerUrl(initialUrl) ?? "";
  const [draftUrl, setDraftUrl] = useState(initialSafeUrl);
  const [loadedUrl, setLoadedUrl] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [error, setError] = useState("");
  const embeddedHostSet = useMemo(
    () => new Set(embeddedHosts.map((host) => host.trim().toLocaleLowerCase("en-US")).filter(Boolean)),
    [embeddedHosts]
  );
  const canEmbedLoadedUrl = loadedUrl
    ? embeddedHostSet.has(new URL(loadedUrl).hostname.toLocaleLowerCase("en-US"))
    : false;

  useEffect(() => {
    const next = safeWebViewerUrl(initialUrl) ?? "";
    setDraftUrl(next);
    setLoadedUrl("");
    setError(initialUrl && !next ? "http 또는 https 공개 주소만 열 수 있습니다." : "");
  }, [initialUrl]);

  function navigate() {
    const safeUrl = safeWebViewerUrl(draftUrl);
    if (!safeUrl) {
      setError("자격 증명, 로컬 네트워크 주소, http·https 이외의 주소는 열 수 없습니다.");
      setLoadedUrl("");
      return;
    }
    setError("");
    setDraftUrl(safeUrl);
    setLoadedUrl(safeUrl);
    setFrameKey((current) => current + 1);
  }

  return (
    <section aria-label="Web viewer" className="vault-web-viewer">
      <header><Globe2 aria-hidden="true" size={16} /><strong>Web viewer</strong></header>
      <form onSubmit={(event) => { event.preventDefault(); navigate(); }}>
        <label className="sr-only" htmlFor="vault-web-viewer-url">웹 주소</label>
        <input
          autoCapitalize="none"
          autoComplete="off"
          id="vault-web-viewer-url"
          inputMode="url"
          onChange={(event) => setDraftUrl(event.currentTarget.value)}
          placeholder="https://example.com"
          spellCheck={false}
          value={draftUrl}
        />
        <button type="submit">열기</button>
        <button aria-label="웹 페이지 새로고침" disabled={!loadedUrl} onClick={() => setFrameKey((current) => current + 1)} type="button"><RefreshCw aria-hidden="true" size={15} /></button>
        {loadedUrl ? <a href={loadedUrl} rel="noopener noreferrer" target="_blank"><ExternalLink aria-hidden="true" size={15} /> 새 탭</a> : null}
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <p className="vault-web-viewer__notice">
        검토된 호스트만 기능 권한이 없는 sandbox에 표시합니다. 그 밖의 공개 주소는 안전한 새 탭으로 엽니다.
      </p>
      {loadedUrl && canEmbedLoadedUrl ? (
        <iframe
          allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'"
          key={frameKey}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox=""
          src={loadedUrl}
          title={`${new URL(loadedUrl).hostname} 웹 뷰어`}
        />
      ) : loadedUrl ? (
        <div className="vault-web-viewer__empty">
          <p>이 주소는 앱 내부 표시 허용 목록에 없습니다.</p>
          <a href={loadedUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink aria-hidden="true" size={15} /> 안전한 새 탭에서 열기
          </a>
        </div>
      ) : <div className="vault-web-viewer__empty">주소를 확인한 뒤 명시적으로 열어주세요.</div>}
    </section>
  );
}
