/* global document, getComputedStyle, window */
import { expect, test } from "@playwright/test";
import { URL } from "node:url";

const entry = { id: `e_${"c".repeat(32)}`, folderId: null, title: "Checklist", path: "Checklist.md", kind: "markdown" };
const manifest = { wikiId: `pw1_${"t".repeat(32)}`, slug: "checklist-layout", revision: 1,
  title: "Checklist layout", expiresAt: null, updatedAt: "2026-09-06T00:00:00Z", folders: [], entries: [entry] };
const body = ["# Checklist", "", "- [ ] 저장 확인", "- [x] 完了した作業", "- [ ] A long task label that wraps onto several lines on a narrow screen and keeps its checkbox beside the first line.",
  "  - [x] Nested completed task", "", "- A normal bullet stays a normal list item."].join("\n");

test("public Markdown checkboxes align with the first text line at desktop, tablet and mobile widths", async ({ page }, testInfo) => {
  test.skip(!/^(?:vault-chromium-desktop-1280|vault-webkit-desktop-1280|vault-firefox-desktop-1280)$/u.test(testInfo.project.name),
    "The layout regression varies its own viewport once per browser engine.");
  const errors = []; page.on("pageerror", () => errors.push("runtime-error"));
  await page.route("**/api/published-wikis?*", async (route) => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    expect(["manifest", "content"]).toContain(action);
    if (action === "content") expect(url.searchParams.get("ids")).toBe(entry.id);
    await route.fulfill({ json: action === "manifest" ? manifest : { revision: 1, entries: [{ ...entry, body }] } });
  });
  await page.goto("/wiki/checklist-layout?page=Checklist.md");
  const tasks = page.locator(".wiki-body .qm-markdown-task");
  await expect(tasks).toHaveCount(4);
  const measurements = [];
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const rows = await tasks.evaluateAll((items) => items.map((item) => {
        const checkbox = item.querySelector(":scope > input");
        const label = item.querySelector(":scope > span");
        const inputRect = checkbox.getBoundingClientRect(); const labelRect = label.getBoundingClientRect();
        const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
        return { disabled: checkbox.disabled, checked: checkbox.checked,
          centerOffset: inputRect.y + inputRect.height / 2 - (labelRect.y + lineHeight / 2),
          height: inputRect.height, lineHeight, labelHeight: labelRect.height,
          gap: labelRect.x - inputRect.right };
      }));
      measurements.push({ width, theme, rows });
      for (const row of rows) {
        expect(row.disabled).toBe(true);
        expect(Math.abs(row.centerOffset), JSON.stringify({ width, theme, row })).toBeLessThanOrEqual(1);
        expect(row.height).toBeLessThanOrEqual(row.lineHeight);
        expect(row.gap).toBeGreaterThanOrEqual(4);
      }
      expect(rows.map((row) => row.checked)).toEqual([false, true, false, true]);
      if (width === 320) expect(rows[2].labelHeight).toBeGreaterThan(rows[2].lineHeight * 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if ((width === 1440 && theme === "light") || (width === 320 && theme === "dark")) {
        await page.screenshot({ path: testInfo.outputPath(`checklist-${width}-${theme}.png`) });
      }
    }
  }
  await testInfo.attach("checkbox-geometry.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  await expect(page.locator(".wiki-body li:not(.qm-markdown-task)")).toHaveCount(1);
  expect(errors).toEqual([]);
});
