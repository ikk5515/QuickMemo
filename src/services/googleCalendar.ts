import { auth } from "../lib/firebase";
import { addDays, isValidScheduleDateString } from "../lib/scheduleHelpers";

const googleCalendarApiBaseUrl = "https://www.googleapis.com/calendar/v3";
const googleCalendarAuthApiPath = "/api/google-calendar-auth";
const googleCalendarConnectionApiPath = "/api/google-calendar-connection";
const accessTokenRefreshSkewMs = 60_000;
const backendRequestTimeoutMs = 15_000;
const googleCalendarRequestTimeoutMs = 20_000;
// A second tab must outwait one full Google request plus the backend lease
// release. Durable task receipts provide the fallback if the first tab dies.
const googleCalendarOperationWaitMs = googleCalendarRequestTimeoutMs + backendRequestTimeoutMs + 10_000;
const defaultTimedEventDurationMinutes = 30;
const maxPatchConflictRetries = 2;

export type GoogleCalendarSyncState = "idle" | "synced" | "failed";

export interface GoogleCalendarConnectionStatus {
  configured: boolean;
  connected: boolean;
  hasStoredConnection: boolean;
  needsReconnect: boolean;
  connectionGeneration: string | null;
  connectionIdentity?: string | null;
  connectionAttemptId?: string | null;
  connectedAt?: string | null;
  email: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: GoogleCalendarSyncState;
  reportSequence?: number;
  serverTime?: string | null;
  syncedCount: number;
  timeZone: string | null;
}

export interface GoogleCalendarTaskInput {
  id: string;
  ownerUid: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  startTimeMinutes: number | null;
  endTimeMinutes: number | null;
  revision?: string | null;
}

export interface GoogleCalendarSyncResult {
  eventId: string | null;
  outcome: "created" | "updated" | "deleted" | "skipped";
  remoteWasPresent?: boolean;
}

export interface GoogleCalendarDeletionWorkflow {
  connectionGeneration: string;
  ownerUid: string;
  workflowLeaseId: string;
}

interface GoogleCalendarAccessTokenResponse {
  accessToken?: unknown;
  connectionGeneration?: unknown;
  expiresAt?: unknown;
  expiresIn?: unknown;
}

interface GoogleCalendarEventResource {
  end?: { date?: string; dateTime?: string; timeZone?: string };
  etag?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
  id?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  status?: string;
}

interface CachedGoogleAccessToken {
  connectionGeneration: string;
  epoch: number;
  expiresAt: number;
  token: string;
  uid: string;
}

interface BackendErrorPayload {
  error?: unknown;
  message?: unknown;
}

export class GoogleCalendarError extends Error {
  code: string;
  mutationMayHaveApplied: boolean;
  retryable: boolean;
  retryAfterMs: number | null;

