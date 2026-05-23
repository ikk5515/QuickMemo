import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";

export interface StoredEditorSelectionRange {
  from: number;
  to: number;
}

export function selectionFromStoredRange(editor: Editor, range: StoredEditorSelectionRange | null) {
  if (!range) {
    return null;
  }

  const maxPosition = editor.state.doc.content.size;
  const from = clampEditorSelectionPosition(range.from, maxPosition);
  const to = clampEditorSelectionPosition(range.to, maxPosition);

  try {
    const $from = editor.state.doc.resolve(from);

    if (from === to) {
      return Selection.near($from, 1);
    }

    return TextSelection.between($from, editor.state.doc.resolve(to), 1);
  } catch {
    try {
      return Selection.near(editor.state.doc.resolve(Math.min(from, to)), 1);
    } catch {
      return null;
    }
  }
}

function clampEditorSelectionPosition(position: number, maxPosition: number) {
  return Math.min(Math.max(position, 0), maxPosition);
}
