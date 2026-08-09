import { CheckCircle2, KeyRound, Mail, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AdminEmailSettingsError,
  confirmAdminEmailSettingsTest,
  disableAdminEmailSettings,
  discardPendingAdminEmailSettings,
  getAdminEmailSettingsStatus,
  removeAdminEmailSettings,
  sendAdminEmailSettingsTest,
  stageAdminEmailSettings,
  type AdminEmailSettingsSecurityMode,
  type AdminEmailSettingsSmtpPort,
  type AdminEmailSettingsStatus
} from "../services/adminEmailSettings";
import { AppSelect } from "./AppSelect";

type PendingAction =
  | "status"
  | "stage"
  | "send-test"
  | "confirm-test"
  | "disable"
  | "discard-pending"
  | "remove"
  | null;

type SmtpPreset = "gmail" | "outlook" | "microsoft365";

const smtpPresets = {
  gmail: {
    host: "smtp.gmail.com",
    port: 465 as const,
    securityMode: "implicit_tls" as const
  },
  outlook: {
    host: "smtp-mail.outlook.com",
    port: 587 as const,
    securityMode: "starttls" as const
  },
  microsoft365: {
    host: "smtp.office365.com",
    port: 587 as const,
    securityMode: "starttls" as const
  }
};

const statusRefreshRequiredErrorCodes = new Set([
  "attempts_exhausted",
  "conflict",
  "invalid_response",
  "invalid_test_code",
  "network_error",
  "request_timeout",
  "test_expired"
]);

