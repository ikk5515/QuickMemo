import {
  VaultInteropError,
  type ObsidianVaultManifest,
  type ObsidianVaultSourceEntry,
  type ObsidianZipOptions,
  type VaultInteropErrorCode
} from "./types";
import type { ObsidianVaultZipExport } from "./zip";
import type {
  VaultInteropWorkerFailure,
  VaultInteropWorkerRequest,
  VaultInteropWorkerResponse
} from "./workerProtocol";

export interface VaultInteropWorkerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface VaultInteropWorkerTransport {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<VaultInteropWorkerResponse>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: VaultInteropWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export type VaultInteropWorkerFactory = () => VaultInteropWorkerTransport;

export class VaultInteropWorkerExecutionError extends Error {
  readonly code = "worker-failed" as const;

  constructor() {
    super("Vault interoperability worker failed.");
    this.name = "VaultInteropWorkerExecutionError";
  }
}

export class VaultInteropWorkerProtocolError extends Error {
  readonly code = "invalid-response" as const;

  constructor() {
    super("Vault interoperability worker returned an invalid response.");
    this.name = "VaultInteropWorkerProtocolError";
  }
}

export class VaultInteropWorkerCancelledError extends Error {
  readonly code = "cancelled" as const;

  constructor() {
    super("Vault interoperability operation was cancelled.");
    this.name = "AbortError";
  }
}

export class VaultInteropWorkerTerminatedError extends Error {
  readonly code = "terminated" as const;

  constructor() {
    super("Vault interoperability worker was terminated.");
    this.name = "VaultInteropWorkerTerminatedError";
  }
}

export const DEFAULT_VAULT_INTEROP_TIMEOUT_MS = 120_000;
export const MAXIMUM_VAULT_INTEROP_TIMEOUT_MS = 300_000;

export class VaultInteropWorkerTimeoutError extends Error {
  readonly code = "timeout" as const;

  constructor() {
    super("Vault interoperability worker timed out.");
    this.name = "VaultInteropWorkerTimeoutError";
  }
}

interface ActiveOperation {
  cancel(error: Error): void;
}

const VAULT_ERROR_CODES = new Set<VaultInteropErrorCode>([
  "archive-too-large",
  "canvas-invalid",
  "duplicate-path",
  "entry-too-large",
  "invalid-content",
  "invalid-path",
  "path-conflict",
  "too-many-entries",
  "total-size-exceeded",
  "unsupported-compression",
  "zip-invalid"
]);

function defaultWorkerFactory(): VaultInteropWorkerTransport {
  return new Worker(new URL("./interop.worker.ts", import.meta.url), {
    name: "quickmemo-vault-interop",
    type: "module"
  });
}

function requestTimeoutMs(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_VAULT_INTEROP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAXIMUM_VAULT_INTEROP_TIMEOUT_MS
  ) {
    throw new RangeError("Vault interoperability timeout is outside the safe range.");
  }
  return timeoutMs;
}

function isolatedBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function copyOptions(options: ObsidianZipOptions): ObsidianZipOptions {
  return {
    ...options,
    folders: options.folders ? [...options.folders] : undefined,
    limits: options.limits ? { ...options.limits } : undefined
  };
}

function copySourcesForTransfer(sources: readonly ObsidianVaultSourceEntry[]): {
  sources: ObsidianVaultSourceEntry[];
  transfer: Transferable[];
} {
  const transfer: Transferable[] = [];
  const copied = sources.map((source) => {
    if (typeof source.content === "string") {
      return { ...source };
    }
    const content = isolatedBytes(source.content);
    transfer.push(content.buffer);
    return { ...source, content };
  });
  return { sources: copied, transfer };
}

function isWorkerResponse(value: unknown, id: string): value is VaultInteropWorkerResponse {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && value.id === id
    && "type" in value
    && (value.type === "export-result" || value.type === "import-result" || value.type === "error");
}

function failureError(failure: VaultInteropWorkerFailure): Error {
  if (failure.kind === "vault" && VAULT_ERROR_CODES.has(failure.code)) {
    return new VaultInteropError(failure.code);
  }
  if (failure.kind === "worker" && failure.code === "internal-error") {
    return new VaultInteropWorkerExecutionError();
  }
  return new VaultInteropWorkerProtocolError();
}

/**
 * Creates one short-lived browser worker per operation. This makes AbortSignal
 * cancellation effective even while synchronous ZIP code is running and keeps
 * decrypted vault content out of a long-lived worker after completion.
 */
export class VaultInteropWorkerClient {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly factory: VaultInteropWorkerFactory;
  private disposed = false;
  private nextRequestId = 0;

