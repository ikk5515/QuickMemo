import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");

describe("NotesPage security controls", () => {
  it("renders PDF previews as an object without script or same-origin iframe grants", () => {
    const pdfObject = notesPageSource.match(/<object[\s\S]*?className="pdf-preview-frame"[\s\S]*?>/)?.[0] ?? "";

    expect(pdfObject).toContain('type="application/pdf"');
    expect(pdfObject).not.toContain("allow-scripts");
    expect(pdfObject).not.toContain("allow-same-origin");
    expect(notesPageSource).not.toContain("dangerouslySetInnerHTML={preview");
  });
});
