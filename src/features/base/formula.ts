import type {
  BaseCellScalar,
  BaseCellValue,
  BaseDateValue,
  BaseDurationValue,
  BaseFileValue,
  BaseHtmlValue,
  BaseIconValue,
  BaseImageValue,
  BaseLinkValue,
  BaseObjectValue,
  BaseRegexValue,
  BaseTypedValue
} from "./types";

type FormulaValue = BaseCellValue;

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "regex"; value: BaseRegexValue }
  | { type: "operator"; value: string }
  | { type: "punctuation"; value: "(" | ")" | "," | "." | "[" | "]" | "{" | "}" | ":" }
  | { type: "eof" };

type FormulaNode =
  | { kind: "literal"; value: BaseCellScalar | BaseRegexValue }
  | { kind: "list"; values: FormulaNode[] }
  | { kind: "object"; entries: Array<{ key: string; value: FormulaNode }> }
  | { kind: "identifier"; name: string }
  | { kind: "member"; object: FormulaNode; property: string | number }
  | { kind: "call"; callee: FormulaNode; args: FormulaNode[] }
  | { kind: "unary"; operator: "!" | "+" | "-"; operand: FormulaNode }
  | { kind: "binary"; operator: string; left: FormulaNode; right: FormulaNode };

export interface BaseFormulaEvaluation {
  error?: string;
  value: FormulaValue;
}

export interface BaseFormulaProgram {
  evaluate(
    resolve: (property: string) => FormulaValue,
    runtime?: BaseFormulaRuntime
  ): BaseFormulaEvaluation;
}

export interface BaseFormulaRuntime {
  nowEpochMs?: number;
  randomSeed?: number;
  resolveFile?: (path: string) => BaseFileValue | undefined;
}

const MAXIMUM_EXPRESSION_LENGTH = 10_000;
const MAXIMUM_TOKENS = 2_000;
const MAXIMUM_DEPTH = 64;
const MAXIMUM_STEPS = 10_000;
const MAXIMUM_LITERAL_ITEMS = 256;
const MAXIMUM_FUNCTION_ARGUMENTS = 50;
const MAXIMUM_RESULT_STRING_LENGTH = 100_000;
const MAXIMUM_RESULT_ARRAY_ITEMS = 10_000;
const MAXIMUM_RESULT_OBJECT_KEYS = 1_000;
const MAXIMUM_RESULT_TEXT_LENGTH = 1_000_000;
const MAXIMUM_COLLECTION_ITERATIONS = 5_000;
const MAXIMUM_FORMAT_LENGTH = 256;
const MAXIMUM_REGEX_PATTERN_LENGTH = 256;
const MAXIMUM_REGEX_INPUT_LENGTH = 10_000;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const URI_SCHEME_PATTERN = /^([a-z][a-z\d+.-]*):/iu;

interface FormulaEvaluationState {
  nowEpochMs: number;
  randomState: number;
  resolveFile?: BaseFormulaRuntime["resolveFile"];
  steps: number;
}

function boundedString(value: string) {
  if (value.length > MAXIMUM_RESULT_STRING_LENGTH) {
    throw new RangeError("계산식 문자열 결과가 100,000자 제한을 초과했습니다.");
  }
  return value;
}

function safeObjectKey(key: string) {
  if (!key || key.length > 256 || FORBIDDEN_OBJECT_KEYS.has(key.toLocaleLowerCase("en-US"))) {
    throw new TypeError(`사용할 수 없는 객체 속성 이름입니다: ${key.slice(0, 64)}`);
  }
  return key;
}

function isIdentifierStart(character: string) {
  return character === "_" || /[\p{L}]/u.test(character);
}

function isIdentifierPart(character: string) {
  return character === "_" || /[\p{L}\p{N}]/u.test(character);
}

function validateRegex(source: string, flags: string): BaseRegexValue {
  if (!source || source.length > MAXIMUM_REGEX_PATTERN_LENGTH) {
    throw new RangeError("정규식 패턴은 1~256자만 허용합니다.");
  }
  if (!/^[gimsuy]*$/u.test(flags) || new Set(flags).size !== flags.length) {
    throw new SyntaxError("정규식 플래그는 중복 없이 g, i, m, s, u, y만 허용합니다.");
  }
  if (/\\(?:[1-9]|k<)/u.test(source)) {
    throw new SyntaxError("역참조 정규식은 실행 시간 예산을 보장할 수 없어 허용하지 않습니다.");
  }
  if (/\(\?(?:[=!]|<[=!])/u.test(source)) {
    throw new SyntaxError("전후방 탐색 정규식은 실행 시간 예산을 보장할 수 없어 허용하지 않습니다.");
  }
  if (/\((?:\\.|[^()])*(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/u.test(source)) {
    throw new SyntaxError("중첩 반복 정규식은 실행 시간 예산을 보장할 수 없어 허용하지 않습니다.");
  }
  if (/\((?:\\.|[^()])*\|(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/u.test(source)) {
    throw new SyntaxError("반복되는 선택 정규식은 실행 시간 예산을 보장할 수 없어 허용하지 않습니다.");
  }
  if (/(?:\.\*|\.\+)(?:\\.|[^])*?(?:\.\*|\.\+)/u.test(source)) {
    throw new SyntaxError("여러 광역 와일드카드 정규식은 허용하지 않습니다.");
  }
  for (const match of source.matchAll(/\{(\d+)(?:,(\d*))?\}/gu)) {
    const lower = Number(match[1]);
    const upper = match[2] === undefined || match[2] === "" ? lower : Number(match[2]);
    if (lower > 1_000 || upper > 1_000) throw new RangeError("정규식 반복 횟수는 1,000 이하만 허용합니다.");
  }
  try {
    new RegExp(source, flags);
  } catch {
    throw new SyntaxError("유효하지 않은 정규식입니다.");
  }
  return { __baseType: "regex", source, flags };
}

function canStartRegex(tokens: readonly Token[]) {
  const previous = tokens[tokens.length - 1];
  if (!previous || previous.type === "operator") return true;
  return previous.type === "punctuation" && ["(", "[", "{", ",", ":"].includes(previous.value);
}

function tokenize(source: string): Token[] {
  if (source.length > MAXIMUM_EXPRESSION_LENGTH) {
    throw new RangeError("계산식이 10,000자 제한을 초과했습니다.");
  }
  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MAXIMUM_TOKENS) throw new RangeError("계산식 토큰이 허용 범위를 초과했습니다.");
  };

  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index++];
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\\") {
          const escaped = source[index++];
          if (escaped === undefined) break;
          const replacements: Record<string, string> = {
            n: "\n", r: "\r", t: "\t", "\\": "\\", "\"": "\"", "'": "'"
          };
          value += replacements[escaped] ?? escaped;
        } else {
          value += current;
        }
      }
      if (!closed) throw new SyntaxError("닫히지 않은 문자열이 있습니다.");
      push({ type: "string", value: boundedString(value) });
      continue;
    }
    const numberMatch = source.slice(index).match(/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/u);
    if (numberMatch) {
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value)) throw new RangeError("유한하지 않은 숫자는 사용할 수 없습니다.");
      push({ type: "number", value });
      index += numberMatch[0].length;
      continue;
    }
    if (isIdentifierStart(character)) {
      let value = character;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) value += source[index++];
      push({ type: "identifier", value });
      continue;
    }
    if (character === "/" && canStartRegex(tokens)) {
      let value = "";
      let escaped = false;
      let inCharacterClass = false;
      let closed = false;
      index += 1;
      while (index < source.length) {
        const current = source[index++];
        if (escaped) {
          value += `\\${current}`;
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === "[") inCharacterClass = true;
        if (current === "]") inCharacterClass = false;
        if (current === "/" && !inCharacterClass) {
          closed = true;
          break;
        }
        value += current;
        if (value.length > MAXIMUM_REGEX_PATTERN_LENGTH) {
          throw new RangeError("정규식 패턴은 1~256자만 허용합니다.");
        }
      }
      if (!closed) throw new SyntaxError("닫히지 않은 정규식이 있습니다.");
      let flags = "";
      while (index < source.length && /[A-Za-z]/u.test(source[index])) flags += source[index++];
      push({ type: "regex", value: validateRegex(value, flags) });
      continue;
    }
    const doubleOperator = source.slice(index, index + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(doubleOperator)) {
      push({ type: "operator", value: doubleOperator });
      index += 2;
      continue;
    }
    if (["+", "-", "*", "/", "%", "!", ">", "<"].includes(character)) {
      push({ type: "operator", value: character });
      index += 1;
      continue;
    }
    if (["(", ")", ",", ".", "[", "]", "{", "}", ":"].includes(character)) {
      push({ type: "punctuation", value: character as Extract<Token, { type: "punctuation" }>["value"] });
      index += 1;
      continue;
    }
    throw new SyntaxError(`지원하지 않는 문자 '${character}'가 있습니다.`);
  }
  push({ type: "eof" });
  return tokens;
}