  constructor(
    code: string,
    message: string,
    retryable = false,
    retryAfterMs: number | null = null,
    mutationMayHaveApplied = false
  ) {
    super(message);
    this.name = "GoogleCalendarError";
    this.code = code;
    this.mutationMayHaveApplied = mutationMayHaveApplied;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export const disconnectedGoogleCalendarStatus: GoogleCalendarConnectionStatus = {
  configured: true,
  connected: false,
  hasStoredConnection: false,
  needsReconnect: false,
  connectionGeneration: null,
  connectionIdentity: null,
  connectionAttemptId: null,
  connectedAt: null,
  email: null,
  lastSyncAt: null,
  lastSyncStatus: "idle",
  reportSequence: 0,
  serverTime: null,
  syncedCount: 0,
  timeZone: null
};

let cachedAccessToken: CachedGoogleAccessToken | null = null;
let knownConnectionGeneration: string | null = null;
let googleCalendarSessionEpoch = 0;
let googleCalendarSessionAbortController = new AbortController();
let googleCalendarStatusRequestSequence = 0;
let googleCalendarStatusAppliedSequence = 0;
let googleCalendarStatusRequestQueue: Promise<void> = Promise.resolve();
const eventOperationQueues = new Map<string, Promise<GoogleCalendarSyncResult>>();

type FirebaseCalendarUser = NonNullable<typeof auth.currentUser>;

interface GoogleCalendarOperationContext {
  connectionGeneration: string;
  epoch: number;
  operationLeaseId: string;
  sessionSignal: AbortSignal;
  uid: string;
  user: FirebaseCalendarUser;
}

function normalizedSyncState(value: unknown): GoogleCalendarSyncState {
  return value === "synced" || value === "failed" ? value : "idle";
}

function normalizedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function normalizedConnectionGeneration(value: unknown) {
  const generation = normalizedString(value, 43);

  return generation && /^[A-Za-z0-9_-]{43}$/u.test(generation) ? generation : null;
}

function normalizedCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeConnectionStatus(payload: unknown): GoogleCalendarConnectionStatus {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = root.connection && typeof root.connection === "object"
    ? root.connection as Record<string, unknown>
    : root;
  const configured = nested.configured !== false;
  const connectionGeneration = normalizedConnectionGeneration(nested.connectionGeneration);
  const connectionIdentity = normalizedConnectionGeneration(nested.connectionIdentity);
  const connectionAttemptId = normalizedString(nested.connectionAttemptId, 128);
  const rawConnected = nested.connected === true;
  const hasStoredConnection = nested.hasStoredConnection === true
    || rawConnected
    || nested.needsReconnect === true;
  const needsReconnect = nested.needsReconnect === true
    || (rawConnected && !connectionGeneration)
    || (!configured && hasStoredConnection);

  return {
    configured,
    connected: configured && rawConnected && !needsReconnect,
    hasStoredConnection,
    needsReconnect,
    connectionGeneration,
    connectionIdentity,
    connectionAttemptId,
    connectedAt: normalizedString(nested.connectedAt, 64),
    email: normalizedString(nested.email, 320),
    lastSyncAt: normalizedString(nested.lastSyncAt, 64),
    lastSyncStatus: needsReconnect ? "failed" : normalizedSyncState(nested.lastSyncStatus),
    reportSequence: normalizedCount(nested.reportSequence),
    serverTime: normalizedString(root.serverTime ?? nested.serverTime, 64),
    syncedCount: normalizedCount(nested.syncedCount),
    timeZone: normalizedString(nested.timeZone, 80)
  };
}

function invalidateGoogleCalendarSession() {
  googleCalendarSessionAbortController.abort();
  googleCalendarSessionAbortController = new AbortController();
  cachedAccessToken = null;
  knownConnectionGeneration = null;
  googleCalendarSessionEpoch += 1;
}

function assertFirebaseUser(user: FirebaseCalendarUser) {
  if (auth.currentUser !== user || auth.currentUser.uid !== user.uid) {
    invalidateGoogleCalendarSession();
    throw new GoogleCalendarError("login_required", "QuickMemo 계정이 변경되었습니다. 다시 시도해주세요.");
  }
}

function backendError(status: number, payload: BackendErrorPayload) {
  const code = typeof payload.error === "string" ? payload.error : `backend_${status}`;

  if (status === 401) {
    return new GoogleCalendarError("login_required", "로그인 확인이 만료되었습니다. 다시 로그인해주세요.");
  }
  if (status === 403) {
    return new GoogleCalendarError("permission_denied", "이 계정에서는 Google Calendar 연결을 사용할 수 없습니다.");
  }
  if (status === 503 || code === "google_calendar_not_configured") {
    return new GoogleCalendarError(
      "not_configured",
      "Google Calendar 관리자 설정이 아직 완료되지 않았습니다."
    );
  }
  if (code === "google_calendar_not_connected") {
    invalidateGoogleCalendarSession();
    return new GoogleCalendarError("not_connected", "Google Calendar 계정을 먼저 연결해주세요.");
  }
  if (code === "google_connection_changed") {
    invalidateGoogleCalendarSession();
    return new GoogleCalendarError(
      "connection_changed",
      "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }
  if (code === "google_operation_in_progress") {
    return new GoogleCalendarError(
      "operation_in_progress",
      "다른 창에서 Google Calendar 작업을 처리하고 있습니다. 잠시 후 다시 시도해주세요.",
      true,
      1_000
    );
  }
  if (code === "google_deletion_workflow_in_progress") {
    return new GoogleCalendarError(
      "deletion_in_progress",
      "다른 창에서 일정 삭제를 처리하고 있습니다. 완료된 뒤 최신 상태를 다시 동기화해주세요."
    );
  }
  if (code === "google_operation_expired") {
    return new GoogleCalendarError(
      "connection_changed",
      "Google Calendar 작업 보호 시간이 만료되었습니다. 다시 시도해주세요.",
      true
    );
  }
  if (code === "reauthorization_required" || code === "google_reconnect_required" || code === "invalid_grant") {
    invalidateGoogleCalendarSession();
    return new GoogleCalendarError(
      "reauthorization_required",
      "Google Calendar 연결이 만료되었습니다. 계정을 다시 연결해주세요."
    );
  }

  return new GoogleCalendarError(
    code,
    status >= 500
      ? "Google Calendar 연결 서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해주세요."
      : "Google Calendar 요청을 처리하지 못했습니다.",
    status === 429 || status >= 500
  );
}

function syncCancelledError() {
  return new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다.");
}

function throwIfBackendRequestAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw syncCancelledError();
  }
}

async function fetchGoogleCalendarBackend(
  path: string,
  body: Record<string, unknown>,
  idToken: string,
  signal?: AbortSignal
) {
  throwIfBackendRequestAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const handleAbort = () => controller.abort();
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, backendRequestTimeoutMs);

  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    let payload: BackendErrorPayload = {};

    try {
      payload = await response.json() as BackendErrorPayload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      // A malformed backend body is handled from its HTTP status below.
    }

    throwIfBackendRequestAborted(signal);
    if (timedOut) {
      throw new Error("Google Calendar backend request timed out");
    }
    return { payload, response };
  } catch {
    if (signal?.aborted) {
      throw syncCancelledError();
    }
    throw new GoogleCalendarError(
      "network_error",
      timedOut
        ? "Google Calendar 연결 서버의 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요."
        : "네트워크 연결을 확인한 뒤 다시 시도해주세요.",
      true
    );
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", handleAbort);
  }
}

async function backendRequest<T>(
  path: string,
  body: Record<string, unknown>,
  retryAuth = true,
  expectedUser?: FirebaseCalendarUser,
  signal?: AbortSignal
): Promise<T> {
  const requestUser = expectedUser ?? auth.currentUser;

  if (!requestUser) {
    throw new GoogleCalendarError("login_required", "Google Calendar 연결을 위해 다시 로그인해주세요.");
  }

  throwIfBackendRequestAborted(signal);
  assertFirebaseUser(requestUser);
  const idToken = await requestUser.getIdToken(false);
  throwIfBackendRequestAborted(signal);
  assertFirebaseUser(requestUser);
  let result = await fetchGoogleCalendarBackend(path, body, idToken, signal);

  if (result.response.status === 401 && retryAuth) {
    throwIfBackendRequestAborted(signal);
    assertFirebaseUser(requestUser);
    const refreshedToken = await requestUser.getIdToken(true);
    throwIfBackendRequestAborted(signal);
    assertFirebaseUser(requestUser);
    result = await fetchGoogleCalendarBackend(path, body, refreshedToken, signal);
  }

  throwIfBackendRequestAborted(signal);
  assertFirebaseUser(requestUser);

  if (!result.response.ok) {
    throw backendError(result.response.status, result.payload);
  }

  return result.payload as T;
}

export function detectedGoogleCalendarTimeZone() {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return isValidGoogleCalendarTimeZone(candidate) ? candidate : "Asia/Seoul";
}

export function isValidGoogleCalendarTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 80) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

