import { isExternalLinkTarget, resolveInternalLink, type InternalLinkResolutionIndex } from "../knowledge/path";
import type { InternalLinkOccurrence, ResolvedLinkOccurrence, VaultIndexEntry } from "../knowledge/types";

const emptyMetadata = new Map<string, { aliases: string[] }>();

/** Resolve only against the current public catalog, including old root-file publications. */
export function resolvePublicWikiLink(
  occurrence: InternalLinkOccurrence,
  entries: readonly VaultIndexEntry[],
  index: InternalLinkResolutionIndex
): ResolvedLinkOccurrence {
  const unresolved: ResolvedLinkOccurrence = { ...occurrence, status: "unresolved", candidateEntryIds: [], unresolvedKey: occurrence.target };
  let decoded: string;
  try { decoded = decodeURIComponent(occurrence.target.trim()).replace(/\\/g, "/"); }
  catch { return unresolved; }
  if (isExternalLinkTarget(decoded)) return unresolved;

  const normal = resolveInternalLink(occurrence, entries, emptyMetadata, index);
  if (normal.status !== "unresolved" || occurrence.syntax !== "wikilink"
    || !decoded || decoded.includes("/") || decoded === "." || decoded === "..") return normal;

  // Earlier publication copies wrote a canonical root filename without '/'.
  // Keep valid relative links (and ambiguities) authoritative. Only a complete,
  // unique root path in this manifest may repair an otherwise unresolved link.
  const root = resolveInternalLink({ ...occurrence, target: `/${occurrence.target.trim()}` }, entries, emptyMetadata, index);
  return root.status === "resolved" && root.candidateEntryIds.length === 1
    && root.targetPath?.normalize("NFC") === decoded.normalize("NFC")
    ? root : normal;
}
