import { useMemo } from "react";
import {
  basePropertyDisplayName,
  formatBaseCellValue,
  materializeBaseView
} from "../base";
import type { BaseCellValue, BaseMetadata, BaseResultGroup } from "../base";
import type { VaultIndexEntry } from "../knowledge";
import { parseDataviewQuery } from "./query";
import { iterateDataviewTasks, type DataviewTask } from "./task";
import "./dataview.css";

// Filtering and sorting currently happen on the main thread. Never slice the
// input before filtering: that would make a syntactically valid report silently
// omit matches outside the prefix. Until worker evaluation is available, fail
// closed above this bound and render no partial result.
export const MAX_DATAVIEW_INPUT_ENTRIES = 500;
export const MAX_DATAVIEW_TASK_SOURCE_CHARACTERS = 2_000_000;
export const MAX_DATAVIEW_TASK_RESULTS = 2_000;

export interface DataviewBlockProps {
  canToggleTask?: (entryId: string) => boolean;
  entries: readonly VaultIndexEntry[];
  metadataByEntryId: ReadonlyMap<string, BaseMetadata>;
  onOpenEntry?: (entryId: string) => void;
  onToggleTask?: (
    entryId: string,
    line: number,
    checked: boolean,
    expected: DataviewTask
  ) => void | Promise<void>;
  source: string;
}

function calendarDateKey(value: BaseCellValue): string | null {
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/u.exec(value.trim());
    return match?.[1] ?? null;
  }
  if (value && !Array.isArray(value) && typeof value === "object" && value.__baseType === "date") {
    try {
      return new Date(value.epochMs).toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }
  return null;
}

function ResultGroupHeading({ group }: { group: BaseResultGroup }) {
  return group.label ? <h3>{group.label}</h3> : null;
}

interface MaterializedTaskGroup extends BaseResultGroup {
  tasks: Array<{ entry: VaultIndexEntry; task: DataviewTask }>;
}

function materializeTaskGroups(
  groups: readonly BaseResultGroup[],
  filter: { completed?: boolean; textContains?: string } | undefined
): { groups: MaterializedTaskGroup[]; overflow: boolean; total: number } {
  const output: MaterializedTaskGroup[] = [];
  let total = 0;
  for (const group of groups) {
    const tasks: MaterializedTaskGroup["tasks"] = [];
    for (const row of group.rows) {
      for (const task of iterateDataviewTasks(row.entry.content ?? "")) {
        if (
          (filter?.completed !== undefined && task.checked !== filter.completed)
          || (filter?.textContains
            && !task.text.toLocaleLowerCase().includes(filter.textContains.toLocaleLowerCase()))
        ) continue;
        total += 1;
        if (total > MAX_DATAVIEW_TASK_RESULTS) return { groups: [], overflow: true, total };
        tasks.push({ entry: row.entry, task });
      }
    }
    output.push({ ...group, tasks });
  }
  return { groups: output, overflow: false, total };
}

