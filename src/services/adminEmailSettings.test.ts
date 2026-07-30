import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdminEmailSettingsError,
  confirmAdminEmailSettingsTest,
  getAdminEmailSettingsStatus,
  stageAdminEmailSettings
} from "./adminEmailSettings";

const firebaseMocks = vi.hoisted(() => ({
  appCheck: {} as object | null,
  getAppCheckToken: vi.fn(),
  getIdToken: vi.fn()
}));

vi.mock("../lib/firebase", () => ({
  get appCheck() {
    return firebaseMocks.appCheck;
  },
  auth: {
    currentUser: {
      getIdToken: firebaseMocks.getIdToken
    }
  }
}));

vi.mock("firebase/app-check", () => ({
  getToken: firebaseMocks.getAppCheckToken
}));

const baseSettings = {
  enabled: true,
  active: {
    present: true,
    generation: "active_0123456789",
    usernameMasked: "q***@gmail.com",
    replyToMasked: "r***@example.com",
    verifiedAt: "2026-07-30T12:00:00.000Z"
  },
  pending: {
    present: false
  }
};
const serviceSource = readFileSync(join(process.cwd(), "src/services/adminEmailSettings.ts"), "utf8");

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

describe("admin email settings API client", () => {
  beforeEach(() => {
    firebaseMocks.appCheck = {};
    firebaseMocks.getIdToken.mockReset().mockResolvedValue("header.payload.signature");
    firebaseMocks.getAppCheckToken.mockReset().mockResolvedValue({ token: "A".repeat(32) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      settings: baseSettings
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not persist or log SMTP credentials in the browser client", () => {
    expect(serviceSource).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/u);
    expect(serviceSource).not.toMatch(/\bconsole\.(?:debug|info|log|warn|error)\b/u);
    expect(serviceSource).toContain('const adminEmailSettingsApiPath = "/api/admin-email-settings"');
  });

  it("loads status through authenticated same-origin POST with App Check", async () => {
    const status = await getAdminEmailSettingsStatus();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const headers = new Headers(init?.headers);

    expect(url).toBe("/api/admin-email-settings");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    expect(JSON.parse(String(init?.body))).toEqual({ action: "status" });
    expect(headers.get("authorization")).toBe("Bearer header.payload.signature");
    expect(headers.get("x-firebase-appcheck")).toBe("A".repeat(32));
    expect(headers.get("x-quickmemo-admin-email-settings")).toBe("1");
    expect(status.active).toMatchObject({
      present: true,
      usernameMasked: "q***@gmail.com",
      host: null,
      port: null,
      securityMode: null
    });
  });

  it("omits App Check only when the client SDK is not configured and leaves enforcement to the server", async () => {
    firebaseMocks.appCheck = null;

    await getAdminEmailSettingsStatus();

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).has("x-firebase-appcheck")).toBe(false);
    expect(firebaseMocks.getAppCheckToken).not.toHaveBeenCalled();
  });

  it("fails closed when configured App Check cannot issue a valid token", async () => {
    firebaseMocks.getAppCheckToken.mockRejectedValueOnce(new Error("unavailable"));

    await expect(getAdminEmailSettingsStatus()).rejects.toMatchObject({
      code: "app_check_unavailable"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the legacy Gmail input compatible while sending the locked transport contract", async () => {
    await stageAdminEmailSettings({
      username: " QuickMemo.Test@Gmail.com ",
      appPassword: "abcd efgh ijkl mnop",
      replyTo: " reply@example.com "
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(request).toMatchObject({
      action: "stage",
      host: "smtp.gmail.com",
      port: 465,
      securityMode: "implicit_tls",
      username: "quickmemo.test@gmail.com",
      appPassword: "abcdefghijklmnop",
      replyTo: "reply@example.com"
    });
    expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(baseSettings)).not.toContain("abcdefghijklmnop");
  });

  it("accepts a Google Workspace school-domain username with required STARTTLS", async () => {
    await stageAdminEmailSettings({
      host: "smtp.gmail.com",
      port: 587,
      securityMode: "starttls",
      username: " QuickMemo@School.Ac.Kr ",
      password: "abcd efgh ijkl mnop"
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      action: "stage",
      host: "smtp.gmail.com",
      port: 587,
      securityMode: "starttls",
      username: "quickmemo@school.ac.kr",
      appPassword: "abcdefghijklmnop"
    });
    expect(request).not.toHaveProperty("password");
  });

  it("preserves a general Outlook SMTP password only in the one-time wire field", async () => {
    const smtpPassword = "Outlook! smtp passphrase 2026";
    await stageAdminEmailSettings({
      host: "smtp-mail.outlook.com",
      port: 587,
      securityMode: "starttls",
      username: " QuickMemo@Outlook.com ",
      password: smtpPassword
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      host: "smtp-mail.outlook.com",
      port: 587,
      securityMode: "starttls",
      username: "quickmemo@outlook.com",
      appPassword: smtpPassword
    });
    expect(request).not.toHaveProperty("password");
    expect(JSON.stringify(baseSettings)).not.toContain(smtpPassword);
  });

  it("rejects untrusted hosts and invalid TLS pairings before making a request", async () => {
    expect(() => stageAdminEmailSettings({
      host: "smtp.attacker.example",
      port: 587,
      securityMode: "starttls",
      username: "admin@example.com",
      password: "long-enough-password"
    })).toThrow(expect.objectContaining({
      code: "invalid_request"
    }));

    expect(() => stageAdminEmailSettings({
      host: "smtp.office365.com",
      port: 465,
      securityMode: "implicit_tls",
      username: "admin@school.ac.kr",
      password: "long-enough-password"
    })).toThrow(expect.objectContaining({
      code: "invalid_request"
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not normalize hyphens or other app-password variants", () => {
    expect(() => stageAdminEmailSettings({
      username: "admin@gmail.com",
      appPassword: "abcd-efgh-ijkl-mnop"
    })).toThrow(expect.objectContaining({
      code: "invalid_request"
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps recent-auth responses without trusting a server-supplied message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: false,
      error: "recent_auth_required",
      message: "untrusted response text"
    }, 401));

    await expect(confirmAdminEmailSettingsTest({
      generation: "pending_012345678",
      code: "123456"
    })).rejects.toEqual(expect.objectContaining<Partial<AdminEmailSettingsError>>({
      code: "recent_auth_required",
      message: "보안을 위해 다시 로그인 후 시도해주세요."
    }));
  });

  it.each([
    ["smtp_auth_failed", "SMTP 인증에 실패했습니다"],
    ["smtp_connection_failed", "SMTP 서버에 연결하지 못했습니다"],
    ["smtp_tls_failed", "SMTP TLS 보안 연결에 실패했습니다"],
    ["smtp_verification_failed", "SMTP 연결을 확인하지 못했습니다"]
  ])("maps %s to bounded guidance without echoing provider detail", async (code, message) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: false,
      error: code,
      message: "smtp.internal.example secret-password 535 private response"
    }, 422));

    const caught = await getAdminEmailSettingsStatus().catch((error: unknown) => error);
    expect(caught).toEqual(expect.objectContaining({
      code,
      message: expect.stringContaining(message)
    }));
    expect((caught as Error).message).not.toContain("smtp.internal.example");
    expect((caught as Error).message).not.toContain("secret-password");
  });

  it("parses bounded integer Retry-After seconds into minute and hour guidance", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: "rate_limited",
        message: "untrusted secret-bearing response"
      }, 429, { "retry-after": "61" }))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: "rate_limited"
      }, 429, { "retry-after": "3601" }));

    await expect(getAdminEmailSettingsStatus()).rejects.toEqual(
      expect.objectContaining<Partial<AdminEmailSettingsError>>({
        code: "rate_limited",
        message: "요청이 너무 많습니다. 약 2분 후 다시 시도해주세요.",
        retryAfterSeconds: 61,
        status: 429
      })
    );
    await expect(getAdminEmailSettingsStatus()).rejects.toEqual(
      expect.objectContaining<Partial<AdminEmailSettingsError>>({
        code: "rate_limited",
        message: "요청이 너무 많습니다. 약 2시간 후 다시 시도해주세요.",
        retryAfterSeconds: 3601,
        status: 429
      })
    );
  });

  it("ignores Retry-After dates and values outside the one-day bound", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: "rate_limited"
      }, 429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: "rate_limited"
      }, 429, { "retry-after": "86401" }));

    for (let request = 0; request < 2; request += 1) {
      const caught = await getAdminEmailSettingsStatus().catch((error: unknown) => error);
      expect(caught).toEqual(expect.objectContaining<Partial<AdminEmailSettingsError>>({
        code: "rate_limited",
        message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
        status: 429
      }));
      expect((caught as AdminEmailSettingsError).retryAfterSeconds).toBeUndefined();
    }
  });

  it("fails closed when the status response contains an unmasked shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      settings: {
        enabled: true,
        active: {
          present: true,
          generation: "active_0123456789",
          usernameMasked: "plain@gmail.com",
          replyToMasked: null
        },
        pending: { present: false }
      }
    }));

    await expect(getAdminEmailSettingsStatus()).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("parses new transport metadata while keeping legacy status responses valid", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      settings: {
        enabled: true,
        active: {
          ...baseSettings.active,
          host: "smtp.office365.com",
          port: 587,
          securityMode: "starttls"
        },
        pending: { present: false }
      }
    }));

    const status = await getAdminEmailSettingsStatus();
    expect(status.active).toMatchObject({
      host: "smtp.office365.com",
      port: 587,
      securityMode: "starttls"
    });
    expect(status.pending).toMatchObject({
      present: false,
      host: null,
      port: null,
      securityMode: null
    });
  });
});
