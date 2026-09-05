import { useEffect, useState } from "react";
import { getPublishedWikiAsset } from "../../services/publishedWikis";
import { buildInternalLinkResolutionIndex, isExternalLinkTarget } from "../knowledge/path";
import type { VaultIndexEntry } from "../knowledge/types";
import type { MarkdownLinkReference } from "../markdown/types";
import { decodeVaultAsset, safeVaultAssetPreviewKind, type DecodedVaultAsset } from "../vault/vaultAsset";
import { PUBLISHED_WIKI_LIMITS, type PublishedWikiEntry, type PublishedWikiManifest } from "./publishedWikiTypes";
import { resolvePublicWikiLink } from "./publicWikiLinkResolution";

interface ReadJob {
  id: string;
  controller: AbortController;
  consumers: number;
  started: boolean;
  settled: boolean;
  promise: Promise<DecodedVaultAsset>;
  resolve: (asset: DecodedVaultAsset) => void;
  reject: (reason: unknown) => void;
}
const emptyMetadata = new Map<string, { aliases: string[] }>();
function cancelled() { return new DOMException("The public image scope is no longer active.", "AbortError"); }
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    if (signal.aborted) reject(cancelled());
    else signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** Owned by one public page generation, never a global or persistent cache. */
export class PublishedWikiAssetReader {
  private readonly controller = new AbortController();
  private readonly assets = new Map<string, PublishedWikiEntry>();
  private readonly decoded = new Map<string, DecodedVaultAsset>();
  private readonly pending = new Map<string, ReadJob>();
  private queue: ReadJob[] = [];
  private active = 0;
  private readonly wikiId: string;
  private readonly revision: number;
  private entries: VaultIndexEntry[];
  private index: ReturnType<typeof buildInternalLinkResolutionIndex>;

  constructor(readonly manifest: PublishedWikiManifest, readonly scope: AbortSignal) {
    this.wikiId = manifest.wikiId; this.revision = manifest.revision;
    this.entries = manifest.entries.map(({ id, path, kind }) => ({ id, path, kind }));
    this.index = buildInternalLinkResolutionIndex(this.entries, emptyMetadata);
    const assets = manifest.entries.filter((entry) => entry.kind === "asset");
    if (assets.length <= PUBLISHED_WIKI_LIMITS.assets && manifest.entries.length <= PUBLISHED_WIKI_LIMITS.assets + PUBLISHED_WIKI_LIMITS.notes) {
      for (const entry of assets) this.assets.set(entry.id, { ...entry });
    }
    if (scope.aborted) this.dispose();
    else scope.addEventListener("abort", this.dispose, { once: true });
  }
  get signal() { return this.controller.signal; }
  dispose = () => {
    this.controller.abort(); this.scope.removeEventListener("abort", this.dispose);
    for (const job of this.pending.values()) { job.controller.abort(); this.finish(job, cancelled()); }
    this.pending.clear(); this.queue = []; this.decoded.clear(); this.assets.clear(); this.entries = [];
    this.index = buildInternalLinkResolutionIndex([], emptyMetadata);
  };
  private assertActive() { if (this.signal.aborted || this.scope.aborted) throw cancelled(); }

  resolve(reference: MarkdownLinkReference, source: Pick<VaultIndexEntry, "id" | "path">): PublishedWikiEntry | null {
    if (this.signal.aborted || this.scope.aborted || !reference.path || reference.kind === "external" || isExternalLinkTarget(reference.path)) return null;
    const result = resolvePublicWikiLink({ sourceEntryId: source.id, sourcePath: source.path,
      syntax: reference.kind === "wikilink" ? "wikilink" : "markdown", raw: reference.raw, target: reference.path,
      embedded: true, line: 0, column: 0, context: "" }, this.entries, this.index);
    return result.status === "resolved" && result.candidateEntryIds.length === 1 && result.targetEntryId
      ? this.assets.get(result.targetEntryId) ?? null : null;
  }

  async load(id: string, signal: AbortSignal): Promise<DecodedVaultAsset> {
    this.assertActive(); if (signal.aborted) throw cancelled();
    if (!this.assets.has(id)) throw new Error("Image is outside the public scope.");
    const cached = this.decoded.get(id);
    if (cached) { this.decoded.delete(id); this.decoded.set(id, cached); return cached; }
    let job = this.pending.get(id);
    if (!job) {
      let resolve!: ReadJob["resolve"], reject!: ReadJob["reject"];
      const promise = new Promise<DecodedVaultAsset>((success, failure) => { resolve = success; reject = failure; });
      job = { id, controller: new AbortController(), consumers: 0, started: false, settled: false, promise, resolve, reject };
      this.pending.set(id, job); this.queue.push(job);
    }
    const current = job; current.consumers += 1;
    // Attach the consumer before starting a request that may reject immediately.
    const result = waitFor(current.promise, signal);
    this.pump();
    try { const asset = await result; this.assertActive(); if (signal.aborted) throw cancelled(); return asset; }
    finally {
      current.consumers -= 1;
      if (!current.settled && current.consumers === 0) {
        current.controller.abort(); this.finish(current, cancelled());
        if (!current.started) this.queue = this.queue.filter((queued) => queued !== current);
      }
    }
  }
  private finish(job: ReadJob, error?: unknown, asset?: DecodedVaultAsset) {
    if (job.settled) return;
    job.settled = true;
    if (this.pending.get(job.id) === job) this.pending.delete(job.id);
    if (asset) job.resolve(asset); else job.reject(error ?? cancelled());
  }
  private pump() {
    while (!this.signal.aborted && this.active < 4 && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled || job.controller.signal.aborted) continue;
      job.started = true; this.active += 1;
      void this.run(job);
    }
  }
  private async run(job: ReadJob) {
    try {
      const entry = await waitFor(getPublishedWikiAsset(this.wikiId, job.id, this.revision, job.controller.signal), job.controller.signal);
      this.assertActive(); job.controller.signal.throwIfAborted();
      const allowed = this.assets.get(job.id);
      if (!allowed || this.pending.get(job.id) !== job || entry.id !== job.id || entry.kind !== "asset"
        || entry.folderId !== allowed.folderId || entry.path !== allowed.path || entry.title !== allowed.title
        || typeof entry.body !== "string" || entry.body.length > PUBLISHED_WIKI_LIMITS.assetBytes) throw new Error("Invalid public image response.");
      const asset = decodeVaultAsset(entry.body);
      if (safeVaultAssetPreviewKind(asset) !== "image") throw new Error("Unsupported public image.");
      this.decoded.delete(job.id); this.decoded.set(job.id, asset);
      while (this.decoded.size > 8) this.decoded.delete(this.decoded.keys().next().value!);
      this.finish(job, undefined, asset);
    } catch (error) { this.finish(job, error); }
    finally { this.active -= 1; this.pump(); }
  }
}

export function usePublishedWikiAssetReader(manifest: PublishedWikiManifest | undefined, signal: AbortSignal | undefined) {
  const [reader, setReader] = useState<PublishedWikiAssetReader | null>(null);
  useEffect(() => {
    if (!manifest || !signal || signal.aborted) { setReader(null); return; }
    const current = new PublishedWikiAssetReader(manifest, signal);
    setReader(current); return current.dispose;
  }, [manifest, signal]);
  return reader && reader.manifest === manifest && reader.scope === signal && !reader.signal.aborted ? reader : null;
}
