/* global Buffer, URL */

import { readFile } from "node:fs/promises";

const workerScriptPath = new URL("../node_modules/tesseract.js/dist/worker.min.js", import.meta.url);
let workerScriptPromise;

function loadWorkerScript() {
  workerScriptPromise ??= readFile(workerScriptPath);
  return workerScriptPromise;
}

function applySecurityHeaders(response) {
  // This response is a DOM-less worker with no credentials or storage access.
  // WebAssembly is permitted only here; the QuickMemo document CSP remains strict.
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'"
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

export default async function handler(request, response) {
  applySecurityHeaders(response);

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.status(405).json({ error: "method_not_allowed" });
    return;
  }

  try {
    const source = await loadWorkerScript();

    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("Content-Length", String(source.byteLength));
    response.status(200);
    response.end(request.method === "HEAD" ? undefined : Buffer.from(source));
  } catch {
    response.setHeader("Cache-Control", "no-store");
    response.status(503).json({ error: "ocr_worker_unavailable" });
  }
}

export { applySecurityHeaders };
