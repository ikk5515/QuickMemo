import { describe, expect, it } from "vitest";
import { buildKnowledgeIndex } from "../knowledge";
import { MAX_SEARCH_INDEX_LINKS, createSearchIndexMarkdown } from "./moc";

describe("createSearchIndexMarkdown", () => {
  it("creates a deterministic Markdown search index with internal relative links", () => {
    const result = createSearchIndexMarkdown({
      candidates: [
        { path: "Projects/Alpha note.md", title: "Alpha [초안]" },
        { path: "Inbox/생각.md", title: "생각" },
        { path: "projects/ALPHA NOTE.md", title: "중복" }
      ],
      generatedAt: new Date("2026-08-22T00:00:00.000Z"),
      query: 'tag:project AND status = "active"',
      title: "프로젝트 인덱스"
    });

    expect(result).toMatchObject({ included: 2, omitted: 0 });
    expect(result.source).toContain("type: search-index");
    expect(result.source).toContain("  - search-index");
    expect(result.source).toContain('source-query: "tag:project AND status = \\"active\\""');
    expect(result.source).toContain("- [생각](<Inbox/%EC%83%9D%EA%B0%81.md>)");
    expect(result.source).toContain("- [Alpha \\[초안\\]](<Projects/Alpha%20note.md>)");
  });

  it("bounds link count and reports omitted results without silently implying completeness", () => {
    const result = createSearchIndexMarkdown({
      candidates: Array.from({ length: MAX_SEARCH_INDEX_LINKS + 7 }, (_, index) => ({
        path: `Notes/${index}.md`,
        title: `노트 ${index}`
      })),
      title: "전체 검색 결과 인덱스"
    });

    expect(result.included).toBe(MAX_SEARCH_INDEX_LINKS);
    expect(result.omitted).toBe(7);
    expect(result.source).toContain("안전한 검색 결과 인덱스 상한으로 7개 링크를 생략했습니다.");
  });

  it("resolves standard Markdown links relative to the index folder", () => {
    const result = createSearchIndexMarkdown({
      candidates: [
        { path: "Projects/Alpha.md", title: "Alpha" },
        { path: "Archive/Done.md", title: "Done" }
      ],
      sourceFolderPath: "Projects/Maps",
      title: "Project map"
    });

    expect(result.source).toContain("- [Alpha](<../Alpha.md>)");
    expect(result.source).toContain("- [Done](<../../Archive/Done.md>)");
    const index = buildKnowledgeIndex([
      { id: "index", path: "Projects/Maps/Project map.md", kind: "markdown", content: result.source },
      { id: "alpha", path: "Projects/Alpha.md", kind: "markdown", content: "" },
      { id: "done", path: "Archive/Done.md", kind: "markdown", content: "" }
    ]);
    expect(index.outgoingByEntryId.get("index")?.map((link) => link.targetEntryId)).toEqual([
      "done",
      "alpha"
    ]);
  });

  it("drops malformed or empty candidates and keeps control characters out of YAML", () => {
    const result = createSearchIndexMarkdown({
      candidates: [
        { path: "", title: "없음" },
        { path: "Valid.md", title: "정상" }
      ],
      query: "tag:test\u0000",
      title: ""
    });

    expect(result.included).toBe(1);
    expect(result.source).toContain("# 새 검색 결과 인덱스");
    expect(result.source).not.toContain("\u0000");
  });
});
