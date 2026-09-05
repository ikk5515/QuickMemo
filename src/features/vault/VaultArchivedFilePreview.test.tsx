import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./browserDownload";
import { VaultArchivedFilePreview } from "./VaultArchivedFilePreview";

vi.mock("./browserDownload", () => ({ downloadBlob: vi.fn() }));

describe("VaultArchivedFilePreview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reveals the original as inert text without creating executable content", async () => {
    const source = '<script>globalThis.secret = "exposed"</script><img src=x onerror=alert(1)>\njavascript:alert(1)';
    const { container } = render(<VaultArchivedFilePreview fileName="기존 파일.canvas" source={source} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByRole("heading", { name: "기존 파일.canvas" })).toBeInTheDocument();
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(source));
    expect(container.querySelector("script, img, iframe, a, textarea, [contenteditable]")).toBeNull();
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(container.querySelector("pre")).toBeNull());
  });

  it("downloads the exact original bytes as a file without interpreting its content", async () => {
    const source = 'views:\r\n  - type: table\r\n# 원본 유지\r\n';
    render(<VaultArchivedFilePreview fileName="보관.base" source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "원본 내려받기" }));
    expect(downloadBlob).toHaveBeenCalledOnce();
    const [blob, fileName] = vi.mocked(downloadBlob).mock.calls[0];
    expect(fileName).toBe("보관.base");
    expect(blob.type).toBe("application/octet-stream");
    expect(blob.size).toBe(new TextEncoder().encode(source).byteLength);
    const contents = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(contents).toBe(source);
  });
});
