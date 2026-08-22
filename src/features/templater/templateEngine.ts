const MAX_TEMPLATE_CHARACTERS = 500_000;
const MAX_TEMPLATE_PROMPTS = 20;
const TOKEN_PATTERN = /\{\{\s*([^{}]{1,80}?)\s*\}\}/gu;
const SAFE_FORMAT_PATTERN = /^[YMDHms\-/. :_]{1,40}$/u;

function isSafePromptLabel(value: string) {
  if (!value || value.length > 60 || value.includes("{") || value.includes("}")) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

export interface TemplateRenderContext {
  inputs?: Readonly<Record<string, string>>;
  now: Date;
  path?: string;
  selection?: string;
  title: string;
}

export interface TemplateRenderResult {
  cursorOffset?: number;
  text: string;
  warnings: string[];
}

export interface TemplateInsertionResult {
  cursor: number;
  text: string;
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function formatDate(now: Date, format: string) {
  const replacements: Record<string, string> = {
    YYYY: String(now.getFullYear()).padStart(4, "0"),
    MM: twoDigits(now.getMonth() + 1),
    DD: twoDigits(now.getDate()),
    HH: twoDigits(now.getHours()),
    mm: twoDigits(now.getMinutes()),
    ss: twoDigits(now.getSeconds())
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/gu, (token) => replacements[token]);
}

export function safeTemplatePromptNames(source: string) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const expression = match[1].trim();
    if (!expression.toLocaleLowerCase().startsWith("prompt:")) continue;
    const label = expression.slice(expression.indexOf(":") + 1).trim();
    if (!isSafePromptLabel(label) || seen.has(label)) continue;
    seen.add(label);
    names.push(label);
    if (names.length >= MAX_TEMPLATE_PROMPTS) break;
  }
  return names;
}

/**
 * Render the deliberately small QuickMemo template language.
 *
 * This function never evaluates JavaScript, expressions, HTML, network calls,
 * or property access. Unknown tokens stay as literal Markdown so a template
 * cannot silently lose user data.
 */
export function renderSafeTemplate(
  source: string,
  context: TemplateRenderContext
): TemplateRenderResult {
  if (source.length > MAX_TEMPLATE_CHARACTERS || new TextEncoder().encode(source).byteLength > MAX_TEMPLATE_CHARACTERS) {
    throw new Error("템플릿은 500,000자를 넘을 수 없습니다.");
  }
  const warnings = new Set<string>();
  let output = "";
  let previousEnd = 0;
  let cursorOffset: number | undefined;

  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    output += source.slice(previousEnd, start);
    const expression = match[1].trim();
    const normalized = expression.toLocaleLowerCase();
    let replacement: string | null = null;

    if (normalized === "title") {
      replacement = context.title;
    } else if (normalized === "path") {
      if (typeof context.path === "string") {
        replacement = context.path;
      } else {
        warnings.add("현재 노트 경로가 없어 {{path}} 토큰을 원문으로 남겼습니다.");
      }
    } else if (normalized === "date") {
      replacement = formatDate(context.now, "YYYY-MM-DD");
    } else if (normalized === "time") {
      replacement = formatDate(context.now, "HH:mm");
    } else if (normalized === "selection") {
      if (typeof context.selection === "string") {
        replacement = context.selection;
      } else {
        warnings.add("선택한 텍스트가 없어 {{selection}} 토큰을 원문으로 남겼습니다.");
      }
    } else if (normalized === "cursor") {
      if (cursorOffset === undefined) cursorOffset = output.length;
      replacement = "";
    } else if (normalized.startsWith("date:") || normalized.startsWith("time:")) {
      const format = expression.slice(expression.indexOf(":") + 1).trim();
      if (SAFE_FORMAT_PATTERN.test(format)) {
        replacement = formatDate(context.now, format);
      } else {
        warnings.add("날짜·시간 형식은 YYYY, MM, DD, HH, mm, ss와 구분자만 사용할 수 있습니다.");
      }
    } else if (normalized.startsWith("prompt:")) {
      const label = expression.slice(expression.indexOf(":") + 1).trim();
      if (!isSafePromptLabel(label)) {
        warnings.add("입력 요청 이름은 제어 문자와 중괄호 없이 1~60자로 작성해주세요.");
      } else if (context.inputs && Object.hasOwn(context.inputs, label)) {
        replacement = context.inputs[label];
      } else {
        warnings.add(`입력값이 없는 안전 템플릿 토큰을 원문으로 남겼습니다: ${label}`);
      }
    }

    if (replacement === null) {
      output += match[0];
      warnings.add(`지원하지 않는 템플릿 토큰은 실행하지 않았습니다: ${expression.slice(0, 40)}`);
    } else {
      output += replacement;
    }
    previousEnd = start + match[0].length;
  }
  output += source.slice(previousEnd);

  if (/<%[\s\S]*?%>/u.test(source) || /\{\{\s*(?:js|eval|script)\s*:/iu.test(source)) {
    warnings.add("스크립트 템플릿은 보안을 위해 실행하지 않고 원문으로 남겼습니다.");
  }
  if (output.length > MAX_TEMPLATE_CHARACTERS || new TextEncoder().encode(output).byteLength > MAX_TEMPLATE_CHARACTERS) {
    throw new Error("렌더링한 템플릿은 500,000바이트를 넘을 수 없습니다.");
  }
  return {
    ...(cursorOffset === undefined ? {} : { cursorOffset }),
    text: output,
    warnings: [...warnings]
  };
}

/**
 * Applies a rendered template to a bounded editor selection. The helper is
 * deliberately DOM/editor agnostic so CodeMirror and plain Markdown imports
 * use the exact same cursor semantics. The first {{cursor}} token wins.
 */
export function applyTemplateInsertion(
  currentText: string,
  selectionStart: number,
  selectionEnd: number,
  rendered: Pick<TemplateRenderResult, "cursorOffset" | "text">
): TemplateInsertionResult {
  if (currentText.length > MAX_TEMPLATE_CHARACTERS
    || new TextEncoder().encode(currentText).byteLength > MAX_TEMPLATE_CHARACTERS) {
    throw new Error("현재 노트는 안전한 템플릿 삽입 크기를 초과했습니다.");
  }
  const start = Math.max(0, Math.min(currentText.length, Math.trunc(selectionStart)));
  const end = Math.max(start, Math.min(currentText.length, Math.trunc(selectionEnd)));
  const text = `${currentText.slice(0, start)}${rendered.text}${currentText.slice(end)}`;
  if (text.length > MAX_TEMPLATE_CHARACTERS
    || new TextEncoder().encode(text).byteLength > MAX_TEMPLATE_CHARACTERS) {
    throw new Error("템플릿을 삽입한 노트는 500,000바이트를 넘을 수 없습니다.");
  }
  const relativeCursor = rendered.cursorOffset === undefined
    ? rendered.text.length
    : Math.max(0, Math.min(rendered.text.length, Math.trunc(rendered.cursorOffset)));
  return { cursor: start + relativeCursor, text };
}

export const SAFE_TEMPLATE_TOKENS = [
  "{{title}}",
  "{{path}}",
  "{{date}}",
  "{{time}}",
  "{{selection}}",
  "{{cursor}}",
  "{{date:YYYY-MM-DD}}",
  "{{time:HH:mm}}",
  "{{prompt:질문}}"
] as const;
