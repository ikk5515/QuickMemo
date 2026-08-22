import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("can lock and unlock editing without rebuilding the document", () => {
    const onChange = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor documentKey="note-a" onChange={onChange} readOnly value="보존할 본문" />
    );

    expect(screen.getByLabelText("Markdown 편집기")).toHaveAttribute("contenteditable", "false");
    expect(screen.getByText("보존할 본문").closest(".vault-codemirror")).toHaveAttribute("aria-readonly", "true");

    view.rerender(
      <CodeMirrorMarkdownEditor documentKey="note-a" onChange={onChange} value="보존할 본문" />
    );

    expect(screen.getByLabelText("Markdown 편집기")).toHaveAttribute("contenteditable", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts a fresh editor document when the document key changes", () => {
    const onChange = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor documentKey="note-a" onChange={onChange} value="첫 노트" />
    );

    view.rerender(
      <CodeMirrorMarkdownEditor documentKey="note-b" onChange={onChange} value="둘째 노트" />
    );

    const editor = screen.getByLabelText("Markdown 편집기");
    expect(editor).toHaveTextContent("둘째 노트");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(editor).toHaveTextContent("둘째 노트");
    expect(editor).not.toHaveTextContent("첫 노트");
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
        insertRequest={{ cursorOffset: 2, id: 7, text: "# 템플릿\n" }}
        onChange={onChange}
        onInsertHandled={onInsertHandled}
        value="본문"
      />
    );

    expect(onChange).toHaveBeenCalledWith("# 템플릿\n본문");
    expect(onInsertHandled).toHaveBeenCalledWith(7);
    const selection = document.getSelection();
    const content = screen.getByLabelText("Markdown 편집기");
    expect(selection?.anchorNode).not.toBeNull();
    const cursorRange = document.createRange();
    cursorRange.selectNodeContents(content);
    cursorRange.setEnd(selection!.anchorNode!, selection!.anchorOffset);
    expect(cursorRange.toString()).toHaveLength(2);
  });

  it("renders inactive Markdown lines inline while leaving one CodeMirror surface", () => {
    const value = [
      "",
      "# 제목",
      "**굵게** *기울임* `코드`",
      "[[Folder/Note|별칭]] [문서](https://example.com) #project/quickmemo",
      "- [ ] 확인할 일",
      "> 인용문",
      "> [!note]+ 참고"
    ].join("\n");
    const { container } = render(
      <CodeMirrorMarkdownEditor livePreview onChange={() => undefined} value={value} />
    );

    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(container.querySelector(".vault-markdown-renderer")).toBeNull();
    expect(container.querySelector(".cm-live-heading-1")).toHaveTextContent("제목");
    expect(container.querySelector(".cm-live-strong")).toHaveTextContent("굵게");
    expect(container.querySelector(".cm-live-emphasis")).toHaveTextContent("기울임");
    expect(container.querySelector(".cm-live-inline-code")).toHaveTextContent("코드");
    expect(container.querySelector(".cm-live-wikilink")).toHaveTextContent("별칭");
    expect(container.querySelector(".cm-live-link")).toHaveTextContent("문서");
    expect(container.querySelector(".cm-live-tag")).toHaveTextContent("#project/quickmemo");
    expect(screen.getByRole("checkbox", { name: "완료하지 않은 작업" })).not.toBeChecked();
    expect(container.querySelector(".cm-live-blockquote")).toHaveTextContent("인용문");
    expect(container.querySelector(".cm-live-callout-marker")).toHaveTextContent("NOTE");
  });

  it("renders inactive tables, fenced blocks and embeds inside the same editor surface", async () => {
    const renderCodeBlock = vi.fn((language: string, source: string) => (
      <strong>{language}: {source.trim()}</strong>
    ));
    const renderEmbed = vi.fn(() => <span>복호화된 임베드</span>);
    const value = [
      "",
      "| 이름 | 상태 |",
      "| --- | --- |",
      "| Alpha | 완료 |",
      "",
      "```dataview",
      "TABLE status",
      "```",
      "",
      "![[Work/Beta]]"
    ].join("\n");
    let container: HTMLElement;
    let unmount: () => void;
    await act(async () => {
      const rendered = render(
        <CodeMirrorMarkdownEditor
          livePreview
          onChange={() => undefined}
          renderCodeBlock={renderCodeBlock}
          renderEmbed={renderEmbed}
          value={value}
        />
      );
      container = rendered.container;
      unmount = rendered.unmount;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(await screen.findByRole("table")).toHaveTextContent("Alpha");
    expect(await screen.findByText("dataview: TABLE status")).toBeInTheDocument();
    expect(await screen.findByText("복호화된 임베드")).toBeInTheDocument();
    expect(container!.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(container!.querySelectorAll(".cm-live-complex-block")).toHaveLength(3);
    expect(renderCodeBlock).toHaveBeenCalledWith("dataview", "TABLE status");
    expect(renderEmbed).toHaveBeenCalledWith(expect.objectContaining({
      embed: true,
      path: "Work/Beta"
    }));
    await act(async () => {
      unmount!();
      await Promise.resolve();
    });
  });

  it("keeps a complex block as canonical Markdown while its line is selected", () => {
    const value = [
      "| 이름 | 상태 |",
      "| --- | --- |",
      "| Alpha | 완료 |"
    ].join("\n");
    const { container } = render(
      <CodeMirrorMarkdownEditor livePreview onChange={() => undefined} value={value} />
    );

    expect(container.querySelector(".cm-live-complex-block")).toBeNull();
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("| 이름 | 상태 |");
  });

  it("previews and keyboard-opens internal links without turning external URLs into unsafe widgets", () => {
    const onLinkClick = vi.fn();
    const onLinkPreviewInteraction = vi.fn();
    const { container } = render(
      <CodeMirrorMarkdownEditor
        livePreview
        onChange={() => undefined}
        onLinkClick={onLinkClick}
        onLinkPreviewInteraction={onLinkPreviewInteraction}
        value={"\n[[Folder/Note#제목|별칭]] [외부](https://example.com/docs)"}
      />
    );
    const internal = container.querySelector<HTMLElement>(".cm-live-wikilink");
    const external = container.querySelector<HTMLAnchorElement>("a.cm-live-link");

    expect(internal).not.toBeNull();
    expect(internal).toHaveAttribute("role", "link");
    expect(internal).toHaveAttribute("tabindex", "0");
    expect(external).toHaveAttribute("href", "https://example.com/docs");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.mouseOver(internal!);
    expect(onLinkPreviewInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "wikilink", path: "Folder/Note", subpath: "#제목" }),
      expect.objectContaining({ active: true, anchor: internal, source: "pointer" })
    );
    fireEvent.mouseOut(internal!);
    expect(onLinkPreviewInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "wikilink" }),
      expect.objectContaining({ active: false, anchor: internal, source: "pointer" })
    );

    fireEvent.click(internal!);
    expect(onLinkClick).not.toHaveBeenCalled();
    fireEvent.click(internal!, { ctrlKey: true });
    expect(onLinkClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "wikilink", target: "Folder/Note#제목" }),
      expect.objectContaining({ ctrlKey: true })
    );

    internal!.focus();
    fireEvent.keyDown(internal!, { key: "Enter" });
    expect(onLinkClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "wikilink" }),
      expect.objectContaining({ ctrlKey: false, metaKey: false })
    );
  });

  it("exposes the selected line as raw Markdown and disables replacements during IME composition", () => {
    const value = "# 활성 제목\n**둘째 줄**";
    const onRevealHandled = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor
        livePreview
        onChange={() => undefined}
        onRevealHandled={onRevealHandled}
        value={value}
      />
    );

    const editor = screen.getByLabelText("Markdown 편집기");
    expect(editor).toHaveTextContent("# 활성 제목");
    expect(view.container.querySelector(".cm-live-heading")).toBeNull();
    expect(view.container.querySelector(".cm-live-strong")).toHaveTextContent("둘째 줄");

    fireEvent.compositionStart(editor, { data: "한" });
    expect(view.container.querySelector(".cm-live-strong")).toBeNull();
    expect(editor).toHaveTextContent("**둘째 줄**");
    fireEvent.compositionEnd(editor, { data: "한" });
    expect(view.container.querySelector(".cm-live-strong")).toHaveTextContent("둘째 줄");

    view.rerender(
      <CodeMirrorMarkdownEditor
        livePreview
        onChange={() => undefined}
        onRevealHandled={onRevealHandled}
        revealRequest={{ id: 12, line: 2 }}
        value={value}
      />
    );

    expect(onRevealHandled).toHaveBeenCalledWith(12);
    expect(view.container.querySelector(".cm-live-heading")).toHaveTextContent("활성 제목");
    expect(view.container.querySelector(".cm-live-strong")).toBeNull();
    expect(editor).toHaveTextContent("**둘째 줄**");
  });

  it("toggles a rendered task checkbox by changing the canonical Markdown", () => {
    const onChange = vi.fn();
    render(
      <CodeMirrorMarkdownEditor livePreview onChange={onChange} value={"\n- [ ] 실제 원문"} />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "완료하지 않은 작업" }));

    expect(onChange).toHaveBeenCalledWith("\n- [x] 실제 원문");
  });

  it("keeps live task widgets disabled while the note is read-only", () => {
    const onChange = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor livePreview onChange={onChange} readOnly value={"\n- [ ] 잠긴 작업"} />
    );

    const checkbox = screen.getByRole("checkbox", { name: "완료하지 않은 작업" });
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();

    view.rerender(
      <CodeMirrorMarkdownEditor livePreview onChange={onChange} value={"\n- [ ] 잠긴 작업"} />
    );
    expect(screen.getByRole("checkbox", { name: "완료하지 않은 작업" })).toBeEnabled();
  });
});
