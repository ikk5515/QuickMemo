/* global Buffer */
import { setTimeout as delay } from "node:timers/promises";
import {
  HttpError, activeUserFromRequest, applySecureResponseHeaders, assertOnlyKeys,
  clientNetworkDigest, createDocumentWrite, createFirestoreContext, deleteDocumentWrite,
  ensureSameOrigin, firestoreBatchGet, firestoreBatchGetNewTransaction, firestoreCommit,
  firestoreDocumentName, firestoreGet, firestoreReferenceValue, firestoreRollback,
  firestoreRunQuery, handleApiError, headerValue, isPlainRecord, jsonResponse,
  randomToken, rateLimitBucketDigest, readJsonBody, requestId, requestUrl, safeId,
  sha256Digest, updateDocumentWrite, verifySecureShareAppCheck
} from "./_secure-share-common.js";
import { assertVaultFolderId, validateVaultFolderTree } from "./_vault-folder-tree.js";

const limits = Object.freeze({ notes: 200, assets: 64, folders: 200, textBytes: 128 * 1024,
  assetBytes: 512 * 1024, totalBytes: 20 * 1024 * 1024, chunkBytes: 1024 * 1024, contentPageSize: 8 });
const maximumManifestBytes = 240 * 1024;
const maximumStoredMetadataBytes = 700 * 1024;
const stageLifetimeMilliseconds = 15 * 60 * 1000;
const idPattern = /^pw1_[A-Za-z0-9_-]{32}$/u;
const generationPattern = /^pwg1_[A-Za-z0-9_-]{32}$/u;
const sourceFields = ["ownerUid", "folderId", "parentId", "isDeleted", "isPurged", "participantUids", "type",
  "contentFormat", "entryKind", "revision", "secureShareCopyState"];

const wikiPath = (wikiId) => `publishedWikis/${wikiId}`;
const rootPath = (uid, rootFolderId) => `publishedWikiRoots/${sha256Digest(`${uid}\n${rootFolderId}`)}`;
const entryId = (wikiId, sourceId) => `e_${Buffer.from(sha256Digest(`${wikiId}\nentry\n${sourceId}`), "base64url").toString("hex").slice(0, 32)}`;
const folderId = (wikiId, sourceId) => `f_${Buffer.from(sha256Digest(`${wikiId}\nfolder\n${sourceId}`), "base64url").toString("hex").slice(0, 32)}`;
const copyPath = (wikiId, generation, id) => `${wikiPath(wikiId)}/entries/${generation}_${id}`;
const byteLength = (value) => Buffer.byteLength(value, "utf8");
const notFound = () => new HttpError(404, "not_found");

