import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LibraryCaptureValidationError,
  captureLibraryDocument,
  consumeLibraryBookmarkletCaptureHandoff,
  consumeLibraryCaptureHandoff,
  createLibraryCaptureLoginState,
  extractLibraryCaptureBlocks,
  libraryBookmarkletCaptureTtlMilliseconds,
  libraryCaptureFromPaste,
  maxLibraryCapturePayloadBytes,
  normalizeLibraryBookmarkletCaptureMessage,
  normalizeLibraryCaptureExtensionResponse,
  normalizeLibraryCaptureHandoffFragment,
  normalizeLibraryCapturePayload,
  parseLibraryCaptureLoginState,
  parseLibraryCaptureHandoffFragment,
  parseLibraryCaptureJson,
  takeLibraryCaptureHandoffFromLocation,
  type LibraryCaptureExternalRuntime
} from "./libraryCapture";

function validCapture(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: "extension",
    title: "읽을 자료",
    url: "https://example.com/article",
    blocks: [{ kind: "paragraph", text: "본문" }],
    ...overrides
  };
}

function validBookmarkletMessage(
  nonce: string,
  capturedAt: string,
  payloadOverrides: Record<string, unknown> = {}
) {
  return {
    type: "quickmemo.libraryCapture.bookmarklet",
    nonce,
    payload: validCapture({
      source: "bookmarklet",
      url: "https://source.example/article",
      capturedAt,
      ...payloadOverrides
    })
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.title = "";
  window.history.replaceState(null, "", "/");
  Object.defineProperty(window, "opener", { configurable: true, value: null, writable: true });
});

