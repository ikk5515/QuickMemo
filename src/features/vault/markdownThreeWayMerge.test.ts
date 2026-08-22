import { describe, expect, it } from "vitest";
import {
  buildMarkdownMergePlan,
  combineMarkdownConflictVersions,
  MAX_MARKDOWN_MERGE_INPUT_BYTES,
  MAX_MARKDOWN_MERGE_LINES,
  resolveMarkdownMergePlan
} from "./markdownThreeWayMerge";

function resolved(plan: ReturnType<typeof buildMarkdownMergePlan>) {
  const result = resolveMarkdownMergePlan(plan, {});
  expect(result.status).toBe("resolved");
  if (result.status !== "resolved") throw new Error("expected resolved merge");
  return result.markdown;
}

describe("bounded Markdown 3-way merge", () => {
  it("keeps either unchanged side and preserves exact newline bytes", () => {
    const base = "# 제목\r\n본문\r\n";
    const local = "# 제목\r\n로컬 본문\r\n";
    expect(resolved(buildMarkdownMergePlan(base, local, base))).toBe(local);
    expect(resolved(buildMarkdownMergePlan(base, base, local))).toBe(local);
    expect(resolved(buildMarkdownMergePlan(base, local, local))).toBe(local);
    expect(resolved(buildMarkdownMergePlan("a\rb\r", "a\rlocal\r", "a\rb\r"))).toBe("a\rlocal\r");
  });

  it("automatically merges disjoint line edits", () => {
    const base = ["# 회의", "", "alpha", "beta", "gamma", ""].join("\n");
    const local = ["# 회의", "", "alpha-local", "beta", "gamma", ""].join("\n");
    const remote = ["# 회의", "", "alpha", "beta", "gamma-server", ""].join("\n");
    const plan = buildMarkdownMergePlan(base, local, remote);

    expect(plan.mode).toBe("merged");
    expect(plan.conflicts).toHaveLength(0);
    expect(resolved(plan)).toBe(
      ["# 회의", "", "alpha-local", "beta", "gamma-server", ""].join("\n")
    );
  });

  it("deduplicates the same insertion made by both sides", () => {
    const base = "first\nlast\n";
    const changed = "first\nshared\nlast\n";
    expect(resolved(buildMarkdownMergePlan(base, changed, changed))).toBe(changed);
  });

  it("merges insertions and deletions that touch separate base ranges", () => {
    const base = "alpha\nbeta\ngamma\ndelta\n";
    const local = "intro\nalpha\nbeta\ngamma\ndelta\n";
    const remote = "alpha\nbeta\ndelta\n";
    expect(resolved(buildMarkdownMergePlan(base, local, remote))).toBe("intro\nalpha\nbeta\ndelta\n");
  });

  it("preserves independent insertions at opposite document boundaries", () => {
    const base = "alpha\nbeta\n";
    const local = "local-first\nalpha\nbeta\n";
    const remote = "alpha\nbeta\nremote-last\n";
    expect(resolved(buildMarkdownMergePlan(base, local, remote))).toBe(
      "local-first\nalpha\nbeta\nremote-last\n"
    );
  });

  it("requires an explicit choice for overlapping edits and preserves every source", () => {
    const plan = buildMarkdownMergePlan("before\nbase\nafter\n", "before\nlocal\nafter\n", "before\nserver\nafter\n");

    expect(plan.mode).toBe("needs-resolution");
    expect(plan.conflicts).toEqual([expect.objectContaining({
      baseText: "base\n",
      localText: "local\n",
      remoteText: "server\n"
    })]);
    expect(resolveMarkdownMergePlan(plan, {})).toEqual({ conflictIndexes: [0], status: "unresolved" });
    expect(resolveMarkdownMergePlan(plan, { 0: { choice: "local" } })).toEqual({
      markdown: "before\nlocal\nafter\n",
      status: "resolved"
    });
    expect(resolveMarkdownMergePlan(plan, { 0: { choice: "remote" } })).toEqual({
      markdown: "before\nserver\nafter\n",
      status: "resolved"
    });
    expect(resolveMarkdownMergePlan(plan, { 0: { choice: "both" } })).toEqual({
      markdown: "before\nlocal\nserver\nafter\n",
      status: "resolved"
    });
    expect(resolveMarkdownMergePlan(plan, { 0: { choice: "manual", manualText: "reviewed\n" } })).toEqual({
      markdown: "before\nreviewed\nafter\n",
      status: "resolved"
    });
  });

  it("keeps multiple conflict resolutions scoped by their non-sensitive ordinal", () => {
    const plan = buildMarkdownMergePlan(
      "one\ntwo\nthree\nfour\n",
      "one-local\ntwo\nthree-local\nfour\n",
      "one-server\ntwo\nthree-server\nfour\n"
    );
    expect(plan.conflicts).toHaveLength(2);
    expect(resolveMarkdownMergePlan(plan, {
      0: { choice: "local" },
      1: { choice: "remote" }
    })).toEqual({
      markdown: "one-local\ntwo\nthree-server\nfour\n",
      status: "resolved"
    });
  });

  it("fails closed to a whole-document choice when byte or line limits are exceeded", () => {
    const tooLarge = "x".repeat(MAX_MARKDOWN_MERGE_INPUT_BYTES + 1);
    const bytePlan = buildMarkdownMergePlan("base", tooLarge, "server");
    expect(bytePlan).toMatchObject({ limitReason: "input-too-large", mode: "comparison-blocked" });
    expect(bytePlan.conflicts[0]).toMatchObject({ localText: tooLarge, remoteText: "server" });

    const tooManyLines = `${"line\n".repeat(MAX_MARKDOWN_MERGE_LINES)}last`;
    const linePlan = buildMarkdownMergePlan("base", tooManyLines, "server");
    expect(linePlan).toMatchObject({ limitReason: "too-many-lines", mode: "comparison-blocked" });
    expect(resolveMarkdownMergePlan(linePlan, {})).toMatchObject({ status: "unresolved" });
  });

  it("never permits callers to expand the comparison time budget", () => {
    const base = Array.from({ length: 2_000 }, (_, index) => `base-${index}`).join("\n");
    const local = base.replace("base-300", "local-300");
    const remote = base.replace("base-1700", "remote-1700");
    const plan = buildMarkdownMergePlan(base, local, remote, { timeBudgetMs: Number.POSITIVE_INFINITY });
    expect(["merged", "comparison-blocked"]).toContain(plan.mode);
    if (plan.mode === "merged") {
      expect(resolved(plan)).toContain("local-300");
      expect(resolved(plan)).toContain("remote-1700");
    } else {
      expect(plan.limitReason).toMatch(/budget/u);
    }
  });

  it("fails closed immediately when a caller tightens the time budget to zero", () => {
    const plan = buildMarkdownMergePlan("base\n", "local\n", "remote\n", { timeBudgetMs: 0 });
    expect(plan).toMatchObject({ limitReason: "time-budget", mode: "comparison-blocked" });
    expect(plan.conflicts[0]).toMatchObject({ localText: "local\n", remoteText: "remote\n" });
  });

  it("reports an oversized selected result instead of returning plaintext for persistence", () => {
    const local = "l".repeat(300_000);
    const remote = "r".repeat(300_000);
    const plan = buildMarkdownMergePlan("base", local, remote);
    expect(resolveMarkdownMergePlan(plan, { 0: { choice: "both" } })).toEqual({
      maxBytes: 500_000,
      status: "output-too-large"
    });
  });

  it("joins both versions without removing either source string", () => {
    expect(combineMarkdownConflictVersions("local", "server")).toBe("local\nserver");
    expect(combineMarkdownConflictVersions("local\n", "server")).toBe("local\nserver");
    expect(combineMarkdownConflictVersions("", "server")).toBe("server");
  });
});
