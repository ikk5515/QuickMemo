import { isDrawingSource } from "../drawing/model";
import { isKanbanSource } from "../kanban/model";

export type MarkdownPluginViewKind = "drawing" | "kanban";

export function detectMarkdownPluginView(source: string): MarkdownPluginViewKind | null {
  if (isDrawingSource(source)) return "drawing";
  if (isKanbanSource(source)) return "kanban";
  return null;
}
