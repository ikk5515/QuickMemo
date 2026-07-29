import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodemailerMock = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  verify: vi.fn()
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: nodemailerMock.createTransport
  }
}));

import * as gmailSmtpProvider from "../../api/_secure-share-gmail-smtp.js";

const {
  classifyGmailSmtpError,
  createGmailSmtpEmailAdapter,
  resetGmailSmtpTransportForTests
} = gmailSmtpProvider;

type SmtpEnvironment = Record<string, string | undefined>;

interface ProviderError extends Error {
  code?: string;
  deliveryAmbiguous?: boolean;
  expose?: boolean;
  providerBlockedSeconds?: number;
  providerReasonCode?: string;
  responseCode?: number;
  statusCode?: number;
  upstreamStatus?: number;
}

const smtpUsername = "quickmemo.sender@gmail.com";
const smtpAppPassword = "abcdefghijklmnop";
const replyTo = "support@example.com";
const recipient = "viewer@example.com";
const otpText = "QuickMemo 인증 코드: 123456";

function gmailEnvironment(overrides: SmtpEnvironment = {}): SmtpEnvironment {
  return {
    SHARE_EMAIL_CONNECTION_TIMEOUT_MS: "8000",
    SHARE_EMAIL_FREE_TIER_MODE: "true",
    SHARE_EMAIL_FROM: `QuickMemo <${smtpUsername}>`,
    SHARE_EMAIL_FROM_NAME: "QuickMemo",
    SHARE_EMAIL_GREETING_TIMEOUT_MS: "7000",
    SHARE_EMAIL_PROVIDER: "gmail_smtp",
    SHARE_EMAIL_PROVIDER_HEALTH_CACHE_SECONDS: "60",
    SHARE_EMAIL_REPLY_TO: replyTo,
    SHARE_EMAIL_SOCKET_TIMEOUT_MS: "12000",
    SHARE_SMTP_APP_PASSWORD: smtpAppPassword,
    SHARE_SMTP_HOST: "smtp.gmail.com",
    SHARE_SMTP_PORT: "465",
    SHARE_SMTP_REQUIRE_TLS: "false",
    SHARE_SMTP_SECURE: "true",
    SHARE_SMTP_USERNAME: smtpUsername,
    ...overrides
  };
}

function acceptedInfo(overrides: Record<string, unknown> = {}) {
  return {
    accepted: [recipient],
    rejected: [],
    pending: [],
    response: "250 2.0.0 OK",
    messageId: "<quickmemo-message-1@gmail.com>",
    ...overrides
  };
}

function injectedTransport(overrides: {
  close?: ReturnType<typeof vi.fn>;
  sendMail?: ReturnType<typeof vi.fn>;
  verify?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    close: overrides.close ?? vi.fn(),
    sendMail: overrides.sendMail ?? vi.fn().mockResolvedValue(acceptedInfo()),
    verify: overrides.verify ?? vi.fn().mockResolvedValue(true)
  };
}

function defaultTransport() {
  return {
    close: nodemailerMock.close,
    sendMail: nodemailerMock.sendMail,
    verify: nodemailerMock.verify
  };
}

function thrownProviderError(operation: Promise<unknown>): Promise<ProviderError> {
  return operation.then(
    () => {
      throw new Error("Expected provider operation to reject");
    },
    (error: unknown) => error as ProviderError
  );
}

function errorSurface(error: ProviderError): string {
  const descriptorValues = Object.values(Object.getOwnPropertyDescriptors(error))
    .map((descriptor) => String(descriptor.value ?? ""));
  return [
    String(error),
    error.message,
    error.stack ?? "",
    JSON.stringify(error),
    ...descriptorValues
  ].join("\n");
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  resetGmailSmtpTransportForTests();
  nodemailerMock.close.mockReset();
  nodemailerMock.createTransport.mockReset();
  nodemailerMock.sendMail.mockReset();
  nodemailerMock.verify.mockReset();
  nodemailerMock.sendMail.mockResolvedValue(acceptedInfo());
  nodemailerMock.verify.mockResolvedValue(true);
  nodemailerMock.createTransport.mockReturnValue(defaultTransport());
});

afterEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  resetGmailSmtpTransportForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Gmail SMTP configuration", () => {
  it.each([
    {
      label: "implicit TLS on port 465",
      environment: gmailEnvironment(),
      expected: {
        port: 465,
        requireTLS: false,
        secure: true
      }
    },
    {
      label: "STARTTLS on port 587",
      environment: gmailEnvironment({
        SHARE_SMTP_PORT: "587",
        SHARE_SMTP_REQUIRE_TLS: "true",
        SHARE_SMTP_SECURE: "false"
      }),
      expected: {
        port: 587,
        requireTLS: true,
        secure: false
      }
    }
  ])("uses the locked Gmail transport for $label", ({ environment, expected }) => {
    const transport = injectedTransport();
    const createTransport = vi.fn(() => transport);

    createGmailSmtpEmailAdapter({ createTransport, environment });

    expect(createTransport).toHaveBeenCalledExactlyOnceWith({
      host: "smtp.gmail.com",
      port: expected.port,
      secure: expected.secure,
      requireTLS: expected.requireTLS,
      pool: false,
      auth: {
        user: smtpUsername,
        pass: smtpAppPassword
      },
      tls: {
        servername: "smtp.gmail.com",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2"
      },
      connectionTimeout: 8_000,
      greetingTimeout: 7_000,
      socketTimeout: 12_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  });

  it.each([
    ["missing Gmail host", { SHARE_SMTP_HOST: undefined }],
    ["non-Gmail host", { SHARE_SMTP_HOST: "smtp.example.com" }],
    ["port 465 without implicit TLS", { SHARE_SMTP_SECURE: "false" }],
    [
      "port 587 without mandatory STARTTLS",
      {
        SHARE_SMTP_PORT: "587",
        SHARE_SMTP_REQUIRE_TLS: "false",
        SHARE_SMTP_SECURE: "false"
      }
    ],
    [
      "port 587 with implicit TLS",
      {
        SHARE_SMTP_PORT: "587",
        SHARE_SMTP_REQUIRE_TLS: "true",
        SHARE_SMTP_SECURE: "true"
      }
    ],
    ["unsupported SMTP port", { SHARE_SMTP_PORT: "25" }],
    ["missing SMTP username", { SHARE_SMTP_USERNAME: undefined }],
    ["non-Gmail username", { SHARE_SMTP_USERNAME: "sender@example.com" }],
    [
      "SMTP username header injection",
      { SHARE_SMTP_USERNAME: "quickmemo.sender@gmail.com\r\nMAIL FROM:<attacker@example.com>" }
    ],
    ["missing app password", { SHARE_SMTP_APP_PASSWORD: undefined }],
    ["short app password", { SHARE_SMTP_APP_PASSWORD: "short-password" }],
    ["spaced app password", { SHARE_SMTP_APP_PASSWORD: "abcd efgh ijkl mnop" }],
    ["missing From address", { SHARE_EMAIL_FROM: undefined }],
    [
      "From address different from the authenticated Gmail account",
      { SHARE_EMAIL_FROM: "QuickMemo <different@gmail.com>" }
    ],
    [
      "From header injection",
      { SHARE_EMAIL_FROM: `QuickMemo <${smtpUsername}>\r\nBcc: attacker@example.com` }
    ],
    ["non-QuickMemo From name", { SHARE_EMAIL_FROM_NAME: "QuickMemo Support" }],
    [
      "reply-to on the application hosting domain",
      { SHARE_EMAIL_REPLY_TO: "reply@quickmemo-tan.vercel.app" }
    ],
    [
      "reply-to header injection",
      { SHARE_EMAIL_REPLY_TO: "support@example.com\r\nBcc: attacker@example.com" }
    ],
    ["non-Gmail provider", { SHARE_EMAIL_PROVIDER: "resend" }],
    ["free-tier mode disabled", { SHARE_EMAIL_FREE_TIER_MODE: "false" }]
  ])("fails closed for %s", (_label, overrides) => {
    const createTransport = vi.fn(() => injectedTransport());

    expect(() => createGmailSmtpEmailAdapter({
      createTransport,
      environment: gmailEnvironment(overrides)
    })).toThrowError("Gmail SMTP configuration is unavailable");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("does not verify or send while constructing a valid adapter", () => {
    const transport = injectedTransport();
    const createTransport = vi.fn(() => transport);

    const adapter = createGmailSmtpEmailAdapter({
      createTransport,
      environment: gmailEnvironment()
    });

    expect(adapter.provider).toBe("gmail_smtp");
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(transport.verify).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("normalizes the Gmail username, From address, and optional reply-to", async () => {
    const sendMail = vi.fn().mockResolvedValue(acceptedInfo());
    const createTransport = vi.fn(() => injectedTransport({ sendMail }));
    const adapter = createGmailSmtpEmailAdapter({
      createTransport,
      environment: gmailEnvironment({
        SHARE_EMAIL_FROM: "QuickMemo <QUICKMEMO.SENDER@GMAIL.COM>",
        SHARE_EMAIL_REPLY_TO: "SUPPORT@EXAMPLE.COM",
        SHARE_SMTP_USERNAME: "QUICKMEMO.SENDER@GMAIL.COM"
      })
    });

    await adapter.send({ text: otpText, to: recipient });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: {
        name: "QuickMemo",
        address: smtpUsername
      },
      replyTo,
      envelope: {
        from: smtpUsername,
        to: [recipient]
      }
    }));
  });
});

describe("Gmail SMTP transporter lifecycle", () => {
  it("reuses one default transporter for the same configuration and resets it safely", () => {
    const environment = gmailEnvironment();

    createGmailSmtpEmailAdapter({ environment });
    createGmailSmtpEmailAdapter({ environment: { ...environment } });

    expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailerMock.close).not.toHaveBeenCalled();

    resetGmailSmtpTransportForTests();

    expect(nodemailerMock.close).toHaveBeenCalledTimes(1);
    createGmailSmtpEmailAdapter({ environment });
    expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(2);
  });

  it("creates a new default transporter when the transport fingerprint changes", () => {
    createGmailSmtpEmailAdapter({ environment: gmailEnvironment() });
    createGmailSmtpEmailAdapter({
      environment: gmailEnvironment({
        SHARE_SMTP_PORT: "587",
        SHARE_SMTP_REQUIRE_TLS: "true",
        SHARE_SMTP_SECURE: "false"
      })
    });

    expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(2);
  });

  it("caches a successful verify result until its configured expiry", async () => {
    let currentTime = 1_000;
    const adapter = createGmailSmtpEmailAdapter({
      environment: gmailEnvironment({
        SHARE_EMAIL_PROVIDER_HEALTH_CACHE_SECONDS: "30"
      }),
      now: () => currentTime
    });

    await expect(adapter.verifyConfiguration()).resolves.toEqual({
      healthy: true,
      provider: "gmail_smtp",
      cached: false
    });
    await expect(adapter.verifyConfiguration()).resolves.toEqual({
      healthy: true,
      provider: "gmail_smtp",
      cached: true
    });
    expect(nodemailerMock.verify).toHaveBeenCalledTimes(1);

    currentTime += 30_001;
    await expect(adapter.verifyConfiguration()).resolves.toEqual({
      healthy: true,
      provider: "gmail_smtp",
      cached: false
    });
    expect(nodemailerMock.verify).toHaveBeenCalledTimes(2);
  });

  it("does not share verify health cache across injected transports", async () => {
    const firstVerify = vi.fn().mockResolvedValue(true);
    const secondVerify = vi.fn().mockResolvedValue(true);
    const first = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ verify: firstVerify })),
      environment: gmailEnvironment()
    });
    const second = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ verify: secondVerify })),
      environment: gmailEnvironment()
    });

    await expect(first.verifyConfiguration()).resolves.toMatchObject({ cached: false });
    await expect(first.verifyConfiguration()).resolves.toMatchObject({ cached: false });
    await expect(second.verifyConfiguration()).resolves.toMatchObject({ cached: false });
    expect(firstVerify).toHaveBeenCalledTimes(2);
    expect(secondVerify).toHaveBeenCalledTimes(1);
  });
});

