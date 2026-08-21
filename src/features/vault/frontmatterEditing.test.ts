import { describe, expect, it } from "vitest";
import {
  UnsupportedFrontmatterPropertyError,
  parsePropertyEditorValue,
  removeFrontmatterProperty,
  setFrontmatterProperty
} from "./frontmatterEditing";

describe("frontmatter editing", () => {
  it("adds frontmatter without changing the Markdown body", () => {
    expect(setFrontmatterProperty("# 제목\n본문", "status", "진행 중"))
      .toBe('---\nstatus: "진행 중"\n---\n\n# 제목\n본문');
  });

  it("updates one property while preserving unrelated comments and body", () => {
    const source = '---\nstatus: "todo" # 상태\naliases:\n  - QM\ncustom: { keep: true }\n---\n# 제목\n';
    expect(setFrontmatterProperty(source, "aliases", ["QuickMemo", "QM"]))
      .toBe('---\nstatus: "todo" # 상태\naliases: ["QuickMemo", "QM"]\ncustom: { keep: true }\n---\n# 제목\n');
  });

  it("removes only the selected scalar or sequence", () => {
    const source = "---\ntags:\n  - work\n  - secure\nstatus: true\n---\n본문";
    expect(removeFrontmatterProperty(source, "tags"))
      .toBe("---\nstatus: true\n---\n본문");
  });

  it("rejects invalid keys and unsupported nested mappings", () => {
    expect(() => setFrontmatterProperty("본문", "bad key", "x")).toThrow(/속성 이름/);
    expect(() => setFrontmatterProperty("---\ncomplex:\n  child: value\n---\n", "complex", "x"))
      .toThrow(UnsupportedFrontmatterPropertyError);
    expect(() => setFrontmatterProperty("---\ntags:\n\n  - work\n---\n", "tags", ["safe"]))
      .toThrow(UnsupportedFrontmatterPropertyError);
    expect(() => setFrontmatterProperty("---\nstatus: todo\n", "status", "done"))
      .toThrow(/닫히지 않은/);
  });

  it("retains basic property types when editing", () => {
    expect(parsePropertyEditorValue("false", true)).toBe(false);
    expect(parsePropertyEditorValue("42", 1)).toBe(42);
    expect(parsePropertyEditorValue("a, b", ["old"])).toEqual(["a", "b"]);
    expect(parsePropertyEditorValue("plain", "old")).toBe("plain");
  });
});
