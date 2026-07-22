/* global chrome, crypto, TextEncoder, URL, btoa, setTimeout */

"use strict";

const QUICKMEMO_ORIGIN = "__QUICKMEMO_ORIGIN__";
const STORAGE_PREFIX = "quickmemo.libraryCapture.";
const ALARM_PREFIX = "quickmemo.libraryCaptureExpiry.";
const CAPTURE_TTL_MILLISECONDS = 2 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_TITLE_CHARACTERS = 300;
const MAX_URL_CHARACTERS = 4096;
const MAX_SELECTION_CHARACTERS = 100000;
const MAX_BLOCKS = 400;
const MAX_BLOCK_CHARACTERS = 12000;
const MAX_BLOCK_CHARACTERS_TOTAL = 350000;
const ROOT_KEYS = new Set(["version", "source", "title", "url", "selectionText", "blocks", "capturedAt"]);
const BLOCK_KEYS = new Set(["kind", "text"]);
const MESSAGE_KEYS = new Set(["type", "nonce"]);
const BLOCK_KINDS = new Set(["heading", "paragraph", "quote", "list-item", "code"]);
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SENSITIVE_QUERY_PARAMETER = /(?:^|[_-])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|code|credential|key|pass(?:word)?|secret|session|signature|sig)(?:$|[_-])/i;
const SENSITIVE_CREDENTIALS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];
const consumingNonces = new Set();

const isPlainRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value, allowedKeys) => Object.keys(value).every((key) => allowedKeys.has(key));
const containsSensitiveCredential = (value) => SENSITIVE_CREDENTIALS.some((pattern) => pattern.test(value));
const serializedSize = (value) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const validCaptureUrl = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARACTERS) return false;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash) {
      return false;
    }
    return [...parsed.searchParams.keys()].every((key) => !SENSITIVE_QUERY_PARAMETER.test(key));
  } catch {
    return false;
  }
};

const validText = (value, maximum, allowEmpty = false) => typeof value === "string"
  && value.length <= maximum
  && (allowEmpty || value.length > 0)
  && !containsSensitiveCredential(value);

const validCapturePayload = (value) => {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ROOT_KEYS) || serializedSize(value) > MAX_PAYLOAD_BYTES) {
    return false;
  }
  if (value.version !== 1 || value.source !== "extension") return false;
  if (!validText(value.title, MAX_TITLE_CHARACTERS, true) || !validCaptureUrl(value.url)) return false;
  if (value.selectionText !== undefined && !validText(value.selectionText, MAX_SELECTION_CHARACTERS)) return false;
  if (value.capturedAt !== undefined && (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt)))) {
    return false;
  }
  if (!Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS) return false;

  let totalBlockCharacters = 0;
  for (const block of value.blocks) {
    if (!isPlainRecord(block) || !hasOnlyKeys(block, BLOCK_KEYS)) return false;
    if (!BLOCK_KINDS.has(block.kind) || !validText(block.text, MAX_BLOCK_CHARACTERS)) return false;
    totalBlockCharacters += block.text.length;
    if (totalBlockCharacters > MAX_BLOCK_CHARACTERS_TOTAL) return false;
  }
  return true;
};

const storageKey = (nonce) => `${STORAGE_PREFIX}${nonce}`;
const alarmName = (nonce) => `${ALARM_PREFIX}${nonce}`;

const createNonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const removeExpiredCaptures = async () => {
  const stored = await chrome.storage.session.get(null);
  const now = Date.now();
  const expiredKeys = Object.entries(stored)
    .filter(([key, value]) => key.startsWith(STORAGE_PREFIX)
      && (!isPlainRecord(value) || typeof value.expiresAt !== "number" || value.expiresAt <= now))
    .map(([key]) => key);
  if (expiredKeys.length > 0) {
    await chrome.storage.session.remove(expiredKeys);
    await Promise.all(expiredKeys.map((key) =>
      chrome.alarms.clear(alarmName(key.slice(STORAGE_PREFIX.length))).catch(() => false)
    ));
  }
};

