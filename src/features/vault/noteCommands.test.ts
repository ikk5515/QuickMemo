import { describe, expect, it } from "vitest";
import { chooseTemplate, expandTemplate, templateCandidates, uniqueNoteTitle } from "./noteCommands";

describe("vault note commands", () => {
  it("creates a local timestamp title for unique notes", () => {
    expect(uniqueNoteTitle(new Date(2026, 7, 22, 3, 4, 5))).toBe("20260822030405");
  });

  it("only exposes Markdown notes inside a Templates folder", () => {
    const notes = [
      { id: "a", title: "회의", body: "template", entryKind: "markdown" },
      { id: "b", title: "일반", body: "note", entryKind: "markdown" },
      { id: "c", title: "canvas", body: "{}", entryKind: "canvas" }
    ];
    const paths = new Map([["a", "Templates/회의.md"], ["b", "일반.md"], ["c", "Templates/canvas.canvas"]]);
    expect(templateCandidates(notes, paths)).toEqual([
      { id: "a", title: "회의", body: "template", path: "Templates/회의.md" }
    ]);
  });

  it("selects exact or unambiguous partial templates", () => {
    const candidates = [
      { id: "a", title: "회의", body: "A", path: "Templates/회의.md" },
      { id: "b", title: "주간 보고", body: "B", path: "Templates/주간 보고.md" }
    ];
    expect(chooseTemplate(candidates, "회의")?.id).toBe("a");
    expect(chooseTemplate(candidates, "주간")?.id).toBe("b");
    expect(chooseTemplate(candidates, "missing")).toBeNull();
  });

  it("expands only supported local placeholders", () => {
    expect(expandTemplate("# {{title}}\n{{date}} {{time}} {{unknown}}", {
      now: new Date(2026, 7, 22, 3, 4),
      title: "회의"
    })).toBe("# 회의\n2026-08-22 03:04 {{unknown}}");
    expect(expandTemplate("{{title}}", {
      now: new Date(2026, 7, 22, 3, 4),
      title: "$& 안전"
    })).toBe("$& 안전");
  });
});
