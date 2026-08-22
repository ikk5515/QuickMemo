export const MAX_DRAWING_HISTORY_ENTRIES = 50;
export const MAX_DRAWING_HISTORY_UTF8_BYTES = 4 * 1024 * 1024;

interface DrawingHistorySnapshot {
  bytes: number;
  source: string;
}

export interface DrawingHistoryState {
  future: DrawingHistorySnapshot[];
  past: DrawingHistorySnapshot[];
  totalBytes: number;
}

export interface DrawingHistoryTransition {
  history: DrawingHistoryState;
  source: string;
}

const textEncoder = new TextEncoder();

function snapshot(source: string): DrawingHistorySnapshot {
  return { bytes: textEncoder.encode(source).byteLength, source };
}

function removeFirst(history: DrawingHistoryState, stack: "future" | "past") {
  const removed = history[stack].shift();
  if (removed) history.totalBytes -= removed.bytes;
}

function trimDrawingHistory(history: DrawingHistoryState) {
  while (
    history.past.length + history.future.length > MAX_DRAWING_HISTORY_ENTRIES
    || history.totalBytes > MAX_DRAWING_HISTORY_UTF8_BYTES
  ) {
    if (!history.past.length && !history.future.length) {
      // Recover from an externally constructed or stale serialized state
      // whose byte counter no longer matches its stacks.
      history.totalBytes = 0;
      break;
    }
    if (!history.past.length) {
      removeFirst(history, "future");
      continue;
    }
    if (!history.future.length) {
      removeFirst(history, "past");
      continue;
    }

    // Both first entries are the farthest snapshots from the current state.
    // Drop the larger one first so the total byte budget converges quickly
    // while the immediately reachable undo and redo entries remain intact.
    removeFirst(
      history,
      history.past[0].bytes >= history.future[0].bytes ? "past" : "future"
    );
  }
  history.totalBytes = Math.max(0, history.totalBytes);
  return history;
}

export function createDrawingHistory(): DrawingHistoryState {
  return { future: [], past: [], totalBytes: 0 };
}

export function drawingHistoryCounts(history: DrawingHistoryState) {
  return { future: history.future.length, past: history.past.length };
}

export function recordDrawingHistory(history: DrawingHistoryState, source: string) {
  history.totalBytes -= history.future.reduce((sum, item) => sum + item.bytes, 0);
  history.future = [];
  const next = snapshot(source);
  history.past.push(next);
  history.totalBytes += next.bytes;
  return trimDrawingHistory(history);
}

export function undoDrawingHistory(
  history: DrawingHistoryState,
  currentSource: string
): DrawingHistoryTransition | null {
  const previous = history.past.pop();
  if (!previous) return null;
  history.totalBytes -= previous.bytes;
  const current = snapshot(currentSource);
  history.future.push(current);
  history.totalBytes += current.bytes;
  return { history: trimDrawingHistory(history), source: previous.source };
}

export function redoDrawingHistory(
  history: DrawingHistoryState,
  currentSource: string
): DrawingHistoryTransition | null {
  const next = history.future.pop();
  if (!next) return null;
  history.totalBytes -= next.bytes;
  const current = snapshot(currentSource);
  history.past.push(current);
  history.totalBytes += current.bytes;
  return { history: trimDrawingHistory(history), source: next.source };
}
