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

  it("keeps public share documents out of caches, referrers, and search indexes", () => {
    const firebaseConfig = readJsonFile<{ hosting: { headers?: HeaderRule[] } }>("firebase.json");
    const vercelConfig = readJsonFile<{ headers?: HeaderRule[] }>("vercel.json");
    const firebaseShareHeaders = headersByKey(
      firebaseConfig.hosting.headers?.find((rule) => rule.source === "/share/**")?.headers ?? []
    );
    const vercelShareHeaders = headersByKey(
      vercelConfig.headers?.find((rule) => rule.source === "/share/(.*)")?.headers ?? []
    );
    const vercelApiHeaders = headersByKey(
      vercelConfig.headers?.find((rule) => rule.source === "/api/public-shares-v2")?.headers ?? []
    );

    for (const headers of [firebaseShareHeaders, vercelShareHeaders, vercelApiHeaders]) {
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
