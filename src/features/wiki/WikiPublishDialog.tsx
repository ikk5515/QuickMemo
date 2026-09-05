import { Check, Copy, ExternalLink, Globe2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { checkPublishedWikiSlugAvailability, getPublishedWikiOwnerStatus, getPublishedWikiWorkspaceStatus, publishPreparedWiki, setPublishedWikiSlug, unpublishWiki } from "../../services/publishedWikis";
import { isValidWikiSlug, normalizeWikiSlug, type PreparedWikiPublication, type PublishedWikiOwnerStatus, type WikiPublicationSelection } from "./publishedWikiTypes";
import "../../styles/wiki-publish.css";

export interface WikiPublishChoice { id: string; label: string }
export interface WikiPublishDialogProps {
  rootFolderId: string | null;
  folders: WikiPublishChoice[];
  notes: WikiPublishChoice[];
  uid: string;
  sessionSignal: AbortSignal;
  prepare: (selection: WikiPublicationSelection, signal: AbortSignal) => Promise<PreparedWikiPublication>;
  onPublicationChange?: (status: PublishedWikiOwnerStatus) => void;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}
const emptySelection: WikiPublicationSelection = { folderIds: [], noteIds: [] };
function publishedSelection(status: PublishedWikiOwnerStatus, legacyRootFolderId?: string): WikiPublicationSelection {
  return status.selection ?? status.manifest?.selection ?? {
    folderIds: status.manifest?.rootFolderId ? [status.manifest.rootFolderId] : legacyRootFolderId ? [legacyRootFolderId] : [], noteIds: []
  };
}
function unionSelection(left: WikiPublicationSelection, right: WikiPublicationSelection): WikiPublicationSelection {
  return { folderIds: [...new Set([...left.folderIds, ...right.folderIds])], noteIds: [...new Set([...left.noteIds, ...right.noteIds])] };
}

export default function WikiPublishDialog({ rootFolderId, folders, notes, uid, sessionSignal, prepare, onPublicationChange, onClose, returnFocusTo }: WikiPublishDialogProps) {
  const titleId = useId(), descriptionId = useId(), slugId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const prepareRef = useRef(prepare), onChangeRef = useRef(onPublicationChange);
  useLayoutEffect(() => { prepareRef.current = prepare; onChangeRef.current = onPublicationChange; }, [prepare, onPublicationChange]);
  const operationRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<PublishedWikiOwnerStatus | null>(null);
  const [selection, setSelection] = useState<WikiPublicationSelection>(emptySelection);
  const [slugInput, setSlugInput] = useState("");
  const [title, setTitle] = useState("내 위키");
  const [legacyWikiId, setLegacyWikiId] = useState("");
  const [legacyStatus, setLegacyStatus] = useState<PublishedWikiOwnerStatus | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const importedSelectionRef = useRef<WikiPublicationSelection>(emptySelection);
  const [availability, setAvailability] = useState<{ slug: string; available: boolean } | null>(null);
  const [preview, setPreview] = useState<PreparedWikiPublication | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState("공개 설정을 불러오고 있습니다…");
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scopeQuery, setScopeQuery] = useState("");
  const [folderLimit, setFolderLimit] = useState(80), [noteLimit, setNoteLimit] = useState(80);
  const choices = useMemo(() => {
    const query = scopeQuery.trim().toLocaleLowerCase();
    return { folders: folders.filter((item) => !query || item.label.toLocaleLowerCase().includes(query)), notes: notes.filter((item) => !query || item.label.toLocaleLowerCase().includes(query)) };
  }, [folders, notes, scopeQuery]);
  const slug = normalizeWikiSlug(slugInput);
  const hasStatus = Boolean(status);
  const selectedLegacy = status?.legacyPublications?.find((item) => item.wikiId === legacyWikiId);
  const selectedLegacyRoot = selectedLegacy?.rootFolderId;
  const legacyReady = Boolean(status?.wikiId) || !legacyWikiId || (!legacyLoading && legacyStatus?.wikiId === legacyWikiId);
  const slugValid = isValidWikiSlug(slug);
  const slugReady = slugValid && (slug === status?.slug || (availability?.slug === slug && availability.available));
  const publicUrl = status?.slug ? `${window.location.origin}/wiki/${encodeURIComponent(status.slug)}` : "";

  useEffect(() => {
    const controller = new AbortController();
    operationRef.current = controller;
    const abort = () => controller.abort();
    if (sessionSignal.aborted) controller.abort(); else sessionSignal.addEventListener("abort", abort, { once: true });
    setError(""); setConfirmed(false); setStatus(null); setPreview(null);
    setLegacyWikiId(""); setLegacyStatus(null); importedSelectionRef.current = emptySelection;
    setBusy("공개 설정을 불러오고 있습니다…");
    void getPublishedWikiWorkspaceStatus({ signal: controller.signal, expectedUid: uid }).then((next) => {
      if (controller.signal.aborted) return;
      setStatus(next); setSlugInput(next.slug ?? ""); setTitle(next.title || "내 위키");
      const current = publishedSelection(next);
      setSelection({ folderIds: [...new Set([...current.folderIds, ...(rootFolderId ? [rootFolderId] : [])])], noteIds: [...current.noteIds] });
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "공개 설정을 불러오지 못했습니다."); })
      .finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => { controller.abort(); operationRef.current?.abort(); sessionSignal.removeEventListener("abort", abort); };
  }, [attempt, rootFolderId, sessionSignal, uid]);

  useEffect(() => {
    if (status?.wikiId || !legacyWikiId || !selectedLegacyRoot) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (sessionSignal.aborted) controller.abort(); else sessionSignal.addEventListener("abort", abort, { once: true });
    setLegacyLoading(true); setLegacyStatus(null); setConfirmed(false); setError("");
    void getPublishedWikiOwnerStatus(selectedLegacyRoot, { signal: controller.signal, expectedUid: uid }).then((next) => {
      if (controller.signal.aborted) return;
      if (next.wikiId !== legacyWikiId) throw new Error("기존 위키가 변경되었습니다. 공개 설정을 다시 확인해 주세요.");
      setLegacyStatus(next);
      setSelection((current) => {
        const imported = publishedSelection(next, selectedLegacyRoot);
        importedSelectionRef.current = {
          folderIds: imported.folderIds.filter((id) => !current.folderIds.includes(id)),
          noteIds: imported.noteIds.filter((id) => !current.noteIds.includes(id))
        };
        return unionSelection(current, imported);
      });
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "기존 위키를 불러오지 못했습니다."); })
      .finally(() => { if (!controller.signal.aborted) setLegacyLoading(false); });
    return () => { controller.abort(); sessionSignal.removeEventListener("abort", abort); };
  }, [legacyWikiId, selectedLegacyRoot, sessionSignal, status?.wikiId, uid]);

  useEffect(() => {
    if (!hasStatus) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (sessionSignal.aborted) controller.abort(); else sessionSignal.addEventListener("abort", abort, { once: true });
    setPreview(null); setPreviewError(""); setConfirmed(false); setPreparing(true);
    void prepareRef.current(selection, controller.signal).then((value) => { if (!controller.signal.aborted) setPreview(value); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setPreviewError(reason instanceof Error ? reason.message : "공개할 내용을 확인하지 못했습니다."); })
      .finally(() => { if (!controller.signal.aborted) setPreparing(false); });
    return () => { controller.abort(); sessionSignal.removeEventListener("abort", abort); };
  // Re-prepare only when the selected scope changes, not on the returned publication revision.
  }, [selection, sessionSignal, hasStatus]);

  useEffect(() => {
    setAvailability(null);
    if (!slugValid || slug === status?.slug) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (sessionSignal.aborted) controller.abort(); else sessionSignal.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
      void checkPublishedWikiSlugAvailability(slug, { signal: controller.signal, expectedUid: uid }).then((value) => { if (!controller.signal.aborted) setAvailability(value); })
        .catch(() => { /* The save request performs the final atomic availability check. */ });
    }, 350);
    return () => { controller.abort(); window.clearTimeout(timer); sessionSignal.removeEventListener("abort", abort); };
  }, [slug, slugValid, status?.slug, sessionSignal, uid]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => { if (returnFocusTo?.isConnected) returnFocusTo.focus(); };
  }, [returnFocusTo]);

  async function run(action: "publish" | "unpublish" | "slug") {
    if (!status || busy || sessionSignal.aborted) return;
    if (action !== "unpublish" && (!slugReady || !legacyReady)) return;
    if (action === "publish" && (!preview || !confirmed || !title.trim() || preparing)) return;
    const controller = new AbortController();
    operationRef.current = controller;
    const abort = () => controller.abort();
    sessionSignal.addEventListener("abort", abort, { once: true });
    setError(""); setNotice(""); setCopied(false);
    setBusy(action === "publish" ? "위키를 게시하고 있습니다…" : action === "slug" ? "주소를 저장하고 있습니다…" : "공개를 중지하고 있습니다…");
    const options = { signal: controller.signal, expectedUid: uid };
    try {
      let next = status;
      if (action !== "unpublish" && slug !== next.slug) {
        const adopting = !next.wikiId && legacyWikiId ? legacyStatus : null;
        next = await setPublishedWikiSlug(slug, adopting?.revision ?? next.revision, { ...options, ...(adopting ? { legacyWikiId: adopting.wikiId! } : {}) });
        if (controller.signal.aborted) return;
        setStatus(next); onChangeRef.current?.(next);
      }
      if (action === "publish") {
        // Rebuild after confirmation to include the latest saved source revisions.
        const latest = await prepareRef.current(selection, controller.signal);
        controller.signal.throwIfAborted();
        next = await publishPreparedWiki({ ...latest, manifest: { ...latest.manifest, title: title.trim() } }, next.revision, options);
      } else if (action === "unpublish") next = await unpublishWiki(null, next.revision, options);
      if (controller.signal.aborted) return;
      setStatus(next); setConfirmed(false); onChangeRef.current?.(next);
      if (action === "publish") setSelection(next.selection ?? selection);
      setNotice(action === "publish" ? "공개했습니다. 선택한 범위의 변경 사항은 저장 후 자동 반영됩니다." : action === "slug" ? "위키 주소를 저장했습니다." : "공개를 중지했습니다. 기존 링크로 내용을 볼 수 없습니다.");
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "처리하지 못했습니다. 다시 확인해 주세요.");
        try {
          const latest = await getPublishedWikiWorkspaceStatus(options);
          if (controller.signal.aborted) return;
          setStatus(latest); setConfirmed(false); onChangeRef.current?.(latest);
          if (latest.wikiId) setSelection((current) => unionSelection(current, publishedSelection(latest)));
          else if (legacyWikiId && selectedLegacyRoot) {
            const currentLegacy = await getPublishedWikiOwnerStatus(selectedLegacyRoot, options);
            if (controller.signal.aborted) return;
            if (currentLegacy.wikiId !== legacyWikiId) { setLegacyStatus(null); return; }
            setLegacyStatus(currentLegacy);
            setSelection((current) => unionSelection(current, publishedSelection(currentLegacy, selectedLegacyRoot)));
          }
        } catch { if (!controller.signal.aborted) setStatus(null); }
      }
    } finally { sessionSignal.removeEventListener("abort", abort); if (!controller.signal.aborted) setBusy(""); }
  }
  function selectLegacy(wikiId: string) {
    setConfirmed(false); setPreview(null); setLegacyStatus(null); setLegacyLoading(Boolean(wikiId));
    const imported = importedSelectionRef.current;
    importedSelectionRef.current = emptySelection;
    setSelection((current) => ({ folderIds: current.folderIds.filter((id) => !imported.folderIds.includes(id)), noteIds: current.noteIds.filter((id) => !imported.noteIds.includes(id)) }));
    setLegacyWikiId(wikiId);
  }
  function toggleSelection(kind: keyof WikiPublicationSelection, id: string) {
    setConfirmed(false);
    importedSelectionRef.current = { ...importedSelectionRef.current, [kind]: importedSelectionRef.current[kind].filter((item) => item !== id) };
    setSelection((value) => ({ ...value, [kind]: value[kind].includes(id) ? value[kind].filter((item) => item !== id) : [...value[kind], id] }));
  }
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); return; }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((item) => !item.closest("details:not([open])") || item.tagName === "SUMMARY");
    const first = items[0], last = items.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  return <div className="wiki-publish-backdrop" role="presentation" onClick={() => { if (!busy) onClose(); }}>
    <div className="wiki-publish-dialog" ref={dialogRef} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={trapFocus} onClick={(event) => event.stopPropagation()}>
      <header><div><Globe2 size={18} aria-hidden="true" /><h2 id={titleId}>위키 공개 설정</h2></div><button aria-label="공개 설정 닫기" type="button" onClick={onClose} disabled={Boolean(busy)}><X size={18} /></button></header>
      <div className="wiki-publish-content">
        <p id={descriptionId}>선택한 폴더와 메모를 하나의 위키 주소로 공개합니다.</p>
        <p className="wiki-publish-description">공개한 내용은 누구나 읽을 수 있습니다. 선택한 폴더의 하위 폴더와 새 메모도 저장 후 자동 반영됩니다.</p>
        <div className="wiki-publish-field"><label htmlFor={slugId}>위키 주소</label><div className="wiki-publish-slug"><span>/wiki/</span><input id={slugId} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={40} value={slugInput} disabled={Boolean(busy)} onChange={(event) => setSlugInput(event.target.value)} aria-describedby={`${slugId}-help`} /><button type="button" disabled={Boolean(busy) || !status || !slugReady || !legacyReady || slug === status.slug} onClick={() => void run("slug")}>주소 저장</button></div>
          <small id={`${slugId}-help`}>{slug && !slugValid ? "영문 소문자·숫자·하이픈 3–40자. 예약된 이름은 사용할 수 없습니다." : slug === status?.slug ? "현재 위키 주소입니다." : availability?.slug === slug ? availability.available ? "사용할 수 있는 주소입니다." : "이미 사용 중인 주소입니다." : "영문 소문자·숫자·하이픈 3–40자"}</small>
          {status?.slug && slug !== status.slug ? <small>변경하면 이전 주소는 열리지 않습니다.</small> : null}
        </div>
        {!status?.wikiId && status?.legacyPublications?.length ? <label className="wiki-publish-field">기존 위키 가져오기<select value={legacyWikiId} disabled={Boolean(busy)} onChange={(event) => selectLegacy(event.target.value)}><option value="">새 위키로 시작</option>{status.legacyPublications.map((legacy) => <option key={legacy.wikiId} value={legacy.wikiId}>{legacy.title}</option>)}</select><small>선택한 기존 위키의 내용을 새 주소로 연결합니다. 나머지 위키는 유지됩니다.</small></label> : null}
        <label className="wiki-publish-field">위키 이름<input value={title} maxLength={120} disabled={Boolean(busy)} onChange={(event) => setTitle(event.target.value)} /></label>
        {publicUrl ? <section className="wiki-publish-link" aria-label="공개 링크"><span>{status?.published ? `공개 중 · 메모 ${status.noteCount}개` : "주소 등록됨 · 비공개"}</span><a href={publicUrl} target="_blank" rel="noopener noreferrer">{publicUrl}<ExternalLink size={14} aria-hidden="true" /></a><button type="button" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true)).catch(() => setError("링크를 복사하지 못했습니다. 위 주소를 선택해 복사해 주세요."))}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "복사됨" : "링크 복사"}</button></section> : null}
        <fieldset className="wiki-publish-selection" disabled={Boolean(busy) || legacyLoading || !status}><legend>공개 범위</legend>
          <label className="wiki-publish-field">공개 범위 검색<input type="search" value={scopeQuery} onChange={(event) => { setScopeQuery(event.target.value); setFolderLimit(80); setNoteLimit(80); }} /></label>
          <details open><summary>폴더 · 하위 폴더 포함</summary><div>{choices.folders.length ? choices.folders.slice(0, folderLimit).map((folder) => <label key={folder.id}><input type="checkbox" checked={selection.folderIds.includes(folder.id)} onChange={() => toggleSelection("folderIds", folder.id)} /><span>{folder.label}</span></label>) : <p>폴더가 없습니다.</p>}{choices.folders.length > folderLimit ? <button type="button" onClick={() => setFolderLimit((value) => value + 80)}>폴더 더 보기</button> : null}</div></details>
          <details><summary>개별 메모</summary><div>{choices.notes.length ? choices.notes.slice(0, noteLimit).map((note) => <label key={note.id}><input type="checkbox" checked={selection.noteIds.includes(note.id)} onChange={() => toggleSelection("noteIds", note.id)} /><span>{note.label}</span></label>) : <p>메모가 없습니다.</p>}{choices.notes.length > noteLimit ? <button type="button" onClick={() => setNoteLimit((value) => value + 80)}>메모 더 보기</button> : null}</div></details>
        </fieldset>
        {preview ? <section className="wiki-publish-preview" aria-label="공개할 내용"><h3>공개할 내용</h3><p>메모 {preview.manifest.entries.filter((entry) => entry.kind !== "asset").length}개 · 이미지 {preview.manifest.entries.filter((entry) => entry.kind === "asset").length}개 · 폴더 {preview.manifest.folders.length}개</p><ul>{preview.manifest.entries.filter((entry) => entry.kind !== "asset").map((entry) => <li key={entry.sourceNoteId}>{entry.title || "제목 없음"}</li>)}</ul>{preview.redactedLinkCount > 0 ? <p>범위 밖의 내부 링크 {preview.redactedLinkCount}개를 비공개 표시로 바꿉니다.</p> : null}{preview.omittedEntryCount > 0 ? <p>지원하지 않는 파일 {preview.omittedEntryCount}개는 제외합니다.</p> : null}<label className="wiki-publish-consent"><input type="checkbox" checked={confirmed} disabled={Boolean(busy) || !legacyReady} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>선택한 범위와 이후 저장되는 변경 사항을 누구나 볼 수 있도록 공개합니다.</span></label></section> : null}
        {legacyLoading ? <p role="status">기존 위키의 공개 범위를 확인하고 있습니다…</p> : null}{preparing ? <p role="status">공개할 내용을 확인하고 있습니다…</p> : null}{busy ? <p role="status">{busy}</p> : null}{notice ? <p role="status">{notice}</p> : null}{error || previewError ? <p className="wiki-publish-error" role="alert">{error || previewError}</p> : null}
      </div>
      <footer>{status?.published ? <button className="danger" type="button" disabled={Boolean(busy)} onClick={() => void run("unpublish")}>공개 중지</button> : <span />}<div><button type="button" disabled={Boolean(busy)} onClick={() => setAttempt((value) => value + 1)}>다시 확인</button><button className="primary" type="button" disabled={Boolean(busy) || preparing || !preview || !status || !confirmed || !slugReady || !legacyReady || !title.trim()} onClick={() => void run("publish")}>{status?.published ? "공개 범위 저장" : "위키 게시"}</button></div></footer>
    </div>
  </div>;
}