async function requestGoogleCalendarConnectionStatus(signal?: AbortSignal) {
  const requestSequence = googleCalendarStatusRequestSequence + 1;
  const requestEpoch = googleCalendarSessionEpoch;

  googleCalendarStatusRequestSequence = requestSequence;
  const payload = await backendRequest<unknown>(
    googleCalendarConnectionApiPath,
    { action: "status" },
    true,
    undefined,
    signal
  );
  const status = normalizeConnectionStatus(payload);

  if (
    requestEpoch !== googleCalendarSessionEpoch
    || requestSequence < googleCalendarStatusAppliedSequence
  ) {
    return status;
  }

  googleCalendarStatusAppliedSequence = requestSequence;

  if (!status.connected || status.needsReconnect) {
    if (cachedAccessToken || knownConnectionGeneration) {
      invalidateGoogleCalendarSession();
    }
  } else {
    if (knownConnectionGeneration && knownConnectionGeneration !== status.connectionGeneration) {
      invalidateGoogleCalendarSession();
    }
    knownConnectionGeneration = status.connectionGeneration;
  }

  return status;
}

export function getGoogleCalendarConnectionStatus(signal?: AbortSignal) {
  const previousRequest = googleCalendarStatusRequestQueue;
  let releaseTurn: () => void = () => undefined;
  const currentTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  googleCalendarStatusRequestQueue = previousRequest.then(() => currentTurn);

  return (async () => {
    let handleAbort: (() => void) | null = null;

    try {
      if (signal?.aborted) {
        throw syncCancelledError();
      }
      if (signal) {
        await Promise.race([
          previousRequest,
          new Promise<never>((_resolve, reject) => {
            handleAbort = () => reject(syncCancelledError());
            signal.addEventListener("abort", handleAbort, { once: true });
          })
        ]);
      } else {
        await previousRequest;
      }
      throwIfBackendRequestAborted(signal);
      return await requestGoogleCalendarConnectionStatus(signal);
    } finally {
      if (handleAbort) {
        signal?.removeEventListener("abort", handleAbort);
      }
      releaseTurn();
    }
  })();
}

export async function getGoogleCalendarTaskAuthority(input: {
  id: string;
  ownerUid: string;
  revision?: string | null;
}): Promise<"current" | "deleted" | "stale" | "undated"> {
  const user = auth.currentUser;

  if (!user || user.uid !== input.ownerUid) {
    throw new GoogleCalendarError("permission_denied", "다른 사용자의 일정은 동기화할 수 없습니다.");
  }
  const payload = await backendRequest<unknown>(googleCalendarConnectionApiPath, {
    action: "task-authority",
    taskId: input.id,
    revision: input.revision ?? null
  }, true, user);
  const state = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).state
    : null;

  if (!new Set(["current", "deleted", "stale", "undated"]).has(String(state))) {
    throw new GoogleCalendarError("invalid_auth_response", "일정의 최신 동기화 상태를 확인하지 못했습니다.");
  }

  return state as "current" | "deleted" | "stale" | "undated";
}

export async function startGoogleCalendarConnection(timeZone = detectedGoogleCalendarTimeZone()) {
  invalidateGoogleCalendarSession();
  const payload = await backendRequest<{ authorizationUrl?: unknown; connectionAttemptId?: unknown }>(googleCalendarAuthApiPath, {
    action: "start",
    browserTimeZone: isValidGoogleCalendarTimeZone(timeZone) ? timeZone : "Asia/Seoul"
  });
  const authorizationUrl = normalizedString(payload.authorizationUrl, 4096);
  const connectionAttemptId = normalizedString(payload.connectionAttemptId, 128);

  if (!authorizationUrl || !connectionAttemptId || !/^[A-Za-z0-9_-]{43}$/u.test(connectionAttemptId)) {
    throw new GoogleCalendarError("invalid_auth_response", "Google 로그인 주소를 확인하지 못했습니다.");
  }

  const parsedUrl = new URL(authorizationUrl);

  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "accounts.google.com") {
    throw new GoogleCalendarError("invalid_auth_response", "안전하지 않은 Google 로그인 주소가 차단되었습니다.");
  }

  return { authorizationUrl, connectionAttemptId };
}

export async function disconnectGoogleCalendar(
  connectionGeneration: string | null,
  connectionIdentity: string | null
) {
  if (!normalizedConnectionGeneration(connectionIdentity)) {
    throw new GoogleCalendarError(
      "connection_changed",
      "Google Calendar 연결 상태가 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }
  invalidateGoogleCalendarSession();
  await backendRequest(googleCalendarConnectionApiPath, {
    action: "disconnect",
    connectionGeneration: normalizedString(connectionGeneration, 128),
    connectionIdentity
  });
}

export async function beginGoogleCalendarDeletionWorkflow(
  ownerUid: string,
  expectedConnectionGeneration: string,
  signal?: AbortSignal
): Promise<GoogleCalendarDeletionWorkflow> {
  assertGoogleCalendarTaskOwner(ownerUid);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(expectedConnectionGeneration)) {
    throw new GoogleCalendarError("connection_changed", "Google Calendar 연결 상태를 다시 확인해주세요.");
  }
  const user = auth.currentUser;
  assertFirebaseUser(user!);
  const status = await getGoogleCalendarConnectionStatus(signal);

  if (!status.connected
    || status.needsReconnect
    || status.connectionGeneration !== expectedConnectionGeneration) {
    throw new GoogleCalendarError(
      "connection_changed",
      "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }

  const deadline = Date.now() + googleCalendarOperationWaitMs;
  let payload: unknown;

  while (true) {
    try {
      payload = await backendRequest<unknown>(googleCalendarConnectionApiPath, {
        action: "begin-deletion-workflow",
        connectionGeneration: expectedConnectionGeneration
      }, true, user!, signal);
      break;
    } catch (caught) {
      if (!(caught instanceof GoogleCalendarError)
        || caught.code !== "operation_in_progress"
        || Date.now() >= deadline) {
        throw caught;
      }
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(syncCancelledError());
          return;
        }
        const remaining = Math.max(0, deadline - Date.now());
        const delay = Math.min(caught.retryAfterMs ?? 1_000, remaining);
        if (delay === 0) {
          reject(caught);
          return;
        }
        const timer = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", handleAbort);
          resolve();
        }, delay);
        const handleAbort = () => {
          globalThis.clearTimeout(timer);
          reject(syncCancelledError());
        };
        signal?.addEventListener("abort", handleAbort, { once: true });
      });
    }
  }

  const result = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const connectionGeneration = normalizedConnectionGeneration(result.connectionGeneration);
  const workflowLeaseId = normalizedConnectionGeneration(result.leaseId);

  if (connectionGeneration !== expectedConnectionGeneration || !workflowLeaseId) {
    throw new GoogleCalendarError(
      "invalid_auth_response",
      "Google Calendar 삭제 보호 상태를 확인하지 못했습니다."
    );
  }

  return { connectionGeneration, ownerUid, workflowLeaseId };
}

