import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");

describe("NotesPage security controls", () => {
  it("renders PDF previews in a sandboxed iframe without script or same-origin grants", () => {
    const pdfIframe = notesPageSource.match(/<iframe[\s\S]*?className="pdf-preview-frame"[\s\S]*?\/>/)?.[0] ?? "";

    expect(pdfIframe).toContain('sandbox=""');
    expect(pdfIframe).not.toContain("allow-scripts");
    expect(pdfIframe).not.toContain("allow-same-origin");
  });
});
