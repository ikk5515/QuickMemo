import { getToken as getAppCheckToken } from "firebase/app-check";
import { appCheck, auth } from "../lib/firebase";

const adminEmailSettingsApiPath = "/api/admin-email-settings";
const maximumResponseCharacters = 32_768;
const maximumRetryAfterSeconds = 86_400;
const requestTimeoutMs = 20_000;
const gmailAddressPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/iu;
const replyToAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const appPasswordPattern = /^[A-Za-z0-9]{16}$/u;
const verificationCodePattern = /^\d{6}$/u;
const safeGenerationPattern = /^[A-Za-z0-9_-]{16,64}$/u;

export type AdminEmailSettingsGeneration = string;
export type AdminEmailSettingsRemoveTarget = "active" | "pending" | "all";

export interface AdminEmailSettingsSlot {
  present: boolean;
  generation: AdminEmailSettingsGeneration | null;
  usernameMasked: string | null;
  replyToMasked: string | null;
  verifiedAt: string | null;
  stagedAt: string | null;
  testSentAt: string | null;
  testExpiresAt: string | null;
  attemptsRemaining: number | null;
}

export interface AdminEmailSettingsStatus {
  enabled: boolean;
  active: AdminEmailSettingsSlot;
  pending: AdminEmailSettingsSlot;
}

interface AdminEmailSettingsApiResponse {
  ok: true;
  settings: AdminEmailSettingsStatus;
}

interface RequestOptions {
  signal?: AbortSignal;
}

interface StageAdminEmailSettingsInput {
  username: string;
  appPassword: string;
  replyTo?: string;
}

interface GenerationRequestInput {
  generation: AdminEmailSettingsGeneration;
}

interface ConfirmAdminEmailSettingsInput extends GenerationRequestInput {
  code: string;
}

interface RemoveAdminEmailSettingsInput {
  target: AdminEmailSettingsRemoveTarget;
  generation?: AdminEmailSettingsGeneration;
}

type AdminEmailSettingsRequestBody =
  | { action: "status" }
  | ({ action: "stage"; username: string; appPassword: string; replyTo?: string } & IdempotentRequest)
  | ({ action: "send-test"; generation: AdminEmailSettingsGeneration } & IdempotentRequest)
  | ({ action: "confirm-test"; generation: AdminEmailSettingsGeneration; code: string } & IdempotentRequest)
  | ({ action: "disable" } & IdempotentRequest)
  | ({ action: "discard-pending"; generation: AdminEmailSettingsGeneration } & IdempotentRequest)
  | ({ action: "remove"; target: AdminEmailSettingsRemoveTarget; generation?: AdminEmailSettingsGeneration } & IdempotentRequest);

interface IdempotentRequest {
  idempotencyKey: string;
}

export class AdminEmailSettingsError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    status: number | null = null,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AdminEmailSettingsError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControl(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function normalizeGmailAddress(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized.length > 254 || !gmailAddressPattern.test(normalized) || containsControl(normalized)) {
    throw new AdminEmailSettingsError("invalid_request", "유효한 Gmail 주소를 입력해주세요.");
  }

  return normalized;
}

function normalizeReplyTo(value: string | undefined) {
  const normalized = value?.trim() ?? "";

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 254 || !replyToAddressPattern.test(normalized) || containsControl(normalized)) {
    throw new AdminEmailSettingsError("invalid_request", "유효한 Reply-To 이메일 주소를 입력해주세요.");
  }

  return normalized;
}

function normalizeAppPassword(value: string) {
  const normalized = value.replace(/ /gu, "");

  if (!appPasswordPattern.test(normalized)) {
    throw new AdminEmailSettingsError("invalid_request", "Gmail 앱 비밀번호 16자리를 입력해주세요.");
  }

  return normalized;
}

function assertGeneration(value: AdminEmailSettingsGeneration) {
  if (typeof value === "string" && safeGenerationPattern.test(value)) {
    return value;
  }

  throw new AdminEmailSettingsError("invalid_request", "설정 버전 정보가 올바르지 않습니다.");
}

function idempotencyKey() {
  return crypto.randomUUID();
}

function safeString(value: unknown, maximumLength = 254) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !containsControl(value)
    ? value
    : null;
}

function safeMaskedEmail(value: unknown) {
  const text = safeString(value, 320);
  return text && text.includes("*") && text.includes("@") ? text : null;
}