export async function endGoogleCalendarDeletionWorkflow(workflow: GoogleCalendarDeletionWorkflow) {
  if (auth.currentUser?.uid !== workflow.ownerUid
    || !/^[A-Za-z0-9_-]{43}$/u.test(workflow.connectionGeneration)
    || !/^[A-Za-z0-9_-]{43}$/u.test(workflow.workflowLeaseId)) {
    return;
  }
  await backendRequest(googleCalendarConnectionApiPath, {
    action: "end-deletion-workflow",
    connectionGeneration: workflow.connectionGeneration,
    workflowLeaseId: workflow.workflowLeaseId
  });
}

export async function renewGoogleCalendarDeletionWorkflow(
  workflow: GoogleCalendarDeletionWorkflow,
  signal?: AbortSignal
) {
  assertGoogleCalendarTaskOwner(workflow.ownerUid);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(workflow.connectionGeneration)
    || !/^[A-Za-z0-9_-]{43}$/u.test(workflow.workflowLeaseId)) {
    throw new GoogleCalendarError(
      "connection_changed",
      "Google Calendar 삭제 보호 상태를 다시 확인해주세요."
    );
  }
  const user = auth.currentUser;
  assertFirebaseUser(user!);
  const payload = await backendRequest<unknown>(googleCalendarConnectionApiPath, {
    action: "renew-deletion-workflow",
    connectionGeneration: workflow.connectionGeneration,
    workflowLeaseId: workflow.workflowLeaseId
  }, true, user!, signal);
  const result = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};

  if (normalizedConnectionGeneration(result.connectionGeneration) !== workflow.connectionGeneration
    || normalizedConnectionGeneration(result.leaseId) !== workflow.workflowLeaseId) {
    throw new GoogleCalendarError(
      "invalid_auth_response",
      "Google Calendar 삭제 보호 상태를 확인하지 못했습니다."
    );
  }
}

export function clearGoogleCalendarSession() {
  invalidateGoogleCalendarSession();
}

export async function reportGoogleCalendarSync(input: {
  failureCode?: string;
  status: GoogleCalendarSyncState;
  syncedCount?: number;
}) {
  const connectionGeneration = knownConnectionGeneration;

  if (!connectionGeneration) {
    return;
  }
  const rawFailureCode = input.failureCode?.replace(/[^a-z0-9_-]/giu, "").slice(0, 64);
  const allowedFailureCodes = new Set([
    "calendar_request_failed",
    "event_conflict",
    "google_api_error",
    "google_unavailable",
    "network_error",
    "permission_denied",
    "rate_limited",
    "reauthorization_required",
    "reconnect_required",
    "unknown",
    "unknown_error"
  ]);
  const failureCode = rawFailureCode && allowedFailureCodes.has(rawFailureCode)
    ? rawFailureCode
    : rawFailureCode
      ? "google_api_error"
      : undefined;
  const syncedCount = Math.max(0, Math.min(100_000, Math.trunc(input.syncedCount ?? 0)));

  await backendRequest(googleCalendarConnectionApiPath, {
    action: "report",
    connectionGeneration,
    status: input.status,
    syncedCount,
    ...(failureCode ? { failureCode } : {})
  });
}

