/* global Buffer */

import { EventEmitter } from "node:events";
import { setImmediate as scheduleImmediate } from "node:timers";
import { describe, expect, it, vi } from "vitest";
import {
  imapMailboxConfiguration,
  inspectImapSmokeMessage,
  readSmokeOtpViaImap,
  runGmailSmtpProductionPreflight
} from "./verify-gmail-smtp-production.mjs";

function productionEnvironment(overrides = {}) {
  return {
    SECURE_SHARE_EMAIL_ENABLED: "false",
    SHARE_EMAIL_PROVIDER: "gmail_smtp",
    SHARE_EMAIL_FREE_TIER_MODE: "true",
    SHARE_SMTP_HOST: "smtp.gmail.com",
    SHARE_SMTP_PORT: "465",
    SHARE_SMTP_SECURE: "true",
    SHARE_SMTP_REQUIRE_TLS: "true",
    SHARE_SMTP_USERNAME: "quickmemo.sender@gmail.com",
    SHARE_SMTP_APP_PASSWORD: "abcdefghijklmnop",
    SHARE_EMAIL_FROM: "quickmemo.sender@gmail.com",
    SHARE_EMAIL_FROM_NAME: "QuickMemo",
    SHARE_SMOKE_TEST_EMAIL: "quickmemo.smoke@gmail.com",
    SHARE_SMOKE_MAILBOX_PROVIDER: "imap",
    SHARE_SMOKE_IMAP_HOST: "imap.gmail.com",
    SHARE_SMOKE_IMAP_PORT: "993",
    SHARE_SMOKE_IMAP_SECURE: "true",
    SHARE_SMOKE_IMAP_USERNAME: "quickmemo.smoke@gmail.com",
    SHARE_SMOKE_IMAP_APP_PASSWORD: "ponmlkjihgfedcba",
    ...overrides
  };
}

function successfulDependencies() {
  const verifyConfiguration = vi.fn(async () => ({
    healthy: true,
    provider: "gmail_smtp"
  }));
  const send = vi.fn(async () => ({
    accepted: true,
    messageId: "smoke-message-id"
  }));
  const createEmailAdapter = vi.fn(async () => ({
    provider: "gmail_smtp",
    verifyConfiguration,
    send
  }));
  const mailboxReader = vi.fn(async () => ({
    closed: true,
    extractedOtp: "123456",
    received: true
  }));
  return {
    createEmailAdapter,
    mailboxReader,
    randomBytes: () => Buffer.alloc(18, 7),
    randomInt: () => 123456,
    send,
    verifyConfiguration
  };
}

