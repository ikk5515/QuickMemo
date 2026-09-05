import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface HostingHeader {
  key: string;
  value: string;
}

interface HeaderRule {
  source: string;
  headers: HostingHeader[];
}

function readJsonFile<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), fileName), "utf8")) as T;
}

function headersByKey(headers: HostingHeader[]): Map<string, string> {
  return new Map(headers.map((header) => [header.key.toLowerCase(), header.value]));
}

function headerRuleMatchesPath(rule: HeaderRule, pathname: string): boolean {
  return new RegExp(`^${rule.source}$`, "u").test(pathname);
}

function expectBrowserHardeningHeaders(headers: HostingHeader[]): void {
  const values = headersByKey(headers);
  const csp = values.get("content-security-policy") ?? "";

  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("'wasm-unsafe-eval'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain("https://www.google.com/recaptcha/");
  expect(csp).toContain("https://www.gstatic.com/recaptcha/");
  expect(csp).toContain("connect-src 'self' https://*.googleapis.com");
  expect(csp).toContain("https://vercel.com");
  expect(csp).toContain("https://blob.vercel-storage.com");
  expect(csp).toContain("https://*.private.blob.vercel-storage.com");
  expect(csp).toContain("https://*.public.blob.vercel-storage.com");
  expect(csp).toContain("https://recaptcha.google.com/recaptcha/");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("worker-src 'self' blob:");
  expect(values.get("x-frame-options")).toBe("DENY");
  expect(values.get("x-content-type-options")).toBe("nosniff");
  expect(values.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(values.get("permissions-policy")).toContain("camera=()");
  expect(values.get("permissions-policy")).toContain("microphone=(self)");
  expect(values.get("permissions-policy")).toContain("geolocation=()");
  expect(values.get("permissions-policy")).toContain("payment=()");
  expect(values.get("permissions-policy")).toContain("usb=()");
  expect(values.get("strict-transport-security")).toContain("max-age=63072000");
}

describe("hosting security headers", () => {
  it("sets anti-framing and browser hardening headers for Firebase Hosting", () => {
    const firebaseConfig = readJsonFile<{ hosting: { headers?: HeaderRule[] } }>("firebase.json");
    const catchAllHeaders = firebaseConfig.hosting.headers?.find((rule) => rule.source === "**")?.headers;

    expect(catchAllHeaders).toBeDefined();
    expectBrowserHardeningHeaders(catchAllHeaders ?? []);
  });

  it("sets anti-framing and browser hardening headers for Vercel", () => {
    const vercelConfig = readJsonFile<{ headers?: HeaderRule[] }>("vercel.json");
    const catchAllHeaders = vercelConfig.headers?.find((rule) => rule.source === "/(.*)")?.headers;

    expect(catchAllHeaders).toBeDefined();
    expectBrowserHardeningHeaders(catchAllHeaders ?? []);
  });

  it("caches only content-hashed Vite assets while keeping documents and private paths uncached", () => {
    const vercelConfig = readJsonFile<{ headers?: HeaderRule[] }>("vercel.json");
    const rules = vercelConfig.headers ?? [];
    const immutableRules = rules.filter((rule) =>
      headersByKey(rule.headers).get("cache-control")?.includes("immutable")
    );
    const viteAssetRule = immutableRules.find((rule) => rule.source.startsWith("/assets/"));

    expect(viteAssetRule).toBeDefined();
    expect(headersByKey(viteAssetRule?.headers ?? []).get("cache-control"))
      .toBe("public, max-age=31536000, immutable");

    for (const hashedAssetPath of [
      "/assets/index-AbCdEf12.js",
      "/assets/index-a1_B2-c3.css",
      "/assets/KaTeX_Main-Regular-Dr94JaBh.woff"
    ]) {
      expect(headerRuleMatchesPath(viteAssetRule as HeaderRule, hashedAssetPath)).toBe(true);
    }

    for (const unsafeLongCachePath of [
      "/assets/index.js",
      "/assets/index-AbCdEf12.js/rewritten-document",
      "/index.html",
      "/app",
      "/wiki",
      "/wiki/public/pw1_example",
      "/api/blob-attachments",
      "/share/ss2_example",
      "/s/example"
    ]) {
      expect(immutableRules.some((rule) => headerRuleMatchesPath(rule, unsafeLongCachePath))).toBe(false);
    }

    // The OCR runtime is separately versioned and pre-existing. No other
    // application or private route may gain an immutable cache policy.
    expect(immutableRules.map((rule) => rule.source).sort()).toEqual([
      "/assets/(.*)-([A-Za-z0-9_-]{8})\\.([A-Za-z0-9]+)",
      "/library-ocr/v7/(.*)"
    ]);

    for (const noStorePath of [
      "/",
      "/index.html",
      "/setup",
      "/login",
      "/home",
      "/app",
      "/app/legacy",
      "/library",
      "/wiki",
      "/wiki/public/pw1_example",
      "/schedule",
      "/schedule/recurring",
      "/admin",
      "/api/library-ocr-worker"
    ]) {
      const matchingCacheControls = rules
        .filter((rule) => headerRuleMatchesPath(rule, noStorePath))
        .map((rule) => headersByKey(rule.headers).get("cache-control"))
        .filter((value): value is string => Boolean(value));

      expect(matchingCacheControls.some((value) => value.includes("no-store"))).toBe(true);
      expect(matchingCacheControls.some((value) => value.includes("immutable"))).toBe(false);
    }
  });

  it("keeps public share documents out of caches, referrers, and search indexes", () => {
    const firebaseConfig = readJsonFile<{ hosting: { headers?: HeaderRule[] } }>("firebase.json");
    const vercelConfig = readJsonFile<{ headers?: HeaderRule[] }>("vercel.json");
    const firebaseShareHeaders = headersByKey(
      firebaseConfig.hosting.headers?.find((rule) => rule.source === "/share/**")?.headers ?? []
    );
    const firebaseCompactShareHeaders = headersByKey(
      firebaseConfig.hosting.headers?.find((rule) => rule.source === "/s/**")?.headers ?? []
    );
    const vercelShareHeaders = headersByKey(
      vercelConfig.headers?.find((rule) => rule.source === "/share/(.*)")?.headers ?? []
    );
    const vercelCompactShareHeaders = headersByKey(
      vercelConfig.headers?.find((rule) => rule.source === "/s/(.*)")?.headers ?? []
    );
    const vercelShareApiHeaders = headersByKey(
      vercelConfig.headers?.find((rule) => rule.source === "/api/public-shares-v2")?.headers ?? []
    );
    const vercelAttachmentApiHeaders = headersByKey(
      vercelConfig.headers?.find((rule) => rule.source === "/api/blob-attachments")?.headers ?? []
    );

    for (const headers of [
      firebaseShareHeaders,
      firebaseCompactShareHeaders,
      vercelShareHeaders,
      vercelCompactShareHeaders,
      vercelShareApiHeaders,
      vercelAttachmentApiHeaders
    ]) {
      expect(headers.get("cache-control")).toContain("no-store");
      expect(headers.get("referrer-policy")).toBe("no-referrer");
      expect(headers.get("x-robots-tag")).toContain("noindex");
      expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
  });

  it("does not initialize unused analytics outside the production CSP", () => {
    const firebaseSource = readFileSync(
      join(process.cwd(), "src/lib/firebase.ts"),
      "utf8"
    );
    const firebaseConfig = readJsonFile<{ hosting: { headers?: HeaderRule[] } }>("firebase.json");
    const vercelConfig = readJsonFile<{ headers?: HeaderRule[] }>("vercel.json");
    const contentSecurityPolicies = [
      headersByKey(
        firebaseConfig.hosting.headers?.find((rule) => rule.source === "**")?.headers ?? []
      ).get("content-security-policy") ?? "",
      headersByKey(
        vercelConfig.headers?.find((rule) => rule.source === "/(.*)")?.headers ?? []
      ).get("content-security-policy") ?? ""
    ];

    expect(firebaseSource).not.toContain("firebase/analytics");
    for (const contentSecurityPolicy of contentSecurityPolicies) {
      expect(contentSecurityPolicy).not.toContain("googletagmanager.com");
      expect(contentSecurityPolicy).not.toContain("google-analytics.com");
      expect(contentSecurityPolicy).not.toContain("apis.google.com");
    }
  });

  it("does not initialize Firebase popup infrastructure on Safari", () => {
    const firebaseSource = readFileSync(
      join(process.cwd(), "src/lib/firebase.ts"),
      "utf8"
    );
    const adminFunctionsSource = readFileSync(
      join(process.cwd(), "src/services/adminFunctions.ts"),
      "utf8"
    );

    expect(firebaseSource).toContain("initializeAuth(app, {");
    expect(firebaseSource).toContain("persistence: browserSessionPersistence");
    expect(firebaseSource).not.toContain("getAuth(app)");
    expect(firebaseSource).not.toContain("popupRedirectResolver");
    expect(adminFunctionsSource).toContain("initializeAuth(secondaryApp, {");
    expect(adminFunctionsSource).toContain("persistence: inMemoryPersistence");
    expect(adminFunctionsSource).not.toContain("getAuth(secondaryApp)");
    expect(adminFunctionsSource).not.toContain("popupRedirectResolver");
  });
});