function assertGoogleCalendarOperationContext(context: GoogleCalendarOperationContext) {
  assertFirebaseUser(context.user);
  if (
    googleCalendarSessionEpoch !== context.epoch
    || knownConnectionGeneration !== context.connectionGeneration
  ) {
    throw new GoogleCalendarError(
      "connection_changed",
      "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }
}

async function getGoogleCalendarAccessToken(
  context: GoogleCalendarOperationContext,
  forceRefresh = false,
  signal?: AbortSignal
) {
  assertGoogleCalendarOperationContext(context);

  if (
    !forceRefresh
    && cachedAccessToken
    && cachedAccessToken.uid === context.uid
    && cachedAccessToken.connectionGeneration === context.connectionGeneration
    && cachedAccessToken.epoch === context.epoch
    && cachedAccessToken.expiresAt > Date.now() + accessTokenRefreshSkewMs
  ) {
    return cachedAccessToken.token;
  }

  const payload = await backendRequest<GoogleCalendarAccessTokenResponse>(googleCalendarConnectionApiPath, {
    action: "access-token",
    connectionGeneration: context.connectionGeneration,
    operationLeaseId: context.operationLeaseId
  }, true, context.user, signal);
  const token = normalizedString(payload.accessToken, 8192);
  const connectionGeneration = normalizedString(payload.connectionGeneration, 128);
  const expiresAtValue = typeof payload.expiresAt === "string" || typeof payload.expiresAt === "number"
    ? new Date(payload.expiresAt).getTime()
    : Number.NaN;
  const expiresIn = typeof payload.expiresIn === "number" ? payload.expiresIn : 3600;
  const expiresAt = Number.isFinite(expiresAtValue)
    ? expiresAtValue
    : Date.now() + Math.max(60, Math.min(3600, expiresIn)) * 1000;

  if (!token || !connectionGeneration) {
    throw new GoogleCalendarError("invalid_token_response", "Google Calendar 접근 권한을 확인하지 못했습니다.");
  }

  assertGoogleCalendarOperationContext(context);

  if (connectionGeneration !== context.connectionGeneration) {
    invalidateGoogleCalendarSession();
    throw new GoogleCalendarError(
      "connection_changed",
      "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }

  cachedAccessToken = {
    connectionGeneration,
    epoch: context.epoch,
    expiresAt,
    token,
    uid: context.uid
  };
  return token;
}

async function validateGoogleCalendarGeneration(
  context: GoogleCalendarOperationContext,
  signal?: AbortSignal
) {
  await backendRequest(googleCalendarConnectionApiPath, {
    action: "validate-generation",
    connectionGeneration: context.connectionGeneration,
    operationLeaseId: context.operationLeaseId
  }, true, context.user, signal);
  assertGoogleCalendarOperationContext(context);
}

async function googleCalendarRequest(
  path: string,
  context: GoogleCalendarOperationContext,
  init: RequestInit = {},
  retryAuth = true
) {
  assertGoogleCalendarOperationContext(context);
  const externalSignal = init.signal ?? undefined;
  const sessionSignal = context.sessionSignal;

  if (externalSignal?.aborted) {
    throw syncCancelledError();
  }
  if (sessionSignal.aborted) {
    throw new GoogleCalendarError(
      "connection_changed",
      "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }
  const canReuseCachedToken = retryAuth
    && cachedAccessToken
    && cachedAccessToken.uid === context.uid
    && cachedAccessToken.connectionGeneration === context.connectionGeneration
    && cachedAccessToken.epoch === context.epoch
    && cachedAccessToken.expiresAt > Date.now() + accessTokenRefreshSkewMs;

  if (canReuseCachedToken) {
    await validateGoogleCalendarGeneration(context, init.signal ?? undefined);
  }
  const accessToken = await getGoogleCalendarAccessToken(context, !retryAuth, init.signal ?? undefined);
  let response: Response;
  const controller = new AbortController();
  let timedOut = false;
  const handleExternalAbort = () => controller.abort();
  const handleSessionAbort = () => controller.abort();
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, googleCalendarRequestTimeoutMs);

  externalSignal?.addEventListener("abort", handleExternalAbort, { once: true });
  sessionSignal.addEventListener("abort", handleSessionAbort, { once: true });

  try {
    response = await fetch(`${googleCalendarApiBaseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {})
      }
    });
    const body = response.body ? await response.arrayBuffer() : null;

    response = new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  } catch {
    if (externalSignal?.aborted) {
      throw syncCancelledError();
    }
    if (sessionSignal.aborted) {
      throw new GoogleCalendarError(
        "connection_changed",
        "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
      );
    }
    throw new GoogleCalendarError(
      "network_error",
      timedOut
        ? "Google Calendar의 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요."
        : "Google Calendar에 연결하지 못했습니다. 네트워크를 확인해주세요.",
      true
    );
  } finally {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", handleExternalAbort);
    sessionSignal.removeEventListener("abort", handleSessionAbort);
  }

  if (externalSignal?.aborted) {
    throw syncCancelledError();
  }
  if (sessionSignal.aborted) {
    throw new GoogleCalendarError(
      "connection_changed",
      "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
    );
  }

  assertGoogleCalendarOperationContext(context);

  if (response.status === 401 && retryAuth) {
    cachedAccessToken = null;
    return googleCalendarRequest(path, context, init, false);
  }

  return response;
}

function googleCalendarHttpError(status: number, reason = "", retryAfterMs: number | null = null) {
  if (status === 401) {
    return new GoogleCalendarError(
      "reauthorization_required",
      "Google Calendar 연결이 만료되었습니다. 계정을 다시 연결해주세요."
    );
  }
  if (status === 403 && new Set([
    "calendarUsageLimitsExceeded",
    "dailyLimitExceeded",
    "quotaExceeded",
    "rateLimitExceeded",
    "userRateLimitExceeded"
  ]).has(reason)) {
    return new GoogleCalendarError(
      "rate_limited",
      "Google Calendar 요청이 많아 잠시 대기 중입니다. 잠시 후 다시 시도해주세요.",
      true,
      retryAfterMs
    );
  }
  if (status === 403) {
    return new GoogleCalendarError(
      "permission_denied",
      "연결된 Google 계정에 일정 수정 권한이 없습니다. 계정을 다시 연결해주세요."
    );
  }
  if (status === 409 || status === 412) {
    return new GoogleCalendarError(
      "event_conflict",
      "Google Calendar에서 같은 일정이 변경되었습니다. 다시 동기화해주세요."
    );
  }
  if (status === 429) {
    return new GoogleCalendarError(
      "rate_limited",
      "Google Calendar 요청이 많아 잠시 대기 중입니다. 잠시 후 다시 시도해주세요.",
      true,
      retryAfterMs
    );
  }
  if (status >= 500) {
    return new GoogleCalendarError(
      "google_unavailable",
      "Google Calendar가 잠시 응답하지 않습니다. 잠시 후 다시 시도해주세요.",
      true
    );
  }

  return new GoogleCalendarError("calendar_request_failed", "Google Calendar 동기화에 실패했습니다.");
}

function retryAfterMilliseconds(response: Response) {
  const value = response.headers.get("retry-after");

  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(60_000, Math.trunc(seconds * 1000)));
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(60_000, date - Date.now())) : null;
}

async function googleCalendarResponseError(response: Response) {
  let reason = "";

  if (response.status === 403) {
    try {
      const payload = await response.clone().json() as {
        error?: { errors?: Array<{ reason?: unknown }> };
      };
      const candidate = payload.error?.errors?.[0]?.reason;
      reason = typeof candidate === "string" && candidate.length <= 80 ? candidate : "";
    } catch {
      // A malformed Google error body is classified by its HTTP status.
    }
  }

  return googleCalendarHttpError(response.status, reason, retryAfterMilliseconds(response));
}

function hexDigest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function googleCalendarEventId(ownerUid: string, taskId: string) {
  const identifier = `${ownerUid}:${taskId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identifier));

  // Google event ids allow base32hex characters (0-9, a-v). Hex is a strict subset.
  return `qm${hexDigest(digest).slice(0, 48)}`;
}

function limitedEventTitle(title: string) {
  const normalized = title.trim() || "제목 없음";

  return Array.from(normalized).slice(0, 512).join("");
}

function wallDateTime(date: string, minutes: number) {
  const safeMinutes = Math.max(0, Math.min(1439, Math.trunc(minutes)));
  const hour = Math.floor(safeMinutes / 60).toString().padStart(2, "0");
  const minute = (safeMinutes % 60).toString().padStart(2, "0");

  return `${date}T${hour}:${minute}:00`;
}

function addWallMinutes(date: string, minutes: number, increment: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, 0, minutes + increment, 0));
  const nextDate = [
    value.getUTCFullYear().toString().padStart(4, "0"),
    (value.getUTCMonth() + 1).toString().padStart(2, "0"),
    value.getUTCDate().toString().padStart(2, "0")
  ].join("-");
  const nextMinutes = value.getUTCHours() * 60 + value.getUTCMinutes();

  return { date: nextDate, minutes: nextMinutes };
}

export function buildGoogleCalendarEvent(task: GoogleCalendarTaskInput, timeZone: string) {
  const startDate = task.startDate;

  if (!startDate || !isValidScheduleDateString(startDate)) {
    return null;
  }

  const safeTimeZone = isValidGoogleCalendarTimeZone(timeZone) ? timeZone : "Asia/Seoul";
  const endDate = task.endDate && isValidScheduleDateString(task.endDate) && task.endDate >= startDate
    ? task.endDate
    : startDate;

  if (task.startTimeMinutes === null) {
    return {
      summary: limitedEventTitle(task.title),
      start: { date: startDate },
      end: { date: addDays(endDate, 1) },
      status: "confirmed" as const,
      visibility: "private" as const
    };
  }

  const startMinutes = Math.max(0, Math.min(1439, Math.trunc(task.startTimeMinutes)));
  let timedEndDate = endDate;
  let endMinutes = task.endTimeMinutes === null
    ? startMinutes
    : Math.max(0, Math.min(1439, Math.trunc(task.endTimeMinutes)));

  if (task.endTimeMinutes === null) {
    const defaultEnd = addWallMinutes(startDate, startMinutes, defaultTimedEventDurationMinutes);
    timedEndDate = defaultEnd.date;
    endMinutes = defaultEnd.minutes;
  } else if (timedEndDate === startDate && endMinutes <= startMinutes) {
    const safeEnd = addWallMinutes(startDate, startMinutes, defaultTimedEventDurationMinutes);
    timedEndDate = safeEnd.date;
    endMinutes = safeEnd.minutes;
  }

  return {
    summary: limitedEventTitle(task.title),
    start: { dateTime: wallDateTime(startDate, startMinutes), timeZone: safeTimeZone },
    end: { dateTime: wallDateTime(timedEndDate, endMinutes), timeZone: safeTimeZone },
    status: "confirmed" as const,
    visibility: "private" as const
  };
}

function eventBelongsToQuickMemo(event: GoogleCalendarEventResource, eventId: string) {
  const properties = event.extendedProperties?.private;

  return properties?.quickMemoSource === "quickmemo-v1"
    && properties.quickMemoEventId === eventId;
}

function normalizedTaskRevision(value: string | null | undefined) {
  return typeof value === "string" && /^\d{12}\.\d{9}$/u.test(value) ? value : null;
}

function quickMemoExtendedProperties(eventId: string, revision?: string | null) {
  const normalizedRevision = normalizedTaskRevision(revision);

  return {
    private: {
      quickMemoEventId: eventId,
      quickMemoSource: "quickmemo-v1",
      ...(normalizedRevision ? { quickMemoRevision: normalizedRevision } : {})
    }
  };
}

function eventRevisionBlocksUpsert(event: GoogleCalendarEventResource, revision?: string | null) {
  const incomingRevision = normalizedTaskRevision(revision);
  const existingRevision = normalizedTaskRevision(event.extendedProperties?.private?.quickMemoRevision);

  if (!incomingRevision || !existingRevision) {
    return false;
  }

  // An organizer's cancelled event can be restored with events.patch. Equal
  // revisions must therefore PATCH status back to confirmed; only a strictly
  // newer cancelled revision is safe to leave untouched.
  return event.status === "cancelled"
    ? existingRevision > incomingRevision
    : existingRevision >= incomingRevision;
}

async function readGoogleCalendarEvent(
  eventId: string,
  context: GoogleCalendarOperationContext,
  signal?: AbortSignal
) {
  const response = await googleCalendarRequest(
    `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    context,
    { method: "GET", signal }
  );

  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (!response.ok) {
    throw await googleCalendarResponseError(response);
  }

  return response.json() as Promise<GoogleCalendarEventResource>;
}

async function deleteGoogleCalendarTaskNow(
  eventId: string,
  context: GoogleCalendarOperationContext,
  signal?: AbortSignal
): Promise<GoogleCalendarSyncResult> {
  const existing = await readGoogleCalendarEvent(eventId, context, signal);

  if (!existing || existing.status === "cancelled") {
    return { eventId, outcome: "deleted", remoteWasPresent: false };
  }
  if (!eventBelongsToQuickMemo(existing, eventId)) {
    throw googleCalendarHttpError(409);
  }

  let response: Response;

  try {
    response = await googleCalendarRequest(
      `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      context,
      {
        method: "DELETE",
        signal,
        headers: existing.etag ? { "if-match": existing.etag } : undefined
      }
    );
  } catch (caught) {
    const ambiguous = caught instanceof GoogleCalendarError
      && (caught.retryable
        || caught.mutationMayHaveApplied
        || caught.code === "connection_changed"
        || caught.code === "sync_cancelled");

    if (ambiguous) {
      try {
        if (await googleCalendarEventIsAbsent(eventId, context)) {
          return { eventId, outcome: "deleted", remoteWasPresent: true };
        }
      } catch (verificationError) {
        if (verificationError instanceof GoogleCalendarError) {
          verificationError.mutationMayHaveApplied = true;
        }
        throw verificationError;
      }
      caught.mutationMayHaveApplied = true;
    }
    throw caught;
  }

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const error = await googleCalendarResponseError(response);

    if (error.retryable) {
      try {
        if (await googleCalendarEventIsAbsent(eventId, context)) {
          return { eventId, outcome: "deleted", remoteWasPresent: true };
        }
      } catch (verificationError) {
        if (verificationError instanceof GoogleCalendarError) {
          verificationError.mutationMayHaveApplied = true;
        }
        throw verificationError;
      }
      error.mutationMayHaveApplied = true;
    }
    throw error;
  }

  return { eventId, outcome: "deleted", remoteWasPresent: true };
}

async function googleCalendarEventIsAbsent(
  eventId: string,
  context: GoogleCalendarOperationContext
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, attempt * 250);
      });
    }

    try {
      const event = await readGoogleCalendarEvent(eventId, context);

      if (!event || event.status === "cancelled") {
        return true;
      }
      return false;
    } catch (caught) {
      if (caught instanceof GoogleCalendarError && new Set([
        "connection_changed",
        "login_required",
        "not_connected",
        "permission_denied",
        "reauthorization_required"
      ]).has(caught.code)) {
        throw caught;
      }
    }
  }

  return false;
}

