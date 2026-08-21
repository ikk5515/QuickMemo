import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GraphAccessibilityList, GraphCanvas } from "./GraphCanvas";
import { createDefaultGlobalGraphSettings, createDefaultLocalGraphSettings } from "./graphSettings";
import type { GraphEdge, GraphNode } from "./types";

const nodes: GraphNode[] = [
  { id: "note-a", kind: "note", label: "프로젝트", path: "Work/프로젝트.md" },
  { id: "tag-work", kind: "tag", label: "#work" },
  { id: "missing", kind: "unresolved", label: "다음 노트" }
];

const edges: GraphEdge[] = [
  { id: "edge-a", sourceId: "note-a", targetId: "tag-work" },
  { id: "edge-b", sourceId: "note-a", targetId: "missing" }
];

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

    fireEvent.click(project, { altKey: true, ctrlKey: true, shiftKey: true });
    expect(onNodeOpen).toHaveBeenLastCalledWith(nodes[0], { target: "new-window" });

    fireEvent.contextMenu(project, { clientX: 12, clientY: 24 });
    expect(onNodeContextMenu).toHaveBeenCalledWith(nodes[0], { clientX: 12, clientY: 24 });
  });

  it("announces an empty graph instead of rendering an empty list", () => {
    render(<GraphAccessibilityList edges={[]} nodes={[]} onNodeOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("표시할 그래프 노드가 없습니다.");
  });
});

describe("GraphCanvas", () => {
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
});
