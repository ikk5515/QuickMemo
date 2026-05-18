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
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("object-src 'none'");
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
});
