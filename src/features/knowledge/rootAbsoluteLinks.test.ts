import { describe, expect, it } from "vitest";
import { backlinkOccurrences, buildGraphSnapshot, buildKnowledgeIndex, DEFAULT_LOCAL_GRAPH_SETTINGS, outgoingOccurrences } from "./index";
import type { VaultIndexEntry } from "./types";

const filename = "연결 문서.md", encoded = encodeURIComponent(filename);
const entry = (id: string, path: string, content = ""): VaultIndexEntry => ({ id, path, kind: "markdown", content });

describe("explicit vault root links", () => {
  it.each(["wikilink", "markdown"])("keeps %s root targets distinct from a same-name relative note in parsing, graph and backlinks", (syntax) => {
    const rootLink = syntax === "wikilink" ? `[[/${encoded}|root]]` : `[root](/${encoded})`;
    const relativeLink = syntax === "wikilink" ? `[[${encoded}|relative]]` : `[relative](${encoded})`;
    const index = buildKnowledgeIndex([entry("source", "Folder/Source.md", `${rootLink}\n\n${relativeLink}`),
      entry("root", filename), entry("relative", `Folder/${filename}`)]);
    expect(outgoingOccurrences(index, "source").map(({ target, targetEntryId, candidateEntryIds }) => ({ target, targetEntryId, candidateEntryIds }))).toEqual([
      { target: `/${encoded}`, targetEntryId: "root", candidateEntryIds: ["root"] },
      { target: encoded, targetEntryId: "relative", candidateEntryIds: ["relative"] }
    ]);
    expect(backlinkOccurrences(index, "root")).toEqual([expect.objectContaining({ sourceEntryId: "source", target: `/${encoded}` })]);
    expect(backlinkOccurrences(index, "relative")).toEqual([expect.objectContaining({ sourceEntryId: "source", target: encoded })]);
    const graph = buildGraphSnapshot(index, DEFAULT_LOCAL_GRAPH_SETTINGS, { activeEntryId: "source" });
    expect(graph.edges.map(({ source, target }) => [source, target]).sort()).toEqual([["entry:source", "entry:relative"], ["entry:source", "entry:root"]]);
  });

  it("never substitutes a relative file when an explicitly addressed root file is absent", () => {
    const index = buildKnowledgeIndex([entry("source", "Folder/Source.md", `[[/${encoded}]]`), entry("relative", `Folder/${filename}`)]);
    expect(outgoingOccurrences(index, "source")[0]).toMatchObject({ status: "unresolved", candidateEntryIds: [] });
    expect(backlinkOccurrences(index, "relative")).toHaveLength(0);
  });
});
