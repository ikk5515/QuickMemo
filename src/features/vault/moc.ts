import { normalizeVaultPath } from "../knowledge/path";

export const MAX_SEARCH_INDEX_LINKS = 500;

export interface SearchIndexLinkCandidate {
  path: string;
  title: string;
}

export interface CreateSearchIndexMarkdownInput {
  candidates: readonly SearchIndexLinkCandidate[];
  generatedAt?: Date;
  query?: string;
  sourceFolderPath?: string;
  title: string;
}

export interface CreateSearchIndexMarkdownResult {
  included: number;
  omitted: number;
  source: string;
}

function markdownLabel(value: string) {
  return value
    .replace(/\\/gu, "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function relativeVaultPath(sourceFolderPath: string, targetPath: string) {
  const sourceSegments = normalizeVaultPath(sourceFolderPath).split("/").filter(Boolean);
  const targetSegments = normalizeVaultPath(targetPath).split("/").filter(Boolean);
  let sharedSegments = 0;
  while (
    sharedSegments < sourceSegments.length
    && sharedSegments < targetSegments.length
    && sourceSegments[sharedSegments].normalize("NFC").toLocaleLowerCase("en-US")
      === targetSegments[sharedSegments].normalize("NFC").toLocaleLowerCase("en-US")
  ) {
    sharedSegments += 1;
  }
  return [
    ...Array.from({ length: sourceSegments.length - sharedSegments }, () => ".."),
    ...targetSegments.slice(sharedSegments)
  ].join("/");
}

function encodedVaultPath(value: string) {
  return value
    .split("/")
    .map((segment) => segment === ".." ? segment : encodeURIComponent(segment))
    .join("/");
}

function yamlString(value: string) {
  const withoutControlCharacters = Array.from(value).filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 9 || codePoint === 10 || codePoint === 13 || (codePoint >= 32 && codePoint !== 127);
  }).join("");
  return JSON.stringify(withoutControlCharacters);
}

export function createSearchIndexMarkdown({
  candidates,
  generatedAt = new Date(),
  query = "",
  sourceFolderPath = "",
  title
}: CreateSearchIndexMarkdownInput): CreateSearchIndexMarkdownResult {
  const normalizedTitle = title.trim().normalize("NFC").slice(0, 120) || "새 검색 결과 인덱스";
  const unique = new Map<string, SearchIndexLinkCandidate>();

  for (const candidate of candidates) {
    const path = normalizeVaultPath(candidate.path.trim().normalize("NFC"));
    const candidateTitle = candidate.title.trim().normalize("NFC");
    if (!path || !candidateTitle || path.length > 1_000 || candidateTitle.length > 240) continue;
    const key = path.toLocaleLowerCase("en-US");
    if (!unique.has(key)) unique.set(key, { path, title: candidateTitle });
  }

  const sorted = [...unique.values()].sort((left, right) => (
    left.path.localeCompare(right.path, "ko", { sensitivity: "accent" })
  ));
  const included = sorted.slice(0, MAX_SEARCH_INDEX_LINKS);
  const normalizedQuery = query.trim().slice(0, 2_000);
  const frontmatter = [
    "---",
    "type: search-index",
    "tags:",
    "  - search-index",
    `created: ${generatedAt.toISOString()}`,
    ...(normalizedQuery ? [`source-query: ${yamlString(normalizedQuery)}`] : []),
    "---"
  ];
  const links = included.map((candidate) => (
    `- [${markdownLabel(candidate.title)}](<${encodedVaultPath(relativeVaultPath(sourceFolderPath, candidate.path))}>)`
  ));
  const omitted = Math.max(0, sorted.length - included.length);

  return {
    included: included.length,
    omitted,
    source: [
      ...frontmatter,
      "",
      `# ${normalizedTitle}`,
      "",
      ...links,
      ...(omitted ? ["", `> [!warning] 일부 결과 생략`, `> 안전한 검색 결과 인덱스 상한으로 ${omitted}개 링크를 생략했습니다.`] : []),
      ""
    ].join("\n")
  };
}
