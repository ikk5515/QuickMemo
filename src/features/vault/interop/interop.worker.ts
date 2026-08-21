import { createVaultInteropWorkerRuntime } from "./workerRuntime";
import type {
  VaultInteropWorkerRequest,
  VaultInteropWorkerResponse
} from "./workerProtocol";

interface VaultInteropWorkerScope {
  close(): void;
  onmessage: ((event: MessageEvent<VaultInteropWorkerRequest>) => void) | null;
  postMessage(message: VaultInteropWorkerResponse, transfer: Transferable[]): void;
}

const workerScope = globalThis as unknown as VaultInteropWorkerScope;
const runtime = createVaultInteropWorkerRuntime({
  postMessage: (response, transfer) => workerScope.postMessage(response, transfer),
  close: () => workerScope.close()
});

workerScope.onmessage = (event) => {
  workerScope.onmessage = null;
  runtime.handleRequest(event.data);
};
