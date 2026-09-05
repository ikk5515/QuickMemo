import { isDrawingSource } from "../drawing/model";

export type MarkdownPluginViewKind = "drawing";

export function detectMarkdownPluginView(source: string): MarkdownPluginViewKind | null {
  if (isDrawingSource(source)) return "drawing";
  return null;
}
