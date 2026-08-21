import { useMemo, useState } from "react";
import type { ParsedMarkdownMetadata, VaultIndexEntry } from "../knowledge";
import {
  basePropertyDisplayName,
  formatBaseCellValue,
  materializeBaseView
} from "./engine";
import { parseBaseSource } from "./parser";
import type {
  BaseDiagnostic,
  BaseDocument,
  BaseMaterializedView,
  BaseResultGroup,
  BaseResultRow,
  BaseViewConfig
} from "./types";
import "./base.css";

export interface BaseViewProps {
  entries: readonly VaultIndexEntry[];
  initialViewName?: string;
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>;
  onOpenEntry?: (entryId: string) => void;
  source: string;
}
function useParsedBase(source: string) {
  return useMemo(() => parseBaseSource(source), [source]);
}

function useMaterializedBase(
  document: BaseDocument | null,
  view: BaseViewConfig | undefined,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>
) {
  return useMemo(
    () => document && view
      ? materializeBaseView(document, view, entries, metadataByEntryId)
      : null,
    [document, entries, metadataByEntryId, view]
  );
}

export function BaseView({
  entries,
  initialViewName,
  metadataByEntryId,
  onOpenEntry,
  source
}: BaseViewProps) {
  const parsed = useParsedBase(source);
  const [selectedViewName, setSelectedViewName] = useState(initialViewName ?? "");
  const selectedView = parsed.document?.views.find((view) => view.name === selectedViewName)
    ?? parsed.document?.views.find((view) => view.name === initialViewName)
    ?? parsed.document?.views[0];
  const materialized = useMaterializedBase(parsed.document, selectedView, entries, metadataByEntryId);

  if (!parsed.document || !selectedView || !materialized) {
    return (
      <section aria-label="Base" className="qm-base qm-base-error">
        <h2>Base를 열 수 없습니다</h2>
        <Diagnostics diagnostics={parsed.errors} />
      </section>
    );
  }

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
        onOpenEntry={onOpenEntry}
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

function BaseResult({
  document,
  onOpenEntry,
  view
}: {
  document: BaseDocument;
  onOpenEntry?: (entryId: string) => void;
  view: BaseMaterializedView;
}) {
  if (!view.resultCount) {
    return <p className="qm-base-empty" role="status">조건에 맞는 Markdown 노트가 없습니다.</p>;
  }
  return (
    <div className="qm-base-groups">
      {view.groups.map((group) => (
        <section aria-label={group.label || view.name} className="qm-base-group" key={group.key}>
          {group.label ? <h3>{group.label}</h3> : null}
          {view.type === "table" ? (
            <BaseTable document={document} group={group} onOpenEntry={onOpenEntry} view={view} />
          ) : view.type === "cards" ? (
            <BaseCards document={document} group={group} onOpenEntry={onOpenEntry} view={view} />
          ) : (
            <BaseList document={document} group={group} onOpenEntry={onOpenEntry} view={view} />
          )}
        </section>
      ))}
    </div>
  );
}

function EntryControl({ row, onOpenEntry }: { row: BaseResultRow; onOpenEntry?: (entryId: string) => void }) {
  const label = formatBaseCellValue(row.cells["file.name"] ?? row.entry.path);
  return onOpenEntry ? (
    <button className="qm-base-entry" onClick={() => onOpenEntry(row.entry.id)} type="button">{label}</button>
  ) : <span className="qm-base-entry-label">{label}</span>;
}

function BaseTable({
  document,
  group,
  onOpenEntry,
  view
}: {
  document: BaseDocument;
  group: BaseResultGroup;
  onOpenEntry?: (entryId: string) => void;
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
                    : formatBaseCellValue(row.cells[property])}
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
  onOpenEntry,
  view
}: {
  document: BaseDocument;
  group: BaseResultGroup;
  onOpenEntry?: (entryId: string) => void;
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
                  <dd>{formatBaseCellValue(row.cells[property])}</dd>
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
  onOpenEntry,
  view
}: {
  document: BaseDocument;
  group: BaseResultGroup;
  onOpenEntry?: (entryId: string) => void;
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
                <strong>{basePropertyDisplayName(document, property)}</strong> {formatBaseCellValue(row.cells[property])}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
