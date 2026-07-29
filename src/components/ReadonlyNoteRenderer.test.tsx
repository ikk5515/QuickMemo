import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadonlyNoteRenderer } from "./ReadonlyNoteRenderer";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("ReadonlyNoteRenderer", () => {
  it("renders every TipTap empty paragraph as a real line without changing hard breaks", () => {
    const { container } = render(
      <ReadonlyNoteRenderer
        content="<p>첫 번째</p><p></p><p></p><p>네 번째<br>다섯 번째</p>"
        data-testid="body"
      />
    );
    const paragraphs = Array.from(container.querySelectorAll("p"));

    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[1].innerHTML).toBe("<br>");
    expect(paragraphs[2].innerHTML).toBe("<br>");
    expect(paragraphs[3].querySelectorAll("br")).toHaveLength(1);
    expect(screen.getByTestId("body")).toHaveClass(
      "note-content",
      "note-content--readonly"
    );
  });

  it("keeps the safe parser but restores legacy empty-paragraph semantics when v2 is disabled", () => {
    vi.stubEnv("VITE_READONLY_NOTE_RENDERER_V2_ENABLED", "false");
    const { container } = render(
      <ReadonlyNoteRenderer
        content={'<p></p><p>safe<script>alert(1)</script><a href="javascript:alert(1)">link</a></p>'}
      />
    );
    const paragraphs = Array.from(container.querySelectorAll("p"));

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].childNodes).toHaveLength(0);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("safelink");
  });

  it("defaults renderer v2 semantics on when the flag is omitted", () => {
    vi.stubEnv("VITE_READONLY_NOTE_RENDERER_V2_ENABLED", "");
    const { container } = render(<ReadonlyNoteRenderer content="<p></p>" />);

    expect(container.querySelector("p")?.innerHTML).toBe("<br>");
  });

  it("keeps supported list, checklist, quote, code, and tab structure", () => {
    const { container } = render(
      <ReadonlyNoteRenderer
        content={'<blockquote><p>인용<br>계속</p></blockquote><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>완료</p><p></p></div></li></ul><pre><code>line 1\n\tline 2</code></pre>'}
      />
    );

    expect(container.querySelector("blockquote br")).not.toBeNull();
    expect(container.querySelector('ul[data-type="taskList"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeDisabled();
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
    expect(container.querySelector("li p:empty")).toBeNull();
    expect(container.querySelector("li p br")).not.toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("line 1\n\tline 2");
  });

  it("sanitizes active HTML and keeps only safe external links", () => {
    const { container } = render(
      <ReadonlyNoteRenderer
        content={'<script>window.bad=1</script><p><img src=x onerror=alert(1)>safe <a href="javascript:alert(1)">bad</a> https://example.com</p><svg onload=alert(1)><text>svg</text></svg>'}
      />
    );

    expect(container.querySelector("script, svg, img, [onerror], [onload]")).toBeNull();
    expect(container).toHaveTextContent("safe bad https://example.com");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(container.querySelector("a")).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders legacy plain text as one safe React text node with normalized line endings", () => {
    const source = "\r\n<script>alert(1)</script>\r\n<br>\r마지막\t열\r\n";
    const { container } = render(
      <ReadonlyNoteRenderer content={source} contentFormat="plain-text" />
    );
    const body = container.querySelector(".note-content--plain");

    expect(body?.textContent).toBe("\n<script>alert(1)</script>\n<br>\n마지막\t열\n");
    expect(body?.childNodes).toHaveLength(1);
    expect(container.querySelector("script, br")).toBeNull();
  });

  it("shows trusted shared-note attribution only when explicitly requested", () => {
    const content =
      '<p data-qm-attribution-label="작성자: AB, 최종 수정자: CD">공유 본문</p>';
    const { rerender } = render(
      <ReadonlyNoteRenderer content={content} showAttribution />
    );

    expect(screen.getByText("작성자: AB, 최종 수정자: CD")).toHaveClass(
      "qm-attribution-note"
    );

    rerender(<ReadonlyNoteRenderer content={content} />);
    expect(screen.queryByText("작성자: AB, 최종 수정자: CD")).toBeNull();
  });

  it("fails closed when a document exceeds the renderer depth or size budget", () => {
    const deeplyNested = `${"<blockquote>".repeat(110)}deep${"</blockquote>".repeat(110)}`;
    const { rerender } = render(
      <ReadonlyNoteRenderer content={deeplyNested} emptyText="표시 불가" />
    );

    expect(screen.getByText("표시 불가")).toBeInTheDocument();

    rerender(
      <ReadonlyNoteRenderer
        content={`<p>${"x".repeat(1_000_001)}</p>`}
        emptyText="표시 불가"
      />
    );
    expect(screen.getByText("표시 불가")).toBeInTheDocument();
  });
});
