import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = join(process.cwd(), "public", "quickmemo-capture-extension");
const manifest = JSON.parse(readFileSync(join(extensionRoot, "manifest.json"), "utf8")) as {
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: unknown[];
  externally_connectable?: { matches?: string[] };
};
const serviceWorker = readFileSync(join(extensionRoot, "service-worker.js"), "utf8");
const captureScript = readFileSync(join(extensionRoot, "capture.js"), "utf8");
const bookmarkletSource = readFileSync(join(process.cwd(), "src", "lib", "libraryBookmarklet.ts"), "utf8");
const buildScript = readFileSync(join(process.cwd(), "scripts", "build-library-extension.mjs"), "utf8");

describe("QuickMemo capture extension security boundary", () => {
  it("uses only click-scoped capture and ephemeral session permissions", () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(["activeTab", "alarms", "scripting", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable?.matches).toEqual(["__QUICKMEMO_MATCH_PATTERN__"]);
    expect(serviceWorker).toContain('setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })');
    expect(serviceWorker).toContain("2 * 60 * 1000");
    expect(serviceWorker).toContain("chrome.alarms.create");
    expect(serviceWorker).toContain("chrome.alarms.onAlarm.addListener");
    expect(serviceWorker).toContain("chrome.storage.session.remove(storageKey(nonce))");
    expect(serviceWorker).not.toContain("chrome.storage.local");
    expect(serviceWorker).not.toContain("chrome.storage.sync");
  });

  it("binds one-time consumption to the exact production origin and library path", () => {
    expect(serviceWorker).toContain("senderUrl.origin === QUICKMEMO_ORIGIN");
    expect(serviceWorker).toContain('senderUrl.pathname === "/library"');
    expect(serviceWorker).toContain("consumingNonces.has(message.nonce)");
    expect(serviceWorker).toContain("await chrome.storage.session.remove(key)");
    expect(serviceWorker).toContain("await chrome.alarms.clear(alarmName(message.nonce))");
    expect(serviceWorker).toContain("chrome.runtime.onMessageExternal");
  });

  it("captures normalized text only and packages an installable placeholder-free ZIP", () => {
    expect(captureScript).toContain("element.textContent");
    expect(captureScript).not.toContain("innerHTML");
    expect(captureScript).toContain("SENSITIVE_CREDENTIALS");
    expect(captureScript).toContain("aggregateCaptureText");
    expect(captureScript).toContain("sensitiveCredentialDetected");
    expect(serviceWorker).toContain("aggregateCaptureText");
    expect(serviceWorker).toContain("!containsSensitiveCredential(aggregateCaptureText)");
    expect(buildScript).toContain("zipSync");
    expect(buildScript).toContain("quickmemo-capture-extension.zip");
    expect(buildScript).toContain("placeholder");
  });

  it("keeps Safari capture in a text-only, no-referrer, memory-only handoff", () => {
    expect(bookmarkletSource).toContain("element.textContent");
    expect(bookmarkletSource).not.toContain("innerHTML");
    expect(bookmarkletSource).not.toContain("localStorage");
    expect(bookmarkletSource).not.toContain("sessionStorage");
    expect(bookmarkletSource).not.toContain("fetch(");
    expect(bookmarkletSource).not.toContain("sendBeacon");
    expect(bookmarkletSource).toContain('window.open("about:blank", "_blank")');
    expect(bookmarkletSource).toContain('referrerPolicy = "no-referrer"');
    expect(bookmarkletSource).toContain("popup?.postMessage");
    expect(bookmarkletSource).toContain("quickMemoOrigin");
  });
});
