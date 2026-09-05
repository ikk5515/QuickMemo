/* global window, document, performance, requestAnimationFrame, getComputedStyle */
import { expect, test } from "@playwright/test";
import { URL } from "node:url";
import { expectVisibleWikiMotionFinished } from "./wiki-motion-helpers.mjs";

const entries = ["A", "B", "C"].map((title, index) => ({
  id: `e_${String(index + 1).padStart(32, "0")}`, folderId: null, title,
  path: `${title}.md`, kind: "markdown"
}));
const manifest = { wikiId: `pw1_${"m".repeat(32)}`, slug: "motion-check", revision: 1,
  title: "Panel motion", expiresAt: null, updatedAt: "2026-09-06T00:00:00Z", folders: [], entries };

// Sample the real rendered frames beginning at the user's click, not at an
// estimated sleep before navigation. No CSS durations or animations are mocked.
async function sampleClick(page, click) {
  await page.evaluate(() => {
    window.motionSamples = new Promise((resolve) => document.addEventListener("click", () => {
      const frames = []; const started = performance.now();
      const sample = () => {
        frames.push([...document.querySelectorAll(".wiki-document-slot")].map((slot) => {
          const style = getComputedStyle(slot);
          const article = slot.querySelector(".wiki-panel"); const articleStyle = getComputedStyle(article);
          return { id: slot.dataset.noteId, x: slot.getBoundingClientRect().x,
            width: slot.getBoundingClientRect().width, opacity: Number(style.opacity),
            visible: style.visibility === "visible", inert: article.inert,
            articleVisible: articleStyle.visibility === "visible", articleOpacity: Number(articleStyle.opacity),
            articleX: article.getBoundingClientRect().x };
        }));
        if (performance.now() - started < 420) requestAnimationFrame(sample); else resolve(frames);
      };
      requestAnimationFrame(sample);
    }, { once: true, capture: true }));
  });
  await click();
  return page.evaluate(() => window.motionSamples);
}
const framesFor = (frames, id) => frames.flatMap((frame) => frame.filter((slot) => slot.id === id));
const intermediate = (frames) => frames.filter((frame) => frame.opacity > 0.01 && frame.opacity < 0.99);

test("compact Wiki transitions preserve document DOM and scroll while fading, sliding and closing", async ({ page }, testInfo) => {
  test.skip(!/^(?:vault-chromium-desktop-1280|vault-webkit-desktop-1280|vault-firefox-desktop-1280)$/u.test(testInfo.project.name),
    "Geometry and real motion run once per engine; this test changes its own viewport.");
  const errors = []; page.on("pageerror", () => errors.push("runtime-error"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/published-wikis?*", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    const action = url.searchParams.get("action");
    expect(["manifest", "content"]).toContain(action);
    const ids = new Set((url.searchParams.get("ids") ?? "").split(","));
    await route.fulfill({ json: action === "manifest" ? manifest : { revision: 1,
      entries: entries.filter((entry) => ids.has(entry.id)).map((entry) => ({ ...entry,
        body: `# ${entry.title}\n\n${entries.filter((other) => other.id !== entry.id).map((other) => `[[${other.title}]]`).join("\n\n")}\n\n${"Long document paragraph.\n\n".repeat(60)}` })) } });
  });
  await page.goto("/wiki/motion-check?page=A.md");
  const panel = (title) => page.locator(`.wiki-panel[data-note-id="${entries.find((entry) => entry.title === title).id}"]`);
  const follow = (from, to) => panel(from).locator(".wiki-body").getByRole("button", { name: to, exact: true });
  await expect(follow("A", "B")).toBeVisible();
  await expect(page.locator(".wiki-local-graph canvas")).toBeVisible();
  await expectVisibleWikiMotionFinished(page);
  await panel("A").evaluate((element) => { window.originalPanelA = element; element.scrollTop = 120; });
  // Start at the links without resetting the reading position retained below.
  await panel("A").evaluate((element) => { element.scrollTop = 0; });
  await follow("A", "B").click();
  await expect(follow("B", "A")).toBeVisible();
  await expectVisibleWikiMotionFinished(page);
  await panel("A").evaluate((element) => { element.scrollTop = 120; });
  const activated = await sampleClick(page, () => follow("B", "A").click());
  expect(intermediate(framesFor(activated, entries[0].id)).length).toBeGreaterThan(1);
  expect(new Set(framesFor(activated, entries[0].id).map((frame) => Math.round(frame.x * 10))).size).toBeGreaterThan(2);
  expect(intermediate(framesFor(activated, entries[1].id)).length).toBeGreaterThan(1);
  expect(intermediate(framesFor(activated, entries[1].id)).every((frame) => frame.inert)).toBe(true);
  expect(await panel("A").evaluate((element) => element === window.originalPanelA && element.scrollTop === 120)).toBe(true);
  await expect(panel("B")).toBeHidden();
  await panel("A").evaluate((element) => { element.scrollTop = 0; });
  await follow("A", "C").click(); await expect(follow("C", "B")).toBeVisible();
  await expectVisibleWikiMotionFinished(page);
  // An active close fades its existing contents and selects its neighbor;
  // the closed editor is inaccessible immediately and removed after motion.
  const closed = await sampleClick(page, () => panel("C").getByRole("button", { name: "C 문서 닫기", exact: true }).click());
  const exiting = framesFor(closed, entries[2].id);
  expect(intermediate(exiting).length).toBeGreaterThan(1);
  expect(intermediate(exiting).every((frame) => frame.inert && frame.visible && frame.articleVisible)).toBe(true);
  await expect(panel("C")).toHaveCount(0);
  await expect(panel("B")).toHaveAttribute("data-active", "true");
  expect(await panel("A").evaluate((element) => element === window.originalPanelA)).toBe(true);
  // Resizing keeps the same instances and settles without document overflow.
  await page.setViewportSize({ width: 1440, height: 900 }); await expectVisibleWikiMotionFinished(page);
  expect(await panel("A").evaluate((element) => element === window.originalPanelA)).toBe(true);
  const opened = await sampleClick(page, () => follow("B", "C").click());
  const incoming = framesFor(opened, entries[2].id);
  expect(incoming.filter((frame) => frame.articleOpacity > 0.01 && frame.articleOpacity < 0.99).length).toBeGreaterThan(1);
  expect(new Set(incoming.map((frame) => Math.round(frame.articleX * 10))).size).toBeGreaterThan(2);
  const desktopClose = await sampleClick(page, () => panel("C").getByRole("button", { name: "C 문서 닫기", exact: true }).click());
  const desktopExiting = intermediate(framesFor(desktopClose, entries[2].id));
  expect(desktopExiting.length).toBeGreaterThan(1);
  expect(desktopExiting.every((frame) => frame.articleVisible && frame.inert)).toBe(true);
  expect(new Set(framesFor(desktopClose, entries[1].id).map((frame) => Math.round(frame.width))).size).toBeGreaterThan(2);
  await expect(panel("C")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 }); await expectVisibleWikiMotionFinished(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await follow("B", "A").click();
  expect(await page.locator(".wiki-panel-stack").evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  await expect(panel("A")).toHaveAttribute("data-active", "true"); await expect(panel("B")).toBeHidden();
  expect(errors).toEqual([]);
});
