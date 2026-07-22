import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface EncryptedRefreshToken {
  version: number;
  keyVersion: number;
  algorithm: string;
  iv: string;
  cipherText: string;
}

interface BackendContext {
  accessToken: string;
  credentials: { projectId: string };
  uid: string;
}

interface FirestoreDocument {
  fields: Record<string, unknown>;
  name: string;
  updateTime: string;
}

interface BackendModule {
  beginGoogleCalendarTaskOperation(
    context: BackendContext,
    expectedGeneration: string,
    taskId: string,
    expectedRevision: string | null,
    deletionWorkflowLeaseId?: string | null
  ): Promise<{
    connectionGeneration: string;
    leaseId: string | null;
    state: "current" | "deleted" | "stale" | "undated";
  }>;
  beginGoogleCalendarDeletionWorkflow(
    context: BackendContext,
    expectedGeneration: string
  ): Promise<{ connectionGeneration: string; leaseId: string }>;
  beginGoogleCalendarOperation(
    context: BackendContext,
    expectedGeneration: string,
    deletionWorkflowLeaseId?: string | null
  ): Promise<{ connectionGeneration: string; leaseId: string }>;
  buildGoogleAuthorizationUrl(config: Record<string, string>, state: string, challenge: string): string;
  buildPkcePair(): Promise<{ verifier: string; challenge: string }>;
  createOAuthState(
    context: BackendContext,
    codeVerifier: string,
    codeChallenge: string,
    redirectUri: string,
    browserTimeZone: string
  ): Promise<{ state: string; sessionBinding: string; connectionAttemptId: string }>;
  decryptRefreshToken(payload: EncryptedRefreshToken, uid: string): Promise<string>;
  disconnectGoogleCalendar(
    context: BackendContext,
    document: FirestoreDocument | null,
    expectedGeneration?: string | null,
    expectedIdentity?: string | null
  ): Promise<void>;
  endGoogleCalendarDeletionWorkflow(
    context: BackendContext,
    expectedGeneration: string,
    leaseId: string
  ): Promise<void>;
  endGoogleCalendarOperation(
    context: BackendContext,
    expectedGeneration: string,
    leaseId: string
  ): Promise<boolean>;
  encryptRefreshToken(token: string, uid: string): Promise<EncryptedRefreshToken>;
  fetchFirebaseManagementAccessToken(credentials: {
    clientEmail: string;
    privateKey: string;
    projectId: string;
  }): Promise<string>;
  ensureGoogleRedirectOrigin(request: { headers: Record<string, string> }, redirectUri: string): void;
  ensureSameOrigin(request: { headers: Record<string, string> }): void;
  fetchGoogleAccount(accessToken: string): Promise<{ sub: string }>;
  finishGoogleCalendarTaskOperation(
    context: BackendContext,
    expectedGeneration: string,
    leaseId: string,
    taskId: string,
    expectedRevision: string | null
  ): Promise<"current" | "deleted" | "stale" | "undated">;
  googleCalendarCallbackHtml(kind: string): string;
  htmlResponse(response: {
    statusCode?: number;
    setHeader(name: string, value: string): void;
    end(value?: string): void;
  }, statusCode: number, html: string): void;
  googleCalendarResultRedirect(response: {
    statusCode?: number;
    setHeader(name: string, value: string): void;
    end(): void;
  }, kind: string): void;
  googleCalendarScope: string;
  googleCalendarStateTtlMs: number;
  googleRedirectUri(request: { headers: Record<string, string> }): string;
  getGoogleCalendarTaskAuthority(
    context: BackendContext,
    taskId: string,
    expectedRevision: string | null
  ): Promise<"current" | "deleted" | "stale" | "undated">;
  isValidTimeZone(value: unknown): boolean;
  maskGoogleEmail(email: unknown): string;
  oauthSessionCookie(
    request: { headers: Record<string, string> },
    state: string,
    binding: string,
    clear?: boolean
  ): string;
  oauthSessionCookiePresent(
    request: { headers: Record<string, string> },
    state: string
  ): boolean;
  oauthSessionMatches(
    request: { headers: Record<string, string> },
    state: string,
    expectedHash: string
  ): boolean;
  tokenHasCalendarScope(token: { scope?: string }): boolean;
  publicConnectionStatus(document: unknown, configured?: boolean): {
    connected: boolean;
    connectionGeneration: string | null;
    connectionIdentity: string | null;
    hasStoredConnection: boolean;
    lastSyncStatus: string;
    needsReconnect: boolean;
  };
  renewGoogleCalendarDeletionWorkflow(
    context: BackendContext,
    expectedGeneration: string,
    leaseId: string
  ): Promise<{ connectionGeneration: string; leaseId: string }>;
  refreshGoogleAccessToken(
    config: { clientId: string; clientSecret: string },
    context: BackendContext,
    document: FirestoreDocument
  ): Promise<{ accessToken: string; connectionGeneration: string; expiresAt: string }>;
  requireGoogleCalendarOperation(
    context: BackendContext,
    expectedGeneration: string,
    leaseId: string
  ): Promise<FirestoreDocument>;
  saveGoogleConnection(
    context: BackendContext,
    token: { refresh_token: string; scope: string },
    account: { email: string; sub: string },
    browserTimeZone: string,
    connectionAttemptId: string,
    connectionEpoch: string
  ): Promise<void>;
  saveSyncReport(
    context: BackendContext,
    report: { connectionGeneration: string; failureCode: string; reportSequence?: number; status: string; syncedCount: number }
  ): Promise<void>;
  validateSyncReport(body: Record<string, unknown>): {
    connectionGeneration: string;
    status: string;
    syncedCount: number;
    failureCode: string;
  };
}

const commonSource = readFileSync(join(process.cwd(), "api/_google-calendar-common.js"), "utf8");
const authSource = readFileSync(join(process.cwd(), "api/google-calendar-auth.js"), "utf8");
const connectionSource = readFileSync(join(process.cwd(), "api/google-calendar-connection.js"), "utf8");
const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
let backend: BackendModule;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), "api/_google-calendar-common.js")).href;
  backend = await import(moduleUrl) as BackendModule;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configureEncryption() {
  vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "quickmemo-test.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
}

const backendContext: BackendContext = {
  accessToken: "firebase-management-token",
  credentials: { projectId: "quickmemo-test" },
  uid: "user-a"
};
const generationA = "a".repeat(43);
const generationB = "b".repeat(43);

function googleConnectionDocument(
  connectionGeneration: string,
  encryptedRefreshToken?: EncryptedRefreshToken,
  updateTime = "2026-07-22T00:00:00.000000Z"
): FirestoreDocument {
  return {
    name: `projects/${backendContext.credentials.projectId}/databases/(default)/documents/googleCalendarConnections/${backendContext.uid}`,
    updateTime,
    fields: {
      ownerUid: { stringValue: backendContext.uid },
      connectionStatus: { stringValue: "connected" },
      connectionGeneration: { stringValue: connectionGeneration },
      lastReportSequence: { integerValue: "0" },
      grantedScopes: {
        arrayValue: { values: [{ stringValue: backend.googleCalendarScope }] }
      },
      ...(encryptedRefreshToken ? {
        encryptedRefreshToken: {
          mapValue: {
            fields: {
              version: { integerValue: String(encryptedRefreshToken.version) },
              keyVersion: { integerValue: String(encryptedRefreshToken.keyVersion) },
              algorithm: { stringValue: encryptedRefreshToken.algorithm },
              iv: { stringValue: encryptedRefreshToken.iv },
              cipherText: { stringValue: encryptedRefreshToken.cipherText }
            }
          }
        }
      } : {})
    }
  };
}