export function DataviewBlock({
  canToggleTask,
  entries,
  metadataByEntryId,
  onOpenEntry,
  onToggleTask,
  source
}: DataviewBlockProps) {
  const parsed = useMemo(() => parseDataviewQuery(source), [source]);
  const markdownEntries = useMemo(
    () => entries.filter((entry) => entry.kind === "markdown" && metadataByEntryId.has(entry.id)),
    [entries, metadataByEntryId]
  );
  const inputLimitExceeded = markdownEntries.length > MAX_DATAVIEW_INPUT_ENTRIES;
  const taskSourceSize = parsed.kind === "task"
    ? markdownEntries.reduce((total, entry) => total + (entry.content?.length ?? 0), 0)
    : 0;
  const taskSourceLimitExceeded = taskSourceSize > MAX_DATAVIEW_TASK_SOURCE_CHARACTERS;
  const evaluation = useMemo(
    () => {
      if (!parsed.document || !parsed.view) return { error: "", result: null };
      if (inputLimitExceeded) {
        return {
          error: `Dataview 입력이 ${MAX_DATAVIEW_INPUT_ENTRIES}개를 넘어 쿼리를 실행하지 않았습니다. 부분 결과는 표시하지 않습니다.`,
          result: null
        };
      }
      if (taskSourceLimitExceeded) {
        return {
          error: `Dataview TASK 원문이 ${MAX_DATAVIEW_TASK_SOURCE_CHARACTERS.toLocaleString("ko-KR")}자를 넘어 실행하지 않았습니다.`,
          result: null
        };
      }
      try {
        return {
          error: "",
          result: materializeBaseView(parsed.document, parsed.view, markdownEntries, metadataByEntryId)
        };
      } catch {
        return { error: "Dataview 결과를 안전하게 계산하지 못했습니다.", result: null };
      }
    },
    [inputLimitExceeded, markdownEntries, metadataByEntryId, parsed.document, parsed.view, taskSourceLimitExceeded]
  );
  const result = evaluation.result;

  if (!parsed.document || !parsed.view || !result) {
    const errors = evaluation.error ? [...parsed.errors, evaluation.error] : parsed.errors;
    return (
      <aside className="qm-dataview qm-dataview-error" role="alert">
        <strong>Dataview 쿼리를 실행하지 않았습니다.</strong>
        <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
      </aside>
    );
  }
  const diagnostics = [
    ...parsed.warnings,
    ...result.warnings.map((warning) => warning.message)
  ];
  const tasks = parsed.kind === "task"
    ? materializeTaskGroups(result.groups, parsed.taskFilter)
    : { groups: [], overflow: false, total: 0 };
  if (tasks.overflow) {
    return (
      <aside className="qm-dataview qm-dataview-error" role="alert">
        <strong>Dataview TASK 쿼리를 실행하지 않았습니다.</strong>
        <p>작업 결과가 {MAX_DATAVIEW_TASK_RESULTS.toLocaleString("ko-KR")}개를 넘어 부분 결과를 표시하지 않습니다.</p>
      </aside>
    );
  }
  const taskGroups = tasks.groups;
  const taskCount = tasks.total;
  const calendarRows = parsed.kind === "calendar" && parsed.calendarProperty
    ? result.groups.flatMap((group) => group.rows).map((row) => ({
        date: calendarDateKey(row.cells[parsed.calendarProperty!]),
        row
      })).filter((item): item is { date: string; row: typeof item.row } => Boolean(item.date))
      .sort((left, right) => left.date.localeCompare(right.date) || left.row.entry.path.localeCompare(right.row.entry.path))
    : [];
  const displayedCount = parsed.kind === "task" ? taskCount
    : parsed.kind === "calendar" ? calendarRows.length
      : result.resultCount;
  return (
    <section aria-label="Dataview 결과" className="qm-dataview">
      <header><strong>Dataview · {parsed.kind?.toLocaleUpperCase()}</strong><output>{displayedCount}개</output></header>
      {diagnostics.length ? <details><summary>안내 {diagnostics.length}개</summary><ul>{diagnostics.map((item) => <li key={item}>{item}</li>)}</ul></details> : null}
      {!displayedCount ? <p role="status">조건에 맞는 결과가 없습니다.</p> : parsed.kind === "task" ? (
        <div className="qm-dataview-groups">
          {taskGroups.filter((group) => group.tasks.length).map((group) => (
            <section key={group.key}>
              <ResultGroupHeading group={group} />
              <ul className="qm-dataview-tasks">
                {group.tasks.map(({ entry, task }: { entry: VaultIndexEntry; task: DataviewTask }) => (
                  <li key={`${entry.id}:${task.line}`}>
                    <input
                      aria-label={`${task.text} ${task.checked ? "완료" : "미완료"}`}
                      checked={task.checked}
                      disabled={!onToggleTask || canToggleTask?.(entry.id) === false}
                      onChange={(event) => void onToggleTask?.(entry.id, task.line, event.currentTarget.checked, task)}
                      type="checkbox"
                    />
                    <span>{task.text}</span>
                    <button disabled={!onOpenEntry} onClick={() => onOpenEntry?.(entry.id)} type="button">
                      {entry.path}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : parsed.kind === "calendar" ? (
        <ol className="qm-dataview-calendar">
          {calendarRows.map(({ date, row }) => (
            <li key={`${date}:${row.entry.id}`}>
              <time dateTime={date}>{date}</time>
              <button disabled={!onOpenEntry} onClick={() => onOpenEntry?.(row.entry.id)} type="button">
                {formatBaseCellValue(row.cells["file.name"] ?? row.entry.path)}
              </button>
            </li>
          ))}
        </ol>
      ) : result.type === "table" ? (
        <div className="qm-dataview-groups">
          {result.groups.map((group) => <section key={group.key}>
            <ResultGroupHeading group={group} />
            <div className="qm-dataview-table" tabIndex={0}>
              <table>
                <thead><tr>{result.columns.map((column) => <th key={column}>{basePropertyDisplayName(parsed.document!, column)}</th>)}</tr></thead>
                <tbody>{group.rows.map((row) => (
                  <tr key={row.entry.id}>{result.columns.map((column) => <td key={column}>
                    {column === "file.name" && onOpenEntry
                      ? <button onClick={() => onOpenEntry(row.entry.id)} type="button">{formatBaseCellValue(row.cells[column])}</button>
                      : formatBaseCellValue(row.cells[column])}
                  </td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          </section>)}
        </div>
      ) : (
        <div className="qm-dataview-groups">
          {result.groups.map((group) => <section key={group.key}>
            <ResultGroupHeading group={group} />
            <ul>{group.rows.map((row) => (
              <li key={row.entry.id}>
                <button disabled={!onOpenEntry} onClick={() => onOpenEntry?.(row.entry.id)} type="button">
                  {formatBaseCellValue(row.cells["file.name"] ?? row.entry.path)}
                </button>
                {result.columns.filter((column) => column !== "file.name").map((column) => (
                  <span key={column}>{basePropertyDisplayName(parsed.document!, column)}: {formatBaseCellValue(row.cells[column])}</span>
                ))}
              </li>
            ))}</ul>
          </section>)}
        </div>
      )}
    </section>
  );
}
