import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import { isSafeExternalHttpUrl, type MarkdownLinkReference } from "../markdown";
import {
  LivePreviewBlockWidget,
  type LivePreviewBlockRenderOptions
} from "./LivePreviewBlockWidget";

const refreshLivePreview = StateEffect.define<null>();
const complexPreviewComposition = StateEffect.define<boolean>();
export const LIVE_PREVIEW_LINK_OPEN_EVENT = "quickmemo:live-preview-link-open";
const HEADING_PATTERN = /^(\s{0,3})(#{1,6})(?:[\t ]+|$)/u;
const QUOTE_PATTERN = /^(\s{0,3})>(?:[\t ]?)/u;
const CALLOUT_PATTERN = /^\[!([^\]\s]+)\]([+-])?(?:[\t ]*)/u;
const TASK_PATTERN = /^(\s*(?:(?:[-+*])|(?:\d+[.)]))[\t ]+)\[([ xX])\](?=[\t ]|$)/u;
const TASK_SOURCE_PATTERN = /^\[[ xX]\]$/u;
const WIKI_LINK_PATTERN = /!?\[\[([^\]\n]+)\]\]/gu;
const STANDARD_LINK_PATTERN = /!?\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
const INLINE_CODE_PATTERN = /(`+)([^`\n]*?)\1/gu;
const STRONG_PATTERN = /(\*\*|__)(?=\S)(.+?\S)\1/gu;
const EMPHASIS_PATTERN = /([*_])(?=\S)(.+?\S)\1/gu;
const HIGHLIGHT_PATTERN = /(?<![\\=])==(?=\S)([^\n]*?\S)==(?![=])/gu;
const BLOCK_ID_PATTERN = /(?:^|[\t ])\^[A-Za-z0-9-]+[\t ]*$/u;
const TAG_PATTERN = /#[\p{L}\p{M}\p{N}_\-/]+/gu;
const TAG_BOUNDARY_PATTERN = /[\p{L}\p{M}\p{N}_]/u;
const NUMERIC_TAG_PATTERN = /^#\d+$/u;
const FENCE_START_PATTERN = /^\s{0,3}(`{3,}|~{3,})([^`]*)$/u;
const TABLE_DELIMITER_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;
const STANDALONE_EMBED_PATTERN = /^\s*!\[\[[^\]\n]+\]\]\s*$/u;
const STANDALONE_MARKDOWN_IMAGE_PATTERN = /^\s*!\[[^\]\n]*\]\([^)\n]+\)\s*$/u;
const MAXIMUM_COMPLEX_PREVIEW_CHARACTERS = 250_000;

interface ComplexBlockRange {
  firstLine: number;
  from: number;
  lastLine: number;
  source: string;
  to: number;
}

interface OccupiedRange {
  from: number;
  to: number;
}

function overlaps(ranges: readonly OccupiedRange[], from: number, to: number): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function selectedLineNumbers(view: EditorView): Set<number> {
  return selectedLineNumbersFromState(view.state);
}

function selectedLineNumbersFromState(state: EditorState): Set<number> {
  const result = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) {
      result.add(line);
    }
  }
  return result;
}