const showFailureBadge = async (tabId) => {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#B42318", tabId });
    await chrome.action.setBadgeText({ text: "!", tabId });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "", tabId }).catch(() => undefined);
    }, 4000);
  } catch {
    // The source tab may already have closed.
  }
};

chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (typeof alarm?.name !== "string" || !alarm.name.startsWith(ALARM_PREFIX)) return;
  const nonce = alarm.name.slice(ALARM_PREFIX.length);
  if (!NONCE_PATTERN.test(nonce)) return;
  void chrome.storage.session.remove(storageKey(nonce)).catch(() => undefined);
});

chrome.action.onClicked.addListener(async (tab) => {
  let pendingStorageKey = null;
  let pendingAlarmName = null;
  try {
    if (!Number.isInteger(tab.id) || tab.incognito || typeof tab.url !== "string" || !/^https?:\/\//i.test(tab.url)) {
      throw new Error("unsupported tab");
    }

    await removeExpiredCaptures();
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture.js"]
    });
    const payload = injectionResults[0]?.result;
    if (!validCapturePayload(payload)) {
      throw new Error("invalid capture");
    }

    const nonce = createNonce();
    pendingStorageKey = storageKey(nonce);
    pendingAlarmName = alarmName(nonce);
    const expiresAt = Date.now() + CAPTURE_TTL_MILLISECONDS;
    await chrome.storage.session.set({
      [pendingStorageKey]: {
        payload,
        expiresAt
      }
    });
    await chrome.alarms.create(pendingAlarmName, { when: expiresAt });
    await chrome.tabs.create({
      url: `${QUICKMEMO_ORIGIN}/library#capture=${encodeURIComponent(nonce)}&extension=${chrome.runtime.id}`
    });
    pendingStorageKey = null;
    pendingAlarmName = null;
  } catch {
    if (pendingStorageKey) {
      await chrome.storage.session.remove(pendingStorageKey).catch(() => undefined);
    }
    if (pendingAlarmName) {
      await chrome.alarms.clear(pendingAlarmName).catch(() => false);
    }
    await showFailureBadge(tab.id);
  }
});

const isTrustedLibrarySender = (sender) => {
  if (sender.tab?.incognito || typeof sender.url !== "string") return false;
  try {
    const senderUrl = new URL(sender.url);
    return senderUrl.origin === QUICKMEMO_ORIGIN
      && (senderUrl.pathname === "/library" || senderUrl.pathname === "/library/");
  } catch {
    return false;
  }
};

const consumeCapture = async (message, sender) => {
  if (!isTrustedLibrarySender(sender) || !isPlainRecord(message) || !hasOnlyKeys(message, MESSAGE_KEYS)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  if (message.type !== "quickmemo.consumeCapture" || typeof message.nonce !== "string" || !NONCE_PATTERN.test(message.nonce)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  if (consumingNonces.has(message.nonce)) {
    return { ok: false, error: "ALREADY_CONSUMED" };
  }

  consumingNonces.add(message.nonce);
  try {
    const key = storageKey(message.nonce);
    const stored = await chrome.storage.session.get(key);
    const entry = stored[key];
    await chrome.storage.session.remove(key);
    await chrome.alarms.clear(alarmName(message.nonce)).catch(() => false);

    if (!isPlainRecord(entry) || typeof entry.expiresAt !== "number" || entry.expiresAt <= Date.now()) {
      return { ok: false, error: "MISSING_OR_EXPIRED" };
    }
    if (!validCapturePayload(entry.payload)) {
      return { ok: false, error: "INVALID_CAPTURE" };
    }
    return { ok: true, payload: entry.payload };
  } finally {
    consumingNonces.delete(message.nonce);
  }
};

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  consumeCapture(message, sender).then(
    sendResponse,
    () => sendResponse({ ok: false, error: "UNAVAILABLE" })
  );
  return true;
});
