/* global HTMLButtonElement, URL, URLSearchParams, document, window */

import { expect } from "@playwright/test";

export async function resetEmulators(request) {
  const response = await request.delete("/__e2e__/reset");
  expect(response.ok()).toBeTruthy();
}

export async function seedScenario(request, scenario) {
  const response = await request.post("/__e2e__/seed", {
    data: { scenario }
  });
  expect(response.status()).toBe(201);
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  return payload.fixture;
}

export async function markOnlyOwnedVaultNoteAsLegacy(request, uid) {
  const response = await request.post("/__e2e__/vault-note-legacy", {
    data: { uid }
  });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  return payload.note;
}

export async function ownedVaultNotesState(request, uid) {
  const query = new URLSearchParams({ uid });
  const response = await request.get(`/__e2e__/vault-notes-state?${query.toString()}`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  return payload.notes;
}

export async function vaultPathRewriteState(request, uid) {
  const query = new URLSearchParams({ uid });
  const response = await request.get(`/__e2e__/vault-path-rewrite-state?${query.toString()}`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  return payload.state;
}

export async function mutateScenario(request, shareId, action) {
  const response = await request.post("/__e2e__/mutate", {
    data: { action, shareId }
  });
  expect(response.ok()).toBeTruthy();
}

export async function scenarioState(request, fixture, uid = "") {
  const query = new URLSearchParams({
    shareId: fixture.shareId,
    ...(uid ? { uid } : {})
  });
  const response = await request.get(`/__e2e__/state?${query.toString()}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).state;
}

export async function deliveredOtp(request, email) {
  const response = await request.get(
    `/__e2e__/mail?email=${encodeURIComponent(email)}`
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()).delivery?.code ?? null;
}

export async function exhaustEmailQuota(request) {
  const response = await request.post("/__e2e__/quota-hard");
  expect(response.ok()).toBeTruthy();
}

export function apiPath(action, shareId, query = {}) {
  const parameters = new URLSearchParams({ action, shareId, ...query });
  return `/api/public-shares-v2?${parameters.toString()}`;
}

export async function openV2Share(page, fixture) {
  await page.goto(fixture.url);
  await expect(page).toHaveURL((url) =>
    url.pathname === `/s/${fixture.shareId.slice(4)}`
    && url.search === ""
    && url.hash === `#${fixture.contentKey}`
  );
  await expect(
    page.locator(
      ".secure-public-share-access, .secure-public-share-viewer, .secure-public-share-state.error"
    )
  ).toBeVisible({ timeout: 35_000 });
}

export async function unlockV2Share(page, fixture) {
  await openV2Share(page, fixture);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "열기", exact: true })).toHaveCount(0);
}

export async function unlockEncryptedVault(page, password) {
  const passwordInput = page.locator('input[type="password"][aria-label="비밀번호"]');
  const formError = page.locator(".unlock-panel .form-error");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(passwordInput).toBeVisible();
    await passwordInput.fill(password);
    await page.getByRole("button", { name: "열기", exact: true }).click();

    const outcome = await Promise.any([
      passwordInput.waitFor({ state: "hidden", timeout: 25_000 }).then(() => "unlocked"),
      formError.waitFor({ state: "visible", timeout: 25_000 }).then(() => "error")
    ]);
    if (outcome === "unlocked") return;

    const message = (await formError.textContent())?.trim() ?? "";
    if (attempt === 0 && /네트워크 연결이 불안정/u.test(message)) {
      await page.waitForTimeout(300);
      continue;
    }
    throw new Error(`encrypted Vault unlock failed: ${message || "unknown error"}`);
  }
}

export async function loginRosterUser(page, user, diagnostics) {
  await expect(
    page.getByRole("button", { name: `${user.displayName} 사용자 선택` })
  ).toBeVisible();
  await page.getByRole("button", { name: `${user.displayName} 사용자 선택` }).click();
  const dialog = page.getByRole("dialog", { name: user.displayName });
  const passwordInput = dialog.getByLabel("비밀번호");
  const formError = dialog.locator(".form-error");
  const loginButton = dialog.getByRole("button", { name: "로그인", exact: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await passwordInput.fill("");
    await passwordInput.fill(user.password);
    await expect(passwordInput).toHaveValue(user.password);
    await expect(formError).toBeHidden();
    const consoleStartIndex = diagnostics?.consoleErrors.length ?? 0;
    await loginButton.click();

    const outcome = await Promise.any([
      page.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 })
        .then(() => "navigated"),
      formError.waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "error")
    ]);

    if (outcome === "navigated") {
      return;
    }

    const message = (await formError.textContent()) ?? "";
    const transientEmulatorTransportError =
      /client is offline|network connection was lost|firestore\/unavailable|네트워크 연결이 불안정/iu.test(message);
    // A credential rejection is authoritative. In particular, Auth Emulator
    // returns the same localized UI message for EMAIL_NOT_FOUND after an
    // external reset, so retrying it would hide a real missing/wrong account.
    if (!transientEmulatorTransportError || attempt === 2) {
      throw new Error(`E2E roster login failed: ${message || "unknown error"}`);
    }

    if (diagnostics) {
      for (const consoleError of diagnostics.consoleErrors.slice(consoleStartIndex)) {
        if (isExpectedFirestoreEmulatorTransportConsoleError(consoleError)) {
          diagnostics.expectedTransientFirestoreTransportErrors.add(consoleError);
        }
      }
    }
    await expect(loginButton).toBeEnabled();
  }
}

