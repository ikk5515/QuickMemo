import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getPublishedWikiWorkspaceStatus, publishPreparedWiki } from "../../services/publishedWikis";
import type { DecryptedVaultFolder, DecryptedVaultNote } from "../vault/vaultData";
import type { PreparedWikiPublication, PublishedWikiOwnerStatus, WikiPublicationInput, WikiPublicationSelection } from "./publishedWikiTypes";

export function publicationSourceIds(uid: string, selection: WikiPublicationSelection, notes: readonly DecryptedVaultNote[], folders: readonly DecryptedVaultFolder[]) {
  const folderIds = new Set(selection.folderIds);
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.ownerUid !== uid || folder.isDeleted || !folder.parentId) continue;
    const ids = children.get(folder.parentId) ?? []; ids.push(folder.id); children.set(folder.parentId, ids);
  }
  const pending = [...folderIds];
  for (let index = 0; index < pending.length; index += 1) for (const id of children.get(pending[index]) ?? []) {
    if (!folderIds.has(id)) { folderIds.add(id); pending.push(id); }
  }
  const explicit = new Set(selection.noteIds);
  return { folderIds, notes: notes.filter((note) => note.ownerUid === uid && !note.isDeleted && !note.isPurged && (explicit.has(note.id) || Boolean(note.folderId && folderIds.has(note.folderId)))) };
}
export function publicationManifestSignature(manifest: WikiPublicationInput | null | undefined) {
  if (!manifest) return "";
  // Field order in JSON responses and locally prepared objects can differ.
  return JSON.stringify({ rootFolderId: manifest.rootFolderId, title: manifest.title, expiresAt: manifest.expiresAt,
    selection: manifest.selection ? { folderIds: [...manifest.selection.folderIds].sort(), noteIds: [...manifest.selection.noteIds].sort() } : null,
    folders: [...manifest.folders].sort((a, b) => a.sourceFolderId.localeCompare(b.sourceFolderId)).map((folder) => [folder.sourceFolderId, folder.parentSourceFolderId, folder.name]),
    entries: [...manifest.entries].sort((a, b) => a.sourceNoteId.localeCompare(b.sourceNoteId)).map((entry) => [entry.sourceNoteId, entry.sourceRevision, entry.sourceFolderId, entry.parentSourceFolderId ?? null, entry.title, entry.kind])
  });
}
function copySelection(selection: WikiPublicationSelection): WikiPublicationSelection {
  return { folderIds: [...selection.folderIds], noteIds: [...selection.noteIds] };
}
function doesNotExpandGrants(manifest: WikiPublicationInput, granted: WikiPublicationSelection) {
  return manifest.rootFolderId === null && manifest.selection
    && manifest.selection.folderIds.every((id) => granted.folderIds.includes(id))
    && manifest.selection.noteIds.every((id) => granted.noteIds.includes(id));
}

