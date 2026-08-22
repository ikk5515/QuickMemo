import {
  ArrowRight,
  Circle,
  Download,
  Eraser,
  Hand,
  Minus,
  MousePointer2,
  PenTool,
  Redo2,
  Square,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  clampDrawingCoordinate,
  drawingElementBounds,
  drawingElementHit,
  drawingElementsEqual,
  drawingResizeHandlePoints,
  resizeDrawingElement,
  translateDrawingElement,
  type DrawingResizeHandle
} from "./geometry";
import {
  parseDrawingSource,
  serializeDrawingDocument,
  type DrawingDocument,
  type DrawingElement,
  type DrawingPoint
} from "./model";
import {
  createDrawingHistory,
  drawingHistoryCounts,
  recordDrawingHistory,
  redoDrawingHistory,
  undoDrawingHistory
} from "./history";
import { drawingDocumentToSvg, safeDrawingExportFilename } from "./export";
import "./drawing.css";

type DrawingTool = "select" | "pen" | "line" | "rectangle" | "ellipse" | "arrow" | "text" | "eraser" | "pan";
interface Viewport { x: number; y: number; zoom: number }
interface ClientPoint { clientX: number; clientY: number }
interface PanGesture extends ClientPoint { pointerId: number; x: number; y: number }
interface SelectionGesture {
  handle?: DrawingResizeHandle;
  kind: "move" | "resize";
  original: DrawingElement;
  pointerId: number;
  start: DrawingPoint;
}
interface PinchGesture {
  anchor: DrawingPoint;
  distance: number;
  pointerIds: [number, number];
  viewport: Viewport;
}

const MAX_LIVE_PEN_POINTS = 25_000;
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const HANDLE_ORDER: DrawingResizeHandle[] = ["nw", "ne", "se", "sw"];

const tools: Array<{ icon: ReactNode; label: string; value: DrawingTool }> = [
  { icon: <MousePointer2 size={16} />, label: "선택", value: "select" },
  { icon: <PenTool size={16} />, label: "펜", value: "pen" },
  { icon: <Minus size={16} />, label: "선", value: "line" },
  { icon: <Square size={16} />, label: "사각형", value: "rectangle" },
  { icon: <Circle size={16} />, label: "타원", value: "ellipse" },
  { icon: <ArrowRight size={16} />, label: "화살표", value: "arrow" },
  { icon: <Type size={16} />, label: "텍스트", value: "text" },
  { icon: <Eraser size={16} />, label: "지우개", value: "eraser" },
  { icon: <Hand size={16} />, label: "이동", value: "pan" }
];

function nextId(type: string) {
  return `${type}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`.slice(0, 120);
}

function withBase(type: DrawingElement["type"], color: string, strokeWidth: number) {
  return { color, id: nextId(type), strokeWidth };
}

function cloneDocument(document: DrawingDocument): DrawingDocument {
  return { version: 1, elements: [...document.elements] };
}

function cloneDrawingElement(element: DrawingElement): DrawingElement {
  if (element.type === "pen") {
    return { ...element, points: element.points.map((point) => ({ ...point })) };
  }
  if (element.type === "text") {
    return { ...element, point: { ...element.point } };
  }
  return { ...element, end: { ...element.end }, start: { ...element.start } };
}

function pointDistance(left: DrawingPoint, right: DrawingPoint) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function boundedClientPoint(point: ClientPoint): ClientPoint {
  return {
    clientX: clampDrawingCoordinate(point.clientX),
    clientY: clampDrawingCoordinate(point.clientY)
  };
}

function boundedZoom(value: number) {
  return Number.isFinite(value) ? Math.min(8, Math.max(0.25, value)) : 1;
}

function replaceElement(document: DrawingDocument, element: DrawingElement) {
  const index = document.elements.findIndex((candidate) => candidate.id === element.id);
  if (index < 0) throw new Error("선택한 Drawing 요소가 변경되어 저장하지 못했습니다.");
  document.elements[index] = element;
}

