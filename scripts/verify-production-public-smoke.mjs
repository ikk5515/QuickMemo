/* global AbortSignal, console, fetch, process, TextDecoder, URL */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultProductionUrl = "https://quickmemo-tan.vercel.app";
const requestTimeoutMilliseconds = 15_000;
const maximumPageBytes = 2 * 1024 * 1024;
const maximumApiBytes = 64 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function boundedText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Production smoke response exceeded the declared size limit.");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new Error("Production smoke response exceeded the streamed size limit.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function validateProductionPage(response, body, expectedOrigin) {
  assert(response.status === 200, `Production page returned HTTP ${response.status}.`);
  assert(new URL(response.url).origin === expectedOrigin, "Production page redirected to an unexpected origin.");
  assert((response.headers.get("content-type") ?? "").toLowerCase().includes("text/html"), "Production page did not return HTML.");
  assert(/<div\s+id=["']root["']/u.test(body), "Production page did not contain the application root.");

  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  assert(contentSecurityPolicy.includes("default-src 'self'"), "Production CSP lost its default-src boundary.");
  assert(contentSecurityPolicy.includes("frame-ancestors 'none'"), "Production CSP lost anti-framing protection.");
  assert(contentSecurityPolicy.includes("object-src 'none'"), "Production CSP permits object content.");
  assert(response.headers.get("x-frame-options") === "DENY", "Production X-Frame-Options is not DENY.");
  assert(response.headers.get("x-content-type-options") === "nosniff", "Production nosniff protection is missing.");
  assert((response.headers.get("strict-transport-security") ?? "").includes("max-age=63072000"), "Production HSTS is missing or weakened.");
}

export function validateUnauthorizedAttachmentResponse(response, body) {
  assert(response.status === 401, `Unauthenticated attachment request returned HTTP ${response.status}, expected 401.`);
  assert((response.headers.get("content-type") ?? "").toLowerCase().includes("application/json"), "Attachment rejection was not JSON.");
  assert((response.headers.get("cache-control") ?? "").toLowerCase().includes("no-store"), "Attachment rejection may be cached.");
  const parsed = JSON.parse(body);
  assert(parsed?.ok === false, "Attachment rejection did not use the expected fail-closed response.");
  assert(!/blob\.vercel-storage\.com|bearer\s|token|secret/iu.test(body), "Attachment rejection exposed sensitive transport details.");
}

export async function verifyProductionPublicSmoke({
  baseUrl = defaultProductionUrl,
  fetchImplementation = fetch
} = {}) {
  const productionUrl = new URL(baseUrl);
  if (productionUrl.protocol !== "https:") {
    throw new Error("Production smoke requires an HTTPS origin.");
  }
  productionUrl.pathname = "/";
  productionUrl.search = "";
  productionUrl.hash = "";

  const pageResponse = await fetchImplementation(productionUrl, {
    headers: { Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds)
  });
  const pageBody = await boundedText(pageResponse, maximumPageBytes);
  validateProductionPage(pageResponse, pageBody, productionUrl.origin);

  const attachmentUrl = new URL("/api/blob-attachments", productionUrl);
  attachmentUrl.searchParams.set("scope", "note");
  attachmentUrl.searchParams.set("noteId", "production_smoke_note");
  attachmentUrl.searchParams.set("attachmentId", "production_smoke_attachment");
  const attachmentResponse = await fetchImplementation(attachmentUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds)
  });
  const attachmentBody = await boundedText(attachmentResponse, maximumApiBytes);
  validateUnauthorizedAttachmentResponse(attachmentResponse, attachmentBody);

  return {
    ok: true,
    origin: productionUrl.origin,
    pageStatus: pageResponse.status,
    attachmentStatus: attachmentResponse.status
  };
}

async function main() {
  const result = await verifyProductionPublicSmoke({
    baseUrl: process.env.QUICKMEMO_PRODUCTION_URL || defaultProductionUrl
  });
  console.log(
    `QuickMemo production smoke passed for ${result.origin}: page ${result.pageStatus}, unauthenticated attachment ${result.attachmentStatus}.`
  );
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production smoke failed.");
    process.exitCode = 1;
  });
}