class FormulaParser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): FormulaNode {
    const expression = this.parseOr(0);
    if (this.peek().type !== "eof") throw new SyntaxError("계산식 끝에 해석할 수 없는 내용이 있습니다.");
    return expression;
  }

  private peek() { return this.tokens[this.index] ?? { type: "eof" as const }; }
  private consume() { return this.tokens[this.index++] ?? { type: "eof" as const }; }

  private matchOperator(...operators: string[]) {
    const token = this.peek();
    if (token.type !== "operator" || !operators.includes(token.value)) return undefined;
    this.consume();
    return token.value;
  }

  private matchPunctuation(value: Extract<Token, { type: "punctuation" }>["value"]) {
    const token = this.peek();
    if (token.type !== "punctuation" || token.value !== value) return false;
    this.consume();
    return true;
  }

  private expectPunctuation(value: Extract<Token, { type: "punctuation" }>["value"]) {
    if (!this.matchPunctuation(value)) throw new SyntaxError(`'${value}' 문자가 필요합니다.`);
  }

  private guardDepth(depth: number) {
    if (depth > MAXIMUM_DEPTH) throw new RangeError("계산식 중첩이 허용 범위를 초과했습니다.");
  }

  private parseOr(depth: number): FormulaNode {
    this.guardDepth(depth);
    let left = this.parseAnd(depth + 1);
    let operator: string | undefined;
    while ((operator = this.matchOperator("||"))) left = { kind: "binary", operator, left, right: this.parseAnd(depth + 1) };
    return left;
  }

  private parseAnd(depth: number): FormulaNode {
    let left = this.parseEquality(depth + 1);
    let operator: string | undefined;
    while ((operator = this.matchOperator("&&"))) left = { kind: "binary", operator, left, right: this.parseEquality(depth + 1) };
    return left;
  }

  private parseEquality(depth: number): FormulaNode {
    let left = this.parseComparison(depth + 1);
    let operator: string | undefined;
    while ((operator = this.matchOperator("==", "!="))) left = { kind: "binary", operator, left, right: this.parseComparison(depth + 1) };
    return left;
  }

  private parseComparison(depth: number): FormulaNode {
    let left = this.parseAdditive(depth + 1);
    let operator: string | undefined;
    while ((operator = this.matchOperator(">", "<", ">=", "<="))) left = { kind: "binary", operator, left, right: this.parseAdditive(depth + 1) };
    return left;
  }

  private parseAdditive(depth: number): FormulaNode {
    let left = this.parseMultiplicative(depth + 1);
    let operator: string | undefined;
    while ((operator = this.matchOperator("+", "-"))) left = { kind: "binary", operator, left, right: this.parseMultiplicative(depth + 1) };
    return left;
  }

  private parseMultiplicative(depth: number): FormulaNode {
    let left = this.parseUnary(depth + 1);
    let operator: string | undefined;
    while ((operator = this.matchOperator("*", "/", "%"))) left = { kind: "binary", operator, left, right: this.parseUnary(depth + 1) };
    return left;
  }

  private parseUnary(depth: number): FormulaNode {
    this.guardDepth(depth);
    const operator = this.matchOperator("!", "+", "-") as "!" | "+" | "-" | undefined;
    return operator ? { kind: "unary", operator, operand: this.parseUnary(depth + 1) } : this.parsePostfix(depth + 1);
  }

  private parsePostfix(depth: number): FormulaNode {
    let node = this.parsePrimary(depth + 1);
    while (true) {
      if (this.matchPunctuation(".")) {
        const token = this.consume();
        if (token.type !== "identifier") throw new SyntaxError("점 뒤에는 속성 또는 함수 이름이 필요합니다.");
        node = { kind: "member", object: node, property: token.value };
        continue;
      }
      if (this.matchPunctuation("[")) {
        const token = this.consume();
        if (token.type !== "string" && token.type !== "number") {
          throw new SyntaxError("대괄호 접근은 문자열 속성 또는 숫자 인덱스만 허용합니다.");
        }
        this.expectPunctuation("]");
        node = { kind: "member", object: node, property: token.value };
        continue;
      }
      if (this.matchPunctuation("(")) {
        const args: FormulaNode[] = [];
        if (!this.matchPunctuation(")")) {
          do {
            if (args.length >= MAXIMUM_FUNCTION_ARGUMENTS) throw new RangeError("함수 인자는 최대 50개까지 사용할 수 있습니다.");
            args.push(this.parseOr(depth + 1));
          } while (this.matchPunctuation(","));
          this.expectPunctuation(")");
        }
        node = { kind: "call", callee: node, args };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(depth: number): FormulaNode {
    this.guardDepth(depth);
    const token = this.consume();
    if (token.type === "number" || token.type === "string" || token.type === "regex") {
      return { kind: "literal", value: token.value };
    }
    if (token.type === "identifier") {
      switch (token.value.toLocaleLowerCase()) {
        case "true": return { kind: "literal", value: true };
        case "false": return { kind: "literal", value: false };
        case "null": return { kind: "literal", value: null };
        default: return { kind: "identifier", name: token.value };
      }
    }
    if (token.type === "punctuation" && token.value === "(") {
      const expression = this.parseOr(depth + 1);
      this.expectPunctuation(")");
      return expression;
    }
    if (token.type === "punctuation" && token.value === "[") {
      const values: FormulaNode[] = [];
      if (!this.matchPunctuation("]")) {
        do {
          if (values.length >= MAXIMUM_LITERAL_ITEMS) throw new RangeError("목록 리터럴은 최대 256개까지 허용합니다.");
          values.push(this.parseOr(depth + 1));
        } while (this.matchPunctuation(","));
        this.expectPunctuation("]");
      }
      return { kind: "list", values };
    }
    if (token.type === "punctuation" && token.value === "{") {
      const entries: Array<{ key: string; value: FormulaNode }> = [];
      if (!this.matchPunctuation("}")) {
        do {
          if (entries.length >= MAXIMUM_LITERAL_ITEMS) throw new RangeError("객체 리터럴은 최대 256개까지 허용합니다.");
          const keyToken = this.consume();
          if (keyToken.type !== "string" && keyToken.type !== "identifier") throw new SyntaxError("객체 속성 이름은 문자열 또는 식별자여야 합니다.");
          const key = safeObjectKey(keyToken.value);
          if (entries.some((entry) => entry.key === key)) throw new SyntaxError(`중복 객체 속성입니다: ${key}`);
          this.expectPunctuation(":");
          entries.push({ key, value: this.parseOr(depth + 1) });
        } while (this.matchPunctuation(","));
        this.expectPunctuation("}");
      }
      return { kind: "object", entries };
    }
    throw new SyntaxError("값, 속성, 목록, 객체 또는 괄호식이 필요합니다.");
  }
}

function typedValue(value: FormulaValue): BaseTypedValue | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  const candidate = value as Partial<BaseTypedValue>;
  return ["date", "duration", "file", "html", "icon", "image", "link", "object", "regex"].includes(String(candidate.__baseType))
    ? value as BaseTypedValue
    : undefined;
}

function isTyped<T extends BaseTypedValue["__baseType"]>(value: FormulaValue, type: T): value is Extract<BaseTypedValue, { __baseType: T }> {
  return typedValue(value)?.__baseType === type;
}

function dateValue(epochMs: number): BaseDateValue {
  if (!Number.isFinite(epochMs)) throw new RangeError("유효하지 않은 날짜입니다.");
  return { __baseType: "date", epochMs };
}

function durationValue(months: number, milliseconds: number): BaseDurationValue {
  if (!Number.isFinite(months) || !Number.isFinite(milliseconds)) throw new RangeError("유효하지 않은 기간입니다.");
  return { __baseType: "duration", months, milliseconds };
}

function objectValue(entries: Iterable<readonly [string, FormulaValue]>): BaseObjectValue {
  const values: Record<string, FormulaValue> = Object.create(null) as Record<string, FormulaValue>;
  let count = 0;
  for (const [rawKey, value] of entries) {
    if (++count > MAXIMUM_RESULT_OBJECT_KEYS) throw new RangeError("계산식 객체가 1,000개 속성 제한을 초과했습니다.");
    values[safeObjectKey(rawKey)] = value;
  }
  return { __baseType: "object", values };
}

function valueToText(value: FormulaValue): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(valueToText).join(", ");
  if (isTyped(value, "date")) return new Date(value.epochMs).toISOString();
  if (isTyped(value, "duration")) return `${value.months}mo ${value.milliseconds}ms`;
  if (isTyped(value, "html")) return value.source;
  if (isTyped(value, "icon")) return value.name;
  if (isTyped(value, "image")) return value.path;
  if (isTyped(value, "link")) return value.display === undefined ? value.path : valueToText(value.display);
  if (isTyped(value, "file")) return value.path;
  if (isTyped(value, "object")) return JSON.stringify(value.values);
  if (isTyped(value, "regex")) return `/${value.source}/${value.flags}`;
  return "";
}

