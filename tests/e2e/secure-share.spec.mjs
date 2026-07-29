/* global window */

import { expect, test } from "@playwright/test";
import {
  apiPath,
  deliveredOtp,
  exhaustEmailQuota,
  expectCleanRuntime,
  loginDirectly,
  loginRosterUser,
  mutateScenario,
  navigateWithinApp,
  observePage,
  openV2Share,
  ownerHeaders,
  resetEmulators,
  scenarioState,
  seedScenario,
  unlockV2Share
} from "./helpers.mjs";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await resetEmulators(request);
});

test.afterAll(async ({ request }) => {
  await resetEmulators(request);
});

test("legacy v1 share remains readable through Firestore Rules", async ({ page, request }) => {
  const fixture = await seedScenario(request, "legacy");
  const diagnostics = observePage(page);

  await page.goto(fixture.url);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible({
    timeout: 35_000
  });
  await expect(page.getByText(fixture.bodyText)).toBeVisible();
  await expect(
    page.locator(".public-share-body script, .public-share-body [onerror]")
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.__quickMemoE2eXss)).toBeUndefined();
  await expectCleanRuntime(diagnostics, fixture);
});

test("v2 anonymous access decrypts in-browser and view permission rejects comments", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "open");
  const diagnostics = observePage(page);

  await unlockV2Share(page, fixture);
  await expect(page.getByText(fixture.bodyText)).toBeVisible();
  await expect(
    page.locator(".secure-public-share-body script, .secure-public-share-body [onerror]")
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.__quickMemoE2eXss)).toBeUndefined();

  const commentResponse = await page.request.post(
    apiPath("comments", fixture.shareId),
    {
      data: {
        body: "view 권한 댓글 차단",
        clientRequestId: "e2e-view-comment-request-0001"
      },
      headers: {
        origin: "http://127.0.0.1:4173",
        "sec-fetch-site": "same-origin"
      }
    }
  );
  expect(commentResponse.status()).toBe(403);
  expect(await commentResponse.text()).not.toContain(fixture.contentKey);
  await expectCleanRuntime(diagnostics, fixture);
});

