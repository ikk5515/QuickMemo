import { sanitizeEditorHtml } from "../../lib/editorContent";
import { buildInternalLinkResolutionIndex, resolveInternalLink, vaultDirectory } from "../knowledge/path";
import type { InternalLinkOccurrence, VaultIndexEntry } from "../knowledge/types";
import { canonicalSafeExternalHttpUrl } from "../markdown/parser";
import { normalizeVaultPath } from "../vault/interop/path";
import { decodeVaultAsset, encodeVaultAsset, safeVaultAssetPreviewKind } from "../vault/vaultAsset";
import { vaultEntryPath, type DecryptedVaultFolder, type DecryptedVaultNote } from "../vault/vaultData";
import { PUBLISHED_WIKI_LIMITS, type PreparedWikiPublication, type WikiPublicationEntryInput } from "./publishedWikiTypes";
import { rewritePublicationMarkdownLinks, type RewritePublicationMarkdownLink } from "./publicationMarkdown";

interface PrepareWikiPublicationInput {
  rootFolderId: string;
  notes: readonly DecryptedVaultNote[];
  folders: readonly DecryptedVaultFolder[];
  title?: string;
  expiresAt?: string | null;
}

const utf8 = new TextEncoder();
const scheme = /^[a-z][a-z\d+.-]*:/iu;
const emptyMetadata = new Map<string, { aliases: string[] }>();
const maximumFolderDepth = 32;

function safeName(value: string) {
  const name = value.trim().normalize("NFC");
  if (!name || utf8.encode(name).length > 512 || name.includes("/") || name.includes("\\")) {
    throw new Error("공개할 폴더 또는 파일 이름을 확인해 주세요.");
  }
  normalizeVaultPath(name);
  return name;
}

function uniqueById<T extends { id: string }>(items: readonly T[]) {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) throw new Error("목록을 새로 불러온 뒤 공개 설정을 다시 열어 주세요.");
    result.set(item.id, item);
  }
  return result;
}

function activeFolderPath(folderId: string, folders: ReadonlyMap<string, DecryptedVaultFolder>) {
  const parts: string[] = [];
  const seen = new Set<string>();
  const owner = folders.get(folderId)?.ownerUid;
  let current: string | null = folderId;
  while (current) {
    const folder = folders.get(current);
    if (!folder || folder.isDeleted || folder.nameDecryptionFailed || folder.ownerUid !== owner
      || seen.has(current) || seen.size > maximumFolderDepth) return null;
    seen.add(current);
    parts.push(folder.displayName);
    current = folder.parentId ?? null;
  }
  return parts.reverse().join("/");
}

