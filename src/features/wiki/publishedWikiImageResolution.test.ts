import { beforeEach, describe, expect, it, vi } from "vitest";
import { tokenizeMarkdown } from "../markdown/parser";
import type { MarkdownLinkReference } from "../markdown/types";
import { encodeVaultAsset } from "../vault/vaultAsset";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../vault/vaultData";
import { prepareWikiPublication } from "./prepareWikiPublication";
import { PublishedWikiAssetReader } from "./publishedWikiAssetReader";
import type { PublishedWikiEntry, PublishedWikiManifest } from "./publishedWikiTypes";
import type { WikiReadableNote } from "./wikiModel";
import { WikiPublicProjection } from "./wikiPublicProjection";

const getAsset = vi.hoisted(() => vi.fn());
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiAsset: getAsset }));
const filename = "QuickMemo QA F 20260905 -1.png";
const encodedFilename = encodeURIComponent(filename);
const source: WikiReadableNote = { id: "public-note", folderId: "public-folder", title: "QuickMemo QA F 20260905", body: "", entryKind: "markdown", contentFormat: "markdown-v1" };
const sourceEntry: PublishedWikiEntry = { id: source.id, title: source.title, folderId: source.folderId ?? null, path: `QuickMemo QA 20260905/${source.title}.md`, kind: "markdown" };
const image: PublishedWikiEntry = { id: "public-image", title: filename, path: filename, folderId: null, kind: "asset" };
const publicFolders = [{ id: "public-folder", displayName: "QuickMemo QA 20260905", parentId: null }];
function manifest(entries: PublishedWikiEntry[] = [sourceEntry, image]): PublishedWikiManifest {
  return { wikiId: "public-wiki", revision: 10, title: "QA", updatedAt: "2026-09-05", expiresAt: null,
    folders: publicFolders.map(({ id, displayName, parentId }) => ({ id, name: displayName, parentId, path: displayName })), entries };
}
function pngBody() {
  const bytes = new Uint8Array(57); const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12); view.setUint32(16, 1); view.setUint32(20, 1); bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set(new TextEncoder().encode("IDAT"), 37); bytes.set(new TextEncoder().encode("IEND"), 49);
  return encodeVaultAsset(bytes, "image/png");
}
function project(body: string, entries: PublishedWikiEntry[] = [sourceEntry, image], projection = new WikiPublicProjection()) {
  return projection.project([{ ...source, body }], publicFolders, entries)[0].body;
}
function reference(path: string): MarkdownLinkReference {
  return { kind: "wikilink", path, target: path, raw: `![[${path}]]`, display: filename, embed: true, subpath: null };
}
function parsedEmbed(body: string) {
  const tokens = tokenizeMarkdown(body).blocks.flatMap((block) => block.type === "paragraph" ? block.children : []);
  const embeds = tokens.filter((token) => token.type === "wikilink" && token.embed);
  expect(embeds).toHaveLength(1);
  const token = embeds[0];
  if (token.type !== "wikilink") throw new Error("Expected a public image embed.");
  return { ...token, kind: "wikilink" as const };
}
beforeEach(() => getAsset.mockReset());