function linkValue(path: string, display?: FormulaValue, entryId?: string): BaseLinkValue {
  const normalized = boundedString(path.trim());
  if (!normalized) throw new TypeError("빈 링크는 만들 수 없습니다.");
  const scheme = normalized.match(URI_SCHEME_PATTERN)?.[1]?.toLocaleLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") throw new TypeError(`허용하지 않는 링크 scheme입니다: ${scheme}`);
  return {
    __baseType: "link",
    path: normalized,
    external: scheme === "http" || scheme === "https",
    ...(entryId ? { entryId } : {}),
    ...(display === undefined || display === null
      ? {}
      : { display: isTyped(display, "icon") ? display : boundedString(valueToText(display)) })
  };
}

function partialFileValue(path: string): BaseFileValue {
  const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.includes("\0")) throw new TypeError("유효하지 않은 Vault 파일 경로입니다.");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return {
    __baseType: "file",
    basename: dot > 0 ? name.slice(0, dot) : name,
    embeds: [],
    ext: dot > 0 ? name.slice(dot + 1) : "",
    folder: normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "",
    links: [],
    name,
    path: normalized,
    properties: objectValue([]),
    tags: []
  };
}

function memberPath(node: FormulaNode): string[] | null {
  if (node.kind === "identifier") return [node.name];
  if (node.kind !== "member" || typeof node.property !== "string") return null;
  const parent = memberPath(node.object);
  return parent ? [...parent, node.property] : null;
}

function isEmpty(value: FormulaValue): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isTyped(value, "object")) return Object.keys(value.values).length === 0;
  return false;
}

