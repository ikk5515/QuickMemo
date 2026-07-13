import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

describe("note UI styles", () => {
  it("keeps editor and read-only note bodies on the same compact paragraph rhythm", () => {
    expect(stylesSource).toMatch(
      /\.rich-body-input\.ProseMirror,\s*\.note-preview-body,\s*\.admin-note-view-body \{\s*line-height: 1;\s*\}/
    );
    expect(stylesSource).toMatch(
      /:is\(\.rich-body-input, \.note-preview-body, \.admin-note-view-body\) p \{\s*margin: 0;\s*\}/
    );
    expect(stylesSource).toMatch(
      /:is\(\.rich-body-input, \.note-preview-body, \.admin-note-view-body\) :is\(figure, ul, ol\) \{\s*margin: 0 0 0\.5em;\s*\}/
    );
    expect(stylesSource).not.toMatch(
      /\.rich-body-input\.ProseMirror,\s*\.note-preview-body,\s*\.admin-note-view-body \{\s*line-height: 1\.68;/
    );
  });

  it("computes the same spacing for editor, preview, public share, and admin bodies", () => {
    const style = document.createElement("style");
    style.textContent = stylesSource;
    document.head.append(style);
    document.body.innerHTML = `
      <div class="rich-body-input ProseMirror"><p>editor</p><figure>figure</figure></div>
      <div class="note-preview-body"><p>preview</p><figure>figure</figure></div>
      <div class="note-preview-body public-share-body"><p>public</p><figure>figure</figure></div>
      <div class="admin-note-view-body"><p>admin</p><figure>figure</figure></div>
    `;

    try {
      const surfaces = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".rich-body-input.ProseMirror, .note-preview-body, .admin-note-view-body"
        )
      );

      expect(surfaces).toHaveLength(4);

      for (const surface of surfaces) {
        const paragraph = surface.querySelector("p");
        const figure = surface.querySelector("figure");

        expect(getComputedStyle(surface).lineHeight).toBe("1");
        expect(getComputedStyle(paragraph!).margin).toBe("0px");
        expect(getComputedStyle(figure!).marginLeft).toBe("0px");
        expect(getComputedStyle(figure!).marginRight).toBe("0px");
      }
    } finally {
      document.body.replaceChildren();
      style.remove();
    }
  });

  it("uses one rail contract for the editor drawer and all-notes folder panel", () => {
    expect(stylesSource).toContain("--notes-layout-gap: 16px;");
    expect(stylesSource).toContain("--notes-panel-padding: 16px;");
    expect(stylesSource).toContain("--notes-rail-width: clamp(280px, 24vw, 320px);");
    expect(stylesSource).toContain("--notes-panel-height: calc(100svh - 110px);");
    expect(stylesSource).toMatch(
      /\.notes-editor-layout\.with-drawer \{\s*grid-template-columns: var\(--notes-rail-width\) minmax\(0, 1fr\);\s*\}/
    );
    expect(stylesSource).toMatch(
      /\.personal-overview-layout \{[^}]*grid-template-columns: var\(--notes-rail-width\) minmax\(0, 1fr\);[^}]*\}/
    );
    expect(stylesSource).toMatch(
      /\.note-drawer \{(?=[^}]*height: var\(--notes-panel-height\);)(?=[^}]*max-height: var\(--notes-panel-height\);)[^}]*\}/
    );
    expect(stylesSource).toMatch(
      /\.overview-folder-panel \{(?=[^}]*height: var\(--notes-panel-height\);)(?=[^}]*max-height: var\(--notes-panel-height\);)[^}]*\}/
    );
    expect(stylesSource).toMatch(
      /\.overview-folder-panel,\s*\.overview-note-panel \{(?=[^}]*align-content: start;)[^}]*\}/
    );
    expect(stylesSource).toMatch(
      /\.overview-note-panel \{(?=[^}]*min-height: var\(--notes-panel-height\);)[^}]*\}/
    );
    expect(stylesSource).toMatch(/\.full-editor-panel \{(?=[^}]*min-width: 0;)[^}]*\}/);
  });

  it("bounds stacked note lists while letting the mobile overview rail flow naturally", () => {
    expect(stylesSource).toMatch(
      /\.notes-editor-layout\.with-drawer \.note-drawer \{(?=[^}]*height: auto;)(?=[^}]*max-height: min\(58svh, 560px\);)(?=[^}]*min-height: 0;)(?=[^}]*overflow: auto;)(?=[^}]*position: static;)[^}]*\}/
    );
    expect(stylesSource).toMatch(
      /\.overview-folder-panel \{(?=[^}]*gap: 12px;)(?=[^}]*height: auto;)(?=[^}]*max-height: none;)(?=[^}]*overflow: visible;)(?=[^}]*padding: 12px;)(?=[^}]*position: static;)[^}]*\}/
    );
  });
});
