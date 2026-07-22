/* global console */

import {
  HttpError,
  activeManagementContext,
  assertOnlyKeys,
  authenticateActiveUser,
  beginGoogleCalendarDeletionWorkflow,
  beginGoogleCalendarOperation,
  beginGoogleCalendarTaskOperation,
  disconnectGoogleCalendar,
  endGoogleCalendarDeletionWorkflow,
  endGoogleCalendarOperation,
  ensureSameOrigin,
  finishGoogleCalendarTaskOperation,
  getGoogleConnection,
  getGoogleCalendarTaskAuthority,
  googleCalendarConfig,
  isGoogleCalendarConfigured,
  jsonResponse,
  publicConnectionStatus,
  readJsonBody,
  refreshGoogleAccessToken,
  renewGoogleCalendarDeletionWorkflow,
  requireGoogleCalendarOperation,
  safeErrorSummary,
  saveSyncReport,
  validateSyncReport
} from "./_google-calendar-common.js";

async function statusResponse(request, response, context) {
  const configured = isGoogleCalendarConfigured(request);
  const connection = await getGoogleConnection(context);
  jsonResponse(response, 200, {
    ok: true,
    serverTime: new Date().toISOString(),
    ...publicConnectionStatus(connection, configured)
  });
}

async function handlePost(request, response) {
  ensureSameOrigin(request);
  const body = await readJsonBody(request);
  if (typeof body.action !== "string" || body.action.length > 32) {
    throw new HttpError(400, "invalid_request");
  }
  const context = await authenticateActiveUser(request);

  if (body.action === "status") {
    assertOnlyKeys(body, ["action"]);
    await statusResponse(request, response, context);
    return;
  }

  if (body.action === "access-token") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "operationLeaseId"]);
    const config = googleCalendarConfig(request);
    const connection = await requireGoogleCalendarOperation(
      context,
      body.connectionGeneration,
      body.operationLeaseId
    );
    const access = await refreshGoogleAccessToken(config, context, connection);
    await activeManagementContext(context.uid, context.credentials, context.accessToken);
    jsonResponse(response, 200, { ok: true, ...access });
    return;
  }

  if (body.action === "validate-generation") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "operationLeaseId"]);
    await requireGoogleCalendarOperation(context, body.connectionGeneration, body.operationLeaseId);
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (body.action === "begin-operation") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "deletionWorkflowLeaseId"]);
    const operation = await beginGoogleCalendarOperation(
      context,
      body.connectionGeneration,
      body.deletionWorkflowLeaseId ?? null
    );
    jsonResponse(response, 200, { ok: true, ...operation });
    return;
  }

  if (body.action === "begin-task-operation") {
    assertOnlyKeys(body, [
      "action",
      "taskId",
      "revision",
      "connectionGeneration",
      "deletionWorkflowLeaseId"
    ]);
    const operation = await beginGoogleCalendarTaskOperation(
      context,
      body.connectionGeneration,
      body.taskId,
      body.revision,
      body.deletionWorkflowLeaseId ?? null
    );
    jsonResponse(response, 200, { ok: true, ...operation });
    return;
  }

  if (body.action === "begin-deletion-workflow") {
    assertOnlyKeys(body, ["action", "connectionGeneration"]);
    const workflow = await beginGoogleCalendarDeletionWorkflow(context, body.connectionGeneration);
    jsonResponse(response, 200, { ok: true, ...workflow });
    return;
  }

  if (body.action === "end-operation") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "operationLeaseId"]);
    await endGoogleCalendarOperation(context, body.connectionGeneration, body.operationLeaseId);
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (body.action === "finish-task-operation") {
    assertOnlyKeys(body, [
      "action",
      "taskId",
      "revision",
      "connectionGeneration",
      "operationLeaseId"
    ]);
    const state = await finishGoogleCalendarTaskOperation(
      context,
      body.connectionGeneration,
      body.operationLeaseId,
      body.taskId,
      body.revision
    );
    jsonResponse(response, 200, { ok: true, state });
    return;
  }

  if (body.action === "end-deletion-workflow") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "workflowLeaseId"]);
    await endGoogleCalendarDeletionWorkflow(
      context,
      body.connectionGeneration,
      body.workflowLeaseId
    );
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (body.action === "renew-deletion-workflow") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "workflowLeaseId"]);
    const workflow = await renewGoogleCalendarDeletionWorkflow(
      context,
      body.connectionGeneration,
      body.workflowLeaseId
    );
    jsonResponse(response, 200, { ok: true, ...workflow });
    return;
  }

  if (body.action === "task-authority") {
    assertOnlyKeys(body, ["action", "taskId", "revision"]);
    const state = await getGoogleCalendarTaskAuthority(context, body.taskId, body.revision);
    jsonResponse(response, 200, { ok: true, state });
    return;
  }

  if (body.action === "report") {
    const report = validateSyncReport(body);
    await saveSyncReport(context, report);
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (body.action === "disconnect") {
    assertOnlyKeys(body, ["action", "connectionGeneration", "connectionIdentity"]);
    if (body.connectionGeneration !== null
      && (typeof body.connectionGeneration !== "string"
        || !/^[A-Za-z0-9_-]{43}$/u.test(body.connectionGeneration))) {
      throw new HttpError(400, "invalid_request");
    }
    if (typeof body.connectionIdentity !== "string"
      || !/^[A-Za-z0-9_-]{43}$/u.test(body.connectionIdentity)) {
      throw new HttpError(400, "invalid_request");
    }
    const connection = await getGoogleConnection(context);
    await disconnectGoogleCalendar(
      context,
      connection,
      body.connectionGeneration,
      body.connectionIdentity
    );
    jsonResponse(response, 200, { ok: true });
    return;
  }

  throw new HttpError(400, "invalid_request");
}

export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    jsonResponse(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    if (request.method === "GET") {
      const context = await authenticateActiveUser(request);
      await statusResponse(request, response, context);
      return;
    }
    await handlePost(request, response);
  } catch (error) {
    if (error instanceof HttpError) {
      jsonResponse(response, error.statusCode, { ok: false, error: error.errorCode });
      return;
    }
    console.error("google calendar connection failed", safeErrorSummary(error));
    jsonResponse(response, 502, { ok: false, error: "google_calendar_unavailable" });
  }
}