function formatStatusDate(value: string | null) {
  if (!value) {
    return "없음";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "확인 불가";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatSecurityMode(value: AdminEmailSettingsSecurityMode | null) {
  return value === "implicit_tls"
    ? "Implicit TLS"
    : value === "starttls"
      ? "필수 STARTTLS"
      : "";
}

function visibleError(caught: unknown) {
  if (caught instanceof AdminEmailSettingsError) {
    return caught.message;
  }
  return "이메일 설정 요청을 처리하지 못했습니다.";
}

export function AdminEmailSettingsPanel() {
  const [settings, setSettings] = useState<AdminEmailSettingsStatus | null>(null);
  const [preset, setPreset] = useState<SmtpPreset>("gmail");
  const [host, setHost] = useState(smtpPresets.gmail.host);
  const [port, setPort] = useState<AdminEmailSettingsSmtpPort>(smtpPresets.gmail.port);
  const [securityMode, setSecurityMode] = useState<AdminEmailSettingsSecurityMode>(
    smtpPresets.gmail.securityMode
  );
  const [username, setUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>("status");
  const [statusRefreshRequired, setStatusRefreshRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const mountedRef = useRef(true);

  const showError = useCallback((caught: unknown) => {
    if (!mountedRef.current) {
      return;
    }
    setNotice(null);
    setError(visibleError(caught));
    if (
      caught instanceof AdminEmailSettingsError
      && statusRefreshRequiredErrorCodes.has(caught.code)
    ) {
      setStatusRefreshRequired(true);
    }
  }, []);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setPendingAction("status");
    setError(null);

    try {
      const nextSettings = await getAdminEmailSettingsStatus({ signal });
      if (mountedRef.current) {
        setSettings(nextSettings);
        setStatusRefreshRequired(false);
      }
    } catch (caught) {
      if (caught instanceof AdminEmailSettingsError && caught.code === "request_cancelled") {
        return;
      }
      if (!mountedRef.current) {
        return;
      }
      setStatusRefreshRequired(true);
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }, [showError]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void loadStatus(controller.signal);

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [loadStatus]);

  useEffect(() => {
    if (notice || error) {
      feedbackRef.current?.focus();
    }
  }, [error, notice]);

  async function handleStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingAction("stage");
    setNotice(null);
    setError(null);

    let stageRequest: ReturnType<typeof stageAdminEmailSettings>;
    try {
      stageRequest = stageAdminEmailSettings({
        host,
        port,
        securityMode,
        username,
        password: smtpPassword,
        replyTo
      });
    } catch (caught) {
      setSmtpPassword("");
      showError(caught);
      setPendingAction(null);
      return;
    }

    // The app password must leave React state immediately after it is handed
    // to the one-time request. It is never written to browser storage.
    setSmtpPassword("");

    try {
      const nextSettings = await stageRequest;
      if (!mountedRef.current) {
        return;
      }
      setSettings(nextSettings);
      setStatusRefreshRequired(false);
      setUsername("");
      setReplyTo("");
      setVerificationCode("");
      setNotice("새 설정을 임시 저장했습니다. 검증 완료 전까지 기존 저장 설정은 그대로 유지됩니다.");
    } catch (caught) {
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function handleSendTest() {
    const generation = settings?.pending.generation;
    if (generation === null || generation === undefined) {
      setError("임시 설정 버전을 확인하지 못했습니다. 상태를 새로고침해주세요.");
      return;
    }

    setPendingAction("send-test");
    setNotice(null);
    setError(null);
    setVerificationCode("");

    try {
      const nextSettings = await sendAdminEmailSettingsTest({ generation });
      if (!mountedRef.current) {
        return;
      }
      setSettings(nextSettings);
      setStatusRefreshRequired(false);
      setNotice("설정한 SMTP 사용자 이메일로 테스트 메일을 보냈습니다. 메일의 6자리 코드를 입력해주세요.");
      requestAnimationFrame(() => codeInputRef.current?.focus());
    } catch (caught) {
      if (
        caught instanceof AdminEmailSettingsError
        && caught.code === "smtp_verification_failed"
      ) {
        setStatusRefreshRequired(true);
      }
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function handleConfirmTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const generation = settings?.pending.generation;
    if (generation === null || generation === undefined) {
      setError("임시 설정 버전을 확인하지 못했습니다. 상태를 새로고침해주세요.");
      return;
    }

    const code = verificationCode;
    setPendingAction("confirm-test");
    setNotice(null);
    setError(null);
    setVerificationCode("");

    let confirmRequest: ReturnType<typeof confirmAdminEmailSettingsTest>;
    try {
      confirmRequest = confirmAdminEmailSettingsTest({
        generation,
        code
      });
    } catch (caught) {
      showError(caught);
      setPendingAction(null);
      return;
    }

    try {
      const nextSettings = await confirmRequest;
      if (!mountedRef.current) {
        return;
      }
      setSettings(nextSettings);
      setStatusRefreshRequired(false);
      setNotice(
        nextSettings.enabled
          ? "테스트 메일 인증을 완료해 이메일 발송을 활성화했습니다."
          : "테스트 메일 인증과 설정 저장을 완료했습니다. 운영 이메일 기능이 비활성 상태여서 발송은 아직 활성화되지 않았습니다."
      );
    } catch (caught) {
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function handleDisable() {
    if (!window.confirm("Secure Share 이메일 발송을 비활성화할까요?\n기존 링크·비밀번호 공유는 계속 사용할 수 있습니다.")) {
      return;
    }

    setPendingAction("disable");
    setNotice(null);
    setError(null);

    try {
      const nextSettings = await disableAdminEmailSettings();
      if (!mountedRef.current) {
        return;
      }
      setSettings(nextSettings);
      setStatusRefreshRequired(false);
      setNotice("이메일 발송을 비활성화했습니다. 저장된 자격증명은 별도로 삭제할 수 있습니다.");
    } catch (caught) {
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function handleDiscardPending() {
    const generation = settings?.pending.generation;
    if (generation === null || generation === undefined) {
      setError("임시 설정 버전을 확인하지 못했습니다. 상태를 새로고침해주세요.");
      return;
    }
    if (!window.confirm("검증 중인 임시 설정을 폐기할까요?\n기존 저장 설정에는 영향을 주지 않습니다.")) {
      return;
    }

    setPendingAction("discard-pending");
    setNotice(null);
    setError(null);
    setVerificationCode("");

    try {
      const nextSettings = await discardPendingAdminEmailSettings({ generation });
      if (!mountedRef.current) {
        return;
      }
      setSettings(nextSettings);
      setStatusRefreshRequired(false);
      setNotice("임시 설정을 폐기했습니다. 기존 저장 설정은 유지됩니다.");
    } catch (caught) {
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function handleRemoveAll() {
    if (
      !window.confirm(
        "저장된 SMTP 설정을 모두 삭제할까요?\n이 작업은 되돌릴 수 없으며 이메일 공유가 즉시 중지됩니다."
      )
    ) {
      return;
    }

    setPendingAction("remove");
    setNotice(null);
    setError(null);
    setSmtpPassword("");
    setVerificationCode("");

    try {
      const nextSettings = await removeAdminEmailSettings({ target: "all" });
      if (!mountedRef.current) {
        return;
      }
      setSettings(nextSettings);
      setStatusRefreshRequired(false);
      setUsername("");
      setReplyTo("");
      setNotice("저장된 이메일 설정을 모두 삭제했습니다.");
    } catch (caught) {
      showError(caught);
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  }

  const busy = pendingAction !== null;
  const mutationControlsDisabled = busy || statusRefreshRequired || !settings;
  const active = settings?.active;
  const pending = settings?.pending;
  const pendingTestReady = Boolean(
    pending?.present
    && pending.testSentAt
    && pending.testExpiresAt
    && pending.attemptsRemaining !== null
    && pending.attemptsRemaining > 0
  );
  const isGmailTransport = host.trim().toLowerCase() === smtpPresets.gmail.host;
  const isOutlookTransport = new Set([
    smtpPresets.outlook.host,
    "smtp.office365.com"
  ]).has(host.trim().toLowerCase());
  const passwordReady = isGmailTransport
    ? (
      /^[A-Za-z0-9]{16}$/u.test(smtpPassword)
      || /^[A-Za-z0-9]{4}( [A-Za-z0-9]{4}){3}$/u.test(smtpPassword)
    )
    : smtpPassword.length >= 8 && smtpPassword.length <= 256;
  const securityModeLabel = securityMode === "implicit_tls"
    ? "Implicit TLS"
    : "필수 STARTTLS";

  function applyPreset(nextPreset: SmtpPreset) {
    setPreset(nextPreset);
    setSmtpPassword("");
    const next = smtpPresets[nextPreset];
    setHost(next.host);
    setPort(next.port);
    setSecurityMode(next.securityMode);
  }

  function updatePort(nextPort: AdminEmailSettingsSmtpPort) {
    setPort(nextPort);
    setSecurityMode(nextPort === 465 ? "implicit_tls" : "starttls");
    setSmtpPassword("");
  }

  function updateSecurityMode(nextMode: AdminEmailSettingsSecurityMode) {
    setSecurityMode(nextMode);
    setPort(nextMode === "implicit_tls" ? 465 : 587);
    setSmtpPassword("");
  }

  return (
    <section
      aria-busy={busy}
      aria-labelledby="admin-email-settings-tab"
      className="panel wide-panel admin-email-settings-panel"
      id="admin-email-settings-panel"
      role="tabpanel"
    >
      <div className="admin-section-header admin-email-settings-heading">
        <div>
          <h2 id="admin-email-settings-title">
            <Mail size={20} />
            이메일 설정
          </h2>
          <p>Secure Share 이메일·OTP를 위한 SMTP 연결을 안전하게 설정합니다.</p>
        </div>
        <button
          aria-label="이메일 설정 상태 새로고침"
          className="secondary-button"
          disabled={busy}
          onClick={() => void loadStatus()}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} />
          새로고침
        </button>
      </div>

      <div className="admin-email-security-note">
        <ShieldAlert aria-hidden="true" size={18} />
        <p>
          QuickMemo 로그인 비밀번호가 아닌 <strong>메일 공급자가 허용한 SMTP 비밀번호 또는 앱 비밀번호</strong>를 사용합니다.
          비밀번호는 이 요청에만 사용되며 브라우저 저장소나 화면 상태 응답에 보관하지 않습니다.
          브라우저나 확장 프로그램이 비밀번호 저장을 제안하면 거부하세요.
        </p>
      </div>

      {pendingAction === "status" && !settings && (
        <p aria-live="polite" className="muted admin-email-loading">이메일 설정 상태를 확인하는 중입니다.</p>
      )}

      {settings && (
        <div className="admin-email-status-grid" aria-label="이메일 설정 상태">
          <article className="admin-email-status-card">
            <header>
              <div>
                <span className={`admin-email-status-badge ${settings.enabled ? "enabled" : "disabled"}`}>
                  {settings.enabled
                    ? "발송 활성"
                    : active?.present
                      ? "설정 저장 · 발송 비활성"
                      : "발송 비활성"}
                </span>
                <h3>저장된 검증 설정</h3>
              </div>
              {settings.enabled && <CheckCircle2 aria-label="활성화됨" size={20} />}
            </header>
            {active?.present ? (
              <>
                <dl>
                  <div><dt>SMTP 계정</dt><dd>{active.usernameMasked ?? "마스킹됨"}</dd></div>
                  {active.host && (
                    <div>
                      <dt>연결</dt>
                      <dd>
                        {active.host}
                        {active.port ? `:${active.port}` : ""}
                        {active.securityMode
                          ? ` · ${formatSecurityMode(active.securityMode)}`
                          : ""}
                      </dd>
                    </div>
                  )}
                  <div><dt>Reply-To</dt><dd>{active.replyToMasked ?? "설정 안 함"}</dd></div>
                  <div><dt>검증 완료</dt><dd>{formatStatusDate(active.verifiedAt)}</dd></div>
                </dl>
                {!settings.enabled && (
                  <p className="admin-email-preserve-note">
                    검증된 설정은 저장되어 있지만 운영 발송 스위치 또는 필수 설정이 비활성 상태입니다.
                  </p>
                )}
              </>
            ) : (
              <p className="muted">활성 설정이 없습니다.</p>
            )}
          </article>

          <article className="admin-email-status-card pending">
            <header>
              <div>
                <span className={`admin-email-status-badge ${pending?.present ? "pending" : "empty"}`}>
                  {pending?.present ? "검증 대기" : "대기 없음"}
                </span>
                <h3>새 설정</h3>
              </div>
              <KeyRound aria-hidden="true" size={20} />
            </header>
            {pending?.present ? (
              <>
                <dl>
                  <div><dt>SMTP 계정</dt><dd>{pending.usernameMasked ?? "마스킹됨"}</dd></div>
                  {pending.host && (
                    <div>
                      <dt>연결</dt>
                      <dd>
                        {pending.host}
                        {pending.port ? `:${pending.port}` : ""}
                        {pending.securityMode
                          ? ` · ${formatSecurityMode(pending.securityMode)}`
                          : ""}
                      </dd>
                    </div>
                  )}
                  <div><dt>임시 저장</dt><dd>{formatStatusDate(pending.stagedAt)}</dd></div>
                  <div><dt>테스트 만료</dt><dd>{formatStatusDate(pending.testExpiresAt)}</dd></div>
                  <div><dt>남은 시도</dt><dd>{pending.attemptsRemaining ?? "확인 전"}</dd></div>
                </dl>
                <p className="admin-email-preserve-note">
                  테스트 실패·취소 시에도 기존 저장 설정은 바뀌지 않습니다.
                </p>
              </>
            ) : (
              <p className="muted">검증 중인 새 설정이 없습니다.</p>
            )}
          </article>
        </div>
      )}

      <div className="admin-email-provider">
        <strong>선택한 보안 연결</strong>
        <span>{host || "SMTP 서버 미입력"}</span>
        <span>포트 {port}</span>
        <span>{securityModeLabel} · TLS 1.2 이상</span>
      </div>

      <form
        autoComplete="off"
        className="admin-email-settings-form"
        data-1p-ignore="true"
        data-bwignore="true"
        data-lpignore="true"
        onSubmit={handleStage}
      >
        <div className="admin-section-header">
          <div>
            <h3>{active?.present ? "새 SMTP 설정으로 변경" : "SMTP 설정 등록"}</h3>
            <p>새 설정은 테스트 메일 인증 후 적용되며 실제 발송 여부는 운영 스위치 상태에 따릅니다.</p>
          </div>
        </div>
        <div className="admin-email-form-grid">
          <label>
            빠른 설정
            <AppSelect
              disabled={mutationControlsDisabled}
              onChange={(event) => applyPreset(event.target.value as SmtpPreset)}
              value={preset}
            >
              <option value="gmail">Gmail / Google Workspace</option>
              <option value="outlook">Outlook.com</option>
              <option value="microsoft365">Microsoft 365 비즈니스·학교</option>
            </AppSelect>
          </label>
          <label>
            SMTP 서버
            <AppSelect
              disabled={mutationControlsDisabled}
              onChange={(event) => {
                const nextHost = event.target.value;
                const nextPreset = Object.entries(smtpPresets).find(
                  ([, configuration]) => configuration.host === nextHost
                )?.[0] as SmtpPreset | undefined;
                if (nextPreset) {
                  applyPreset(nextPreset);
                }
              }}
              value={host}
            >
              <option value="smtp.gmail.com">smtp.gmail.com</option>
              <option value="smtp-mail.outlook.com">smtp-mail.outlook.com</option>
              <option value="smtp.office365.com">smtp.office365.com</option>
            </AppSelect>
          </label>
          <label>
            SMTP 포트
            <AppSelect
              disabled={mutationControlsDisabled}
              onChange={(event) => updatePort(Number(event.target.value) as AdminEmailSettingsSmtpPort)}
              value={port}
            >
              {isGmailTransport && <option value={465}>465</option>}
              <option value={587}>587</option>
            </AppSelect>
          </label>
          <label>
            TLS 보안 방식
            <AppSelect
              disabled={mutationControlsDisabled}
              onChange={(event) => updateSecurityMode(event.target.value as AdminEmailSettingsSecurityMode)}
              value={securityMode}
            >
              {isGmailTransport && (
                <option value="implicit_tls">Implicit TLS (포트 465)</option>
              )}
              <option value="starttls">필수 STARTTLS (포트 587)</option>
            </AppSelect>
          </label>
          <label>
            SMTP 사용자 이메일
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={mutationControlsDisabled}
              inputMode="email"
              maxLength={254}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="name@school.ac.kr"
              required
              spellCheck={false}
              type="email"
              value={username}
            />
          </label>
          <label>
            SMTP 비밀번호 / 앱 비밀번호
            <input
              aria-describedby="admin-email-app-password-help"
              autoCapitalize="none"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
              data-lpignore="true"
              disabled={mutationControlsDisabled}
              maxLength={256}
              minLength={isGmailTransport ? 16 : 8}
              name="quickmemo-smtp-one-time-secret"
              onChange={(event) => setSmtpPassword(event.target.value)}
              placeholder={isGmailTransport ? "Google 앱 비밀번호 16자리" : "SMTP 비밀번호 또는 앱 비밀번호"}
              required
              spellCheck={false}
              type="password"
              value={smtpPassword}
            />
          </label>
          <label className="admin-email-reply-to">
            Reply-To <span>(선택)</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={mutationControlsDisabled}
              inputMode="email"
              maxLength={254}
              onChange={(event) => setReplyTo(event.target.value)}
              placeholder="답장을 받을 이메일"
              spellCheck={false}
              type="email"
              value={replyTo}
            />
          </label>
        </div>
        <p className="admin-email-field-help">
          서버 측 요청 위조와 내부망 접근을 막기 위해 검증된 Gmail·Outlook SMTP 서버 3개만 선택할 수 있습니다.
        </p>
        <p className="admin-email-field-help" id="admin-email-app-password-help">
          {isGmailTransport
            ? "Gmail과 Google Workspace는 2단계 인증에서 발급한 Google 앱 비밀번호 16자리를 사용하세요."
            : "메일 공급자가 SMTP 인증에 허용한 비밀번호 또는 전용 앱 비밀번호를 사용하세요."}
          {" "}QuickMemo 로그인 비밀번호는 입력하지 마세요.
        </p>
        {isOutlookTransport && (
          <p className="admin-email-field-help" role="note">
            Outlook.com 사전 설정은 smtp-mail.outlook.com:587과 필수 STARTTLS를 사용합니다.
            Microsoft 365 비즈니스·학교 계정은 별도 사전 설정의 smtp.office365.com을 선택하세요.
            이 화면은 OAuth2(Modern Auth)를 지원하지 않으므로 SMTP AUTH가 비활성화됐거나 Modern Auth가 필수인 계정은 연결할 수 없습니다.
          </p>
        )}
        <button disabled={mutationControlsDisabled || !passwordReady} type="submit">
          {pendingAction === "stage" ? "안전하게 저장 중" : "새 설정 임시 저장"}
        </button>
      </form>

      {pending?.present && (
        <section aria-labelledby="admin-email-verification-title" className="admin-email-verification">
          <div>
            <h3 id="admin-email-verification-title">테스트 메일 인증</h3>
            <p>
              테스트 메일은 위에 표시된 SMTP 사용자 이메일로만 전송됩니다. 코드는 6자리이며 제한 시간과 입력 횟수가 있습니다.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={mutationControlsDisabled || pending.generation === null}
            onClick={() => void handleSendTest()}
            type="button"
          >
            {pendingAction === "send-test" ? "테스트 발송 중" : "설정 주소로 테스트 발송"}
          </button>
          {pendingTestReady ? (
            <form onSubmit={handleConfirmTest}>
              <label>
                6자리 인증 코드
                <input
                  autoComplete="one-time-code"
                  disabled={mutationControlsDisabled}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setVerificationCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                  pattern="\d{6}"
                  placeholder="000000"
                  ref={codeInputRef}
                  required
                  type="text"
                  value={verificationCode}
                />
              </label>
              <button disabled={mutationControlsDisabled || verificationCode.length !== 6} type="submit">
                {pendingAction === "confirm-test" ? "확인 중" : "코드 확인 및 설정 적용"}
              </button>
            </form>
          ) : (
            <p className="admin-email-verification-wait">
              테스트 메일 발송이 완료되면 인증 코드 입력란이 표시됩니다.
            </p>
          )}
          <button
            className="secondary-button danger"
            disabled={mutationControlsDisabled}
            onClick={() => void handleDiscardPending()}
            type="button"
          >
            임시 설정 폐기
          </button>
        </section>
      )}

      {(notice || error) && (
        <p
          aria-live={error ? "assertive" : "polite"}
          className={error ? "form-error admin-email-feedback" : "form-success admin-email-feedback"}
          ref={feedbackRef}
          role={error ? "alert" : "status"}
          tabIndex={-1}
        >
          {error ?? notice}
        </p>
      )}

      {settings && (active?.present || pending?.present) && (
        <section aria-label="이메일 설정 위험 작업" className="admin-email-danger-zone">
          <div>
            <h3>비활성화·삭제</h3>
            <p>비활성화는 자격증명을 보존하고, 삭제는 저장된 설정을 복구할 수 없게 제거합니다.</p>
          </div>
          {active?.present && settings.enabled && (
            <button
              className="secondary-button"
              disabled={mutationControlsDisabled}
              onClick={() => void handleDisable()}
              type="button"
            >
              이메일 발송 비활성화
            </button>
          )}
          <button
            className="secondary-button danger"
            disabled={mutationControlsDisabled}
            onClick={() => void handleRemoveAll()}
            type="button"
          >
            <Trash2 aria-hidden="true" size={16} />
            저장된 설정 모두 삭제
          </button>
        </section>
      )}
    </section>
  );
}
