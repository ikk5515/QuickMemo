import type {
  BaseDocument,
  BaseFilterSource,
  BasePropertyConfig,
  BaseSortRule,
  BaseViewConfig
} from "../base";

const MAX_QUERY_BYTES = 32 * 1024;
const MAX_QUERY_LINES = 100;
const MAX_LIST_RESULTS = 500;
const MAX_TABLE_RESULTS = 200;
const MAX_TABLE_COLUMNS = 32;
const MAX_FILTER_DEPTH = 32;
const MAX_FILTER_NODES = 256;
const MAX_PARSE_MILLISECONDS = 100;
const PROPERTY_PATTERN = /^(?:file\.(?:name|path|folder|ext|ctime|mtime|tags|links|properties)|(?:note\.)?[A-Za-z_][\w-]*)$/iu;

export interface DataviewQueryResult {
  calendarProperty?: string;
  document: BaseDocument | null;
  errors: string[];
  kind: "calendar" | "list" | "table" | "task" | null;
  taskFilter?: {
    completed?: boolean;
    textContains?: string;
  };
  warnings: string[];
  view: BaseViewConfig | null;
}

interface QueryBudget {
  nodes: number;
  startedAt: number;
}

class DataviewQueryBudgetError extends Error {}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function assertTimeBudget(budget: QueryBudget) {
  if (monotonicNow() - budget.startedAt > MAX_PARSE_MILLISECONDS) {
    throw new DataviewQueryBudgetError("Dataview 쿼리 분석 시간이 안전 제한을 초과했습니다.");
  }
}

