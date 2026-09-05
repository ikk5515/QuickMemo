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
function openLegacy(query = "") {
  return render(<MemoryRouter initialEntries={["/before", `${legacyBase}${query}`]} initialIndex={1}>
    <Routes>
      <Route path="/before" element={<p>원래 페이지</p>} />
      <Route path="/wiki/public/:wikiId" element={<PublicWikiPage />} />
      <Route path="/wiki/:wikiSlug" element={<PublicWikiPage />} />
    </Routes><History />
  </MemoryRouter>);
}
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
