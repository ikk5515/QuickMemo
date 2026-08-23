import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(join(process.cwd(), "src/features/canvas/canvas.css"), "utf8");

describe("Canvas responsive interaction styles", () => {
  it("keeps the 320px toolbar inside the viewport with horizontal tool scrolling", () => {
    const mobileStyles = stylesSource.slice(stylesSource.indexOf("@media (max-width: 640px) {"));

    expect(mobileStyles).toMatch(/\.vault-canvas-toolbar \{[\s\S]*?box-sizing: border-box;[\s\S]*?left: 9px;[\s\S]*?max-width: calc\(100% - 18px\);[\s\S]*?width: calc\(100% - 18px\);/);
    expect(stylesSource).toMatch(/\.vault-canvas-toolbar \{[\s\S]*?overflow-x: auto;/);
  });

  it("provides 44px coarse-pointer targets without enlarging the color swatch", () => {
    const touchStyles = stylesSource.slice(stylesSource.indexOf("@media (max-width: 640px), (pointer: coarse) {"));

    expect(touchStyles).toMatch(/\.vault-canvas-toolbar button,[\s\S]*?\.vault-canvas-file-card button,[\s\S]*?\.vault-canvas-safe-link \{[\s\S]*?min-height: 44px;/);
    expect(touchStyles).toMatch(/\.vault-json-canvas \.react-flow__controls-button \{[\s\S]*?height: 44px;[\s\S]*?min-width: 44px;[\s\S]*?width: 44px;/);
    expect(touchStyles).toMatch(/\.vault-canvas-palette button \{[\s\S]*?height: 44px;[\s\S]*?min-width: 44px;[\s\S]*?width: 44px;/);
    expect(stylesSource).toMatch(/\.vault-canvas-color-swatch \{[\s\S]*?height: 19px;[\s\S]*?width: 19px;/);
    expect(touchStyles).toMatch(/\.vault-canvas-context-menu button \{[\s\S]*?min-height: 44px;/);
  });

  it("keeps decrypted group background previews inert behind editable controls", () => {
    expect(stylesSource).toMatch(/\.vault-canvas-group-background-preview \{[\s\S]*?pointer-events: none;[\s\S]*?position: absolute;/);
    expect(stylesSource).toMatch(/\.vault-canvas-group-content > :not\(\.vault-canvas-group-background-preview\) \{[\s\S]*?z-index: 1;/);
  });
});
