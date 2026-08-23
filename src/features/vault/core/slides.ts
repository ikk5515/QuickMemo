import { normalizeMarkdownLineEndings } from "../../markdown";

export const MAX_SLIDES_PER_DECK = 200;
export const MAX_SLIDES_SOURCE_CHARACTERS = 1_000_000;

export interface MarkdownSlide {
  index: number;
  source: string;
}
export interface MarkdownSlidesDeck {
  slides: MarkdownSlide[];
  title: string;
}

function stripLeadingFrontmatter(lines: string[]) {
  if (lines[0] !== "---") return lines;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      return lines.slice(index + 1);
    }
  }
  return lines;
}

/** Splits on Obsidian's `---` slide marker, never inside YAML or code fences. */
export function createMarkdownSlidesDeck(source: string, title = "슬라이드") {
  if (source.length > MAX_SLIDES_SOURCE_CHARACTERS) {
    throw new Error("슬라이드 원본은 1,000,000자 이하만 열 수 있습니다.");
  }
  const lines = stripLeadingFrontmatter(normalizeMarkdownLineEndings(source).split("\n"));
  const slides: string[][] = [[]];
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      slides.at(-1)!.push(line);
      const closing = line.match(/^\s{0,3}(`+|~+)\s*$/u);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      slides.at(-1)!.push(line);
      continue;
    }
    if (/^\s{0,3}---\s*$/u.test(line)) {
      if (slides.length >= MAX_SLIDES_PER_DECK) {
        throw new Error(`슬라이드는 최대 ${MAX_SLIDES_PER_DECK}장까지 열 수 있습니다.`);
      }
      slides.push([]);
      continue;
    }
    slides.at(-1)!.push(line);
  }
  const normalizedSlides = slides
    .map((linesForSlide) => linesForSlide.join("\n").trim())
    .filter((slide, index, all) => slide || (all.length === 1 && index === 0));
  return {
    slides: (normalizedSlides.length ? normalizedSlides : [""]).map((slideSource, index) => ({
      index,
      source: slideSource
    })),
    title: title.trim().slice(0, 180) || "슬라이드"
  } satisfies MarkdownSlidesDeck;
}
