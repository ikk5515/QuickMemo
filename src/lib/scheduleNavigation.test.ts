import { describe, expect, it } from "vitest";
import { isPrimaryScheduleView, normalizePrimaryScheduleView, primaryScheduleViews } from "./scheduleNavigation";

describe("scheduleNavigation", () => {
  it("keeps the public schedule navigation focused on the three primary views", () => {
    expect(primaryScheduleViews).toEqual(["todo", "calendar", "matrix"]);
  });

  it("treats recurring and completed as utility views instead of top-level tabs", () => {
    expect(isPrimaryScheduleView("recurring")).toBe(false);
    expect(isPrimaryScheduleView("completed")).toBe(false);
    expect(normalizePrimaryScheduleView("recurring")).toBe("todo");
    expect(normalizePrimaryScheduleView("completed")).toBe("todo");
  });
});
