import {
  Fragment,
  createElement,
  useDeferredValue,
  useId,
  useMemo,
  type FocusEventHandler,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode
} from "react";
import { MathExpression } from "./MathExpression";
import { MermaidDiagram } from "./MermaidDiagram";
import { tokenizeMarkdown } from "./parser";
import type {
  MarkdownBlock,
  MarkdownFootnote,
  MarkdownInlineToken,
  MarkdownLinkClickHandler,
  MarkdownLinkPreviewHandler,
  MarkdownLinkReference,
  MarkdownTagClickHandler
} from "./types";
import "./markdown.css";

const maximumRenderedMarkdownCharacters = 1_000_000;
export const MAX_DATAVIEW_BLOCKS_PER_DOCUMENT = 8;

function safelyTokenizeMarkdown(source: string) {
  try {
    return tokenizeMarkdown(source);
  } catch {
    return null;
  }
}

export interface MarkdownRendererProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "dangerouslySetInnerHTML"> {
  source: string;
  emptyText?: string;
  onLinkClick?: MarkdownLinkClickHandler;
  onLinkPreviewInteraction?: MarkdownLinkPreviewHandler;
  onTagClick?: MarkdownTagClickHandler;
  renderCodeBlock?: (language: string, source: string) => ReactNode | undefined;
  renderEmbed?: (reference: MarkdownLinkReference) => ReactNode;
}

interface InlineRenderOptions {
  onLinkClick?: MarkdownLinkClickHandler;
  onLinkPreviewInteraction?: MarkdownLinkPreviewHandler;
  onTagClick?: MarkdownTagClickHandler;
  renderCodeBlock?: (language: string, source: string) => ReactNode | undefined;
  renderEmbed?: (reference: MarkdownLinkReference) => ReactNode;
  footnotePrefix: string;
  dataviewBlocksRendered: number;
}

export function MarkdownRenderer({
  source,
  emptyText = "내용 없음",
  className = "",
  onLinkClick,
  onLinkPreviewInteraction,
  onTagClick,
  renderCodeBlock,
  renderEmbed,
  ...attributes
}: MarkdownRendererProps) {
  const reactId = useId();
  const deferredSource = useDeferredValue(source);
  const document = useMemo(
    () => deferredSource.length <= maximumRenderedMarkdownCharacters
      ? safelyTokenizeMarkdown(deferredSource)
      : null,
    [deferredSource]
  );
  const options = {
    onLinkClick,
    onLinkPreviewInteraction,
    onTagClick,
    renderCodeBlock,
    renderEmbed,
    footnotePrefix: `qm-markdown-${reactId.replace(/[^a-z0-9_-]/giu, "")}`,
    dataviewBlocksRendered: 0
  };

  return (
    <div
      {...attributes}
      className={["qm-markdown-renderer", className].filter(Boolean).join(" ")}
    >
      {!document || !document.blocks.length
        ? <p className="qm-markdown-empty">{emptyText}</p>
        : document.blocks.map((block, index) => renderBlock(block, `block-${index}`, options))}
      {document && document.footnotes.length > 0 && renderFootnotes(document.footnotes, options)}
    </div>
  );
}

interface InternalLinkPreviewBindings {
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
}

function internalLinkPreviewBindings(
  reference: MarkdownLinkReference,
  handler: MarkdownLinkPreviewHandler | undefined
): InternalLinkPreviewBindings {
  if (!handler || reference.kind === "external") {
    return {};
  }
  return {
    onBlur: (event) => handler(reference, {
      active: false,
      anchor: event.currentTarget,
      source: "focus"
    }),
    onFocus: (event) => handler(reference, {
      active: true,
      anchor: event.currentTarget,
      source: "focus"
    }),
    onMouseEnter: (event) => handler(reference, {
      active: true,
      anchor: event.currentTarget,
      source: "pointer"
    }),
    onMouseLeave: (event) => handler(reference, {
      active: false,
      anchor: event.currentTarget,
      source: "pointer"
    })
  };
}

