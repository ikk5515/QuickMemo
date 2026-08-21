import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode
} from "react";
import type {
  GraphContextPoint,
  GraphEdge,
  GraphNode,
  GraphOpenIntent,
  GraphRendererHandle,
  GraphViewSettings,
  GraphViewport
} from "./types";
import { graphOpenIntentFromModifiers } from "./graphSettings";
import "./graph.css";

const LazyForceGraphRenderer = lazy(() => import("./ForceGraphRenderer"));
const ACCESSIBLE_NODE_BATCH_SIZE = 200;

const NODE_KIND_LABELS: Record<GraphNode["kind"], string> = {
  note: "노트",
  canvas: "캔버스",
  attachment: "첨부 파일",
  tag: "태그",
  unresolved: "생성되지 않은 링크"
};

export type GraphRenderMode = "auto" | "canvas" | "accessible";

export type GraphKeyboardAction =
  | { type: "pan"; deltaX: number; deltaY: number }
  | { type: "zoom"; factor: number };

export function graphKeyboardAction(key: string, shiftKey: boolean): GraphKeyboardAction | null {
  const panDistance = shiftKey ? 120 : 32;
  switch (key) {
    case "+":
    case "=":
      return { type: "zoom", factor: 1.25 };
    case "-":
      return { type: "zoom", factor: 0.8 };
    case "ArrowLeft":
      return { type: "pan", deltaX: -panDistance, deltaY: 0 };
    case "ArrowRight":
      return { type: "pan", deltaX: panDistance, deltaY: 0 };
    case "ArrowUp":
      return { type: "pan", deltaX: 0, deltaY: -panDistance };
    case "ArrowDown":
      return { type: "pan", deltaX: 0, deltaY: panDistance };
    default:
      return null;
  }
}

export interface GraphCanvasProps {
  activeNodeId?: string;
  edges: readonly GraphEdge[];
  initialViewport?: GraphViewport;
  nodes: readonly GraphNode[];
  onHoveredNodeChange?: (node: GraphNode | null) => void;
  onImageCopy?: (image: Blob) => void | Promise<void>;
  onBookmark?: () => void;
  onNodeContextMenu?: (node: GraphNode, point: GraphContextPoint) => void;
  onNodeDrag?: (node: GraphNode) => void;
  onNodeDragEnd?: (node: GraphNode) => void;
  onNodeOpen: (node: GraphNode, intent: GraphOpenIntent) => void;
  onViewportChange?: (viewport: GraphViewport) => void;
  renderMode?: GraphRenderMode;
  settings: GraphViewSettings;
}

interface GraphCanvasErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface GraphCanvasErrorBoundaryState {
  failed: boolean;
}

class GraphCanvasErrorBoundary extends Component<GraphCanvasErrorBoundaryProps, GraphCanvasErrorBoundaryState> {
  state: GraphCanvasErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): GraphCanvasErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    // The accessible node list remains usable when a browser blocks Canvas.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function browserSupportsGraphCanvas() {
  if (
    typeof window === "undefined"
    || typeof document === "undefined"
    || typeof HTMLCanvasElement === "undefined"
    || /jsdom/i.test(window.navigator.userAgent)
  ) {
    return false;
  }
  try {
    return document.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function reducedMotionSnapshot() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
}

export interface GraphAccessibilityListProps {
  activeNodeId?: string;
  edges: readonly GraphEdge[];
  nodes: readonly GraphNode[];
  onNodeContextMenu?: (node: GraphNode, point: GraphContextPoint) => void;
  onNodeOpen: (node: GraphNode, intent: GraphOpenIntent) => void;
}

export function GraphAccessibilityList({
  activeNodeId,
  edges,
  nodes,
  onNodeContextMenu,
  onNodeOpen
}: GraphAccessibilityListProps) {
  const [visibleCount, setVisibleCount] = useState(ACCESSIBLE_NODE_BATCH_SIZE);
  const connectionCountByNodeId = useMemo(() => {
    const neighbors = new Map<string, Set<string>>();
    for (const node of nodes) {
      neighbors.set(node.id, new Set());
    }
    for (const edge of edges) {
      neighbors.get(edge.sourceId)?.add(edge.targetId);
      neighbors.get(edge.targetId)?.add(edge.sourceId);
    }
    return new Map([...neighbors].map(([id, connected]) => [id, connected.size]));
  }, [edges, nodes]);
  const visibleNodes = nodes.length > ACCESSIBLE_NODE_BATCH_SIZE
    ? nodes.slice(0, visibleCount)
    : nodes;

  useEffect(() => {
    setVisibleCount(ACCESSIBLE_NODE_BATCH_SIZE);
  }, [nodes]);

  if (nodes.length === 0) {
    return <p role="status">표시할 그래프 노드가 없습니다.</p>;
  }

  return (
    <div className="qm-graph-accessible-window">
      <p aria-live="polite" className="qm-graph-accessible-count">
        전체 {nodes.length}개 중 {visibleNodes.length}개 표시
      </p>
      <ul aria-label="그래프 노드" className="qm-graph-accessible-list">
        {visibleNodes.map((node, index) => {
          const connectionCount = connectionCountByNodeId.get(node.id) ?? 0;
          return (
            <li aria-posinset={index + 1} aria-setsize={nodes.length} key={node.id}>
              <button
                aria-current={node.id === activeNodeId ? "page" : undefined}
                aria-label={`${node.label}, ${NODE_KIND_LABELS[node.kind]}, 연결 ${connectionCount}개`}
                onClick={(event) => onNodeOpen(node, graphOpenIntentFromModifiers(event))}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onNodeContextMenu?.(node, { clientX: event.clientX, clientY: event.clientY });
                }}
                type="button"
              >
                <span>{node.label}</span>
                <small>{NODE_KIND_LABELS[node.kind]} · 연결 {connectionCount}</small>
              </button>
            </li>
          );
        })}
      </ul>
      {visibleNodes.length < nodes.length ? (
        <button
          className="qm-graph-accessible-more"
          onClick={() => setVisibleCount((current) => Math.min(nodes.length, current + ACCESSIBLE_NODE_BATCH_SIZE))}
          type="button"
        >
          다음 {Math.min(ACCESSIBLE_NODE_BATCH_SIZE, nodes.length - visibleNodes.length)}개 표시
        </button>
      ) : null}
    </div>
  );
}

