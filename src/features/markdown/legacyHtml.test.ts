import { describe, expect, it } from "vitest";
import { previewLegacyHtmlToMarkdown } from "./legacyHtml";

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
    expect(preview.markdown).toContain("[자료](https://example.com)");
    expect(preview.markdown).toContain("| A | B |");
    expect(preview.markdown).toContain("| --- | --- |");
  });

  it("bounds deeply nested legacy HTML and preserves inert text", () => {
    const source = `${"<div>".repeat(10_000)}보존할 내용<script>remove()</script>${"</div>".repeat(10_000)}`;

    expect(() => previewLegacyHtmlToMarkdown(source)).not.toThrow();
    const preview = previewLegacyHtmlToMarkdown(source);
    expect(preview.markdown).toContain("보존할 내용");
    expect(preview.markdown).not.toContain("remove()");
    expect(preview.lossy).toBe(true);
  });
});
