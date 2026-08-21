import { VaultInteropError } from "./types";
import { exportObsidianVaultZip, readObsidianVaultZip } from "./zip";
import type {
  VaultInteropWorkerRequest,
  VaultInteropWorkerResponse
} from "./workerProtocol";

export interface VaultInteropWorkerRuntimeOptions {
  close?(): void;
  postMessage(response: VaultInteropWorkerResponse, transfer: Transferable[]): void;
}

export interface VaultInteropWorkerRuntime {
  handleRequest(request: unknown): void;
}

function transferableBuffers(value: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (candidate: unknown): void => {
    if (
      ArrayBuffer.isView(candidate)
      && Object.prototype.toString.call(candidate) === "[object Uint8Array]"
    ) {
      if (Object.prototype.toString.call(candidate.buffer) === "[object ArrayBuffer]") {
        buffers.add(candidate.buffer as ArrayBuffer);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (typeof candidate === "object" && candidate !== null) {
      for (const item of Object.values(candidate)) {
        visit(item);
      }
    }
  };
  visit(value);
  return [...buffers];
}

function requestId(request: unknown): string {
  if (
    typeof request === "object"
    && request !== null
    && "id" in request
    && typeof request.id === "string"
  ) {
    return request.id;
  }
  return "invalid-request";
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isRequest(request: unknown): request is VaultInteropWorkerRequest {
  if (
    typeof request !== "object"
    || request === null
    || !("id" in request)
    || typeof request.id !== "string"
    || !("type" in request)
    || typeof request.type !== "string"
    || !("options" in request)
    || typeof request.options !== "object"
    || request.options === null
  ) {
    return false;
  }
  if (request.type === "export") {
    return "sources" in request && Array.isArray(request.sources);
  }
  return request.type === "import"
    && "bytes" in request
    && isUint8Array(request.bytes);
}

function errorResponse(id: string, error: unknown): VaultInteropWorkerResponse {
  if (error instanceof VaultInteropError) {
    return {
      id,
      type: "error",
      error: { kind: "vault", code: error.code }
    };
  }
  return {
    id,
    type: "error",
    error: { kind: "worker", code: "internal-error" }
  };
}

/**
 * Runs one ZIP operation without logging or persisting its plaintext inputs.
 * The browser entrypoint closes the dedicated worker after this response.
 */
export function createVaultInteropWorkerRuntime(
  runtimeOptions: VaultInteropWorkerRuntimeOptions
): VaultInteropWorkerRuntime {
  let completed = false;

  const finish = (response: VaultInteropWorkerResponse): void => {
    runtimeOptions.postMessage(response, transferableBuffers(response));
    runtimeOptions.close?.();
  };

  return {
    handleRequest(request) {
      if (completed) {
        return;
      }
      completed = true;
      const id = requestId(request);
      if (!isRequest(request)) {
        finish({
          id,
          type: "error",
          error: { kind: "worker", code: "invalid-request" }
        });
        return;
      }

      try {
        if (request.type === "export") {
          finish({
            id: request.id,
            type: "export-result",
            result: exportObsidianVaultZip(request.sources, request.options)
          });
          return;
        }
        finish({
          id: request.id,
          type: "import-result",
          result: readObsidianVaultZip(request.bytes, request.options)
        });
      } catch (error) {
        finish(errorResponse(request.id, error));
      }
    }
  };
}
