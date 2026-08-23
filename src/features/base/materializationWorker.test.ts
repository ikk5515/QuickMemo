import { describe, expect, it } from "vitest";
import type { VaultIndexEntry } from "../knowledge";
import type { BaseDocument, BaseMetadata, BaseViewConfig } from "./types";
import { materializeBaseWorkerRequest } from "./materializationRuntime";
import { baseDocumentRequiresWorker } from "./materializationWorker";

const document: BaseDocument = {
  formulas: {},
  properties: { status: { displayName: "상태" } },
  summaries: {},
  views: []
};
const view: BaseViewConfig = {
  type: "table",
  name: "작업",
  order: ["file.name", "status"],
  sort: [{ property: "file.name", direction: "ASC" }],
  summaries: {}
};
const entries: VaultIndexEntry[] = [
  { id: "b", kind: "markdown", path: "B.md" },
  { id: "a", kind: "markdown", path: "A.md" },
  { id: "asset", kind: "asset", path: "image.png" }
];
const metadata = (status: string): BaseMetadata => ({
  aliases: [],
  blocks: [],
  headings: [],
  links: [],
  properties: { status },
  tags: []
});

describe("Base materialization worker runtime", () => {
  it("routes regex formulas through a disposable Worker even for a small Base", () => {
    expect(baseDocumentRequiresWorker({
      filters: undefined,
      formulas: { matched: 'file.name.matches(/^(note|daily)-\\d+$/i)' },
      summaries: {},
      views: []
    })).toBe(true);
    expect(baseDocumentRequiresWorker({
      filters: undefined,
      formulas: { label: 'file.name + " / " + status' },
      summaries: {},
      views: []
    })).toBe(false);
  });

  it("materializes the same serializable rows without executing user code", () => {
    const response = materializeBaseWorkerRequest({
      id: 7,
      document,
      entries,
      metadataEntries: [["a", metadata("todo")], ["b", metadata("done")]],
      view
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.id).toBe(7);
    expect(response.result.groups[0].rows.map((row) => row.entry.id)).toEqual(["a", "b", "asset"]);
    expect(response.result.groups[0].rows[0].cells.status).toBe("todo");
  });

  it("returns an opaque failure instead of reflecting exception details", () => {
    const response = materializeBaseWorkerRequest({
      id: 9,
      document,
      entries: null as unknown as VaultIndexEntry[],
      metadataEntries: [],
      view
    });

    expect(response).toEqual({ id: 9, ok: false, error: "materialization-failed" });
  });

  it("forwards serializable this.file, time and random context into materialization", () => {
    const contextualDocument: BaseDocument = {
      formulas: {
        context: "this.file.path",
        loadedAt: "number(now())",
        roll: "random()"
      },
      properties: {},
      summaries: {},
      views: []
    };
    const contextualView: BaseViewConfig = {
      ...view,
      order: ["formula.context", "formula.loadedAt", "formula.roll"]
    };
    const request = {
      id: 11,
      document: contextualDocument,
      entries,
      metadataEntries: [["a", metadata("todo")], ["b", metadata("done")]] as Array<[string, BaseMetadata]>,
      context: {
        thisEntry: entries[0],
        thisMetadata: metadata("context"),
        nowEpochMs: 1_748_351_045_123,
        randomSeed: 42
      },
      view: contextualView
    };
    const response = materializeBaseWorkerRequest(request);
    const replay = materializeBaseWorkerRequest(request);

    expect(response.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!response.ok || !replay.ok) return;
    expect(response.result.groups[0].rows[0].cells).toMatchObject({
      "formula.context": "B.md",
      "formula.loadedAt": 1_748_351_045_123
    });
    expect(response.result.groups[0].rows[0].cells["formula.roll"]).toBe(
      replay.result.groups[0].rows[0].cells["formula.roll"]
    );
  });
});
