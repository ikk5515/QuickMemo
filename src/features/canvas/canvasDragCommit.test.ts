import { describe, expect, it } from "vitest";
import {
  createCanvasNodeDragCommitState,
  recordCanvasNodeDragCommitSignal
} from "./canvasDragCommit";

function terminalDecisions(order: readonly ("final-change" | "stop")[]) {
  const state = createCanvasNodeDragCommitState("card-a");
  return order.map((signal) => recordCanvasNodeDragCommitSignal(state, signal, true));
}

describe("Canvas node drag commit coalescing", () => {
  it("flushes exactly once when the final change arrives before drag-stop", () => {
    expect(terminalDecisions(["final-change", "stop"])).toEqual(["wait", "flush-and-clear"]);
  });

  it("flushes exactly once when drag-stop arrives before the final change", () => {
    expect(terminalDecisions(["stop", "final-change"])).toEqual(["wait", "flush-and-clear"]);
  });

  it("uses one fallback flush and suppresses a delayed counterpart", () => {
    const state = createCanvasNodeDragCommitState("card-a");

    expect(recordCanvasNodeDragCommitSignal(state, "stop", true)).toBe("wait");
    expect(recordCanvasNodeDragCommitSignal(state, "fallback")).toBe("flush");
    expect(recordCanvasNodeDragCommitSignal(state, "final-change", true)).toBe("clear");
  });

  it("does not serialize a gesture whose snapped position never changed", () => {
    const state = createCanvasNodeDragCommitState("card-a");
    expect(recordCanvasNodeDragCommitSignal(state, "stop")).toBe("clear");
  });
});
