import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface SidebarPreference { width: number; collapsed: boolean }
export interface ControlledSidebarPreference extends SidebarPreference { onChange: (value: SidebarPreference) => void }

export function clampSidebarWidth(width: number, minimum: number, maximum: number) {
  return Math.round(Math.max(minimum, Math.min(Math.max(minimum, maximum), Number.isFinite(width) ? width : minimum)));
}

/** Shared pointer/keyboard resizing. Only the latest drag position is committed per frame. */
export function useResizableSidebar({ width, minWidth, maxWidth, onChange, onCommit }: {
  width: number; minWidth: number; maxWidth: number; onChange: (width: number) => void; onCommit?: (width: number) => void;
}) {
  const [resizing, setResizing] = useState(false);
  const latest = useRef({ width, minWidth, maxWidth, onChange, onCommit });
  useLayoutEffect(() => { latest.current = { width, minWidth, maxWidth, onChange, onCommit }; });
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; target: HTMLElement; userSelect: string; cursor: string } | null>(null);
  const frame = useRef<number | null>(null);
  function flush() {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (drag.current) latest.current.onChange(drag.current.width);
  }
  function finish(commit: boolean) {
    const current = drag.current;
    if (!current) return;
    flush(); drag.current = null;
    document.body.style.userSelect = current.userSelect;
    document.body.style.cursor = current.cursor;
    try { if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId); } catch { /* Detached separators release capture automatically. */ }
    setResizing(false);
    if (commit) latest.current.onCommit?.(current.width);
  }
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const current = drag.current;
    if (current) { document.body.style.userSelect = current.userSelect; document.body.style.cursor = current.cursor; }
  }, []);
  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    const current = latest.current;
    const startWidth = clampSidebarWidth(current.width, current.minWidth, current.maxWidth);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth, target: event.currentTarget,
      userSelect: document.body.style.userSelect, cursor: document.body.style.cursor };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize";
    setResizing(true);
  }
  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.width = clampSidebarWidth(current.startWidth + event.clientX - current.startX, latest.current.minWidth, latest.current.maxWidth);
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (drag.current) latest.current.onChange(drag.current.width); });
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const current = latest.current;
    const step = event.shiftKey ? 48 : 16;
    const requested = event.key === "Home" ? current.minWidth : event.key === "End" ? current.maxWidth
      : event.key === "ArrowLeft" ? current.width - step : event.key === "ArrowRight" ? current.width + step : null;
    if (requested === null) return;
    event.preventDefault();
    const next = clampSidebarWidth(requested, current.minWidth, current.maxWidth);
    current.onChange(next); current.onCommit?.(next);
  }
  return { resizing, separatorProps: {
    role: "separator" as const, tabIndex: 0, "aria-orientation": "vertical" as const,
    "aria-valuemin": minWidth, "aria-valuemax": Math.max(minWidth, maxWidth), "aria-valuenow": clampSidebarWidth(width, minWidth, maxWidth),
    onPointerDown, onPointerMove, onPointerUp: () => finish(true), onPointerCancel: () => finish(true), onLostPointerCapture: () => finish(true), onKeyDown
  } };
}
