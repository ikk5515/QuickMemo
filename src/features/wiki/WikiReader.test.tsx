import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { WikiReader, type WikiReaderProps } from "./WikiReader";
import type { WikiReadableNote } from "./wikiModel";

const notes: WikiReadableNote[] = [
  { id: "overview", title: "개요", body: "## 시작\n\n개요 본문\n\n### 자세히\n\n[[연결 문서]]\n\n[[비공개 문서]]", entryKind: "markdown", contentFormat: "markdown-v1" },
  { id: "linked", title: "연결 문서", body: "## 참고\n\n연결 본문\n\n[[세 번째 문서]]", entryKind: "markdown", contentFormat: "markdown-v1" },
  { id: "third", title: "세 번째 문서", body: "## 마지막\n\n세 번째 본문", entryKind: "markdown", contentFormat: "markdown-v1" }
];
const folders: WikiReaderProps["folders"] = [];
function NavigationState() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="wiki-location">{location.pathname + location.search}</output><button onClick={() => navigate(-1)} type="button">브라우저 뒤로</button></>;
}
function Reader({ data = notes, loadingNoteIds }: { data?: WikiReadableNote[]; loadingNoteIds?: ReadonlySet<string> }) {
  return <><WikiReader basePath="/wiki/public/published" folders={folders} loadingNoteIds={loadingNoteIds} mode="public" notes={data} title="공개 지식" /><NavigationState /></>;
}
function renderReader(path = "/wiki/public/published?note=overview", data = notes) {
  return render(<MemoryRouter initialEntries={[path]}><Reader data={data} /></MemoryRouter>);
}
async function ready() { await screen.findByRole("list", { name: "그래프 노드" }); }

