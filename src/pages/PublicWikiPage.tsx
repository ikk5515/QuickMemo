import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { usePublishedWikiAssetReader } from "../features/wiki/publishedWikiAssetReader";
import { PublishedWikiAssetEmbed } from "../features/wiki/PublishedWikiAssetEmbed";
import { usePublishedWikiData } from "../features/wiki/usePublishedWikiData";
import { WikiReader } from "../features/wiki/WikiReader";
import type { WikiReadableFolder, WikiReadableNote } from "../features/wiki/wikiModel";

export default function PublicWikiPage() {
  const { wikiId = "" } = useParams();
  const [params] = useSearchParams();
  const [retry, setRetry] = useState(0);
  const { data, error } = usePublishedWikiData(wikiId, [params.get("note") ?? "", ...params.getAll("pane")], retry);
  const assetReader = usePublishedWikiAssetReader(data?.manifest, data?.signal);
  const notes = useMemo<WikiReadableNote[]>(() => data?.manifest.entries.filter((entry) => entry.kind !== "asset").map((entry) => ({
    id: entry.id, folderId: entry.folderId, title: entry.title, entryKind: entry.kind === "legacy-html" ? "legacy-html" : "markdown",
    contentFormat: entry.kind === "legacy-html" ? "legacy-html-v1" : "markdown-v1", body: data.contents.get(entry.id)?.body ?? ""
  })) ?? [], [data]);
  const folders = useMemo<WikiReadableFolder[]>(() => data?.manifest.folders.map((folder) => ({ id: folder.id, parentId: folder.parentId, displayName: folder.name })) ?? [], [data?.manifest]);
  const publicLinkEntries = useMemo(() => data?.manifest.entries.map(({ id, path, kind }) => ({ id, path, kind })) ?? [], [data?.manifest]);
  const loadingNoteIds = useMemo(() => new Set(notes.filter((note) => !data?.contents.has(note.id)).map((note) => note.id)), [data, notes]);
  if (!data) return <main className="page-center"><div className="wiki-public-message">
    {error ? <><h1>위키를 열 수 없습니다</h1><p role="alert">{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>다시 시도</button></> : <p role="status">공개 위키를 불러오고 있습니다…</p>}
    <Link to="/login">QuickMemo 로그인</Link>
  </div></main>;
  return <WikiReader mode="public" title={data.manifest.title} basePath={`/wiki/public/${encodeURIComponent(wikiId)}`} notes={notes} folders={folders} loadingNoteIds={loadingNoteIds} publicLinkEntries={publicLinkEntries}
    homeLink={{ href: "/wiki", label: "내 위키" }}
    renderAsset={(reference, sourceEntry) => <PublishedWikiAssetEmbed key={`${data.manifest.revision}:${sourceEntry.id}:${reference.raw}`} reader={assetReader} reference={reference} sourceEntry={sourceEntry} />}
  />;
}
