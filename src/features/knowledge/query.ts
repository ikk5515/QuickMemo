import { normalizeTag } from "./markdown";
import { vaultBasename, vaultStem } from "./path";
import type {
  ParsedMarkdownMetadata,
  VaultIndexEntry,
  VaultSearchField,
  VaultSearchQuery
} from "./types";

interface SearchContext {
  entry: VaultIndexEntry;
  metadata: ParsedMarkdownMetadata;
}

export interface VaultSearchEvaluationOptions {
  /** Regex is disabled for main-thread fallbacks because JS regex cannot be preempted safely. */
  allowRegex?: boolean;
}

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let regex = false;
  let escaped = false;

  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        current += character;
      }
      continue;
    }
    if (regex) {
      current += character;
      if (character === "/") {
        regex = false;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && (current.length === 0 || current.endsWith(":"))) {
      current += character;
      regex = true;
      continue;
    }
    if (character === "(" || character === ")") {
      flush();
      tokens.push(character);
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
}

function parseTerm(token: string): VaultSearchQuery {
  const propertyMatch = token.match(/^\[([^:\]]+):([^\]]*)]$/) ?? token.match(/^\[([^\]]+)]:(.*)$/);
  let propertyName: string | undefined;
  let field: VaultSearchField | undefined;
  let value = token;

  if (propertyMatch) {
    field = "property";
    propertyName = propertyMatch[1];
    value = propertyMatch[2];
  } else {
    const fieldMatch = token.match(/^(file|path|content|tag|line|block|section|task):(.*)$/i);
    if (fieldMatch) {
      field = fieldMatch[1].toLocaleLowerCase() as VaultSearchField;
      value = fieldMatch[2];
    }
  }

  const regexMatch = value.match(/^\/(.*)\/([dgimsuvy]*)$/);
  if (regexMatch) {
    return {
      type: "regex",
      field,
      propertyName,
      source: regexMatch[1],
      flags: regexMatch[2].replace(/[dgy]/g, "")
    };
  }
  return { type: "term", field, propertyName, value };
}

export function parseVaultSearchQuery(query: string): VaultSearchQuery {
  const tokens = tokenize(query);
  let cursor = 0;

  const parsePrimary = (): VaultSearchQuery => {
    const token = tokens[cursor];
    if (!token) {
      return { type: "all" };
    }
    if (token === "-") {
      cursor += 1;
      return { type: "not", child: parsePrimary() };
    }
    if (token.startsWith("-") && token.length > 1) {
      cursor += 1;
      return { type: "not", child: parseTerm(token.slice(1)) };
    }
    if (token === "(") {
      cursor += 1;
      const nested = parseOr();
      if (tokens[cursor] === ")") {
        cursor += 1;
      }
      return nested;
    }
    cursor += 1;
    return parseTerm(token);
  };

  const parseAnd = (): VaultSearchQuery => {
    const children: VaultSearchQuery[] = [];
    while (cursor < tokens.length && tokens[cursor] !== ")" && tokens[cursor].toLocaleUpperCase() !== "OR") {
      children.push(parsePrimary());
    }
    if (children.length === 0) {
      return { type: "all" };
    }
    return children.length === 1 ? children[0] : { type: "and", children };
  };

  const parseOr = (): VaultSearchQuery => {
    const children = [parseAnd()];
    while (tokens[cursor]?.toLocaleUpperCase() === "OR") {
      cursor += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0] : { type: "or", children };
  };

  return parseOr();
}

export function vaultSearchQueryContainsRegex(query: string | VaultSearchQuery): boolean {
  const parsed = typeof query === "string" ? parseVaultSearchQuery(query) : query;
  switch (parsed.type) {
    case "regex":
      return true;
    case "not":
      return vaultSearchQueryContainsRegex(parsed.child);
    case "and":
    case "or":
      return parsed.children.some(vaultSearchQueryContainsRegex);
    default:
      return false;
  }
}

function propertyText(context: SearchContext, propertyName?: string): string {
  if (propertyName) {
    const matchingKey = Object.keys(context.metadata.properties).find(
      (key) => key.toLocaleLowerCase() === propertyName.toLocaleLowerCase()
    );
    const value = matchingKey ? context.metadata.properties[matchingKey] : undefined;
    return Array.isArray(value) ? value.join(" ") : String(value ?? "");
  }
  return Object.entries(context.metadata.properties)
    .flatMap(([key, value]) => [key, ...(Array.isArray(value) ? value : [value])])
    .join(" ");
}

function markdownBlocks(content: string): string[] {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "")
    .split(/(?:\r?\n){2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function markdownSections(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/u.test(line) && current.length) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) {
    sections.push(current.join("\n"));
  }
  return sections.filter((section) => section.trim());
}

function fieldValues(context: SearchContext, field?: VaultSearchField, propertyName?: string): string[] {
  const content = context.entry.content ?? "";
  switch (field) {
    case "file":
      return [vaultBasename(context.entry.path), vaultStem(context.entry.path)];
    case "path":
      return [context.entry.path];
    case "content":
      return [content];
    case "line":
      return content.split(/\r?\n/);
    case "block":
      return markdownBlocks(content);
    case "section":
      return markdownSections(content);
    case "task":
      return content.split(/\r?\n/).filter((line) => /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+/u.test(line));
    case "tag":
      return context.metadata.tags;
    case "property":
      return [propertyText(context, propertyName)];
    default:
      return [
        context.entry.path,
        content,
        ...context.metadata.aliases,
        ...context.metadata.tags,
        propertyText(context)
      ];
  }
}

function matchesTerm(
  context: SearchContext,
  field: VaultSearchField | undefined,
  propertyName: string | undefined,
  value: string
): boolean {
  if (field === "tag") {
    const expected = normalizeTag(value) ?? value.replace(/^#/, "");
    const expectedKey = expected.toLocaleLowerCase();
    return context.metadata.tags.some((tag) => {
      const tagKey = tag.toLocaleLowerCase();
      return tagKey === expectedKey || tagKey.startsWith(`${expectedKey}/`);
    });
  }
  const needle = value.toLocaleLowerCase();
  return fieldValues(context, field, propertyName).some((candidate) => candidate.toLocaleLowerCase().includes(needle));
}

export function evaluateVaultSearchQuery(
  query: VaultSearchQuery,
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata,
  options: VaultSearchEvaluationOptions = {}
): boolean {
  const context = { entry, metadata };
  switch (query.type) {
    case "all":
      return true;
    case "term":
      return matchesTerm(context, query.field, query.propertyName, query.value);
    case "regex": {
      if (options.allowRegex === false) {
        return false;
      }
      try {
        const expression = new RegExp(query.source, query.flags);
        return fieldValues(context, query.field, query.propertyName).some((candidate) => expression.test(candidate));
      } catch {
        return false;
      }
    }
    case "not":
      return !evaluateVaultSearchQuery(query.child, entry, metadata, options);
    case "and":
      return query.children.every((child) => evaluateVaultSearchQuery(child, entry, metadata, options));
    case "or":
      return query.children.some((child) => evaluateVaultSearchQuery(child, entry, metadata, options));
  }
}

export function matchesVaultSearchQuery(
  query: string | VaultSearchQuery,
  entry: VaultIndexEntry,
  metadata: ParsedMarkdownMetadata,
  options: VaultSearchEvaluationOptions = {}
): boolean {
  const parsed = typeof query === "string" ? parseVaultSearchQuery(query) : query;
  return evaluateVaultSearchQuery(parsed, entry, metadata, options);
}
