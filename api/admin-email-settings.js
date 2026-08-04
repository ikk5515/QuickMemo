/* global console */

import { createGmailSmtpEmailAdapter } from "./_secure-share-gmail-smtp.js";
import {
  HttpError,
  activeUserFromRequest,
  applySecureResponseHeaders,
  assertOnlyKeys,
  authorizationToken,
  createDocumentWrite,
  createFirestoreContext,
  ensureSameOrigin,
  envValue,
  firestoreCommit,
  firestoreBatchGet,
  firestoreGet,
  generateOtpCode,
  handleApiError,
  headerValue,
  jsonResponse,
  readJsonBody,
  requestId,
  safeErrorSummary,
  updateDocumentWrite,
  verifySecureShareAppCheck
} from "./_secure-share-common.js";
import {
  activeSlotForProject,
  adminEmailSettingsRequestHash,
  adminAuditWrite,
  adminIdempotencyRequestMatches,
  adminIdempotencyOutcomeWrite,
  assertEmailSettingsTestSendAvailable,
  adminIdempotencyWrite,
  assertEmailSettingsGeneration,
  assertEmailSettingsIdempotencyKey,
  consumeEmailSettingsAdminRateLimit,
  createPendingEmailSettingsSlot,
  decryptEmailSettingsSlot,
  emailSettingsTestMaximumAttempts,
  emailSettingsTestFailureDisposition,
  emailTestCodeDigest,
  emailTestCodeMatches,
  idTokenHasRecentAdminAuthentication,
  invalidateSecureShareEmailRuntimeCache,
  isOptimisticFirestoreConflict,
  nextTestWindow,
  normalizeGmailSettingsInput,
  priorAdminIdempotency,
  providerHealthWrite,
  publicEmailSettingsStatus,
  removeProviderHealthWrite,
  safeSecureShareEmailRuntimeSnapshot,
  secureShareEmailProviderHealthPath,
  secureShareEmailSettingsPath,
  settingsDocumentWrite,
  testRequestHash
} from "./_secure-share-email-settings.js";

const validActions = new Set([
  "status",
  "stage",
  "send-test",
  "confirm-test",
  "disable",
  "discard-pending",
  "remove"
]);
const mutatingActions = new Set([
  "stage",
  "send-test",
  "confirm-test",
  "disable",
  "discard-pending",
  "remove"
]);
const validRemoveTargets = new Set(["active", "pending", "all"]);
const maximumBodyBytes = 8 * 1024;

function boundedEmailQuotaValue(name, fallback, maximum) {
  const parsed = Number.parseInt(envValue(name), 10);
  if (Number.isSafeInteger(parsed) && parsed > maximum) {
    throw new HttpError(
      503,
      "email_settings_unavailable",
      "Email quota configuration exceeds the free-operation cap"
    );
  }
  return Number.isSafeInteger(parsed)
    ? Math.min(Math.max(parsed, 1), maximum)
    : fallback;
}

function emailTestQuotaPolicy() {
  return {
    minute: boundedEmailQuotaValue(
      "SHARE_EMAIL_GLOBAL_MINUTE_LIMIT",
      3,
      3
    ),
    hour: boundedEmailQuotaValue(
      "SHARE_EMAIL_GLOBAL_HOURLY_LIMIT",
      20,
      20
    ),
    rolling24h: boundedEmailQuotaValue(
      "SHARE_EMAIL_ROLLING_24H_HARD_LIMIT",
      30,
      30
    ),
    month: boundedEmailQuotaValue(
      "SHARE_EMAIL_MONTHLY_HARD_LIMIT",
      700,
      700
    )
  };
}

function hourQuotaPeriod(hourStart, limit) {
  const key = new Date(hourStart).toISOString().slice(0, 13);
  return {
    bucketId: `hour_${key}`,
    expiresAt: new Date(hourStart + 32 * 24 * 60 * 60 * 1000),
    hardLimit: limit,
    periodKey: key,
    scope: "hourly",
    softLimit: limit
  };
}

