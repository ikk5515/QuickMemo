import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_GRAPH_SETTINGS, buildGraphSnapshot } from "./graph";
import { buildKnowledgeIndex } from "./knowledgeIndex";
import type { GraphViewSettings, VaultIndexEntry } from "./types";

function markdownEntry(id: string, content: string): VaultIndexEntry {
  return { id, path: `${id}.md`, kind: "markdown", content };
}

function localSettings(
  overrides: Partial<Extract<GraphViewSettings, { scope: "local" }>> = {}
): Extract<GraphViewSettings, { scope: "local" }> {
  return {
    ...DEFAULT_LOCAL_GRAPH_SETTINGS,
    ...overrides,
    common: {
      ...DEFAULT_LOCAL_GRAPH_SETTINGS.common,
      ...overrides.common
    },
    scope: "local"
  };
}

describe("local graph adjacency traversal", () => {
  it("preserves global link order when incoming and outgoing adjacency compete to discover a neighbor", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("X", "[[A]] [[Z]]"),
      markdownEntry("A", "[[B]] [[Missing]] [[A]]"),
      markdownEntry("B", "[[Z]]"),
      markdownEntry("Z", "")
    ]);
    const snapshot = buildGraphSnapshot(index, localSettings({
      root: { entryId: "A" },
      depth: 2,
      incoming: true,
      outgoing: true,
      neighborLinks: false
    }));

    expect(snapshot.nodes.map((node) => node.id)).toEqual([
      "entry:A",
      "entry:B",
      "entry:X",
      "entry:Z",
      "unresolved:missing"
    ]);
    expect(snapshot.edges.map((edge) => edge.id)).toEqual([
      "link:entry:A->entry:A",
      "link:entry:A->entry:B",
      "link:entry:A->unresolved:missing",
      "link:entry:X->entry:A",
      "link:entry:X->entry:Z"
    ]);
  });

  it("keeps direction, unresolved filtering, and neighborLinks semantics with adjacency traversal", () => {
    const index = buildKnowledgeIndex([
      markdownEntry("X", "[[A]] [[Z]]"),
      markdownEntry("A", "[[B]] [[Missing]]"),
      markdownEntry("B", "[[Z]]"),
      markdownEntry("Z", "")
    ]);

    const outgoingOnly = buildGraphSnapshot(index, localSettings({
      root: { entryId: "A" },
      depth: 2,
      incoming: false,
      outgoing: true,
      neighborLinks: false
    }));
    expect(outgoingOnly.nodes.map((node) => node.id)).toEqual([
      "entry:A",
      "entry:B",
      "entry:Z",
      "unresolved:missing"
    ]);
    expect(outgoingOnly.edges.map((edge) => edge.id)).toEqual([
      "link:entry:A->entry:B",
      "link:entry:A->unresolved:missing",
      "link:entry:B->entry:Z"
    ]);

    const incomingOnly = buildGraphSnapshot(index, localSettings({
      root: { entryId: "A" },
      depth: 2,
      incoming: true,
      outgoing: false
    }));
    expect(incomingOnly.nodes.map((node) => node.id)).toEqual(["entry:A", "entry:X"]);
    expect(incomingOnly.edges.map((edge) => edge.id)).toEqual(["link:entry:X->entry:A"]);

    const existingOnly = buildGraphSnapshot(index, localSettings({
      root: { entryId: "A" },
      depth: 2,
      incoming: false,
      outgoing: true,
      common: {
        ...DEFAULT_LOCAL_GRAPH_SETTINGS.common,
        existingFilesOnly: true
      }
    }));
    expect(existingOnly.nodes.some((node) => node.kind === "unresolved")).toBe(false);
    expect(existingOnly.edges.some((edge) => edge.target.startsWith("unresolved:"))).toBe(false);

    const withNeighbors = buildGraphSnapshot(index, localSettings({
      root: { entryId: "A" },
      depth: 2,
      incoming: true,
      outgoing: true,
      neighborLinks: true
    }));
    expect(withNeighbors.edges.map((edge) => edge.id)).toContain("link:entry:B->entry:Z");
  });
});