function identifier(value, kind = "wiki") {
  if (!(kind === "wiki" ? idPattern : generationPattern).test(value ?? "")) throw notFound();
  return value;
}
function integer(value, maximum = 999_999_999) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new HttpError(400, "invalid_request");
  return value;
}
function safeName(value) {
  if (typeof value !== "string" || !value.trim() || byteLength(value) > 512
    || [...value].some((character) => character === "/" || character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || [".", ".."].includes(value.trim())) throw new HttpError(400, "invalid_request");
  return value.trim().normalize("NFC");
}
function expiry(value) {
  if (value === null) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + 366 * 86400_000) throw new HttpError(400, "invalid_expiry");
  return new Date(parsed).toISOString();
}
function profileActive(profile) {
  return profile?.isActive === true && (profile.isAdmin === true
    || !Object.prototype.hasOwnProperty.call(profile, "featureAccess")
    || (isPlainRecord(profile.featureAccess) && profile.featureAccess.notes === true));
}
function sourceKind(note) {
  if (note?.contentFormat === "asset-v1" && (!note.entryKind || note.entryKind === "asset")) return "asset";
  if (note?.contentFormat === "markdown-v1" && (!note.entryKind || note.entryKind === "markdown")) return "markdown";
  if ((!note?.contentFormat || note.contentFormat === "legacy-html-v1") && (!note?.entryKind || note.entryKind === "legacy-html")) return "legacy-html";
  return null;
}
function sourceActive(note, uid, expectedKind) {
  return note?.ownerUid === uid && note.isDeleted !== true && note.isPurged !== true
    && ["personal", "shared"].includes(note.type) && note.participantUids?.includes(uid)
    && (!note.secureShareCopyState || note.secureShareCopyState === "active")
    && sourceKind(note) === expectedKind;
}
function subtreeContains(tree, rootFolderId, candidateId) {
  let current = candidateId;
  for (let depth = 0; current && depth <= 32; depth += 1) {
    const node = tree.nodes[current];
    if (!node?.active) return false;
    if (current === rootFolderId) return true;
    current = node.parentId;
  }
  return false;
}
function assertManifest(input) {
  assertOnlyKeys(input, ["rootFolderId", "title", "expiresAt", "folders", "entries"]);
  const rootFolderId = assertVaultFolderId(input.rootFolderId);
  if (!Array.isArray(input.folders) || !input.folders.length || input.folders.length > limits.folders
    || !Array.isArray(input.entries) || input.entries.length > limits.notes + limits.assets) throw new HttpError(413, "publication_too_large");
  const folders = input.folders.map((folder) => {
    assertOnlyKeys(folder, ["sourceFolderId", "parentSourceFolderId", "name"]);
    return { sourceFolderId: assertVaultFolderId(folder.sourceFolderId),
      parentSourceFolderId: folder.parentSourceFolderId === null ? null : assertVaultFolderId(folder.parentSourceFolderId), name: safeName(folder.name) };
  });
  const folderIds = new Set(folders.map((folder) => folder.sourceFolderId));
  if (folderIds.size !== folders.length || !folderIds.has(rootFolderId)
    || folders.some((folder) => folder.sourceFolderId === rootFolderId
      ? folder.parentSourceFolderId !== null : !folder.parentSourceFolderId || !folderIds.has(folder.parentSourceFolderId))) throw new HttpError(400, "invalid_request");
  const entries = input.entries.map((entry) => {
    assertOnlyKeys(entry, ["sourceNoteId", "sourceRevision", "sourceFolderId", "title", "kind"]);
    if (!["markdown", "legacy-html", "asset"].includes(entry.kind)) throw new HttpError(400, "invalid_request");
    const sourceFolderId = assertVaultFolderId(entry.sourceFolderId);
    if (!folderIds.has(sourceFolderId)) throw new HttpError(403, "publication_scope_denied");
    return { sourceNoteId: safeId(entry.sourceNoteId), sourceRevision: integer(entry.sourceRevision), sourceFolderId,
      title: safeName(entry.title), kind: entry.kind };
  });
  if (new Set(entries.map((entry) => entry.sourceNoteId)).size !== entries.length
    || entries.filter((entry) => entry.kind === "asset").length > limits.assets
    || entries.filter((entry) => entry.kind !== "asset").length > limits.notes) throw new HttpError(413, "publication_too_large");
  const manifest = { rootFolderId, title: safeName(input.title), expiresAt: expiry(input.expiresAt), folders, entries };
  if (byteLength(JSON.stringify(manifest)) > maximumManifestBytes) throw new HttpError(413, "publication_too_large");
  return manifest;
}

async function readProjected(context, collection, ids, transaction = "") {
  const unique = [...new Set(ids)];
  const documents = [];
  for (let offset = 0; offset < unique.length; offset += 30) {
    const batch = unique.slice(offset, offset + 30);
    documents.push(...await firestoreRunQuery(context, {
      select: { fields: sourceFields.map((fieldPath) => ({ fieldPath })) },
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: "__name__" }, op: "IN", value: {
        arrayValue: { values: batch.map((id) => firestoreReferenceValue(firestoreDocumentName(context.projectId, `${collection}/${id}`))) }
      } } }, limit: batch.length
    }, "", transaction));
  }
  return new Map(documents.map((document) => [document.__id, document]));
}

