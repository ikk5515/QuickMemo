import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMarkdownInline } from "./parser";
import { previewLegacyHtmlToMarkdown } from "./legacyHtml";

afterEach(() => vi.restoreAllMocks());

describe("legacy HTML conversion preview", () => {
  it("creates a non-mutating Markdown preview and reports removed active content", () => {
    const source = [
      "<h1>기존 노트</h1>",
      "<p><strong>중요</strong> <a href=\"javascript:alert(1)\">위험</a></p>",
      "<pre><code class=\"language-ts\">first\n\tsecond</code></pre>",
      "<script>window.bad = true</script>"
    ].join("");
    const preview = previewLegacyHtmlToMarkdown(source);

    expect(preview.sourcePreserved).toBe(true);
    expect(source).toContain("<script>");
    expect(preview.markdown).toContain("# 기존 노트");
    expect(preview.markdown).toContain("**중요** 위험");
    expect(preview.markdown).toContain("first\n\tsecond");
    expect(preview.markdown).not.toContain("javascript:");
    expect(preview.markdown).not.toContain("window.bad");
    expect(preview.lossy).toBe(true);
    expect(preview.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["unsafe-link-removed", "active-content-removed"])
    );
  });

  it("converts lists, tasks, safe links, and tables without executing HTML", () => {
    const preview = previewLegacyHtmlToMarkdown([
      "<ul><li><input type=checkbox checked>완료</li><li>대기</li></ul>",
      "<p><a href=\"https://example.com\">자료</a></p>",
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
    ].join(""));

    expect(preview.markdown).toContain("- [x] 완료");
    expect(preview.markdown).toContain("[자료](<https://example.com/>)");
    expect(preview.markdown).toContain("| A | B |");
    expect(preview.markdown).toContain("| --- | --- |");
  });

  it("preserves br as an explicit CommonMark hard break", () => {
    const preview = previewLegacyHtmlToMarkdown("<p>첫 줄<br>둘째 줄</p>");

    expect(preview.markdown).toBe("첫 줄\\\n둘째 줄");
    expect(parseMarkdownInline(preview.markdown)).toEqual([
      { type: "text", value: "첫 줄" },
      { type: "line-break" },
      { type: "text", value: "둘째 줄" }
    ]);
    expect(preview.lossy).toBe(false);
  });

  it("canonicalizes spaced and balanced or unbalanced parenthesis URLs into parseable links", () => {
    const preview = previewLegacyHtmlToMarkdown([
      '<p><a href="https://example.com/a b(c)">균형</a></p>',
      '<p><a href="https://example.com/open(a b">여는 괄호</a></p>',
      '<p><a href="https://example.com/close)a b">닫는 괄호</a></p>'
    ].join(""));
    const links = parseMarkdownInline(preview.markdown)
      .filter((token) => token.type === "link");

    expect(preview.markdown).toContain("(<https://example.com/a%20b%28c%29>)");
    expect(preview.markdown).toContain("(<https://example.com/open%28a%20b>)");
    expect(preview.markdown).toContain("(<https://example.com/close%29a%20b>)");
    expect(links).toMatchObject([
      { type: "link", href: "https://example.com/a%20b%28c%29", external: true, safe: true },
      { type: "link", href: "https://example.com/open%28a%20b", external: true, safe: true },
      { type: "link", href: "https://example.com/close%29a%20b", external: true, safe: true }
    ]);
    expect(preview.lossy).toBe(false);
  });

  it("bounds deeply nested legacy HTML and preserves inert text", () => {
    const source = `${"<div>".repeat(10_000)}보존할 내용<script>remove()</script>${"</div>".repeat(10_000)}`;

    expect(() => previewLegacyHtmlToMarkdown(source)).not.toThrow();
    const preview = previewLegacyHtmlToMarkdown(source);
    expect(preview.markdown).toContain("보존할 내용");
    expect(preview.markdown).not.toContain("remove()");
    expect(preview.lossy).toBe(true);
  });

  it("rejects a flat 30k-node tree before invoking the DOM parser", () => {
    const source = `<div>${"<span>x</span>".repeat(30_000)}</div>`;
    const createElement = vi.spyOn(document, "createElement");

    const preview = previewLegacyHtmlToMarkdown(source);

    expect(createElement).not.toHaveBeenCalled();
    expect(preview.sourcePreserved).toBe(true);
    expect(preview.lossy).toBe(true);
    expect(preview.warnings[0]?.message).toContain("원본 노트는 그대로 보존");
  });

  it("preserves legacy plain text that merely looks like active HTML", () => {
    const source = "<script>literal()</script>\r\n<br>\r마지막 #tag [[Note]]";
    const preview = previewLegacyHtmlToMarkdown(source);

    expect(preview.markdown).toBe(
      "\\<script\\>literal\\(\\)\\<\\/script\\>\n\\<br\\>\n마지막 \\#tag \\[\\[Note\\]\\]"
    );
    expect(preview.warnings).toEqual([]);
    expect(preview.lossy).toBe(false);
    expect(preview.sourcePreserved).toBe(true);
  });

  it("escapes Markdown and Obsidian syntax found inside legacy HTML text", () => {
    const preview = previewLegacyHtmlToMarkdown([
      "<p># literal heading</p>",
      "<p>- literal item</p>",
      "<p>[[Note]] #tag ==highlight== %%comment%% ^block</p>"
    ].join(""));

    expect(preview.markdown).toContain("\\# literal heading");
    expect(preview.markdown).toContain("\\- literal item");
    expect(preview.markdown).toContain("\\[\\[Note\\]\\]");
    expect(preview.markdown).toContain("\\#tag");
    expect(preview.markdown).toContain("\\=\\=highlight\\=\\=");
    expect(preview.markdown).toContain("\\%\\%comment\\%\\%");
    expect(preview.markdown).toContain("\\^block");
  });

  it("warns when editor-only formatting and active attributes are simplified", () => {
    const preview = previewLegacyHtmlToMarkdown(
      "<!--qm-font-size:22--><p style=\"text-align:center\" onclick=\"bad()\"><span data-qm-text-color=\"#112233\">내용</span></p>"
    );

    expect(preview.markdown).toContain("내용");
    expect(preview.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["unsupported-formatting", "active-content-removed"])
    );
    expect(preview.lossy).toBe(true);
  });

  it("keeps safe raster data URLs on the original and explicitly warns that the copy omits them", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==";
    const source = `<p>앞<img src="${dataUrl}" alt="픽셀">뒤</p>`;
    const preview = previewLegacyHtmlToMarkdown(source);

    expect(source).toContain(dataUrl);
    expect(preview.sourcePreserved).toBe(true);
    expect(preview.markdown).toContain("[픽셀 제거됨]");
    expect(preview.markdown).not.toContain("data:image");
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: "unsafe-image-removed"
    }));
    expect(preview.lossy).toBe(true);
  });
});