function leasedGoogleConnectionDocument(
  connectionGeneration = generationA,
  leaseId = "l".repeat(43),
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
): FirestoreDocument {
  const document = googleConnectionDocument(connectionGeneration);

  document.fields.operationLeaseId = { stringValue: leaseId };
  document.fields.operationLeaseGeneration = { stringValue: connectionGeneration };
  document.fields.operationLeaseExpiresAt = { timestampValue: leaseExpiresAt };
  return document;
}

function deletionWorkflowGoogleConnectionDocument(
  connectionGeneration = generationA,
  leaseId = "w".repeat(43),
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
): FirestoreDocument {
  const document = googleConnectionDocument(connectionGeneration);

  document.fields.deletionWorkflowLeaseId = { stringValue: leaseId };
  document.fields.deletionWorkflowLeaseGeneration = { stringValue: connectionGeneration };
  document.fields.deletionWorkflowLeaseExpiresAt = { timestampValue: leaseExpiresAt };
  return document;
}

function backendJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Google Calendar backend security", () => {
  it("generates a standards-compliant PKCE S256 verifier and challenge", async () => {
    const first = await backend.buildPkcePair();
    const second = await backend.buildPkcePair();
    const expected = createHash("sha256").update(first.verifier).digest("base64url");

    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.challenge).toBe(expected);
    expect(second.verifier).not.toBe(first.verifier);
  });

  it("builds a server-owned authorization request with only the minimum Calendar scope", () => {
    const authorizationUrl = new URL(backend.buildGoogleAuthorizationUrl({
      clientId: "client-id",
      clientSecret: "must-not-appear",
      redirectUri: "https://quickmemo.example/api/google-calendar-auth"
    }, "state-value", "challenge-value"));

    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://quickmemo.example/api/google-calendar-auth");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      backend.googleCalendarScope
    ]);
    expect(authorizationUrl.toString()).not.toContain("must-not-appear");
    expect(authorizationUrl.searchParams.has("code_verifier")).toBe(false);
  });

  it("encrypts refresh tokens with a fresh AES-256-GCM IV, key version, and uid/client AAD", async () => {
    configureEncryption();
    const first = await backend.encryptRefreshToken("refresh-secret", "user-a");
    const second = await backend.encryptRefreshToken("refresh-secret", "user-a");

    expect(first).toMatchObject({ version: 1, keyVersion: 1, algorithm: "AES-256-GCM" });
    expect(first.iv).not.toBe(second.iv);
    expect(first.cipherText).not.toContain("refresh-secret");
    await expect(backend.decryptRefreshToken(first, "user-a")).resolves.toBe("refresh-secret");
    await expect(backend.decryptRefreshToken(first, "user-b")).rejects.toThrow();

    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "different-client.apps.googleusercontent.com");
    await expect(backend.decryptRefreshToken(first, "user-a")).rejects.toThrow();
  });

  it("single-flights and reuses a still-valid Firebase management access token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      return backendJsonResponse({
        access_token: "cached-firebase-management-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const credentials = {
      clientEmail: "calendar-cache-test@quickmemo-test.iam.gserviceaccount.com",
      privateKey,
      projectId: "quickmemo-cache-test"
    };

    await expect(Promise.all([
      backend.fetchFirebaseManagementAccessToken(credentials),
      backend.fetchFirebaseManagementAccessToken(credentials),
      backend.fetchFirebaseManagementAccessToken(credentials)
    ])).resolves.toEqual([
      "cached-firebase-management-token",
      "cached-firebase-management-token",
      "cached-firebase-management-token"
    ]);
    await expect(backend.fetchFirebaseManagementAccessToken(credentials))
      .resolves.toBe("cached-firebase-management-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed encryption keys instead of silently weakening AES-256", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    await expect(backend.encryptRefreshToken("refresh-secret", "user-a")).rejects.toMatchObject({
      statusCode: 503,
      errorCode: "server_not_configured"
    });
  });

  it("requires the granted owned-events scope", () => {
    expect(backend.tokenHasCalendarScope({ scope: `openid email ${backend.googleCalendarScope}` })).toBe(true);
    expect(backend.tokenHasCalendarScope({ scope: "openid email" })).toBe(false);
    expect(commonSource).toContain("!tokenHasCalendarScope(token)");
  });

  it("allows only a validated same-origin browser request", () => {
    vi.stubEnv("GOOGLE_CALENDAR_ALLOWED_ORIGINS", "https://quickmemo.example");
    const request = {
      headers: {
        origin: "https://quickmemo.example",
        host: "quickmemo.example",
        "x-forwarded-proto": "https",
        "sec-fetch-site": "same-origin"
      }
    };
    expect(() => backend.ensureSameOrigin(request)).not.toThrow();
    expect(() => backend.ensureSameOrigin({
      ...request,
      headers: { ...request.headers, origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
    })).toThrowError(expect.objectContaining({ errorCode: "origin_not_allowed" }));
    expect(() => backend.ensureSameOrigin({ ...request, headers: { ...request.headers, origin: "" } }))
      .toThrowError(expect.objectContaining({ errorCode: "origin_not_allowed" }));
  });

  it("requires OAuth start requests to use the exact configured redirect origin", () => {
    const redirectUri = "https://quickmemo.example/api/google-calendar-auth";

    expect(() => backend.ensureGoogleRedirectOrigin({
      headers: { origin: "https://quickmemo.example" }
    }, redirectUri)).not.toThrow();
    expect(() => backend.ensureGoogleRedirectOrigin({
      headers: { origin: "https://preview.quickmemo.example" }
    }, redirectUri)).toThrowError(expect.objectContaining({
      errorCode: "google_calendar_canonical_origin_required"
    }));
    expect(() => backend.ensureGoogleRedirectOrigin({ headers: { origin: "" } }, redirectUri))
      .toThrowError(expect.objectContaining({ errorCode: "google_calendar_canonical_origin_required" }));
  });

  it("accepts only a fixed callback path and a valid IANA browser time zone", () => {
    vi.stubEnv("GOOGLE_CALENDAR_REDIRECT_URI", "https://quickmemo.example/api/google-calendar-auth");
    expect(backend.googleRedirectUri({ headers: {} })).toBe("https://quickmemo.example/api/google-calendar-auth");
    expect(backend.isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(backend.isValidTimeZone("UTC")).toBe(true);
    expect(backend.isValidTimeZone("GMT")).toBe(true);
    expect(backend.isValidTimeZone("CET")).toBe(true);
    expect(backend.isValidTimeZone("not/a/real/time/zone")).toBe(false);

    vi.stubEnv("GOOGLE_CALENDAR_REDIRECT_URI", "https://attacker.example/callback?next=quickmemo");
    expect(() => backend.googleRedirectUri({ headers: {} })).toThrowError(
      expect.objectContaining({ errorCode: "server_not_configured" })
    );
  });

  it("binds OAuth state to a short-lived HttpOnly callback cookie and consumes it once", () => {
    const state = "s".repeat(43);
    const binding = "a".repeat(43);
    const cookie = backend.oauthSessionCookie({
      headers: { host: "quickmemo.example", "x-forwarded-proto": "https" }
    }, state, binding);
    const cleared = backend.oauthSessionCookie({
      headers: { host: "quickmemo.example", "x-forwarded-proto": "https" }
    }, state, "", true);
    const localCookie = backend.oauthSessionCookie({ headers: { host: "localhost:5173" } }, state, binding);

    expect(backend.googleCalendarStateTtlMs).toBe(10 * 60 * 1000);
    expect(cookie).toContain(`qm_google_calendar_oauth_${state}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=600");
    expect(cleared).toContain("Max-Age=0");
    expect(localCookie).not.toContain("; Secure");
    expect(backend.oauthSessionMatches({
      headers: { cookie: `other=value; qm_google_calendar_oauth_${state}=${binding}` }
    }, state, createHash("sha256").update(binding).digest("base64url"))).toBe(true);
    expect(backend.oauthSessionMatches({
      headers: { cookie: `qm_google_calendar_oauth_${state}=wrong` }
    }, state, createHash("sha256").update(binding).digest("base64url"))).toBe(false);
    expect(backend.oauthSessionCookiePresent({
      headers: { cookie: `other=value; qm_google_calendar_oauth_${state}=${binding}` }
    }, state)).toBe(true);
    expect(backend.oauthSessionCookiePresent({ headers: {} }, state)).toBe(false);
    expect(commonSource).toContain("sessionBindingHash");
    expect(commonSource).toContain("codeChallenge: stringValue(codeChallenge)");
    expect(commonSource).toContain("currentDocument: { updateTime: document.updateTime }");
    expect(authSource).toContain("oauthSessionMatches(request, query.state, candidate.sessionBindingHash)");
    expect(authSource.indexOf("oauthSessionCookiePresent(request, query.state)"))
      .toBeLessThan(authSource.indexOf("fetchFirebaseManagementAccessToken(credentials)"));
    expect(commonSource.indexOf("if (!validateState(parsedState))"))
      .toBeLessThan(commonSource.indexOf("delete: document.name"));
    expect(authSource).toContain("await pkceChallengeForVerifier(state.codeVerifier) !== state.codeChallenge");
  });

  it("does not let a stale OAuth callback clear a newer popup session cookie", () => {
    const stateA = "x".repeat(43);
    const stateB = "y".repeat(43);
    const bindingA = "a".repeat(43);
    const bindingB = "b".repeat(43);
    const cookieA = backend.oauthSessionCookie({ headers: { host: "quickmemo.example" } }, stateA, bindingA);
    const cookieB = backend.oauthSessionCookie({ headers: { host: "quickmemo.example" } }, stateB, bindingB);
    const cookieNameA = cookieA.slice(0, cookieA.indexOf("="));
    const cookieNameB = cookieB.slice(0, cookieB.indexOf("="));
    const requestWithBothCookies = {
      headers: { cookie: `${cookieNameA}=${bindingA}; ${cookieNameB}=${bindingB}` }
    };

    expect(backend.oauthSessionMatches(
      requestWithBothCookies,
      stateA,
      createHash("sha256").update(bindingA).digest("base64url")
    )).toBe(true);
    expect(backend.oauthSessionMatches(
      requestWithBothCookies,
      stateB,
      createHash("sha256").update(bindingB).digest("base64url")
    )).toBe(true);

    const clearA = backend.oauthSessionCookie({ headers: { host: "quickmemo.example" } }, stateA, "", true);
    expect(cookieNameA).not.toBe(cookieNameB);
    expect(clearA).toContain(`${cookieNameA}=`);
    expect(clearA).not.toContain(`${cookieNameB}=`);

    const consumeState = authSource.indexOf("const state = await consumeOAuthState");
    const clearConsumedCookie = authSource.indexOf(
      'oauthSessionCookie(request, query.state, "", true)',
      consumeState
    );
    expect(clearConsumedCookie).toBeGreaterThan(consumeState);
  });

  it("atomically advances the user's OAuth epoch when issuing a new state", async () => {
    const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("googleCalendarConnectionEpochs/user-a")) {
        return backendJsonResponse({}, 404);
      }
      if (url.endsWith(":commit")) {
        commits.push(JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> });
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await backend.createOAuthState(
      backendContext,
      "v".repeat(86),
      "c".repeat(43),
      "https://quickmemo.example/api/google-calendar-auth",
      "Asia/Seoul"
    );

    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.sessionBinding).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.connectionAttemptId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(commits).toHaveLength(1);
    expect(commits[0].writes).toHaveLength(2);
    const stateWrite = commits[0].writes[0] as {
      update: { fields: { connectionEpoch: { stringValue: string }; connectionAttemptId: { stringValue: string } } };
    };
    const epochWrite = commits[0].writes[1] as {
      currentDocument: { exists: boolean };
      update: { fields: { connectionEpoch: { stringValue: string }; ownerUid: { stringValue: string } } };
    };
    expect(stateWrite.update.fields.connectionAttemptId.stringValue).toBe(result.connectionAttemptId);
    expect(stateWrite.update.fields.connectionEpoch.stringValue)
      .toBe(epochWrite.update.fields.connectionEpoch.stringValue);
    expect(epochWrite).toMatchObject({
      currentDocument: { exists: false },
      update: { fields: { ownerUid: { stringValue: "user-a" } } }
    });
  });

  it("rejects an older OAuth callback after a newer attempt advanced the epoch", async () => {
    configureEncryption();
    const staleEpoch = "s".repeat(43);
    const currentEpoch = "n".repeat(43);
    const epochDocument: FirestoreDocument = {
      name: `projects/${backendContext.credentials.projectId}/databases/(default)/documents/googleCalendarConnectionEpochs/${backendContext.uid}`,
      updateTime: "2026-07-22T00:00:02.000000Z",
      fields: {
        ownerUid: { stringValue: backendContext.uid },
        connectionEpoch: { stringValue: currentEpoch }
      }
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("googleCalendarConnectionEpochs/user-a") && !url.endsWith(":commit")) {
        return backendJsonResponse(epochDocument);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveGoogleConnection(
      backendContext,
      { refresh_token: "refresh-secret", scope: backend.googleCalendarScope },
      { email: "user@example.com", sub: "google-subject" },
      "Asia/Seoul",
      "a".repeat(43),
      staleEpoch
    )).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_connection_changed"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("limits sync reports to non-sensitive status metadata", () => {
    const connectionGeneration = "g".repeat(43);

    expect(backend.validateSyncReport({ action: "report", connectionGeneration, status: "synced", syncedCount: 3 })).toEqual({
      connectionGeneration,
      status: "synced",
      syncedCount: 3,
      failureCode: ""
    });
    expect(backend.validateSyncReport({
      action: "report",
      connectionGeneration,
      reportSequence: 2,
      status: "failed",
      syncedCount: 0,
      failureCode: "network_error"
    })).toEqual({ connectionGeneration, status: "failed", syncedCount: 0, failureCode: "network_error" });
    expect(() => backend.validateSyncReport({
      action: "report",
      connectionGeneration,
      reportSequence: 3,
      status: "failed",
      syncedCount: 0,
      failureCode: "user@example.com"
    })).toThrow();
    expect(backend.validateSyncReport({
      action: "report",
      connectionGeneration,
      reportSequence: 4,
      status: "failed",
      syncedCount: 1,
      failureCode: "event_conflict"
    }).failureCode).toBe("event_conflict");
    expect(() => backend.validateSyncReport({
      action: "report",
      connectionGeneration,
      reportSequence: 5,
      status: "synced",
      syncedCount: 1,
      eventTitle: "private schedule"
    })).toThrow();
  });

  it("evaluates task authority with the server clock instead of the browser clock", async () => {
    const updatedAt = "2026-07-22T00:00:00.123456789Z";
    const expectedRevision = `${String(Math.floor(Date.parse(updatedAt) / 1000)).padStart(12, "0")}.123456789`;
    let calendarUpdatedAt: string | null = null;
    let createdAt: string | null = null;
    let leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    let taskStartDate: string | null = "2026-07-22";
    let taskExists = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarTaskTombstones/task-a")) {
        return backendJsonResponse({
          fields: {
            ownerUid: { stringValue: backendContext.uid },
            taskId: { stringValue: "task-a" },
            leaseExpiresAt: { timestampValue: leaseExpiresAt }
          }
        });
      }
      if (url.includes("scheduleTasks/task-a")) {
        if (!taskExists) {
          return backendJsonResponse({}, 404);
        }
        return backendJsonResponse({
          fields: {
            ownerUid: { stringValue: backendContext.uid },
            ...(taskStartDate ? { startDate: { stringValue: taskStartDate } } : {}),
            ...(calendarUpdatedAt ? { calendarUpdatedAt: { timestampValue: calendarUpdatedAt } } : {}),
            ...(createdAt ? { createdAt: { timestampValue: createdAt } } : {}),
            updatedAt: { timestampValue: updatedAt }
          }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      expectedRevision
    )).resolves.toBe("deleted");

    leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      expectedRevision
    )).resolves.toBe("current");
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      `${expectedRevision.slice(0, -1)}0`
    )).resolves.toBe("stale");

    calendarUpdatedAt = "2026-07-22T00:01:00.000000007Z";
    const calendarRevision = `${String(Math.floor(Date.parse(calendarUpdatedAt) / 1000)).padStart(12, "0")}.000000007`;
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      calendarRevision
    )).resolves.toBe("current");
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      expectedRevision
    )).resolves.toBe("stale");

    calendarUpdatedAt = null;
    createdAt = "2026-07-21T23:59:00.000000009Z";
    const createdRevision = `${String(Math.floor(Date.parse(createdAt) / 1000)).padStart(12, "0")}.000000009`;
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      createdRevision
    )).resolves.toBe("current");

    taskStartDate = null;
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      expectedRevision
    )).resolves.toBe("undated");

    taskExists = false;
    await expect(backend.getGoogleCalendarTaskAuthority(
      backendContext,
      "task-a",
      expectedRevision
    )).resolves.toBe("deleted");
  });

  it("holds a CAS-bound operation lease across one logical Google mutation", async () => {
    const connection = googleConnectionDocument(generationA);
    let leasedConnection: FirestoreDocument | null = null;
    let beginLeaseId = "";
    let commitCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith(":commit")) {
        commitCount += 1;
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{
            currentDocument?: { updateTime?: string };
            update?: { fields?: Record<string, unknown> };
            updateMask?: { fieldPaths?: string[] };
          }>;
        };
        const write = commit.writes[0];

        if (commitCount === 1) {
          expect(write.currentDocument).toEqual({ updateTime: connection.updateTime });
          expect(write.updateMask?.fieldPaths).toEqual([
            "operationLeaseId",
            "operationLeaseGeneration",
            "operationLeaseExpiresAt"
          ]);
          beginLeaseId = (write.update?.fields?.operationLeaseId as { stringValue: string }).stringValue;
          leasedConnection = leasedGoogleConnectionDocument(generationA, beginLeaseId);
          leasedConnection.updateTime = "2026-07-22T00:00:01.000000Z";
        } else if (commitCount === 2) {
          expect(write.currentDocument).toEqual({ updateTime: leasedConnection?.updateTime });
          expect(write.updateMask?.fieldPaths).toEqual(["operationLeaseExpiresAt"]);
          const renewedExpiry = (write.update?.fields?.operationLeaseExpiresAt as { timestampValue: string }).timestampValue;
          expect(Date.parse(renewedExpiry)).toBeGreaterThan(Date.now() + 170_000);
          if (!leasedConnection) {
            throw new Error("Expected an active operation lease");
          }
          leasedConnection.fields.operationLeaseExpiresAt = { timestampValue: renewedExpiry };
          leasedConnection.updateTime = "2026-07-22T00:00:02.000000Z";
        } else {
          expect(write.currentDocument).toEqual({ updateTime: leasedConnection?.updateTime });
          expect(write.update?.fields).toMatchObject({
            operationLeaseId: { stringValue: "" },
            operationLeaseGeneration: { stringValue: "" },
            operationLeaseExpiresAt: { timestampValue: "1970-01-01T00:00:00.000Z" }
          });
        }
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:02Z" });
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(leasedConnection ?? connection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const operation = await backend.beginGoogleCalendarOperation(backendContext, generationA);

    expect(operation).toEqual({ connectionGeneration: generationA, leaseId: beginLeaseId });
    await expect(backend.requireGoogleCalendarOperation(
      backendContext,
      generationA,
      beginLeaseId
    )).resolves.toMatchObject({ updateTime: "2026-07-22T00:00:02.000000Z" });
    await expect(backend.endGoogleCalendarOperation(
      backendContext,
      generationA,
      beginLeaseId
    )).resolves.toBe(true);
    expect(commitCount).toBe(3);
  });

  it("combines current task authority with a CAS-bound operation lease", async () => {
    const updatedAt = "2026-07-22T00:00:00.123456789Z";
    const expectedRevision = `${String(Math.floor(Date.parse(updatedAt) / 1000)).padStart(12, "0")}.123456789`;
    const connection = googleConnectionDocument(generationA);
    let commitCount = 0;
    let leaseId = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("googleCalendarTaskTombstones/task-combined")) {
        return backendJsonResponse({}, 404);
      }
      if (url.includes("scheduleTasks/task-combined")) {
        return backendJsonResponse({
          fields: {
            ownerUid: { stringValue: backendContext.uid },
            startDate: { stringValue: "2026-07-22" },
            calendarUpdatedAt: { timestampValue: updatedAt }
          }
        });
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      if (url.endsWith(":commit")) {
        commitCount += 1;
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{ update?: { fields?: Record<string, { stringValue?: string }> } }>;
        };
        leaseId = commit.writes[0]?.update?.fields?.operationLeaseId?.stringValue ?? "";
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const operation = await backend.beginGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      "task-combined",
      expectedRevision
    );

    expect(operation).toEqual({
      connectionGeneration: generationA,
      leaseId,
      state: "current"
    });
    expect(leaseId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(commitCount).toBe(1);
  });

  it("returns stale authority without acquiring a blocking operation lease", async () => {
    const connection = googleConnectionDocument(generationA);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarTaskTombstones/task-stale")) {
        return backendJsonResponse({}, 404);
      }
      if (url.includes("scheduleTasks/task-stale")) {
        return backendJsonResponse({
          fields: {
            ownerUid: { stringValue: backendContext.uid },
            startDate: { stringValue: "2026-07-22" },
            calendarUpdatedAt: { timestampValue: "2026-07-22T00:00:01.000000000Z" }
          }
        });
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.beginGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      "task-stale",
      "001753142400.000000000"
    )).resolves.toEqual({
      connectionGeneration: generationA,
      leaseId: null,
      state: "stale"
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);

    await expect(backend.beginGoogleCalendarTaskOperation(
      backendContext,
      generationB,
      "task-stale",
      "001753142400.000000000"
    )).rejects.toMatchObject({ errorCode: "google_connection_changed" });
  });

  it("rejects malformed combined-operation leases before any authority read", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.beginGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      "task-malformed-lease",
      "001753142400.000000000",
      "not-a-valid-lease"
    )).rejects.toMatchObject({ statusCode: 400, errorCode: "invalid_request" });
    await expect(backend.finishGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      "not-a-valid-lease",
      "task-malformed-lease",
      "001753142400.000000000"
    )).rejects.toMatchObject({ statusCode: 400, errorCode: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the operation lease before evaluating finish authority", async () => {
    const updatedAt = "2026-07-22T00:00:00.123456789Z";
    const expectedRevision = `${String(Math.floor(Date.parse(updatedAt) / 1000)).padStart(12, "0")}.123456789`;
    const leaseId = "l".repeat(43);
    const connection = leasedGoogleConnectionDocument(generationA, leaseId);
    let leaseReleased = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      if (url.endsWith(":commit")) {
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{ update?: { fields?: Record<string, { stringValue?: string }> } }>;
        };
        expect(commit.writes[0]?.update?.fields).toMatchObject({
          operationLeaseId: { stringValue: "" },
          operationLeaseGeneration: { stringValue: "" }
        });
        leaseReleased = true;
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      if (url.includes("googleCalendarTaskTombstones/task-finish")) {
        expect(leaseReleased).toBe(true);
        return backendJsonResponse({}, 404);
      }
      if (url.includes("scheduleTasks/task-finish")) {
        expect(leaseReleased).toBe(true);
        return backendJsonResponse({
          fields: {
            ownerUid: { stringValue: backendContext.uid },
            startDate: { stringValue: "2026-07-22" },
            calendarUpdatedAt: { timestampValue: updatedAt }
          }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.finishGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      leaseId,
      "task-finish",
      expectedRevision
    )).resolves.toBe("current");
    expect(leaseReleased).toBe(true);
  });

  it("keeps the lease released when the finish authority read fails", async () => {
    const leaseId = "l".repeat(43);
    const connection = leasedGoogleConnectionDocument(generationA, leaseId);
    let leaseReleased = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      if (url.endsWith(":commit")) {
        leaseReleased = true;
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      if (url.includes("googleCalendarTaskTombstones/task-timeout")) {
        expect(leaseReleased).toBe(true);
        return backendJsonResponse({}, 404);
      }
      if (url.includes("scheduleTasks/task-timeout")) {
        expect(leaseReleased).toBe(true);
        return backendJsonResponse({}, 504);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.finishGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      leaseId,
      "task-timeout",
      "001753142400.000000000"
    )).rejects.toThrow("Firestore read failed");
    expect(leaseReleased).toBe(true);
  });

  it("fails closed when a finish operation cannot release its lease", async () => {
    const leaseId = "l".repeat(43);
    const connection = leasedGoogleConnectionDocument(generationA, leaseId);
    let authorityReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      if (url.endsWith(":commit")) {
        return backendJsonResponse({}, 409);
      }
      if (url.includes("scheduleTasks/") || url.includes("googleCalendarTaskTombstones/")) {
        authorityReads += 1;
        return backendJsonResponse({}, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.finishGoogleCalendarTaskOperation(
      backendContext,
      generationA,
      leaseId,
      "task-release-conflict",
      "001753142400.000000000"
    )).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_operation_release_failed"
    });
    expect(authorityReads).toBe(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(":commit"))).toHaveLength(4);
  });

  it("holds a CAS-bound workflow lease across the complete task deletion sequence", async () => {
    const connection = googleConnectionDocument(generationA);
    let workflowConnection: FirestoreDocument | null = null;
    let workflowLeaseId = "";
    let commitCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith(":commit")) {
        commitCount += 1;
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{
            currentDocument?: { updateTime?: string };
            update?: { fields?: Record<string, unknown> };
            updateMask?: { fieldPaths?: string[] };
          }>;
        };
        const write = commit.writes[0];

        if (commitCount === 1) {
          expect(write.currentDocument).toEqual({ updateTime: connection.updateTime });
          expect(write.updateMask?.fieldPaths).toEqual([
            "deletionWorkflowLeaseId",
            "deletionWorkflowLeaseGeneration",
            "deletionWorkflowLeaseExpiresAt"
          ]);
          workflowLeaseId = (write.update?.fields?.deletionWorkflowLeaseId as { stringValue: string }).stringValue;
          workflowConnection = deletionWorkflowGoogleConnectionDocument(generationA, workflowLeaseId);
          workflowConnection.updateTime = "2026-07-22T00:00:01.000000Z";
        } else {
          expect(write.currentDocument).toEqual({ updateTime: workflowConnection?.updateTime });
          expect(write.update?.fields).toMatchObject({
            deletionWorkflowLeaseId: { stringValue: "" },
            deletionWorkflowLeaseGeneration: { stringValue: "" },
            deletionWorkflowLeaseExpiresAt: { timestampValue: "1970-01-01T00:00:00.000Z" }
          });
        }
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:02Z" });
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(workflowConnection ?? connection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const workflow = await backend.beginGoogleCalendarDeletionWorkflow(backendContext, generationA);
    expect(workflow).toEqual({ connectionGeneration: generationA, leaseId: workflowLeaseId });
    await expect(backend.endGoogleCalendarDeletionWorkflow(
      backendContext,
      generationA,
      workflowLeaseId
    )).resolves.toBeUndefined();
    expect(commitCount).toBe(2);
  });

  it("renews and binds each Google delete operation to the active workflow generation", async () => {
    const workflowLeaseId = "w".repeat(43);
    let connection = deletionWorkflowGoogleConnectionDocument(generationA, workflowLeaseId);
    let commitCount = 0;
    const updateTimes = [
      "2026-07-22T00:00:01.000000Z",
      "2026-07-22T00:00:02.000000Z"
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith(":commit")) {
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{
            currentDocument?: { updateTime?: string };
            update?: { fields?: Record<string, { stringValue?: string; timestampValue?: string }> };
            updateMask?: { fieldPaths?: string[] };
          }>;
        };
        const write = commit.writes[0];
        const fields = write.update?.fields ?? {};

        expect(write.currentDocument).toEqual({ updateTime: connection.updateTime });
        if (commitCount === 0) {
          expect(write.updateMask?.fieldPaths).toEqual(["deletionWorkflowLeaseExpiresAt"]);
        } else {
          expect(write.updateMask?.fieldPaths).toEqual([
            "operationLeaseId",
            "operationLeaseGeneration",
            "operationLeaseExpiresAt",
            "deletionWorkflowLeaseExpiresAt"
          ]);
        }
        for (const [fieldPath, value] of Object.entries(fields)) {
          connection.fields[fieldPath] = value;
        }
        connection = { ...connection, updateTime: updateTimes[commitCount] };
        commitCount += 1;
        return backendJsonResponse({ commitTime: updateTimes[commitCount - 1] });
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.beginGoogleCalendarOperation(
      backendContext,
      generationA
    )).rejects.toMatchObject({ errorCode: "google_deletion_workflow_in_progress" });
    expect(commitCount).toBe(0);
    await expect(backend.renewGoogleCalendarDeletionWorkflow(
      backendContext,
      generationA,
      workflowLeaseId
    )).resolves.toEqual({ connectionGeneration: generationA, leaseId: workflowLeaseId });
    await expect(backend.beginGoogleCalendarOperation(
      backendContext,
      generationA,
      workflowLeaseId
    )).resolves.toMatchObject({ connectionGeneration: generationA });
    expect(commitCount).toBe(2);
  });

  it("refuses to revive an expired deletion workflow", async () => {
    const workflowLeaseId = "w".repeat(43);
    const connection = deletionWorkflowGoogleConnectionDocument(
      generationA,
      workflowLeaseId,
      new Date(Date.now() - 1_000).toISOString()
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.renewGoogleCalendarDeletionWorkflow(
      backendContext,
      generationA,
      workflowLeaseId
    )).rejects.toMatchObject({ errorCode: "google_operation_expired" });
    await expect(backend.beginGoogleCalendarOperation(
      backendContext,
      generationA,
      workflowLeaseId
    )).rejects.toMatchObject({ errorCode: "google_operation_expired" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);
  });

  it("blocks account replacement and disconnect while an operation or deletion workflow lease is active", async () => {
    configureEncryption();
    const leaseId = "l".repeat(43);
    let connection = leasedGoogleConnectionDocument(generationA, leaseId);
    const epochDocument: FirestoreDocument = {
      name: `projects/${backendContext.credentials.projectId}/databases/(default)/documents/googleCalendarConnectionEpochs/${backendContext.uid}`,
      updateTime: "2026-07-22T00:00:02.000000Z",
      fields: {
        ownerUid: { stringValue: backendContext.uid },
        connectionEpoch: { stringValue: "e".repeat(43) }
      }
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarConnectionEpochs/user-a")) {
        return backendJsonResponse(epochDocument);
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(connection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveGoogleConnection(
      backendContext,
      { refresh_token: "refresh-secret", scope: backend.googleCalendarScope },
      { email: "user@example.com", sub: "google-subject" },
      "Asia/Seoul",
      "a".repeat(43),
      "e".repeat(43)
    )).rejects.toMatchObject({ errorCode: "google_operation_in_progress" });
    await expect(backend.disconnectGoogleCalendar(
      backendContext,
      connection,
      generationA,
      backend.publicConnectionStatus(connection).connectionIdentity
    )).rejects.toMatchObject({ errorCode: "google_operation_in_progress" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);

    connection = deletionWorkflowGoogleConnectionDocument(generationA);
    fetchMock.mockClear();
    await expect(backend.saveGoogleConnection(
      backendContext,
      { refresh_token: "refresh-secret", scope: backend.googleCalendarScope },
      { email: "user@example.com", sub: "google-subject" },
      "Asia/Seoul",
      "a".repeat(43),
      "e".repeat(43)
    )).rejects.toMatchObject({ errorCode: "google_operation_in_progress" });
    await expect(backend.disconnectGoogleCalendar(
      backendContext,
      connection,
      generationA,
      backend.publicConnectionStatus(connection).connectionIdentity
    )).rejects.toMatchObject({ errorCode: "google_operation_in_progress" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);
  });

  it("surfaces structurally incomplete stored connections as reconnectable failures", () => {
    const status = backend.publicConnectionStatus({
      fields: {
        connectionStatus: { stringValue: "connected" },
        emailMasked: { stringValue: "us***@example.com" },
        grantedScopes: { arrayValue: {} },
        lastSyncStatus: { stringValue: "synced" }
      }
    });

    expect(status).toMatchObject({
      connected: false,
      hasStoredConnection: true,
      lastSyncStatus: "failed",
      needsReconnect: true
    });
  });

  it("surfaces a non-empty malformed connection generation as requiring reconnect", () => {
    const connection = googleConnectionDocument("legacy-generation");
    const status = backend.publicConnectionStatus(connection);

    expect(status).toMatchObject({
      connected: false,
      connectionGeneration: null,
      hasStoredConnection: true,
      lastSyncStatus: "failed",
      needsReconnect: true
    });
  });

  it("marks a structurally valid connection with a malformed encrypted token for reconnect", async () => {
    const connection = googleConnectionDocument(generationA);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(":commit")) {
        expect(init?.method).toBe("POST");
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.refreshGoogleAccessToken({
      clientId: "quickmemo-test.apps.googleusercontent.com",
      clientSecret: "client-secret"
    }, backendContext, connection)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_reconnect_required"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const commit = JSON.parse(String(init?.body)) as {
      writes: Array<{
        currentDocument?: { updateTime?: string };
        update?: { fields?: Record<string, { stringValue?: string }> };
      }>;
    };
    expect(commit.writes[0]).toMatchObject({
      currentDocument: { updateTime: connection.updateTime },
      update: {
        fields: {
          connectionStatus: { stringValue: "needs_reconnect" },
          lastFailureCode: { stringValue: "reconnect_required" },
          lastSyncStatus: { stringValue: "failed" }
        }
      }
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("oauth2.googleapis.com"))).toBe(false);
  });

  it("keeps a recognized non-invalid_grant OAuth error generic without changing connection state", async () => {
    configureEncryption();
    const encrypted = await backend.encryptRefreshToken("refresh-secret", backendContext.uid);
    const connection = googleConnectionDocument(generationA, encrypted);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "https://oauth2.googleapis.com/token") {
        return backendJsonResponse({ error: "invalid_client" }, 400);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.refreshGoogleAccessToken({
      clientId: "quickmemo-test.apps.googleusercontent.com",
      clientSecret: "client-secret"
    }, backendContext, connection)).rejects.toMatchObject({
      name: "UpstreamError",
      upstreamStatus: 400,
      oauthErrorCode: "invalid_client",
      oauthInvalidGrant: false
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);
  });

  it("keeps the upstream timeout active until a stalled response body finishes", async () => {
    vi.useFakeTimers();
    try {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const response = new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });

        init.signal?.addEventListener("abort", () => {
          bodyController?.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
        return response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const operation = backend.fetchGoogleAccount("short-lived-access-token");
      const rejection = expect(operation).rejects.toMatchObject({
        name: "UpstreamError",
        upstreamStatus: 504
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the connection for reconnect only for the exact invalid_grant OAuth error", async () => {
    configureEncryption();
    const encrypted = await backend.encryptRefreshToken("refresh-secret", backendContext.uid);
    const connection = googleConnectionDocument(generationA, encrypted);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://oauth2.googleapis.com/token") {
        return backendJsonResponse({ error: "invalid_grant" }, 400);
      }
      if (url.endsWith(":commit")) {
        expect(init?.method).toBe("POST");
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.refreshGoogleAccessToken({
      clientId: "quickmemo-test.apps.googleusercontent.com",
      clientSecret: "client-secret"
    }, backendContext, connection)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_reconnect_required"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const commitCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith(":commit"));
    const reconnectCommit = JSON.parse(String(commitCall?.[1]?.body)) as {
      writes?: Array<{ update?: { fields?: Record<string, unknown> } }>;
    };
    expect(reconnectCommit.writes?.[0]).toMatchObject({
      update: {
        fields: {
          connectionStatus: { stringValue: "needs_reconnect" },
          lastFailureCode: { stringValue: "reconnect_required" },
          lastSyncStatus: { stringValue: "failed" }
        }
      }
    });
  });

  it("rejects a sync report for a superseded connection generation without writing status", async () => {
    const currentConnection = googleConnectionDocument(generationB, undefined, "2026-07-22T00:00:02.000000Z");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("firestore.googleapis.com") && !url.endsWith(":commit")) {
        return backendJsonResponse(currentConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveSyncReport(backendContext, {
      connectionGeneration: generationA,
      failureCode: "",
      reportSequence: 1,
      status: "synced",
      syncedCount: 2
    })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_calendar_not_connected"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);
  });

  it("retries a reconnect-required sync report after a CAS race and makes it terminal", async () => {
    const firstConnection = googleConnectionDocument(generationA);
    const refreshedConnection = googleConnectionDocument(
      generationA,
      undefined,
      "2026-07-22T00:00:02.000000Z"
    );
    let readCount = 0;
    let commitCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(":commit")) {
        commitCount += 1;
        if (commitCount === 1) {
          return backendJsonResponse({ error: { status: "ABORTED" } }, 409);
        }
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{ currentDocument?: { updateTime?: string }; update?: { fields?: Record<string, unknown> } }>;
        };
        expect(commit.writes[0]).toMatchObject({
          currentDocument: { updateTime: refreshedConnection.updateTime },
          update: {
            fields: {
              connectionStatus: { stringValue: "needs_reconnect" },
              lastFailureCode: { stringValue: "permission_denied" },
              lastSyncStatus: { stringValue: "failed" }
            }
          }
        });
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:03Z" });
      }
      if (url.includes("firestore.googleapis.com")) {
        readCount += 1;
        return backendJsonResponse(readCount === 1 ? firstConnection : refreshedConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveSyncReport(backendContext, {
      connectionGeneration: generationA,
      failureCode: "permission_denied",
      reportSequence: 1,
      status: "failed",
      syncedCount: 0
    })).resolves.toBeUndefined();

    expect(readCount).toBe(2);
    expect(commitCount).toBe(2);
  });

  it("retries an ordinary synced report after a Firestore precondition conflict", async () => {
    const firstConnection = googleConnectionDocument(generationA);
    const refreshedConnection = googleConnectionDocument(
      generationA,
      undefined,
      "2026-07-22T00:00:02.000000Z"
    );
    let readCount = 0;
    let commitCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith(":commit")) {
        commitCount += 1;
        if (commitCount === 1) {
          return backendJsonResponse({ error: { status: "FAILED_PRECONDITION" } }, 400);
        }
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{ currentDocument?: { updateTime?: string }; update?: { fields?: Record<string, unknown> } }>;
        };
        expect(commit.writes[0]).toMatchObject({
          currentDocument: { updateTime: refreshedConnection.updateTime },
          update: {
            fields: {
              lastFailureCode: { stringValue: "" },
              lastSyncStatus: { stringValue: "synced" },
              syncedCount: { integerValue: "7" }
            }
          }
        });
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:03Z" });
      }
      if (url.includes("firestore.googleapis.com")) {
        readCount += 1;
        return backendJsonResponse(readCount === 1 ? firstConnection : refreshedConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveSyncReport(backendContext, {
      connectionGeneration: generationA,
      failureCode: "",
      reportSequence: 1,
      status: "synced",
      syncedCount: 7
    })).resolves.toBeUndefined();

    expect(readCount).toBe(2);
    expect(commitCount).toBe(2);
  });

  it("does not let a later ordinary report overwrite a terminal needs-reconnect state", async () => {
    const terminalConnection = googleConnectionDocument(generationA);
    terminalConnection.fields.connectionStatus = { stringValue: "needs_reconnect" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("firestore.googleapis.com") && !url.endsWith(":commit")) {
        return backendJsonResponse(terminalConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveSyncReport(backendContext, {
      connectionGeneration: generationA,
      failureCode: "",
      reportSequence: 1,
      status: "synced",
      syncedCount: 7
    })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_calendar_not_connected"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);
  });

  it("allocates report order on the server even when a client sends an old sequence", async () => {
    const currentConnection = googleConnectionDocument(generationA);
    currentConnection.fields.lastReportSequence = { integerValue: "8" };
    currentConnection.fields.lastSyncStatus = { stringValue: "failed" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("firestore.googleapis.com") && !url.endsWith(":commit")) {
        return backendJsonResponse(currentConnection);
      }
      if (url.endsWith(":commit")) {
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{ update?: { fields?: Record<string, unknown> } }>;
        };
        expect(commit.writes[0]?.update?.fields).toMatchObject({
          lastReportSequence: { integerValue: "9" },
          lastSyncStatus: { stringValue: "synced" }
        });
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:03Z" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.saveSyncReport(backendContext, {
      connectionGeneration: generationA,
      failureCode: "",
      reportSequence: 7,
      status: "synced",
      syncedCount: 7
    })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(true);
  });

  it("rejects a stale disconnect generation and otherwise performs only a CAS-bound local delete", async () => {
    const connection = googleConnectionDocument(generationA);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("googleCalendarConnectionEpochs/user-a")) {
        return backendJsonResponse({}, 404);
      }
      if (url.endsWith(":commit")) {
        expect(init?.method).toBe("POST");
        return backendJsonResponse({ commitTime: "2026-07-22T00:00:01Z" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const connectionIdentity = backend.publicConnectionStatus(connection).connectionIdentity;

    await expect(backend.disconnectGoogleCalendar(
      backendContext,
      connection,
      generationB,
      connectionIdentity
    )).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_connection_changed"
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(backend.disconnectGoogleCalendar(
      backendContext,
      connection,
      generationA,
      connectionIdentity
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [input, init] = fetchMock.mock.calls[1];
    const commit = JSON.parse(String(init?.body)) as {
      writes: Array<{
        currentDocument?: { exists?: boolean; updateTime?: string };
        delete?: string;
        update?: { fields?: Record<string, unknown>; name?: string };
      }>;
    };
    expect(String(input)).toContain("firestore.googleapis.com");
    expect(commit.writes).toHaveLength(2);
    expect(commit.writes[0]).toMatchObject({
      currentDocument: { exists: false },
      update: {
        name: expect.stringContaining("googleCalendarConnectionEpochs/user-a"),
        fields: { ownerUid: { stringValue: "user-a" } }
      }
    });
    expect(commit.writes[1]).toEqual({
      delete: connection.name,
      currentDocument: { updateTime: connection.updateTime }
    });
    expect(commonSource).not.toContain("oauth2/revoke");
  });

  it("does not delete a replacement connection when a stale disconnect retries after a CAS conflict", async () => {
    const initialConnection = googleConnectionDocument(generationA);
    const replacementConnection = googleConnectionDocument(
      generationB,
      undefined,
      "2026-07-22T00:00:03.000000Z"
    );
    let commitCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarConnectionEpochs/user-a")) {
        return backendJsonResponse({}, 404);
      }
      if (url.endsWith(":commit")) {
        commitCalls += 1;
        return backendJsonResponse({}, 409);
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(replacementConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.disconnectGoogleCalendar(
      backendContext,
      initialConnection,
      generationA,
      backend.publicConnectionStatus(initialConnection).connectionIdentity
    )).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_connection_changed"
    });
    expect(commitCalls).toBe(1);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("googleCalendarConnectionEpochs/user-a"),
      expect.stringContaining(":commit"),
      expect.stringContaining("googleCalendarConnections/user-a")
    ]);
  });

  it("does not delete a replacement connection when a legacy null-generation disconnect loses its CAS", async () => {
    const legacyConnection = googleConnectionDocument(generationA);
    delete legacyConnection.fields.connectionGeneration;
    const replacementConnection = googleConnectionDocument(
      generationB,
      undefined,
      "2026-07-22T00:00:04.000000Z"
    );
    const legacyStatus = backend.publicConnectionStatus(legacyConnection);
    let commitCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("googleCalendarConnectionEpochs/user-a")) {
        return backendJsonResponse({}, 404);
      }
      if (url.endsWith(":commit")) {
        commitCalls += 1;
        return backendJsonResponse({}, 409);
      }
      if (url.includes("googleCalendarConnections/user-a")) {
        return backendJsonResponse(replacementConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(legacyStatus).toMatchObject({
      connected: false,
      connectionGeneration: null,
      hasStoredConnection: true,
      needsReconnect: true
    });
    expect(legacyStatus.connectionIdentity).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(legacyStatus.connectionIdentity)
      .not.toBe(backend.publicConnectionStatus(replacementConnection).connectionIdentity);

    await expect(backend.disconnectGoogleCalendar(
      backendContext,
      legacyConnection,
      null,
      legacyStatus.connectionIdentity
    )).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_connection_changed"
    });
    expect(commitCalls).toBe(1);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("googleCalendarConnectionEpochs/user-a"),
      expect.stringContaining(":commit"),
      expect.stringContaining("googleCalendarConnections/user-a")
    ]);
  });

  it("retries a rotated refresh-token write after a same-generation CAS conflict", async () => {
    configureEncryption();
    const encrypted = await backend.encryptRefreshToken("refresh-secret", backendContext.uid);
    const initialConnection = googleConnectionDocument(generationA, encrypted);
    const updatedConnection = googleConnectionDocument(
      generationA,
      encrypted,
      "2026-07-22T00:00:01.000000Z"
    );
    let commitCalls = 0;
    const commitPreconditions: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://oauth2.googleapis.com/token") {
        return backendJsonResponse({
          access_token: "fresh-google-access-token",
          expires_in: 3600,
          refresh_token: "rotated-refresh-secret"
        });
      }
      if (url.endsWith(":commit")) {
        commitCalls += 1;
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{
            currentDocument?: { updateTime?: string };
            update?: { fields?: { encryptedRefreshToken?: unknown } };
          }>;
        };
        commitPreconditions.push(commit.writes[0]?.currentDocument?.updateTime ?? "");
        expect(commit.writes[0]?.update?.fields?.encryptedRefreshToken).toBeTruthy();
        return commitCalls === 1
          ? backendJsonResponse({}, 409)
          : backendJsonResponse({ commitTime: "2026-07-22T00:00:02Z" });
      }
      if (url.includes("firestore.googleapis.com")) {
        return backendJsonResponse(updatedConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.refreshGoogleAccessToken({
      clientId: "quickmemo-test.apps.googleusercontent.com",
      clientSecret: "client-secret"
    }, backendContext, initialConnection)).resolves.toMatchObject({
      accessToken: "fresh-google-access-token",
      connectionGeneration: generationA
    });
    expect(commitCalls).toBe(2);
    expect(commitPreconditions).toEqual([
      initialConnection.updateTime,
      updatedConnection.updateTime
    ]);
  });

  it("withholds a refreshed access token if the connection generation changes during refresh", async () => {
    configureEncryption();
    const encrypted = await backend.encryptRefreshToken("refresh-secret", backendContext.uid);
    const initialConnection = googleConnectionDocument(generationA, encrypted);
    const replacementConnection = googleConnectionDocument(
      generationB,
      encrypted,
      "2026-07-22T00:00:03.000000Z"
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return backendJsonResponse({ access_token: "fresh-google-access-token", expires_in: 3600 });
      }
      if (url.includes("firestore.googleapis.com") && !url.endsWith(":commit")) {
        return backendJsonResponse(replacementConnection);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend.refreshGoogleAccessToken({
      clientId: "quickmemo-test.apps.googleusercontent.com",
      clientSecret: "client-secret"
    }, backendContext, initialConnection)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: "google_connection_changed"
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://oauth2.googleapis.com/token",
      expect.stringContaining("firestore.googleapis.com")
    ]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(":commit"))).toBe(false);
  });

  it("returns only a masked account identifier in connection status", () => {
    expect(backend.maskGoogleEmail("calendar.owner@example.com")).toBe("ca***@example.com");
    expect(backend.maskGoogleEmail("not-an-email")).toBe("Google 계정");
    expect(commonSource).toContain("emailMasked");
    expect(commonSource).not.toContain("email: stringValue");
  });

  it("renders an accessible close-window action so the opener can observe popup completion", () => {
    for (const kind of ["success", "cancelled", "failed"]) {
      const html = backend.googleCalendarCallbackHtml(kind);
      expect(html).toContain('<html lang="ko">');
      expect(html).toContain('<button id="close-window" type="button">창 닫기</button>');
      expect(html).toContain('id="close-hint" role="status" aria-live="polite" hidden');
      expect(html).toContain('window.close()');
      expect(html).toContain('<script nonce="__QUICKMEMO_CSP_NONCE__">');
      expect(html).not.toContain('href="/schedule"');
      expect(html).not.toContain("access_token");
      expect(html).not.toContain("refresh_token");
    }
    expect(commonSource).toContain('response.setHeader("cache-control", "no-store")');
    expect(commonSource).toContain('response.setHeader("referrer-policy", "no-referrer")');
  });

  it("replaces the callback script nonce and sends a matching restrictive CSP", () => {
    const headers = new Map<string, string>();
    let renderedHtml = "";
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end: (value = "") => {
        renderedHtml = value;
      }
    };

    backend.htmlResponse(response, 200, backend.googleCalendarCallbackHtml("success"));

    const contentSecurityPolicy = headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/u.exec(contentSecurityPolicy)?.[1];
    expect(response.statusCode).toBe(200);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(contentSecurityPolicy).toContain("default-src 'none'");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(renderedHtml).toContain(`<script nonce="${nonce}">`);
    expect(renderedHtml).not.toContain("__QUICKMEMO_CSP_NONCE__");
  });

  it("removes the one-time authorization code from the visible callback URL before rendering", () => {
    const headers = new Map<string, string>();
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end: vi.fn()
    };

    backend.googleCalendarResultRedirect(response, "success");

    expect(response.statusCode).toBe(303);
    expect(headers.get("location")).toBe("/api/google-calendar-auth?result=success");
    expect(headers.get("location")).not.toContain("code=");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(authSource).toContain('googleCalendarResultRedirect(response, "success")');
    expect(authSource).toContain('googleCalendarResultRedirect(response, "failed")');
  });

  it("verifies Firebase identity and active status before server-only connection access", () => {
    const callerLookup = commonSource.indexOf("const caller = await lookupFirebaseCaller(idToken)");
    const credentials = commonSource.indexOf("const credentials = firebaseManagementCredentials()", callerLookup);
    const profile = commonSource.indexOf("`users/${uid}`", credentials);

    expect(commonSource).toContain("accounts:lookup");
    expect(commonSource).toContain("profile.fields?.isActive?.booleanValue !== true");
    expect(connectionSource).toContain("await activeManagementContext(context.uid, context.credentials, context.accessToken)");
    expect(connectionSource).toContain("serverTime: new Date().toISOString()");
    expect(callerLookup).toBeGreaterThan(-1);
    expect(credentials).toBeGreaterThan(callerLookup);
    expect(profile).toBeGreaterThan(credentials);
    expect(commonSource).toContain("googleCalendarConnections");
    expect(commonSource).toContain("googleCalendarOAuthStates");
  });

  it("accepts no client redirect, verifier, uid, event payload, or unrestricted failure text", () => {
    expect(authSource).toContain('assertOnlyKeys(body, ["action", "browserTimeZone"])');
    expect(authSource).not.toContain("body.redirectUri");
    expect(authSource).not.toContain("body.codeVerifier");
    expect(authSource).not.toContain("body.uid");
    expect(connectionSource).toContain('assertOnlyKeys(body, ["action"])');
    expect(connectionSource).toMatch(
      /if \(body\.action === "begin-task-operation"\) \{[\s\S]*?assertOnlyKeys\(body, \[[\s\S]*?"taskId"[\s\S]*?"revision"[\s\S]*?"connectionGeneration"[\s\S]*?"deletionWorkflowLeaseId"[\s\S]*?\]\);/u
    );
    expect(connectionSource).toMatch(
      /if \(body\.action === "finish-task-operation"\) \{[\s\S]*?assertOnlyKeys\(body, \[[\s\S]*?"taskId"[\s\S]*?"revision"[\s\S]*?"connectionGeneration"[\s\S]*?"operationLeaseId"[\s\S]*?\]\);/u
    );
    expect(connectionSource).not.toContain("eventTitle");
    expect(connectionSource).not.toContain("eventDescription");
    expect(connectionSource).not.toContain("refreshToken:");
    expect(commonSource).toMatch(/return \{\s+accessToken: token\.access_token,\s+expiresAt:/u);
    expect(commonSource).toContain('const connectionGeneration = readString(document, "connectionGeneration")');
    expect(commonSource).toContain('timeZone: document ? readString(document, "timeZone") || null : null');
  });

  it("routes all backend failures through redacted summaries without credential logging", () => {
    expect(authSource).toContain('console.error("google calendar callback failed", safeErrorSummary(error))');
    expect(connectionSource).toContain('console.error("google calendar connection failed", safeErrorSummary(error))');
    expect(authSource).not.toContain("console.log");
    expect(connectionSource).not.toContain("console.log");
    expect(commonSource).toContain("access_token|refresh_token|id_token|code|code_verifier|state");
  });

  it("documents server-only secrets without exposing them through VITE-prefixed variables", () => {
    for (const name of [
      "GOOGLE_CALENDAR_CLIENT_ID",
      "GOOGLE_CALENDAR_CLIENT_SECRET",
      "GOOGLE_CALENDAR_REDIRECT_URI",
      "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY",
      "GOOGLE_CALENDAR_ALLOWED_ORIGINS"
    ]) {
      expect(envExample).toContain(`${name}=`);
      expect(envExample).not.toContain(`VITE_${name}=`);
    }
  });
});
