import { getToken as getAppCheckToken } from "firebase/app-check";
import type { EncryptedPayload, WrappedNoteKey } from "../types";
import { appCheck } from "../lib/firebase";
import {
  normalizeSecureShareEmail,
  validateSecureSharePolicyInput,
  type SecureSharePolicyInput,
  type SecureSharePolicyValidationOptions
} from "../lib/secureSharePolicy";

export const secureShareApiPath = "/api/public-shares-v2";

export const secureShareApiActions = [
  "feature-status",
  "owner-list",
  "owner-details",
  "owner-create",
  "owner-update",
  "owner-activate",
  "owner-revoke",
  "metadata",
  "email-challenge",
  "access",
  "session",
  "content",
  "comments",
  "comment-delete",
  "copy-grant",
  "attachment-preview",
  "attachment-download"
] as const;

export type SecureShareApiAction = (typeof secureShareApiActions)[number];
export type SecureShareApiMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface SecureShareApiActionContractEntry {
  auth: "optional" | "owner" | "session";
  csrf: "after_session" | "if_available" | "none";
  methods: readonly SecureShareApiMethod[];
}

/**
 * The frontend/backend contract for the flat Vercel router. Keeping this
 * exported makes route changes mechanical while retaining one audited fetch
 * implementation.
 */
export const secureShareApiActionContract: Record<
  SecureShareApiAction,
  SecureShareApiActionContractEntry
> = {
  "feature-status": { auth: "optional", csrf: "none", methods: ["GET"] },
  "owner-list": { auth: "owner", csrf: "none", methods: ["GET"] },
  "owner-details": { auth: "owner", csrf: "none", methods: ["GET"] },
  "owner-create": { auth: "owner", csrf: "if_available", methods: ["POST"] },
  "owner-update": { auth: "owner", csrf: "if_available", methods: ["PATCH"] },
  "owner-activate": { auth: "owner", csrf: "if_available", methods: ["POST"] },
  "owner-revoke": { auth: "owner", csrf: "if_available", methods: ["POST"] },
  metadata: { auth: "optional", csrf: "none", methods: ["GET"] },
  "email-challenge": { auth: "optional", csrf: "none", methods: ["POST"] },
  access: { auth: "optional", csrf: "none", methods: ["POST"] },
  session: { auth: "session", csrf: "none", methods: ["GET"] },
  content: { auth: "session", csrf: "none", methods: ["GET"] },
  comments: { auth: "session", csrf: "after_session", methods: ["GET", "POST"] },
  "comment-delete": { auth: "session", csrf: "after_session", methods: ["DELETE"] },
  "copy-grant": { auth: "session", csrf: "after_session", methods: ["POST"] },
  "attachment-preview": { auth: "session", csrf: "none", methods: ["GET"] },
  "attachment-download": { auth: "session", csrf: "none", methods: ["GET"] }
};

const secureShareIdentifierPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const csrfTokenPattern = /^[A-Za-z0-9_-]{32,512}$/u;
const copyGrantPattern = /^[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{40,64}$/u;
const forbiddenContentKeyFields = new Set([
  "contentkey",
  "fragment",
  "sharecontentkey",
  "sharefragment",
  "sharekey"
]);
const csrfTokensByShareId = new Map<string, string>();

interface SecureShareApiErrorPayload {
  error?: unknown;
  message?: unknown;
}

export interface SecureShareOwnerCreateInput {
  attachmentCount: number;
  encryptedBody: EncryptedPayload;
  encryptedTitle: EncryptedPayload;
  idempotencyKey: string;
  ownerWrappedShareKey: WrappedNoteKey;
  policy: unknown;
  sourceAttachmentRevision?: number;
  sourceNoteId: string;
  sourceRevision?: number;
}

export interface SecureShareOwnerUpdateInput {
  idempotencyKey: string;
  policy: unknown;
}

export interface SecureShareOwnerActivateInput {
  attachmentCount: number;
  generation: string;
  idempotencyKey: string;
}

export interface SecureShareListOptions {
  cursor?: string;
  limit?: number;
  sourceNoteId?: string;
  status?: "active" | "consumed" | "expired" | "revoked";
}

export interface SecureShareFeatureStatus {
  emailEnabled: boolean;
  v2Enabled: boolean;
}

export interface SecureShareAccessInput {
  challengeId?: string;
  oneTimeOpenConfirmed?: boolean;
  otp?: string;
  ownerPreview?: boolean;
  password?: string;
  unlockAttemptId: string;
}

export interface SecureShareCommentInput {
  body: string;
  clientRequestId: string;
}

export interface SecureShareViewerRequestOptions {
  idToken?: string;
  signal?: AbortSignal;
}

export interface SecureShareRequestOptions {
  action: SecureShareApiAction;
  body?: unknown;
  copyGrant?: string;
  idToken?: string;
  method: SecureShareApiMethod;
  query?: Record<string, boolean | number | string | null | undefined>;
  shareId?: string;
  signal?: AbortSignal;
}

export class SecureShareApiError extends Error {
  code: string;
  retryAfterSeconds: number | null;
  status: number;

  constructor(
    code: string,
    message: string,
    status = 0,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "SecureShareApiError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsAsciiWhitespaceOrControl(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 32 || codePoint === 127;
  });
}

