import { useEffect, useId, useState } from "react";

const maximumMermaidCharacters = 100_000;
const maximumMermaidSvgCharacters = 2_000_000;
const unsafeSvgElements = [
  "script",
  "foreignObject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
  "image",
  "feImage",
  "animate",
  "animateMotion",
  "animateTransform",
  "set"
].join(",");

let mermaidModulePromise: Promise<Awaited<typeof import("mermaid")>["default"]> | null = null;

function loadMermaid() {
  mermaidModulePromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      flowchart: { htmlLabels: false }
    });
    return mermaid;
  });
  return mermaidModulePromise;
}

export function sanitizeMermaidSvg(svg: string) {
  if (!svg || svg.length > maximumMermaidSvgCharacters) {
    throw new Error("invalid-mermaid-svg");
  }

  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    throw new Error("invalid-mermaid-svg");
  }

  parsed.querySelectorAll(unsafeSvgElements).forEach((element) => element.remove());
  parsed.querySelectorAll("a").forEach((anchor) => {
    const parent = anchor.parentNode;
    if (!parent) {
      return;
    }
    while (anchor.firstChild) {
      parent.insertBefore(anchor.firstChild, anchor);
    }
    anchor.remove();
  });

  parsed.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href" || name === "src") {
        if (!value.startsWith("#")) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }
      if (/javascript\s*:|data\s*:/iu.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (hasUnsafeCss(value)) {
        if (element.localName === "style") {
          element.remove();
          break;
        }
        element.removeAttribute(attribute.name);
      }
    }
  });

  parsed.querySelectorAll("style").forEach((style) => {
    if (hasUnsafeCss(style.textContent ?? "")) {
      style.remove();
    }
  });

  return new XMLSerializer().serializeToString(root);
}

function hasUnsafeCss(value: string) {
  if (/@import|expression\s*\(|-moz-binding/iu.test(value)) {
    return true;
  }
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/giu)) {
    const target = match[1].trim().replace(/^["']|["']$/g, "");
    if (!target.startsWith("#")) {
      return true;
    }
  }
  return false;
}

export interface MermaidDiagramProps {
  source: string;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const reactId = useId();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setImageUrl(null);
    setFailed(false);

    if (!source.trim() || source.length > maximumMermaidCharacters) {
      setFailed(true);
      return;
    }

    const renderId = `qm-mermaid-${reactId.replace(/[^a-z0-9_-]/giu, "")}`;
    void loadMermaid()
      .then((mermaid) => mermaid.render(renderId, source))
      .then(({ svg }) => {
        if (!active) {
          return;
        }
        const safeSvg = sanitizeMermaidSvg(svg);
        if (typeof URL.createObjectURL !== "function") {
          throw new Error("object-url-unavailable");
        }
        objectUrl = URL.createObjectURL(new Blob([safeSvg], { type: "image/svg+xml" }));
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [reactId, source]);

  return (
    <figure className="qm-markdown-mermaid" aria-label="Mermaid 다이어그램">
      {imageUrl ? (
        <img alt="Mermaid 다이어그램" draggable={false} src={imageUrl} />
      ) : (
        <p aria-live="polite" className="qm-markdown-mermaid-status" role="status">
          {failed ? "다이어그램을 표시할 수 없습니다." : "다이어그램 렌더링 중…"}
        </p>
      )}
      <details>
        <summary>Mermaid 원본 보기</summary>
        <pre className="qm-markdown-code-block"><code data-language="mermaid">{source}</code></pre>
      </details>
    </figure>
  );
}
