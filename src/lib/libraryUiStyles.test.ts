import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const stylesSource = readFileSync(join(process.cwd(), "src/styles/library.css"), "utf8");
const appStylesSource = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelector("[data-library-style-test]")?.remove();
});

describe("library UI styles", () => {
  it("keeps the sidebar and results as grid panels while flattening only the desktop reader backdrop", () => {
    const style = document.createElement("style");
    style.dataset.libraryStyleTest = "true";
    style.textContent = stylesSource;
    document.head.append(style);
    document.body.innerHTML = `
      <main class="library-layout with-reader">
        <aside class="library-sidebar"></aside>
        <section class="library-results-panel"></section>
        <div class="library-reader-backdrop">
          <aside class="library-reader"></aside>
        </div>
      </main>
    `;

    const sidebar = document.querySelector<HTMLElement>(".library-sidebar");
    const results = document.querySelector<HTMLElement>(".library-results-panel");
    const readerBackdrop = document.querySelector<HTMLElement>(".library-reader-backdrop");
    const reader = document.querySelector<HTMLElement>(".library-reader");

    expect(getComputedStyle(sidebar!).display).toBe("grid");
    expect(getComputedStyle(results!).display).toBe("block");
    expect(getComputedStyle(readerBackdrop!).display).toBe("contents");
    expect(getComputedStyle(reader!).display).toBe("grid");
  });

  it("keeps all three desktop columns on the shared panel surface contract", () => {
    expect(stylesSource).toMatch(
      /\.library-sidebar,\s*\.library-results-panel,\s*\.library-reader \{\s*background: var\(--panel\);\s*border: 1px solid var\(--line\);\s*border-radius: var\(--radius-panel\);\s*box-shadow: var\(--shadow-card\);\s*min-width: 0;\s*\}/
    );
    expect(stylesSource).toMatch(
      /\.library-reader-backdrop \{\s*display: contents;\s*\}/
    );
  });

  it("keeps attachment previews above the mobile reader and nested attachment dialogs", () => {
    const previewLayer = Number(
      appStylesSource.match(/\.pdf-preview-backdrop \{\s*z-index: (\d+);/)?.[1] ?? 0
    );
    const noteAttachmentLayer = Number(
      appStylesSource.match(/\.note-insight-backdrop \{\s*z-index: (\d+);/)?.[1] ?? 0
    );
    const mobileReaderLayer = Number(
      stylesSource.match(/\.library-reader \{[^}]*z-index: (\d+);[^}]*\}/)?.[1] ?? 0
    );

    expect(previewLayer).toBeGreaterThan(noteAttachmentLayer);
    expect(previewLayer).toBeGreaterThan(mobileReaderLayer);
  });

  it("lets mobile preview surfaces shrink inside safe-area-aware dialogs", () => {
    const compactPreviewMedia = appStylesSource.match(
      /@media \(max-width: 900px\) \{([\s\S]*?)\n\}\n\n@media \(max-width: 680px\)/
    )?.[1] ?? "";

    expect(compactPreviewMedia).toMatch(
      /\.pdf-preview-backdrop \{\s*padding:\s*max\(10px, env\(safe-area-inset-top\)\)\s*max\(10px, env\(safe-area-inset-right\)\)\s*max\(10px, env\(safe-area-inset-bottom\)\)\s*max\(10px, env\(safe-area-inset-left\)\);\s*\}/
    );
    expect(compactPreviewMedia).toMatch(
      /\.pdf-preview-canvas-frame,\s*\.docx-preview-frame,\s*\.docx-preview-sandbox,\s*\.hwp-preview-frame,\s*\.document-preview-frame,\s*\.public-image-preview-frame,\s*\.file-text-preview \{\s*min-height: 0;\s*overscroll-behavior: contain;\s*\}/
    );
  });
});
