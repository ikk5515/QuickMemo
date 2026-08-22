import {
  materializeBaseWorkerRequest,
  type BaseMaterializationWorkerRequest,
  type BaseMaterializationWorkerResponse
} from "./materializationRuntime";

interface BaseWorkerScope {
  onmessage: ((event: MessageEvent<BaseMaterializationWorkerRequest>) => void) | null;
  postMessage(message: BaseMaterializationWorkerResponse): void;
}

const workerScope = self as unknown as BaseWorkerScope;

workerScope.onmessage = (event) => {
  workerScope.postMessage(materializeBaseWorkerRequest(event.data));
};
