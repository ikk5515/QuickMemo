import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DATAVIEW_BLOCKS_PER_DOCUMENT, MarkdownRenderer } from "./MarkdownRenderer";

afterEach(cleanup);

describe("MarkdownRenderer", () => {
  it("allows a bounded host renderer to handle an explicit code language", () => {
    render(
      <MarkdownRenderer
        renderCodeBlock={(language, source) => language === "dataview"
          ? <output data-testid="dataview">{source}</output>
          : undefined}
        source={'```dataview\nLIST\n```\n\n```unknown\nplain\n```'}
      />
    );
    expect(screen.getByTestId("dataview")).toHaveTextContent("LIST");
    expect(document.querySelector('code[data-language="unknown"]')).toHaveTextContent("plain");
  });

  it("limits executable Dataview blocks per document and preserves skipped code as inert text", () => {
    const renderCodeBlock = vi.fn((language: string, source: string) => language === "dataview"
      ? <output data-testid="dataview">{source}</output>
      : undefined);
    const source = Array.from(
      { length: MAX_DATAVIEW_BLOCKS_PER_DOCUMENT + 1 },
      (_, index) => `\`\`\`dataview\nLIST ${index}\n\`\`\``
    ).join("\n\n");

    const { container } = render(<MarkdownRenderer renderCodeBlock={renderCodeBlock} source={source} />);

    expect(renderCodeBlock).toHaveBeenCalledTimes(MAX_DATAVIEW_BLOCKS_PER_DOCUMENT);
    expect(screen.getAllByTestId("dataview")).toHaveLength(MAX_DATAVIEW_BLOCKS_PER_DOCUMENT);
    expect(screen.getByText("Dataview 실행 한도에 도달했습니다.")).toBeInTheDocument();
    expect(container.querySelectorAll(".qm-markdown-dataview-budget pre")).toHaveLength(1);
    expect(container.querySelector("script")).toBeNull();
  });
  it("renders raw HTML as inert text and refuses active link schemes", () => {
    const { container } = render(
      <MarkdownRenderer
        source={'<img src=x onerror=alert(1)> <script>window.bad=1</script>\n\n[위험](javascript:alert(1)) [안전](https://example.com/path)'}
      />
    );

    expect(container.querySelector("img, script")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(screen.getByText("위험").closest("a, button")).toBeNull();
    expect(screen.getByRole("link", { name: "안전" })).toHaveAttribute(
      "href",
      "https://example.com/path"
    );
    expect(screen.getByRole("link", { name: "안전" })).toHaveAttribute(
      "rel",
      "noopener noreferrer"
    );
  });

  it("exposes structured wiki-link and tag callbacks", () => {
    const onLinkClick = vi.fn();
    const onTagClick = vi.fn();
    render(
      <MarkdownRenderer
        source="[[Folder/Note#Heading|표시 이름]] #Project/QuickMemo"
        onLinkClick={onLinkClick}
        onTagClick={onTagClick}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "표시 이름" }));
    expect(onLinkClick.mock.calls[0][0]).toMatchObject({
      kind: "wikilink",
      target: "Folder/Note#Heading",
      path: "Folder/Note",
      subpath: "#Heading",
      display: "표시 이름",
      embed: false
    });

    fireEvent.click(screen.getByRole("button", { name: "#Project/QuickMemo" }));
    expect(onTagClick.mock.calls[0][0]).toBe("Project/QuickMemo");
  });

  it("reports pointer and keyboard preview intent only for inert internal-link controls", () => {
    const onLinkPreviewInteraction = vi.fn();
    render(
      <MarkdownRenderer
        source="[[Folder/Note|Wiki]] [상대](../Note.md) [외부](https://example.com)"
        onLinkPreviewInteraction={onLinkPreviewInteraction}
      />
    );

    const wiki = screen.getByRole("button", { name: "Wiki" });
    fireEvent.mouseEnter(wiki);
    fireEvent.focus(wiki);
    fireEvent.mouseLeave(wiki);
    fireEvent.blur(wiki);

    expect(onLinkPreviewInteraction).toHaveBeenCalledTimes(4);
    expect(onLinkPreviewInteraction.mock.calls.map(([reference, interaction]) => ({
      active: interaction.active,
      anchor: interaction.anchor,
      kind: reference.kind,
      source: interaction.source
    }))).toEqual([
      { active: true, anchor: wiki, kind: "wikilink", source: "pointer" },
      { active: true, anchor: wiki, kind: "wikilink", source: "focus" },
      { active: false, anchor: wiki, kind: "wikilink", source: "pointer" },
      { active: false, anchor: wiki, kind: "wikilink", source: "focus" }
    ]);

    const relative = screen.getByRole("button", { name: "상대" });
    fireEvent.focus(relative);
    expect(onLinkPreviewInteraction.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "markdown-internal",
      path: "../Note.md"
    });

    fireEvent.mouseEnter(screen.getByRole("link", { name: "외부" }));
    expect(onLinkPreviewInteraction).toHaveBeenCalledTimes(5);
  });

  it("preserves literal tabs in source code and renders accessible tasks and tables", () => {
    const { container } = render(
      <MarkdownRenderer
        source={'```ts\nconst first = 1;\n\tconst second = 2;\n```\n\n- [x] 완료\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'}
      />
    );

    expect(container.querySelector("pre code")?.textContent).toContain("\n\tconst second");
    expect(screen.getByRole("checkbox", { name: "완료된 작업" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "완료된 작업" })).toBeDisabled();
    expect(container.querySelectorAll("table td")).toHaveLength(2);
  });

  it("renders callouts, including their fold state, without interpreting title HTML", () => {
    const { container } = render(
      <MarkdownRenderer
        source={[
          "> [!warning]- <img src=x onerror=alert(1)> 주의",
          "> 접힌 내용",
          "",
          "> [!tip]+ 펼친 힌트",
          "> 확인 내용"
        ].join("\n")}
      />
    );

    const callouts = container.querySelectorAll("details.qm-markdown-callout");
    expect(callouts).toHaveLength(2);
    expect(callouts[0]).not.toHaveAttribute("open");
    expect(callouts[1]).toHaveAttribute("open");
    expect(container.querySelector("img")).toBeNull();
    expect(callouts[0]).toHaveTextContent("<img src=x onerror=alert(1)> 주의");
  });

  it("renders numbered footnotes with one backlink per occurrence", () => {
    render(
      <MarkdownRenderer
        source={"본문[^a] 다시[^a], 인라인 ^[바로 적는 각주].\n\n[^a]: 출처 **설명**"}
      />
    );

    expect(screen.getAllByRole("link", { name: "각주 1" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "각주 2" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "각주" })).toHaveTextContent("출처 설명");
    expect(screen.getByRole("region", { name: "각주" })).toHaveTextContent("바로 적는 각주");
    expect(screen.getByRole("link", { name: "각주 1의 2번째 참조로 돌아가기" }))
      .toHaveAttribute("href", expect.stringMatching(/-fn-1-ref-2$/));
  });

  it("keeps embeds inert by default and delegates resolved content explicitly", () => {
    const onLinkClick = vi.fn();
    const renderEmbed = vi.fn((reference) => (
      <span data-testid={`resolved-${reference.path}`}>{reference.display}</span>
    ));
    const { container } = render(
      <MarkdownRenderer
        source="![[assets/photo.png|사진]] ![원격](https://example.com/tracker.png) ![위험](javascript:alert(1))"
        onLinkClick={onLinkClick}
        renderEmbed={renderEmbed}
      />
    );

    expect(renderEmbed).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("resolved-assets/photo.png")).toHaveTextContent("사진");
    expect(screen.getByTestId("resolved-https://example.com/tracker.png")).toHaveTextContent("원격");
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("위험");
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it("typesets trusted-off KaTeX math and leaves active commands inert", async () => {
    const { container } = render(
      <MarkdownRenderer
        source={"인라인 $e^{i\\pi}+1=0$\n\n$$\\frac{1}{2}$$\n\n$\\href{javascript:alert(1)}{위험}$"}
      />
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    });
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelectorAll('[role="math"]')).toHaveLength(3);
  });
});