interface Options {
  uid: string; signal: AbortSignal; ready: boolean; paused: boolean;
  notes: readonly DecryptedVaultNote[]; folders: readonly DecryptedVaultFolder[];
  prepare: (selection: WikiPublicationSelection, signal: AbortSignal) => Promise<PreparedWikiPublication>;
}
/** Only saved source metadata schedules publishing; typing never serializes or uploads the workspace. */
export function useWikiAutoPublication(options: Options) {
  const { uid, signal, ready, paused, notes, folders } = options;
  const [scopedStatus, setScopedStatus] = useState<{ uid: string; signal: AbortSignal; value: PublishedWikiOwnerStatus } | null>(null);
  const status = scopedStatus?.uid === uid && scopedStatus.signal === signal && !signal.aborted ? scopedStatus.value : null;
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const latest = useRef(options);
  const statusRef = useRef<PublishedWikiOwnerStatus | null>(status);
  const statusScope = useRef({ uid, signal });
  const completed = useRef("");
  const operation = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    latest.current = options;
    if (statusScope.current.uid !== uid || statusScope.current.signal !== signal) {
      statusScope.current = { uid, signal }; statusRef.current = null; completed.current = "";
    }
  }, [options, uid, signal]);
  const applyStatus = useCallback((value: PublishedWikiOwnerStatus) => {
    if (signal.aborted || latest.current.uid !== uid || latest.current.signal !== signal) return false;
    const previous = statusRef.current;
    // A metadata read started before a dialog commit must not resurrect older grants.
    if (previous?.wikiId && (value.wikiId !== previous.wikiId || value.revision < previous.revision)) return false;
    statusRef.current = value; setScopedStatus({ uid, signal, value }); return true;
  }, [uid, signal]);
  const updateStatus = useCallback((value: PublishedWikiOwnerStatus) => {
    if (applyStatus(value)) completed.current = "";
  }, [applyStatus]);
  useEffect(() => {
    const controller = new AbortController();
    const abort = () => {
      controller.abort(); operation.current?.abort();
      if (latest.current.uid === uid && latest.current.signal === signal) {
        statusRef.current = null; setScopedStatus(null); setMessage(""); completed.current = "";
      }
    };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    setScopedStatus(null); statusRef.current = null; setMessage(""); completed.current = "";
    let checking = false;
    const refresh = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const next = await getPublishedWikiWorkspaceStatus({ expectedUid: uid, signal: controller.signal });
        if (!controller.signal.aborted && applyStatus(next)) setRetry((value) => value + 1);
      } catch { /* A failed metadata read cannot grant publication. Retry on focus or reconnect. */ }
      finally { checking = false; }
    };
    void refresh();
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
    return () => { abort(); signal.removeEventListener("abort", abort); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); };
  }, [uid, signal, applyStatus]);
  const published = status?.published; const slug = status?.slug; const selection = status?.selection;
  // Adopting a legacy address preserves its snapshot. Only an explicit
  // workspace publication records consent to subsequent automatic updates.
  const automaticallyPublished = status?.manifest?.rootFolderId === null;
  const sourceSignature = useMemo(() => {
    if (!published || !slug || !selection || !automaticallyPublished) return "";
    const source = publicationSourceIds(uid, selection, notes, folders);
    return JSON.stringify([slug, { folderIds: [...selection.folderIds].sort(), noteIds: [...selection.noteIds].sort() },
      source.notes.map((note) => [note.id, note.revision ?? 0, note.folderId, note.title, note.entryKind, note.contentFormat]).sort(),
      folders.filter((folder) => source.folderIds.has(folder.id)).map((folder) => [folder.id, folder.parentId, folder.displayName, folder.isDeleted, folder.nameDecryptionFailed]).sort()
    ]);
  }, [published, slug, selection, automaticallyPublished, uid, notes, folders]);
  useEffect(() => {
    if (!ready || paused || !sourceSignature || signal.aborted || completed.current === sourceSignature) return;
    const controller = new AbortController();
    operation.current = controller;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let retryTimer: number | undefined;
    const timer = window.setTimeout(() => {
      void (async () => {
        const current = statusRef.current;
        if (!current?.published || !current.slug || !current.selection || current.manifest?.rootFolderId !== null || latest.current.paused || !latest.current.ready || latest.current.uid !== uid || latest.current.signal !== signal || controller.signal.aborted) return;
        const granted = copySelection(current.selection);
        try {
          setMessage("위키 반영 중…");
          const prepared = await latest.current.prepare(copySelection(granted), controller.signal);
          controller.signal.throwIfAborted();
          if (latest.current.uid !== uid || latest.current.signal !== signal || latest.current.paused || !latest.current.ready) return;
          const confirmed = statusRef.current;
          if (!confirmed?.published || confirmed.wikiId !== current.wikiId || confirmed.revision !== current.revision || confirmed.slug !== current.slug) return;
          if (!doesNotExpandGrants(prepared.manifest, granted)) throw new Error("Automatic publication cannot expand granted sources");
          const nextPrepared = { ...prepared, manifest: { ...prepared.manifest, title: current.title, expiresAt: current.expiresAt } };
          if (publicationManifestSignature(nextPrepared.manifest) !== publicationManifestSignature(current.manifest)) {
            const next = await publishPreparedWiki(nextPrepared, current.revision, { expectedUid: uid, signal: controller.signal });
            if (controller.signal.aborted) return;
            if (!applyStatus(next)) return;
          }
          completed.current = sourceSignature; setMessage("");
        } catch {
          if (controller.signal.aborted) return;
          setMessage("위키 반영 대기 중");
          // Revocation, address changes, and another tab's commit always win the revision check.
          try {
            const next = await getPublishedWikiWorkspaceStatus({ expectedUid: uid, signal: controller.signal });
            if (!controller.signal.aborted && applyStatus(next) && !next.published) setMessage("");
          } catch { /* Keep the last published copy; retry once connectivity returns. */ }
          retryTimer = window.setTimeout(() => setRetry((value) => value + 1), 15_000);
        }
      })();
    }, 1200);
    return () => { controller.abort(); window.clearTimeout(timer); window.clearTimeout(retryTimer); signal.removeEventListener("abort", abort); if (operation.current === controller) operation.current = null; };
  }, [sourceSignature, ready, paused, uid, signal, retry, applyStatus]);
  return { status, message, updateStatus };
}
