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
  orderedGraphGroups
} from "./graphSettings";
import { shouldRenderGraphLabel } from "./labelLod";
import { graphColorWithAlpha, useGraphPalette } from "./graphPalette";
import {
  graphNeighborIndex,
  graphNodeRadius,
  nodeIdFromLinkEndpoint,
  reconcileGraphRenderData,
  type RenderEdge,
  type RenderNode
} from "./graphRenderData";
import type {
  GraphContextPoint,
  GraphEdge,
  GraphNode,
  GraphOpenIntent,
  GraphRendererHandle,
  GraphViewSettings,
  GraphViewport
} from "./types";

interface SuppressedNodeClick {
  expiresAt: number;
  nodeId: string;
}

interface DeferredViewport {
  base: GraphViewport;
  target: GraphViewport;
}

interface CanvasPresentationSnapshot {
  canvas: HTMLCanvasElement;
  transform: string;
  transformOrigin: string;
  transition: string;
  willChange: string;
}

const LONG_PRESS_CLICK_SUPPRESSION_MS = 1_000;
const LARGE_GRAPH_NODE_THRESHOLD = 5_000;
const LARGE_GRAPH_VIEWPORT_COMMIT_DELAY_MS = 180;
const LARGE_GRAPH_COMPOSITOR_TRANSITION_MS = 60;
// A 48-tick prewarm leaves the large-graph simulation below 0.06 alpha with
// the matching decay below. That is visually settled enough to navigate while
// avoiding a long, synchronous 70-tick block before the first canvas paint.
const LARGE_GRAPH_WARMUP_TICKS = 48;

function viewportNearlyEqual(left: GraphViewport | null, right: GraphViewport) {
  return Boolean(
    left
    && Math.abs(left.centerX - right.centerX) < 0.01
    && Math.abs(left.centerY - right.centerY) < 0.01
    && Math.abs(left.zoom - right.zoom) < 0.0001
  );
}

