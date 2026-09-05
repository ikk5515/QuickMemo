import {
  HttpError, activeUserFromRequest, applySecureResponseHeaders, assertOnlyKeys,
  createDocumentWrite, createFirestoreContext, ensureSameOrigin, firestoreCommit,
  firestoreGet, handleApiError, headerValue, jsonResponse, readJsonBody, requestId, sha256Digest,
  updateDocumentWrite, verifySecureShareAppCheck
} from "./_secure-share-common.js";

const defaults = Object.freeze({ memo: { width: 244, collapsed: false }, wiki: { width: 280, collapsed: false } });
function sidebar(value) {
  assertOnlyKeys(value, ["width", "collapsed"]);
  if (!Number.isInteger(value.width) || value.width < 180 || value.width > 520 || typeof value.collapsed !== "boolean") {
    throw new HttpError(400, "invalid_preferences");
  }
  return { width: value.width, collapsed: value.collapsed };
}
function projection(value) {
  const read = (kind) => { try { return sidebar(value?.[kind]); } catch { return { ...defaults[kind] }; } };
  return { memo: read("memo"), wiki: read("wiki") };
}
function conflict(error) {
  return error?.statusCode === 409 || (error?.statusCode === 400 && error?.upstreamCode === "FAILED_PRECONDITION");
}

/** UI dimensions only. The authenticated UID is the sole document selector. */
export async function workspacePreferenceAction(context, uid, body) {
  const path = `workspaceUiPreferences/${sha256Digest(uid)}`;
  if (body.action === "get") {
    assertOnlyKeys(body, ["action"]);
    const current = await firestoreGet(context, path);
    if (current && current.ownerUid !== uid) throw new HttpError(403, "permission_denied");
    return projection(current);
  }
  assertOnlyKeys(body, ["action", "kind", "value"]);
  if (body.action !== "set" || !["memo", "wiki"].includes(body.kind)) throw new HttpError(400, "invalid_action");
  const value = sidebar(body.value);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await firestoreGet(context, path);
    if (current && current.ownerUid !== uid) throw new HttpError(403, "permission_denied");
    const next = { ...projection(current), [body.kind]: value };
    if (current && JSON.stringify(next) === JSON.stringify(projection(current))) return next;
    const window = Math.floor(Date.now() / 60_000);
    const count = current?.rateWindow === window ? current.rateCount : 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new HttpError(503, "service_unavailable");
    if (count >= 60) throw new HttpError(429, "rate_limited", "Preference write limit exceeded", { retryAfter: 60 });
    const stored = { ...next, ownerUid: uid, updatedAt: new Date(), rateWindow: window, rateCount: count + 1 };
    try {
      await firestoreCommit(context, [current
        ? updateDocumentWrite(context.projectId, path, stored, Object.keys(stored), current.__updateTime)
        : createDocumentWrite(context.projectId, path, stored)]);
      return next;
    } catch (error) { if (attempt === 3 || !conflict(error)) throw error; }
  }
  throw new HttpError(409, "preferences_changed");
}

export default async function handler(request, response) {
  const id = requestId();
  applySecureResponseHeaders(response, id);
  try {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    ensureSameOrigin(request);
    if (headerValue(request, "x-quickmemo-workspace-preferences") !== "1") throw new HttpError(403, "request_rejected");
    const context = await createFirestoreContext();
    const check = await verifySecureShareAppCheck(request, context);
    if (check.enforced && !check.valid) throw new HttpError(403, "request_rejected");
    const user = await activeUserFromRequest(request, context);
    const body = await readJsonBody(request, 2048);
    jsonResponse(response, 200, await workspacePreferenceAction(context, user.uid, body));
  } catch (error) { handleApiError(error, response, id); }
}

export const __workspacePreferencesTesting = { sidebar, projection };