describe("public projection and image resolution share the exact published catalog", () => {
  it("reads an existing bare canonical root PNG from a nested note without republishing", async () => {
    const original = `![[${encodedFilename}|${filename}]]\n\n# F`;
    const projected = project(original);
    expect(projected).toBe(original);
    const reader = new PublishedWikiAssetReader(manifest(), new AbortController().signal);
    const selected = reader.resolve(parsedEmbed(projected), sourceEntry);
    expect(selected).toEqual(image);
    expect(getAsset).not.toHaveBeenCalled();
    getAsset.mockResolvedValue({ ...image, body: pngBody() });
    expect((await reader.load(selected!.id, new AbortController().signal)).mimeType).toBe("image/png");
    expect(getAsset).toHaveBeenCalledExactlyOnceWith("public-wiki", image.id, 10, expect.any(AbortSignal));
    reader.dispose();
  });

  it("prepares a nested folder grant plus one individually selected PNG as a root-absolute embed", () => {
    const folders: DecryptedVaultFolder[] = [
      { id: "private", displayName: "개인", parentId: null, name: "encrypted", ownerUid: "owner", color: "#123456" },
      { id: "selected", displayName: "QuickMemo QA 20260905", parentId: "private", name: "encrypted", ownerUid: "owner", color: "#123456" },
      { id: "images", displayName: "붙여넣은 이미지", parentId: null, name: "encrypted", ownerUid: "owner", color: "#123456" }
    ];
    const envelope = { version: 1 as const, algorithm: "AES-GCM" as const, cipherText: "fixture", iv: "fixture" };
    const base = { ownerUid: "owner", type: "personal" as const, participantUids: ["owner"], revision: 4, updatedBy: "owner", encryptedBody: envelope, encryptedTitle: envelope, wrappedKeys: {} };
    const notes: DecryptedVaultNote[] = [
      { ...base, id: "original-note", title: source.title, folderId: "selected", entryKind: "markdown", contentFormat: "markdown-v1",
        body: `![[붙여넣은 이미지/${filename}]]\n\n![[붙여넣은 이미지/private.png]]\n\n# F` },
      { ...base, id: "original-image", title: filename, folderId: "images", entryKind: "asset", contentFormat: "asset-v1", body: pngBody() },
      { ...base, id: "unselected-image", title: "private.png", folderId: "images", entryKind: "asset", contentFormat: "asset-v1", body: pngBody() }
    ];
    const before = JSON.stringify({ notes, folders });
    const prepared = prepareWikiPublication({ rootFolderId: null, ownerUid: "owner", folders, notes, selection: { folderIds: ["selected"], noteIds: ["original-image"] } });
    expect(prepared.manifest.folders).toEqual([{ sourceFolderId: "selected", parentSourceFolderId: null, name: "QuickMemo QA 20260905" }]);
    expect(prepared.manifest.entries).toEqual([
      expect.objectContaining({ sourceNoteId: "original-note", parentSourceFolderId: "selected", kind: "markdown" }),
      expect.objectContaining({ sourceNoteId: "original-image", parentSourceFolderId: null, kind: "asset" })
    ]);
    const body = prepared.contents[0].body;
    expect(body).toBe(`![[/${encodedFilename}|${filename}]]\n\n[비공개 첨부]\n\n# F`);
    expect(body).not.toMatch(/개인|붙여넣은 이미지|private.png/);
    expect(project(body)).toBe(body);
    const reader = new PublishedWikiAssetReader(manifest(), new AbortController().signal);
    expect(reader.resolve(parsedEmbed(project(body)), sourceEntry)).toEqual(image);
    expect(JSON.stringify({ notes, folders })).toBe(before);
    expect(getAsset).not.toHaveBeenCalled(); reader.dispose();
  });

  it("preserves relative same-name resolution and lets explicit root links select the root PNG", () => {
    const relative = { ...image, id: "relative-image", folderId: source.folderId ?? null, path: `QuickMemo QA 20260905/${filename}` };
    const entries = [sourceEntry, image, relative];
    const reader = new PublishedWikiAssetReader(manifest(entries), new AbortController().signal);
    expect(reader.resolve(parsedEmbed(project(`![[${encodedFilename}]]`, entries)), sourceEntry)).toEqual(relative);
    expect(reader.resolve(parsedEmbed(project(`![[/${encodedFilename}]]`, entries)), sourceEntry)).toEqual(image);
    reader.dispose();
  });

  it("never guesses a root entry when the normal relative path is ambiguous", () => {
    const relative = { ...image, id: "relative-one", folderId: source.folderId ?? null, path: `QuickMemo QA 20260905/${filename}` };
    const entries = [sourceEntry, image, relative, { ...relative, id: "relative-two" }];
    const reader = new PublishedWikiAssetReader(manifest(entries), new AbortController().signal);
    expect(project(`![[${encodedFilename}|hidden label]]`, entries)).toBe("[비공개 첨부]");
    expect(reader.resolve(reference(encodedFilename), sourceEntry)).toBeNull(); reader.dispose();
  });

  it("clears the projected embed when its exact selected asset is removed and refuses nonselected IDs", async () => {
    const projection = new WikiPublicProjection(); const original = `![[${encodedFilename}|hidden label]]`;
    expect(project(original, [sourceEntry, image], projection)).toBe(original);
    expect(project(original, [sourceEntry], projection)).toBe("[비공개 첨부]");
    const reader = new PublishedWikiAssetReader(manifest([sourceEntry]), new AbortController().signal);
    expect(reader.resolve(reference(encodedFilename), sourceEntry)).toBeNull();
    await expect(reader.load("original-image", new AbortController().signal)).rejects.toThrow("outside the public scope");
    await expect(reader.load(image.id, new AbortController().signal)).rejects.toThrow("outside the public scope");
    expect(getAsset).not.toHaveBeenCalled(); reader.dispose();
  });

  it("does not fall back for Markdown-relative links, partial filenames, or duplicate root paths", () => {
    const reader = new PublishedWikiAssetReader(manifest(), new AbortController().signal);
    expect(reader.resolve({ ...reference(encodedFilename), kind: "markdown-internal" }, sourceEntry)).toBeNull();
    expect(reader.resolve(reference(encodedFilename.replace(/\.png$/, "")), sourceEntry)).toBeNull(); reader.dispose();
    const entries = [sourceEntry, image, { ...image, id: "duplicate-root" }];
    const duplicate = new PublishedWikiAssetReader(manifest(entries), new AbortController().signal);
    expect(project(`![[${encodedFilename}]]`, entries)).toBe("[비공개 첨부]");
    expect(duplicate.resolve(reference(encodedFilename), sourceEntry)).toBeNull(); duplicate.dispose();
  });

  it.each(["javascript%3Aalert.png", "https%3Aevil.png", "%2F%2Fevil.png", "%5C%5Cevil.png"])("does not turn encoded external target %s into a published file", (target) => {
    const decoded = decodeURIComponent(target).replace(/\\/g, "/").replace(/^\/+/, "");
    const entries = [sourceEntry, { ...image, path: decoded, title: decoded },
      { ...image, id: "relative-unsafe", path: `QuickMemo QA 20260905/${decoded}`, folderId: source.folderId ?? null, title: decoded }];
    const reader = new PublishedWikiAssetReader(manifest(entries), new AbortController().signal);
    expect(project(`![[${target}|hidden label]]`, entries)).toBe("[비공개 첨부]");
    expect(reader.resolve(reference(target), sourceEntry)).toBeNull();
    expect(getAsset).not.toHaveBeenCalled(); reader.dispose();
  });
});