async function scopeState(context, uid, rootFolderId, manifest, transaction) {
  const [profile, root, treeDocument] = await firestoreBatchGet(context, [
    `users/${uid}`, `noteFolders/${rootFolderId}`, `vaultFolderTrees/${uid}`
  ], transaction);
  if (!profileActive(profile) || root?.ownerUid !== uid || root.isDeleted === true || treeDocument?.ownerUid !== uid) throw notFound();
  const tree = validateVaultFolderTree({ schemaVersion: treeDocument.schemaVersion, revision: treeDocument.revision, folderCount: treeDocument.folderCount, nodes: treeDocument.nodes });
  if (!tree.nodes[rootFolderId]?.active) throw notFound();
  const folders = await readProjected(context, "noteFolders", manifest.folders.map((folder) => folder.sourceFolderId), transaction);
  const allowedFolders = new Set();
  for (const folder of manifest.folders) {
    const current = folders.get(folder.sourceFolderId);
    const node = tree.nodes[folder.sourceFolderId];
    if (current?.ownerUid === uid && current.isDeleted !== true && node?.parentId === (current.parentId ?? null)
      && (folder.sourceFolderId === rootFolderId || folder.parentSourceFolderId === current.parentId)
      && subtreeContains(tree, rootFolderId, folder.sourceFolderId)) allowedFolders.add(folder.sourceFolderId);
  }
  // A stored relative path is only public while every original path segment is
  // still in the selected subtree. Never repair a removed parent using private paths.
  for (let pass = 0; pass < manifest.folders.length; pass += 1) {
    let removed = false;
    for (const folder of manifest.folders) if (allowedFolders.has(folder.sourceFolderId)
      && folder.sourceFolderId !== rootFolderId && !allowedFolders.has(folder.parentSourceFolderId)) {
      allowedFolders.delete(folder.sourceFolderId); removed = true;
    }
    if (!removed) break;
  }
  if (!allowedFolders.has(rootFolderId)) throw notFound();
  return { tree, allowedFolders };
}

async function validateSources(context, site, manifest, transaction, strict) {
  const scope = await scopeState(context, site.ownerUid, site.rootFolderId, manifest, transaction);
  const sources = await readProjected(context, "notes", manifest.entries.map((entry) => entry.sourceNoteId), transaction);
  const entries = manifest.entries.filter((entry) => {
    const current = sources.get(entry.sourceNoteId);
    return sourceActive(current, site.ownerUid, entry.kind)
      && scope.allowedFolders.has(entry.sourceFolderId) && current.folderId === entry.sourceFolderId
      && (!strict || (current.revision ?? 0) === entry.sourceRevision);
  });
  if (strict && (entries.length !== manifest.entries.length || scope.allowedFolders.size !== manifest.folders.length)) throw new HttpError(409, "source_changed");
  return { entries, folders: manifest.folders.filter((folder) => scope.allowedFolders.has(folder.sourceFolderId)) };
}