function emailTestQuotaPeriods(nowMilliseconds = Date.now()) {
  const policy = emailTestQuotaPolicy();
  const now = new Date(nowMilliseconds);
  const minuteStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes()
  );
  const hourStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours()
  );
  const seoul = new Date(nowMilliseconds + 9 * 60 * 60 * 1000);
  const monthKey = seoul.toISOString().slice(0, 7);
  const nextMonth =
    Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth() + 1, 1)
    - 9 * 60 * 60 * 1000;
  const minuteKey = now.toISOString().slice(0, 16);
  const current = [
    {
      bucketId: `minute_${minuteKey}`,
      expiresAt: new Date(minuteStart + 72 * 60 * 60 * 1000),
      hardLimit: policy.minute,
      periodKey: minuteKey,
      scope: "minute",
      softLimit: policy.minute
    },
    hourQuotaPeriod(hourStart, policy.hour),
    {
      bucketId: `month_${monthKey}`,
      expiresAt: new Date(nextMonth + 400 * 24 * 60 * 60 * 1000),
      hardLimit: policy.month,
      periodKey: monthKey,
      scope: "monthly",
      softLimit: Math.min(500, policy.month)
    }
  ];
  const historicalHours = Array.from({ length: 24 }, (_, index) =>
    hourQuotaPeriod(hourStart - (index + 1) * 60 * 60 * 1000, policy.hour)
  );
  return { current, historicalHours, rollingLimit: policy.rolling24h };
}

function quotaCounts(document) {
  const counts = {
    reservedCount: document?.reservedCount ?? 0,
    sentCount: document?.sentCount ?? 0,
    failedCount: document?.failedCount ?? 0,
    ambiguousCount: document?.ambiguousCount ?? 0
  };
  if (
    Object.values(counts).some(
      (value) => !Number.isSafeInteger(value) || value < 0
    )
  ) {
    throw new HttpError(
      503,
      "email_settings_unavailable",
      "Email quota state is invalid"
    );
  }
  return counts;
}

class EmailTestQuotaSnapshotConflict extends Error {
  constructor() {
    super("Email test quota snapshot changed concurrently");
    this.name = "EmailTestQuotaSnapshotConflict";
  }
}

function quotaEnforcementTotal(document, scope) {
  const counts = quotaCounts(document);
  return (
    counts.reservedCount
    + counts.sentCount
    + counts.ambiguousCount
    + (new Set(["minute", "hourly"]).has(scope)
      ? counts.failedCount
      : 0)
  );
}

function emailQuotaWrite(context, state, deltas, now) {
  const counts = quotaCounts(state.document);
  const fields = {
    scope: state.period.scope,
    periodKey: state.period.periodKey,
    reservedCount: counts.reservedCount + (deltas.reserved ?? 0),
    sentCount: counts.sentCount + (deltas.sent ?? 0),
    failedCount: counts.failedCount + (deltas.failed ?? 0),
    ambiguousCount: counts.ambiguousCount + (deltas.ambiguous ?? 0),
    softLimit: state.period.softLimit,
    hardLimit: state.period.hardLimit,
    softLimitReached: false,
    updatedAt: now,
    expiresAt: state.period.expiresAt
  };
  if (
    fields.reservedCount < 0
    || fields.sentCount < 0
    || fields.failedCount < 0
    || fields.ambiguousCount < 0
  ) {
    throw new HttpError(
      503,
      "email_settings_unavailable",
      "Email quota accounting underflow"
    );
  }
  const enforcement = quotaEnforcementTotal(fields, fields.scope);
  fields.softLimitReached = enforcement >= fields.softLimit;
  const path = `publicShareEmailQuotaBuckets/${state.period.bucketId}`;
  return state.document
    ? updateDocumentWrite(
      context.projectId,
      path,
      fields,
      Object.keys(fields),
      state.document.__updateTime
    )
    : createDocumentWrite(context.projectId, path, fields);
}

async function reserveEmailTestQuota(context, nowMilliseconds = Date.now()) {
  const periods = emailTestQuotaPeriods(nowMilliseconds);
  const allPeriods = [...periods.current, ...periods.historicalHours];
  const paths = allPeriods.map(
    (period) => `publicShareEmailQuotaBuckets/${period.bucketId}`
  );
  const documents = await firestoreBatchGet(context, paths);
  const states = allPeriods.map((period, index) => ({
    document: documents[index],
    period
  }));
  const currentStates = states.slice(0, 3);
  if (currentStates.some(
    (state) =>
      quotaEnforcementTotal(state.document, state.period.scope)
      >= state.period.hardLimit
  )) {
    throw new HttpError(429, "rate_limited", "Email quota is exhausted", {
      retryAfter: 60
    });
  }
  const rollingTotal = [
    currentStates[1],
    ...states.slice(3)
  ].reduce((total, state) => {
    const counts = quotaCounts(state.document);
    return total
      + counts.reservedCount
      + counts.sentCount
      + counts.ambiguousCount;
  }, 0);
  if (rollingTotal >= periods.rollingLimit) {
    throw new HttpError(429, "rate_limited", "Email quota is exhausted", {
      retryAfter: 60 * 60
    });
  }
  const now = new Date(nowMilliseconds);
  return {
    bucketIds: currentStates.map((state) => state.period.bucketId),
    writes: [
      ...currentStates.map((state) =>
        emailQuotaWrite(context, state, { reserved: 1 }, now)
      ),
      emailQuotaWrite(context, states[3], {}, now)
    ]
  };
}

