import { describe, expect, it } from "vitest";
import {
  isValidObsidianTag,
  parseMarkdownInline,
  parseWikiLinkTarget,
  stripObsidianComments,
  tokenizeMarkdown
} from "./parser";

describe("Markdown parser", () => {
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
});
