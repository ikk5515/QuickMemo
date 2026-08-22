import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphAccessibilityList, GraphCanvas, graphKeyboardAction } from "./GraphCanvas";
import { createDefaultGlobalGraphSettings, createDefaultLocalGraphSettings } from "./graphSettings";
import type { GraphEdge, GraphNode } from "./types";

const canvasRendererState = vi.hoisted(() => ({
  deferReady: false,
  fitCalls: 0,
  panCalls: [] as Array<{ deltaX: number; deltaY: number }>,
  props: null as null | {
    onReady?: () => void;
    onViewportChange?: (viewport: { centerX: number; centerY: number; zoom: number }) => void;
  },
  zoomCalls: [] as number[]
}));

vi.mock("./ForceGraphRenderer", () => ({
  default: forwardRef(function MockForceGraphRenderer(
    props: {
      onReady?: () => void;
      onViewportChange?: (viewport: { centerX: number; centerY: number; zoom: number }) => void;
    },
    ref
  ) {
    const { onReady } = props;
    canvasRendererState.props = props;
    useImperativeHandle(ref, () => ({
      copyImage: async () => null,
      fitView: () => {
        canvasRendererState.fitCalls += 1;
      },
      panBy: (deltaX: number, deltaY: number) => {
        canvasRendererState.panCalls.push({ deltaX, deltaY });
      },
      zoomBy: (factor: number) => {
        canvasRendererState.zoomCalls.push(factor);
      }
    }));
    useEffect(() => {
      if (!canvasRendererState.deferReady) {
        onReady?.();
      }
    }, [onReady]);
    return <canvas data-testid="graph-renderer" />;
  })
}));

const nodes: GraphNode[] = [
  { id: "note-a", kind: "note", label: "프로젝트", path: "Work/프로젝트.md" },
  { id: "tag-work", kind: "tag", label: "#work" },
  { id: "missing", kind: "unresolved", label: "다음 노트" }
];

const edges: GraphEdge[] = [
  { id: "edge-a", sourceId: "note-a", targetId: "tag-work" },
  { id: "edge-b", sourceId: "note-a", targetId: "missing" }
];

afterEach(() => {
  vi.unstubAllGlobals();
  canvasRendererState.deferReady = false;
  canvasRendererState.fitCalls = 0;
  canvasRendererState.panCalls.length = 0;
  canvasRendererState.props = null;
  canvasRendererState.zoomCalls.length = 0;
});

describe("GraphAccessibilityList", () => {
  it("exposes every Canvas node with its kind and distinct connection count", async () => {
    const user = userEvent.setup();
    const onNodeOpen = vi.fn();
    const onNodeContextMenu = vi.fn();
    render(
      <GraphAccessibilityList
        activeNodeId="note-a"
        edges={edges}
        nodes={nodes}
        onNodeContextMenu={onNodeContextMenu}
        onNodeOpen={onNodeOpen}
      />
    );

    const project = screen.getByRole("button", { name: "프로젝트, 노트, 연결 2개" });
    expect(project).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "#work, 태그, 연결 1개" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음 노트, 생성되지 않은 링크, 연결 1개" })).toBeInTheDocument();

    await user.click(project);
    expect(onNodeOpen).toHaveBeenCalledWith(nodes[0], { target: "current" });

    fireEvent.click(project, { altKey: true, ctrlKey: true });
    expect(onNodeOpen).toHaveBeenLastCalledWith(nodes[0], { target: "new-group" });

    fireEvent.click(project, { altKey: true, ctrlKey: true, shiftKey: true });
    expect(onNodeOpen).toHaveBeenLastCalledWith(nodes[0], { target: "new-window" });

    fireEvent.contextMenu(project, { clientX: 12, clientY: 24 });
    expect(onNodeContextMenu).toHaveBeenCalledWith(nodes[0], { clientX: 12, clientY: 24 });
  });

  it("announces an empty graph instead of rendering an empty list", () => {
    render(<GraphAccessibilityList edges={[]} nodes={[]} onNodeOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("표시할 그래프 노드가 없습니다.");
  });

  it("windows very large accessible graphs into bounded DOM batches", async () => {
    const user = userEvent.setup();
    const manyNodes = Array.from({ length: 450 }, (_, index): GraphNode => ({
      id: `node-${index}`,
      kind: "note",
      label: `노트 ${index}`
    }));
    render(<GraphAccessibilityList edges={[]} nodes={manyNodes} onNodeOpen={vi.fn()} />);

    const list = screen.getByRole("list", { name: "그래프 노드" });
    expect(within(list).getAllByRole("button")).toHaveLength(200);
    expect(screen.getByText("전체 450개 중 200개 표시")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "다음 200개 표시" }));
    expect(within(list).getAllByRole("button")).toHaveLength(400);
    await user.click(screen.getByRole("button", { name: "다음 50개 표시" }));
    expect(within(list).getAllByRole("button")).toHaveLength(450);
    expect(screen.queryByRole("button", { name: /다음 .*개 표시/ })).not.toBeInTheDocument();
  });
});

