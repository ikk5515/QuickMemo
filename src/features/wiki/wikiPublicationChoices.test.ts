import { describe, expect, it, vi } from "vitest";
import * as asset from "../vault/vaultAsset";
import type { DecryptedVaultNote } from "../vault/vaultData";
import { isWikiPublicationChoice } from "./wikiPublicationChoices";
import { PUBLISHED_WIKI_LIMITS } from "./publishedWikiTypes";

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (byte) => byte.charCodeAt(0));
function note(extra: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return { id: "asset", ownerUid: "owner", participantUids: ["owner"], title: "Image.png", body: asset.encodeVaultAsset(png, "image/png"), entryKind: "asset", contentFormat: "asset-v1", ...extra } as DecryptedVaultNote;
}

describe("individual Wiki publication choices", () => {
  it("includes a validated owner raster without changing its encrypted or plaintext source", () => {
    const source = note(); const before = JSON.stringify(source);
    expect(isWikiPublicationChoice(source, "owner")).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
    expect(asset.decodeVaultAsset(source.body).bytes).toEqual(png);
  });
  it.each([
    note({ body: asset.encodeVaultAsset(new Uint8Array(new TextEncoder().encode("<svg></svg>")), "image/svg+xml") }),
    note({ body: asset.encodeVaultAsset(new Uint8Array(new TextEncoder().encode("%PDF-1.7")), "application/pdf") }),
    note({ body: asset.encodeVaultAsset(new Uint8Array(new TextEncoder().encode("GIF89a")), "image/gif") }),
    note({ body: asset.encodeVaultAsset(new Uint8Array(new TextEncoder().encode("<script>unsafe</script>")), "image/png") }),
    note({ body: "invalid-json" }),
    note({ entryKind: "canvas", contentFormat: "json-canvas-v1" }),
    note({ entryKind: "base", contentFormat: "base-v1" })
  ])("excludes unsupported or malformed content even when the name ends with PNG (%#)", (source) => {
    expect(isWikiPublicationChoice(source, "owner")).toBe(false);
  });
  it("rejects withdrawn authority before decoding and preserves ordinary note choices", () => {
    const decode = vi.spyOn(asset, "decodeVaultAsset");
    try {
      for (const extra of [{ ownerUid: "other" }, { participantUids: [] }, { isDeleted: true }, { isPurged: true }, { secureShareCopyState: "copying" as const }]) {
        expect(isWikiPublicationChoice(note(extra), "owner")).toBe(false);
      }
      expect(isWikiPublicationChoice(note({ entryKind: "markdown", contentFormat: "markdown-v1", body: "# note" }), "owner")).toBe(true);
      expect(isWikiPublicationChoice(note({ entryKind: "legacy-html", contentFormat: "legacy-html-v1", body: "<p>note</p>" }), "owner")).toBe(true);
      expect(isWikiPublicationChoice(note({ contentFormat: "markdown-v1" }), "owner")).toBe(false);
      expect(isWikiPublicationChoice(note({ body: " ".repeat(PUBLISHED_WIKI_LIMITS.assetBytes + 1) }), "owner")).toBe(false);
      expect(isWikiPublicationChoice(note({ body: "😀".repeat(Math.floor(PUBLISHED_WIKI_LIMITS.assetBytes / 4) + 1) }), "owner")).toBe(false);
      expect(decode).not.toHaveBeenCalled();
    } finally { decode.mockRestore(); }
  });
});