test("password failure is generic and the correct password opens the share", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "password");
  const diagnostics = observePage(page);

  await openV2Share(page, fixture);
  const passwordInput = page.getByLabel("공유 비밀번호");
  await passwordInput.fill("Wrong-Password!");
  await page.getByRole("button", { name: "열기", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("이 공유 링크를 사용할 수 없습니다.");
  await expect(page.getByRole("alert")).toBeFocused();

  await passwordInput.fill(fixture.password);
  await page.getByRole("button", { name: "열기", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expectCleanRuntime(diagnostics, fixture);
});

test("OTP challenge handles failure, success, and allowed-email delivery locally", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "otp");
  const diagnostics = observePage(page);

  await openV2Share(page, fixture);
  await page.getByLabel("인증 이메일").fill(fixture.allowedEmail);
  await page.getByRole("button", { name: "인증 코드 보내기" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "인증 가능한 이메일인 경우 코드를 전송했습니다."
  );
  const otp = await deliveredOtp(request, fixture.allowedEmail);
  expect(otp).toMatch(/^\d{6}$/u);
  const wrongOtp = otp === "000000" ? "111111" : "000000";

  await page.getByLabel("6자리 인증 코드").fill(wrongOtp);
  await page.getByRole("button", { name: "열기", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("이 공유 링크를 사용할 수 없습니다.");

  await page.getByLabel("6자리 인증 코드").fill(otp);
  await page.getByRole("button", { name: "열기", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expectCleanRuntime(diagnostics, fixture, [otp]);
});

test("non-allowed email receives the same browser message without local delivery", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "otp-disallowed");
  const diagnostics = observePage(page);
  const outsider = "not-allowed-e2e@example.test";

  await openV2Share(page, fixture);
  await page.getByLabel("인증 이메일").fill(outsider);
  await page.getByRole("button", { name: "인증 코드 보내기" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "인증 가능한 이메일인 경우 코드를 전송했습니다."
  );
  await expect(page.getByLabel("6자리 인증 코드")).toBeVisible();
  expect(await deliveredOtp(request, outsider)).toBeNull();
  await expectCleanRuntime(diagnostics, fixture, [outsider]);
});

test("email quota hard stop fails closed without provider delivery", async ({
  page,
  request
}) => {
  await resetEmulators(request);
  const fixture = await seedScenario(request, "otp");
  await exhaustEmailQuota(request);

  await openV2Share(page, fixture);
  await page.getByLabel("인증 이메일").fill(fixture.allowedEmail);
  await page.getByRole("button", { name: "인증 코드 보내기" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "현재 무료 이메일 발송 한도에 도달해 이메일 인증을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."
  );
  expect(await deliveredOtp(request, fixture.allowedEmail)).toBeNull();
  await resetEmulators(request);
});

test("authenticated-only share rejects anonymous access and accepts a verified emulator user", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "authenticated-verified");
  const diagnostics = observePage(page);

  await page.goto(fixture.url);
  await expect(
    page.getByText("이 공유는 로그인한 QuickMemo 사용자만 열 수 있습니다.")
  ).toBeVisible();
  const anonymousResponse = await page.request.post(
    apiPath("access", fixture.shareId),
    {
      data: {
        unlockAttemptId: "e2e-anonymous-attempt-000001"
      },
      headers: {
        origin: "http://127.0.0.1:4173",
        "sec-fetch-site": "same-origin"
      }
    }
  );
  expect(anonymousResponse.status()).toBe(401);

  await page.getByRole("button", { name: "QuickMemo 로그인" }).click();
  await loginRosterUser(page, fixture.viewerAuth, diagnostics);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expectCleanRuntime(diagnostics, fixture);
});

test("email_verified false account is rejected by an authenticated email policy", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "authenticated-unverified");
  const diagnostics = observePage(page);

  await page.goto(fixture.url);
  await page.getByRole("button", { name: "QuickMemo 로그인" }).click();
  await loginRosterUser(page, fixture.viewerAuth, diagnostics);
  await expect(page.getByRole("alert")).toHaveText("이 공유 링크를 사용할 수 없습니다.");
  expect(diagnostics.apiPayloads.some(({ status }) => status === 403)).toBe(true);
  await expectCleanRuntime(diagnostics, fixture);
});

test("global one-time share survives same-session refresh and rejects a new context", async ({
  browser,
  page,
  request
}) => {
  const fixture = await seedScenario(request, "one-time");
  const diagnostics = observePage(page);

  await openV2Share(page, fixture);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  const consumed = await scenarioState(request, fixture);
  expect(consumed.share.consumedAt).not.toBeNull();
  expect(consumed.share.successfulAccessCount).toBe(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  const secondDiagnostics = observePage(secondPage);
  await secondPage.goto(fixture.url);
  await expect(
    secondPage.getByRole("heading", { name: "이 공유 링크를 사용할 수 없습니다." })
  ).toBeVisible();
  await expectCleanRuntime(secondDiagnostics, fixture);
  await secondContext.close();
  await expectCleanRuntime(diagnostics, fixture);
});

test("download-disabled attachment hides controls, previews safely, and blocks tampering", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "view-attachment");
  const diagnostics = observePage(page);

  await unlockV2Share(page, fixture);
  await expect(page.getByRole("button", { name: "본문 빠른 복사" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다운로드" })).toHaveCount(0);
  await expect(page.getByText(/직접 다운로드 요청은 제한됩니다/u)).toBeVisible();

  const downloadResponse = await page.request.get(
    apiPath("attachment-download", fixture.shareId, {
      attachmentId: fixture.attachmentId
    })
  );
  expect(downloadResponse.status()).toBe(403);
  expect(await downloadResponse.text()).not.toMatch(
    /(?:blobPath|blobUrl|blob\.vercel-storage\.com)/iu
  );

  const previewButton = page.getByRole("button", { name: "미리보기" });
  await previewButton.click();
  const dialog = page.getByRole("dialog", { name: "e2e-attachment.txt" });
  await expect(dialog).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "파일 미리보기 닫기" });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(previewButton).toBeFocused();

  const tamperedResponse = await page.request.get(
    apiPath("attachment-preview", fixture.shareId, {
      attachmentId: `${fixture.attachmentId}_tampered`
    })
  );
  expect(tamperedResponse.status()).toBe(404);
  await expectCleanRuntime(diagnostics, fixture);
});

test("comment permission keeps XSS text out and supports author deletion", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "comment");
  const diagnostics = observePage(page);

  await unlockV2Share(page, fixture);
  await expect(page.getByText("내 댓글 이름")).toBeVisible();
  await expect(page.getByText("guest1, 네트워크 대역 203.226")).toBeVisible();
  await expect(
    page.getByText("전체 IP 주소가 아닌 일부 네트워크 대역만 표시됩니다.")
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("203.226.244.27");

  await page.getByRole("button", { name: "이름 변경" }).click();
  const displayNameInput = page.getByLabel("표시 이름");
  await displayNameInput.fill("인기테스터");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("status")).toContainText(
    "댓글 표시 이름을 변경했습니다."
  );
  await expect(page.getByText("인기테스터, 네트워크 대역 203.226")).toBeVisible();

  const commentInput = page.getByLabel("새 댓글");
  await commentInput.fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "댓글 작성" }).click();
  await expect(page.getByText("댓글에는 HTML 태그를 입력할 수 없습니다.")).toBeVisible();

  const commentText = "alert(1)은 실행되지 않는 평문 댓글";
  await commentInput.fill(commentText);
  await page.getByRole("button", { name: "댓글 작성" }).click();
  await expect(page.getByText(commentText)).toBeVisible();
  await expect(page.locator(".secure-public-share-comment-list script")).toHaveCount(0);
  await page.getByRole("button", { name: /인기테스터 댓글 삭제/u }).click();
  await expect(page.getByText(commentText)).toHaveCount(0);
  await expectCleanRuntime(diagnostics, fixture);
});