function encodedPath(path: string) {
  return path.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

function relativePath(source: string, target: string) {
  const from = vaultDirectory(source).split("/");
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

function escapedLabel(label: string) {
  return label.replace(/[\\[\]|]/gu, "\\$&").replace(/[\r\n]/gu, " ");
}


export function prepareWikiPublication({ rootFolderId, notes, folders, title, expiresAt = null }: PrepareWikiPublicationInput): PreparedWikiPublication {
  const foldersById = uniqueById(folders);
  uniqueById(notes);
  const root = foldersById.get(rootFolderId);
  if (!root || !root.ownerUid || !activeFolderPath(rootFolderId, foldersById)) throw new Error("공개할 폴더를 다시 확인해 주세요.");
  const titleValue = safeName(title ?? root.displayName);
  if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()
    || Date.parse(expiresAt) > Date.now() + 366 * 86_400_000)) throw new Error("공개 만료일을 확인해 주세요.");
  const children = new Map<string, DecryptedVaultFolder[]>();
  for (const folder of folders) {
    if (folder.ownerUid !== root.ownerUid || folder.isDeleted || folder.nameDecryptionFailed || !folder.parentId) continue;
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  const selected = [root];
  const folderPaths = new Map<string, string>();
  const folderPathKeys = new Set<string>();
  for (let index = 0; index < selected.length; index += 1) {
    if (selected.length > PUBLISHED_WIKI_LIMITS.folders) throw new Error("한 번에 공개할 수 있는 폴더 수를 초과했습니다.");
    const folder = selected[index];
    const name = safeName(folder.displayName);
    const path = folder.id === rootFolderId ? name : `${folderPaths.get(folder.parentId!)}/${name}`;
    const pathKey = normalizeVaultPath(path).toLocaleLowerCase("en-US");
    if (folderPathKeys.has(pathKey)) throw new Error("공개 범위에 이름이 같은 폴더가 있습니다. 이름을 확인해 주세요.");
    folderPathKeys.add(pathKey);
    if (folderPaths.has(folder.id)) throw new Error("폴더 구조를 다시 확인해 주세요.");
    folderPaths.set(folder.id, path);
    selected.push(...(children.get(folder.id) ?? []));
  }
  const privateFolderPaths = new Map<string, string>();
  for (const folder of folders) {
    const path = activeFolderPath(folder.id, foldersById);
    if (path) privateFolderPaths.set(folder.id, path);
  }
  const currentNotes = notes.filter((note) => !note.isDeleted && !note.isPurged
    && (!note.secureShareCopyState || note.secureShareCopyState === "active")
    && (!note.folderId || privateFolderPaths.has(note.folderId)));
  const sourceEntries: VaultIndexEntry[] = currentNotes.map((note) => ({
    id: note.id, kind: note.entryKind, path: vaultEntryPath(note, privateFolderPaths)
  }));
  const sourceById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  const resolutionIndex = buildInternalLinkResolutionIndex(sourceEntries, emptyMetadata);
  const prepared = new Map<string, { note: DecryptedVaultNote; metadata: WikiPublicationEntryInput; path: string; body: string }>();
  const publicPaths = new Set<string>();
  let omittedEntryCount = 0;
  let noteCount = 0;
  let assetCount = 0;
  for (const note of currentNotes) {
    if (note.ownerUid !== root.ownerUid || !note.folderId || !folderPaths.has(note.folderId)) continue;
    if (note.entryKind !== "markdown" && note.entryKind !== "legacy-html" && note.entryKind !== "asset") { omittedEntryCount += 1; continue; }
    if (!note.participantUids.includes(root.ownerUid)
      || note.contentFormat !== (note.entryKind === "asset" ? "asset-v1" : note.entryKind === "markdown" ? "markdown-v1" : "legacy-html-v1")) {
      throw new Error("공개할 메모의 권한과 저장 형식을 다시 확인해 주세요.");
    }
    let body = note.body;
    if (note.entryKind === "asset") {
      try {
        const asset = decodeVaultAsset(body);
        if (safeVaultAssetPreviewKind(asset) !== "image") { omittedEntryCount += 1; continue; }
        body = encodeVaultAsset(asset.bytes, asset.mimeType);
      } catch { omittedEntryCount += 1; continue; }
      assetCount += 1;
    } else noteCount += 1;
    if (noteCount > PUBLISHED_WIKI_LIMITS.notes || assetCount > PUBLISHED_WIKI_LIMITS.assets) throw new Error("한 번에 공개할 수 있는 메모 또는 이미지 수를 초과했습니다.");
    const noteTitle = safeName(note.title);
    const path = vaultEntryPath({ ...note, title: noteTitle }, folderPaths);
    const pathKey = normalizeVaultPath(path).toLocaleLowerCase("en-US");
    if (publicPaths.has(pathKey)) throw new Error("공개 범위에 이름이 같은 파일이 있습니다. 이름을 확인해 주세요.");
    publicPaths.add(pathKey);
    if (utf8.encode(body).length > (note.entryKind === "asset" ? PUBLISHED_WIKI_LIMITS.assetBytes : PUBLISHED_WIKI_LIMITS.textBytes)) throw new Error("공개할 메모 또는 이미지의 크기 제한을 초과했습니다.");
    if (!Number.isSafeInteger(note.revision ?? 0) || (note.revision ?? 0) < 0) throw new Error("최신 저장 내용을 확인한 뒤 다시 공개해 주세요.");
    prepared.set(note.id, { note, path, body, metadata: {
      sourceNoteId: note.id, sourceRevision: note.revision ?? 0, sourceFolderId: note.folderId,
      title: noteTitle, kind: note.entryKind
    } });
  }
  let redactedLinkCount = 0;
  let totalBytes = 0;
  const contents = [...prepared.values()].map(({ note, path, body }) => {
    let labelDepth = 0;
    const rewriteLink: RewritePublicationMarkdownLink = ({ target, label, embed, syntax }) => {
      const redact = () => { redactedLinkCount += 1; return embed ? "[비공개 첨부]" : "[비공개 링크]"; };
      let visibleLabel = label;
      if (label.includes("[")) {
        if (labelDepth >= 16) throw new Error("링크 표시 이름이 복잡해 공개할 내용을 안전하게 확인하지 못했습니다.");
        labelDepth += 1;
        try { visibleLabel = rewritePublicationMarkdownLinks(label, rewriteLink); }
        finally { labelDepth -= 1; }
      }
      if (scheme.test(target) || target.startsWith("//")) {
        const href = canonicalSafeExternalHttpUrl(target);
        return href ? `${embed ? "!" : ""}[${escapedLabel(visibleLabel || href)}](<${href}>)` : redact();
      }
      const hash = target.indexOf("#");
      const fragment = hash < 0 ? "" : target.slice(hash + 1);
      const targetPath = hash < 0 ? target : target.slice(0, hash);
      const occurrence: InternalLinkOccurrence = {
        sourceEntryId: note.id, sourcePath: sourceById.get(note.id)!.path,
        syntax: targetPath.startsWith("/") ? "wikilink" : syntax,
        raw: "", target: targetPath, displayText: label, embedded: embed, line: 0, column: 0, context: "",
        ...(fragment ? { fragment: { kind: fragment.startsWith("^") ? "block" as const : "heading" as const, value: fragment.replace(/^\^/u, "") } } : {})
      };
      const resolved = resolveInternalLink(occurrence, sourceEntries, emptyMetadata, resolutionIndex);
      const published = resolved.status === "resolved" && resolved.targetEntryId ? prepared.get(resolved.targetEntryId) : undefined;
      if (!published || resolved.candidateEntryIds.length > 1) return redact();
      const display = escapedLabel(visibleLabel || published.metadata.title.replace(/\.md$/iu, ""));
      const suffix = fragment ? `#${fragment.startsWith("^") ? "^" : ""}${encodeURIComponent(fragment.replace(/^\^/u, ""))}` : "";
      return syntax === "wikilink"
        ? `${embed ? "!" : ""}[[${encodedPath(published.path)}${suffix}|${display}]]`
        : `${embed ? "!" : ""}[${display}](<${encodedPath(relativePath(path, published.path))}${suffix}>)`;
    };
    let publicBody = body;
    if (note.entryKind === "markdown") publicBody = rewritePublicationMarkdownLinks(body, rewriteLink);
    else if (note.entryKind === "legacy-html") {
      if (typeof document === "undefined") throw new Error("이전 형식의 메모는 브라우저에서 공개할 수 있습니다.");
      const template = document.createElement("template");
      template.innerHTML = body;
      for (const element of template.content.querySelectorAll("*")) {
        if (element.tagName === "A" && !canonicalSafeExternalHttpUrl(element.getAttribute("href") ?? "")) {
          element.replaceWith(document.createTextNode("[비공개 링크]"));
          redactedLinkCount += 1;
          continue;
        }
        for (const attribute of [...element.attributes]) {
          if (attribute.name.startsWith("data-") || attribute.name === "id") element.removeAttribute(attribute.name);
        }
      }
      const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
      let textNode: Node | null;
      while ((textNode = walker.nextNode())) textNode.textContent = rewritePublicationMarkdownLinks(textNode.textContent ?? "", rewriteLink);
      publicBody = sanitizeEditorHtml(template.innerHTML);
    }
    const bytes = utf8.encode(publicBody).length;
    if (bytes > (note.entryKind === "asset" ? PUBLISHED_WIKI_LIMITS.assetBytes : PUBLISHED_WIKI_LIMITS.textBytes)) throw new Error("링크를 정리한 메모가 공개 크기 제한을 초과했습니다.");
    totalBytes += bytes;
    if (totalBytes > PUBLISHED_WIKI_LIMITS.totalBytes) throw new Error("한 번에 공개할 수 있는 전체 크기를 초과했습니다.");
    return { sourceNoteId: note.id, body: publicBody };
  });
  return {
    manifest: {
      rootFolderId, title: titleValue, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      folders: selected.map((folder) => ({ sourceFolderId: folder.id, parentSourceFolderId: folder.id === rootFolderId ? null : folder.parentId!, name: safeName(folder.displayName) })),
      entries: [...prepared.values()].map((entry) => entry.metadata)
    },
    contents, omittedEntryCount, redactedLinkCount, totalBytes
  };
}