function selectedHandleAt(element: DrawingElement, point: DrawingPoint, zoom: number) {
  const handles = drawingResizeHandlePoints(drawingElementBounds(element));
  const tolerance = Math.max(4, 12 / zoom);
  return HANDLE_ORDER.find((handle) => pointDistance(handles[handle], point) <= tolerance) ?? null;
}

function clientPointToCanvas(
  svg: SVGSVGElement,
  clientPoint: ClientPoint,
  viewport: Viewport
): DrawingPoint {
  const bounds = svg.getBoundingClientRect();
  const width = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 1;
  const height = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 1;
  const clientX = Number.isFinite(clientPoint.clientX) ? clientPoint.clientX : bounds.left;
  const clientY = Number.isFinite(clientPoint.clientY) ? clientPoint.clientY : bounds.top;
  return {
    x: clampDrawingCoordinate(viewport.x + ((clientX - bounds.left) / width) * (1000 / viewport.zoom)),
    y: clampDrawingCoordinate(viewport.y + ((clientY - bounds.top) / height) * (700 / viewport.zoom))
  };
}

export interface DrawingViewProps {
  onChange: (source: string) => void;
  onExportSvg?: (artifact: { filename: string; svg: string }) => void;
  readOnly?: boolean;
  source: string;
}

export function DrawingView({ onChange, onExportSvg, readOnly = false, source }: DrawingViewProps) {
  const parsed = useMemo(() => parseDrawingSource(source), [source]);
  const [tool, setTool] = useState<DrawingTool>("select");
  const [color, setColor] = useState("#8b5cf6");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [textValue, setTextValue] = useState("텍스트");
  const [preview, setPreview] = useState<DrawingElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<DrawingElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [message, setMessage] = useState("");
  const [historyCounts, setHistoryCounts] = useState({ future: 0, past: 0 });
  const instructionsId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const previewRef = useRef<DrawingElement | null>(null);
  const selectionPreviewRef = useRef<DrawingElement | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const startRef = useRef<DrawingPoint | null>(null);
  const drawPointerIdRef = useRef<number | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const selectionGestureRef = useRef<SelectionGesture | null>(null);
  const pointerPositionsRef = useRef(new Map<number, ClientPoint>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const historyRef = useRef(createDrawingHistory());
  const lastEmittedRef = useRef<string | null>(null);
  const document = parsed.document;
  const locked = readOnly || parsed.readOnly;
  const selectedElement = useMemo(
    () => document?.elements.find((element) => element.id === selectedId) ?? null,
    [document, selectedId]
  );
  const renderedSelection = selectionPreview ?? selectedElement;

  const clearScheduledPreview = useCallback(() => {
    if (previewFrameRef.current === null) return;
    window.cancelAnimationFrame?.(previewFrameRef.current);
    window.clearTimeout(previewFrameRef.current);
    previewFrameRef.current = null;
  }, []);

  const clearTransientInteraction = useCallback(() => {
    clearScheduledPreview();
    previewRef.current = null;
    selectionPreviewRef.current = null;
    startRef.current = null;
    drawPointerIdRef.current = null;
    panRef.current = null;
    selectionGestureRef.current = null;
    pinchRef.current = null;
    setPreview(null);
    setSelectionPreview(null);
  }, [clearScheduledPreview]);

  useEffect(() => {
    if (lastEmittedRef.current === source) {
      lastEmittedRef.current = null;
      return;
    }
    clearScheduledPreview();
    historyRef.current = createDrawingHistory();
    setHistoryCounts({ future: 0, past: 0 });
    setSelectedId(null);
    previewRef.current = null;
    selectionPreviewRef.current = null;
    startRef.current = null;
    drawPointerIdRef.current = null;
    panRef.current = null;
    selectionGestureRef.current = null;
    pinchRef.current = null;
    pointerPositionsRef.current.clear();
    setPreview(null);
    setSelectionPreview(null);
  }, [clearScheduledPreview, source]);

  useEffect(() => {
    if (selectedId && document && !document.elements.some((element) => element.id === selectedId)) {
      setSelectedId(null);
      setSelectionPreview(null);
      selectionPreviewRef.current = null;
    }
  }, [document, selectedId]);

  useEffect(() => () => clearScheduledPreview(), [clearScheduledPreview]);

  if (!document) {
    return <section className="qm-drawing-error" role="alert"><h2>Drawing을 열 수 없습니다</h2><ul>{parsed.errors.map((error) => <li key={error}>{error}</li>)}</ul></section>;
  }

  const emit = (nextSource: string, recordHistory = true) => {
    if (recordHistory) recordDrawingHistory(historyRef.current, source);
    lastEmittedRef.current = nextSource;
    setHistoryCounts(drawingHistoryCounts(historyRef.current));
    onChange(nextSource);
  };

  const commit = (mutate: (next: DrawingDocument) => void, recordHistory = true) => {
    if (locked) return;
    try {
      const next = cloneDocument(document);
      mutate(next);
      emit(serializeDrawingDocument(source, next), recordHistory);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Drawing을 저장하지 못했습니다.");
    }
  };

  const undo = () => {
    clearTransientInteraction();
    const transition = undoDrawingHistory(historyRef.current, source);
    if (!transition) return;
    emit(transition.source, false);
  };

  const redo = () => {
    clearTransientInteraction();
    const transition = redoDrawingHistory(historyRef.current, source);
    if (!transition) return;
    emit(transition.source, false);
  };

  const canvasPoint = (event: ReactPointerEvent<SVGSVGElement>) => clientPointToCanvas(
    event.currentTarget,
    event,
    viewport
  );

  const schedulePreviewRender = () => {
    if (previewFrameRef.current !== null) return;
    const publish = () => {
      previewFrameRef.current = null;
      const currentPreview = previewRef.current;
      const currentSelection = selectionPreviewRef.current;
      setPreview(currentPreview ? cloneDrawingElement(currentPreview) : null);
      setSelectionPreview(currentSelection ? cloneDrawingElement(currentSelection) : null);
    };
    previewFrameRef.current = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(publish)
      : window.setTimeout(publish, 16);
  };

  const beginPinch = (svg: SVGSVGElement) => {
    const pointers = [...pointerPositionsRef.current.entries()].slice(0, 2);
    if (pointers.length < 2) return false;
    clearTransientInteraction();
    const [[firstId, first], [secondId, second]] = pointers;
    const midpoint = {
      clientX: (first.clientX + second.clientX) / 2,
      clientY: (first.clientY + second.clientY) / 2
    };
    pinchRef.current = {
      anchor: clientPointToCanvas(svg, midpoint, viewport),
      distance: Math.max(1, Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)),
      pointerIds: [firstId, secondId],
      viewport: { ...viewport }
    };
    return true;
  };

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const clientPoint = boundedClientPoint(event);
    pointerPositionsRef.current.set(event.pointerId, clientPoint);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (pointerPositionsRef.current.size >= 2 && beginPinch(event.currentTarget)) {
      event.preventDefault();
      return;
    }
    if (locked || event.button !== 0) return;
    event.preventDefault();
    const point = canvasPoint(event);
    if (tool === "select") {
      const handle = renderedSelection ? selectedHandleAt(renderedSelection, point, viewport.zoom) : null;
      if (renderedSelection && handle) {
        selectionGestureRef.current = {
          handle,
          kind: "resize",
          original: cloneDrawingElement(renderedSelection),
          pointerId: event.pointerId,
          start: point
        };
        return;
      }
      let hit: DrawingElement | null = null;
      for (let index = document.elements.length - 1; index >= 0; index -= 1) {
        if (drawingElementHit(document.elements[index], point, 14 / viewport.zoom)) {
          hit = document.elements[index];
          break;
        }
      }
      setSelectedId(hit?.id ?? null);
      if (hit) {
        selectionGestureRef.current = {
          kind: "move",
          original: cloneDrawingElement(hit),
          pointerId: event.pointerId,
          start: point
        };
      }
      return;
    }
    if (tool === "pan") {
      panRef.current = { ...clientPoint, pointerId: event.pointerId, x: viewport.x, y: viewport.y };
      return;
    }
    if (tool === "eraser") {
      let index = -1;
      for (let candidate = document.elements.length - 1; candidate >= 0; candidate -= 1) {
        if (drawingElementHit(document.elements[candidate], point, 14 / viewport.zoom)) {
          index = candidate;
          break;
        }
      }
      if (index >= 0) {
        const removedId = document.elements[index].id;
        commit((next) => { next.elements.splice(index, 1); });
        if (selectedId === removedId) setSelectedId(null);
      }
      return;
    }
    if (tool === "text") {
      const text = textValue.trim().slice(0, 2_000);
      if (!text) {
        setMessage("먼저 툴바에 텍스트를 입력하세요.");
      } else {
        commit((next) => { next.elements.push({ ...withBase("text", color, strokeWidth), point, text, type: "text" }); });
      }
      return;
    }
    startRef.current = point;
    drawPointerIdRef.current = event.pointerId;
    const common = withBase(tool, color, strokeWidth);
    const nextPreview: DrawingElement = tool === "pen"
      ? { ...common, points: [point], type: "pen" }
      : { ...common, end: point, start: point, type: tool };
    previewRef.current = nextPreview;
    setPreview(cloneDrawingElement(nextPreview));
  };

  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const clientPoint = boundedClientPoint(event);
    if (pointerPositionsRef.current.has(event.pointerId)) {
      pointerPositionsRef.current.set(event.pointerId, clientPoint);
    }
    const pinch = pinchRef.current;
    if (pinch) {
      const first = pointerPositionsRef.current.get(pinch.pointerIds[0]);
      const second = pointerPositionsRef.current.get(pinch.pointerIds[1]);
      if (first && second) {
        event.preventDefault();
        const nextDistance = Math.max(1, Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY));
        const nextZoom = boundedZoom(pinch.viewport.zoom * (nextDistance / pinch.distance));
        const bounds = event.currentTarget.getBoundingClientRect();
        const midpoint = {
          x: (first.clientX + second.clientX) / 2,
          y: (first.clientY + second.clientY) / 2
        };
        setViewport({
          x: clampDrawingCoordinate(pinch.anchor.x - ((midpoint.x - bounds.left) / Math.max(1, bounds.width)) * (1000 / nextZoom)),
          y: clampDrawingCoordinate(pinch.anchor.y - ((midpoint.y - bounds.top) / Math.max(1, bounds.height)) * (700 / nextZoom)),
          zoom: nextZoom
        });
      }
      return;
    }
    if (panRef.current?.pointerId === event.pointerId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const scaleX = 1000 / (Math.max(1, bounds.width) * viewport.zoom);
      const scaleY = 700 / (Math.max(1, bounds.height) * viewport.zoom);
      setViewport((current) => ({
        ...current,
        x: clampDrawingCoordinate(panRef.current!.x - (clientPoint.clientX - panRef.current!.clientX) * scaleX),
        y: clampDrawingCoordinate(panRef.current!.y - (clientPoint.clientY - panRef.current!.clientY) * scaleY)
      }));
      return;
    }
    const selectionGesture = selectionGestureRef.current;
    if (selectionGesture?.pointerId === event.pointerId) {
      const point = canvasPoint(event);
      const transformed = selectionGesture.kind === "move"
        ? translateDrawingElement(selectionGesture.original, {
          x: point.x - selectionGesture.start.x,
          y: point.y - selectionGesture.start.y
        })
        : resizeDrawingElement(selectionGesture.original, selectionGesture.handle!, point);
      selectionPreviewRef.current = transformed;
      schedulePreviewRender();
      return;
    }
    const current = previewRef.current;
    if (drawPointerIdRef.current !== event.pointerId || !current || !startRef.current) return;
    const point = canvasPoint(event);
    if (current.type === "pen") {
      const last = current.points[current.points.length - 1];
      if (pointDistance(last, point) < 1.5 || current.points.length >= MAX_LIVE_PEN_POINTS) return;
      current.points.push(point);
    } else if (current.type !== "text") {
      current.end = point;
    }
    schedulePreviewRender();
  };

  const releasePointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    pointerPositionsRef.current.delete(event.pointerId);
  };

  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    releasePointer(event);
    if (pinchRef.current) {
      if (pointerPositionsRef.current.size < 2) pinchRef.current = null;
      return;
    }
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }
    if (selectionGestureRef.current?.pointerId === event.pointerId) {
      const original = selectionGestureRef.current.original;
      const finished = selectionPreviewRef.current;
      selectionGestureRef.current = null;
      selectionPreviewRef.current = null;
      clearScheduledPreview();
      setSelectionPreview(null);
      if (finished && !drawingElementsEqual(original, finished)) {
        commit((next) => replaceElement(next, finished));
      }
      return;
    }
    if (drawPointerIdRef.current !== event.pointerId) return;
    drawPointerIdRef.current = null;
    startRef.current = null;
    clearScheduledPreview();
    const finished = previewRef.current;
    previewRef.current = null;
    if (finished) {
      setPreview(null);
      commit((next) => { next.elements.push(finished); });
    }
  };

  const pointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    releasePointer(event);
    if (pointerPositionsRef.current.size < 2) pinchRef.current = null;
    if (
      drawPointerIdRef.current === event.pointerId
      || panRef.current?.pointerId === event.pointerId
      || selectionGestureRef.current?.pointerId === event.pointerId
    ) clearTransientInteraction();
  };

  const zoom = (factor: number) => setViewport((current) => ({
    ...current,
    zoom: boundedZoom(current.zoom * factor)
  }));

  const canvasWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY > 0 ? 0.9 : 1.1);
  };

  const canvasKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "z") {
      event.preventDefault();
      if (!locked) {
        if (event.shiftKey) redo();
        else undo();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      clearTransientInteraction();
      setSelectedId(null);
      setMessage("");
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId && !locked) {
      event.preventDefault();
      commit((next) => { next.elements = next.elements.filter((element) => element.id !== selectedId); });
      setSelectedId(null);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1.25);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      zoom(0.8);
      return;
    }
    const direction = event.key === "ArrowLeft" ? [-1, 0] : event.key === "ArrowRight" ? [1, 0]
      : event.key === "ArrowUp" ? [0, -1] : event.key === "ArrowDown" ? [0, 1] : null;
    if (!direction) return;
    event.preventDefault();
    if (selectedElement && !locked) {
      if (event.repeat) return;
      const distance = event.shiftKey ? 10 : 1;
      const moved = translateDrawingElement(selectedElement, {
        x: direction[0] * distance,
        y: direction[1] * distance
      });
      commit((next) => replaceElement(next, moved));
      return;
    }
    setViewport((current) => ({
      ...current,
      x: clampDrawingCoordinate(current.x + direction[0] * 32 / current.zoom),
      y: clampDrawingCoordinate(current.y + direction[1] * 32 / current.zoom)
    }));
  };

  const chooseTool = (nextTool: DrawingTool) => {
    clearTransientInteraction();
    setTool(nextTool);
    svgRef.current?.focus({ preventScroll: true });
  };

  const exportSvg = () => {
    try {
      const svg = drawingDocumentToSvg(document);
      const title = source.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? "Drawing";
      const filename = safeDrawingExportFilename(title);
      if (onExportSvg) {
        onExportSvg({ filename, svg });
      } else if (typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
        const anchor = globalThis.document.createElement("a");
        anchor.download = filename;
        anchor.href = url;
        anchor.rel = "noopener noreferrer";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      } else {
        throw new Error("이 브라우저에서는 파일 내보내기를 사용할 수 없습니다.");
      }
      setMessage(`${filename} 내보내기를 준비했습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Drawing을 내보내지 못했습니다.");
    }
  };

  return (
    <section aria-label="QuickMemo Drawing beta" className="qm-drawing">
      <div aria-label="Drawing 도구" className="qm-drawing-toolbar" role="toolbar">
        {tools.map((item) => <button aria-label={item.label} aria-pressed={tool === item.value} disabled={locked} key={item.value} onClick={() => chooseTool(item.value)} title={item.label} type="button">{item.icon}</button>)}
        <label title="선 색상"><span className="sr-only">선 색상</span><input aria-label="선 색상" disabled={locked} onChange={(event) => setColor(event.currentTarget.value)} type="color" value={color} /></label>
        <label title="선 굵기"><span className="sr-only">선 굵기</span><input aria-label="선 굵기" disabled={locked} max={12} min={1} onChange={(event) => setStrokeWidth(Number(event.currentTarget.value))} type="range" value={strokeWidth} /></label>
        {tool === "text" ? <input aria-label="배치할 텍스트" className="qm-drawing-text-input" disabled={locked} maxLength={2_000} onChange={(event) => setTextValue(event.currentTarget.value)} value={textValue} /> : null}
        <span className="qm-drawing-spacer" />
        <button aria-label="실행 취소" disabled={locked || historyCounts.past === 0} onClick={undo} type="button"><Undo2 size={16} /></button>
        <button aria-label="다시 실행" disabled={locked || historyCounts.future === 0} onClick={redo} type="button"><Redo2 size={16} /></button>
        <button aria-label="축소" onClick={() => zoom(0.8)} type="button"><ZoomOut size={16} /></button>
        <output aria-label="확대 비율">{Math.round(viewport.zoom * 100)}%</output>
        <button aria-label="확대" onClick={() => zoom(1.25)} type="button"><ZoomIn size={16} /></button>
        <button aria-label="안전한 SVG로 내보내기" onClick={exportSvg} type="button"><Download size={16} /></button>
      </div>
      {parsed.readOnly ? <div className="qm-drawing-warning" role="status">보존할 수 없는 Drawing 데이터가 있어 읽기 전용입니다. 소스 모드에서 확인하세요.</div> : null}
      {message ? <div className="qm-drawing-warning" role="status">{message}</div> : null}
      <div aria-live="polite" className="sr-only">{selectedElement ? `${selectedElement.type} 요소가 선택되었습니다.` : ""}</div>
      <div className="qm-drawing-stage">
        <svg
          aria-describedby={instructionsId}
          aria-label="Drawing 캔버스"
          data-tool={tool}
          onKeyDown={canvasKeyDown}
          onPointerCancel={pointerCancel}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onWheel={canvasWheel}
          preserveAspectRatio="none"
          ref={svgRef}
          role="application"
          tabIndex={0}
          viewBox={`${viewport.x} ${viewport.y} ${1000 / viewport.zoom} ${700 / viewport.zoom}`}
        >
          <rect fill="var(--vault-surface)" height="100%" width="100%" x={viewport.x} y={viewport.y} />
          <DrawingElementsLayer
            elements={document.elements}
            previewingId={selectionPreview ? selectedId : null}
            selectedId={selectedId}
          />
          {preview ? <DrawingShape element={preview} /> : null}
          {selectionPreview ? <DrawingShape element={selectionPreview} preview /> : null}
          {renderedSelection ? <DrawingSelection element={renderedSelection} zoom={viewport.zoom} /> : null}
        </svg>
      </div>
      <p className="qm-drawing-scope" id={instructionsId}>QuickMemo Drawing beta: 선택 후 끌어서 이동하고 모서리 핸들로 크기를 조절할 수 있습니다. Delete, Escape, 방향키와 두 손가락 확대/이동을 지원하며 이미지 임베드는 지원하지 않습니다.</p>
    </section>
  );
}

interface DrawingShapeProps {
  element: DrawingElement;
  preview?: boolean;
  selected?: boolean;
  transforming?: boolean;
}

const DrawingElementsLayer = memo(function DrawingElementsLayer({
  elements,
  previewingId,
  selectedId
}: {
  elements: readonly DrawingElement[];
  previewingId: string | null;
  selectedId: string | null;
}) {
  return <g>{elements.map((element) => (
    <DrawingShape
      element={element}
      key={element.id}
      selected={element.id === selectedId}
      transforming={element.id === previewingId}
    />
  ))}</g>;
}, (previous, next) => (
  previous.elements === next.elements
  && previous.previewingId === next.previewingId
  && previous.selectedId === next.selectedId
));

const DrawingShape = memo(function DrawingShape({ element, preview, selected, transforming }: DrawingShapeProps) {
  const className = [
    "qm-drawing-shape",
    selected ? "is-selected" : "",
    transforming ? "is-transforming" : "",
    preview ? "is-preview" : ""
  ].filter(Boolean).join(" ");
  const common = {
    className,
    fill: "none",
    stroke: element.color,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: element.strokeWidth,
    vectorEffect: "non-scaling-stroke" as const
  };
  if (element.type === "pen") return <polyline {...common} points={element.points.map((point) => `${point.x},${point.y}`).join(" ")} />;
  if (element.type === "line") return <line {...common} x1={element.start.x} x2={element.end.x} y1={element.start.y} y2={element.end.y} />;
  if (element.type === "rectangle") return <rect {...common} height={Math.abs(element.end.y - element.start.y)} width={Math.abs(element.end.x - element.start.x)} x={Math.min(element.start.x, element.end.x)} y={Math.min(element.start.y, element.end.y)} />;
  if (element.type === "ellipse") return <ellipse {...common} cx={(element.start.x + element.end.x) / 2} cy={(element.start.y + element.end.y) / 2} rx={Math.abs(element.end.x - element.start.x) / 2} ry={Math.abs(element.end.y - element.start.y) / 2} />;
  if (element.type === "text") return <text className={className} fill={element.color} fontSize={Math.max(12, element.strokeWidth * 8)} x={element.point.x} y={element.point.y}>{element.text.split("\n").map((line, index) => <tspan dy={index ? "1.2em" : 0} key={`${element.id}-${index}`} x={element.point.x}>{line}</tspan>)}</text>;
  const angle = Math.atan2(element.end.y - element.start.y, element.end.x - element.start.x);
  const length = 14 + element.strokeWidth * 2;
  const left = { x: element.end.x - Math.cos(angle - Math.PI / 6) * length, y: element.end.y - Math.sin(angle - Math.PI / 6) * length };
  const right = { x: element.end.x - Math.cos(angle + Math.PI / 6) * length, y: element.end.y - Math.sin(angle + Math.PI / 6) * length };
  return <g className={className}><line {...common} x1={element.start.x} x2={element.end.x} y1={element.start.y} y2={element.end.y} /><polyline {...common} points={`${left.x},${left.y} ${element.end.x},${element.end.y} ${right.x},${right.y}`} /></g>;
}, (previous, next) => (
  previous.preview === next.preview
  && previous.selected === next.selected
  && previous.transforming === next.transforming
  && drawingElementsEqual(previous.element, next.element)
));

const DrawingSelection = memo(function DrawingSelection({ element, zoom }: { element: DrawingElement; zoom: number }) {
  const bounds = drawingElementBounds(element);
  const handles = drawingResizeHandlePoints(bounds);
  const handleRadius = Math.max(3, 6 / zoom);
  return (
    <g aria-hidden="true" className="qm-drawing-selection">
      <rect
        height={Math.max(1, bounds.height)}
        width={Math.max(1, bounds.width)}
        x={bounds.x}
        y={bounds.y}
      />
      {HANDLE_ORDER.map((handle) => (
        <circle
          className={`qm-drawing-resize-handle is-${handle}`}
          cx={handles[handle].x}
          cy={handles[handle].y}
          key={handle}
          r={handleRadius}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}, (previous, next) => previous.zoom === next.zoom && drawingElementsEqual(previous.element, next.element));