function conflict(error) {
  return error?.name === "UpstreamError" && ([409, 412].includes(error.statusCode)
    || error.upstreamCode === "ABORTED"
    || (error.statusCode === 400 && error.upstreamCode === "FAILED_PRECONDITION"));
}
async function transactionally(context, paths, operation) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let state = null;
    try {
      state = await firestoreBatchGetNewTransaction(context, paths);
      const result = await operation(state.documents, state.transaction);
      await firestoreCommit(context, result.writes ?? [], state.transaction);
      return result.value;
    } catch (error) {
      if (state?.transaction) await firestoreRollback(context, state.transaction).catch(() => undefined);
      if (!conflict(error)) throw error;
      if (attempt === 3) throw new HttpError(503, "service_unavailable", "Published wiki transaction contention", { retryAfter: 1 });
      await delay(15 * (attempt + 1) + Math.floor(Math.random() * 30));
    }
  }
  throw new HttpError(503, "service_unavailable");
}
function cleanupDue(site) {
  const candidates = [site.pending?.deadline, site.active?.expiresAt].map((value) => Date.parse(value)).filter(Number.isFinite);
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}
function writeSite(context, wikiId, previous, next) {
  if (byteLength(JSON.stringify(next)) > maximumStoredMetadataBytes) throw new HttpError(413, "publication_too_large");
  return previous ? updateDocumentWrite(context.projectId, wikiPath(wikiId), next, Object.keys(next), previous.__updateTime)
    : createDocumentWrite(context.projectId, wikiPath(wikiId), next);
}
function storedSite(document, wikiId, uid) {
  if (!document || document.schemaVersion !== 1 || document.wikiId !== wikiId || document.ownerUid !== uid) throw notFound();
  return document;
}
function ownerStatus(site) {
  const active = site?.active;
  return { wikiId: site?.wikiId ?? null, revision: site?.revision ?? 0, published: site?.published === true,
    title: active?.title ?? "", expiresAt: active?.expiresAt ?? null, updatedAt: site?.updatedAt ?? null,
    noteCount: active?.entries.filter((entry) => entry.kind !== "asset").length ?? 0,
    assetCount: active?.entries.filter((entry) => entry.kind === "asset").length ?? 0 };
}
async function obsoleteCopies(context, site, transaction, keepGeneration) {
  const copies = await firestoreRunQuery(context, {
    select: { fields: [{ fieldPath: "generation" }] }, from: [{ collectionId: "entries" }], limit: 2 * (limits.notes + limits.assets) + 1
  }, wikiPath(site.wikiId), transaction);
  if (copies.length > 2 * (limits.notes + limits.assets)) throw new HttpError(409, "publication_cleanup_required");
  return copies.filter((copy) => copy.generation !== keepGeneration).map((copy) =>
    deleteDocumentWrite(context.projectId, `${wikiPath(site.wikiId)}/entries/${copy.__id}`, copy.__updateTime));
}
function requireStage(site, body) {
  if (site.revision !== integer(body.expectedRevision) || !site.pending
    || site.pending.generation !== identifier(body.generation, "generation")
    || Date.parse(site.pending.deadline) <= Date.now()) throw new HttpError(409, "publication_changed");
  return site.pending;
}

