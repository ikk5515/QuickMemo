import {
  buildInternalLinkResolutionIndex,
  matchesVaultSearchQuery,
  normalizeVaultPath,
  parseVaultSearchQuery,
  resolveInternalLink,
  vaultBasename,
  vaultStem,
  type FrontmatterValue,
  type InternalLinkOccurrence,
  type VaultIndexEntry,
  type VaultSearchQuery
} from "../knowledge";
import {
  tryCompileBaseFormula,
  type BaseFormulaProgram,
  type BaseFormulaRuntime
} from "./formula";
import type {
  BaseCellScalar,
  BaseCellValue,
  BaseDateValue,
  BaseDiagnostic,
  BaseDocument,
  BaseEvaluationContext,
  BaseFileValue,
  BaseFilterSource,
  BaseInputRow,
  BaseLinkValue,
  BaseMaterializedView,
  BaseMetadata,
  BaseObjectValue,
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

const EMPTY_BASE_METADATA: BaseMetadata = Object.freeze({
  aliases: Object.freeze([]),
  blocks: Object.freeze([]),
  headings: Object.freeze([]),
  links: Object.freeze([]),
  properties: Object.freeze({}),
  tags: Object.freeze([]),
  backlinks: Object.freeze([])
});

const MAXIMUM_SUMMARY_VALUES = 10_000;

function mixSeed(seed: number, value: string) {
  let result = (seed >>> 0) || 0x9e37_79b9;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x0100_0193) >>> 0;
  }
  return result || 0x85eb_ca6b;
}

function freshRandomSeed() {
  const random = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(random);
  return random[0] || Math.floor(Math.random() * 0xffff_ffff) || 0x9e37_79b9;
}

const SUPPORTED_FILE_PROPERTIES = new Set([
  "file.backlinks",
  "file.basename",
  "file.ctime",
  "file.embeds",
  "file.ext",
  "file.file",
  "file.folder",
  "file.links",
  "file.mtime",
  "file.name",
  "file.path",
  "file.properties",
  "file.size",
  "file.tags"
]);

