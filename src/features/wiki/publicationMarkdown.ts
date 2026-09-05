import { parseWikiLinkTarget } from "../markdown/parser";

export interface PublicationMarkdownLink { raw: string; target: string; label: string; embed: boolean; syntax: "wikilink" | "markdown" }
export type RewritePublicationMarkdownLink = (parts: PublicationMarkdownLink) => string;

/** Destinations accept the same angle-bracket and optional-title form as the reading renderer. */
function destination(value: string) {
  const match = value.trim().match(/^(?:<([^>]+)>|((?:\\.|[^\s])+?))(?:\s+["'(][\s\S]*)?$/u);
  return (match?.[1] ?? match?.[2] ?? "").replace(/\\([\\()[\]])/gu, "$1");
}

function codeFenceRanges(source: string) {
  const ranges = new Map<number, number>();
  let opening: { offset: number; character: string; length: number } | null = null;
  let offset = 0;
  for (const line of source.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!opening && match) opening = { offset, character: match[1][0], length: match[1].length };
    else if (opening && match && match[1][0] === opening.character && match[1].length >= opening.length && !match[2].trim()) {
      ranges.set(opening.offset, Math.min(source.length, offset + line.length + 1));
      opening = null;
    }
    offset += line.length + 1;
  }
  if (opening) ranges.set(opening.offset, source.length);
  return ranges;
}

/** Rewrites a public copy. Code examples remain literal; the encrypted source is never changed. */
export function rewritePublicationMarkdownLinks(source: string, rewriteLink: RewritePublicationMarkdownLink) {
  const fences = codeFenceRanges(source);
  const definitions = new Map<string, string>();
  const definitionEnds = new Map<number, number>();
  const labelKey = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  let offset = 0;
  let fenceEnd = 0;
  for (const line of source.split("\n")) {
    fenceEnd = fences.get(offset) ?? fenceEnd;
    const definition = offset >= fenceEnd ? line.match(/^ {0,3}\[([^\]^]+)\]:\s*(.*)$/u) : null;
    if (definition) {
      const key = labelKey(definition[1]);
      if (!definitions.has(key)) definitions.set(key, destination(definition[2]));
      definitionEnds.set(offset, offset + line.length);
    }
    offset += line.length + 1;
  }

  let remaining = Math.max(1_024, source.length * 12);
  const spend = () => {
    remaining -= 1;
    if (remaining < 0) throw new Error("링크 구문이 복잡해 공개할 내용을 안전하게 확인하지 못했습니다.");
  };
  const closing = (start: number, open: string, close: string) => {
    let depth = 1;
    for (let index = start; index < source.length; index += 1) {
      spend();
      if (source[index] === "\\") index += 1;
      else if (source[index] === open) depth += 1;
      else if (source[index] === close && --depth === 0) return index;
    }
    return -1;
  };
  const result: string[] = [];
  let index = 0;
  let plainStart = 0;
  const replaceThrough = (end: number, replacement: string) => {
    result.push(source.slice(plainStart, index), replacement);
    index = end;
    plainStart = end;
  };
  while (index < source.length) {
    spend();
    const protectedEnd = fences.get(index);
    if (protectedEnd !== undefined) { index = protectedEnd; continue; }
    const definitionEnd = definitionEnds.get(index);
    if (definitionEnd !== undefined) {
      replaceThrough(definitionEnd, "");
      continue;
    }
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === "`") {
      let length = 1;
      while (source[index + length] === "`") length += 1;
      const marker = "`".repeat(length);
      let end = index + length;
      while (end < source.length) {
        spend();
        if (source.startsWith(marker, end) && source[end - 1] !== "`" && source[end + length] !== "`") break;
        end += 1;
      }
      index = end < source.length ? end + length : index + length;
      continue;
    }
    const embed = source.startsWith("![", index);
    const start = index + (embed ? 1 : 0);
    if (source.startsWith("[[", start)) {
      let end = start + 2;
      while (end < source.length && !source.startsWith("]]", end)) { spend(); end += source[end] === "\\" ? 2 : 1; }
      if (end < source.length) {
        const parsed = parseWikiLinkTarget(source.slice(start + 2, end));
        replaceThrough(end + 2, rewriteLink({
          raw: source.slice(index, end + 2), target: parsed?.target ?? "", label: source.slice(start + 2, end).includes("|") ? parsed?.display ?? "" : "",
          embed, syntax: "wikilink"
        }));
        continue;
      }
    } else if (source[start] === "[") {
      const labelEnd = closing(start + 1, "[", "]");
      if (labelEnd !== -1) {
        const label = source.slice(start + 1, labelEnd);
        if (source[labelEnd + 1] === "(") {
          const targetEnd = closing(labelEnd + 2, "(", ")");
          if (targetEnd !== -1) {
            replaceThrough(targetEnd + 1, rewriteLink({ raw: source.slice(index, targetEnd + 1), target: destination(source.slice(labelEnd + 2, targetEnd)), label, embed, syntax: "markdown" }));
            continue;
          }
        }
        let end = labelEnd + 1;
        let key = labelKey(label);
        if (source[end] === "[") {
          const referenceEnd = closing(end + 1, "[", "]");
          if (referenceEnd !== -1) { key = labelKey(source.slice(end + 1, referenceEnd) || label); end = referenceEnd + 1; }
        }
        if (definitions.has(key)) {
          replaceThrough(end, rewriteLink({ raw: `${embed ? "!" : ""}[${label}](<${definitions.get(key)!}>)`, target: definitions.get(key)!, label, embed, syntax: "markdown" }));
          continue;
        }
        // An ordinary bracketed phrase can contain a real wiki link. Do not
        // skip its interior merely because the outer brackets are not a link.
        index = start + 1;
        continue;
      }
    }
    index += 1;
  }
  result.push(source.slice(plainStart));
  return result.join("");
}