async function finalizedEmailTestQuotaWrites(context, bucketIds, outcome) {
  if (
    !Array.isArray(bucketIds)
    || bucketIds.length !== 3
    || !new Set(["sent", "failed", "ambiguous"]).has(outcome)
  ) {
    throw new HttpError(
      503,
      "email_settings_unavailable",
      "Email quota reservation is invalid"
    );
  }
  const currentPeriods = emailTestQuotaPeriods().current;
  const periodsById = new Map(
    currentPeriods.map((period) => [period.bucketId, period])
  );
  // A send may finish across a minute/hour/month boundary. Reconstruct the
  // reserved periods from their immutable bucket IDs and stored documents.
  const paths = bucketIds.map(
    (bucketId) => `publicShareEmailQuotaBuckets/${bucketId}`
  );
  const documents = await firestoreBatchGet(context, paths);
  return documents.map((document, index) => {
    if (!document) {
      throw new HttpError(
        503,
        "email_settings_unavailable",
        "Email quota reservation disappeared"
      );
    }
    if (quotaCounts(document).reservedCount === 0) {
      throw new EmailTestQuotaSnapshotConflict();
    }
    const bucketId = bucketIds[index];
    const period = periodsById.get(bucketId) ?? {
      bucketId,
      expiresAt: new Date(document.expiresAt),
      hardLimit: document.hardLimit,
      periodKey: document.periodKey,
      scope: document.scope,
      softLimit: document.softLimit
    };
    return emailQuotaWrite(context, { document, period }, {
      reserved: -1,
      [outcome]: 1
    }, new Date());
  });
}

export function emailSettingsSendingRecoveryState(
  pending,
  nowMilliseconds = Date.now()
) {
  if (pending?.testState !== "sending") {
    return "not_sending";
  }
  const bucketIds = pending.testQuotaBucketIds;
  if (
    pending.testQuotaState !== "reserved"
    || !Array.isArray(bucketIds)
    || bucketIds.length !== 3
    || !/^minute_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(bucketIds[0] ?? "")
    || !/^hour_\d{4}-\d{2}-\d{2}T\d{2}$/u.test(bucketIds[1] ?? "")
    || !/^month_\d{4}-\d{2}$/u.test(bucketIds[2] ?? "")
  ) {
    throw new HttpError(
      503,
      "email_settings_unavailable",
      "Pending SMTP test reservation is invalid"
    );
  }
  const deadline = Date.parse(pending.testExpiresAt ?? "");
  if (
    !Number.isFinite(deadline)
    || !Number.isSafeInteger(nowMilliseconds)
    || nowMilliseconds < 0
  ) {
    throw new HttpError(
      503,
      "email_settings_unavailable",
      "Pending SMTP test deadline is invalid"
    );
  }
  return deadline <= nowMilliseconds ? "expired" : "in_flight";
}

function requireMethod(request) {
  if (request.method !== "POST") {
    throw new HttpError(405, "method_not_allowed");
  }
}

function assertAdminRequestMarker(request) {
  if (headerValue(request, "x-quickmemo-admin-email-settings") !== "1") {
    throw new HttpError(403, "request_rejected", "Admin request marker is missing");
  }
}

async function authenticatedAdmin(request) {
  ensureSameOrigin(request);
  assertAdminRequestMarker(request);
  const context = await createFirestoreContext();
  const appCheck = await verifySecureShareAppCheck(request, context);
  if (appCheck.enforced === true && appCheck.valid !== true) {
    throw new HttpError(403, "request_rejected", "App Check validation failed");
  }
  const idToken = authorizationToken(request);
  if (!idToken) {
    throw new HttpError(401, "authentication_required");
  }
  // Identity Toolkit validates token authority and disabled-user state before
  // any decoded claim is trusted. activeUserFromRequest then re-reads the
  // server-owned profile and enforces active-user/admin state.
  const user = await activeUserFromRequest(request, context);
  if (user.isAdmin !== true) {
    throw new HttpError(403, "admin_required");
  }
  return { idToken, user };
}