test("independent browsers receive per-share identities and keep renamed authors", async ({
  browser,
  page,
  request
}) => {
  const fixture = await seedScenario(request, "comment");
  const firstDiagnostics = observePage(page);
  const secondContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul"
  });
  const secondPage = await secondContext.newPage();
  const secondDiagnostics = observePage(secondPage);

  try {
    await unlockV2Share(page, fixture);
    await expect(page.getByText("guest1, 네트워크 대역 203.226")).toBeVisible();
    const firstComment = "첫 번째 브라우저의 기존 댓글";
    await page.getByLabel("새 댓글").fill(firstComment);
    await page.getByRole("button", { name: "댓글 작성" }).click();
    await expect(page.getByText(firstComment)).toBeVisible();
    await page.getByRole("button", { name: "이름 변경" }).click();
    await page.getByLabel("표시 이름").fill("테스터A");
    await page.getByRole("button", { name: "저장" }).click();
    await expect(page.getByText("테스터A, 네트워크 대역 203.226")).toHaveCount(2);

    await unlockV2Share(secondPage, fixture);
    await expect(secondPage.getByText("guest2, 네트워크 대역 203.226")).toBeVisible();
    await secondPage.getByRole("button", { name: "이름 변경" }).click();
    await secondPage.getByLabel("표시 이름").fill("테스터A");
    const duplicateAttemptConsoleOffset = secondDiagnostics.consoleErrors.length;
    await secondPage.getByRole("button", { name: "저장" }).click();
    await expect(
      secondPage.getByText("이미 사용 중인 이름입니다. 다른 이름을 입력해주세요.")
    ).toBeVisible();
    const duplicateNameConflict = secondDiagnostics.consoleErrors
      .slice(duplicateAttemptConsoleOffset)
      .find(({ location, text }) => (
        location.includes("/api/public-shares-v2?action=participant-me")
        && /status of 409 \(Conflict\)$/u.test(text)
      ));
    expect(duplicateNameConflict, "duplicate-name conflict must be the observed 409").toBeDefined();
    secondDiagnostics.expectedConsoleErrors.add(duplicateNameConflict);
    await secondPage.getByLabel("표시 이름").fill("테스터B");
    await secondPage.getByRole("button", { name: "저장" }).click();
    await expect(secondPage.getByText("테스터B, 네트워크 대역 203.226")).toBeVisible();
    const secondComment = "두 번째 브라우저의 댓글";
    await secondPage.getByLabel("새 댓글").fill(secondComment);
    await secondPage.getByRole("button", { name: "댓글 작성" }).click();
    await expect(secondPage.getByText(secondComment)).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
    await expect(
      page
        .locator(".secure-public-share-comment-list article")
        .filter({ hasText: firstComment })
        .getByText("테스터A, 네트워크 대역 203.226")
    ).toBeVisible();
    await expect(page.getByText(firstComment)).toBeVisible();
    await expect(page.getByText(secondComment)).toBeVisible();

    await Promise.all([
      expectCleanRuntime(firstDiagnostics, fixture),
      expectCleanRuntime(secondDiagnostics, fixture)
    ]);
    const observedPayloads = JSON.stringify([
      ...firstDiagnostics.apiPayloads,
      ...secondDiagnostics.apiPayloads
    ]);
    expect(observedPayloads).not.toContain("203.226.244.27");
    expect(observedPayloads).not.toMatch(
      /"(?:carrier|isp|asn|country|city|location)"\s*:/iu
    );
  } finally {
    await secondContext.close();
  }
});

