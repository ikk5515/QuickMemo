import { describe, expect, it } from "vitest";
import { parseDataviewQuery } from "./query";

describe("parseDataviewQuery", () => {
  it("maps a bounded TABLE query onto the shared Base engine", () => {
    const result = parseDataviewQuery(`TABLE status AS "상태", file.mtime AS "수정"\nFROM #project AND "Work"\nWHERE status = "active"\nSORT file.mtime DESC\nLIMIT 900`);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("LIMIT은 안전을 위해 200으로 제한했습니다.");
    expect(result.view).toMatchObject({ limit: 200, type: "table", sort: [{ property: "file.mtime", direction: "DESC" }] });
    expect(result.document?.filters).toEqual({ and: ['file.hasTag("project")', 'file.inFolder("Work")'] });
  });

  it("supports LIST with an allowlisted property", () => {
    const result = parseDataviewQuery("LIST rating\nFROM [[Roadmap]]\nWHERE rating >= 4\nLIMIT 20");
    expect(result.errors).toEqual([]);
    expect(result.view?.order).toEqual(["file.name", "rating"]);
    expect(result.document?.filters).toBe('file.hasLink("Roadmap")');
  });

  it("supports bounded TASK filters, CALENDAR dates and GROUP BY", () => {
    const task = parseDataviewQuery('TASK\nFROM #project\nWHERE !completed AND contains(text, "검토")\nGROUP BY status DESC\nLIMIT 50');
    expect(task.errors).toEqual([]);
    expect(task.kind).toBe("task");
    expect(task.taskFilter).toEqual({ completed: false, textContains: "검토" });
    expect(task.view?.groupBy).toEqual({ property: "status", direction: "DESC" });

    const calendar = parseDataviewQuery("CALENDAR due\nFROM \"Projects\"\nSORT due ASC");
    expect(calendar.errors).toEqual([]);
    expect(calendar.kind).toBe("calendar");
    expect(calendar.calendarProperty).toBe("due");
    expect(calendar.view?.order).toEqual(["file.name", "due"]);
  });

  it("fails closed for executable or unknown syntax", () => {
    expect(parseDataviewQuery("TABLE eval(secret)\nWHERE fetch(url)").document).toBeNull();
    expect(parseDataviewQuery("dataviewjs\nfetch('/')").errors[0]).toContain("LIST, TABLE, TASK 또는 CALENDAR");
  });

  it("rejects deeply nested NOT expressions without overflowing the stack", () => {
    const result = parseDataviewQuery(`LIST\nFROM ${"NOT ".repeat(2_000)}#project`);
    expect(result.document).toBeNull();
    expect(result.errors.join(" ")).toContain("깊이 32");
  });

  it("rejects oversized logical ASTs before evaluating them", () => {
    const result = parseDataviewQuery(`LIST\nFROM ${Array.from({ length: 300 }, (_, index) => `#tag${index}`).join(" AND ")}`);
    expect(result.document).toBeNull();
    expect(result.errors.join(" ")).toContain("노드 256");
  });

  it("bounds TABLE columns and rows independently from LIST", () => {
    const columns = Array.from({ length: 40 }, (_, index) => `field${index}`).join(", ");
    const result = parseDataviewQuery(`TABLE ${columns}\nLIMIT 500`);
    expect(result.errors).toEqual([]);
    expect(result.view?.limit).toBe(200);
    expect(result.view?.order).toHaveLength(33);
    expect(result.warnings).toContain("TABLE 열은 안전을 위해 32개로 제한했습니다.");
  });
});
