import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedVaultNote } from "../features/vault/vaultData";
import WikiPage from "./WikiPage";

const fixtures = vi.hoisted(() => ({
  auth: {
    firebaseUser: { uid: "owner" },
    profile: { uid: "owner", isActive: true, featureAccess: { notes: true, schedule: true, library: true } },
    privateKey: {} as CryptoKey | null
  },
  data: { ready: true, error: null, folders: [], notes: [] as DecryptedVaultNote[], retry: vi.fn() },
  useData: vi.fn()
}));

vi.mock("../context/AuthContext", () => ({ useAuth: () => fixtures.auth }));
vi.mock("../features/wiki/usePrivateWikiData", () => ({ usePrivateWikiData: fixtures.useData }));
vi.mock("../components/UnlockPanel", () => ({ UnlockPanel: () => <div>암호화 키 잠금 해제</div> }));

function makeNote(id: string, title: string, body: string, extra = {}) {
  return { id, title, body, ownerUid: "owner", contentFormat: "markdown-v1", entryKind: "markdown", ...extra } as DecryptedVaultNote;
}
function Location() { return <output data-testid="location">{useLocation().search}</output>; }
function renderWiki(path = "/wiki?note=overview") {
  return render(<MemoryRouter initialEntries={[path]}><WikiPage /><Location /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.auth.firebaseUser.uid = "owner";
  fixtures.auth.profile.uid = "owner";
  fixtures.auth.profile.isActive = true;
  fixtures.auth.profile.featureAccess.notes = true;
  fixtures.auth.privateKey = {} as CryptoKey;
  fixtures.data.notes = [
    makeNote("overview", "개요", "## 요약\n\n나만의 비밀 위키\n\n[[클라우드]]\n\n[[없는메모]]"),
    makeNote("cloud", "클라우드", "## 관측\n\n메트릭과 알림을 수집합니다. [[개요]]"),
    makeNote("legacy", "이전 메모", '<h2>이전 제목</h2><p>예전 내용</p><script>alert(1)</script><a href="javascript:alert(1)">unsafe</a>', { contentFormat: "legacy-html-v1", entryKind: "legacy-html" })
  ];
  fixtures.useData.mockImplementation(() => fixtures.data);
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("WikiPage private read-only reader", () => {
  it.each(["inactive", "uid-mismatch", "feature-disabled", "locked"])("does not mount decrypted data for %s sessions", (state) => {
    if (state === "inactive") fixtures.auth.profile.isActive = false;
    if (state === "uid-mismatch") fixtures.auth.firebaseUser.uid = "someone-else";
    if (state === "feature-disabled") fixtures.auth.profile.featureAccess.notes = false;
    if (state === "locked") fixtures.auth.privateKey = null;
    renderWiki();
    expect(fixtures.useData).not.toHaveBeenCalled();
    expect(screen.queryByText("나만의 비밀 위키")).not.toBeInTheDocument();
    if (state === "locked") expect(screen.getByText("암호화 키 잠금 해제")).toBeVisible();
  });

  it("renders the deep-linked note, existing Markdown outline, backlinks and accessible graph", async () => {
    renderWiki();
    expect(screen.getByRole("heading", { name: "개요", level: 1 })).toBeVisible();
    expect(screen.getByText("나만의 비밀 위키")).toBeVisible();
    const toc = screen.getByRole("navigation", { name: "현재 메모 목차" });
    expect(await within(toc).findByRole("button", { name: "요약" })).toBeVisible();
    const backlinks = screen.getByRole("region", { name: "이 메모를 연결한 메모" });
    expect(await within(backlinks).findByRole("link", { name: /클라우드/ })).toHaveAttribute("href", "/wiki?note=cloud");
    expect(await screen.findByRole("list", { name: "그래프 노드" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /저장|생성|삭제/ })).not.toBeInTheDocument();
  });

  it("searches decrypted body and navigates wiki links within the owner projection", async () => {
    renderWiki();
    await screen.findByRole("list", { name: "그래프 노드" });
    fireEvent.change(screen.getByRole("searchbox", { name: "위키 검색" }), { target: { value: "메트릭" } });
    const search = await screen.findByRole("navigation", { name: "위키 검색 결과" });
    await waitFor(() => expect(within(search).getAllByRole("link")).toHaveLength(1));
    fireEvent.click(within(search).getByRole("link", { name: /클라우드/ }));
    expect(screen.getByRole("heading", { name: "클라우드", level: 1 })).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("?note=cloud");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "현재 메모 목차" })).getByRole("button", { name: "관측" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /^개요$/ }));
    expect(screen.getByRole("heading", { name: "개요", level: 1 })).toBeVisible();
  });

  it("does not substitute another note for a missing or foreign deep link", () => {
    renderWiki("/wiki?note=not-owned");
    expect(screen.getByRole("heading", { name: "메모를 찾을 수 없습니다" })).toBeVisible();
    expect(screen.queryByText("나만의 비밀 위키")).not.toBeInTheDocument();
    expect(screen.queryByText("not-owned")).not.toBeInTheDocument();
  });

  it("keeps unresolved links read-only and opens modified-click links with no opener", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWiki();
    await screen.findByRole("list", { name: "그래프 노드" });
    fireEvent.click(screen.getByRole("button", { name: /^없는메모$/ }));
    expect(screen.getByText("이 링크의 메모를 위키에서 찾을 수 없습니다.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^클라우드$/ }), { ctrlKey: true });
    expect(open).toHaveBeenCalledWith("/wiki?note=cloud", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("sanitizes legacy HTML with the established read-only renderer", async () => {
    const { container } = renderWiki("/wiki?note=legacy");
    expect(screen.getByText("예전 내용")).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    await act(async () => undefined);
  });

  it("bounds the rendered navigation and exposes the next page", async () => {
    fixtures.data.notes = Array.from({ length: 1000 }, (_, index) => makeNote(`n${index}`, `메모${String(index).padStart(4, "0")}`, ""));
    renderWiki("/wiki");
    const navigation = screen.getByRole("navigation", { name: "위키 폴더와 메모" });
    expect(within(navigation).getAllByRole("link")).toHaveLength(120);
    fireEvent.click(within(navigation).getByRole("button", { name: "다음" }));
    expect(within(navigation).getByRole("link", { name: "메모0120" })).toBeVisible();
    expect(within(navigation).getAllByRole("link")).toHaveLength(120);
    await act(async () => undefined);
  });

  it("preserves the reader, search and scroll position when an owned note updates", async () => {
    const view = renderWiki();
    fireEvent.change(screen.getByRole("searchbox", { name: "위키 검색" }), { target: { value: "메트릭" } });
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "위키 검색 결과" })).getAllByRole("link")).toHaveLength(1));
    const article = screen.getByRole("main");
    article.scrollTop = 320;
    const search = screen.getByRole("searchbox", { name: "위키 검색" });
    fixtures.data.notes = fixtures.data.notes.map((note) => note.id === "overview"
      ? { ...note, revision: 2, body: `${note.body}\n\n다른 탭에서 수정한 본문` }
      : note);
    view.rerender(<MemoryRouter initialEntries={["/wiki?note=overview"]}><WikiPage /><Location /></MemoryRouter>);
    expect(screen.getByRole("main")).toBe(article);
    expect(article.scrollTop).toBe(320);
    expect(screen.getByRole("searchbox", { name: "위키 검색" })).toBe(search);
    expect(search).toHaveValue("메트릭");
    expect(await screen.findByText("다른 탭에서 수정한 본문")).toBeVisible();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