describe("Gmail SMTP delivery contract", () => {
  it("sends one normalized recipient with a fixed plain-text OTP message envelope", async () => {
    const sendMail = vi.fn().mockResolvedValue(acceptedInfo());
    const adapter = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ sendMail })),
      environment: gmailEnvironment()
    });

    await expect(adapter.send({
      text: otpText,
      to: "VIEWER@EXAMPLE.COM"
    })).resolves.toEqual({
      accepted: true,
      messageId: "<quickmemo-message-1@gmail.com>"
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      from: {
        name: "QuickMemo",
        address: smtpUsername
      },
      envelope: {
        from: smtpUsername,
        to: [recipient]
      },
      to: recipient,
      replyTo,
      subject: "QuickMemo 공유 노트 인증번호",
      text: otpText,
      headers: {
        "Auto-Submitted": "auto-generated"
      },
      disableFileAccess: true,
      disableUrlAccess: true
    });
  });

  it.each([
    ["missing accepted recipient", { accepted: [] }],
    ["different accepted recipient", { accepted: ["other@example.com"] }],
    ["multiple accepted recipients", { accepted: [recipient, "other@example.com"] }],
    ["a rejected recipient", { rejected: ["rejected@example.com"] }],
    ["a malformed rejected state", { rejected: "rejected@example.com" }],
    ["a pending recipient", { pending: ["pending@example.com"] }],
    ["a malformed pending state", { pending: "pending@example.com" }],
    ["a non-success SMTP response", { response: "550 5.1.1 rejected" }],
    ["a malformed SMTP response", { response: "250OK" }]
  ])("fails closed for %s", async (_label, infoOverrides) => {
    const sendMail = vi.fn().mockResolvedValue(acceptedInfo(infoOverrides));
    const adapter = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ sendMail })),
      environment: gmailEnvironment()
    });

    await expect(adapter.send({ text: otpText, to: recipient })).rejects.toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: true,
      expose: false,
      providerReasonCode: "permanent_provider_error",
      statusCode: 503
    });
  });

  it.each([
    ["missing message ID", { messageId: "" }],
    ["oversized message ID", { messageId: "m".repeat(999) }],
    ["message ID with a control character", { messageId: "message\r\ninjection" }]
  ])("treats %s as an ambiguous accepted delivery", async (_label, infoOverrides) => {
    const sendMail = vi.fn().mockResolvedValue(acceptedInfo(infoOverrides));
    const adapter = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ sendMail })),
      environment: gmailEnvironment()
    });

    await expect(adapter.send({ text: otpText, to: recipient })).rejects.toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: true,
      expose: false,
      providerReasonCode: "ambiguous_delivery",
      statusCode: 503
    });
  });
});