async function settingsResponse(
  response,
  id,
  document,
  context,
  extras = {}
) {
  const status = publicEmailSettingsStatus(document);
  const runtime = await safeSecureShareEmailRuntimeSnapshot(context, {
    allowCache: false
  });
  status.enabled = runtime.ready === true;
  jsonResponse(response, 200, {
    ok: true,
    settings: status,
    ...extras,
    requestId: id
  });
}

async function currentSettings(context) {
  return firestoreGet(context, secureShareEmailSettingsPath);
}

async function replayIfIdempotent(
  response,
  id,
  user,
  action,
  idempotencyKey,
  requestHash
) {
  const prior = await priorAdminIdempotency(user.context, {
    action,
    actorUid: user.uid,
    idempotencyKey
  });
  if (!prior) {
    return false;
  }
  if (!adminIdempotencyRequestMatches(prior, {
    action,
    actorUid: user.uid,
    requestHash
  })) {
    throw new HttpError(
      409,
      "conflict",
      "Idempotency key was reused with a different request"
    );
  }
  const outcome =
    typeof prior.outcome === "string" ? prior.outcome : "conflict";
  if (outcome !== "success") {
    const errorCode = new Set([
      "attempts_exhausted",
      "conflict",
      "invalid_test_code",
      "smtp_verification_failed"
    ]).has(outcome)
      ? outcome
      : "conflict";
    const statusCode = Number.isSafeInteger(prior.httpStatus)
      && prior.httpStatus >= 400
      && prior.httpStatus <= 599
      ? prior.httpStatus
      : errorCode === "smtp_verification_failed"
        ? 503
        : errorCode === "conflict"
          ? 409
          : 400;
    throw new HttpError(statusCode, errorCode);
  }
  await settingsResponse(response, id, await currentSettings(user.context), user.context, {
    replayed: true
  });
  return true;
}

async function prepareMutation(request, response, id, user, body) {
  const idempotencyKey = assertEmailSettingsIdempotencyKey(body.idempotencyKey);
  const requestHash = adminEmailSettingsRequestHash(user.uid, body);
  if (await replayIfIdempotent(
    response,
    id,
    user,
    body.action,
    idempotencyKey,
    requestHash
  )) {
    return null;
  }
  await consumeEmailSettingsAdminRateLimit(user.context, {
    action: body.action,
    actorUid: user.uid
  });
  return { idempotencyKey, requestHash };
}

function mutationWrites(
  user,
  current,
  fields,
  {
    action,
    generation = "",
    httpStatus = 200,
    idempotencyKey,
    idempotencyOutcome = "success",
    requestHash,
    requestId: id,
    result = "success"
  }
) {
  const now = new Date();
  return [
    settingsDocumentWrite(user.context, current, {
      ...fields,
      updatedAt: now,
      updatedBy: user.uid
    }),
    adminIdempotencyWrite(user.context, {
      action,
      actorUid: user.uid,
      generation,
      httpStatus,
      idempotencyKey,
      outcome: idempotencyOutcome,
      requestHash,
      now
    }),
    adminAuditWrite(user.context, {
      action,
      actorUid: user.uid,
      generation,
      requestId: id,
      result,
      now
    })
  ];
}

async function commitMutation(user, current, writes) {
  try {
    await firestoreCommit(user.context, writes);
    invalidateSecureShareEmailRuntimeCache(user.context.projectId);
  } catch (error) {
    if (isOptimisticFirestoreConflict(error)) {
      throw new HttpError(409, "conflict");
    }
    throw error;
  }
  return currentSettings(user.context);
}

