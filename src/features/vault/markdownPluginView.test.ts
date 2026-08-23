import { describe, expect, it } from "vitest";
import { createDrawingSource } from "../drawing/model";
import { createKanbanSource } from "../kanban/model";
import { detectMarkdownPluginView } from "./markdownPluginView";

describe("detectMarkdownPluginView", () => {
  it("recognizes only explicit QuickMemo plugin frontmatter", () => {
    expect(detectMarkdownPluginView(createDrawingSource())).toBe("drawing");
    expect(detectMarkdownPluginView(createKanbanSource())).toBe("kanban");
    expect(detectMarkdownPluginView("# drawing-v1")).toBeNull();
  });
});