function assertIdentifier(value: string, field: string) {
  if (!secureShareIdentifierPattern.test(value)) {
    throw new SecureShareApiError(
      "invalid_request",
      `${field} 값이 올바르지 않습니다.`
    );
  }
}

function assertIdToken(idToken: string | undefined) {
  if (
    typeof idToken !== "string"
    || idToken.length < 20
    || idToken.length > 16_384
    || containsAsciiWhitespaceOrControl(idToken)
  ) {
    throw new SecureShareApiError(
      "login_required",
      "QuickMemo 로그인 상태를 다시 확인해주세요.",
      401
    );
  }
}

function assertNoContentKey(value: unknown, seen = new WeakSet<object>(), field = "request") {
  if (typeof value === "string") {
    if (/(?:#|%23|[?&])key(?:=|%3d)/iu.test(value)) {
      throw new SecureShareApiError(
        "content_key_blocked",
        "공유 콘텐츠 키는 서버 요청에 포함할 수 없습니다."
      );
    }
    return;
  }

  if (
    value === null
    || value === undefined
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return;
  }

  if (typeof value !== "object") {
    throw new SecureShareApiError(
      "invalid_request",
      `${field} 값은 JSON으로 전송할 수 없습니다.`
    );
  }
  if (seen.has(value)) {
    throw new SecureShareApiError("invalid_request", "순환 요청 데이터는 전송할 수 없습니다.");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoContentKey(item, seen, `${field}.${index}`));
    return;
  }
  if (!isPlainRecord(value)) {
    throw new SecureShareApiError(
      "invalid_request",
      `${field} 값은 JSON 객체여야 합니다.`
    );
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z]/giu, "").toLowerCase();

    if (forbiddenContentKeyFields.has(normalizedKey)) {
      throw new SecureShareApiError(
        "content_key_blocked",
        "공유 콘텐츠 키는 서버 요청에 포함할 수 없습니다."
      );
    }
    assertNoContentKey(nestedValue, seen, `${field}.${key}`);
  }
}

function secureShareApiUrl(
  action: SecureShareApiAction,
  shareId?: string,
  query: SecureShareRequestOptions["query"] = {}
) {
  const params = new URLSearchParams({ action });

  if (shareId) {
    assertIdentifier(shareId, "shareId");
    params.set("shareId", shareId);
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (
      forbiddenContentKeyFields.has(key.replaceAll(/[^a-z]/giu, "").toLowerCase())
      || /[#?&]/u.test(String(value))
    ) {
      throw new SecureShareApiError("invalid_request", "안전하지 않은 요청 값이 차단되었습니다.");
    }
    params.set(key, String(value));
  }

  return `${secureShareApiPath}?${params.toString()}`;
}

function safeRetryAfter(response: Response) {
  const value = response.headers.get("retry-after");

  if (!value || !/^\d{1,6}$/u.test(value)) {
    return null;
  }

  return Number(value);
}

async function bestEffortAppCheckToken() {
  if (!appCheck) {
    return null;
  }

  try {
    const result = await getAppCheckToken(appCheck, false);
    const token = result.token;

    return typeof token === "string"
      && token.length >= 20
      && token.length <= 16_384
      && !containsAsciiWhitespaceOrControl(token)
      ? token
      : null;
  } catch {
    return null;
  }
}

function errorMessage(status: number, payload: SecureShareApiErrorPayload) {
  if (typeof payload.message === "string" && payload.message.length <= 300) {
    return payload.message;
  }
  if (status === 401) {
    return "로그인 또는 공유 세션을 다시 확인해주세요.";
  }
  if (status === 403) {
    return "이 공유 작업을 수행할 권한이 없습니다.";
  }
  if (status === 404 || status === 410) {
    return "이 공유 링크를 사용할 수 없습니다.";
  }
  if (status === 429) {
    return "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
  }
  return status >= 500
    ? "공유 서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해주세요."
    : "공유 요청을 처리하지 못했습니다.";
}

async function parseJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("application/json")) {
    if (response.ok && response.status === 204) {
      return null;
    }
    throw new SecureShareApiError(
      "invalid_response",
      "공유 서버의 응답 형식이 올바르지 않습니다.",
      response.status
    );
  }

  try {
    return await response.json() as unknown;
  } catch {
    throw new SecureShareApiError(
      "invalid_response",
      "공유 서버의 응답을 확인하지 못했습니다.",
      response.status
    );
  }
}

