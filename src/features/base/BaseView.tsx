import { createElement, Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { FrontmatterScalar, FrontmatterValue, VaultIndexEntry } from "../knowledge";
import {
  basePropertyDisplayName,
  formatBaseCellValue,
  materializeBaseView
} from "./engine";
import {
  BASE_MATERIALIZATION_WORKER_THRESHOLD,
  BASE_MATERIALIZATION_WORKER_TIMEOUT_MS,
  baseDocumentRequiresWorker,
  createBaseMaterializationWorker
} from "./materializationWorker";
import type {
  BaseMaterializationWorkerRequest,
  BaseMaterializationWorkerResponse
} from "./materializationRuntime";
import { parseBaseSource } from "./parser";
import type {
  BaseCellValue,
  BaseDiagnostic,
  BaseDocument,
  BaseEvaluationContext,
  BaseMaterializedView,
  BaseMetadata,
  BaseResultGroup,
  BaseResultRow,
  BaseViewConfig
} from "./types";
import "./base.css";

export interface BaseViewProps {
  evaluationContext?: BaseEvaluationContext;
  entries: readonly VaultIndexEntry[];
  initialViewName?: string;
  metadataByEntryId: ReadonlyMap<string, BaseMetadata>;
  onEditProperty?: (
    entryId: string,
    property: string,
    value: FrontmatterValue
  ) => void | Promise<void>;
  onOpenEntry?: (entryId: string) => void;
  readOnlyEntryIds?: ReadonlySet<string>;
  source: string;
}

const EDITABLE_PROPERTY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function editablePropertyName(property: string, metadata: BaseMetadata): string | null {
  const normalized = property.trim();
  const lower = normalized.toLocaleLowerCase();
  if (lower.startsWith("file.") || lower.startsWith("formula.")) {
    return null;
  }
  const candidate = normalized.replace(/^note\./iu, "");
  const existing = Object.keys(metadata.properties).find(
    (key) => key.toLocaleLowerCase() === candidate.toLocaleLowerCase()
  );
  const key = existing ?? candidate;
  return EDITABLE_PROPERTY_PATTERN.test(key) ? key : null;
}

function scalarEditorValue(value: FrontmatterScalar): string {
  return value === null ? "null" : String(value);
}

function propertyEditorValue(value: FrontmatterValue | undefined): string {
  if (Array.isArray(value)) {
    return value.map(scalarEditorValue).join(", ");
  }
  return value === undefined ? "" : scalarEditorValue(value);
}

function parseScalarLike(rawValue: string, previousValue: FrontmatterScalar): FrontmatterScalar {
  if (typeof previousValue === "number") {
    const parsed = Number(rawValue.trim());
    if (!rawValue.trim() || !Number.isFinite(parsed)) {
      throw new Error("숫자 속성에는 유효한 숫자를 입력해주세요.");
    }
    return parsed;
  }
  if (typeof previousValue === "boolean") {
    const normalized = rawValue.trim().toLocaleLowerCase();
    if (normalized !== "true" && normalized !== "false") {
      throw new Error("불리언 배열 값은 true 또는 false로 입력해주세요.");
    }
    return normalized === "true";
  }
  if (previousValue === null) {
    if (rawValue.trim().toLocaleLowerCase() !== "null") {
      throw new Error("null 배열 값은 null로 유지해야 합니다.");
    }
    return null;
  }
  return rawValue.trim();
}

function parsePropertyDraft(rawValue: string, previousValue: FrontmatterValue | undefined): FrontmatterValue {
  if (Array.isArray(previousValue)) {
    if (!rawValue.trim()) return [];
    const values = rawValue.split(",").map((item) => item.trim());
    const fallback = previousValue.find((item) => item !== null) ?? previousValue[0] ?? "";
    return values.map((item, index) => parseScalarLike(item, previousValue[index] ?? fallback));
  }
  if (typeof previousValue === "number") {
    return parseScalarLike(rawValue, previousValue);
  }
  if (previousValue === null) {
    return parseScalarLike(rawValue, previousValue);
  }
  return rawValue;
}
function useParsedBase(source: string) {
  return useMemo(() => parseBaseSource(source), [source]);
}

function useMaterializedBase(
  document: BaseDocument | null,
  view: BaseViewConfig | undefined,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, BaseMetadata>,
  evaluationContext: BaseEvaluationContext | undefined
) {
  const requestIdRef = useRef(0);
  const inputToken = useMemo(
    () => ({ document, entries, evaluationContext, metadataByEntryId, view }),
    [document, entries, evaluationContext, metadataByEntryId, view]
  );
  const [workerState, setWorkerState] = useState<{
    error: boolean;
    pending: boolean;
    requestId: number;
    result: BaseMaterializedView | null;
    token: object | null;
  }>({ error: false, pending: false, requestId: 0, result: null, token: null });
  const useWorker = Boolean(
    document
    && view
    && (
      entries.length > BASE_MATERIALIZATION_WORKER_THRESHOLD
      || baseDocumentRequiresWorker(document)
    )
  );
  const synchronous = useMemo(
    () => document && view && !useWorker
      ? materializeBaseView(document, view, entries, metadataByEntryId, evaluationContext)
      : null,
    [document, entries, evaluationContext, metadataByEntryId, useWorker, view]
  );

  useEffect(() => {
    if (!document || !view || !useWorker) {
      return undefined;
    }

    const requestId = ++requestIdRef.current;
    let worker: Worker;
    let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      worker = createBaseMaterializationWorker();
    } catch {
      setWorkerState({ error: true, pending: false, requestId, result: null, token: inputToken });
      return undefined;
    }
    setWorkerState({ error: false, pending: true, requestId, result: null, token: inputToken });
    worker.onmessage = (event: MessageEvent<BaseMaterializationWorkerResponse>) => {
      if (event.data.id !== requestId || requestIdRef.current !== requestId) return;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      setWorkerState({
        error: !event.data.ok,
        pending: false,
        requestId,
        result: event.data.ok ? event.data.result : null,
        token: inputToken
      });
    };
    worker.onerror = () => {
      if (requestIdRef.current !== requestId) return;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      setWorkerState({ error: true, pending: false, requestId, result: null, token: inputToken });
    };
    const request: BaseMaterializationWorkerRequest = {
      id: requestId,
      document,
      entries: [...entries],
      context: evaluationContext,
      metadataEntries: [...metadataByEntryId.entries()],
      view
    };
    worker.postMessage(request);
    timeoutId = setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      requestIdRef.current += 1;
      worker.terminate();
      setWorkerState({ error: true, pending: false, requestId, result: null, token: inputToken });
    }, BASE_MATERIALIZATION_WORKER_TIMEOUT_MS);

    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (requestIdRef.current === requestId) requestIdRef.current += 1;
      worker.terminate();
    };
  }, [document, entries, evaluationContext, inputToken, metadataByEntryId, useWorker, view]);

  if (!useWorker) {
    return { error: false, pending: false, result: synchronous };
  }
  if (workerState.token !== inputToken) {
    return { error: false, pending: true, result: null };
  }
  return {
    error: workerState.error,
    pending: workerState.pending,
    result: workerState.result
  };
}

