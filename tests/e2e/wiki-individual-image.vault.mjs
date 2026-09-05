/* global URL */
import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { allowExpectedWebKitFirestoreEmulatorUnloadErrors, expectCleanRuntime, loginDirectly, navigateWithinApp, observePage, openVaultMoreTool, ownedVaultNotesState, seedScenario } from "./helpers.mjs";
import { readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";

const projects = new Set(["vault-chromium-desktop-1440", "vault-webkit-desktop-1280"]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

for (const folder of [null, "Nested image notes"]) {
test(`explicitly publishes one image from ${folder ? "a nested note" : "an individual root note"} without granting its source folder or sibling image`, async ({ page, request, browser }, testInfo) => {
  test.skip(!projects.has(testInfo.project.name), "Focused encrypted image publication acceptance uses desktop Chromium and WebKit.");
  test.setTimeout(150_000);
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  await loginDirectly(page, fixture.viewerAuth, diagnostics); await navigateWithinApp(page, "/app");
  const create = page.locator('.vault-panel-toolbar button[aria-label="새 노트"]');
  await expect(create).toBeEnabled({ timeout: 40_000 });
  if (folder) {
    page.once("dialog", (prompt) => prompt.accept(folder));
    await page.locator('.vault-panel-toolbar button[aria-label="새 폴더"]').click();
    await page.getByRole("treeitem", { name: folder, exact: true }).click();
  }
  await create.click();
  const title = "Individual image document";
  const imageTitle = `${title} -1.png`, siblingTitle = `${title} -2.png`;
  await page.getByRole("textbox", { name: "노트 이름", exact: true }).fill(title);
  const editor = page.getByRole("textbox", { name: "Markdown 편집기", exact: true });
  await editor.fill(`# ${title}\n\nOnly the chosen image is public.`);
  await saveVaultDocument(page, { allowClean: true });
  await editor.press("ControlOrMeta+Home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "이미지 파일 추가", exact: true }).click();
  await (await chooser).setFiles([
    { name: "selected.png", mimeType: "image/png", buffer: png },
    { name: "private-sibling.png", mimeType: "image/png", buffer: png }
  ]);
  await expect.poll(async () => (await readVaultEditorSource(editor)).match(/!\[\[[^\]]+\.png\]\]/gu)?.length ?? 0, { timeout: 40_000 }).toBe(2);
  await saveVaultDocument(page, { allowClean: true });
  await expect(page.locator(".vault-save-state")).toHaveText("저장됨");
  await expect.poll(async () => (await ownedVaultNotesState(request, fixture.viewerAuth.uid)).length).toBe(3);
  const original = await ownedVaultNotesState(request, fixture.viewerAuth.uid);
  expect(original.filter((note) => note.entryKind === "asset")).toHaveLength(2);
  const imageFolderIds = new Set(original.filter((note) => note.entryKind === "asset").map((note) => note.folderId));
  expect(imageFolderIds.size).toBe(1); expect([...imageFolderIds][0]).toBeTruthy();

  const publicationWrites = [];
  page.on("request", (event) => {
    if (new URL(event.url()).pathname !== "/api/published-wikis" || event.method() !== "POST") return;
    const action = event.postDataJSON()?.action;
    if (["begin", "upload", "activate"].includes(action)) publicationWrites.push(action);
  });
  await openVaultMoreTool(page, "위키 공개 설정");
  const dialog = page.getByRole("dialog", { name: "위키 공개 설정", exact: true });
  await expect(dialog.getByRole("textbox", { name: "위키 주소", exact: true })).toBeEnabled();
  const slug = `image-${Date.now().toString(36)}`;
  await dialog.getByRole("textbox", { name: "위키 주소", exact: true }).fill(slug);
  await expect(dialog.getByText("사용할 수 있는 주소입니다.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "주소 저장", exact: true }).click();
  await expect(dialog.getByText("주소 등록됨 · 비공개", { exact: true })).toBeVisible();
  if (folder) await dialog.getByRole("checkbox", { name: folder, exact: true }).check();
  await dialog.locator("summary").filter({ hasText: /^개별 메모·이미지$/u }).click();
  if (!folder) await dialog.getByRole("checkbox", { name: `${title}.md`, exact: true }).check();
  const search = dialog.getByRole("searchbox", { name: "공개 범위 검색", exact: true });
  await search.fill(imageTitle);
  const selected = dialog.getByRole("checkbox", { name: `붙여넣은 이미지/${imageTitle}`, exact: true });
  await expect(selected).not.toBeChecked(); await selected.check();
  const preview = dialog.getByRole("region", { name: "공개할 내용", exact: true });
  await expect(preview.getByText(`메모 1개 · 이미지 1개 · 폴더 ${folder ? 1 : 0}개`, { exact: true })).toBeVisible();
  await expect(preview.getByRole("list")).toContainText(`이미지 · ${imageTitle}`);
  await expect(preview.getByRole("list")).not.toContainText(siblingTitle);
  const consent = dialog.getByRole("checkbox", { name: "선택한 범위와 이후 저장되는 변경 사항을 누구나 볼 수 있도록 공개합니다.", exact: true });
  await expect(consent).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "위키 게시", exact: true })).toBeDisabled();
  expect(publicationWrites).toEqual([]);
  await consent.check(); await dialog.getByRole("button", { name: "위키 게시", exact: true }).click();
  await expect(dialog.getByText("공개했습니다. 선택한 범위의 변경 사항은 저장 후 자동 반영됩니다.", { exact: true })).toBeVisible({ timeout: 40_000 });
  expect(publicationWrites).toContain("activate");
  const publicUrl = await dialog.getByRole("region", { name: "공개 링크", exact: true }).getByRole("link").getAttribute("href");
  const anonymous = await browser.newContext({ baseURL: "http://127.0.0.1:4174", viewport: testInfo.project.use.viewport, locale: "ko-KR" });
  try {
    const reader = await anonymous.newPage();
    const manifestResponse = reader.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/published-wikis" && url.searchParams.get("action") === "manifest" && response.status() === 200;
    });
    await reader.goto(publicUrl);
    const manifest = await (await manifestResponse).json();
    expect(manifest.folders).toHaveLength(folder ? 1 : 0);
    if (folder) expect(manifest.folders[0]).toMatchObject({ name: folder, path: folder, parentId: null });
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries.map((entry) => entry.title).sort()).toEqual([title, imageTitle].sort());
    const asset = manifest.entries.find((entry) => entry.kind === "asset");
    const note = manifest.entries.find((entry) => entry.kind === "markdown");
    expect(asset).toMatchObject({ folderId: null, path: imageTitle });
    expect(note).toMatchObject({ folderId: folder ? manifest.folders[0].id : null, path: folder ? `${folder}/${title}.md` : `${title}.md` });
    expect(manifest.entries.every((entry) => !entry.path.includes("붙여넣은 이미지/"))).toBe(true);
    const image = reader.locator(".wiki-body").getByRole("img", { name: imageTitle, exact: true });
    await expect(image).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1);
    await expect(reader.locator("body")).not.toContainText(siblingTitle);
    await expect(reader.locator("body")).not.toContainText("붙여넣은 이미지");
    await expect(reader.locator('.wiki-body')).toContainText("Only the chosen image is public.");
    await expect(reader.locator('[contenteditable="true"], .wiki-home-link')).toHaveCount(0);
    await reader.reload();
    await expect(image).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1);
    expect(await ownedVaultNotesState(request, fixture.viewerAuth.uid)).toEqual(original);
    await reader.screenshot({ path: testInfo.outputPath("individual-image-public.png"), fullPage: true });
  } finally { await anonymous.close(); }
  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics); await expectCleanRuntime(diagnostics, fixture);
});
}
