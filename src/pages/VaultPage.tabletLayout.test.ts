import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/styles/vault.css"), "utf8");

function ruleBodiesForSelector(css: string, selector: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1]
      .split(",")
      .some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]);
}

describe("Vault tablet sidebar layout contract", () => {
  it("docks the right sidebar instead of covering the editor at tablet widths", () => {
    const tabletStart = styles.indexOf("@media (max-width: 1180px) {");
    const touchStart = styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {", tabletStart);
    const tabletStyles = styles.slice(tabletStart, touchStart);

    expect(tabletStart).toBeGreaterThanOrEqual(0);
    expect(touchStart).toBeGreaterThan(tabletStart);
    expect(ruleBodiesForSelector(tabletStyles, ".vault-workspace")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*var\(--vault-rail-size\) minmax\(195px, 230px\) minmax\(0, 1fr\) var\(--vault-right-panel-size\);/u)
    ]));
    expect(ruleBodiesForSelector(tabletStyles, ".vault-workspace.vault-left-closed")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*var\(--vault-rail-size\) minmax\(0, 1fr\) var\(--vault-right-panel-size\);/u)
    ]));
    expect(ruleBodiesForSelector(tabletStyles, ".vault-right-panel")).toEqual(expect.arrayContaining([
      expect.stringMatching(/max-width:\s*none;[\s\S]*position:\s*relative;[\s\S]*width:\s*auto;/u)
    ]));
  });

  it("places the tablet title and mode controls in separate grid areas", () => {
    const headerStart = styles.indexOf("@media (min-width: 761px) and (max-width: 1180px) {");
    const touchStart = styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {", headerStart);
    const headerStyles = styles.slice(headerStart, touchStart);

    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(touchStart).toBeGreaterThan(headerStart);
    expect(ruleBodiesForSelector(headerStyles, ".vault-note-header")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-areas:\s*"breadcrumb title"\s*"actions actions";/u),
      expect.stringMatching(/grid-template-columns:\s*minmax\(70px, \.75fr\) minmax\(0, 1\.25fr\);/u),
      expect.stringMatching(/grid-template-rows:\s*minmax\(30px, auto\) minmax\(44px, auto\);/u)
    ]));
    expect(ruleBodiesForSelector(headerStyles, ".vault-note-header > input")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-area:\s*title;[\s\S]*width:\s*100%;/u)
    ]));
    expect(ruleBodiesForSelector(headerStyles, ".vault-note-actions")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-area:\s*actions;[\s\S]*justify-content:\s*flex-start;[\s\S]*width:\s*100%;/u)
    ]));
    expect(ruleBodiesForSelector(headerStyles, ".vault-note-content")).toEqual(expect.arrayContaining([
      expect.stringMatching(/height:\s*calc\(100% - 98px\);/u)
    ]));
  });

  it("keeps enough portrait-tablet canvas width while both sidebars are docked", () => {
    const compactStart = styles.indexOf("@media (min-width: 761px) and (max-width: 900px) {");
    const splitStart = styles.indexOf("@media (min-width: 761px) and (max-width: 1023px) {", compactStart);
    const compactStyles = styles.slice(compactStart, splitStart);

    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(splitStart).toBeGreaterThan(compactStart);
    expect(ruleBodiesForSelector(compactStyles, ".vault-workspace")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*var\(--vault-rail-size\) minmax\(150px, 170px\) minmax\(0, 1fr\) var\(--vault-right-panel-size\);/u)
    ]));
    expect(ruleBodiesForSelector(compactStyles, ".vault-workspace.vault-left-closed")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*var\(--vault-rail-size\) minmax\(0, 1fr\) var\(--vault-right-panel-size\);/u)
    ]));
    expect(ruleBodiesForSelector(compactStyles, ".vault-right-panel > header")).toEqual(expect.arrayContaining([
      expect.stringMatching(/min-height:\s*48px;/u)
    ]));
    expect(ruleBodiesForSelector(compactStyles, ".vault-right-panel > header > div")).toEqual(expect.arrayContaining([
      expect.stringMatching(/flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;[\s\S]*overflow-y:\s*hidden;/u)
    ]));
  });

  it("removes redundant split-pane actions and preserves a touch-size pin below 1024px", () => {
    const splitStart = styles.indexOf("@media (min-width: 761px) and (max-width: 1023px) {");
    const touchStart = styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {", splitStart);
    const splitStyles = styles.slice(splitStart, touchStart);
    const mobileStart = styles.indexOf("@media (max-width: 760px) {", touchStart);
    const touchStyles = styles.slice(touchStart, mobileStart);

    expect(splitStart).toBeGreaterThanOrEqual(0);
    expect(touchStart).toBeGreaterThan(splitStart);
    expect(ruleBodiesForSelector(splitStyles, ".vault-workspace-split .vault-new-tab")).toEqual(expect.arrayContaining([
      expect.stringMatching(/display:\s*none;/u)
    ]));
    expect(ruleBodiesForSelector(splitStyles, ".vault-workspace-split .vault-split-direction")).toEqual(expect.arrayContaining([
      expect.stringMatching(/display:\s*none;/u)
    ]));
    expect(ruleBodiesForSelector(touchStyles, '.vault-tab-strip > [role="presentation"] .vault-tab-pin')).toEqual(expect.arrayContaining([
      expect.stringMatching(/flex:\s*0 0 44px;[\s\S]*height:\s*44px;[\s\S]*width:\s*44px;/u)
    ]));
  });

  it("restores the right sidebar as a modal-style overlay only at phone widths", () => {
    const mobileStart = styles.indexOf("@media (max-width: 760px) {");
    const narrowStart = styles.indexOf("@media (max-width: 390px) {", mobileStart);
    const mobileStyles = styles.slice(mobileStart, narrowStart);

    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(narrowStart).toBeGreaterThan(mobileStart);
    expect(ruleBodiesForSelector(mobileStyles, ".vault-right-panel")).toEqual(expect.arrayContaining([
      expect.stringMatching(/bottom:\s*0;[\s\S]*position:\s*absolute;[\s\S]*right:\s*0;[\s\S]*z-index:\s*30;/u)
    ]));
  });
});
