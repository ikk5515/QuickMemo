import type {
  InternalLinkOccurrence,
  ParsedMarkdownMetadata,
  ResolvedLinkOccurrence,
  VaultIndexEntry
} from "./types";

const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const MARKDOWN_EXTENSION_PATTERN = /\.md$/i;

export function normalizeVaultPath(path: string): string {
  const segments: string[] = [];
  const normalizedSeparators = path.replace(/\\/g, "/").replace(/^\/+/, "");

  for (const segment of normalizedSeparators.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

export function vaultDirectory(path: string): string {
  const normalized = normalizeVaultPath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

export function vaultBasename(path: string): string {
  const normalized = normalizeVaultPath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function vaultStem(path: string): string {
  return vaultBasename(path).replace(/\.[^.]+$/, "");
}

function caseFold(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function safelyDecodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface InternalLinkResolutionIndex {
  byAlias: ReadonlyMap<string, readonly VaultIndexEntry[]>;
  byPath: ReadonlyMap<string, readonly VaultIndexEntry[]>;
  byStem: ReadonlyMap<string, readonly VaultIndexEntry[]>;
}

function appendLookupEntry(
  lookup: Map<string, VaultIndexEntry[]>,
  key: string,
  entry: VaultIndexEntry
): void {
  const existing = lookup.get(key);
  if (existing) {
    existing.push(entry);
  } else {
    lookup.set(key, [entry]);
  }
}

export function buildInternalLinkResolutionIndex(
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>
): InternalLinkResolutionIndex {
  const byAlias = new Map<string, VaultIndexEntry[]>();
  const byPath = new Map<string, VaultIndexEntry[]>();
  const byStem = new Map<string, VaultIndexEntry[]>();

  for (const entry of entries) {
    appendLookupEntry(byPath, caseFold(normalizeVaultPath(entry.path)), entry);
    appendLookupEntry(byStem, caseFold(vaultStem(entry.path)), entry);
    for (const alias of metadataByEntryId.get(entry.id)?.aliases ?? []) {
      appendLookupEntry(byAlias, caseFold(alias), entry);
    }
  }

  return { byAlias, byPath, byStem };
}

function pathVariants(target: string, syntax: InternalLinkOccurrence["syntax"], sourcePath: string): string[] {
  const decoded = safelyDecodePath(target.trim()).replace(/\\/g, "/");
  const sourceDirectory = vaultDirectory(sourcePath);
  const hasExtension = /\.[^/]+$/.test(decoded);
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const normalized = normalizeVaultPath(candidate);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
    if (!hasExtension && normalized && !candidates.includes(`${normalized}.md`)) {
      candidates.push(`${normalized}.md`);
    }
  };

  if (syntax === "markdown" || decoded.startsWith("./") || decoded.startsWith("../")) {
    add(sourceDirectory ? `${sourceDirectory}/${decoded}` : decoded);
  } else {
    if (!decoded.includes("/")) {
      add(sourceDirectory ? `${sourceDirectory}/${decoded}` : decoded);
    } else {
      add(decoded);
    }
  }

  return candidates;
}

export function isExternalLinkTarget(target: string): boolean {
  const value = target.trim();
  return URI_SCHEME_PATTERN.test(value) || value.startsWith("//") || value.startsWith("#");
}

export function resolveInternalLink(
  occurrence: InternalLinkOccurrence,
  entries: readonly VaultIndexEntry[],
  metadataByEntryId: ReadonlyMap<string, ParsedMarkdownMetadata>,
  resolutionIndex = buildInternalLinkResolutionIndex(entries, metadataByEntryId)
): ResolvedLinkOccurrence {
  const target = occurrence.target.trim();
  if (!target && occurrence.fragment) {
    return {
      ...occurrence,
      status: "resolved",
      targetEntryId: occurrence.sourceEntryId,
      targetPath: occurrence.sourcePath,
      candidateEntryIds: [occurrence.sourceEntryId],
      unresolvedKey: occurrence.sourcePath
    };
  }

  const variants = pathVariants(target, occurrence.syntax, occurrence.sourcePath);
  const variantKeys = variants.map(caseFold);
  let candidates: VaultIndexEntry[] = [];
  for (const variantKey of variantKeys) {
    const matches = resolutionIndex.byPath.get(variantKey) ?? [];
    if (matches.length > 0) {
      candidates = [...matches];
      break;
    }
  }

  if (candidates.length === 0 && occurrence.syntax === "wikilink" && !target.includes("/")) {
    const targetName = caseFold(target.replace(MARKDOWN_EXTENSION_PATTERN, ""));
    const stemMatches = resolutionIndex.byStem.get(targetName) ?? [];
    if (stemMatches.length > 0) {
      candidates = [...stemMatches];
    } else {
      candidates = [...(resolutionIndex.byAlias.get(targetName) ?? [])];
    }
  }

  const unresolvedKey = occurrence.syntax === "markdown" || target.startsWith("./") || target.startsWith("../")
    ? normalizeVaultPath(variants[0] ?? target)
    : normalizeVaultPath(target);
  if (candidates.length === 1) {
    return {
      ...occurrence,
      status: "resolved",
      targetEntryId: candidates[0].id,
      targetPath: normalizeVaultPath(candidates[0].path),
      candidateEntryIds: [candidates[0].id],
      unresolvedKey
    };
  }

  return {
    ...occurrence,
    status: candidates.length > 1 ? "ambiguous" : "unresolved",
    candidateEntryIds: candidates.map((entry) => entry.id),
    unresolvedKey
  };
}
