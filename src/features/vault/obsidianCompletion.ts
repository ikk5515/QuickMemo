import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";

export interface ObsidianCompletionNote {
  /** Vault-relative path. The optional `.md` suffix is removed when inserted. */
  path: string;
  aliases?: readonly string[];
  blocks?: readonly string[];
  headings?: readonly string[];
}

export interface ObsidianMarkdownCompletionData {
  /** Used by `[[#Heading]]` and `[[#^block-id]]` completion. */
  currentBlocks?: readonly string[];
  /** Used by `[[#Heading]]` and `[[#^block-id]]` completion. */
  currentHeadings?: readonly string[];
  currentNotePath?: string | null;
  notes?: readonly ObsidianCompletionNote[];
  /** Tags may be supplied with or without the leading `#`. */
  tags?: readonly string[];
}

const NOTE_SECTION = { name: "노트", rank: 0 } as const;
const ALIAS_SECTION = { name: "별칭", rank: 1 } as const;
const HEADING_SECTION = { name: "제목", rank: 0 } as const;
const BLOCK_SECTION = { name: "블록", rank: 0 } as const;
const TAG_SECTION = { name: "태그", rank: 0 } as const;

function uniqueByNormalizedValue(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of values) {
    const value = rawValue.trim();
    const key = value.normalize("NFC").toLocaleLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }

  return result;
}

function normalizeNotePath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
}

function noteBasename(path: string): string {
  const normalized = normalizeNotePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizedLookup(value: string): string {
  return normalizeNotePath(value).normalize("NFC").toLocaleLowerCase();
}

function isSafeWikiValue(value: string): boolean {
  return value.length > 0 && !/[\]\n\r|]/u.test(value);
}

function closingBrackets(context: CompletionContext): string {
  const suffix = context.state.sliceDoc(context.pos, Math.min(context.pos + 2, context.state.doc.length));
  if (suffix.startsWith("]]")) {
    return "";
  }
  return suffix.startsWith("]") ? "]" : "]]";
}

function isInsideCode(context: CompletionContext): boolean {
  if (context.state.doc.length === 0) {
    return false;
  }

  let node = syntaxTree(context.state).resolveInner(Math.max(0, context.pos - 1), 1);
  while (node) {
    if (/code/i.test(node.name)) {
      return true;
    }
    if (!node.parent) {
      break;
    }
    node = node.parent;
  }
  return false;
}

function notesForTarget(target: string, data: ObsidianMarkdownCompletionData): readonly ObsidianCompletionNote[] {
  const notes = data.notes ?? [];
  const lookup = normalizedLookup(target || data.currentNotePath || "");
  if (!lookup) {
    return [];
  }

  return notes.filter((note) => {
    const path = normalizedLookup(note.path);
    if (path === lookup || normalizedLookup(noteBasename(note.path)) === lookup) {
      return true;
    }
    return (note.aliases ?? []).some((alias) => normalizedLookup(alias) === lookup);
  });
}

function noteOptions(notes: readonly ObsidianCompletionNote[], closing: string): Completion[] {
  const options: Completion[] = [];
  const seenPaths = new Set<string>();
  const seenAliases = new Set<string>();

  for (const note of notes) {
    const path = normalizeNotePath(note.path);
    const pathKey = normalizedLookup(path);
    if (isSafeWikiValue(path) && !seenPaths.has(pathKey)) {
      seenPaths.add(pathKey);
      options.push({
        apply: `${path}${closing}`,
        boost: path.includes("/") ? 0 : 1,
        detail: path.includes("/") ? noteBasename(path) : undefined,
        label: path,
        section: NOTE_SECTION,
        type: "namespace"
      });
    }

    for (const alias of uniqueByNormalizedValue(note.aliases ?? [])) {
      const aliasKey = `${pathKey}\u0000${alias.normalize("NFC").toLocaleLowerCase()}`;
      if (!isSafeWikiValue(alias) || seenAliases.has(aliasKey)) {
        continue;
      }
      seenAliases.add(aliasKey);
      options.push({
        apply: `${path}|${alias}${closing}`,
        detail: `별칭 · ${path}`,
        label: alias,
        section: ALIAS_SECTION,
        type: "text"
      });
    }
  }

  return options;
}

