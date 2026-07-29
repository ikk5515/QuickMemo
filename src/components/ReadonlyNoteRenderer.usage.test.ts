import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const rendererSource = source("src/components/ReadonlyNoteRenderer.tsx");
const notesPageSource = source("src/pages/NotesPage.tsx");
const publicSharePageSource = source("src/pages/PublicSharePage.tsx");
const secureShareViewerSource = source("src/components/SecurePublicShareViewer.tsx");
const adminPageSource = source("src/pages/AdminPage.tsx");

describe("ReadonlyNoteRenderer surface contract", () => {
  it("uses one renderer for note view, v1, v2 owner/viewer, and admin full-note bodies", () => {
    expect(notesPageSource).toContain("<ReadonlyNoteRenderer");
    expect(notesPageSource).toContain('className="note-preview-body"');
    expect(publicSharePageSource).toContain("<ReadonlyNoteRenderer");
    expect(publicSharePageSource).toContain('className="note-preview-body public-share-body"');
    expect(secureShareViewerSource).toContain("<ReadonlyNoteRenderer");
    expect(secureShareViewerSource).toContain(
      'className="note-preview-body public-share-body secure-public-share-body"'
    );
    expect(adminPageSource).toContain("<ReadonlyNoteRenderer");
    expect(adminPageSource).toContain('className="admin-note-view-body"');
    expect(notesPageSource).toContain('contentFormat={renderLegacyPlainText ? "plain-text" : "html"}');
    expect(publicSharePageSource).toContain("contentFormat={bodyFormat}");
    expect(secureShareViewerSource).toContain("contentFormat={content.bodyFormat}");
    expect(adminPageSource).toContain("contentFormat={selectedAdminNote.bodyFormat}");
  });

  it("keeps the public renderer independent of the interactive TipTap editor bundle", () => {
    expect(rendererSource).not.toContain("@tiptap/");
    expect(rendererSource).not.toContain("NotesPage");
    expect(rendererSource).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });

  it("keeps summary/search text separate from semantic Quick Copy text", () => {
    expect(secureShareViewerSource).toContain("copyTextFromEditorHtml(bodyHtml)");
    expect(secureShareViewerSource).toContain(
      'readonlyBody.contentFormat === "plain-text"'
    );
    expect(secureShareViewerSource).not.toContain(
      "bodyPlainText: previewTextFromHtml(bodyHtml)"
    );
    expect(notesPageSource).toContain("previewTextFromHtml(note.body)");
  });
});
