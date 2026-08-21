import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
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
          width: Math.max(280, Math.round(bounds.width || current.width))
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
    settings
  }, forwardedRef) {
    const hostRef = useRef<HTMLDivElement>(null);
    const forceGraphRef = useRef<GraphMethods | undefined>(undefined);
    const publicNodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const [renderNodes, setRenderNodes] = useState<RenderNode[]>(() => nodes.map((node) => ({ ...node })));
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const { height, width } = useGraphSize(hostRef);
    const initialCenterX = initialViewport?.centerX;
    const initialCenterY = initialViewport?.centerY;
    const initialZoom = initialViewport?.zoom;

    useEffect(() => {
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
      const renderEdges: RenderEdge[] = edges.map((edge) => ({
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
        forceGraphRef.current?.zoomToFit(300, 48);
      },
      panBy(deltaX, deltaY) {
        const graph = forceGraphRef.current;
        if (!graph) {
          return;
        }
        const center = graph.centerAt();
        const zoom = graph.zoom() || 1;
        graph.centerAt(center.x + deltaX / zoom, center.y + deltaY / zoom, 120);
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
        graph.zoom(nextZoom, 180);
      }
    }), []);

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

    return (
      <div className="qm-graph-renderer" ref={hostRef}>
        <ForceGraph2D<RenderNode, RenderEdge>
          autoPauseRedraw
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={nodes.length > 5_000 ? 80 : 140}
          enableNodeDrag
          graphData={graphData}
          height={height}
          linkColor={(edge) => edgeIsHighlighted(edge as RenderEdge) ? "rgba(154, 148, 178, 0.55)" : "rgba(154, 148, 178, 0.09)"}
          linkDirectionalArrowColor={(edge) => edgeIsHighlighted(edge as RenderEdge) ? "#aaa3c8" : "rgba(170, 163, 200, 0.12)"}
          linkDirectionalArrowLength={settings.common.arrows ? 5 : 0}
          linkDirectionalArrowRelPos={1}
          linkSource="source"
          linkTarget="target"
          linkWidth={(edge) => settings.common.linkThickness * (edgeIsHighlighted(edge as RenderEdge) ? 1 : 0.55)}
          maxZoom={GRAPH_SETTING_RANGES.zoom.max}
          minZoom={GRAPH_SETTING_RANGES.zoom.min}
          nodeCanvasObject={(renderedNode, context, globalScale) => {
            const node = renderedNode as RenderNode;
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
            if (node) {
              onNodeOpen(node, graphOpenIntentFromModifiers(event));
            }
          }}
          onNodeDrag={(renderedNode) => {
            const node = renderedNode as RenderNode;
            node.fx = node.x;
            node.fy = node.y;
            const source = publicNode(node);
            if (source) {
              onNodeDrag?.(source);
            }
          }}
          onNodeDragEnd={(renderedNode) => {
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
          onZoomEnd={({ k }) => {
            const center = forceGraphRef.current?.centerAt();
            if (center) {
              onViewportChange?.({ centerX: center.x, centerY: center.y, zoom: k });
            }
          }}
          ref={forceGraphRef}
          showPointerCursor
          width={width}
        />
      </div>
    );
  }
);

export default ForceGraphRenderer;