describe("normalizeLibraryCapturePayload", () => {
  it("normalizes text and removes URL fragments and secret-like query values", () => {
    const payload = normalizeLibraryCapturePayload(
      validCapture({
        title: "  제목\r\n\u202E  ",
        url: "https://example.com/read?article=7&access_token=never-store-this#private-fragment",
        selectionText: " 선택\u0000 문장 ",
        capturedAt: "2026-07-22T01:02:03+09:00"
      })
    );

    expect(payload).toEqual({
      version: 1,
      source: "extension",
      title: "제목",
      url: "https://example.com/read?article=7",
      selectionText: "선택 문장",
      blocks: [{ kind: "paragraph", text: "본문" }],
      capturedAt: "2026-07-21T16:02:03.000Z"
    });
  });

  it("removes credentials hidden in decoded query values and paths", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678";
    const payload = normalizeLibraryCapturePayload(
      validCapture({
        url: `https://example.com/articles/${encodeURIComponent(jwt)}/safe`
          + `?page=2&redirect=${encodeURIComponent(encodeURIComponent(`https://accounts.example/callback?access_token=secret-value`))}`
          + `&preview=${encodeURIComponent(jwt)}&theme=dark`
      })
    );

    expect(payload.url).toBe("https://example.com/articles/safe?page=2&theme=dark");
    expect(payload.url).not.toContain("secret-value");
    expect(payload.url).not.toContain("eyJ");
  });

  it("removes decoded path credential pairs but preserves benign URLs and nested schemes", () => {
    const payload = normalizeLibraryCapturePayload(
      validCapture({
        url: "https://example.com/read/access_token/opaque-secret-value/docs"
          + "?source=https%3A%2F%2Fdocs.example.org%2Foauth%2Fguide&topic=access-token-guide"
      })
    );

    expect(payload.url).toBe(
      "https://example.com/read/docs?source=https%3A%2F%2Fdocs.example.org%2Foauth%2Fguide&topic=access-token-guide"
    );
  });

  it("removes double-encoded credential assignments embedded in a path segment", () => {
    const hiddenPath = encodeURIComponent(encodeURIComponent("callback/access_token=do-not-store"));
    const payload = normalizeLibraryCapturePayload(
      validCapture({ url: `https://example.com/safe/${hiddenPath}/article` })
    );

    expect(payload.url).toBe("https://example.com/safe/article");
  });

  it("removes double-encoded sensitive parameter names without over-filtering benign slugs", () => {
    const payload = normalizeLibraryCapturePayload(
      validCapture({
        url: "https://example.com/docs/key/installation-guide"
          + "?%2561ccess_token=hidden&query=authorization-guide&return=https%3A%2F%2Fexample.org%2Fsafe"
      })
    );

    expect(payload.url).toBe(
      "https://example.com/docs/key/installation-guide?query=authorization-guide&return=https%3A%2F%2Fexample.org%2Fsafe"
    );
  });

  it("removes camelCase API and client credential names from queries and paths", () => {
    const payload = normalizeLibraryCapturePayload(
      validCapture({
        url: "https://example.com/apiKey/opaque-secret-value/article"
          + "?apiKey=do-not-store&clientSecret=also-private&privateKey=never-store&page=4"
      })
    );

    expect(payload.url).toBe("https://example.com/article?page=4");
    expect(payload.url).not.toContain("do-not-store");
    expect(payload.url).not.toContain("also-private");
    expect(payload.url).not.toContain("never-store");
  });

  it("removes a credential assignment hidden inside a nested query value", () => {
    const nested = encodeURIComponent("https://accounts.example/callback?apiKey=never-store-this");
    const payload = normalizeLibraryCapturePayload(
      validCapture({ url: `https://example.com/read?next=${nested}&page=5` })
    );

    expect(payload.url).toBe("https://example.com/read?page=5");
    expect(payload.url).not.toContain("never-store-this");
  });

  it("does not let a malformed percent sign shield encoded credentials or a non-eyJ JWT", () => {
    const jwt = "e30.eyJzdWIiOiJ1c2VyIn0.signature12345678";
    const payload = normalizeLibraryCapturePayload(
      validCapture({
        url: "https://example.com/read"
          + `?next=%2561ccess_token%253Dhidden%25&signed=${encodeURIComponent(jwt)}&page=3`
      })
    );

    expect(payload.url).toBe("https://example.com/read?page=3");
  });

  it.each([
    ["root HTML", validCapture({ html: "<main>raw</main>" })],
    ["token", validCapture({ token: "secret" })],
    ["private key", validCapture({ privateKey: "secret" })],
    ["block HTML", validCapture({ blocks: [{ kind: "paragraph", text: "본문", html: "<p>본문</p>" }] })]
  ])("rejects unapproved %s fields", (_label, value) => {
    expect(() => normalizeLibraryCapturePayload(value)).toThrow(LibraryCaptureValidationError);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:password@example.com/private"
  ])("rejects unsafe capture URL %s", (url) => {
    expect(() => normalizeLibraryCapturePayload(validCapture({ url }))).toThrow(
      "http 또는 https URL만 캡처할 수 있습니다."
    );
  });

  it("rejects serialized payloads above the total byte budget", () => {
    const oversized = validCapture({
      selectionText: "가".repeat(100_000),
      blocks: Array.from({ length: 30 }, () => ({ kind: "paragraph", text: "나".repeat(10_000) }))
    });
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(maxLibraryCapturePayloadBytes);
    expect(() => normalizeLibraryCapturePayload(oversized)).toThrow("허용 크기");
  });

  it("rejects extension captures without a URL", () => {
    expect(() => normalizeLibraryCapturePayload(validCapture({ url: null }))).toThrow("URL이 필요합니다");
  });

  it("rejects accessor properties without invoking untrusted getters", () => {
    const payload = validCapture();
    const getter = vi.fn(() => 1);
    Object.defineProperty(payload, "version", { enumerable: true, get: getter });

    expect(() => normalizeLibraryCapturePayload(payload)).toThrow("일반 데이터 필드");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "access_token=abcdefghijklmno",
    "-----BEGIN PRIVATE KEY-----"
  ])("refuses credential-like text instead of persisting it: %s", (text) => {
    expect(() => normalizeLibraryCapturePayload(validCapture({ selectionText: text }))).toThrow("인증 정보");
  });

  it("refuses a credential split across adjacent capture blocks", () => {
    expect(() => normalizeLibraryCapturePayload(validCapture({
      blocks: [
        { kind: "heading", text: "Authorization: Bearer" },
        { kind: "paragraph", text: "abcdefghijklmnopqrstuvwxyz" }
      ]
    }))).toThrow("인증 정보");
  });
});

describe("library capture input adapters", () => {
  it("accepts a pasted http URL without treating it as body text", () => {
    expect(libraryCaptureFromPaste("https://example.com/guide#section")).toEqual({
      version: 1,
      source: "paste",
      title: "example.com",
      url: "https://example.com/guide",
      blocks: []
    });
  });

  it("turns pasted text into bounded structured paragraphs", () => {
    const payload = libraryCaptureFromPaste("첫 줄\n\n두 번째 문단");

    expect(payload).toMatchObject({
      source: "paste",
      title: "첫 줄",
      url: null,
      selectionText: "첫 줄\n\n두 번째 문단",
      blocks: [
        { kind: "paragraph", text: "첫 줄" },
        { kind: "paragraph", text: "두 번째 문단" }
      ]
    });
  });

  it("accepts a validated bookmarklet JSON payload but refuses extension JSON paste", () => {
    const bookmarklet = JSON.stringify(validCapture({ source: "bookmarklet" }));
    expect(parseLibraryCaptureJson(bookmarklet).source).toBe("bookmarklet");
    expect(libraryCaptureFromPaste(bookmarklet).source).toBe("bookmarklet");
    expect(() => libraryCaptureFromPaste(JSON.stringify(validCapture()))).toThrow("보안 핸드오프");
  });

  it("does not silently reinterpret malformed JSON as ordinary text", () => {
    expect(() => libraryCaptureFromPaste('{"version":')).toThrow("JSON을 읽을 수 없습니다");
  });
});

