import type {
  GraphSnapshot,
  GraphViewSettings,
  ResolvedLinkOccurrence,
  TagIndexEntry,
  UnlinkedMentionOccurrence,
  VaultIndexEntry
} from "./types";
import type {
  KnowledgeMetadataSummary,
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse,
  KnowledgeWorkerUpdateResult
} from "./workerProtocol";
import { vaultSearchQueryContainsRegex } from "./query";

export const DEFAULT_KNOWLEDGE_SEARCH_TIMEOUT_MS = 2_000;
export const DEFAULT_KNOWLEDGE_GRAPH_TIMEOUT_MS = 5_000;
export const DEFAULT_KNOWLEDGE_INDEX_TIMEOUT_MS = 10_000;

export class KnowledgeWorkerError extends Error {
  constructor(message = "Knowledge worker request failed.") {
    super(message);
    this.name = "KnowledgeWorkerError";
  }
}

export class KnowledgeWorkerTimeoutError extends KnowledgeWorkerError {
  constructor() {
    super("Knowledge worker request timed out.");
    this.name = "KnowledgeWorkerTimeoutError";
  }
}

export class KnowledgeWorkerCancelledError extends KnowledgeWorkerError {
  constructor() {
    super("Knowledge worker request was cancelled.");
    this.name = "AbortError";
  }
}

export class KnowledgeWorkerRestartedError extends KnowledgeWorkerError {
  constructor() {
    super("Knowledge worker restarted before the request completed.");
    this.name = "KnowledgeWorkerRestartedError";
  }
}

export interface KnowledgeWorkerTransport {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<KnowledgeWorkerResponse>) => void) | null;
  postMessage(message: KnowledgeWorkerRequest): void;
  terminate(): void;
}

export type KnowledgeWorkerFactory = () => KnowledgeWorkerTransport;

export interface KnowledgeWorkerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface PendingRequest {
  cleanup(): void;
  reject(error: Error): void;
  resolve(response: KnowledgeWorkerResponse): void;
}

type RequestWithoutId = KnowledgeWorkerRequest extends infer Request
  ? Request extends KnowledgeWorkerRequest
    ? Omit<Request, "id">
    : never
  : never;

function defaultWorkerFactory(): KnowledgeWorkerTransport {
  return new Worker(new URL("./knowledge.worker.ts", import.meta.url), {
    name: "quickmemo-knowledge-index",
    type: "module"
  });
}

function assertResponseType<Type extends KnowledgeWorkerResponse["type"]>(
  response: KnowledgeWorkerResponse,
  type: Type
): Extract<KnowledgeWorkerResponse, { type: Type }> {
  if (response.type !== type) {
    throw new KnowledgeWorkerError();
  }
  return response as Extract<KnowledgeWorkerResponse, { type: Type }>;
}

function updateResult(
  response: Extract<KnowledgeWorkerResponse, { type: "updated" }>
): KnowledgeWorkerUpdateResult {
  return {
    version: response.version,
    entryCount: response.entryCount,
    changedMetadataEntryIds: [...response.changedMetadataEntryIds]
  };
}

function requestMayRunRegex(request: RequestWithoutId): boolean {
  if (request.type === "search") {
    return vaultSearchQueryContainsRegex(request.query);
  }
  if (request.type === "graph-snapshot") {
    return vaultSearchQueryContainsRegex(request.settings.common.query)
      || request.settings.common.groups.some((group) => vaultSearchQueryContainsRegex(group.query));
  }
  return false;
}

export class KnowledgeWorkerClient {
  private readonly entriesById = new Map<string, VaultIndexEntry>();
  private readonly factory: KnowledgeWorkerFactory;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;
  private generation = 0;
  private nextRequestId = 0;
  private worker: KnowledgeWorkerTransport;

  constructor(factory: KnowledgeWorkerFactory = defaultWorkerFactory) {
    this.factory = factory;
    this.worker = this.createWorker();
  }

  private createWorker(): KnowledgeWorkerTransport {
    const generation = ++this.generation;
    const worker = this.factory();
    worker.onmessage = (event) => {
      if (generation !== this.generation || this.disposed) {
        return;
      }
      this.handleResponse(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (generation === this.generation && !this.disposed) {
        this.restartWorker(new KnowledgeWorkerRestartedError());
      }
    };
    if (this.entriesById.size > 0) {
      worker.postMessage({
        id: `rehydrate-${generation}`,
        type: "replace-vault",
        entries: [...this.entriesById.values()].map((entry) => ({ ...entry }))
      });
    }
    return worker;
  }

  private handleResponse(response: KnowledgeWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    pending.cleanup();
    if (response.type === "error") {
      pending.reject(new KnowledgeWorkerError());
      return;
    }
    pending.resolve(response);
  }

  private rejectPending(error: Error): void {
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendingRequests) {
      pending.cleanup();
      pending.reject(error);
    }
  }

  private restartWorker(error: Error): void {
    if (this.disposed) {
      return;
    }
    const previousWorker = this.worker;
    previousWorker.onmessage = null;
    previousWorker.onerror = null;
    previousWorker.terminate();
    this.rejectPending(error);
    this.worker = this.createWorker();
  }