async function ownerAction(context, uid, body) {
  const action = body.action;
  if (action === "begin") {
    assertOnlyKeys(body, ["action", "expectedRevision", "manifest"]);
    const manifest = assertManifest(body.manifest);
    const lookupPath = rootPath(uid, manifest.rootFolderId);
    return transactionally(context, [lookupPath], async ([lookup], transaction) => {
      const wikiId = lookup ? identifier(lookup.wikiId) : `pw1_${randomToken(24)}`;
      const [prior] = await firestoreBatchGet(context, [wikiPath(wikiId)], transaction);
      if (prior) storedSite(prior, wikiId, uid);
      if ((prior?.revision ?? 0) !== integer(body.expectedRevision)) throw new HttpError(409, "publication_changed");
      const site = { schemaVersion: 1, wikiId, ownerUid: uid, rootFolderId: manifest.rootFolderId,
        revision: prior?.revision ?? 0, published: prior?.published === true, active: prior?.active ?? null,
        updatedAt: prior?.updatedAt ?? null, pending: null };
      await validateSources(context, site, manifest, transaction, true);
      const obsolete = prior ? await obsoleteCopies(context, site, transaction, site.active?.generation) : [];
      const generation = `pwg1_${randomToken(24)}`;
      site.pending = { ...manifest, generation, deadline: new Date(Date.now() + stageLifetimeMilliseconds).toISOString(), uploaded: {}, totalBytes: 0 };
      site.cleanupAt = cleanupDue(site);
      return { writes: [...obsolete, ...(!lookup ? [createDocumentWrite(context.projectId, lookupPath, { ownerUid: uid, rootFolderId: manifest.rootFolderId, wikiId })] : []),
        writeSite(context, wikiId, prior, site)], value: { wikiId, generation, expectedRevision: site.revision } };
    });
  }
  if (action === "status" || action === "unpublish") {
    assertOnlyKeys(body, action === "status" ? ["action", "rootFolderId"] : ["action", "rootFolderId", "expectedRevision"]);
    const rootFolderId = assertVaultFolderId(body.rootFolderId);
    const lookup = await firestoreGet(context, rootPath(uid, rootFolderId));
    if (!lookup) return ownerStatus(null);
    const wikiId = identifier(lookup.wikiId);
    return transactionally(context, [wikiPath(wikiId), `users/${uid}`], async ([document, profile], transaction) => {
      const site = storedSite(document, wikiId, uid);
      if (!profileActive(profile) || site.rootFolderId !== rootFolderId) throw notFound();
      if (action === "status") return { value: ownerStatus(site) };
      if (site.revision !== integer(body.expectedRevision)) throw new HttpError(409, "publication_changed");
      // Revocation becomes authoritative before any best-effort storage cleanup.
      const next = { ...site, published: false, active: null, pending: null, cleanupAt: new Date(), revision: site.revision + 1, updatedAt: new Date().toISOString() };
      delete next.__id; delete next.__updateTime; delete next.__createTime; delete next.__name;
      const obsolete = await obsoleteCopies(context, site, transaction, null);
      // Two generations can exceed Firestore's 500-write transaction ceiling.
      // Clearing access is atomic; a later begin removes remaining private copies.
      return { writes: [...obsolete.slice(0, 450), writeSite(context, wikiId, site, next)], value: ownerStatus(next) };
    });
  }
  if (!["upload", "activate", "abort"].includes(action)) throw new HttpError(400, "invalid_action");
  assertOnlyKeys(body, action === "upload" ? ["action", "wikiId", "generation", "expectedRevision", "contents"] : ["action", "wikiId", "generation", "expectedRevision"]);
  const wikiId = identifier(body.wikiId);
  return transactionally(context, [wikiPath(wikiId), `users/${uid}`], async ([document, profile], transaction) => {
    const site = storedSite(document, wikiId, uid);
    if (!profileActive(profile)) throw notFound();
    const pending = action === "abort" && site.pending?.generation === body.generation && site.revision === integer(body.expectedRevision) ? site.pending : requireStage(site, body);
    const next = { ...site, pending: { ...pending } };
    delete next.__id; delete next.__updateTime; delete next.__createTime; delete next.__name;
    if (action === "abort") {
      const obsolete = await obsoleteCopies(context, site, transaction, site.active?.generation);
      next.pending = null; next.cleanupAt = cleanupDue(next);
      return { writes: [...obsolete, writeSite(context, wikiId, site, next)], value: ownerStatus(next) };
    }
    if (action === "upload") {
      if (!Array.isArray(body.contents) || !body.contents.length || body.contents.length > 32 || byteLength(JSON.stringify(body.contents)) > limits.chunkBytes) throw new HttpError(413, "publication_too_large");
      const selected = body.contents.map((content) => {
        assertOnlyKeys(content, ["sourceNoteId", "body"]);
        const metadata = pending.entries.find((entry) => entry.sourceNoteId === content.sourceNoteId);
        if (!metadata || typeof content.body !== "string" || byteLength(content.body) > (metadata.kind === "asset" ? limits.assetBytes : limits.textBytes)) throw new HttpError(413, "publication_too_large");
        return { metadata, content };
      });
      if (new Set(selected.map(({ metadata }) => metadata.sourceNoteId)).size !== selected.length) throw new HttpError(400, "invalid_request");
      await validateSources(context, site, { ...pending, entries: selected.map(({ metadata }) => metadata) }, transaction, true);
      const copies = await firestoreBatchGet(context, selected.map(({ metadata }) => copyPath(wikiId, pending.generation, entryId(wikiId, metadata.sourceNoteId))), transaction);
      next.pending.uploaded = { ...pending.uploaded };
      for (const { metadata, content } of selected) next.pending.uploaded[entryId(wikiId, metadata.sourceNoteId)] = byteLength(content.body);
      next.pending.totalBytes = Object.values(next.pending.uploaded).reduce((sum, bytes) => sum + bytes, 0);
      if (next.pending.totalBytes > limits.totalBytes) throw new HttpError(413, "publication_too_large");
      const writes = selected.map(({ metadata, content }, index) => {
        const id = entryId(wikiId, metadata.sourceNoteId);
        const fields = { generation: pending.generation, sourceNoteId: metadata.sourceNoteId, body: content.body };
        return copies[index] ? updateDocumentWrite(context.projectId, copyPath(wikiId, pending.generation, id), fields, Object.keys(fields), copies[index].__updateTime)
          : createDocumentWrite(context.projectId, copyPath(wikiId, pending.generation, id), fields);
      });
      return { writes: [...writes, writeSite(context, wikiId, site, next)], value: { uploadedCount: Object.keys(next.pending.uploaded).length } };
    }
    await validateSources(context, site, pending, transaction, true);
    if (pending.entries.some((entry) => !Object.prototype.hasOwnProperty.call(pending.uploaded, entryId(wikiId, entry.sourceNoteId)))) throw new HttpError(409, "publication_incomplete");
    if (pending.expiresAt !== null && Date.parse(pending.expiresAt) <= Date.now()) throw new HttpError(409, "publication_expired");
    const { uploaded: _uploaded, deadline: _deadline, ...active } = pending;
    void _uploaded; void _deadline;
    next.active = active; next.pending = null; next.published = true;
    next.revision = site.revision + 1; next.updatedAt = new Date().toISOString(); next.cleanupAt = new Date();
    return { writes: [writeSite(context, wikiId, site, next)], value: ownerStatus(next) };
  });
}

