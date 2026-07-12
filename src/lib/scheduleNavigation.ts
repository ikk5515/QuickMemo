import type { ScheduleView } from "../types";

export type PrimaryScheduleView = Extract<ScheduleView, "todo" | "calendar" | "matrix" | "recurring">;

export const primaryScheduleViews = ["todo", "calendar", "matrix", "recurring"] as const satisfies readonly PrimaryScheduleView[];

export function isPrimaryScheduleView(value: unknown): value is PrimaryScheduleView {
  return value === "todo" || value === "calendar" || value === "matrix" || value === "recurring";
}

export function normalizePrimaryScheduleView(value: ScheduleView | null | undefined): PrimaryScheduleView {
  return isPrimaryScheduleView(value) ? value : "todo";
}

export function scheduleViewFromSearch(search: string): ScheduleView | null {
  const value = new URLSearchParams(search).get("view");

  return isPrimaryScheduleView(value) || value === "completed"
    ? value
    : null;
}

export function scheduleViewHref(view: ScheduleView) {
  return view === "recurring" ? "/schedule/recurring" : `/schedule?view=${view}`;
}