const explicitSearchPattern = /^(?:query:\s*|(?:-?(?:file|path|content|tag|line|block|section|task):)|\[[^\]]+\]:|\[[^:\]]+:[^\]]*\])/i;
const functionPattern = /^file\.(hasTag|inFolder|hasLink|hasProperty)\(\s*(["'])(.*?)\2\s*\)$/i;
const containsPattern = /^(file\.(?:name|path|folder)|formula\.[A-Za-z_][\w-]*|(?:note\.)?[A-Za-z_][\w-]*)\.contains\(\s*(["'])(.*?)\2\s*\)$/i;
const comparisonPattern = /^(file\.(?:name|path|folder|ext|ctime|mtime)|formula\.[A-Za-z_][\w-]*|(?:note\.)?[A-Za-z_][\w-]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/i;

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

function propertyValue(metadata: BaseMetadata, name: string): FrontmatterValue | undefined {
  const normalized = name.replace(/^note\./i, "").toLocaleLowerCase();
  const key = Object.keys(metadata.properties).find((candidate) => candidate.toLocaleLowerCase() === normalized);
  return key ? metadata.properties[key] : undefined;
}

function isDateValue(value: BaseCellValue): value is BaseDateValue {
  return Boolean(value && !Array.isArray(value) && typeof value === "object" && value.__baseType === "date");
}

function isObjectValue(value: BaseCellValue): value is BaseObjectValue {
  return Boolean(value && !Array.isArray(value) && typeof value === "object" && value.__baseType === "object");
}

function isLinkValue(value: BaseCellValue): value is BaseLinkValue {
  return Boolean(value && !Array.isArray(value) && typeof value === "object" && value.__baseType === "link");
}

function dateValue(epochMs: number | undefined): BaseDateValue | undefined {
  return typeof epochMs === "number" && Number.isFinite(epochMs)
    ? { __baseType: "date", epochMs }
    : undefined;
}

function linkValue(rawTarget: string, entryId?: string): BaseLinkValue {
  const wikilink = rawTarget.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/u);
  const path = (wikilink?.[1] ?? rawTarget).trim();
  const scheme = path.match(/^([a-z][a-z\d+.-]*):/iu)?.[1]?.toLocaleLowerCase();
  return {
    __baseType: "link",
    path,
    external: scheme === "http" || scheme === "https",
    ...(entryId ? { entryId } : {}),
    ...(wikilink?.[2] ? { display: wikilink[2].trim() } : {})
  };
}

function frontmatterCellValue(value: FrontmatterValue | undefined): BaseCellValue {
  const convert = (item: BaseCellScalar): BaseCellValue => {
    if (typeof item !== "string") return item;
    if (/^\[\[[^\]]+\]\]$/u.test(item.trim())) return linkValue(item.trim());
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.test(item.trim())) {
      const parsed = Date.parse(item);
      if (Number.isFinite(parsed)) return { __baseType: "date", epochMs: parsed };
    }
    return item;
  };
  return Array.isArray(value) ? value.slice(0, 10_000).map(convert) : value === undefined ? undefined : convert(value);
}

function propertiesValue(metadata: BaseMetadata): BaseObjectValue {
  const values: Record<string, BaseCellValue> = Object.create(null) as Record<string, BaseCellValue>;
  for (const [key, value] of Object.entries(metadata.properties).slice(0, 1_000)) {
    if (["__proto__", "constructor", "prototype"].includes(key.toLocaleLowerCase("en-US"))) continue;
    values[key] = frontmatterCellValue(value);
  }
  return { __baseType: "object", values };
}

function contentByteSize(entry: VaultIndexEntry): number | undefined {
  if (typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0) return entry.size;
  if (typeof entry.content !== "string") return undefined;
  let bytes = 0;
  for (const character of entry.content) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function fileValue(entry: VaultIndexEntry, metadata: BaseMetadata): BaseFileValue {
  const name = vaultBasename(entry.path);
  const tags = [...metadata.tags].slice(0, 10_000);
  let remainingRelations = Math.max(0, 10_000 - tags.length);
  const links = metadata.links.slice(0, remainingRelations).map((link) => linkValue(link.target, link.targetEntryId));
  remainingRelations = Math.max(0, remainingRelations - links.length);
  const embeds = metadata.links.filter((link) => link.embedded).slice(0, remainingRelations).map((link) => linkValue(link.target, link.targetEntryId));
  remainingRelations = Math.max(0, remainingRelations - embeds.length);
  const backlinks = metadata.backlinks?.slice(0, remainingRelations).map((link) => linkValue(link.target, link.sourceEntryId));
  return {
    __baseType: "file",
    entryId: entry.id,
    path: entry.path,
    name,
    basename: vaultStem(entry.path),
    folder: folder(entry.path),
    ext: extension(entry.path),
    size: contentByteSize(entry),
    createdAt: dateValue(entry.createdAt),
    updatedAt: dateValue(entry.updatedAt),
    tags,
    links,
    embeds,
    backlinks,
    properties: propertiesValue(metadata)
  };
}

export function basePropertyValue(
  property: string,
  entry: VaultIndexEntry,
  metadata: BaseMetadata
): BaseCellValue {
  const normalized = property.trim();
  switch (normalized.toLocaleLowerCase()) {
    case "file":
    case "file.file":
      return fileValue(entry, metadata);
    case "file.name":
      return vaultStem(entry.path);
    case "file.basename":
      return vaultStem(entry.path);
    case "file.path":
      return entry.path;
    case "file.folder":
      return folder(entry.path);
    case "file.ext":
      return extension(entry.path);
    case "file.ctime":
      return dateValue(entry.createdAt);
    case "file.mtime":
      return dateValue(entry.updatedAt);
    case "file.size":
      return contentByteSize(entry);
    case "file.tags":
      return [...metadata.tags].slice(0, 10_000);
    case "file.links":
      return metadata.links.slice(0, 10_000).map((link) => linkValue(link.target, link.targetEntryId));
    case "file.embeds":
      return metadata.links.filter((link) => link.embedded).slice(0, 10_000).map((link) => linkValue(link.target, link.targetEntryId));
    case "file.backlinks":
      return metadata.backlinks?.slice(0, 10_000).map((link) => linkValue(link.target, link.sourceEntryId));
    case "file.properties":
      return propertiesValue(metadata);
    default:
      if (normalized.toLocaleLowerCase().startsWith("formula.")) {
        return undefined;
      }
      return frontmatterCellValue(propertyValue(metadata, normalized));
  }
}

function valueText(value: BaseCellValue): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(valueText).join(", ");
  }
  if (isDateValue(value)) return new Date(value.epochMs).toISOString();
  if (isLinkValue(value)) return value.display === undefined ? value.path : valueText(value.display);
  if (isObjectValue(value)) return JSON.stringify(value.values);
  if (typeof value === "object" && value.__baseType === "file") return value.path;
  if (typeof value === "object" && value.__baseType === "duration") return `${value.months}mo ${value.milliseconds}ms`;
  if (typeof value === "object" && value.__baseType === "html") return value.source;
  if (typeof value === "object" && value.__baseType === "icon") return value.name;
  if (typeof value === "object" && value.__baseType === "image") return value.path;
  if (typeof value === "object" && value.__baseType === "regex") return `/${value.source}/${value.flags}`;
  return String(value);
}

function truthyValue(value: BaseCellValue) {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== ""
    && (!Array.isArray(value) || value.length > 0)
    && (!isObjectValue(value) || Object.keys(value.values).length > 0);
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

function evaluateStatement(
  statement: string,
  row: BaseInputRow,
  path: string,
  resolve: (property: string) => BaseCellValue,
  runtime: BaseFormulaRuntime
): FilterResult {
  const expression = statement.trim();

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

  // Official Bases uses the same expression language for filters and formulas.
  // Compile the bounded interpreter first; legacy pattern handlers below remain
  // only as compatibility fallbacks for older QuickMemo fixtures.
  const compiledExpression = tryCompileBaseFormula(expression);
  if (compiledExpression.program) {
    const evaluation = compiledExpression.program.evaluate(resolve, {
      ...runtime,
      randomSeed: mixSeed(runtime.randomSeed ?? 0, `${row.entry.id}:${path}:${expression}`)
    });
    if (!evaluation.error) {
      return { matches: truthyValue(evaluation.value), supported: true, warnings: [] };
    }
    return {
      matches: false,
      supported: false,
      warnings: [warning(`필터 계산식을 실행하지 못했습니다: ${evaluation.error}`, path)]
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
    const actual = valueText(resolve(property));
    return { matches: actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase()), supported: true, warnings: [] };
  }

  const comparisonMatch = expression.match(comparisonPattern);
  if (comparisonMatch) {
    const [, property, operator, literalSource] = comparisonMatch;
    const literal = parseLiteral(literalSource);
    if (literal !== undefined || literalSource.trim().toLocaleLowerCase() === "null") {
      return {
        matches: compareValues(resolve(property), operator, literal ?? null),
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

function evaluateFilter(
  filter: BaseFilterSource,
  row: BaseInputRow,
  path: string,
  resolve: (property: string) => BaseCellValue,
  runtime: BaseFormulaRuntime
): FilterResult {
  if (typeof filter === "string") {
    return evaluateStatement(filter, row, path, resolve, runtime);
  }
  if (filter.and) {
    const results = filter.and.map((child, index) => evaluateFilter(child, row, `${path}.and[${index}]`, resolve, runtime));
    const supported = results.every((result) => result.supported);
    return {
      matches: supported && results.every((result) => result.matches),
      supported,
      warnings: results.flatMap((result) => result.warnings)
    };
  }
  if (filter.or) {
    const results = filter.or.map((child, index) => evaluateFilter(child, row, `${path}.or[${index}]`, resolve, runtime));
    const supported = results.every((result) => result.supported);
    return {
      matches: supported && results.some((result) => result.matches),
      supported,
      warnings: results.flatMap((result) => result.warnings)
    };
  }
  if (filter.not) {
    const results = filter.not.map((child, index) => evaluateFilter(child, row, `${path}.not[${index}]`, resolve, runtime));
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

function scalarSortValue(value: BaseCellValue): BaseCellValue {
  return Array.isArray(value) ? value[0] : value;
}

function compareCellValues(left: BaseCellValue, right: BaseCellValue, direction: BaseSortDirection): number {
  const a = scalarSortValue(left);
  const b = scalarSortValue(right);
  // Empty cells remain at the end in both directions. Reversing this branch
  // would make attachment/Canvas rows jump ahead of populated notes in DESC.
  if (a === undefined || a === null) {
    return b === undefined || b === null ? 0 : 1;
  }
  if (b === undefined || b === null) {
    return -1;
  }
  let result = 0;
  const comparableA = isDateValue(a) ? a.epochMs : a;
  const comparableB = isDateValue(b) ? b.epochMs : b;
  if (typeof comparableA === "number" && typeof comparableB === "number") {
    result = comparableA - comparableB;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    result = Number(a) - Number(b);
  } else {
    result = valueText(a).localeCompare(valueText(b), undefined, { numeric: true, sensitivity: "base" });
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

function formulaWarning(message: string, path?: string): BaseDiagnostic {
  return { code: "unsupported-formula", message, ...(path ? { path } : {}) };
}

function compileFormulaPrograms(document: BaseDocument, warnings: BaseDiagnostic[]) {
  const programs = new Map<string, { name: string; program: BaseFormulaProgram }>();
  for (const [name, source] of Object.entries(document.formulas)) {
    const compiled = tryCompileBaseFormula(source);
    if (!compiled.program) {
      warnings.push(formulaWarning(
        `계산식 '${name}'을(를) 실행하지 못했습니다: ${compiled.error ?? "문법 오류"}`,
        `formulas.${name}`
      ));
      continue;
    }
    programs.set(name.toLocaleLowerCase(), { name, program: compiled.program });
  }
  return programs;
}

function createFormulaResolver(
  row: BaseInputRow,
  programs: ReadonlyMap<string, { name: string; program: BaseFormulaProgram }>,
  warnings: BaseDiagnostic[],
  runtime: BaseFormulaRuntime,
  thisFile: BaseFileValue | undefined
) {
  const cache = new Map<string, BaseCellValue>();
  const propertyCache = new Map<string, BaseCellValue>();
  const active = new Set<string>();
  const resolve = (property: string): BaseCellValue => {
    const normalized = property.trim();
    const lower = normalized.toLocaleLowerCase();
    if (lower === "this") {
      return thisFile ? { __baseType: "object", values: { file: thisFile } } : undefined;
    }
    if (lower === "this.file") return thisFile;
    if (lower.startsWith("this.file.")) {
      if (!thisFile) {
        if (warnings.length < 200) {
          warnings.push({
            code: "unsupported-option",
            message: "이 Base에 embedding/active file 문맥이 없어 this.file 값을 비웠습니다.",
            path: normalized
          });
        }
        return undefined;
      }
      const suffix = normalized.slice("this.file.".length);
      const contextFields: Record<string, BaseCellValue> = {
        backlinks: thisFile.backlinks,
        basename: thisFile.basename,
        ctime: thisFile.createdAt,
        embeds: thisFile.embeds,
        ext: thisFile.ext,
        file: thisFile,
        folder: thisFile.folder,
        links: thisFile.links,
        mtime: thisFile.updatedAt,
        name: thisFile.basename,
        path: thisFile.path,
        properties: thisFile.properties,
        size: thisFile.size,
        tags: thisFile.tags
      };
      return contextFields[suffix.toLocaleLowerCase()];
    }
    const formulaName = lower.startsWith("formula.") ? normalized.slice("formula.".length) : null;
    if (formulaName === null) {
      if (lower.startsWith("file.") && !SUPPORTED_FILE_PROPERTIES.has(lower)) {
        if (
          lower.startsWith("file.properties.")
          || lower.startsWith("file.ctime.")
          || lower.startsWith("file.mtime.")
          || lower.startsWith("file.file.")
          || lower.startsWith("file.links.")
          || lower.startsWith("file.embeds.")
          || lower.startsWith("file.backlinks.")
          || lower.startsWith("file.tags.")
        ) {
          return undefined;
        }
        if (warnings.length < 200) {
          warnings.push({
            code: "unsupported-option",
            message: `현재 암호화 인덱스에 없는 파일 속성을 안전하게 비웠습니다: ${normalized}`,
            path: normalized
          });
        }
        return undefined;
      }
      if (!propertyCache.has(lower)) {
        propertyCache.set(lower, basePropertyValue(normalized, row.entry, row.metadata));
      }
      return propertyCache.get(lower);
    }
    const key = formulaName.toLocaleLowerCase();
    if (cache.has(key)) return cache.get(key);
    const formula = programs.get(key);
    if (!formula) return undefined;
    if (active.has(key)) {
      if (warnings.length < 200) {
        warnings.push(formulaWarning(
          `계산식 '${formula.name}'에 순환 참조가 있어 값을 비웠습니다.`,
          `formulas.${formula.name}`
        ));
      }
      return undefined;
    }
    active.add(key);
    const evaluation = formula.program.evaluate(resolve, {
      ...runtime,
      randomSeed: mixSeed(runtime.randomSeed ?? 0, `${row.entry.id}:formula:${key}`)
    });
    active.delete(key);
    if (evaluation.error && warnings.length < 200) {
      warnings.push(formulaWarning(
        `계산식 '${formula.name}'을(를) 실행하지 못했습니다: ${evaluation.error}`,
        `formulas.${formula.name}`
      ));
    }
    cache.set(key, evaluation.value);
    return evaluation.value;
  };
  return resolve;
}

function columnsFor(document: BaseDocument, view: BaseViewConfig): string[] {
  const ordered = view.order.length ? view.order : ["file.name", ...Object.keys(document.properties)];
  return Array.from(new Set(ordered.length ? ordered : ["file.name"])).slice(0, 200);
}

function groupRows(
  rows: BaseResultRow[],
  view: BaseViewConfig,
  resolvers: ReadonlyMap<string, (property: string) => BaseCellValue>
): BaseResultGroup[] {
  if (!view.groupBy) {
    return [{ key: "all", label: "", rows }];
  }
  const groups = new Map<string, BaseResultRow[]>();
  for (const row of rows) {
    const value = resolvers.get(row.entry.id)?.(view.groupBy.property);
    const key = valueText(value) || "(비어 있음)";
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups]
    .sort(([left], [right]) => compareCellValues(left, right, view.groupBy?.direction ?? "ASC"))
    .map(([key, groupedRows]) => ({ key, label: key, rows: groupedRows }));
}

function summaryValues(
  property: string,
  rows: readonly BaseResultRow[],
  resolvers: ReadonlyMap<string, (property: string) => BaseCellValue>
) {
  const values: BaseCellValue[] = [];
  for (const row of rows) {
    const value = resolvers.get(row.entry.id)?.(property);
    const candidates = Array.isArray(value) ? (value.length ? value : [null]) : [value ?? null];
    if (values.length + candidates.length > MAXIMUM_SUMMARY_VALUES) {
      return { exceeded: true, values: [] as BaseCellValue[] };
    }
    for (const candidate of candidates) values.push(candidate);
  }
  return { exceeded: false, values };
}

function emptySummaryValue(value: BaseCellValue) {
  return value === undefined || value === null || value === ""
    || (Array.isArray(value) && value.length === 0)
    || (isObjectValue(value) && Object.keys(value.values).length === 0);
}

function defaultSummary(name: string, values: readonly BaseCellValue[]): BaseCellValue {
  const normalized = name.toLocaleLowerCase();
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const sorted = numbers.slice().sort((left, right) => left - right);
  const numericMinimum = () => sorted[0];
  const numericMaximum = () => sorted[sorted.length - 1];
  switch (normalized) {
    case "average": return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : undefined;
    case "min": return numbers.length ? numericMinimum() : undefined;
    case "max": return numbers.length ? numericMaximum() : undefined;
    case "sum": return numbers.reduce((sum, value) => sum + value, 0);
    case "range": {
      if (numbers.length) return numericMaximum() - numericMinimum();
      const dates = values.filter(isDateValue).map((value) => value.epochMs);
      if (!dates.length) return undefined;
      let earliest = dates[0];
      let latest = dates[0];
      for (let index = 1; index < dates.length; index += 1) {
        if (dates[index] < earliest) earliest = dates[index];
        if (dates[index] > latest) latest = dates[index];
      }
      return latest - earliest;
    }
    case "median": {
      if (!sorted.length) return undefined;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    case "stddev": {
      if (!numbers.length) return undefined;
      const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      return Math.sqrt(numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numbers.length);
    }
    case "earliest":
    case "latest": {
      const dates = values.flatMap((value) => {
        if (isDateValue(value)) return [value.epochMs];
        if (typeof value === "number" && Number.isFinite(value)) return [value];
        if (typeof value !== "string") return [];
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? [parsed] : [];
      });
      if (!dates.length) return undefined;
      let selected = dates[0];
      for (let index = 1; index < dates.length; index += 1) {
        if (normalized === "earliest" ? dates[index] < selected : dates[index] > selected) {
          selected = dates[index];
        }
      }
      return selected;
    }
    case "checked": return values.filter((value) => value === true).length;
    case "unchecked": return values.filter((value) => value === false).length;
    case "empty": return values.filter(emptySummaryValue).length;
    case "filled": return values.filter((value) => !emptySummaryValue(value)).length;
    case "unique": return new Set(values.map((value) => valueText(value))).size;
    default: return undefined;
  }
}

function materializeSummaries(
  document: BaseDocument,
  view: BaseViewConfig,
  rows: readonly BaseResultRow[],
  resolvers: ReadonlyMap<string, (property: string) => BaseCellValue>,
  warnings: BaseDiagnostic[],
  runtime: BaseFormulaRuntime
): BaseMaterializedView["summaries"] {
  return Object.entries(view.summaries).map(([property, name]) => {
    const summaryInput = summaryValues(property, rows, resolvers);
    if (summaryInput.exceeded) {
      if (warnings.length < 200) {
        warnings.push(formulaWarning(
          `요약 '${name}'의 입력이 10,000개 제한을 초과해 안전하게 비웠습니다.`,
          `views.${view.name}.summaries.${property}`
        ));
      }
      return { property, name, value: undefined };
    }
    const { values } = summaryInput;
    const customSource = Object.entries(document.summaries).find(
      ([candidate]) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()
    )?.[1];
    if (!customSource) return { property, name, value: defaultSummary(name, values) };
    const compiled = tryCompileBaseFormula(customSource);
    if (!compiled.program) {
      if (warnings.length < 200) {
        warnings.push(formulaWarning(
          `사용자 정의 요약 '${name}'을(를) 해석하지 못했습니다: ${compiled.error ?? "문법 오류"}`,
          `summaries.${name}`
        ));
      }
      return { property, name, value: undefined };
    }
    const evaluation = compiled.program.evaluate(
      (candidate) => candidate.toLocaleLowerCase() === "values" ? values : undefined,
      { ...runtime, randomSeed: mixSeed(runtime.randomSeed ?? 0, `summary:${name}:${property}`) }
    );
    if (evaluation.error && warnings.length < 200) {
      warnings.push(formulaWarning(
        `사용자 정의 요약 '${name}'을(를) 실행하지 못했습니다: ${evaluation.error}`,
        `summaries.${name}`
      ));
    }
    return { property, name, value: evaluation.value };
  });
}

function metadataWithBacklinks(
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, BaseMetadata>
): Map<string, BaseMetadata> {
  const resolutionIndex = buildInternalLinkResolutionIndex(entries, metadataByEntryId);
  const backlinks = new Map(entries.map((entry) => [entry.id, [] as Array<{ sourceEntryId: string; target: string }>]));
  const linksByEntryId = new Map(entries.map((entry) => [
    entry.id,
    [...(metadataByEntryId.get(entry.id)?.links ?? [])].slice(0, 10_000)
  ]));
  let occurrenceBudget = 32_768;
  for (const source of entries) {
    const metadata = metadataByEntryId.get(source.id) ?? EMPTY_BASE_METADATA;
    for (const [linkIndex, link] of metadata.links.slice(0, 10_000).entries()) {
      if (occurrenceBudget-- <= 0) break;
      const occurrence: InternalLinkOccurrence = {
        sourceEntryId: source.id,
        sourcePath: source.path,
        syntax: link.syntax ?? "wikilink",
        raw: link.target,
        target: link.target,
        embedded: Boolean(link.embedded),
        line: 1,
        column: 1,
        context: ""
      };
      const resolved = resolveInternalLink(occurrence, entries, metadataByEntryId, resolutionIndex);
      if (resolved.status === "resolved" && resolved.targetEntryId) {
        backlinks.get(resolved.targetEntryId)?.push({
          sourceEntryId: source.id,
          target: normalizeVaultPath(source.path)
        });
        const projected = linksByEntryId.get(source.id);
        if (projected?.[linkIndex] && resolved.targetPath) {
          projected[linkIndex] = {
            ...projected[linkIndex],
            target: resolved.targetPath,
            targetEntryId: resolved.targetEntryId
          };
        }
      }
    }
    if (occurrenceBudget <= 0) break;
  }
  return new Map(entries.map((entry) => {
    const metadata = metadataByEntryId.get(entry.id) ?? EMPTY_BASE_METADATA;
    return [entry.id, {
      ...metadata,
      links: linksByEntryId.get(entry.id) ?? [],
      backlinks: backlinks.get(entry.id) ?? []
    }];
  }));
}

function createFileResolverFactory(
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, BaseMetadata>
) {
  const resolutionIndex = buildInternalLinkResolutionIndex(entries, metadataByEntryId);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const fileCache = new Map<string, BaseFileValue>();
  const fileFor = (entry: VaultIndexEntry) => {
    const cached = fileCache.get(entry.id);
    if (cached) return cached;
    const value = fileValue(entry, metadataByEntryId.get(entry.id) ?? EMPTY_BASE_METADATA);
    fileCache.set(entry.id, value);
    return value;
  };
  return (source: VaultIndexEntry, rawPath: string): BaseFileValue | undefined => {
    const path = rawPath.trim().replace(/^\[\[|\]\]$/gu, "").split(/[|#]/u, 1)[0];
    if (!path || /^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
    const occurrence: InternalLinkOccurrence = {
      sourceEntryId: source.id,
      sourcePath: source.path,
      syntax: "wikilink",
      raw: path,
      target: path,
      embedded: false,
      line: 1,
      column: 1,
      context: ""
    };
    const resolved = resolveInternalLink(occurrence, entries, metadataByEntryId, resolutionIndex);
    const target = resolved.targetEntryId ? entryById.get(resolved.targetEntryId) : undefined;
    return target ? fileFor(target) : undefined;
  };
}

export function materializeBaseView(
  document: BaseDocument,
  view: BaseViewConfig,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, BaseMetadata>,
  context: BaseEvaluationContext = {}
): BaseMaterializedView {
  const columns = columnsFor(document, view);
  const warnings: BaseDiagnostic[] = [];
  const programs = compileFormulaPrograms(document, warnings);
  const relatedMetadata = metadataWithBacklinks(entries, metadataByEntryId);
  const resolveFileFor = createFileResolverFactory(entries, relatedMetadata);
  const materializedNow = Number.isFinite(context.nowEpochMs) ? context.nowEpochMs! : Date.now();
  const materializedSeed = Number.isSafeInteger(context.randomSeed) ? context.randomSeed! : freshRandomSeed();
  const thisMetadata = context.thisEntry
    ? context.thisMetadata ?? relatedMetadata.get(context.thisEntry.id) ?? EMPTY_BASE_METADATA
    : undefined;
  const thisFile = context.thisEntry && thisMetadata
    ? fileValue(context.thisEntry, thisMetadata)
    : undefined;
  const inputRows = entries.map((entry): BaseInputRow => ({
    entry,
    metadata: relatedMetadata.get(entry.id) ?? EMPTY_BASE_METADATA
  }));
  const runtimes = new Map(inputRows.map((row) => [row.entry.id, {
    nowEpochMs: materializedNow,
    randomSeed: mixSeed(materializedSeed, row.entry.id),
    resolveFile: (path: string) => resolveFileFor(row.entry, path)
  } satisfies BaseFormulaRuntime]));
  const resolvers = new Map(inputRows.map((row) => [row.entry.id, createFormulaResolver(
    row,
    programs,
    warnings,
    runtimes.get(row.entry.id)!,
    thisFile
  )]));
  const filtered = inputRows.filter((row) => {
    const resolve = resolvers.get(row.entry.id)!;
    const globalResult = document.filters
      ? evaluateFilter(document.filters, row, "filters", resolve, runtimes.get(row.entry.id)!)
      : { matches: true, supported: true, warnings: [] };
    const viewResult = view.filters
      ? evaluateFilter(view.filters, row, `views.${view.name}.filters`, resolve, runtimes.get(row.entry.id)!)
      : { matches: true, supported: true, warnings: [] };
    if (warnings.length < 200) {
      warnings.push(...globalResult.warnings, ...viewResult.warnings);
    }
    return globalResult.matches && viewResult.matches;
  });

  const sorted = filtered.slice().sort((left, right) => {
    for (const rule of view.sort) {
      const result = compareCellValues(
        resolvers.get(left.entry.id)?.(rule.property),
        resolvers.get(right.entry.id)?.(rule.property),
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
      resolvers.get(row.entry.id)?.(property)
    ]))
  }));
  const summaries = materializeSummaries(document, view, resultRows, resolvers, warnings, {
    nowEpochMs: materializedNow,
    randomSeed: mixSeed(materializedSeed, `summary:${view.name}`)
  });

  return {
    columns,
    groups: groupRows(resultRows, view, resolvers),
    name: view.name,
    resultCount: resultRows.length,
    summaries,
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
