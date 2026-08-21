import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_GRAPH_SETTINGS,
  DEFAULT_LOCAL_GRAPH_SETTINGS
} from "./graph";
import {
  KnowledgeWorkerCancelledError,
  KnowledgeWorkerClient,
  KnowledgeWorkerTimeoutError
} from "./knowledgeWorkerClient";
import { createKnowledgeWorkerRuntime } from "./workerRuntime";
import type { VaultIndexEntry } from "./types";
import type {
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse
} from "./workerProtocol";
import type { KnowledgeWorkerTransport } from "./knowledgeWorkerClient";

function markdownEntry(id: string, path: string, content: string): VaultIndexEntry {
  return { id, path, kind: "markdown", content };
}

function request(
  responses: KnowledgeWorkerResponse[],
  value: KnowledgeWorkerRequest
): KnowledgeWorkerResponse {
  const runtime = createKnowledgeWorkerRuntime({
    postMessage: (response) => responses.push(response)
  });
  runtime.handleRequest(value);
  return responses.at(-1) as KnowledgeWorkerResponse;
}

class RuntimeTransport implements KnowledgeWorkerTransport {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<KnowledgeWorkerResponse>) => void) | null = null;
  readonly received: KnowledgeWorkerRequest[] = [];
  terminated = false;
  private readonly hangingTypes: ReadonlySet<KnowledgeWorkerRequest["type"]>;
  private readonly runtime = createKnowledgeWorkerRuntime({
    postMessage: (response) => {
      this.onmessage?.(new MessageEvent("message", { data: response }));
    },
    close: () => undefined
  });

  constructor(hangingTypes: readonly KnowledgeWorkerRequest["type"][] = []) {
    this.hangingTypes = new Set(hangingTypes);
  }

  postMessage(message: KnowledgeWorkerRequest): void {
    if (this.terminated) {
      return;
    }
    this.received.push(message);
    if (!this.hangingTypes.has(message.type)) {
      this.runtime.handleRequest(message);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("knowledge worker runtime", () => {
  it("supports replace, upsert, remove, search, links, tags, metadata and graph snapshots", () => {
    const responses: KnowledgeWorkerResponse[] = [];
    const runtime = createKnowledgeWorkerRuntime({
      postMessage: (response) => responses.push(response)
    });
    runtime.handleRequest({
      id: "replace",
      type: "replace-vault",
      entries: [
        markdownEntry(
          "source",
          "Projects/Source.md",
          "---\naliases: [Start]\ntags: [project/quickmemo]\nstatus: active\n---\n[[Target]] important"
        ),
        markdownEntry("target", "Projects/Target.md", "# Target")
      ]
    });
    runtime.handleRequest({ id: "search", type: "search", query: "tag:#project content:important" });
    runtime.handleRequest({ id: "outgoing", type: "outgoing-links", entryId: "source" });
    runtime.handleRequest({ id: "backlinks", type: "backlinks", entryId: "target" });
    runtime.handleRequest({ id: "tags", type: "tags" });
    runtime.handleRequest({ id: "metadata", type: "metadata-summaries", entryIds: ["source"] });
    runtime.handleRequest({
      id: "global",
      type: "graph-snapshot",
      settings: DEFAULT_GLOBAL_GRAPH_SETTINGS
    });
    runtime.handleRequest({
      id: "local",
      type: "graph-snapshot",
      settings: { ...DEFAULT_LOCAL_GRAPH_SETTINGS, root: { entryId: "target" } }
    });
    runtime.handleRequest({
      id: "upsert",
      type: "upsert-entry",
      entry: markdownEntry("third", "Third.md", "#third")
    });
    runtime.handleRequest({ id: "remove", type: "remove-entry", entryId: "third" });

    expect(responses.find((response) => response.id === "replace")).toMatchObject({
      type: "updated",
      version: 1,
      entryCount: 2
    });
    expect(responses.find((response) => response.id === "search")).toMatchObject({
      type: "search-results",
      entryIds: ["source"]
    });
    expect(responses.find((response) => response.id === "outgoing")).toMatchObject({
      type: "outgoing-links",
      occurrences: [expect.objectContaining({ targetEntryId: "target" })]
    });
    expect(responses.find((response) => response.id === "backlinks")).toMatchObject({
      type: "backlinks",
      occurrences: [expect.objectContaining({ sourceEntryId: "source" })]
    });
    expect(responses.find((response) => response.id === "tags")).toMatchObject({
      type: "tags",
      tags: [expect.objectContaining({ key: "project/quickmemo", count: 1 })]
    });
    expect(responses.find((response) => response.id === "metadata")).toMatchObject({
      type: "metadata-summaries",
      summaries: [expect.objectContaining({
        entryId: "source",
        aliases: ["Start"],
        tags: ["project/quickmemo"],
        properties: expect.objectContaining({ status: "active" }),
        outgoingLinkCount: 1,
        backlinkCount: 0
      })]
    });
    expect(responses.find((response) => response.id === "global")).toMatchObject({
      type: "graph-snapshot",
      snapshot: { scope: "global", nodes: expect.any(Array), edges: expect.any(Array) }
    });
    expect(responses.find((response) => response.id === "local")).toMatchObject({
      type: "graph-snapshot",
      snapshot: { scope: "local", rootNodeId: "entry:target" }
    });
    expect(responses.find((response) => response.id === "upsert")).toMatchObject({
      type: "updated",
      version: 2,
      entryCount: 3
    });
    expect(responses.find((response) => response.id === "remove")).toMatchObject({
      type: "updated",
      version: 3,
      entryCount: 2
    });
  });

  it("returns a generic error without reflecting plaintext input", () => {
    const responses: KnowledgeWorkerResponse[] = [];
    const secret = "private-title-that-must-not-be-reflected";
    const response = request(responses, {
      id: "invalid",
      type: "graph-snapshot",
      settings: null
    } as unknown as KnowledgeWorkerRequest);

    expect(response).toEqual({
      id: "invalid",
      type: "error",
      code: "internal-error",
      message: "Knowledge worker request failed."
    });
    expect(JSON.stringify(response)).not.toContain(secret);

    const malformedResponses: KnowledgeWorkerResponse[] = [];
    const runtime = createKnowledgeWorkerRuntime({
      postMessage: (malformedResponse) => malformedResponses.push(malformedResponse)
    });
    runtime.handleRequest({ id: secret, type: "unknown" } as unknown as KnowledgeWorkerRequest);
    expect(malformedResponses[0]).toMatchObject({
      id: secret,
      type: "error",
      code: "invalid-request",
      message: "Knowledge worker request failed."
    });
    expect(malformedResponses[0]?.type === "error" ? malformedResponses[0].message : "").not.toContain(secret);
  });
});

describe("knowledge worker client", () => {
  it("provides typed query methods over a worker transport", async () => {
    const transport = new RuntimeTransport();
    const client = new KnowledgeWorkerClient(() => transport);
    await client.replaceVault([
      markdownEntry("source", "Source.md", "[[Target]] #work"),
      markdownEntry("target", "Target.md", "")
    ]);

    await expect(client.search("tag:#work")).resolves.toEqual(["source"]);
    await expect(client.outgoingLinks("source")).resolves.toEqual([
      expect.objectContaining({ targetEntryId: "target" })
    ]);
    await expect(client.backlinks("target")).resolves.toEqual([
      expect.objectContaining({ sourceEntryId: "source" })
    ]);
    await expect(client.tags()).resolves.toEqual([
      expect.objectContaining({ key: "work", entryIds: ["source"] })
    ]);
    await expect(client.metadataSummaries(["source"])).resolves.toEqual([
      expect.objectContaining({ entryId: "source", outgoingLinkCount: 1 })
    ]);
    await expect(client.globalGraphSnapshot(DEFAULT_GLOBAL_GRAPH_SETTINGS)).resolves.toMatchObject({
      scope: "global",
      nodes: expect.any(Array),
      edges: expect.any(Array)
    });
    await expect(client.localGraphSnapshot(
      { ...DEFAULT_LOCAL_GRAPH_SETTINGS, root: { entryId: "target" } }
    )).resolves.toMatchObject({
      scope: "local",
      rootNodeId: "entry:target"
    });
    await client.dispose();
    expect(transport.terminated).toBe(true);
  });

  it("terminates, restarts and rehydrates the worker when search times out", async () => {
    const first = new RuntimeTransport(["search"]);
    const second = new RuntimeTransport();
    const transports = [first, second];
    const client = new KnowledgeWorkerClient(() => transports.shift() as RuntimeTransport);
    await client.replaceVault([markdownEntry("source", "Source.md", "recoverable")]);

    await expect(client.search("recoverable", { timeoutMs: 5 })).rejects.toBeInstanceOf(
      KnowledgeWorkerTimeoutError
    );
    expect(first.terminated).toBe(true);
    expect(second.received[0]).toMatchObject({
      type: "replace-vault",
      entries: [expect.objectContaining({ id: "source" })]
    });
    await expect(client.search("recoverable")).resolves.toEqual(["source"]);
    await client.dispose();
  });

  it("cancels only the aborted request without disrupting other worker operations", async () => {
    const first = new RuntimeTransport(["search"]);
    const client = new KnowledgeWorkerClient(() => first);
    await client.replaceVault([markdownEntry("source", "Source.md", "cancel me")]);
    const controller = new AbortController();
    const search = client.search("cancel", { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();

    await expect(search).rejects.toBeInstanceOf(KnowledgeWorkerCancelledError);
    expect(first.terminated).toBe(false);
    await expect(client.tags()).resolves.toEqual([]);
    await client.dispose();
    expect(first.terminated).toBe(true);
  });

  it("terminates and rehydrates when cancelling a potentially blocking regex", async () => {
    const first = new RuntimeTransport(["search"]);
    const second = new RuntimeTransport();
    const transports = [first, second];
    const client = new KnowledgeWorkerClient(() => transports.shift() as RuntimeTransport);
    await client.replaceVault([markdownEntry("source", "Source.md", "aaaa")]);
    const controller = new AbortController();
    const search = client.search("content:/(a+)+$/", { signal: controller.signal });

    controller.abort();

    await expect(search).rejects.toBeInstanceOf(KnowledgeWorkerCancelledError);
    expect(first.terminated).toBe(true);
    expect(second.received[0]).toMatchObject({
      type: "replace-vault",
      entries: [expect.objectContaining({ id: "source" })]
    });
    await expect(client.search("aaaa")).resolves.toEqual(["source"]);
    await client.dispose();
  });
});
