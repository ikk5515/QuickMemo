export interface DataviewTask {
  checked: boolean;
  line: number;
  text: string;
}

const TASK_PATTERN = /^\s*(?:>\s*)?(?:(?:[-+*])|(?:\d+[.)]))\s+\[([ xX])\]\s+(.+)$/u;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/u;

/** Extract task rows without evaluating Markdown, HTML, scripts or fenced code. */
export function* iterateDataviewTasks(source: string): Generator<DataviewTask, void> {
  let fence = "";
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const marker = FENCE_PATTERN.exec(line)?.[1] ?? "";
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const task = TASK_PATTERN.exec(line);
    if (!task) continue;
    yield {
      checked: task[1].toLocaleLowerCase() === "x",
      line: index + 1,
      text: task[2].slice(0, 10_000)
    };
  }
}

export function extractDataviewTasks(source: string, maximumTasks = Number.POSITIVE_INFINITY): DataviewTask[] {
  const tasks: DataviewTask[] = [];
  for (const task of iterateDataviewTasks(source)) {
    tasks.push(task);
    if (tasks.length >= maximumTasks) break;
  }
  return tasks;
}

export function setDataviewTaskChecked(
  source: string,
  lineNumber: number,
  checked: boolean,
  expected?: Pick<DataviewTask, "checked" | "text">
): string | null {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  const lines = source.split(/\r?\n/u);
  const line = lines[lineNumber - 1];
  const task = line === undefined ? null : TASK_PATTERN.exec(line);
  if (!task) return null;
  if (expected && (
    (task[1].toLocaleLowerCase() === "x") !== expected.checked
    || task[2].slice(0, 10_000) !== expected.text
  )) return null;
  const next = line.replace(/(\[[ xX]\])/u, checked ? "[x]" : "[ ]");
  if (next === line) return source;
  lines[lineNumber - 1] = next;
  return lines.join("\n");
}