async function patchGoogleCalendarEvent(
  eventId: string,
  event: object,
  etag: string | undefined,
  context: GoogleCalendarOperationContext,
  signal?: AbortSignal
) {
  return googleCalendarRequest(
    `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    context,
    {
      method: "PATCH",
      signal,
      headers: etag ? { "if-match": etag } : undefined,
      body: JSON.stringify(event)
    }
  );
}

async function patchGoogleCalendarEventWithRevision(
  eventId: string,
  event: object,
  initialEvent: GoogleCalendarEventResource,
  revision: string | null | undefined,
  context: GoogleCalendarOperationContext,
  signal?: AbortSignal
) {
  const incomingRevision = normalizedTaskRevision(revision);
  let currentEvent = initialEvent;

  for (let attempt = 0; attempt <= maxPatchConflictRetries; attempt += 1) {
    if (eventRevisionBlocksUpsert(currentEvent, incomingRevision)) {
      return "skipped" as const;
    }

    const response = await patchGoogleCalendarEvent(
      eventId,
      event,
      currentEvent.etag,
      context,
      signal
    );

    if (response.ok) {
      return "updated" as const;
    }
    if (
      !incomingRevision
      || !new Set([409, 412]).has(response.status)
      || attempt >= maxPatchConflictRetries
    ) {
      throw await googleCalendarResponseError(response);
    }

    const latestEvent = await readGoogleCalendarEvent(eventId, context, signal);

    if (!latestEvent || !latestEvent.etag || !eventBelongsToQuickMemo(latestEvent, eventId)) {
      throw googleCalendarHttpError(409);
    }
    currentEvent = latestEvent;
  }

  throw googleCalendarHttpError(409);
}

async function upsertGoogleCalendarTaskNow(
  task: GoogleCalendarTaskInput,
  timeZone: string,
  context: GoogleCalendarOperationContext,
  signal?: AbortSignal
): Promise<GoogleCalendarSyncResult> {
  const event = buildGoogleCalendarEvent(task, timeZone);
  const eventId = await googleCalendarEventId(task.ownerUid, task.id);

  if (!event) {
    return deleteGoogleCalendarTaskNow(eventId, context, signal);
  }

  const existing = await readGoogleCalendarEvent(eventId, context, signal);

  if (existing) {
    if (existing.status === "cancelled") {
      if (existing.extendedProperties?.private && !eventBelongsToQuickMemo(existing, eventId)) {
        throw googleCalendarHttpError(409);
      }
    } else if (!eventBelongsToQuickMemo(existing, eventId)) {
      throw googleCalendarHttpError(409);
    }

    if (eventRevisionBlocksUpsert(existing, task.revision)) {
      return { eventId, outcome: "skipped" };
    }

    const patch = {
      ...event,
      extendedProperties: quickMemoExtendedProperties(eventId, task.revision)
    };

    const outcome = await patchGoogleCalendarEventWithRevision(
      eventId,
      patch,
      existing,
      task.revision,
      context,
      signal
    );
    return { eventId, outcome };
  }

  const response = await googleCalendarRequest("/calendars/primary/events?sendUpdates=none", context, {
    method: "POST",
    signal,
    body: JSON.stringify({
      id: eventId,
      ...event,
      extendedProperties: quickMemoExtendedProperties(eventId, task.revision)
    })
  });

  if (response.status === 409) {
    const racedEvent = await readGoogleCalendarEvent(eventId, context, signal);

    if (!racedEvent || !eventBelongsToQuickMemo(racedEvent, eventId)) {
      throw googleCalendarHttpError(409);
    }

    if (eventRevisionBlocksUpsert(racedEvent, task.revision)) {
      return { eventId, outcome: "skipped" };
    }

    const outcome = await patchGoogleCalendarEventWithRevision(eventId, {
      ...event,
      extendedProperties: quickMemoExtendedProperties(eventId, task.revision)
    }, racedEvent, task.revision, context, signal);
    return { eventId, outcome };
  }
  if (!response.ok) {
    throw await googleCalendarResponseError(response);
  }

  return { eventId, outcome: "created" };
}

function enqueueEventOperation(
  eventKey: string,
  operation: () => Promise<GoogleCalendarSyncResult>
) {
  const previous = eventOperationQueues.get(eventKey) ?? Promise.resolve({ eventId: null, outcome: "skipped" } as GoogleCalendarSyncResult);
  const queued = previous.catch(() => undefined).then(operation);

  eventOperationQueues.set(eventKey, queued);
  const cleanup = () => {
    if (eventOperationQueues.get(eventKey) === queued) {
      eventOperationQueues.delete(eventKey);
    }
  };

  void queued.then(cleanup, cleanup);

  return queued;
}

async function prepareGoogleCalendarOperation(
  ownerUid: string,
  signal?: AbortSignal,
  deletionWorkflow?: GoogleCalendarDeletionWorkflow
): Promise<GoogleCalendarOperationContext> {
  const user = auth.currentUser;

  if (!user || !ownerUid || user.uid !== ownerUid) {
    cachedAccessToken = null;
    throw new GoogleCalendarError("permission_denied", "현재 QuickMemo 계정의 일정만 동기화할 수 있습니다.");
  }

  const status = await getGoogleCalendarConnectionStatus(signal);

  if (status.needsReconnect) {
    throw new GoogleCalendarError(
      "reauthorization_required",
      "Google Calendar 연결이 만료되었습니다. 계정을 다시 연결해주세요."
    );
  }
  if (!status.connected || !status.connectionGeneration) {
    throw new GoogleCalendarError("not_connected", "Google Calendar 계정을 먼저 연결해주세요.");
  }
  if (deletionWorkflow && (
    deletionWorkflow.ownerUid !== ownerUid
    || deletionWorkflow.connectionGeneration !== status.connectionGeneration
    || !/^[A-Za-z0-9_-]{43}$/u.test(deletionWorkflow.workflowLeaseId)
  )) {
    throw new GoogleCalendarError(
      "connection_changed",
      "Google Calendar 삭제 보호 상태가 만료되었습니다. 다시 시도해주세요."
    );
  }

  assertFirebaseUser(user);
  const baseContext = {
    connectionGeneration: status.connectionGeneration,
    epoch: googleCalendarSessionEpoch,
    sessionSignal: googleCalendarSessionAbortController.signal,
    uid: ownerUid,
    user
  };
  let payload: unknown;
  const operationWaitDeadline = Date.now() + googleCalendarOperationWaitMs;

  while (true) {
    try {
      payload = await backendRequest<unknown>(googleCalendarConnectionApiPath, {
        action: "begin-operation",
        connectionGeneration: status.connectionGeneration,
        ...(deletionWorkflow
          ? { deletionWorkflowLeaseId: deletionWorkflow.workflowLeaseId }
          : {})
      }, true, user, signal);
      break;
    } catch (caught) {
      if (!(caught instanceof GoogleCalendarError)
        || caught.code !== "operation_in_progress"
        || Date.now() >= operationWaitDeadline) {
        throw caught;
      }
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(syncCancelledError());
          return;
        }
        const remainingWaitMs = Math.max(0, operationWaitDeadline - Date.now());
        const delayMs = Math.min(caught.retryAfterMs ?? 1_000, remainingWaitMs);

        if (delayMs === 0) {
          reject(caught);
          return;
        }
        const timer = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", handleAbort);
          resolve();
        }, delayMs);
        const handleAbort = () => {
          globalThis.clearTimeout(timer);
          reject(syncCancelledError());
        };

        signal?.addEventListener("abort", handleAbort, { once: true });
      });
    }
  }
  const operation = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const operationLeaseId = normalizedString(operation.leaseId, 128);
  const operationGeneration = normalizedString(operation.connectionGeneration, 128);

  if (!operationLeaseId
    || !/^[A-Za-z0-9_-]{43}$/u.test(operationLeaseId)
    || operationGeneration !== status.connectionGeneration) {
    throw new GoogleCalendarError("invalid_auth_response", "Google Calendar 작업 보호 상태를 확인하지 못했습니다.");
  }

  return {
    ...baseContext,
    operationLeaseId
  } satisfies GoogleCalendarOperationContext;
}

async function releaseGoogleCalendarOperation(context: GoogleCalendarOperationContext) {
  await backendRequest(googleCalendarConnectionApiPath, {
    action: "end-operation",
    connectionGeneration: context.connectionGeneration,
    operationLeaseId: context.operationLeaseId
  }, true, context.user).catch(() => undefined);
}

function assertGoogleCalendarTaskOwner(ownerUid: string) {
  const user = auth.currentUser;

  if (!user || !ownerUid || user.uid !== ownerUid) {
    cachedAccessToken = null;
    throw new GoogleCalendarError("permission_denied", "현재 QuickMemo 계정의 일정만 동기화할 수 있습니다.");
  }
  assertFirebaseUser(user);
}

export async function upsertGoogleCalendarTask(
  task: GoogleCalendarTaskInput,
  timeZone: string,
  signal?: AbortSignal,
  deletionWorkflow?: GoogleCalendarDeletionWorkflow
) {
  assertGoogleCalendarTaskOwner(task.ownerUid);
  if (deletionWorkflow && deletionWorkflow.ownerUid !== task.ownerUid) {
    throw new GoogleCalendarError(
      "permission_denied",
      "현재 QuickMemo 계정의 삭제 보호 상태만 사용할 수 있습니다."
    );
  }
  const requestedConnectionGeneration = knownConnectionGeneration;

  return enqueueEventOperation(task.ownerUid, async () => {
    const context = await prepareGoogleCalendarOperation(task.ownerUid, signal, deletionWorkflow);

    try {
      if (
        requestedConnectionGeneration
        && context.connectionGeneration !== requestedConnectionGeneration
      ) {
        throw new GoogleCalendarError(
          "connection_changed",
          "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
        );
      }

      return await upsertGoogleCalendarTaskNow(task, timeZone, context, signal);
    } finally {
      await releaseGoogleCalendarOperation(context);
    }
  });
}

export async function deleteGoogleCalendarTask(
  task: Pick<GoogleCalendarTaskInput, "id" | "ownerUid">,
  signal?: AbortSignal,
  deletionWorkflow?: GoogleCalendarDeletionWorkflow
) {
  assertGoogleCalendarTaskOwner(task.ownerUid);
  if (deletionWorkflow && deletionWorkflow.ownerUid !== task.ownerUid) {
    throw new GoogleCalendarError(
      "permission_denied",
      "현재 QuickMemo 계정의 삭제 보호 상태만 사용할 수 있습니다."
    );
  }
  const requestedConnectionGeneration = knownConnectionGeneration;
  const eventId = await googleCalendarEventId(task.ownerUid, task.id);

  return enqueueEventOperation(task.ownerUid, async () => {
    const context = await prepareGoogleCalendarOperation(task.ownerUid, signal, deletionWorkflow);

    try {
      if (
        requestedConnectionGeneration
        && context.connectionGeneration !== requestedConnectionGeneration
      ) {
        throw new GoogleCalendarError(
          "connection_changed",
          "연결된 Google 계정이 변경되었습니다. 상태를 새로고침한 뒤 다시 시도해주세요."
        );
      }

      return await deleteGoogleCalendarTaskNow(eventId, context, signal);
    } finally {
      await releaseGoogleCalendarOperation(context);
    }
  });
}

export function googleCalendarErrorMessage(error: unknown) {
  return error instanceof GoogleCalendarError
    ? error.message
    : "Google Calendar 동기화 중 예상하지 못한 오류가 발생했습니다.";
}

export function googleCalendarErrorCode(error: unknown) {
  return error instanceof GoogleCalendarError ? error.code : "unknown_error";
}
