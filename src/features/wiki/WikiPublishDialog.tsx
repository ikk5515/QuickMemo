import { Check, Copy, ExternalLink, Globe2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { getPublishedWikiOwnerStatus, publishPreparedWiki, unpublishWiki } from "../../services/publishedWikis";
import type { PreparedWikiPublication, PublishedWikiOwnerStatus } from "./publishedWikiTypes";
import "../../styles/wiki-publish.css";

export interface WikiPublishDialogProps {
  rootFolderId: string;
  folderName: string;
  uid: string;
  sessionSignal: AbortSignal;
  prepare: (signal: AbortSignal) => Promise<PreparedWikiPublication>;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}

export default function WikiPublishDialog({ rootFolderId, folderName, uid, sessionSignal, prepare, onClose, returnFocusTo }: WikiPublishDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const prepareRef = useRef(prepare);
  useLayoutEffect(() => { prepareRef.current = prepare; }, [prepare]);
  const operationRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<PublishedWikiOwnerStatus | null>(null);
  const [preview, setPreview] = useState<PreparedWikiPublication | null>(null);
  const [busy, setBusy] = useState("공개할 내용을 확인하고 있습니다…");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const publicUrl = status?.wikiId ? `${window.location.origin}/wiki/public/${encodeURIComponent(status.wikiId)}` : "";

  useEffect(() => {
    const controller = new AbortController();
    operationRef.current = controller;
    const abort = () => controller.abort();
    if (sessionSignal.aborted) controller.abort();
    else sessionSignal.addEventListener("abort", abort, { once: true });
    setError(""); setConfirmed(false); setPreview(null);
    setBusy("공개할 내용을 확인하고 있습니다…");
    void Promise.all([
      getPublishedWikiOwnerStatus(rootFolderId, { signal: controller.signal, expectedUid: uid }).then((next) => { if (!controller.signal.aborted) setStatus(next); return next; }),
      prepareRef.current(controller.signal)
    ]).then(([nextStatus, prepared]) => {
      if (controller.signal.aborted) return;
      setStatus(nextStatus); setPreview(prepared);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "공개할 내용을 불러오지 못했습니다.");
    }).finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => {
      controller.abort(); operationRef.current?.abort();
      sessionSignal.removeEventListener("abort", abort);
    };
  }, [attempt, rootFolderId, sessionSignal, uid]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => { if (returnFocusTo?.isConnected) returnFocusTo.focus(); };
  }, [returnFocusTo]);

  async function run(action: "publish" | "unpublish") {
    if (!status || busy || sessionSignal.aborted || (action === "publish" && (!preview || !confirmed))) return;
    const controller = new AbortController();
    operationRef.current = controller;
    const abort = () => controller.abort();
    sessionSignal.addEventListener("abort", abort, { once: true });
    setError(""); setNotice(""); setCopied(false);
    setBusy(action === "publish" ? "위키를 게시하고 있습니다…" : "공개를 중지하고 있습니다…");
    try {
      const next = action === "publish"
        ? await publishPreparedWiki(preview!, status.revision, { signal: controller.signal, expectedUid: uid })
        : await unpublishWiki(rootFolderId, status.revision, { signal: controller.signal, expectedUid: uid });
      if (controller.signal.aborted) return;
      setStatus(next); setConfirmed(false);
      setNotice(action === "publish" ? "공개 위키가 게시되었습니다." : "공개를 중지했습니다. 기존 링크로 내용을 볼 수 없습니다.");
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "처리하지 못했습니다. 상태를 새로 확인한 뒤 다시 시도해 주세요.");
        // A timed-out activation may have committed. Read the authoritative state before retrying.
        try { setStatus(await getPublishedWikiOwnerStatus(rootFolderId, { signal: controller.signal, expectedUid: uid })); } catch { if (!controller.signal.aborted) setStatus(null); }
      }
    } finally {
      sessionSignal.removeEventListener("abort", abort);
      if (!controller.signal.aborted) setBusy("");
    }
  }

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); return; }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')];
    const first = items[0], last = items.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }

  return <div className="wiki-publish-backdrop" role="presentation" onClick={() => { if (!busy) onClose(); }}>
    <div className="wiki-publish-dialog" ref={dialogRef} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={trapFocus} onClick={(event) => event.stopPropagation()}>
      <header><div><Globe2 size={19} aria-hidden="true" /><h2 id={titleId}>폴더 위키 공개</h2></div><button aria-label="공개 설정 닫기" type="button" onClick={onClose} disabled={Boolean(busy)}><X size={18} /></button></header>
      <div className="wiki-publish-content">
        <p id={descriptionId}><strong>{folderName}</strong> 폴더와 하위 폴더를 공개 링크로 읽을 수 있게 합니다.</p>
        <p className="wiki-publish-description">게시한 내용은 로그인 없이 누구나 볼 수 있습니다. 다른 폴더는 포함되지 않으며, 원본 메모는 계속 암호화됩니다. 수정한 내용은 다시 게시할 때 반영됩니다.</p>
        {status?.published && publicUrl ? <section className="wiki-publish-link" aria-label="공개 링크">
          <span>공개 중 · 메모 {status.noteCount}개</span>
          <a href={publicUrl} target="_blank" rel="noopener noreferrer">{publicUrl}<ExternalLink size={14} aria-hidden="true" /></a>
          <button type="button" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true)).catch(() => setError("링크를 복사하지 못했습니다. 위 주소를 선택해 복사해 주세요."))}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "복사됨" : "링크 복사"}</button>
        </section> : null}
        {preview ? <section className="wiki-publish-preview" aria-label="공개할 내용">
          <h3>공개할 내용</h3>
          <p>메모 {preview.manifest.entries.filter((entry) => entry.kind !== "asset").length}개 · 이미지 {preview.manifest.entries.filter((entry) => entry.kind === "asset").length}개 · 폴더 {preview.manifest.folders.length}개</p>
          <ul>{preview.manifest.entries.filter((entry) => entry.kind !== "asset").map((entry) => <li key={entry.sourceNoteId}>{entry.title || "제목 없음"}</li>)}</ul>
          {preview.redactedLinkCount > 0 ? <p>공개 범위 밖의 내부 링크 {preview.redactedLinkCount}개를 비공개 표시로 바꿉니다.</p> : null}
          {preview.omittedEntryCount > 0 ? <p>지원하지 않는 파일 {preview.omittedEntryCount}개는 제외합니다.</p> : null}
          <label className="wiki-publish-consent"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>위 내용을 누구나 볼 수 있도록 공개합니다.</span></label>
        </section> : null}
        {busy ? <p role="status">{busy}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <p className="wiki-publish-error" role="alert">{error}</p> : null}
      </div>
      <footer>
        {status?.published ? <button className="danger" type="button" disabled={Boolean(busy)} onClick={() => void run("unpublish")}>공개 중지</button> : <span />}
        <div><button type="button" disabled={Boolean(busy)} onClick={() => setAttempt((value) => value + 1)}>다시 확인</button><button className="primary" type="button" disabled={Boolean(busy) || !preview || !status || !confirmed} onClick={() => void run("publish")}>{status?.published ? "공개 내용 업데이트" : "위키 게시"}</button></div>
      </footer>
    </div>
  </div>;
}