function publicProjection(site, allowed) {
  const root = allowed.folders.find((folder) => folder.sourceFolderId === site.rootFolderId);
  if (!root) throw notFound();
  const paths = new Map([[site.rootFolderId, root.name]]);
  const byId = new Map(allowed.folders.map((folder) => [folder.sourceFolderId, folder]));
  const pathFor = (id, seen = new Set()) => {
    if (paths.has(id)) return paths.get(id);
    if (seen.has(id) || seen.size > 32 || !byId.has(id)) throw notFound();
    seen.add(id);
    const folder = byId.get(id);
    const parent = pathFor(folder.parentSourceFolderId, seen);
    const path = parent ? `${parent}/${folder.name}` : folder.name;
    paths.set(id, path); return path;
  };
  const folders = allowed.folders.map((folder) => ({ id: folderId(site.wikiId, folder.sourceFolderId),
    parentId: folder.sourceFolderId === site.rootFolderId ? null : folderId(site.wikiId, folder.parentSourceFolderId),
    name: folder.name, path: pathFor(folder.sourceFolderId) }));
  const entries = allowed.entries.map((entry) => {
    const directory = pathFor(entry.sourceFolderId);
    const name = entry.kind === "asset" || /\.md$/iu.test(entry.title) ? entry.title : `${entry.title}.md`;
    return { id: entryId(site.wikiId, entry.sourceNoteId), folderId: folderId(site.wikiId, entry.sourceFolderId), title: entry.title,
      path: directory ? `${directory}/${name}` : name, kind: entry.kind };
  });
  return { wikiId: site.wikiId, revision: site.revision, title: site.active.title, expiresAt: site.active.expiresAt,
    updatedAt: site.updatedAt, folders, entries };
}