async function recoverExpiredPendingTestReservation(
  user,
  initial,
  requestIdValue
) {
  let current = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pending = current?.pending;
    const now = new Date();
    const state = emailSettingsSendingRecoveryState(
      pending,
      now.getTime()
    );
    if (state !== "expired") {
      return current;
    }
    const failure = emailSettingsTestFailureDisposition(
      { deliveryAmbiguous: true },
      now.getTime()
    );
    const quotaWrites = await finalizedEmailTestQuotaWrites(
      user.context,
      pending.testQuotaBucketIds,
      "ambiguous"
    );
    const recoveredPending = {
      ...pending,
      testState: "ambiguous",
      testCodeDigest: "",
      testRequestHash: "",
      testExpiresAt: undefined,
      testNotBefore: failure.testNotBefore,
      testQuotaBucketIds: undefined,
      testQuotaState: "finalized"
    };
    const writes = [
      settingsDocumentWrite(user.context, current, {
        enabled: current.enabled === true,
        active: current.active,
        pending: recoveredPending,
        updatedAt: now,
        updatedBy: user.uid
      }),
      adminAuditWrite(user.context, {
        action: "recover-stuck-test",
        actorUid: user.uid,
        generation: pending.generation,
        requestId: requestIdValue,
        result: "ambiguous",
        now
      }),
      ...quotaWrites
    ];
    try {
      await firestoreCommit(user.context, writes);
      invalidateSecureShareEmailRuntimeCache(user.context.projectId);
      return currentSettings(user.context);
    } catch (error) {
      if (!isOptimisticFirestoreConflict(error) || attempt === 4) {
        throw error;
      }
      current = await currentSettings(user.context);
    }
  }
  throw new HttpError(409, "conflict");
}

async function handleStatus(response, id, user) {
  await settingsResponse(
    response,
    id,
    await currentSettings(user.context),
    user.context
  );
}

function smtpVerificationErrorCode(error) {
  let reasonCode = "";
  try {
    reasonCode =
      typeof error?.providerReasonCode === "string"
        ? error.providerReasonCode
        : "";
  } catch {
    reasonCode = "";
  }
  if (reasonCode === "auth_error") {
    return "smtp_auth_failed";
  }
  if (reasonCode === "tls_error") {
    return "smtp_tls_failed";
  }
  if (new Set([
    "connection_error",
    "timeout",
    "temporary_provider_error"
  ]).has(reasonCode)) {
    return "smtp_connection_failed";
  }
  return "smtp_verification_failed";
}

async function handleStage(request, response, id, user, body) {
  assertOnlyKeys(body, [
    "action",
    "host",
    "port",
    "securityMode",
    "username",
    "appPassword",
    "replyTo",
    "idempotencyKey"
  ]);
  const prepared = await prepareMutation(
    request,
    response,
    id,
    user,
    body
  );
  if (!prepared) {
    return;
  }
  const { idempotencyKey, requestHash } = prepared;
  let current = await currentSettings(user.context);
  current = await recoverExpiredPendingTestReservation(
    user,
    current,
    id
  );
  if (current?.pending?.testState === "sending") {
    throw new HttpError(409, "conflict", "A test delivery is in progress");
  }
  const settings = normalizeGmailSettingsInput(body);
  const pending = createPendingEmailSettingsSlot(settings, {
    projectId: user.context.projectId
  });
  const decrypted = decryptEmailSettingsSlot(pending.encrypted, {
    generation: pending.generation,
    projectId: user.context.projectId,
    slot: "pending"
  });
  try {
    const adapter = createGmailSmtpEmailAdapter({
      environment: decrypted.environment
    });
    await adapter.verifyConfiguration();
  } catch (error) {
    throw new HttpError(
      422,
      smtpVerificationErrorCode(error),
      "SMTP configuration verification failed"
    );
  }
  const document = await commitMutation(
    user,
    current,
    mutationWrites(user, current, {
      enabled: current?.enabled === true,
      active: current?.active,
      pending
    }, {
      action: body.action,
      generation: pending.generation,
      idempotencyKey,
      requestHash,
      requestId: id
    })
  );
  await settingsResponse(response, id, document, user.context);
}

function pendingForGeneration(document, generation) {
  if (
    !document?.pending
    || document.pending.generation !== generation
    || !Number.isFinite(Date.parse(document.pending.expiresAt ?? ""))
    || Date.parse(document.pending.expiresAt) <= Date.now()
  ) {
    throw new HttpError(409, "conflict", "Pending settings generation changed");
  }
  return document.pending;
}

