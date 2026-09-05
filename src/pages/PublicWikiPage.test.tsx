import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedWikiManifest } from "../features/wiki/publishedWikiTypes";
import PublicWikiPage from "./PublicWikiPage";

const hooks = vi.hoisted(() => ({ data: vi.fn(), assets: vi.fn() }));
vi.mock("../features/wiki/usePublishedWikiData", () => ({ usePublishedWikiData: hooks.data }));
vi.mock("../features/wiki/publishedWikiAssetReader", () => ({ usePublishedWikiAssetReader: hooks.assets }));

const legacyBase = "/wiki/public/pw1_legacy-fixture";
let manifest: PublishedWikiManifest;
function History() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>이전 페이지</button></>;
}
function openAt(path: string) {
  return render(<MemoryRouter initialEntries={["/before", path]} initialIndex={1}>
    <Routes>
      <Route path="/before" element={<p>원래 페이지</p>} />
      <Route path="/wiki/public/:wikiId" element={<PublicWikiPage />} />
      <Route path="/wiki/:wikiSlug" element={<PublicWikiPage />} />
    </Routes><History />
  </MemoryRouter>);
}
function openLegacy(query = "") { return openAt(`${legacyBase}${query}`); }
function pageUrl(base: string, path: string) { return `${base}?${new URLSearchParams({ page: path })}`; }
async function expectRequestedPage(url: string) {
  const article = await screen.findByRole("article", { name: "요청한 문서" });
  expect(within(article).getByText("요청한 본문")).toBeVisible();
  expect(screen.queryByRole("article", { name: "첫 문서" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(url));
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  manifest = {
    wikiId: "pw1_legacy-fixture", revision: 1, title: "공개 위키", expiresAt: null, updatedAt: "2026-09-05", folders: [],
    entries: [
      { id: "first", folderId: null, title: "첫 문서", path: "첫 문서.md", kind: "markdown" },
      { id: "requested", folderId: null, title: "요청한 문서", path: "요청한 문서.md", kind: "markdown" },
      { id: "asset", folderId: null, title: "이미지.png", path: "이미지.png", kind: "asset" }
    ]
  };
  hooks.assets.mockReturnValue(null);
  hooks.data.mockImplementation(() => ({ data: {
    manifest, signal: new AbortController().signal,
    contents: new Map(manifest.entries.map((entry) => [entry.id, { ...entry, body: entry.id === "requested" ? "요청한 본문" : "다른 본문" }]))
  }, error: null }));
});

describe("canonical public wiki deep link authority", () => {
  it.each(["?page=missing-private-path", "?note=e_11111111111111111111111111111111", "?note=asset", "?page=%EC%9D%B4%EB%AF%B8%EC%A7%80.png", "?note=", "?page=", "?page=missing-private-path&note=first", "?note=first&note=requested"])("shows only the generic unavailable state for an invalid target: %s", (query) => {
    manifest.slug = "my-wiki"; openAt(`/wiki/my-wiki${query}`);
    expect(screen.getByRole("alert").textContent).toBe("위키를 열 수 없습니다");
    expect(screen.queryByRole("main", { name: "위키 읽기 패널" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("다른 본문")).not.toBeInTheDocument();
    expect(screen.queryByText("요청한 본문")).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe(`/wiki/my-wiki${query}`);
  });
  it.each([legacyBase, "/wiki/my-wiki"])("rejects repeated page parameters on %s even when both resolve", (base) => {
    manifest.slug = "my-wiki";
    const query = new URLSearchParams([["page", "첫 문서.md"], ["page", "요청한 문서.md"]]);
    openAt(`${base}?${query}`);
    expect(screen.getByRole("alert").textContent).toBe("위키를 열 수 없습니다");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("rejects an ambiguous readable path on the canonical route", () => {
    manifest.slug = "my-wiki"; manifest.entries.push({ ...manifest.entries[1], id: "duplicate" });
    openAt(pageUrl("/wiki/my-wiki", "요청한 문서.md"));
    expect(screen.getByRole("alert").textContent).toBe("위키를 열 수 없습니다");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("canonicalizes a real legacy note ID on the slug route and replaces browser history", async () => {
    manifest.slug = "my-wiki"; openAt("/wiki/my-wiki?note=first");
    expect(await screen.findByRole("article", { name: "첫 문서" })).toBeVisible();
    expect(screen.queryByRole("article", { name: "요청한 문서" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe(pageUrl("/wiki/my-wiki", "첫 문서.md"));
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(await screen.findByText("원래 페이지")).toBeVisible();
  });
  it("keeps a real page authoritative over a stale legacy note on the slug route", async () => {
    manifest.slug = "my-wiki";
    openAt(`/wiki/my-wiki?${new URLSearchParams({ page: "요청한 문서.md", note: "missing-private-id" })}`);
    await expectRequestedPage(pageUrl("/wiki/my-wiki", "요청한 문서.md"));
  });
});

describe("legacy public wiki deep links", () => {
  it("opens the requested legacy note before slug migration and replaces its history entry", async () => {
    openLegacy("?note=requested");
    await expectRequestedPage(pageUrl(legacyBase, "요청한 문서.md"));
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(await screen.findByText("원래 페이지")).toBeVisible();
  });
  it("maps a migrated legacy note to the canonical slug and readable path", async () => {
    manifest.slug = "my-wiki"; openLegacy("?note=requested");
    await expectRequestedPage(pageUrl("/wiki/my-wiki", "요청한 문서.md"));
  });
  it.each([null, "my-wiki"])("preserves an existing readable page with slug %s", async (slug) => {
    manifest.slug = slug; openLegacy(`?${new URLSearchParams({ page: "요청한 문서.md" })}`);
    await expectRequestedPage(pageUrl(slug ? "/wiki/my-wiki" : legacyBase, "요청한 문서.md"));
  });
  it("honors an explicit page over an older note parameter during slug migration", async () => {
    manifest.slug = "my-wiki"; openLegacy(`?${new URLSearchParams({ page: "요청한 문서.md", note: "first" })}`);
    await expectRequestedPage(pageUrl("/wiki/my-wiki", "요청한 문서.md"));
  });
  it.each(["?note=missing-private-id", "?note=asset", "?note=", "?page=missing-private-path&note=first", "?page=%EC%9D%B4%EB%AF%B8%EC%A7%80.png"])("does not substitute a document for an unavailable or non-readable target: %s", (query) => {
    manifest.slug = "my-wiki"; openLegacy(query);
    expect(screen.getByRole("alert")).toHaveTextContent("위키를 열 수 없습니다");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("다른 본문")).not.toBeInTheDocument();
    expect(screen.queryByText("요청한 본문")).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe(`${legacyBase}${query}`);
  });
  it("rejects an ambiguous canonical path instead of redirecting its legacy note", () => {
    manifest.entries.push({ ...manifest.entries[1], id: "duplicate" }); openLegacy("?note=requested");
    expect(screen.getByRole("alert")).toBeVisible(); expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("retains legacy HTML as a readable target", async () => {
    manifest.entries[1].kind = "legacy-html"; openLegacy("?note=requested");
    await expectRequestedPage(pageUrl(legacyBase, "요청한 문서.md"));
  });
  it("redirects a migrated root link and lets the reader select its initial document", async () => {
    manifest.slug = "my-wiki"; openLegacy();
    expect(await screen.findByRole("article")).toBeVisible();
    const location = new URL(screen.getByTestId("location").textContent!, "https://quickmemo.test");
    expect(location.pathname).toBe("/wiki/my-wiki");
    expect(location.searchParams.has("note")).toBe(false);
  });
});
