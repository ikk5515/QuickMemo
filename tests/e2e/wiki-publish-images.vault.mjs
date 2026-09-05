/* global Buffer, window, Event */
import { expect, test } from "@playwright/test";
import { allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime, loginDirectly, navigateWithinApp, observePage, ownedVaultNotesState, seedScenario } from "./helpers.mjs";

test("a selected folder publishes its encrypted raster image without granting access to the original note", async ({ browser, page, request }, testInfo) => {
  test.skip(!["vault-chromium-desktop-1440", "vault-webkit-desktop-1280"].includes(testInfo.project.name), "Raster publication acceptance runs once per browser engine.");
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  const explorer = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  const create = explorer.getByRole("button", { name: "새 노트", exact: true });
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  await page.getByLabel("노트 이름").fill("이미지 원본");
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown 편집기" }).fill("원본은공개하지않습니다");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "이미지 파일 추가", exact: true }).click();
  await (await chooserPromise).setFiles({
    name: "public-fixture.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  });
  await expect.poll(async () => (await ownedVaultNotesState(request, fixture.viewerAuth.uid)).filter((note) => note.entryKind === "asset").length, { timeout: 30_000 }).toBe(1);
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  const folder = explorer.getByRole("treeitem", { name: "붙여넣은 이미지", exact: true });
  await expect(folder).toBeVisible();
  await folder.click();
  await create.click();
  await page.getByLabel("노트 이름").fill("이미지 안내");
  await page.getByRole("button", { name: "소스 모드", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown 편집기" }).fill("# 이미지 안내\n\n![[이미지 원본 -1.png]]");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  const original = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "폴더 위키 공개…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "폴더 위키 공개", exact: true });
  await expect(dialog.getByRole("region", { name: "공개할 내용" })).toContainText("메모 1개 · 이미지 1개");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "위키 게시", exact: true }).click();
  const link = dialog.locator('a[target="_blank"]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  const anonymous = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ko-KR" });
  try {
    const reader = await anonymous.newPage();
    const failures = [];
    reader.on("pageerror", (error) => failures.push(error.message));
    await reader.goto(await link.getAttribute("href"));
    await expect(reader.locator(".wiki-title")).toHaveText("이미지 안내");
    const picture = reader.locator(".wiki-asset-embed img");
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => picture.evaluate((element) => element.complete && element.naturalWidth === 1)).toBe(true);
    await expect(reader.locator("body")).not.toContainText("원본은공개하지않습니다");
    expect(await ownedVaultNotesState(request, fixture.viewerAuth.uid)).toEqual(original);
    await dialog.getByRole("button", { name: "공개 중지", exact: true }).click();
    await expect(dialog.getByText(/공개를 중지했습니다/)).toBeVisible();
    await reader.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(reader.getByRole("heading", { name: "위키를 열 수 없습니다" })).toBeVisible();
    await expect(picture).toHaveCount(0);
    expect(failures).toEqual([]);
  } finally { await anonymous.close(); }
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});
