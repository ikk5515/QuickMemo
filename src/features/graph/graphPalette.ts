import { useLayoutEffect, useState, type RefObject } from "react";

interface GraphPalette {
  accent: string;
  node: string;
  text: string;
}

const DEFAULT_PALETTE: GraphPalette = {
  accent: "#8b82f6",
  node: "#aaa5b7",
  text: "#eceaf2"
};

export function graphColorWithAlpha(color: string, alpha: number): string {
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const longHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color);
  const channels = shortHex
    ? shortHex.slice(1).map((value) => Number.parseInt(`${value}${value}`, 16))
    : longHex
      ? longHex.slice(1).map((value) => Number.parseInt(value, 16))
      : rgb?.slice(1).map(Number);
  return channels ? `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})` : color;
}

/** Read theme colors only on mount/theme changes, never inside a Canvas frame. */
export function useGraphPalette(hostRef: RefObject<HTMLDivElement | null>): GraphPalette {
  const [palette, setPalette] = useState(DEFAULT_PALETTE);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const refresh = () => {
      const style = window.getComputedStyle(host);
      const next = {
        accent: style.getPropertyValue("--qm-graph-accent").trim() || DEFAULT_PALETTE.accent,
        node: style.getPropertyValue("--qm-graph-node").trim() || DEFAULT_PALETTE.node,
        text: style.getPropertyValue("--qm-graph-text").trim() || DEFAULT_PALETTE.text
      };
      setPalette((current) => current.accent === next.accent && current.node === next.node && current.text === next.text
        ? current
        : next);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"]
    });
    return () => observer.disconnect();
  }, [hostRef]);
  return palette;
}