function renderBlock(block: MarkdownBlock, key: string, options: InlineRenderOptions): ReactNode {
  switch (block.type) {
    case "heading":
      return createElement(
        `h${block.level}`,
        { key, id: headingId(inlinePlainText(block.children)) },
        renderInline(block.children, `${key}-inline`, options)
      );
    case "paragraph":
      return (
        <p key={key} className="qm-markdown-paragraph">
          {renderInline(block.children, `${key}-inline`, options)}
        </p>
      );
    case "code-block":
      if (block.language.trim().toLocaleLowerCase() === "dataview") {
        if (options.dataviewBlocksRendered >= MAX_DATAVIEW_BLOCKS_PER_DOCUMENT) {
          return (
            <aside key={key} className="qm-markdown-dataview-budget" role="status">
              <strong>Dataview 실행 한도에 도달했습니다.</strong>
              <p>문서당 Dataview 블록은 {MAX_DATAVIEW_BLOCKS_PER_DOCUMENT}개까지만 실행합니다.</p>
              <pre className="qm-markdown-code-block">
                <code data-language={block.language || undefined}>{block.value}</code>
              </pre>
            </aside>
          );
        }
        options.dataviewBlocksRendered += 1;
      }
      if (options.renderCodeBlock) {
        const custom = options.renderCodeBlock(block.language, block.value);
        if (custom !== undefined) {
          return <Fragment key={key}>{custom}</Fragment>;
        }
      }
      if (block.language.toLocaleLowerCase() === "mermaid") {
        return <MermaidDiagram key={key} source={block.value} />;
      }
      return (
        <pre key={key} className="qm-markdown-code-block">
          <code data-language={block.language || undefined}>{block.value}</code>
        </pre>
      );
    case "math-block":
      return (
        <div key={key} className="qm-markdown-math-block">
          <MathExpression display source={block.value} />
        </div>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List key={key} start={block.ordered ? block.start : undefined}>
          {block.items.map((item, itemIndex) => (
            <li
              key={`${key}-item-${itemIndex}`}
              className={item.checked === null ? undefined : "qm-markdown-task"}
            >
              {item.checked !== null && (
                <input
                  aria-label={item.checked ? "완료된 작업" : "미완료 작업"}
                  checked={item.checked}
                  disabled
                  type="checkbox"
                />
              )}
              <span>{renderInline(item.children, `${key}-item-${itemIndex}`, options)}</span>
            </li>
          ))}
        </List>
      );
    }
    case "quote":
      return (
        <blockquote key={key}>
          {block.blocks.map((child, childIndex) =>
            renderBlock(child, `${key}-quote-${childIndex}`, options)
          )}
        </blockquote>
      );
    case "callout": {
      const title = renderInline(block.title, `${key}-title`, options);
      const content = block.blocks.map((child, childIndex) =>
        renderBlock(child, `${key}-callout-${childIndex}`, options)
      );
      if (block.foldable) {
        return (
          <details
            key={key}
            className="qm-markdown-callout qm-markdown-callout--foldable"
            data-callout={block.calloutType}
            open={block.open}
          >
            <summary className="qm-markdown-callout-title">{title}</summary>
            <div className="qm-markdown-callout-content">{content}</div>
          </details>
        );
      }
      return (
        <aside
          key={key}
          aria-label={inlinePlainText(block.title)}
          className="qm-markdown-callout"
          data-callout={block.calloutType}
        >
          <div className="qm-markdown-callout-title">{title}</div>
          <div className="qm-markdown-callout-content">{content}</div>
        </aside>
      );
    }
    case "table":
      return (
        <div key={key} className="qm-markdown-table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th
                    key={`${key}-head-${cellIndex}`}
                    style={{ textAlign: block.alignments[cellIndex] ?? undefined }}
                  >
                    {renderInline(cell.children, `${key}-head-${cellIndex}`, options)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-row-${rowIndex}-${cellIndex}`}
                      style={{ textAlign: block.alignments[cellIndex] ?? undefined }}
                    >
                      {renderInline(
                        cell.children,
                        `${key}-row-${rowIndex}-${cellIndex}`,
                        options
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "thematic-break":
      return <hr key={key} />;
    case "frontmatter":
      return (
        <details key={key} className="qm-markdown-frontmatter">
          <summary>속성</summary>
          <pre><code>{block.value}</code></pre>
        </details>
      );
  }
}

function renderInline(
  tokens: MarkdownInlineToken[],
  keyPrefix: string,
  options: InlineRenderOptions
): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "text":
        return <Fragment key={key}>{token.value}</Fragment>;
      case "line-break":
        return <br key={key} />;
      case "code":
        return <code key={key}>{token.value}</code>;
      case "math":
        return <MathExpression key={key} source={token.value} />;
      case "footnote-reference": {
        if (token.number === null || token.referenceIndex === null) {
          return <Fragment key={key}>{token.raw}</Fragment>;
        }
        const footnoteId = `${options.footnotePrefix}-fn-${token.number}`;
        const referenceId = `${footnoteId}-ref-${token.referenceIndex}`;
        return (
          <sup key={key} className="qm-markdown-footnote-reference" id={referenceId}>
            <a aria-label={`각주 ${token.number}`} href={`#${footnoteId}`}>
              {token.number}
            </a>
          </sup>
        );
      }
      case "strong":
        return <strong key={key}>{renderInline(token.children, key, options)}</strong>;
      case "emphasis":
        return <em key={key}>{renderInline(token.children, key, options)}</em>;
      case "delete":
        return <del key={key}>{renderInline(token.children, key, options)}</del>;
      case "tag":
        return (
          <button
            key={key}
            className="qm-markdown-tag"
            type="button"
            onClick={(event) => options.onTagClick?.(token.tag, event)}
          >
            {token.raw}
          </button>
        );
      case "wikilink": {
        const reference: MarkdownLinkReference = {
          kind: "wikilink",
          raw: token.raw,
          target: token.target,
          path: token.path,
          subpath: token.subpath,
          display: token.display,
          embed: token.embed
        };
        return token.embed
          ? renderEmbed(reference, key, options)
          : (
              <button
                key={key}
                className="qm-markdown-link"
                type="button"
                {...internalLinkPreviewBindings(reference, options.onLinkPreviewInteraction)}
                onClick={(event) => options.onLinkClick?.(reference, event)}
              >
                {token.display}
              </button>
            );
      }
      case "link": {
        const display = inlinePlainText(token.children);
        if (!token.safe) {
          return (
            <span key={key} className="qm-markdown-unsafe-link" title="허용되지 않는 링크">
              {renderInline(token.children, key, options)}
            </span>
          );
        }

        const hashIndex = token.href.indexOf("#");
        const path = hashIndex === -1 ? token.href : token.href.slice(0, hashIndex);
        const subpath = hashIndex === -1 ? null : token.href.slice(hashIndex);
        const reference: MarkdownLinkReference = {
          kind: token.external ? "external" : "markdown-internal",
          raw: token.raw,
          target: token.href,
          path,
          subpath,
          display,
          embed: token.embed,
          href: token.href
        };

        if (token.embed) {
          return renderEmbed(reference, key, options);
        }

        if (token.external) {
          return (
            <a
              key={key}
              href={token.href}
              rel="noopener noreferrer"
              target="_blank"
              onClick={(event) => options.onLinkClick?.(reference, event)}
            >
              {renderInline(token.children, key, options)}
            </a>
          );
        }

        return (
          <button
            key={key}
            className="qm-markdown-link"
            type="button"
            {...internalLinkPreviewBindings(reference, options.onLinkPreviewInteraction)}
            onClick={(event) => options.onLinkClick?.(reference, event)}
          >
            {renderInline(token.children, key, options)}
          </button>
        );
      }
    }
  });
}

