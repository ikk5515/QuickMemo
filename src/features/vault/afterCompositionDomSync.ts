import type { EditorView } from "@codemirror/view";

/** Finish only after CM's scheduled DOM read, including its Android input flush. */
export function afterCompositionDomSync(view: EditorView, finish: () => void): () => void {
  let cancelled = false;
  view.requestMeasure({
    read: () => undefined,
    write: () => {
      // Editor transactions are forbidden during a measurement write phase.
      queueMicrotask(() => {
        if (!cancelled && !view.composing) finish();
      });
    }
  });
  return () => { cancelled = true; };
}
