import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeMirrorMarkdownEditor } from "./CodeMirrorMarkdownEditor";

describe("CodeMirrorMarkdownEditor", () => {
  it("exposes an accessible multiline editor and preserves literal tabs", () => {
    const onChange = vi.fn();
    render(<CodeMirrorMarkdownEditor onChange={onChange} value={"a\tb"} />);

    const editor = screen.getByLabelText("Markdown 편집기");
    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(editor).toHaveAttribute("aria-autocomplete", "list");
    expect(editor).toHaveAttribute("aria-keyshortcuts", "Control+Space");
    expect(editor).toHaveTextContent("a b");
  });

  it("invokes save through Mod-s", () => {
    const onSave = vi.fn();
    render(<CodeMirrorMarkdownEditor onChange={() => undefined} onSave={onSave} value="본문" />);

    fireEvent.keyDown(screen.getByLabelText("Markdown 편집기"), { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not report a prop value synchronization as a user edit", () => {
    const onChange = vi.fn();
    const view = render(<CodeMirrorMarkdownEditor onChange={onChange} value="첫 노트" />);

    view.rerender(<CodeMirrorMarkdownEditor onChange={onChange} value="원격에서 갱신된 노트" />);

    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("원격에서 갱신된 노트");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("inserts requested template text through the editor transaction", () => {
    const onChange = vi.fn();
    const onInsertHandled = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onInsertHandled={onInsertHandled}
        value="본문"
      />
    );

    view.rerender(
      <CodeMirrorMarkdownEditor
        insertRequest={{ id: 7, text: "# 템플릿\n" }}
        onChange={onChange}
        onInsertHandled={onInsertHandled}
        value="본문"
      />
    );

    expect(onChange).toHaveBeenCalledWith("# 템플릿\n본문");
    expect(onInsertHandled).toHaveBeenCalledWith(7);
  });
});
