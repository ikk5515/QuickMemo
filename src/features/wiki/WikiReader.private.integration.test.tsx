import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiReader } from "./WikiReader";
import type { WikiReadableNote } from "./wikiModel";

// The gate supplies an authorized owner projection. This suite exercises the real
// reader, knowledge index, Markdown/legacy sanitizer and DOM rather than Firebase.
function makeNote(id: string, title: string, body: string, extra = {}): WikiReadableNote {
  return { id, title, body, contentFormat: "markdown-v1", entryKind: "markdown", ...extra };
}
let notes: WikiReadableNote[];
function Location() { return <output data-testid="location">{useLocation().search}</output>; }
function Reader({ data = notes }: { data?: WikiReadableNote[] }) {
  return <><WikiReader notes={data} folders={[]} mode="private" basePath="/wiki" /><Location /></>;
}
function renderWiki(path = "/wiki?note=overview") { return render(<MemoryRouter initialEntries={[path]}><Reader /></MemoryRouter>); }
async function ready() { await screen.findByRole("list", { name: "그래프 노드" }); }
beforeEach(() => {
  localStorage.clear();
  notes = [
    makeNote("overview", "개요", "## 요약\n\n나만의 비밀 위키\n\n[[클라우드]]\n\n[[없는메모]]"),
    makeNote("cloud", "클라우드", "## 관측\n\n메트릭과 알림을 수집합니다. [[개요]]"),
    makeNote("legacy", "이전 메모", '<h2>이전 제목</h2><p>예전 내용</p><script>alert(1)</script><a href="javascript:alert(1)">unsafe</a>', { contentFormat: "legacy-html-v1", entryKind: "legacy-html" })
  ];
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("private authorized WikiReader reading regressions", () => {
  it("renders the deep-linked Markdown note with outline, backlinks and accessible graph", async () => {
    renderWiki();
    const article = screen.getByRole("article", { name: "개요" });
    expect(within(article).getByRole("heading", { name: "개요", level: 1 })).toBeVisible();
    expect(within(article).getByText("나만의 비밀 위키")).toBeVisible();
    expect(await within(screen.getByRole("navigation", { name: "현재 메모 목차" })).findByRole("button", { name: "요약" })).toBeVisible();
    expect(await within(within(article).getByRole("region", { name: "이 메모를 연결한 메모" })).findByRole("link", { name: /클라우드/ })).toHaveAttribute("href", "/wiki?note=cloud");
    await ready(); expect(screen.queryByRole("button", { name: /저장|생성|삭제/ })).not.toBeInTheDocument();
  });
  it("searches decrypted body and opens wiki links inside the owner projection without replacing earlier panels", async () => {
    const { container } = renderWiki(); await ready();
    fireEvent.change(screen.getByRole("searchbox", { name: "위키 검색" }), { target: { value: "메트릭" } });
    const search = await screen.findByRole("navigation", { name: "위키 검색 결과" });
    await waitFor(() => expect(within(search).getAllByRole("link")).toHaveLength(1));
    fireEvent.click(within(search).getByRole("link", { name: /클라우드/ }));
    const cloud = screen.getByRole("article", { name: "클라우드" });
    expect(within(cloud).getByRole("heading", { name: "클라우드", level: 1 })).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("?note=cloud");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "현재 메모 목차" })).getByRole("button", { name: "관측" })).toBeVisible());
    fireEvent.click(within(cloud).getByRole("button", { name: /^개요$/ }));
    expect(screen.getByRole("article", { name: "개요" })).toBeVisible(); expect(container.querySelectorAll(".wiki-panel")).toHaveLength(2);
  });
  it("never substitutes another private note for a missing or foreign deep link", async () => {
    renderWiki("/wiki?note=not-owned");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("나만의 비밀 위키")).not.toBeInTheDocument();
    expect(screen.queryByText("not-owned")).not.toBeInTheDocument();
    await act(async () => undefined);
  });
  it("keeps unresolved links read-only and modified-click links isolated from their opener", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null); renderWiki(); await ready();
    const article = screen.getByRole("article", { name: "개요" });
    fireEvent.click(within(article).getByRole("button", { name: /^없는메모$/ }));
    expect(screen.getByText("이 링크의 메모를 위키에서 찾을 수 없습니다.")).toBeVisible(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(within(article).getByRole("button", { name: /^클라우드$/ }), { ctrlKey: true });
    expect(open).toHaveBeenCalledWith("/wiki?note=cloud", "_blank", "noopener,noreferrer");
  });
  it("sanitizes legacy HTML with the established read-only renderer", async () => {
    const { container } = renderWiki("/wiki?note=legacy");
    expect(screen.getByText("예전 내용")).toBeVisible(); expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull(); await act(async () => undefined);
  });
  it("bounds navigation DOM and exposes the next page for a large owner projection", async () => {
    notes = Array.from({ length: 1000 }, (_, index) => makeNote(`n${index}`, `메모${String(index).padStart(4, "0")}`, ""));
    renderWiki("/wiki"); const navigation = screen.getByRole("navigation", { name: "위키 폴더와 메모" });
    expect(within(navigation).getAllByRole("link")).toHaveLength(120);
    fireEvent.click(within(navigation).getByRole("button", { name: "다음" }));
    expect(within(navigation).getByRole("link", { name: "메모0120" })).toBeVisible(); expect(within(navigation).getAllByRole("link")).toHaveLength(120);
    await act(async () => undefined);
  });
  it("preserves article DOM, search and document scroll while an owned note updates", async () => {
    const view = renderWiki();
    fireEvent.change(screen.getByRole("searchbox", { name: "위키 검색" }), { target: { value: "메트릭" } });
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "위키 검색 결과" })).getAllByRole("link")).toHaveLength(1));
    const article = screen.getByRole("article", { name: "개요" }); article.scrollTop = 320;
    const search = screen.getByRole("searchbox", { name: "위키 검색" });
    notes = notes.map((note) => note.id === "overview" ? { ...note, revision: 2, body: `${note.body}\n\n다른 탭에서 수정한 본문` } : note);
    view.rerender(<MemoryRouter initialEntries={["/wiki?note=overview"]}><Reader /></MemoryRouter>);
    expect(screen.getByRole("article", { name: "개요" })).toBe(article); expect(article.scrollTop).toBe(320);
    expect(screen.getByRole("searchbox", { name: "위키 검색" })).toBe(search); expect(search).toHaveValue("메트릭");
    expect(await screen.findByText("다른 탭에서 수정한 본문")).toBeVisible(); expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
