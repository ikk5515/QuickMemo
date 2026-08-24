export const VAULT_API_REQUEST_DEADLINE_MS = 12_000;

/**
 * A Vault mutation must never keep an editor or the global path lock busy
 * forever when WebKit, Auth, App Check, or the network transport stalls.
 * Callers still own the mutation's revision/idempotency rules; this helper
 * only supplies a bounded signal and a race for work that does not accept one.
 */
export class VaultApiDeadlineError extends Error {
  readonly code = "deadline-exceeded";

  constructor() {
    super("Vault mutation request deadline exceeded");
    this.name = "VaultApiDeadlineError";
  }
}

export interface VaultApiDeadline {
  readonly signal: AbortSignal;
  dispose(): void;
  race<T>(operation: Promise<T>): Promise<T>;
  timedOut(): boolean;
}

export function createVaultApiDeadline(
  externalSignal?: AbortSignal,
  timeoutMs = VAULT_API_REQUEST_DEADLINE_MS
): VaultApiDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Vault API deadline must be a positive integer");
  }

  const controller = new AbortController();
  let deadlineExceeded = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    abortFromCaller();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = globalThis.setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new VaultApiDeadlineError());
  }, timeoutMs);

  const dispose = () => {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  };

  const race = <T,>(operation: Promise<T>) => {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        controller.signal.removeEventListener("abort", abort);
        reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => {
        controller.signal.removeEventListener("abort", abort);
      });
      if (controller.signal.aborted) abort();
    });
  };

  return {
    dispose,
    race,
    signal: controller.signal,
    timedOut: () => deadlineExceeded
  };
}
