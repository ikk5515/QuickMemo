import { createKnowledgeWorkerRuntime } from "./workerRuntime";
import type { KnowledgeWorkerRequest, KnowledgeWorkerResponse } from "./workerProtocol";

interface KnowledgeWorkerScope {
  close(): void;
  onmessage: ((event: MessageEvent<KnowledgeWorkerRequest>) => void) | null;
  postMessage(message: KnowledgeWorkerResponse): void;
}

const workerScope = globalThis as unknown as KnowledgeWorkerScope;
const runtime = createKnowledgeWorkerRuntime({
  postMessage: (response) => workerScope.postMessage(response),
  close: () => workerScope.close()
});

workerScope.onmessage = (event) => {
  runtime.handleRequest(event.data);
};
