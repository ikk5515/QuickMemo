/* global Response, process */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  initialHashedScriptPath,
  validateImmutableAssetResponse,
  validateProductionPage,
  validateUnauthorizedAttachmentResponse,
  verifyProductionPublicSmoke
} from "./verify-production-public-smoke.mjs";

const productionHeaders = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload"
};

describe("production public smoke", () => {
  it("accepts the hardened application shell and fail-closed attachment API", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response('<div id="root"></div><script type="module" src="/assets/index-AbCdEf12.js"></script>', {
        status: 200,
        headers: productionHeaders
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "content-type": "application/javascript; charset=utf-8"
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "로그인이 필요합니다." }), {
        status: 401,
        headers: {
          "cache-control": "no-store, private",
          "content-type": "application/json; charset=utf-8"
        }
      }));

    const originalResponse = globalThis.Response;
    const result = await verifyProductionPublicSmoke({
      baseUrl: "https://quickmemo.example",
      fetchImplementation: async (input, init) => {
        const response = await fetchImplementation(input, init);
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      }
    });

    expect(globalThis.Response).toBe(originalResponse);
    expect(result).toMatchObject({
      ok: true,
      origin: "https://quickmemo.example",
      pageStatus: 200,
      assetStatus: 200,
      attachmentStatus: 401
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls[1]?.[1]).toMatchObject({ method: "HEAD", redirect: "error" });
  });

  it("rejects a page that loses its anti-framing policy", () => {
    const response = new Response('<div id="root"></div>', {
      status: 200,
      headers: {
        ...productionHeaders,
        "content-security-policy": "default-src 'self'; object-src 'none'"
      }
    });
    Object.defineProperty(response, "url", { value: "https://quickmemo.example/" });

    expect(() => validateProductionPage(
      response,
      '<div id="root"></div>',
      "https://quickmemo.example"
    )).toThrow(/anti-framing/u);
  });

  it("rejects cached or detail-leaking attachment errors", () => {
    const response = new Response(JSON.stringify({
      ok: false,
      error: "https://private.blob.vercel-storage.com/file"
    }), {
      status: 401,
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "application/json"
      }
    });

    expect(() => validateUnauthorizedAttachmentResponse(
      response,
      JSON.stringify({ ok: false, error: "https://private.blob.vercel-storage.com/file" })
    )).toThrow(/cached/u);
  });

  it("requires a content-hashed script with immutable production caching", () => {
    expect(initialHashedScriptPath(
      '<script type="module" src="/assets/index-AbCdEf12.js"></script>'
    )).toBe("/assets/index-AbCdEf12.js");
    expect(() => initialHashedScriptPath(
      '<script type="module" src="/assets/index.js"></script>'
    )).toThrow(/hashed application script/u);

    const response = new Response(null, {
      status: 200,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "application/javascript; charset=utf-8"
      }
    });
    Object.defineProperty(response, "url", { value: "https://quickmemo.example/assets/index-AbCdEf12.js" });

    expect(() => validateImmutableAssetResponse(
      response,
      "https://quickmemo.example"
    )).toThrow(/one-year browser cache lifetime/u);
  });

  it("uses Vercel CLI protection bypass for the immutable deployment smoke", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/vercel-production.yml"),
      "utf8"
    );
    const immutableStep = workflow.match(
      /- name: Verify immutable deployment[\s\S]*?- name: Verify production alias/u
    )?.[0] ?? "";

    expect(immutableStep).toContain("VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    expect(immutableStep).toContain("vercel@54.4.1 curl /");
    expect(immutableStep).toContain('--deployment "${DEPLOYMENT_URL}"');
    expect(immutableStep).toContain('page_status}" != "200"');
    expect(immutableStep).toContain('attachment_status}" != "401"');
    expect(immutableStep).not.toContain("node scripts/verify-production-public-smoke.mjs");
  });
});
