import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteSnapshot } from "../../services/notes";
import type { MarkdownLinkReference } from "../markdown";
import type { DecodedVaultAsset } from "../vault/vaultAsset";
import { WikiAssetEmbed } from "./WikiAssetEmbed";
import type { WikiAssetReader } from "./wikiAssetReader";

const reference: MarkdownLinkReference = {
  kind: "wikilink", raw: "![[diagram.png]]", target: "diagram.png", path: "diagram.png",
  subpath: null, display: "diagram.png", embed: true
};
const sourceEntry = { id: "note", path: "Note.md" };
const resolved = { id: "asset", fileName: "diagram.png", snapshot: { id: "asset" } as NoteSnapshot };

function pngBytes() {
  const bytes = new Uint8Array(57);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, 80);
  view.setUint32(20, 60);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}

function makeReader(asset: DecodedVaultAsset = { bytes: pngBytes(), mimeType: "image/png" }) {
  const resolve = vi.fn().mockResolvedValue(resolved);
  const load = vi.fn().mockResolvedValue(asset);
  const controller = new AbortController();
  return { controller, load, resolve, reader: { load, resolve, signal: controller.signal } as unknown as WikiAssetReader };
}

const observers: TestIntersectionObserver[] = [];
class TestIntersectionObserver {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn((element: Element) => { this.target = element; });
  target: Element | null = null;
  constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
  intersect(isIntersecting: boolean) {
    if (!this.target) throw new Error("Expected an observed asset placeholder");
    this.callback([{ isIntersecting, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const createObjectURL = vi.fn(() => "blob:wiki-asset");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  observers.length = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function embed(reader: WikiAssetReader) {
  return <MemoryRouter><WikiAssetEmbed reader={reader} reference={reference} sourceEntry={sourceEntry} /></MemoryRouter>;
}

function enterViewport() {
  act(() => observers.at(-1)!.intersect(true));
}

describe("WikiAssetEmbed", () => {
  it("waits until visible, passes cancellation to both reads, and revokes its inline image on unmount", async () => {
    const { reader, resolve, load } = makeReader();
    const view = render(embed(reader));
    expect(observers).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    act(() => observers[0].intersect(false));
    expect(resolve).not.toHaveBeenCalled();

    enterViewport();
    expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute("src", "blob:wiki-asset");
    expect(resolve).toHaveBeenCalledWith(reference, sourceEntry, expect.any(AbortSignal));
    const signal = resolve.mock.calls[0][2] as AbortSignal;
    expect(load).toHaveBeenCalledWith(resolved, signal);
    expect(signal.aborted).toBe(false);
    expect(screen.queryByRole("link", { name: "다운로드" })).not.toBeInTheDocument();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:wiki-asset");
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it.each([
    ["SVG", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"],
    ["HTML", "text/html", "<html><script>window.fixtureExecuted=true</script></html>"],
    ["HTML claiming PNG", "image/png", "<html><script/></html>"],
    ["PDF", "application/pdf", "%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF"]
  ])("keeps %s out of image/iframe/blob previews and offers only its memo entry", async (_label, mimeType, source) => {
    const { reader, load } = makeReader({ bytes: new TextEncoder().encode(source), mimeType });
    const view = render(embed(reader));
    enterViewport();
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    const link = await screen.findByRole("link", { name: /diagram\.png/ });
    expect(link).toHaveAttribute("href", "/app?entry=asset");
    expect(view.container).toHaveTextContent("메모에서 파일 보기");
    expect(view.container.querySelector("img, iframe, object, embed")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("does not preview a valid PNG under a mismatched MIME type", async () => {
    const { reader } = makeReader({ bytes: pngBytes(), mimeType: "image/jpeg" });
    const view = render(embed(reader));
    enterViewport();
    expect(await screen.findByRole("link", { name: /diagram\.png/ })).toHaveAttribute("href", "/app?entry=asset");
    expect(view.container.querySelector("img, iframe, object, embed")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("aborts an unmounted resolution and ignores a reader that resolves after cancellation", async () => {
    const { reader, resolve, load } = makeReader();
    let finishResolve!: (value: typeof resolved) => void;
    resolve.mockImplementation(() => new Promise((finish) => { finishResolve = finish; }));
    const view = render(embed(reader));
    enterViewport();
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const signal = resolve.mock.calls[0][2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { finishResolve(resolved); await Promise.resolve(); });
    expect(load).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("aborts the previous reader's load and ignores its late decrypted result", async () => {
    const first = makeReader();
    let finishFirstLoad!: (value: DecodedVaultAsset) => void;
    first.load.mockImplementation(() => new Promise((finish) => { finishFirstLoad = finish; }));
    const second = makeReader();
    second.resolve.mockResolvedValue({ ...resolved, id: "second", fileName: "second.png" });
    const view = render(embed(first.reader));
    enterViewport();
    await waitFor(() => expect(first.load).toHaveBeenCalledOnce());
    const firstSignal = first.load.mock.calls[0][1] as AbortSignal;

    view.rerender(embed(second.reader));
    expect(firstSignal.aborted).toBe(true);
    enterViewport();
    expect(await screen.findByRole("img", { name: "second.png" })).toBeInTheDocument();
    await act(async () => { finishFirstLoad({ bytes: pngBytes(), mimeType: "image/png" }); await Promise.resolve(); });
    expect(screen.queryByRole("img", { name: "diagram.png" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("clears an already visible image and its URL immediately when the reader changes", async () => {
    const first = makeReader();
    const second = makeReader();
    second.resolve.mockImplementation(() => new Promise(() => undefined));
    const view = render(embed(first.reader));
    enterViewport();
    await screen.findByRole("img", { name: "diagram.png" });
    view.rerender(embed(second.reader));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:wiki-asset");
  });

  it("immediately removes decrypted pixels and revokes the URL when its unlocked session expires", async () => {
    const { controller, reader, load } = makeReader();
    render(embed(reader));
    enterViewport();
    await screen.findByRole("img", { name: "diagram.png" });
    const signal = load.mock.calls[0][1] as AbortSignal;
    act(() => controller.abort());
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:wiki-asset");
  });

  it("does not start reading from a session that has already expired", () => {
    const { controller, reader, resolve, load } = makeReader();
    controller.abort();
    render(embed(reader));
    enterViewport();
    expect(resolve).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
