import { describe, expect, it } from "vitest";
import {
  isPrimaryScheduleView,
  normalizePrimaryScheduleView,
  primaryScheduleViews,
  scheduleViewFromSearch,
  scheduleViewHref
} from "./scheduleNavigation";

describe("scheduleNavigation", () => {
  it("exposes recurring work as the fourth primary schedule tab", () => {
    expect(primaryScheduleViews).toEqual(["todo", "calendar", "matrix", "recurring"]);
  });

  it("keeps completed history as the only utility view", () => {
    expect(isPrimaryScheduleView("recurring")).toBe(true);
    expect(isPrimaryScheduleView("completed")).toBe(false);
    expect(normalizePrimaryScheduleView("recurring")).toBe("recurring");
    expect(normalizePrimaryScheduleView("completed")).toBe("todo");
  });

  it("maps deep-linked tabs to stable schedule URLs", () => {
    expect(scheduleViewHref("todo")).toBe("/schedule?view=todo");
    expect(scheduleViewHref("recurring")).toBe("/schedule/recurring");
    expect(scheduleViewFromSearch("?view=matrix")).toBe("matrix");
    expect(scheduleViewFromSearch("?view=completed")).toBe("completed");
    expect(scheduleViewFromSearch("?view=unknown")).toBeNull();
  });
});
