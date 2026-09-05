import { describe, expect, it } from "vitest";
import { buildKnowledgeIndex } from "../knowledge/knowledgeIndex";
import { matchesVaultSearchQuery } from "../knowledge/query";
import type { GraphSnapshot, VaultIndexEntry } from "../knowledge/types";
import { appendWikiPanel, wikiEntries, wikiFolderPaths, wikiGraphData, wikiLiteralSearchQuery, wikiOutline, wikiPanelIds, wikiSearchQuery, wikiTreeRows, WIKI_GRAPH_NODE_LIMIT } from "./wikiModel";

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

  it("uses only supplied readable folder fields and terminates cyclic or missing parents", () => {
    const folders = [{ id: "root", displayName: "공개 자료", parentId: null }, { id: "sub", displayName: "개념", parentId: "root" }];
    expect(wikiEntries([{ id: "n", title: "관측", body: "본문", folderId: "sub", contentFormat: "markdown-v1", entryKind: "markdown" }], folders)[0].path).toBe("공개 자료/개념/관측.md");
    expect(wikiFolderPaths([{ id: "only", displayName: "공개 이름", parentId: "unpublished" }]).get("only")).toBe("공개 이름");
    expect(wikiFolderPaths([{ id: "a", displayName: "A", parentId: "b" }, { id: "b", displayName: "B", parentId: "a" }]).size).toBe(2);
  });

  it("bounds stacked panels to six and never accepts unprovided ids from the URL", () => {
    const allowed = new Set(["a", "b", "c", "d", "e", "f", "g"]);
    expect(wikiPanelIds("a", ["b", "c", "d", "e", "f", "g"], allowed)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(wikiPanelIds("a", ["b", "foreign", "c"], allowed)).toEqual(["a", "b"]);
    expect(wikiPanelIds("foreign", ["a"], allowed)).toEqual([]);
    expect(appendWikiPanel(["a", "b", "c"], "a", "d")).toEqual(["a", "d"]);
    expect(appendWikiPanel(["a", "b", "c"], "c", "a")).toEqual(["a"]);
    expect(appendWikiPanel(["a", "b", "c", "d", "e", "f"], "f", "g")).toEqual(["a", "b", "c", "d", "e", "g"]);
  });

  it("keeps heading hierarchy across skipped levels without inventing empty parents", () => {
    const headings = [{ text: "개념", level: 2, slug: "개념", line: 1 }, { text: "예시", level: 4, slug: "예시", line: 3 }, { text: "운영", level: 2, slug: "운영", line: 5 }];
    const outline = wikiOutline(headings);
    expect(outline.map((node) => node.heading.text)).toEqual(["개념", "운영"]);
    expect(outline[0].children[0].heading.text).toBe("예시");
    expect(outline[1].children).toEqual([]);
  });
});