function truthy(value: FormulaValue) { return !isEmpty(value) && value !== false && value !== 0; }
function numeric(value: FormulaValue): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function normalizeResult(value: FormulaValue): FormulaValue {
  const state = { items: 0, keys: 0, text: 0, seen: new Set<object>() };
  const visit = (candidate: FormulaValue, depth: number): FormulaValue => {
    if (depth > MAXIMUM_DEPTH) throw new RangeError("계산식 결과 중첩이 허용 범위를 초과했습니다.");
    if (candidate === undefined || candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new RangeError("계산식 숫자 결과는 유한해야 합니다.");
      return candidate;
    }
    if (typeof candidate === "string") {
      state.text += candidate.length;
      if (state.text > MAXIMUM_RESULT_TEXT_LENGTH) throw new RangeError("계산식 결과 문자열이 안전 크기를 초과했습니다.");
      return boundedString(candidate);
    }
    if (state.seen.has(candidate)) throw new TypeError("순환 객체는 계산식 결과로 사용할 수 없습니다.");
    state.seen.add(candidate);
    if (Array.isArray(candidate)) {
      state.items += candidate.length;
      if (state.items > MAXIMUM_RESULT_ARRAY_ITEMS) throw new RangeError("계산식 목록 결과가 10,000개 제한을 초과했습니다.");
      const result = candidate.map((item) => visit(item, depth + 1));
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "date")) {
      const result = dateValue(candidate.epochMs);
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "duration")) {
      const result = durationValue(candidate.months, candidate.milliseconds);
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "html")) {
      const result: BaseHtmlValue = { __baseType: "html", source: boundedString(candidate.source) };
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "icon")) {
      if (!/^[a-z0-9-]{1,64}$/u.test(candidate.name)) throw new TypeError("유효하지 않은 아이콘 이름입니다.");
      const result: BaseIconValue = { __baseType: "icon", name: candidate.name };
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "image")) {
      const result: BaseImageValue = { __baseType: "image", path: boundedString(candidate.path), external: candidate.external };
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "link")) {
      const result = linkValue(candidate.path, candidate.display, candidate.entryId);
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "file")) {
      if (!candidate.path || candidate.path.length > MAXIMUM_RESULT_STRING_LENGTH) throw new TypeError("유효하지 않은 파일 값입니다.");
      state.seen.delete(candidate);
      return candidate;
    }
    if (isTyped(candidate, "object")) {
      const entries = Object.entries(candidate.values);
      state.keys += entries.length;
      if (state.keys > MAXIMUM_RESULT_OBJECT_KEYS) throw new RangeError("계산식 객체가 1,000개 속성 제한을 초과했습니다.");
      const result = objectValue(entries.map(([key, item]) => [key, visit(item, depth + 1)] as const));
      state.seen.delete(candidate);
      return result;
    }
    if (isTyped(candidate, "regex")) {
      const result = validateRegex(candidate.source, candidate.flags);
      state.seen.delete(candidate);
      return result;
    }
    throw new TypeError("지원하지 않는 계산식 결과 형식입니다.");
  };
  return visit(value, 0);
}

function boundedJoin(values: readonly FormulaValue[], separator: string) {
  let length = Math.max(0, values.length - 1) * separator.length;
  const texts: string[] = [];
  for (const value of values) {
    const text = valueToText(value);
    length += text.length;
    if (length > MAXIMUM_RESULT_STRING_LENGTH) throw new RangeError("계산식 문자열 결합 결과가 100,000자 제한을 초과했습니다.");
    texts.push(text);
  }
  return boundedString(texts.join(separator));
}

function equalityKey(value: FormulaValue): string {
  if (isTyped(value, "link")) return `path:${value.external ? value.path : value.path.replace(/\.md$/iu, "").toLocaleLowerCase()}`;
  if (isTyped(value, "file")) return `path:${value.path.replace(/\.md$/iu, "").toLocaleLowerCase()}`;
  if (isTyped(value, "date")) return `date:${value.epochMs}`;
  if (isTyped(value, "duration")) return `duration:${value.months}:${value.milliseconds}`;
  return JSON.stringify(value);
}

function equalValues(left: FormulaValue, right: FormulaValue) {
  if (typeof left === "object" || typeof right === "object") return equalityKey(left) === equalityKey(right);
  return left === right;
}

function parseDate(input: FormulaValue): BaseDateValue | undefined {
  if (isTyped(input, "date")) return input;
  if (typeof input === "number" && Number.isFinite(input)) return dateValue(input);
  if (typeof input !== "string" || input.length > 128) return undefined;
  const epochMs = Date.parse(input);
  return Number.isFinite(epochMs) ? dateValue(epochMs) : undefined;
}

function parseDuration(input: FormulaValue): BaseDurationValue | undefined {
  if (isTyped(input, "duration")) return input;
  if (typeof input !== "string" || !input.trim() || input.length > 256) return undefined;
  const source = input.trim();
  const pattern = /([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(years?|yrs?|y|months?|mos?|M|weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gu;
  let cursor = 0;
  let months = 0;
  let milliseconds = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (source.slice(cursor, match.index).trim()) return undefined;
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount)) return undefined;
    if (unit === "M" || /^(?:months?|mos?)$/iu.test(unit)) months += amount;
    else if (/^(?:years?|yrs?|y)$/iu.test(unit)) months += amount * 12;
    else {
      const multiplier = /^(?:weeks?|w)$/iu.test(unit) ? 7 * 86_400_000
        : /^(?:days?|d)$/iu.test(unit) ? 86_400_000
          : /^(?:hours?|hrs?|h)$/iu.test(unit) ? 3_600_000
            : /^(?:minutes?|mins?|m)$/iu.test(unit) ? 60_000
              : 1_000;
      milliseconds += amount * multiplier;
    }
    cursor = pattern.lastIndex;
  }
  if (cursor === 0 || source.slice(cursor).trim()) return undefined;
  return durationValue(months, milliseconds);
}

function addDuration(date: BaseDateValue, duration: BaseDurationValue, sign: 1 | -1) {
  const value = new Date(date.epochMs);
  if (duration.months) value.setUTCMonth(value.getUTCMonth() + duration.months * sign);
  return dateValue(value.getTime() + duration.milliseconds * sign);
}

function comparable(value: FormulaValue): number | string | undefined {
  if (typeof value === "number" || typeof value === "string") return value;
  if (isTyped(value, "date")) return value.epochMs;
  if (isTyped(value, "duration") && value.months === 0) return value.milliseconds;
  return undefined;
}

function evaluateBinary(operator: string, left: FormulaValue, right: FormulaValue): FormulaValue {
  if (operator === "&&") return truthy(left) && truthy(right);
  if (operator === "||") return truthy(left) || truthy(right);
  if (operator === "==" || operator === "!=") {
    const equal = equalValues(left, right);
    return operator === "==" ? equal : !equal;
  }
  if ([">", "<", ">=", "<="].includes(operator)) {
    const a = comparable(left);
    const b = comparable(right);
    if (a === undefined || b === undefined || typeof a !== typeof b) return false;
    const comparison = typeof a === "number" ? a - (b as number) : a.localeCompare(b as string);
    if (operator === ">") return comparison > 0;
    if (operator === "<") return comparison < 0;
    if (operator === ">=") return comparison >= 0;
    return comparison <= 0;
  }
  if (isTyped(left, "date")) {
    if (isTyped(right, "date") && operator === "-") return left.epochMs - right.epochMs;
    const duration = parseDuration(right);
    if (duration && (operator === "+" || operator === "-")) return addDuration(left, duration, operator === "+" ? 1 : -1);
  }
  if (isTyped(left, "duration")) {
    if (isTyped(right, "duration") && (operator === "+" || operator === "-")) {
      const sign = operator === "+" ? 1 : -1;
      return durationValue(left.months + right.months * sign, left.milliseconds + right.milliseconds * sign);
    }
    const amount = numeric(right);
    if (amount !== undefined && (operator === "*" || operator === "/")) {
      if (operator === "/" && amount === 0) return undefined;
      const factor = operator === "*" ? amount : 1 / amount;
      return durationValue(left.months * factor, left.milliseconds * factor);
    }
  }
  if (operator === "+" && (typeof left === "string" || typeof right === "string")) {
    const leftText = valueToText(left);
    const rightText = valueToText(right);
    if (leftText.length + rightText.length > MAXIMUM_RESULT_STRING_LENGTH) throw new RangeError("계산식 문자열 결과가 100,000자 제한을 초과했습니다.");
    return boundedString(leftText + rightText);
  }
  const a = numeric(left);
  const b = numeric(right);
  if (a === undefined || b === undefined) return undefined;
  switch (operator) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? undefined : a / b;
    case "%": return b === 0 ? undefined : a % b;
    default: return undefined;
  }
}

