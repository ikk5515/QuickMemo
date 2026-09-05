/* global URL */

import { expect, test } from "@playwright/test";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  expectCleanRuntime,
  loginDirectly,
  navigateWithinApp,
  observePage,
  seedScenario,
  unlockEncryptedVault
} from "./helpers.mjs";

async function expectVaultWritesReady(page) {
  const createNote = page.getByRole("button", { name: "새 노트", exact: true }).first();
  await expect(createNote).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "Vault 이름 무결성 준비" })).toHaveCount(0);
}

test("a sealed Vault reconnect reads the ready marker without repeating the inventory seal", async ({
  page,
  request
}) => {
  test.setTimeout(120_000);
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);
  let integritySealRequests = 0;

  page.on("request", (networkRequest) => {
    const url = new URL(networkRequest.url());
    // UI metadata shares the Hobby function, but never performs inventory work.
    if (url.pathname === "/api/vault-integrity" && !url.searchParams.has("resource") && networkRequest.method() === "POST") {
      integritySealRequests += 1;
    }
  });

  await loginDirectly(page, fixture.viewerAuth, diagnostics);
  await navigateWithinApp(page, "/app");
  await expectVaultWritesReady(page);
  expect(integritySealRequests, "the initial pending Vault must be sealed once").toBeGreaterThanOrEqual(1);
  const initialSealRequests = integritySealRequests;

  await page.reload();
  await unlockEncryptedVault(page, fixture.viewerAuth.password);
  await expectVaultWritesReady(page);
  await expect.poll(
    () => integritySealRequests,
    { message: "a ready reconnect must not repeat the full inventory seal" }
  ).toBe(initialSealRequests);

  allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
  await expectCleanRuntime(diagnostics, fixture);
});
