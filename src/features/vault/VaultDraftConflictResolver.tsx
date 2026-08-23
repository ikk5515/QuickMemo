import { AlertTriangle, GitMerge, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import {
  buildMarkdownMergePlan,
  combineMarkdownConflictVersions,
  type MarkdownMergeChoice,
  type MarkdownMergeResolution,
  resolveMarkdownMergePlan
} from "./markdownThreeWayMerge";
import { MAX_VAULT_BODY_CHARACTERS } from "./vaultPayloadLimits";
import "./vaultDraftConflictResolver.css";

const MAX_CONFLICT_PREVIEW_CHARACTERS = 6_000;

const limitMessage = {
  "input-too-large": "비교할 문서가 1MB 제한을 넘어 자동 비교를 중단했습니다.",
  "too-many-lines": "비교할 문서의 줄 수가 안전 한도를 넘어 자동 비교를 중단했습니다.",
  "time-budget": "제한된 시간 안에 안전한 자동 병합을 확인하지 못했습니다.",
  "work-budget": "비교 작업량이 안전 한도를 넘어 자동 병합을 중단했습니다."
} as const;

const choiceLabels: Array<{ choice: MarkdownMergeChoice; label: string }> = [
  { choice: "local", label: "내 편집본" },
  { choice: "remote", label: "서버 최신본" },
  { choice: "both", label: "둘 다 보존" },
  { choice: "manual", label: "직접 편집" }
];

export interface VaultDraftConflictResolutionSummary {
  automatic: boolean;
  conflictCount: number;
  usedManualResolution: boolean;
}

export interface VaultDraftConflictResolverProps {
  baseMarkdown: string;
  busy?: boolean;
  localMarkdown: string;
  onCancel: () => void;
  onResolve: (
    mergedMarkdown: string,
    summary: VaultDraftConflictResolutionSummary
  ) => Promise<void> | void;
  remoteMarkdown: string;
}

interface ScopedMergeResolutions {
  baseMarkdown: string;
  localMarkdown: string;
  remoteMarkdown: string;
  values: Record<number, MarkdownMergeResolution>;
}

function previewText(value: string) {
  if (value.length <= MAX_CONFLICT_PREVIEW_CHARACTERS) return value;
  return `${value.slice(0, MAX_CONFLICT_PREVIEW_CHARACTERS)}\n… 미리보기 생략 …`;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"
  )).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