describe("DOM capture", () => {
  it("extracts only readable text blocks and excludes navigation and executable markup", () => {
    const root = document.createElement("article");
    root.innerHTML = `
      <header><p>헤더 제외</p></header>
      <h1>자료 제목</h1>
      <p>첫 문단 <strong>강조</strong></p>
      <blockquote><p>인용 문장</p></blockquote>
      <ul><li>목록 항목</li></ul>
      <pre><code>const safe = true;</code></pre>
      <button>버튼 제외</button>
      <script>window.secret = "no";</script>
      <footer><p>푸터 제외</p></footer>
    `;

    expect(extractLibraryCaptureBlocks(root)).toEqual([
      { kind: "heading", text: "자료 제목" },
      { kind: "paragraph", text: "첫 문단 강조" },
      { kind: "quote", text: "인용 문장" },
      { kind: "list-item", text: "목록 항목" },
      { kind: "code", text: "const safe = true;" }
    ]);
  });

  it("uses article before main and captures only selection text, not HTML", () => {
    document.title = "  테스트 문서  ";
    window.history.replaceState(null, "", "/read?article=1&token=secret#fragment");
    document.body.innerHTML = `
      <main><p>메인 본문</p></main>
      <article><h2>기사</h2><p>기사 본문</p></article>
    `;
    vi.spyOn(document, "getSelection").mockReturnValue({
      toString: () => "선택한 <b>텍스트</b>"
    } as Selection);

    const payload = captureLibraryDocument(document);

    expect(payload.url).toBe("http://localhost:3000/read?article=1");
    expect(payload.blocks).toEqual([
      { kind: "heading", text: "기사" },
      { kind: "paragraph", text: "기사 본문" }
    ]);
    expect(payload.selectionText).toBe("선택한 <b>텍스트</b>");
    expect(JSON.stringify(payload)).not.toContain("<article>");
  });
});

