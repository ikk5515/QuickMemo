// @vitest-environment node

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "vite";

interface TestDom {
  window: Window & typeof globalThis & { close: () => void };
}

const JSDOM = (createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { runScripts: string; url: string }) => TestDom;
}).JSDOM;

interface ProductionBookmarkletModule {
  createLibraryCaptureBookmarkletUrl: (origin: string) => string;
  maxLibraryBookmarkletUrlBytes: number;
}

async function buildProductionBookmarkletModule() {
  const result = await build({
    build: {
      lib: {
        entry: fileURLToPath(new URL("./libraryBookmarklet.ts", import.meta.url)),
        formats: ["es"]
      },
      minify: "esbuild",
      rollupOptions: {
        output: { entryFileNames: "library-bookmarklet-production.js" }
      },
      write: false
    },
    configFile: false,
    logLevel: "silent"
  });
  const buildOutput = Array.isArray(result) ? result[0] : result;
  if (!("output" in buildOutput)) {
    throw new Error("프로덕션 북마클릿 테스트 번들 출력을 확인하지 못했습니다.");
  }
  const entryOutput = buildOutput.output.find(
    (output) => output.type === "chunk" && output.isEntry
  );
  if (!entryOutput || entryOutput.type !== "chunk") {
    throw new Error("프로덕션 북마클릿 테스트 번들을 만들지 못했습니다.");
  }
  const bundledSource = entryOutput.code;

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString("base64")}`;
  return import(moduleUrl) as Promise<ProductionBookmarkletModule>;
}

describe("Safari library capture production bookmarklet", () => {
  it("survives URL canonicalization and still blocks a CRLF-split credential after minification", async () => {
    const productionModule = await buildProductionBookmarkletModule();
    const bookmarkletUrl = productionModule.createLibraryCaptureBookmarkletUrl(
      "https://quickmemo.example"
    );
    const canonicalUrl = new URL(bookmarkletUrl).href;
    const originalScript = decodeURIComponent(bookmarkletUrl.slice("javascript:".length));
    const canonicalScript = decodeURIComponent(canonicalUrl.slice("javascript:".length));

    expect(Buffer.byteLength(bookmarkletUrl)).toBeLessThanOrEqual(
      productionModule.maxLibraryBookmarkletUrlBytes
    );
    expect(bookmarkletUrl).not.toMatch(/[\t\n\r]/);
    expect(canonicalScript).toBe(originalScript);

    const sourcePage = new JSDOM(
      "<!doctype html><title>보안 문서</title><article><p>일반 본문</p></article>",
      { runScripts: "outside-only", url: "https://source.example/read" }
    );
    const alerts: string[] = [];
    let openCalls = 0;
    Object.defineProperty(sourcePage.window.document, "getSelection", {
      configurable: true,
      value: () => ({
        toString: () => "Authorization: Bearer\r\nabcdefghijklmnopqrstuvwxyz"
      })
    });
    Object.defineProperty(sourcePage.window, "open", {
      configurable: true,
      value: () => {
        openCalls += 1;
        return null;
      }
    });
    Object.defineProperty(sourcePage.window, "alert", {
      configurable: true,
      value: (message: string) => alerts.push(message)
    });
    Object.defineProperty(sourcePage.window, "TextEncoder", {
      configurable: true,
      value: TextEncoder
    });

    try {
      sourcePage.window.eval(canonicalScript);
      expect(openCalls).toBe(0);
      expect(alerts).toEqual([
        "QuickMemo: 인증 정보로 보이는 텍스트가 있어 캡처를 중단했습니다."
      ]);
    } finally {
      sourcePage.window.close();
    }

    const splitCredentialPage = new JSDOM(
      [
        "<!doctype html><title>보안 문서</title><article>",
        "<h2>Authorization: Bearer</h2>",
        "<p>abcdefghijklmnopqrstuvwxyz</p>",
        "</article>"
      ].join(""),
      { runScripts: "outside-only", url: "https://source.example/read" }
    );
    const splitAlerts: string[] = [];
    let splitOpenCalls = 0;
    Object.defineProperty(splitCredentialPage.window, "open", {
      configurable: true,
      value: () => {
        splitOpenCalls += 1;
        return null;
      }
    });
    Object.defineProperty(splitCredentialPage.window, "alert", {
      configurable: true,
      value: (message: string) => splitAlerts.push(message)
    });
    Object.defineProperty(splitCredentialPage.window, "TextEncoder", {
      configurable: true,
      value: TextEncoder
    });

    try {
      splitCredentialPage.window.eval(canonicalScript);
      expect(splitOpenCalls).toBe(0);
      expect(splitAlerts).toEqual([
        "QuickMemo: 인증 정보로 보이는 텍스트가 있어 캡처를 중단했습니다."
      ]);
    } finally {
      splitCredentialPage.window.close();
    }
  });
});
