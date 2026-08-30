import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoteAttachmentSnapshot } from "../../services/notes";
import { VaultNoteAttachmentsInline } from "./VaultNoteAttachmentsInline";

function attachment(index: number, extension = "txt"): NoteAttachmentSnapshot {
  return {
    algorithm: "AES-GCM-CHUNKED",
    blobPath: `users/user-a/notes/note-a/attachments/attachment-${index}/data`,
    chunkCount: 1,
    chunkIvs: [],
    chunkSize: 4 * 1024 * 1024,
    encryptedSize: 20,
    extension,
    fileName: `자료-${index}`,
    id: `attachment-${index}`,
    isReady: true,
    mimeType: extension === "png" ? "image/png" : "text/plain",
    noteId: "note-a",
    originalSize: index * 1024,
    storageProvider: "vercel-blob",
    uploadedBy: "user-a",
    version: 2
  };
}

describe("VaultNoteAttachmentsInline", () => {
  it("shows a bounded metadata summary with the exact remaining count", () => {
    render(
      <VaultNoteAttachmentsInline
        attachments={Array.from({ length: 7 }, (_, index) => attachment(index + 1, index === 0 ? "png" : "txt"))}
        loading={false}
        onManage={vi.fn()}
      />
    );

    expect(screen.getByLabelText("노트 첨부파일")).toHaveTextContent("7개");
    expect(screen.getByText("자료-1.png")).toBeInTheDocument();
    expect(screen.getByText("자료-5.txt")).toBeInTheDocument();
    expect(screen.queryByText("자료-6.txt")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("opens the shared management dialog from the compact shelf", async () => {
    const onManage = vi.fn();
    render(
      <VaultNoteAttachmentsInline
        attachments={[attachment(1)]}
        loading={false}
        onManage={onManage}
      />
    );

    const button = screen.getByRole("button", { name: "노트 첨부파일 관리" });
    await userEvent.click(button);
    expect(onManage).toHaveBeenCalledWith(button);
  });

  it("fails closed and disables management when the metadata state is unavailable", () => {
    render(
      <VaultNoteAttachmentsInline
        attachments={[]}
        disabled
        error="첨부파일 목록을 불러오지 못했습니다."
        loading={false}
        onManage={vi.fn()}
      />
    );

    expect(screen.getByText("첨부파일 목록을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "노트에 파일 추가" })).toBeDisabled();
  });
});