function rememberAndRedactCsrfToken(payload: unknown, requestedShareId?: string) {
  if (!isPlainRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, "csrfToken")) {
    return payload;
  }

  const csrfToken = payload.csrfToken;
  const responseShareId = typeof payload.shareId === "string" ? payload.shareId : requestedShareId;

  if (
    typeof csrfToken !== "string"
    || !csrfTokenPattern.test(csrfToken)
    || !responseShareId
    || !secureShareIdentifierPattern.test(responseShareId)
  ) {
    if (responseShareId) {
      csrfTokensByShareId.delete(responseShareId);
    }
    throw new SecureShareApiError(
      "invalid_response",
      "공유 세션 보호 정보를 확인하지 못했습니다."
    );
  }

  csrfTokensByShareId.set(responseShareId, csrfToken);
  const redactedPayload = { ...payload };
  delete redactedPayload.csrfToken;
  return redactedPayload;
}

async function fetchSecureShareResponse(options: SecureShareRequestOptions) {
  const contract = secureShareApiActionContract[options.action];

  if (!contract.methods.includes(options.method)) {
    throw new SecureShareApiError(
      "invalid_request",
      `${options.action} 작업에서 ${options.method} 요청을 사용할 수 없습니다.`
    );
  }
  if (contract.auth === "owner") {
    assertIdToken(options.idToken);
  } else if (options.idToken !== undefined) {
    assertIdToken(options.idToken);
  }
  if (options.copyGrant !== undefined) {
    if (
      options.action !== "attachment-download"
      || options.method !== "GET"
      || !copyGrantPattern.test(options.copyGrant)
    ) {
      throw new SecureShareApiError(
        "invalid_request",
        "첨부파일 복사 권한 정보가 올바르지 않습니다."
      );
    }
    assertIdToken(options.idToken);
  }

  assertNoContentKey(options.query);
  assertNoContentKey(options.body);

  const headers = new Headers({ accept: "application/json" });
  const csrfToken = options.shareId
    ? csrfTokensByShareId.get(options.shareId)
    : undefined;

  if (options.idToken) {
    headers.set("authorization", `Bearer ${options.idToken}`);
  }
  if (options.copyGrant) {
    headers.set("x-secure-share-copy-grant", options.copyGrant);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (csrfToken && contract.csrf !== "none") {
    headers.set("x-csrf-token", csrfToken);
  } else if (contract.csrf === "after_session" && options.method !== "GET") {
    throw new SecureShareApiError(
      "session_required",
      "공유 세션을 다시 확인해주세요.",
      401
    );
  }
  const appCheckToken = await bestEffortAppCheckToken();

  if (appCheckToken) {
    headers.set("x-firebase-appcheck", appCheckToken);
  }

  try {
    return await fetch(secureShareApiUrl(options.action, options.shareId, options.query), {
      method: options.method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      credentials: "include",
      headers,
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: options.signal
    });
  } catch (caught) {
    if (caught instanceof SecureShareApiError) {
      throw caught;
    }
    if (options.signal?.aborted) {
      throw new SecureShareApiError("request_cancelled", "공유 요청을 취소했습니다.");
    }
    throw new SecureShareApiError(
      "network_error",
      "네트워크 연결을 확인한 뒤 다시 시도해주세요."
    );
  }
}

export async function secureShareApiRequest<T = unknown>(
  options: SecureShareRequestOptions
): Promise<T> {
  const response = await fetchSecureShareResponse(options);
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    const errorPayload = isPlainRecord(payload) ? payload : {};
    const code = typeof errorPayload.error === "string" && errorPayload.error.length <= 80
      ? errorPayload.error
      : `secure_share_${response.status}`;

    throw new SecureShareApiError(
      code,
      errorMessage(response.status, errorPayload),
      response.status,
      safeRetryAfter(response)
    );
  }

  return rememberAndRedactCsrfToken(payload, options.shareId) as T;
}

