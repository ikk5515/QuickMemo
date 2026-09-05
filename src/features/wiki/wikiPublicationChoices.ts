import { decodeVaultAsset, safeVaultAssetPreviewKind } from "../vault/vaultAsset";
import type { DecryptedVaultNote } from "../vault/vaultData";
import { PUBLISHED_WIKI_LIMITS } from "./publishedWikiTypes";

const utf8 = new TextEncoder();

/** Selection hints only; preparation and the server recheck every grant. */
export function isWikiPublicationChoice(note: DecryptedVaultNote, uid: string): boolean {
  if (note.ownerUid !== uid || note.isDeleted || note.isPurged || !note.participantUids.includes(uid)
    || (note.secureShareCopyState && note.secureShareCopyState !== "active")) return false;
  if (note.entryKind === "markdown") return note.contentFormat === "markdown-v1";
  if (note.entryKind === "legacy-html") return note.contentFormat === "legacy-html-v1";
  if (note.entryKind !== "asset" || note.contentFormat !== "asset-v1") return false;
  // Reject oversized envelopes before JSON parsing or base64 allocation.
  if (note.body.length > PUBLISHED_WIKI_LIMITS.assetBytes
    || utf8.encode(note.body).byteLength > PUBLISHED_WIKI_LIMITS.assetBytes) return false;
  try {
    const asset = decodeVaultAsset(note.body);
    try { return safeVaultAssetPreviewKind(asset) === "image"; }
    finally { asset.bytes.fill(0); }
  } catch { return false; }
}
