import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { selectionFromStoredRange } from "./editorSelection";
import { richEditorExtensions } from "./richEditorExtensions";

const editors: Editor[] = [];
const editorElements: HTMLElement[] = [];

function createEditor(content: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editorElements.push(element);

  const editor = new Editor({
    content,
    element,
    extensions: richEditorExtensions
  });

  editors.push(editor);
  return editor;
}

function textPosition(editor: Editor, text: string, offset = 0) {
  let foundPosition: number | null = null;

  editor.state.doc.descendants((node, position) => {
    if (foundPosition !== null || !node.isText) {
      return foundPosition === null;
    }

    const index = (node.text ?? "").indexOf(text);

    if (index >= 0) {
      foundPosition = position + index + offset;
      return false;
    }

    return true;
  });

  if (foundPosition === null) {
    throw new Error(`Could not find text "${text}" in editor document`);
  }

  return foundPosition;
}

afterEach(() => {
  while (editors.length) {
    editors.pop()?.destroy();
  }

  while (editorElements.length) {
    editorElements.pop()?.remove();
  }
});

describe("editor selection helpers", () => {
  it("restores a selected text range so toolbar font and color commands affect the selection", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    const from = textPosition(editor, "beta");
    const to = from + "beta".length;
    const storedRange = { from, to };

    editor.commands.setTextSelection(textPosition(editor, "alpha"));

    const restoredSelection = selectionFromStoredRange(editor, storedRange);
    expect(restoredSelection?.from).toBe(from);
    expect(restoredSelection?.to).toBe(to);

    editor.view.dispatch(editor.state.tr.setSelection(restoredSelection!));
    editor.chain().focus().setMark("textSize", { size: 28 }).setMark("textColor", { color: "#2563eb" }).run();

    expect(editor.getHTML()).toContain('data-qm-font-size="28"');
    expect(editor.getHTML()).toContain('data-qm-text-color="#2563eb"');
    expect(editor.getHTML()).toContain(">beta</span>");
  });
});
