import { describe, expect, it } from "vitest";
import {
  isPrimaryScheduleView,
  normalizePrimaryScheduleView,
  primaryScheduleViews,
  scheduleViewFromSearch,
  scheduleViewHref
} from "./scheduleNavigation";

describe("scheduleNavigation", () => {
  it("exposes only Calendar and Matrix as active schedule views", () => {
    expect(primaryScheduleViews).toEqual(["calendar", "matrix"]);
  });

  it("canonicalizes every legacy view to Calendar", () => {
    expect(isPrimaryScheduleView("recurring")).toBe(false);
    expect(isPrimaryScheduleView("todo")).toBe(false);
    expect(isPrimaryScheduleView("completed")).toBe(false);
    expect(normalizePrimaryScheduleView("recurring")).toBe("calendar");
    expect(normalizePrimaryScheduleView("todo")).toBe("calendar");
    expect(normalizePrimaryScheduleView("completed")).toBe("calendar");
  });

  it("maps active and legacy links to stable schedule URLs", () => {
    expect(scheduleViewHref("todo")).toBe("/schedule?view=calendar");
    expect(scheduleViewHref("recurring")).toBe("/schedule?view=calendar");
    expect(scheduleViewHref("completed")).toBe("/schedule?view=calendar");
    expect(scheduleViewFromSearch("?view=matrix")).toBe("matrix");
    expect(scheduleViewFromSearch("?view=calendar")).toBe("calendar");
    expect(scheduleViewFromSearch("?view=completed")).toBeNull();
    expect(scheduleViewFromSearch("?view=unknown")).toBeNull();
  });
});
