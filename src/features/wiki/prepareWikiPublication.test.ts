import { describe, expect, it } from "vitest";
import { buildKnowledgeIndex } from "../knowledge/knowledgeIndex";
import { decodeVaultAsset, encodeVaultAsset } from "../vault/vaultAsset";
import { vaultEntryPath, type DecryptedVaultFolder, type DecryptedVaultNote } from "../vault/vaultData";
import { PUBLISHED_WIKI_LIMITS } from "./publishedWikiTypes";
import { prepareWikiPublication } from "./prepareWikiPublication";

const envelope = { version: 1 as const, algorithm: "AES-GCM" as const, cipherText: "fixture-ciphertext", iv: "fixture-iv" };
const folder = (id: string, displayName: string, parentId: string | null, extra: Partial<DecryptedVaultFolder> = {}): DecryptedVaultFolder => ({
  id, displayName, parentId, name: "encrypted-folder", ownerUid: "owner", color: "#123456", ...extra
});
const note = (id: string, folderId: string | null, title: string, body: string, extra: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote => ({
  id, folderId, title, body, ownerUid: "owner", type: "personal", participantUids: ["owner"],
  contentFormat: "markdown-v1", entryKind: "markdown", revision: 4, updatedBy: "owner",
  encryptedBody: envelope, encryptedTitle: envelope, wrappedKeys: {}, ...extra
});
const folders = [
  folder("private-parent", "PrivateAncestor", null),
  folder("root", "Public", "private-parent"),
  folder("sub", "Sub", "root"),
  folder("outside", "Confidential", "private-parent")
];

function validPng() {
  const bytes = new Uint8Array(57);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, 1); view.setUint32(20, 1);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}

