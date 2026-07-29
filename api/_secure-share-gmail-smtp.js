/* global Buffer, process */

import nodemailer from "nodemailer";
import {
  clearTimeout as clearNodeTimeout,
  setTimeout as scheduleNodeTimeout
} from "node:timers";
import {
  HttpError,
  gmailSmtpConfiguration,
  normalizeEmail,
  sha256Digest
} from "./_secure-share-common.js";

const smtpProviderName = "gmail_smtp";
const successfulSmtpResponsePattern = /^2\d\d(?:\s|-)/u;
const safeReasonCodes = new Set([
  "ambiguous_delivery",
  "auth_error",
  "configuration_error",
  "connection_error",
  "invalid_recipient",
  "permanent_provider_error",
  "quota_exceeded",
  "rate_limited",
  "temporary_provider_error",
  "timeout",
  "tls_error"
]);

let cachedTransporter = null;
let cachedTransporterFingerprint = "";
let cachedHealthFingerprint = "";
let cachedHealthUntil = 0;

function safeProperty(value, name) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    return value[name];
  } catch {
    return undefined;
  }
}

function smtpFailure(reasonCode, options = {}) {
  const error = new HttpError(
    503,
    "email_feature_unavailable",
    "Gmail SMTP delivery is unavailable",
    {
      deliveryAmbiguous: options.deliveryAmbiguous === true,
      expose: false,
      upstreamStatus: Number.isInteger(options.responseCode)
        ? options.responseCode
        : undefined
    }
  );
  error.providerReasonCode = safeReasonCodes.has(reasonCode)
    ? reasonCode
    : "permanent_provider_error";
  error.providerBlockedSeconds = Number.isSafeInteger(options.blockedSeconds)
    ? Math.min(Math.max(options.blockedSeconds, 0), 24 * 60 * 60)
    : 0;
  return error;
}

export function classifyGmailSmtpError(error) {
  const codeValue = safeProperty(error, "code");
  const code = typeof codeValue === "string" ? codeValue.toUpperCase() : "";
  const commandValue = safeProperty(error, "command");
  const command = typeof commandValue === "string" ? commandValue.toUpperCase() : "";
  const responseCodeValue = safeProperty(error, "responseCode");
  const responseCode = Number.isInteger(responseCodeValue) ? responseCodeValue : 0;
  const responseValue = safeProperty(error, "response");
  const response = typeof responseValue === "string"
    ? responseValue.toLowerCase()
    : "";
  const deliveryAmbiguous =
    command === "DATA"
    || command === "DOT"
    || safeProperty(error, "deliveryAmbiguous") === true;

  if (code === "EAUTH" || responseCode === 534 || responseCode === 535) {
    return {
      blockedSeconds: 24 * 60 * 60,
      deliveryAmbiguous: false,
      reasonCode: "auth_error",
      responseCode
    };
  }
  if (code === "ETLS" || code === "CERT_HAS_EXPIRED" || code.startsWith("ERR_TLS")) {
    return {
      blockedSeconds: 10 * 60,
      deliveryAmbiguous: false,
      reasonCode: "tls_error",
      responseCode
    };
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return {
      blockedSeconds: deliveryAmbiguous ? 60 : 5 * 60,
      deliveryAmbiguous,
      reasonCode: deliveryAmbiguous ? "ambiguous_delivery" : "timeout",
      responseCode
    };
  }
  if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 454) {
    return {
      blockedSeconds: 60 * 60,
      deliveryAmbiguous,
      reasonCode: responseCode === 454 ? "quota_exceeded" : "rate_limited",
      responseCode
    };
  }
  if (
    new Set([452, 550, 552]).has(responseCode)
    && (
      /\b5\.4\.5\b/u.test(response)
      || /\bdaily user sending limit\b/u.test(response)
      || /\bquota\b/u.test(response)
      || /\btoo many messages\b/u.test(response)
    )
  ) {
    return {
      blockedSeconds: 24 * 60 * 60,
      deliveryAmbiguous: false,
      reasonCode: "quota_exceeded",
      responseCode
    };
  }
  if (responseCode === 550 || responseCode === 551 || responseCode === 553) {
    return {
      blockedSeconds: 0,
      deliveryAmbiguous: false,
      reasonCode: "invalid_recipient",
      responseCode
    };
  }
  if (code === "EDNS" || code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ESOCKET") {
    return {
      blockedSeconds: 5 * 60,
      deliveryAmbiguous,
      reasonCode: deliveryAmbiguous ? "ambiguous_delivery" : "connection_error",
      responseCode
    };
  }
  if (responseCode >= 400 && responseCode < 500) {
    return {
      blockedSeconds: 10 * 60,
      deliveryAmbiguous,
      reasonCode: deliveryAmbiguous ? "ambiguous_delivery" : "temporary_provider_error",
      responseCode
    };
  }
  return {
    blockedSeconds: deliveryAmbiguous ? 60 : 10 * 60,
    deliveryAmbiguous,
    reasonCode: deliveryAmbiguous ? "ambiguous_delivery" : "permanent_provider_error",
    responseCode
  };
}

function transporterFingerprint(configuration) {
  return sha256Digest([
    configuration.host,
    configuration.port,
    configuration.secure,
    configuration.requireTls,
    configuration.username,
    configuration.appPassword
  ].join("\u0000"));
}

function transporterOptions(configuration) {
  return {
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    requireTLS: configuration.port === 587,
    pool: false,
    auth: {
      user: configuration.username,
      pass: configuration.appPassword
    },
    tls: {
      servername: "smtp.gmail.com",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    },
    connectionTimeout: configuration.connectionTimeout,
    greetingTimeout: configuration.greetingTimeout,
    socketTimeout: configuration.socketTimeout,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true
  };
}

