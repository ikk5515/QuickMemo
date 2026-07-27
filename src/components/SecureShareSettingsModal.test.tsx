import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSecureSharePolicy } from "../lib/secureSharePolicy";
import { SecureShareSettingsModal } from "./SecureShareSettingsModal";

type ModalProps = ComponentProps<typeof SecureShareSettingsModal>;

function localDateTimeInputValue(date: Date) {
  const localMilliseconds = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localMilliseconds).toISOString().slice(0, 16);
}

function renderModal(overrides: Partial<ModalProps> = {}) {
  const appRoot = document.createElement("div");
  const opener = document.createElement("button");
  const renderHost = document.createElement("div");

  appRoot.id = "root";
  opener.type = "button";
  opener.textContent = "공유 설정 열기";
  appRoot.append(opener);
  document.body.append(appRoot, renderHost);
  opener.focus();

  const props: ModalProps = {
    emailFeatureEnabled: true,
    initialValue: defaultSecureSharePolicy(),
    now: new Date("2026-07-28T00:00:00.000Z"),
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    timeZone: "Asia/Seoul",
    ...overrides
  };
  const result = render(<SecureShareSettingsModal {...props} />, {
    container: renderHost
  });

  return { ...result, appRoot, opener, props };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("SecureShareSettingsModal", () => {
  it("is an accessible modal with initial focus, focus trap, Escape, and focus restoration", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { appRoot, opener, unmount } = renderModal({ onClose });
    const dialog = screen.getByRole("dialog", { name: "보안 공유 만들기" });
    const firstRadio = screen.getByRole("radio", { name: /링크를 가진 모든 사람/ });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(appRoot.inert).toBe(true);
    expect(appRoot).toHaveAttribute("aria-hidden", "true");
    expect(document.body.style.overflow).toBe("hidden");
    await waitFor(() => expect(firstRadio).toHaveFocus());

    const saveButton = screen.getByRole("button", { name: "보안 공유 만들기" });
    saveButton.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "보안 공유 설정 창 닫기" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(appRoot.inert).toBe(false);
    expect(appRoot).not.toHaveAttribute("aria-hidden");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("parses allowlist chips, forces email verification, and clears recipients on mode change", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSave });

    await user.click(screen.getByRole("radio", { name: /지정한 이메일만/ }));
    const emailVerification = screen.getByRole("checkbox", { name: /이메일 인증 필요/ });
    const emailInput = screen.getByLabelText("허용 이메일");

    expect(emailVerification).toBeChecked();
    expect(emailVerification).toBeDisabled();

    await user.type(emailInput, "First@Example.com{Enter}");
    await user.type(emailInput, "second@example.com{Enter}");
    await user.type(emailInput, "FIRST@example.com{Enter}");

    expect(screen.getByText("first@example.com")).toBeInTheDocument();
    expect(screen.getByText("second@example.com")).toBeInTheDocument();
    expect(screen.getByText("2/100")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "보안 공유 만들기" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      accessMode: "allowed_emails",
      allowedEmails: ["first@example.com", "second@example.com"],
      emailVerificationRequired: true
    }));

    await user.click(screen.getByRole("radio", { name: /로그인한 QuickMemo 사용자만/ }));
    expect(screen.queryByLabelText("허용 이메일")).not.toBeInTheDocument();
    expect(screen.queryByText("first@example.com")).not.toBeInTheDocument();
  });

  it("disables email-dependent controls when the server email feature is unavailable", () => {
    renderModal({ emailFeatureEnabled: false });

    expect(screen.getByRole("radio", { name: /지정한 이메일만/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /이메일 인증 필요/ })).toBeDisabled();
    expect(screen.getByText(/운영 이메일 인증 설정이 준비되지 않아/)).toBeInTheDocument();
  });

  it("preserves password whitespace exactly and requires matching confirmation", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSave });

    await user.click(screen.getByRole("checkbox", { name: /비밀번호 필요/ }));
    const passwordInput = screen.getByLabelText("비밀번호", { selector: "input" });
    const confirmationInput = screen.getByLabelText("비밀번호 확인");

    await user.type(passwordInput, " 123456 ");
    await user.type(confirmationInput, "different");
    await user.click(screen.getByRole("button", { name: "보안 공유 만들기" }));

    const mismatch = screen.getByRole("alert");
    expect(mismatch).toHaveTextContent("비밀번호 확인이 일치하지 않습니다.");
    expect(mismatch).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();

    await user.clear(confirmationInput);
    await user.type(confirmationInput, " 123456 ");
    await user.click(screen.getByRole("button", { name: "보안 공유 만들기" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      passwordEnabled: true,
      password: " 123456 "
    }));
  });

  it("does not reveal an existing password and confirms its removal", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({
      mode: "edit",
      hasStoredPassword: true,
      initialValue: {
        ...defaultSecureSharePolicy(),
        passwordEnabled: true
      },
      onSave
    });

    expect(screen.getByText("비밀번호가 설정되어 있습니다.")).toBeInTheDocument();
    expect(screen.queryByLabelText("새 비밀번호")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "비밀번호 제거" }));
    const confirmation = screen.getByRole("alert");
    expect(confirmation).toHaveTextContent("설정된 비밀번호를 제거할까요?");
    await user.click(within(confirmation).getByRole("button", { name: "비밀번호 제거 확인" }));
    await user.click(screen.getByRole("button", { name: "설정 저장" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedPolicy = onSave.mock.calls[0][0];
    expect(savedPolicy.passwordEnabled).toBe(false);
    expect(savedPolicy).not.toHaveProperty("password");
  });

  it("validates custom expiry and announces one-time and capability combinations", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSave });

    await user.click(screen.getByRole("checkbox", { name: /한 번 열람하면 링크 만료/ }));
    await user.click(screen.getByRole("checkbox", { name: /첨부파일 다운로드 금지/ }));
    await user.click(screen.getByRole("checkbox", { name: /본문 빠른 복사 버튼 숨기기/ }));
    await user.click(screen.getByRole("radio", { name: /QuickMemo에 복사본 저장 가능/ }));

    expect(screen.getByText(/직접 다운로드는 제한되지만 QuickMemo 내부 복사본 저장은 허용/))
      .toBeInTheDocument();
    const summary = screen.getByRole("heading", { name: "5. 현재 설정 요약" })
      .closest(".secure-share-settings-summary");
    expect(summary).toHaveTextContent("최초 인증에 성공한 한 명");
    expect(summary).toHaveTextContent("첨부파일 직접 다운로드는 제한");
    expect(summary).toHaveTextContent("본문 빠른 복사 버튼은 표시되지");

    await user.click(screen.getByRole("radio", { name: /직접 지정/ }));
    const customExpiry = screen.getByLabelText("만료 날짜와 시간");
    fireEvent.change(customExpiry, {
      target: { value: localDateTimeInputValue(new Date("2026-07-28T00:04:00.000Z")) }
    });
    await user.click(screen.getByRole("button", { name: "보안 공유 만들기" }));

    expect(screen.getByRole("alert")).toHaveTextContent("최소 5분 이후");
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(customExpiry, {
      target: { value: localDateTimeInputValue(new Date("2026-07-29T00:00:00.000Z")) }
    });
    await user.click(screen.getByRole("button", { name: "보안 공유 만들기" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      expirationPreset: "custom",
      customExpiresAt: "2026-07-29T00:00:00.000Z",
      oneTimeEnabled: true,
      oneTimeScope: "global",
      permissionLevel: "save_copy",
      downloadAllowed: false,
      quickCopyButtonVisible: false
    }));
  });

  it("keeps the dialog busy and moves focus to a save failure", async () => {
    const user = userEvent.setup();
    renderModal({
      onSave: vi.fn().mockRejectedValue(new Error("서버에서 설정을 저장하지 못했습니다."))
    });

    await user.click(screen.getByRole("button", { name: "보안 공유 만들기" }));
    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("서버에서 설정을 저장하지 못했습니다.");
    expect(alert).toHaveFocus();
  });
});
