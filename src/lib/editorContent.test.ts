import { describe, expect, it } from "vitest";
import {
  imageHtml,
  parseEditorContent,
  previewTextFromHtml,
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
});