function numbersFrom(value: FormulaValue) {
  return (Array.isArray(value) ? value : [value]).filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function minimum(values: readonly number[]) {
  if (!values.length) return undefined;
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) if (values[index] < result) result = values[index];
  return result;
}

function maximum(values: readonly number[]) {
  if (!values.length) return undefined;
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) if (values[index] > result) result = values[index];
  return result;
}

function boundedArguments(args: readonly FormulaValue[]): FormulaValue[] {
  const values: FormulaValue[] = [];
  for (const argument of args) {
    const candidates = Array.isArray(argument) ? argument : [argument];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      if (values.length >= MAXIMUM_RESULT_ARRAY_ITEMS) throw new RangeError("계산식 목록 인자가 10,000개 제한을 초과했습니다.");
      values.push(candidate);
    }
  }
  return values;
}

function typeName(value: FormulaValue) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "list";
  return typedValue(value)?.__baseType ?? typeof value;
}

function formatDate(value: BaseDateValue, pattern: string) {
  if (pattern.length > MAXIMUM_FORMAT_LENGTH) throw new RangeError("날짜 형식은 최대 256자까지 허용합니다.");
  const date = new Date(value.epochMs);
  const pad = (number: number, length = 2) => String(number).padStart(length, "0");
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hour12 = date.getUTCHours() % 12 || 12;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - startOfYear) / 86_400_000) + 1;
  const replacements: Record<string, string> = {
    YYYY: pad(date.getUTCFullYear(), 4),
    YY: pad(date.getUTCFullYear() % 100),
    MMMM: monthNames[date.getUTCMonth()],
    MMM: monthNames[date.getUTCMonth()].slice(0, 3),
    MM: pad(date.getUTCMonth() + 1),
    M: String(date.getUTCMonth() + 1),
    DDDD: pad(dayOfYear, 3),
    DDD: String(dayOfYear),
    DD: pad(date.getUTCDate()),
    D: String(date.getUTCDate()),
    dddd: weekdayNames[date.getUTCDay()],
    ddd: weekdayNames[date.getUTCDay()].slice(0, 3),
    dd: weekdayNames[date.getUTCDay()].slice(0, 2),
    d: String(date.getUTCDay()),
    HH: pad(date.getUTCHours()),
    H: String(date.getUTCHours()),
    hh: pad(hour12),
    h: String(hour12),
    mm: pad(date.getUTCMinutes()),
    m: String(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
    s: String(date.getUTCSeconds()),
    SSS: pad(date.getUTCMilliseconds(), 3),
    A: date.getUTCHours() < 12 ? "AM" : "PM",
    a: date.getUTCHours() < 12 ? "am" : "pm",
    Q: String(Math.floor(date.getUTCMonth() / 3) + 1),
    X: String(Math.floor(value.epochMs / 1_000)),
    x: String(value.epochMs),
    Z: "+00:00"
  };
  const tokenPattern = /\[[^\]]*\]|YYYY|MMMM|DDDD|dddd|SSS|MMM|DDD|ddd|YY|MM|DD|dd|HH|hh|mm|ss|M|D|d|H|h|m|s|A|a|Q|X|x|Z/gu;
  return boundedString(pattern.replace(tokenPattern, (token) => (
    token.startsWith("[") ? token.slice(1, -1) : replacements[token]
  )));
}

function safeRegExp(value: BaseRegexValue, mode: "stateful" | "test" = "stateful") {
  validateRegex(value.source, value.flags);
  const flags = mode === "test" ? value.flags.replace(/[gy]/gu, "") : value.flags;
  return new RegExp(value.source, flags);
}

function boundedRegexInput(value: string) {
  if (value.length > MAXIMUM_REGEX_INPUT_LENGTH) {
    throw new RangeError("정규식 입력은 최대 10,000자까지 허용합니다.");
  }
  return value;
}

