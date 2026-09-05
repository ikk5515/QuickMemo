import { describe, expect, it } from "vitest";
import { buildKnowledgeIndex } from "../knowledge/knowledgeIndex";
import { matchesVaultSearchQuery } from "../knowledge/query";
import type { GraphSnapshot, VaultIndexEntry } from "../knowledge/types";
import { wikiGraphData, wikiLiteralSearchQuery, wikiSearchQuery, wikiTreeRows, WIKI_GRAPH_NODE_LIMIT } from "./wikiModel";

describe("private wiki projection", () => {
  const entries: VaultIndexEntry[] = [
    { id: "aws", path: "개발/클라우드/AWS.md", kind: "markdown", content: "알림 observability" },
    { id: "index", path: "개발/소개.md", kind: "markdown", content: "[[클라우드/AWS]]" },
    { id: "home", path: "시작.md", kind: "markdown", content: "검색 /secret.*/" }
  ];

  it("flattens nested folders and hides only the collapsed branch", () => {
    expect(wikiTreeRows(entries, new Set()).map((row) => row.id)).toEqual(["개발", "개발/클라우드", "aws", "index", "home"]);
    expect(wikiTreeRows(entries, new Set(["개발/클라우드"])).map((row) => row.id)).toEqual(["개발", "개발/클라우드", "index", "home"]);
    expect(wikiTreeRows(entries, new Set(["개발"])).map((row) => row.id)).toEqual(["개발", "home"]);
  });

  it("uses the existing search engine for literal terms without executing regex syntax", () => {
    const index = buildKnowledgeIndex(entries);
    const matching = (query: string) => index.entries.filter((entry) => matchesVaultSearchQuery(
      wikiLiteralSearchQuery(query), entry, index.metadataByEntryId.get(entry.id)!, { allowRegex: false }
    )).map((entry) => entry.id);
    expect(matching("알림 observability")).toEqual(["aws"]);
    expect(matching("/secret.*/")).toEqual(["home"]);
    expect(matching("/secret.+/")).toEqual([]);
    const home = index.entries.find((entry) => entry.id === "home")!;
    expect(matchesVaultSearchQuery(wikiSearchQuery("/secret.*/"), home, index.metadataByEntryId.get(home.id)!)).toBe(true);
    expect(matchesVaultSearchQuery(wikiSearchQuery("/secret.+/"), home, index.metadataByEntryId.get(home.id)!)).toBe(false);
  });

  it("keeps the active root while bounding dense local graphs and removing dangling edges", () => {
    const snapshot: GraphSnapshot = {
      scope: "local", rootNodeId: "entry:root",
      nodes: Array.from({ length: 500 }, (_, index) => ({ id: `entry:${index}`, kind: "file", label: `${index}`, incomingReferenceCount: index })),
      edges: [{ id: "dangling", kind: "internal-link", source: "entry:0", target: "entry:1", occurrenceCount: 1, occurrenceLines: [1] }]
    };
    snapshot.nodes.push({ id: "entry:root", kind: "file", label: "루트", incomingReferenceCount: 0 });
    const graph = wikiGraphData(snapshot);
    expect(graph.nodes).toHaveLength(WIKI_GRAPH_NODE_LIMIT);
    expect(graph.nodes[0].id).toBe("entry:root");
    expect(graph.edges).toEqual([]);
  });
});
