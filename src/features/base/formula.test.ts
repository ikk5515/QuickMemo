import { describe, expect, it } from "vitest";
import { compileBaseFormula, tryCompileBaseFormula } from "./formula";

describe("Base formula evaluator", () => {
  it("evaluates documented arithmetic, if, property and formatting expressions without eval", () => {
    const values = new Map<string, string | number | boolean | null>([
      ["price", 12.5],
      ["age", 5],
      ["status", "open"]
    ]);
    const resolve = (property: string) => values.get(property);

    expect(compileBaseFormula("(price / age).toFixed(2)").evaluate(resolve)).toEqual({ value: "2.50" });
    expect(compileBaseFormula('if(price, price.toFixed(1) + " dollars")').evaluate(resolve)).toEqual({
      value: "12.5 dollars"
    });
    expect(compileBaseFormula('status.upper() == "OPEN" && price > 10').evaluate(resolve)).toEqual({ value: true });
    expect(compileBaseFormula("if(false, 1)").evaluate(resolve)).toEqual({ value: null });
  });

  it("supports bracket property access and bounded list summary functions", () => {
    expect(compileBaseFormula('note["reading score"] * 2').evaluate((property) => (
      property === "note.reading score" ? 4 : undefined
    ))).toEqual({ value: 8 });
    expect(compileBaseFormula("values.mean().round(3)").evaluate((property) => (
      property === "values" ? [1, 2, 4] : undefined
    ))).toEqual({ value: 2.333 });
  });

  it("rejects executable JavaScript and prototype access instead of evaluating it", () => {
    expect(tryCompileBaseFormula("globalThis.compromised = true").program).toBeUndefined();
    expect(tryCompileBaseFormula("(() => alert(1))()").program).toBeUndefined();
    expect((globalThis as { compromised?: boolean }).compromised).toBeUndefined();
  });

  it("fails closed before a small formula can amplify into an oversized string", () => {
    const replacement = "x".repeat(6_000);
    const program = compileBaseFormula(`seed.replace("a", "${replacement}")`);
    const result = program.evaluate((property) => property === "seed" ? "a".repeat(2_000) : undefined);
    expect(result.value).toBeUndefined();
    expect(result.error).toContain("100,000자");
  });

  it("reports unsupported functions and methods instead of silently returning an empty value", () => {
    expect(compileBaseFormula("unknown()").evaluate(() => undefined)).toEqual({
      value: undefined,
      error: "지원하지 않는 계산식 함수입니다: unknown"
    });
    expect(compileBaseFormula("title.unknown()").evaluate((property) => (
      property === "title" ? "QuickMemo" : undefined
    ))).toEqual({
      value: undefined,
      error: "지원하지 않는 문자열 계산식 메서드입니다: unknown"
    });
  });

  it("bounds flattened function arguments and computes large min/max lists without spread", () => {
    const values = Array.from({ length: 10_000 }, (_, index) => 10_000 - index);
    expect(compileBaseFormula("values.min()").evaluate((property) => (
      property === "values" ? values : undefined
    ))).toEqual({ value: 1 });
    expect(compileBaseFormula("max(values)").evaluate((property) => (
      property === "values" ? values : undefined
    ))).toEqual({ value: 10_000 });
    const tooMany = compileBaseFormula("max(first, second)").evaluate((property) => (
      property === "first" || property === "second" ? values : undefined
    ));
    expect(tooMany.value).toBeUndefined();
    expect(tooMany.error).toContain("10,000개");
  });

  it("reports non-finite numeric results instead of silently materializing them", () => {
    const result = compileBaseFormula("largest * largest").evaluate((property) => (
      property === "largest" ? Number.MAX_VALUE : undefined
    ));
    expect(result.value).toBeUndefined();
    expect(result.error).toContain("유한");
  });

  it("supports bounded list/object literals, numeric indexes and collection expressions", () => {
    expect(compileBaseFormula('[1, 2, 3][1]').evaluate(() => undefined)).toEqual({ value: 2 });
    expect(compileBaseFormula('{title: "memo", scores: [2, 4]}.scores[0]').evaluate(() => undefined)).toEqual({ value: 2 });
    expect(compileBaseFormula('[1, 2, 3, 4].filter(value > 2).map(value * 2).reduce(acc + value, 0)')
      .evaluate(() => undefined)).toEqual({ value: 14 });
    expect(compileBaseFormula('[1, [2, 3], 3].flat().unique().join("-")')
      .evaluate(() => undefined)).toEqual({ value: "1-2-3" });
    expect(tryCompileBaseFormula('{"__proto__": 1}').program).toBeUndefined();
    expect(compileBaseFormula('file["__proto__"]')
      .evaluate((property) => property === "file" ? { __baseType: "object", values: {} } : undefined).error)
      .toContain("사용할 수 없는 객체 속성");
  });

  it("supports typed date and duration arithmetic with bounded formatting", () => {
    expect(compileBaseFormula('date("2024-12-01T00:00:00Z") + "1M" + "4h"')
      .evaluate(() => undefined)).toEqual({
        value: { __baseType: "date", epochMs: Date.parse("2025-01-01T04:00:00Z") }
      });
    expect(compileBaseFormula('(date("2025-01-02T00:00:00Z") - date("2025-01-01T00:00:00Z"))')
      .evaluate(() => undefined)).toEqual({ value: 86_400_000 });
    expect(compileBaseFormula('date("2025-05-27T12:34:56Z").format("YYYY-MM-DD HH:mm:ss")')
      .evaluate(() => undefined)).toEqual({ value: "2025-05-27 12:34:56" });
    expect(compileBaseFormula('duration("5h") * 2')
      .evaluate(() => undefined)).toEqual({
        value: { __baseType: "duration", months: 0, milliseconds: 36_000_000 }
      });
  });

  it("supports typed links/files while rejecting executable URL schemes", () => {
    const currentFile = {
      __baseType: "file" as const,
      basename: "Alpha",
      embeds: [],
      entryId: "alpha",
      ext: "md",
      folder: "Work",
      links: [{ __baseType: "link" as const, external: false, path: "Work/Beta.md" }],
      name: "Alpha.md",
      path: "Work/Alpha.md",
      properties: { __baseType: "object" as const, values: { status: "open" } },
      tags: ["project/quickmemo"]
    };
    const resolve = (property: string) => property === "file" ? currentFile : undefined;
    expect(compileBaseFormula('file.hasTag("project") && file.hasLink("Work/Beta.md")')
      .evaluate(resolve)).toEqual({ value: true });
    expect(compileBaseFormula('file.asLink("Open").display').evaluate(resolve)).toEqual({ value: "Open" });
    expect(compileBaseFormula('file.properties.status').evaluate(resolve)).toEqual({ value: "open" });
    const unsafe = compileBaseFormula('link("javascript:alert(1)")').evaluate(() => undefined);
    expect(unsafe.value).toBeUndefined();
    expect(unsafe.error).toContain("scheme");
  });

  it("caps collection iteration and string amplification in newly supported methods", () => {
    const tooLarge = Array.from({ length: 5_001 }, (_, index) => index);
    const mapped = compileBaseFormula("values.map(value + 1)").evaluate((property) => (
      property === "values" ? tooLarge : undefined
    ));
    expect(mapped.value).toBeUndefined();
    expect(mapped.error).toContain("5,000개");
    const repeated = compileBaseFormula('seed.repeat(100000)').evaluate((property) => (
      property === "seed" ? "ab" : undefined
    ));
    expect(repeated.value).toBeUndefined();
    expect(repeated.error).toContain("100,000자");
  });

  it("supports the documented regex overloads while preserving division syntax", () => {
    expect(compileBaseFormula("6 / 2").evaluate(() => undefined)).toEqual({ value: 3 });
    expect(compileBaseFormula('/abc/i.matches("--ABC--")').evaluate(() => undefined)).toEqual({ value: true });
    expect(compileBaseFormula('"a:b:c:d".replace(/:/, "-")').evaluate(() => undefined)).toEqual({
      value: "a-b:c:d"
    });
    expect(compileBaseFormula('"a:b:c:d".replace(/:/g, "-")').evaluate(() => undefined)).toEqual({
      value: "a-b-c-d"
    });
    expect(compileBaseFormula('"John Smith".replace(/(\\w+) (\\w+)/, "$2, $1")')
      .evaluate(() => undefined)).toEqual({ value: "Smith, John" });
    expect(compileBaseFormula('"a,b,c,d".split(/,/, 3)').evaluate(() => undefined)).toEqual({
      value: ["a", "b", "c"]
    });
  });

  it("rejects unsafe regex shapes and enforces input and replacement budgets", () => {
    for (const expression of [
      '/(a+)+$/.matches("a")',
      '/(a|aa)+$/.matches("a")',
      '/(a)\\1/.matches("aa")',
      '/(?=a)a/.matches("a")',
      '/a{1001}/.matches("a")'
    ]) {
      expect(tryCompileBaseFormula(expression).program, expression).toBeUndefined();
    }

    const oversizedInput = compileBaseFormula("/a/.matches(input)").evaluate((property) => (
      property === "input" ? "a".repeat(10_001) : undefined
    ));
    expect(oversizedInput.value).toBeUndefined();
    expect(oversizedInput.error).toContain("10,000자");

    const amplified = compileBaseFormula("input.replace(/a/g, replacement)").evaluate((property) => {
      if (property === "input") return "a".repeat(100);
      if (property === "replacement") return "x".repeat(2_000);
      return undefined;
    });
    expect(amplified.value).toBeUndefined();
    expect(amplified.error).toContain("100,000자");

    for (const source of [
      'input.replace(/a/g, replacement)',
      'input.replace("a", replacement)'
    ]) {
      const contextualAmplification = compileBaseFormula(source).evaluate((property) => {
        if (property === "input") return "a".repeat(1_000);
        if (property === "replacement") return "$`";
        return undefined;
      });
      expect(contextualAmplification.value, source).toBeUndefined();
      expect(contextualAmplification.error, source).toContain("100,000자");
    }
  });

  it("returns inert HTML, image and icon values and rejects executable schemes", () => {
    expect(compileBaseFormula('html("<strong>safe</strong><script>alert(1)</script>")')
      .evaluate(() => undefined)).toEqual({
        value: { __baseType: "html", source: "<strong>safe</strong><script>alert(1)</script>" }
      });
    expect(compileBaseFormula('image("https://example.com/image.png")').evaluate(() => undefined)).toEqual({
      value: { __baseType: "image", external: true, path: "https://example.com/image.png" }
    });
    expect(compileBaseFormula('image("Assets/image.png")').evaluate(() => undefined)).toEqual({
      value: { __baseType: "image", external: false, path: "Assets/image.png" }
    });
    expect(compileBaseFormula('icon("Arrow-Right")').evaluate(() => undefined)).toEqual({
      value: { __baseType: "icon", name: "arrow-right" }
    });
    expect(compileBaseFormula('link("Target", icon("plus"))').evaluate(() => undefined)).toEqual({
      value: {
        __baseType: "link",
        display: { __baseType: "icon", name: "plus" },
        external: false,
        path: "Target"
      }
    });
    const unsafe = compileBaseFormula('image("javascript:alert(1)")').evaluate(() => undefined);
    expect(unsafe.value).toBeUndefined();
    expect(unsafe.error).toContain("scheme");
  });

  it("refreshes random values per runtime seed while remaining replayable inside one view load", () => {
    const program = compileBaseFormula("random() + random()");
    const first = program.evaluate(() => undefined, { randomSeed: 1234 });
    const replay = program.evaluate(() => undefined, { randomSeed: 1234 });
    const nextLoad = program.evaluate(() => undefined, { randomSeed: 5678 });
    expect(first).toEqual(replay);
    expect(nextLoad.value).not.toBe(first.value);
    expect(first.value).toEqual(expect.any(Number));
    expect(first.value as number).toBeGreaterThanOrEqual(0);
    expect(first.value as number).toBeLessThan(2);

    expect(compileBaseFormula("number(now())").evaluate(() => undefined, { nowEpochMs: 1_748_351_045_123 }))
      .toEqual({ value: 1_748_351_045_123 });
  });

  it("supports a bounded Moment-compatible UTC token surface and bracket literals", () => {
    const result = compileBaseFormula(
      'date("2025-05-27T13:04:05.123Z").format("ddd, MMM D YYYY [at] h:mm:ss.SSS A [Q]Q DDD X x Z")'
    ).evaluate(() => undefined);
    expect(result).toEqual({
      value: "Tue, May 27 2025 at 1:04:05.123 PM Q2 147 1748351045 1748351045123 +00:00"
    });
    const tooLong = compileBaseFormula("now().format(pattern)").evaluate(
      (property) => property === "pattern" ? "Y".repeat(257) : undefined,
      { nowEpochMs: 0 }
    );
    expect(tooLong.value).toBeUndefined();
    expect(tooLong.error).toContain("256자");
  });

  it("resolves file(), link.asFile() and link.linksTo() through the bounded vault resolver", () => {
    const beta = {
      __baseType: "file" as const,
      basename: "Beta",
      embeds: [],
      entryId: "beta",
      ext: "md",
      folder: "Work",
      links: [],
      name: "Beta.md",
      path: "Work/Beta.md",
      properties: { __baseType: "object" as const, values: {} },
      tags: []
    };
    const alpha = {
      ...beta,
      basename: "Alpha",
      entryId: "alpha",
      links: [{ __baseType: "link" as const, external: false, path: beta.path }],
      name: "Alpha.md",
      path: "Work/Alpha.md"
    };
    const byPath = new Map([[alpha.path, alpha], [beta.path, beta]]);
    const runtime = { resolveFile: (path: string) => byPath.get(path) };

    expect(compileBaseFormula('file("Work/Alpha.md").links[0].asFile().path')
      .evaluate(() => undefined, runtime)).toEqual({ value: "Work/Beta.md" });
    expect(compileBaseFormula('link("Work/Alpha.md").linksTo(file("Work/Beta.md"))')
      .evaluate(() => undefined, runtime)).toEqual({ value: true });
    expect(compileBaseFormula('file("Work/Beta.md").asLink("Beta")')
      .evaluate(() => undefined, runtime)).toEqual({
        value: {
          __baseType: "link",
          display: "Beta",
          entryId: "beta",
          external: false,
          path: "Work/Beta.md"
        }
      });
    expect(compileBaseFormula('link("https://example.com").linksTo(file("Work/Beta.md"))')
      .evaluate(() => undefined, runtime)).toEqual({ value: false });
  });
});
