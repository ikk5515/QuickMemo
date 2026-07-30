import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminEmailSettingsError, type AdminEmailSettingsStatus } from "../services/adminEmailSettings";
import { AdminEmailSettingsPanel } from "./AdminEmailSettingsPanel";

const stylesSource = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

const serviceMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  disable: vi.fn(),
  discard: vi.fn(),
  getStatus: vi.fn(),
  remove: vi.fn(),
  sendTest: vi.fn(),
  stage: vi.fn()
}));

vi.mock("../services/adminEmailSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/adminEmailSettings")>();
  return {
    ...original,
    confirmAdminEmailSettingsTest: serviceMocks.confirm,
    disableAdminEmailSettings: serviceMocks.disable,
    discardPendingAdminEmailSettings: serviceMocks.discard,
    getAdminEmailSettingsStatus: serviceMocks.getStatus,
    removeAdminEmailSettings: serviceMocks.remove,
    sendAdminEmailSettingsTest: serviceMocks.sendTest,
    stageAdminEmailSettings: serviceMocks.stage
  };
});

function settings(overrides: Partial<AdminEmailSettingsStatus> = {}): AdminEmailSettingsStatus {
  return {
    enabled: false,
    active: {
      present: false,
      generation: null,
      host: null,
      port: null,
      securityMode: null,
      usernameMasked: null,
      replyToMasked: null,
      verifiedAt: null,
      stagedAt: null,
      testSentAt: null,
      testExpiresAt: null,
      attemptsRemaining: null
    },
    pending: {
      present: false,
      generation: null,
      host: null,
      port: null,
      securityMode: null,
      usernameMasked: null,
      replyToMasked: null,
      verifiedAt: null,
      stagedAt: null,
      testSentAt: null,
      testExpiresAt: null,
      attemptsRemaining: null
    },
    ...overrides
  };
}