describe("authorized WikiReader projection and reading panels", () => {
  it("shows backlink basenames without raw Markdown excerpts or visible folder paths", async () => {
    render(<MemoryRouter initialEntries={["/wiki?note=linked"]}><WikiReader notes={notes.map((note) => ({ ...note, folderId: "root" }))}
      folders={[{ id: "root", parentId: null, displayName: "공개 자료" }]} /></MemoryRouter>);
    const backlinks = screen.getByRole("region", { name: "이 메모를 연결한 메모" });
    const link = await within(backlinks).findByRole("link", { name: /^개요$/u });
    expect(link).toHaveTextContent(/^개요$/u);
    expect(link).toHaveAttribute("title", "공개 자료/개요.md");
    expect(backlinks).not.toHaveTextContent("[[연결 문서]]");
    expect(backlinks).not.toHaveTextContent("공개 자료/");
  });

  it.each([false, true])("keeps an explicitly selected TOC item when it cannot reach the top (short=%s)", async (short) => {
    let observeChange: (() => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: () => void) { observeChange = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      renderReader(); await ready();
      const article = screen.getByRole("article", { name: "개요" });
      Object.defineProperties(article, { clientHeight: { value: 600, configurable: true }, scrollHeight: { value: short ? 300 : 1200, configurable: true } });
      const headings = within(article).getAllByRole("heading");
      headings[0].getBoundingClientRect = () => new DOMRect(0, -500, 200, 40);
      headings[1].getBoundingClientRect = () => new DOMRect(0, 50, 200, 40);
      headings[2].getBoundingClientRect = () => new DOMRect(0, 420, 200, 40);
      headings[2].scrollIntoView = () => { article.scrollTop = short ? 0 : 600; };
      const toc = screen.getByRole("navigation", { name: "현재 메모 목차" });
      const child = within(toc).getByRole("button", { name: "자세히" });
      fireEvent.click(child);
      act(() => observeChange?.());
      expect(headings[2]).toHaveFocus();
      expect(child).toHaveAttribute("aria-current", "location");
      if (!short) {
        article.scrollTop = 300;
        act(() => observeChange?.());
        expect(within(toc).getByRole("button", { name: "시작" })).toHaveAttribute("aria-current", "location");
        expect(child).not.toHaveAttribute("aria-current");
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it("makes the closed mobile drawer and earlier panels inert while preserving their DOM", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 767px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      const { container } = renderReader(); await ready();
      const sidebar = container.querySelector(".wiki-sidebar")!;
      expect(sidebar).toHaveAttribute("inert");
      expect(screen.queryByRole("searchbox", { name: "위키 검색" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "위키 목록 열기" }));
      const search = screen.getByRole("searchbox", { name: "위키 검색" });
      await waitFor(() => expect(search).toHaveFocus());
      expect(sidebar).not.toHaveAttribute("inert");
      fireEvent.keyDown(search, { key: "Escape" });
      expect(screen.getByRole("button", { name: "위키 목록 열기" })).toHaveFocus();
      expect(sidebar).toHaveAttribute("inert");
      const original = screen.getByRole("article", { name: "개요" }); original.scrollTop = 250;
      fireEvent.click(within(original).getByRole("button", { name: "연결 문서" }));
      expect(original).toHaveAttribute("inert");
      expect(container.querySelectorAll(".wiki-panel")).toHaveLength(2);
      expect(screen.getAllByRole("article")).toHaveLength(1);
      fireEvent.keyDown(screen.getByRole("article", { name: "연결 문서" }), { key: "Escape" });
      expect(screen.getByRole("article", { name: "개요" })).toBe(original);
      expect(original.scrollTop).toBe(250);
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses a leading Markdown H1 as the only article title while retaining the filename label", async () => {
    const data = [{ ...notes[0], title: "저장된 파일 이름", body: "# 실제 문서 제목\n\n## 본문 제목\n내용" }];
    const { container } = renderReader(undefined, data);
    expect(screen.getByRole("article", { name: "저장된 파일 이름" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "실제 문서 제목", level: 1 })).toHaveClass("wiki-title");
    expect(container.querySelector(".wiki-breadcrumb")).toHaveTextContent("저장된 파일 이름");
    await ready();
  });

  it("opens encoded block fragments and focuses duplicate headings by their unique outline slugs", async () => {
    const data = [
      { ...notes[0], body: "[[연결 문서#%5Eproof|블록 열기]]" },
      { ...notes[1], body: "## 같은 제목\n첫 부분\n\n## 같은 제목\n두 번째 부분 ^proof" }
    ];
    renderReader(undefined, data); await ready();
    fireEvent.click(screen.getByRole("button", { name: "블록 열기" }));
    const linked = screen.getByRole("article", { name: "연결 문서" });
    await waitFor(() => expect(linked.querySelector('[data-block-id="proof"]')).toHaveFocus());
    const toc = screen.getByRole("navigation", { name: "현재 메모 목차" });
    const buttons = await within(toc).findAllByRole("button", { name: "같은 제목" });
    const headings = within(linked).getAllByRole("heading", { name: "같은 제목" });
    expect(headings[0].id).not.toBe(headings[1].id);
    fireEvent.click(buttons[1]);
    expect(headings[1]).toHaveFocus();
    expect(buttons[1]).toHaveAttribute("aria-current", "location");
  });

  it("appends links to the right without replacing earlier article DOM or scroll, then closes with Escape", async () => {
    renderReader(); await ready();
    const original = screen.getByRole("article", { name: "개요" });
    original.scrollTop = 380;
    fireEvent.click(within(original).getByRole("button", { name: "연결 문서" }));
    expect(screen.getByRole("article", { name: "개요" })).toBe(original);
    expect(original.scrollTop).toBe(380);
    const linked = screen.getByRole("article", { name: "연결 문서" });
    expect(linked).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("wiki-location")).toHaveTextContent("?note=linked&pane=overview");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "현재 메모 목차" })).getByRole("button", { name: "참고" })).toBeVisible());
    fireEvent.keyDown(linked, { key: "Escape" });
    expect(screen.queryByRole("article", { name: "연결 문서" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "개요" })).toBe(original);
    expect(original.scrollTop).toBe(380);
  });

  it("uses browser history to restore the previous panel and sidebar selection replaces the stack", async () => {
    renderReader(); await ready();
    fireEvent.click(within(screen.getByRole("article", { name: "개요" })).getByRole("button", { name: "연결 문서" }));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "현재 메모 목차" })).getByRole("button", { name: "참고" })).toBeInTheDocument());
    const linked = screen.getByRole("article", { name: "연결 문서" }); linked.scrollTop = 120;
    fireEvent.click(within(linked).getByRole("button", { name: "세 번째 문서" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("article", { name: "연결 문서" })).toBe(linked);
    expect(linked.scrollTop).toBe(120);
    fireEvent.click(within(screen.getByRole("navigation", { name: "위키 폴더와 메모" })).getByRole("link", { name: "세 번째 문서" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "세 번째 문서" })).toBeInTheDocument();
  });

  it("reveals keyboard-focused earlier panels while retaining every page and its reading position", async () => {
    renderReader(); await ready();
    const original = screen.getByRole("article", { name: "개요" }); original.scrollTop = 380;
    fireEvent.click(within(original).getByRole("button", { name: "연결 문서" }));
    const linked = screen.getByRole("article", { name: "연결 문서" });
    await waitFor(() => expect(linked).toHaveFocus());
    linked.scrollTop = 120;
    fireEvent.click(within(linked).getByRole("button", { name: "세 번째 문서" }));
    const latest = screen.getByRole("article", { name: "세 번째 문서" });
    await waitFor(() => expect(latest).toHaveFocus());
    const earlierLink = within(linked).getByRole("button", { name: "세 번째 문서" });
    act(() => earlierLink.focus());
    expect(earlierLink).toHaveFocus();
    expect(linked).toHaveAttribute("data-active", "true");
    expect(latest).toHaveAttribute("data-active", "false");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "현재 메모 목차" })).getByRole("button", { name: "참고" })).toBeInTheDocument());
    act(() => { window.dispatchEvent(new Event("resize")); latest.focus({ preventScroll: true }); });
    expect(latest).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("article", { name: "개요" })).toBe(original);
    expect(screen.getByRole("article", { name: "연결 문서" })).toBe(linked);
    expect(original.scrollTop).toBe(380);
    expect(linked.scrollTop).toBe(120);
  });

  it("returns to an existing last panel when its link is opened again from an earlier page", async () => {
    renderReader(); await ready();
    const original = screen.getByRole("article", { name: "개요" });
    const link = within(original).getByRole("button", { name: "연결 문서" });
    fireEvent.click(link);
    const linked = screen.getByRole("article", { name: "연결 문서" });
    await waitFor(() => expect(linked).toHaveFocus());
    linked.scrollTop = 120;
    const unchangedUrl = screen.getByTestId("wiki-location").textContent;
    act(() => link.focus());
    expect(original).toHaveAttribute("data-active", "true");
    fireEvent.click(link);
    await waitFor(() => expect(linked).toHaveFocus());
    expect(linked).toHaveAttribute("data-active", "true");
    expect(original).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("wiki-location").textContent).toBe(unchangedUrl);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(linked.scrollTop).toBe(120);
  });

  it("does not expose private controls or resolve notes outside the supplied public subset", async () => {
    const { container } = renderReader(); await ready();
    expect(screen.queryByText("비공개", { exact: true })).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="/app"]')).toBeNull();
    expect(screen.queryByText("저장한 메모를 읽고 연결을 따라가세요.")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search page or heading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "비공개 문서" })).not.toBeInTheDocument();
    expect(screen.getByText("[비공개 링크]")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "전체 위키 그래프 보기" }));
    const graph = await screen.findByRole("region", { name: "전체 그래프" });
    expect(await within(graph).findAllByRole("listitem")).toHaveLength(3);
    expect(within(graph).queryByText("비공개 문서")).not.toBeInTheDocument();
  });

  it("keeps hierarchy and updates TOC aria-current when a heading is selected", async () => {
    renderReader(); await ready();
    const toc = screen.getByRole("navigation", { name: "현재 메모 목차" });
    const first = within(toc).getByRole("button", { name: "시작" });
    const child = within(toc).getByRole("button", { name: "자세히" });
    expect(child.closest("ol")?.parentElement?.tagName).toBe("LI");
    const heading = screen.getByRole("heading", { name: "자세히", level: 3 });
    heading.scrollIntoView = vi.fn();
    fireEvent.click(child);
    expect(child).toHaveAttribute("aria-current", "location");
    expect(first).not.toHaveAttribute("aria-current");
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest", behavior: "instant" });
    expect(heading).toHaveFocus();
  });

  it("shows pending body status while preserving the article and search during background loading", async () => {
    const pending = new Set(["overview"]);
    const view = render(<MemoryRouter initialEntries={["/wiki/public/published?note=overview"]}><Reader loadingNoteIds={pending} /></MemoryRouter>);
    expect(screen.getByText("본문을 불러오고 있습니다…")).toHaveAttribute("role", "status");
    expect(screen.queryByText("개요 본문")).not.toBeInTheDocument();
    const article = screen.getByRole("article", { name: "개요" }); article.scrollTop = 80;
    fireEvent.change(screen.getByRole("searchbox", { name: "위키 검색" }), { target: { value: "참고" } });
    view.rerender(<MemoryRouter initialEntries={["/wiki/public/published?note=overview"]}><Reader /></MemoryRouter>);
    expect(screen.getByRole("article", { name: "개요" })).toBe(article);
    expect(article.scrollTop).toBe(80);
    expect(screen.getByRole("searchbox", { name: "위키 검색" })).toHaveValue("참고");
    expect(screen.getByText("개요 본문")).toBeInTheDocument();
    await act(async () => undefined);
  });

  it("renders at most six URL panels and immediately removes vanished notes from the reading stack", async () => {
    const many: WikiReadableNote[] = Array.from({ length: 9 }, (_, index) => ({ id: "n" + index, title: "문서" + index, body: "본문" + index, entryKind: "markdown", contentFormat: "markdown-v1" }));
    const path = "/wiki/public/published?note=n8&pane=n0&pane=n1&pane=n2&pane=n3&pane=n4&pane=n5&pane=n6";
    const view = renderReader(path, many);
    expect(screen.getAllByRole("article")).toHaveLength(6);
    view.rerender(<MemoryRouter initialEntries={[path]}><Reader data={many.filter((note) => note.id === "n0")} /></MemoryRouter>);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.queryByText("본문4")).not.toBeInTheDocument();
    await act(async () => undefined);
  });
});
