import { act, render } from "@testing-library/react";
import { createRef, forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForceGraphRenderer } from "./ForceGraphRenderer";
import { createDefaultGlobalGraphSettings } from "./graphSettings";
import type { GraphEdge, GraphNode, GraphRendererHandle } from "./types";

const renderedSnapshots = vi.hoisted(() => [] as Array<{ edgeIds: string[]; nodeIds: string[] }>);
const renderedSizes = vi.hoisted(() => [] as Array<{ height: number; width: number }>);
const capturedGraph = vi.hoisted(() => ({ current: null as null | {
  cooldownTicks?: number;
  enableNodeDrag?: boolean;
  enablePointerInteraction?: boolean;
  graphData: {
    links: Array<{ id: string; source: string | { id: string }; target: string | { id: string } }>;
    nodes: Array<{ fx?: number; fy?: number; id: string; x?: number; y?: number }>;
  };
  linkDirectionalArrowLength?: () => number;
  onNodeClick?: (node: { id: string }, event: MouseEvent) => void;
  onNodeDrag?: (node: { fx?: number; fy?: number; id: string; x?: number; y?: number }) => void;
  onNodeDragEnd?: (node: { fx?: number; fy?: number; id: string; x?: number; y?: number }) => void;
  onNodeHover?: (node: { id: string } | null) => void;
  onNodeRightClick?: (node: { id: string }, event: MouseEvent) => void;
  onZoomEnd?: (transform: { k: number }) => void;
  warmupTicks?: number;
} }));
const graphMethodState = vi.hoisted(() => ({
  center: { x: 0, y: 0 },
  centerAtCalls: [] as Array<{ duration?: number; x: number; y: number }>,
  forceAssignments: [] as Array<{ force: unknown; name: string }>,
  reheatCount: 0,
  zoom: 1,
  zoomCalls: [] as Array<{ duration?: number; value: number }>
}));

vi.mock("react-force-graph-2d", () => ({
  default: forwardRef(function MockForceGraph(
    props: {
      cooldownTicks?: number;
      enableNodeDrag?: boolean;
      enablePointerInteraction?: boolean;
      graphData: {
        links: Array<{ id: string; source: string | { id: string }; target: string | { id: string } }>;
        nodes: Array<{ id: string }>;
      };
      linkDirectionalArrowLength?: () => number;
      onNodeClick?: (node: { id: string }, event: MouseEvent) => void;
      onNodeDrag?: (node: { fx?: number; fy?: number; id: string; x?: number; y?: number }) => void;
      onNodeDragEnd?: (node: { fx?: number; fy?: number; id: string; x?: number; y?: number }) => void;
      onNodeHover?: (node: { id: string } | null) => void;
      onNodeRightClick?: (node: { id: string }, event: MouseEvent) => void;
      onZoomEnd?: (transform: { k: number }) => void;
      warmupTicks?: number;
      height: number;
      width: number;
    },
    ref
  ) {
    const nodeIds = new Set(props.graphData.nodes.map((node) => node.id));
    const endpointId = (value: string | { id: string }) => typeof value === "string" ? value : value.id;
    for (const edge of props.graphData.links) {
      if (!nodeIds.has(endpointId(edge.source)) || !nodeIds.has(endpointId(edge.target))) {
        throw new Error(`node not found for ${edge.id}`);
      }
    }
    renderedSnapshots.push({
      edgeIds: props.graphData.links.map((edge) => edge.id),
      nodeIds: [...nodeIds]
    });
    renderedSizes.push({ height: props.height, width: props.width });
    capturedGraph.current = props;
    useImperativeHandle(ref, () => ({
      centerAt: (x?: number, y?: number, duration?: number) => {
        if (typeof x === "number" && typeof y === "number") {
          graphMethodState.center = { x, y };
          graphMethodState.centerAtCalls.push({ duration, x, y });
          return undefined;
        }
        return { ...graphMethodState.center };
      },
      d3Force: (name: string, force?: unknown) => {
        if (force !== undefined) {
          graphMethodState.forceAssignments.push({ force, name });
          return undefined;
        }
        return { distance: vi.fn(), strength: vi.fn() };
      },
      d3ReheatSimulation: () => {
        graphMethodState.reheatCount += 1;
      },
      screen2GraphCoords: (x: number, y: number) => ({ x, y }),
      zoom: (value?: number, duration?: number) => {
        if (typeof value === "number") {
          graphMethodState.zoom = value;
          graphMethodState.zoomCalls.push({ duration, value });
          return undefined;
        }
        return graphMethodState.zoom;
      },
      zoomToFit: vi.fn()
    }));
    return <canvas data-testid="force-graph" />;
  })
}));

