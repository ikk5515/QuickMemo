import {
  parseObsidianMarkdown,
  resolveInternalLink,
  type VaultIndexEntry
} from "../knowledge";
import type { DecryptedVaultNote } from "./vaultData";

/**
 * Vault assets are independent encrypted entries. Until a share operation can
 * re-wrap or re-encrypt those entries too, sharing a Markdown document that
 * embeds one would produce a misleading, inaccessible image placeholder.
 * Resolve only real embedded asset targets; normal links and unresolved embed
 * text do not cross an ACL boundary and remain safe to share as inert text.
 */
export function embeddedVaultAssetIdsForShare(
  note: Pick<DecryptedVaultNote, "body" | "contentFormat" | "entryKind" | "id">,
  sourcePath: string,
  entries: readonly VaultIndexEntry[]
) {
  if (note.contentFormat !== "markdown-v1" || note.entryKind !== "markdown") {
    return [];
  }

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const metadata = parseObsidianMarkdown(note.id, sourcePath, note.body);
  const assetIds = new Set<string>();

  for (const occurrence of metadata.links) {
    if (!occurrence.embedded) continue;
    const resolved = resolveInternalLink(occurrence, entries, new Map());
    if (
      resolved.status === "resolved"
      && resolved.targetEntryId
      && entryById.get(resolved.targetEntryId)?.kind === "asset"
    ) {
      assetIds.add(resolved.targetEntryId);
    }
  }

  return [...assetIds];
}
