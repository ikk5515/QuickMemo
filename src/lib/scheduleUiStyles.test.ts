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

  it("styles the today quick panel trigger and popover surfaces for light and dark themes", () => {
    const mobileStyles = stylesSource.slice(stylesSource.indexOf("@media (max-width: 760px)"));

    expect(stylesSource).toMatch(/\.today-work-trigger\.active,[\s\S]*\.today-work-trigger\[aria-expanded="true"\] \{[\s\S]*background: var\(--color-primary-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.today-work-trigger\.active,[\s\S]*html\[data-theme="dark"\] \.today-work-trigger\[aria-expanded="true"\] \{[\s\S]*background: color-mix\(in srgb, var\(--teal\) 14%, var\(--color-surface-elevated\)\);/);
    expect(stylesSource).toMatch(/\.schedule-tool-menu-trigger\.active,[\s\S]*\.schedule-tool-menu-trigger\[aria-current="page"\] \{[\s\S]*background: var\(--color-primary-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.schedule-tool-menu-trigger\.active,[\s\S]*html\[data-theme="dark"\] \.schedule-tool-menu-trigger\[aria-current="page"\] \{[\s\S]*background: color-mix\(in srgb, var\(--teal\) 14%, var\(--color-surface-elevated\)\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.schedule-tool-menu-popover \{[\s\S]*background: var\(--color-popover-bg\);/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.schedule-view-tabs \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(mobileStyles).toMatch(/\.today-work-panel \{[\s\S]*overflow-y: auto;/);
    expect(mobileStyles).toMatch(/\.today-work-panel \{[\s\S]*position: fixed;/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.today-work-section\.overdue \{[\s\S]*background: var\(--color-danger-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.today-recurring-item\.checked \{[\s\S]*background: var\(--color-success-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.schedule-feedback:not\(\.error\) \{[\s\S]*background: var\(--color-success-subtle\);/);
  });
});