beforeEach(() => {
  capturedGraph.current = null;
  renderedSnapshots.length = 0;
  renderedSizes.length = 0;
  graphMethodState.center = { x: 0, y: 0 };
  graphMethodState.centerAtCalls.length = 0;
  graphMethodState.forceAssignments.length = 0;
  graphMethodState.reheatCount = 0;
  graphMethodState.zoom = 1;
  graphMethodState.zoomCalls.length = 0;
});

describe("ForceGraphRenderer", () => {
  it("publishes node and edge updates atomically when linked nodes are added or removed", () => {
    const nodeA: GraphNode = { id: "a", kind: "note", label: "A" };
    const nodeB: GraphNode = { id: "b", kind: "note", label: "B" };
    const edge: GraphEdge = { id: "a-b", sourceId: "a", targetId: "b" };
    const settings = createDefaultGlobalGraphSettings();
    const onNodeOpen = vi.fn();
    const view = render(
      <ForceGraphRenderer
        edges={[]}
        nodes={[nodeA]}
        onNodeOpen={onNodeOpen}
        settings={settings}
      />
    );

    view.rerender(
      <ForceGraphRenderer
        edges={[edge]}
        nodes={[nodeA, nodeB]}
        onNodeOpen={onNodeOpen}
        settings={settings}
      />
    );
    view.rerender(
      <ForceGraphRenderer
        edges={[]}
        nodes={[nodeB]}
        onNodeOpen={onNodeOpen}
        settings={settings}
      />
    );

    expect(renderedSnapshots).toEqual(expect.arrayContaining([
      { edgeIds: [], nodeIds: ["a"] },
      { edgeIds: ["a-b"], nodeIds: ["a", "b"] },
      { edgeIds: [], nodeIds: ["b"] }
    ]));
  });

  it("publishes imperative keyboard pan and zoom targets for encrypted viewport persistence", () => {
    const rendererRef = createRef<GraphRendererHandle>();
    const onViewportChange = vi.fn();
    render(
      <ForceGraphRenderer
        edges={[]}
        nodes={[{ id: "a", kind: "note", label: "A" }]}
        onNodeOpen={vi.fn()}
        onViewportChange={onViewportChange}
        ref={rendererRef}
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    act(() => rendererRef.current?.panBy(32, -12));
    expect(onViewportChange).toHaveBeenLastCalledWith({ centerX: 32, centerY: -12, zoom: 1 });

    act(() => rendererRef.current?.zoomBy(1.25));
    expect(onViewportChange).toHaveBeenLastCalledWith({ centerX: 32, centerY: -12, zoom: 1.25 });
  });

  it("suppresses expensive arrow rendering during animated keyboard navigation", () => {
    vi.useFakeTimers();
    try {
      const rendererRef = createRef<GraphRendererHandle>();
      const settings = createDefaultGlobalGraphSettings();
      settings.common.arrows = true;
      render(
        <ForceGraphRenderer
          edges={[]}
          nodes={[{ id: "a", kind: "note", label: "A" }]}
          onNodeOpen={vi.fn()}
          ref={rendererRef}
          settings={settings}
        />
      );

      expect(capturedGraph.current?.linkDirectionalArrowLength?.()).toBe(5);
      act(() => rendererRef.current?.panBy(32, 0));
      expect(capturedGraph.current?.linkDirectionalArrowLength?.()).toBe(0);
      act(() => vi.advanceTimersByTime(220));
      expect(capturedGraph.current?.linkDirectionalArrowLength?.()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prewarms a five-thousand-node layout before enabling interactive redraws", () => {
    const nodes: GraphNode[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `node-${index}`,
      kind: "note",
      label: `Node ${index}`
    }));

    render(
      <ForceGraphRenderer
        edges={[]}
        nodes={nodes}
        onNodeOpen={vi.fn()}
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    expect(capturedGraph.current?.warmupTicks).toBe(48);
    expect(capturedGraph.current?.cooldownTicks).toBe(0);
  });

  it("applies large-graph keyboard navigation without overlapping canvas transitions", () => {
    vi.useFakeTimers();
    const rendererRef = createRef<GraphRendererHandle>();
    const onHoveredNodeChange = vi.fn();
    const nodes: GraphNode[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `node-${index}`,
      kind: "note",
      label: `Node ${index}`
    }));

    try {
      render(
        <ForceGraphRenderer
          edges={[]}
          nodes={nodes}
          onHoveredNodeChange={onHoveredNodeChange}
          onNodeOpen={vi.fn()}
          ref={rendererRef}
          settings={createDefaultGlobalGraphSettings()}
        />
      );

      expect(capturedGraph.current?.enablePointerInteraction).toBe(true);
      expect(capturedGraph.current?.enableNodeDrag).toBe(true);
      act(() => capturedGraph.current?.onNodeHover?.({ id: "node-0" }));
      expect(onHoveredNodeChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "node-0" }));
      act(() => rendererRef.current?.panBy(32, -12));
      expect(graphMethodState.centerAtCalls).toContainEqual({ duration: 0, x: 32, y: -12 });
      expect(capturedGraph.current?.enablePointerInteraction).toBe(false);
      expect(onHoveredNodeChange).toHaveBeenLastCalledWith(null);

      act(() => rendererRef.current?.zoomBy(1.25));
      expect(graphMethodState.zoomCalls).toContainEqual({ duration: 0, value: 1.25 });
      expect(capturedGraph.current?.enablePointerInteraction).toBe(false);

      act(() => vi.advanceTimersByTime(260));
      expect(capturedGraph.current?.enablePointerInteraction).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores an initial viewport without relying on simulated node coordinates", () => {
    render(
      <ForceGraphRenderer
        edges={[]}
        initialViewport={{ centerX: -41.5, centerY: 83.25, zoom: 2.5 }}
        nodes={[{ id: "a", kind: "note", label: "A" }]}
        onNodeOpen={vi.fn()}
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    expect(graphMethodState.centerAtCalls).toContainEqual({ duration: 0, x: -41.5, y: 83.25 });
    expect(graphMethodState.zoomCalls).toContainEqual({ duration: 0, value: 2.5 });
  });

  it("measures a narrow host before mounting and reapplies the saved viewport after resize", () => {
    let width = 276;
    let resizeCallback: ResizeObserverCallback | null = null;
    let resizeFrame: FrameRequestCallback | null = null;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      resizeFrame = callback;
      return 1;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      resizeFrame = null;
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      bottom: 420,
      height: 420,
      left: 0,
      right: width,
      toJSON: () => ({}),
      top: 0,
      width,
      x: 0,
      y: 0
    }));
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    try {
      render(
        <ForceGraphRenderer
          edges={[]}
          initialViewport={{ centerX: 91, centerY: -17, zoom: 3.25 }}
          nodes={[{ id: "a", kind: "note", label: "A" }]}
          onNodeOpen={vi.fn()}
          settings={createDefaultGlobalGraphSettings()}
        />
      );

      expect(renderedSizes.length).toBeGreaterThan(0);
      expect(renderedSizes.every((size) => size.width !== 640)).toBe(true);
      expect(renderedSizes.at(-1)).toEqual({ height: 420, width: 276 });
      expect(graphMethodState.centerAtCalls).toContainEqual({ duration: 0, x: 91, y: -17 });
      expect(graphMethodState.zoomCalls).toContainEqual({ duration: 0, value: 3.25 });

      const centerCallsBeforeResize = graphMethodState.centerAtCalls.length;
      width = 346;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
        resizeCallback?.([], {} as ResizeObserver);
      });
      expect(renderedSizes.at(-1)).toEqual({ height: 420, width: 276 });
      act(() => {
        const callback = resizeFrame;
        resizeFrame = null;
        callback?.(0);
      });

      expect(renderedSizes.at(-1)).toEqual({ height: 420, width: 346 });
      expect(graphMethodState.centerAtCalls.length).toBeGreaterThan(centerCallsBeforeResize);
      expect(graphMethodState.centerAtCalls.at(-1)).toEqual({ duration: 0, x: 91, y: -17 });
      expect(graphMethodState.zoomCalls.at(-1)).toEqual({ duration: 0, value: 3.25 });
    } finally {
      rect.mockRestore();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("routes canvas click, context menu, temporary drag fixation, and zoom-end events", () => {
    const onNodeContextMenu = vi.fn();
    const onNodeDrag = vi.fn();
    const onNodeDragEnd = vi.fn();
    const onNodeOpen = vi.fn();
    const onViewportChange = vi.fn();
    render(
      <ForceGraphRenderer
        edges={[]}
        nodes={[{ id: "a", kind: "note", label: "A" }]}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDrag={onNodeDrag}
        onNodeDragEnd={onNodeDragEnd}
        onNodeOpen={onNodeOpen}
        onViewportChange={onViewportChange}
        settings={createDefaultGlobalGraphSettings()}
      />
    );
    const graph = capturedGraph.current;
    expect(graph).not.toBeNull();
    if (!graph) return;
    const renderedNode = graph.graphData.nodes[0];
    renderedNode.x = 12;
    renderedNode.y = -8;

    const reheatsBeforeDrag = graphMethodState.reheatCount;
    act(() => graph.onNodeDrag?.(renderedNode));
    expect(renderedNode).toMatchObject({ fx: 12, fy: -8 });
    expect(onNodeDrag).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    act(() => graph.onNodeDragEnd?.(renderedNode));
    expect(renderedNode.fx).toBeUndefined();
    expect(renderedNode.fy).toBeUndefined();
    expect(onNodeDragEnd).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(graphMethodState.reheatCount).toBe(reheatsBeforeDrag + 1);

    act(() => graph.onNodeClick?.(renderedNode, new MouseEvent("click")));
    expect(onNodeOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), { target: "current" });
    act(() => graph.onNodeClick?.(renderedNode, new MouseEvent("click", { ctrlKey: true })));
    expect(onNodeOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), { target: "new-tab" });
    act(() => graph.onNodeClick?.(renderedNode, new MouseEvent("click", { altKey: true, metaKey: true })));
    expect(onNodeOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), { target: "new-group" });
    act(() => graph.onNodeClick?.(renderedNode, new MouseEvent("click", {
      altKey: true,
      metaKey: true,
      shiftKey: true
    })));
    expect(onNodeOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), { target: "new-window" });

    const contextEvent = new MouseEvent("contextmenu", { clientX: 40, clientY: 60 });
    const preventDefault = vi.spyOn(contextEvent, "preventDefault");
    act(() => graph.onNodeRightClick?.(renderedNode, contextEvent));
    expect(preventDefault).toHaveBeenCalled();
    expect(onNodeContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), {
      clientX: 40,
      clientY: 60
    });

    act(() => graph.onZoomEnd?.({ k: 2 }));
    expect(onViewportChange).toHaveBeenLastCalledWith({ centerX: 0, centerY: 0, zoom: 2 });
  });
});
