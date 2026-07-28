import { Copy, Eye, EyeOff, ShieldCheck, Trash2, WandSparkles, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import {
  defaultSecureSharePolicy,
  formatSecureShareExpiry,
  parseAllowedEmailChips,
  secureShareAllowedEmailLimit,
  secureShareCustomExpiryMaxMs,
  secureShareCustomExpiryMinMs,
  secureSharePasswordMaxLength,
  summarizeSecureSharePolicy,
  validateSecureSharePassword,
  validateSecureSharePolicyInput,
  type SecureShareAccessMode,
  type SecureShareExpirationPreset,
  type SecureSharePermissionLevel,
  type SecureSharePolicyInput
} from "../lib/secureSharePolicy";

export interface SecureShareSettingsModalProps {
  emailFeatureEnabled?: boolean;
  error?: string | null;
  hasStoredPassword?: boolean;
  initialValue?: SecureSharePolicyInput;
  mode?: "create" | "edit";
  now?: Date | string;
  onClose: () => void;
  onSave: (value: SecureSharePolicyInput) => Promise<void> | void;
  saving?: boolean;
  timeZone?: string;
}

interface RadioOption<T extends string> {
  description: string;
  label: string;
  value: T;
}

const accessModeOptions: readonly RadioOption<SecureShareAccessMode>[] = [
  {
    value: "anyone_with_link",
    label: "링크를 가진 모든 사람",
    description: "링크를 알고 있는 사람이 설정된 인증 절차를 거쳐 접근합니다."
  },
  {
    value: "allowed_emails",
    label: "지정한 이메일만",
    description: "목록에 추가한 이메일 소유자만 인증 후 접근합니다."
  },
  {
    value: "authenticated_users",
    label: "로그인한 QuickMemo 사용자만",
    description: "익명 계정을 제외한 QuickMemo 로그인 사용자만 접근합니다."
  }
];

const expirationOptions: readonly RadioOption<SecureShareExpirationPreset>[] = [
  { value: "one_hour", label: "1시간", description: "서버 시간 기준 1시간 후 종료" },
  { value: "one_day", label: "1일", description: "서버 시간 기준 1일 후 종료" },
  { value: "seven_days", label: "7일", description: "서버 시간 기준 7일 후 종료" },
  { value: "custom", label: "직접 지정", description: "5분 이후부터 365일 이내" }
];

const permissionOptions: readonly RadioOption<SecureSharePermissionLevel>[] = [
  {
    value: "view",
    label: "보기만 가능",
    description: "내용과 허용된 첨부 미리보기만 볼 수 있습니다."
  },
  {
    value: "comment",
    label: "댓글 가능",
    description: "내용을 보고 평문 댓글을 작성할 수 있습니다."
  },
  {
    value: "save_copy",
    label: "QuickMemo에 복사본 저장 가능",
    description: "로그인 사용자가 독립적으로 암호화된 새 노트를 만들 수 있습니다."
  }
];

const generatedPasswordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_";

function safeInitialNow(value: Date | string | undefined) {
  const candidate = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  return Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function toDateTimeLocalValue(value: Date | string | null) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return [
    date.getFullYear(),
    "-",
    padDatePart(date.getMonth() + 1),
    "-",
    padDatePart(date.getDate()),
    "T",
    padDatePart(date.getHours()),
    ":",
    padDatePart(date.getMinutes())
  ].join("");
}

function localDateTimeToIso(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function generatedSecureSharePassword(length = 24) {
  const result: string[] = [];
  const rejectionLimit = Math.floor(256 / generatedPasswordAlphabet.length)
    * generatedPasswordAlphabet.length;

  while (result.length < length) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(length));

    for (const randomByte of randomBytes) {
      if (randomByte < rejectionLimit) {
        result.push(generatedPasswordAlphabet[randomByte % generatedPasswordAlphabet.length]);
      }
      if (result.length === length) {
        break;
      }
    }
  }

  return result.join("");
}

function passwordStrength(password: string) {
  if (!password) {
    return { label: "입력 전", score: 0 };
  }

  const characterTypes = [
    /[a-z]/u.test(password),
    /[A-Z]/u.test(password),
    /\d/u.test(password),
    /[^\p{L}\p{N}]/u.test(password)
  ].filter(Boolean).length;
  const length = Array.from(password).length;
  const score = Math.min(
    4,
    Number(length >= 8)
      + Number(length >= 12)
      + Number(characterTypes >= 3)
      + Number(length >= 20)
  );

  return {
    score,
    label: score <= 1 ? "약함" : score <= 2 ? "보통" : score === 3 ? "강함" : "매우 강함"
  };
}