export async function loginDirectly(page, user, diagnostics) {
  await page.goto("/login");
  await loginRosterUser(page, user, diagnostics);
  await expect(page).toHaveURL((url) => url.pathname !== "/login" && url.pathname !== "/home");
  await expect(page.locator(".app-frame")).toBeVisible();
}

export async function navigateWithinApp(page, rawUrl) {
  const target = await page.evaluate((url) => {
    const target = new URL(url, window.location.origin);

    if (target.origin !== window.location.origin) {
      throw new Error("E2E navigation target must be same-origin");
    }

    return `${target.pathname}${target.search}${target.hash}`;
  }, rawUrl);

  const bridge = page.locator("[data-quickmemo-e2e-navigation]");
  await expect(bridge).toHaveCount(1);
  await bridge.evaluate((element, targetPath) => {
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error("E2E navigation bridge is unavailable");
    }

    element.dataset.target = targetPath;
    element.click();
  }, target);
  await expect(page).toHaveURL((url) =>
    `${url.pathname}${url.search}${url.hash}` === target
  );
}

export function observePage(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const apiPayloads = [];
  const pendingResponses = [];
  const expectedConsoleErrors = new Set();
  const expectedPageErrors = new Set();
  const expectedTransientFirestoreTransportErrors = new Set();

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({
        location: message.location().url,
        text: message.text()
      });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("response", (response) => {
    if (!response.url().includes("/api/public-shares-v2")) {
      return;
    }
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      return;
    }
    const pending = response.text()
      .then((text) => {
        apiPayloads.push({ status: response.status(), text, url: response.url() });
      })
      .catch(() => undefined);
    pendingResponses.push(pending);
  });

  return {
    apiPayloads,
    consoleErrors,
    expectedConsoleErrors,
    expectedPageErrors,
    expectedTransientFirestoreTransportErrors,
    pageErrors,
    pendingResponses
  };
}

/**
 * WebKit reports aborted Firestore emulator WebChannel requests as page errors
 * when a test deliberately reloads or tears down the page. Keep this opt-in
 * and emulator-only: product assertions still have to prove every read/write
 * before callers classify the exact localhost transport message as expected.
 */
export function allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics) {
  let hasExpectedRestAbort = false;
  for (const consoleError of diagnostics.consoleErrors) {
    if (isExpectedFirestoreEmulatorTransportConsoleError(consoleError)) {
      diagnostics.expectedTransientFirestoreTransportErrors.add(consoleError);
      if (isExpectedFirestoreEmulatorRestAbort(consoleError)) {
        hasExpectedRestAbort = true;
      }
    }
  }
  // WebKit can emit a second, location-less console line for the same aborted
  // REST request. Never accept that generic line on its own: it is expected only
  // when an exact allowlisted localhost emulator failure is present in this opt-in
  // unload window.
  if (hasExpectedRestAbort) {
    for (const consoleError of diagnostics.consoleErrors) {
      if (
        consoleError.location === ""
        && consoleError.text === "The network connection was lost."
      ) {
        diagnostics.expectedTransientFirestoreTransportErrors.add(consoleError);
      }
    }
  }
  for (const pageError of diagnostics.pageErrors) {
    if (isExpectedWebKitFirestoreEmulatorUnloadPageError(pageError)) {
      diagnostics.expectedPageErrors.add(pageError);
    }
  }
}

export function isExpectedFirestoreEmulatorTransportConsoleError({ location, text }) {
  return (
    (
      /^http:\/\/127\.0\.0\.1:8080\/google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel(?:\?|$)/u.test(location)
      || isExpectedFirestoreEmulatorRestAbort({ location, text })
    )
    && text === "Failed to load resource: The network connection was lost."
  );
}

