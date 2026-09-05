import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getPublishedWikiContents, getPublishedWikiManifest } from "../../services/publishedWikis";
import { PUBLISHED_WIKI_LIMITS, type PublishedWikiContent, type PublishedWikiManifest } from "./publishedWikiTypes";

interface PublicWikiData {
  wikiId: string;
  manifest: PublishedWikiManifest;
  contents: ReadonlyMap<string, PublishedWikiContent>;
  signal: AbortSignal;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** Plaintext remains in this page's memory and is discarded on revocation or scope changes. */
export function usePublishedWikiData(wikiId: string, preferredIds: readonly string[], retry: number) {
  const [data, setData] = useState<PublicWikiData | null>(null);
  const [error, setError] = useState("");
  const preferredRef = useRef(preferredIds);
  useLayoutEffect(() => { preferredRef.current = preferredIds; }, [preferredIds]);
  useEffect(() => {
    const lifetime = new AbortController();
    let contentScope: AbortController | null = null;
    let signature = "";
    let checking = false;
    let current: PublicWikiData | null = null;
    setData(null); setError("");
    const ownsScope = (scope: AbortController) => !lifetime.signal.aborted && contentScope === scope && !scope.signal.aborted;
    function assertScope(scope: AbortController) {
      if (!ownsScope(scope)) throw new DOMException("Public wiki scope changed.", "AbortError");
    }
    function discard(reason: unknown) {
      contentScope?.abort(); current = null; signature = ""; setData(null);
      setError(reason instanceof Error ? reason.message : "공개 위키를 불러오지 못했습니다.");
    }
    async function loadContents(manifest: PublishedWikiManifest, scope: AbortController) {
      const contents = new Map<string, PublishedWikiContent>();
      try {
        const readable = manifest.entries.filter((entry) => entry.kind !== "asset");
        const wanted = new Set(preferredRef.current);
        const ordered = [...readable.filter((entry) => (wanted.has(entry.id) || wanted.has(entry.path))), ...readable.filter((entry) => !(wanted.has(entry.id) || wanted.has(entry.path)))];
        const chunks: string[][] = [];
        for (let index = 0; index < ordered.length; index += PUBLISHED_WIKI_LIMITS.contentPageSize) chunks.push(ordered.slice(index, index + PUBLISHED_WIKI_LIMITS.contentPageSize).map((entry) => entry.id));
        async function read(ids: string[]) {
          const result = await getPublishedWikiContents(manifest.wikiId, ids, manifest.revision, scope.signal);
          assertScope(scope);
          if (result.revision !== manifest.revision) throw new Error("공개 내용이 변경되었습니다. 다시 열어 주세요.");
          const allowed = new Set(ids);
          for (const entry of result.entries) if (allowed.has(entry.id) && entry.kind !== "asset") contents.set(entry.id, entry);
          // Missing source entries may have been moved or deleted during the request.
          if (ids.some((id) => !contents.has(id))) throw new Error("공개 범위가 변경되었습니다. 다시 열어 주세요.");
          current = { wikiId, manifest, contents: new Map(contents), signal: scope.signal };
          setData(current);
        }
        if (chunks.length) await read(chunks.shift()!);
        const worker = async () => {
          while (chunks.length) { assertScope(scope); await read(chunks.shift()!); }
        };
        await Promise.all([worker(), worker()]);
      } catch (reason) {
        // A superseded request may settle after the next revision is already
        // visible. It can neither publish old bodies nor clear the new scope.
        if (ownsScope(scope)) discard(reason);
      }
    }
    async function check() {
      if (checking || lifetime.signal.aborted) return;
      checking = true;
      const verification = new AbortController();
      const abort = () => verification.abort(lifetime.signal.reason);
      lifetime.signal.addEventListener("abort", abort, { once: true });
      const timeout = window.setTimeout(() => verification.abort(new Error("공개 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")), 15_000);
      try {
        const manifest = await abortable(getPublishedWikiManifest(wikiId, verification.signal), verification.signal);
        lifetime.signal.throwIfAborted();
        const nextSignature = JSON.stringify(manifest);
        if (signature === nextSignature && current) return;
        contentScope?.abort();
        const scope = new AbortController();
        contentScope = scope;
        signature = nextSignature;
        current = { wikiId, manifest, contents: new Map(), signal: scope.signal };
        setData(current); setError("");
        // Revalidation must stay independent of even the first body request.
        // Unchanged manifests preserve the existing load rather than duplicate it.
        void loadContents(manifest, scope);
      } catch (reason) {
        if (!lifetime.signal.aborted) discard(reason);
      } finally {
        window.clearTimeout(timeout); lifetime.signal.removeEventListener("abort", abort); checking = false;
      }
    }
    const refresh = () => { if (document.visibilityState !== "hidden") void check(); };
    void check();
    const interval = window.setInterval(refresh, 45_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      lifetime.abort(); contentScope?.abort(); current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [wikiId, retry]);
  return { data: data?.wikiId === wikiId && !data.signal.aborted ? data : null, error };
}