export function GraphCanvas({
  activeNodeId,
  edges,
  initialViewport,
  nodes,
  onHoveredNodeChange,
  onImageCopy,
  onBookmark,
  onNodeContextMenu,
  onNodeDrag,
  onNodeDragEnd,
  onNodeOpen,
  onViewportChange,
  renderMode = "auto",
  settings
}: GraphCanvasProps) {
  const rendererRef = useRef<GraphRendererHandle>(null);
  const [canvasSupported] = useState(browserSupportsGraphCanvas);
  const [rendererReady, setRendererReady] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [timelinePosition, setTimelinePosition] = useState<number | null>(null);
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const reducedMotion = useReducedMotion();

  const shouldRenderCanvas = renderMode === "canvas" || (renderMode === "auto" && canvasSupported);
  const [accessibilityOpen, setAccessibilityOpen] = useState(!shouldRenderCanvas);
  const chronologicalNodes = useMemo(
    () => nodes
      .filter((node): node is GraphNode & { createdAt: number } => (
        typeof node.createdAt === "number" && Number.isFinite(node.createdAt)
      ))
      .slice()
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    [nodes]
  );
  const timelineEnabled = settings.scope === "global" && settings.animate && chronologicalNodes.length > 0;
  const lastTimelinePosition = Math.max(0, chronologicalNodes.length - 1);
  const effectiveTimelinePosition = timelinePosition === null
    ? lastTimelinePosition
    : Math.min(lastTimelinePosition, timelinePosition);
  const timelineCutoff = chronologicalNodes[effectiveTimelinePosition]?.createdAt;
  const visibleNodes = useMemo(() => {
    if (!timelineEnabled || timelineCutoff === undefined) {
      return nodes;
    }
    return nodes.filter((node) => node.createdAt === undefined || node.createdAt <= timelineCutoff);
  }, [nodes, timelineCutoff, timelineEnabled]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId)),
    [edges, visibleNodeIds]
  );

  useEffect(() => {
    if (reducedMotion && timelinePlaying) {
      setTimelinePlaying(false);
    }
  }, [reducedMotion, timelinePlaying]);

  useEffect(() => {
    if (!shouldRenderCanvas) {
      setAccessibilityOpen(true);
    }
  }, [shouldRenderCanvas]);

  useEffect(() => {
    if (reducedMotion || !timelineEnabled || !timelinePlaying || effectiveTimelinePosition >= lastTimelinePosition) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setTimelinePosition(effectiveTimelinePosition + 1);
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [effectiveTimelinePosition, lastTimelinePosition, reducedMotion, timelineEnabled, timelinePlaying]);

  function handleKeyboardNavigation(event: KeyboardEvent<HTMLElement>) {
    const renderer = rendererRef.current;
    const action = graphKeyboardAction(event.key, event.shiftKey);
    if (!renderer || !action) {
      return;
    }
    event.preventDefault();
    if (action.type === "zoom") {
      renderer.zoomBy(action.factor);
    } else {
      renderer.panBy(action.deltaX, action.deltaY);
    }
  }

  async function copyGraphImage() {
    setCopyStatus("");
    const image = await rendererRef.current?.copyImage();
    if (!image) {
      setCopyStatus("이미지를 복사할 수 없습니다.");
      return;
    }
    try {
      if (onImageCopy) {
        await onImageCopy(image);
      } else if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ [image.type]: image })]);
      } else {
        setCopyStatus("이 브라우저는 이미지 복사를 지원하지 않습니다.");
        return;
      }
      setCopyStatus("그래프 이미지를 복사했습니다.");
    } catch {
      setCopyStatus("이미지를 복사할 수 없습니다.");
    }
  }

  const fallback = (
    <div className="qm-graph-canvas__fallback" role="status">
      그래프 Canvas를 사용할 수 없어 목록으로 표시합니다.
    </div>
  );

  return (
    <section
      aria-label={`${settings.scope === "global" ? "전체" : "로컬"} 그래프`}
      className="qm-graph-canvas"
      onKeyDown={handleKeyboardNavigation}
      tabIndex={0}
    >
      <div aria-label="그래프 화면 제어" className="qm-graph-toolbar" role="toolbar">
        <button
          aria-label="확대"
          disabled={!rendererReady}
          onClick={() => rendererRef.current?.zoomBy(1.25)}
          type="button"
        >
          +
        </button>
        <button
          aria-label="축소"
          disabled={!rendererReady}
          onClick={() => rendererRef.current?.zoomBy(0.8)}
          type="button"
        >
          −
        </button>
        <button
          aria-label="화면에 맞추기"
          disabled={!rendererReady}
          onClick={() => rendererRef.current?.fitView()}
          type="button"
        >
          ⛶
        </button>
        <button
          aria-label="그래프 이미지 복사"
          disabled={!rendererReady}
          onClick={() => void copyGraphImage()}
          type="button"
        >
          이미지 복사
        </button>
        {settings.scope === "global" ? (
          <button
            aria-label="전체 그래프 북마크"
            disabled={!onBookmark}
            onClick={onBookmark}
            type="button"
          >
            북마크
          </button>
        ) : null}
      </div>

      {timelineEnabled ? (
        <div aria-label="그래프 타임라인" className="qm-graph-timeline" role="group">
          <button
            aria-label={timelinePlaying && effectiveTimelinePosition < lastTimelinePosition
              ? "타임라인 일시 정지"
              : "타임라인 재생"}
            disabled={reducedMotion}
            onClick={() => {
              if (timelinePlaying && effectiveTimelinePosition < lastTimelinePosition) {
                setTimelinePlaying(false);
                return;
              }
              if (effectiveTimelinePosition >= lastTimelinePosition) {
                setTimelinePosition(0);
              }
              setTimelinePlaying(true);
            }}
            type="button"
          >
            {timelinePlaying && effectiveTimelinePosition < lastTimelinePosition ? "Ⅱ" : "▶"}
          </button>
          <input
            aria-label="그래프 생성일 위치"
            max={lastTimelinePosition}
            min={0}
            onChange={(event) => {
              setTimelinePlaying(false);
              setTimelinePosition(Number(event.currentTarget.value));
            }}
            step={1}
            type="range"
            value={effectiveTimelinePosition}
          />
          <time dateTime={timelineCutoff === undefined ? undefined : new Date(timelineCutoff).toISOString()}>
            {timelineCutoff === undefined ? "" : new Date(timelineCutoff).toLocaleDateString("ko-KR")}
          </time>
          {reducedMotion ? <span className="qm-graph-motion-note">모션 감소 설정으로 자동 재생 꺼짐</span> : null}
        </div>
      ) : null}

      <div className="qm-graph-canvas__stage">
        {shouldRenderCanvas ? (
          <GraphCanvasErrorBoundary fallback={fallback}>
            <Suspense fallback={<div className="qm-graph-canvas__fallback" role="status">그래프를 불러오는 중입니다.</div>}>
              <LazyForceGraphRenderer
                activeNodeId={activeNodeId}
                edges={visibleEdges}
                initialViewport={initialViewport}
                nodes={visibleNodes}
                onHoveredNodeChange={(node) => {
                  setHoveredNode(node);
                  onHoveredNodeChange?.(node);
                }}
                onNodeContextMenu={onNodeContextMenu}
                onNodeDrag={onNodeDrag}
                onNodeDragEnd={onNodeDragEnd}
                onNodeOpen={onNodeOpen}
                onReady={() => setRendererReady(true)}
                onViewportChange={onViewportChange}
                reducedMotion={reducedMotion}
                ref={rendererRef}
                settings={settings}
              />
            </Suspense>
          </GraphCanvasErrorBoundary>
        ) : fallback}
        {hoveredNode ? (
          <aside aria-live="polite" className="qm-graph-preview">
            <strong>{hoveredNode.label}</strong>
            {hoveredNode.path ? <span>{hoveredNode.path}</span> : null}
            {hoveredNode.preview ? <p>{hoveredNode.preview}</p> : null}
          </aside>
        ) : null}
      </div>

      <details
        className="qm-graph-accessibility"
        onToggle={(event) => setAccessibilityOpen(event.currentTarget.open)}
        open={accessibilityOpen}
      >
        <summary>접근 가능한 그래프 목록</summary>
        {accessibilityOpen ? (
          <GraphAccessibilityList
            activeNodeId={activeNodeId}
            edges={visibleEdges}
            nodes={visibleNodes}
            onNodeContextMenu={onNodeContextMenu}
            onNodeOpen={onNodeOpen}
          />
        ) : null}
      </details>
      <p aria-live="polite" className="qm-graph-copy-status">{copyStatus}</p>
    </section>
  );
}
