import { afterEach, describe, expect, it, vi } from "vitest";
import { previewMarkdownHtmlNormalization } from "./markdownHtmlNormalization";

afterEach(() => vi.restoreAllMocks());

describe("Markdown block HTML normalization preview", () => {
  it("converts complete block HTML while preserving YAML and native Markdown", () => {
    const source = [
      "---",
      "sample: <h1>YAML literal</h1>",
      "---",
      "# 기존 Markdown",
      "<H3>테스트</H3>",
      "<p># literal heading</p>"
    ].join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toContain("sample: <h1>YAML literal</h1>");
    expect(preview.markdown).toContain("# 기존 Markdown");
    expect(preview.markdown).toContain("### 테스트");
    expect(preview.markdown).toContain("\\# literal heading");
    expect(preview.changedBlockCount).toBe(2);
    expect(preview.sourcePreserved).toBe(true);
  });

  it("skips fenced code, indented code, inline HTML, and unsupported inline roots", () => {
    const source = [
      "```html",
      "<h3>fenced</h3>",
      "```",
      "~~~",
      "<p>tilde fenced</p>",
      "~~~",
      "    <h3>indented</h3>",
      "앞 <h3>inline</h3> 뒤",
      "<span>inline root</span>",
      "<h3>convert me</h3>"
    ].join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toContain("<h3>fenced</h3>");
    expect(preview.markdown).toContain("<p>tilde fenced</p>");
    expect(preview.markdown).toContain("    <h3>indented</h3>");
    expect(preview.markdown).toContain("앞 <h3>inline</h3> 뒤");
    expect(preview.markdown).toContain("<span>inline root</span>");
    expect(preview.markdown).toContain("### convert me");
    expect(preview.changedBlockCount).toBe(1);
  });

  it("converts complete multiline list, table, pre, and horizontal-rule blocks", () => {
    const source = [
      "<ul>",
      "  <li>하나</li>",
      "  <li>둘</li>",
      "</ul>",
      "<table>",
      "<tr><th>A</th><th>B</th></tr>",
      "<tr><td>1</td><td>2</td></tr>",
      "</table>",
      "<pre><code class=\"language-ts\">const value = 1;</code></pre>",
      "<hr />"
    ].join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toContain("- 하나\n- 둘");
    expect(preview.markdown).toContain("| A | B |");
    expect(preview.markdown).toContain("```ts\nconst value = 1;\n```");
    expect(preview.markdown).toContain("---");
    expect(preview.changedBlockCount).toBe(4);
  });

  it("finds the real root close for quote-aware, same-tag nested divs", () => {
    const source = [
      "<div data-label=\"quoted </div> and > characters\">",
      "<div><strong>안쪽</strong></div>",
      "<p>바깥 뒤</p>",
      "</div>",
      "<h3>다음 블록</h3>"
    ].join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toContain("**안쪽**");
    expect(preview.markdown).toContain("바깥 뒤");
    expect(preview.markdown).toContain("### 다음 블록");
    expect(preview.markdown).not.toContain("</div>");
    expect(preview.changedBlockCount).toBe(2);
  });

  it("keeps nested lists in one root candidate instead of cutting at the inner close", () => {
    const source = [
      "<ul>",
      "<li>상위<ul><li>하위</li></ul></li>",
      "<li>다음</li>",
      "</ul>"
    ].join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toContain("- 상위");
    expect(preview.markdown).toContain("  - 하위");
    expect(preview.markdown).toContain("- 다음");
    expect(preview.markdown).not.toContain("</ul>");
    expect(preview.changedBlockCount).toBe(1);
  });

  it("preserves a large run of unclosed roots and reports the bounded fallback", () => {
    const source = Array.from({ length: 50_000 }, (_, index) =>
      `<div data-index="${index}">`
    ).join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toBe(source);
    expect(preview.changedBlockCount).toBe(0);
    expect(preview.warnings[0]?.message).toContain("원문을 그대로 유지");
    expect(preview.sourcePreserved).toBe(true);
  });

  it("aborts a 5k-block plan before DOM parsing without partially converting it", () => {
    const source = Array.from({ length: 5_000 }, (_, index) =>
      `<p>블록 ${index}</p>`
    ).join("\n");
    const createElement = vi.spyOn(document, "createElement");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(createElement).not.toHaveBeenCalled();
    expect(preview.markdown).toBe(source);
    expect(preview.changedBlockCount).toBe(0);
    expect(preview.lossy).toBe(false);
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: "unsupported-formatting",
      message: expect.stringContaining("원문을 그대로 유지")
    }));
  });

  it("preserves an incomplete quoted tag and all following text byte-for-byte", () => {
    const source = [
      "<div title=\"unfinished >",
      "<h3>변환하면 안 됨</h3>",
      "원문"
    ].join("\n");

    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toBe(source);
    expect(preview.changedBlockCount).toBe(0);
  });

  it("aggregates lossy warnings without retaining active or unsafe content", () => {
    const source = "<div style=\"text-align:center\">안전<script>bad()</script><a href=\"javascript:bad()\">링크</a></div>";
    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toContain("안전링크");
    expect(preview.markdown).not.toContain("bad()");
    expect(preview.markdown).not.toContain("javascript:");
    expect(preview.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "unsupported-formatting",
        "active-content-removed",
        "unsafe-link-removed"
      ])
    );
    expect(preview.lossy).toBe(true);
    expect(preview.changedBlockCount).toBe(1);
  });

  it("returns byte-identical input when there is no safe conversion candidate", () => {
    const source = "# 그대로\r\n문장 안의 <strong>HTML</strong>\r\n";
    const preview = previewMarkdownHtmlNormalization(source);

    expect(preview.markdown).toBe(source);
    expect(preview.changedBlockCount).toBe(0);
    expect(preview.warnings).toEqual([]);
    expect(preview.lossy).toBe(false);
  });
});
