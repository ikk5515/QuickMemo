import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownRenderer } from "../../markdown";
import { createMarkdownSlidesDeck } from "./slides";
import "./core.css";

export interface VaultSlidesProps {
  onClose?: () => void;
  source: string;
  title: string;
}
export function VaultSlides({ onClose, source, title }: VaultSlidesProps) {
  const deck = useMemo(() => createMarkdownSlidesDeck(source, title), [source, title]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => setActiveIndex(0), [source]);

  function move(offset: number) {
    setActiveIndex((current) => Math.max(0, Math.min(deck.slides.length - 1, current + offset)));
  }

  function stopPresenting() {
    setPresenting(false);
    onClose?.();
  }

  return (
    <section
      aria-label={`${deck.title} 슬라이드`}
      className={`vault-slides${presenting ? " vault-slides--presenting" : ""}`}
      onKeyDown={(event) => {
        if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
          event.preventDefault();
          move(1);
        } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Home") {
          event.preventDefault();
          setActiveIndex(0);
        } else if (event.key === "End") {
          event.preventDefault();
          setActiveIndex(deck.slides.length - 1);
        } else if (event.key === "Escape" && presenting) {
          event.preventDefault();
          stopPresenting();
        }
      }}
      ref={frameRef}
      tabIndex={0}
    >
      <header>
        <strong>{deck.title}</strong>
        <div>
          {!presenting ? (
            <button aria-label="프레젠테이션 시작" onClick={() => { setPresenting(true); window.setTimeout(() => frameRef.current?.focus(), 0); }} type="button">
              <Maximize2 aria-hidden="true" size={15} />
            </button>
          ) : null}
          {presenting ? <button aria-label="프레젠테이션 닫기" onClick={stopPresenting} type="button"><X aria-hidden="true" size={16} /></button> : null}
        </div>
      </header>
      <article className="vault-slides__stage">
        <MarkdownRenderer source={deck.slides[activeIndex]?.source ?? ""} />
      </article>
      <footer>
        <button aria-label="이전 슬라이드" disabled={activeIndex === 0} onClick={() => move(-1)} type="button"><ChevronLeft aria-hidden="true" size={16} /></button>
        <output aria-live="polite">{activeIndex + 1} / {deck.slides.length}</output>
        <button aria-label="다음 슬라이드" disabled={activeIndex >= deck.slides.length - 1} onClick={() => move(1)} type="button"><ChevronRight aria-hidden="true" size={16} /></button>
      </footer>
    </section>
  );
}
