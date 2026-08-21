import { isAlias, isNode, parseDocument, visit } from "yaml";
import type {
  BaseDiagnostic,
  BaseDocument,
  BaseFilterSource,
  BaseGroupRule,
  BaseParseResult,
  BasePropertyConfig,
  BaseSortDirection,
  BaseSortRule,
  BaseViewConfig,
  BaseViewType
} from "./types";

const maximumBaseSourceBytes = 512 * 1024;
const maximumBaseDepth = 48;
const maximumBaseValues = 20_000;
const maximumBaseStringLength = 100_000;
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"]);
const supportedRootKeys = new Set(["filters", "formulas", "properties", "summaries", "views"]);

interface SafeYamlState {
  values: number;
}

function diagnostic(
  code: BaseDiagnostic["code"],
  message: string,
  path?: string
): BaseDiagnostic {
  return { code, message, ...(path ? { path } : {}) };
}

function safeYamlValue(value: unknown, state: SafeYamlState, depth = 0, path = "root"): unknown {
  state.values += 1;
  if (depth > maximumBaseDepth || state.values > maximumBaseValues) {
    throw new RangeError("Base YAML 구조가 허용 범위를 초과했습니다.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`${path}에 유한하지 않은 숫자가 있습니다.`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > maximumBaseStringLength) {
      throw new RangeError(`${path}의 문자열이 너무 깁니다.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => safeYamlValue(item, state, depth + 1, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`${path}에 지원하지 않는 YAML 값이 있습니다.`);
  }

  const safe = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (dangerousKeys.has(key)) {
      throw new TypeError(`${path}.${key} 키는 사용할 수 없습니다.`);
    }
    safe[key] = safeYamlValue(item, state, depth + 1, `${path}.${key}`);
  }
  return safe;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maximum = 240): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function direction(value: unknown): BaseSortDirection {
  return typeof value === "string" && value.toLocaleUpperCase() === "DESC" ? "DESC" : "ASC";
}

function parseFilter(value: unknown, path: string, errors: BaseDiagnostic[]): BaseFilterSource | undefined {
  if (typeof value === "string") {
    const statement = value.trim();
    if (!statement) {
      errors.push(diagnostic("invalid-schema", "빈 필터 문장은 사용할 수 없습니다.", path));
      return undefined;
    }
    return statement;
  }
  const source = record(value);
  if (!source) {
    errors.push(diagnostic("invalid-schema", "필터는 문자열 또는 and/or/not 객체여야 합니다.", path));
    return undefined;
  }
  const operators = ["and", "or", "not"].filter((key) => Object.hasOwn(source, key));
  if (operators.length !== 1 || Object.keys(source).length !== 1) {
    errors.push(diagnostic("invalid-schema", "필터 객체에는 and, or, not 중 하나만 사용할 수 있습니다.", path));
    return undefined;
  }
  const operator = operators[0] as "and" | "or" | "not";
  const items = source[operator];
  if (!Array.isArray(items) || items.length === 0 || items.length > 1_000) {
    errors.push(diagnostic("invalid-schema", `${operator} 필터에는 1~1000개의 조건이 필요합니다.`, path));
    return undefined;
  }
  const children = items.map((item, index) => parseFilter(item, `${path}.${operator}[${index}]`, errors));
  if (children.some((child) => child === undefined)) {
    return undefined;
  }
  return { [operator]: children as BaseFilterSource[] };
}

function parseProperties(value: unknown, warnings: BaseDiagnostic[]): Record<string, BasePropertyConfig> {
  const source = record(value);
  if (!source) {
    return {};
  }
  const properties: Record<string, BasePropertyConfig> = Object.create(null);
  for (const [key, rawConfig] of Object.entries(source).slice(0, 2_000)) {
    const config = record(rawConfig);
    if (!config) {
      warnings.push(diagnostic("unsupported-option", "속성 설정은 객체여야 합니다.", `properties.${key}`));
      continue;
    }
    const displayName = text(config.displayName, 120);
    properties[key] = displayName ? { displayName } : {};
    const unsupported = Object.keys(config).filter((option) => option !== "displayName");
    if (unsupported.length) {
      warnings.push(diagnostic(
        "unsupported-option",
        `아직 지원하지 않는 속성 옵션: ${unsupported.join(", ")}`,
        `properties.${key}`
      ));
    }
  }
  return properties;
}

function parseFormulas(value: unknown, warnings: BaseDiagnostic[]): Record<string, string> {
  const source = record(value);
  if (!source) {
    return {};
  }
  const formulas: Record<string, string> = Object.create(null);
  for (const [key, rawFormula] of Object.entries(source).slice(0, 1_000)) {
    if (typeof rawFormula !== "string") {
      warnings.push(diagnostic("unsupported-formula", "계산식은 문자열이어야 하며 실행되지 않았습니다.", `formulas.${key}`));
      continue;
    }
    formulas[key] = rawFormula;
    warnings.push(diagnostic(
      "unsupported-formula",
      `계산식 '${key}'은(는) 보안을 위해 실행하지 않습니다.`,
      `formulas.${key}`
    ));
  }
  return formulas;
}

function parseSort(value: unknown, path: string, warnings: BaseDiagnostic[]): BaseSortRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 50).flatMap((item, index) => {
    if (typeof item === "string") {
      const property = text(item);
      return property ? [{ property, direction: "ASC" as const }] : [];
    }
    const config = record(item);
    const property = text(config?.property);
    if (!property) {
      warnings.push(diagnostic("unsupported-option", "정렬 속성을 확인할 수 없습니다.", `${path}[${index}]`));
      return [];
    }
    return [{ property, direction: direction(config?.direction) }];
  });
}

function parseGroup(value: unknown, path: string, warnings: BaseDiagnostic[]): BaseGroupRule | undefined {
  const config = record(value);
  const property = text(config?.property);
  if (!property) {
    if (value !== undefined) {
      warnings.push(diagnostic("unsupported-option", "그룹 속성을 확인할 수 없습니다.", path));
    }
    return undefined;
  }
  return { property, direction: direction(config?.direction) };
}

function parseView(
  value: unknown,
  index: number,
  errors: BaseDiagnostic[],
  warnings: BaseDiagnostic[]
): BaseViewConfig | null {
  const path = `views[${index}]`;
  const source = record(value);
  if (!source) {
    errors.push(diagnostic("invalid-schema", "View는 객체여야 합니다.", path));
    return null;
  }
  const rawType = text(source.type, 40);
  if (!rawType || !(["table", "cards", "list"] as string[]).includes(rawType)) {
    warnings.push(diagnostic("unsupported-view", `지원하지 않는 View 유형: ${rawType ?? "없음"}`, path));
    return null;
  }
  const name = text(source.name, 120) ?? `${rawType} ${index + 1}`;
  const order = Array.isArray(source.order)
    ? source.order.slice(0, 200).flatMap((item) => text(item) ?? [])
    : [];
  const filters = source.filters === undefined ? undefined : parseFilter(source.filters, `${path}.filters`, errors);
  const numericLimit = typeof source.limit === "number" && Number.isSafeInteger(source.limit)
    ? Math.min(10_000, Math.max(1, source.limit))
    : undefined;
  const known = new Set(["type", "name", "limit", "filters", "groupBy", "order", "sort", "sortBy", "summaries"]);
  const unsupported = Object.keys(source).filter((key) => !known.has(key));
  if (unsupported.length) {
    warnings.push(diagnostic("unsupported-option", `아직 지원하지 않는 View 옵션: ${unsupported.join(", ")}`, path));
  }
  if (source.summaries !== undefined) {
    warnings.push(diagnostic("unsupported-option", "요약 계산은 아직 지원하지 않습니다.", `${path}.summaries`));
  }
  const groupBy = parseGroup(source.groupBy, `${path}.groupBy`, warnings);
  return {
    type: rawType as BaseViewType,
    name,
    ...(filters ? { filters } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(numericLimit ? { limit: numericLimit } : {}),
    order,
    sort: parseSort(source.sort ?? source.sortBy, `${path}.sort`, warnings)
  };
}

export function parseBaseSource(source: string): BaseParseResult {
  const errors: BaseDiagnostic[] = [];
  const warnings: BaseDiagnostic[] = [];
  if (new TextEncoder().encode(source).byteLength > maximumBaseSourceBytes) {
    return {
      document: null,
      errors: [diagnostic("unsafe-yaml", "Base 파일이 512 KiB 제한을 초과했습니다.")],
      warnings
    };
  }

  try {
    const yaml = parseDocument(source, {
      customTags: [],
      merge: false,
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true
    });
    if (yaml.errors.length) {
      return {
        document: null,
        errors: yaml.errors.map((error) => diagnostic("invalid-yaml", error.message)),
        warnings
      };
    }
    if (yaml.warnings.length) {
      return {
        document: null,
        errors: yaml.warnings.map((warning) => diagnostic("invalid-yaml", warning.message)),
        warnings
      };
    }
    let unsafeNode = false;
    visit(yaml, (_key, node) => {
      if (isAlias(node) || (isNode(node) && (Boolean(node.anchor) || Boolean(node.tag)))) {
        unsafeNode = true;
        return visit.BREAK;
      }
      return undefined;
    });
    if (unsafeNode) {
      return {
        document: null,
        errors: [diagnostic("unsafe-yaml", "YAML anchor, alias, 명시적 tag는 Base에서 사용할 수 없습니다.")],
        warnings
      };
    }

    const converted = !source.trim()
      ? Object.create(null)
      : yaml.toJS({ maxAliasCount: 0, mapAsMap: false });
    const safe = safeYamlValue(converted, { values: 0 });
    const root = record(safe);
    if (!root) {
      return {
        document: null,
        errors: [diagnostic("invalid-schema", "Base 파일의 최상위 값은 YAML 객체여야 합니다.")],
        warnings
      };
    }
    for (const key of Object.keys(root)) {
      if (!supportedRootKeys.has(key)) {
        warnings.push(diagnostic("unsupported-option", `알 수 없는 최상위 옵션: ${key}`, key));
      }
    }
    const filters = root.filters === undefined ? undefined : parseFilter(root.filters, "filters", errors);
    const properties = parseProperties(root.properties, warnings);
    const formulas = parseFormulas(root.formulas, warnings);
    if (root.summaries !== undefined) {
      warnings.push(diagnostic("unsupported-option", "사용자 정의 요약 계산은 아직 지원하지 않습니다.", "summaries"));
    }
    if (root.views !== undefined && !Array.isArray(root.views)) {
      errors.push(diagnostic("invalid-schema", "views는 View 객체 목록이어야 합니다.", "views"));
    }
    const views = Array.isArray(root.views)
      ? root.views.slice(0, 100).map((view, index) => parseView(view, index, errors, warnings)).filter((view): view is BaseViewConfig => view !== null)
      : [];
    const viewNames = new Set<string>();
    for (const view of views) {
      const key = view.name.toLocaleLowerCase();
      if (viewNames.has(key)) {
        errors.push(diagnostic("invalid-schema", `View 이름 '${view.name}'이(가) 중복되었습니다.`, "views"));
      }
      viewNames.add(key);
    }
    if (!views.length && !errors.length) {
      views.push({ type: "table", name: "Table", order: ["file.name"], sort: [] });
    }
    if (errors.length) {
      return { document: null, errors, warnings };
    }
    const document: BaseDocument = {
      ...(filters ? { filters } : {}),
      formulas,
      properties,
      views
    };
    return { document, errors, warnings };
  } catch (caught) {
    return {
      document: null,
      errors: [diagnostic(
        "unsafe-yaml",
        caught instanceof Error ? caught.message : "Base YAML을 안전하게 해석하지 못했습니다."
      )],
      warnings
    };
  }
}
