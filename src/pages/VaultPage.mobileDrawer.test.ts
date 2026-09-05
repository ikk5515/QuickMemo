import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
const styles = readFileSync(join(process.cwd(), "src/styles/vault.css"), "utf8");
const workspaceManagerStyles = readFileSync(
  join(process.cwd(), "src/features/vault/vaultWorkspaceManager.css"),
  "utf8"
);

function ruleBodiesForSelector(css: string, selector: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1]
      .split(",")
      .some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]);
}

describe("Vault mobile drawer accessibility contract", () => {
  it("treats open mobile panels as modal dialogs and makes the workspace inert", () => {
    expect(source).toContain('role={mobileLayout ? "dialog" : undefined}');
    expect(source).toContain("aria-modal={mobileLayout ? true : undefined}");
    expect(source).toContain("inert={Boolean(activeMobileDrawer)}");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
  });

  it("hands focus from the mobile tools drawer to the next dialog", () => {
    const launcher = source.slice(source.indexOf("  function closeMobilePanelsForDialog()"), source.indexOf("  const closeContextMenu"));
    expect(launcher).toContain("if (!mobileLayout) return;");
    expect(launcher).toContain("mobileDrawerReturnFocusRef.current = null;");
    expect(launcher).toContain("pendingMobileDrawerFocusRef.current = null;");
    expect(launcher).toContain("setLeftOpen(false);");
    expect(launcher).toContain("setRightOpen(false);");
    expect(launcher.match(/closeMobilePanelsForDialog\(\);/gu)).toHaveLength(2);
    expect(source).toContain("returnFocusTo={mobileLayout ? leftPanelToggleRef.current : trashButtonRef.current}");
    expect(source).toContain('  "summary",');
  });

  it("provides a pointer backdrop without creating a keyboard dead end", () => {
    expect(source).toContain('className="vault-mobile-drawer-backdrop"');
    expect(source).toContain("tabIndex={-1}");
    expect(styles).toMatch(/\.vault-mobile-drawer-backdrop\s*\{[\s\S]*position: absolute;[\s\S]*z-index: 29;/u);
  });

  it("keeps mobile tab actions outside the horizontally scrolling tab strip", () => {
    const tabBarStart = source.indexOf('<div className="vault-tab-bar">');
    const tabBarEnd = source.indexOf('<section aria-labelledby={group.activeTabId', tabBarStart);
    const tabBarSource = source.slice(tabBarStart, tabBarEnd);

    expect(tabBarStart).toBeGreaterThanOrEqual(0);
    expect(tabBarEnd).toBeGreaterThan(tabBarStart);
    expect(tabBarSource).toContain('className="vault-tab-strip"');
    expect(tabBarSource).toContain('className="vault-tab-actions"');
    expect(tabBarSource.indexOf('className="vault-tab-strip"')).toBeLessThan(
      tabBarSource.indexOf('className="vault-tab-actions"')
    );
    expect(tabBarSource).toMatch(/<div[^>]+className="vault-tab-strip"[\s\S]*<div className="vault-tab-actions" role="presentation">/u);
    expect(tabBarSource).toMatch(/className="vault-tab-actions"[\s\S]*aria-label="새 노트 탭"[\s\S]*aria-label=\{rightOpen \? "오른쪽 패널 닫기" : "오른쪽 패널 열기"\}/u);
    expect(tabBarSource).toContain('aria-label="탭 그룹 선택"');

    expect(ruleBodiesForSelector(styles, ".vault-tab-bar")).toEqual(expect.arrayContaining([
      expect.stringMatching(/display:\s*flex;[\s\S]*overflow:\s*hidden;/u)
    ]));
    expect(ruleBodiesForSelector(styles, ".vault-tab-strip")).toEqual(expect.arrayContaining([
      expect.stringMatching(/flex:\s*1 1 auto;[\s\S]*min-width:\s*0;[\s\S]*overflow-x:\s*auto;/u)
    ]));
    expect(ruleBodiesForSelector(styles, ".vault-tab-actions")).toEqual(expect.arrayContaining([
      expect.stringMatching(/flex:\s*0 0 auto;[\s\S]*z-index:\s*2;/u)
    ]));
  });

  it("keeps the mobile right-panel close control at a non-shrinking 44px target", () => {
    const touchMediaStart = styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {");
    const nextMediaStart = styles.indexOf("@media (max-width: 760px) {", touchMediaStart);
    const touchStyles = styles.slice(touchMediaStart, nextMediaStart);
    const closeButtonBodies = ruleBodiesForSelector(touchStyles, ".vault-right-panel > header > button");

    expect(touchMediaStart).toBeGreaterThanOrEqual(0);
    expect(nextMediaStart).toBeGreaterThan(touchMediaStart);
    expect(closeButtonBodies).toEqual(expect.arrayContaining([
      expect.stringMatching(/height:\s*44px;[\s\S]*width:\s*44px;/u),
      expect.stringMatching(/flex-basis:\s*44px;[\s\S]*min-width:\s*44px;/u)
    ]));
  });

  it("collapses split groups to one selectable surface at phone widths", () => {
    const mobileStart = styles.indexOf("@media (max-width: 760px) {");
    const narrowStart = styles.indexOf("@media (max-width: 390px) {", mobileStart);
    const mobileStyles = styles.slice(mobileStart, narrowStart);
    expect(ruleBodiesForSelector(mobileStyles, ".vault-tab-groups.split")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*minmax\(0, 1fr\);/u)
    ]));
    expect(ruleBodiesForSelector(styles, ".vault-tab-group-selector select")).toEqual(expect.arrayContaining([
      expect.stringMatching(/max-width:\s*88px;[\s\S]*min-width:\s*0;/u)
    ]));
  });

  it("gives the native mobile tab-group select an explicit WebKit-safe touch height", () => {
    const touchMediaStart = styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {");
    const nextMediaStart = styles.indexOf("@media (max-width: 760px) {", touchMediaStart);
    const touchStyles = styles.slice(touchMediaStart, nextMediaStart);
    const selectorBodies = ruleBodiesForSelector(touchStyles, ".vault-tab-group-selector select");

    expect(touchMediaStart).toBeGreaterThanOrEqual(0);
    expect(nextMediaStart).toBeGreaterThan(touchMediaStart);
    expect(selectorBodies).toEqual(expect.arrayContaining([
      expect.stringMatching(/box-sizing:\s*border-box;[\s\S]*height:\s*44px;[\s\S]*min-width:\s*44px;/u)
    ]));
    expect(ruleBodiesForSelector(touchStyles, ".vault-tab-group")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-rows:\s*45px minmax\(0, 1fr\);/u)
    ]));
  });

  it("keeps every visible mobile tab control at 44px without shrinking the title target", () => {
    const touchMediaStart = styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {");
    const nextMediaStart = styles.indexOf("@media (max-width: 760px) {", touchMediaStart);
    const touchStyles = styles.slice(touchMediaStart, nextMediaStart);

    expect(ruleBodiesForSelector(touchStyles, '.vault-tab-strip > [role="presentation"]')).toEqual(
      expect.arrayContaining([expect.stringMatching(/min-width:\s*132px;/u)])
    );
    expect(ruleBodiesForSelector(touchStyles, '.vault-tab-strip > [role="presentation"] button:first-child')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/min-height:\s*44px;[\s\S]*min-width:\s*44px;/u)
      ])
    );

    for (const selector of [
      '.vault-tab-strip > [role="presentation"] .vault-tab-pin',
      '.vault-tab-strip > [role="presentation"] button:last-child'
    ]) {
      expect(ruleBodiesForSelector(touchStyles, selector)).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /flex:\s*0 0 44px;[\s\S]*height:\s*44px;[\s\S]*min-height:\s*44px;[\s\S]*min-width:\s*44px;[\s\S]*width:\s*44px;/u
        )
      ]));
    }
  });

  it("loads tab chrome styles independently from the lazy workspace manager", () => {
    expect(ruleBodiesForSelector(styles, '.vault-tab-strip > [role="presentation"] .vault-tab-pin')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/flex:\s*0 0 25px;[\s\S]*min-height:\s*25px;[\s\S]*min-width:\s*25px;/u)
      ])
    );
    expect(workspaceManagerStyles).not.toContain(".vault-tab-strip");
  });

  it("publishes an explicit workspace synchronization state for browser waits", () => {
    expect(source).toMatch(/className=\{`vault-workspace[\s\S]*data-workspace-sync=\{workspaceConflict/u);
    expect(source).toContain('workspaceConflict\n          ? "conflict"');
    expect(source).toContain('!workspaceReady\n            ? "loading"');
    expect(source).toContain(
      'workspaceSavePending || latestWorkspaceSerialization !== lastSavedWorkspaceSerialization'
    );
    expect(source).toContain('? "pending"\n              : "saved"');
    expect(source).toContain("setLastSavedWorkspaceSerialization(serialized)");
  });
});