function safeDateString(value: unknown) {
  const text = safeString(value, 64);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function parseGeneration(value: unknown) {
  if (typeof value === "string" && safeGenerationPattern.test(value)) {
    return value;
  }
  return null;
}

function parseSlot(value: unknown): AdminEmailSettingsSlot {
  if (!isRecord(value) || typeof value.present !== "boolean") {
    throw new AdminEmailSettingsError("invalid_response", "이메일 설정 응답을 확인하지 못했습니다.");
  }

  const attemptsRemaining =
    typeof value.attemptsRemaining === "number"
    && Number.isSafeInteger(value.attemptsRemaining)
    && value.attemptsRemaining >= 0
    && value.attemptsRemaining <= 20
      ? value.attemptsRemaining
      : null;

  return {
    present: value.present,
    generation: parseGeneration(value.generation),
    usernameMasked: safeMaskedEmail(value.usernameMasked),
    replyToMasked: safeMaskedEmail(value.replyToMasked),
    verifiedAt: safeDateString(value.verifiedAt),
    stagedAt: safeDateString(value.stagedAt),
    testSentAt: safeDateString(value.testSentAt),
    testExpiresAt: safeDateString(value.testExpiresAt),
    attemptsRemaining
  };
}

function parseSuccessPayload(value: unknown): AdminEmailSettingsApiResponse {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.settings)) {
    throw new AdminEmailSettingsError("invalid_response", "이메일 설정 응답을 확인하지 못했습니다.");
  }

  if (typeof value.settings.enabled !== "boolean") {
    throw new AdminEmailSettingsError("invalid_response", "이메일 설정 상태를 확인하지 못했습니다.");
  }

  const settings = {
    enabled: value.settings.enabled,
    active: parseSlot(value.settings.active),
    pending: parseSlot(value.settings.pending)
  };

  if (
    (settings.active.present && (!settings.active.usernameMasked || settings.active.generation === null))
    || (settings.pending.present && (!settings.pending.usernameMasked || settings.pending.generation === null))
  ) {
    throw new AdminEmailSettingsError("invalid_response", "마스킹된 이메일 설정 상태를 확인하지 못했습니다.");
  }

  return {
    ok: true,
    settings
  };
}

const errorMessages: Readonly<Record<string, string>> = {
  authentication_required: "로그인 상태를 다시 확인해주세요.",
  admin_required: "관리자만 이메일 설정을 변경할 수 있습니다.",
  recent_auth_required: "보안을 위해 다시 로그인 후 시도해주세요.",
  recent_authentication_required: "보안을 위해 다시 로그인 후 시도해주세요.",
  invalid_request: "입력한 이메일 설정을 확인해주세요.",
  request_rejected: "보안 검증으로 요청이 거부되었습니다. 페이지를 새로고침한 후 다시 시도해주세요.",
  rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
  conflict: "다른 관리자가 설정을 변경했습니다. 상태를 새로고침한 후 다시 시도해주세요.",
  email_settings_unavailable: "이메일 설정 서비스를 사용할 수 없습니다.",
  smtp_verification_failed: "Gmail SMTP 연결을 확인하지 못했습니다. 상태를 새로고침한 뒤 Gmail 보안 설정을 확인해주세요.",
  test_required: "먼저 테스트 메일을 발송해주세요.",
  test_expired: "테스트 인증 코드가 만료되었습니다. 상태를 새로고침한 뒤 다시 발송해주세요.",
  invalid_test_code: "인증 코드가 올바르지 않습니다. 상태를 새로고침해 남은 횟수를 확인해주세요.",
  attempts_exhausted: "인증 코드 입력 횟수를 초과했습니다. 새 설정을 다시 등록해주세요."
};

function parseRetryAfterSeconds(value: string | null) {
  const normalized = value?.trim() ?? "";

  if (!/^\d{1,5}$/u.test(normalized)) {
    return undefined;
  }

  const seconds = Number(normalized);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= maximumRetryAfterSeconds
    ? seconds
    : undefined;
}

function rateLimitedMessage(retryAfterSeconds: number | undefined) {
  if (retryAfterSeconds === undefined) {
    return errorMessages.rate_limited;
  }

  if (retryAfterSeconds < 60 * 60) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return `요청이 너무 많습니다. 약 ${minutes}분 후 다시 시도해주세요.`;
  }

  const hours = Math.ceil(retryAfterSeconds / (60 * 60));
  return `요청이 너무 많습니다. 약 ${hours}시간 후 다시 시도해주세요.`;
}

function errorForResponse(
  status: number,
  payload: unknown,
  retryAfterSeconds: number | undefined
) {
  const code =
    isRecord(payload)
    && typeof payload.error === "string"
    && /^[a-z0-9_]{1,80}$/u.test(payload.error)
      ? payload.error
      : `email_settings_${status}`;
  const fallback =
    status === 401
      ? "로그인 상태를 다시 확인해주세요."
      : status === 403
        ? "이 설정을 변경할 권한이 없습니다."
        : status === 429
          ? "요청이 너무 많습니다. 잠시 후 다시 시도해주세요."
          : status >= 500
            ? "이메일 설정 서버가 잠시 응답하지 않습니다."
            : "이메일 설정 요청을 처리하지 못했습니다.";
  const rateLimitRetryAfterSeconds = code === "rate_limited" ? retryAfterSeconds : undefined;
  const message = code === "rate_limited"
    ? rateLimitedMessage(rateLimitRetryAfterSeconds)
    : errorMessages[code] ?? fallback;

  return new AdminEmailSettingsError(code, message, status, rateLimitRetryAfterSeconds);
}

