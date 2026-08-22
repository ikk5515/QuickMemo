import { describe, expect, it } from "vitest";
import {
  MAX_KANBAN_PARSE_DIAGNOSTICS,
  createKanbanSource,
  exportObsidianKanbanMarkdown,
  importKanbanMarkdown,
  parseKanbanSource,
  serializeKanbanDocument
} from "./model";

describe("Kanban Markdown model", () => {
  it("round-trips supported columns and cards", () => {
    const source = createKanbanSource("프로젝트")
      .replace("quickmemo-plugin: kanban-v1", "quickmemo-plugin: kanban-v1\ntags: [board]")
      .replace("## 할 일\n", "## 할 일\n- [ ] 조사\n");
    const parsed = parseKanbanSource(source);
    expect(parsed.readOnly).toBe(false);
    expect(parsed.document?.columns[0].cards[0]).toMatchObject({ checked: false, text: "조사" });
    const serialized = serializeKanbanDocument(parsed.document!);
    expect(parseKanbanSource(serialized).document).toMatchObject({ title: "프로젝트" });
    expect(serialized).toContain("tags: [board]");
  });

  it("fails closed instead of deleting unsupported Markdown", () => {
    const source = createKanbanSource().replace("## 할 일\n", "## 할 일\n> callout\n");
    const parsed = parseKanbanSource(source);
    expect(parsed.readOnly).toBe(true);
    expect(parsed.errors[0]).toContain("보존");
  });

  it.each([
    ["보드 제목", (value: string) => createKanbanSource().replace("# Kanban", `# ${value}`)],
    ["열 제목", (value: string) => createKanbanSource().replace("## 할 일", `## ${value}`)],
    ["카드", (value: string) => createKanbanSource().replace("## 할 일\n", `## 할 일\n- [ ] ${value}\n`)]
  ])("fails closed without truncating an existing 501-character %s", (_label, makeSource) => {
    const value = "가".repeat(501);
    const parsed = parseKanbanSource(makeSource(value));
    expect(parsed.readOnly).toBe(true);
    expect(parsed.errors.join(" ")).toContain("500자를 초과");
    expect(JSON.stringify(parsed.document)).toContain(value);
  });

  it("rejects overlong edited values instead of silently slicing them", () => {
    const parsed = parseKanbanSource(createKanbanSource());
    parsed.document!.columns[0].title = "가".repeat(501);
    expect(() => serializeKanbanDocument(parsed.document!)).toThrow("500자");
  });

  it("caps diagnostics for a near-limit board with many unsupported lines", () => {
    const header = "---\nquickmemo-plugin: kanban-v1\n---\n";
    const source = `${header}${"x\n".repeat(Math.floor((499_900 - header.length) / 2))}`;
    const parsed = parseKanbanSource(source);

    expect(new TextEncoder().encode(source).byteLength).toBeLessThanOrEqual(500_000);
    expect(parsed.document).toBeNull();
    expect(parsed.readOnly).toBe(true);
    expect(parsed.errors).toHaveLength(MAX_KANBAN_PARSE_DIAGNOSTICS);
    expect(parsed.errors.at(-1)).toContain("추가 진단 2개");
  });

  it("round-trips one-level card checklists as ordinary Markdown tasks", () => {
    const source = createKanbanSource().replace(
      "## 할 일\n",
      "## 할 일\n- [ ] 릴리스\n  - [x] 테스트\n  - [ ] 배포\n"
    );
    const parsed = parseKanbanSource(source);

    expect(parsed.readOnly).toBe(false);
    expect(parsed.document?.columns[0].cards[0].checklist).toEqual([
      expect.objectContaining({ checked: true, text: "테스트" }),
      expect.objectContaining({ checked: false, text: "배포" })
    ]);
    expect(serializeKanbanDocument(parsed.document!)).toContain("  - [x] 테스트\n  - [ ] 배포");
  });

  it("imports an Obsidian Kanban note explicitly and exports its compatible marker", () => {
    const imported = importKanbanMarkdown(`---
kanban-plugin: basic
tags: [project]
---
# 릴리스

## 할 일
- [ ] 점검
  - [ ] 모바일

%% kanban:settings
{"lane-width":300}
%%
`);

    expect(imported.errors).toEqual([]);
    expect(imported.warnings[0]).toContain("표시 설정");
    expect(imported.source).toContain("quickmemo-plugin: kanban-v1");
    expect(imported.source).toContain("tags: [project]");
    const parsed = parseKanbanSource(imported.source!);
    expect(parsed.document?.columns[0].cards[0].checklist?.[0].text).toBe("모바일");
    expect(exportObsidianKanbanMarkdown(parsed.document!)).toContain("kanban-plugin: basic");
  });

  it("fails a lossy general Markdown import without changing the source", () => {
    const source = "# Board\n\n## Lane\n\n> keep this callout\n";
    const imported = importKanbanMarkdown(source);
    expect(imported.source).toBeNull();
    expect(imported.errors.join(" ")).toContain("보존");
    expect(source).toContain("keep this callout");
  });
});