function fragmentOptions(
  kind: "heading" | "block",
  target: string,
  data: ObsidianMarkdownCompletionData,
  closing: string
): Completion[] {
  const currentTarget = target.trim().length === 0;
  const matchingNotes = notesForTarget(target, data);
  const rawValues = currentTarget
    ? kind === "heading"
      ? data.currentHeadings ?? matchingNotes.flatMap((note) => note.headings ?? [])
      : data.currentBlocks ?? matchingNotes.flatMap((note) => note.blocks ?? [])
    : matchingNotes.flatMap((note) => (kind === "heading" ? note.headings ?? [] : note.blocks ?? []));

  return uniqueByNormalizedValue(rawValues)
    .map((value) => (kind === "heading" ? value.replace(/^#+\s*/u, "") : value.replace(/^\^/u, "")))
    .filter(isSafeWikiValue)
    .map((value) => ({
      apply: `${value}${closing}`,
      detail: target ? normalizeNotePath(target) : "현재 노트",
      displayLabel: kind === "heading" ? value : `^${value}`,
      label: value,
      section: kind === "heading" ? HEADING_SECTION : BLOCK_SECTION,
      type: kind === "heading" ? "property" : "variable"
    }));
}

function completeWikiLink(context: CompletionContext, data: ObsidianMarkdownCompletionData): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = context.state.sliceDoc(line.from, context.pos);
  const openIndex = beforeCursor.lastIndexOf("[[");
  if (openIndex < 0 || openIndex < beforeCursor.lastIndexOf("]]")) {
    return null;
  }

  const linkText = beforeCursor.slice(openIndex + 2);
  if (linkText.includes("|") || /[\]\n\r]/u.test(linkText)) {
    return null;
  }

  const closing = closingBrackets(context);
  const hashIndex = linkText.indexOf("#");
  if (hashIndex < 0) {
    const from = line.from + openIndex + 2;
    const options = noteOptions(data.notes ?? [], closing);
    return options.length > 0
      ? { from, options, validFor: /^[^#|\]\n\r]*$/u }
      : null;
  }

  const target = linkText.slice(0, hashIndex);
  const fragment = linkText.slice(hashIndex + 1);
  const block = fragment.startsWith("^");
  const from = line.from + openIndex + 2 + hashIndex + 1 + (block ? 1 : 0);
  const options = fragmentOptions(block ? "block" : "heading", target, data, closing);
  return options.length > 0
    ? { from, options, validFor: block ? /^[^|\]\n\r]*$/u : /^[^^|\]\n\r]*$/u }
    : null;
}

function hasOpenWikiLink(context: CompletionContext): boolean {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = context.state.sliceDoc(line.from, context.pos);
  const openIndex = beforeCursor.lastIndexOf("[[");
  return openIndex >= 0 && openIndex >= beforeCursor.lastIndexOf("]]");
}

function completeTag(context: CompletionContext, data: ObsidianMarkdownCompletionData): CompletionResult | null {
  const beforeCursor = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos);
  const match = /(?:^|[\s([{>,"'])#([^\s#\][(){}<>,"']*)$/u.exec(beforeCursor);
  if (!match) {
    return null;
  }

  const tags = uniqueByNormalizedValue((data.tags ?? []).map((tag) => tag.replace(/^#/u, ""))).filter(
    (tag) => !/\s|#/u.test(tag) && !/^\d+$/u.test(tag)
  );
  if (tags.length === 0) {
    return null;
  }

  return {
    from: context.pos - match[1].length,
    options: tags.map((tag) => ({
      apply: tag,
      detail: "태그",
      displayLabel: `#${tag}`,
      label: tag,
      section: TAG_SECTION,
      type: "keyword"
    })),
    validFor: /^[^\s#\][(){}<>,"']*$/u
  };
}

/** A synchronous, plaintext-in-memory-only CodeMirror completion source. */
export function completeObsidianMarkdown(
  context: CompletionContext,
  data: ObsidianMarkdownCompletionData | undefined
): CompletionResult | null {
  if (!data || isInsideCode(context)) {
    return null;
  }

  if (hasOpenWikiLink(context)) {
    return completeWikiLink(context, data);
  }
  return completeTag(context, data);
}
