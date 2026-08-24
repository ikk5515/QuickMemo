import { describe, expect, it, vi } from "vitest";
import { encodeVaultAsset } from "./vaultAsset";
import { BoundedVaultAssetDecodeCache } from "./vaultAssetCache";

describe("BoundedVaultAssetDecodeCache", () => {
  it("decodes on demand, reuses live assets, and bounds the strong LRU", () => {
    const decoder = vi.fn((source: string) => ({ bytes: new TextEncoder().encode(source), mimeType: "text/plain" }));
    const cache = new BoundedVaultAssetDecodeCache(2, decoder);

    expect(cache.get("a", "one")?.bytes).toEqual(new TextEncoder().encode("one"));
    cache.get("b", "two");
    cache.get("a", "one");
    cache.get("c", "three");
    cache.get("b", "two");

    expect(decoder).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(2);
  });

  it("caches invalid payloads and clears entries outside the unlocked Vault", () => {
    const cache = new BoundedVaultAssetDecodeCache(2);
    expect(cache.get("broken", "not-json")).toBeNull();
    expect(cache.get("broken", "not-json")).toBeNull();
    expect(cache.get("valid", encodeVaultAsset(new Uint8Array([1]), "application/octet-stream"))).not.toBeNull();

    cache.retain(new Set(["valid"]));
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("keeps mounted asset identities stable beyond the strong LRU limit", () => {
    const decoder = vi.fn((source: string) => ({
      bytes: new TextEncoder().encode(source),
      mimeType: "image/png"
    }));
    const cache = new BoundedVaultAssetDecodeCache(12, decoder);
    const entries = Array.from({ length: 16 }, (_, index) => ({
      entryId: `asset-${index}`,
      source: `encoded-${index}`
    }));

    const mountedAssets = entries.map(({ entryId, source }) => cache.get(entryId, source));
    const rerenderedAssets = entries.map(({ entryId, source }) => cache.get(entryId, source));

    expect(decoder).toHaveBeenCalledTimes(entries.length);
    expect(cache.size).toBe(12);
    rerenderedAssets.forEach((asset, index) => {
      expect(asset).toBe(mountedAssets[index]);
    });
  });
});
