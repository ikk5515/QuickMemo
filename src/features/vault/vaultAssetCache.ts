import { decodeVaultAsset, type DecodedVaultAsset } from "./vaultAsset";

interface CachedVaultAsset {
  asset: DecodedVaultAsset | null;
  source: string;
}

/**
 * Keeps decoded attachment bytes out of the default Vault render path. Source
 * strings are already held by the decrypted draft; this cache only retains a
 * small LRU of assets that were actually previewed by the active note/Canvas.
 */
export class BoundedVaultAssetDecodeCache {
  readonly #cache = new Map<string, CachedVaultAsset>();
  readonly #decode: (source: string) => DecodedVaultAsset;
  readonly #limit: number;

  constructor(limit = 12, decode: (source: string) => DecodedVaultAsset = decodeVaultAsset) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("첨부 미리보기 캐시 제한은 1 이상이어야 합니다.");
    }
    this.#limit = limit;
    this.#decode = decode;
  }

  clear() {
    this.#cache.clear();
  }

  get(entryId: string, source: string): DecodedVaultAsset | null {
    const cached = this.#cache.get(entryId);
    if (cached?.source === source) {
      this.#cache.delete(entryId);
      this.#cache.set(entryId, cached);
      return cached.asset;
    }

    let asset: DecodedVaultAsset | null = null;
    try {
      asset = this.#decode(source);
    } catch {
      // Authenticated but malformed asset payloads remain visible as entries,
      // while browser decoding and preview stay blocked.
    }
    this.#cache.delete(entryId);
    this.#cache.set(entryId, { asset, source });
    while (this.#cache.size > this.#limit) {
      const oldestEntryId = this.#cache.keys().next().value as string | undefined;
      if (!oldestEntryId) break;
      this.#cache.delete(oldestEntryId);
    }
    return asset;
  }

  retain(entryIds: ReadonlySet<string>) {
    for (const entryId of this.#cache.keys()) {
      if (!entryIds.has(entryId)) {
        this.#cache.delete(entryId);
      }
    }
  }

  get size() {
    return this.#cache.size;
  }
}
