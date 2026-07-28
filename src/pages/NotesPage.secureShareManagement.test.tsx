import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecureShareOwnerSummary } from "../types";
import {
  assertSecureShareOwnerOperationCurrent,
  mergeSecureShareOwnerSummaries,
  parseCompleteSecureShareSourcePage,
  runPublicShareCleanupWithCommitBoundary,
  SecureShareOwnerOperationStaleError,
  SecureSharePostCommitCleanupError,
  secureShareOwnerPageSize,
  secureShareOwnerSourcePageSize,
  secureSharePostCommitCleanupMessage,
  SecureShareOwnerModal
} from "./NotesPage";

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
    showCommenterIpPrefix: true,
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
  hasMore = false,
  loadingMore = false,
  onClose = vi.fn(),
  onLoadMore = vi.fn(),
  onRevoke = vi.fn().mockResolvedValue(true),
  onSelect = vi.fn()
}: {
  busy?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onClose?: () => void;
  onLoadMore?: () => void;
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
      hasMore={hasMore}
      loadingMore={loadingMore}
      noteTitle="분기 보안 계획"
      nowMilliseconds={nowMilliseconds}
      onClose={onClose}
      onCopy={vi.fn()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onLoadMore={onLoadMore}
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

describe("secure share owner pagination", () => {
  it("uses a 20-item page and merges mutation refreshes without dropping loaded history", () => {
    const refreshedActiveShare = {
      ...activeShare,
      successfulAccessCount: activeShare.successfulAccessCount + 1
    };
    const nextPageShare = secureShare("ss2_next_page_share_123456", {
      createdAt: "2026-07-27T20:00:00.000Z"
    });

    expect(secureShareOwnerPageSize).toBe(20);
    expect(mergeSecureShareOwnerSummaries(
      [activeShare, consumedShare],
      [refreshedActiveShare, nextPageShare]
    )).toEqual([
      refreshedActiveShare,
      consumedShare,
      nextPageShare
    ]);
  });

  it("requires a complete source-note-specific page before using its history", () => {
    expect(secureShareOwnerSourcePageSize).toBe(100);
    expect(parseCompleteSecureShareSourcePage({
      ok: true,
      shares: [activeShare, consumedShare],
      nextCursor: null
    }, activeShare.sourceNoteId)).toEqual([activeShare, consumedShare]);

    expect(() => parseCompleteSecureShareSourcePage({
      ok: true,
      shares: [activeShare],
      nextCursor: "cursor_more_source_shares"
    }, activeShare.sourceNoteId)).toThrow(/100개를 초과/);
  });

  it("fails closed when a source-filtered page contains another note", () => {
    expect(() => parseCompleteSecureShareSourcePage({
      ok: true,
      shares: [
        activeShare,
        secureShare("ss2_wrong_source_123456", {
          sourceNoteId: "note_other_123456"
        })
      ],
      nextCursor: null
    }, activeShare.sourceNoteId)).toThrow(/원본 노트가 요청과 일치하지 않습니다/);
  });
});

describe("secure share owner operation lifecycle", () => {
  const operation = { generation: 7, uid: "user_secure_owner" };
  const currentIdentity = {
    firebaseUid: operation.uid,
    generation: operation.generation,
    profileUid: operation.uid,
    unlocked: true
  };

  it("accepts only the exact unlocked account generation", () => {
    expect(() => assertSecureShareOwnerOperationCurrent(
      operation,
      currentIdentity
    )).not.toThrow();

    [
      { ...currentIdentity, firebaseUid: "user_other_account" },
      { ...currentIdentity, generation: operation.generation + 1 },
      { ...currentIdentity, profileUid: "user_other_account" },
      { ...currentIdentity, unlocked: false }
    ].forEach((staleIdentity) => {
      expect(() => assertSecureShareOwnerOperationCurrent(
        operation,
        staleIdentity
      )).toThrow(SecureShareOwnerOperationStaleError);
    });
  });

  it("preserves a distinct post-commit cleanup outcome and its cause", () => {
    const cause = new Error("owner revoke failed");
    const error = new SecureSharePostCommitCleanupError(cause);

    expect(error.message).toBe(secureSharePostCommitCleanupMessage);
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(SecureSharePostCommitCleanupError);
  });

  it("keeps a committed deletion successful when legacy share cleanup needs a retry", async () => {
    let deletionCommitted = false;
    const cleanupFailure = new Error("legacy public share delete failed");
    const commitDeletion = vi.fn(async () => {
      deletionCommitted = true;
    });
    const cleanupLegacyShares = vi.fn(async () => {
      throw cleanupFailure;
    });

    await commitDeletion();
    const result = await runPublicShareCleanupWithCommitBoundary(
      deletionCommitted,
      cleanupLegacyShares
    ).catch((error: unknown) => error);

    expect(commitDeletion).toHaveBeenCalledTimes(1);
    expect(cleanupLegacyShares).toHaveBeenCalledTimes(1);
    expect(commitDeletion.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupLegacyShares.mock.invocationCallOrder[0]);
    expect(deletionCommitted).toBe(true);
    expect(result).toBeInstanceOf(SecureSharePostCommitCleanupError);
    expect(result).toMatchObject({
      cause: cleanupFailure,
      message: secureSharePostCommitCleanupMessage
    });
  });
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

  it("loads additional cursor pages only through an accessible explicit action", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <ManagementHarness hasMore onLoadMore={onLoadMore} />
    );

    const history = screen.getByRole("navigation", {
      name: "이 노트의 보안 공유 이력"
    });
    const loadMoreButton = within(history).getByRole("button", { name: "더 보기" });

    expect(screen.getByText(/불러온 보안 공유 4개/)).toBeInTheDocument();
    expect(loadMoreButton).toHaveAttribute("aria-controls", "secure-share-history-list");
    await user.click(loadMoreButton);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(
      <ManagementHarness hasMore loadingMore onLoadMore={onLoadMore} />
    );

    expect(history).toHaveAttribute("aria-busy", "true");
    expect(within(history).getByRole("button", { name: "불러오는 중..." })).toBeDisabled();
    expect(within(history).getByText("보안 공유 이력을 더 불러오는 중...")).toHaveAttribute(
      "aria-live",
      "polite"
    );

    rerender(<ManagementHarness onLoadMore={onLoadMore} />);
    expect(within(history).queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("keeps the management path available when the current note is not in the loaded page", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const modalProps = {
      busy: false,
      canCreate: false,
      copied: false,
      error: null,
      noteTitle: "오래된 공유가 있는 노트",
      nowMilliseconds,
      onClose: vi.fn(),
      onCopy: vi.fn(),
      onCreate: vi.fn(),
      onEdit: vi.fn(),
      onLoadMore,
      onRevoke: vi.fn().mockResolvedValue(true),
      onSelect: vi.fn(),
      share: null,
      shares: [],
      shareUrl: null
    };

    const { rerender } = render(
      <SecureShareOwnerModal
        {...modalProps}
        hasMore
        loadingMore={false}
      />
    );

    expect(screen.getByText("현재 불러온 이력에 이 노트의 보안 공유가 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 공유" })).toBeDisabled();
    const loadMoreButton = screen.getByRole("button", { name: "더 보기" });
    await waitFor(() => expect(
      screen.getByRole("button", { name: "보안 공유 창 닫기" })
    ).toHaveFocus());
    await user.click(loadMoreButton);
    expect(loadMoreButton).toHaveFocus();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(
      <SecureShareOwnerModal
        {...modalProps}
        hasMore
        loadingMore
      />
    );
    rerender(
      <SecureShareOwnerModal
        {...modalProps}
        hasMore={false}
        loadingMore={false}
      />
    );

    const detailHeading = screen.getByRole("heading", {
      name: "선택한 공유 상세"
    });
    await waitFor(() => expect(detailHeading).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "보안 공유 관리" }))
      .toContainElement(document.activeElement as HTMLElement);
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
