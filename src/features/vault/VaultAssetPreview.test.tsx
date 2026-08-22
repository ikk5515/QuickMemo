import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultAssetPreview, safeVaultPdfFragment } from "./VaultAssetPreview";

function pngBytes(width = 800, height = 600) {
  const bytes = new Uint8Array(57);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, 0);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  view.setUint32(45, 0);
  bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}

describe("VaultAssetPreview", () => {
  const createObjectURL = vi.fn(() => "blob:quickmemo-asset");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses and revokes a short-lived URL for a signature-matched image", async () => {
    const rendered = render(<VaultAssetPreview
      asset={{
        bytes: pngBytes(),
        mimeType: "image/png"
      }}
      fileName="diagram.png"
    />);

    expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute("src", "blob:quickmemo-asset");
    expect(screen.getByRole("link", { name: "다운로드" })).toHaveAttribute("download", "diagram.png");
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:quickmemo-asset");
  });

  it("shares one object URL across repeated Canvas references and revokes it after the last unmount", async () => {
    const asset = {
      bytes: pngBytes(),
      mimeType: "image/png"
    };
    const first = render(<VaultAssetPreview asset={asset} fileName="diagram.png" />);
    const second = render(<VaultAssetPreview asset={asset} fileName="diagram.png" />);

    expect(await screen.findAllByRole("img", { name: "diagram.png" })).toHaveLength(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:quickmemo-asset");
  });

  it("tiles a signature-matched image using only its generated blob URL", async () => {
    render(<VaultAssetPreview
      asset={{ bytes: pngBytes(), mimeType: "image/png" }}
      fileName="pattern.png"
      imageMode="repeat"
    />);

    const tiled = await screen.findByRole("img", { name: "pattern.png" });
    expect(tiled).toHaveClass("vault-asset-preview-repeat-image");
    expect(tiled).toHaveStyle({ backgroundImage: 'url("blob:quickmemo-asset")' });
    expect(tiled).not.toHaveAttribute("src");
  });

  it("keeps HTML and SVG bytes download-only", async () => {
    render(<VaultAssetPreview
      asset={{ bytes: new TextEncoder().encode("<html><script/></html>"), mimeType: "text/html" }}
      fileName="unsafe.html"
    />);

    expect(screen.getByRole("status")).toHaveTextContent("미리보지 않습니다");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/미리보기/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "다운로드" })).toBeInTheDocument());
  });

  it("keeps a raster with oversized decoded dimensions download-only", async () => {
    render(<VaultAssetPreview
      asset={{ bytes: pngBytes(8_193, 1), mimeType: "image/png" }}
      fileName="oversized.png"
    />);

    expect(screen.getByRole("status")).toHaveTextContent("미리보지 않습니다");
    expect(screen.queryByRole("img", { name: "oversized.png" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "다운로드" })).toBeInTheDocument());
  });

  it("renders PDF bytes only in a blob-backed capability-free sandbox", async () => {
    render(<VaultAssetPreview
      asset={{ bytes: new TextEncoder().encode("%PDF-1.7"), mimeType: "application/pdf" }}
      fileName="design.pdf"
      pdfFragment="#page=2&zoom=125"
    />);

    const frame = await screen.findByTitle("design.pdf PDF 미리보기");
    expect(frame).toHaveAttribute("src", "blob:quickmemo-asset#page=2&zoom=125");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("rejects executable or out-of-range PDF fragments", () => {
    expect(safeVaultPdfFragment("#page=9&zoom=400")).toBe("#page=9&zoom=400");
    expect(safeVaultPdfFragment("#page=0")).toBe("");
    expect(safeVaultPdfFragment("#page=1&zoom=401")).toBe("");
    expect(safeVaultPdfFragment("#page=1&toolbar=1")).toBe("");
    expect(safeVaultPdfFragment("javascript:alert(1)")).toBe("");
  });
});
