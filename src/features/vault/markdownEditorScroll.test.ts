import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { captureMarkdownEditorScroll } from "./markdownEditorScroll";

function setup() {
  const dom = document.createElement("div");
  const contentDOM = dom.appendChild(document.createElement("div"));
  const line = contentDOM.appendChild(document.createElement("div"));
  line.className = "cm-line";
  document.body.append(dom);
  Object.defineProperties(dom, { clientHeight: { configurable: true, value: 400 }, clientWidth: { configurable: true, value: 600 } });
  dom.scrollTop = 223;
  let top = 193.25;
  vi.spyOn(line, "getBoundingClientRect").mockImplementation(() => ({ top, height: 27 }) as DOMRect);
  const effect = () => EditorView.scrollIntoView(80) as ReturnType<EditorView["scrollSnapshot"]>;
  const view = {
    dom, contentDOM, scrollDOM: dom,
    domAtPos: vi.fn(() => ({ node: line, offset: 0 })),
    scrollSnapshot: vi.fn(effect),
    requestMeasure: vi.fn(),
    lineBlockAtHeight: vi.fn(() => { top -= 13; dom.scrollTop += 13; })
  };
  return { view, editor: view as unknown as EditorView, dom, line };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("captureMarkdownEditorScroll", () => {
  it("keeps the same visible line offset when a public height measurement moves the scroll DOM", () => {
    const { view, editor } = setup();
    const captured = captureMarkdownEditorScroll(editor);
    expect(view.lineBlockAtHeight).toHaveBeenCalledExactlyOnceWith(223);
    expect(view.domAtPos).toHaveBeenNthCalledWith(1, 80);
    expect(view.domAtPos).toHaveBeenNthCalledWith(2, 80);
    expect(captured.scrollTop).toBe(223);
    expect(view.scrollDOM.scrollTop).toBe(223);
    expect(captured.scrollSnapshot).toBe(view.scrollSnapshot.mock.results[1].value);
    expect(Object.values(captured)).not.toContain(view.dom);
  });

  it.each(["detached", "hidden"])("does not measure a %s editor", (mode) => {
    const { view, editor, dom } = setup();
    if (mode === "detached") dom.remove();
    else Object.defineProperty(dom, "clientHeight", { value: 0 });
    const captured = captureMarkdownEditorScroll(editor);
    expect(captured.scrollTop).toBe(223);
    expect(captured.scrollSnapshot).toBe(view.scrollSnapshot.mock.results[0].value);
    expect(view.requestMeasure).not.toHaveBeenCalled();
    expect(view.domAtPos).not.toHaveBeenCalled();
  });

  it("keeps the safe original snapshot when no measurable text line exists", () => {
    const { view, editor, line } = setup();
    line.className = "cm-widget";
    expect(captureMarkdownEditorScroll(editor).scrollTop).toBe(223);
    expect(view.requestMeasure).not.toHaveBeenCalled();
  });

  it("restores the original coordinates and returns normally if layout is unavailable during an update", () => {
    const { view, editor } = setup();
    view.lineBlockAtHeight.mockImplementation(() => { view.scrollDOM.scrollTop = 900; throw new Error("Reading the editor layout isn't allowed during an update"); });
    const captured = captureMarkdownEditorScroll(editor);
    expect(captured.scrollTop).toBe(223);
    expect(view.scrollDOM.scrollTop).toBe(223);
    expect(captured.scrollSnapshot).toBe(view.scrollSnapshot.mock.results[0].value);
  });

  it("keeps fallback coordinates when the referenced line disappears during measurement", () => {
    const { view, editor, line } = setup();
    view.lineBlockAtHeight.mockImplementation(() => { view.scrollDOM.scrollTop = 900; line.remove(); });
    const captured = captureMarkdownEditorScroll(editor);
    expect(captured.scrollTop).toBe(223);
    expect(view.scrollDOM.scrollTop).toBe(223);
    expect(captured.scrollSnapshot).toBe(view.scrollSnapshot.mock.results[0].value);
  });

  it("returns raw coordinates if snapshot capture fails so normal session destruction can continue", () => {
    const { view, editor } = setup();
    view.scrollSnapshot.mockImplementation(() => { throw new Error("disposed"); });
    expect(captureMarkdownEditorScroll(editor)).toEqual({ scrollTop: 223, scrollLeft: 0 });
    expect(view.requestMeasure).not.toHaveBeenCalled();
  });
});