function inlinePlainText(tokens: MarkdownInlineToken[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "text":
      case "code":
      case "math":
        return token.value;
      case "line-break":
        return "\n";
      case "footnote-reference":
        return token.number === null ? token.raw : `${token.number}`;
      case "tag":
        return token.raw;
      case "wikilink":
        return token.display;
      case "link":
      case "strong":
      case "emphasis":
      case "delete":
        return inlinePlainText(token.children);
    }
  }).join("");
}

function renderEmbed(
  reference: MarkdownLinkReference,
  key: string,
  options: InlineRenderOptions
) {
  const resolved = options.renderEmbed?.(reference);
  return (
    <span
      key={key}
      aria-label={`임베드: ${reference.display}`}
      className="qm-markdown-embed"
      role="group"
    >
      {resolved ?? (
        <button
          className="qm-markdown-link qm-markdown-embed-link"
          type="button"
          {...internalLinkPreviewBindings(reference, options.onLinkPreviewInteraction)}
          onClick={(event) => options.onLinkClick?.(reference, event)}
        >
          <span aria-hidden="true">↳ </span>
          {reference.display}
        </button>
      )}
    </span>
  );
}

function renderFootnotes(footnotes: MarkdownFootnote[], options: InlineRenderOptions) {
  return (
    <section aria-label="각주" className="qm-markdown-footnotes">
      <ol>
        {footnotes.map((footnote) => {
          const footnoteId = `${options.footnotePrefix}-fn-${footnote.number}`;
          return (
            <li id={footnoteId} key={footnote.label}>
              <div className="qm-markdown-footnote-content">
                {footnote.blocks.map((block, index) =>
                  renderBlock(block, `${footnoteId}-block-${index}`, options)
                )}
              </div>
              <span className="qm-markdown-footnote-backlinks">
                {Array.from({ length: footnote.referenceCount }, (_, index) => (
                  <a
                    aria-label={`각주 ${footnote.number}의 ${index + 1}번째 참조로 돌아가기`}
                    href={`#${footnoteId}-ref-${index + 1}`}
                    key={`${footnoteId}-back-${index + 1}`}
                  >
                    ↩{index > 0 ? index + 1 : ""}
                  </a>
                ))}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function headingId(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-") || undefined;
}
