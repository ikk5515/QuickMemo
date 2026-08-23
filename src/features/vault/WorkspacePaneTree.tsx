import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef
} from "react";
import {
  MAXIMUM_WORKSPACE_SPLIT_RATIO,
  MINIMUM_WORKSPACE_SPLIT_RATIO,
  clampWorkspaceSplitRatio,
  workspaceLayoutGroupIds,
  type VaultWorkspacePaneNode,
  type VaultWorkspacePaneSplit
} from "./workspaceLayout";

export interface WorkspacePaneRender {
  groupId: string;
  node: ReactNode;
}

interface WorkspacePaneTreeProps {
  activeGroupId: string;
  layout: VaultWorkspacePaneNode;
  mobile: boolean;
  onResize: (splitId: string, ratio: number) => void;
  panes: readonly WorkspacePaneRender[];
}

interface WorkspaceSplitViewProps {
  node: VaultWorkspacePaneSplit;
  onResize: WorkspacePaneTreeProps["onResize"];
  paneByGroupId: ReadonlyMap<string, ReactNode>;
}

function WorkspacePaneNodeView({
  node,
  onResize,
  paneByGroupId
}: {
  node: VaultWorkspacePaneNode;
  onResize: WorkspacePaneTreeProps["onResize"];
  paneByGroupId: ReadonlyMap<string, ReactNode>;
}) {
  if (node.type === "pane") {
    return paneByGroupId.get(node.groupId) ?? (
      <div className="vault-workspace-pane-unavailable" role="status">이 pane을 복원할 수 없습니다.</div>
    );
  }
  return <WorkspaceSplitView node={node} onResize={onResize} paneByGroupId={paneByGroupId} />;
}

function WorkspaceSplitView({ node, onResize, paneByGroupId }: WorkspaceSplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const pendingRatioRef = useRef(node.ratio);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (activePointerIdRef.current === null) pendingRatioRef.current = node.ratio;
  }, [node.ratio]);

  const cancelFrame = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const commitResize = useCallback(() => {
    if (activePointerIdRef.current === null) return;
    activePointerIdRef.current = null;
    cancelFrame();
    const ratio = clampWorkspaceSplitRatio(pendingRatioRef.current);
    containerRef.current?.style.setProperty("--vault-split-ratio", `${ratio * 100}%`);
    onResize(node.id, ratio);
  }, [cancelFrame, node.id, onResize]);

  useEffect(() => {
    window.addEventListener("blur", commitResize);
    return () => {
      window.removeEventListener("blur", commitResize);
      cancelFrame();
    };
  }, [cancelFrame, commitResize]);

  const updateFromPointer = (event: PointerEvent<HTMLButtonElement>) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const ratio = node.direction === "vertical"
      ? (event.clientX - bounds.left) / bounds.width
      : (event.clientY - bounds.top) / bounds.height;
    pendingRatioRef.current = clampWorkspaceSplitRatio(ratio);
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      containerRef.current?.style.setProperty(
        "--vault-split-ratio",
        `${pendingRatioRef.current * 100}%`
      );
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateFromPointer(event);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current === event.pointerId) updateFromPointer(event);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    commitResize();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const decreasingKey = node.direction === "vertical" ? "ArrowLeft" : "ArrowUp";
    const increasingKey = node.direction === "vertical" ? "ArrowRight" : "ArrowDown";
    let ratio: number | null = null;
    if (event.key === decreasingKey || event.key === increasingKey) {
      const delta = event.shiftKey ? 0.1 : 0.02;
      ratio = node.ratio + (event.key === decreasingKey ? -delta : delta);
    } else if (event.key === "Home") {
      ratio = MINIMUM_WORKSPACE_SPLIT_RATIO;
    } else if (event.key === "End") {
      ratio = MAXIMUM_WORKSPACE_SPLIT_RATIO;
    }
    if (ratio === null) return;
    event.preventDefault();
    onResize(node.id, clampWorkspaceSplitRatio(ratio));
  };

  return (
    <div
      className={`vault-workspace-split split-${node.direction}`}
      data-split-id={node.id}
      ref={containerRef}
      style={{ "--vault-split-ratio": `${node.ratio * 100}%` } as CSSProperties}
    >
      <div className="vault-workspace-split-branch first">
        <WorkspacePaneNodeView node={node.first} onResize={onResize} paneByGroupId={paneByGroupId} />
      </div>
      <button
        aria-label="분할 창 크기 조절"
        aria-orientation={node.direction === "vertical" ? "vertical" : "horizontal"}
        aria-valuemax={MAXIMUM_WORKSPACE_SPLIT_RATIO * 100}
        aria-valuemin={MINIMUM_WORKSPACE_SPLIT_RATIO * 100}
        aria-valuenow={Math.round(node.ratio * 100)}
        className="vault-split-resizer"
        onKeyDown={handleKeyDown}
        onLostPointerCapture={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        role="separator"
        type="button"
      />
      <div className="vault-workspace-split-branch second">
        <WorkspacePaneNodeView node={node.second} onResize={onResize} paneByGroupId={paneByGroupId} />
      </div>
    </div>
  );
}

export function WorkspacePaneTree({ activeGroupId, layout, mobile, onResize, panes }: WorkspacePaneTreeProps) {
  const paneByGroupId = useMemo(
    () => new Map(panes.map((pane) => [pane.groupId, pane.node])),
    [panes]
  );
  if (mobile) {
    const fallbackGroupId = workspaceLayoutGroupIds(layout)[0];
    const activePane = paneByGroupId.get(activeGroupId) ?? paneByGroupId.get(fallbackGroupId);
    return <div className="vault-tab-groups mobile">{activePane}</div>;
  }
  return (
    <div className="vault-tab-groups">
      <WorkspacePaneNodeView node={layout} onResize={onResize} paneByGroupId={paneByGroupId} />
    </div>
  );
}
