import { describe, expect, it } from "vitest";
import { parseBaseSource } from "./parser";

describe("parseBaseSource", () => {
  it("parses Obsidian-style filters, property labels, order, grouping and supported views", () => {
    const result = parseBaseSource(`
filters:
  and:
    - file.hasTag("project")
properties:
  status:
    displayName: 상태
  file.ext:
    displayName: 확장자
views:
  - type: table
    name: 진행 중
    limit: 25
    groupBy:
      property: status
      direction: DESC
    order:
      - file.name
      - status
    sort:
      - property: priority
        direction: DESC
  - type: cards
    name: 카드
  - type: list
    name: 목록
`);

    expect(result.errors).toEqual([]);
    expect(result.document?.properties.status).toEqual({ displayName: "상태" });
    expect(result.document?.views.map((view) => view.type)).toEqual(["table", "cards", "list"]);
    expect(result.document?.views[0]).toMatchObject({
      name: "진행 중",
      limit: 25,
      groupBy: { property: "status", direction: "DESC" },
      order: ["file.name", "status"],
      sort: [{ property: "priority", direction: "DESC" }]
    });
  });

  it("retains formulas only as inert strings and emits explicit warnings", () => {
    const result = parseBaseSource(`
formulas:
  dangerous: 'globalThis.compromised = true'
views:
  - type: table
    name: Formula table
    order: [file.name, formula.dangerous]
`);

    expect(result.errors).toEqual([]);
    expect(result.document?.formulas.dangerous).toBe("globalThis.compromised = true");
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "unsupported-formula",
      path: "formulas.dangerous"
    }));
    expect((globalThis as { compromised?: boolean }).compromised).toBeUndefined();
  });

  it("rejects aliases, custom tags, duplicate keys and prototype-shaped mappings", () => {
    expect(parseBaseSource("shared: &shared [file.name]\nviews: *shared").errors[0]?.code).toBe("unsafe-yaml");
    expect(parseBaseSource("views: !!js/function 'alert(1)'").errors[0]?.code).toBe("invalid-yaml");
    expect(parseBaseSource("views: []\nviews: []").errors[0]?.code).toBe("invalid-yaml");
    expect(parseBaseSource("__proto__:\n  polluted: true\nviews: []").errors[0]?.code).toBe("unsafe-yaml");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("uses a safe default table for an empty file and rejects oversized input", () => {
    const empty = parseBaseSource("");
    expect(empty.errors).toEqual([]);
    expect(empty.document?.views).toEqual([
      { type: "table", name: "Table", order: ["file.name"], sort: [] }
    ]);

    const oversized = parseBaseSource(`views: []\npadding: ${"가".repeat(180_000)}`);
    expect(oversized.document).toBeNull();
    expect(oversized.errors[0]).toMatchObject({ code: "unsafe-yaml" });
  });

  it("rejects malformed view collections and duplicate view names", () => {
    expect(parseBaseSource("views: table").errors).toContainEqual(expect.objectContaining({
      code: "invalid-schema",
      path: "views"
    }));
    expect(parseBaseSource(`
views:
  - type: table
    name: Same
  - type: cards
    name: same
`).errors).toContainEqual(expect.objectContaining({
      code: "invalid-schema",
      path: "views"
    }));
  });
});
