import { describe, expect, it, vi } from "vitest";
import * as graphModule from "./graph";
import {
  DEFAULT_GLOBAL_GRAPH_SETTINGS,
  DEFAULT_LOCAL_GRAPH_SETTINGS
} from "./graph";
import {
  KnowledgeWorkerCancelledError,
  KnowledgeWorkerClient,
  KnowledgeWorkerError,
  KnowledgeWorkerTimeoutError
} from "./knowledgeWorkerClient";
import {
  MAX_METADATA_SUMMARY_LINKS_PER_ENTRY,
  MAX_METADATA_SUMMARY_LINKS_PER_RESPONSE,
  createKnowledgeWorkerRuntime
} from "./workerRuntime";
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

class ThrowingMutationTransport extends RuntimeTransport {
  override postMessage(message: KnowledgeWorkerRequest): void {
    if (message.type === "upsert-entry") {
      throw new DOMException("worker unavailable", "InvalidStateError");
    }
    super.postMessage(message);
  }
}

describe("knowledge worker runtime", () => {
  it("reuses global and local projections for display changes and invalidates them on data changes", () => {
    const buildSnapshot = vi.spyOn(graphModule, "buildGraphSnapshot");
    try {
      const responses: KnowledgeWorkerResponse[] = [];
      const runtime = createKnowledgeWorkerRuntime({ postMessage: (response) => responses.push(structuredClone(response)) });
      runtime.handleRequest({ id: "replace", type: "replace-vault", entries: [
        markdownEntry("a", "A.md", "[[B]]"), markdownEntry("b", "B.md", "")
      ] });
      const global = { id: "global", type: "graph-snapshot" as const, settings: DEFAULT_GLOBAL_GRAPH_SETTINGS };
      const local = { id: "local", type: "graph-snapshot" as const, settings: DEFAULT_LOCAL_GRAPH_SETTINGS, activeEntryId: "a" };
      runtime.handleRequest(global);
      runtime.handleRequest(local);
      expect(buildSnapshot).toHaveBeenCalledTimes(2);

      runtime.handleRequest({ ...global, activeEntryId: "b", settings: {
        ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
        animate: true,
        common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common, nodeSize: 2, repelForce: 15, arrows: true }
      } });
      runtime.handleRequest(local);
      expect(buildSnapshot).toHaveBeenCalledTimes(2);

      runtime.handleRequest({ ...local, activeEntryId: "b" });
      expect(buildSnapshot).toHaveBeenCalledTimes(3);
      runtime.handleRequest({ ...global, settings: {
        ...DEFAULT_GLOBAL_GRAPH_SETTINGS,
        common: { ...DEFAULT_GLOBAL_GRAPH_SETTINGS.common, query: "file:A" }
      } });
      expect(buildSnapshot).toHaveBeenCalledTimes(4);

      runtime.handleRequest({ id: "rename", type: "upsert-entry", entry: markdownEntry("a", "Renamed.md", "[[B]]") });
      runtime.handleRequest(global);
      runtime.handleRequest(local);
      expect(buildSnapshot).toHaveBeenCalledTimes(6);

      runtime.handleRequest({ id: "remove", type: "remove-entry", entryId: "b" });
      runtime.handleRequest(global);
      const removed = responses.at(-1);
      expect(removed?.type === "graph-snapshot" && removed.snapshot.nodes.some((node) => node.entryId === "b")).toBe(false);
      expect(buildSnapshot).toHaveBeenCalledTimes(7);

      // Replacing a vault/allowed-entry set cannot reuse the previous user's
      // decrypted projection, even when the filter and active id are unchanged.
      runtime.handleRequest({ id: "new-scope", type: "replace-vault", entries: [] });
      runtime.handleRequest(global);
      expect(responses.at(-1)).toMatchObject({ type: "graph-snapshot", snapshot: { nodes: [], edges: [] } });
      expect(buildSnapshot).toHaveBeenCalledTimes(8);
      runtime.handleRequest({ id: "dispose", type: "dispose" });
      const responseCount = responses.length;
      runtime.handleRequest(global);
      expect(responses).toHaveLength(responseCount);
      expect(buildSnapshot).toHaveBeenCalledTimes(8);
    } finally {
      buildSnapshot.mockRestore();
    }
  });

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
          "---\naliases: [Start]\ntags: [project/quickmemo]\nstatus: active\n---\n[[Target]] Target important"
        ),
        markdownEntry("target", "Projects/Target.md", "# Target")
      ]
    });
    runtime.handleRequest({ id: "search", type: "search", query: "tag:#project content:important" });
    runtime.handleRequest({ id: "outgoing", type: "outgoing-links", entryId: "source" });
    runtime.handleRequest({ id: "backlinks", type: "backlinks", entryId: "target" });
    runtime.handleRequest({ id: "unlinked", type: "unlinked-mentions", entryId: "target" });
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
      occurrences: [expect.objectContaining({
        context: expect.stringContaining("important"),
        raw: "[[Target]]",
        targetEntryId: "target"
      })]
    });
    expect(responses.find((response) => response.id === "backlinks")).toMatchObject({
      type: "backlinks",
      occurrences: [expect.objectContaining({ sourceEntryId: "source" })]
    });
    expect(responses.find((response) => response.id === "unlinked")).toMatchObject({
      type: "unlinked-mentions",
      occurrences: [expect.objectContaining({
        matchedText: "Target",
        sourceEntryId: "source",
        targetEntryId: "target"
      })]
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
        links: [{ target: "Target" }]
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
      entryCount: 3,
      changedMetadataEntryIds: ["third"]
    });
    expect(responses.find((response) => response.id === "remove")).toMatchObject({
      type: "updated",
      version: 3,
      entryCount: 2,
      changedMetadataEntryIds: ["third"]
    });
  });

  it("returns bounded structured-clone-safe internal link summaries without exposing mutable index state", () => {
    const responses: KnowledgeWorkerResponse[] = [];
    const runtime = createKnowledgeWorkerRuntime({
      postMessage: (response) => responses.push(response)
    });
    const linkSyntax = "![[Target#^block-id|Card]]";
    runtime.handleRequest({
      id: "replace",
      type: "replace-vault",
      entries: [
        markdownEntry(
          "source",
          "Folder/Source.md",
          `${linkSyntax} `.repeat(MAX_METADATA_SUMMARY_LINKS_PER_ENTRY + 32)
        ),
        markdownEntry("target", "Folder/Target.md", "^block-id")
      ]
    });
    runtime.handleRequest({ id: "metadata-1", type: "metadata-summaries", entryIds: ["source"] });

    const response = responses.find((item) => item.id === "metadata-1");
    expect(response?.type).toBe("metadata-summaries");
    if (!response || response.type !== "metadata-summaries") {
      throw new Error("Expected metadata summaries response");
    }
    expect(structuredClone(response)).toEqual(response);
    expect(response.summaries[0]?.links).toHaveLength(1);
    expect(response.summaries[0]?.links[0]).toEqual({ target: "Target" });
    expect(Object.keys(response.summaries[0]?.links[0] ?? {})).toEqual(["target"]);
    expect(JSON.stringify(response)).not.toContain(linkSyntax);

    const firstLink = response.summaries[0]?.links[0];
    if (firstLink) {
      firstLink.target = "mutated-outside-worker";
    }
    runtime.handleRequest({ id: "metadata-2", type: "metadata-summaries", entryIds: ["source"] });
    const secondResponse = responses.find((item) => item.id === "metadata-2");
    expect(secondResponse?.type === "metadata-summaries"
      ? secondResponse.summaries[0]?.links[0]
      : undefined).toEqual(expect.objectContaining({
      target: "Target"
    }));
  });

  it("bounds metadata link projections across the whole worker response", () => {
    const responses: KnowledgeWorkerResponse[] = [];
    const runtime = createKnowledgeWorkerRuntime({
      postMessage: (response) => responses.push(response)
    });
    const entries = Array.from({ length: 17 }, (_, entryIndex) => markdownEntry(
      `source-${entryIndex}`,
      `Folder/Source-${entryIndex}.md`,
      Array.from(
        { length: MAX_METADATA_SUMMARY_LINKS_PER_ENTRY + 1 },
        (__, linkIndex) => `[[Target-${entryIndex}-${linkIndex}]]`
      ).join(" ")
    ));
    runtime.handleRequest({ id: "replace-many", type: "replace-vault", entries });
    runtime.handleRequest({ id: "metadata-many", type: "metadata-summaries" });
    runtime.handleRequest({
      id: "metadata-selected",
      type: "metadata-summaries",
      entryIds: ["source-16"]
    });

    const response = responses.find((item) => item.id === "metadata-many");
    expect(response?.type).toBe("metadata-summaries");
    if (!response || response.type !== "metadata-summaries") {
      throw new Error("Expected metadata summaries response");
    }
    expect(response.summaries.reduce((sum, summary) => sum + summary.links.length, 0))
      .toBe(MAX_METADATA_SUMMARY_LINKS_PER_RESPONSE);
    expect(response.summaries.every(
      (summary) => summary.links.length <= MAX_METADATA_SUMMARY_LINKS_PER_ENTRY
    )).toBe(true);
    const selectedResponse = responses.find((item) => item.id === "metadata-selected");
    expect(selectedResponse?.type === "metadata-summaries"
      ? selectedResponse.summaries
      : undefined).toEqual([response.summaries[16]]);
  });

  it("reports every summary whose response-wide link budget projection moves", () => {
    const responses: KnowledgeWorkerResponse[] = [];
    const runtime = createKnowledgeWorkerRuntime({
      postMessage: (response) => responses.push(response)
    });
    const entries = Array.from({ length: 17 }, (_, entryIndex) => markdownEntry(
      `source-${entryIndex}`,
      `Folder/Source-${entryIndex}.md`,
      Array.from(
        { length: MAX_METADATA_SUMMARY_LINKS_PER_ENTRY + 1 },
        (__, linkIndex) => `[[Target-${entryIndex}-${linkIndex}]]`
      ).join(" ")
    ));
    runtime.handleRequest({ id: "replace-budget", type: "replace-vault", entries });
    runtime.handleRequest({
      id: "upsert-budget",
      type: "upsert-entry",
      entry: markdownEntry("source-0", "Folder/Source-0.md", "no links")
    });
    runtime.handleRequest({ id: "metadata-after", type: "metadata-summaries" });
    runtime.handleRequest({
      id: "metadata-after-selected",
      type: "metadata-summaries",
      entryIds: ["source-16"]
    });

    expect(responses.find((item) => item.id === "upsert-budget")).toMatchObject({
      type: "updated",
      changedMetadataEntryIds: ["source-0", "source-16"]
    });
    const fullResponse = responses.find((item) => item.id === "metadata-after");
    const selectedResponse = responses.find((item) => item.id === "metadata-after-selected");
    expect(fullResponse?.type).toBe("metadata-summaries");
    expect(selectedResponse?.type).toBe("metadata-summaries");
    if (
      !fullResponse
      || fullResponse.type !== "metadata-summaries"
      || !selectedResponse
      || selectedResponse.type !== "metadata-summaries"
    ) {
      throw new Error("Expected metadata summaries responses");
    }
    const fullSummary = fullResponse.summaries.find((summary) => summary.entryId === "source-16");
    expect(fullSummary?.links).toHaveLength(MAX_METADATA_SUMMARY_LINKS_PER_ENTRY);
    expect(selectedResponse.summaries).toEqual([fullSummary]);
  });

  it("returns a generic error without reflecting or publicly logging plaintext input", () => {
    const consoleSpies = (["debug", "error", "info", "log", "warn"] as const).map((method) => (
      vi.spyOn(console, method).mockImplementation(() => undefined)
    ));
    const responses: KnowledgeWorkerResponse[] = [];
    const secret = "private-title-that-must-not-be-reflected";
    try {
      const response = request(responses, {
        id: "invalid",
        type: "replace-vault",
        entries: null,
        privatePlaintext: secret
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
      runtime.handleRequest({
        id: "malformed",
        type: "unknown",
        privatePlaintext: secret
      } as unknown as KnowledgeWorkerRequest);
      expect(malformedResponses[0]).toEqual({
        id: "malformed",
        type: "error",
        code: "invalid-request",
        message: "Knowledge worker request failed."
      });
      expect(JSON.stringify(malformedResponses[0])).not.toContain(secret);
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });
});

describe("knowledge worker client", () => {
  it("provides typed query methods over a worker transport", async () => {
    const transport = new RuntimeTransport();
    const client = new KnowledgeWorkerClient(() => transport);
    const replaceResult = await client.replaceVault([
      markdownEntry("source", "Source.md", "[[Target]] Target #work"),
      markdownEntry("target", "Target.md", "")
    ]);
    expect(replaceResult).toEqual({
      version: 1,
      entryCount: 2,
      changedMetadataEntryIds: ["source", "target"]
    });

    await expect(client.search("tag:#work")).resolves.toEqual(["source"]);
    await expect(client.outgoingLinks("source")).resolves.toEqual([
      expect.objectContaining({ context: "[[Target]] Target #work", raw: "[[Target]]", targetEntryId: "target" })
    ]);
    await expect(client.backlinks("target")).resolves.toEqual([
      expect.objectContaining({ sourceEntryId: "source" })
    ]);
    await expect(client.unlinkedMentions("target")).resolves.toEqual([
      expect.objectContaining({ matchedText: "Target", sourceEntryId: "source" })
    ]);
    await expect(client.tags()).resolves.toEqual([
      expect.objectContaining({ key: "work", entryIds: ["source"] })
    ]);
    await expect(client.metadataSummaries(["source"])).resolves.toEqual([
      expect.objectContaining({
        entryId: "source",
        links: [{ target: "Target" }]
      })
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
    await expect(client.upsertEntry(
      markdownEntry("source", "Source.md", "[[Target]] #updated")
    )).resolves.toEqual({
      version: 2,
      entryCount: 2,
      changedMetadataEntryIds: ["source"]
    });
    await expect(client.removeEntry("target")).resolves.toEqual({
      version: 3,
      entryCount: 1,
      changedMetadataEntryIds: ["target"]
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

  it("drops a vault mutation instead of rehydrating an index payload that timed out", async () => {
    const first = new RuntimeTransport(["replace-vault"]);
    const second = new RuntimeTransport();
    const transports = [first, second];
    const client = new KnowledgeWorkerClient(() => transports.shift() as RuntimeTransport);

    await expect(client.replaceVault(
      [markdownEntry("malicious", "Private.md", "sensitive")],
      { timeoutMs: 5 }
    )).rejects.toBeInstanceOf(KnowledgeWorkerTimeoutError);

    expect(first.terminated).toBe(true);
    expect(second.received).toEqual([]);
    await expect(client.search("sensitive")).resolves.toEqual([]);
    await client.dispose();
  });

  it("rehydrates only the last acknowledged index after an upsert times out", async () => {
    const first = new RuntimeTransport(["upsert-entry"]);
    const second = new RuntimeTransport();
    const transports = [first, second];
    const client = new KnowledgeWorkerClient(() => transports.shift() as RuntimeTransport);
    await client.replaceVault([markdownEntry("base", "Base.md", "stable")]);

    await expect(client.upsertEntry(
      markdownEntry("unacknowledged", "Private.md", "sensitive"),
      { timeoutMs: 5 }
    )).rejects.toBeInstanceOf(KnowledgeWorkerTimeoutError);

    expect(second.received[0]).toMatchObject({
      type: "replace-vault",
      entries: [expect.objectContaining({ id: "base" })]
    });
    expect(JSON.stringify(second.received[0])).not.toContain("sensitive");
    await expect(client.search("stable")).resolves.toEqual(["base"]);
    await expect(client.search("sensitive")).resolves.toEqual([]);
    await client.dispose();
  });

  it("cleans up a synchronous postMessage failure without committing the mutation", async () => {
    const transport = new ThrowingMutationTransport();
    const client = new KnowledgeWorkerClient(() => transport);
    await client.replaceVault([markdownEntry("base", "Base.md", "stable")]);

    await expect(client.upsertEntry(
      markdownEntry("unacknowledged", "Private.md", "sensitive")
    )).rejects.toBeInstanceOf(KnowledgeWorkerError);
    await expect(client.search("stable")).resolves.toEqual(["base"]);
    await expect(client.search("sensitive")).resolves.toEqual([]);
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