export function BaseView({
  evaluationContext,
  entries,
  initialViewName,
  metadataByEntryId,
  onEditProperty,
  onOpenEntry,
  readOnlyEntryIds,
  source
}: BaseViewProps) {
  const parsed = useParsedBase(source);
  const [selectedViewName, setSelectedViewName] = useState(initialViewName ?? "");
  const selectedView = parsed.document?.views.find((view) => view.name === selectedViewName)
    ?? parsed.document?.views.find((view) => view.name === initialViewName)
    ?? parsed.document?.views[0];
  const materialization = useMaterializedBase(
    parsed.document,
    selectedView,
    entries,
    metadataByEntryId,
    evaluationContext
  );

  if (parsed.document && selectedView && materialization.pending) {
    return (
      <section aria-label={`${selectedView.name} Base`} aria-busy="true" className="qm-base">
        <p className="qm-base-empty" role="status">대형 Base를 안전하게 계산하는 중입니다…</p>
      </section>
    );
  }

  if (!parsed.document || !selectedView || !materialization.result) {
    return (
      <section aria-label="Base" className="qm-base qm-base-error">
        <h2>Base를 열 수 없습니다</h2>
        {materialization.error ? (
          <p role="alert">대형 Base 계산 worker를 시작하지 못했습니다. 원본 Base 파일은 변경하지 않았습니다.</p>
        ) : <Diagnostics diagnostics={parsed.errors} />}
      </section>
    );
  }

  const materialized = materialization.result;
  const diagnostics = [...parsed.warnings, ...materialized.warnings];
  return (
    <section aria-label={`${selectedView.name} Base`} className="qm-base">
      <header className="qm-base-toolbar">
        <label>
          <span>보기</span>
          <select
            aria-label="Base 보기"
            onChange={(event) => setSelectedViewName(event.currentTarget.value)}
            value={selectedView.name}
          >
            {parsed.document.views.map((view) => (
              <option key={`${view.type}:${view.name}`} value={view.name}>{view.name}</option>
            ))}
          </select>
        </label>
        <output aria-live="polite">결과 {materialized.resultCount}개</output>
      </header>

      {diagnostics.length ? (
        <details className="qm-base-diagnostics">
          <summary>호환성 안내 {diagnostics.length}개</summary>
          <Diagnostics diagnostics={diagnostics} />
        </details>
      ) : null}

      <BaseResult
        document={parsed.document}
        onEditProperty={onEditProperty}
        onOpenEntry={onOpenEntry}
        readOnlyEntryIds={readOnlyEntryIds}
        view={materialized}
      />
    </section>
  );
}