export function clearSecureShareSessionMemory(shareId?: string) {
  if (shareId) {
    csrfTokensByShareId.delete(shareId);
    return;
  }
  csrfTokensByShareId.clear();
}

export async function getSecureShareFeatureStatus(
  signal?: AbortSignal
): Promise<SecureShareFeatureStatus> {
  const payload = await secureShareApiRequest<unknown>({
    action: "feature-status",
    method: "GET",
    signal
  });

  if (
    !isPlainRecord(payload)
    || Object.keys(payload).some((field) => field !== "v2Enabled" && field !== "emailEnabled")
    || typeof payload.v2Enabled !== "boolean"
    || typeof payload.emailEnabled !== "boolean"
  ) {
    throw new SecureShareApiError(
      "invalid_response",
      "보안 공유 기능 상태를 확인하지 못했습니다."
    );
  }

  return {
    v2Enabled: payload.v2Enabled,
    emailEnabled: payload.emailEnabled
  };
}

export function listOwnedSecureShares(idToken: string, options: SecureShareListOptions = {}) {
  const limit = options.limit === undefined
    ? 20
    : Math.min(100, Math.max(1, Math.trunc(options.limit)));

  if (options.sourceNoteId !== undefined) {
    assertIdentifier(options.sourceNoteId, "sourceNoteId");
  }

  return secureShareApiRequest({
    action: "owner-list",
    method: "GET",
    idToken,
    query: {
      cursor: options.cursor,
      limit,
      sourceNoteId: options.sourceNoteId,
      status: options.status
    }
  });
}

export function getSecureShareOwnerDetails(shareId: string, idToken: string) {
  return secureShareApiRequest({
    action: "owner-details",
    method: "GET",
    idToken,
    shareId
  });
}

function validatedPolicy(
  policy: unknown,
  options: SecureSharePolicyValidationOptions
): SecureSharePolicyInput {
  const result = validateSecureSharePolicyInput(policy, options);

  if (!result.ok) {
    throw new SecureShareApiError(
      "invalid_policy",
      result.issues[0]?.message ?? "공유 설정을 확인해주세요."
    );
  }
  return result.value;
}

export function createSecureShare(
  input: SecureShareOwnerCreateInput,
  idToken: string,
  validationOptions: SecureSharePolicyValidationOptions = {}
) {
  const policy = validatedPolicy(input.policy, {
    ...validationOptions,
    requirePasswordWhenEnabled: true
  });

  return secureShareApiRequest({
    action: "owner-create",
    method: "POST",
    idToken,
    body: {
      attachmentCount: input.attachmentCount,
      encryptedBody: input.encryptedBody,
      encryptedTitle: input.encryptedTitle,
      idempotencyKey: input.idempotencyKey,
      ownerWrappedShareKey: input.ownerWrappedShareKey,
      policy,
      sourceAttachmentRevision: input.sourceAttachmentRevision,
      sourceNoteId: input.sourceNoteId,
      sourceRevision: input.sourceRevision
    }
  });
}

export function updateSecureShare(
  shareId: string,
  input: SecureShareOwnerUpdateInput,
  idToken: string,
  validationOptions: SecureSharePolicyValidationOptions = {}
) {
  return secureShareApiRequest({
    action: "owner-update",
    method: "PATCH",
    idToken,
    shareId,
    body: {
      idempotencyKey: input.idempotencyKey,
      policy: validatedPolicy(input.policy, validationOptions)
    }
  });
}

export function activateSecureShare(
  shareId: string,
  input: SecureShareOwnerActivateInput,
  idToken: string
) {
  return secureShareApiRequest({
    action: "owner-activate",
    method: "POST",
    idToken,
    shareId,
    body: input
  });
}

export async function revokeSecureShare(
  shareId: string,
  idToken: string,
  idempotencyKey: string
) {
  const payload = await secureShareApiRequest({
    action: "owner-revoke",
    method: "POST",
    idToken,
    shareId,
    body: { idempotencyKey }
  });

  clearSecureShareSessionMemory(shareId);
  return payload;
}

export function getSecureShareMetadata(
  shareId: string,
  options: { idToken?: string; signal?: AbortSignal } = {}
) {
  return secureShareApiRequest({
    action: "metadata",
    method: "GET",
    idToken: options.idToken,
    shareId,
    signal: options.signal
  });
}

