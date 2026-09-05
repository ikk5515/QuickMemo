import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WikiPublishDialog from "./WikiPublishDialog";
import type { PreparedWikiPublication, PublishedWikiOwnerStatus } from "./publishedWikiTypes";
const api = vi.hoisted(() => ({ status: vi.fn(), legacy: vi.fn(), availability: vi.fn(), slug: vi.fn(), publish: vi.fn(), unpublish: vi.fn() }));
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiWorkspaceStatus: api.status, getPublishedWikiOwnerStatus: api.legacy, checkPublishedWikiSlugAvailability: api.availability, setPublishedWikiSlug: api.slug, publishPreparedWiki: api.publish, unpublishWiki: api.unpublish }));
const emptyStatus = { wikiId: "pw1_internal", slug: "my-notes", revision: 1, published: false, title: "공개 위키", expiresAt: null, updatedAt: null, noteCount: 0, assetCount: 0, selection: { folderIds: [], noteIds: [] } };
const prepared: PreparedWikiPublication = { manifest: { rootFolderId: null, selection: { folderIds: ["folder"], noteIds: [] }, title: "공개 폴더", expiresAt: null, folders: [{ sourceFolderId: "folder", parentSourceFolderId: null, name: "공개 폴더" }], entries: [{ sourceNoteId: "note", sourceRevision: 1, sourceFolderId: "folder", parentSourceFolderId: "folder", title: "공개 메모", kind: "markdown" }] }, contents: [{ sourceNoteId: "note", body: "게시할 내용" }], totalBytes: 20, omittedEntryCount: 0, redactedLinkCount: 1 };
function mount(prepare = vi.fn().mockResolvedValue(prepared)) {
  const session = new AbortController(), close = vi.fn(), changed = vi.fn();
  const view = render(<WikiPublishDialog rootFolderId="folder" folders={[{ id: "folder", label: "공개 폴더" }, { id: "other", label: "다른 폴더" }]} notes={[{ id: "loose", label: "개별 문서" }]} uid="owner" prepare={prepare} sessionSignal={session.signal} onPublicationChange={changed} onClose={close} />);
  return { ...view, session, close, prepare, changed };
}
const consent = () => screen.getByRole("checkbox", { name: /선택한 범위와 이후/ });
beforeEach(() => {
  vi.resetAllMocks(); api.status.mockResolvedValue(emptyStatus);
  api.availability.mockImplementation(async (slug) => ({ slug, available: true }));
  api.slug.mockImplementation(async (slug) => ({ ...emptyStatus, slug }));
  api.publish.mockResolvedValue({ ...emptyStatus, revision: 2, published: true, noteCount: 1, selection: prepared.manifest.selection });
  api.unpublish.mockResolvedValue({ ...emptyStatus, revision: 5 });
});
describe("workspace wiki publication dialog", () => {
  it("keeps focus in the dialog while source preparation is pending", async () => {
    const { prepare } = mount(vi.fn().mockReturnValue(new Promise(() => undefined)));
    await waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "위키 공개 설정" })).toHaveFocus();
  });
  it("requires explicit consent and publishes the latest saved scope under the existing root", async () => {
    const { prepare, changed } = mount();
    expect(await screen.findByText("공개 메모")).toBeVisible();
    expect(screen.getByRole("button", { name: "위키 게시" })).toBeDisabled();
    expect(api.publish).not.toHaveBeenCalled();
    fireEvent.click(consent()); fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith({ ...prepared, manifest: { ...prepared.manifest, title: "공개 위키" } }, 1, expect.objectContaining({ expectedUid: "owner" })));
    expect(prepare).toHaveBeenCalledWith({ folderIds: ["folder"], noteIds: [] }, expect.any(AbortSignal));
    expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByRole("link")).toHaveAttribute("href", expect.stringContaining("/wiki/my-notes"));
    expect(screen.getByRole("link").getAttribute("href")).not.toContain("pw1_");
    expect(consent()).not.toBeChecked(); expect(changed).toHaveBeenCalled();
  });
  it("preserves previous grants when adding a folder and resets consent when the selection changes", async () => {
    api.status.mockResolvedValue({ ...emptyStatus, selection: { folderIds: ["other"], noteIds: ["loose"] } });
    const { prepare } = mount(); await screen.findByText("공개 메모");
    expect(prepare).toHaveBeenCalledWith({ folderIds: ["other", "folder"], noteIds: ["loose"] }, expect.any(AbortSignal));
    fireEvent.click(consent()); fireEvent.click(screen.getByRole("checkbox", { name: "다른 폴더" }));
    await waitFor(() => expect(prepare).toHaveBeenLastCalledWith({ folderIds: ["folder"], noteIds: ["loose"] }, expect.any(AbortSignal)));
    expect(consent()).not.toBeChecked(); expect(api.publish).not.toHaveBeenCalled();
  });
  it("registers a new readable root before the first publication and uses its returned revision", async () => {
    api.status.mockResolvedValue({ ...emptyStatus, wikiId: null, slug: null, revision: 0 });
    mount(); await screen.findByText("공개 메모");
    fireEvent.change(screen.getByRole("textbox", { name: "위키 주소" }), { target: { value: "  Notes-A  " } });
    await screen.findByText("사용할 수 있는 주소입니다.");
    fireEvent.click(consent()); fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(api.slug).toHaveBeenCalledWith("notes-a", 0, expect.objectContaining({ expectedUid: "owner" })));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith(expect.any(Object), 1, expect.any(Object)));
  });
  it("blocks reserved and taken addresses without granting publication", async () => {
    api.availability.mockImplementation(async (slug) => ({ slug, available: false }));
    mount(); await screen.findByText("공개 메모");
    const input = screen.getByRole("textbox", { name: "위키 주소" });
    fireEvent.change(input, { target: { value: "admin" } }); fireEvent.click(consent());
    expect(screen.getByRole("button", { name: "위키 게시" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "claimed-root" } });
    await screen.findByText("이미 사용 중인 주소입니다.");
    expect(screen.getByRole("button", { name: "주소 저장" })).toBeDisabled(); expect(api.slug).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled();
  });
  it("can reserve an empty wiki address even when content preparation fails", async () => {
    api.status.mockResolvedValue({ ...emptyStatus, wikiId: null, slug: null, revision: 0 });
    mount(vi.fn().mockRejectedValue(new Error("본문 준비 실패"))); await screen.findByRole("alert");
    fireEvent.change(screen.getByRole("textbox", { name: "위키 주소" }), { target: { value: "empty-wiki" } });
    await screen.findByText("사용할 수 있는 주소입니다."); fireEvent.click(screen.getByRole("button", { name: "주소 저장" }));
    await waitFor(() => expect(api.slug).toHaveBeenCalled()); expect(api.publish).not.toHaveBeenCalled();
  });
  it("still permits unpublishing when local preparation fails", async () => {
    api.status.mockResolvedValue({ ...emptyStatus, revision: 4, published: true });
    mount(vi.fn().mockRejectedValue(new Error("본문 준비 실패")));
    expect(await screen.findByRole("alert")).toHaveTextContent("본문 준비 실패");
    fireEvent.click(screen.getByRole("button", { name: "공개 중지" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith(null, 4, expect.any(Object)));
    expect(await screen.findByText(/기존 링크로 내용을 볼 수 없습니다/)).toBeVisible();
  });
  it("aborts publication when the unlocked session ends", async () => {
    let receivedSignal: AbortSignal | undefined;
    api.publish.mockImplementation((_prepared, _revision, options) => { receivedSignal = options.signal; return new Promise(() => undefined); });
    const { session, unmount } = mount(); await screen.findByText("공개 메모");
    fireEvent.click(consent()); fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(receivedSignal?.aborted).toBe(false));
    await act(async () => session.abort()); expect(receivedSignal?.aborted).toBe(true); unmount();
  });
});


