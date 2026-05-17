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
});
