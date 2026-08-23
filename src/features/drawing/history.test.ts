import { describe, expect, it } from "vitest";
import {
  MAX_DRAWING_HISTORY_ENTRIES,
  MAX_DRAWING_HISTORY_UTF8_BYTES,
  createDrawingHistory,
  drawingHistoryCounts,
  recordDrawingHistory,
  redoDrawingHistory,
  undoDrawingHistory
} from "./history";

describe("Drawing history budget", () => {
  it("keeps only the newest bounded number of undo snapshots", () => {
    const history = createDrawingHistory();
    for (let index = 0; index < MAX_DRAWING_HISTORY_ENTRIES + 12; index += 1) {
      recordDrawingHistory(history, `source-${index}`);
    }

    expect(drawingHistoryCounts(history)).toEqual({ future: 0, past: MAX_DRAWING_HISTORY_ENTRIES });
    expect(history.past[0]?.source).toBe("source-12");
    expect(history.past.at(-1)?.source).toBe(`source-${MAX_DRAWING_HISTORY_ENTRIES + 11}`);
  });

  it("enforces one UTF-8 byte budget across undo and redo stacks", () => {
    const history = createDrawingHistory();
    const sources = Array.from({ length: 20 }, (_, index) => `${index}:${"가".repeat(150_000)}`);
    for (const source of sources) recordDrawingHistory(history, source);

    expect(history.totalBytes).toBeLessThanOrEqual(MAX_DRAWING_HISTORY_UTF8_BYTES);
    expect(history.past.length).toBeLessThan(sources.length);
    expect(history.past.at(-1)?.source).toBe(sources.at(-1));

    const undone = undoDrawingHistory(history, "current");
    expect(undone?.source).toBe(sources.at(-1));
    expect(history.totalBytes).toBeLessThanOrEqual(MAX_DRAWING_HISTORY_UTF8_BYTES);

    const redone = redoDrawingHistory(history, undone!.source);
    expect(redone?.source).toBe("current");
    expect(history.totalBytes).toBeLessThanOrEqual(MAX_DRAWING_HISTORY_UTF8_BYTES);
    expect(history.past.length + history.future.length).toBeLessThanOrEqual(MAX_DRAWING_HISTORY_ENTRIES);
  });

  it("repairs a corrupt empty history byte counter without looping", () => {
    const history = createDrawingHistory();
    history.totalBytes = MAX_DRAWING_HISTORY_UTF8_BYTES + 1;

    recordDrawingHistory(history, "recovered");

    expect(history.totalBytes).toBe(0);
    expect(drawingHistoryCounts(history)).toEqual({ future: 0, past: 0 });
  });
});