async function finalizeTestState(
  user,
  generation,
  requestHash,
  fields,
  id,
  result,
  idempotencyKey,
  quotaOutcome,
  idempotencyOutcome = "success",
  httpStatus = 200
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await currentSettings(user.context);
    const pending = pendingForGeneration(current, generation);
    if (pending.testRequestHash !== requestHash) {
      throw new HttpError(409, "conflict");
    }
    if (
      pending.testQuotaState === "finalized"
      && !Array.isArray(pending.testQuotaBucketIds)
    ) {
      return current;
    }
    const updatedPending = {
      ...pending,
      ...fields,
      testQuotaBucketIds: undefined,
      testQuotaState: "finalized"
    };
    const idempotency = await priorAdminIdempotency(user.context, {
      action: "send-test",
      actorUid: user.uid,
      idempotencyKey
    });
    let quotaWrites;
    try {
      quotaWrites = await finalizedEmailTestQuotaWrites(
        user.context,
        pending.testQuotaBucketIds,
        quotaOutcome
      );
    } catch (error) {
      if (!(error instanceof EmailTestQuotaSnapshotConflict)) {
        throw error;
      }
      const latest = await currentSettings(user.context);
      if (
        typeof current?.__updateTime !== "string"
        || latest?.__updateTime === current.__updateTime
      ) {
        throw new HttpError(
          503,
          "email_settings_unavailable",
          "Email quota accounting underflow"
        );
      }
      continue;
    }
    const writes = [
      settingsDocumentWrite(user.context, current, {
        enabled: current.enabled === true,
        active: current.active,
        pending: updatedPending,
        updatedAt: new Date(),
        updatedBy: user.uid
      }),
      adminAuditWrite(user.context, {
        action: "send-test",
        actorUid: user.uid,
        generation,
        requestId: id,
        result
      }),
      adminIdempotencyOutcomeWrite(
        user.context,
        idempotency,
        idempotencyOutcome,
        httpStatus
      ),
      ...quotaWrites
    ];
    try {
      await firestoreCommit(user.context, writes);
      return currentSettings(user.context);
    } catch (error) {
      if (!isOptimisticFirestoreConflict(error) || attempt === 4) {
        throw error;
      }
    }
  }
  throw new HttpError(409, "conflict");
}

async function handleSendTest(request, response, id, user, body) {
  assertOnlyKeys(body, ["action", "generation", "idempotencyKey"]);
  const generation = assertEmailSettingsGeneration(body.generation);
  const prepared = await prepareMutation(
    request,
    response,
    id,
    user,
    body
  );
  if (!prepared) {
    return;
  }
  const {
    idempotencyKey,
    requestHash: idempotencyRequestHash
  } = prepared;
  const current = await currentSettings(user.context);
  const pending = pendingForGeneration(current, generation);
  const testSendCount = assertEmailSettingsTestSendAvailable(pending);
  const decrypted = decryptEmailSettingsSlot(pending.encrypted, {
    generation,
    projectId: user.context.projectId,
    slot: "pending"
  });
  const code = generateOtpCode();
  const codeDigest = emailTestCodeDigest(generation, code);
  const deliveryRequestHash =
    testRequestHash(user.uid, generation, idempotencyKey);
  const testWindow = nextTestWindow();
  const quotaReservation = await reserveEmailTestQuota(user.context);
  const reservedPending = {
    ...pending,
    testState: "sending",
    testCodeDigest: codeDigest,
    testRequestHash: deliveryRequestHash,
    testSendCount: testSendCount + 1,
    testAttempts: 0,
    testSentAt: testWindow.sentAt,
    testExpiresAt: testWindow.expiresAt,
    testQuotaBucketIds: quotaReservation.bucketIds,
    testQuotaState: "reserved"
  };
  const reservation = mutationWrites(user, current, {
    enabled: current.enabled === true,
    active: current.active,
    pending: reservedPending
  }, {
    action: body.action,
    generation,
    idempotencyKey,
    requestHash: idempotencyRequestHash,
    requestId: id,
    result: "reserved",
    idempotencyOutcome: "conflict",
    httpStatus: 409
  });
  reservation.push(...quotaReservation.writes);
  await commitMutation(user, current, reservation);

  try {
    const adapter = createGmailSmtpEmailAdapter({
      environment: decrypted.environment
    });
    await adapter.send({
      text:
        "QuickMemo Secure Share SMTP 설정 확인 코드입니다.\n\n"
        + `확인 코드: ${code}\n`
        + "이 코드는 10분 후 만료됩니다.",
      timeoutMilliseconds: 10_000,
      to: decrypted.configuration.username
    });
  } catch (error) {
    const failure = emailSettingsTestFailureDisposition(error);
    await finalizeTestState(
      user,
      generation,
      deliveryRequestHash,
      {
        testState: failure.state,
        testCodeDigest: "",
        testExpiresAt: undefined,
        testNotBefore: failure.testNotBefore
      },
      id,
      failure.state,
      idempotencyKey,
      failure.quotaOutcome,
      "smtp_verification_failed",
      503
    );
    throw new HttpError(
      503,
      "smtp_verification_failed",
      "SMTP test delivery failed"
    );
  }
  const document = await finalizeTestState(
    user,
    generation,
    deliveryRequestHash,
    { testState: "sent" },
    id,
    "sent",
    idempotencyKey,
    "sent"
  );
  await settingsResponse(response, id, document, user.context, {
    test: {
      sent: true,
      expiresAt: testWindow.expiresAt.toISOString()
    }
  });
}

