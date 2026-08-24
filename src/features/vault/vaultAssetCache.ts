import { decodeVaultAsset, type DecodedVaultAsset } from "./vaultAsset";

interface CachedVaultAsset {
  asset: DecodedVaultAsset | null;
  source: string;
}

interface LiveVaultAsset {
  asset: WeakRef<DecodedVaultAsset>;
  source: string;
}

/**
 * Keeps decoded attachment bytes out of the default Vault render path. Source
 * strings are already held by the decrypted draft; this cache strongly retains
 * only a small LRU. A swept weak index keeps assets that are still mounted in
 * the UI identity-stable without extending the lifetime of their decoded bytes.
 */
export class BoundedVaultAssetDecodeCache {
  readonly #cache = new Map<string, CachedVaultAsset>();
  readonly #decode: (source: string) => DecodedVaultAsset;
  readonly #limit: number;
  readonly #liveAssets = new Map<string, LiveVaultAsset>();

  constructor(limit = 12, decode: (source: string) => DecodedVaultAsset = decodeVaultAsset) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("첨부 미리보기 캐시 제한은 1 이상이어야 합니다.");
    }
    this.#limit = limit;
    this.#decode = decode;
  }

  clear() {
    this.#cache.clear();
    this.#liveAssets.clear();
  }

  get(entryId: string, source: string): DecodedVaultAsset | null {
    const cached = this.#cache.get(entryId);
    if (cached?.source === source) {
      this.#remember(entryId, cached);
      return cached.asset;
    }

    const live = this.#liveAssets.get(entryId);
    const liveAsset = live?.source === source ? live.asset.deref() : undefined;
    if (live && liveAsset) {
      this.#liveAssets.delete(entryId);
      this.#liveAssets.set(entryId, live);
      this.#remember(entryId, { asset: liveAsset, source });
      return liveAsset;
    }
    if (live) {
      this.#liveAssets.delete(entryId);
    }

    let asset: DecodedVaultAsset | null = null;
    try {
      asset = this.#decode(source);
    } catch {
      // Authenticated but malformed asset payloads remain visible as entries,
      // while browser decoding and preview stay blocked.
    }
    if (asset && typeof WeakRef === "function") {
      this.#sweepDeadLiveAssets();
      this.#liveAssets.set(entryId, { asset: new WeakRef(asset), source });
    }
    this.#remember(entryId, { asset, source });
    return asset;
  }

  #remember(entryId: string, cached: CachedVaultAsset) {
    this.#cache.delete(entryId);
    this.#cache.set(entryId, cached);
    while (this.#cache.size > this.#limit) {
      const oldestEntryId = this.#cache.keys().next().value as string | undefined;
      if (!oldestEntryId) break;
      this.#cache.delete(oldestEntryId);
    }
  }

  #sweepDeadLiveAssets(maximumChecks = 8) {
    let checks = 0;
    for (const [entryId, live] of this.#liveAssets) {
      if (checks >= maximumChecks) break;
      checks += 1;
      this.#liveAssets.delete(entryId);
      if (live.asset.deref()) {
        this.#liveAssets.set(entryId, live);
      }
    }
  }

  retain(entryIds: ReadonlySet<string>) {
    for (const entryId of this.#cache.keys()) {
      if (!entryIds.has(entryId)) {
        this.#cache.delete(entryId);
      }
    }
    for (const [entryId, live] of this.#liveAssets) {
      if (!entryIds.has(entryId) || !live.asset.deref()) {
        this.#liveAssets.delete(entryId);
      }
    }
  }

  get size() {
    return this.#cache.size;
  }
}
