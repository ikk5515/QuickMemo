import type { ActiveScheduleView, ScheduleView } from "../types";

export type PrimaryScheduleView = ActiveScheduleView;

export const primaryScheduleViews = ["calendar", "matrix"] as const satisfies readonly PrimaryScheduleView[];

export function isPrimaryScheduleView(value: unknown): value is PrimaryScheduleView {
  return value === "calendar" || value === "matrix";
}

export function normalizePrimaryScheduleView(value: ScheduleView | null | undefined): PrimaryScheduleView {
  return isPrimaryScheduleView(value) ? value : "calendar";
}

export function scheduleViewFromSearch(search: string): PrimaryScheduleView | null {
  const value = new URLSearchParams(search).get("view");

  return isPrimaryScheduleView(value) ? value : null;
}

export function scheduleViewHref(view: ScheduleView | null | undefined) {
  return `/schedule?view=${normalizePrimaryScheduleView(view)}`;
}