async function recordInvalidTestCode(
  user,
  current,
  pending,
  generation,
  body,
  idempotencyKey,
  requestHash,
  id
) {
  const attempts = Math.min(
    (Number.isSafeInteger(pending.testAttempts)
      ? pending.testAttempts
      : 0) + 1,
    emailSettingsTestMaximumAttempts
  );
  const exhausted = attempts >= emailSettingsTestMaximumAttempts;
  const updatedPending = {
    ...pending,
    testAttempts: attempts,
    testState: exhausted ? "locked" : "sent",
    testCodeDigest: exhausted ? "" : pending.testCodeDigest
  };
  await commitMutation(
    user,
    current,
    mutationWrites(user, current, {
      enabled: current.enabled === true,
      active: current.active,
      pending: updatedPending
    }, {
      action: body.action,
      generation,
      idempotencyKey,
      requestHash,
      idempotencyOutcome: exhausted
        ? "attempts_exhausted"
        : "invalid_test_code",
      httpStatus: 400,
      requestId: id,
      result: exhausted ? "attempts_exhausted" : "invalid_code"
    })
  );
  throw new HttpError(
    400,
    exhausted ? "attempts_exhausted" : "invalid_test_code"
  );
}

async function handleConfirmTest(request, response, id, user, body) {
  assertOnlyKeys(body, [
    "action",
    "generation",
    "code",
    "idempotencyKey"
  ]);
  const generation = assertEmailSettingsGeneration(body.generation);
  if (typeof body.code !== "string" || !/^[0-9]{6}$/u.test(body.code)) {
    throw new HttpError(400, "invalid_request");
  }
  const prepared = await prepareMutation(
    request,
    response,
    id,
    user,
    body
  );
  if (!prepared) {
    return;
  }
  const { idempotencyKey, requestHash } = prepared;
  const current = await currentSettings(user.context);
  const pending = pendingForGeneration(current, generation);
  if (pending.testState !== "sent" || !pending.testCodeDigest) {
    throw new HttpError(
      409,
      pending.testState === "locked" ? "attempts_exhausted" : "test_required"
    );
  }
  const expiresAt = Date.parse(pending.testExpiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new HttpError(400, "test_expired");
  }
  if (
    !emailTestCodeMatches(
      generation,
      body.code,
      pending.testCodeDigest
    )
  ) {
    await recordInvalidTestCode(
      user,
      current,
      pending,
      generation,
      body,
      idempotencyKey,
      requestHash,
      id
    );
  }
  const active = activeSlotForProject(pending, {
    projectId: user.context.projectId
  });
  const health = await firestoreGet(
    user.context,
    secureShareEmailProviderHealthPath
  );
  const writes = mutationWrites(user, current, {
    enabled: true,
    active,
    pending: undefined
  }, {
    action: body.action,
    generation,
    idempotencyKey,
    requestHash,
    requestId: id
  });
  writes.push(providerHealthWrite(
    user.context,
    health,
    generation
  ));
  const document = await commitMutation(user, current, writes);
  await settingsResponse(
    response,
    id,
    document,
    user.context,
    { activated: true }
  );
}

async function handleDisable(request, response, id, user, body) {
  assertOnlyKeys(body, ["action", "idempotencyKey"]);
  const prepared = await prepareMutation(
    request,
    response,
    id,
    user,
    body
  );
  if (!prepared) {
    return;
  }
  const { idempotencyKey, requestHash } = prepared;
  const current = await currentSettings(user.context);
  const document = await commitMutation(
    user,
    current,
    mutationWrites(user, current, {
      enabled: false,
      active: current?.active,
      pending: current?.pending
    }, {
      action: body.action,
      generation: current?.active?.generation ?? "",
      idempotencyKey,
      requestHash,
      requestId: id
    })
  );
  await settingsResponse(response, id, document, user.context);
}

