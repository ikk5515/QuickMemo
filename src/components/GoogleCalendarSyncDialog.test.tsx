import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleCalendarConnectionStatus } from "../services/googleCalendar";
import { GoogleCalendarSyncDialog } from "./GoogleCalendarSyncDialog";

type DialogProps = ComponentProps<typeof GoogleCalendarSyncDialog>;

const disconnectedConnection: GoogleCalendarConnectionStatus = {
  configured: true,
  connected: false,
  hasStoredConnection: false,
  needsReconnect: false,
  connectionGeneration: null,
  email: null,
  lastSyncAt: null,
  lastSyncStatus: "idle",
  syncedCount: 0,
  timeZone: null
};

const connectedConnection: GoogleCalendarConnectionStatus = {
  configured: true,
  connected: true,
  hasStoredConnection: true,
  needsReconnect: false,
  connectionGeneration: "connection-a",
  email: "te***@example.com",
  lastSyncAt: "2026-07-22T00:30:00.000Z",
  lastSyncStatus: "synced",
  syncedCount: 3,
  timeZone: "Asia/Seoul"
};

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const appRoot = document.createElement("div");
  const opener = document.createElement("button");
  const renderHost = document.createElement("div");

  appRoot.id = "root";
  opener.type = "button";
  opener.textContent = "동기화 창 열기";
  appRoot.append(opener);
  document.body.append(appRoot, renderHost);
  opener.focus();

  const props: DialogProps = {
    connection: disconnectedConnection,
    eligibleExistingCount: 3,
    error: null,
    loading: false,
    notice: null,
    operation: null,
    progress: null,
    onCancelSync: vi.fn(),
    onClose: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onRefresh: vi.fn(),
    onSyncExisting: vi.fn(),
    ...overrides
  };
  const result = render(<GoogleCalendarSyncDialog {...props} />, { container: renderHost });

  return { ...result, appRoot, opener, props };
}

