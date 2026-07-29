/* global Buffer, process */

import {
  randomBytes as nodeRandomBytes,
  randomInt as nodeRandomInt,
  timingSafeEqual
} from "node:crypto";
import {
  clearTimeout,
  setTimeout
} from "node:timers";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const smokeSubject = "QuickMemo 공유 노트 인증번호";
const maximumImapMessageBytes = 128 * 1024;
const maximumRecentMessages = 10;
const imapCommandTimeoutMilliseconds = 10_000;
const receiptTimeoutMilliseconds = 30_000;
const stageTimeoutMilliseconds = 20_000;

function environmentValue(environment, name) {
  return typeof environment?.[name] === "string"
    ? environment[name].trim()
    : "";
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactDisabledFlag(environment) {
  return environmentValue(environment, "SECURE_SHARE_EMAIL_ENABLED") === "false";
}

export function imapMailboxConfiguration(environment = process.env) {
  const provider = environmentValue(
    environment,
    "SHARE_SMOKE_MAILBOX_PROVIDER"
  ).toLowerCase();
  const host = environmentValue(environment, "SHARE_SMOKE_IMAP_HOST").toLowerCase();
  const port = Number.parseInt(
    environmentValue(environment, "SHARE_SMOKE_IMAP_PORT"),
    10
  );
  const secure = environmentValue(
    environment,
    "SHARE_SMOKE_IMAP_SECURE"
  ).toLowerCase();
  const username = environmentValue(
    environment,
    "SHARE_SMOKE_IMAP_USERNAME"
  ).toLowerCase();
  const appPassword = environmentValue(
    environment,
    "SHARE_SMOKE_IMAP_APP_PASSWORD"
  );
  const recipient = environmentValue(
    environment,
    "SHARE_SMOKE_TEST_EMAIL"
  ).toLowerCase();
  if (
    provider !== "imap"
    || host !== "imap.gmail.com"
    || port !== 993
    || secure !== "true"
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/u.test(username)
    || !/^[A-Za-z0-9]{16}$/u.test(appPassword)
    || recipient !== username
  ) {
    throw codedError("mailbox_credentials_unavailable");
  }
  return Object.freeze({
    appPassword,
    host,
    port,
    recipient,
    username
  });
}

function withTimeout(promise, milliseconds, code) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(codedError(code)), milliseconds);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function quoteImapString(value) {
  if (!/^[\x20-\x7e]+$/u.test(value)) {
    throw codedError("mailbox_credentials_unavailable");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function imapDate(date) {
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  return `${date.getUTCDate()}-${monthNames[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

class ImapSession {
  constructor(socket, tagPrefix) {
    this.socket = socket;
    this.tagPrefix = tagPrefix;
    this.counter = 0;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.closed = false;
    socket.on("data", (chunk) => {
      if (this.closed) {
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#settleWaiter();
    });
    socket.on("error", () => {
      this.#rejectWaiter("imap_connection_failed");
    });
    socket.on("close", () => {
      this.closed = true;
      this.#rejectWaiter("imap_connection_closed");
    });
  }

  #rejectWaiter(code) {
    if (!this.waiter) {
      return;
    }
    const { reject, timeout } = this.waiter;
    this.waiter = null;
    clearTimeout(timeout);
    reject(codedError(code));
  }

  #settleWaiter() {
    if (!this.waiter) {
      return;
    }
    if (this.buffer.length > this.waiter.maximumBytes) {
      this.#rejectWaiter("imap_response_too_large");
      return;
    }
    const text = this.buffer.toString("utf8");
    const match = this.waiter.pattern.exec(text);
    if (!match) {
      return;
    }
    const resultEnd = match.index + match[0].length;
    const result = this.buffer.subarray(0, resultEnd);
    this.buffer = this.buffer.subarray(resultEnd);
    const { reject, resolve, timeout } = this.waiter;
    this.waiter = null;
    clearTimeout(timeout);
    if (this.waiterStatusRequired && match[1]?.toUpperCase() !== "OK") {
      reject(codedError("imap_command_failed"));
      return;
    }
    resolve(result);
  }

  #wait(pattern, maximumBytes, statusRequired = false) {
    if (this.waiter || this.closed) {
      return Promise.reject(codedError("imap_connection_closed"));
    }
    this.waiterStatusRequired = statusRequired;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiter = null;
        reject(codedError("imap_timeout"));
      }, imapCommandTimeoutMilliseconds);
      this.waiter = {
        maximumBytes,
        pattern,
        reject,
        resolve,
        timeout
      };
      this.#settleWaiter();
    });
  }

  greeting() {
    return this.#wait(/(?:^|\r\n)\* (?:OK|PREAUTH)[^\r\n]*\r\n/u, 16 * 1024);
  }

  async command(command, maximumBytes = 64 * 1024) {
    this.counter += 1;
    const tag = `${this.tagPrefix}${String(this.counter).padStart(3, "0")}`;
    const response = this.#wait(
      new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, "u"),
      maximumBytes,
      true
    );
    this.socket.write(`${tag} ${command}\r\n`, "utf8");
    return response;
  }

  async close() {
    if (this.closed) {
      this.socket.destroy();
      return true;
    }
    try {
      await this.command("LOGOUT", 16 * 1024);
    } catch {
      // A bounded, best-effort LOGOUT is followed by a local close regardless.
    } finally {
      this.closed = true;
      this.socket.end();
      this.socket.destroy();
    }
    return true;
  }
}

async function connectImap(configuration, connectTls) {
  const socket = connectTls({
    host: configuration.host,
    port: configuration.port,
    servername: "imap.gmail.com",
    minVersion: "TLSv1.2",
    rejectUnauthorized: true
  });
  socket.setTimeout?.(imapCommandTimeoutMilliseconds, () => socket.destroy());
  try {
    await withTimeout(new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    }), imapCommandTimeoutMilliseconds, "imap_timeout");
    if (socket.authorized !== true) {
      throw codedError("imap_tls_failed");
    }
  } catch {
    socket.destroy();
    throw codedError("imap_connection_failed");
  }
  const tagPrefix = `QMS${nodeRandomBytes(4).toString("hex").toUpperCase()}`;
  return new ImapSession(socket, tagPrefix);
}

function parseSearchUids(response) {
  const text = response.toString("ascii");
  const line = text.match(/(?:^|\r\n)\* SEARCH(?: ([0-9 ]+))?\r\n/u);
  if (!line) {
    return [];
  }
  return (line[1] ?? "")
    .split(" ")
    .filter((value) => /^[1-9][0-9]*$/u.test(value))
    .slice(-maximumRecentMessages);
}

function decodeQuotedPrintable(value) {
  const unfolded = value.replaceAll(/=\r?\n/gu, "");
  const bytes = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    if (
      unfolded[index] === "="
      && /^[0-9A-Fa-f]{2}$/u.test(unfolded.slice(index + 1, index + 3))
    ) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeMimeWords(value) {
  return value.replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/gu,
    (_match, charset, encoding, content) => {
      if (!/^utf-?8$/iu.test(charset)) {
        return "";
      }
      try {
        return encoding.toLowerCase() === "b"
          ? Buffer.from(content, "base64").toString("utf8")
          : decodeQuotedPrintable(content.replaceAll("_", " "));
      } catch {
        return "";
      }
    }
  );
}

function unfoldedHeader(rawMessage, name) {
  const headerBlock = rawMessage.split(/\r?\n\r?\n/u, 1)[0] ?? "";
  const unfolded = headerBlock.replaceAll(/\r?\n[ \t]+/gu, " ");
  const match = unfolded.match(new RegExp(`(?:^|\\r?\\n)${name}:\\s*([^\\r\\n]+)`, "iu"));
  return match ? match[1].trim() : "";
}

function decodedMessageCandidates(rawMessage) {
  const candidates = [rawMessage, decodeQuotedPrintable(rawMessage)];
  const base64Blocks = rawMessage.match(/(?:^|\r?\n)(?:[A-Za-z0-9+/]{20,}={0,2}\r?\n){1,256}/gu)
    ?? [];
  for (const block of base64Blocks.slice(0, 4)) {
    const compact = block.replaceAll(/\s/gu, "");
    if (compact.length > maximumImapMessageBytes * 2) {
      continue;
    }
    try {
      candidates.push(Buffer.from(compact, "base64").toString("utf8"));
    } catch {
      // Ignore malformed MIME parts without exposing their content.
    }
  }
  return candidates;
}

export function inspectImapSmokeMessage(rawMessage, {
  earliestDate,
  expectedSubject = smokeSubject,
  requestId
}) {
  if (
    typeof rawMessage !== "string"
    || Buffer.byteLength(rawMessage, "utf8") > maximumImapMessageBytes
  ) {
    return { found: false };
  }
  const subject = decodeMimeWords(unfoldedHeader(rawMessage, "Subject"));
  const messageDate = Date.parse(unfoldedHeader(rawMessage, "Date"));
  if (
    subject !== expectedSubject
    || !Number.isFinite(messageDate)
    || messageDate < earliestDate.getTime() - 2 * 60 * 1000
    || messageDate > Date.now() + 5 * 60 * 1000
  ) {
    return { found: false };
  }
  for (const candidate of decodedMessageCandidates(rawMessage)) {
    if (!candidate.includes(requestId)) {
      continue;
    }
    const otpMatch = candidate.match(/(?:인증번호|Verification code)\s*:\s*([0-9]{6})/u);
    if (otpMatch) {
      return { found: true, extractedOtp: otpMatch[1] };
    }
  }
  return { found: false };
}

export async function readSmokeOtpViaImap({
  earliestDate,
  environment = process.env,
  expectedSubject = smokeSubject,
  requestId
}, dependencies = {}) {
  const configuration = imapMailboxConfiguration(environment);
  const connectTls = dependencies.connectTls ?? tls.connect;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + receiptTimeoutMilliseconds;
  let session;
  let closed = false;
  try {
    session = await connectImap(configuration, connectTls);
    await session.greeting();
    await session.command(
      `LOGIN ${quoteImapString(configuration.username)} ${quoteImapString(configuration.appPassword)}`,
      16 * 1024
    );
    await session.command("EXAMINE \"INBOX\"", 32 * 1024);
    while (now() < deadline) {
      const searchResponse = await session.command(
        `UID SEARCH SINCE ${imapDate(earliestDate)}`,
        32 * 1024
      );
      const uids = parseSearchUids(searchResponse);
      for (const uid of uids.reverse()) {
        const fetchResponse = await session.command(
          `UID FETCH ${uid} (BODY.PEEK[]<0.${maximumImapMessageBytes}>)`,
          maximumImapMessageBytes + 16 * 1024
        );
        const inspection = inspectImapSmokeMessage(
          fetchResponse.toString("utf8"),
          { earliestDate, expectedSubject, requestId }
        );
        if (inspection.found) {
          return {
            closed: true,
            extractedOtp: inspection.extractedOtp,
            received: true
          };
        }
      }
      await sleep(Math.min(2_000, Math.max(deadline - now(), 0)));
    }
    throw codedError("receipt_timeout");
  } finally {
    if (session) {
      closed = await session.close();
    }
    if (!closed && session) {
      session.socket.destroy();
    }
  }
}

function safeStages(overrides = {}) {
  return {
    flagSafe: false,
    mailboxConfigured: false,
    smtpConfigured: false,
    smtpVerified: false,
    messageSent: false,
    receiptVerified: false,
    otpMatched: false,
    mailboxClosed: false,
    ...overrides
  };
}

function safeFailure(reason, stages) {
  return { ok: false, reason, stages: safeStages(stages) };
}

function sameOtp(actual, expected) {
  if (
    typeof actual !== "string"
    || typeof expected !== "string"
    || actual.length !== expected.length
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
}

async function defaultCreateEmailAdapter(environment) {
  const { createGmailSmtpEmailAdapter } = await import(
    "../api/_secure-share-gmail-smtp.js"
  );
  return createGmailSmtpEmailAdapter({ environment });
}

export async function runGmailSmtpProductionPreflight(options = {}) {
  const environment = options.environment ?? process.env;
  const createEmailAdapter =
    options.createEmailAdapter ?? defaultCreateEmailAdapter;
  const mailboxReader = options.mailboxReader ?? readSmokeOtpViaImap;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const randomInt = options.randomInt ?? nodeRandomInt;
  const timeoutMilliseconds =
    options.stageTimeoutMilliseconds ?? stageTimeoutMilliseconds;
  let stages = safeStages();

  if (!exactDisabledFlag(environment)) {
    return safeFailure("email_flag_not_false", stages);
  }
  stages = safeStages({ ...stages, flagSafe: true });

  try {
    imapMailboxConfiguration(environment);
    stages.mailboxConfigured = true;
  } catch {
    return safeFailure("mailbox_credentials_unavailable", stages);
  }

  let adapter;
  try {
    adapter = await createEmailAdapter(environment);
    if (
      adapter?.provider !== "gmail_smtp"
      || typeof adapter.verifyConfiguration !== "function"
      || typeof adapter.send !== "function"
    ) {
      return safeFailure("smtp_configuration_invalid", stages);
    }
    stages.smtpConfigured = true;
  } catch {
    return safeFailure("smtp_configuration_invalid", stages);
  }

  try {
    const verification = await withTimeout(
      Promise.resolve(adapter.verifyConfiguration()),
      timeoutMilliseconds,
      "smtp_verify_timeout"
    );
    if (verification?.healthy !== true || verification?.provider !== "gmail_smtp") {
      return safeFailure("smtp_verify_failed", stages);
    }
    stages.smtpVerified = true;
  } catch (error) {
    return safeFailure(
      error?.code === "smtp_verify_timeout"
        ? "smtp_verify_timeout"
        : "smtp_verify_failed",
      stages
    );
  }

  let otp;
  let requestId;
  let startedAt;
  let recipient;
  try {
    otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
    requestId = randomBytes(18).toString("base64url");
    startedAt = new Date();
    recipient = environmentValue(
      environment,
      "SHARE_SMOKE_TEST_EMAIL"
    ).toLowerCase();
  } catch {
    return safeFailure("smoke_message_generation_failed", stages);
  }
  const text = [
    "QuickMemo 공유 노트를 열기 위한 인증번호입니다.",
    `인증번호: ${otp}`,
    "이 인증번호는 10분 동안 유효합니다.",
    "본인이 요청하지 않았다면 이 메일을 무시하세요.",
    `Smoke Request ID: ${requestId}`,
    "서비스 주소: quickmemo-tan.vercel.app"
  ].join("\n\n");

  try {
    const delivery = await withTimeout(
      Promise.resolve(adapter.send({
        text,
        timeoutMilliseconds,
        to: recipient
      })),
      timeoutMilliseconds,
      "smtp_send_timeout"
    );
    if (delivery?.accepted !== true) {
      return safeFailure("smtp_send_failed", stages);
    }
    stages.messageSent = true;
  } catch (error) {
    return safeFailure(
      error?.code === "smtp_send_timeout"
        ? "smtp_send_timeout"
        : "smtp_send_failed",
      stages
    );
  }

  try {
    const receipt = await withTimeout(
      Promise.resolve(mailboxReader({
        earliestDate: startedAt,
        environment,
        expectedSubject: smokeSubject,
        requestId
      })),
      receiptTimeoutMilliseconds + timeoutMilliseconds,
      "receipt_timeout"
    );
    stages.mailboxClosed = receipt?.closed === true;
    if (receipt?.received !== true) {
      return safeFailure("receipt_not_found", stages);
    }
    stages.receiptVerified = true;
    if (!sameOtp(receipt.extractedOtp, otp)) {
      return safeFailure("otp_mismatch", stages);
    }
    stages.otpMatched = true;
    if (!stages.mailboxClosed) {
      return safeFailure("mailbox_not_closed", stages);
    }
  } catch (error) {
    return safeFailure(
      error?.code === "receipt_timeout"
        ? "receipt_timeout"
        : "receipt_failed",
      stages
    );
  }

  return { ok: true, reason: "gmail_smtp_smoke_verified", stages };
}

async function main() {
  let result;
  try {
    result = await runGmailSmtpProductionPreflight();
  } catch {
    result = safeFailure("preflight_internal_error");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
