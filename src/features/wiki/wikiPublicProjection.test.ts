import { describe, expect, it } from "vitest";
import { WikiPublicProjection } from "./wikiPublicProjection";
import type { WikiReadableNote } from "./wikiModel";

const source: WikiReadableNote = { id: "source", title: "시작", folderId: "root", body: "본문 [[대상|공개 표시]] ![[사진.png|이미지 표시]] [[사라진 파일|비밀 이름]] [이전 파일](secret.md)\n\n`[[예제]]`", entryKind: "markdown", contentFormat: "markdown-v1" };
const target: WikiReadableNote = { id: "target", title: "대상", folderId: "root", body: "", entryKind: "markdown", contentFormat: "markdown-v1" };
const folders = [{ id: "root", displayName: "자료", parentId: null }];
const catalog = [{ id: "source", path: "자료/시작.md", kind: "markdown" as const }, { id: "target", path: "자료/대상.md", kind: "markdown" as const }, { id: "image", path: "자료/사진.png", kind: "asset" as const }];

describe("public wiki display projection", () => {
  it("keeps supplied links and assets while redacting unresolved target labels before indexing", () => {
    const projected = new WikiPublicProjection().project([source, target], folders, catalog);
    expect(projected[0].body).toContain("[[대상|공개 표시]]");
    expect(projected[0].body).toContain("![[사진.png|이미지 표시]]");
    expect(projected[0].body).not.toContain("비밀 이름");
    expect(projected[0].body).not.toContain("secret.md");
    expect(projected[0].body).toContain("[비공개 링크]");
    expect(projected[0].body).toContain("`[[예제]]`");
    expect(source.body).toContain("비밀 이름");
  });

  it("invalidates prior labels immediately when the public catalog contracts", () => {
    const projection = new WikiPublicProjection();
    projection.project([source, target], folders, catalog);
    const next = projection.project([source], folders, catalog.slice(0, 1));
    expect(next[0].body).not.toContain("공개 표시");
    expect(next[0].body).not.toContain("이미지 표시");
    expect(next[0].body).toContain("[비공개 첨부]");
    projection.clear();
    expect(projection.project([source], folders, [])[0].body).toBe("공개 범위를 확인하지 못해 내용을 표시할 수 없습니다.");
  });

  it("retains safe external URLs and self fragments while keeping unsafe schemes out", () => {
    const note = { ...source, body: "[공식](https://example.com) [[#소제목]] [위험](javascript:alert(1))" };
    const result = new WikiPublicProjection().project([note], folders, catalog)[0].body;
    expect(result).toContain("https://example.com");
    expect(result).toContain("[[#소제목]]");
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("위험");
  });

  it("sanitizes legacy HTML and replaces internal anchors and embedded wiki syntax without altering code samples", () => {
    const legacy: WikiReadableNote = { ...source, contentFormat: "legacy-html-v1", entryKind: "legacy-html",
      body: '<p>[[사라진 파일|이전 이름]]</p><a href="relative.md">내부 제목</a><a href="https://example.com">공식</a><code>[[예제]]</code><script>alert(1)</script>' };
    const body = new WikiPublicProjection().project([legacy], folders, catalog)[0].body;
    expect(body).not.toContain("이전 이름"); expect(body).not.toContain("내부 제목"); expect(body).not.toContain("<script");
    expect(body).toContain("https://example.com"); expect(body).toContain("[[예제]]");
  });
});