describe("legacy wiki adoption", () => {
  const summaries = [
    { wikiId: "pw1_legacy-a", rootFolderId: "other", title: "이전 위키 A", published: true, revision: 2 },
    { wikiId: "pw1_legacy-b", rootFolderId: "legacy-b-folder", title: "이전 위키 B", published: true, revision: 6 }
  ];
  const legacy: PublishedWikiOwnerStatus = {
    ...emptyStatus, wikiId: summaries[0].wikiId, slug: null, published: true, revision: 4,
    selection: undefined, manifest: { ...prepared.manifest, rootFolderId: "other", selection: undefined }, noteCount: 3
  };
  const adopted = { ...legacy, slug: "adopted-notes", revision: 5, selection: { folderIds: ["other"], noteIds: [] } };
  beforeEach(() => {
    api.status.mockResolvedValue({ ...emptyStatus, wikiId: null, slug: null, revision: 0, legacyPublications: summaries });
    api.legacy.mockResolvedValue(legacy);
    api.slug.mockResolvedValue(adopted);
  });
  async function chooseLegacy() {
    await screen.findByText("공개 메모");
    fireEvent.change(screen.getByRole("combobox", { name: /기존 위키 가져오기/ }), { target: { value: summaries[0].wikiId } });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "다른 폴더" })).toBeChecked());
    fireEvent.change(screen.getByRole("textbox", { name: "위키 주소" }), { target: { value: "adopted-notes" } });
    await screen.findByText("사용할 수 있는 주소입니다.");
  }
  it("loads the selected legacy grants and latest revision before adopting its existing snapshot", async () => {
    const { prepare, changed } = mount();
    await chooseLegacy();
    expect(api.legacy).toHaveBeenCalledWith("other", expect.objectContaining({ expectedUid: "owner" }));
    expect(prepare).toHaveBeenLastCalledWith({ folderIds: ["folder", "other"], noteIds: [] }, expect.any(AbortSignal));
    expect(consent()).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "주소 저장" }));
    await waitFor(() => expect(api.slug).toHaveBeenCalledWith("adopted-notes", 4, expect.objectContaining({ legacyWikiId: summaries[0].wikiId, expectedUid: "owner" })));
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(adopted));
    expect(api.publish).not.toHaveBeenCalled(); expect(api.unpublish).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "공개 폴더" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "다른 폴더" })).toBeChecked();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", expect.stringContaining("/wiki/adopted-notes"));
    // Only A was addressed; B's independent publication is neither fetched nor changed.
    expect(api.legacy.mock.calls.every(([root]) => root === "other")).toBe(true);
    expect(api.slug).toHaveBeenCalledTimes(1);
  });
  it("publishes the confirmed union using the adoption receipt revision, then renames the same root", async () => {
    const prepare = vi.fn(async (selection) => ({ ...prepared, manifest: { ...prepared.manifest, selection } }));
    const published = { ...adopted, revision: 6, selection: { folderIds: ["folder", "other"], noteIds: [] } };
    api.publish.mockResolvedValue(published);
    mount(prepare); await chooseLegacy();
    fireEvent.click(consent()); fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ selection: published.selection }) }), 5, expect.any(Object)));
    await screen.findByText(/선택한 범위의 변경 사항은 저장 후 자동 반영/);
    api.slug.mockResolvedValue({ ...published, slug: "renamed-notes", revision: 7 });
    fireEvent.change(screen.getByRole("textbox", { name: "위키 주소" }), { target: { value: "renamed-notes" } });
    await screen.findByText("사용할 수 있는 주소입니다.");
    fireEvent.click(screen.getByRole("button", { name: "주소 저장" }));
    await waitFor(() => expect(api.slug).toHaveBeenLastCalledWith("renamed-notes", 6, expect.objectContaining({ expectedUid: "owner" })));
    expect(api.slug.mock.calls[1][2]).not.toHaveProperty("legacyWikiId");
    expect(api.publish).toHaveBeenCalledTimes(1); expect(api.unpublish).not.toHaveBeenCalled();
  });
  it("clears consent and ignores a previous legacy response when the chosen source changes", async () => {
    let finishA!: (value: PublishedWikiOwnerStatus) => void;
    api.legacy.mockImplementation((root) => root === "other" ? new Promise((resolve) => { finishA = resolve; }) : Promise.resolve({ ...legacy, wikiId: summaries[1].wikiId, revision: 8, manifest: { ...legacy.manifest!, rootFolderId: "legacy-b-folder" } }));
    const { prepare } = mount(); await screen.findByText("공개 메모"); fireEvent.click(consent());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: summaries[0].wikiId } });
    await waitFor(() => expect(api.legacy).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "위키 게시" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: summaries[1].wikiId } });
    await waitFor(() => expect(prepare).toHaveBeenLastCalledWith({ folderIds: ["folder", "legacy-b-folder"], noteIds: [] }, expect.any(AbortSignal)));
    await act(async () => finishA(legacy));
    expect(prepare).toHaveBeenLastCalledWith({ folderIds: ["folder", "legacy-b-folder"], noteIds: [] }, expect.any(AbortSignal));
    expect(consent()).not.toBeChecked(); expect(api.slug).not.toHaveBeenCalled();
    expect(api.legacy.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("refreshes legacy grants after a CAS conflict and requires renewed confirmation", async () => {
    const latest = { ...legacy, revision: 9, selection: { folderIds: ["other"], noteIds: ["loose"] } };
    api.legacy.mockResolvedValueOnce(legacy).mockResolvedValue(latest);
    api.slug.mockRejectedValueOnce(new Error("공개 설정이 변경되었습니다."));
    const { prepare } = mount(); await chooseLegacy(); fireEvent.click(consent());
    fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(prepare).toHaveBeenLastCalledWith({ folderIds: ["folder", "other"], noteIds: ["loose"] }, expect.any(AbortSignal)));
    expect(consent()).not.toBeChecked(); expect(api.publish).not.toHaveBeenCalled();
    fireEvent.click(consent()); fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(api.slug).toHaveBeenLastCalledWith("adopted-notes", 9, expect.objectContaining({ legacyWikiId: summaries[0].wikiId })));
  });
  it("cannot adopt a legacy publication after its lookup session has ended", async () => {
    let finish!: (value: PublishedWikiOwnerStatus) => void;
    api.legacy.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { session } = mount(); await screen.findByText("공개 메모");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: summaries[0].wikiId } });
    await waitFor(() => expect(api.legacy).toHaveBeenCalled());
    await act(async () => { session.abort(); finish(legacy); });
    expect(api.legacy.mock.calls[0][1].signal.aborted).toBe(true);
    expect(api.slug).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "위키 게시" })).toBeDisabled();
  });
});