test("owner preview can delete a guest comment without consuming a one-time share", async ({
  browser,
  page,
  request
}) => {
  const fixture = await seedScenario(request, "owner-preview");
  const guestDiagnostics = observePage(page);

  await openV2Share(page, fixture);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  const guestComment = "소유자가 삭제할 E2E 게스트 댓글";
  await page.getByLabel("새 댓글").fill(guestComment);
  await page.getByRole("button", { name: "댓글 작성" }).click();
  await expect(page.getByText(guestComment)).toBeVisible();
  const beforeOwnerPreview = await scenarioState(request, fixture);
  expect(beforeOwnerPreview.share.consumedAt).not.toBeNull();
  expect(beforeOwnerPreview.share.successfulAccessCount).toBe(1);
  await expectCleanRuntime(guestDiagnostics, fixture);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await loginDirectly(ownerPage, fixture.ownerAuth);
  await navigateWithinApp(ownerPage, fixture.url);
  const ownerDiagnostics = observePage(ownerPage);
  await expect(ownerPage.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expect(
    ownerPage.getByText("소유자/관리자 미리보기", { exact: true })
  ).toBeVisible();
  await expect(
    ownerPage.getByRole("button", { name: "미리보기 열기", exact: true })
  ).toHaveCount(0);
  await expect(ownerPage.getByText(guestComment)).toBeVisible();
  await ownerPage.getByRole("button", { name: /guest1 댓글 삭제/iu }).click();
  await expect(ownerPage.getByText(guestComment)).toHaveCount(0);
  const afterOwnerPreview = await scenarioState(request, fixture);
  expect(afterOwnerPreview.share.consumedAt).toBe(beforeOwnerPreview.share.consumedAt);
  expect(afterOwnerPreview.share.successfulAccessCount).toBe(1);
  await expectCleanRuntime(ownerDiagnostics, fixture);
  await ownerContext.close();
});

test("save-copy permission creates an independent active note after emulator login", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "save-copy");
  const diagnostics = observePage(page);

  await unlockV2Share(page, fixture);
  await page.getByRole("button", { name: "QuickMemo에 복사본 저장" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await loginRosterUser(page, fixture.viewerAuth, diagnostics);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await page.getByRole("button", { name: "QuickMemo에 복사본 저장" }).click();
  await expect(
    page.getByText("보안 공유의 독립 복사본을 QuickMemo에 저장했습니다.")
  ).toBeVisible({ timeout: 30_000 });

  const state = await scenarioState(request, fixture, fixture.viewerAuth.uid);
  expect(state.copiedNotes).toHaveLength(1);
  expect(state.copiedNotes[0]).toMatchObject({
    attachmentCount: 0,
    state: "active"
  });
  await expectCleanRuntime(diagnostics, fixture);
});

test("save-copy decrypts, re-encrypts, and activates an attachment with the local Blob adapter", async ({
  page,
  request
}) => {
  const fixture = await seedScenario(request, "save-copy-attachment");
  const diagnostics = observePage(page);

  expect(fixture.sourceAttachmentCipherDigest).toMatch(/^[a-f0-9]{64}$/u);
  await unlockV2Share(page, fixture);
  await page.getByRole("button", { name: "QuickMemo에 복사본 저장" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await loginRosterUser(page, fixture.viewerAuth, diagnostics);
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await page.getByRole("button", { name: "QuickMemo에 복사본 저장" }).click();
  await expect(
    page.getByText("보안 공유의 독립 복사본을 QuickMemo에 저장했습니다.")
  ).toBeVisible({ timeout: 30_000 });

  const state = await scenarioState(request, fixture, fixture.viewerAuth.uid);
  expect(state.copiedNotes).toHaveLength(1);
  expect(state.copiedNotes[0]).toMatchObject({
    attachmentCount: 1,
    attachmentRevision: 1,
    expectedCount: 1,
    readyCount: 1,
    reservedCount: 1,
    state: "active"
  });
  expect(state.copiedNotes[0].attachments).toHaveLength(1);
  expect(state.copiedNotes[0].attachments[0]).toMatchObject({
    isReady: true,
    storageProvider: "vercel-blob"
  });
  expect(state.copiedNotes[0].attachments[0].memoryBlobSize).toBe(
    state.copiedNotes[0].attachments[0].encryptedSize
  );
  expect(state.copiedNotes[0].attachments[0].memoryBlobDigest).toMatch(
    /^[a-f0-9]{64}$/u
  );
  expect(state.copiedNotes[0].attachments[0].memoryBlobDigest).not.toBe(
    fixture.sourceAttachmentCipherDigest
  );
  await expectCleanRuntime(diagnostics, fixture);
});

test("revoke, policy change, and server expiry invalidate existing sessions", async ({
  page,
  request
}) => {
  const revokedFixture = await seedScenario(request, "lifecycle");
  await unlockV2Share(page, revokedFixture);
  const revokeResponse = await page.request.post(
    apiPath("owner-revoke", revokedFixture.shareId),
    {
      data: { idempotencyKey: "e2e-revoke-owner-000001" },
      headers: ownerHeaders(revokedFixture.ownerAuth.idToken)
    }
  );
  expect(revokeResponse.status()).toBe(200);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "이 공유 링크를 사용할 수 없습니다." })
  ).toBeVisible();

  const policyFixture = await seedScenario(request, "lifecycle");
  await unlockV2Share(page, policyFixture);
  const policyResponse = await page.request.patch(
    apiPath("owner-update", policyFixture.shareId),
    {
      data: {
        idempotencyKey: "e2e-policy-owner-000001",
        policy: { quickCopyButtonVisible: false }
      },
      headers: ownerHeaders(policyFixture.ownerAuth.idToken)
    }
  );
  expect(policyResponse.status()).toBe(200);
  const staleSession = await page.request.get(apiPath("session", policyFixture.shareId));
  expect(staleSession.status()).toBe(401);

  const expiredFixture = await seedScenario(request, "open");
  await unlockV2Share(page, expiredFixture);
  await mutateScenario(request, expiredFixture.shareId, "expire");
  const expiredSession = await page.request.get(apiPath("session", expiredFixture.shareId));
  expect(expiredSession.status()).toBe(401);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "이 공유 링크를 사용할 수 없습니다." })
  ).toBeVisible();

  const initiallyExpired = await seedScenario(request, "expired");
  await page.goto(initiallyExpired.url);
  await expect(
    page.getByRole("heading", { name: "이 공유 링크를 사용할 수 없습니다." })
  ).toBeVisible();
});
