import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WikiPublishDialog from "./WikiPublishDialog";
import type { PreparedWikiPublication } from "./publishedWikiTypes";
const api = vi.hoisted(() => ({ status: vi.fn(), publish: vi.fn(), unpublish: vi.fn() }));
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiOwnerStatus: api.status, publishPreparedWiki: api.publish, unpublishWiki: api.unpublish }));
const emptyStatus = { wikiId: null, revision: 0, published: false, title: "폴더", expiresAt: null, updatedAt: null, noteCount: 0, assetCount: 0 };
const prepared: PreparedWikiPublication = { manifest: { rootFolderId: "folder", title: "공개 폴더", expiresAt: null, folders: [{ sourceFolderId: "folder", parentSourceFolderId: null, name: "공개 폴더" }], entries: [{ sourceNoteId: "note", sourceRevision: 1, sourceFolderId: "folder", title: "공개 메모", kind: "markdown" }] }, contents: [{ sourceNoteId: "note", body: "게시할 내용" }], totalBytes: 20, omittedEntryCount: 0, redactedLinkCount: 1 };
function mount(prepare = vi.fn().mockResolvedValue(prepared)) {
  const session = new AbortController();
  const close = vi.fn();
  const view = render(<WikiPublishDialog rootFolderId="folder" folderName="공개 폴더" uid="owner" prepare={prepare} sessionSignal={session.signal} onClose={close} />);
  return { ...view, session, close, prepare };
}
beforeEach(() => { vi.clearAllMocks(); api.status.mockResolvedValue(emptyStatus); api.publish.mockResolvedValue({ ...emptyStatus, wikiId: "public123", revision: 1, published: true, noteCount: 1 }); api.unpublish.mockResolvedValue({ ...emptyStatus, wikiId: "public123", revision: 2 }); });
describe("folder wiki publication dialog", () => {
  it("keeps keyboard focus inside the dialog while its contents are being prepared", () => {
    mount(vi.fn().mockReturnValue(new Promise(() => undefined)));
    expect(screen.getByRole("dialog", { name: "폴더 위키 공개" })).toHaveFocus();
  });
  it("shows the exact selected note list and requires the publication checkbox", async () => {
    mount();
    expect(await screen.findByText("공개 메모")).toBeVisible();
    expect(screen.getByRole("button", { name: "위키 게시" })).toBeDisabled();
    expect(api.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith(prepared, 0, expect.objectContaining({ expectedUid: "owner" })));
    expect(await screen.findByRole("link")).toHaveAttribute("href", expect.stringContaining("/wiki/public/public123"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it("still permits unpublishing when local content preparation fails", async () => {
    api.status.mockResolvedValue({ ...emptyStatus, wikiId: "public123", revision: 4, published: true });
    mount(vi.fn().mockRejectedValue(new Error("본문 준비 실패")));
    expect(await screen.findByRole("alert")).toHaveTextContent("본문 준비 실패");
    fireEvent.click(screen.getByRole("button", { name: "공개 중지" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("folder", 4, expect.any(Object)));
    expect(await screen.findByText(/기존 링크로 내용을 볼 수 없습니다/)).toBeVisible();
  });
  it("aborts publication when the unlocked session ends", async () => {
    let receivedSignal: AbortSignal | undefined;
    api.publish.mockImplementation((_prepared, _revision, options) => { receivedSignal = options.signal; return new Promise(() => undefined); });
    const { session, unmount } = mount();
    await screen.findByText("공개 메모");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "위키 게시" }));
    expect(receivedSignal?.aborted).toBe(false);
    await act(async () => session.abort());
    expect(receivedSignal?.aborted).toBe(true);
    unmount();
  });
});
