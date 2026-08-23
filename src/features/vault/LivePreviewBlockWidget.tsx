import { WidgetType } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import {
  MarkdownRenderer,
  type MarkdownRendererProps
} from "../markdown";

const roots = new WeakMap<HTMLElement, Root>();

export type LivePreviewBlockRenderOptions = Pick<
  MarkdownRendererProps,
  "onLinkClick" | "onLinkPreviewInteraction" | "onTagClick" | "renderCodeBlock" | "renderEmbed"
>;

/**
 * Renders an inactive, complete Markdown block without ever mutating its source.
 * CodeMirror owns the host lifetime; React is explicitly unmounted on destroy so
 * Mermaid, embeds and preview subscriptions cannot leak after scrolling/editing.
 */
export class LivePreviewBlockWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly options: LivePreviewBlockRenderOptions
  ) {
    super();
  }

  override eq(other: LivePreviewBlockWidget): boolean {
    return other.source === this.source
      && other.options.onLinkClick === this.options.onLinkClick
      && other.options.onLinkPreviewInteraction === this.options.onLinkPreviewInteraction
      && other.options.onTagClick === this.options.onTagClick
      && other.options.renderCodeBlock === this.options.renderCodeBlock
      && other.options.renderEmbed === this.options.renderEmbed;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-live-complex-block";
    host.contentEditable = "false";
    const root = createRoot(host);
    roots.set(host, root);
    root.render(
      <MarkdownRenderer
        {...this.options}
        className="cm-live-complex-block__content"
        emptyText="빈 블록"
        source={this.source}
      />
    );
    return host;
  }

  override destroy(dom: HTMLElement): void {
    const root = roots.get(dom);
    roots.delete(dom);
    // CodeMirror may remove a widget during React's current event. Queueing the
    // unmount avoids a synchronous nested-root warning while still releasing it.
    queueMicrotask(() => root?.unmount());
  }

  override ignoreEvent(): boolean {
    return false;
  }
}
