import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultAssetPreview } from "./VaultAssetPreview";

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
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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

  it("renders PDF bytes only in a blob-backed capability-free sandbox", async () => {
    render(<VaultAssetPreview
      asset={{ bytes: new TextEncoder().encode("%PDF-1.7"), mimeType: "application/pdf" }}
      fileName="design.pdf"
    />);

    const frame = await screen.findByTitle("design.pdf PDF 미리보기");
    expect(frame).toHaveAttribute("src", "blob:quickmemo-asset");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  });
});
