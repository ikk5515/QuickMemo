import {
  matchesVaultSearchQuery,
  parseVaultSearchQuery,
  vaultBasename,
  vaultStem,
  type FrontmatterValue,
  type ParsedMarkdownMetadata,
  type VaultIndexEntry,
  type VaultSearchQuery
} from "../knowledge";
import type {
  BaseCellScalar,
  BaseCellValue,
  BaseDiagnostic,
  BaseDocument,
  BaseFilterSource,
  BaseInputRow,
  BaseMaterializedView,
  BaseResultGroup,
  BaseResultRow,
  BaseSortDirection,
  BaseViewConfig
} from "./types";

interface FilterResult {
  matches: boolean;
  supported: boolean;
  warnings: BaseDiagnostic[];
}

const explicitSearchPattern = /^(?:query:\s*|(?:-?(?:file|path|content|tag|line|block|section|task):)|\[[^\]]+\]:|\[[^:\]]+:[^\]]*\])/i;
const functionPattern = /^file\.(hasTag|inFolder|hasLink|hasProperty)\(\s*(["'])(.*?)\2\s*\)$/i;
const containsPattern = /^(file\.(?:name|path|folder)|(?:note\.)?[A-Za-z_][\w-]*)\.contains\(\s*(["'])(.*?)\2\s*\)$/i;
const comparisonPattern = /^(file\.(?:name|path|folder|ext|ctime|mtime)|(?:note\.)?[A-Za-z_][\w-]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/i;

function warning(message: string, path?: string): BaseDiagnostic {
  return { code: "unsupported-filter", message, ...(path ? { path } : {}) };
}

function containsRegexQuery(query: VaultSearchQuery): boolean {
  switch (query.type) {
    case "regex":
      return true;
    case "not":
      return containsRegexQuery(query.child);
    case "and":
    case "or":
      return query.children.some(containsRegexQuery);
    case "all":
    case "term":
      return false;
  }
}

function extension(path: string) {
  const name = vaultBasename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function folder(path: string) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function propertyValue(metadata: ParsedMarkdownMetadata, name: string): FrontmatterValue | undefined {
  const normalized = name.replace(/^note\./i, "").toLocaleLowerCase();
  const key = Object.keys(metadata.properties).find((candidate) => candidate.toLocaleLowerCase() === normalized);
  return key ? metadata.properties[key] : undefined;
}

export function basePropertyValue(
  property: string,
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata
): BaseCellValue {
  const normalized = property.trim();
  switch (normalized.toLocaleLowerCase()) {
    case "file.name":
      return vaultStem(entry.path);
    case "file.path":
      return entry.path;
    case "file.folder":
      return folder(entry.path);
    case "file.ext":
      return extension(entry.path);
    case "file.ctime":
      return entry.createdAt ?? undefined;
    case "file.mtime":
      return entry.updatedAt ?? undefined;
    case "file.tags":
      return metadata.tags;
    case "file.links":
      return metadata.links.map((link) => link.target);
    case "file.properties":
      return Object.keys(metadata.properties);
    default:
      if (normalized.toLocaleLowerCase().startsWith("formula.")) {
        return undefined;
      }
      return propertyValue(metadata, normalized);
  }
}

function valueText(value: BaseCellValue): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "")).join(", ");
  }
  return String(value);
}

function parseLiteral(source: string): BaseCellScalar | undefined {
  const value = source.trim();
  const quoted = value.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) {
    return quoted[2].replace(/\\([\\"'])/g, "$1");
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (/^(?:true|false)$/i.test(value)) {
    return value.toLocaleLowerCase() === "true";
  }
  if (/^null$/i.test(value)) {
    return null;
  }
  return undefined;
}

function compareValues(left: BaseCellValue, operator: string, right: BaseCellScalar): boolean {
  if (Array.isArray(left)) {
    return operator === "!="
      ? left.every((item) => !compareValues(item, "==", right))
      : left.some((item) => compareValues(item, operator, right));
  }
  if (operator === "==" || operator === "!=") {
    const equal = typeof left === "string" && typeof right === "string"
      ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
      : left === right;
    return operator === "==" ? equal : !equal;
  }
  if (left === undefined || left === null || right === null) {
    return false;
  }
  const comparableLeft = typeof left === "number" ? left : String(left);
  const comparableRight = typeof right === "number" ? right : String(right);
  if (typeof comparableLeft !== typeof comparableRight) {
    return false;
  }
  switch (operator) {
    case ">": return comparableLeft > comparableRight;
    case "<": return comparableLeft < comparableRight;
    case ">=": return comparableLeft >= comparableRight;
    case "<=": return comparableLeft <= comparableRight;
    default: return false;
  }
}

function evaluateStatement(statement: string, row: BaseInputRow, path: string): FilterResult {
  const expression = statement.trim();
  if (/\bformula\./i.test(expression)) {
    return { matches: false, supported: false, warnings: [warning("계산식 기반 필터는 실행하지 않습니다.", path)] };
  }

  if (explicitSearchPattern.test(expression)) {
    const query = expression.replace(/^query:\s*/i, "");
    const parsedQuery = parseVaultSearchQuery(query);
    if (containsRegexQuery(parsedQuery)) {
      return {
        matches: false,
        supported: false,
        warnings: [warning("Base의 정규식 필터는 시간 제한 Worker가 연결될 때까지 실행하지 않습니다.", path)]
      };
    }
    return {
      matches: matchesVaultSearchQuery(parsedQuery, row.entry, row.metadata),
      supported: true,
      warnings: []
    };
  }

  const functionMatch = expression.match(functionPattern);
  if (functionMatch) {
    const [, functionName, , argument] = functionMatch;
    switch (functionName.toLocaleLowerCase()) {
      case "hastag":
        return {
          matches: matchesVaultSearchQuery(
            { type: "term", field: "tag", value: argument },
            row.entry,
            row.metadata
          ),
          supported: true,
          warnings: []
        };
      case "infolder": {
        const expected = argument.replace(/^\/+|\/+$/g, "").toLocaleLowerCase();
        const actual = folder(row.entry.path).toLocaleLowerCase();
        return { matches: actual === expected || actual.startsWith(`${expected}/`), supported: true, warnings: [] };
      }
      case "haslink": {
        const expected = argument.replace(/\.md$/i, "").toLocaleLowerCase();
        return {
          matches: row.metadata.links.some((link) => (
            link.target.replace(/\.md$/i, "").toLocaleLowerCase() === expected
            || vaultStem(link.target).toLocaleLowerCase() === expected
          )),
          supported: true,
          warnings: []
        };
      }
      case "hasproperty":
        return { matches: propertyValue(row.metadata, argument) !== undefined, supported: true, warnings: [] };
      default:
        break;
    }
  }

  const containsMatch = expression.match(containsPattern);
  if (containsMatch) {
    const [, property, , expected] = containsMatch;
    const actual = valueText(basePropertyValue(property, row.entry, row.metadata));
    return { matches: actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase()), supported: true, warnings: [] };
  }

  const comparisonMatch = expression.match(comparisonPattern);
  if (comparisonMatch) {
    const [, property, operator, literalSource] = comparisonMatch;
    const literal = parseLiteral(literalSource);
    if (literal !== undefined || literalSource.trim().toLocaleLowerCase() === "null") {
      return {
        matches: compareValues(basePropertyValue(property, row.entry, row.metadata), operator, literal ?? null),
        supported: true,
        warnings: []
      };
    }
  }

  return {
    matches: false,
    supported: false,
    warnings: [warning(`지원하지 않는 필터를 안전하게 제외했습니다: ${expression.slice(0, 120)}`, path)]
  };
}

function evaluateFilter(filter: BaseFilterSource, row: BaseInputRow, path: string): FilterResult {
  if (typeof filter === "string") {
    return evaluateStatement(filter, row, path);
  }
  if (filter.and) {
    const results = filter.and.map((child, index) => evaluateFilter(child, row, `${path}.and[${index}]`));
    const supported = results.every((result) => result.supported);
    return {
      matches: supported && results.every((result) => result.matches),
      supported,
      warnings: results.flatMap((result) => result.warnings)
    };
  }
  if (filter.or) {
    const results = filter.or.map((child, index) => evaluateFilter(child, row, `${path}.or[${index}]`));
    const supported = results.every((result) => result.supported);
    return {
      matches: supported && results.some((result) => result.matches),
      supported,
      warnings: results.flatMap((result) => result.warnings)
    };
  }
  if (filter.not) {
    const results = filter.not.map((child, index) => evaluateFilter(child, row, `${path}.not[${index}]`));
    const supported = results.every((result) => result.supported);
    return {
      matches: supported && !results.some((result) => result.matches),
      supported,
      warnings: results.flatMap((result) => result.warnings)
    };
  }
  return {
    matches: false,
    supported: false,
    warnings: [warning("비어 있는 필터를 안전하게 제외했습니다.", path)]
  };
}

function scalarSortValue(value: BaseCellValue): BaseCellScalar | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function compareCellValues(left: BaseCellValue, right: BaseCellValue, direction: BaseSortDirection): number {
  const a = scalarSortValue(left);
  const b = scalarSortValue(right);
  let result = 0;
  if (a === undefined || a === null) {
    result = b === undefined || b === null ? 0 : 1;
  } else if (b === undefined || b === null) {
    result = -1;
  } else if (typeof a === "number" && typeof b === "number") {
    result = a - b;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    result = Number(a) - Number(b);
  } else {
    result = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }
  return direction === "DESC" ? -result : result;
}

function uniqueDiagnostics(items: BaseDiagnostic[]): BaseDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.code}\n${item.path ?? ""}\n${item.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function columnsFor(document: BaseDocument, view: BaseViewConfig): string[] {
  const ordered = view.order.length ? view.order : ["file.name", ...Object.keys(document.properties)];
  return Array.from(new Set(ordered.length ? ordered : ["file.name"])).slice(0, 200);
}

function groupRows(rows: BaseResultRow[], view: BaseViewConfig): BaseResultGroup[] {
  if (!view.groupBy) {
    return [{ key: "all", label: "", rows }];
  }
  const groups = new Map<string, BaseResultRow[]>();
  for (const row of rows) {
    const value = basePropertyValue(view.groupBy.property, row.entry, row.metadata);
    const key = valueText(value) || "(비어 있음)";
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups]
    .sort(([left], [right]) => compareCellValues(left, right, view.groupBy?.direction ?? "ASC"))
    .map(([key, groupedRows]) => ({ key, label: key, rows: groupedRows }));
}

export function materializeBaseView(
  document: BaseDocument,
  view: BaseViewConfig,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>
): BaseMaterializedView {
  const columns = columnsFor(document, view);
  const warnings: BaseDiagnostic[] = [];
  const inputRows = entries.flatMap((entry): BaseInputRow[] => {
    const metadata = metadataByEntryId.get(entry.id);
    return entry.kind === "markdown" && metadata ? [{ entry, metadata }] : [];
  });
  const filtered = inputRows.filter((row) => {
    const globalResult = document.filters
      ? evaluateFilter(document.filters, row, "filters")
      : { matches: true, supported: true, warnings: [] };
    const viewResult = view.filters
      ? evaluateFilter(view.filters, row, `views.${view.name}.filters`)
      : { matches: true, supported: true, warnings: [] };
    if (warnings.length < 200) {
      warnings.push(...globalResult.warnings, ...viewResult.warnings);
    }
    return globalResult.matches && viewResult.matches;
  });

  const sorted = filtered.slice().sort((left, right) => {
    for (const rule of view.sort) {
      const result = compareCellValues(
        basePropertyValue(rule.property, left.entry, left.metadata),
        basePropertyValue(rule.property, right.entry, right.metadata),
        rule.direction
      );
      if (result) {
        return result;
      }
    }
    return left.entry.path.localeCompare(right.entry.path, undefined, { numeric: true, sensitivity: "base" });
  });
  const limited = view.limit ? sorted.slice(0, view.limit) : sorted;
  const resultRows: BaseResultRow[] = limited.map((row) => ({
    ...row,
    cells: Object.fromEntries(columns.map((property) => [
      property,
      basePropertyValue(property, row.entry, row.metadata)
    ]))
  }));

  for (const property of columns) {
    if (property.toLocaleLowerCase().startsWith("formula.")) {
      warnings.push({
        code: "unsupported-formula",
        message: `계산식 속성 '${property}'은(는) 표시만 하며 실행하지 않습니다.`,
        path: `views.${view.name}.order`
      });
    }
  }
  for (const rule of view.sort) {
    if (rule.property.toLocaleLowerCase().startsWith("formula.")) {
      warnings.push({
        code: "unsupported-formula",
        message: `계산식 속성 '${rule.property}' 정렬은 실행하지 않습니다.`,
        path: `views.${view.name}.sort`
      });
    }
  }
  if (view.groupBy?.property.toLocaleLowerCase().startsWith("formula.")) {
    warnings.push({
      code: "unsupported-formula",
      message: `계산식 속성 '${view.groupBy.property}' 그룹은 실행하지 않습니다.`,
      path: `views.${view.name}.groupBy`
    });
  }

  return {
    columns,
    groups: groupRows(resultRows, view),
    name: view.name,
    resultCount: resultRows.length,
    type: view.type,
    warnings: uniqueDiagnostics(warnings)
  };
}

export function basePropertyDisplayName(document: BaseDocument, property: string): string {
  return document.properties[property]?.displayName
    ?? (property.startsWith("note.") ? property.slice("note.".length) : property);
}

export function formatBaseCellValue(value: BaseCellValue): string {
  return valueText(value) || "—";
}
