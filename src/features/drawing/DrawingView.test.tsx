import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrawingView } from "./DrawingView";
import {
  createDrawingSource,
  parseDrawingSource,
  serializeDrawingDocument,
  type DrawingDocument
} from "./model";

const downloadBlobMock = vi.hoisted(() => vi.fn());

vi.mock("../vault/browserDownload", () => ({
  downloadBlob: downloadBlobMock
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  downloadBlobMock.mockReset();
});

const rectangleDocument: DrawingDocument = {
  elements: [{
    color: "#8b5cf6",
    end: { x: 30, y: 40 },
    id: "rectangle-a",
    start: { x: 10, y: 20 },
    strokeWidth: 2,
    type: "rectangle"
  }],
  version: 1
};

function rectangleSource() {
  const source = createDrawingSource();
  return serializeDrawingDocument(source, rectangleDocument);
}

function ControlledDrawing({
  initialSource,
  onChange = () => undefined,
  onExportSvg,
  readOnly = false
}: {
  initialSource: string;
  onChange?: (source: string) => void;
  onExportSvg?: (artifact: { filename: string; svg: string }) => void;
  readOnly?: boolean;
}) {
  const [source, setSource] = useState(initialSource);
  return (
    <DrawingView
      onChange={(nextSource) => {
        onChange(nextSource);
        setSource(nextSource);
      }}
      onExportSvg={onExportSvg}
      readOnly={readOnly}
      source={source}
    />
  );
}

function canvas() {
  const element = screen.getByRole("application", { name: "Drawing 캔버스" });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom: 700,
    height: 700,
    left: 0,
    right: 1000,
    top: 0,
    width: 1000,
    x: 0,
    y: 0,
    toJSON: () => ({})
  });
  return element;
}

function selectRectangle(element: HTMLElement, pointerId = 1) {
  fireEvent.pointerDown(element, { button: 0, clientX: 20, clientY: 30, pointerId });
  fireEvent.pointerUp(element, { button: 0, clientX: 20, clientY: 30, pointerId });
}

