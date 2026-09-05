import { describe, expect, it } from "vitest";
import {
  isValidObsidianTag,
  parseMarkdownInline,
  parseWikiLinkTarget,
  stripObsidianComments,
  tokenizeMarkdown
} from "./parser";

describe("Markdown parser", () => {
  it("keeps block identifiers as metadata on paragraphs, list items and structured blocks", () => {
    const source = [
      "문단 ^paragraph-1",
      "",
      "- 첫 항목 ^item-1",
      "- 다음 항목",
      "",
      "^whole-list",
      "",
      "> 인용문",
      "",
      "^quote-1",
      "",
      "`문자 ^code-1`",
      "",
      "\\^escaped",
      "",
      "^허용안됨"
    ].join("\n");
    const document = tokenizeMarkdown(source);
    expect(document.blocks).toMatchObject([
      { type: "paragraph", blockId: "paragraph-1", children: [{ type: "text", value: "문단" }] },
      { type: "list", blockId: "whole-list", items: [{ blockId: "item-1", children: [{ type: "text", value: "첫 항목" }] }, { children: [{ type: "text", value: "다음 항목" }] }] },
      { type: "quote", blockId: "quote-1" },
      { type: "paragraph", children: [{ type: "code", value: "문자 ^code-1" }] },
      { type: "paragraph", children: [{ type: "text", value: "^escaped" }] },
      { type: "paragraph", children: [{ type: "text", value: "^허용안됨" }] }
    ]);
    expect(source).toContain("^paragraph-1");
  });

  it("recognizes Setext headings without confusing standalone thematic breaks or list items", () => {
    expect(tokenizeMarkdown("큰 제목\n===\n\n작은 제목\n---\n\n---\n\n- 항목").blocks).toMatchObject([
      { type: "heading", level: 1, children: [{ type: "text", value: "큰 제목" }] },
      { type: "heading", level: 2, children: [{ type: "text", value: "작은 제목" }] },
      { type: "thematic-break" },
      { type: "list" }
    ]);
  });

  it("preserves Obsidian highlights with nested formatting while keeping code literal", () => {
    expect(parseMarkdownInline("==중요 **강조** [[Note]]== `==원문==` \\==문자\\==")).toEqual([
      {
        type: "highlight",
        children: [
          { type: "text", value: "중요 " },
          { type: "strong", children: [{ type: "text", value: "강조" }] },
          { type: "text", value: " " },
          expect.objectContaining({ type: "wikilink", path: "Note" })
        ]
      },
      { type: "text", value: " " },
      { type: "code", value: "==원문==" },
      { type: "text", value: " ==문자==" }
    ]);
  });

  it("keeps nested lists, task states and continuation blocks attached to their parent item", () => {
    const document = tokenizeMarkdown([
      "- [ ] 프로젝트",
      "  - [x] 조사 [[Research]]",
      "    1. 자료[^source]",
      "    2. 요약",
      "",
      "  이어지는 **문단**",
      "- 다음 프로젝트",
      "",
      "[^source]: ==출처=="
    ].join("\n"));
    expect(document.blocks).toMatchObject([{
      type: "list",
      items: [
        {
          checked: false,
          children: [{ type: "text", value: "프로젝트" }],
          blocks: [
            {
              type: "list",
              items: [{ checked: true, blocks: [{ type: "list", ordered: true, items: [
                { children: [expect.anything(), expect.objectContaining({ type: "footnote-reference", number: 1 })] },
                { children: [{ type: "text", value: "요약" }] }
              ] }] }]
            },
            { type: "paragraph", children: expect.arrayContaining([{ type: "strong", children: [{ type: "text", value: "문단" }] }]) }
          ]
        },
        { children: [{ type: "text", value: "다음 프로젝트" }] }
      ]
    }]);
    expect(document.footnotes).toHaveLength(1);
  });

  it("retains tab-indented child lists and fenced code without flattening their source", () => {
    const document = tokenizeMarkdown("- 상위\n\t- 하위\n\n  ```md\n  ==원문== [[No link]]\n  ```\n- 끝");
    expect(document.blocks).toMatchObject([{
      type: "list", items: [
        { blocks: [
          { type: "list", items: [{ children: [{ type: "text", value: "하위" }] }] },
          { type: "code-block", value: "==원문== [[No link]]" }
        ] },
        { children: [{ type: "text", value: "끝" }] }
      ]
    }]);
  });

  it("bounds deeply nested list parsing and retains the remaining literal source", () => {
    const source = Array.from({ length: 200 }, (_, index) => `${"  ".repeat(index)}- 항목 ${index}`).join("\n");
    expect(() => tokenizeMarkdown(source)).not.toThrow();
    expect(JSON.stringify(tokenizeMarkdown(source))).toContain("항목 199");
  });

  it("distinguishes CommonMark hard breaks from soft line endings", () => {
    expect(parseMarkdownInline("첫 줄\\\n둘째 줄\n셋째 줄")).toEqual([
      { type: "text", value: "첫 줄" },
      { type: "line-break" },
      { type: "text", value: "둘째 줄\n셋째 줄" }
    ]);
    expect(parseMarkdownInline("첫 줄  \n둘째 줄")).toEqual([
      { type: "text", value: "첫 줄" },
      { type: "line-break" },
      { type: "text", value: "둘째 줄" }
    ]);
  });

  it("keeps wiki target paths separate from display aliases and subpaths", () => {
    expect(parseWikiLinkTarget("Projects/QuickMemo#보안 설계|암호화 메모"))
      .toEqual({
        target: "Projects/QuickMemo#보안 설계",
        path: "Projects/QuickMemo",
        subpath: "#보안 설계",
        display: "암호화 메모"
      });
    expect(parseWikiLinkTarget("Folder/Note.md#^block-id"))
      .toEqual({
        target: "Folder/Note.md#^block-id",
        path: "Folder/Note.md",
        subpath: "#^block-id",
        display: "Note › block-id"
      });
  });

  it("recognizes unicode and nested tags but not numeric-only or malformed tags", () => {
    expect(isValidObsidianTag("#프로젝트/퀵메모-2")).toBe(true);
    expect(isValidObsidianTag("#music/🎹")).toBe(true);
    expect(isValidObsidianTag("#1234")).toBe(false);
    expect(isValidObsidianTag("#bad tag")).toBe(false);
    expect(isValidObsidianTag("#bad//tag")).toBe(false);
  });

  it("does not parse tags or links inside inline and fenced code", () => {
    const inline = parseMarkdownInline("#real `#not-tag [[Not a link]]` [[Real]]");
    expect(inline.filter((token) => token.type === "tag")).toHaveLength(1);
    expect(inline.filter((token) => token.type === "wikilink")).toHaveLength(1);
    expect(inline.find((token) => token.type === "code")).toMatchObject({
      value: "#not-tag [[Not a link]]"
    });

    const document = tokenizeMarkdown("```ts\n\tconst raw = '[[No edge]] #no-tag';\n```\n\n[[Edge]] #tag");
    expect(document.blocks[0]).toMatchObject({
      type: "code-block",
      language: "ts",
      value: "\tconst raw = '[[No edge]] #no-tag';"
    });
  });

  it("tokenizes headings, tasks, lists, and tables without converting raw HTML", () => {
    const document = tokenizeMarkdown([
      "# 제목",
      "",
      "- [x] 완료 [[노트]]",
      "- [ ] 남음 #업무",
      "",
      "| 이름 | 상태 |",
      "| :--- | ---: |",
      "| QuickMemo | **진행 중** |",
      "",
      "<img src=x onerror=alert(1)>"
    ].join("\n"));

    expect(document.blocks.map((block) => block.type)).toEqual([
      "heading",
      "list",
      "table",
      "paragraph"
    ]);
    expect(document.blocks[1]).toMatchObject({
      type: "list",
      items: [{ checked: true }, { checked: false }]
    });
    expect(document.blocks[2]).toMatchObject({
      type: "table",
      alignments: ["left", "right"]
    });
    expect(document.blocks[3]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "<img src=x onerror=alert(1)>" }]
    });
  });

  it("hides Obsidian comments but preserves frontmatter and code verbatim", () => {
    const source = [
      "---",
      "literal: '%%frontmatter%%'",
      "---",
      "보임 %%숨김 [[No edge]] #no-tag%% 끝",
      "`%% inline code %%`",
      "앞 %%",
      "# 숨은 제목",
      "%% 뒤",
      "```md",
      "%% fenced code %%",
      "```"
    ].join("\n");

    const stripped = stripObsidianComments(source);
    expect(stripped).toContain("literal: '%%frontmatter%%'");
    expect(stripped).toContain("보임  끝");
    expect(stripped).toContain("`%% inline code %%`");
    expect(stripped).toContain("앞 \n\n 뒤");
    expect(stripped).toContain("%% fenced code %%");

    const document = tokenizeMarkdown(source);
    expect(document.blocks.some((block) => block.type === "heading")).toBe(false);
    expect(document.blocks.find((block) => block.type === "code-block")).toMatchObject({
      value: "%% fenced code %%"
    });
  });

  it("parses nested and foldable callouts as structured blocks", () => {
    const document = tokenizeMarkdown([
      "> [!warning]- **주의**",
      "> 첫 문단",
      "> > [!tip]+ 힌트",
      "> > [[연결 노트]]"
    ].join("\n"));

    expect(document.blocks[0]).toMatchObject({
      type: "callout",
      calloutType: "warning",
      foldable: true,
      open: false,
      blocks: [
        { type: "paragraph" },
        { type: "callout", calloutType: "tip", foldable: true, open: true }
      ]
    });
  });

  it("resolves repeated and inline footnotes in first-reference order", () => {
    const document = tokenizeMarkdown([
      "본문[^source] 다시[^source] 그리고 ^[즉석 **각주**]. 미해결[^missing]",
      "",
      "[^source]: 첫 줄",
      "    둘째 줄 [[Note]]"
    ].join("\n"));

    expect(document.footnotes).toHaveLength(2);
    expect(document.footnotes[0]).toMatchObject({
      label: "source",
      number: 1,
      referenceCount: 2
    });
    expect(document.footnotes[1]).toMatchObject({
      number: 2,
      referenceCount: 1
    });
    expect(document.footnotes[0].blocks[0]).toMatchObject({
      type: "paragraph"
    });

    const paragraph = document.blocks[0];
    expect(paragraph.type).toBe("paragraph");
    if (paragraph.type !== "paragraph") {
      return;
    }
    const references = paragraph.children.filter((token) => token.type === "footnote-reference");
    expect(references.map((token) => token.number)).toEqual([1, 1, 2, null]);
    expect(references.map((token) => token.referenceIndex)).toEqual([1, 2, 1, null]);
  });

  it("parses inline and display math without consuming currency or unclosed fences", () => {
    const document = tokenizeMarkdown([
      "오일러 항등식 $e^{i\\pi}+1=0$ 및 가격 $5",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx",
      "$$"
    ].join("\n"));

    expect(document.blocks[0]).toMatchObject({
      type: "paragraph",
      children: expect.arrayContaining([
        { type: "math", value: "e^{i\\pi}+1=0" }
      ])
    });
    expect(document.blocks[1]).toEqual({
      type: "math-block",
      value: "\\int_0^1 x^2 \\, dx"
    });
  });

  it("marks wiki and Markdown image syntax as embeds without loading a resource", () => {
    const tokens = parseMarkdownInline(
      "![[image.png|미리보기]] ![원격](https://example.com/image.png) ![차단](data:text/html,bad)"
    );

    expect(tokens.filter((token) => token.type === "wikilink")).toMatchObject([
      { embed: true, path: "image.png", display: "미리보기" }
    ]);
    expect(tokens.filter((token) => token.type === "link")).toMatchObject([
      { embed: true, safe: true, external: true },
      { embed: true, safe: false, external: true }
    ]);
  });

  it("bounds deeply nested quote parsing instead of overflowing the call stack", () => {
    const deeplyNested = `${"> ".repeat(10_000)}보존할 내용`;

    expect(() => tokenizeMarkdown(deeplyNested)).not.toThrow();
    expect(JSON.stringify(tokenizeMarkdown(deeplyNested))).toContain("보존할 내용");
  });

  it("bounds adversarial unmatched inline syntax at the maximum note size", () => {
    const startedAt = performance.now();
    const unmatchedBrackets = tokenizeMarkdown("[".repeat(500_000));
    const unmatchedCodeRun = tokenizeMarkdown("`".repeat(500_000));
    const elapsedMs = performance.now() - startedAt;

    expect(unmatchedBrackets.blocks).toHaveLength(1);
    expect(unmatchedCodeRun.blocks).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