describe("AdminEmailSettingsPanel", () => {
  beforeEach(() => {
    for (const mock of Object.values(serviceMocks)) {
      mock.mockReset();
    }
    serviceMocks.getStatus.mockResolvedValue(settings());
  });

  it("defaults to the trusted Gmail TLS profile and never asks for the QuickMemo password", async () => {
    render(<AdminEmailSettingsPanel />);

    expect(await screen.findByLabelText("SMTP 서버")).toHaveValue("smtp.gmail.com");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "admin-email-settings-panel");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "admin-email-settings-tab");
    expect(screen.getByText("포트 465")).toBeInTheDocument();
    expect(screen.getByText("Implicit TLS · TLS 1.2 이상")).toBeInTheDocument();
    const passwordInput = screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호");
    const settingsForm = passwordInput.closest("form");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(passwordInput).toHaveAttribute("autocomplete", "new-password");
    expect(passwordInput).toHaveAttribute("data-1p-ignore", "true");
    expect(settingsForm).toHaveAttribute("autocomplete", "off");
    expect(settingsForm).toHaveAttribute("data-bwignore", "true");
    expect(screen.getByText(/비밀번호 저장을 제안하면 거부/u)).toBeInTheDocument();
    expect(screen.getByText(/검증된 Gmail·Outlook SMTP 서버 3개만/u)).toBeInTheDocument();
    expect(screen.queryByLabelText("QuickMemo 비밀번호")).not.toBeInTheDocument();
  });

  it("defines theme-aware disabled input styling without hiding field values", () => {
    const disabledInputRule = stylesSource.match(
      /\.admin-email-settings-panel input:disabled \{[\s\S]*?\n\}/u
    )?.[0] ?? "";

    expect(disabledInputRule).toContain("background: var(--color-surface-muted)");
    expect(disabledInputRule).toContain("color: var(--color-text-secondary)");
    expect(disabledInputRule).toContain("cursor: not-allowed");
    expect(disabledInputRule).toContain("opacity: 1");
  });

  it("offers only trusted Gmail and Outlook profiles and explains the Modern Auth limit", async () => {
    const user = userEvent.setup();
    render(<AdminEmailSettingsPanel />);

    const preset = await screen.findByLabelText("빠른 설정");
    await waitFor(() => expect(preset).not.toBeDisabled());
    expect(screen.getByLabelText("SMTP 서버")).toHaveValue("smtp.gmail.com");

    await user.type(
      screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호"),
      "abcdefghijklmnop"
    );
    await user.selectOptions(preset, "outlook");

    expect(screen.getByLabelText("SMTP 서버")).toHaveValue("smtp-mail.outlook.com");
    expect(screen.getByLabelText("SMTP 포트")).toHaveValue("587");
    expect(screen.getByLabelText("TLS 보안 방식")).toHaveValue("starttls");
    expect(screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호")).toHaveValue("");
    expect(screen.getByText(/OAuth2\(Modern Auth\)를 지원하지 않으므로/u)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /직접 입력/u })).not.toBeInTheDocument();

    await user.selectOptions(preset, "microsoft365");
    expect(screen.getByLabelText("SMTP 서버")).toHaveValue("smtp.office365.com");
    expect(screen.getByLabelText("SMTP 포트")).toHaveValue("587");
  });

  it("clears the app password from React-controlled DOM immediately after staging starts", async () => {
    let resolveStage: ((value: AdminEmailSettingsStatus) => void) | undefined;
    serviceMocks.stage.mockImplementation(() => new Promise<AdminEmailSettingsStatus>((resolve) => {
      resolveStage = resolve;
    }));
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    await waitFor(() => expect(screen.getByLabelText("SMTP 사용자 이메일")).not.toBeDisabled());

    await user.type(screen.getByLabelText("SMTP 사용자 이메일"), "quickmemo.test@gmail.com");
    await user.type(screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호"), "abcdefghijklmnop");
    await user.type(screen.getByLabelText(/Reply-To/u), "reply@example.com");
    await user.click(screen.getByRole("button", { name: "새 설정 임시 저장" }));

    expect(serviceMocks.stage).toHaveBeenCalledWith({
      host: "smtp.gmail.com",
      port: 465,
      securityMode: "implicit_tls",
      username: "quickmemo.test@gmail.com",
      password: "abcdefghijklmnop",
      replyTo: "reply@example.com"
    });
    expect(screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("SMTP 사용자 이메일")).toBeDisabled();

    resolveStage?.(settings({
      pending: {
        ...settings().pending,
        present: true,
        generation: "pending_012345678",
        usernameMasked: "q***@gmail.com"
      }
    }));
    await screen.findByText(/새 설정을 임시 저장했습니다/u);
    expect(screen.getByLabelText("SMTP 사용자 이메일")).toHaveValue("");
    expect(screen.getByLabelText(/Reply-To/u)).toHaveValue("");
    expect(screen.getByLabelText("SMTP 사용자 이메일")).not.toBeDisabled();
  });

  it("sends the test only through the pending generation and activates after a six-digit code", async () => {
    const pendingSettings = settings({
      pending: {
        ...settings().pending,
        present: true,
        generation: "pending_012345678",
        usernameMasked: "q***@gmail.com",
        attemptsRemaining: 5
      }
    });
    const sentSettings = settings({
      pending: {
        ...pendingSettings.pending,
        testSentAt: "2026-07-30T12:00:00.000Z",
        testExpiresAt: "2026-07-30T12:10:00.000Z"
      }
    });
    const activeSettings = settings({
      enabled: true,
      active: {
        ...settings().active,
        present: true,
        generation: "active_0123456789",
        usernameMasked: "q***@gmail.com",
        verifiedAt: "2026-07-30T13:00:00.000Z"
      }
    });
    serviceMocks.getStatus.mockResolvedValue(pendingSettings);
    serviceMocks.sendTest.mockResolvedValue(sentSettings);
    serviceMocks.confirm.mockResolvedValue(activeSettings);
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    expect(await screen.findByText(/테스트 메일 발송이 완료되면/u)).toBeInTheDocument();
    expect(screen.queryByLabelText("6자리 인증 코드")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "설정 주소로 테스트 발송" }));

    expect(serviceMocks.sendTest).toHaveBeenCalledWith({ generation: "pending_012345678" });
    expect(await screen.findByText(/설정한 SMTP 사용자 이메일로 테스트 메일/u)).toBeInTheDocument();

    const codeInput = screen.getByLabelText("6자리 인증 코드");
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: "코드 확인 및 설정 적용" }));

    expect(serviceMocks.confirm).toHaveBeenCalledWith({
      generation: "pending_012345678",
      code: "123456"
    });
    expect(codeInput).toHaveValue("");
    expect(await screen.findByText(/이메일 발송을 활성화했습니다/u)).toBeInTheDocument();
    expect(screen.getByText("발송 활성")).toBeInTheDocument();
  });

  it("does not claim effective activation when the verified backend status remains disabled", async () => {
    const pendingSettings = settings({
      pending: {
        ...settings().pending,
        present: true,
        generation: "pending_012345678",
        usernameMasked: "q***@gmail.com",
        attemptsRemaining: 5,
        testSentAt: "2026-07-30T12:00:00.000Z",
        testExpiresAt: "2026-07-30T12:10:00.000Z"
      }
    });
    const storedButDisabled = settings({
      enabled: false,
      active: {
        ...settings().active,
        present: true,
        generation: "active_0123456789",
        usernameMasked: "q***@gmail.com",
        verifiedAt: "2026-07-30T13:00:00.000Z"
      }
    });
    serviceMocks.getStatus.mockResolvedValue(pendingSettings);
    serviceMocks.confirm.mockResolvedValue(storedButDisabled);
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    const codeInput = await screen.findByLabelText("6자리 인증 코드");
    await waitFor(() => expect(codeInput).not.toBeDisabled());
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: "코드 확인 및 설정 적용" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "운영 이메일 기능이 비활성 상태여서 발송은 아직 활성화되지 않았습니다."
    );
    expect(screen.queryByText(/이메일 발송을 활성화했습니다/u)).not.toBeInTheDocument();
    expect(screen.getByText("설정 저장 · 발송 비활성")).toBeInTheDocument();
    expect(screen.getByText(/운영 발송 스위치 또는 필수 설정이 비활성/u)).toBeInTheDocument();
  });

  it("clears the OTP and disables mutation controls while confirmation is in flight", async () => {
    const pendingSettings = settings({
      pending: {
        ...settings().pending,
        present: true,
        generation: "pending_012345678",
        usernameMasked: "q***@gmail.com",
        attemptsRemaining: 5,
        testSentAt: "2026-07-30T12:00:00.000Z",
        testExpiresAt: "2026-07-30T12:10:00.000Z"
      }
    });
    let resolveConfirm: ((value: AdminEmailSettingsStatus) => void) | undefined;
    serviceMocks.getStatus.mockResolvedValue(pendingSettings);
    serviceMocks.confirm.mockImplementation(() => new Promise<AdminEmailSettingsStatus>((resolve) => {
      resolveConfirm = resolve;
    }));
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    const codeInput = await screen.findByLabelText("6자리 인증 코드");
    await waitFor(() => expect(codeInput).not.toBeDisabled());
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: "코드 확인 및 설정 적용" }));

    expect(codeInput).toHaveValue("");
    expect(codeInput).toBeDisabled();
    expect(screen.getByRole("button", { name: "설정 주소로 테스트 발송" })).toBeDisabled();

    resolveConfirm?.(pendingSettings);
    await waitFor(() => expect(codeInput).not.toBeDisabled());
  });

  it("locks mutation retries after an ambiguous failure until status refresh succeeds", async () => {
    const pendingSettings = settings({
      pending: {
        ...settings().pending,
        present: true,
        generation: "pending_012345678",
        usernameMasked: "q***@gmail.com",
        attemptsRemaining: 5,
        testSentAt: "2026-07-30T12:00:00.000Z",
        testExpiresAt: "2026-07-30T12:10:00.000Z"
      }
    });
    serviceMocks.getStatus.mockResolvedValue(pendingSettings);
    serviceMocks.confirm.mockRejectedValue(new AdminEmailSettingsError(
      "network_error",
      "네트워크 연결과 최신 설정 상태를 확인한 후 다시 시도해주세요."
    ));
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    const codeInput = await screen.findByLabelText("6자리 인증 코드");
    await waitFor(() => expect(codeInput).not.toBeDisabled());
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: "코드 확인 및 설정 적용" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("최신 설정 상태를 확인");
    expect(codeInput).toHaveValue("");
    expect(codeInput).toBeDisabled();
    expect(screen.getByRole("button", { name: "이메일 설정 상태 새로고침" })).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: "이메일 설정 상태 새로고침" }));
    await waitFor(() => expect(codeInput).not.toBeDisabled());
    expect(serviceMocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("requires a status refresh after SMTP test delivery fails", async () => {
    const pendingSettings = settings({
      pending: {
        ...settings().pending,
        present: true,
        generation: "pending_012345678",
        usernameMasked: "q***@gmail.com",
        attemptsRemaining: 5
      }
    });
    serviceMocks.getStatus.mockResolvedValue(pendingSettings);
    serviceMocks.sendTest.mockRejectedValue(new AdminEmailSettingsError(
      "smtp_verification_failed",
      "SMTP 연결을 확인하지 못했습니다.",
      503
    ));
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    const sendButton = await screen.findByRole("button", {
      name: "설정 주소로 테스트 발송"
    });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SMTP 연결을 확인하지 못했습니다."
    );
    expect(sendButton).toBeDisabled();

    await user.click(screen.getByRole("button", {
      name: "이메일 설정 상태 새로고침"
    }));
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    expect(serviceMocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("shows a safe re-login instruction and does not echo server content", async () => {
    serviceMocks.stage.mockRejectedValue(new AdminEmailSettingsError(
      "recent_auth_required",
      "보안을 위해 다시 로그인 후 시도해주세요.",
      401
    ));
    const user = userEvent.setup();

    render(<AdminEmailSettingsPanel />);
    await waitFor(() => expect(screen.getByLabelText("SMTP 사용자 이메일")).not.toBeDisabled());
    await user.type(screen.getByLabelText("SMTP 사용자 이메일"), "quickmemo.test@gmail.com");
    await user.type(screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호"), "abcdefghijklmnop");
    await user.click(screen.getByRole("button", { name: "새 설정 임시 저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("보안을 위해 다시 로그인 후 시도해주세요.");
    await waitFor(() => expect(screen.getByLabelText("SMTP 비밀번호 / 앱 비밀번호")).toHaveValue(""));
  });
});
