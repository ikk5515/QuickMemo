import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schedulePageSource = readFileSync(join(process.cwd(), "src/pages/SchedulePage.tsx"), "utf8");
const scheduleStylesSource = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function lastCssBlock(marker: string) {
  const markerIndex = scheduleStylesSource.lastIndexOf(marker);
  const openingBrace = scheduleStylesSource.indexOf("{", markerIndex);
  let depth = 0;

  expect(markerIndex).toBeGreaterThanOrEqual(0);
  expect(openingBrace).toBeGreaterThan(markerIndex);

  for (let index = openingBrace; index < scheduleStylesSource.length; index += 1) {
    if (scheduleStylesSource[index] === "{") {
      depth += 1;
    } else if (scheduleStylesSource[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return scheduleStylesSource.slice(markerIndex, index + 1);
      }
    }
  }

  throw new Error(`CSS block is not closed: ${marker}`);
}

describe("SchedulePage source boundary", () => {
  it("keeps legacy recurring data services out of the active Calendar and Matrix bundle", () => {
    expect(schedulePageSource).not.toContain("services/recurringHabits");
    expect(schedulePageSource).not.toContain("subscribeRecurringHabits");
    expect(schedulePageSource).not.toContain("subscribeRecurringHabitCheckIns");
  });

  it("keeps Todo, recurring, and the quick panel removed while restoring completed history", () => {
    expect(schedulePageSource).not.toContain("TodayWorkPanel");
    expect(schedulePageSource).not.toContain("TodoView");
    expect(schedulePageSource).not.toContain("RecurringView");
    expect(schedulePageSource).toContain('type ScheduleWorkspaceView = PrimaryScheduleView | "completed"');
    expect(schedulePageSource).toContain('{ view: "completed", label: "완료"');
    expect(schedulePageSource).toContain("function CompletedView(");
    expect(schedulePageSource).toContain('task.status !== "completed"');
    expect(schedulePageSource).not.toContain("false &&");
  });

  it("keeps the matrix, category filters, and completed list inside narrow viewports", () => {
    expect(scheduleStylesSource).toContain("grid-template-columns: repeat(3, minmax(72px, 1fr));");
    expect(scheduleStylesSource).toContain("@media (max-width: 1024px)");
    expect(scheduleStylesSource).toContain('grid-template-areas: "drag check main flags";');
    expect(scheduleStylesSource).toContain("@media (max-width: 820px)");
    expect(scheduleStylesSource).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.obsidian-schedule-pane \.matrix-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u
    );
    expect(scheduleStylesSource).toContain('"drag check main"\n      ". . flags"');
    expect(scheduleStylesSource).toContain("overflow-wrap: anywhere;");
    expect(scheduleStylesSource).toContain("@media (max-width: 420px)");
    expect(scheduleStylesSource).toContain("max-inline-size: 100%;");
    expect(scheduleStylesSource).toContain("min-inline-size: 0;");
  });

  it.each([
    { marker: "@media (max-width: 1024px)", rule: 'grid-template-areas: "drag check main flags";', width: 1024 },
    { marker: "@media (max-width: 820px)", rule: "grid-template-columns: minmax(0, 1fr);", width: 768 },
    { marker: "@media (max-width: 420px)", rule: '"actions";', width: 390 },
    { marker: "@media (max-width: 420px)", rule: "grid-template-columns: minmax(0, 1fr);", width: 320 }
  ])("retains the no-overflow schedule contract at $width px", ({ marker, rule }) => {
    expect(lastCssBlock(marker)).toContain(rule);
  });
});