function splitComma(source: string, budget: QueryBudget): string[] {
  const values: string[] = [];
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ((index & 255) === 0) assertTimeBudget(budget);
    const character = source[index];
    if ((character === '"' || character === "'") && source[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
    } else if (character === "," && !quote) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(source.slice(start).trim());
  return values.filter(Boolean);
}

function splitLogical(source: string, operator: "AND" | "OR", budget: QueryBudget): string[] {
  const values: string[] = [];
  let quote = "";
  let start = 0;
  const pattern = new RegExp(`\\s+${operator}\\s+`, "iy");
  for (let index = 0; index < source.length; index += 1) {
    if ((index & 255) === 0) assertTimeBudget(budget);
    const character = source[index];
    if ((character === '"' || character === "'") && source[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
      continue;
    }
    if (!quote) {
      pattern.lastIndex = index;
      const match = pattern.exec(source);
      if (match) {
        values.push(source.slice(start, index).trim());
        index = pattern.lastIndex - 1;
        start = pattern.lastIndex;
      }
    }
  }
  values.push(source.slice(start).trim());
  return values.filter(Boolean);
}

function filterTree(
  source: string,
  atom: (value: string) => BaseFilterSource | null,
  budget: QueryBudget,
  depth = 0
): BaseFilterSource | null {
  assertTimeBudget(budget);
  budget.nodes += 1;
  if (depth > MAX_FILTER_DEPTH || budget.nodes > MAX_FILTER_NODES) {
    throw new DataviewQueryBudgetError(`Dataview 논리식은 깊이 ${MAX_FILTER_DEPTH}, 노드 ${MAX_FILTER_NODES}개까지만 사용할 수 있습니다.`);
  }
  const or = splitLogical(source, "OR", budget);
  if (or.length > 1) {
    if (budget.nodes + or.length > MAX_FILTER_NODES) {
      throw new DataviewQueryBudgetError(`Dataview 논리식은 깊이 ${MAX_FILTER_DEPTH}, 노드 ${MAX_FILTER_NODES}개까지만 사용할 수 있습니다.`);
    }
    const children = or.map((item) => filterTree(item, atom, budget, depth + 1));
    return children.some((child) => !child) ? null : { or: children as BaseFilterSource[] };
  }
  const and = splitLogical(source, "AND", budget);
  if (and.length > 1) {
    if (budget.nodes + and.length > MAX_FILTER_NODES) {
      throw new DataviewQueryBudgetError(`Dataview 논리식은 깊이 ${MAX_FILTER_DEPTH}, 노드 ${MAX_FILTER_NODES}개까지만 사용할 수 있습니다.`);
    }
    const children = and.map((item) => filterTree(item, atom, budget, depth + 1));
    return children.some((child) => !child) ? null : { and: children as BaseFilterSource[] };
  }
  const not = source.match(/^NOT\s+(.+)$/iu);
  if (not) {
    const child = filterTree(not[1], atom, budget, depth + 1);
    return child ? { not: [child] } : null;
  }
  return atom(source.trim());
}

function escapeArgument(value: string) {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function parseFrom(source: string, budget: QueryBudget): BaseFilterSource | null {
  return filterTree(source, (value) => {
    const folder = value.match(/^["']([^"']*)["']$/u);
    if (folder) {
      return folder[1] ? `file.inFolder("${escapeArgument(folder[1])}")` : null;
    }
    const tag = value.match(/^#([^\s#]+)$/u);
    if (tag) {
      return `file.hasTag("${escapeArgument(tag[1])}")`;
    }
    const link = value.match(/^\[\[([^\]]+)\]\]$/u);
    if (link) {
      return `file.hasLink("${escapeArgument(link[1])}")`;
    }
    return null;
  }, budget);
}

function parseWhere(source: string, budget: QueryBudget): BaseFilterSource | null {
  return filterTree(source, (value) => {
    const contains = value.match(/^contains\(\s*([^,]+)\s*,\s*(["'])(.*?)\2\s*\)$/iu);
    if (contains && PROPERTY_PATTERN.test(contains[1].trim())) {
      return `${contains[1].trim()}.contains("${escapeArgument(contains[3])}")`;
    }
    const comparison = value.match(/^([^\s]+)\s*(=|==|!=|>=|<=|>|<)\s*(.+)$/u);
    if (!comparison || !PROPERTY_PATTERN.test(comparison[1])) {
      return null;
    }
    const literal = comparison[3].trim();
    if (!/^(?:["'][\s\S]*["']|-?(?:\d+\.?\d*|\.\d+)|true|false|null)$/iu.test(literal)) {
      return null;
    }
    return `${comparison[1]} ${comparison[2] === "=" ? "==" : comparison[2]} ${literal}`;
  }, budget);
}

function parseColumn(source: string): { property: string; displayName?: string } | null {
  const match = source.match(/^([^\s]+)(?:\s+AS\s+(["'])(.*?)\2)?$/iu);
  const property = match?.[1];
  return property && PROPERTY_PATTERN.test(property)
    ? { property, ...(match?.[3] ? { displayName: match[3].slice(0, 120) } : {}) }
    : null;
}

function parseDataviewQueryUnsafe(source: string): DataviewQueryResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const budget: QueryBudget = { nodes: 0, startedAt: monotonicNow() };
  if (new TextEncoder().encode(source).byteLength > MAX_QUERY_BYTES) {
    return { document: null, errors: ["Dataview 쿼리는 32 KiB를 넘을 수 없습니다."], kind: null, warnings, view: null };
  }
  const lines = source.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > MAX_QUERY_LINES) {
    return {
      document: null,
      errors: [lines.length ? "Dataview 쿼리는 100줄을 넘을 수 없습니다." : "Dataview 쿼리가 비어 있습니다."],
      kind: null,
      warnings,
      view: null
    };
  }

  const first = lines[0].match(/^(CALENDAR|LIST|TABLE|TASK)(?:\s+([\s\S]*))?$/iu);
  if (!first) {
    return { document: null, errors: ["첫 줄은 LIST, TABLE, TASK 또는 CALENDAR여야 합니다."], kind: null, warnings, view: null };
  }
  const kind = first[1].toLocaleLowerCase() as "calendar" | "list" | "table" | "task";
  const type = kind === "table" ? "table" : "list";
  const columns: Array<{ property: string; displayName?: string }> = [];
  let calendarProperty: string | undefined;
  if (kind === "table") {
    const requestedColumns = splitComma(first[2] ?? "", budget);
    if (requestedColumns.length > MAX_TABLE_COLUMNS) {
      warnings.push(`TABLE 열은 안전을 위해 ${MAX_TABLE_COLUMNS}개로 제한했습니다.`);
    }
    for (const item of requestedColumns.slice(0, MAX_TABLE_COLUMNS)) {
      const column = parseColumn(item);
      if (!column) {
        errors.push(`지원하지 않는 TABLE 열입니다: ${item.slice(0, 80)}`);
      } else {
        columns.push(column);
      }
    }
  } else if (kind === "calendar") {
    const column = first[2] ? parseColumn(first[2]) : null;
    if (column) {
      calendarProperty = column.property;
      columns.push(column);
    } else {
      errors.push("CALENDAR에는 날짜 속성 하나가 필요합니다.");
    }
  } else if (kind === "list" && first[2]) {
    const column = parseColumn(first[2]);
    if (column) {
      columns.push(column);
    } else {
      errors.push("LIST 표현식은 안전한 파일 또는 속성 이름만 사용할 수 있습니다.");
    }
  }

  let from: BaseFilterSource | undefined;
  let where: BaseFilterSource | undefined;
  const sort: BaseSortRule[] = [];
  const maxResults = kind === "table" ? MAX_TABLE_RESULTS : MAX_LIST_RESULTS;
  let limit = Math.min(100, maxResults);
  let groupBy: BaseViewConfig["groupBy"];
  let taskFilter: DataviewQueryResult["taskFilter"];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const clause = line.match(/^(FROM|WHERE|SORT|LIMIT|GROUP\s+BY)\s+(.+)$/iu);
    if (!clause) {
      errors.push(`지원하지 않는 Dataview 절입니다: ${line.slice(0, 80)}`);
      continue;
    }
    const keyword = clause[1].toLocaleUpperCase();
    if (seen.has(keyword) && keyword !== "SORT") {
      errors.push(`${keyword} 절은 한 번만 사용할 수 있습니다.`);
      continue;
    }
    seen.add(keyword);
    if (keyword === "FROM") {
      from = parseFrom(clause[2], budget) ?? undefined;
      if (!from) errors.push("FROM은 #tag, \"folder\", [[note]]와 AND/OR/NOT만 지원합니다.");
    } else if (keyword === "WHERE") {
      if (kind === "task") {
        const taskWhere = clause[2].match(/^(!?completed)(?:\s+AND\s+contains\(\s*text\s*,\s*(["'])(.*?)\2\s*\))?$/iu)
          ?? clause[2].match(/^(contains\(\s*text\s*,\s*(["'])(.*?)\2\s*\))(?:\s+AND\s+(!?completed))?$/iu);
        if (taskWhere) {
          const completionToken = taskWhere[1].toLocaleLowerCase().includes("completed")
            ? taskWhere[1]
            : taskWhere[4];
          const text = taskWhere[3];
          taskFilter = {
            ...(completionToken ? { completed: !completionToken.startsWith("!") } : {}),
            ...(text ? { textContains: text.slice(0, 500) } : {})
          };
        } else {
          where = parseWhere(clause[2], budget) ?? undefined;
          if (!where) errors.push("TASK WHERE는 completed, !completed, contains(text, \"문구\") 또는 안전한 파일 비교식을 지원합니다.");
        }
      } else {
        where = parseWhere(clause[2], budget) ?? undefined;
        if (!where) errors.push("WHERE에는 안전한 비교식 또는 contains(property, \"text\")만 사용할 수 있습니다.");
      }
    } else if (keyword === "SORT") {
      for (const ruleSource of splitComma(clause[2], budget).slice(0, 8)) {
        const rule = ruleSource.match(/^([^\s]+)(?:\s+(ASC|DESC))?$/iu);
        if (rule && PROPERTY_PATTERN.test(rule[1])) {
          sort.push({ property: rule[1], direction: rule[2]?.toLocaleUpperCase() === "DESC" ? "DESC" : "ASC" });
        } else {
          errors.push(`지원하지 않는 SORT 규칙입니다: ${ruleSource.slice(0, 80)}`);
        }
      }
    } else if (keyword === "GROUP BY") {
      const group = clause[2].match(/^([^\s]+)(?:\s+(ASC|DESC))?$/iu);
      if (group && PROPERTY_PATTERN.test(group[1])) {
        groupBy = {
          property: group[1],
          direction: group[2]?.toLocaleUpperCase() === "DESC" ? "DESC" : "ASC"
        };
      } else {
        errors.push("GROUP BY에는 안전한 속성 이름 하나만 사용할 수 있습니다.");
      }
    } else {
      const parsedLimit = Number(clause[2]);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
        errors.push("LIMIT은 1 이상의 정수여야 합니다.");
      } else {
        if (parsedLimit > maxResults) warnings.push(`LIMIT은 안전을 위해 ${maxResults}으로 제한했습니다.`);
        limit = Math.min(maxResults, parsedLimit);
      }
    }
  }
  if (errors.length) {
    return { document: null, errors, kind: null, warnings, view: null };
  }

  const properties: Record<string, BasePropertyConfig> = Object.create(null);
  for (const column of columns) {
    properties[column.property] = column.displayName ? { displayName: column.displayName } : {};
  }
  const view: BaseViewConfig = {
    type,
    name: "Dataview",
    ...(where ? { filters: where } : {}),
    ...(groupBy ? { groupBy } : {}),
    limit,
    order: Array.from(new Set(["file.name", ...columns.map((column) => column.property)])),
    sort,
    summaries: {}
  };
  const document: BaseDocument = {
    ...(from ? { filters: from } : {}),
    formulas: {},
    properties,
    summaries: {},
    views: [view]
  };
  return {
    ...(calendarProperty ? { calendarProperty } : {}),
    document,
    errors,
    kind,
    ...(taskFilter ? { taskFilter } : {}),
    warnings,
    view
  };
}

export function parseDataviewQuery(source: string): DataviewQueryResult {
  try {
    return parseDataviewQueryUnsafe(source);
  } catch (error) {
    return {
      document: null,
      errors: [error instanceof DataviewQueryBudgetError
        ? error.message
        : "Dataview 쿼리를 안전하게 분석하지 못했습니다."],
      kind: null,
      warnings: [],
      view: null
    };
  }
}