async function publicAction(context, action, wikiId, ids, revision) {
  return transactionally(context, [wikiPath(wikiId)], async ([site], transaction) => {
    if (!site || site.schemaVersion !== 1 || site.wikiId !== wikiId || !site.published || !site.active
      || (site.active.expiresAt !== null && !(Date.parse(site.active.expiresAt) > Date.now()))) throw notFound();
    if (revision !== null && site.revision !== revision) throw new HttpError(409, "publication_changed");
    const requested = action === "manifest" ? site.active.entries : site.active.entries.filter((entry) => ids.includes(entryId(wikiId, entry.sourceNoteId)));
    if (action !== "manifest" && (requested.length !== ids.length || requested.some((entry) => action === "asset" ? entry.kind !== "asset" : entry.kind === "asset"))) throw notFound();
    const folderIds = new Set([site.rootFolderId]);
    const folderById = new Map(site.active.folders.map((folder) => [folder.sourceFolderId, folder]));
    for (const entry of requested) {
      let id = entry.sourceFolderId;
      for (let depth = 0; id && depth <= 32; depth += 1) { folderIds.add(id); id = folderById.get(id)?.parentSourceFolderId; }
    }
    const folders = action === "manifest" ? site.active.folders : site.active.folders.filter((folder) => folderIds.has(folder.sourceFolderId));
    const allowed = await validateSources(context, site, { ...site.active, folders, entries: requested }, transaction, false);
    const projection = publicProjection(site, allowed);
    if (action === "manifest") return { value: projection };
    if (allowed.entries.length !== ids.length) throw notFound();
    const copies = await firestoreBatchGet(context, projection.entries.map((entry) => copyPath(wikiId, site.active.generation, entry.id)), transaction);
    if (copies.some((copy, index) => !copy || copy.generation !== site.active.generation
      || copy.sourceNoteId !== allowed.entries[index].sourceNoteId || typeof copy.body !== "string")) throw notFound();
    const entries = projection.entries.map((entry, index) => ({ ...entry, body: copies[index].body }));
    if (byteLength(JSON.stringify(entries)) > 2 * limits.chunkBytes) throw new HttpError(413, "publication_too_large");
    return { value: { revision: site.revision, entries } };
  });
}

/** The existing authenticated cleanup cron reclaims at most three sites per run.
 * No collection scans or additional scheduler/secrets; cleanupAt uses a single-field index. */
export async function cleanupExpiredPublishedWikis(context, deadlineAt) {
  const due = await firestoreRunQuery(context, {
    select: { fields: [{ fieldPath: "wikiId" }] }, from: [{ collectionId: "publishedWikis" }],
    where: { fieldFilter: { field: { fieldPath: "cleanupAt" }, op: "LESS_THAN_OR_EQUAL", value: { timestampValue: new Date().toISOString() } } },
    orderBy: [{ field: { fieldPath: "cleanupAt" }, direction: "ASCENDING" }], limit: 3
  });
  let deleted = 0;
  for (const item of due) {
    if (Date.now() >= deadlineAt) break;
    deleted += await transactionally(context, [wikiPath(identifier(item.wikiId))], async ([site], transaction) => {
      if (!site || !site.cleanupAt || !(new Date(site.cleanupAt).getTime() <= Date.now())) return { value: 0 };
      const next = { ...site };
      delete next.__id; delete next.__updateTime; delete next.__createTime; delete next.__name;
      if (next.pending && !(Date.parse(next.pending.deadline) > Date.now())) next.pending = null;
      if (next.active?.expiresAt && !(Date.parse(next.active.expiresAt) > Date.now())) {
        next.active = null; next.published = false; next.revision += 1; next.updatedAt = new Date().toISOString();
      }
      const copies = await firestoreRunQuery(context, {
        select: { fields: [{ fieldPath: "generation" }] }, from: [{ collectionId: "entries" }], limit: 529
      }, wikiPath(site.wikiId), transaction);
      const keep = new Set([next.active?.generation, next.pending?.generation].filter(Boolean));
      const obsolete = copies.filter((copy) => !keep.has(copy.generation));
      const removing = obsolete.slice(0, 450);
      next.cleanupAt = obsolete.length > removing.length || copies.length >= 529 ? new Date() : cleanupDue(next);
      return { writes: [...removing.map((copy) => deleteDocumentWrite(context.projectId, `${wikiPath(site.wikiId)}/entries/${copy.__id}`, copy.__updateTime)),
        writeSite(context, site.wikiId, site, next)], value: removing.length };
    });
  }
  return deleted;
}

