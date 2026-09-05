import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownLinkReference } from "../markdown/types";
import { encodeVaultAsset } from "../vault/vaultAsset";
import type { PublishedWikiManifest } from "./publishedWikiTypes";
import { PublishedWikiAssetReader } from "./publishedWikiAssetReader";
import { PublishedWikiAssetEmbed } from "./PublishedWikiAssetEmbed";
const api = vi.hoisted(() => ({ asset: vi.fn() }));
vi.mock("../../services/publishedWikis", () => ({ getPublishedWikiAsset: api.asset }));
const imageEntry = { id: "image", folderId: "folder", title: "diagram.png", path: "Public/diagram.png", kind: "asset" as const };
const manifest: PublishedWikiManifest = { wikiId: "wiki", revision: 1, title: "Public", updatedAt: "2026-09-05", expiresAt: null, folders: [{ id: "folder", parentId: null, name: "Public", path: "Public" }], entries: [imageEntry] };
const reference: MarkdownLinkReference = { kind: "wikilink", raw: "![[diagram.png]]", target: "diagram.png", path: "diagram.png", subpath: null, display: "diagram.png", embed: true };
const sourceEntry = { id: "note", path: "Public/Note.md", kind: "markdown" as const };
const createObjectURL = vi.fn(() => "blob:public-image");
const revokeObjectURL = vi.fn();
function pngBytes() {
  const bytes = new Uint8Array(57); const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12); view.setUint32(16, 80); view.setUint32(20, 60); bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set(new TextEncoder().encode("IDAT"), 37); bytes.set(new TextEncoder().encode("IEND"), 49); return bytes;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  api.asset.mockResolvedValue({ ...imageEntry, body: encodeVaultAsset(pngBytes(), "image/png") });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(signal: AbortSignal, data = manifest, ref = reference) { return render(<PublishedWikiAssetEmbed reader={new PublishedWikiAssetReader(data, signal)} reference={ref} sourceEntry={sourceEntry} />); }
describe("public wiki image boundaries", () => {
  it("reads only a scoped published raster and revokes its object URL on scope abort", async () => {
    const scope = new AbortController(); mount(scope.signal);
    expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute("src", "blob:public-image");
    expect(api.asset).toHaveBeenCalledWith("wiki", "image", 1, expect.any(AbortSignal));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await act(async () => scope.abort());
    await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:public-image");
  });
  it("never requests a missing or private-scope asset and does not reflect its filename", async () => {
    mount(new AbortController().signal, { ...manifest, entries: [] }, { ...reference, display: "private-secret.png", path: "../private-secret.png" });
    await act(async () => undefined);
    expect(api.asset).not.toHaveBeenCalled();
    expect(screen.getByText("공개되지 않은 이미지")).toBeVisible();
    expect(screen.queryByText(/private-secret/)).not.toBeInTheDocument();
  });
  it("shares one request, decoded image and object URL across six panes with 32 embeds each", async () => {
    const scope = new AbortController(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    const item = (index: number) => <PublishedWikiAssetEmbed key={index} reader={reader} reference={reference} sourceEntry={sourceEntry} />;
    const view = render(<>{Array.from({ length: 6 * 32 }, (_, index) => item(index))}</>);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(192));
    expect(api.asset).toHaveBeenCalledTimes(1); expect(createObjectURL).toHaveBeenCalledTimes(1);
    view.rerender(<>{item(0)}</>); expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    view.unmount(); expect(revokeObjectURL).toHaveBeenCalledTimes(1); scope.abort();
  });
  it("does not request a body until the reference enters the viewport", async () => {
    let notify!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: typeof notify) { notify = callback; } observe() {} disconnect() {} });
    const scope = new AbortController(); mount(scope.signal);
    await act(async () => undefined); expect(api.asset).not.toHaveBeenCalled();
    await act(async () => notify([{ isIntersecting: true }]));
    expect(await screen.findByRole("img")).toBeVisible(); expect(api.asset).toHaveBeenCalledTimes(1); scope.abort();
  });
  it("hides and revokes the old image immediately when the reader's manifest loses its ID", async () => {
    const scope = new AbortController(); const reader = new PublishedWikiAssetReader(manifest, scope.signal);
    const view = render(<PublishedWikiAssetEmbed reader={reader} reference={reference} sourceEntry={sourceEntry} />);
    await screen.findByRole("img");
    const replacement = new PublishedWikiAssetReader({ ...manifest, entries: [] }, scope.signal);
    view.rerender(<PublishedWikiAssetEmbed reader={replacement} reference={reference} sourceEntry={sourceEntry} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(revokeObjectURL).toHaveBeenCalledWith("blob:public-image");
    expect(screen.getByText("공개되지 않은 이미지")).toBeVisible(); expect(api.asset).toHaveBeenCalledTimes(1); scope.abort();
  });
  it.each(["image/svg+xml", "text/html", "image/png"])("rejects executable bytes even when claimed as %s", async (mime) => {
    api.asset.mockResolvedValue({ ...imageEntry, body: encodeVaultAsset(Uint8Array.from(new TextEncoder().encode("<script>alert(1)</script>")), mime) });
    mount(new AbortController().signal);
    expect(await screen.findByText("공개되지 않은 이미지")).toBeVisible();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
