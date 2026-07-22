import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerEndpointSource = readFileSync(join(process.cwd(), "api/library-ocr-worker.js"), "utf8");
const assetCopySource = readFileSync(join(process.cwd(), "scripts/copy-library-ocr-assets.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
  functions?: Record<string, { includeFiles?: string }>;
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

describe("isolated OCR worker endpoint", () => {
  it("serves only the pinned local worker with a narrow worker CSP", () => {
    expect(workerEndpointSource).toContain("tesseract.js/dist/worker.min.js");
    expect(workerEndpointSource).toContain("default-src 'none'");
    expect(workerEndpointSource).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(workerEndpointSource).not.toContain("script-src 'self' 'unsafe-eval'");
    expect(workerEndpointSource).toContain('Cross-Origin-Resource-Policy", "same-origin');
    expect(workerEndpointSource).toContain('request.method !== "GET" && request.method !== "HEAD"');
    expect(workerEndpointSource).not.toMatch(/console\.(?:log|error)/u);
  });

  it("copies only local Korean/English models and records integrity hashes", () => {
    expect(assetCopySource).toContain("kor.traineddata.gz");
    expect(assetCopySource).toContain("eng.traineddata.gz");
    expect(assetCopySource).toContain('createHash("sha256")');
    expect(assetCopySource).toContain("manifestLicenses.push");
    expect(assetCopySource).toContain("tesseract.js-LICENSE.md");
    expect(assetCopySource).toContain("tesseract.js-core-LICENSE.txt");
    expect(assetCopySource).toContain("tesseract-core-relaxedsimd-lstm.wasm.js");
    expect(assetCopySource).not.toMatch(/https?:\/\//u);
  });

  it("bundles the pinned worker into the Vercel function", () => {
    expect(vercelConfig.functions?.["api/library-ocr-worker.js"]?.includeFiles)
      .toBe("node_modules/tesseract.js/dist/worker.min.js");
  });

  it("uses a versioned immutable cache path for local OCR assets", () => {
    const cacheRule = vercelConfig.headers?.find((rule) => rule.source === "/library-ocr/v7/(.*)");
    const headers = new Map(cacheRule?.headers.map((header) => [header.key.toLowerCase(), header.value]));

    expect(assetCopySource).toContain('"library-ocr", "v7"');
    expect(headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(packageJson.dependencies?.["tesseract.js"]).toBe("7.0.0");
    expect(packageJson.dependencies?.["@tesseract.js-data/kor"]).toBe("1.0.0");
    expect(packageJson.dependencies?.["@tesseract.js-data/eng"]).toBe("1.0.0");
  });
});
