import { describe, expect, it } from "vitest";
import type { ParsedMarkdownMetadata, VaultIndexEntry } from "../knowledge";
import { materializeBaseView } from "./engine";
import { parseBaseSource } from "./parser";

function metadata(
  properties: ParsedMarkdownMetadata["properties"],
  tags: string[] = [],
  links: ParsedMarkdownMetadata["links"] = []
): ParsedMarkdownMetadata {
  return { aliases: [], blocks: [], headings: [], links, properties, tags };
}

const entries: VaultIndexEntry[] = [
  { id: "alpha", kind: "markdown", path: "Work/Alpha.md", content: "Alpha", createdAt: 10, updatedAt: 30 },
  { id: "beta", kind: "markdown", path: "Work/Beta.md", content: "Beta", createdAt: 20, updatedAt: 20 },
  { id: "gamma", kind: "markdown", path: "Personal/Gamma.md", content: "Gamma", createdAt: 30, updatedAt: 10 },
  { id: "canvas", kind: "canvas", path: "Work/Board.canvas" }
];
const metadataByEntryId = new Map<string, ParsedMarkdownMetadata>([
  ["alpha", metadata({ priority: 2, status: "todo" }, ["project"], [{
    sourceEntryId: "alpha",
    sourcePath: "Work/Alpha.md",
    syntax: "wikilink",
    raw: "[[Beta]]",
    target: "Beta",
    embedded: false,
    line: 1,
    column: 1,
    context: "[[Beta]]"
  }])],
  ["beta", metadata({ priority: 5, status: "done" }, ["project"])],
  ["gamma", metadata({ priority: 3, status: "todo" }, ["personal"])],
  ["canvas", metadata({})]
]);

function parsedDocument(source: string) {
  const parsed = parseBaseSource(source);
  expect(parsed.errors).toEqual([]);
  return parsed.document!;
}

describe("materializeBaseView", () => {
  it("combines global/view filters, excludes non-Markdown files and preserves property order", () => {
    const document = parsedDocument(`
filters:
  and:
    - file.inFolder("Work")
    - file.hasTag("project")
properties:
  status:
    displayName: 상태
views:
  - type: table
    name: Open work
    filters:
      and:
        - status != "done"
        - file.hasLink("Beta")
    order: [file.name, status, priority]
`);
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId);

    expect(result.columns).toEqual(["file.name", "status", "priority"]);
    expect(result.resultCount).toBe(1);
    expect(result.groups[0].rows[0].entry.id).toBe("alpha");
    expect(result.groups[0].rows[0].cells).toMatchObject({ status: "todo", priority: 2 });
  });

  it("sorts by typed properties, groups in the requested direction and applies limits", () => {
    const document = parsedDocument(`
views:
  - type: cards
    name: Grouped
    limit: 3
    groupBy:
      property: status
      direction: DESC
    sort:
      - property: priority
        direction: DESC
    order: [file.name, priority, status]
`);
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId);

    expect(result.groups.map((group) => group.label)).toEqual(["todo", "done"]);
    expect(result.groups.flatMap((group) => group.rows).map((row) => row.entry.id)).toEqual([
      "gamma",
      "alpha",
      "beta"
    ]);
  });

  it("reuses VaultSearchQuery for explicit search filters", () => {
    const document = parsedDocument(`
filters: 'query: tag:project path:"Work"'
views:
  - type: list
    name: Search
    order: [file.name]
`);
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId);
    expect(result.groups[0].rows.map((row) => row.entry.id)).toEqual(["alpha", "beta"]);
  });

  it("fails unsupported expressions closed and never evaluates formula properties", () => {
    const unsupported = parsedDocument(`
filters: now() > file.mtime
views:
  - type: table
    name: Safe
`);
    const unsupportedResult = materializeBaseView(unsupported, unsupported.views[0], entries, metadataByEntryId);
    expect(unsupportedResult.resultCount).toBe(0);
    expect(unsupportedResult.warnings).toContainEqual(expect.objectContaining({ code: "unsupported-filter" }));

    const negatedUnsupported = parsedDocument(`
filters:
  not:
    - now() > file.mtime
views:
  - type: table
    name: Still safe
`);
    const negatedResult = materializeBaseView(
      negatedUnsupported,
      negatedUnsupported.views[0],
      entries,
      metadataByEntryId
    );
    expect(negatedResult.resultCount).toBe(0);

    const regex = parsedDocument(`
filters: 'query: content:/(a+)+$/'
views:
  - type: table
    name: No regex on main thread
`);
    const regexResult = materializeBaseView(regex, regex.views[0], entries, metadataByEntryId);
    expect(regexResult.resultCount).toBe(0);
    expect(regexResult.warnings[0]?.message).toContain("정규식 필터");

    const formula = parsedDocument(`
formulas:
  score: priority * 2
views:
  - type: table
    name: Formula
    order: [file.name, formula.score]
`);
    const formulaResult = materializeBaseView(formula, formula.views[0], entries, metadataByEntryId);
    expect(formulaResult.groups[0].rows[0].cells["formula.score"]).toBeUndefined();
    expect(formulaResult.warnings).toContainEqual(expect.objectContaining({ code: "unsupported-formula" }));
  });
});
