/* global console */

import {
  HttpError,
  activeManagementContext,
  assertOnlyKeys,
  authenticateActiveUser,
  buildGoogleAuthorizationUrl,
  buildPkcePair,
  callbackQuery,
  consumeOAuthState,
  createOAuthState,
  ensureGoogleRedirectOrigin,
  ensureSameOrigin,
  exchangeAuthorizationCode,
  fetchFirebaseManagementAccessToken,
  fetchGoogleAccount,
  firebaseManagementCredentials,
  googleCalendarCallbackHtml,
  googleCalendarConfig,
  googleCalendarResultRedirect,
  htmlResponse,
  jsonResponse,
  isValidTimeZone,
  oauthSessionCookie,
  oauthSessionCookiePresent,
  oauthSessionMatches,
  pkceChallengeForVerifier,
  readJsonBody,
  safeErrorSummary,
  saveGoogleConnection
} from "./_google-calendar-common.js";

async function startGoogleAuthorization(request, response) {
  ensureSameOrigin(request);
  const body = await readJsonBody(request, 256);
  assertOnlyKeys(body, ["action", "browserTimeZone"]);
  if (body.action !== "start") {
    throw new HttpError(400, "invalid_request");
  }
  const browserTimeZone = body.browserTimeZone ?? "UTC";
  if (!isValidTimeZone(browserTimeZone)) {
    throw new HttpError(400, "invalid_time_zone");
  }

  const context = await authenticateActiveUser(request);
  const config = googleCalendarConfig(request);
  ensureGoogleRedirectOrigin(request, config.redirectUri);
  const { verifier, challenge } = await buildPkcePair();
  const { state, sessionBinding, connectionAttemptId } = await createOAuthState(
    context,
    verifier,
    challenge,
    config.redirectUri,
    browserTimeZone
  );
  response.setHeader("set-cookie", oauthSessionCookie(request, state, sessionBinding));
  jsonResponse(response, 200, {
    ok: true,
    authorizationUrl: buildGoogleAuthorizationUrl(config, state, challenge),
    connectionAttemptId
  });
}

async function finishGoogleAuthorization(request, response) {
  if (typeof request.url !== "string" || request.url.length > 8192) {
    googleCalendarResultRedirect(response, "failed");
    return;
  }

  const query = callbackQuery(request);
  if (query.result) {
    const validResult = new Set(["success", "cancelled", "failed"]).has(query.result)
      && !query.code
      && !query.state
      && !query.error;
    htmlResponse(
      response,
      validResult ? 200 : 400,
      googleCalendarCallbackHtml(validResult ? query.result : "failed")
    );
    return;
  }

  if (!query.state || query.state.length > 128 || query.error.length > 100) {
    googleCalendarResultRedirect(response, "failed");
    return;
  }
  if (!oauthSessionCookiePresent(request, query.state)) {
    googleCalendarResultRedirect(response, "failed");
    return;
  }

  const credentials = firebaseManagementCredentials();
  const accessToken = await fetchFirebaseManagementAccessToken(credentials);
  const state = await consumeOAuthState(
    credentials.projectId,
    accessToken,
    query.state,
    (candidate) => oauthSessionMatches(request, query.state, candidate.sessionBindingHash)
  );
  if (!state) {
    googleCalendarResultRedirect(response, "failed");
    return;
  }

  // Every authorization attempt has its own cookie name. Clearing this
  // consumed attempt cannot overwrite or delete a newer popup's binding.
  response.setHeader("set-cookie", oauthSessionCookie(request, query.state, "", true));

  if (query.error) {
    const kind = query.error === "access_denied" ? "cancelled" : "failed";
    googleCalendarResultRedirect(response, kind);
    return;
  }

  const config = googleCalendarConfig(request);
  if (state.redirectUri !== config.redirectUri
    || await pkceChallengeForVerifier(state.codeVerifier) !== state.codeChallenge
    || !query.code
    || query.code.length > 4096) {
    googleCalendarResultRedirect(response, "failed");
    return;
  }

  await activeManagementContext(state.ownerUid, credentials, accessToken);
  const token = await exchangeAuthorizationCode(config, query.code, state.codeVerifier);
  if (typeof token?.access_token !== "string" || !token.access_token || token.access_token.length > 4096) {
    throw new Error("Google authorization response was incomplete");
  }
  const account = await fetchGoogleAccount(token.access_token);
  if (account.email_verified !== true) {
    throw new HttpError(400, "google_account_unverified");
  }
  const refreshedContext = await activeManagementContext(state.ownerUid, credentials, accessToken);
  await saveGoogleConnection(
    refreshedContext,
    token,
    account,
    state.browserTimeZone,
    state.connectionAttemptId,
    state.connectionEpoch
  );
  googleCalendarResultRedirect(response, "success");
}

export default async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "GET") {
    response.setHeader("allow", "GET, POST");
    jsonResponse(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    if (request.method === "POST") {
      await startGoogleAuthorization(request, response);
      return;
    }
    await finishGoogleAuthorization(request, response);
  } catch (error) {
    if (request.method === "GET") {
      console.error("google calendar callback failed", safeErrorSummary(error));
      googleCalendarResultRedirect(response, "failed");
      return;
    }

    if (error instanceof HttpError) {
      jsonResponse(response, error.statusCode, { ok: false, error: error.errorCode });
      return;
    }
    console.error("google calendar authorization failed", safeErrorSummary(error));
    jsonResponse(response, 502, { ok: false, error: "google_calendar_unavailable" });
  }
}