async function consumeLimit(context, key, maximum) {
  const window = Math.floor(Date.now() / 60_000);
  const digest = rateLimitBucketDigest("published-wiki", [key, String(window)]);
  const path = `publicShareRateLimits/${digest}`;
  // A counter has one compare-and-swap write. Holding a read/write transaction
  // lock while parallel requests upgrade this same global document can deadlock
  // in the emulator and amplify contention in production. Match Secure Share's
  // optimistic precondition writes; every retry reads the latest count again.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = await firestoreGet(context, path);
    if (prior && (!Number.isSafeInteger(prior.count) || prior.count < 0)) throw new HttpError(503, "service_unavailable");
    if ((prior?.count ?? 0) >= maximum) throw new HttpError(429, "rate_limited", "Published wiki rate limit exceeded", { retryAfter: 60 });
    const fields = { count: (prior?.count ?? 0) + 1, limitType: "published-wiki", shareId: "", ownerUid: "",
      windowStart: new Date(window * 60_000), updatedAt: new Date(), expiresAt: new Date((window + 2) * 60_000) };
    try {
      await firestoreCommit(context, [prior ? updateDocumentWrite(context.projectId, path, fields, Object.keys(fields), prior.__updateTime)
        : createDocumentWrite(context.projectId, path, fields)]);
      return;
    } catch (error) {
      if (!conflict(error)) throw error;
      if (attempt === 3) throw new HttpError(503, "service_unavailable", "Published wiki counter contention", { retryAfter: 1 });
      await delay(25 * (attempt + 1) + Math.floor(Math.random() * 50 * (attempt + 1)));
    }
  }
}

export default async function handler(request, response) {
  const id = requestId();
  applySecureResponseHeaders(response, id);
  try {
    if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
    if (request.method === "POST" || headerValue(request, "origin")) ensureSameOrigin(request);
    // Same-origin browser GETs commonly omit Origin. Match the existing
    // Secure Share revision endpoint's marker + Fetch Metadata boundary.
    if (request.method === "GET" && headerValue(request, "sec-fetch-site").trim().toLowerCase() !== "same-origin") throw new HttpError(403, "request_rejected");
    if (headerValue(request, "x-quickmemo-published-wiki") !== "1") throw new HttpError(403, "request_rejected");
    const context = await createFirestoreContext();
    const check = await verifySecureShareAppCheck(request, context);
    if (check.enforced && !check.valid) throw new HttpError(403, "request_rejected");
    if (request.method === "POST") {
      const user = await activeUserFromRequest(request, context);
      await consumeLimit(context, `owner:${user.uid}`, 120);
      const body = await readJsonBody(request, limits.chunkBytes + 64 * 1024);
      jsonResponse(response, 200, await ownerAction(context, user.uid, body));
      return;
    }
    const url = requestUrl(request);
    if ([...url.searchParams.keys()].some((key) => !["action", "wikiId", "ids", "revision"].includes(key))) throw new HttpError(400, "invalid_request");
    const action = url.searchParams.get("action");
    if (!["manifest", "content", "asset"].includes(action)) throw new HttpError(400, "invalid_action");
    const wikiId = identifier(url.searchParams.get("wikiId"));
    const ids = action === "manifest" ? [] : (url.searchParams.get("ids") ?? "").split(",");
    if (action !== "manifest" && (!ids.length || ids.length > (action === "asset" ? 1 : limits.contentPageSize)
      || ids.some((value) => !/^e_[0-9a-f]{32}$/u.test(value)) || new Set(ids).size !== ids.length)) throw new HttpError(400, "invalid_request");
    const revision = action === "manifest" ? null : integer(Number(url.searchParams.get("revision")));
    const network = clientNetworkDigest(request);
    await consumeLimit(context, "public-global", 900);
    await consumeLimit(context, `public:${wikiId}:${network}`, action === "manifest" ? 60 : 240);
    jsonResponse(response, 200, await publicAction(context, action, wikiId, ids, revision));
  } catch (error) { handleApiError(error, response, id); }
}

export const __publishedWikiTesting = Object.freeze({ limits, assertManifest, sourceKind, sourceActive, subtreeContains,
  profileActive, entryId, folderId, rootPath, publicProjection, ownerAction, publicAction, consumeLimit });