async function appCheckToken() {
  if (!appCheck) {
    // The server is authoritative for App Check enforcement. When the
    // deployment enables enforcement it rejects a missing token; deployments
    // that intentionally run with enforcement off remain operable.
    return null;
  }

  try {
    const result = await getAppCheckToken(appCheck, false);
    const token = typeof result.token === "string" && result.token.length >= 20 && result.token.length <= 16_384
      && !containsControl(result.token)
      ? result.token
      : null;
    if (!token) {
      throw new AdminEmailSettingsError(
        "app_check_unavailable",
        "보안 검증을 완료하지 못했습니다. 페이지를 새로고침한 후 다시 시도해주세요."
      );
    }
    return token;
  } catch {
    throw new AdminEmailSettingsError(
      "app_check_unavailable",
      "보안 검증을 완료하지 못했습니다. 페이지를 새로고침한 후 다시 시도해주세요."
    );
  }
}

async function requestAdminEmailSettings(
  body: AdminEmailSettingsRequestBody,
  options: RequestOptions = {}
) {
  const user = auth.currentUser;

  if (!user) {
    throw new AdminEmailSettingsError("authentication_required", errorMessages.authentication_required);
  }

  const [idToken, verificationToken] = await Promise.all([
    user.getIdToken(),
    appCheckToken()
  ]);

  if (!idToken || idToken.length > 16_384 || containsControl(idToken)) {
    throw new AdminEmailSettingsError("authentication_required", errorMessages.authentication_required);
  }

  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${idToken}`,
    "content-type": "application/json",
    "x-quickmemo-admin-email-settings": "1"
  });

  if (verificationToken) {
    headers.set("x-firebase-appcheck", verificationToken);
  }

  const timeoutController = new AbortController();
  const timeout = window.setTimeout(() => timeoutController.abort(), requestTimeoutMs);
  const abort = () => timeoutController.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(adminEmailSettingsApiPath, {
      method: "POST",
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: timeoutController.signal
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    const responseText = await response.text();

    if (!contentType.includes("application/json") || responseText.length > maximumResponseCharacters) {
      throw new AdminEmailSettingsError("invalid_response", "이메일 설정 응답을 확인하지 못했습니다.", response.status);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      throw new AdminEmailSettingsError("invalid_response", "이메일 설정 응답을 확인하지 못했습니다.", response.status);
    }

    if (!response.ok) {
      throw errorForResponse(response.status, payload, retryAfterSeconds);
    }

    return parseSuccessPayload(payload).settings;
  } catch (caught) {
    if (caught instanceof AdminEmailSettingsError) {
      throw caught;
    }
    if (options.signal?.aborted) {
      throw new AdminEmailSettingsError("request_cancelled", "요청을 취소했습니다.");
    }
    if (timeoutController.signal.aborted) {
      throw new AdminEmailSettingsError(
        "request_timeout",
        "요청 결과를 확인하지 못했습니다. 상태를 새로고침한 후 다시 시도해주세요."
      );
    }
    throw new AdminEmailSettingsError(
      "network_error",
      "네트워크 연결과 최신 설정 상태를 확인한 후 다시 시도해주세요."
    );
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function getAdminEmailSettingsStatus(options?: RequestOptions) {
  return requestAdminEmailSettings({ action: "status" }, options);
}

export function stageAdminEmailSettings(input: StageAdminEmailSettingsInput, options?: RequestOptions) {
  const username = normalizeGmailAddress(input.username);
  const appPassword = normalizeAppPassword(input.appPassword);
  const replyTo = normalizeReplyTo(input.replyTo);

  return requestAdminEmailSettings({
    action: "stage",
    username,
    appPassword,
    ...(replyTo ? { replyTo } : {}),
    idempotencyKey: idempotencyKey()
  }, options);
}

export function sendAdminEmailSettingsTest(input: GenerationRequestInput, options?: RequestOptions) {
  return requestAdminEmailSettings({
    action: "send-test",
    generation: assertGeneration(input.generation),
    idempotencyKey: idempotencyKey()
  }, options);
}

export function confirmAdminEmailSettingsTest(input: ConfirmAdminEmailSettingsInput, options?: RequestOptions) {
  const code = input.code.trim();

  if (!verificationCodePattern.test(code)) {
    throw new AdminEmailSettingsError("invalid_request", "6자리 인증 코드를 입력해주세요.");
  }

  return requestAdminEmailSettings({
    action: "confirm-test",
    generation: assertGeneration(input.generation),
    code,
    idempotencyKey: idempotencyKey()
  }, options);
}

export function disableAdminEmailSettings(options?: RequestOptions) {
  return requestAdminEmailSettings({
    action: "disable",
    idempotencyKey: idempotencyKey()
  }, options);
}

export function discardPendingAdminEmailSettings(input: GenerationRequestInput, options?: RequestOptions) {
  return requestAdminEmailSettings({
    action: "discard-pending",
    generation: assertGeneration(input.generation),
    idempotencyKey: idempotencyKey()
  }, options);
}

export function removeAdminEmailSettings(input: RemoveAdminEmailSettingsInput, options?: RequestOptions) {
  const generation = input.generation === undefined ? undefined : assertGeneration(input.generation);

  return requestAdminEmailSettings({
    action: "remove",
    target: input.target,
    ...(generation === undefined ? {} : { generation }),
    idempotencyKey: idempotencyKey()
  }, options);
}
