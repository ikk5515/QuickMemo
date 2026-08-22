import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schedulePageSource = readFileSync(join(process.cwd(), "src/pages/SchedulePage.tsx"), "utf8");

describe("SchedulePage source boundary", () => {
  it("keeps legacy recurring data services out of the active Calendar and Matrix bundle", () => {
    expect(schedulePageSource).not.toContain("services/recurringHabits");
    expect(schedulePageSource).not.toContain("subscribeRecurringHabits");
    expect(schedulePageSource).not.toContain("subscribeRecurringHabitCheckIns");
  });

  it("does not retain hidden Todo, recurring, completed, or quick-panel JSX", () => {
    expect(schedulePageSource).not.toContain("TodayWorkPanel");
    expect(schedulePageSource).not.toContain("TodoView");
    expect(schedulePageSource).not.toContain("RecurringView");
    expect(schedulePageSource).not.toContain("CompletedView");
    expect(schedulePageSource).not.toContain("false &&");
  });
});
