import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeWorkerRuntime } from "../knowledge/workerRuntime";
import type { KnowledgeWorkerRequest, KnowledgeWorkerResponse } from "../knowledge/workerProtocol";
import type { VaultIndexEntry } from "../knowledge/types";
import { useWikiKnowledge } from "./useWikiKnowledge";

const instances: TestWorker[] = [];
class TestWorker {
  onmessage: ((event: MessageEvent<KnowledgeWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  received: KnowledgeWorkerRequest[] = [];
  holdMutations = false;
  heldMutations: KnowledgeWorkerRequest[] = [];
  private runtime = createKnowledgeWorkerRuntime({ postMessage: (data) => {
    queueMicrotask(() => { if (!this.terminated) this.onmessage?.(new MessageEvent("message", { data })); });
  } });
  constructor() { instances.push(this); }
  postMessage(request: KnowledgeWorkerRequest) {
    if (this.terminated) return;
    this.received.push(request);
    if (this.holdMutations && ["replace-vault", "upsert-entry", "remove-entry"].includes(request.type)) {
      this.heldMutations.push(request);
      return;
    }
    this.runtime.handleRequest(request);
  }
  flushMutation() {
    const request = this.heldMutations.shift();
    if (request && !this.terminated) this.runtime.handleRequest(request);
  }
  terminate() { this.terminated = true; }
}
const entries: VaultIndexEntry[] = [
  { id: "one", path: "첫 메모.md", kind: "markdown", content: "## 요약\n[[둘째 메모]]" },
  { id: "two", path: "둘째 메모.md", kind: "markdown", content: "알림 /secret.*/" }
];

beforeEach(() => { instances.length = 0; vi.stubGlobal("Worker", TestWorker); });
afterEach(() => vi.unstubAllGlobals());

describe("useWikiKnowledge worker lifecycle", () => {
  it("shares one authorized index between stacked panels and the expanded global graph", async () => {
    const { result, rerender } = renderHook(({ ids, scope }) => useWikiKnowledge(entries, "two", "", ids, scope), {
      initialProps: { ids: ["one", "two", "not-provided"], scope: "local" as "local" | "global" }
    });
    await waitFor(() => expect(result.current.pages.get("one")?.headings[0]?.text).toBe("요약"));
    expect([...result.current.pages.keys()]).toEqual(["two", "one"]);
    expect(result.current.pages.get("two")?.backlinks[0]?.sourceEntryId).toBe("one");
    rerender({ ids: ["one", "two"], scope: "global" });
    await waitFor(() => expect(result.current.active?.graph.scope).toBe("global"));
    expect(result.current.active?.graph.nodes.map((node) => node.entryId).sort()).toEqual(["one", "two"]);
    expect(instances).toHaveLength(1);
    expect(instances[0].received.filter((request) => request.type === "replace-vault")).toHaveLength(1);
    expect(instances[0].received.filter((request) => request.type === "metadata-summaries").every((request) => request.type === "metadata-summaries" && !request.entryIds?.includes("not-provided"))).toBe(true);
  });

  it("reuses one index while searching and navigating, and terminates it on unmount", async () => {
    const { result, rerender, unmount } = renderHook(({ id, query }) => useWikiKnowledge(entries, id, query), { initialProps: { id: "one", query: "" } });
    await waitFor(() => expect(result.current.active?.headings[0]?.text).toBe("요약"));
    const worker = instances[0];
    const graphRequests = worker.received.filter((request) => request.type === "graph-snapshot").length;
    rerender({ id: "one", query: "알림" });
    await waitFor(() => expect(result.current.resultIds).toEqual(["two"]));
    expect(worker.received.filter((request) => request.type === "graph-snapshot")).toHaveLength(graphRequests);
    rerender({ id: "two", query: "/secret.*/" });
    await waitFor(() => expect(result.current.active?.backlinks[0]?.sourceEntryId).toBe("one"));
    await waitFor(() => expect(result.current.resultIds).toEqual(["two"]));
    expect(worker.received.filter((request) => request.type === "replace-vault")).toHaveLength(1);
    unmount();
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });

  it("removes vanished entries without exposing old search results", async () => {
    const { result, rerender, unmount } = renderHook(({ data }) => useWikiKnowledge(data, "one", "알림"), { initialProps: { data: entries } });
    await waitFor(() => expect(result.current.resultIds).toEqual(["two"]));
    rerender({ data: [] });
    expect(result.current.resultIds).toEqual([]);
    expect(result.current.active).toBeNull();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(instances).toHaveLength(1);
    expect(instances[0].received.filter((request) => request.type === "remove-entry")).toHaveLength(2);
    expect(result.current.resultIds).toEqual([]);
    unmount();
    expect(instances[0].terminated).toBe(true);
  });

  it("upserts only one changed body while retaining the existing worker and index", async () => {
    const { result, rerender } = renderHook(({ data }) => useWikiKnowledge(data, "one", "변경된"), { initialProps: { data: entries } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const worker = instances[0];
    const changed = entries.map((entry) => entry.id === "one" ? { ...entry, content: "## 변경된 제목\n변경된 본문" } : entry);
    rerender({ data: changed });
    await waitFor(() => expect(result.current.active?.headings[0]?.text).toBe("변경된 제목"));
    await waitFor(() => expect(result.current.resultIds).toEqual(["one"]));
    expect(instances).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    expect(worker.received.filter((request) => request.type === "replace-vault")).toHaveLength(1);
    const upserts = worker.received.filter((request) => request.type === "upsert-entry");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ entry: { id: "one", content: "## 변경된 제목\n변경된 본문" } });
  });

  it("does no index or query work for cloned entries with unchanged projection values", async () => {
    const { result, rerender } = renderHook(({ data }) => useWikiKnowledge(data, "one", "알림"), { initialProps: { data: entries } });
    await waitFor(() => expect(result.current.resultIds).toEqual(["two"]));
    await waitFor(() => expect(result.current.active).not.toBeNull());
    const active = result.current.active;
    const worker = instances[0];
    const count = worker.received.length;
    rerender({ data: entries.map((entry) => ({ ...entry })) });
    await act(async () => undefined);
    expect(instances).toHaveLength(1);
    expect(worker.received).toHaveLength(count);
    expect(result.current.active).toBe(active);
    expect(result.current.resultIds).toEqual(["two"]);
  });

  it("uses a single replacement for bulk updates instead of hundreds of upserts", async () => {
    const many = Array.from({ length: 250 }, (_, index): VaultIndexEntry => ({ id: `n${index}`, kind: "markdown", path: `노트${index}.md`, content: "이전 본문" }));
    const { result, rerender } = renderHook(({ data }) => useWikiKnowledge(data, "n0", ""), { initialProps: { data: many } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ data: many.map((entry) => ({ ...entry, content: "## 새 제목\n새 본문" })) });
    await waitFor(() => expect(result.current.active?.headings[0]?.text).toBe("새 제목"));
    expect(instances).toHaveLength(1);
    expect(instances[0].received.filter((request) => request.type === "replace-vault")).toHaveLength(2);
    expect(instances[0].received.filter((request) => request.type === "upsert-entry")).toHaveLength(0);
  });

  it.each([false, true])("serializes rapid updates and never publishes a superseded projection (revert=%s)", async (revert) => {
    const { result, rerender } = renderHook(({ data }) => useWikiKnowledge(data, "one", "최신"), { initialProps: { data: entries } });
    await waitFor(() => expect(result.current.active?.headings[0]?.text).toBe("요약"));
    const worker = instances[0];
    worker.holdMutations = true;
    rerender({ data: entries.map((entry) => entry.id === "one" ? { ...entry, content: "## 중간 제목\n최신" } : entry) });
    await waitFor(() => expect(worker.heldMutations).toHaveLength(1));
    const latest = revert ? entries : entries.map((entry) => entry.id === "one" ? { ...entry, content: "## 최종 제목\n최신" } : entry);
    rerender({ data: latest });
    expect(result.current.ready).toBe(false);
    expect(result.current.active).toBeNull();
    expect(result.current.resultIds).toEqual([]);
    await act(async () => worker.flushMutation());
    await waitFor(() => expect(worker.heldMutations).toHaveLength(1));
    expect(result.current.active).toBeNull();
    expect(result.current.resultIds).toEqual([]);
    await act(async () => worker.flushMutation());
    await waitFor(() => expect(result.current.active?.headings[0]?.text).toBe(revert ? "요약" : "최종 제목"));
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.resultIds).toEqual(revert ? [] : ["one"]);
    expect(instances).toHaveLength(1);
    expect(worker.received.filter((request) => request.type === "upsert-entry")).toHaveLength(2);
    expect(worker.received.filter((request) => request.type === "replace-vault")).toHaveLength(1);
  });

  it("disposes immediately on unmount while a mutation is still pending", async () => {
    const { result, rerender, unmount } = renderHook(({ data }) => useWikiKnowledge(data, "one", ""), { initialProps: { data: entries } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const worker = instances[0];
    worker.holdMutations = true;
    rerender({ data: entries.map((entry) => ({ ...entry, content: "비밀 변경" })) });
    await waitFor(() => expect(worker.heldMutations).toHaveLength(1));
    unmount();
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
    await act(async () => worker.flushMutation());
    expect(worker.received.filter((request) => request.type === "upsert-entry")).toHaveLength(1);
  });

  it("keeps the workerless fallback incremental and literal-only", async () => {
    vi.stubGlobal("Worker", undefined);
    const { result, rerender } = renderHook(({ data, query }) => useWikiKnowledge(data, "one", query), { initialProps: { data: entries, query: "/secret.*/" } });
    await waitFor(() => expect(result.current.resultIds).toEqual(["two"]));
    rerender({ data: entries.map((entry) => entry.id === "one" ? { ...entry, content: "## 갱신\n/secret.*/" } : entry), query: "/secret.*/" });
    await waitFor(() => expect(result.current.active?.headings[0]?.text).toBe("갱신"));
    await waitFor(() => expect(result.current.resultIds).toEqual(["one", "two"]));
    rerender({ data: entries, query: "/secret.+/" });
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.resultIds).toEqual([]);
    expect(instances).toHaveLength(0);
  });
});