describe("Safari bookmarklet memory handoff", () => {
  const now = Date.parse("2026-07-27T03:00:00.000Z");

  it("accepts only an exact, fresh bookmarklet envelope from the captured URL origin", () => {
    const nonce = "C".repeat(43);
    const message = validBookmarkletMessage(nonce, new Date(now).toISOString());

    expect(normalizeLibraryBookmarkletCaptureMessage(
      message,
      nonce,
      "https://source.example",
      now
    )).toMatchObject({
      source: "bookmarklet",
      title: "읽을 자료",
      url: "https://source.example/article"
    });
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      { ...message, body: "주소에 두면 안 되는 본문" },
      nonce,
      "https://source.example",
      now
    )).toThrow("허용되지 않은 필드");
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      message,
      nonce,
      "https://other.example",
      now
    )).toThrow("일치하지 않습니다");
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      validBookmarkletMessage(nonce, new Date(now).toISOString(), { source: "extension" }),
      nonce,
      "https://source.example",
      now
    )).toThrow("출처");
  });

  it("rejects expired or future captures and fails closed on credential-like text", () => {
    const nonce = "D".repeat(43);
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      validBookmarkletMessage(
        nonce,
        new Date(now - libraryBookmarkletCaptureTtlMilliseconds - 1).toISOString()
      ),
      nonce,
      "https://source.example",
      now
    )).toThrow("만료");
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      validBookmarkletMessage(nonce, new Date(now + 30_001).toISOString()),
      nonce,
      "https://source.example",
      now
    )).toThrow("만료");
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      validBookmarkletMessage(nonce, new Date(now).toISOString(), {
        blocks: [{ kind: "paragraph", text: "Bearer abcdefghijklmnopqrstuvwxyz" }]
      }),
      nonce,
      "https://source.example",
      now
    )).toThrow("인증 정보");
    expect(() => normalizeLibraryBookmarkletCaptureMessage(
      validBookmarkletMessage(nonce, new Date(now).toISOString(), {
        blocks: [
          { kind: "heading", text: "Authorization: Bearer" },
          { kind: "paragraph", text: "abcdefghijklmnopqrstuvwxyz" }
        ]
      }),
      nonce,
      "https://source.example",
      now
    )).toThrow("인증 정보");
  });

  it("binds delivery to opener and nonce, consumes once, and sends no auth-dependent acknowledgement", async () => {
    const nonce = "E".repeat(43);
    const opener = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(window, "opener", { configurable: true, value: opener, writable: true });
    const promise = consumeLibraryBookmarkletCaptureHandoff(
      { nonce, source: "bookmarklet" },
      window,
      1_000,
      () => now
    );

    window.dispatchEvent(new MessageEvent("message", {
      data: validBookmarkletMessage("X".repeat(43), new Date(now).toISOString()),
      origin: "https://source.example",
      source: opener
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: validBookmarkletMessage(nonce, new Date(now).toISOString()),
      origin: "https://source.example",
      source: { postMessage: vi.fn() } as unknown as Window
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: validBookmarkletMessage(nonce, new Date(now).toISOString()),
      origin: "https://source.example",
      source: opener
    }));

    await expect(promise).resolves.toMatchObject({ source: "bookmarklet", title: "읽을 자료" });
    expect(opener.postMessage).not.toHaveBeenCalled();
    expect(window.opener).toBeNull();
    await expect(consumeLibraryBookmarkletCaptureHandoff(
      { nonce, source: "bookmarklet" },
      window,
      1_000,
      () => now
    )).rejects.toThrow("이미 사용");
  });

  it("times out without persisting the body when the source page never connects", async () => {
    vi.useFakeTimers();
    const nonce = "F".repeat(43);
    const opener = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(window, "opener", { configurable: true, value: opener, writable: true });
    const promise = consumeLibraryBookmarkletCaptureHandoff(
      { nonce, source: "bookmarklet" },
      window,
      25,
      () => now
    );
    const rejection = expect(promise).rejects.toThrow("응답 시간이 초과");

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(opener.postMessage).not.toHaveBeenCalled();
  });
});