describe("prepareWikiPublication", () => {
  it("copies only the selected active owner subtree without modifying encrypted or decrypted inputs", () => {
    const sources = [
      note("home", "root", "Home", "# Hello"),
      note("child", "sub", "Child", "content"),
      note("outside-note", "outside", "Secret", "outside-sensitive-body"),
      note("deleted", "root", "Deleted", "deleted-body", { isDeleted: true }),
      note("purged", "root", "Purged", "purged-body", { isPurged: true }),
      note("foreign", "root", "Foreign", "foreign-body", { ownerUid: "other" }),
      note("pending-copy", "root", "Pending", "pending-copy-body", { secureShareCopyState: "copying" }),
      note("root-note", null, "Top", "unselected-body")
    ];
    const before = JSON.stringify({ sources, folders });
    const result = prepareWikiPublication({ rootFolderId: "root", notes: sources, folders });
    expect(result.manifest.folders).toEqual([
      { sourceFolderId: "root", parentSourceFolderId: null, name: "Public" },
      { sourceFolderId: "sub", parentSourceFolderId: "root", name: "Sub" }
    ]);
    expect(result.manifest.entries.map((entry) => entry.sourceNoteId)).toEqual(["home", "child"]);
    expect(result.contents).toEqual([{ sourceNoteId: "home", body: "# Hello" }, { sourceNoteId: "child", body: "content" }]);
    expect(JSON.stringify(result)).not.toMatch(/PrivateAncestor|Confidential|sensitive|ciphertext|wrappedKeys|foreign-body|unselected-body/u);
    expect(JSON.stringify({ sources, folders })).toBe(before);
    expect(result.totalBytes).toBe(new TextEncoder().encode("# Hellocontent").length);
  });

  it("rewrites Wiki, relative Markdown, absolute Markdown and self-fragment references to the public tree", () => {
    const sources = [
      note("home", "root", "Home", [
        "[[PrivateAncestor/Public/Sub/Target#Heading|Visible]]",
        "[Go](Sub/Target.md#^block)",
        "[Absolute](/PrivateAncestor/Public/Sub/Target.md)",
        "[[#Local]]"
      ].join("\n")),
      note("target", "sub", "Target", "[Back](../Home.md)")
    ];
    const result = prepareWikiPublication({ rootFolderId: "root", notes: sources, folders });
    const home = result.contents[0].body;
    expect(home).toContain("[[Public/Sub/Target.md#Heading|Visible]]");
    expect(home).toContain("[Go](<Sub/Target.md#^block>)");
    expect(home).toContain("[Absolute](<Sub/Target.md>)");
    expect(home).toContain("[[Public/Home.md#Local|Home]]");
    expect(result.contents[1].body).toBe("[Back](<../Home.md>)");
    expect(home).not.toContain("PrivateAncestor");
    const paths = new Map([ ["root", "Public"], ["sub", "Public/Sub"] ]);
    const index = buildKnowledgeIndex(sources.map((source, position) => ({
      id: source.id, path: vaultEntryPath(source, paths), kind: source.entryKind, content: result.contents[position].body
    })));
    expect(index.outgoingByEntryId.get("home")?.every((link) => link.status === "resolved")).toBe(true);
    expect(result.redactedLinkCount).toBe(0);
  });

  it("redacts outside, unresolved, ambiguous and omitted-asset targets including their visible labels", () => {
    const sources = [
      note("home", "root", "Home", [
        "[[PrivateAncestor/Confidential/Secret|Highly sensitive title]]",
        "![Sensitive file](../Confidential/file.svg)",
        "[[Missing|Sensitive unresolved title]]",
        "[[Duplicate|Sensitive ambiguous title]]",
        "![[Sub/unsafe.svg|Sensitive SVG title]]"
      ].join("\n")),
      note("secret", "outside", "Secret", "hidden body"),
      note("duplicate-a", "sub", "Duplicate", "A"),
      note("duplicate-b", "outside", "Duplicate", "B"),
      note("svg", "sub", "unsafe.svg", encodeVaultAsset(new Uint8Array(new TextEncoder().encode("<svg></svg>")), "image/svg+xml"), { entryKind: "asset", contentFormat: "asset-v1" })
    ];
    const result = prepareWikiPublication({ rootFolderId: "root", notes: sources, folders });
    expect(result.contents[0].body).toBe("[비공개 링크]\n[비공개 첨부]\n[비공개 링크]\n[비공개 링크]\n[비공개 첨부]");
    expect(result.contents[0].body).not.toMatch(/Sensitive|sensitive|Secret|Missing|Duplicate|Confidential|svg/u);
    expect(result.redactedLinkCount).toBe(5);
    expect(result.omittedEntryCount).toBe(1);
  });

  it("retains Obsidian file links with alias labels and preserves the published target's alias frontmatter", () => {
    const targetBody = "---\naliases: [별칭, Alternate]\n---\n# Target";
    const result = prepareWikiPublication({ rootFolderId: "root", folders, notes: [
      note("home", "root", "Home", "[[Target|별칭]] [[./Sub/Target#Section|Alternate]]"),
      note("target", "sub", "Target", targetBody)
    ] });
    expect(result.contents[0].body).toBe("[[Public/Sub/Target.md|별칭]] [[Public/Sub/Target.md#Section|Alternate]]");
    expect(result.contents[1].body).toBe(targetBody);
    expect(result.redactedLinkCount).toBe(0);
  });

  it("redacts alias labels on outside file links and keeps bare aliases unresolved as in Obsidian", () => {
    const result = prepareWikiPublication({ rootFolderId: "root", folders, notes: [
      note("home", "root", "Home", "[[Secret|민감한 별칭]] [[OutsideAlias]] [[SharedAlias]]"),
      note("target", "sub", "Target", "---\naliases: [SharedAlias]\n---\nPublished"),
      note("secret", "outside", "Secret", "---\naliases: [OutsideAlias, SharedAlias]\n---\nSecret content")
    ] });
    expect(result.contents[0].body).toBe("[비공개 링크] [비공개 링크] [비공개 링크]");
    expect(result.contents[0].body).not.toMatch(/Secret|민감한|OutsideAlias|SharedAlias/u);
    expect(result.redactedLinkCount).toBe(3);
  });

  it("handles parentheses, encoded filenames, reference-style links and multiline destinations", () => {
    const sources = [
      note("home", "root", "Home", [
        "[Nested](Sub/Note(one).md)",
        "[Reference][ref] and [ref]",
        "[Multiline](\nSub/Note%28one%29.md\n)",
        "[Secret][private]",
        "",
        "[ref]: Sub/Note%28one%29.md \"optional title\"",
        "[private]: ../Confidential/Secret.md"
      ].join("\n")),
      note("target", "sub", "Note(one)", "target"),
      note("secret", "outside", "Secret", "hidden")
    ];
    const result = prepareWikiPublication({ rootFolderId: "root", notes: sources, folders });
    expect(result.contents[0].body).toContain("[Nested](<Sub/Note%28one%29.md>)");
    expect(result.contents[0].body).toContain("[Reference](<Sub/Note%28one%29.md>) and [ref](<Sub/Note%28one%29.md>)");
    expect(result.contents[0].body).toContain("[Multiline](<Sub/Note%28one%29.md>)");
    expect(result.contents[0].body).not.toMatch(/Confidential|Secret|\[private\]:/u);
  });

  it("does not hide a private nested link behind an ordinary bracketed phrase or another link label", () => {
    const source = note("home", "root", "Home", "[Aside [[PrivateAncestor/Confidential/Secret|Secret label]]]\n[See [[PrivateAncestor/Confidential/Secret|Hidden title]]](https://example.com)");
    const result = prepareWikiPublication({ rootFolderId: "root", folders, notes: [source, note("secret", "outside", "Secret", "hidden")] });
    expect(result.contents[0].body).not.toMatch(/Confidential|Secret|Hidden title/u);
    expect(result.contents[0].body).toContain("비공개 링크");
    expect(result.redactedLinkCount).toBe(2);
  });

  it("preserves literal code and safe external links, while refusing active external schemes", () => {
    const body = "`[[Literal]]`\n```md\n[[Example]] [sample](../example.md)\n```\n[Docs](https://example.com/path) [Bad](javascript:alert(1))";
    const result = prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("home", "root", "Home", body)] });
    expect(result.contents[0].body).toContain("`[[Literal]]`\n```md\n[[Example]] [sample](../example.md)\n```");
    expect(result.contents[0].body).toContain("[Docs](<https://example.com/path>) [비공개 링크]");
    expect(result.contents[0].body).not.toContain("javascript:");
  });

  it("publishes only signature-checked raster payloads and removes unknown asset metadata", () => {
    const encoded = JSON.parse(encodeVaultAsset(validPng(), "image/png"));
    const sources = [
      note("home", "root", "Home", "![[PrivateAncestor/Public/Sub/picture.png|Picture]]"),
      note("image", "sub", "picture.png", JSON.stringify({ ...encoded, ownerUid: "private-owner", privatePath: "private-parent" }), { entryKind: "asset", contentFormat: "asset-v1" }),
      note("mismatch", "sub", "wrong.png", encodeVaultAsset(new Uint8Array(new TextEncoder().encode("<html>unsafe</html>")), "image/png"), { entryKind: "asset", contentFormat: "asset-v1" }),
      note("canvas", "sub", "Board", "{}", { entryKind: "canvas", contentFormat: "json-canvas-v1" })
    ];
    const result = prepareWikiPublication({ rootFolderId: "root", folders, notes: sources });
    expect(result.manifest.entries.map((entry) => entry.sourceNoteId)).toEqual(["home", "image"]);
    expect(result.contents[0].body).toBe("![[Public/Sub/picture.png|Picture]]");
    expect(decodeVaultAsset(result.contents[1].body).bytes).toEqual(validPng());
    expect(result.contents[1].body).not.toMatch(/ownerUid|privatePath|private-owner|private-parent/u);
    expect(result.omittedEntryCount).toBe(2);
  });

  it("sanitizes legacy HTML and strips attribution IDs and private anchor labels from its public copy", () => {
    const body = '<p data-author-uid="private-user" id="private-block">Visible <a href="/app?entry=private-note">Secret label</a> <a href="https://example.com">Docs</a></p><script>alert(1)</script>';
    const result = prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("legacy", "root", "Legacy", body, { entryKind: "legacy-html", contentFormat: "legacy-html-v1" })] });
    expect(result.contents[0].body).not.toMatch(/private-|Secret|script|data-author/u);
    expect(result.contents[0].body).toContain('rel="noopener noreferrer"');
    expect(result.contents[0].body).toContain("[비공개 링크]");
  });

  it("rejects hidden roots, cycles, collisions, invalid names and incomplete authority", () => {
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders: folders.map((item) => item.id === "private-parent" ? { ...item, isDeleted: true } : item), notes: [] })).toThrow();
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders: [folder("root", "Root", "cycle"), folder("cycle", "Cycle", "root")], notes: [] })).toThrow();
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("a", "root", "Same", "a"), note("b", "root", "same.md", "b")] })).toThrow(/이름/u);
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders: [...folders, folder("sub-duplicate", "sub", "root")], notes: [] })).toThrow(/이름/u);
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("a", "root", "../bad", "a")] })).toThrow();
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("a", "root", "A", "a", { participantUids: [] })] })).toThrow(/권한/u);
  });

  it("enforces UTF-8 text, count, expiry and parser-work limits before returning a publishable copy", () => {
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("huge", "root", "Huge", "가".repeat(PUBLISHED_WIKI_LIMITS.textBytes / 2))] })).toThrow(/크기/u);
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: Array.from({ length: 201 }, (_, index) => note(`n${index}`, "root", `Note${index}`, "small")) })).toThrow(/메모/u);
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: [], expiresAt: "2000-01-01T00:00:00Z" })).toThrow(/만료일/u);
    const start = performance.now();
    expect(() => prepareWikiPublication({ rootFolderId: "root", folders, notes: [note("brackets", "root", "Brackets", "[".repeat(100_000))] })).toThrow(/복잡/u);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
