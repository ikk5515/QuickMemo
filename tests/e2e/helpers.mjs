/* global URLSearchParams, document */

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

export function apiPath(action, shareId, query = {}) {
  const parameters = new URLSearchParams({ action, shareId, ...query });
  return `/api/public-shares-v2?${parameters.toString()}`;
}

export async function openV2Share(page, fixture) {
  await page.goto(fixture.url);
  await expect(page.getByRole("heading", { name: "보안 공유 열기" })).toBeVisible();
}

export async function unlockV2Share(page, fixture) {
  await openV2Share(page, fixture);
  await page.getByRole("button", { name: "보안 공유 열기" }).click();
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
}

export async function loginRosterUser(page, user) {
  await expect(
    page.getByRole("button", { name: `${user.displayName} 사용자 선택` })
  ).toBeVisible();
  await page.getByRole("button", { name: `${user.displayName} 사용자 선택` }).click();
  const dialog = page.getByRole("dialog", { name: user.displayName });
  await dialog.getByLabel("비밀번호").fill(user.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login"),
    dialog.getByRole("button", { name: "로그인", exact: true }).click()
  ]);
}

export async function loginDirectly(page, user) {
  await page.goto("/login");
  await loginRosterUser(page, user);
}

export function observePage(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const apiPayloads = [];
  const pendingResponses = [];

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
    pageErrors,
    pendingResponses
  };
}

export async function expectCleanRuntime(diagnostics, fixture, extraSecrets = []) {
  await Promise.all(diagnostics.pendingResponses);
  const expectedAuthorizationProbes = diagnostics.consoleErrors.filter(({ location, text }) => (
    location.includes("/api/public-shares-v2")
    && /^Failed to load resource: the server responded with a status of (?:401|403|404)/u.test(text)
  ));
  const unexpectedConsoleErrors = diagnostics.consoleErrors.filter(
    (message) => !expectedAuthorizationProbes.includes(message)
  );
  expect(unexpectedConsoleErrors, "unexpected browser console errors").toEqual([]);
  expect(diagnostics.pageErrors, "unhandled browser errors").toEqual([]);

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
      body: body.scrollWidth - body.clientWidth,
      element: overflowingElement
        ? `${overflowingElement.tagName}.${overflowingElement.className}`
        : null,
      root: root.scrollWidth - root.clientWidth
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