function errorMessage(caught: unknown) {
  return caught instanceof Error && caught.message
    ? caught.message
    : "보안 공유 설정을 저장하지 못했습니다. 다시 시도해주세요.";
}

export function SecureShareSettingsModal({
  emailFeatureEnabled = false,
  error = null,
  hasStoredPassword = false,
  initialValue,
  mode = "create",
  now,
  onClose,
  onSave,
  saving = false,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: SecureShareSettingsModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const emailInputId = useId();
  const emailHelpId = useId();
  const emailErrorId = useId();
  const passwordInputId = useId();
  const passwordConfirmId = useId();
  const passwordHelpId = useId();
  const customExpiryId = useId();
  const customExpiryHelpId = useId();
  const commenterIpPrefixHelpId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const firstControlRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const focusLifecycleRef = useRef(0);
  const mountedRef = useRef(true);
  const initialPolicy = initialValue ?? defaultSecureSharePolicy();
  const [draft, setDraft] = useState<SecureSharePolicyInput>(() => ({
    ...initialPolicy,
    allowedEmails: [...initialPolicy.allowedEmails],
    password: undefined
  }));
  const storedPasswordWasActive = mode === "edit"
    && hasStoredPassword
    && initialPolicy.passwordEnabled;
  const [passwordResetting, setPasswordResetting] = useState(
    initialPolicy.passwordEnabled && !storedPasswordWasActive
  );
  const [passwordRemovalConfirmed, setPasswordRemovalConfirmed] = useState(false);
  const [passwordRemovalPrompt, setPasswordRemovalPrompt] = useState(false);
  const [password, setPassword] = useState(
    mode === "create" ? initialValue?.password ?? "" : ""
  );
  const [passwordConfirmation, setPasswordConfirmation] = useState(
    mode === "create" ? initialValue?.password ?? "" : ""
  );
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordCopyNotice, setPasswordCopyNotice] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emailInputError, setEmailInputError] = useState("");
  const [localError, setLocalError] = useState("");
  const [internalSaving, setInternalSaving] = useState(false);
  const [validationNow] = useState(() => safeInitialNow(now));
  const busy = saving || internalSaving;
  const displayedError = error || localError;
  const strength = passwordStrength(password);
  const minimumCustomExpiry = new Date(
    validationNow.getTime() + secureShareCustomExpiryMinMs
  );
  const maximumCustomExpiry = new Date(
    validationNow.getTime() + secureShareCustomExpiryMaxMs
  );
  const customExpiryPreview = draft.customExpiresAt
    ? formatSecureShareExpiry(draft.customExpiresAt, { locale: "ko-KR", timeZone })
    : "만료 날짜와 시간을 선택해주세요.";
  const summary = useMemo(
    () => summarizeSecureSharePolicy(draft, { locale: "ko-KR", timeZone }),
    [draft, timeZone]
  );

  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  }, [busy, onClose]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const focusLifecycle = focusLifecycleRef.current + 1;
    focusLifecycleRef.current = focusLifecycle;
    restoreFocusRef.current ??= document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const appRoot = document.getElementById("root");
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;

    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "contain";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      if (!focusable?.length) {
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!dialogRef.current?.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    const focusTimer = window.setTimeout(() => {
      (firstControlRef.current ?? dialogRef.current)?.focus({ preventScroll: true });
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown, true);
      if (appRoot) {
        appRoot.inert = false;
        if (previousAriaHidden === null) {
          appRoot.removeAttribute("aria-hidden");
        } else {
          appRoot.setAttribute("aria-hidden", previousAriaHidden);
        }
      }
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      window.setTimeout(() => {
        if (focusLifecycleRef.current === focusLifecycle) {
          restoreFocusRef.current?.focus({ preventScroll: true });
        }
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (displayedError) {
      errorRef.current?.focus({ preventScroll: true });
    }
  }, [displayedError]);

  function updateDraft(patch: Partial<SecureSharePolicyInput>) {
    setDraft((current) => ({ ...current, ...patch }));
    setLocalError("");
  }

  function selectAccessMode(accessMode: SecureShareAccessMode) {
    updateDraft({
      accessMode,
      allowedEmails: accessMode === "allowed_emails" ? draft.allowedEmails : [],
      emailVerificationRequired: accessMode === "allowed_emails"
        ? true
        : false
    });
    setEmailInput("");
    setEmailInputError("");
  }

  function commitEmailInput(value = emailInput) {
    const parsed = parseAllowedEmailChips(value, draft.allowedEmails);

    updateDraft({ allowedEmails: parsed.emails });
    if (parsed.overflow.length > 0) {
      setEmailInputError(`허용 이메일은 최대 ${secureShareAllowedEmailLimit}개까지 추가할 수 있습니다.`);
    } else if (parsed.invalid.length > 0) {
      setEmailInputError(`올바르지 않은 이메일: ${parsed.invalid.join(", ")}`);
    } else {
      setEmailInputError("");
    }
    setEmailInput(parsed.invalid.join(", "));
    return parsed;
  }

  function handleEmailKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      commitEmailInput();
    }
  }

  function requestPasswordToggle(enabled: boolean) {
    if (!enabled && storedPasswordWasActive && !passwordRemovalConfirmed) {
      setPasswordRemovalPrompt(true);
      return;
    }

    updateDraft({ passwordEnabled: enabled });
    if (enabled && (!storedPasswordWasActive || passwordRemovalConfirmed)) {
      setPasswordResetting(true);
    }
    if (!enabled) {
      setPassword("");
      setPasswordConfirmation("");
      setPasswordResetting(false);
    }
  }

  function confirmPasswordRemoval() {
    setPasswordRemovalConfirmed(true);
    setPasswordRemovalPrompt(false);
    setPasswordResetting(false);
    setPassword("");
    setPasswordConfirmation("");
    updateDraft({ passwordEnabled: false });
  }

  function startPasswordReset() {
    setPasswordResetting(true);
    setPasswordRemovalConfirmed(false);
    setPassword("");
    setPasswordConfirmation("");
    updateDraft({ passwordEnabled: true });
  }

  function cancelPasswordReset() {
    setPasswordResetting(false);
    setPassword("");
    setPasswordConfirmation("");
    updateDraft({ passwordEnabled: true });
  }

  function generatePassword() {
    const generated = generatedSecureSharePassword();
    setPassword(generated);
    setPasswordConfirmation(generated);
    setPasswordVisible(true);
    setPasswordCopyNotice("새 비밀번호를 만들었습니다. 안전한 곳에 별도로 보관해주세요.");
  }

  async function copyPassword() {
    if (!password || !navigator.clipboard?.writeText) {
      setPasswordCopyNotice("이 브라우저에서는 자동 복사를 사용할 수 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(password);
      setPasswordCopyNotice("비밀번호를 복사했습니다.");
    } catch {
      setPasswordCopyNotice("비밀번호를 복사하지 못했습니다. 직접 선택해 복사해주세요.");
    }
  }

  function selectExpiration(expirationPreset: SecureShareExpirationPreset) {
    updateDraft({
      expirationPreset,
      customExpiresAt: expirationPreset === "custom"
        ? draft.customExpiresAt
          ?? new Date(validationNow.getTime() + 24 * 60 * 60 * 1_000).toISOString()
        : null
    });
  }

  function selectPermission(permissionLevel: SecureSharePermissionLevel) {
    updateDraft({
      permissionLevel,
      showCommenterIpPrefix: permissionLevel === "comment"
        ? mode === "create"
          ? true
          : draft.showCommenterIpPrefix
        : false
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }

    const pendingEmails = draft.accessMode === "allowed_emails" && emailInput.trim()
      ? commitEmailInput()
      : null;
    const allowedEmails = pendingEmails?.emails ?? draft.allowedEmails;

    if (pendingEmails && (pendingEmails.invalid.length > 0 || pendingEmails.overflow.length > 0)) {
      setLocalError("허용 이메일 입력을 확인해주세요.");
      return;
    }

    const needsNewPassword = draft.passwordEnabled
      && (!storedPasswordWasActive || passwordResetting || passwordRemovalConfirmed);

    if (needsNewPassword) {
      const passwordError = validateSecureSharePassword(password);

      if (passwordError) {
        setLocalError(passwordError);
        return;
      }
      if (password !== passwordConfirmation) {
        setLocalError("비밀번호 확인이 일치하지 않습니다.");
        return;
      }
    }

    const rawPolicy = {
      ...draft,
      allowedEmails,
      ...(needsNewPassword ? { password } : {})
    };
    const validation = validateSecureSharePolicyInput(rawPolicy, {
      emailFeatureEnabled,
      now: validationNow,
      requirePasswordWhenEnabled: needsNewPassword
    });

    if (!validation.ok) {
      setLocalError(validation.issues[0]?.message ?? "공유 설정을 확인해주세요.");
      return;
    }

    setLocalError("");
    setInternalSaving(true);
    try {
      await onSave(validation.value);
    } catch (caught) {
      if (mountedRef.current) {
        setLocalError(errorMessage(caught));
      }
    } finally {
      if (mountedRef.current) {
        setInternalSaving(false);
      }
    }
  }

  const dialog = (
    <div
      className="secure-share-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        aria-busy={busy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="secure-share-settings-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <header className="secure-share-settings-header">
          <div>
            <span className="section-kicker">
              <ShieldCheck aria-hidden="true" size={17} />
              Secure Share v2
            </span>
            <h2 id={titleId}>{mode === "edit" ? "보안 공유 설정 변경" : "보안 공유 만들기"}</h2>
            <p id={descriptionId}>
              콘텐츠 키는 이 화면과 공유 링크의 fragment에만 유지되며 서버로 전송되지 않습니다.
            </p>
          </div>
          <button
            aria-label="보안 공유 설정 창 닫기"
            className="icon-button secure-share-settings-close"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <form className="secure-share-settings-form" noValidate onSubmit={handleSubmit}>
          <div className="secure-share-settings-scroll">
            {displayedError && (
              <div
                ref={errorRef}
                className="secure-share-settings-error"
                role="alert"
                tabIndex={-1}
              >
                {displayedError}
              </div>
            )}

            <fieldset className="secure-share-settings-section">
              <legend>1. 공유 대상</legend>
              <div className="secure-share-radio-grid">
                {accessModeOptions.map((option, index) => {
                  const description = `${titleId}-access-${option.value}`;
                  const disabled = option.value === "allowed_emails" && !emailFeatureEnabled;

                  return (
                    <label
                      className={`secure-share-radio-card${draft.accessMode === option.value ? " selected" : ""}${disabled ? " disabled" : ""}`}
                      key={option.value}
                    >
                      <input
                        ref={index === 0 ? firstControlRef : undefined}
                        aria-describedby={description}
                        checked={draft.accessMode === option.value}
                        disabled={busy || disabled}
                        name={`${titleId}-access-mode`}
                        onChange={() => selectAccessMode(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small id={description}>
                          {disabled ? "운영 이메일 인증 설정이 준비되어야 사용할 수 있습니다." : option.description}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>

              {draft.accessMode === "allowed_emails" && (
                <div className="secure-share-email-editor">
                  <label htmlFor={emailInputId}>허용 이메일</label>
                  <div
                    aria-describedby={`${emailHelpId}${emailInputError ? ` ${emailErrorId}` : ""}`}
                    className="secure-share-email-chips"
                  >
                    {draft.allowedEmails.map((email) => (
                      <span className="secure-share-email-chip" key={email}>
                        {email}
                        <button
                          aria-label={`${email} 삭제`}
                          disabled={busy}
                          onClick={() => updateDraft({
                            allowedEmails: draft.allowedEmails.filter((candidate) => candidate !== email)
                          })}
                          type="button"
                        >
                          <X aria-hidden="true" size={13} />
                        </button>
                      </span>
                    ))}
                    <input
                      id={emailInputId}
                      aria-invalid={Boolean(emailInputError)}
                      disabled={busy}
                      onBlur={() => {
                        if (emailInput.trim()) {
                          commitEmailInput();
                        }
                      }}
                      onChange={(event) => {
                        setEmailInput(event.target.value);
                        setEmailInputError("");
                      }}
                      onKeyDown={handleEmailKeyDown}
                      onPaste={(event) => {
                        const pasted = event.clipboardData.getData("text");

                        if (/[\r\n,;]/u.test(pasted)) {
                          event.preventDefault();
                          commitEmailInput(`${emailInput}${pasted}`);
                        }
                      }}
                      placeholder="name@example.com"
                      type="email"
                      value={emailInput}
                    />
                  </div>
                  <div className="secure-share-email-meta">
                    <small id={emailHelpId}>
                      Enter, 쉼표, 세미콜론 또는 줄바꿈으로 추가합니다. 목록은 접근자에게 공개되지 않습니다.
                    </small>
                    <span>{draft.allowedEmails.length}/{secureShareAllowedEmailLimit}</span>
                  </div>
                  {emailInputError && (
                    <p className="secure-share-inline-error" id={emailErrorId} role="alert">
                      {emailInputError}
                    </p>
                  )}
                  {draft.allowedEmails.length > 0 && (
                    <button
                      className="secondary-button secure-share-clear-emails"
                      disabled={busy}
                      onClick={() => {
                        updateDraft({ allowedEmails: [] });
                        setEmailInput("");
                        setEmailInputError("");
                      }}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      전체 삭제
                    </button>
                  )}
                </div>
              )}
            </fieldset>

            <fieldset className="secure-share-settings-section">
              <legend>2. 보안</legend>
              <label className="secure-share-toggle-row">
                <span>
                  <strong>비밀번호 필요</strong>
                  <small>비밀번호는 콘텐츠 암호화 키가 아닌 서버 접근 조건입니다.</small>
                </span>
                <input
                  checked={draft.passwordEnabled}
                  disabled={busy}
                  onChange={(event) => requestPasswordToggle(event.target.checked)}
                  type="checkbox"
                />
              </label>

              {passwordRemovalPrompt && (
                <div className="secure-share-confirm-box" role="alert">
                  <strong>설정된 비밀번호를 제거할까요?</strong>
                  <p>저장하면 정책 버전이 바뀌고 기존 접근 세션이 무효화됩니다.</p>
                  <div>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => setPasswordRemovalPrompt(false)}
                      type="button"
                    >
                      취소
                    </button>
                    <button
                      className="secondary-button danger"
                      disabled={busy}
                      onClick={confirmPasswordRemoval}
                      type="button"
                    >
                      비밀번호 제거 확인
                    </button>
                  </div>
                </div>
              )}

              {draft.passwordEnabled && storedPasswordWasActive && !passwordResetting && !passwordRemovalConfirmed && (
                <div className="secure-share-stored-password">
                  <strong>비밀번호가 설정되어 있습니다.</strong>
                  <p>저장된 원문은 표시할 수 없으며 새 비밀번호로 재설정할 수 있습니다.</p>
                  <div>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={startPasswordReset}
                      type="button"
                    >
                      비밀번호 재설정
                    </button>
                    <button
                      className="secondary-button danger"
                      disabled={busy}
                      onClick={() => setPasswordRemovalPrompt(true)}
                      type="button"
                    >
                      비밀번호 제거
                    </button>
                  </div>
                </div>
              )}

              {draft.passwordEnabled && (!storedPasswordWasActive || passwordResetting || passwordRemovalConfirmed) && (
                <div className="secure-share-password-editor">
                  <div className="secure-share-password-field">
                    <label htmlFor={passwordInputId}>
                      {storedPasswordWasActive ? "새 비밀번호" : "비밀번호"}
                    </label>
                    <div>
                      <input
                        id={passwordInputId}
                        aria-describedby={passwordHelpId}
                        autoComplete="new-password"
                        disabled={busy}
                        maxLength={secureSharePasswordMaxLength * 2}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setPasswordCopyNotice("");
                        }}
                        type={passwordVisible ? "text" : "password"}
                        value={password}
                      />
                      <button
                        aria-label={passwordVisible ? "비밀번호 숨기기" : "비밀번호 보기"}
                        className="icon-button"
                        disabled={busy}
                        onClick={() => setPasswordVisible((visible) => !visible)}
                        type="button"
                      >
                        {passwordVisible
                          ? <EyeOff aria-hidden="true" size={17} />
                          : <Eye aria-hidden="true" size={17} />}
                      </button>
                    </div>
                  </div>
                  <label htmlFor={passwordConfirmId}>비밀번호 확인</label>
                  <input
                    id={passwordConfirmId}
                    autoComplete="new-password"
                    disabled={busy}
                    maxLength={secureSharePasswordMaxLength * 2}
                    onChange={(event) => setPasswordConfirmation(event.target.value)}
                    type={passwordVisible ? "text" : "password"}
                    value={passwordConfirmation}
                  />
                  <div className="secure-share-password-strength">
                    <meter
                      aria-label={`비밀번호 강도 ${strength.label}`}
                      max={4}
                      min={0}
                      value={strength.score}
                    />
                    <span>{strength.label}</span>
                  </div>
                  <small id={passwordHelpId}>
                    8~128자, Unicode 사용 가능. 공백을 포함해 입력한 문자열 그대로 비교합니다.
                  </small>
                  <div className="secure-share-password-actions">
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={generatePassword}
                      type="button"
                    >
                      <WandSparkles aria-hidden="true" size={15} />
                      안전한 비밀번호 생성
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy || !password}
                      onClick={() => void copyPassword()}
                      type="button"
                    >
                      <Copy aria-hidden="true" size={15} />
                      비밀번호 복사
                    </button>
                    {storedPasswordWasActive && passwordResetting && (
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={cancelPasswordReset}
                        type="button"
                      >
                        재설정 취소
                      </button>
                    )}
                  </div>
                  {passwordCopyNotice && (
                    <p className="secure-share-status" role="status">{passwordCopyNotice}</p>
                  )}
                  <p className="secure-share-warning">
                    저장 후 비밀번호 원문은 다시 볼 수 없으며, 찾기 대신 재설정만 가능합니다.
                  </p>
                </div>
              )}

              <label className="secure-share-toggle-row">
                <span>
                  <strong>
                    {draft.accessMode === "authenticated_users"
                      ? "이메일이 인증된 QuickMemo 계정만 허용"
                      : "이메일 인증 필요"}
                  </strong>
                  <small>
                    {draft.accessMode === "allowed_emails"
                      ? "지정 이메일의 소유 여부를 확인하기 위해 항상 필요합니다."
                      : draft.accessMode === "authenticated_users"
                        ? "서버가 Firebase email_verified 상태를 확인합니다."
                        : "접근자가 이메일로 받은 코드를 입력해야 합니다."}
                  </small>
                </span>
                <input
                  checked={draft.emailVerificationRequired}
                  disabled={
                    busy
                    || !emailFeatureEnabled
                    || draft.accessMode === "allowed_emails"
                  }
                  onChange={(event) => updateDraft({
                    emailVerificationRequired: event.target.checked
                  })}
                  type="checkbox"
                />
              </label>
              {!emailFeatureEnabled && (
                <p className="secure-share-warning">
                  운영 이메일 인증 설정이 준비되지 않아 이메일 인증 옵션을 사용할 수 없습니다.
                </p>
              )}

              <label className="secure-share-toggle-row">
                <span>
                  <strong>한 번 열람하면 링크 만료</strong>
                  <small>최초로 인증에 성공한 한 명에게만 접근 세션이 발급됩니다.</small>
                </span>
                <input
                  checked={draft.oneTimeEnabled}
                  disabled={busy}
                  onChange={(event) => updateDraft({
                    oneTimeEnabled: event.target.checked,
                    oneTimeScope: "global"
                  })}
                  type="checkbox"
                />
              </label>
              {draft.oneTimeEnabled && draft.allowedEmails.length > 1 && (
                <p className="secure-share-warning" role="status">
                  여러 이메일을 지정했지만 가장 먼저 인증에 성공한 사용자가 링크를 소비합니다.
                </p>
              )}
              {draft.oneTimeEnabled && draft.permissionLevel === "comment" && (
                <p className="secure-share-warning">
                  댓글은 최초 접근 세션이 유효한 동안만 작성할 수 있습니다.
                </p>
              )}
              {draft.oneTimeEnabled && (
                <p className="secure-share-helper">소유자 미리보기는 링크를 소비하지 않습니다.</p>
              )}

              <label className="secure-share-toggle-row">
                <span>
                  <strong>첨부파일 다운로드 금지</strong>
                  <small>
                    직접 다운로드 버튼과 요청을 제한합니다. 화면 캡처나 수동 복제까지 완전히 막지는 않습니다.
                  </small>
                </span>
                <input
                  checked={!draft.downloadAllowed}
                  disabled={busy}
                  onChange={(event) => updateDraft({ downloadAllowed: !event.target.checked })}
                  type="checkbox"
                />
              </label>

              <label className="secure-share-toggle-row">
                <span>
                  <strong>본문 빠른 복사 버튼 숨기기</strong>
                  <small>빠른 복사 UI만 숨기며 텍스트 선택 자체를 완전히 막지는 않습니다.</small>
                </span>
                <input
                  checked={!draft.quickCopyButtonVisible}
                  disabled={busy}
                  onChange={(event) => updateDraft({
                    quickCopyButtonVisible: !event.target.checked
                  })}
                  type="checkbox"
                />
              </label>
            </fieldset>

            <fieldset className="secure-share-settings-section">
              <legend>3. 만료</legend>
              <div className="secure-share-expiration-grid">
                {expirationOptions.map((option) => {
                  const description = `${titleId}-expiry-${option.value}`;

                  return (
                    <label
                      className={`secure-share-radio-card compact${draft.expirationPreset === option.value ? " selected" : ""}`}
                      key={option.value}
                    >
                      <input
                        aria-describedby={description}
                        checked={draft.expirationPreset === option.value}
                        disabled={busy}
                        name={`${titleId}-expiration`}
                        onChange={() => selectExpiration(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small id={description}>{option.description}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {draft.expirationPreset === "custom" && (
                <div className="secure-share-custom-expiry">
                  <label htmlFor={customExpiryId}>만료 날짜와 시간</label>
                  <input
                    id={customExpiryId}
                    aria-describedby={customExpiryHelpId}
                    disabled={busy}
                    max={toDateTimeLocalValue(maximumCustomExpiry)}
                    min={toDateTimeLocalValue(minimumCustomExpiry)}
                    onChange={(event) => updateDraft({
                      customExpiresAt: localDateTimeToIso(event.target.value)
                    })}
                    type="datetime-local"
                    value={toDateTimeLocalValue(draft.customExpiresAt)}
                  />
                  <small id={customExpiryHelpId}>
                    현재 시간보다 최소 5분 이후, 최대 365일까지 설정할 수 있습니다.
                  </small>
                  <p className="secure-share-expiry-preview">{customExpiryPreview}</p>
                </div>
              )}
            </fieldset>

            <fieldset className="secure-share-settings-section">
              <legend>4. 권한</legend>
              <div className="secure-share-radio-grid">
                {permissionOptions.map((option) => {
                  const description = `${titleId}-permission-${option.value}`;

                  return (
                    <label
                      className={`secure-share-radio-card${draft.permissionLevel === option.value ? " selected" : ""}`}
                      key={option.value}
                    >
                      <input
                        aria-describedby={description}
                        checked={draft.permissionLevel === option.value}
                        disabled={busy}
                        name={`${titleId}-permission`}
                        onChange={() => selectPermission(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small id={description}>{option.description}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {draft.permissionLevel === "comment" && (
                <label className="secure-share-toggle-row">
                  <span>
                    <strong>댓글 작성자의 IP 일부 표시</strong>
                    <small>
                      댓글 작성 시 전체 IP가 아닌 앞부분만 작성자 이름 옆에 표시됩니다.
                    </small>
                    <small id={commenterIpPrefixHelpId}>
                      예: guest1 (203.226). 전체 IP 주소는 표시하거나 저장하지 않습니다.
                    </small>
                  </span>
                  <input
                    aria-describedby={commenterIpPrefixHelpId}
                    checked={draft.showCommenterIpPrefix}
                    disabled={busy}
                    onChange={(event) => updateDraft({
                      showCommenterIpPrefix: event.target.checked
                    })}
                    type="checkbox"
                  />
                </label>
              )}
              {draft.permissionLevel === "save_copy" && !draft.downloadAllowed && (
                <p className="secure-share-info" role="status">
                  직접 다운로드는 제한되지만 QuickMemo 내부 복사본 저장은 허용됩니다.
                </p>
              )}
            </fieldset>

            <section
              aria-labelledby={`${titleId}-summary`}
              className="secure-share-settings-summary"
            >
              <h3 id={`${titleId}-summary`}>5. 현재 설정 요약</h3>
              <p>{summary}</p>
              <small>저장 후에는 서버가 검증한 정책 응답을 기준으로 화면이 갱신됩니다.</small>
            </section>
          </div>

          <footer className="secure-share-settings-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              취소
            </button>
            <button disabled={busy} type="submit">
              {busy ? "저장 중…" : mode === "edit" ? "설정 저장" : "보안 공유 만들기"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}
