import { describe, expect, it } from "vitest";
import { fuzzyScore, rankFuzzyItems } from "./fuzzy";

describe("fuzzy navigation ranking", () => {
  it("prefers exact and prefix matches over subsequences", () => {
    const items = ["Project graph", "Graph", "Knowledge graph"];
    const ranked = rankFuzzyItems(items, "graph", (item) => item);

    expect(ranked.map(({ item }) => item)).toEqual([
      "Graph",
      "Project graph",
      "Knowledge graph"
    ]);
  });

  it("matches multiple Unicode-normalized tokens and rejects missing tokens", () => {
    expect(fuzzyScore("프로젝트/QuickMemo 그래프", "quick 그래")).not.toBeNull();
    expect(fuzzyScore("ＡＢＣ 노트", "abc")).not.toBeNull();
    expect(fuzzyScore("프로젝트 노트", "없는 태그")).toBeNull();
  });

  it("preserves caller order when the query is empty", () => {
    const items = [{ id: "recent" }, { id: "older" }];
    expect(rankFuzzyItems(items, "   ", (item) => item.id).map(({ item }) => item.id))
      .toEqual(["recent", "older"]);
  });
});