describe("Gmail SMTP Production preflight", () => {
  it("refuses to run unless the email feature flag is explicitly false", async () => {
    const dependencies = successfulDependencies();
    const result = await runGmailSmtpProductionPreflight({
      ...dependencies,
      environment: productionEnvironment({
        SECURE_SHARE_EMAIL_ENABLED: "true"
      })
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "email_flag_not_false"
    });
    expect(dependencies.createEmailAdapter).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
  });

  it("fails closed before SMTP when receipt credentials are incomplete", async () => {
    const dependencies = successfulDependencies();
    const result = await runGmailSmtpProductionPreflight({
      ...dependencies,
      environment: productionEnvironment({
        SHARE_SMOKE_IMAP_APP_PASSWORD: ""
      })
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "mailbox_credentials_unavailable",
      stages: {
        flagSafe: true,
        mailboxConfigured: false,
        messageSent: false
      }
    });
    expect(dependencies.createEmailAdapter).not.toHaveBeenCalled();
    expect(dependencies.mailboxReader).not.toHaveBeenCalled();
  });

  it("verifies once, sends exactly once, and matches the in-memory OTP receipt", async () => {
    const dependencies = successfulDependencies();
    const result = await runGmailSmtpProductionPreflight({
      ...dependencies,
      environment: productionEnvironment()
    });

    expect(result).toEqual({
      ok: true,
      reason: "gmail_smtp_smoke_verified",
      stages: {
        flagSafe: true,
        mailboxConfigured: true,
        smtpConfigured: true,
        smtpVerified: true,
        messageSent: true,
        receiptVerified: true,
        otpMatched: true,
        mailboxClosed: true
      }
    });
    expect(dependencies.verifyConfiguration).toHaveBeenCalledTimes(1);
    expect(dependencies.send).toHaveBeenCalledTimes(1);
    expect(dependencies.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("인증번호: 123456"),
      to: "quickmemo.smoke@gmail.com"
    }));
    expect(dependencies.mailboxReader).toHaveBeenCalledTimes(1);
    expect(dependencies.mailboxReader).toHaveBeenCalledWith(expect.objectContaining({
      expectedSubject: "QuickMemo 공유 노트 인증번호"
    }));
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("returns fixed reason codes without reflecting credentials or provider responses", async () => {
    const environment = productionEnvironment();
    const rawProviderResponse =
      "535 raw smtp response abcdefghijklmnop quickmemo.sender@gmail.com";
    const result = await runGmailSmtpProductionPreflight({
      environment,
      createEmailAdapter: async () => ({
        provider: "gmail_smtp",
        verifyConfiguration: async () => {
          throw new Error(rawProviderResponse);
        },
        send: vi.fn()
      })
    });
    const serialized = JSON.stringify(result);

    expect(result.reason).toBe("smtp_verify_failed");
    expect(serialized).not.toContain(rawProviderResponse);
    expect(serialized).not.toContain(environment.SHARE_SMTP_APP_PASSWORD);
    expect(serialized).not.toContain(environment.SHARE_SMOKE_IMAP_APP_PASSWORD);
    expect(serialized).not.toContain(environment.SHARE_SMOKE_TEST_EMAIL);
  });

  it("fails safely on verify timeout without sending", async () => {
    const send = vi.fn();
    const result = await runGmailSmtpProductionPreflight({
      environment: productionEnvironment(),
      stageTimeoutMilliseconds: 5,
      createEmailAdapter: async () => ({
        provider: "gmail_smtp",
        verifyConfiguration: () => new Promise(() => {}),
        send
      })
    });

    expect(result.reason).toBe("smtp_verify_timeout");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not retry an SMTP send failure", async () => {
    const dependencies = successfulDependencies();
    dependencies.send.mockRejectedValueOnce(new Error(
      "550 confidential response quickmemo.smoke@gmail.com"
    ));
    const result = await runGmailSmtpProductionPreflight({
      ...dependencies,
      environment: productionEnvironment()
    });

    expect(result.reason).toBe("smtp_send_failed");
    expect(dependencies.send).toHaveBeenCalledTimes(1);
    expect(dependencies.mailboxReader).not.toHaveBeenCalled();
  });

  it("requires a closed receipt reader and an exact OTP match", async () => {
    const dependencies = successfulDependencies();
    dependencies.mailboxReader.mockResolvedValueOnce({
      closed: true,
      extractedOtp: "654321",
      received: true
    });
    const mismatch = await runGmailSmtpProductionPreflight({
      ...dependencies,
      environment: productionEnvironment()
    });
    expect(mismatch.reason).toBe("otp_mismatch");

    const secondDependencies = successfulDependencies();
    secondDependencies.mailboxReader.mockResolvedValueOnce({
      closed: false,
      extractedOtp: "123456",
      received: true
    });
    const unclosed = await runGmailSmtpProductionPreflight({
      ...secondDependencies,
      environment: productionEnvironment()
    });
    expect(unclosed.reason).toBe("mailbox_not_closed");
  });

  it("accepts only the fixed Gmail read-only mailbox configuration", () => {
    expect(imapMailboxConfiguration(productionEnvironment())).toMatchObject({
      host: "imap.gmail.com",
      port: 993,
      recipient: "quickmemo.smoke@gmail.com"
    });
    expect(() => imapMailboxConfiguration(productionEnvironment({
      SHARE_SMOKE_IMAP_HOST: "mail.example.com"
    }))).toThrow();
    expect(() => imapMailboxConfiguration(productionEnvironment({
      SHARE_SMOKE_IMAP_SECURE: "false"
    }))).toThrow();
  });

  it("uses only read-only bounded IMAP commands and always closes", async () => {
    const commands = [];
    const socket = new EventEmitter();
    socket.authorized = true;
    socket.setTimeout = vi.fn();
    socket.end = vi.fn();
    socket.destroy = vi.fn();
    const requestId = "read-only-request-id";
    const messageDate = new Date(Date.now() - 1_000);
    const encodedSubject =
      "=?UTF-8?B?UXVpY2tNZW1vIOqzteycoCDrhbjtirgg7J247Kad67KI7Zi4?=";
    socket.write = vi.fn((line) => {
      const [tag, ...commandParts] = line.trim().split(" ");
      const command = commandParts.join(" ");
      commands.push(command);
      let response;
      if (command.startsWith("LOGIN ")) {
        response = `${tag} OK authenticated\r\n`;
      } else if (command === "EXAMINE \"INBOX\"") {
        response = `* 1 EXISTS\r\n${tag} OK examined\r\n`;
      } else if (command.startsWith("UID SEARCH SINCE ")) {
        response = `* SEARCH 42\r\n${tag} OK searched\r\n`;
      } else if (command.startsWith("UID FETCH 42 (BODY.PEEK[]<0.")) {
        response = [
          "* 1 FETCH (BODY[] {512}",
          `Subject: ${encodedSubject}`,
          `Date: ${messageDate.toUTCString()}`,
          "",
          `Smoke Request ID: ${requestId}`,
          "Verification code: 123456",
          ")",
          `${tag} OK fetched`,
          ""
        ].join("\r\n");
      } else if (command === "LOGOUT") {
        response = `* BYE closing\r\n${tag} OK logout\r\n`;
      } else {
        response = `${tag} BAD unsupported\r\n`;
      }
      scheduleImmediate(() => socket.emit("data", Buffer.from(response)));
      return true;
    });
    const connectTls = vi.fn(() => {
      scheduleImmediate(() => socket.emit("secureConnect"));
      scheduleImmediate(() => {
        socket.emit("data", Buffer.from("* OK Gmail IMAP ready\r\n"));
      });
      return socket;
    });

    const result = await readSmokeOtpViaImap({
      earliestDate: new Date(messageDate.getTime() - 1_000),
      environment: productionEnvironment(),
      requestId
    }, { connectTls });

    expect(result).toEqual({
      closed: true,
      extractedOtp: "123456",
      received: true
    });
    expect(commands).toContain("EXAMINE \"INBOX\"");
    expect(commands.some((command) => command.includes("BODY.PEEK[]"))).toBe(true);
    expect(commands).toContain("LOGOUT");
    expect(commands.join("\n")).not.toMatch(/\b(?:SELECT|STORE|EXPUNGE|DELETE)\b/u);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("identifies a bounded recent fixed-subject message without returning raw mail", () => {
    const messageDate = new Date(Date.now() - 1_000);
    const earliestDate = new Date(messageDate.getTime() - 1_000);
    const rawMessage = [
      "Subject: =?UTF-8?B?UXVpY2tNZW1vIOqzteycoCDrhbjtirgg7J247Kad67KI7Zi4?=",
      `Date: ${messageDate.toUTCString()}`,
      "",
      "Smoke Request ID: request-identifier",
      "Verification code: 123456"
    ].join("\r\n");
    const result = inspectImapSmokeMessage(rawMessage, {
      earliestDate,
      requestId: "request-identifier"
    });

    expect(result).toEqual({ found: true, extractedOtp: "123456" });
    expect(JSON.stringify(result)).not.toContain("Smoke Request ID");
  });
});
