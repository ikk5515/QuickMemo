import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedMarkdownMetadata, VaultIndexEntry } from "../knowledge";
import { DataviewBlock, MAX_DATAVIEW_INPUT_ENTRIES } from "./DataviewBlock";

afterEach(cleanup);

const emptyMetadata: ParsedMarkdownMetadata = {
  aliases: [],
  blocks: [],
  headings: [],
  links: [],
  properties: {},
  tags: []
};

describe("DataviewBlock", () => {
  it("keeps query results read-only even when they display editable-looking properties", () => {
    const entry: VaultIndexEntry = { id: "alpha", kind: "markdown", path: "Alpha.md" };
    const metadataByEntryId = new Map([
      [entry.id, { ...emptyMetadata, properties: { active: true, score: 7, status: "todo" } }]
    ]);

    render(
      <DataviewBlock
        entries={[entry]}
        metadataByEntryId={metadataByEntryId}
        source={'TABLE status, score, active\nWHERE status = "todo"\nLIMIT 20'}
      />
    );

    expect(screen.getByText("todo")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("fails closed instead of showing a partial result when the input bound is exceeded", () => {
    const entries: VaultIndexEntry[] = Array.from(
      { length: MAX_DATAVIEW_INPUT_ENTRIES + 1 },
      (_, index) => ({ id: `entry-${index}`, kind: "markdown", path: `Entry ${index}.md` })
    );
    const metadataByEntryId = new Map(entries.map((entry) => [entry.id, emptyMetadata]));

    render(
      <DataviewBlock
        entries={entries}
        metadataByEntryId={metadataByEntryId}
        source={`LIST\nWHERE file.name = "Entry ${MAX_DATAVIEW_INPUT_ENTRIES}.md"\nLIMIT 200`}
      />
    );

    expect(screen.getByText("Dataview 쿼리를 실행하지 않았습니다.")).toBeInTheDocument();
    expect(screen.getByText(
      `Dataview 입력이 ${MAX_DATAVIEW_INPUT_ENTRIES}개를 넘어 쿼리를 실행하지 않았습니다. 부분 결과는 표시하지 않습니다.`
    )).toBeInTheDocument();
    expect(screen.queryByText("조건에 맞는 Markdown 노트가 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Entry ${MAX_DATAVIEW_INPUT_ENTRIES}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("counts only queryable Markdown rows toward the fail-closed input bound", () => {
    const assets: VaultIndexEntry[] = Array.from(
      { length: MAX_DATAVIEW_INPUT_ENTRIES + 1 },
      (_, index) => ({ id: `asset-${index}`, kind: "asset", path: `Asset ${index}.png` })
    );
    const note: VaultIndexEntry = { id: "target", kind: "markdown", path: "Target.md" };

    render(
      <DataviewBlock
        entries={[...assets, note]}
        metadataByEntryId={new Map([[note.id, emptyMetadata]])}
        source={'LIST\nWHERE file.name = "Target"\nLIMIT 20'}
      />
    );

    expect(screen.getByRole("button", { name: "Target" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders filtered TASK results with optional revision-safe toggle callbacks", async () => {
    const onToggleTask = vi.fn();
    const entry: VaultIndexEntry = {
      id: "tasks",
      kind: "markdown",
      path: "Projects/Tasks.md",
      content: "- [ ] 배포 검토\n- [x] 완료 검토\n```md\n- [ ] 코드 검토\n```"
    };
    render(
      <DataviewBlock
        entries={[entry]}
        metadataByEntryId={new Map([[entry.id, { ...emptyMetadata, properties: { status: "active" } }]])}
        onToggleTask={onToggleTask}
        source={'TASK\nWHERE !completed AND contains(text, "검토")'}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "배포 검토 미완료" });
    expect(screen.queryByText("완료 검토")).not.toBeInTheDocument();
    expect(screen.queryByText("코드 검토")).not.toBeInTheDocument();
    checkbox.click();
    expect(onToggleTask).toHaveBeenCalledWith("tasks", 1, true, {
      checked: false,
      line: 1,
      text: "배포 검토"
    });
  });

  it("renders CALENDAR rows in date order and preserves GROUP BY headings", () => {
    const entries: VaultIndexEntry[] = [
      { id: "later", kind: "markdown", path: "Projects/Later.md" },
      { id: "early", kind: "markdown", path: "Projects/Early.md" }
    ];
    const metadataByEntryId = new Map<string, ParsedMarkdownMetadata>([
      ["later", { ...emptyMetadata, properties: { due: "2026-08-24", status: "todo" } }],
      ["early", { ...emptyMetadata, properties: { due: "2026-08-22", status: "done" } }]
    ]);
    const { container, rerender } = render(
      <DataviewBlock
        entries={entries}
        metadataByEntryId={metadataByEntryId}
        source={'CALENDAR due\nFROM "Projects"'}
      />
    );
    expect([...container.querySelectorAll("time")].map((item) => item.textContent)).toEqual(["2026-08-22", "2026-08-24"]);

    rerender(
      <DataviewBlock
        entries={entries}
        metadataByEntryId={metadataByEntryId}
        source={"LIST\nGROUP BY status ASC"}
      />
    );
    expect(screen.getByRole("heading", { name: "done" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "todo" })).toBeInTheDocument();
  });
});
