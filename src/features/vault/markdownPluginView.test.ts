import { describe, expect, it } from "vitest";
import { createDrawingSource } from "../drawing/model";
import { detectMarkdownPluginView } from "./markdownPluginView";

describe("detectMarkdownPluginView", () => {
  it("recognizes only explicit QuickMemo plugin frontmatter", () => {
    expect(detectMarkdownPluginView(createDrawingSource())).toBe("drawing");
    expect(detectMarkdownPluginView("---\nquickmemo-plugin: kanban-v1\n---\n## 할 일\n- [ ] 기존 카드")).toBeNull();
    expect(detectMarkdownPluginView("# drawing-v1")).toBeNull();
  });
});
