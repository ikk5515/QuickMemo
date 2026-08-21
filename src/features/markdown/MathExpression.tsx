import { useEffect, useRef } from "react";
import "katex/dist/katex.min.css";

const maximumMathCharacters = 20_000;
let katexModulePromise: Promise<typeof import("katex")> | null = null;

function loadKatex() {
  katexModulePromise ??= import("katex");
  return katexModulePromise;
}

export interface MathExpressionProps {
  source: string;
  display?: boolean;
}

export function MathExpression({ source, display = false }: MathExpressionProps) {
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let active = true;
    container.replaceChildren(document.createTextNode(source));
    if (!source.trim() || source.length > maximumMathCharacters) {
      return;
    }

    void loadKatex().then(({ default: katex }) => {
      if (!active || containerRef.current !== container) {
        return;
      }
      container.replaceChildren();
      katex.render(source, container, {
        displayMode: display,
        output: "htmlAndMathml",
        throwOnError: false,
        trust: false,
        strict: "error",
        maxExpand: 1_000,
        maxSize: 20
      });
    }).catch(() => {
      if (active && containerRef.current === container) {
        container.replaceChildren(document.createTextNode(source));
      }
    });

    return () => {
      active = false;
    };
  }, [display, source]);

  return (
    <span
      ref={containerRef}
      aria-label={display ? `수식 블록: ${source}` : `인라인 수식: ${source}`}
      className={display ? "qm-markdown-math qm-markdown-math--display" : "qm-markdown-math"}
      data-math-source={source}
      role="math"
    />
  );
}