describe("GraphCanvas", () => {
  it("maps zoom and normal/accelerated keyboard panning to deterministic actions", () => {
    expect(graphKeyboardAction("+", false)).toEqual({ type: "zoom", factor: 1.25 });
    expect(graphKeyboardAction("-", false)).toEqual({ type: "zoom", factor: 0.8 });
    expect(graphKeyboardAction("ArrowLeft", false)).toEqual({ type: "pan", deltaX: -32, deltaY: 0 });
    expect(graphKeyboardAction("ArrowDown", true)).toEqual({ type: "pan", deltaX: 0, deltaY: 120 });
    expect(graphKeyboardAction("Escape", false)).toBeNull();
  });

  it("falls back to the accessible list when Canvas is unavailable in tests", () => {
    render(
      <GraphCanvas
        edges={edges}
        nodes={nodes}
        onNodeOpen={vi.fn()}
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    expect(screen.getByRole("region", { name: "전체 그래프" })).toBeInTheDocument();
    expect(screen.getByText("그래프 Canvas를 사용할 수 없어 목록으로 표시합니다.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "그래프 노드" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "확대" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "전체 그래프 북마크" })).toBeDisabled();
  });

  it("wires keyboard and toolbar controls to the live renderer without moving browser focus", async () => {
    render(
      <GraphCanvas
        edges={edges}
        nodes={nodes}
        onNodeOpen={vi.fn()}
        renderMode="canvas"
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    await screen.findByTestId("graph-renderer");
    const graph = screen.getByRole("region", { name: "전체 그래프" });
    const zoomIn = screen.getByRole("button", { name: "확대" });
    await waitFor(() => expect(zoomIn).toBeEnabled());
    expect(fireEvent.keyDown(graph, { key: "=", shiftKey: false })).toBe(false);
    expect(fireEvent.keyDown(graph, { key: "ArrowDown", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(graph, { key: "Escape" })).toBe(true);
    expect(canvasRendererState.zoomCalls).toEqual([1.25]);
    expect(canvasRendererState.panCalls).toEqual([{ deltaX: 0, deltaY: 120 }]);

    await userEvent.click(zoomIn);
    await userEvent.click(screen.getByRole("button", { name: "축소" }));
    await userEvent.click(screen.getByRole("button", { name: "화면에 맞추기" }));
    expect(canvasRendererState.zoomCalls).toEqual([1.25, 1.25, 0.8]);
    expect(canvasRendererState.fitCalls).toBe(1);
  });

  it("replays bounded keyboard input once the lazy Canvas renderer becomes ready", async () => {
    canvasRendererState.deferReady = true;
    render(
      <GraphCanvas
        edges={edges}
        nodes={nodes}
        onNodeOpen={vi.fn()}
        renderMode="canvas"
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    await screen.findByTestId("graph-renderer");
    const graph = screen.getByRole("region", { name: "전체 그래프" });
    expect(fireEvent.keyDown(graph, { key: "=" })).toBe(false);
    expect(fireEvent.keyDown(graph, { key: "ArrowRight" })).toBe(false);
    expect(canvasRendererState.zoomCalls).toEqual([]);
    expect(canvasRendererState.panCalls).toEqual([]);

    act(() => canvasRendererState.props?.onReady?.());
    expect(canvasRendererState.zoomCalls).toEqual([1.25]);
    expect(canvasRendererState.panCalls).toEqual([{ deltaX: 32, deltaY: 0 }]);
  });

  it("mirrors restored and renderer-observed viewports for encrypted reload acceptance", async () => {
    render(
      <GraphCanvas
        edges={edges}
        initialViewport={{ centerX: -12.5, centerY: 44.25, zoom: 1.75 }}
        nodes={nodes}
        onNodeOpen={vi.fn()}
        renderMode="canvas"
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    await screen.findByTestId("graph-renderer");
    const graph = screen.getByRole("region", { name: "전체 그래프" });
    expect(graph).toHaveAttribute("data-graph-center-x", "-12.5");
    expect(graph).toHaveAttribute("data-graph-center-y", "44.25");
    expect(graph).toHaveAttribute("data-graph-zoom", "1.75");

    act(() => canvasRendererState.props?.onViewportChange?.({ centerX: 80, centerY: -20, zoom: 3 }));
    expect(graph).toHaveAttribute("data-graph-center-x", "80");
    expect(graph).toHaveAttribute("data-graph-center-y", "-20");
    expect(graph).toHaveAttribute("data-graph-zoom", "3");
  });

  it("labels Local Graph independently and keeps its accessible fallback interactive", async () => {
    const user = userEvent.setup();
    const onNodeOpen = vi.fn();
    render(
      <GraphCanvas
        edges={edges}
        nodes={nodes}
        onNodeOpen={onNodeOpen}
        renderMode="accessible"
        settings={createDefaultLocalGraphSettings()}
      />
    );

    expect(screen.getByRole("region", { name: "로컬 그래프" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "#work, 태그, 연결 1개" }));
    expect(onNodeOpen).toHaveBeenCalledWith(nodes[1], { target: "current" });
    expect(screen.queryByRole("button", { name: "전체 그래프 북마크" })).not.toBeInTheDocument();
  });

  it("scrubs the Global Graph creation timeline and hides future nodes and edges", () => {
    const settings = createDefaultGlobalGraphSettings();
    settings.animate = true;
    const datedNodes: GraphNode[] = [
      { id: "old", kind: "note", label: "오래된 노트", createdAt: 100 },
      { id: "new", kind: "note", label: "새 노트", createdAt: 200 }
    ];
    render(
      <GraphCanvas
        edges={[{ id: "old-new", sourceId: "old", targetId: "new" }]}
        nodes={datedNodes}
        onNodeOpen={vi.fn()}
        renderMode="accessible"
        settings={settings}
      />
    );

    expect(screen.getByRole("slider", { name: "그래프 생성일 위치" })).toHaveValue("1");
    expect(screen.getByRole("button", { name: "새 노트, 노트, 연결 1개" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "그래프 생성일 위치" }), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "오래된 노트, 노트, 연결 0개" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /새 노트/ })).not.toBeInTheDocument();
  });

  it("keeps timeline scrubbing but disables automatic playback when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    })));
    const settings = createDefaultGlobalGraphSettings();
    settings.animate = true;
    render(
      <GraphCanvas
        edges={[]}
        nodes={[{ id: "dated", kind: "note", label: "날짜 노트", createdAt: 100 }]}
        onNodeOpen={vi.fn()}
        renderMode="accessible"
        settings={settings}
      />
    );

    expect(screen.getByRole("button", { name: "타임라인 재생" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "그래프 생성일 위치" })).toBeEnabled();
    expect(screen.getByText("모션 감소 설정으로 자동 재생 꺼짐")).toBeInTheDocument();
  });
});
