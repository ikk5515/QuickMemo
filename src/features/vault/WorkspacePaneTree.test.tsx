import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePaneTree } from "./WorkspacePaneTree";
import type { VaultWorkspacePaneNode } from "./workspaceLayout";

const layout: VaultWorkspacePaneNode = {
  type: "split",
  id: "split_root",
  direction: "vertical",
  ratio: 0.6,
  first: { type: "pane", groupId: "primary" },
  second: {
    type: "split",
    id: "split_nested",
    direction: "horizontal",
    ratio: 0.4,
    first: { type: "pane", groupId: "secondary" },
    second: { type: "pane", groupId: "pane_third" }
  }
};

const panes = [
  { groupId: "primary", node: <div>첫 pane</div> },
  { groupId: "secondary", node: <div>둘째 pane</div> },
  { groupId: "pane_third", node: <div>셋째 pane</div> }
];

describe("WorkspacePaneTree", () => {
  it("renders recursively nested horizontal and vertical panes", () => {
    const { container } = render(
      <WorkspacePaneTree activeGroupId="primary" layout={layout} mobile={false} onResize={vi.fn()} panes={panes} />
    );
    expect(screen.getByText("첫 pane")).toBeInTheDocument();
    expect(screen.getByText("둘째 pane")).toBeInTheDocument();
    expect(screen.getByText("셋째 pane")).toBeInTheDocument();
    expect(container.querySelectorAll("[role=separator]")).toHaveLength(2);
  });

  it("resizes the correct split with orientation-aware keyboard controls", () => {
    const onResize = vi.fn();
    render(
      <WorkspacePaneTree activeGroupId="primary" layout={layout} mobile={false} onResize={onResize} panes={panes} />
    );
    const separators = screen.getAllByRole("separator");
    fireEvent.keyDown(separators[0], { key: "ArrowRight" });
    fireEvent.keyDown(separators[1], { key: "ArrowDown", shiftKey: true });
    expect(onResize).toHaveBeenNthCalledWith(1, "split_root", 0.62);
    expect(onResize).toHaveBeenNthCalledWith(2, "split_nested", 0.5);
  });

  it("commits a pointer resize against the bounds of the selected nested split", () => {
    const onResize = vi.fn();
    const { container } = render(
      <WorkspacePaneTree activeGroupId="primary" layout={layout} mobile={false} onResize={onResize} panes={panes} />
    );
    const rootSplit = container.querySelector<HTMLElement>('[data-split-id="split_root"]')!;
    vi.spyOn(rootSplit, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 1_000,
      top: 0,
      width: 1_000,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    const separator = screen.getAllByRole("separator")[0] as HTMLButtonElement & {
      hasPointerCapture: (pointerId: number) => boolean;
      releasePointerCapture: (pointerId: number) => void;
      setPointerCapture: (pointerId: number) => void;
    };
    separator.setPointerCapture = vi.fn();
    separator.hasPointerCapture = vi.fn(() => false);
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { clientX: 700, clientY: 100, pointerId: 7 });
    fireEvent.pointerUp(separator, { clientX: 700, clientY: 100, pointerId: 7 });
    expect(onResize).toHaveBeenCalledWith("split_root", 0.7);
  });

  it("renders only the selected pane on mobile", () => {
    render(
      <WorkspacePaneTree activeGroupId="pane_third" layout={layout} mobile onResize={vi.fn()} panes={panes} />
    );
    expect(screen.getByText("셋째 pane")).toBeInTheDocument();
    expect(screen.queryByText("첫 pane")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
