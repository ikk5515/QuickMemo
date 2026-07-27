import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecureShareOwnerSummary } from "../types";
import { SecureShareOwnerModal } from "./NotesPage";

const nowMilliseconds = Date.parse("2026-07-28T01:00:00.000Z");

function secureShare(
  shareId: string,
  overrides: Partial<SecureShareOwnerSummary> = {}
): SecureShareOwnerSummary {
  return {
    accessMode: "anyone_with_link",
    attachmentCount: 2,
    consumedAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    downloadAllowed: false,
    expiresAt: "2026-07-29T00:00:00.000Z",
    hasPassword: true,
    lastAccessAt: "2026-07-28T00:45:00.000Z",
    oneTimeEnabled: true,
    permissionLevel: "comment",
    policyVersion: 1,
    quickCopyButtonVisible: false,
    ready: true,
    requiresEmailVerification: true,
    revokedAt: null,
    schemaVersion: 2,
    shareId,
    sourceNoteId: "note_123456",
    status: "active",
    successfulAccessCount: 12,
    updatedAt: "2026-07-28T00:45:00.000Z",
    ...overrides
  };
}

const activeShare = secureShare("ss2_active_share_123456");
const consumedShare = secureShare("ss2_consumed_share_123456", {
  consumedAt: "2026-07-28T00:30:00.000Z",
  createdAt: "2026-07-27T23:00:00.000Z",
  status: "consumed"
});
const expiredShare = secureShare("ss2_expired_share_123456", {
  createdAt: "2026-07-27T22:00:00.000Z",
  expiresAt: "2026-07-28T00:30:00.000Z"
});
const revokedShare = secureShare("ss2_revoked_share_123456", {
  createdAt: "2026-07-27T21:00:00.000Z",
  revokedAt: "2026-07-28T00:20:00.000Z",
  status: "revoked"
});
const shares = [activeShare, consumedShare, expiredShare, revokedShare];

function ManagementHarness({
  busy = false,
  onClose = vi.fn(),
  onRevoke = vi.fn().mockResolvedValue(true),
  onSelect = vi.fn()
}: {
  busy?: boolean;
  onClose?: () => void;
  onRevoke?: (share: SecureShareOwnerSummary) => Promise<boolean>;
  onSelect?: (share: SecureShareOwnerSummary) => void;
}) {
  const [selectedId, setSelectedId] = useState(activeShare.shareId);
  const selected = shares.find((share) => share.shareId === selectedId) ?? activeShare;

  return (
    <SecureShareOwnerModal
      busy={busy}
      canCreate={false}
      copied={false}
      error={null}
      noteTitle="분기 보안 계획"
      nowMilliseconds={nowMilliseconds}
      onClose={onClose}
      onCopy={vi.fn()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onRevoke={onRevoke}
      onSelect={(share) => {
        setSelectedId(share.shareId);
        onSelect(share);
      }}
      share={selected}
      shares={shares}
      shareUrl={`https://quickmemo.example/share/${selected.shareId}#key=test`}
    />
  );
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("SecureShareOwnerModal management history", () => {
  it("keeps initial focus and busy actions inside the management dialog", async () => {
    render(<ManagementHarness busy />);

    const dialog = screen.getByRole("dialog", { name: "보안 공유 관리" });

    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(within(dialog).getByRole("button", { name: "소유자 미리보기" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "설정 변경" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "공유 중단" })).toBeDisabled();
  });

  it("shows full history and switches detail/action availability by effective state", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ManagementHarness onSelect={onSelect} />);

    expect(screen.getByRole("dialog", { name: "보안 공유 관리" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("분기 보안 계획")).toBeInTheDocument();
    expect(screen.getByText(/보안 공유 4개/)).toBeInTheDocument();
    expect(screen.getAllByText("비밀번호").length).toBeGreaterThan(0);
    expect(screen.getAllByText("이메일 인증").length).toBeGreaterThan(0);
    expect(screen.getByText("12회")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /사용 완료/ }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({
      shareId: consumedShare.shareId
    }));

    const detail = screen.getByRole("heading", { name: "선택한 공유 상세" }).closest("section");
    expect(detail).not.toBeNull();
    expect(within(detail!).getByText(/소비됨/)).toBeInTheDocument();
    expect(within(detail!).getByRole("button", { name: "URL 복사" })).toBeDisabled();
    expect(within(detail!).getByRole("link", { name: "소유자 미리보기" })).toHaveAttribute(
      "rel",
      "noopener noreferrer"
    );
    expect(within(detail!).getByRole("button", { name: "설정 변경" })).toBeDisabled();
    expect(within(detail!).getByRole("button", { name: "공유 중단" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /만료/ }));
    expect(within(detail!).getByRole("button", { name: "URL 복사" })).toBeDisabled();
    expect(within(detail!).getByRole("button", { name: "소유자 미리보기" })).toBeDisabled();
    expect(within(detail!).getByRole("button", { name: "설정 변경" })).toBeDisabled();
    expect(within(detail!).getByRole("button", { name: "공유 중단" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "새 공유" })).toBeDisabled();
  });

  it("requires an accessible custom confirmation and keeps the parent open on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onRevoke = vi.fn().mockResolvedValue(true);
    render(<ManagementHarness onClose={onClose} onRevoke={onRevoke} />);

    const managementDialog = screen.getByRole("dialog", { name: "보안 공유 관리" });
    await user.click(screen.getByRole("button", { name: "공유 중단" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "이 공유를 즉시 중단할까요?"
    });
    const cancelButton = within(confirmation).getByRole("button", { name: "취소" });

    expect(confirmation).toHaveAttribute("aria-describedby", "secure-share-revoke-description");
    expect(within(confirmation).getByText(/기존 접근 세션도 즉시 무효화/)).toBeInTheDocument();
    expect(managementDialog).toHaveAttribute("aria-hidden", "true");
    expect(managementDialog).not.toHaveAttribute("aria-modal");
    expect(managementDialog).toHaveAttribute("inert");
    await waitFor(() => expect(cancelButton).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "공유 중단" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "공유 중단" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "공유 중단"
    }));

    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith(activeShare));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "보안 공유 관리" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /활성/ })).toHaveFocus());
  });
});