function compositorTransform(base: GraphViewport, target: GraphViewport) {
  const scale = target.zoom / base.zoom;
  const translateX = (base.centerX - target.centerX) * target.zoom;
  const translateY = (base.centerY - target.centerY) * target.zoom;
  return {
    css: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`,
    scale,
    translateX,
    translateY
  };
}

function applyCanvasPresentation(
  snapshots: readonly CanvasPresentationSnapshot[],
  transform: string,
  reducedMotion: boolean
) {
  for (const snapshot of snapshots) {
    snapshot.canvas.style.transformOrigin = "50% 50%";
    snapshot.canvas.style.transition = reducedMotion
      ? "none"
      : `transform ${LARGE_GRAPH_COMPOSITOR_TRANSITION_MS}ms linear`;
    snapshot.canvas.style.willChange = "transform";
    snapshot.canvas.style.transform = transform;
  }
}

function restoreCanvasPresentations(snapshots: readonly CanvasPresentationSnapshot[]) {
  for (const snapshot of snapshots) {
    snapshot.canvas.style.transform = snapshot.transform;
    snapshot.canvas.style.transformOrigin = snapshot.transformOrigin;
    snapshot.canvas.style.transition = snapshot.transition;
    snapshot.canvas.style.willChange = snapshot.willChange;
  }
}

interface ConfigurableForce {
  distance?: (value: number) => unknown;
  strength?: (value: number) => unknown;
}

type GraphMethods = ForceGraphMethods<NodeObject<RenderNode>, LinkObject<RenderNode, RenderEdge>>;

export interface ForceGraphRendererProps {
  activeNodeId?: string;
  edges: readonly GraphEdge[];
  fitOnLoad?: boolean;
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
          height: Math.max(1, Math.round(bounds.height || current.height || 480)),
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
    fitOnLoad = false,
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
    const canvasPresentationRef = useRef<CanvasPresentationSnapshot[] | null>(null);
    const deferredViewportRef = useRef<DeferredViewport | null>(null);
    const forceGraphRef = useRef<GraphMethods | undefined>(undefined);
    const automaticFitRef = useRef({ firstPaint: true, settled: true });
    const hoveredNodeIdRef = useRef<string | null>(null);
    const hoveredNodeFrameRef = useRef<number | null>(null);
    const pendingHoveredNodeRef = useRef<GraphNode | null>(null);
    const onHoveredNodeChangeRef = useRef(onHoveredNodeChange);
    const interactionActiveRef = useRef(false);
    const interactionIdleTimerRef = useRef<number | null>(null);
    const lastViewportRef = useRef<GraphViewport | null>(null);
    const programmaticViewportChangeRef = useRef(false);
    const pointerInteractionEnabledRef = useRef(true);
    const pointerInteractionFrameRef = useRef<number | null>(null);
    const pendingPointerInteractionRef = useRef(true);
    const reconciledInputRef = useRef({ nodes, edges });
    const readyNotifiedRef = useRef(false);
    const forcesConfiguredRef = useRef(false);
    const resetCompositorAfterRenderRef = useRef(false);
    const restoredGraphSizeRef = useRef("");
    const restoredViewportInputRef = useRef<GraphViewport | null>(null);
    const longPressStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const longPressTimerRef = useRef<number | null>(null);
    const suppressedNodeClickRef = useRef<SuppressedNodeClick | null>(null);
    const viewportCommitTimerRef = useRef<number | null>(null);
    const publicNodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const [renderState, setRenderState] = useState(() => ({
      data: reconcileGraphRenderData(undefined, nodes, edges)
    }));
    const graphData = renderState.data;
    const renderNodes = graphData.nodes;
    const palette = useGraphPalette(hostRef);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [pointerInteractionEnabled, setPointerInteractionEnabled] = useState(true);
    const { height, width } = useGraphSize(hostRef);
    const initialCenterX = initialViewport?.centerX;
    const initialCenterY = initialViewport?.centerY;
    const initialZoom = initialViewport?.zoom;
    const graphSizeReady = width > 0 && height > 0;
    const largeGraph = nodes.length >= LARGE_GRAPH_NODE_THRESHOLD;
    const automaticFitEnabled = fitOnLoad && initialViewport === undefined;

    useEffect(() => {
      onHoveredNodeChangeRef.current = onHoveredNodeChange;
    }, [onHoveredNodeChange]);

    useLayoutEffect(() => {
      if (reconciledInputRef.current.nodes === nodes && reconciledInputRef.current.edges === edges) return;
      reconciledInputRef.current = { nodes, edges };
      setRenderState((current) => ({ data: reconcileGraphRenderData(current.data, nodes, edges) }));
    }, [nodes, edges]);

    useLayoutEffect(() => {
      automaticFitRef.current = { firstPaint: automaticFitEnabled, settled: automaticFitEnabled };
    }, [activeNodeId, automaticFitEnabled, graphData.links, graphData.nodes]);

    const neighborsByNodeId = useMemo(() => graphNeighborIndex(graphData), [graphData]);
    const highlightedNodeIds = hoveredNodeId ? neighborsByNodeId.get(hoveredNodeId) ?? null : null;
    const nodeAppearance = useMemo(() => {
      const groups = orderedGraphGroups(settings.common.groups);
      return new Map(nodes.map((node) => {
        const group = groups.find((candidate) => node.groupIds?.includes(candidate.id));
        const color = node.id === activeNodeId ? palette.accent : group?.color ?? node.color ?? palette.node;
        const radius = graphNodeRadius(node.inboundReferenceCount, settings.common.nodeSize);
        return [node.id, { color, dimmed: graphColorWithAlpha(color, 0.15), radius, value: (radius / 4) ** 2 }];
      }));
    }, [activeNodeId, nodes, palette, settings.common.groups, settings.common.nodeSize]);
    const linkColors = useMemo(() => ({
      default: graphColorWithAlpha(palette.node, 0.35),
      dimmed: graphColorWithAlpha(palette.node, 0.08),
      highlighted: graphColorWithAlpha(palette.accent, 0.8)
    }), [palette]);

    useLayoutEffect(() => {
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
      if (forcesConfiguredRef.current && (largeGraph || reducedMotion)) {
        // A static graph has zero live ticks. Reheat alone cannot move it;
        // coalesce slider input into one bounded prewarm after it settles.
        const timer = window.setTimeout(() => {
          setRenderState((current) => ({ data: { ...current.data } }));
        }, 120);
        return () => window.clearTimeout(timer);
      }
      forcesConfiguredRef.current = true;
    }, [graphSizeReady, largeGraph, reducedMotion, settings.common.centerForce, settings.common.linkDistance, settings.common.linkForce, settings.common.repelForce]);

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
      if (viewportCommitTimerRef.current !== null) {
        window.clearTimeout(viewportCommitTimerRef.current);
      }
      if (pointerInteractionFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerInteractionFrameRef.current);
      }
      if (hoveredNodeFrameRef.current !== null) {
        window.cancelAnimationFrame(hoveredNodeFrameRef.current);
      }
      restoreCanvasPresentations(canvasPresentationRef.current ?? []);
    }, []);

    const schedulePointerInteraction = useCallback((enabled: boolean) => {
      pendingPointerInteractionRef.current = enabled;
      if (
        pointerInteractionFrameRef.current === null
        && pointerInteractionEnabledRef.current === enabled
      ) {
        return;
      }
      if (pointerInteractionFrameRef.current !== null) {
        return;
      }
      // react-kapsule applies changed ForceGraph props during the child render.
      // A synchronous zoom-end callback must not update this parent in that
      // render phase, so coalesce pointer hit-map changes into the next frame.
      pointerInteractionFrameRef.current = window.requestAnimationFrame(() => {
        pointerInteractionFrameRef.current = null;
        const next = pendingPointerInteractionRef.current;
        if (pointerInteractionEnabledRef.current === next) {
          return;
        }
        pointerInteractionEnabledRef.current = next;
        setPointerInteractionEnabled(next);
      });
    }, []);

    const scheduleHoveredNode = useCallback((node: GraphNode | null) => {
      pendingHoveredNodeRef.current = node;
      if (
        hoveredNodeFrameRef.current === null
        && hoveredNodeIdRef.current === (node?.id ?? null)
      ) {
        return;
      }
      if (hoveredNodeFrameRef.current !== null) return;
      // A force-graph zoom callback may run while react-kapsule applies props
      // during its child render. Coalesce both local hover state and the parent
      // notification into the next frame so neither can update React in render.
      hoveredNodeFrameRef.current = window.requestAnimationFrame(() => {
        hoveredNodeFrameRef.current = null;
        const nextNode = pendingHoveredNodeRef.current;
        const nextNodeId = nextNode?.id ?? null;
        if (hoveredNodeIdRef.current === nextNodeId) return;
        hoveredNodeIdRef.current = nextNodeId;
        setHoveredNodeId(nextNodeId);
        onHoveredNodeChangeRef.current?.(nextNode);
      });
    }, []);

    const markInteractionIdle = useCallback(() => {
      if (interactionIdleTimerRef.current !== null) {
        window.clearTimeout(interactionIdleTimerRef.current);
        interactionIdleTimerRef.current = null;
      }
      interactionActiveRef.current = false;
      schedulePointerInteraction(true);
    }, [schedulePointerInteraction]);

    const markInteractionActive = useCallback((idleAfterMs?: number, suspendPointerHitTesting = false) => {
      interactionActiveRef.current = true;
      if (largeGraph && suspendPointerHitTesting) {
        // force-graph otherwise redraws a second, hidden 5k/10k hit-map Canvas
        // for every viewport frame. Hover cannot be meaningful while the
        // viewport itself is moving, so pause only that duplicate paint and
        // restore it immediately at idle. Node dragging does not use this path.
        scheduleHoveredNode(null);
        schedulePointerInteraction(false);
      }
      if (interactionIdleTimerRef.current !== null) {
        window.clearTimeout(interactionIdleTimerRef.current);
        interactionIdleTimerRef.current = null;
      }
      if (idleAfterMs !== undefined) {
        interactionIdleTimerRef.current = window.setTimeout(() => {
          interactionIdleTimerRef.current = null;
          interactionActiveRef.current = false;
          schedulePointerInteraction(true);
        }, idleAfterMs);
      }
    }, [largeGraph, scheduleHoveredNode, schedulePointerInteraction]);

    const emitViewport = useCallback((next: GraphViewport) => {
      const previous = lastViewportRef.current;
      if (viewportNearlyEqual(previous, next)) {
        return;
      }
      lastViewportRef.current = next;
      onViewportChange?.(next);
    }, [onViewportChange]);

    const restoreCanvasPresentation = useCallback(() => {
      restoreCanvasPresentations(canvasPresentationRef.current ?? []);
      canvasPresentationRef.current = null;
      hostRef.current?.removeAttribute("data-compositor-navigation");
    }, []);

    const commitDeferredViewport = useCallback(() => {
      if (viewportCommitTimerRef.current !== null) {
        window.clearTimeout(viewportCommitTimerRef.current);
        viewportCommitTimerRef.current = null;
      }
      const pending = deferredViewportRef.current;
      if (!pending) {
        return false;
      }
      deferredViewportRef.current = null;
      const graph = forceGraphRef.current;
      if (!graph) {
        restoreCanvasPresentation();
        markInteractionIdle();
        return false;
      }

      // Keep the composited bitmap in place until force-graph has painted the
      // exact target viewport. onRenderFramePost then removes the CSS transform
      // in the same frame, avoiding a flash of the previous viewport.
      resetCompositorAfterRenderRef.current = true;
      markInteractionIdle();
      programmaticViewportChangeRef.current = true;
      try {
        graph.centerAt(pending.target.centerX, pending.target.centerY, 0);
        graph.zoom(pending.target.zoom, 0);
      } finally {
        programmaticViewportChangeRef.current = false;
      }
      return true;
    }, [markInteractionIdle, restoreCanvasPresentation]);

    const flushDeferredViewportForDirectInput = useCallback(() => {
      if (!commitDeferredViewport()) {
        return;
      }

      // Capture runs before react-force-graph's own wheel/pointer handler. The
      // exact D3 viewport is already committed synchronously, so remove the CSS
      // presentation in the same task as well. The browser cannot paint between
      // these statements, and the downstream handler therefore measures the
      // untransformed canvas bounds instead of applying its anchor twice.
      resetCompositorAfterRenderRef.current = false;
      restoreCanvasPresentation();
    }, [commitDeferredViewport, restoreCanvasPresentation]);

    const stageDeferredViewport = useCallback((next: GraphViewport) => {
      const graph = forceGraphRef.current;
      const host = hostRef.current;
      const canvas = host?.querySelector("canvas");
      if (!largeGraph || !graph || !host || !(canvas instanceof HTMLCanvasElement)) {
        return false;
      }

      const current = deferredViewportRef.current;
      const graphCenter = current ? null : graph.centerAt();
      const base = current?.base ?? {
        centerX: graphCenter?.x ?? 0,
        centerY: graphCenter?.y ?? 0,
        zoom: graph.zoom() || 1
      };
      const transform = compositorTransform(base, next);
      deferredViewportRef.current = { base, target: next };
      if (!canvasPresentationRef.current) {
        canvasPresentationRef.current = [...host.querySelectorAll("canvas")].map((candidate) => ({
          canvas: candidate,
          transform: candidate.style.transform,
          transformOrigin: candidate.style.transformOrigin,
          transition: candidate.style.transition,
          willChange: candidate.style.willChange
        }));
      }
      applyCanvasPresentation(canvasPresentationRef.current, transform.css, reducedMotion);
      host.dataset.compositorNavigation = "true";
      if (viewportCommitTimerRef.current !== null) {
        window.clearTimeout(viewportCommitTimerRef.current);
      }
      viewportCommitTimerRef.current = window.setTimeout(
        commitDeferredViewport,
        LARGE_GRAPH_VIEWPORT_COMMIT_DELAY_MS
      );

      // Do not let a long held key expose an unpainted region or excessively
      // scale the cached bitmap. Ordinary bursts stay compositor-only; larger
      // moves settle to a sharp Canvas and begin a fresh burst.
      if (
        Math.abs(transform.translateX) > width * 0.35
        || Math.abs(transform.translateY) > height * 0.35
        || transform.scale < 0.7
        || transform.scale > 1.4
      ) {
        commitDeferredViewport();
      }
      return true;
    }, [commitDeferredViewport, height, largeGraph, reducedMotion, width]);

    useLayoutEffect(() => {
      if (deferredViewportRef.current) {
        commitDeferredViewport();
      }
    }, [commitDeferredViewport, graphData, height, width]);

    useEffect(() => {
      const graph = forceGraphRef.current;
      if (!graph || !graphSizeReady || initialCenterX === undefined || initialCenterY === undefined || initialZoom === undefined) {
        return;
      }
      const next = {
        centerX: initialCenterX,
        centerY: initialCenterY,
        zoom: clamp(initialZoom, GRAPH_SETTING_RANGES.zoom.min, GRAPH_SETTING_RANGES.zoom.max)
      };
      const graphSizeKey = `${width}:${height}`;
      const sizeChanged = restoredGraphSizeRef.current !== graphSizeKey;
      const inputChanged = !viewportNearlyEqual(restoredViewportInputRef.current, next);
      restoredGraphSizeRef.current = graphSizeKey;
      restoredViewportInputRef.current = next;
      const target = inputChanged ? next : lastViewportRef.current ?? next;
      if (!sizeChanged && viewportNearlyEqual(lastViewportRef.current, target)) {
        return;
      }
      if (deferredViewportRef.current) {
        commitDeferredViewport();
      }
      programmaticViewportChangeRef.current = true;
      try {
        graph.centerAt(target.centerX, target.centerY, 0);
        graph.zoom(target.zoom, 0);
      } finally {
        programmaticViewportChangeRef.current = false;
      }
      lastViewportRef.current = target;
    }, [commitDeferredViewport, graphSizeReady, height, initialCenterX, initialCenterY, initialZoom, width]);

    useImperativeHandle(forwardedRef, () => ({
      async copyImage() {
        const committed = commitDeferredViewport();
        if (committed) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
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
        cancelAutomaticFit();
        commitDeferredViewport();
        forceGraphRef.current?.zoomToFit(reducedMotion || largeGraph ? 0 : 300, 48);
      },
      panBy(deltaX, deltaY) {
        cancelAutomaticFit();
        const graph = forceGraphRef.current;
        if (!graph) {
          return;
        }
        const virtualViewport = deferredViewportRef.current?.target;
        const graphCenter = virtualViewport ? null : graph.centerAt();
        const current = virtualViewport ?? {
          centerX: graphCenter?.x ?? 0,
          centerY: graphCenter?.y ?? 0,
          zoom: graph.zoom() || 1
        };
        const zoom = current.zoom;
        const next = {
          centerX: current.centerX + deltaX / zoom,
          centerY: current.centerY + deltaY / zoom,
          zoom
        };
        if (largeGraph) {
          markInteractionActive(undefined, true);
          if (stageDeferredViewport(next)) {
            emitViewport(next);
            return;
          }
        }
        markInteractionActive(reducedMotion ? 50 : 220, true);
        // Repeated keyboard input arrives faster than the regular transition.
        // On a 5k/10k graph, overlapping transitions otherwise redraw every
        // node and edge continuously. Apply each keyboard step atomically so
        // the canvas stays responsive without hiding any graph data.
        programmaticViewportChangeRef.current = true;
        try {
          graph.centerAt(next.centerX, next.centerY, reducedMotion || largeGraph ? 0 : 120);
        } finally {
          programmaticViewportChangeRef.current = false;
        }
        emitViewport(next);
      },
      zoomBy(factor) {
        cancelAutomaticFit();
        const graph = forceGraphRef.current;
        if (!graph) {
          return;
        }
        const virtualViewport = deferredViewportRef.current?.target;
        const currentZoom = virtualViewport?.zoom ?? graph.zoom();
        const nextZoom = clamp(
          currentZoom * factor,
          GRAPH_SETTING_RANGES.zoom.min,
          GRAPH_SETTING_RANGES.zoom.max
        );
        const graphCenter = virtualViewport ? null : graph.centerAt();
        const next = {
          centerX: virtualViewport?.centerX ?? graphCenter?.x ?? 0,
          centerY: virtualViewport?.centerY ?? graphCenter?.y ?? 0,
          zoom: nextZoom
        };
        if (largeGraph) {
          markInteractionActive(undefined, true);
          if (stageDeferredViewport(next)) {
            emitViewport(next);
            return;
          }
        }
        markInteractionActive(reducedMotion ? 50 : 260, true);
        programmaticViewportChangeRef.current = true;
        try {
          graph.zoom(nextZoom, reducedMotion || largeGraph ? 0 : 180);
        } finally {
          programmaticViewportChangeRef.current = false;
        }
        emitViewport(next);
      }
    }), [
      commitDeferredViewport,
      emitViewport,
      largeGraph,
      markInteractionActive,
      reducedMotion,
      stageDeferredViewport
    ]);

    function publicNode(node: RenderNode): GraphNode | undefined {
      return publicNodeById.get(node.id);
    }

    function cancelAutomaticFit() {
      automaticFitRef.current = { firstPaint: false, settled: false };
    }

    function fitNewGraph() {
      const graph = forceGraphRef.current;
      if (!graph || renderNodes.length === 0 || !renderNodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))) {
        return false;
      }
      programmaticViewportChangeRef.current = true;
      try {
        graph.zoomToFit(0, 64);
        // A singleton should remain a small note marker, not fill the panel.
        if (graph.zoom() > 1) graph.zoom(1, 0);
        const center = graph.centerAt();
        emitViewport({ centerX: center.x, centerY: center.y, zoom: graph.zoom() });
      } finally {
        programmaticViewportChangeRef.current = false;
      }
      return true;
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
        onPointerDownCapture={() => {
          cancelAutomaticFit();
          flushDeferredViewportForDirectInput();
        }}
        onPointerMove={moveLongPress}
        onPointerMoveCapture={flushDeferredViewportForDirectInput}
        onPointerUp={clearLongPress}
        onWheelCapture={() => {
          cancelAutomaticFit();
          flushDeferredViewportForDirectInput();
        }}
        ref={hostRef}
      >
        {graphSizeReady ? <ForceGraph2D<RenderNode, RenderEdge>
          autoPauseRedraw
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={reducedMotion || largeGraph ? 0 : 130}
          d3AlphaDecay={largeGraph ? 0.06 : 0.035}
          enableNodeDrag
          enablePointerInteraction={pointerInteractionEnabled}
          graphData={graphData}
          height={height}
          linkColor={(edge) => !hoveredNodeId ? linkColors.default : edgeIsHighlighted(edge as RenderEdge) ? linkColors.highlighted : linkColors.dimmed}
          linkDirectionalArrowColor={(edge) => edgeIsHighlighted(edge as RenderEdge) ? palette.node : linkColors.dimmed}
          linkDirectionalArrowLength={() => settings.common.arrows && !interactionActiveRef.current ? 5 : 0}
          linkDirectionalArrowRelPos={1}
          linkSource="source"
          linkTarget="target"
          linkWidth={(edge) => settings.common.linkThickness * (hoveredNodeId && edgeIsHighlighted(edge as RenderEdge) ? 1.8 : 1)}
          maxZoom={GRAPH_SETTING_RANGES.zoom.max}
          minZoom={GRAPH_SETTING_RANGES.zoom.min}
          nodeCanvasObject={(renderedNode, context, globalScale) => {
            const node = renderedNode as RenderNode;
            if (!shouldDrawLabel(node, globalScale)) {
              return;
            }
            const fadeScale = 2 ** settings.common.textFadeThreshold;
            const focused = node.id === activeNodeId || node.id === hoveredNodeId;
            const opacity = focused ? 1 : clamp((globalScale / fadeScale - 0.35) / 0.65, 0, 1);
            if (opacity <= 0.02 || typeof node.x !== "number" || typeof node.y !== "number") {
              return;
            }
            const fontSize = 12 / globalScale;
            context.save();
            context.font = `500 ${fontSize}px system-ui, sans-serif`;
            context.textAlign = "center";
            context.textBaseline = "top";
            context.fillStyle = palette.text;
            context.globalAlpha = opacity * (highlightedNodeIds && !highlightedNodeIds.has(node.id) ? 0.18 : 0.9);
            const radius = nodeAppearance.get(node.id)?.radius ?? 4;
            context.fillText(node.label, node.x, node.y + radius + 4 / globalScale);
            context.restore();
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeColor={(renderedNode) => {
            const appearance = nodeAppearance.get(renderedNode.id);
            return highlightedNodeIds && !highlightedNodeIds.has(renderedNode.id)
              ? appearance?.dimmed ?? linkColors.dimmed
              : appearance?.color ?? palette.node;
          }}
          nodeId="id"
          nodeRelSize={4}
          nodeVal={(renderedNode) => nodeAppearance.get(renderedNode.id)?.value ?? 1}
          onEngineStop={() => {
            if (automaticFitEnabled && automaticFitRef.current.settled && fitNewGraph()) {
              cancelAutomaticFit();
            }
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
            cancelAutomaticFit();
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
            if (largeGraph || reducedMotion) {
              setRenderState((current) => ({ data: { ...current.data } }));
            }
            const source = publicNode(node);
            if (source) {
              onNodeDragEnd?.(source);
            }
          }}
          onNodeHover={(renderedNode) => {
            const node = renderedNode ? publicNode(renderedNode as RenderNode) ?? null : null;
            scheduleHoveredNode(node);
          }}
          onNodeRightClick={(renderedNode, event) => {
            event.preventDefault();
            const node = publicNode(renderedNode as RenderNode);
            if (node) {
              onNodeContextMenu?.(node, { clientX: event.clientX, clientY: event.clientY });
            }
          }}
          onRenderFramePost={() => {
            if (automaticFitEnabled && automaticFitRef.current.firstPaint && fitNewGraph()) {
              automaticFitRef.current.firstPaint = false;
            }
            if (!resetCompositorAfterRenderRef.current) {
              return;
            }
            resetCompositorAfterRenderRef.current = false;
            // A very fast key repeat can begin the next compositor burst
            // before this committed frame is painted. In that case the fresh
            // transform is relative to the viewport being painted now and
            // must remain until the newer target is committed.
            if (!deferredViewportRef.current) {
              restoreCanvasPresentation();
            }
          }}
          onZoom={() => {
            if (!programmaticViewportChangeRef.current) {
              markInteractionActive(reducedMotion ? 50 : 260, true);
            }
          }}
          onZoomEnd={({ k }) => {
            if (programmaticViewportChangeRef.current) {
              return;
            }
            markInteractionIdle();
            publishViewport(k);
          }}
          ref={forceGraphRef}
          showPointerCursor
          warmupTicks={largeGraph ? LARGE_GRAPH_WARMUP_TICKS : reducedMotion ? 80 : automaticFitEnabled ? 48 : 0}
          width={width}
        /> : null}
      </div>
    );
  }
);

export default ForceGraphRenderer;