describe("DrawingView", () => {
  it("adds safe SVG text and emits the Markdown source", () => {
    const onChange = vi.fn();
    render(<ControlledDrawing initialSource={createDrawingSource()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "텍스트" }));
    fireEvent.change(screen.getByRole("textbox", { name: "배치할 텍스트" }), { target: { value: "<script>alert(1)</script>" } });
    fireEvent.pointerDown(canvas(), { button: 0, clientX: 1, clientY: 1, pointerId: 1 });
    const emitted = onChange.mock.calls[0]?.[0] as string;
    expect(parseDrawingSource(emitted).document?.elements[0]).toMatchObject({ text: "<script>alert(1)</script>", type: "text" });
    expect(document.querySelector("foreignObject, iframe, img, script")).toBeNull();
  });

  it("selects and moves an element with one history commit on pointer release", () => {
    const onChange = vi.fn();
    render(<ControlledDrawing initialSource={rectangleSource()} onChange={onChange} />);
    const drawingCanvas = canvas();
    selectRectangle(drawingCanvas);

    fireEvent.pointerDown(drawingCanvas, { button: 0, clientX: 20, clientY: 30, pointerId: 2 });
    fireEvent.pointerMove(drawingCanvas, { clientX: 30, clientY: 40, pointerId: 2 });
    fireEvent.pointerMove(drawingCanvas, { clientX: 31, clientY: 41, pointerId: 2 });
    fireEvent.pointerMove(drawingCanvas, { clientX: 30, clientY: 40, pointerId: 2 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(drawingCanvas, { button: 0, clientX: 30, clientY: 40, pointerId: 2 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(parseDrawingSource(onChange.mock.calls[0][0]).document?.elements[0]).toMatchObject({
      end: { x: 40, y: 50 },
      start: { x: 20, y: 30 }
    });
    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect(parseDrawingSource(onChange.mock.calls[1][0]).document?.elements[0]).toMatchObject({
      end: { x: 30, y: 40 },
      start: { x: 10, y: 20 }
    });
  });

  it("renders mutable drawing previews without writing history on every move", () => {
    const onChange = vi.fn();
    let publishFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      publishFrame = callback;
      return 1;
    });
    render(<ControlledDrawing initialSource={createDrawingSource()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "선" }));
    const drawingCanvas = canvas();

    fireEvent.pointerDown(drawingCanvas, { button: 0, clientX: 10, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(drawingCanvas, { clientX: 50, clientY: 60, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    act(() => publishFrame?.(0));

    const previewLine = drawingCanvas.querySelector("line.qm-drawing-shape");
    expect(previewLine).toHaveAttribute("x2", "50");
    expect(previewLine).toHaveAttribute("y2", "60");
    fireEvent.pointerUp(drawingCanvas, { button: 0, clientX: 50, clientY: 60, pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("resizes a selected element from a corner handle", () => {
    const onChange = vi.fn();
    render(<ControlledDrawing initialSource={rectangleSource()} onChange={onChange} />);
    const drawingCanvas = canvas();
    selectRectangle(drawingCanvas);

    fireEvent.pointerDown(drawingCanvas, { button: 0, clientX: 10, clientY: 20, pointerId: 2 });
    fireEvent.pointerMove(drawingCanvas, { clientX: 0, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(drawingCanvas, { button: 0, clientX: 0, clientY: 10, pointerId: 2 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(parseDrawingSource(onChange.mock.calls[0][0]).document?.elements[0]).toMatchObject({
      end: { x: 30, y: 40 },
      start: { x: 0, y: 10 }
    });
  });

  it("cancels an in-progress transform with Escape without writing history", () => {
    const onChange = vi.fn();
    render(<ControlledDrawing initialSource={rectangleSource()} onChange={onChange} />);
    const drawingCanvas = canvas();
    selectRectangle(drawingCanvas);

    fireEvent.pointerDown(drawingCanvas, { button: 0, clientX: 20, clientY: 30, pointerId: 2 });
    fireEvent.pointerMove(drawingCanvas, { clientX: 300, clientY: 300, pointerId: 2 });
    fireEvent.keyDown(drawingCanvas, { key: "Escape" });
    fireEvent.pointerUp(drawingCanvas, { button: 0, clientX: 300, clientY: 300, pointerId: 2 });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "실행 취소" })).toBeDisabled();
  });

  it("supports bounded keyboard movement, Escape and deletion", () => {
    const onChange = vi.fn();
    render(<ControlledDrawing initialSource={rectangleSource()} onChange={onChange} />);
    const drawingCanvas = canvas();
    selectRectangle(drawingCanvas);

    fireEvent.keyDown(drawingCanvas, { key: "ArrowRight", repeat: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(drawingCanvas, { key: "ArrowRight", shiftKey: true });
    expect(parseDrawingSource(onChange.mock.calls[0][0]).document?.elements[0]).toMatchObject({
      start: { x: 20, y: 20 }
    });

    fireEvent.keyDown(drawingCanvas, { key: "Escape" });
    fireEvent.keyDown(drawingCanvas, { key: "Delete" });
    expect(onChange).toHaveBeenCalledTimes(1);
    selectRectangle(drawingCanvas, 3);
    fireEvent.keyDown(drawingCanvas, { key: "Backspace" });
    expect(parseDrawingSource(onChange.mock.calls[1][0]).document?.elements).toHaveLength(0);
  });

  it("supports a two-pointer touch zoom gesture without mutating source", () => {
    const onChange = vi.fn();
    render(<ControlledDrawing initialSource={rectangleSource()} onChange={onChange} />);
    const drawingCanvas = canvas();

    fireEvent.pointerDown(drawingCanvas, { button: 0, clientX: 100, clientY: 100, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerDown(drawingCanvas, { button: 0, clientX: 200, clientY: 100, pointerId: 2, pointerType: "touch" });
    fireEvent.pointerMove(drawingCanvas, { clientX: 300, clientY: 100, pointerId: 2, pointerType: "touch" });

    expect(screen.getByRole("status", { name: "확대 비율" })).toHaveTextContent("200%");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not describe a valid reading-mode drawing as corrupt", () => {
    render(<ControlledDrawing initialSource={createDrawingSource()} readOnly />);
    expect(screen.queryByText(/보존할 수 없는 Drawing 데이터/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "펜" })).toBeDisabled();
    expect(screen.getByRole("application", { name: "Drawing 캔버스" })).toHaveAttribute("tabindex", "0");
  });

  it("exports an inert standalone SVG without changing encrypted Markdown", () => {
    const onChange = vi.fn();
    const onExportSvg = vi.fn();
    render(
      <ControlledDrawing
        initialSource={rectangleSource().replace("# Drawing", "# 설계/초안")}
        onChange={onChange}
        onExportSvg={onExportSvg}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "안전한 SVG로 내보내기" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onExportSvg).toHaveBeenCalledWith(expect.objectContaining({
      filename: "설계-초안.svg",
      svg: expect.stringContaining("<rect")
    }));
    expect(onExportSvg.mock.calls[0][0].svg).not.toMatch(/script|foreignObject|href=/iu);
  });

  it("routes the standalone SVG download through the WebKit-safe Blob helper", () => {
    render(<ControlledDrawing initialSource={rectangleSource()} />);

    fireEvent.click(screen.getByRole("button", { name: "안전한 SVG로 내보내기" }));

    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), "Drawing.svg");
    expect((downloadBlobMock.mock.calls[0][0] as Blob).type).toBe("image/svg+xml;charset=utf-8");
  });
});