  private request(
    request: RequestWithoutId,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<KnowledgeWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new KnowledgeWorkerError("Knowledge worker has been disposed."));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new KnowledgeWorkerCancelledError());
    }

    const id = `knowledge-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (requestMayRunRegex(request) && this.pending.has(id)) {
          // JavaScript RegExp evaluation is synchronous and cannot be
          // cooperatively interrupted. Terminate the worker to enforce the
          // cancellation contract, then rehydrate from the encrypted-session
          // client's in-memory entry map.
          this.restartWorker(new KnowledgeWorkerCancelledError());
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.cleanup();
          pending.reject(new KnowledgeWorkerCancelledError());
        }
      };
      const cleanup = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        options.signal?.removeEventListener("abort", onAbort);
      };

      this.pending.set(id, { cleanup, reject, resolve });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (this.pending.has(id)) {
            this.restartWorker(new KnowledgeWorkerTimeoutError());
          }
        }, Math.max(0, options.timeoutMs));
      }
      try {
        this.worker.postMessage({ ...request, id } as KnowledgeWorkerRequest);
      } catch {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.cleanup();
          pending.reject(new KnowledgeWorkerError());
        }
      }
    });
  }

  async initialize(): Promise<{ version: number; entryCount: number }> {
    const response = assertResponseType(await this.request({ type: "initialize" }), "ready");
    return { version: response.version, entryCount: response.entryCount };
  }

  async replaceVault(
    entries: readonly VaultIndexEntry[],
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<KnowledgeWorkerUpdateResult> {
    const nextEntries = entries.map((entry) => ({ ...entry }));
    const response = assertResponseType(await this.request(
      {
        type: "replace-vault",
        entries: nextEntries
      },
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_KNOWLEDGE_INDEX_TIMEOUT_MS }
    ), "updated");
    this.entriesById.clear();
    for (const entry of nextEntries) {
      this.entriesById.set(entry.id, entry);
    }
    return updateResult(response);
  }

  async upsertEntry(
    entry: VaultIndexEntry,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<KnowledgeWorkerUpdateResult> {
    const nextEntry = { ...entry };
    const response = assertResponseType(await this.request(
      { type: "upsert-entry", entry: nextEntry },
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_KNOWLEDGE_INDEX_TIMEOUT_MS }
    ), "updated");
    this.entriesById.set(entry.id, nextEntry);
    return updateResult(response);
  }

  async removeEntry(
    entryId: string,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<KnowledgeWorkerUpdateResult> {
    const response = assertResponseType(await this.request(
      { type: "remove-entry", entryId },
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_KNOWLEDGE_INDEX_TIMEOUT_MS }
    ), "updated");
    this.entriesById.delete(entryId);
    return updateResult(response);
  }

  async search(
    query: string,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<string[]> {
    const response = assertResponseType(await this.request(
      { type: "search", query },
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_KNOWLEDGE_SEARCH_TIMEOUT_MS }
    ), "search-results");
    return response.entryIds;
  }

  async outgoingLinks(entryId: string): Promise<ResolvedLinkOccurrence[]> {
    const response = assertResponseType(
      await this.request({ type: "outgoing-links", entryId }),
      "outgoing-links"
    );
    return response.occurrences;
  }

  async backlinks(entryId: string): Promise<ResolvedLinkOccurrence[]> {
    const response = assertResponseType(
      await this.request({ type: "backlinks", entryId }),
      "backlinks"
    );
    return response.occurrences;
  }

  async unlinkedMentions(entryId: string): Promise<UnlinkedMentionOccurrence[]> {
    const response = assertResponseType(
      await this.request({ type: "unlinked-mentions", entryId }),
      "unlinked-mentions"
    );
    return response.occurrences;
  }

  async tags(): Promise<TagIndexEntry[]> {
    const response = assertResponseType(await this.request({ type: "tags" }), "tags");
    return response.tags;
  }

  async metadataSummaries(entryIds?: readonly string[]): Promise<KnowledgeMetadataSummary[]> {
    const response = assertResponseType(await this.request({
      type: "metadata-summaries",
      entryIds: entryIds ? [...entryIds] : undefined
    }), "metadata-summaries");
    return response.summaries;
  }

  async graphSnapshot(
    settings: GraphViewSettings,
    activeEntryId?: string,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<GraphSnapshot> {
    const response = assertResponseType(await this.request(
      { type: "graph-snapshot", settings, activeEntryId },
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_KNOWLEDGE_GRAPH_TIMEOUT_MS }
    ), "graph-snapshot");
    return response.snapshot;
  }

  globalGraphSnapshot(
    settings: Extract<GraphViewSettings, { scope: "global" }>,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<GraphSnapshot> {
    return this.graphSnapshot(settings, undefined, options);
  }

  localGraphSnapshot(
    settings: Extract<GraphViewSettings, { scope: "local" }>,
    activeEntryId?: string,
    options: KnowledgeWorkerRequestOptions = {}
  ): Promise<GraphSnapshot> {
    return this.graphSnapshot(settings, activeEntryId, options);
  }

  cancelActiveQueries(): void {
    if (this.pending.size > 0) {
      this.restartWorker(new KnowledgeWorkerCancelledError());
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Lock/logout cleanup must synchronously make decrypted index data
    // unreachable. Waiting for a cooperative worker response leaves a window
    // where plaintext paths/tags remain in both this map and the worker heap.
    this.disposed = true;
    this.entriesById.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.rejectPending(new KnowledgeWorkerError("Knowledge worker has been disposed."));
  }
}
