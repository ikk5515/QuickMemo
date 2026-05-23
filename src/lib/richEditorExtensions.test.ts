import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
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

describe("rich editor extensions", () => {
  it("keeps the caret near pasted content after a value sync", () => {
    const editor = createEditor(
      "<p>alpha</p><table><tbody><tr><th><p>head</p></th><th><p>other</p></th></tr><tr><td><p>cell</p></td><td><p>two</p></td></tr></tbody></table><p>omega</p>"
    );

    editor.commands.setTextSelection(textPosition(editor, "cell", 2));
    editor.commands.insertContent(" pasted");

    const selectionAfterPaste = editor.state.selection.from;
    const syncedHtml = editor.getHTML();
    const selectionBookmark = editor.state.selection.getBookmark();

    editor.commands.setContent(syncedHtml, { emitUpdate: false });
    editor.view.dispatch(editor.state.tr.setSelection(selectionBookmark.resolve(editor.state.doc)));

    expect(editor.getText()).toContain("ce pastedll");
    expect(editor.state.selection.from).toBe(selectionAfterPaste);
    expect(editor.state.selection.from).toBeLessThan(textPosition(editor, "omega"));
  });

  it("renders a persistent highlight for non-empty text selections", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    const from = textPosition(editor, "beta");

    editor.commands.setTextSelection({ from, to: from + "beta".length });

    expect(editor.view.dom.querySelector("[data-qm-active-selection='true']")).not.toBeNull();

    editor.commands.setTextSelection(from);

    expect(editor.view.dom.querySelector("[data-qm-active-selection='true']")).toBeNull();
  });
});