async function handleDiscardPending(request, response, id, user, body) {
  assertOnlyKeys(body, ["action", "generation", "idempotencyKey"]);
  const generation = assertEmailSettingsGeneration(body.generation);
  const prepared = await prepareMutation(
    request,
    response,
    id,
    user,
    body
  );
  if (!prepared) {
    return;
  }
  const { idempotencyKey, requestHash } = prepared;
  let current = await currentSettings(user.context);
  current = await recoverExpiredPendingTestReservation(
    user,
    current,
    id
  );
  const pending = pendingForGeneration(current, generation);
  if (pending.testState === "sending") {
    throw new HttpError(409, "conflict", "A test delivery is in progress");
  }
  const document = await commitMutation(
    user,
    current,
    mutationWrites(user, current, {
      enabled: current.enabled === true,
      active: current.active,
      pending: undefined
    }, {
      action: body.action,
      generation,
      idempotencyKey,
      requestHash,
      requestId: id
    })
  );
  await settingsResponse(response, id, document, user.context);
}

function generationMatchesRemoval(current, target, generation) {
  if (!generation) {
    return;
  }
  const matches =
    (target !== "pending" && current?.active?.generation === generation)
    || (target !== "active" && current?.pending?.generation === generation);
  if (!matches) {
    throw new HttpError(409, "conflict");
  }
}

async function handleRemove(request, response, id, user, body) {
  assertOnlyKeys(body, [
    "action",
    "target",
    "generation",
    "idempotencyKey"
  ]);
  if (!validRemoveTargets.has(body.target)) {
    throw new HttpError(400, "invalid_request");
  }
  const generation = body.generation === undefined
    ? ""
    : assertEmailSettingsGeneration(body.generation);
  const prepared = await prepareMutation(
    request,
    response,
    id,
    user,
    body
  );
  if (!prepared) {
    return;
  }
  const { idempotencyKey, requestHash } = prepared;
  const removesActive = body.target === "active" || body.target === "all";
  const removesPending = body.target === "pending" || body.target === "all";
  let current = await currentSettings(user.context);
  if (removesPending) {
    current = await recoverExpiredPendingTestReservation(
      user,
      current,
      id
    );
  }
  generationMatchesRemoval(current, body.target, generation);
  if (removesPending && current?.pending?.testState === "sending") {
    throw new HttpError(409, "conflict", "A test delivery is in progress");
  }
  const health = removesActive
    ? await firestoreGet(user.context, secureShareEmailProviderHealthPath)
    : null;
  const writes = mutationWrites(user, current, {
    enabled: removesActive ? false : current?.enabled === true,
    active: removesActive ? undefined : current?.active,
    pending: removesPending ? undefined : current?.pending
  }, {
    action: body.action,
    generation,
    idempotencyKey,
    requestHash,
    requestId: id
  });
  const healthDelete = removeProviderHealthWrite(user.context, health);
  if (healthDelete) {
    writes.push(healthDelete);
  }
  const document = await commitMutation(user, current, writes);
  await settingsResponse(response, id, document, user.context);
}

async function dispatch(request, response, id) {
  requireMethod(request);
  const body = await readJsonBody(request, maximumBodyBytes);
  if (
    typeof body.action !== "string"
    || !validActions.has(body.action)
  ) {
    throw new HttpError(400, "invalid_request");
  }
  if (!mutatingActions.has(body.action)) {
    assertOnlyKeys(body, ["action"]);
  }
  const { idToken, user } = await authenticatedAdmin(request);
  if (
    mutatingActions.has(body.action)
    && !idTokenHasRecentAdminAuthentication(
      idToken,
      user.uid,
      user.context.projectId
    )
  ) {
    throw new HttpError(401, "recent_auth_required");
  }
  if (body.action === "status") {
    await handleStatus(response, id, user);
  } else if (body.action === "stage") {
    await handleStage(request, response, id, user, body);
  } else if (body.action === "send-test") {
    await handleSendTest(request, response, id, user, body);
  } else if (body.action === "confirm-test") {
    await handleConfirmTest(request, response, id, user, body);
  } else if (body.action === "disable") {
    await handleDisable(request, response, id, user, body);
  } else if (body.action === "discard-pending") {
    await handleDiscardPending(request, response, id, user, body);
  } else if (body.action === "remove") {
    await handleRemove(request, response, id, user, body);
  }
}

export default async function handler(request, response) {
  const id = requestId();
  applySecureResponseHeaders(response, id);
  try {
    await dispatch(request, response, id);
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode >= 500) {
      // Safe summaries contain only bounded status metadata.
      console.error("admin email settings request failed", {
        requestId: id,
        error: safeErrorSummary(error)
      });
    }
    handleApiError(error, response, id);
  }
}
