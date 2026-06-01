import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

describe("schedule UI styles", () => {
  it("uses explicit light and dark calendar hover tokens instead of black inversion", () => {
    expect(stylesSource).toContain("--schedule-hover-bg: #f8fafc");
    expect(stylesSource).toContain("--schedule-event-hover-bg: #f1f5f9");
    expect(stylesSource).toContain("--schedule-hover-bg: #1f2937");
    expect(stylesSource).toContain("--schedule-event-hover-bg: #243244");
    expect(stylesSource).toMatch(/\.calendar-day:hover,[\s\S]*background: var\(--schedule-hover-bg\);/);
    expect(stylesSource).toMatch(/\.calendar-task-pill:hover,[\s\S]*background: var\(--schedule-event-hover-bg\);/);
  });

  it("keeps dark mode primary buttons on button tokens instead of text color tokens", () => {
    expect(stylesSource).toContain("--button-primary-bg: #226b61");
    expect(stylesSource).toMatch(/button \{[\s\S]*background: var\(--button-primary-bg\);/);
    expect(stylesSource).not.toMatch(/button \{[^}]*background: var\(--ink\);/);
  });
});
