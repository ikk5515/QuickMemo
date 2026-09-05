import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { VAULT_MARKDOWN_IMAGE_ACCEPT } from "./clipboardImagePaste";
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

  it("does not roll back a newer local document when a controlled value arrives one render behind", async () => {
    let finishPaste: ((source: string) => void) | undefined;
    const onChange = vi.fn();
    const onPasteImages = vi.fn(() => new Promise<string>((resolve) => {
      finishPaste = resolve;
    }));
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="이전 값"
        valueRevision={1}
      />
    );

    fireEvent.paste(screen.getByLabelText("Markdown 편집기"), {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });
    await act(async () => {
      finishPaste?.("![[붙여넣은 이미지.png]]");
      await Promise.resolve();
    });

    expect(onPasteImages).toHaveBeenCalledWith(
      [image],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(onChange).toHaveBeenLastCalledWith("![[붙여넣은 이미지.png]]이전 값");
    expect(screen.getByLabelText("Markdown 편집기"))
      .toHaveTextContent("![[붙여넣은 이미지.png]]이전 값");

    view.rerender(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="이전 값"
        valueRevision={1}
      />
    );
    expect(screen.getByLabelText("Markdown 편집기"))
      .toHaveTextContent("![[붙여넣은 이미지.png]]이전 값");

    view.rerender(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="![[붙여넣은 이미지.png]]이전 값"
        valueRevision={1}
      />
    );
    view.rerender(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="확정된 원격 값"
        valueRevision={2}
      />
    );
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("확정된 원격 값");
  });

  it("accepts an authoritative remote value while a local acknowledgement is pending", async () => {
    const onChange = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor
        insertRequest={{ id: 1, text: "로컬 " }}
        onChange={onChange}
        value="본문"
        valueRevision={4}
      />
    );

    expect(onChange).toHaveBeenLastCalledWith("로컬 본문");
    view.rerender(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        value="원격 확정"
        valueRevision={5}
      />
    );
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("원격 확정");

    view.rerender(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        value="로컬 본문"
        valueRevision={5}
      />
    );
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("원격 확정");
  });

  it("keeps a pending image paste across a revision-only autosave acknowledgement", async () => {
    let finishPaste: ((source: string) => void) | undefined;
    let pasteSignal: AbortSignal | undefined;
    const onChange = vi.fn();
    const onPasteImages = vi.fn((_files: readonly File[], context: { signal: AbortSignal }) => {
      pasteSignal = context.signal;
      return new Promise<string>((resolve) => {
        finishPaste = resolve;
      });
    });
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        documentKey="note-a"
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="저장된 본문"
        valueRevision={1}
      />
    );
    fireEvent.paste(screen.getByLabelText("Markdown 편집기"), {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });

    view.rerender(
      <CodeMirrorMarkdownEditor
        documentKey="note-a"
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="저장된 본문"
        valueRevision={2}
      />
    );
    expect(pasteSignal?.aborted).toBe(false);

    await act(async () => {
      finishPaste?.("![[이미지.png]]");
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith("![[이미지.png]]저장된 본문");
  });

  it.each([false, true])("keeps the editor and pending image upload when changing Source/Live mode (from live=%s)", async (livePreview) => {
    let finishPaste!: (result: { onCommit: () => Promise<boolean>; onDiscard: () => void; source: string }) => void;
    let pasteSignal!: AbortSignal;
    const onChange = vi.fn();
    const onCommit = vi.fn().mockResolvedValue(true);
    const onDiscard = vi.fn();
    const onPasteImages = vi.fn((_files: readonly File[], context: { signal: AbortSignal }) => {
      pasteSignal = context.signal;
      return new Promise<{ onCommit: () => Promise<boolean>; onDiscard: () => void; source: string }>((resolve) => { finishPaste = resolve; });
    });
    const image = new File([new Uint8Array([1])], "upload.png", { type: "image/png" });
    const props = { documentKey: "note-a", onChange, onPasteImages, value: "본문", valueRevision: 1 };
    const view = render(<CodeMirrorMarkdownEditor {...props} autoFocus={!livePreview} livePreview={livePreview} />);
    const editor = screen.getByLabelText("Markdown 편집기");
    fireEvent.paste(editor, {
      clipboardData: { files: [image], getData: () => "", items: [{ getAsFile: () => image, kind: "file", type: "image/png" }] }
    });

    view.rerender(<CodeMirrorMarkdownEditor {...props} autoFocus={livePreview} livePreview={!livePreview} />);
    expect(pasteSignal.aborted).toBe(false);
    expect(screen.getByLabelText("Markdown 편집기")).toBe(editor);
    await act(async () => {
      finishPaste({ onCommit, onDiscard, source: "![[붙여넣은 이미지/완료.png]]" });
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith("![[붙여넣은 이미지/완료.png]]본문");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("preserves the editing position and undo history across Source and Live Preview transitions", () => {
    const source = "# 제목\n**본문**";
    const onChange = vi.fn();
    const props = { documentKey: "mode-selection", onChange, value: source };
    const view = render(<CodeMirrorMarkdownEditor {...props} autoFocus />);
    const editor = screen.getByLabelText("Markdown 편집기");
    const codeMirror = EditorView.findFromDOM(editor)!;
    act(() => codeMirror.dispatch({
      changes: { from: source.length, insert: " 추가" },
      selection: { anchor: source.length + 3 },
      userEvent: "input.type"
    }));
    const position = codeMirror.state.selection.main.head;
    const editedSource = codeMirror.state.doc.toString();

    view.rerender(<CodeMirrorMarkdownEditor {...props} livePreview />);
    expect(screen.getByLabelText("Markdown 편집기")).toBe(editor);
    expect(EditorView.findFromDOM(editor)).toBe(codeMirror);
    expect(codeMirror.state.selection.main.head).toBe(position);
    expect(codeMirror.state.doc.toString()).toBe(editedSource);
    expect(view.container.querySelector(".cm-live-heading")).toHaveTextContent("제목");
    expect(view.container.querySelector(".cm-live-strong")).toBeNull();
    expect(editor).toHaveTextContent("**본문** 추가");
    expect(onChange).toHaveBeenCalledTimes(1);

    view.rerender(<CodeMirrorMarkdownEditor {...props} autoFocus />);
    expect(EditorView.findFromDOM(editor)).toBe(codeMirror);
    expect(codeMirror.state.selection.main.head).toBe(position);
    expect(editor).toHaveTextContent("# 제목");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(codeMirror.state.doc.toString()).toBe(source);
    expect(onChange).toHaveBeenLastCalledWith(source);
  });

  it("still cancels a pending image upload on actual editor unmount", async () => {
    let finishPaste!: (result: { onDiscard: () => void; source: string }) => void;
    let pasteSignal!: AbortSignal;
    const onChange = vi.fn();
    const onDiscard = vi.fn();
    const onPasteImages = vi.fn((_files: readonly File[], context: { signal: AbortSignal }) => {
      pasteSignal = context.signal;
      return new Promise<{ onDiscard: () => void; source: string }>((resolve) => { finishPaste = resolve; });
    });
    const image = new File([new Uint8Array([1])], "upload.png", { type: "image/png" });
    const view = render(<CodeMirrorMarkdownEditor autoFocus documentKey="note-a" onChange={onChange} onPasteImages={onPasteImages} value="본문" />);
    fireEvent.paste(screen.getByLabelText("Markdown 편집기"), {
      clipboardData: { files: [image], getData: () => "", items: [{ getAsFile: () => image, kind: "file", type: "image/png" }] }
    });
    view.unmount();
    expect(pasteSignal.aborted).toBe(true);
    await act(async () => {
      finishPaste({ onDiscard, source: "![[취소할 이미지.png]]" });
      await Promise.resolve();
    });
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restores the exact selected text when image source persistence is not confirmed", async () => {
    let finishCommit: ((accepted: boolean) => void) | undefined;
    const onChange = vi.fn();
    const onCommit = vi.fn(() => new Promise<boolean>((resolve) => {
      finishCommit = resolve;
    }));
    const onPasteImages = vi.fn(async () => ({
      onCommit,
      source: "![[붙여넣은 이미지/선택 복구 -1.png]]"
    }));
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    render(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="선택된 원문"
      />
    );
    const editor = screen.getByLabelText("Markdown 편집기");
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(editor).toHaveTextContent("![[붙여넣은 이미지/선택 복구 -1.png]]");

    await act(async () => {
      finishCommit?.(false);
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("선택된 원문");
    expect(editor).toHaveTextContent("선택된 원문");
  });

  it("requests a parent CAS rollback when the source document unmounts during commit", async () => {
    let finishCommit: ((accepted: boolean) => void) | undefined;
    const onRollback = vi.fn().mockReturnValue(true);
    const onSettled = vi.fn();
    const onPasteImages = vi.fn(async () => ({
      onCommit: () => new Promise<boolean>((resolve) => {
        finishCommit = resolve;
      }),
      onRollback,
      onSettled,
      source: "![[붙여넣은 이미지/전환 복구 -1.png]]"
    }));
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        documentKey="note-a"
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        value="교체 전 원문"
        valueRevision={1}
      />
    );
    const editor = screen.getByLabelText("Markdown 편집기");
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });
    await act(async () => Promise.resolve());

    view.rerender(
      <CodeMirrorMarkdownEditor
        documentKey="note-b"
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        value="다른 노트"
        valueRevision={2}
      />
    );
    await act(async () => {
      finishCommit?.(false);
      await Promise.resolve();
    });

    expect(onRollback).toHaveBeenCalledWith({
      replacementText: "교체 전 원문",
      source: "![[붙여넣은 이미지/전환 복구 -1.png]]"
    });
    expect(onSettled).toHaveBeenCalledWith("rolled-back");
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("다른 노트");
  });

  it("acknowledges an earlier local value without rolling back a newer queued edit", () => {
    const onChange = vi.fn();
    const view = render(
      <CodeMirrorMarkdownEditor
        insertRequest={{ id: 1, text: "가" }}
        onChange={onChange}
        value="본문"
        valueRevision={3}
      />
    );
    view.rerender(
      <CodeMirrorMarkdownEditor
        insertRequest={{ id: 2, text: "나" }}
        onChange={onChange}
        value="본문"
        valueRevision={3}
      />
    );
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("가나본문");

    view.rerender(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        value="가본문"
        valueRevision={3}
      />
    );
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("가나본문");
  });

  it("keeps edits made while an encrypted image is being created", async () => {
    let finishPaste: ((source: string) => void) | undefined;
    const onChange = vi.fn();
    const onPasteImages = () => new Promise<string>((resolve) => {
      finishPaste = resolve;
    });
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="본문"
      />
    );

    fireEvent.paste(screen.getByLabelText("Markdown 편집기"), {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });
    view.rerender(
      <CodeMirrorMarkdownEditor
        insertRequest={{ id: 4, text: "[[노트]] " }}
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="본문"
      />
    );
    await act(async () => {
      finishPaste?.("![[붙여넣은 이미지.png]] ");
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenLastCalledWith(
      "![[붙여넣은 이미지.png]] [[노트]] 본문"
    );
  });

  it("never deletes replacement input made inside the original selection while image persistence waits", async () => {
    let finishPaste: ((result: { onDiscard: () => void; source: string }) => void) | undefined;
    let pasteSignal: AbortSignal | undefined;
    const onChange = vi.fn();
    const onDiscard = vi.fn();
    const onPasteImages = vi.fn((_files: readonly File[], context: { signal: AbortSignal }) => {
      pasteSignal = context.signal;
      return new Promise<{ onDiscard: () => void; source: string }>((resolve) => {
        finishPaste = resolve;
      });
    });
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        documentKey="note-a"
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="선택된 본문"
        valueRevision={1}
      />
    );
    const editor = screen.getByLabelText("Markdown 편집기");
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });

    view.rerender(
      <CodeMirrorMarkdownEditor
        documentKey="note-a"
        insertRequest={{ id: 7, text: "대체 입력" }}
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="선택된 본문"
        valueRevision={1}
      />
    );
    expect(pasteSignal?.aborted).toBe(true);
    expect(editor).toHaveTextContent("대체 입력");

    await act(async () => {
      finishPaste?.({ onDiscard, source: "![[늦게 완료된 이미지.png]]" });
      await Promise.resolve();
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(editor).toHaveTextContent("대체 입력");
    expect(editor).not.toHaveTextContent("늦게 완료된 이미지");
  });

  it("cancels a pending paste and discards its asset result when the document changes", async () => {
    let finishPaste: ((result: { onDiscard: () => void; source: string }) => void) | undefined;
    let pasteSignal: AbortSignal | undefined;
    const onDiscard = vi.fn();
    const onPasteImages = vi.fn((_files: readonly File[], context: { signal: AbortSignal }) => {
      pasteSignal = context.signal;
      return new Promise<{ onDiscard: () => void; source: string }>((resolve) => {
        finishPaste = resolve;
      });
    });
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        documentKey="note-a"
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        value="첫 노트"
        valueRevision={1}
      />
    );
    fireEvent.paste(screen.getByLabelText("Markdown 편집기"), {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });

    view.rerender(
      <CodeMirrorMarkdownEditor
        documentKey="note-b"
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        value="둘째 노트"
        valueRevision={2}
      />
    );
    expect(pasteSignal?.aborted).toBe(true);

    await act(async () => {
      finishPaste?.({ onDiscard, source: "![[고아 이미지.png]]" });
      await Promise.resolve();
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("둘째 노트");
    expect(screen.getByLabelText("Markdown 편집기")).not.toHaveTextContent("고아 이미지");
  });

  it("does not invoke image persistence from a read-only editor", () => {
    const onPasteImages = vi.fn();
    const image = new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" });
    render(
      <CodeMirrorMarkdownEditor
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        readOnly
        value="잠긴 본문"
      />
    );

    fireEvent.paste(screen.getByLabelText("Markdown 편집기"), {
      clipboardData: {
        files: [image],
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }]
      }
    });

    expect(onPasteImages).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Markdown 편집기")).toHaveTextContent("잠긴 본문");
  });

  it.each([false, true])(
    "selects image files through the shared Source/Live editor path (livePreview=%s)",
    async (livePreview) => {
      const onChange = vi.fn();
      const onPasteImages = vi.fn(async () => "![[선택한 이미지.png]]");
      const image = new File([new Uint8Array([1])], "selected.png", { type: "image/png" });
      const view = render(
        <CodeMirrorMarkdownEditor
          livePreview={livePreview}
          onChange={onChange}
          onPasteImages={onPasteImages}
          value="본문"
        />
      );

      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).not.toBeNull();
      if (!input) throw new Error("이미지 파일 입력을 찾지 못했습니다.");
      expect(input).toHaveAttribute("accept", VAULT_MARKDOWN_IMAGE_ACCEPT);
      expect(input).toHaveAttribute("multiple");
      expect(screen.getByText("PNG · JPG · WebP · 최대 8개 · 파일당 32MB · 합계 64MB"))
        .toBeInTheDocument();
      const button = screen.getByRole("button", { name: "이미지 파일 추가" });
      expect(button).toBeEnabled();
      await act(async () => {
        fireEvent.click(button);
        fireEvent.change(input, { target: { files: [image] } });
        await Promise.resolve();
      });

      expect(onPasteImages).toHaveBeenCalledWith(
        [image],
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(onChange).toHaveBeenLastCalledWith("![[선택한 이미지.png]]본문");
      expect(input).toHaveValue("");

      await act(async () => {
        fireEvent.click(button);
        fireEvent.change(input, { target: { files: [image] } });
        await Promise.resolve();
      });
      expect(onPasteImages).toHaveBeenCalledTimes(2);
      expect(input).toHaveValue("");
    }
  );

  it("uploads a dropped image at the drop position through the shared encrypted handler", async () => {
    const onChange = vi.fn();
    const onPasteImages = vi.fn(async () => "![[드롭 이미지.png]]");
    const image = new File([new Uint8Array([1])], "dropped.png", { type: "image/png" });
    render(
      <CodeMirrorMarkdownEditor
        onChange={onChange}
        onPasteImages={onPasteImages}
        value="본문"
      />
    );
    const editor = screen.getByLabelText("Markdown 편집기");
    const dataTransfer = {
      dropEffect: "none",
      files: [image],
      items: [{ getAsFile: () => image, kind: "file", type: "image/png" }],
      types: ["Files"]
    };

    fireEvent.dragOver(editor, { dataTransfer });
    await act(async () => {
      fireEvent.drop(editor, { clientX: 0, clientY: 0, dataTransfer });
      await Promise.resolve();
    });

    expect(dataTransfer.dropEffect).toBe("copy");
    expect(onPasteImages).toHaveBeenCalledWith(
      [image],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(onChange).toHaveBeenLastCalledWith("![[드롭 이미지.png]]본문");
  });

  it("leaves a text drop to CodeMirror without starting image persistence", () => {
    const onPasteImages = vi.fn();
    render(
      <CodeMirrorMarkdownEditor
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        value="본문"
      />
    );
    const dataTransfer = {
      dropEffect: "none",
      files: [],
      getData: () => "텍스트",
      items: [{ getAsFile: () => null, kind: "string", type: "text/plain" }],
      types: ["text/plain"]
    };
    const editor = screen.getByLabelText("Markdown 편집기");

    fireEvent.dragOver(editor, { dataTransfer });
    fireEvent.drop(editor, { dataTransfer });

    expect(dataTransfer.dropEffect).toBe("none");
    expect(onPasteImages).not.toHaveBeenCalled();
  });

  it("blocks picker and image-drop writes while read-only", () => {
    const onPasteImages = vi.fn();
    const image = new File([new Uint8Array([1])], "dropped.png", { type: "image/png" });
    const view = render(
      <CodeMirrorMarkdownEditor
        onChange={() => undefined}
        onPasteImages={onPasteImages}
        readOnly
        value="잠긴 본문"
      />
    );
    const editor = screen.getByLabelText("Markdown 편집기");
    const button = screen.getByRole("button", { name: "이미지 파일 추가" });
    expect(button).toBeDisabled();

    fireEvent.drop(editor, {
      dataTransfer: {
        files: [image],
        items: [{ getAsFile: () => image, kind: "file", type: "image/png" }],
        types: ["Files"]
      }
    });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("이미지 파일 입력을 찾지 못했습니다.");
    fireEvent.change(input, {
      target: { files: [image] }
    });

    expect(onPasteImages).not.toHaveBeenCalled();
    expect(editor).toHaveTextContent("잠긴 본문");
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