export function VaultDraftConflictResolver({
  baseMarkdown,
  busy = false,
  localMarkdown,
  onCancel,
  onResolve,
  remoteMarkdown
}: VaultDraftConflictResolverProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [resolutionState, setResolutionState] = useState<ScopedMergeResolutions>({
    baseMarkdown,
    localMarkdown,
    remoteMarkdown,
    values: {}
  });
  const plan = useMemo(
    () => buildMarkdownMergePlan(baseMarkdown, localMarkdown, remoteMarkdown),
    [baseMarkdown, localMarkdown, remoteMarkdown]
  );
  const resolutions = resolutionState.baseMarkdown === baseMarkdown
    && resolutionState.localMarkdown === localMarkdown
    && resolutionState.remoteMarkdown === remoteMarkdown
    ? resolutionState.values
    : {};
  const disabled = busy || applying;

  useEffect(() => {
    generationRef.current += 1;
    setApplying(false);
    setError("");
    setResolutionState({ baseMarkdown, localMarkdown, remoteMarkdown, values: {} });
  }, [baseMarkdown, localMarkdown, remoteMarkdown]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  function choose(conflictIndex: number, choice: MarkdownMergeChoice) {
    const conflict = plan.conflicts[conflictIndex];
    const canInitializeBoth = Boolean(
      conflict
      && conflict.localText.length + conflict.remoteText.length + 1 <= MAX_VAULT_BODY_CHARACTERS
    );
    setError(choice === "manual" && !canInitializeBoth
      ? "두 원문을 한 번에 편집기에 넣으면 저장 한도를 넘습니다. 미리보기를 참고해 필요한 부분만 직접 작성해주세요."
      : "");
    setResolutionState((current) => {
      const currentValues = current.baseMarkdown === baseMarkdown
        && current.localMarkdown === localMarkdown
        && current.remoteMarkdown === remoteMarkdown
        ? current.values
        : {};
      return {
        baseMarkdown,
        localMarkdown,
        remoteMarkdown,
        values: {
          ...currentValues,
          [conflictIndex]: choice === "manual"
            ? {
                choice,
                manualText: canInitializeBoth && conflict
                  ? combineMarkdownConflictVersions(conflict.localText, conflict.remoteText)
                  : ""
              }
            : { choice }
        }
      };
    });
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !disabled) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function applyResolution() {
    if (disabled) return;
    const result = resolveMarkdownMergePlan(plan, resolutions);
    if (result.status === "unresolved") {
      setError(`충돌 ${result.conflictIndexes.map((index) => index + 1).join(", ")}의 보존 방법을 선택해주세요.`);
      return;
    }
    if (result.status === "output-too-large") {
      setError(`병합 결과가 저장 한도 ${Math.floor(result.maxBytes / 1_000)}KB를 넘습니다. 직접 편집해 크기를 줄여주세요.`);
      return;
    }
    const generation = generationRef.current;
    setApplying(true);
    setError("");
    try {
      await onResolve(result.markdown, {
        automatic: plan.conflicts.length === 0,
        conflictCount: plan.conflicts.length,
        usedManualResolution: Object.values(resolutions).some((resolution) => resolution.choice === "manual")
      });
    } catch {
      if (generationRef.current === generation) {
        setError("병합본을 저장하지 못했습니다. 서버 최신 상태를 다시 확인한 뒤 재시도해주세요.");
      }
    } finally {
      if (generationRef.current === generation) setApplying(false);
    }
  }

  return (
    <div className="vault-draft-conflict-backdrop">
      <div
        aria-busy={disabled}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="vault-draft-conflict-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <span aria-hidden="true" className="vault-draft-conflict-icon"><GitMerge size={19} /></span>
          <div>
            <h2 id={titleId}>편집 충돌 안전 병합</h2>
            <p id={descriptionId}>내 편집본과 서버 최신본을 비교했습니다. 선택하기 전에는 어느 쪽도 덮어쓰지 않습니다.</p>
          </div>
          <button
            aria-label="편집 충돌 병합 닫기"
            disabled={disabled}
            onClick={onCancel}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        {plan.limitReason ? (
          <div className="vault-draft-conflict-warning" role="alert">
            <AlertTriangle aria-hidden="true" size={17} />
            <p>{limitMessage[plan.limitReason]} 자동 추측 대신 문서 전체에서 보존할 버전을 직접 선택합니다.</p>
          </div>
        ) : plan.conflicts.length ? (
          <p className="vault-draft-conflict-status" role="status">
            충돌 {plan.conflicts.length}곳이 남았습니다. 충돌하지 않는 변경은 이미 자동으로 합쳤습니다.
          </p>
        ) : (
          <p className="vault-draft-conflict-status is-ready" role="status">
            충돌하지 않는 변경을 안전하게 자동 병합했습니다. 적용 전까지 서버에는 저장하지 않습니다.
          </p>
        )}

        <div className="vault-draft-conflict-list">
          {plan.conflicts.map((conflict) => {
            const resolution = resolutions[conflict.index];
            const legendId = `${titleId}-conflict-${conflict.index}`;
            return (
              <fieldset className="vault-draft-conflict-item" key={conflict.index}>
                <legend id={legendId}>충돌 {conflict.index + 1}</legend>
                <div className="vault-draft-conflict-versions">
                  <section aria-label={`충돌 ${conflict.index + 1} 내 편집본`}>
                    <strong>내 편집본</strong>
                    <pre>{previewText(conflict.localText)}</pre>
                    {conflict.localText.length > MAX_CONFLICT_PREVIEW_CHARACTERS ? <small>화면 미리보기만 줄였으며 선택 시 원문 전체를 보존합니다.</small> : null}
                  </section>
                  <section aria-label={`충돌 ${conflict.index + 1} 서버 최신본`}>
                    <strong>서버 최신본</strong>
                    <pre>{previewText(conflict.remoteText)}</pre>
                    {conflict.remoteText.length > MAX_CONFLICT_PREVIEW_CHARACTERS ? <small>화면 미리보기만 줄였으며 선택 시 원문 전체를 보존합니다.</small> : null}
                  </section>
                </div>
                <details>
                  <summary>공통 기준본 보기</summary>
                  <pre>{previewText(conflict.baseText)}</pre>
                  {conflict.baseText.length > MAX_CONFLICT_PREVIEW_CHARACTERS ? <small>기준본 미리보기는 6,000자까지만 표시합니다.</small> : null}
                </details>
                <div aria-labelledby={legendId} className="vault-draft-conflict-choices" role="radiogroup">
                  {choiceLabels.map(({ choice, label }) => (
                    <label key={choice}>
                      <input
                        checked={resolution?.choice === choice}
                        disabled={disabled}
                        name={`${titleId}-choice-${conflict.index}`}
                        onChange={() => choose(conflict.index, choice)}
                        type="radio"
                        value={choice}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                {resolution?.choice === "manual" ? (
                  <label className="vault-draft-conflict-manual">
                    <span>직접 편집한 병합 내용</span>
                    <textarea
                      disabled={disabled}
                      onChange={(event) => {
                        const manualText = event.target.value;
                        setResolutionState((current) => ({
                          baseMarkdown,
                          localMarkdown,
                          remoteMarkdown,
                          values: {
                            ...(current.baseMarkdown === baseMarkdown
                              && current.localMarkdown === localMarkdown
                              && current.remoteMarkdown === remoteMarkdown
                              ? current.values
                              : {}),
                            [conflict.index]: { choice: "manual", manualText }
                          }
                        }));
                      }}
                      spellCheck="false"
                      value={resolution.manualText ?? ""}
                    />
                  </label>
                ) : null}
              </fieldset>
            );
          })}
        </div>

        {error ? <p className="vault-draft-conflict-error" role="alert">{error}</p> : null}
        <footer>
          <p>적용 시 서버 최신 revision을 다시 확인하고, 일치할 때만 새 revision으로 저장해야 합니다.</p>
          <div>
            <button disabled={disabled} onClick={onCancel} type="button">취소</button>
            <button className="primary" disabled={disabled} onClick={() => void applyResolution()} type="button">
              {applying ? "안전 저장 중…" : plan.conflicts.length ? "선택한 병합본 적용" : "자동 병합본 적용"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