function transporterFor(configuration, createTransport) {
  const fingerprint = transporterFingerprint(configuration);
  if (
    createTransport === nodemailer.createTransport
    && cachedTransporter
    && cachedTransporterFingerprint === fingerprint
  ) {
    return { fingerprint, transporter: cachedTransporter };
  }
  const transporter = createTransport(transporterOptions(configuration));
  if (
    !transporter
    || typeof transporter.sendMail !== "function"
    || typeof transporter.verify !== "function"
  ) {
    throw smtpFailure("configuration_error");
  }
  if (createTransport === nodemailer.createTransport) {
    cachedTransporter = transporter;
    cachedTransporterFingerprint = fingerprint;
    cachedHealthFingerprint = "";
    cachedHealthUntil = 0;
  }
  return { fingerprint, transporter };
}

function normalizedMailboxList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = [];
  for (const value of values) {
    try {
      normalized.push(normalizeEmail(String(value)));
    } catch {
      return [];
    }
  }
  return normalized;
}

function acceptedDelivery(info, recipient) {
  const acceptedValues = safeProperty(info, "accepted");
  const rejectedValues = safeProperty(info, "rejected");
  const pending = safeProperty(info, "pending");
  const response = safeProperty(info, "response");
  if (
    !Array.isArray(acceptedValues)
    || !Array.isArray(rejectedValues)
    || rejectedValues.length !== 0
  ) {
    return false;
  }
  const accepted = normalizedMailboxList(acceptedValues);
  const hasNoPendingRecipients =
    pending === undefined
    || (Array.isArray(pending) && pending.length === 0);
  return (
    accepted.length === 1
    && accepted[0] === recipient
    && hasNoPendingRecipients
    && typeof response === "string"
    && successfulSmtpResponsePattern.test(response)
  );
}

export function createGmailSmtpEmailAdapter(options = {}) {
  const environment = options.environment ?? process.env;
  const configuration = gmailSmtpConfiguration(environment);
  const createTransport = options.createTransport ?? nodemailer.createTransport;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const { fingerprint, transporter } = transporterFor(configuration, createTransport);

  return {
    provider: smtpProviderName,
    async verifyConfiguration() {
      const currentTime = now();
      if (
        createTransport === nodemailer.createTransport
        && cachedHealthFingerprint === fingerprint
        && cachedHealthUntil > currentTime
      ) {
        return { healthy: true, provider: smtpProviderName, cached: true };
      }
      try {
        const verified = await transporter.verify();
        if (verified !== true) {
          throw smtpFailure("configuration_error");
        }
        if (createTransport === nodemailer.createTransport) {
          cachedHealthFingerprint = fingerprint;
          cachedHealthUntil = currentTime + configuration.healthCacheSeconds * 1000;
        }
        return { healthy: true, provider: smtpProviderName, cached: false };
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        const classification = classifyGmailSmtpError(error);
        throw smtpFailure(classification.reasonCode, classification);
      }
    },
    async send({ text, timeoutMilliseconds, to }) {
      let recipient;
      try {
        recipient = normalizeEmail(to);
      } catch {
        throw smtpFailure("configuration_error");
      }
      if (
        typeof text !== "string"
        || text.length < 1
        || Buffer.byteLength(text, "utf8") > 16 * 1024
      ) {
        throw smtpFailure("configuration_error");
      }
      try {
        const sendPromise = transporter.sendMail({
          from: {
            name: configuration.fromName,
            address: configuration.fromAddress
          },
          envelope: {
            from: configuration.username,
            to: [recipient]
          },
          to: recipient,
          replyTo: configuration.replyTo || undefined,
          subject: "QuickMemo 공유 노트 인증번호",
          text,
          headers: {
            "Auto-Submitted": "auto-generated"
          },
          disableFileAccess: true,
          disableUrlAccess: true
        });
        const boundedTimeout = Number.isSafeInteger(timeoutMilliseconds)
          ? Math.min(Math.max(timeoutMilliseconds, 1), 15_000)
          : 15_000;
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = scheduleNodeTimeout(() => {
            reject(smtpFailure("ambiguous_delivery", {
              blockedSeconds: 60,
              deliveryAmbiguous: true
            }));
          }, boundedTimeout);
          timeoutHandle.unref?.();
        });
        let info;
        try {
          info = await Promise.race([sendPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearNodeTimeout(timeoutHandle);
          }
        }
        if (!acceptedDelivery(info, recipient)) {
          throw smtpFailure("permanent_provider_error", {
            deliveryAmbiguous: true
          });
        }
        const messageId = safeProperty(info, "messageId");
        const messageIdHasControlCharacter = typeof messageId === "string"
          && Array.from(messageId).some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
          });
        if (
          typeof messageId !== "string"
          || messageId.length < 3
          || messageId.length > 998
          || messageIdHasControlCharacter
        ) {
          throw smtpFailure("ambiguous_delivery", {
            deliveryAmbiguous: true
          });
        }
        return { accepted: true, messageId };
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        const classification = classifyGmailSmtpError(error);
        throw smtpFailure(classification.reasonCode, classification);
      }
    }
  };
}

export function resetGmailSmtpTransportForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Gmail SMTP transport reset is restricted to tests");
  }
  if (cachedTransporter && typeof cachedTransporter.close === "function") {
    cachedTransporter.close();
  }
  cachedTransporter = null;
  cachedTransporterFingerprint = "";
  cachedHealthFingerprint = "";
  cachedHealthUntil = 0;
}
