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

  it("uses a compact Obsidian-style three-view pane with mobile touch targets", () => {
    expect(stylesSource).toMatch(/\.obsidian-schedule-pane \{[\s\S]*max-width: none;[\s\S]*padding: 0;/);
    expect(stylesSource).toMatch(/\.obsidian-schedule-pane \.schedule-header \{[\s\S]*border-bottom: 1px solid var\(--color-border-subtle\);[\s\S]*position: sticky;/);
    expect(stylesSource).toMatch(/\.obsidian-schedule-pane \.schedule-view-tabs \{[\s\S]*box-shadow: none;[\s\S]*grid-template-columns: repeat\(3, minmax\(72px, 1fr\)\);/);
    expect(stylesSource).toMatch(/\.obsidian-schedule-pane \.calendar-panel,[\s\S]*\.obsidian-schedule-pane \.matrix-section \{[\s\S]*border-radius: 4px;[\s\S]*box-shadow: none;/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.obsidian-schedule-pane \.schedule-view-tabs \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.obsidian-schedule-pane \.schedule-view-tabs button,[\s\S]*min-height: 44px;/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.schedule-feedback:not\(\.error\) \{[\s\S]*background: var\(--color-success-subtle\);/);
  });

  it("keeps category filters and text badges usable across themes and mobile widths", () => {
    expect(stylesSource).toMatch(/\.schedule-category-filter \{[\s\S]*grid-template-columns: repeat\(3, minmax\(64px, 1fr\)\);/);
    expect(stylesSource).toContain("--schedule-category-work: #2f5f9f");
    expect(stylesSource).toContain("--schedule-category-personal: #a63f36");
    expect(stylesSource).toMatch(/\.schedule-category-filter button\.active \{[\s\S]*color: var\(--color-primary-hover\);/);
    expect(stylesSource).toMatch(/\.schedule-category-badge\.work \{[\s\S]*--category-color: var\(--schedule-category-work\);/);
    expect(stylesSource).toMatch(/\.schedule-category-badge\.personal \{[\s\S]*--category-color: var\(--schedule-category-personal\);/);
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.schedule-category-badge \{[\s\S]*var\(--color-surface-elevated\)/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.schedule-category-filter \{[\s\S]*width: 100%;/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.calendar-task-pill > \*,[\s\S]*\.calendar-task-spacer,[\s\S]*\.calendar-more \{[\s\S]*display: none;/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.calendar-task-pill\.show-category > \.schedule-category-badge\.compact \{[\s\S]*display: inline-flex;/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.calendar-task-count \{[\s\S]*display: inline-flex;/);
  });

  it("reflows matrix controls and panels across tablet and mobile widths", () => {
    const tabletStyles = stylesSource.slice(stylesSource.lastIndexOf("@media (max-width: 1024px)"));
    const mobileStyles = stylesSource.slice(stylesSource.lastIndexOf("@media (max-width: 640px)"));
    const narrowTabletStyles = stylesSource.slice(stylesSource.lastIndexOf("@media (max-width: 820px)"));

    expect(stylesSource).toContain("@media (hover: none) and (pointer: coarse) and (max-width: 1024px)");
    expect(stylesSource).toMatch(/\.matrix-task-row \{[\s\S]*cursor: default;/);
    expect(stylesSource).toMatch(/\.task-drag-handle \{[\s\S]*cursor: grab;/);
    expect(tabletStyles).toMatch(/\.matrix-layout \{[\s\S]*--matrix-section-height: auto;/);
    expect(tabletStyles).toMatch(/\.matrix-grid \{[\s\S]*grid-auto-rows: auto;/);
    expect(tabletStyles).toMatch(/\.matrix-today-rail \.matrix-section \{[\s\S]*height: auto;[\s\S]*min-height: 140px;/);
    expect(tabletStyles).toMatch(/\.matrix-section > \.matrix-date-groups \{[\s\S]*max-height: none;[\s\S]*overflow-y: visible;/);
    expect(tabletStyles).toMatch(/\.matrix-date-group\.empty \{[\s\S]*display: none;/);
    expect(tabletStyles).toMatch(/\.matrix-task-row \{[\s\S]*grid-template-areas: "drag check main flags";[\s\S]*grid-template-columns: 44px 44px minmax\(0, 1fr\) minmax\(0, auto\);/);
    expect(narrowTabletStyles).toMatch(/\.obsidian-schedule-pane \.matrix-grid \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(mobileStyles).toMatch(/\.matrix-today-rail \.matrix-section \{[\s\S]*min-height: 112px;/);
    expect(mobileStyles).toMatch(/\.obsidian-schedule-pane \.matrix-task-row \{[\s\S]*"drag check main"[\s\S]*"\. \. flags";[\s\S]*grid-template-columns: 44px 44px minmax\(0, 1fr\);/);
    expect(mobileStyles).toMatch(/\.matrix-task-row > \.task-main strong,[\s\S]*overflow-wrap: anywhere;[\s\S]*white-space: normal;/);
    expect(stylesSource).toMatch(/\.obsidian-schedule-pane \.completed-panel \{[\s\S]*inline-size: calc\(100% - 20px\);[\s\S]*margin: 10px;/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.calendar-day \{[\s\S]*min-height: 76px;[\s\S]*padding: 5px 3px;/);
    expect(stylesSource).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.calendar-task-pill \{[\s\S]*border-radius: 999px;[\s\S]*height: 8px;[\s\S]*width: 8px;/);
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
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] \.auth-page:not\(\.login-layout\),[\s\S]*html\[data-theme="dark"\] \.public-share-page \{[\s\S]*var\(--color-app-bg\);/);
    expect(stylesSource).toMatch(/\.login-layout\.auth-page \{[^}]*background: var\(--color-app-bg\);/);
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

  it("preserves literal tabs in editable and read-only note bodies", () => {
    expect(stylesSource).toMatch(/\.rich-body-input\.ProseMirror \{[\s\S]*tab-size: 4;[\s\S]*white-space: pre-wrap;/);
    expect(stylesSource).toMatch(/\.note-preview-body \{[\s\S]*tab-size: 4;[\s\S]*white-space: pre-wrap;/);
    expect(stylesSource).toMatch(/\.note-preview-body\.public-share-body \{[\s\S]*tab-size: 4;[\s\S]*white-space: pre-wrap;/);
    expect(stylesSource).toMatch(/\.admin-note-view-body \{[\s\S]*tab-size: 4;[\s\S]*white-space: pre-wrap;/);
  });
});
