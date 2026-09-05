import { WidgetType } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LivePreviewUpdates } from "./livePreviewUpdates";
import {
  MarkdownRenderer,
  type MarkdownRendererProps
} from "../markdown";

const roots = new WeakMap<HTMLElement, Root>();

export type LivePreviewBlockRenderOptions = Pick<
  MarkdownRendererProps,
  "onLinkClick" | "onLinkPreviewInteraction" | "onTagClick" | "renderCodeBlock" | "renderEmbed"
> & { updates?: LivePreviewUpdates };

const subscribeToStaticPreview = () => () => undefined;
const staticPreviewSnapshot = () => 0;

function LivePreviewBlock({ source, options }: { source: string; options: LivePreviewBlockRenderOptions }) {
  const { updates, ...renderOptions } = options;
  useSyncExternalStore(
    updates?.subscribe ?? subscribeToStaticPreview,
    updates?.getSnapshot ?? staticPreviewSnapshot,
    staticPreviewSnapshot
  );
  return <MarkdownRenderer
    {...renderOptions}
    className="cm-live-complex-block__content"
    emptyText="빈 블록"
    source={source}
  />;
}

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
      && other.options.renderEmbed === this.options.renderEmbed
      && other.options.updates === this.options.updates;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-live-complex-block";
    host.contentEditable = "false";
    const root = createRoot(host);
    roots.set(host, root);
    root.render(
      <LivePreviewBlock options={this.options} source={this.source} />
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
