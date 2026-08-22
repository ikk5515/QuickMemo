export const BASE_MATERIALIZATION_WORKER_THRESHOLD = 250;
export const BASE_MATERIALIZATION_WORKER_TIMEOUT_MS = 2_000;

function filterFormulaSources(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(filterFormulaSources);
  return Object.values(value).flatMap(filterFormulaSources);
}

function containsRegexLiteral(source: string): boolean {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "/") continue;
    const previous = source.slice(0, index).trimEnd().at(-1) ?? "";
    if (previous && !"([{:;,=!?&|+-*%".includes(previous)) continue;
    let inCharacterClass = false;
    let bodyLength = 0;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const candidate = source[cursor];
      if (candidate === "\n" || candidate === "\r") break;
      if (candidate === "\\") {
        bodyLength += 1;
        cursor += 1;
        if (cursor < source.length) bodyLength += 1;
        continue;
      }
      if (candidate === "[") inCharacterClass = true;
      else if (candidate === "]") inCharacterClass = false;
      else if (candidate === "/" && !inCharacterClass) {
        if (!bodyLength) break;
        let flagCursor = cursor + 1;
        while (/[gimsuy]/u.test(source[flagCursor] ?? "")) flagCursor += 1;
        const next = source[flagCursor] ?? "";
        if (!next || /[\s),.\]}:?]/u.test(next)) return true;
        break;
      }
      bodyLength += 1;
    }
  }
  return false;
}

/**
 * JavaScript RegExp execution cannot be interrupted on the main thread. Even
 * after the formula allowlist rejects known catastrophic shapes, keep every
 * Base containing a regex literal behind the disposable materialization
 * Worker. False positives are safe: they only move a small Base off-thread.
 */
export function baseDocumentRequiresWorker(document: {
  filters?: unknown;
  formulas: Record<string, string>;
  summaries: Record<string, string>;
  views: readonly { filters?: unknown }[];
}): boolean {
  const formulaSources = [
    ...Object.values(document.formulas),
    ...Object.values(document.summaries),
    ...filterFormulaSources(document.filters),
    ...document.views.flatMap((view) => filterFormulaSources(view.filters))
  ];
  return formulaSources.some(containsRegexLiteral);
}

export function createBaseMaterializationWorker(): Worker {
  return new Worker(new URL("./materialization.worker.ts", import.meta.url), {
    name: "quickmemo-base-materialization",
    type: "module"
  });
}
