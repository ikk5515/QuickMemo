import type { ScheduleView } from "../types";

export type PrimaryScheduleView = Extract<ScheduleView, "todo" | "calendar" | "matrix">;

export const primaryScheduleViews = ["todo", "calendar", "matrix"] as const satisfies readonly PrimaryScheduleView[];

export function isPrimaryScheduleView(value: ScheduleView | null | undefined): value is PrimaryScheduleView {
  return value === "todo" || value === "calendar" || value === "matrix";
}

export function normalizePrimaryScheduleView(value: ScheduleView | null | undefined): PrimaryScheduleView {
  return isPrimaryScheduleView(value) ? value : "todo";
}
