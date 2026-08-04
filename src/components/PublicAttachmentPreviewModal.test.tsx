import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import PublicAttachmentPreviewModal from "./PublicAttachmentPreviewModal";

describe("PublicAttachmentPreviewModal download capability", () => {
  it("renders an inline preview without exposing a download link when downloads are denied", () => {
    render(
      <PublicAttachmentPreviewModal
        onClose={vi.fn()}
        preview={{
          downloadAllowed: false,
          fileName: "preview.png",
          kind: "image",
          label: "이미지 미리보기",
          url: "blob:preview-only"
        }}
      />
    );

    expect(screen.getByRole("img", { name: "preview.png" })).toHaveAttribute("src", "blob:preview-only");
    expect(screen.queryByRole("link", { name: "다운로드" })).not.toBeInTheDocument();
  });

  it("uses a separately authorized download URL when downloads are allowed", () => {
    render(
      <PublicAttachmentPreviewModal
        onClose={vi.fn()}
        preview={{
          downloadAllowed: true,
          downloadUrl: "blob:download-authorized",
          fileName: "preview.txt",
          kind: "text",
          label: "텍스트 미리보기",
          text: "QuickMemo",
          url: "blob:render-only"
        }}
      />
    );

    expect(screen.getByRole("link", { name: "다운로드" })).toHaveAttribute("href", "blob:download-authorized");
  });

  it("keeps the mobile close action in the trailing column and preserves safe areas", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 680px)"));

    expect(mobileStyles).toMatch(
      /\.modal-backdrop \{[\s\S]*?max\(14px, env\(safe-area-inset-bottom\)\)/u
    );
    expect(mobileStyles).toMatch(/\.pdf-preview-close \{\s*grid-column: 2;/u);
  });
});
