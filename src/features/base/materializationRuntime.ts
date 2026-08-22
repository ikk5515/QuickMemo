import type { VaultIndexEntry } from "../knowledge";
import { materializeBaseView } from "./engine";
import type {
  BaseDocument,
  BaseEvaluationContext,
  BaseMaterializedView,
  BaseMetadata,
  BaseViewConfig
} from "./types";

export interface BaseMaterializationWorkerRequest {
  id: number;
  document: BaseDocument;
  entries: VaultIndexEntry[];
  metadataEntries: Array<[string, BaseMetadata]>;
  context?: BaseEvaluationContext;
  view: BaseViewConfig;
}

export type BaseMaterializationWorkerResponse =
  | { id: number; ok: true; result: BaseMaterializedView }
  | { id: number; ok: false; error: "materialization-failed" };

export function materializeBaseWorkerRequest(
  request: BaseMaterializationWorkerRequest
): BaseMaterializationWorkerResponse {
  try {
    return {
      id: request.id,
      ok: true,
      result: materializeBaseView(
        request.document,
        request.view,
        request.entries,
        new Map(request.metadataEntries),
        request.context
      )
    };
  } catch {
    return { id: request.id, ok: false, error: "materialization-failed" };
  }
}