function replacementExpansionUpperBound(
  replacement: string,
  matchIndex: number,
  matchLength: number,
  inputLength: number
) {
  let length = replacement.length;
  for (const reference of replacement.matchAll(/\$(?:&|`|'|\d{1,2})/gu)) {
    if (reference[0] === "$`") length += matchIndex;
    else if (reference[0] === "$'") length += Math.max(0, inputLength - matchIndex - matchLength);
    else length += matchLength;
    if (length > MAXIMUM_RESULT_STRING_LENGTH) return length;
  }
  return length;
}

function boundedRegexReplace(receiver: string, pattern: BaseRegexValue, replacement: string) {
  boundedRegexInput(receiver);
  if (replacement.length > 10_000) throw new RangeError("정규식 치환 문자열은 최대 10,000자까지 허용합니다.");
  const expression = safeRegExp(pattern, "stateful");
  const globalExpression = new RegExp(expression.source, expression.flags.includes("g")
    ? expression.flags
    : `${expression.flags.replace("y", "")}g`);
  let projectedLength = receiver.length;
  let matchCount = 0;
  for (const match of receiver.matchAll(globalExpression)) {
    matchCount += 1;
    if (matchCount > MAXIMUM_REGEX_INPUT_LENGTH + 1) throw new RangeError("정규식 일치 횟수가 안전 예산을 초과했습니다.");
    projectedLength += replacementExpansionUpperBound(
      replacement,
      match.index,
      match[0].length,
      receiver.length
    ) - match[0].length;
    if (projectedLength > MAXIMUM_RESULT_STRING_LENGTH) {
      throw new RangeError("정규식 치환 결과가 100,000자 제한을 초과할 수 있습니다.");
    }
    if (!expression.global) break;
  }
  return boundedString(receiver.replace(expression, replacement));
}

function invokeMethod(
  receiver: FormulaValue,
  method: string,
  args: FormulaValue[],
  state: FormulaEvaluationState
): FormulaValue {
  const normalized = method.toLocaleLowerCase();
  if (normalized === "isempty") return isEmpty(receiver);
  if (normalized === "istruthy") return truthy(receiver);
  if (normalized === "istype") return typeName(receiver) === String(args[0] ?? "").toLocaleLowerCase();
  if (normalized === "tostring") return boundedString(valueToText(receiver));
  if (normalized === "contains" || normalized === "containsall" || normalized === "containsany") {
    const expected = boundedArguments(args);
    const predicate = (value: FormulaValue) => typeof receiver === "string"
      ? receiver.includes(valueToText(value))
      : Array.isArray(receiver) && receiver.some((item) => equalValues(item, value));
    if (normalized === "contains") return predicate(expected[0]);
    return normalized === "containsall" ? expected.every(predicate) : expected.some(predicate);
  }
  if (isTyped(receiver, "regex")) {
    if (normalized === "matches") return safeRegExp(receiver, "test").test(boundedRegexInput(valueToText(args[0])));
    throw new TypeError(`지원하지 않는 정규식 계산식 메서드입니다: ${method}`);
  }
  if (typeof receiver === "string") {
    switch (normalized) {
      case "lower": return receiver.toLocaleLowerCase();
      case "upper": return receiver.toLocaleUpperCase();
      case "trim": return receiver.trim();
      case "startswith": return receiver.startsWith(valueToText(args[0]));
      case "endswith": return receiver.endsWith(valueToText(args[0]));
      case "replace": {
        if (isTyped(args[0], "regex")) return boundedRegexReplace(receiver, args[0], valueToText(args[1]));
        const search = valueToText(args[0]);
        const replacement = valueToText(args[1]);
        if (!search) throw new RangeError("빈 문자열 전체 치환은 사용할 수 없습니다.");
        let projectedLength = receiver.length;
        let offset = 0;
        while (true) {
          const matchIndex = receiver.indexOf(search, offset);
          if (matchIndex === -1) break;
          projectedLength += replacementExpansionUpperBound(
            replacement,
            matchIndex,
            search.length,
            receiver.length
          ) - search.length;
          offset = matchIndex + search.length;
          if (projectedLength > MAXIMUM_RESULT_STRING_LENGTH) {
            throw new RangeError("계산식 문자열 치환 결과가 100,000자 제한을 초과했습니다.");
          }
        }
        return boundedString(receiver.replaceAll(search, replacement));
      }
      case "repeat": {
        const count = Math.trunc(numeric(args[0]) ?? 0);
        if (count < 0 || receiver.length * count > MAXIMUM_RESULT_STRING_LENGTH) throw new RangeError("계산식 문자열 반복 결과가 100,000자 제한을 초과했습니다.");
        return receiver.repeat(count);
      }
      case "reverse": return [...receiver].reverse().join("");
      case "slice": return receiver.slice(numeric(args[0]) ?? 0, numeric(args[1]));
      case "split": {
        if (isTyped(args[0], "regex")) {
          boundedRegexInput(receiver);
          const limit = Math.max(0, Math.min(MAXIMUM_RESULT_ARRAY_ITEMS, Math.trunc(numeric(args[1]) ?? MAXIMUM_RESULT_ARRAY_ITEMS)));
          return receiver.split(safeRegExp(args[0], "stateful"), limit);
        }
        const separator = valueToText(args[0]);
        if (!separator) throw new TypeError("빈 구분자로 문자열을 나눌 수 없습니다.");
        const limit = Math.max(0, Math.min(MAXIMUM_RESULT_ARRAY_ITEMS, Math.trunc(numeric(args[1]) ?? MAXIMUM_RESULT_ARRAY_ITEMS)));
        return receiver.split(separator, limit);
      }
      case "title": return receiver.replace(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu, (word) => word[0].toLocaleUpperCase() + word.slice(1).toLocaleLowerCase());
      default: throw new TypeError(`지원하지 않는 문자열 계산식 메서드입니다: ${method}`);
    }
  }
  if (typeof receiver === "number") {
    const digits = Math.max(0, Math.min(12, Math.trunc(numeric(args[0]) ?? 0)));
    switch (normalized) {
      case "round": { const factor = 10 ** digits; return Math.round(receiver * factor) / factor; }
      case "tofixed": return receiver.toFixed(digits);
      case "abs": return Math.abs(receiver);
      case "ceil": return Math.ceil(receiver);
      case "floor": return Math.floor(receiver);
      default: throw new TypeError(`지원하지 않는 숫자 계산식 메서드입니다: ${method}`);
    }
  }
  if (Array.isArray(receiver)) {
    const numbers = numbersFrom(receiver);
    switch (normalized) {
      case "join": return boundedJoin(receiver, valueToText(args[0]) || ", ");
      case "flat": return boundedArguments(receiver);
      case "reverse": return receiver.slice().reverse();
      case "slice": return receiver.slice(numeric(args[0]) ?? 0, numeric(args[1]));
      case "sort": return receiver.slice().sort((left, right) => valueToText(left).localeCompare(valueToText(right), undefined, { numeric: true }));
      case "sum": return numbers.reduce((sum, value) => sum + value, 0);
      case "mean": return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : undefined;
      case "min": return minimum(numbers);
      case "max": return maximum(numbers);
      case "median": {
        if (!numbers.length) return undefined;
        const sorted = numbers.slice().sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      }
      case "stddev": {
        if (!numbers.length) return undefined;
        const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
        return Math.sqrt(numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / numbers.length);
      }
      case "unique": return [...new Map(receiver.map((value) => [equalityKey(value), value])).values()];
      default: throw new TypeError(`지원하지 않는 목록 계산식 메서드입니다: ${method}`);
    }
  }
  if (isTyped(receiver, "date")) {
    const date = new Date(receiver.epochMs);
    switch (normalized) {
      case "date": return dateValue(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      case "format": return formatDate(receiver, valueToText(args[0]));
      case "time": return formatDate(receiver, "HH:mm:ss");
      case "relative": {
        const difference = receiver.epochMs - state.nowEpochMs;
        const absolute = Math.abs(difference);
        const [amount, unit] = absolute >= 86_400_000 ? [Math.round(absolute / 86_400_000), "day"]
          : absolute >= 3_600_000 ? [Math.round(absolute / 3_600_000), "hour"]
            : absolute >= 60_000 ? [Math.round(absolute / 60_000), "minute"] : [Math.round(absolute / 1_000), "second"];
        return `${amount} ${unit}${amount === 1 ? "" : "s"} ${difference < 0 ? "ago" : "from now"}`;
      }
      default: throw new TypeError(`지원하지 않는 날짜 계산식 메서드입니다: ${method}`);
    }
  }
  if (isTyped(receiver, "object")) {
    switch (normalized) {
      case "keys": return Object.keys(receiver.values);
      case "values": return Object.values(receiver.values);
      default: throw new TypeError(`지원하지 않는 객체 계산식 메서드입니다: ${method}`);
    }
  }
  if (isTyped(receiver, "link")) {
    if (normalized === "asfile") {
      if (receiver.external) return undefined;
      const path = receiver.path.replace(/^\[\[|\]\]$/gu, "");
      return state.resolveFile?.(path) ?? partialFileValue(path);
    }
    if (normalized === "linksto") {
      const source = receiver.external ? undefined : state.resolveFile?.(receiver.path.replace(/^\[\[|\]\]$/gu, ""));
      if (!source) return false;
      return invokeMethod(source, "hasLink", args, state);
    }
    throw new TypeError(`지원하지 않는 링크 계산식 메서드입니다: ${method}`);
  }
  if (isTyped(receiver, "file")) {
    switch (normalized) {
      case "aslink": return linkValue(receiver.path, args[0], receiver.entryId);
      case "haslink": {
        const expected = args[0];
        const path = isTyped(expected, "file") || isTyped(expected, "link") ? expected.path : valueToText(expected);
        const normalized = path.replace(/\.md$/iu, "").toLocaleLowerCase();
        return receiver.links.some((link) => {
          const candidate = link.path.replace(/\.md$/iu, "").toLocaleLowerCase();
          return candidate === normalized || (!normalized.includes("/") && candidate.slice(candidate.lastIndexOf("/") + 1) === normalized);
        });
      }
      case "hasproperty": return Object.hasOwn(receiver.properties.values, valueToText(args[0]));
      case "hastag": return args.some((value) => {
        const expected = valueToText(value).replace(/^#/u, "").toLocaleLowerCase();
        return receiver.tags.some((tag) => {
          const actual = tag.replace(/^#/u, "").toLocaleLowerCase();
          return actual === expected || actual.startsWith(`${expected}/`);
        });
      });
      case "infolder": {
        const expected = valueToText(args[0]).replace(/^\/+|\/+$/gu, "").toLocaleLowerCase();
        const actual = receiver.folder.toLocaleLowerCase();
        return actual === expected || actual.startsWith(`${expected}/`);
      }
      default: throw new TypeError(`지원하지 않는 파일 계산식 메서드입니다: ${method}`);
    }
  }
  throw new TypeError(`지원하지 않는 계산식 메서드 또는 값 형식입니다: ${method}`);
}

function nextRandom(state: FormulaEvaluationState) {
  let value = state.randomState >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState / 0x1_0000_0000;
}

function safeRenderablePath(path: string, valueType: "image" | "link") {
  const normalized = boundedString(path.trim());
  if (!normalized) throw new TypeError(`빈 ${valueType} 경로는 사용할 수 없습니다.`);
  const scheme = normalized.match(URI_SCHEME_PATTERN)?.[1]?.toLocaleLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") throw new TypeError(`허용하지 않는 ${valueType} scheme입니다: ${scheme}`);
  return { normalized, external: scheme === "http" || scheme === "https" };
}

function invokeFunction(
  name: string,
  args: FormulaValue[],
  state: FormulaEvaluationState
): FormulaValue {
  switch (name.toLocaleLowerCase()) {
    case "escapehtml": return boundedString(valueToText(args[0]).replace(/[&<>"']/gu, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]!));
    case "date": return parseDate(args[0]);
    case "duration": return parseDuration(args[0]);
    case "file": {
      const input = args[0];
      if (isTyped(input, "file")) return input;
      if (isTyped(input, "link")) {
        if (input.external) return undefined;
        const path = input.path.replace(/^\[\[|\]\]$/gu, "");
        return state.resolveFile?.(path) ?? partialFileValue(path);
      }
      const path = valueToText(input);
      return state.resolveFile?.(path) ?? partialFileValue(path);
    }
    case "html": return { __baseType: "html", source: boundedString(valueToText(args[0])) };
    case "image": {
      const input = args[0];
      const path = isTyped(input, "file") ? input.path : valueToText(input);
      const safe = safeRenderablePath(path, "image");
      return { __baseType: "image", path: safe.normalized, external: safe.external };
    }
    case "icon": {
      const iconName = valueToText(args[0]).toLocaleLowerCase();
      if (!/^[a-z0-9-]{1,64}$/u.test(iconName)) throw new TypeError("아이콘 이름은 영문 소문자, 숫자, 하이픈만 허용합니다.");
      return { __baseType: "icon", name: iconName };
    }
    case "link": {
      const input = args[0];
      if (isTyped(input, "file")) return linkValue(input.path, args[1], input.entryId);
      const path = valueToText(input);
      const resolved = /^[a-z][a-z\d+.-]*:/iu.test(path) ? undefined : state.resolveFile?.(path);
      return linkValue(resolved?.path ?? path, args[1], resolved?.entryId);
    }
    case "list": return Array.isArray(args[0]) ? args[0] : [args[0]];
    case "now": return dateValue(state.nowEpochMs);
    case "today": {
      const now = new Date(state.nowEpochMs);
      return dateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime());
    }
    case "number": {
      const input = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (isTyped(input, "date")) return input.epochMs;
      if (typeof input === "boolean") return input ? 1 : 0;
      const value = Number(input);
      if (!Number.isFinite(value)) throw new TypeError("숫자로 변환할 수 없는 값입니다.");
      return value;
    }
    case "string": return Array.isArray(args[0]) ? boundedJoin(args[0], ", ") : boundedString(valueToText(args[0]));
    case "boolean": return truthy(args[0]);
    case "min": return minimum(numbersFrom(boundedArguments(args)));
    case "max": return maximum(numbersFrom(boundedArguments(args)));
    case "abs": return typeof args[0] === "number" ? Math.abs(args[0]) : undefined;
    case "ceil": return typeof args[0] === "number" ? Math.ceil(args[0]) : undefined;
    case "floor": return typeof args[0] === "number" ? Math.floor(args[0]) : undefined;
    case "round": return invokeMethod(args[0], "round", args.slice(1), state);
    case "random": return nextRandom(state);
    default: throw new TypeError(`지원하지 않는 계산식 함수입니다: ${name}`);
  }
}

function memberValue(object: FormulaValue, property: string | number): FormulaValue {
  if (typeof property === "string" && FORBIDDEN_OBJECT_KEYS.has(property.toLocaleLowerCase("en-US"))) {
    throw new TypeError(`사용할 수 없는 객체 속성 이름입니다: ${property}`);
  }
  if (Array.isArray(object)) {
    if (typeof property === "number") {
      const index = Math.trunc(property);
      return index >= 0 && index < object.length ? object[index] : undefined;
    }
    if (property.toLocaleLowerCase() === "length") return object.length;
  }
  if (typeof object === "string" && typeof property === "string" && property.toLocaleLowerCase() === "length") return [...object].length;
  if (isTyped(object, "object") && typeof property === "string") return object.values[property];
  if (isTyped(object, "date") && typeof property === "string") {
    const date = new Date(object.epochMs);
    switch (property.toLocaleLowerCase()) {
      case "year": return date.getUTCFullYear();
      case "month": return date.getUTCMonth() + 1;
      case "day": return date.getUTCDate();
      case "hour": return date.getUTCHours();
      case "minute": return date.getUTCMinutes();
      case "second": return date.getUTCSeconds();
      case "millisecond": return date.getUTCMilliseconds();
      default: return undefined;
    }
  }
  if (isTyped(object, "file") && typeof property === "string") {
    const fields: Record<string, FormulaValue> = {
      backlinks: object.backlinks, basename: object.basename, ctime: object.createdAt, embeds: object.embeds,
      ext: object.ext, file: object, folder: object.folder, links: object.links, mtime: object.updatedAt,
      name: object.name, path: object.path, properties: object.properties, size: object.size, tags: object.tags
    };
    return fields[property.toLocaleLowerCase()];
  }
  if (isTyped(object, "link") && typeof property === "string") {
    if (property.toLocaleLowerCase() === "path") return object.path;
    if (property.toLocaleLowerCase() === "display") return object.display;
  }
  if (isTyped(object, "duration") && typeof property === "string") {
    if (property.toLocaleLowerCase() === "months") return object.months;
    if (property.toLocaleLowerCase() === "milliseconds") return object.milliseconds;
  }
  return undefined;
}

function evaluateCollectionExpression(
  receiver: FormulaValue[],
  method: string,
  args: FormulaNode[],
  resolve: (property: string) => FormulaValue,
  state: FormulaEvaluationState
): FormulaValue {
  if (receiver.length > MAXIMUM_COLLECTION_ITERATIONS) throw new RangeError("map/filter/reduce는 한 번에 최대 5,000개 항목까지 실행합니다.");
  const normalized = method.toLocaleLowerCase();
  if ((normalized === "map" || normalized === "filter") && args.length !== 1) throw new TypeError(`${method} 함수는 표현식 하나만 받습니다.`);
  if (normalized === "reduce" && args.length !== 2) throw new TypeError("reduce 함수는 표현식과 초기값을 받습니다.");
  if (normalized === "map" || normalized === "filter") {
    const output: FormulaValue[] = [];
    receiver.forEach((value, index) => {
      const result = evaluateNode(args[0], (property) => {
        const key = property.toLocaleLowerCase();
        if (key === "value") return value;
        if (key === "index") return index;
        return resolve(property);
      }, state);
      if (normalized === "map") output.push(result);
      else if (truthy(result)) output.push(value);
    });
    return output;
  }
  let accumulator = evaluateNode(args[1], resolve, state);
  receiver.forEach((value, index) => {
    accumulator = evaluateNode(args[0], (property) => {
      const key = property.toLocaleLowerCase();
      if (key === "value") return value;
      if (key === "index") return index;
      if (key === "acc") return accumulator;
      return resolve(property);
    }, state);
  });
  return accumulator;
}

function evaluateNode(node: FormulaNode, resolve: (property: string) => FormulaValue, state: FormulaEvaluationState): FormulaValue {
  state.steps += 1;
  if (state.steps > MAXIMUM_STEPS) throw new RangeError("계산식 실행 단계가 허용 범위를 초과했습니다.");
  switch (node.kind) {
    case "literal": return node.value;
    case "list": return node.values.map((value) => evaluateNode(value, resolve, state));
    case "object": return objectValue(node.entries.map(({ key, value }) => [key, evaluateNode(value, resolve, state)] as const));
    case "identifier": return normalizeResult(resolve(node.name));
    case "member": {
      const path = memberPath(node);
      if (path) {
        const resolved = normalizeResult(resolve(path.join(".")));
        if (resolved !== undefined) return resolved;
      }
      return memberValue(evaluateNode(node.object, resolve, state), node.property);
    }
    case "unary": {
      const value = evaluateNode(node.operand, resolve, state);
      if (node.operator === "!") return !truthy(value);
      const number = numeric(value);
      return number === undefined ? undefined : node.operator === "-" ? -number : number;
    }
    case "binary": {
      const left = evaluateNode(node.left, resolve, state);
      if (node.operator === "&&" && !truthy(left)) return false;
      if (node.operator === "||" && truthy(left)) return true;
      return normalizeResult(evaluateBinary(node.operator, left, evaluateNode(node.right, resolve, state)));
    }
    case "call": {
      if (node.callee.kind === "identifier" && node.callee.name.toLocaleLowerCase() === "if") {
        if (node.args.length < 2 || node.args.length > 3) throw new TypeError("if 함수는 조건, 참 값, 선택적인 거짓 값만 받습니다.");
        return truthy(evaluateNode(node.args[0], resolve, state))
          ? evaluateNode(node.args[1], resolve, state)
          : node.args[2] ? evaluateNode(node.args[2], resolve, state) : null;
      }
      if (node.callee.kind === "identifier") {
        return normalizeResult(invokeFunction(
          node.callee.name,
          node.args.map((argument) => evaluateNode(argument, resolve, state)),
          state
        ));
      }
      if (node.callee.kind === "member") {
        const receiver = evaluateNode(node.callee.object, resolve, state);
        const method = String(node.callee.property);
        if (Array.isArray(receiver) && ["map", "filter", "reduce"].includes(method.toLocaleLowerCase())) {
          return normalizeResult(evaluateCollectionExpression(receiver, method, node.args, resolve, state));
        }
        return normalizeResult(invokeMethod(
          receiver,
          method,
          node.args.map((argument) => evaluateNode(argument, resolve, state)),
          state
        ));
      }
      throw new TypeError("호출할 수 없는 계산식 값입니다.");
    }
  }
}

export function compileBaseFormula(source: string): BaseFormulaProgram {
  const expression = new FormulaParser(tokenize(source)).parse();
  return {
    evaluate(resolve, runtime) {
      try {
        let seed = runtime?.randomSeed;
        if (!Number.isSafeInteger(seed)) {
          const random = new Uint32Array(1);
          globalThis.crypto?.getRandomValues?.(random);
          seed = random[0] || Math.floor(Math.random() * 0xffff_ffff);
        }
        return { value: normalizeResult(evaluateNode(expression, resolve, {
          nowEpochMs: Number.isFinite(runtime?.nowEpochMs) ? runtime!.nowEpochMs! : Date.now(),
          randomState: (seed! >>> 0) || 0x9e37_79b9,
          resolveFile: runtime?.resolveFile,
          steps: 0
        })) };
      } catch (caught) {
        return { value: undefined, error: caught instanceof Error ? caught.message : "계산식을 안전하게 실행하지 못했습니다." };
      }
    }
  };
}

export function tryCompileBaseFormula(source: string): { error?: string; program?: BaseFormulaProgram } {
  try {
    return { program: compileBaseFormula(source) };
  } catch (caught) {
    return { error: caught instanceof Error ? caught.message : "계산식을 해석하지 못했습니다." };
  }
}
