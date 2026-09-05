import { mapWithConcurrency } from "../../lib/mapWithConcurrency";
import type { NoteSnapshot } from "../../services/notes";
import { buildInternalLinkResolutionIndex, isExternalLinkTarget, resolveInternalLink, type InternalLinkResolutionIndex } from "../knowledge/path";
import type { VaultIndexEntry } from "../knowledge/types";
import type { MarkdownLinkReference } from "../markdown/types";
import { normalizeVaultPath } from "../vault/interop/path";
import { BoundedVaultAssetDecodeCache } from "../vault/vaultAssetCache";
import { buildVaultPaths, resolvedVaultEntryKind, vaultEntryPath, type DecryptedVaultFolder } from "../vault/vaultData";
import { VaultDecryptionSession, vaultNoteDecryptionAuthority } from "../vault/vaultDecryptionSession";

export interface ResolvedWikiAsset {
  id: string;
  fileName: string;
  snapshot: NoteSnapshot;
}

export interface WikiAssetReaderOptions {
  uid: string;
  privateKey: CryptoKey;
  session: VaultDecryptionSession;
  snapshots: readonly NoteSnapshot[];
  folders: readonly DecryptedVaultFolder[];
}

function abortError() { return new DOMException("The private image reader is no longer active.", "AbortError"); }

function waitForRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** A fixed owner/session projection; only visible references request a body. */
export class WikiAssetReader {
  private readonly controller = new AbortController();
  private readonly assets = new Map<string, { snapshot: NoteSnapshot; authority: string }>();
  private readonly folderPaths: Map<string, string>;
  private readonly decoded = new BoundedVaultAssetDecodeCache(8);
  private readonly epoch: AbortSignal;
  private readonly session: VaultDecryptionSession;
  private readonly uid: string;
  private readonly privateKey: CryptoKey;
  private headers: Promise<{ entries: VaultIndexEntry[]; index: InternalLinkResolutionIndex }> | null = null;

  constructor({ uid, privateKey, session, snapshots, folders }: WikiAssetReaderOptions) {
    session.assertSession(uid, privateKey);
    this.uid = uid;
    this.privateKey = privateKey;
    this.session = session;
    this.epoch = session.signal;
    this.epoch.throwIfAborted();
    this.folderPaths = buildVaultPaths([...folders]);
    // Do not resolve from a truncated index: that could select a different file.
    if (snapshots.length <= 5_000) for (const snapshot of snapshots) {
      const authority = vaultNoteDecryptionAuthority(snapshot, uid);
      if (authority && snapshot.ownerUid === uid && !snapshot.isDeleted && !snapshot.isPurged
        && resolvedVaultEntryKind(snapshot) === "asset"
        && (!snapshot.folderId || this.folderPaths.has(snapshot.folderId))) {
        this.assets.set(snapshot.id, { snapshot, authority });
      }
    }
    this.epoch.addEventListener("abort", this.dispose, { once: true });
  }

  get signal() { return this.controller.signal; }

  dispose = () => {
    this.controller.abort(abortError());
    this.epoch.removeEventListener("abort", this.dispose);
    this.assets.clear();
    this.folderPaths.clear();
    this.headers = null;
    this.decoded.clear();
  };

  private assertActive() {
    this.signal.throwIfAborted();
    this.epoch.throwIfAborted();
    this.session.assertSession(this.uid, this.privateKey);
  }

  private async operation<T>(signal: AbortSignal, run: (combined: AbortSignal) => Promise<T>) {
    this.assertActive();
    signal.throwIfAborted();
    const combined = new AbortController();
    const abort = () => combined.abort(abortError());
    this.signal.addEventListener("abort", abort, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await waitForRead(run(combined.signal), combined.signal);
      combined.signal.throwIfAborted();
      this.assertActive();
      return result;
    } finally {
      this.signal.removeEventListener("abort", abort);
      signal.removeEventListener("abort", abort);
    }
  }

  private titleIndex() {
    if (!this.headers) {
      this.headers = mapWithConcurrency([...this.assets.values()], 4, async ({ snapshot }) => {
        this.assertActive();
        try {
          const title = await this.session.decryptNoteTitle(snapshot, this.signal);
          this.assertActive();
          const path = normalizeVaultPath(vaultEntryPath({ entryKind: "asset", folderId: snapshot.folderId, title }, this.folderPaths));
          return { id: snapshot.id, path, kind: "asset" } as VaultIndexEntry;
        } catch (error) {
          this.assertActive();
          // A malformed filename or unreadable individual file is not a match.
          if (error instanceof Error && error.name === "AbortError") throw error;
          return null;
        }
      }).then((entries) => {
        this.assertActive();
        const valid = entries.filter((entry): entry is VaultIndexEntry => entry !== null);
        return { entries: valid, index: buildInternalLinkResolutionIndex(valid, new Map()) };
      });
    }
    return this.headers;
  }

  async resolve(reference: MarkdownLinkReference, sourceEntry: Pick<VaultIndexEntry, "id" | "path">, signal: AbortSignal): Promise<ResolvedWikiAsset | null> {
    return this.operation(signal, async (combined) => {
      if (reference.kind === "external" || !reference.path || isExternalLinkTarget(reference.path)) return null;
      const { entries, index } = await waitForRead(this.titleIndex(), combined);
      combined.throwIfAborted();
      const metadata = new Map();
      const result = resolveInternalLink({
        sourceEntryId: sourceEntry.id, sourcePath: sourceEntry.path,
        syntax: reference.kind === "wikilink" ? "wikilink" : "markdown",
        raw: reference.raw, target: reference.path, embedded: true, line: 0, column: 0, context: ""
      }, entries, metadata, index);
      const snapshot = result.status === "resolved" && result.targetEntryId ? this.assets.get(result.targetEntryId)?.snapshot : null;
      if (!snapshot || !result.targetPath) return null;
      return { id: snapshot.id, fileName: result.targetPath.split("/").at(-1)!, snapshot };
    });
  }

  async load(asset: ResolvedWikiAsset, signal: AbortSignal) {
    return this.operation(signal, async (combined) => {
      const scoped = this.assets.get(asset.id);
      if (!scoped || scoped.snapshot !== asset.snapshot
        || scoped.authority !== vaultNoteDecryptionAuthority(asset.snapshot, this.uid)) return null;
      const { body } = await this.session.decryptNote(asset.snapshot, combined);
      combined.throwIfAborted();
      this.assertActive();
      return this.decoded.get(asset.id, body);
    });
  }
}