export function requestSecureShareEmailChallenge(
  shareId: string,
  email: string,
  signal?: AbortSignal
) {
  const normalizedEmail = normalizeSecureShareEmail(email);

  if (!normalizedEmail) {
    throw new SecureShareApiError("invalid_email", "올바른 이메일 주소를 입력해주세요.");
  }

  return secureShareApiRequest({
    action: "email-challenge",
    method: "POST",
    shareId,
    signal,
    body: { email: normalizedEmail }
  });
}

export function unlockSecureShare(
  shareId: string,
  input: SecureShareAccessInput,
  options: { idToken?: string; signal?: AbortSignal } = {}
) {
  assertIdentifier(input.unlockAttemptId, "unlockAttemptId");

  return secureShareApiRequest({
    action: "access",
    method: "POST",
    idToken: options.idToken,
    shareId,
    signal: options.signal,
    body: {
      challengeId: input.challengeId,
      oneTimeOpenConfirmed: input.oneTimeOpenConfirmed,
      otp: input.otp,
      ownerPreview: input.ownerPreview,
      password: input.password,
      unlockAttemptId: input.unlockAttemptId
    }
  });
}

export function refreshSecureShareSession(
  shareId: string,
  options: SecureShareViewerRequestOptions = {}
) {
  return secureShareApiRequest({
    action: "session",
    method: "GET",
    idToken: options.idToken,
    shareId,
    signal: options.signal
  });
}

export function getSecureShareContent(
  shareId: string,
  options: SecureShareViewerRequestOptions = {}
) {
  return secureShareApiRequest({
    action: "content",
    method: "GET",
    idToken: options.idToken,
    shareId,
    signal: options.signal
  });
}

export function listSecureShareComments(
  shareId: string,
  options: SecureShareViewerRequestOptions & { cursor?: string; limit?: number } = {}
) {
  return secureShareApiRequest({
    action: "comments",
    method: "GET",
    idToken: options.idToken,
    shareId,
    signal: options.signal,
    query: {
      cursor: options.cursor,
      limit: options.limit === undefined
        ? 20
        : Math.min(100, Math.max(1, Math.trunc(options.limit)))
    }
  });
}

export function createSecureShareComment(
  shareId: string,
  input: SecureShareCommentInput,
  options: SecureShareViewerRequestOptions = {}
) {
  return secureShareApiRequest({
    action: "comments",
    method: "POST",
    idToken: options.idToken,
    shareId,
    signal: options.signal,
    body: input
  });
}

export function deleteSecureShareComment(
  shareId: string,
  commentId: string,
  options: SecureShareViewerRequestOptions = {}
) {
  assertIdentifier(commentId, "commentId");
  return secureShareApiRequest({
    action: "comment-delete",
    method: "DELETE",
    idToken: options.idToken,
    shareId,
    signal: options.signal,
    body: { commentId }
  });
}

export function requestSecureShareCopyGrant(
  shareId: string,
  idToken: string,
  idempotencyKey: string,
  signal?: AbortSignal
) {
  return secureShareApiRequest({
    action: "copy-grant",
    method: "POST",
    idToken,
    shareId,
    signal,
    body: { idempotencyKey }
  });
}

export function getSecureShareAttachmentPreview(
  shareId: string,
  attachmentId: string,
  options: SecureShareViewerRequestOptions = {}
) {
  assertIdentifier(attachmentId, "attachmentId");
  return fetchSecureShareResponse({
    action: "attachment-preview",
    method: "GET",
    idToken: options.idToken,
    shareId,
    signal: options.signal,
    query: { attachmentId }
  });
}

export function getSecureShareAttachmentDownload(
  shareId: string,
  attachmentId: string,
  options: SecureShareViewerRequestOptions = {}
) {
  assertIdentifier(attachmentId, "attachmentId");
  return fetchSecureShareResponse({
    action: "attachment-download",
    method: "GET",
    idToken: options.idToken,
    shareId,
    signal: options.signal,
    query: { attachmentId }
  });
}

export function getSecureShareAttachmentForCopy(
  shareId: string,
  attachmentId: string,
  idToken: string,
  copyGrant: string,
  signal?: AbortSignal
) {
  assertIdentifier(attachmentId, "attachmentId");
  return fetchSecureShareResponse({
    action: "attachment-download",
    method: "GET",
    copyGrant,
    idToken,
    shareId,
    signal,
    query: { attachmentId }
  });
}
