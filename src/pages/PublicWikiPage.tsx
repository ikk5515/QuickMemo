import { useMemo } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { usePublishedWikiAssetReader } from "../features/wiki/publishedWikiAssetReader";
import { PublishedWikiAssetEmbed } from "../features/wiki/PublishedWikiAssetEmbed";
import { usePublishedWikiData } from "../features/wiki/usePublishedWikiData";
import { WikiReader } from "../features/wiki/WikiReader";
import type { WikiReadableFolder, WikiReadableNote } from "../features/wiki/wikiModel";

export default function PublicWikiPage() {
  const { wikiId = "", wikiSlug = "" } = useParams();
  const identifier = wikiSlug || wikiId;
  const [params] = useSearchParams();
  const { data, error } = usePublishedWikiData(identifier, [params.get("page") ?? "", params.get("note") ?? "", ...params.getAll("pane")], 0);
  const assetReader = usePublishedWikiAssetReader(data?.manifest, data?.signal);
  const notes = useMemo<WikiReadableNote[]>(() => data?.manifest.entries.filter((entry) => entry.kind !== "asset").map((entry) => ({
    id: entry.id, folderId: entry.folderId, title: entry.title, entryKind: entry.kind === "legacy-html" ? "legacy-html" : "markdown",
    contentFormat: entry.kind === "legacy-html" ? "legacy-html-v1" : "markdown-v1", body: data.contents.get(entry.id)?.body ?? ""
  })) ?? [], [data]);
  const folders = useMemo<WikiReadableFolder[]>(() => data?.manifest.folders.map((folder) => ({ id: folder.id, parentId: folder.parentId, displayName: folder.name })) ?? [], [data?.manifest]);
  const publicLinkEntries = useMemo(() => data?.manifest.entries.map(({ id, path, kind }) => ({ id, path, kind })) ?? [], [data?.manifest]);
  const loadingNoteIds = useMemo(() => new Set(notes.filter((note) => !data?.contents.has(note.id)).map((note) => note.id)), [data, notes]);
  if (!data) return <main className="page-center"><div className="wiki-public-message" role={error ? "alert" : undefined}>
    {error ? <h1>위키를 열 수 없습니다</h1> : <p role="status">공개 위키를 불러오고 있습니다…</p>}
  </div></main>;
  if (wikiId) {
    const hasPage = params.has("page");
    const hasNote = params.has("note");
    const requested = hasPage ? params.get("page") : params.get("note");
    const matches = data.manifest.entries.filter((entry) => entry.kind !== "asset" && (hasPage ? entry.path === requested : entry.id === requested));
    const entry = matches.length === 1 ? matches[0] : undefined;
    // A legacy ID must resolve inside this publication. Never replace a missing
    // or ambiguous deep link with the first document during canonicalization.
    if ((hasPage || hasNote) && (!entry || data.manifest.entries.filter((candidate) => candidate.kind !== "asset" && candidate.path === entry.path).length !== 1)) {
      return <main className="page-center"><div className="wiki-public-message" role="alert"><h1>위키를 열 수 없습니다</h1></div></main>;
    }
    if (data.manifest.slug || (hasNote && !hasPage)) {
      const base = data.manifest.slug ? `/wiki/${encodeURIComponent(data.manifest.slug)}` : `/wiki/public/${encodeURIComponent(wikiId)}`;
      const query = entry ? `?${new URLSearchParams({ page: entry.path })}` : "";
      return <Navigate replace to={`${base}${query}`} />;
    }
  }
  return <WikiReader mode="public" title={data.manifest.title} basePath={data.manifest.slug ? `/wiki/${encodeURIComponent(data.manifest.slug)}` : `/wiki/public/${encodeURIComponent(wikiId)}`} notes={notes} folders={folders} loadingNoteIds={loadingNoteIds} publicLinkEntries={publicLinkEntries}
    renderAsset={(reference, sourceEntry) => <PublishedWikiAssetEmbed key={`${data.manifest.revision}:${sourceEntry.id}:${reference.raw}`} reader={assetReader} reference={reference} sourceEntry={sourceEntry} />}
  />;
}
