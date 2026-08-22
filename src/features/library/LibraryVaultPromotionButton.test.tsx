import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LibraryVaultPromotionButton } from "./LibraryVaultPromotionButton";
import { LibraryVaultUserError } from "./libraryVaultErrors";

describe("LibraryVaultPromotionButton", () => {
  it("announces success and exposes an accessible Vault open action", async () => {
    const promote = vi.fn().mockResolvedValue({ noteId: "note-a", state: "created" });
    const open = vi.fn();
    render(<LibraryVaultPromotionButton onOpen={open} onPromote={promote} />);
    fireEvent.click(screen.getByRole("button", { name: "Vault Markdown으로 저장" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("암호화된 Markdown 노트"));
    fireEvent.click(screen.getByRole("button", { name: "Vault에서 열기" }));
    expect(open).toHaveBeenCalledWith("note-a");
  });

  it("prevents duplicate clicks while promotion is pending and announces errors", async () => {
    let rejectPromotion!: (error: Error) => void;
    const promote = vi.fn(() => new Promise<{ noteId: string; state: "created" }>((_resolve, reject) => {
      rejectPromotion = reject;
    }));
    render(<LibraryVaultPromotionButton onPromote={promote} />);
    const button = screen.getByRole("button", { name: "Vault Markdown으로 저장" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(promote).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Vault에 저장 중…" })).toBeDisabled();
    rejectPromotion(new LibraryVaultUserError("안전한 복구가 필요합니다."));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("안전한 복구"));
  });

  it("does not expose unknown backend error details in the live status", async () => {
    render(<LibraryVaultPromotionButton onPromote={async () => {
      throw new Error("permission denied at private/document-id");
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "Vault Markdown으로 저장" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("서버 연결과 Vault 상태"));
    expect(screen.getByRole("status")).not.toHaveTextContent("private/document-id");
  });

  it("distinguishes a recovered response-loss operation from a new or duplicate write", async () => {
    render(<LibraryVaultPromotionButton onPromote={async () => ({
      noteId: "note-recovered",
      state: "recovered"
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Vault Markdown으로 저장" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("끊긴 저장 응답을 서버에서 재확인"));
  });
});
