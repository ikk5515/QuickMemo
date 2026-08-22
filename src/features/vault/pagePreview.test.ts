import { describe, expect, it } from "vitest";
import type { MarkdownLinkReference } from "../markdown";
import {
  MAX_VAULT_PAGE_PREVIEW_BODY_CHARACTERS,
  MAX_VAULT_PAGE_PREVIEW_PATH_CHARACTERS,
  MAX_VAULT_PAGE_PREVIEW_TITLE_CHARACTERS,
  createVaultPagePreviewContent,
  vaultPagePreviewDelay,
  vaultPagePreviewPosition,
  type VaultPagePreviewTarget
} from "./pagePreview";

const internalReference: MarkdownLinkReference = {
  display: "Target",
  embed: false,
  kind: "wikilink",
  path: "Folder/Target",
  raw: "[[Folder/Target]]",
  subpath: null,
  target: "Folder/Target"
};

const target: VaultPagePreviewTarget = {
  body: "---\nsecret: hidden-property\n---\n# Heading\nSafe **body** [[Other|label]] <script>leak()</script>",
  contentFormat: "markdown-v1",
  entryKind: "markdown",
  id: "target",
  path: "Folder/Target.md",
  title: "Target"
};

describe("Vault Page Preview", () => {
  it("creates bounded inert text without frontmatter or active HTML", () => {
    const preview = createVaultPagePreviewContent({
      reference: internalReference,
      resolvedTargetEntryId: target.id,
      target: {
        ...target,
        body: `${target.body}${" long".repeat(1_000)}`,
        path: target.path.repeat(100),
        title: target.title.repeat(100)
      }
    });

    expect(preview).not.toBeNull();
    expect(preview?.body).toContain("Safe body label Other");
    expect(preview?.body).not.toContain("hidden-property");
    expect(preview?.body).not.toContain("script");
    expect(preview?.body).not.toContain("leak");
    expect(preview?.body.length).toBeLessThanOrEqual(MAX_VAULT_PAGE_PREVIEW_BODY_CHARACTERS);
    expect(preview?.path.length).toBeLessThanOrEqual(MAX_VAULT_PAGE_PREVIEW_PATH_CHARACTERS);
    expect(preview?.title.length).toBeLessThanOrEqual(MAX_VAULT_PAGE_PREVIEW_TITLE_CHARACTERS);
  });

  it("does not expose external, unresolved, mismatched, inaccessible, or non-note targets", () => {
    expect(createVaultPagePreviewContent({
      reference: { ...internalReference, kind: "external" },
      resolvedTargetEntryId: target.id,
      target
    })).toBeNull();
    expect(createVaultPagePreviewContent({ reference: internalReference, target })).toBeNull();
    expect(createVaultPagePreviewContent({
      reference: internalReference,
      resolvedTargetEntryId: target.id,
      target: null
    })).toBeNull();
    expect(createVaultPagePreviewContent({
      reference: internalReference,
      resolvedTargetEntryId: target.id,
      target: { ...target, id: "other" }
    })).toBeNull();
    expect(createVaultPagePreviewContent({
      reference: internalReference,
      resolvedTargetEntryId: target.id,
      target: { ...target, contentFormat: "legacy-html-v1" }
    })).toBeNull();
    expect(createVaultPagePreviewContent({
      reference: internalReference,
      resolvedTargetEntryId: target.id,
      target: {
        ...target,
        contentFormat: "json-canvas-v1",
        entryKind: "canvas"
      }
    })).toBeNull();
  });

  it("strips active legacy HTML and clamps the popup to narrow viewports", () => {
    const preview = createVaultPagePreviewContent({
      reference: internalReference,
      resolvedTargetEntryId: target.id,
      target: {
        ...target,
        body: "<p>Allowed text</p><iframe>hidden frame</iframe><style>.secret{}</style>",
        contentFormat: "legacy-html-v1",
        entryKind: "legacy-html"
      }
    });
    expect(preview?.body).toBe("Allowed text");

    expect(vaultPagePreviewPosition(
      { bottom: 552, left: 300, top: 530 },
      { height: 568, width: 320 }
    )).toEqual({ left: 12, placement: "above", top: 522, width: 296 });
    expect(vaultPagePreviewPosition(
      { bottom: 70, left: -30, top: 50 },
      { height: 800, width: 1_000 }
    )).toEqual({ left: 12, placement: "below", top: 78, width: 360 });
  });

  it("keeps deliberate delays but removes them for reduced motion", () => {
    expect(vaultPagePreviewDelay("open", "pointer", false)).toBe(320);
    expect(vaultPagePreviewDelay("open", "focus", false)).toBe(120);
    expect(vaultPagePreviewDelay("close", "focus", false)).toBe(120);
    expect(vaultPagePreviewDelay("open", "pointer", true)).toBe(0);
    expect(vaultPagePreviewDelay("close", "pointer", true)).toBe(0);
  });
});