  constructor(factory: VaultInteropWorkerFactory = defaultWorkerFactory) {
    this.factory = factory;
  }

  private request(
    request: VaultInteropWorkerRequest,
    transfer: Transferable[],
    expectedType: "export-result" | "import-result",
    options: VaultInteropWorkerRequestOptions
  ): Promise<VaultInteropWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new VaultInteropWorkerTerminatedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(new VaultInteropWorkerCancelledError());
    }
    let timeoutMs: number;
    try {
      timeoutMs = requestTimeoutMs(options.timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }

    let worker: VaultInteropWorkerTransport;
    try {
      worker = this.factory();
    } catch {
      return Promise.reject(new VaultInteropWorkerExecutionError());
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        options.signal?.removeEventListener("abort", onAbort);
        worker.onerror = null;
        worker.onmessage = null;
        worker.onmessageerror = null;
        worker.terminate();
        this.active.delete(request.id);
      };
      const finish = (result: { response: VaultInteropWorkerResponse } | { error: Error }) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if ("error" in result) {
          reject(result.error);
        } else {
          resolve(result.response);
        }
      };
      const onAbort = () => finish({ error: new VaultInteropWorkerCancelledError() });

      this.active.set(request.id, {
        cancel: (error) => finish({ error })
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      worker.onerror = (event) => {
        event.preventDefault();
        finish({ error: new VaultInteropWorkerExecutionError() });
      };
      worker.onmessageerror = () => {
        finish({ error: new VaultInteropWorkerProtocolError() });
      };
      worker.onmessage = (event) => {
        if (!isWorkerResponse(event.data, request.id)) {
          finish({ error: new VaultInteropWorkerProtocolError() });
          return;
        }
        if (event.data.type === "error") {
          finish({ error: failureError(event.data.error) });
          return;
        }
        if (event.data.type !== expectedType) {
          finish({ error: new VaultInteropWorkerProtocolError() });
          return;
        }
        finish({ response: event.data });
      };
      timeoutHandle = setTimeout(() => {
        finish({ error: new VaultInteropWorkerTimeoutError() });
      }, timeoutMs);

      try {
        worker.postMessage(request, transfer);
      } catch {
        finish({ error: new VaultInteropWorkerExecutionError() });
      }
    });
  }

  async exportVault(
    sources: readonly ObsidianVaultSourceEntry[],
    zipOptions: ObsidianZipOptions = {},
    requestOptions: VaultInteropWorkerRequestOptions = {}
  ): Promise<ObsidianVaultZipExport> {
    const id = `vault-interop-${++this.nextRequestId}`;
    const copied = copySourcesForTransfer(sources);
    const response = await this.request({
      id,
      type: "export",
      sources: copied.sources,
      options: copyOptions(zipOptions)
    }, copied.transfer, "export-result", requestOptions);
    if (response.type !== "export-result") {
      throw new VaultInteropWorkerProtocolError();
    }
    return response.result;
  }

  async importVault(
    bytes: Uint8Array,
    zipOptions: ObsidianZipOptions = {},
    requestOptions: VaultInteropWorkerRequestOptions = {}
  ): Promise<ObsidianVaultManifest> {
    const id = `vault-interop-${++this.nextRequestId}`;
    const isolatedArchive = isolatedBytes(bytes);
    const response = await this.request({
      id,
      type: "import",
      bytes: isolatedArchive,
      options: copyOptions(zipOptions)
    }, [isolatedArchive.buffer], "import-result", requestOptions);
    if (response.type !== "import-result") {
      throw new VaultInteropWorkerProtocolError();
    }
    return response.result;
  }

  terminate(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const active = [...this.active.values()];
    for (const operation of active) {
      operation.cancel(new VaultInteropWorkerTerminatedError());
    }
    this.active.clear();
  }
}

export async function exportObsidianVaultZipInWorker(
  sources: readonly ObsidianVaultSourceEntry[],
  zipOptions: ObsidianZipOptions = {},
  requestOptions: VaultInteropWorkerRequestOptions = {}
): Promise<ObsidianVaultZipExport> {
  const client = new VaultInteropWorkerClient();
  try {
    return await client.exportVault(sources, zipOptions, requestOptions);
  } finally {
    client.terminate();
  }
}

export async function readObsidianVaultZipInWorker(
  bytes: Uint8Array,
  zipOptions: ObsidianZipOptions = {},
  requestOptions: VaultInteropWorkerRequestOptions = {}
): Promise<ObsidianVaultManifest> {
  const client = new VaultInteropWorkerClient();
  try {
    return await client.importVault(bytes, zipOptions, requestOptions);
  } finally {
    client.terminate();
  }
}
