import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject
} from "react-force-graph-2d";
import {
  graphOpenIntentFromModifiers,
  GRAPH_SETTING_RANGES,
  resolveGraphNodeColor
} from "./graphSettings";
import type {
  GraphContextPoint,
  GraphEdge,
  GraphNode,
  GraphOpenIntent,
  GraphRendererHandle,
  GraphViewSettings,
  GraphViewport
} from "./types";

interface RenderNode extends GraphNode {
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
  x?: number;
  y?: number;
}

interface RenderEdge {
  id: string;
  occurrenceCount: number;
  source: string | RenderNode;
  target: string | RenderNode;
}

interface SuppressedNodeClick {
  expiresAt: number;
  nodeId: string;
}

const LONG_PRESS_CLICK_SUPPRESSION_MS = 1_000;

interface ConfigurableForce {
  distance?: (value: number) => unknown;
  strength?: (value: number) => unknown;
}

type GraphMethods = ForceGraphMethods<NodeObject<RenderNode>, LinkObject<RenderNode, RenderEdge>>;

export interface ForceGraphRendererProps {
  activeNodeId?: string;
  edges: readonly GraphEdge[];
  initialViewport?: GraphViewport;
  nodes: readonly GraphNode[];
  onHoveredNodeChange?: (node: GraphNode | null) => void;
  onNodeContextMenu?: (node: GraphNode, point: GraphContextPoint) => void;
  onNodeDrag?: (node: GraphNode) => void;
  onNodeDragEnd?: (node: GraphNode) => void;
  onNodeOpen: (node: GraphNode, intent: GraphOpenIntent) => void;
  onReady?: () => void;
  onViewportChange?: (viewport: GraphViewport) => void;
  reducedMotion?: boolean;
  settings: GraphViewSettings;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function nodeIdFromLinkEndpoint(endpoint: RenderEdge["source"]): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function colorWithAlpha(color: string, alpha: number): string {
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const longHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  const channels = shortHex
    ? shortHex.slice(1).map((value) => Number.parseInt(`${value}${value}`, 16))
    : longHex?.slice(1).map((value) => Number.parseInt(value, 16));
  if (!channels) {
    return color;
  }
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

function useGraphSize(hostRef: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ height: 480, width: 640 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const measure = () => {
      const bounds = host.getBoundingClientRect();
      setSize((current) => {
        const next = {
          height: Math.max(240, Math.round(bounds.height || current.height)),
          width: Math.max(1, Math.round(bounds.width || current.width))
        };
        return next.height === current.height && next.width === current.width ? current : next;
      });
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(host);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [hostRef]);

  return size;
}

export const ForceGraphRenderer = forwardRef<GraphRendererHandle, ForceGraphRendererProps>(
  function ForceGraphRenderer({
    activeNodeId,
    edges,
    initialViewport,
    nodes,
    onHoveredNodeChange,
    onNodeContextMenu,
    onNodeDrag,
    onNodeDragEnd,
    onNodeOpen,
    onReady,
    onViewportChange,
    reducedMotion = false,
    settings
  }, forwardedRef) {
    const hostRef = useRef<HTMLDivElement>(null);
    const forceGraphRef = useRef<GraphMethods | undefined>(undefined);
    const interactionActiveRef = useRef(false);
    const lastViewportRef = useRef<GraphViewport | null>(null);
    const longPressStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const longPressTimerRef = useRef<number | null>(null);
    const suppressedNodeClickRef = useRef<SuppressedNodeClick | null>(null);
    const publicNodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const [renderNodes, setRenderNodes] = useState<RenderNode[]>(() => nodes.map((node) => ({ ...node })));
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const { height, width } = useGraphSize(hostRef);
    const initialCenterX = initialViewport?.centerX;
    const initialCenterY = initialViewport?.centerY;
    const initialZoom = initialViewport?.zoom;

    useLayoutEffect(() => {
      setRenderNodes((current) => {
        const previousNodes = new Map(current.map((node) => [node.id, node]));
        return nodes.map((node) => {
          const rendered = previousNodes.get(node.id) ?? { ...node };
          Object.assign(rendered, node);
          return rendered;
        });
      });
    }, [nodes]);

    const graphData = useMemo(() => {
      const renderedNodeIds = new Set(renderNodes.map((node) => node.id));
      const renderEdges: RenderEdge[] = edges
        .filter((edge) => renderedNodeIds.has(edge.sourceId) && renderedNodeIds.has(edge.targetId))
        .map((edge) => ({
          id: edge.id,
          occurrenceCount: edge.occurrenceCount ?? 1,
          source: edge.sourceId,
          target: edge.targetId
        }));
      return { nodes: renderNodes, links: renderEdges };
    }, [edges, renderNodes]);

    const highlightedNodeIds = useMemo(() => {
      if (!hoveredNodeId) {
        return null;
      }
      const ids = new Set([hoveredNodeId]);
      for (const edge of edges) {
        if (edge.sourceId === hoveredNodeId) {
          ids.add(edge.targetId);
        } else if (edge.targetId === hoveredNodeId) {
          ids.add(edge.sourceId);
        }
      }
      return ids;
    }, [edges, hoveredNodeId]);

    useEffect(() => {
      const graph = forceGraphRef.current;
      if (!graph) {
        return;
      }
      const charge = graph.d3Force("charge") as ConfigurableForce | undefined;
      const center = graph.d3Force("center") as ConfigurableForce | undefined;
      const link = graph.d3Force("link") as ConfigurableForce | undefined;
      charge?.strength?.(-settings.common.repelForce * 15);
      center?.strength?.(settings.common.centerForce);
      link?.strength?.(settings.common.linkForce);
      link?.distance?.(settings.common.linkDistance);
      graph.d3ReheatSimulation();
    }, [settings.common.centerForce, settings.common.linkDistance, settings.common.linkForce, settings.common.repelForce]);

    useEffect(() => {
      const graph = forceGraphRef.current;
      if (!graph || initialCenterX === undefined || initialCenterY === undefined || initialZoom === undefined) {
        return;
      }
      graph.centerAt(initialCenterX, initialCenterY, 0);
      graph.zoom(clamp(initialZoom, GRAPH_SETTING_RANGES.zoom.min, GRAPH_SETTING_RANGES.zoom.max), 0);
    }, [initialCenterX, initialCenterY, initialZoom]);

    useEffect(() => {
      onReady?.();
    }, [onReady]);

    useEffect(() => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    }, []);

    useImperativeHandle(forwardedRef, () => ({
      async copyImage() {
        const canvas = hostRef.current?.querySelector("canvas");
        if (!canvas || typeof canvas.toBlob !== "function") {
          return null;
        }
        return new Promise<Blob | null>((resolve) => {
          try {
            canvas.toBlob(resolve, "image/png");
          } catch {
            resolve(null);
          }
        });
      },
      fitView() {
        forceGraphRef.current?.zoomToFit(reducedMotion ? 0 : 300, 48);
      },
      panBy(deltaX, deltaY) {
        const graph = forceGraphRef.current;
        if (!graph) {
          return;
        }
        const center = graph.centerAt();
        const zoom = graph.zoom() || 1;
        graph.centerAt(center.x + deltaX / zoom, center.y + deltaY / zoom, reducedMotion ? 0 : 120);
      },
      zoomBy(factor) {
        const graph = forceGraphRef.current;
        if (!graph) {
          return;
        }
        const nextZoom = clamp(
          graph.zoom() * factor,
          GRAPH_SETTING_RANGES.zoom.min,
          GRAPH_SETTING_RANGES.zoom.max
        );
        graph.zoom(nextZoom, reducedMotion ? 0 : 180);
      }
    }), [reducedMotion]);

    function publicNode(node: RenderNode): GraphNode | undefined {
      return publicNodeById.get(node.id);
    }

    function edgeIsHighlighted(edge: RenderEdge) {
      if (!hoveredNodeId) {
        return true;
      }
      return nodeIdFromLinkEndpoint(edge.source) === hoveredNodeId
        || nodeIdFromLinkEndpoint(edge.target) === hoveredNodeId;
    }

    function clearLongPress() {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressStartRef.current = null;
    }

    function beginLongPress(event: ReactPointerEvent<HTMLDivElement>) {
      if (event.pointerType !== "touch" || !onNodeContextMenu) {
        return;
      }
      clearLongPress();
      suppressedNodeClickRef.current = null;
      const point = { clientX: event.clientX, clientY: event.clientY };
      longPressStartRef.current = point;
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        const graph = forceGraphRef.current;
        const host = hostRef.current;
        if (!graph || !host) {
          return;
        }
        const bounds = host.getBoundingClientRect();
        const graphPoint = graph.screen2GraphCoords(point.clientX - bounds.left, point.clientY - bounds.top);
        const hitRadius = 24 / Math.max(graph.zoom(), GRAPH_SETTING_RANGES.zoom.min);
        let nearest: RenderNode | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const node of renderNodes) {
          if (typeof node.x !== "number" || typeof node.y !== "number") {
            continue;
          }
          const distance = Math.hypot(node.x - graphPoint.x, node.y - graphPoint.y);
          if (distance <= hitRadius && distance < nearestDistance) {
            nearest = node;
            nearestDistance = distance;
          }
        }
        const source = nearest ? publicNode(nearest) : undefined;
        if (source) {
          suppressedNodeClickRef.current = {
            expiresAt: Date.now() + LONG_PRESS_CLICK_SUPPRESSION_MS,
            nodeId: source.id
          };
          onNodeContextMenu(source, point);
        }
      }, 550);
    }

    function moveLongPress(event: ReactPointerEvent<HTMLDivElement>) {
      const start = longPressStartRef.current;
      if (start && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 10) {
        clearLongPress();
      }
    }

    function shouldDrawLabel(node: RenderNode, globalScale: number) {
      const focused = node.id === activeNodeId || node.id === hoveredNodeId;
      if (focused) {
        return true;
      }
      if (interactionActiveRef.current && nodes.length >= 1_000) {
        return false;
      }
      if (nodes.length < 1_000) {
        return true;
      }
      const references = node.inboundReferenceCount ?? 0;
      if (nodes.length >= 5_000) {
        if (globalScale < 2.5) return false;
        if (globalScale < 4.5) return references >= 5;
        if (globalScale < 7) return references >= 2;
        return true;
      }
      if (globalScale < 1.5) return references >= 3;
      if (globalScale < 3) return references >= 1;
      return true;
    }

    function publishViewport(zoom: number) {
      const center = forceGraphRef.current?.centerAt();
      if (!center) {
        return;
      }
      const next = { centerX: center.x, centerY: center.y, zoom };
      const previous = lastViewportRef.current;
      if (
        previous
        && Math.abs(previous.centerX - next.centerX) < 0.01
        && Math.abs(previous.centerY - next.centerY) < 0.01
        && Math.abs(previous.zoom - next.zoom) < 0.0001
      ) {
        return;
      }
      lastViewportRef.current = next;
      onViewportChange?.(next);
    }

    return (
      <div
        className="qm-graph-renderer"
        onPointerCancel={clearLongPress}
        onPointerDown={beginLongPress}
        onPointerMove={moveLongPress}
        onPointerUp={clearLongPress}
        ref={hostRef}
      >
        <ForceGraph2D<RenderNode, RenderEdge>
          autoPauseRedraw
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={reducedMotion ? 0 : nodes.length > 5_000 ? 70 : 130}
          d3AlphaDecay={nodes.length > 5_000 ? 0.06 : 0.035}
          enableNodeDrag
          graphData={graphData}
          height={height}
          linkColor={(edge) => edgeIsHighlighted(edge as RenderEdge) ? "rgba(154, 148, 178, 0.55)" : "rgba(154, 148, 178, 0.09)"}
          linkDirectionalArrowColor={(edge) => edgeIsHighlighted(edge as RenderEdge) ? "#aaa3c8" : "rgba(170, 163, 200, 0.12)"}
          linkDirectionalArrowLength={() => settings.common.arrows && !interactionActiveRef.current ? 5 : 0}
          linkDirectionalArrowRelPos={1}
          linkSource="source"
          linkTarget="target"
          linkWidth={(edge) => settings.common.linkThickness * (edgeIsHighlighted(edge as RenderEdge) ? 1 : 0.55)}
          maxZoom={GRAPH_SETTING_RANGES.zoom.max}
          minZoom={GRAPH_SETTING_RANGES.zoom.min}
          nodeCanvasObject={(renderedNode, context, globalScale) => {
            const node = renderedNode as RenderNode;
            if (!shouldDrawLabel(node, globalScale)) {
              return;
            }
            const fadeScale = 2 ** settings.common.textFadeThreshold;
            const opacity = clamp((globalScale / fadeScale - 0.35) / 0.65, 0, 1);
            if (opacity <= 0.02 || typeof node.x !== "number" || typeof node.y !== "number") {
              return;
            }
            const fontSize = 12 / globalScale;
            context.save();
            context.font = `500 ${fontSize}px system-ui, sans-serif`;
            context.textAlign = "center";
            context.textBaseline = "top";
            context.fillStyle = `rgba(239, 237, 248, ${opacity * (highlightedNodeIds && !highlightedNodeIds.has(node.id) ? 0.18 : 0.9)})`;
            context.fillText(node.label, node.x, node.y + (7 * settings.common.nodeSize) / globalScale);
            context.restore();
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeColor={(renderedNode) => {
            const node = renderedNode as RenderNode;
            const color = node.id === activeNodeId
              ? "#b7a9ff"
              : resolveGraphNodeColor(node, settings.common.groups);
            return highlightedNodeIds && !highlightedNodeIds.has(node.id)
              ? colorWithAlpha(color, 0.15)
              : color;
          }}
          nodeId="id"
          nodeRelSize={4}
          nodeVal={(renderedNode) => {
            const node = renderedNode as RenderNode;
            return Math.max(1, (node.inboundReferenceCount ?? 0) + 1) * settings.common.nodeSize;
          }}
          onNodeClick={(renderedNode, event) => {
            const node = publicNode(renderedNode as RenderNode);
            if (!node) {
              return;
            }
            const suppressed = suppressedNodeClickRef.current;
            if (suppressed && suppressed.expiresAt <= Date.now()) {
              suppressedNodeClickRef.current = null;
            } else if (suppressed?.nodeId === node.id) {
              suppressedNodeClickRef.current = null;
              return;
            }
            onNodeOpen(node, graphOpenIntentFromModifiers(event));
          }}
          onNodeDrag={(renderedNode) => {
            interactionActiveRef.current = true;
            const node = renderedNode as RenderNode;
            node.fx = node.x;
            node.fy = node.y;
            const source = publicNode(node);
            if (source) {
              onNodeDrag?.(source);
            }
          }}
          onNodeDragEnd={(renderedNode) => {
            interactionActiveRef.current = false;
            const node = renderedNode as RenderNode;
            node.fx = undefined;
            node.fy = undefined;
            forceGraphRef.current?.d3ReheatSimulation();
            const source = publicNode(node);
            if (source) {
              onNodeDragEnd?.(source);
            }
          }}
          onNodeHover={(renderedNode) => {
            const node = renderedNode ? publicNode(renderedNode as RenderNode) ?? null : null;
            setHoveredNodeId(node?.id ?? null);
            onHoveredNodeChange?.(node);
          }}
          onNodeRightClick={(renderedNode, event) => {
            event.preventDefault();
            const node = publicNode(renderedNode as RenderNode);
            if (node) {
              onNodeContextMenu?.(node, { clientX: event.clientX, clientY: event.clientY });
            }
          }}
          onZoom={() => {
            interactionActiveRef.current = true;
          }}
          onZoomEnd={({ k }) => {
            interactionActiveRef.current = false;
            publishViewport(k);
          }}
          ref={forceGraphRef}
          showPointerCursor
          warmupTicks={reducedMotion ? (nodes.length > 5_000 ? 40 : 80) : 0}
          width={width}
        />
      </div>
    );
  }
);

export default ForceGraphRenderer;
