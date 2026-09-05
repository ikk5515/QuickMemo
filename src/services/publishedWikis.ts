import { getToken } from "firebase/app-check";
import { appCheck, auth } from "../lib/firebase";
import {
  PUBLISHED_WIKI_LIMITS as limits, normalizeWikiSlug, isValidWikiSlug,
  type PreparedWikiPublication, type PublishedWikiContent, type PublishedWikiContentPage,
  type PublishedWikiEntry, type PublishedWikiFolder, type PublishedWikiManifest,
  type PublishedWikiOwnerStatus, type WikiPublicationInput, type WikiPublicationSelection, type WikiPublicationContentInput, type WikiPublicationStage
} from "../features/wiki/publishedWikiTypes";

const apiPath = "/api/published-wikis";
const encoder = new TextEncoder();
const wikiPattern = /^pw1_[A-Za-z0-9_-]{32}$/u;
const entryPattern = /^e_[0-9a-f]{32}$/u;
const folderPattern = /^f_[0-9a-f]{32}$/u;
interface Options { signal?: AbortSignal; expectedUid?: string }
interface PublishOptions extends Options { onProgress?: (completed: number, total: number) => void }
const errorMessages: Record<string, string> = {
  invalid_slug: "위키 주소는 3~40자의 영문, 숫자, 하이픈으로 입력해 주세요.",
  reserved_slug: "이 주소는 사용할 수 없습니다.",
  slug_taken: "이미 사용 중인 위키 주소입니다.",
  slug_required: "먼저 사용할 위키 주소를 정해 주세요.",
  workspace_exists: "이미 연결된 위키가 있습니다. 기존 내용을 선택해 추가해 주세요.",
  service_unavailable: "위키에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  not_found: "공개가 중지되었거나 사용할 수 없는 위키입니다.",
  source_changed: "메모가 변경되었습니다. 내용을 다시 확인해 주세요.",
  publication_changed: "공개 내용이 변경되었습니다. 새로 확인한 뒤 다시 시도해 주세요.",
  publication_incomplete: "일부 내용을 게시하지 못했습니다. 다시 시도해 주세요.",
  publication_expired: "공개 기간이 만료되었습니다. 기간을 다시 설정해 주세요.",
  rate_limited: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  invalid_response: "위키에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  unauthorized: "로그인한 뒤 다시 시도해 주세요.",
  permission_denied: "공개 권한이 없습니다. 로그인 상태를 확인해 주세요.",
  publication_scope_denied: "선택한 폴더의 내용만 공개할 수 있습니다.",
  publication_too_large: "공개할 내용이 한도를 넘었습니다. 더 작은 폴더를 선택해 주세요."
};
export class PublishedWikiError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(errorMessages[code] ?? "위키 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."); this.name = "PublishedWikiError"; }
}
function aborted() { return new DOMException("게시 요청이 취소되었습니다.", "AbortError"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublishedWikiError("invalid_response", 502);
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length > maximum) throw new PublishedWikiError("invalid_response", 502);
  return value;
}
function numeric(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PublishedWikiError("invalid_response", 502);
  return value as number;
}
function nullableString(value: unknown) { return value === null ? null : string(value); }
function matched(value: unknown, pattern: RegExp) {
  const result = string(value); if (!pattern.test(result)) throw new PublishedWikiError("invalid_response", 502); return result;
}
function parseSelection(value: unknown): WikiPublicationSelection {
  const row = record(value);
  const ids = (value: unknown, maximum: number) => list(value, maximum, (id) => matched(id, /^[A-Za-z0-9_-]{1,128}$/u));
  const folderIds = ids(row.folderIds, limits.folders); const noteIds = ids(row.noteIds, limits.notes + limits.assets);
  if (new Set(folderIds).size !== folderIds.length || new Set(noteIds).size !== noteIds.length) throw new PublishedWikiError("invalid_response", 502);
  return { folderIds, noteIds };
}
function parseOwnerManifest(value: unknown): WikiPublicationInput | null {
  if (value === null || value === undefined) return null;
  const row = record(value); const sourceId = (id: unknown) => matched(id, /^[A-Za-z0-9_-]{1,128}$/u);
  return { rootFolderId: row.rootFolderId === null ? null : sourceId(row.rootFolderId),
    ...(row.selection === undefined ? {} : { selection: parseSelection(row.selection) }), title: string(row.title), expiresAt: nullableString(row.expiresAt),
    folders: list(row.folders, limits.folders, (value) => { const folder = record(value); return { sourceFolderId: sourceId(folder.sourceFolderId), parentSourceFolderId: folder.parentSourceFolderId === null ? null : sourceId(folder.parentSourceFolderId), name: string(folder.name) }; }),
    entries: list(row.entries, limits.notes + limits.assets, (value) => { const entry = record(value);
      if (!["markdown", "legacy-html", "asset"].includes(String(entry.kind))) throw new PublishedWikiError("invalid_response", 502);
      return { sourceNoteId: sourceId(entry.sourceNoteId), sourceFolderId: entry.sourceFolderId === null ? null : sourceId(entry.sourceFolderId), sourceRevision: numeric(entry.sourceRevision),
        ...(entry.parentSourceFolderId === undefined ? {} : { parentSourceFolderId: entry.parentSourceFolderId === null ? null : sourceId(entry.parentSourceFolderId) }), title: string(entry.title), kind: entry.kind as "markdown" | "legacy-html" | "asset" }; }) };
}
function parsedSlug(value: unknown) {
  if (value === undefined || value === null) return null;
  const slug = string(value, 40); if (!isValidWikiSlug(slug)) throw new PublishedWikiError("invalid_response", 502); return slug;
}
function parseStatus(value: unknown): PublishedWikiOwnerStatus {
  const row = record(value);
  if (typeof row.published !== "boolean") throw new PublishedWikiError("invalid_response", 502);
  return { wikiId: row.wikiId === null ? null : matched(row.wikiId, wikiPattern), slug: parsedSlug(row.slug),
    selection: row.selection === undefined ? { folderIds: [], noteIds: [] } : parseSelection(row.selection), manifest: parseOwnerManifest(row.manifest),
    legacyHasMore: row.legacyHasMore === true,
    legacyPublications: row.legacyPublications === undefined ? [] : list(row.legacyPublications, 20, (value) => {
      const site = record(value); if (typeof site.published !== "boolean") throw new PublishedWikiError("invalid_response", 502);
      return { wikiId: matched(site.wikiId, wikiPattern), rootFolderId: string(site.rootFolderId, 128), title: string(site.title), published: site.published, revision: numeric(site.revision) };
    }), revision: numeric(row.revision), published: row.published,
    title: string(row.title), expiresAt: nullableString(row.expiresAt), updatedAt: nullableString(row.updatedAt), noteCount: numeric(row.noteCount), assetCount: numeric(row.assetCount) };
}
function parseEntry(value: unknown): PublishedWikiEntry {
  const row = record(value);
  if (!["markdown", "legacy-html", "asset"].includes(String(row.kind))) throw new PublishedWikiError("invalid_response", 502);
  return { id: matched(row.id, entryPattern), folderId: row.folderId === null ? null : matched(row.folderId, folderPattern), title: string(row.title), path: string(row.path, 32 * 512), kind: row.kind as PublishedWikiEntry["kind"] };
}
function list<T>(value: unknown, maximum: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new PublishedWikiError("invalid_response", 502);
  return value.map(parse);
}
function parseManifest(value: unknown): PublishedWikiManifest {
  const row = record(value);
  const folders = list(row.folders, limits.folders, (value): PublishedWikiFolder => {
    const folder = record(value); return { id: matched(folder.id, folderPattern), parentId: folder.parentId === null ? null : matched(folder.parentId, folderPattern), name: string(folder.name), path: string(folder.path, 32 * 512) };
  });
  const entries = list(row.entries, limits.notes + limits.assets, parseEntry);
  const folderIds = new Set(folders.map((folder) => folder.id));
  if (folderIds.size !== folders.length || new Set(entries.map((entry) => entry.id)).size !== entries.length
    || entries.some((entry) => entry.folderId !== null && !folderIds.has(entry.folderId)) || folders.some((folder) => folder.parentId !== null && !folderIds.has(folder.parentId))) throw new PublishedWikiError("invalid_response", 502);
  return { wikiId: matched(row.wikiId, wikiPattern), slug: parsedSlug(row.slug), revision: numeric(row.revision), title: string(row.title), expiresAt: nullableString(row.expiresAt), updatedAt: string(row.updatedAt), folders, entries };
}
function parseContentPage(value: unknown, ids: string[], revision: number, asset: boolean): PublishedWikiContentPage {
  const row = record(value);
  const entries = list(row.entries, asset ? 1 : limits.contentPageSize, (value): PublishedWikiContent => {
    const entry = parseEntry(value); const body = string(record(value).body, asset ? limits.assetBytes : limits.textBytes);
    if ((entry.kind === "asset") !== asset || encoder.encode(body).byteLength > (asset ? limits.assetBytes : limits.textBytes)) throw new PublishedWikiError("invalid_response", 502);
    return { ...entry, body };
  });
  if (numeric(row.revision) !== revision || entries.length !== ids.length || new Set(entries.map((entry) => entry.id)).size !== ids.length
    || entries.some((entry) => !ids.includes(entry.id))) throw new PublishedWikiError("publication_changed", 409);
  return { revision, entries };
}
function ownerGuard(options: Options) {
  const user = auth.currentUser; const uid = user?.uid;
  if (!uid || (options.expectedUid !== undefined && options.expectedUid !== uid)) throw aborted();
  const check = () => { if (options.signal?.aborted || auth.currentUser?.uid !== uid) throw aborted(); };
  check(); return { user, uid, check };
}
async function request(bodyOrQuery: Record<string, unknown>, options: Options, owner: boolean): Promise<unknown> {
  const guard = owner ? ownerGuard(options) : null;
  const check = () => { if (options.signal?.aborted) throw aborted(); guard?.check(); };
  check();
  const headers: Record<string, string> = { "x-quickmemo-published-wiki": "1" };
  if (guard) { headers.authorization = `Bearer ${await guard.user!.getIdToken()}`; check(); }
  if (appCheck) { headers["X-Firebase-AppCheck"] = (await getToken(appCheck, false)).token; check(); }
  const query = new URLSearchParams(Object.entries(bodyOrQuery).map(([key, value]) => [key, String(value)]));
  if (owner) headers["content-type"] = "application/json";
  const response = await fetch(owner ? apiPath : `${apiPath}?${query}`, { method: owner ? "POST" : "GET", headers,
    ...(owner ? { body: JSON.stringify(bodyOrQuery) } : {}), credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: options.signal });
  check();
  const text = await response.text(); check();
  if (text.length > 2 * limits.chunkBytes + 64 * 1024) throw new PublishedWikiError("invalid_response", 502);
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new PublishedWikiError("invalid_response", 502); }
  if (!response.ok) throw new PublishedWikiError(typeof record(data).error === "string" ? String(record(data).error) : "request_failed", response.status);
  return data;
}
export async function getPublishedWikiOwnerStatus(rootFolderId: string | null, options: Options = {}) {
  return parseStatus(await request({ action: "status", rootFolderId }, options, true));
}
export async function unpublishWiki(rootFolderId: string | null, expectedRevision: number, options: Options = {}) {
  return parseStatus(await request({ action: "unpublish", rootFolderId, expectedRevision }, options, true));
}
export async function getPublishedWikiWorkspaceStatus(options: Options = {}) {
  return parseStatus(await request({ action: "owner-status" }, options, true));
}
export async function checkPublishedWikiSlugAvailability(input: string, options: Options = {}) {
  const slug = normalizeWikiSlug(input);
  if (!isValidWikiSlug(slug)) throw new PublishedWikiError("invalid_slug", 400);
  const row = record(await request({ action: "slug-availability", slug }, options, true));
  if (parsedSlug(row.slug) !== slug || typeof row.available !== "boolean") throw new PublishedWikiError("invalid_response", 502);
  return { slug, available: row.available };
}
export async function setPublishedWikiSlug(input: string, expectedRevision: number, options: Options & { legacyWikiId?: string } = {}) {
  const slug = normalizeWikiSlug(input);
  if (!isValidWikiSlug(slug)) throw new PublishedWikiError("invalid_slug", 400);
  const result = parseStatus(await request({ action: "set-slug", slug, expectedRevision,
    ...(options.legacyWikiId ? { legacyWikiId: options.legacyWikiId } : {}) }, options, true));
  if (result.slug !== slug) throw new PublishedWikiError("invalid_response", 502); return result;
}
function contentChunks(contents: WikiPublicationContentInput[]) {
  const chunks: WikiPublicationContentInput[][] = []; let chunk: WikiPublicationContentInput[] = [];
  for (const content of contents) {
    if (chunk.length && (chunk.length >= 32 || encoder.encode(JSON.stringify([...chunk, content])).byteLength > limits.chunkBytes)) { chunks.push(chunk); chunk = []; }
    chunk.push(content);
    if (encoder.encode(JSON.stringify(chunk)).byteLength > limits.chunkBytes) throw new PublishedWikiError("publication_too_large", 413);
  }
  if (chunk.length) chunks.push(chunk); return chunks;
}
export async function publishPreparedWiki(prepared: PreparedWikiPublication, expectedRevision: number, options: PublishOptions = {}) {
  const guard = ownerGuard(options); const pinned = { ...options, expectedUid: guard.uid }; const chunks = contentChunks(prepared.contents);
  let stage: WikiPublicationStage | null = null;
  try {
    const raw = record(await request({ action: "begin", manifest: prepared.manifest, expectedRevision }, pinned, true));
    stage = { wikiId: matched(raw.wikiId, wikiPattern), generation: matched(raw.generation, /^pwg1_[A-Za-z0-9_-]{32}$/u), expectedRevision: numeric(raw.expectedRevision) };
    if (stage.expectedRevision !== expectedRevision) throw new PublishedWikiError("publication_changed", 409);
    let completed = 0; options.onProgress?.(completed, prepared.contents.length);
    for (const contents of chunks) {
      guard.check(); await request({ action: "upload", ...stage, contents }, pinned, true); guard.check();
      completed += contents.length; options.onProgress?.(completed, prepared.contents.length);
    }
    guard.check();
    return parseStatus(await request({ action: "activate", ...stage }, pinned, true));
  } catch (error) {
    // An aborted UI lifetime must not leave plaintext staging copies until the cron.
    // Cleanup uses a fresh bounded signal, but never follows a switched account.
    if (stage && auth.currentUser?.uid === guard.uid) await request({ action: "abort", ...stage }, { expectedUid: guard.uid, signal: AbortSignal.timeout(5000) }, true).catch(() => undefined);
    throw error;
  }
}
export async function getPublishedWikiManifest(wikiId: string, signal?: AbortSignal) {
  const legacy = wikiPattern.test(wikiId);
  const slug = legacy ? null : normalizeWikiSlug(wikiId);
  if (!legacy && !isValidWikiSlug(slug!)) throw new PublishedWikiError("invalid_request", 400);
  const result = parseManifest(await request({ action: "manifest", ...(legacy ? { wikiId } : { slug }) }, { signal }, false));
  if (legacy ? result.wikiId !== wikiId : result.slug !== slug) throw new PublishedWikiError("invalid_response", 502); return result;
}
async function getContents(wikiId: string, ids: string[], revision: number, signal: AbortSignal | undefined, asset: boolean) {
  if (!wikiPattern.test(wikiId) || !ids.length || ids.length > (asset ? 1 : limits.contentPageSize) || new Set(ids).size !== ids.length
    || ids.some((id) => !entryPattern.test(id)) || !Number.isSafeInteger(revision) || revision < 1) throw new PublishedWikiError("invalid_request", 400);
  return parseContentPage(await request({ action: asset ? "asset" : "content", wikiId, ids: ids.join(","), revision }, { signal }, false), ids, revision, asset);
}
export function getPublishedWikiContents(wikiId: string, entryIds: string[], revision: number, signal?: AbortSignal) {
  return getContents(wikiId, entryIds, revision, signal, false);
}
export async function getPublishedWikiAsset(wikiId: string, entryId: string, revision: number, signal?: AbortSignal) {
  return (await getContents(wikiId, [entryId], revision, signal, true)).entries[0];
}