function topStatusBadge() {
  const badge = document.querySelector<HTMLElement>(".google-calendar-sync-badge");

  expect(badge).not.toBeNull();
  return badge as HTMLElement;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("GoogleCalendarSyncDialog", () => {
  it("shows idle, completed, and failed sync states in the top status badge", () => {
    const { props, rerender } = renderDialog();

    expect(topStatusBadge()).toHaveTextContent("미동기화");
    expect(topStatusBadge()).toHaveClass("idle");

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={connectedConnection}
      />
    );
    expect(topStatusBadge()).toHaveTextContent("동기화 완료");
    expect(topStatusBadge()).toHaveClass("synced");

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        backgroundSyncPendingCount={2}
        connection={connectedConnection}
      />
    );
    expect(topStatusBadge()).toHaveTextContent("동기화 중");
    expect(topStatusBadge()).toHaveClass("syncing");

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={connectedConnection}
        operation="syncing"
      />
    );
    expect(topStatusBadge()).toHaveTextContent("동기화 중");
    expect(topStatusBadge()).toHaveClass("syncing");

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={{ ...connectedConnection, lastSyncStatus: "failed" }}
      />
    );
    expect(topStatusBadge()).toHaveTextContent("동기화 실패");
    expect(topStatusBadge()).toHaveClass("failed");
  });

  it("explains the security boundary and keeps existing-task sync opt-in disabled by default", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();

    renderDialog({ onConnect });

    expect(screen.getByText("비밀번호는 QuickMemo에 입력하지 않습니다.")).toBeInTheDocument();
    expect(screen.getByText(/제목·날짜·시간만 전송합니다/)).toBeInTheDocument();
    expect(screen.getByText(/상세 내용과 체크리스트는 전송하지 않습니다/)).toBeInTheDocument();
    expect(screen.getByText(/과거나 완료된 일정도 포함/)).toBeInTheDocument();
    expect(screen.getByText(/이미 동기화된 일정은 중복 등록하지 않습니다/)).toBeInTheDocument();

    const existingTasksCheckbox = screen.getByRole("checkbox", { name: /기존 일정도 한 번 동기화/ });
    const connectButton = screen.getByRole("button", { name: "Google 계정 연결" });

    expect(existingTasksCheckbox).not.toBeChecked();
    await user.click(connectButton);
    expect(onConnect).toHaveBeenLastCalledWith(false);

    await user.click(existingTasksCheckbox);
    await user.click(connectButton);
    expect(onConnect).toHaveBeenLastCalledWith(true);
  });

  it("supports refresh, existing-task sync, and a cancel-first disconnect confirmation", async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();
    const onRefresh = vi.fn();
    const onSyncExisting = vi.fn();

    renderDialog({
      connection: connectedConnection,
      onDisconnect,
      onRefresh,
      onSyncExisting
    });

    expect(screen.getByText("기존 일정 동기화 범위")).toBeInTheDocument();
    expect(screen.getByText(/과거나 완료된 일정도 포함/)).toBeInTheDocument();
    expect(screen.getByText(/이미 동기화된 일정은 중복 등록하지 않습니다/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "상태 새로고침" }));
    await user.click(screen.getByRole("button", { name: "기존 일정 동기화" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onSyncExisting).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    let confirmation = screen.getByRole("alertdialog", { name: "이 Google 계정 연결을 해제할까요?" });
    const cancelButton = within(confirmation).getByRole("button", { name: "취소" });

    expect(onDisconnect).not.toHaveBeenCalled();
    await waitFor(() => expect(cancelButton).toHaveFocus());
    await user.click(cancelButton);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "연결 해제" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    confirmation = screen.getByRole("alertdialog", { name: "이 Google 계정 연결을 해제할까요?" });
    await user.click(within(confirmation).getByRole("button", { name: "연결 해제" }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("clears an open disconnect confirmation when an active connection becomes disconnected", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderDialog({ connection: connectedConnection });

    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    expect(screen.getByRole("alertdialog", { name: "이 Google 계정 연결을 해제할까요?" })).toBeInTheDocument();

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={disconnectedConnection}
      />
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps a stored masked account removable when administrator settings are unavailable", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    const storedConnection = {
      ...disconnectedConnection,
      configured: false,
      email: "te***@example.com",
      hasStoredConnection: true,
      needsReconnect: true
    };

    renderDialog({ connection: storedConnection, onConnect });

    expect(screen.getByText("te***@example.com")).toBeInTheDocument();
    expect(screen.getByText("관리자가 Google Calendar API 설정을 확인해야 합니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "관리자 설정 필요" })).toBeDisabled();

    const disconnectButton = screen.getByRole("button", { name: "연결 해제" });
    expect(disconnectButton).toBeEnabled();
    await user.click(disconnectButton);
    expect(screen.getByRole("alertdialog", { name: "이 Google 계정 연결을 해제할까요?" })).toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("labels progress and exposes cancellation only while an existing-task sync is running", async () => {
    const user = userEvent.setup();
    const onCancelSync = vi.fn();
    const { props, rerender } = renderDialog({
      connection: connectedConnection,
      onCancelSync,
      operation: "syncing",
      progress: { completed: 2, total: 5 }
    });

    expect(screen.getByRole("progressbar", { name: "기존 일정 동기화 진행률 2/5" })).toBeInTheDocument();
    const cancelSyncButton = screen.getByRole("button", { name: "동기화 취소" });
    expect(cancelSyncButton).toBeEnabled();
    await user.click(cancelSyncButton);
    expect(onCancelSync).toHaveBeenCalledTimes(1);

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={connectedConnection}
        operation="disconnecting"
        progress={null}
      />
    );
    expect(screen.queryByRole("button", { name: "동기화 취소" })).not.toBeInTheDocument();
  });

  it("announces a completed cancellation inside the dialog", () => {
    renderDialog({ notice: "기존 일정 동기화를 중단했습니다." });

    const notice = screen.getByText("기존 일정 동기화를 중단했습니다.").closest(".google-calendar-sync-notice");

    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("aria-live", "polite");
  });

  it("closes with Escape and initially focuses the primary action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    renderDialog({ onClose });

    await waitFor(() => expect(screen.getByRole("button", { name: "Google 계정 연결" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus from a safe loading target to the default action once without stealing it on refresh", async () => {
    const { props, rerender } = renderDialog({ loading: true });
    const closeButton = screen.getByRole("button", { name: "Google Calendar 동기화 창 닫기" });

    expect(closeButton).toHaveFocus();

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        loading={false}
      />
    );
    const connectButton = screen.getByRole("button", { name: "Google 계정 연결" });
    await waitFor(() => expect(connectButton).toHaveFocus());

    closeButton.focus();
    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={{ ...disconnectedConnection, lastSyncStatus: "failed" }}
        error="상태를 다시 확인해주세요."
        loading={false}
        operation="connecting"
      />
    );
    await waitFor(() => expect(closeButton).toHaveFocus());
  });

  it("moves focus to the close button when a manual refresh enters loading state", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderDialog({ connection: connectedConnection });
    const refreshButton = screen.getByRole("button", { name: "상태 새로고침" });

    await waitFor(() => expect(screen.getByRole("button", { name: "기존 일정 동기화" })).toHaveFocus());
    await user.click(refreshButton);
    expect(refreshButton).toHaveFocus();

    rerender(
      <GoogleCalendarSyncDialog
        {...props}
        connection={connectedConnection}
        loading
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Google Calendar 동기화 창 닫기" })).toHaveFocus());
  });

  it.each([
    {
      label: "loading",
      overrides: { loading: true }
    },
    {
      label: "not configured",
      overrides: {
        connection: { ...disconnectedConnection, configured: false }
      }
    },
    {
      label: "no eligible existing tasks",
      overrides: {
        connection: connectedConnection,
        eligibleExistingCount: 0
      }
    }
  ] satisfies Array<{ label: string; overrides: Partial<DialogProps> }>) (
    "keeps focus inside the dialog while $label",
    async ({ overrides }) => {
      renderDialog(overrides);

      const dialog = screen.getByRole("dialog", { name: "Google Calendar 동기화" });
      const closeButton = screen.getByRole("button", { name: "Google Calendar 동기화 창 닫기" });

      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
      expect(closeButton).toHaveFocus();
    }
  );

  it("traps focus, makes the app root inert, and restores both root state and opener focus", async () => {
    const user = userEvent.setup();
    const { appRoot, opener, unmount } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Google Calendar 동기화" });
    const closeButton = screen.getByRole("button", { name: "Google Calendar 동기화 창 닫기" });
    const connectButton = screen.getByRole("button", { name: "Google 계정 연결" });

    await waitFor(() => expect(connectButton).toHaveFocus());
    expect(appRoot.inert).toBe(true);
    expect(appRoot).toHaveAttribute("aria-hidden", "true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("contain");

    await user.tab();
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(connectButton).toHaveFocus();

    opener.focus();
    expect(dialog).not.toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    expect(closeButton).toHaveFocus();

    unmount();
    expect(appRoot.inert).toBe(false);
    expect(appRoot).not.toHaveAttribute("aria-hidden");
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps the original opener as the restore target under React Strict Mode", async () => {
    const appRoot = document.createElement("div");
    const opener = document.createElement("button");
    const renderHost = document.createElement("div");
    appRoot.id = "root";
    opener.type = "button";
    opener.textContent = "동기화 창 열기";
    appRoot.append(opener);
    document.body.append(appRoot, renderHost);
    opener.focus();

    const { unmount } = render(
      <StrictMode>
        <GoogleCalendarSyncDialog
          connection={disconnectedConnection}
          eligibleExistingCount={3}
          error={null}
          loading={false}
          notice={null}
          operation={null}
          progress={null}
          onCancelSync={vi.fn()}
          onClose={vi.fn()}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onRefresh={vi.fn()}
          onSyncExisting={vi.fn()}
        />
      </StrictMode>,
      { container: renderHost }
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Google 계정 연결" })).toHaveFocus());
    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