describe("extension one-time handoff", () => {
  const nonce = "A".repeat(43);
  const extensionId = "a".repeat(32);

  it("parses a nonce-only fragment and returns null for unrelated fragments", () => {
    expect(parseLibraryCaptureHandoffFragment(`#capture=${nonce}&extension=${extensionId}`)).toEqual({
      nonce,
      extensionId
    });
    expect(parseLibraryCaptureHandoffFragment("#section=notes")).toBeNull();
    expect(normalizeLibraryCaptureHandoffFragment(`#capture=${nonce}&extension=${extensionId}`)).toBe(
      `#capture=${nonce}&extension=${extensionId}`
    );
    expect(parseLibraryCaptureHandoffFragment(`#capture=${nonce}&source=bookmarklet`)).toEqual({
      nonce,
      source: "bookmarklet"
    });
    expect(normalizeLibraryCaptureHandoffFragment(`#capture=${nonce}&source=bookmarklet`)).toBe(
      `#capture=${nonce}&source=bookmarklet`
    );
    const loginState = createLibraryCaptureLoginState(
      "/library",
      `#capture=${nonce}&extension=${extensionId}`
    );
    expect(parseLibraryCaptureLoginState(loginState)).toEqual(loginState);
    const bookmarkletLoginState = createLibraryCaptureLoginState(
      "/library",
      `#capture=${nonce}&source=bookmarklet`
    );
    expect(parseLibraryCaptureLoginState(bookmarkletLoginState)).toEqual(bookmarkletLoginState);
    expect(createLibraryCaptureLoginState("/admin", `#capture=${nonce}&extension=${extensionId}`)).toBeNull();
  });

  it.each([
    { returnTo: "https://evil.example", captureFragment: `#capture=${nonce}&extension=${extensionId}` },
    { returnTo: "/library", captureFragment: `#capture=${nonce}&extension=${extensionId}`, extra: "/admin" },
    { returnTo: "/library", captureFragment: `#capture=${nonce}&extension=${extensionId}&body=secret` }
  ])("rejects untrusted capture login state without accepting a redirect", (state) => {
    expect(() => parseLibraryCaptureLoginState(state)).toThrow("캡처 로그인 정보");
  });

  it("rejects inherited and accessor-backed login state without invoking getters", () => {
    const inherited = Object.create({
      returnTo: "/library",
      captureFragment: `#capture=${nonce}&extension=${extensionId}`
    });
    expect(() => parseLibraryCaptureLoginState(inherited)).toThrow("캡처 로그인 정보");

    const getter = vi.fn(() => `#capture=${nonce}&extension=${extensionId}`);
    const accessorState = { returnTo: "/library" } as Record<string, unknown>;
    Object.defineProperty(accessorState, "captureFragment", { enumerable: true, get: getter });
    expect(() => parseLibraryCaptureLoginState(accessorState)).toThrow("일반 데이터 필드");
    expect(getter).not.toHaveBeenCalled();

    const getTrap = vi.fn(() => "https://evil.example");
    const proxiedState = new Proxy(
      {
        returnTo: "/library",
        captureFragment: `#capture=${nonce}&extension=${extensionId}`
      },
      { get: getTrap }
    );
    expect(parseLibraryCaptureLoginState(proxiedState)).toEqual({
      returnTo: "/library",
      captureFragment: `#capture=${nonce}&extension=${extensionId}`
    });
    expect(getTrap).not.toHaveBeenCalled();
  });

  it.each([
    `#capture=${nonce}&extension=${extensionId}&body=본문`,
    `#capture=${nonce}&capture=${nonce}&extension=${extensionId}`,
    `#capture=short&extension=${extensionId}`,
    `#capture=${nonce}&extension=invalid`,
    `#capture=${nonce}&source=extension`,
    `#capture=${nonce}&source=bookmarklet&body=본문`,
    `#capture=${nonce}&source=bookmarklet&extension=${extensionId}`
  ])("rejects malformed or body-bearing fragments", (fragment) => {
    expect(() => parseLibraryCaptureHandoffFragment(fragment)).toThrow("핸드오프 주소");
  });

  it("accepts only validated extension-source responses", () => {
    expect(normalizeLibraryCaptureExtensionResponse({ ok: true, payload: validCapture() }).source).toBe("extension");
    expect(() =>
      normalizeLibraryCaptureExtensionResponse({
        ok: true,
        payload: validCapture({ source: "bookmarklet" })
      })
    ).toThrow("출처");
    expect(() => normalizeLibraryCaptureExtensionResponse({ ok: false, error: "MISSING_OR_EXPIRED" })).toThrow(
      "만료되었거나 이미 사용"
    );
  });

  it("does not invoke accessor fields from an untrusted extension response", () => {
    const response: Record<string, unknown> = { payload: validCapture() };
    const getter = vi.fn(() => true);
    Object.defineProperty(response, "ok", { enumerable: true, get: getter });

    expect(() => normalizeLibraryCaptureExtensionResponse(response)).toThrow("응답 형식");
    expect(getter).not.toHaveBeenCalled();
  });

  it("removes the nonce fragment from history even when the handoff is malformed", () => {
    window.history.replaceState({ route: "library" }, "", `/library?view=all#capture=${nonce}&extension=${extensionId}`);

    expect(takeLibraryCaptureHandoffFromLocation()).toEqual({ nonce, extensionId });
    expect(window.location.pathname).toBe("/library");
    expect(window.location.search).toBe("?view=all");
    expect(window.location.hash).toBe("");

    window.history.replaceState(null, "", `/library#capture=${nonce}&source=bookmarklet`);
    expect(takeLibraryCaptureHandoffFromLocation()).toEqual({ nonce, source: "bookmarklet" });
    expect(window.location.hash).toBe("");

    window.history.replaceState(null, "", "/library#capture=invalid");
    expect(() => takeLibraryCaptureHandoffFromLocation()).toThrow("핸드오프 주소");
    expect(window.location.hash).toBe("");
  });

  it("consumes an external handoff once and revalidates the returned payload", async () => {
    const sendMessage = vi.fn((_id, message, callback) => {
      expect(message).toEqual({ nonce, type: "quickmemo.consumeCapture" });
      callback({ ok: true, payload: validCapture() });
    });
    const runtime = { sendMessage } as LibraryCaptureExternalRuntime;

    await expect(consumeLibraryCaptureHandoff({ extensionId, nonce }, runtime)).resolves.toMatchObject({
      source: "extension",
      title: "읽을 자료"
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      extensionId,
      { nonce, type: "quickmemo.consumeCapture" },
      expect.any(Function)
    );
  });

  it("shows a useful error when Chrome external messaging is unavailable", async () => {
    await expect(consumeLibraryCaptureHandoff({ extensionId, nonce }, null)).rejects.toThrow(
      "Chrome 확장 프로그램에 연결할 수 없습니다"
    );
  });
});
