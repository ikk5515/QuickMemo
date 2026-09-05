import type { EditorView } from "@codemirror/view";
import type { MarkdownEditorSnapshot } from "./markdownEditorSession";

type ScrollSnapshot = Pick<MarkdownEditorSnapshot, "scrollTop" | "scrollLeft" | "scrollSnapshot">;

function lineTop(view: EditorView, position: number): number | null {
  const { node } = view.domAtPos(position);
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  const line = element?.closest(".cm-line");
  if (!line || !view.contentDOM.contains(line)) return null;
  const rect = line.getBoundingClientRect();
  return rect.height > 0 && Number.isFinite(rect.top) ? rect.top : null;
}

/** Capture once on document disposal, preserving the visible line while CM settles its height map. */
export function captureMarkdownEditorScroll(view: EditorView): ScrollSnapshot {
  const fallback: ScrollSnapshot = {
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft
  };
  try {
    fallback.scrollSnapshot = view.scrollSnapshot();
    if (!view.dom.isConnected || view.scrollDOM.clientHeight <= 0 || view.scrollDOM.clientWidth <= 0) return fallback;
    const anchor = fallback.scrollSnapshot.value.range.head;
    const beforeTop = lineTop(view, anchor);
    if (beforeTop === null) return fallback;
    // scrollSnapshot itself only reads CM's cached heights. A pending live
    // preview heading can change them, and measuring may move the scroll DOM.
    // Keep the same visible line's offset across this single boundary read.
    view.requestMeasure();
    view.lineBlockAtHeight(fallback.scrollTop);
    const afterTop = lineTop(view, anchor);
    if (afterTop === null) {
      view.scrollDOM.scrollTop = fallback.scrollTop;
      view.scrollDOM.scrollLeft = fallback.scrollLeft;
      return fallback;
    }
    view.scrollDOM.scrollTop += afterTop - beforeTop;
    return {
      scrollTop: view.scrollDOM.scrollTop,
      scrollLeft: view.scrollDOM.scrollLeft,
      scrollSnapshot: view.scrollSnapshot()
    };
  } catch {
    // A detached/hidden view or a layout read during a CM update must never
    // prevent the editor's authorized session write and destruction.
    view.scrollDOM.scrollTop = fallback.scrollTop;
    view.scrollDOM.scrollLeft = fallback.scrollLeft;
    return fallback;
  }
}
