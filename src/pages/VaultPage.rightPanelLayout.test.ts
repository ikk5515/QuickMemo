import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
const vaultStyles = readFileSync(join(process.cwd(), "src/styles/vault.css"), "utf8");
const propertyStyles = readFileSync(
  join(process.cwd(), "src/features/vault/vaultProperties.css"),
  "utf8"
);

function ruleBodiesForSelector(css: string, selector: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1]
      .split(",")
      .some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]);
}

describe("Vault right-panel responsive layout contract", () => {
  it("exposes a bounded pointer and keyboard separator backed by encrypted workspace state", () => {
    expect(source).toContain('aria-label="오른쪽 패널 너비 조절"');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain('role="separator"');
    expect(source).toContain("onKeyDown={handleRightPanelResizeKeyDown}");
    expect(source).toContain("onPointerMove={moveRightPanelResize}");
    expect(source).toContain("onLostPointerCapture={finishRightPanelResize}");
    expect(source).toContain("window.requestAnimationFrame");
    expect(source).toContain('"--vault-right-panel-width": `${effectiveRightPanelWidth}px`');
    expect(source).toContain('vaultWorkspaceRef.current?.style.setProperty(');
    expect(source).toContain("vaultWorkspaceWidth");
    expect(source).toContain("new ResizeObserver(updateViewportWidth)");
    expect(source).toContain("workspace.clientWidth || window.innerWidth");
    expect(source).toContain('window.addEventListener("resize", updateViewportWidth');
    expect(source).toContain('window.removeEventListener("resize", updateViewportWidth)');
    expect(source).toContain("useLayoutEffect(() => {");
    const resizeFrame = source.slice(
      source.indexOf("const queueRightPanelResize"),
      source.indexOf("const beginRightPanelResize")
    );
    expect(resizeFrame).not.toContain("setRightPanelWidth(");
    expect(source).toContain("rightPanelWidth,");
    expect(source).toContain("setRightPanelWidth(restored.right.width)");
    expect(ruleBodiesForSelector(vaultStyles, ".vault-right-panel-resizer")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/inset-inline-start:\s*0;[\s\S]*top:\s*41px;[\s\S]*width:\s*12px;/u)
      ])
    );
    expect(vaultStyles).toMatch(
      /@media \(max-width: 1024px\), \(pointer: coarse\)[\s\S]*\.vault-right-panel-resizer[\s\S]*inset-inline-start:\s*0;[\s\S]*top:\s*48px;[\s\S]*width:\s*24px;/u
    );
  });

  it("uses compact icon tabs and a complete visible current-mode label", () => {
    expect(ruleBodiesForSelector(vaultStyles, '.vault-right-panel > header [role="tab"]')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/flex:\s*0 0 32px;[\s\S]*justify-content:\s*center;/u)
      ])
    );
    expect(ruleBodiesForSelector(vaultStyles, ".vault-right-panel-current-mode")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/u)
      ])
    );
    expect(source).toContain("RIGHT_PANEL_TABS.find(({ mode }) => mode === rightMode)?.label");
    expect(vaultStyles).toMatch(
      /@media \(max-width: 1024px\) and \(pointer: fine\)[\s\S]*\.vault-right-panel > header \[role="tab"\][\s\S]*flex:\s*0 0 32px;[\s\S]*\.vault-right-panel > header > button[\s\S]*flex-basis:\s*32px;/u
    );
    expect(vaultStyles).toMatch(
      /@media \(min-width: 761px\) and \(max-width: 1024px\) and \(pointer: coarse\)[\s\S]*\.vault-right-panel > header > div[\s\S]*overflow-x:\s*hidden;[\s\S]*\.vault-right-panel > header \[role="tab"\][\s\S]*flex:\s*1 1 44px;[\s\S]*min-width:\s*30px;/u
    );
  });

  it("keeps Properties controls inside a narrow sidebar and touch sized", () => {
    expect(ruleBodiesForSelector(propertyStyles, ".vault-property-row")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(88px, 0\.8fr\) auto;/u)
    ]));
    expect(ruleBodiesForSelector(propertyStyles, ".vault-property-value")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-column:\s*1 \/ 3;[\s\S]*min-width:\s*0;/u)
    ]));
    expect(ruleBodiesForSelector(propertyStyles, ".vault-property-add")).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(88px, 0\.8fr\);/u)
    ]));
    expect(propertyStyles).toMatch(
      /@media \(max-width: 1024px\), \(pointer: coarse\)[\s\S]*\.vault-property-row select,[\s\S]*\.vault-property-add select[\s\S]*min-block-size: 44px;/u
    );
  });

  it("wraps Local Graph controls and prevents its pin from covering settings", () => {
    expect(ruleBodiesForSelector(vaultStyles, ".vault-local-graph-pane .qm-graph-toolbar")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/flex-wrap:\s*wrap;[\s\S]*max-width:\s*calc\(100% - 1rem\);[\s\S]*right:\s*\.5rem;/u)
      ])
    );
    expect(ruleBodiesForSelector(vaultStyles, ".vault-local-graph-pin")).toEqual(expect.arrayContaining([
      expect.stringMatching(/inset-inline-end:\s*50px;[\s\S]*max-width:\s*calc\(100% - 66px\);/u),
      expect.stringMatching(/min-height:\s*44px;/u)
    ]));
  });

  it("removes the resize target when the right panel becomes a mobile drawer", () => {
    const mobileStart = vaultStyles.indexOf("@media (max-width: 760px) {");
    const narrowStart = vaultStyles.indexOf("@media (max-width: 390px) {", mobileStart);
    const mobileStyles = vaultStyles.slice(mobileStart, narrowStart);
    expect(ruleBodiesForSelector(mobileStyles, ".vault-right-panel-resizer")).toEqual(
      expect.arrayContaining([expect.stringMatching(/display:\s*none;/u)])
    );
    expect(source).toContain('{!mobileLayout && surface === "memo" ? (');
  });
});