function Diagnostics({ diagnostics }: { diagnostics: readonly BaseDiagnostic[] }) {
  return (
    <ul aria-label="Base 진단" role="status">
      {diagnostics.map((item, index) => (
        <li key={`${item.code}:${item.path ?? "root"}:${index}`}>
          {item.path ? <code>{item.path}</code> : null} {item.message}
        </li>
      ))}
    </ul>
  );
}

const SAFE_BASE_HTML_TAGS = new Set([
  "b", "br", "code", "del", "em", "i", "kbd", "mark", "p", "s", "small", "span", "strong", "sub", "sup", "u"
]);
const MAXIMUM_BASE_HTML_NODES = 1_000;
const MAXIMUM_BASE_HTML_DEPTH = 16;

function renderSafeHtml(source: string): ReactNode {
  if (typeof DOMParser === "undefined") return source;
  const parsed = new DOMParser().parseFromString(`<body>${source}</body>`, "text/html");
  let nodeCount = 0;
  const render = (node: Node, key: string, depth: number): ReactNode => {
    nodeCount += 1;
    if (nodeCount > MAXIMUM_BASE_HTML_NODES || depth > MAXIMUM_BASE_HTML_DEPTH) return null;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return null;
    const tag = node.tagName.toLocaleLowerCase();
    const children = [...node.childNodes].map((child, index) => render(child, `${key}:${index}`, depth + 1));
    if (tag === "a") {
      const href = node.getAttribute("href")?.trim() ?? "";
      if (/^https?:\/\//iu.test(href)) {
        return <a href={href} key={key} rel="noopener noreferrer" target="_blank">{children}</a>;
      }
      return <Fragment key={key}>{children}</Fragment>;
    }
    if (!SAFE_BASE_HTML_TAGS.has(tag)) return <Fragment key={key}>{children}</Fragment>;
    return createElement(tag, { key }, children);
  };
  return [...parsed.body.childNodes].map((node, index) => render(node, `html:${index}`, 0));
}

function BaseCellDisplay({
  onOpenEntry,
  value
}: {
  onOpenEntry?: (entryId: string) => void;
  value: BaseCellValue;
}) {
  if (Array.isArray(value)) {
    return <>{value.map((item, index) => (
      <Fragment key={index}>{index ? ", " : null}<BaseCellDisplay onOpenEntry={onOpenEntry} value={item} /></Fragment>
    ))}</>;
  }
  if (!value || typeof value !== "object") return <>{formatBaseCellValue(value)}</>;
  switch (value.__baseType) {
    case "html": return <span className="qm-base-safe-html">{renderSafeHtml(value.source)}</span>;
    case "icon": return <span aria-label={`아이콘 ${value.name}`} className="qm-base-icon" role="img">✦</span>;
    case "image": return value.external
      ? <a className="qm-base-image-value" href={value.path} rel="noopener noreferrer" target="_blank">이미지 열기</a>
      : <span className="qm-base-image-value" title={value.path}>이미지 · {value.path}</span>;
    case "link": {
      const entryId = value.entryId;
      const label = value.display === undefined
        ? value.path
        : <BaseCellDisplay onOpenEntry={onOpenEntry} value={value.display} />;
      return value.external
        ? <a href={value.path} rel="noopener noreferrer" target="_blank">{label}</a>
        : entryId && onOpenEntry
          ? <button className="qm-base-link-value" onClick={() => onOpenEntry(entryId)} type="button">{label}</button>
          : <span className="qm-base-link-value">{label}</span>;
    }
    default: return <>{formatBaseCellValue(value)}</>;
  }
}

