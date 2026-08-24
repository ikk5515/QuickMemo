export interface CanvasNodeDragCommitState {
  finalChangeSeen: boolean;
  flushScheduled: boolean;
  flushed: boolean;
  nodeId: string;
  positionChanged: boolean;
  stopSeen: boolean;
}

export type CanvasNodeDragCommitSignal = "fallback" | "final-change" | "stop";
export type CanvasNodeDragCommitDecision = "clear" | "flush" | "flush-and-clear" | "wait";

export function createCanvasNodeDragCommitState(nodeId: string): CanvasNodeDragCommitState {
  return {
    finalChangeSeen: false,
    flushScheduled: false,
    flushed: false,
    nodeId,
    positionChanged: false,
    stopSeen: false
  };
}

/**
 * Coalesces React Flow's final position change and drag-stop callback. Both
 * callback orders produce one flush; `fallback` covers an interrupted gesture
 * where only one terminal signal reaches the component.
 */
export function recordCanvasNodeDragCommitSignal(
  state: CanvasNodeDragCommitState,
  signal: CanvasNodeDragCommitSignal,
  positionChanged = false
): CanvasNodeDragCommitDecision {
  state.positionChanged = state.positionChanged || positionChanged;
  if (signal === "final-change") state.finalChangeSeen = true;
  if (signal === "stop") state.stopSeen = true;

  if (state.flushed) {
    return state.finalChangeSeen && state.stopSeen ? "clear" : "wait";
  }
  if (!state.positionChanged) {
    return state.stopSeen ? "clear" : "wait";
  }
  if (state.finalChangeSeen && state.stopSeen) {
    state.flushed = true;
    return "flush-and-clear";
  }
  if (signal === "fallback") {
    state.flushed = true;
    return "flush";
  }
  return "wait";
}
