import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captureScript = readFileSync(
  join(process.cwd(), "public", "quickmemo-capture-extension", "capture.js"),
  "utf8"
);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.title = "";
  window.history.replaceState(null, "", "/");
});

describe("QuickMemo Chrome capture runtime", () => {
  it("returns a text-only payload for ordinary readable content", () => {
    document.title = "일반 자료";
    window.history.replaceState(null, "", "/article?item=7#private");
    document.body.innerHTML = "<article><h2>제목</h2><p>읽을 본문</p></article>";
    vi.spyOn(document, "getSelection").mockReturnValue({
      toString: () => "선택한 문장"
    } as Selection);

    expect(window.eval(captureScript)).toMatchObject({
      source: "extension",
      title: "일반 자료",
      url: "http://localhost:3000/article?item=7",
      selectionText: "선택한 문장",
      blocks: [
        { kind: "heading", text: "제목" },
        { kind: "paragraph", text: "읽을 본문" }
      ]
    });
  });

  it("returns no payload when a credential is split across readable blocks", () => {
    document.title = "보안 자료";
    window.history.replaceState(null, "", "/security");
    document.body.innerHTML = `
      <article>
        <h2>Authorization: Bearer</h2>
        <p>abcdefghijklmnopqrstuvwxyz</p>
      </article>
    `;

    expect(window.eval(captureScript)).toBeNull();
  });
});
