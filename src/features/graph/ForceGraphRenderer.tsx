import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useCallback,
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
import { forceX, forceY } from "d3-force";
import {
  graphEngineForceSettings,
  graphOpenIntentFromModifiers,
  GRAPH_SETTING_RANGES,
  resolveGraphNodeColor
} from "./graphSettings";
import { shouldRenderGraphLabel } from "./labelLod";
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
  // Do not mount force-graph against a guessed desktop-sized canvas. On a
  // narrow viewport, restoring the saved transform before the first real
  // measurement makes force-graph translate it when 640px is replaced by the
  // actual width. That shifts the persisted graph center during unlock.
  const [size, setSize] = useState({ height: 0, width: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const measure = () => {
      const bounds = host.getBoundingClientRect();
      setSize((current) => {
        const next = {
          height: Math.max(240, Math.round(bounds.height || current.height || 480)),
          width: Math.max(1, Math.round(bounds.width || current.width || 640))
        };
        return next.height === current.height && next.width === current.width ? current : next;
      });
    };

    let measureFrame = 0;
    const scheduleMeasure = () => {
      if (measureFrame !== 0) {
        return;
      }
      // Updating the force-graph canvas from inside a ResizeObserver delivery
      // can resize its host again in the same WebKit frame and surface an
      // undelivered-notification loop. Coalesce measurements into the next
      // animation frame so layout has settled before React updates the canvas.
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = 0;
        measure();
      });
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(scheduleMeasure);
      observer.observe(host);
      return () => {
        observer.disconnect();
        if (measureFrame !== 0) {
          window.cancelAnimationFrame(measureFrame);
        }
      };
    }

    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      if (measureFrame !== 0) {
        window.cancelAnimationFrame(measureFrame);
      }
    };
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
    const interactionIdleTimerRef = useRef<number | null>(null);
    const lastViewportRef = useRef<GraphViewport | null>(null);
    const readyNotifiedRef = useRef(false);
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
    const graphSizeReady = width > 0 && height > 0;

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
      const mapped = graphEngineForceSettings({
        centerForce: settings.common.centerForce,
        linkDistance: settings.common.linkDistance,
        linkForce: settings.common.linkForce,
        repelForce: settings.common.repelForce
      });
      const charge = graph.d3Force("charge") as ConfigurableForce | undefined;
      const link = graph.d3Force("link") as ConfigurableForce | undefined;
      graph.d3Force("center", null);
      graph.d3Force("x", forceX<RenderNode>(0).strength(mapped.centerStrength));
      graph.d3Force("y", forceY<RenderNode>(0).strength(mapped.centerStrength));
      charge?.strength?.(mapped.repelStrength);
      link?.strength?.(mapped.linkStrength);
      link?.distance?.(mapped.linkDistance);
      graph.d3ReheatSimulation();
    }, [settings.common.centerForce, settings.common.linkDistance, settings.common.linkForce, settings.common.repelForce]);

    useEffect(() => {
      const graph = forceGraphRef.current;
      if (!graph || !graphSizeReady || initialCenterX === undefined || initialCenterY === undefined || initialZoom === undefined) {
        return;
      }
      graph.centerAt(initialCenterX, initialCenterY, 0);
      graph.zoom(clamp(initialZoom, GRAPH_SETTING_RANGES.zoom.min, GRAPH_SETTING_RANGES.zoom.max), 0);
    }, [graphSizeReady, height, initialCenterX, initialCenterY, initialZoom, width]);

    useEffect(() => {
      if (!graphSizeReady || readyNotifiedRef.current) return;
      readyNotifiedRef.current = true;
      onReady?.();
    }, [graphSizeReady, onReady]);

    useEffect(() => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
      if (interactionIdleTimerRef.current !== null) {
        window.clearTimeout(interactionIdleTimerRef.current);
      }
    }, []);

    const markInteractionIdle = useCallback(() => {
      if (interactionIdleTimerRef.current !== null) {
        window.clearTimeout(interactionIdleTimerRef.current);
        interactionIdleTimerRef.current = null;
      }
      interactionActiveRef.current = false;
    }, []);

    const markInteractionActive = useCallback((idleAfterMs?: number) => {
      interactionActiveRef.current = true;
      if (interactionIdleTimerRef.current !== null) {
        window.clearTimeout(interactionIdleTimerRef.current);
        interactionIdleTimerRef.current = null;
      }
      if (idleAfterMs !== undefined) {
        interactionIdleTimerRef.current = window.setTimeout(() => {
          interactionIdleTimerRef.current = null;
          interactionActiveRef.current = false;
        }, idleAfterMs);
      }
    }, []);

    const emitViewport = useCallback((next: GraphViewport) => {
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
    }, [onViewportChange]);

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
        markInteractionActive(reducedMotion ? 50 : 220);
        const center = graph.centerAt();
        const zoom = graph.zoom() || 1;
        const next = {
          centerX: center.x + deltaX / zoom,
          centerY: center.y + deltaY / zoom,
          zoom
        };
        graph.centerAt(next.centerX, next.centerY, reducedMotion ? 0 : 120);
        emitViewport(next);
      },
      zoomBy(factor) {
        const graph = forceGraphRef.current;
        if (!graph) {
          return;
        }
        markInteractionActive(reducedMotion ? 50 : 260);
        const nextZoom = clamp(
          graph.zoom() * factor,
          GRAPH_SETTING_RANGES.zoom.min,
          GRAPH_SETTING_RANGES.zoom.max
        );
        graph.zoom(nextZoom, reducedMotion ? 0 : 180);
        const center = graph.centerAt();
        emitViewport({ centerX: center.x, centerY: center.y, zoom: nextZoom });
      }
    }), [emitViewport, markInteractionActive, reducedMotion]);

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
      return shouldRenderGraphLabel({
        focused: node.id === activeNodeId || node.id === hoveredNodeId,
        globalScale,
        inboundReferenceCount: node.inboundReferenceCount ?? 0,
        interactionActive: interactionActiveRef.current,
        nodeCount: nodes.length
      });
    }

    function publishViewport(zoom: number) {
      const center = forceGraphRef.current?.centerAt();
      if (!center) {
        return;
      }
      emitViewport({ centerX: center.x, centerY: center.y, zoom });
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
        {graphSizeReady ? <ForceGraph2D<RenderNode, RenderEdge>
          autoPauseRedraw
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={reducedMotion || nodes.length >= 5_000 ? 0 : 130}
          d3AlphaDecay={nodes.length >= 5_000 ? 0.06 : 0.035}
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
            markInteractionActive();
            const node = renderedNode as RenderNode;
            node.fx = node.x;
            node.fy = node.y;
            const source = publicNode(node);
            if (source) {
              onNodeDrag?.(source);
            }
          }}
          onNodeDragEnd={(renderedNode) => {
            markInteractionIdle();
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
            markInteractionActive(reducedMotion ? 50 : 260);
          }}
          onZoomEnd={({ k }) => {
            markInteractionIdle();
            publishViewport(k);
          }}
          ref={forceGraphRef}
          showPointerCursor
          warmupTicks={nodes.length >= 5_000 ? 70 : reducedMotion ? 80 : 0}
          width={width}
        /> : null}
      </div>
    );
  }
);

export default ForceGraphRenderer;
