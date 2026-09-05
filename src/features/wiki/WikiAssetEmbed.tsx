import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { VaultIndexEntry } from "../knowledge/types";
import type { MarkdownLinkClickHandler, MarkdownLinkReference } from "../markdown/types";
import { VaultAssetPreview } from "../vault/VaultAssetPreview";
import { safeVaultAssetPreviewKind, type DecodedVaultAsset } from "../vault/vaultAsset";
import { WikiAssetReader, type WikiAssetReaderOptions } from "./wikiAssetReader";

/** Effect-owned construction remains valid through React StrictMode replay. */
export function useWikiAssetReader(options: WikiAssetReaderOptions | null) {
  const { uid, privateKey, session, snapshots, folders } = options ?? {};
  const [state, setState] = useState<{ options: WikiAssetReaderOptions; reader: WikiAssetReader } | null>(null);
  useEffect(() => {
    if (!uid || !privateKey || !session || !snapshots || !folders) return;
    const current = { uid, privateKey, session, snapshots, folders };
    const reader = new WikiAssetReader(current);
    setState({ options: current, reader });
    return reader.dispose;
  }, [uid, privateKey, session, snapshots, folders]);
  return state && state.options.uid === uid && state.options.privateKey === privateKey && state.options.session === session
    && state.options.snapshots === snapshots && state.options.folders === folders && !state.reader.signal.aborted
    ? state.reader : null;
}

export function WikiAssetEmbed({ reader, reference, sourceEntry, onLinkClick }: {
  reader: WikiAssetReader | null;
  reference: MarkdownLinkReference;
  sourceEntry: Pick<VaultIndexEntry, "id" | "path">;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const identity = JSON.stringify([reference.kind, reference.path, reference.raw, sourceEntry.id, sourceEntry.path]);
  const [result, setResult] = useState<{
    reader: WikiAssetReader; identity: string; id: string; fileName: string; asset: DecodedVaultAsset | null;
  } | null>(null);
  const inputs = useRef({ reference, sourceEntry });
  useEffect(() => { inputs.current = { reference, sourceEntry }; }, [reference, sourceEntry]);

  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!reader || !visible || reader.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => { controller.abort(); setResult(null); };
    reader.signal.addEventListener("abort", abort, { once: true });
    const current = inputs.current;
    void reader.resolve(current.reference, current.sourceEntry, controller.signal).then(async (resolved) => {
      if (!resolved || controller.signal.aborted) return;
      const asset = await reader.load(resolved, controller.signal);
      if (!controller.signal.aborted) setResult({ reader, identity, id: resolved.id, fileName: resolved.fileName, asset });
    }).catch(() => { if (!controller.signal.aborted) setResult(null); });
    return () => { controller.abort(); reader.signal.removeEventListener("abort", abort); };
  }, [identity, reader, visible]);

  const current = result?.reader === reader && result.identity === identity && !reader?.signal.aborted ? result : null;
  return <span className="wiki-asset-embed" ref={root}>
    {current?.asset && safeVaultAssetPreviewKind(current.asset) === "image"
      ? <VaultAssetPreview asset={current.asset} compact fileName={current.fileName} inlineEmbed={{ label: current.fileName, onOpen: () => undefined }} />
      : current ? <Link className="wiki-asset-fallback" to={`/app?entry=${encodeURIComponent(current.id)}`}><span>{current.fileName}</span><small>메모에서 파일 보기</small></Link>
        : onLinkClick ? <button className="qm-markdown-link qm-markdown-embed-link wiki-asset-placeholder" onClick={(event) => onLinkClick(reference, event)} type="button">{reference.display}</button>
          : <span className="wiki-asset-placeholder">{reference.display}</span>}
  </span>;
}
