import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

describe("schedule UI styles", () => {
  it("uses explicit light and dark calendar hover tokens instead of black inversion", () => {
    expect(stylesSource).toContain("--schedule-hover-bg: #f8fafc");
    expect(stylesSource).toContain("--schedule-event-hover-bg: #f1f5f9");
    expect(stylesSource).toContain("--schedule-hover-bg: #2a2a2f");
    expect(stylesSource).toContain("--schedule-event-hover-bg: #303036");
    expect(stylesSource).toMatch(/\.calendar-day:hover,[\s\S]*background: var\(--schedule-hover-bg\);/);
    expect(stylesSource).toMatch(/\.calendar-task-pill:hover,[\s\S]*background: var\(--schedule-event-hover-bg\);/);
  });

  it("keeps dark mode primary buttons on button tokens instead of text color tokens", () => {
    expect(stylesSource).toContain("--button-primary-bg: #2f6f67");
    expect(stylesSource).toMatch(/button \{[\s\S]*background: var\(--button-primary-bg\);/);
    expect(stylesSource).toMatch(/\.home-primary-action \{[\s\S]*background: var\(--button-primary-bg\);[\s\S]*color: var\(--button-primary-color\);/);
    expect(stylesSource).toMatch(/\.home-primary-action:hover,[\s\S]*\.home-primary-action:focus-visible \{[\s\S]*background: var\(--button-primary-hover-bg\);/);
    expect(stylesSource).not.toMatch(/button \{[^}]*background: var\(--ink\);/);
    expect(stylesSource).not.toMatch(/\.home-primary-action \{[^}]*background: var\(--ink\);/);
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

  it("keeps the dark theme on neutral graphite tokens instead of navy surfaces", () => {
    const darkBlock = stylesSource.match(/:root\[data-theme="dark"\] \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(darkBlock).toContain("--color-app-bg: #09090b");
    expect(darkBlock).toContain("--color-page-bg: #0f0f10");
    expect(darkBlock).toContain("--color-surface: #18181b");
    expect(darkBlock).toContain("--color-surface-elevated: #222226");
    expect(darkBlock).toContain("--color-surface-hover: #2a2a2f");
    expect(darkBlock).not.toMatch(/#0b1120|#0f172a|#111827|#172033|#1e293b|#1f2937|#243244/u);
  });

  it("covers note, admin, recurring, and preview surfaces with dark-mode overrides", () => {
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.note-list-item,[\s\S]*html\[data-theme="dark"\] \.overview-note-card,[\s\S]*background: var\(--color-surface\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.rich-toolbar-tabs,[\s\S]*html\[data-theme="dark"\] \.text-color-palette,[\s\S]*background: var\(--color-surface-elevated\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.admin-user-card,[\s\S]*html\[data-theme="dark"\] \.admin-note-card,[\s\S]*background: var\(--color-surface\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.recurring-habit-row,[\s\S]*html\[data-theme="dark"\] \.recurring-overview-item,[\s\S]*background: var\(--color-surface\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.pdf-preview-canvas-frame,[\s\S]*html\[data-theme="dark"\] \.public-image-preview-frame \{[\s\S]*background: var\(--color-app-bg\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.auth-page,[\s\S]*html\[data-theme="dark"\] \.public-share-page \{[\s\S]*var\(--color-app-bg\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.schedule-color-picker input\[type="color"\] \{[\s\S]*background: var\(--color-input-bg\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.empty-state,[\s\S]*html\[data-theme="dark"\] \.note-empty-state,[\s\S]*background: var\(--color-surface-hover\);/);
  });

  it("keeps note all-view and editor controls neutral in dark mode", () => {
    expect(stylesSource).toMatch(/\.overview-note-open \{[\s\S]*border: 0;/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.overview-note-open,[\s\S]*html\[data-theme="dark"\] \.note-list-open \{[\s\S]*border-color: transparent;/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.overview-note-open:focus-visible,[\s\S]*html\[data-theme="dark"\] \.note-list-open:focus-visible \{[\s\S]*box-shadow: 0 0 0 3px var\(--color-focus-ring\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.notes-top-actions \.note-nav-button \{[\s\S]*background: var\(--color-primary-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.notes-top-actions \.note-nav-button\.has-alert \{[\s\S]*background: var\(--color-danger-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.folder-filter-button\.active:not\(:disabled\):hover,[\s\S]*html\[data-theme="dark"\] \.image-size-toolbar button\.active:not\(:disabled\):focus-visible \{[\s\S]*background: var\(--color-primary-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.secondary-button\.active,[\s\S]*html\[data-theme="dark"\] \.admin-tabs button\[aria-selected="true"\] \{[\s\S]*background: var\(--color-primary-subtle\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.secondary-button\.danger:not\(:disabled\):hover,[\s\S]*html\[data-theme="dark"\] \.icon-button\.danger:not\(:disabled\):focus-visible \{[\s\S]*background: color-mix\(in srgb, var\(--coral\) 18%, var\(--color-surface-elevated\)\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.attachment-upload-toast\.complete \.attachment-upload-icon \{[\s\S]*background: color-mix\(in srgb, var\(--teal\) 14%, var\(--color-surface-elevated\)\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.document-preview-page \{[\s\S]*background: var\(--color-surface\);[\s\S]*color: var\(--ink\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.folder-color-picker button\.active \{[\s\S]*box-shadow:[\s\S]*var\(--color-surface\)/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.cell-color-palette button\.active,[\s\S]*html\[data-theme="dark"\] \.text-color-palette button\.active \{[\s\S]*var\(--color-surface-elevated\)/);
  });
});
