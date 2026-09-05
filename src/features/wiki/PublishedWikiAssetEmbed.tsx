import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultIndexEntry } from "../knowledge/types";
import type { MarkdownLinkReference } from "../markdown/types";
import { VaultAssetPreview } from "../vault/VaultAssetPreview";
import type { DecodedVaultAsset } from "../vault/vaultAsset";
import type { PublishedWikiAssetReader } from "./publishedWikiAssetReader";

export function PublishedWikiAssetEmbed({ reader, reference, sourceEntry }: {
  reader: PublishedWikiAssetReader | null;
  reference: MarkdownLinkReference;
  sourceEntry: VaultIndexEntry;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{ id: string; reader: PublishedWikiAssetReader; asset: DecodedVaultAsset } | null>(null);
  const [failure, setFailure] = useState<{ id: string; reader: PublishedWikiAssetReader } | null>(null);
  const assetEntry = useMemo(() => reader?.resolve(reference, sourceEntry) ?? null, [reader, reference, sourceEntry]);
  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "240px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !assetEntry || !reader || reader.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => { controller.abort(); setLoaded(null); };
    reader.signal.addEventListener("abort", abort, { once: true });
    setFailure(null);
    void reader.load(assetEntry.id, controller.signal).then((asset) => {
      if (!controller.signal.aborted && !reader.signal.aborted) setLoaded({ id: assetEntry.id, reader, asset });
    }).catch(() => { if (!controller.signal.aborted) setFailure({ id: assetEntry.id, reader }); });
    return () => { controller.abort(); reader.signal.removeEventListener("abort", abort); };
  }, [assetEntry, reader, visible]);
  const current = loaded?.reader === reader && loaded?.id === assetEntry?.id && reader && !reader.signal.aborted ? loaded.asset : null;
  const failed = failure?.reader === reader && failure?.id === assetEntry?.id;
  return <span className="wiki-asset-embed" ref={root}>{current && assetEntry
    ? <VaultAssetPreview asset={current} compact fileName={assetEntry.title} inlineEmbed={{ label: assetEntry.title, onOpen: () => undefined }} />
    : <span className="wiki-asset-placeholder">{reader && (!assetEntry || failed) ? "공개되지 않은 이미지" : "이미지 불러오는 중…"}</span>}</span>;
}
