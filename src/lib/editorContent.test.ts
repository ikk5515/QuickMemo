import { describe, expect, it } from "vitest";
import {
  imageHtml,
  linkifyEditorHtml,
  parseEditorContent,
  previewTextFromHtml,
  sanitizeEditorHtml,
  serializeEditorContent
} from "./editorContent";

describe("editor content helpers", () => {
  it("wraps plain text as editable HTML", () => {
    expect(parseEditorContent("hello\nworld").html).toBe("<p>hello<br>world</p>");
  });

  it("stores and restores editor font size metadata", () => {
    const stored = serializeEditorContent("<p>memo</p>", 22);
    expect(parseEditorContent(stored)).toEqual({ html: "<p>memo</p>", fontSize: 22 });
  });

  it("strips unsafe HTML from previews", () => {
    expect(previewTextFromHtml('<script>alert(1)</script><p>safe</p>')).toBe("safe");
  });

  it("allows inline image data URLs", () => {
    const html = imageHtml("data:image/png;base64,abc", "test");
    expect(parseEditorContent(html).html).toContain("data:image/png;base64,abc");
  });

  it("preserves only safe image width values", () => {
    expect(parseEditorContent('<p><img src="data:image/png;base64,abc" data-qm-width="50"></p>').html).toContain(
      'data-qm-width="50"'
    );
    expect(parseEditorContent('<p><img src="data:image/png;base64,abc" style="width:13px"></p>').html).not.toContain(
      "width:13px"
    );
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

  it("preserves safe task lists, table alignment, and cell colors", () => {
    const html = sanitizeEditorHtml(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li></ul><table><tbody><tr><td colspan="1" rowspan="1" colwidth="120" data-qm-bg="#dbeafe" style="background: red; text-align:center"><p style="text-align:center">cell</p></td></tr></tbody></table>'
    );

    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-qm-bg="#dbeafe"');
    expect(html).toContain('colwidth="120"');
    expect(html).toContain("text-align: center");
  });

  it("removes unsafe table and checkbox attributes", () => {
    const html = sanitizeEditorHtml(
      '<table onclick="alert(1)"><tbody><tr><td data-qm-bg="#000000" colwidth="99999" style="background-image:url(javascript:bad); width:9999px"><input type="text" value="bad"><p style="text-align:justify">safe</p></td></tr></tbody></table>'
    );

    expect(html).not.toContain("onclick");
    expect(html).not.toContain("#000000");
    expect(html).not.toContain("colwidth");
    expect(html).not.toContain("javascript");
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain("justify");
  });
});
