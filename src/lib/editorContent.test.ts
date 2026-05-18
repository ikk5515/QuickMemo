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
    expect(parseEditorContent('<p><img src="data:image/png;base64,abc" data-qm-image-width="480"></p>').html).toContain(
      'data-qm-image-width="480"'
    );
    expect(parseEditorContent('<p><img src="data:image/png;base64,abc" data-qm-image-width="480"></p>').html).toContain(
      "width: 480px"
    );
    expect(parseEditorContent('<p><img src="data:image/png;base64,abc" style="width:13px"></p>').html).not.toContain(
      "width:13px"
    );
    expect(parseEditorContent('<p><img src="data:image/png;base64,abc" data-qm-image-width="9999"></p>').html).not.toContain(
      "data-qm-image-width"
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

  it("preserves underline and strike formatting", () => {
    const html = sanitizeEditorHtml("<p><u>under</u> <s>strike</s> <del>delete</del></p>");

    expect(html).toContain("<u>under</u>");
    expect(html).toContain("<s>strike</s>");
    expect(html).toContain("<del>delete</del>");
  });

  it("preserves safe task lists, table alignment, and cell colors", () => {
    const html = sanitizeEditorHtml(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li></ul><p><span data-qm-font-size="22" data-qm-text-color="#2563eb" style="font-size:22px;color:#2563eb">big</span></p><table data-qm-table-width-px="720" data-qm-table-height-px="320"><tbody><tr data-qm-row-height-px="80"><td colspan="1" rowspan="1" colwidth="120" data-qm-cell-width-px="120" data-qm-bg="#34c759" style="background: red; text-align:center"><p style="text-align:center">cell</p></td></tr></tbody></table>'
    );

    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-qm-font-size="22"');
    expect(html).toContain("font-size: 22px");
    expect(html).toContain('data-qm-text-color="#2563eb"');
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
      '<p><span data-qm-font-size="99" data-qm-text-color="javascript:bad" style="font-size:99px;color:expression(alert(1))">bad</span></p><table onclick="alert(1)" data-qm-table-width="999" data-qm-table-width-px="99999" data-qm-table-height-px="99999" style="width:9999px;height:99999px"><tbody><tr data-qm-row-height-px="99999"><td data-qm-bg="javascript:bad" data-qm-cell-width-px="99999" colwidth="99999" style="background-image:url(javascript:bad); width:9999px"><input type="text" value="bad"><p style="text-align:justify">safe</p></td></tr></tbody></table>'
    );

    expect(html).not.toContain("onclick");
    expect(html).not.toContain('data-qm-font-size="99"');
    expect(html).not.toContain("data-qm-text-color");
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