describe("Gmail SMTP failure classification and redaction", () => {
  it.each([
    [
      "authentication failure",
      { code: "EAUTH", responseCode: 535 },
      {
        blockedSeconds: 86_400,
        deliveryAmbiguous: false,
        reasonCode: "auth_error",
        responseCode: 535
      }
    ],
    [
      "TLS failure",
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      {
        blockedSeconds: 600,
        deliveryAmbiguous: false,
        reasonCode: "tls_error",
        responseCode: 0
      }
    ],
    [
      "pre-DATA timeout",
      { code: "ETIMEDOUT", command: "CONN" },
      {
        blockedSeconds: 300,
        deliveryAmbiguous: false,
        reasonCode: "timeout",
        responseCode: 0
      }
    ],
    [
      "post-DATA timeout",
      { code: "ETIMEDOUT", command: "DATA" },
      {
        blockedSeconds: 60,
        deliveryAmbiguous: true,
        reasonCode: "ambiguous_delivery",
        responseCode: 0
      }
    ],
    [
      "Gmail temporary rate limit",
      { responseCode: 421 },
      {
        blockedSeconds: 3_600,
        deliveryAmbiguous: false,
        reasonCode: "rate_limited",
        responseCode: 421
      }
    ],
    [
      "Gmail quota rejection",
      { responseCode: 454 },
      {
        blockedSeconds: 3_600,
        deliveryAmbiguous: false,
        reasonCode: "quota_exceeded",
        responseCode: 454
      }
    ],
    [
      "Gmail daily quota rejection",
      {
        command: "DATA",
        response: "550 5.4.5 Daily user sending limit exceeded",
        responseCode: 550
      },
      {
        blockedSeconds: 86_400,
        deliveryAmbiguous: false,
        reasonCode: "quota_exceeded",
        responseCode: 550
      }
    ],
    [
      "invalid recipient",
      { command: "DATA", responseCode: 550 },
      {
        blockedSeconds: 0,
        deliveryAmbiguous: false,
        reasonCode: "invalid_recipient",
        responseCode: 550
      }
    ],
    [
      "pre-DATA connection failure",
      { code: "ECONNECTION", command: "CONN" },
      {
        blockedSeconds: 300,
        deliveryAmbiguous: false,
        reasonCode: "connection_error",
        responseCode: 0
      }
    ],
    [
      "post-DATA connection failure",
      { code: "ECONNECTION", command: "DOT" },
      {
        blockedSeconds: 300,
        deliveryAmbiguous: true,
        reasonCode: "ambiguous_delivery",
        responseCode: 0
      }
    ],
    [
      "other transient SMTP response",
      { responseCode: 452 },
      {
        blockedSeconds: 600,
        deliveryAmbiguous: false,
        reasonCode: "temporary_provider_error",
        responseCode: 452
      }
    ],
    [
      "unknown post-DATA provider failure",
      { command: "DATA", responseCode: 554 },
      {
        blockedSeconds: 60,
        deliveryAmbiguous: true,
        reasonCode: "ambiguous_delivery",
        responseCode: 554
      }
    ]
  ])("classifies %s without provider prose", (_label, input, expected) => {
    expect(classifyGmailSmtpError(input)).toEqual(expected);
  });

  it("converts verify errors into a sanitized provider error", async () => {
    const rawEmail = "private.viewer@example.com";
    const rawOtp = "654321";
    const verify = vi.fn().mockRejectedValue(Object.assign(
      new Error(`SMTP rejected ${smtpAppPassword} ${rawEmail} ${rawOtp}`),
      {
        code: "EAUTH",
        response: `535 ${smtpAppPassword} ${rawEmail} ${rawOtp}`,
        responseCode: 535
      }
    ));
    const adapter = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ verify })),
      environment: gmailEnvironment()
    });

    const error = await thrownProviderError(adapter.verifyConfiguration());

    expect(error).toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: false,
      expose: false,
      providerBlockedSeconds: 86_400,
      providerReasonCode: "auth_error",
      statusCode: 503,
      upstreamStatus: 535
    });
    const exposed = errorSurface(error);
    expect(exposed).not.toContain(smtpAppPassword);
    expect(exposed).not.toContain(rawEmail);
    expect(exposed).not.toContain(rawOtp);
  });

  it("converts post-DATA send errors into a sanitized ambiguous error", async () => {
    const rawEmail = "private.viewer@example.com";
    const rawOtp = "987654";
    const sendMail = vi.fn().mockRejectedValue(Object.assign(
      new Error(`socket lost after ${rawEmail} ${rawOtp} ${smtpAppPassword}`),
      {
        code: "ESOCKET",
        command: "DATA",
        response: `421 ${rawEmail} ${rawOtp} ${smtpAppPassword}`,
        responseCode: 421
      }
    ));
    const adapter = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ sendMail })),
      environment: gmailEnvironment()
    });

    const error = await thrownProviderError(adapter.send({
      text: `QuickMemo 인증 코드: ${rawOtp}`,
      to: rawEmail
    }));

    expect(error).toMatchObject({
      code: "email_feature_unavailable",
      deliveryAmbiguous: true,
      expose: false,
      providerBlockedSeconds: 3_600,
      providerReasonCode: "rate_limited",
      statusCode: 503,
      upstreamStatus: 421
    });
    const exposed = errorSurface(error);
    expect(exposed).not.toContain(smtpAppPassword);
    expect(exposed).not.toContain(rawEmail);
    expect(exposed).not.toContain(rawOtp);
  });

  it("turns a send timeout race into a sanitized ambiguous result", async () => {
    vi.useFakeTimers();
    const rawEmail = "timeout.viewer@example.com";
    const rawOtp = "112233";
    const sendMail = vi.fn(() => new Promise(() => undefined));
    const adapter = createGmailSmtpEmailAdapter({
      createTransport: vi.fn(() => injectedTransport({ sendMail })),
      environment: gmailEnvironment()
    });

    try {
      const operation = adapter.send({
        text: `QuickMemo 인증 코드: ${rawOtp}`,
        timeoutMilliseconds: 25,
        to: rawEmail
      });
      await vi.advanceTimersByTimeAsync(25);
      const error = await thrownProviderError(operation);

      expect(error).toMatchObject({
        code: "email_feature_unavailable",
        deliveryAmbiguous: true,
        expose: false,
        providerBlockedSeconds: 60,
        providerReasonCode: "ambiguous_delivery",
        statusCode: 503
      });
      expect(error.upstreamStatus).toBeUndefined();
      expect(sendMail).toHaveBeenCalledTimes(1);
      const exposed = errorSurface(error);
      expect(exposed).not.toContain(smtpAppPassword);
      expect(exposed).not.toContain(rawEmail);
      expect(exposed).not.toContain(rawOtp);
    } finally {
      vi.useRealTimers();
    }
  });
});
