import { describe, expect, it } from "vitest";
import {
  imageHtml,
  linkifyEditorHtml,
  parseEditorContent,
  plainTextToEditorHtml,
  previewTextFromHtml,
  sanitizeEditorHtml,
  serializeEditorContent
} from "./editorContent";

const safePngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==";

describe("editor content helpers", () => {
  it("wraps plain text as editable HTML", () => {
    expect(parseEditorContent("hello\nworld").html).toBe("<p>hello<br>world</p>");
  });

  it("preserves tab characters when converting plain text to editor HTML", () => {
    const outline = "제목\n\t하위 항목 1\n\t\t하위 항목 1-1\n\t하위 항목 2";
    const tsv = "이름\t나이\t메모\n홍길동\t30\t테스트\n김철수\t25\t확인";

    expect(plainTextToEditorHtml("a\tb")).toBe("<p>a\tb</p>");
    expect(plainTextToEditorHtml("\titem")).toBe("<p>\titem</p>");
    expect(plainTextToEditorHtml("\t\titem")).toBe("<p>\t\titem</p>");
    expect(plainTextToEditorHtml(outline)).toContain("<br>\t\t하위 항목 1-1");
    expect(plainTextToEditorHtml(tsv)).toContain("이름\t나이\t메모");
  });

  it("round-trips tab characters through editor serialization", () => {
    const html = plainTextToEditorHtml("root\n\tchild\n\t\tgrandchild\nname\tage\tmemo");
    const serialized = serializeEditorContent(html, 17);
    const parsed = parseEditorContent(serialized);

    expect(serialized).toContain("\tchild");
    expect(serialized).toContain("\t\tgrandchild");
    expect(serialized).toContain("name\tage\tmemo");
    expect(parsed.html).toContain("\tchild");
    expect(parsed.html).toContain("name\tage\tmemo");
  });

  it("preserves tabs while escaping unsafe plain text paste content", () => {
    const html = plainTextToEditorHtml("\t<script>alert(1)</script>\t<img src=x onerror=alert(1)>");

    expect(html).toContain("\t&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("\t&lt;img src=x onerror=alert(1)&gt;");
    expect(sanitizeEditorHtml(html)).not.toContain("<script>");
    expect(sanitizeEditorHtml(html)).not.toContain("<img");
  });

  it("stores and restores editor font size metadata", () => {
    const stored = serializeEditorContent("<p>memo</p>", 22);
    expect(parseEditorContent(stored)).toEqual({ html: "<p>memo</p>", fontSize: 22 });
  });

  it("round-trips heading levels and horizontal rules without losing safe text", () => {
    const source =
      '<h1 data-qm-line-height="1.35" data-qm-block-id="qm_123456789abc" style="text-align:center" onclick="alert(1)">큰 제목<script>alert(1)</script></h1><h2>중간 제목</h2><h3>작은 제목</h3><h4>제목 4</h4><h5>제목 5</h5><h6>제목 6</h6><hr><p>본문</p>';
    const serialized = serializeEditorContent(source, 19);
    const parsed = parseEditorContent(serialized);

    expect(parsed.fontSize).toBe(19);
    expect(parsed.html).toContain(
      '<h1 style="text-align: center; line-height: 1.35;" data-qm-line-height="1.35" data-qm-block-id="qm_123456789abc">큰 제목</h1>'
    );
    expect(parsed.html).toContain("<h2>중간 제목</h2>");
    expect(parsed.html).toContain("<h3>작은 제목</h3>");
    expect(parsed.html).toContain("<h4>제목 4</h4>");
    expect(parsed.html).toContain("<h5>제목 5</h5>");
    expect(parsed.html).toContain("<h6>제목 6</h6>");
    expect(parsed.html).toContain("<hr>");
    expect(parsed.html).toContain("<p>본문</p>");
    expect(parsed.html).not.toContain("onclick");
    expect(parsed.html).not.toContain("script");
    expect(parsed.html).not.toContain("alert(1)");
  });

  it("recognizes heading-only HTML instead of escaping it as plain text", () => {
    expect(parseEditorContent("<h1>제목만 있는 메모</h1>").html).toBe("<h1>제목만 있는 메모</h1>");
  });

  it("strips unsafe HTML from previews", () => {
    expect(previewTextFromHtml('<script>alert(1)</script><p>safe</p>')).toBe("safe");
  });

  it("allows inline image data URLs", () => {
    const html = imageHtml(safePngDataUrl, "test");
    expect(parseEditorContent(html).html).toContain(safePngDataUrl);
  });

  it("preserves only safe image width values", () => {
    expect(parseEditorContent(`<p><img src="${safePngDataUrl}" data-qm-width="50"></p>`).html).toContain(
      'data-qm-width="50"'
    );
    expect(parseEditorContent(`<p><img src="${safePngDataUrl}" data-qm-image-width="480"></p>`).html).toContain(
      'data-qm-image-width="480"'
    );
    expect(parseEditorContent(`<p><img src="${safePngDataUrl}" data-qm-image-width="480"></p>`).html).toContain(
      "width: 480px"
    );
    expect(parseEditorContent(`<p><img src="${safePngDataUrl}" style="width:13px"></p>`).html).not.toContain(
      "width:13px"
    );
    expect(parseEditorContent(`<p><img src="${safePngDataUrl}" data-qm-image-width="9999"></p>`).html).not.toContain(
      "data-qm-image-width"
    );
  });

  it("rejects oversized, animated, and malformed inline image payloads before browser decode", () => {
    const hugePngHeader = new Uint8Array(33);
    hugePngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(hugePngHeader.buffer);
    view.setUint32(8, 13);
    hugePngHeader.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 20_000);
    view.setUint32(20, 20_000);
    const hugePng = `data:image/png;base64,${btoa(String.fromCharCode(...hugePngHeader))}`;

    expect(sanitizeEditorHtml(`<p><img src="${hugePng}"></p>`)).not.toContain("<img");
    expect(sanitizeEditorHtml('<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></p>')).not.toContain("<img");
    expect(sanitizeEditorHtml('<p><img src="data:image/png;base64,abc"></p>')).not.toContain("<img");
  });

  it("turns typed web URLs into safe links", () => {
    const html = linkifyEditorHtml("<p>go https://example.com, www.quickmemo.app</p>");

    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain(">https://example.com</a>,");
    expect(html).toContain('href="https://www.quickmemo.app/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("keeps unsafe anchor hrefs out of memo HTML", () => {
    const html = sanitizeEditorHtml('<p><a href="javascript:alert(1)">bad</a></p>');

    expect(html).toBe("<p>bad</p>");
  });

  it("preserves underline and strike formatting", () => {
    const html = sanitizeEditorHtml("<p><u>under</u> <s>strike</s> <del>delete</del></p>");

    expect(html).toContain("<u>under</u>");
    expect(html).toContain("<s>strike</s>");
    expect(html).toContain("<del>delete</del>");
  });

  it("preserves safe task lists, table alignment, and cell colors", () => {
    const html = sanitizeEditorHtml(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-qm-block-id="qm_123456789abc" data-qm-author-uids="u1" data-qm-editor-uids="u1,u2" data-qm-last-editor-uid="u2" data-qm-attribution-label="작성자: BH, 최종 수정자: KIG"><label><input type="checkbox" checked></label><div><p>done</p></div></li></ul><p data-qm-line-height="1.35" style="line-height:1.35"><span data-qm-font-size="36" data-qm-text-color="#2563eb" data-qm-line-height="1.85" style="font-size:36px;color:#2563eb;line-height:1.85">big</span></p><table data-qm-table-width-px="720" data-qm-table-height-px="320"><tbody><tr data-qm-row-height-px="80"><td colspan="1" rowspan="1" colwidth="120" data-qm-cell-width-px="120" data-qm-bg="#34c759" style="background: red; text-align:center"><p style="text-align:center">cell</p></td></tr></tbody></table>'
    );

    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-qm-block-id="qm_123456789abc"');
    expect(html).toContain('data-qm-font-size="36"');
    expect(html).toContain("font-size: 36px");
    expect(html).toContain('data-qm-text-color="#2563eb"');
    expect(html).toContain('data-qm-line-height="1.35"');
    expect(html).toContain('data-qm-line-height="1.85"');
    expect(html).toContain("line-height: 1.35");
    expect(html).toContain("line-height: 1.85");
    expect(html).toContain('data-qm-author-uids="u1"');
    expect(html).toContain('data-qm-editor-uids="u1,u2"');
    expect(html).toContain('data-qm-last-editor-uid="u2"');
    expect(html).toContain('data-qm-attribution-label="작성자: BH, 최종 수정자: KIG"');
    expect(html).toContain('data-qm-table-width-px="720"');
    expect(html).toContain("width: 720px");
    expect(html).toContain('data-qm-table-height-px="320"');
    expect(html).toContain("height: 320px");
    expect(html).toContain('data-qm-row-height-px="80"');
    expect(html).toContain("height: 80px");
    expect(html).toContain('data-qm-bg="#34c759"');
    expect(html).toContain('colwidth="120"');
    expect(html).toContain('data-qm-cell-width-px="120"');
    expect(html).toContain("text-align: center");
  });

  it("removes unsafe table and checkbox attributes", () => {
    const html = sanitizeEditorHtml(
      '<p data-qm-line-height="99" data-qm-block-id="bad id!" data-qm-author-uids="<bad>" data-qm-last-editor-uid="bad uid" data-qm-attribution-label="<img src=x onerror=alert(1)>"><span data-qm-font-size="99" data-qm-text-color="javascript:bad" data-qm-line-height="999" style="font-size:99px;color:expression(alert(1));line-height:999">bad</span></p><table onclick="alert(1)" data-qm-table-width="999" data-qm-table-width-px="99999" data-qm-table-height-px="99999" style="width:9999px;height:99999px"><tbody><tr data-qm-row-height-px="99999"><td data-qm-bg="javascript:bad" data-qm-cell-width-px="99999" colwidth="99999" style="background-image:url(javascript:bad); width:9999px"><input type="text" value="bad"><p style="text-align:justify" data-qm-editor-uids="bad uid with spaces">safe</p></td></tr></tbody></table>'
    );

    expect(html).not.toContain("onclick");
    expect(html).not.toContain("data-qm-block-id");
    expect(html).not.toContain('data-qm-font-size="99"');
    expect(html).not.toContain("data-qm-text-color");
    expect(html).not.toContain("data-qm-line-height");
    expect(html).not.toContain("data-qm-author-uids");
    expect(html).not.toContain("data-qm-editor-uids");
    expect(html).not.toContain("data-qm-last-editor-uid");
    expect(html).not.toContain("data-qm-attribution-label");
    expect(html).not.toContain("font-size: 99px");
    expect(html).not.toContain("expression");
    expect(html).not.toContain("colwidth");
    expect(html).not.toContain("data-qm-cell-width-px");
    expect(html).not.toContain("data-qm-table-width");
    expect(html).not.toContain("data-qm-table-width-px");
    expect(html).not.toContain("data-qm-table-height-px");
    expect(html).not.toContain("data-qm-row-height-px");
    expect(html).not.toContain("width: 9999px");
    expect(html).not.toContain("height: 99999px");
    expect(html).not.toContain("javascript");
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain("justify");
  });
});