function isCodeBlockLine(view: EditorView, from: number, to: number): boolean {
  const position = Math.min(Math.max(from, to > from ? from + 1 : from), view.state.doc.length);
  let node = syntaxTree(view.state).resolveInner(position, 1);
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

function lineRangeSource(state: EditorState, firstLine: number, lastLine: number) {
  const first = state.doc.line(firstLine);
  const last = state.doc.line(lastLine);
  return {
    firstLine,
    from: first.from,
    lastLine,
    source: state.sliceDoc(first.from, last.to),
    to: last.to
  } satisfies ComplexBlockRange;
}

function selectedRangeIntersectsLines(activeLines: ReadonlySet<number>, first: number, last: number) {
  for (let line = first; line <= last; line += 1) {
    if (activeLines.has(line)) return true;
  }
  return false;
}

function collectComplexBlockRanges(state: EditorState, activeLines: ReadonlySet<number>): ComplexBlockRange[] {
  if (state.doc.length > MAXIMUM_COMPLEX_PREVIEW_CHARACTERS) return [];
  const ranges: ComplexBlockRange[] = [];
  const lines = state.doc.lines;
  let lineNumber = 1;
  while (lineNumber <= lines) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    const fence = FENCE_START_PATTERN.exec(text);
    if (fence) {
      const marker = fence[1];
      const closing = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`, "u");
      let end = lineNumber + 1;
      while (end <= lines && !closing.test(state.doc.line(end).text)) end += 1;
      if (end <= lines && !selectedRangeIntersectsLines(activeLines, lineNumber, end)) {
        ranges.push(lineRangeSource(state, lineNumber, end));
        lineNumber = end + 1;
        continue;
      }
    }

    if (text.trim() === "$$") {
      let end = lineNumber + 1;
      while (end <= lines && state.doc.line(end).text.trim() !== "$$") end += 1;
      if (end <= lines && !selectedRangeIntersectsLines(activeLines, lineNumber, end)) {
        ranges.push(lineRangeSource(state, lineNumber, end));
        lineNumber = end + 1;
        continue;
      }
    }

    if (
      lineNumber < lines
      && text.includes("|")
      && TABLE_DELIMITER_PATTERN.test(state.doc.line(lineNumber + 1).text)
    ) {
      let end = lineNumber + 2;
      while (end <= lines && state.doc.line(end).text.includes("|") && state.doc.line(end).text.trim()) end += 1;
      end -= 1;
      if (!selectedRangeIntersectsLines(activeLines, lineNumber, end)) {
        ranges.push(lineRangeSource(state, lineNumber, end));
        lineNumber = end + 1;
        continue;
      }
    }

    if (/^\s{0,3}>\s?\[![^\]\s]+\][+-]?/u.test(text)) {
      let end = lineNumber + 1;
      while (end <= lines && /^\s{0,3}>/u.test(state.doc.line(end).text)) end += 1;
      end -= 1;
      if (end > lineNumber && !selectedRangeIntersectsLines(activeLines, lineNumber, end)) {
        ranges.push(lineRangeSource(state, lineNumber, end));
        lineNumber = end + 1;
        continue;
      }
    }

    if (
      (STANDALONE_EMBED_PATTERN.test(text) || STANDALONE_MARKDOWN_IMAGE_PATTERN.test(text))
      && !activeLines.has(lineNumber)
    ) {
      ranges.push(lineRangeSource(state, lineNumber, lineNumber));
    }
    lineNumber += 1;
  }
  return ranges;
}

class PreviewTextWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly kind: "link" | "wikilink",
    private readonly target: string,
    private readonly raw: string,
    private readonly embed: boolean
  ) {
    super();
  }

  override eq(other: PreviewTextWidget): boolean {
    return other.text === this.text
      && other.kind === this.kind
      && other.target === this.target
      && other.raw === this.raw
      && other.embed === this.embed;
  }

  override toDOM(): HTMLElement {
    const external = this.kind === "link" && isSafeExternalHttpUrl(this.target);
    const element = document.createElement(external ? "a" : "span");
    element.className = this.kind === "wikilink" ? "cm-live-wikilink" : "cm-live-link";
    element.dataset.livePreviewDisplay = this.text;
    element.dataset.livePreviewEmbed = this.embed ? "true" : "false";
    element.dataset.livePreviewKind = this.kind;
    element.dataset.livePreviewRaw = this.raw;
    element.dataset.livePreviewTarget = this.target;
    element.textContent = this.text;
    element.title = this.kind === "wikilink" ? `내부 링크: ${this.target}` : `링크: ${this.target}`;
    if (external && element instanceof HTMLAnchorElement) {
      element.href = this.target;
      element.rel = "noopener noreferrer";
      element.target = "_blank";
    } else {
      element.setAttribute("role", "link");
      element.tabIndex = 0;
      element.addEventListener("keydown", (rawEvent) => {
        const event = rawEvent as KeyboardEvent;
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        element.dispatchEvent(new CustomEvent(LIVE_PREVIEW_LINK_OPEN_EVENT, {
          bubbles: true,
          detail: {
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey
          }
        }));
      });
    }
    return element;
  }

  override ignoreEvent(): boolean {
    // Let the editor-level delegated handlers provide Page Preview and
    // modifier/keyboard activation for this replacement widget.
    return false;
  }
}

export function livePreviewReferenceFromElement(element: Element | null): MarkdownLinkReference | null {
  const anchor = element?.closest<HTMLElement>("[data-live-preview-target]");
  if (!anchor) return null;
  const target = anchor.dataset.livePreviewTarget?.trim() ?? "";
  const display = anchor.dataset.livePreviewDisplay?.trim() || target;
  const raw = anchor.dataset.livePreviewRaw ?? target;
  const sourceKind = anchor.dataset.livePreviewKind;
  if (!target || (sourceKind !== "link" && sourceKind !== "wikilink")) return null;
  const hashIndex = target.indexOf("#");
  const path = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const subpath = hashIndex >= 0 ? target.slice(hashIndex) : null;
  const external = sourceKind === "link" && isSafeExternalHttpUrl(target);
  return {
    display,
    embed: anchor.dataset.livePreviewEmbed === "true",
    ...(external ? { href: target } : {}),
    kind: external ? "external" : sourceKind === "wikilink" ? "wikilink" : "markdown-internal",
    path,
    raw,
    subpath,
    target
  };
}

class CalloutMarkerWidget extends WidgetType {
  constructor(
    private readonly type: string,
    private readonly fold: string
  ) {
    super();
  }

  override eq(other: CalloutMarkerWidget): boolean {
    return other.type === this.type && other.fold === this.fold;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "cm-live-callout-marker";
    element.textContent = this.type.toLocaleUpperCase();
    element.setAttribute("aria-label", `콜아웃 ${this.type}${this.fold ? ` ${this.fold}` : ""}`);
    return element;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly checked: boolean,
    private readonly readOnly: boolean
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.from === this.from
      && other.checked === this.checked
      && other.readOnly === this.readOnly;
  }

  override toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement("input");
    checkbox.className = "cm-live-task-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.disabled = this.readOnly;
    checkbox.setAttribute("aria-label", this.checked ? "완료한 작업" : "완료하지 않은 작업");
    checkbox.addEventListener("change", () => {
      if (this.readOnly || view.state.readOnly || !TASK_SOURCE_PATTERN.test(view.state.sliceDoc(this.from, this.from + 3))) {
        checkbox.checked = this.checked;
        return;
      }
      view.dispatch({
        changes: {
          from: this.from + 1,
          to: this.from + 2,
          insert: checkbox.checked ? "x" : " "
        }
      });
      view.focus();
    });
    return checkbox;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type === "change" || event.type === "click" || event.type === "mousedown";
  }
}

function pushReplace(
  ranges: Array<Range<Decoration>>,
  from: number,
  to: number,
  widget?: WidgetType
): void {
  if (to <= from) return;
  ranges.push(Decoration.replace(widget ? { widget } : {}).range(from, to));
}

function decorateInactiveLine(
  view: EditorView,
  lineNumber: number,
  ranges: Array<Range<Decoration>>
): void {
  const line = view.state.doc.line(lineNumber);
  if (isCodeBlockLine(view, line.from, line.to)) return;

  const text = line.text;
  const occupied: OccupiedRange[] = [];
  const absolute = (offset: number) => line.from + offset;

  const heading = HEADING_PATTERN.exec(text);
  if (heading) {
    const level = heading[2].length;
    ranges.push(Decoration.line({ class: `cm-live-heading cm-live-heading-${level}` }).range(line.from));
    const markerFrom = absolute(heading[1].length);
    const markerTo = absolute(heading[0].length);
    pushReplace(ranges, markerFrom, markerTo);
    occupied.push({ from: markerFrom, to: markerTo });
  }

  const quote = QUOTE_PATTERN.exec(text);
  if (quote) {
    const quoteFrom = absolute(quote[1].length);
    const restOffset = quote[0].length;
    const callout = CALLOUT_PATTERN.exec(text.slice(restOffset));
    if (callout) {
      const markerTo = absolute(restOffset + callout[0].length);
      ranges.push(Decoration.line({ class: "cm-live-callout" }).range(line.from));
      pushReplace(
        ranges,
        quoteFrom,
        markerTo,
        new CalloutMarkerWidget(callout[1], callout[2] ?? "")
      );
      occupied.push({ from: quoteFrom, to: markerTo });
    } else {
      const markerTo = absolute(restOffset);
      ranges.push(Decoration.line({ class: "cm-live-blockquote" }).range(line.from));
      pushReplace(ranges, quoteFrom, markerTo);
      occupied.push({ from: quoteFrom, to: markerTo });
    }
  }

  const task = TASK_PATTERN.exec(text);
  if (task) {
    const checkboxOffset = task[1].length;
    const checkboxFrom = absolute(checkboxOffset);
    const checked = task[2].toLocaleLowerCase() === "x";
    ranges.push(Decoration.line({ class: checked ? "cm-live-task cm-live-task-complete" : "cm-live-task" }).range(line.from));
    pushReplace(
      ranges,
      checkboxFrom,
      checkboxFrom + 3,
      new TaskCheckboxWidget(checkboxFrom, checked, view.state.readOnly)
    );
    occupied.push({ from: checkboxFrom, to: checkboxFrom + 3 });
  }

  for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
    const offset = match.index;
    const from = absolute(offset);
    const to = from + match[0].length;
    if (overlaps(occupied, from, to)) continue;
    const [targetPart, aliasPart] = match[1].split("|", 2);
    const target = targetPart.trim();
    const label = (aliasPart ?? target).trim() || target;
    pushReplace(ranges, from, to, new PreviewTextWidget(label, "wikilink", target, match[0], match[0].startsWith("!")));
    occupied.push({ from, to });
  }

  for (const match of text.matchAll(STANDARD_LINK_PATTERN)) {
    const offset = match.index;
    const from = absolute(offset);
    const to = from + match[0].length;
    if (overlaps(occupied, from, to)) continue;
    pushReplace(ranges, from, to, new PreviewTextWidget(
      match[1],
      "link",
      match[2].trim(),
      match[0],
      match[0].startsWith("!")
    ));
    occupied.push({ from, to });
  }

  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    const offset = match.index;
    const from = absolute(offset);
    const to = from + match[0].length;
    if (overlaps(occupied, from, to)) continue;
    const markerSize = match[1].length;
    pushReplace(ranges, from, from + markerSize);
    pushReplace(ranges, to - markerSize, to);
    ranges.push(Decoration.mark({ class: "cm-live-inline-code" }).range(from + markerSize, to - markerSize));
    occupied.push({ from, to });
  }

  const blockId = text.match(BLOCK_ID_PATTERN);
  if (blockId) {
    const from = absolute(blockId.index ?? 0);
    const to = from + blockId[0].length;
    if (!overlaps(occupied, from, to)) {
      pushReplace(ranges, from, to);
      occupied.push({ from, to });
    }
  }

  for (const match of text.matchAll(HIGHLIGHT_PATTERN)) {
    const from = absolute(match.index);
    const to = from + match[0].length;
    // Existing code/link widgets own their source markers. Nested emphasis or
    // a link inside a highlight may still render without obscuring its target.
    if (overlaps(occupied, from, from + 2) || overlaps(occupied, to - 2, to)) continue;
    pushReplace(ranges, from, from + 2);
    pushReplace(ranges, to - 2, to);
    ranges.push(Decoration.mark({ class: "cm-live-highlight" }).range(from + 2, to - 2));
    occupied.push({ from, to: from + 2 }, { from: to - 2, to });
  }

  for (const match of text.matchAll(STRONG_PATTERN)) {
    const offset = match.index;
    const from = absolute(offset);
    const to = from + match[0].length;
    if (overlaps(occupied, from, to)) continue;
    const markerSize = match[1].length;
    pushReplace(ranges, from, from + markerSize);
    pushReplace(ranges, to - markerSize, to);
    ranges.push(Decoration.mark({ class: "cm-live-strong" }).range(from + markerSize, to - markerSize));
    occupied.push({ from, to });
  }

  for (const match of text.matchAll(EMPHASIS_PATTERN)) {
    const offset = match.index;
    const from = absolute(offset);
    const to = from + match[0].length;
    if (overlaps(occupied, from, to)) continue;
    pushReplace(ranges, from, from + 1);
    pushReplace(ranges, to - 1, to);
    ranges.push(Decoration.mark({ class: "cm-live-emphasis" }).range(from + 1, to - 1));
    occupied.push({ from, to });
  }

  for (const match of text.matchAll(TAG_PATTERN)) {
    const offset = match.index;
    const previous = offset > 0 ? text[offset - 1] : "";
    if (previous && TAG_BOUNDARY_PATTERN.test(previous)) continue;
    const from = absolute(offset);
    const to = from + match[0].length;
    if (overlaps(occupied, from, to) || NUMERIC_TAG_PATTERN.test(match[0])) continue;
    ranges.push(Decoration.mark({ class: "cm-live-tag" }).range(from, to));
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = [];
  const activeLines = selectedLineNumbers(view);
  const visited = new Set<number>();
  const complexBlocks = collectComplexBlockRanges(view.state, activeLines);
  const complexLines = new Set<number>();
  for (const block of complexBlocks) {
    for (let line = block.firstLine; line <= block.lastLine; line += 1) complexLines.add(line);
  }

  for (const visible of view.visibleRanges) {
    let line = view.state.doc.lineAt(visible.from);
    while (line.from <= visible.to) {
      if (!visited.has(line.number) && !activeLines.has(line.number) && !complexLines.has(line.number)) {
        visited.add(line.number);
        decorateInactiveLine(view, line.number, ranges);
      }
      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }

  return Decoration.set(ranges, true);
}

class InlineLivePreviewView {
  decorations: DecorationSet;
  private composing = false;

  constructor(
    private readonly view: EditorView
  ) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    const refreshRequested = update.transactions.some((transaction) => (
      transaction.effects.some((effect) => effect.is(refreshLivePreview))
    ));
    if (this.composing) {
      if (this.decorations.size > 0) this.decorations = Decoration.none;
      return;
    }
    if (
      refreshRequested
      || update.docChanged
      || update.selectionSet
      || update.viewportChanged
      || update.focusChanged
      || update.startState.readOnly !== update.state.readOnly
    ) {
      this.decorations = buildDecorations(update.view);
    }
  }

  setComposing(composing: boolean): void {
    if (this.composing === composing) return;
    this.composing = composing;
    this.view.dispatch({ effects: refreshLivePreview.of(null) });
  }
}

/**
 * CodeMirror-only inline preview. Decorations never alter the Markdown document:
 * the selected line is always raw source and IME composition temporarily removes
 * every replacement widget before CodeMirror handles the composed input.
 */
export function inlineLivePreview(options: LivePreviewBlockRenderOptions = {}): Extension {
  const complexBlocks = StateField.define<{
    composing: boolean;
    decorations: DecorationSet;
  }>({
    create(state) {
      const activeLines = selectedLineNumbersFromState(state);
      return {
        composing: false,
        decorations: Decoration.set(collectComplexBlockRanges(state, activeLines).map((block) => (
          Decoration.replace({
            block: true,
            widget: new LivePreviewBlockWidget(block.source, options)
          }).range(block.from, block.to)
        )), true)
      };
    },
    update(current, transaction) {
      const composition = transaction.effects.find((effect) => effect.is(complexPreviewComposition));
      const composing = composition?.value ?? current.composing;
      if (composing) return { composing, decorations: Decoration.none };
      if (!transaction.docChanged && !transaction.selection) return current;
      const activeLines = selectedLineNumbersFromState(transaction.state);
      return {
        composing,
        decorations: Decoration.set(collectComplexBlockRanges(transaction.state, activeLines).map((block) => (
          Decoration.replace({
            block: true,
            widget: new LivePreviewBlockWidget(block.source, options)
          }).range(block.from, block.to)
        )), true)
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
  });
  const plugin = ViewPlugin.define((view) => new InlineLivePreviewView(view), {
    decorations: (value) => value.decorations,
    eventHandlers: {
      compositionstart: (_event, view) => {
        view.dispatch({ effects: complexPreviewComposition.of(true) });
        view.plugin(plugin)?.setComposing(true);
        return false;
      },
      compositionend: (_event, view) => {
        view.dispatch({ effects: complexPreviewComposition.of(false) });
        view.plugin(plugin)?.setComposing(false);
        return false;
      }
    }
  });
  return [complexBlocks, plugin];
}
