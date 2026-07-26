import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLibraryCaptureBookmarkletUrl,
  maxLibraryBookmarkletUrlBytes
} from "./libraryBookmarklet";

function canonicalBookmarkletScript(url: string) {
  expect(url.startsWith("javascript:")).toBe(true);
  const anchor = document.createElement("a");
  anchor.setAttribute("href", url);
  const canonicalUrl = anchor.href;
  expect(canonicalUrl).not.toMatch(/[\t\n\r]/);

  const originalScript = decodeURIComponent(url.slice("javascript:".length));
  const canonicalScript = decodeURIComponent(canonicalUrl.slice("javascript:".length));
  expect(canonicalScript).toBe(originalScript);
  return canonicalScript;
}

function executeBookmarklet(url: string) {
  window.eval(canonicalBookmarkletScript(url));
}

function installPopupMock() {
  const popupDocument = document.implementation.createHTMLDocument("QuickMemo 이동");
  const popup = {
    close: vi.fn(),
    closed: false,
    document: popupDocument,
    focus: vi.fn(),
    postMessage: vi.fn()
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  return popup;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.title = "";
  window.history.replaceState(null, "", "/");
});

describe("Safari library capture bookmarklet", () => {
  it("builds only for an exact HTTPS or local origin within the install-size budget", () => {
    const value = createLibraryCaptureBookmarkletUrl("https://quickmemo.example");

    expect(value.startsWith("javascript:")).toBe(true);
    expect(value).toContain("https://quickmemo.example");
    expect(value).not.toMatch(/[\t\n\r]/);
    expect(canonicalBookmarkletScript(value)).toContain("libraryCaptureBookmarkletRuntime");
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(maxLibraryBookmarkletUrlBytes);
    expect(() => createLibraryCaptureBookmarkletUrl("http://quickmemo.example")).toThrow("HTTPS");
    expect(() => createLibraryCaptureBookmarkletUrl("https://quickmemo.example/library")).toThrow("origin");
    expect(() => createLibraryCaptureBookmarkletUrl("javascript:alert(1)")).toThrow();
    expect(() => createLibraryCaptureBookmarkletUrl("http://localhost:4173")).not.toThrow();
  });

  it("captures title, sanitized URL, selection, and readable text without putting the body in navigation", () => {
    vi.useFakeTimers();
    const popup = installPopupMock();
    vi.spyOn(window, "alert").mockImplementation(() => undefined);
    document.title = "Safari 원본 제목";
    window.history.replaceState(
      null,
      "",
      "/read?article=7&access_token=never-store-this#private-fragment"
    );
    document.body.innerHTML = `
      <main><p>메인 본문</p></main>
      <article>
        <header><p>메뉴 제외</p></header>
        <h1>읽을 제목</h1>
        <p>읽을 본문</p>
        <form><input value="폼 비밀"><p>폼 제외</p></form>
      </article>
    `;
    vi.spyOn(document, "getSelection").mockReturnValue({
      toString: () => "선택한 핵심 문장"
    } as Selection);

    executeBookmarklet(createLibraryCaptureBookmarkletUrl("https://quickmemo.example"));

    expect(popup.postMessage).toHaveBeenCalled();
    const [message, targetOrigin] = popup.postMessage.mock.calls[0] as [
      {
        nonce: string;
        payload: {
          blocks: Array<{ kind: string; text: string }>;
          selectionText: string;
          source: string;
          title: string;
          url: string;
        };
        type: string;
      },
      string
    ];
    expect(targetOrigin).toBe("https://quickmemo.example");
    expect(message).toMatchObject({
      type: "quickmemo.libraryCapture.bookmarklet",
      payload: {
        source: "bookmarklet",
        title: "Safari 원본 제목",
        url: "http://localhost:3000/read?article=7",
        selectionText: "선택한 핵심 문장",
        blocks: [
          { kind: "heading", text: "읽을 제목" },
          { kind: "paragraph", text: "읽을 본문" }
        ]
      }
    });
    expect(message.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const navigationLink = popup.document.querySelector<HTMLAnchorElement>("a");
    expect(navigationLink).not.toBeNull();
    expect(navigationLink?.href).toBe(
      `https://quickmemo.example/library#capture=${message.nonce}&source=bookmarklet`
    );
    expect(navigationLink?.href).not.toContain("Safari 원본 제목");
    expect(navigationLink?.href).not.toContain("선택한 핵심 문장");
    expect(navigationLink?.href).not.toContain("/read");
    expect(navigationLink?.referrerPolicy).toBe("no-referrer");
    expect(popup.document.querySelector<HTMLMetaElement>('meta[name="referrer"]')?.content).toBe("no-referrer");
    expect(popup.focus).toHaveBeenCalledOnce();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it.each([
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer\r\nabcdefghijklmnopqrstuvwxyz",
    "access_token=abcdefghijklmno",
    "-----BEGIN PRIVATE KEY-----"
  ])("fails closed before opening QuickMemo when readable text contains a credential: %s", (secret) => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open");
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    document.title = "보안 문서";
    window.history.replaceState(null, "", "/security");
    document.body.innerHTML = `<article><p>${secret}</p></article>`;

    executeBookmarklet(createLibraryCaptureBookmarkletUrl("https://quickmemo.example"));

    expect(open).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      "QuickMemo: 인증 정보로 보이는 텍스트가 있어 캡처를 중단했습니다."
    );
  });

  it("fails closed when a credential is split across adjacent readable blocks", () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open");
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    document.title = "보안 문서";
    window.history.replaceState(null, "", "/security");
    document.body.innerHTML = `
      <article>
        <h2>Authorization: Bearer</h2>
        <p>abcdefghijklmnopqrstuvwxyz</p>
      </article>
    `;

    executeBookmarklet(createLibraryCaptureBookmarkletUrl("https://quickmemo.example"));

    expect(open).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      "QuickMemo: 인증 정보로 보이는 텍스트가 있어 캡처를 중단했습니다."
    );
  });

  it("does not fall back to a body-bearing URL when Safari blocks the popup", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockReturnValue(null);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    document.title = "일반 문서";
    window.history.replaceState(null, "", "/article");
    document.body.innerHTML = "<article><p>본문</p></article>";

    executeBookmarklet(createLibraryCaptureBookmarkletUrl("https://quickmemo.example"));

    expect(alert).toHaveBeenCalledWith(
      "QuickMemo 창을 열 수 없습니다. Safari의 팝업 허용 상태를 확인해주세요."
    );
  });
});
