import { expect, test } from "@playwright/test";
import { URL } from "node:url";

test("closing the public graph restores keyboard focus to its opener", async ({ page }, testInfo) => {
  test.skip(!/^(?:vault-chromium-desktop-1280|vault-webkit-desktop-1280|vault-firefox-desktop-1280)$/u.test(testInfo.project.name),
    "The regression varies its viewport once per browser engine.");
  const entry = { id: `e_${"d".repeat(32)}`, folderId: null, title: "Focus", path: "Focus.md", kind: "markdown" };
  const manifest = { wikiId: `pw1_${"g".repeat(32)}`, slug: "graph-focus", revision: 1,
    title: "Graph focus", expiresAt: null, updatedAt: "2026-09-06T00:00:00Z", folders: [], entries: [entry] };
  await page.route("**/api/published-wikis?*", async (route) => {
    expect(route.request().method()).toBe("GET");
    const action = new URL(route.request().url()).searchParams.get("action");
    expect(["manifest", "content"]).toContain(action);
    await route.fulfill({ json: action === "manifest" ? manifest : { revision: 1, entries: [{ ...entry, body: "# Focus\n\nKeyboard navigation." }] } });
  });
  await page.goto("/wiki/graph-focus?page=Focus.md");
  const opener = page.getByRole("button", { name: "그래프 크게 보기", exact: true });
  const dialog = page.getByRole("dialog", { name: "위키 그래프 크게 보기", exact: true });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const method of ["button", "Escape"]) {
      await opener.click();
      await expect(dialog).toBeVisible();
      if (method === "button") await dialog.getByRole("button", { name: "그래프 닫기", exact: true }).click();
      else await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  }
});