function BaseResult({
  document,
  onEditProperty,
  onOpenEntry,
  readOnlyEntryIds,
  view
}: {
  document: BaseDocument;
  onEditProperty?: BaseViewProps["onEditProperty"];
  onOpenEntry?: (entryId: string) => void;
  readOnlyEntryIds?: ReadonlySet<string>;
  view: BaseMaterializedView;
}) {
  if (!view.resultCount) {
    return <p className="qm-base-empty" role="status">조건에 맞는 파일이 없습니다.</p>;
  }
  return (
    <>
      <div className="qm-base-groups">
        {view.groups.map((group) => (
          <section aria-label={group.label || view.name} className="qm-base-group" key={group.key}>
            {group.label ? <h3>{group.label}</h3> : null}
            {view.type === "table" ? (
              <BaseTable document={document} group={group} onEditProperty={onEditProperty} onOpenEntry={onOpenEntry} readOnlyEntryIds={readOnlyEntryIds} view={view} />
            ) : view.type === "cards" ? (
              <BaseCards document={document} group={group} onEditProperty={onEditProperty} onOpenEntry={onOpenEntry} readOnlyEntryIds={readOnlyEntryIds} view={view} />
            ) : (
              <BaseList document={document} group={group} onEditProperty={onEditProperty} onOpenEntry={onOpenEntry} readOnlyEntryIds={readOnlyEntryIds} view={view} />
            )}
          </section>
        ))}
      </div>
      {view.summaries.length ? (
        <dl aria-label="Base 요약" className="qm-base-summaries">
          {view.summaries.map((summary) => (
            <div key={`${summary.property}:${summary.name}`}>
              <dt>{basePropertyDisplayName(document, summary.property)} · {summary.name}</dt>
              <dd><BaseCellDisplay onOpenEntry={onOpenEntry} value={summary.value} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

function EntryControl({ row, onOpenEntry }: { row: BaseResultRow; onOpenEntry?: (entryId: string) => void }) {
  const label = formatBaseCellValue(row.cells["file.name"] ?? row.entry.path);
  return onOpenEntry ? (
    <button className="qm-base-entry" onClick={() => onOpenEntry(row.entry.id)} type="button">{label}</button>
  ) : <span className="qm-base-entry-label">{label}</span>;
}

function BasePropertyControl({
  displayName,
  onEditProperty,
  onOpenEntry,
  property,
  readOnly,
  row
}: {
  displayName: string;
  onEditProperty?: BaseViewProps["onEditProperty"];
  onOpenEntry?: (entryId: string) => void;
  property: string;
  readOnly?: boolean;
  row: BaseResultRow;
}) {
  const errorId = useId();
  const propertyName = editablePropertyName(property, row.metadata);
  const currentValue = propertyName ? row.metadata.properties[propertyName] : undefined;
  const currentEditorValue = propertyEditorValue(currentValue);
  const [draft, setDraft] = useState(() => currentEditorValue);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const commitGenerationRef = useRef(0);
  const entryName = formatBaseCellValue(row.cells["file.name"] ?? row.entry.path);
  const label = `${entryName} — ${displayName} 속성`;

  useEffect(() => {
    setDraft(currentEditorValue);
    setError("");
  }, [currentEditorValue]);

  if (!onEditProperty || !propertyName || readOnly) {
    return <BaseCellDisplay onOpenEntry={onOpenEntry} value={row.cells[property]} />;
  }

  const commit = async (nextValue?: FrontmatterValue) => {
    const generation = ++commitGenerationRef.current;
    try {
      const value = nextValue ?? parsePropertyDraft(draft, currentValue);
      if (propertyEditorValue(value) === currentEditorValue) {
        setError("");
        return;
      }
      setPending(true);
      setError("");
      await onEditProperty(row.entry.id, propertyName, value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "속성을 수정하지 못했습니다.");
    } finally {
      if (commitGenerationRef.current === generation) {
        setPending(false);
      }
    }
  };

  if (typeof currentValue === "boolean") {
    return (
      <span className="qm-base-property-editor">
        <input
          aria-describedby={error ? errorId : undefined}
          aria-label={label}
          checked={draft === "true"}
          disabled={pending}
          onChange={(event) => {
            const value = event.currentTarget.checked;
            setDraft(String(value));
            void commit(value);
          }}
          type="checkbox"
        />
        {error ? <small id={errorId} role="alert">{error}</small> : null}
      </span>
    );
  }

  return (
    <span className="qm-base-property-editor">
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? "true" : undefined}
        aria-label={label}
        aria-busy={pending || undefined}
        inputMode={typeof currentValue === "number" ? "decimal" : undefined}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value.replace(/[\r\n]/gu, " ");
          setDraft(nextDraft);
          try {
            parsePropertyDraft(nextDraft, currentValue);
            setError("");
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "속성을 수정하지 못했습니다.");
          }
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(currentEditorValue);
            setError("");
            event.currentTarget.blur();
          }
        }}
        type={typeof currentValue === "number" ? "number" : "text"}
        value={draft}
      />
      {Array.isArray(currentValue) ? <small>쉼표로 구분</small> : null}
      {error ? <small id={errorId} role="alert">{error}</small> : null}
    </span>
  );
}

function BaseTable({
  document,
  group,
  onEditProperty,
  onOpenEntry,
  readOnlyEntryIds,
  view
}: {
  document: BaseDocument;
  group: BaseResultGroup;
  onEditProperty?: BaseViewProps["onEditProperty"];
  onOpenEntry?: (entryId: string) => void;
  readOnlyEntryIds?: ReadonlySet<string>;
  view: BaseMaterializedView;
}) {
  return (
    <div className="qm-base-table-scroll" tabIndex={0}>
      <table>
        <caption className="sr-only">{view.name}{group.label ? ` — ${group.label}` : ""}</caption>
        <thead>
          <tr>{view.columns.map((property) => <th key={property} scope="col">{basePropertyDisplayName(document, property)}</th>)}</tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr key={row.entry.id}>
              {view.columns.map((property) => (
                <td key={property}>
                  {property === "file.name"
                    ? <EntryControl onOpenEntry={onOpenEntry} row={row} />
                    : <BasePropertyControl
                        displayName={basePropertyDisplayName(document, property)}
                        onEditProperty={onEditProperty}
                        onOpenEntry={onOpenEntry}
                        property={property}
                        readOnly={row.entry.kind !== "markdown" || readOnlyEntryIds?.has(row.entry.id)}
                        row={row}
                      />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BaseCards({
  document,
  group,
  onEditProperty,
  onOpenEntry,
  readOnlyEntryIds,
  view
}: {
  document: BaseDocument;
  group: BaseResultGroup;
  onEditProperty?: BaseViewProps["onEditProperty"];
  onOpenEntry?: (entryId: string) => void;
  readOnlyEntryIds?: ReadonlySet<string>;
  view: BaseMaterializedView;
}) {
  return (
    <ul aria-label={`${view.name} 카드`} className="qm-base-cards">
      {group.rows.map((row) => (
        <li key={row.entry.id}>
          <article>
            <h4><EntryControl onOpenEntry={onOpenEntry} row={row} /></h4>
            <dl>
              {view.columns.filter((property) => property !== "file.name").map((property) => (
                <div key={property}>
                  <dt>{basePropertyDisplayName(document, property)}</dt>
                  <dd>
                    <BasePropertyControl
                      displayName={basePropertyDisplayName(document, property)}
                      onEditProperty={onEditProperty}
                      onOpenEntry={onOpenEntry}
                      property={property}
                      readOnly={row.entry.kind !== "markdown" || readOnlyEntryIds?.has(row.entry.id)}
                      row={row}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        </li>
      ))}
    </ul>
  );
}

function BaseList({
  document,
  group,
  onEditProperty,
  onOpenEntry,
  readOnlyEntryIds,
  view
}: {
  document: BaseDocument;
  group: BaseResultGroup;
  onEditProperty?: BaseViewProps["onEditProperty"];
  onOpenEntry?: (entryId: string) => void;
  readOnlyEntryIds?: ReadonlySet<string>;
  view: BaseMaterializedView;
}) {
  return (
    <ul aria-label={`${view.name} 목록`} className="qm-base-list">
      {group.rows.map((row) => (
        <li key={row.entry.id}>
          <EntryControl onOpenEntry={onOpenEntry} row={row} />
          <span>
            {view.columns.filter((property) => property !== "file.name").map((property) => (
              <span className="qm-base-list-property" key={property}>
                <strong>{basePropertyDisplayName(document, property)}</strong>{" "}
                <BasePropertyControl
                  displayName={basePropertyDisplayName(document, property)}
                  onEditProperty={onEditProperty}
                  onOpenEntry={onOpenEntry}
                  property={property}
                  readOnly={row.entry.kind !== "markdown" || readOnlyEntryIds?.has(row.entry.id)}
                  row={row}
                />
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
