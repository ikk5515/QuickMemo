/* global window, document, performance, requestAnimationFrame, getComputedStyle */
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectCleanRuntime, loginDirectly, navigateWithinApp, observePage, seedScenario } from "./helpers.mjs";
import { pressVaultEditorModKey, readVaultEditorSource, saveVaultDocument } from "./vault-editor-helpers.mjs";

const sourceFor = (title) => `# ${title}\n\nMotion 검증 본문${title === "Motion A" ? "\n\n긴 문서의 독립적인 스크롤 위치를 보존합니다.".repeat(50) : ""}`;

async function createNote(page, title) {
  await page.locator('.vault-panel-toolbar button[aria-label="새 노트"]').click();
  await page.getByLabel("노트 이름").fill(title);
  await page.getByRole("textbox", { name: "Markdown 편집기" }).fill(sourceFor(title));
  await saveVaultDocument(page);
  await expect(page.locator(".vault-workspace")).toHaveAttribute("data-workspace-sync", "saved");
}

async function measureClick(page, action) {
  await page.evaluate(() => {
    const known = new Map([...document.querySelectorAll('.vault-tab-strip [role="tab"]')].map((tab) => [tab.textContent, tab.parentElement]));
    window.memoMotionSamples = new Promise((resolve) => document.addEventListener("click", () => {
      const started = performance.now();
      const frames = [];
      const sample = () => {
        const strip = document.querySelector(".vault-tab-strip");
        const panel = document.querySelector(".vault-editor-pane");
        const pstyle = getComputedStyle(panel);
        frames.push({ t: performance.now() - started,
          tabs: [...strip.querySelectorAll('[role="tab"]')].map((tab) => {
            const parent = tab.parentElement; const rect = parent.getBoundingClientRect(); const style = getComputedStyle(parent);
            const labelRange = document.createRange(); labelRange.selectNodeContents(tab);
            return { title: tab.textContent, x: rect.x, width: rect.width, opacity: Number(style.opacity), transform: style.transform,
              labelOffsetY: labelRange.getBoundingClientRect().y - rect.y,
              selected: tab.getAttribute("aria-selected"), original: !known.has(tab.textContent) || known.get(tab.textContent) === parent,
              transition: style.transitionDuration, animation: style.animationName };
          }),
          knownConnected: [...known].map(([title, node]) => ({ title, connected: node.isConnected })),
          exits: [...strip.querySelectorAll(".vault-tab-exit")].map((ghost) => {
            const labelRange = document.createRange(); labelRange.selectNodeContents(ghost);
            return { title: ghost.textContent, opacity: Number(getComputedStyle(ghost).opacity), inert: ghost.inert,
              labelOffsetY: labelRange.getBoundingClientRect().y - ghost.getBoundingClientRect().y,
              hidden: ghost.getAttribute("aria-hidden"), interactive: Boolean(ghost.querySelector("button,input,[role=tab],[id]")) || Boolean(ghost.id) };
          }),
          title: document.querySelector('[aria-label="노트 이름"]')?.value,
          panel: { opacity: Number(pstyle.opacity), transform: pstyle.transform, animation: pstyle.animationName, transition: pstyle.transitionDuration },
          running: [...strip.getAnimations({ subtree: true }), ...panel.getAnimations({ subtree: true })]
            .filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => ({ name: animation.animationName ?? animation.transitionProperty ?? "animation", target: animation.effect?.target?.className })),
        });
        if (performance.now() - started < 420) requestAnimationFrame(sample); else resolve(frames);
      };
      sample();
    }, { capture: true, once: true }));
  });
  await action();
  return page.evaluate(() => window.memoMotionSamples);
}

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`Memo close, reopen and activate preserve state with natural motion (${reducedMotion})`, async ({ page, request }, testInfo) => {
    test.skip(!["vault-chromium-desktop-1280", "vault-webkit-desktop-1280", "vault-firefox-desktop-1280"].includes(testInfo.project.name), "Synthetic encrypted owner runs once per engine and motion preference, then checks narrow layout.");
    await page.emulateMedia({ reducedMotion });
    const fixture = await seedScenario(request, "authenticated-verified");
    const diagnostics = observePage(page);
    const failedReads = [];
    const readHttpErrors = [];
    let phase = "setup";
    const readKey = (request) => `${request.method()} ${request.url()} ${request.postData() ?? ""}`;
    const isEmulatorRead = (request) => request.method() === "POST"
      && /^http:\/\/127\.0\.0\.1:8080\/v1\/projects\/quickmemo-share-api-test\/databases\/\(default\)\/documents:batchGet\?key=fake-emulator-api-key$/u.test(request.url());
    page.on("requestfailed", (request) => {
      if (isEmulatorRead(request)) failedReads.push({ key: readKey(request), url: request.url(), recovered: false, phase });
    });
    page.on("response", (response) => {
      if (!isEmulatorRead(response.request())) return;
      if (response.status() >= 400) readHttpErrors.push(response.status());
      if (response.status() !== 200) return;
      const key = readKey(response.request());
      for (const failed of failedReads) if (failed.key === key) failed.recovered = true;
    });
    await loginDirectly(page, fixture.viewerAuth, diagnostics);
    await navigateWithinApp(page, "/app");
    await expect(page.locator('.vault-panel-toolbar button[aria-label="새 노트"]')).toBeEnabled({ timeout: 30_000 });
    for (const suffix of ["A", "B", "C"]) await createNote(page, `Motion ${suffix}`);
    // Classify only this exact loopback read's console object after its
    // identical method/URL/body actually retried with HTTP 200. Unrecovered
    // attempts and HTTP/auth errors remain failures at every checkpoint.
    const checkRuntime = async (extraSecrets = []) => {
      await expect.poll(() => failedReads.every((read) => read.recovered), "every failed loopback read actually recovers").toBe(true);
      expect(readHttpErrors, "loopback read HTTP/auth errors").toEqual([]);
      for (const error of diagnostics.consoleErrors) {
        const failures = failedReads.filter((read) => read.url === error.location);
        if (error.text === "Failed to load resource: The network connection was lost." && failures.length && failures.every((read) => read.recovered)) {
          diagnostics.expectedTransientFirestoreTransportErrors.add(error);
        }
      }
      const recovery = {
        failedReadAttempts: failedReads.length,
        recoveredReadAttempts: failedReads.filter((read) => read.recovered).length,
        setupReadFailures: failedReads.filter((read) => read.phase === "setup").length,
        verificationReadFailures: failedReads.filter((read) => read.phase === "verification").length,
        classifiedConsoleErrors: diagnostics.expectedTransientFirestoreTransportErrors.size,
        httpErrors: readHttpErrors
      };
      await writeFile(testInfo.outputPath("memo-runtime-recovery.json"), JSON.stringify(recovery, null, 2));
      await expectCleanRuntime(diagnostics, fixture, extraSecrets);
    };
    await checkRuntime();
    phase = "verification";
    await expect(page.getByRole("tab", { name: "Motion C", exact: true })).toHaveAttribute("aria-selected", "true");
    const close = await measureClick(page, () => page.getByRole("button", { name: "Motion B 닫기", exact: true }).click());
    await expect(page.getByRole("tab", { name: "Motion B", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Motion C", exact: true })).toHaveAttribute("aria-selected", "true");
    const open = await measureClick(page, () => page.getByRole("treeitem", { name: "Motion B", exact: true }).click());
    await expect(page.getByRole("tab", { name: "Motion B", exact: true })).toHaveAttribute("aria-selected", "true");
    const activate = await measureClick(page, () => page.getByRole("tab", { name: "Motion A", exact: true }).click());
    await expect(page.getByLabel("노트 이름")).toHaveValue("Motion A");
    expect(await readVaultEditorSource(page.getByRole("textbox", { name: "Markdown 편집기" }))).toBe(sourceFor("Motion A"));
    const summarize = (frames) => ({ frames: frames.length, runningFiniteMotionFrames: frames.filter((frame) => frame.running.length).length,
      panelOpacityStates: [...new Set(frames.map((frame) => frame.panel.opacity))], panelTransformStates: [...new Set(frames.map((frame) => frame.panel.transform))],
      tabs: ["Motion A", "Motion B", "Motion C"].map((title) => {
        const states = frames.flatMap((frame) => frame.tabs.filter((tab) => tab.title === title));
        return { title, xStates: [...new Set(states.map((tab) => Math.round(tab.x * 100) / 100))], opacityStates: [...new Set(states.map((tab) => tab.opacity))],
          originalRetained: states.every((tab) => tab.original), connectedFrames: frames.filter((frame) => frame.knownConnected.some((node) => node.title === title && node.connected)).length };
      }) });
    const observation = JSON.stringify({ reducedMotion, summary: { close: summarize(close), open: summarize(open), activate: summarize(activate) }, frames: { close, open, activate } }, null, 2);
    await writeFile(testInfo.outputPath("memo-motion-observation.json"), observation);
    await testInfo.attach("memo-motion-observation", { contentType: "application/json", body: observation });
    await page.screenshot({ path: testInfo.outputPath("memo-motion-after.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await checkRuntime();
    if (reducedMotion === "no-preference") {
      const remainingC = close.flatMap((frame) => frame.tabs.filter((tab) => tab.title === "Motion C"));
      expect(new Set(remainingC.map((tab) => Math.round(tab.x * 100))).size, "C moves through intermediate positions as middle B closes").toBeGreaterThan(2);
      const fadingB = close.flatMap((frame) => frame.exits.filter((ghost) => ghost.title === "Motion B" && ghost.opacity > 0.01 && ghost.opacity < 0.99));
      expect(fadingB.length, "B's original title fades while its logical tab is already closed").toBeGreaterThan(1);
      expect(fadingB.every((ghost) => ghost.inert && ghost.hidden === "true" && !ghost.interactive)).toBe(true);
      const baselineLabelOffset = close[0].tabs.find((tab) => tab.title === "Motion B").labelOffsetY;
      expect(Math.max(...fadingB.map((ghost) => Math.abs(ghost.labelOffsetY - baselineLabelOffset))), "the exit title keeps its original text baseline").toBeLessThanOrEqual(1);
      expect(open.flatMap((frame) => frame.tabs.filter((tab) => tab.title === "Motion B" && tab.opacity > 0.01 && tab.opacity < 0.99)).length).toBeGreaterThan(1);
      expect(activate.filter((frame) => frame.panel.opacity > 0.01 && frame.panel.opacity < 0.99).length).toBeGreaterThan(1);
    } else {
      expect(close.flatMap((frame) => frame.exits)).toEqual([]);
      expect(open.flatMap((frame) => frame.tabs.filter((tab) => tab.title === "Motion B")).every((tab) => tab.opacity === 1 && tab.transform === "none")).toBe(true);
      expect(activate.every((frame) => frame.panel.opacity === 1 && frame.panel.transform === "none")).toBe(true);
    }
    await expect(page.locator(".vault-tab-exit")).toHaveCount(0);
    const editor = page.getByRole("textbox", { name: "Markdown 편집기" });
    const original = sourceFor("Motion A");
    const suffix = " motion-draft";
    const edited = original + suffix;
    await pressVaultEditorModKey(editor, "End");
    // Key typing has an explicit keyboard event sequence. Firefox's automation
    // insertText emits a compose continuation without compose.start, so it is
    // not used as proof of an OS IME or a separate undo group here.
    await editor.pressSequentially(suffix);
    await expect.poll(() => readVaultEditorSource(editor)).toBe(edited);
    await page.getByRole("tab", { name: "Motion B", exact: true }).click();
    await page.getByRole("tab", { name: "Motion A", exact: true }).click();
    await expect.poll(() => readVaultEditorSource(editor)).toBe(edited);
    await pressVaultEditorModKey(editor, "z");
    await expect.poll(() => readVaultEditorSource(editor)).toBe(original);
    await pressVaultEditorModKey(editor, "Shift+z");
    await expect.poll(() => readVaultEditorSource(editor)).toBe(edited);
    await pressVaultEditorModKey(editor, "z");
    await expect.poll(() => readVaultEditorSource(editor)).toBe(original);
    await saveVaultDocument(page, { allowClean: true });
    const scroller = page.locator(".vault-editor-pane .cm-scroller");
    await scroller.evaluate(async (element) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      element.scrollTop = 180;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    // Sample the actual position at the navigation event, after CM's pending
    // virtual line-height measurements; no guessed delay is the baseline.
    await page.evaluate(() => document.addEventListener("click", () => {
      const content = document.querySelector('.vault-editor-pane [aria-label="Markdown 편집기"]');
      const view = content.cmTile.root.view;
      const snapshot = view.scrollSnapshot().value;
      const scroller = view.scrollDOM;
      window.memoScrollBeforeSwitch = scroller.scrollTop;
      window.memoScrollGeometryBefore = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
        anchor: snapshot.range.head, yMargin: snapshot.yMargin, contentTop: view.contentDOM.getBoundingClientRect().top,
        scrollerTop: scroller.getBoundingClientRect().top, anchorCoordinates: view.coordsAtPos(snapshot.range.head),
        lines: [...content.querySelectorAll('.cm-line')].map((line) => ({ from: view.posAtDOM(line), top: line.getBoundingClientRect().top, height: line.getBoundingClientRect().height })) };
    }, { once: true, capture: true }));
    await page.getByRole("tab", { name: "Motion B", exact: true }).click();
    const scroll = await page.evaluate(() => window.memoScrollBeforeSwitch);
    expect(scroll).toBeGreaterThan(100);
    await page.getByRole("tab", { name: "Motion A", exact: true }).click();
    try {
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(scroll);
    } finally {
      const geometry = await page.evaluate(() => {
        const content = document.querySelector('.vault-editor-pane [aria-label="Markdown 편집기"]');
        const view = content.cmTile.root.view;
        const snapshot = view.scrollSnapshot().value;
        return { before: window.memoScrollGeometryBefore, after: { scrollTop: view.scrollDOM.scrollTop, scrollHeight: view.scrollDOM.scrollHeight,
          anchor: snapshot.range.head, yMargin: snapshot.yMargin, contentTop: view.contentDOM.getBoundingClientRect().top,
          scrollerTop: view.scrollDOM.getBoundingClientRect().top, previousAnchorCoordinates: view.coordsAtPos(window.memoScrollGeometryBefore.anchor),
          lines: [...content.querySelectorAll('.cm-line')].map((line) => ({ from: view.posAtDOM(line), top: line.getBoundingClientRect().top, height: line.getBoundingClientRect().height })) } };
      });
      await writeFile(testInfo.outputPath("memo-scroll-geometry.json"), JSON.stringify(geometry, null, 2));
      expect(geometry.after.anchor).toBe(geometry.before.anchor);
      expect(Math.abs((geometry.after.previousAnchorCoordinates.top - geometry.after.scrollerTop)
        - (geometry.before.anchorCoordinates.top - geometry.before.scrollerTop)), "the same document anchor keeps its viewport offset").toBeLessThanOrEqual(1);
    }
    await expect.poll(() => readVaultEditorSource(editor)).toBe(original);
    // Reopening during an exit has one accessible tab and no stale visual title.
    await page.getByRole("button", { name: "Motion B 닫기", exact: true }).click();
    await page.getByRole("treeitem", { name: "Motion B", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Motion B", exact: true })).toHaveCount(1);
    await expect(page.locator(".vault-tab-exit")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const strip = page.locator(".vault-tab-strip");
    await expect.poll(() => strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "Motion B 닫기", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Motion B", exact: true })).toHaveCount(0);
    await expect(page.locator(".vault-tab-exit")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Leftmost and then final/current close keep one coherent empty workspace.
    await page.getByRole("button", { name: "Motion A 닫기", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Motion A", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Motion C 닫기", exact: true }).click();
    await expect(page.locator('.vault-tab-strip [role="tab"]')).toHaveCount(0);
    await expect(page.locator(".vault-tab-exit")).toHaveCount(0);
    await checkRuntime([edited]);
  });
}