function isExpectedFirestoreEmulatorRestAbort({ location, text }) {
  return (
    /^http:\/\/127\.0\.0\.1:8080\/v1\/projects\/[A-Za-z0-9._-]+\/databases\/\(default\)\/documents:(?:batchGet|commit)\?key=fake-emulator-api-key$/u.test(location)
    && text === "Failed to load resource: The network connection was lost."
  );
}

export function isExpectedWebKitFirestoreEmulatorUnloadPageError(message) {
  return (
    /^\/127\.0\.0\.1:8080\/google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel\?.+ due to access control checks\.$/u
      .test(message)
    || /^\/127\.0\.0\.1:8080\/v1\/projects\/[A-Za-z0-9._-]+\/databases\/\(default\)\/documents:(?:batchGet|commit)\?key=fake-emulator-api-key due to access control checks\.$/u
      .test(message)
  );
}

export async function expectCleanRuntime(diagnostics, fixture, extraSecrets = []) {
  await Promise.all(diagnostics.pendingResponses);
  const expectedAuthorizationProbes = diagnostics.consoleErrors.filter(({ location, text }) => (
    location.includes("/api/public-shares-v2")
    && /^Failed to load resource: the server responded with a status of (?:401|403|404)/u.test(text)
  ));
  const unexpectedConsoleErrors = diagnostics.consoleErrors.filter(
    (message) =>
      !expectedAuthorizationProbes.includes(message)
      && !diagnostics.expectedConsoleErrors.has(message)
      && !diagnostics.expectedTransientFirestoreTransportErrors.has(message)
  );
  expect(unexpectedConsoleErrors, "unexpected browser console errors").toEqual([]);
  const unexpectedPageErrors = diagnostics.pageErrors.filter(
    (message) => !diagnostics.expectedPageErrors.has(message)
  );
  expect(unexpectedPageErrors, "unhandled browser errors").toEqual([]);

  const forbiddenValues = [
    fixture.contentKey,
    fixture.password,
    fixture.allowedEmail,
    ...extraSecrets
  ].filter((value) => typeof value === "string" && value.length >= 6);

  for (const payload of diagnostics.apiPayloads) {
    expect(payload.text, `${payload.url} must not expose Blob internals`)
      .not.toMatch(/(?:blobPath|blobUrl|blobDownloadUrl|blob\.vercel-storage\.com)/iu);
    expect(payload.text, `${payload.url} must not expose a session token field`)
      .not.toMatch(/"sessionToken"\s*:/iu);
    for (const secret of forbiddenValues) {
      expect(payload.text, `${payload.url} leaked a fixture secret`).not.toContain(secret);
    }
  }
}

export async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const overflowingElement = Array.from(document.querySelectorAll("*")).find((element) => {
      const rectangle = element.getBoundingClientRect();
      return rectangle.right > root.clientWidth + 1 || rectangle.left < -1;
    });
    return {
      body: Math.max(0, body.scrollWidth - body.clientWidth),
      element: overflowingElement
        ? {
            ariaLabel: overflowingElement.getAttribute("aria-label"),
            className: overflowingElement.className,
            left: Math.round(overflowingElement.getBoundingClientRect().left * 100) / 100,
            right: Math.round(overflowingElement.getBoundingClientRect().right * 100) / 100,
            tagName: overflowingElement.tagName,
            text: overflowingElement.textContent?.trim().slice(0, 80) ?? ""
          }
        : null,
      root: Math.max(0, root.scrollWidth - root.clientWidth)
    };
  });

  expect(overflow, "page must not overflow horizontally").toEqual({
    body: 0,
    element: null,
    root: 0
  });
}

export function ownerHeaders(idToken) {
  return {
    authorization: `Bearer ${idToken}`,
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
    "sec-fetch-site": "same-origin"
  };
}

// Advanced memo tools remain reachable without occupying the primary ribbon.
export async function openVaultMoreTool(page, name) {
  const panel = page.locator('.vault-left-panel[aria-label="Vault 탐색기"]');
  await expect.poll(async () => {
    if (await panel.isVisible()) return true;
    const rightDrawer = page.getByRole("dialog", { name: "연결 정보", exact: true });
    if (await rightDrawer.isVisible()) {
      await rightDrawer.getByRole("button", { name: "오른쪽 패널 닫기" }).click();
    }
    const files = page.getByRole("button", { name: "파일", exact: true });
    if (await files.isVisible()) await files.click({ timeout: 500 }).catch(() => undefined);
    return panel.isVisible();
  }, { message: "Memo explorer must settle open after encrypted workspace restoration" }).toBe(true);
  await expect(panel).toBeVisible();
  const tools = panel.locator("details.vault-more-tools");
  if (!(await tools.evaluate((element) => element.open))) await tools.locator("summary").click();
  await tools.getByRole("button", { name, exact: true }).click();
}
