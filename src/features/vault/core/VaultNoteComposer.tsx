import { FileInput, Files } from "lucide-react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  executeNoteMerge,
  executeNoteSplit,
  planNoteMerge,
  planNoteSplit,
  type ComposerEntrySnapshot,
  type NoteComposerAdapter
} from "./noteComposer";
import "./core.css";

export interface VaultNoteComposerProps {
  activeEntry: ComposerEntrySnapshot;
  adapter: NoteComposerAdapter;
  mergeCandidates: readonly ComposerEntrySnapshot[];
  onComplete?: (entryId: string) => void;
  selection: { end: number; start: number } | null;
}

export function VaultNoteComposer({
  activeEntry,
  adapter,
  mergeCandidates,
  onComplete,
  selection
}: VaultNoteComposerProps) {
  const availableTargets = useMemo(
    () => mergeCandidates.filter((candidate) => candidate.id !== activeEntry.id),
    [activeEntry.id, mergeCandidates]
  );
  const [mode, setMode] = useState<"split" | "merge">("split");
  const [newTitle, setNewTitle] = useState("");
  const [replaceWithLink, setReplaceWithLink] = useState(true);
  const [targetId, setTargetId] = useState("");
  const [trashSource, setTrashSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const tabIdPrefix = useId();
  const splitTabId = `${tabIdPrefix}-split-tab`;
  const mergeTabId = `${tabIdPrefix}-merge-tab`;
  const splitPanelId = `${tabIdPrefix}-split-panel`;
  const mergePanelId = `${tabIdPrefix}-merge-panel`;

  useEffect(() => {
    setNewTitle("");
    setTargetId("");
    setMessage("");
    setError("");
  }, [activeEntry.id, activeEntry.revision]);

  async function runSplit() {
    if (!selection) {
      setError("편집기에서 분리할 Markdown 범위를 먼저 선택해주세요.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const plan = planNoteSplit(activeEntry, {
        ...selection,
        newTitle,
        replaceSelectionWithLink: replaceWithLink
      });
      const result = await executeNoteSplit(plan, adapter);
      if (result.kind === "created-copy-source-unchanged") {
        setMessage(`새 노트는 보존했습니다. 원본 링크는 반영되지 않았습니다: ${result.reason}`);
      } else {
        setMessage("선택한 내용을 새 노트로 분리했습니다.");
      }
      onComplete?.(result.createdEntryId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "노트를 분리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function runMerge() {
    const target = availableTargets.find((candidate) => candidate.id === targetId);
    if (!target) {
      setError("합칠 대상 노트를 선택해주세요.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const plan = planNoteMerge(activeEntry, target, { trashSourceAfterMerge: trashSource });
      const result = await executeNoteMerge(plan, adapter);
      setMessage(result.kind === "merged-source-kept"
        ? `대상 노트에는 합쳤지만 원본은 보존했습니다: ${result.reason}`
        : "대상 노트에 내용을 합쳤습니다.");
      onComplete?.(target.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "노트를 합치지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function moveTabFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextMode = event.key === "ArrowLeft" || event.key === "Home" ? "split" : "merge";
    setMode(nextMode);
    window.setTimeout(() => document.getElementById(nextMode === "split" ? splitTabId : mergeTabId)?.focus(), 0);
  }

  return (
    <section aria-label="Note composer" className="vault-core-panel vault-note-composer">
      <header><Files aria-hidden="true" size={16} /><strong>Note composer</strong></header>
      <div className="vault-core-tabs" onKeyDown={moveTabFocus} role="tablist" aria-label="Note composer 작업">
        <button aria-controls={splitPanelId} aria-selected={mode === "split"} disabled={busy} id={splitTabId} onClick={() => setMode("split")} role="tab" tabIndex={mode === "split" ? 0 : -1} type="button">노트 분리</button>
        <button aria-controls={mergePanelId} aria-selected={mode === "merge"} disabled={busy} id={mergeTabId} onClick={() => setMode("merge")} role="tab" tabIndex={mode === "merge" ? 0 : -1} type="button">노트 합치기</button>
      </div>
      {mode === "split" ? (
        <div aria-labelledby={splitTabId} className="vault-note-composer__form" id={splitPanelId} role="tabpanel">
          <label>새 노트 이름<input disabled={busy} onChange={(event) => setNewTitle(event.currentTarget.value)} value={newTitle} /></label>
          <p>{selection ? `${selection.end - selection.start}자를 분리합니다.` : "편집기에서 분리할 범위를 선택해주세요."}</p>
          <label className="vault-core-check">
            <input checked={replaceWithLink} disabled={busy} onChange={(event) => setReplaceWithLink(event.currentTarget.checked)} type="checkbox" />
            원래 위치를 새 노트 링크로 바꾸기
          </label>
          <button disabled={busy || !selection} onClick={() => void runSplit()} type="button">
            <FileInput aria-hidden="true" size={14} /> {busy ? "분리 중…" : "새 노트로 분리"}
          </button>
        </div>
      ) : (
        <div aria-labelledby={mergeTabId} className="vault-note-composer__form" id={mergePanelId} role="tabpanel">
          <label>합칠 대상
            <select disabled={busy} onChange={(event) => setTargetId(event.currentTarget.value)} value={targetId}>
              <option value="">대상 선택</option>
              {availableTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
          </label>
          <label className="vault-core-check">
            <input checked={trashSource} disabled={busy} onChange={(event) => setTrashSource(event.currentTarget.checked)} type="checkbox" />
            병합이 끝난 뒤 원본을 휴지통으로 이동
          </label>
          <button disabled={busy || !targetId} onClick={() => void runMerge()} type="button">
            <Files aria-hidden="true" size={14} /> {busy ? "합치는 중…" : "대상 노트에 합치기"}
          </button>
        </div>
      )}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <small>dirty draft를 먼저 저장하고 revision을 다시 확인합니다. 부분 실패 시 원본을 삭제하지 않습니다.</small>
    </section>
  );
}
