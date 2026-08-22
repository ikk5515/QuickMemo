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
  it("combines global/view filters and preserves property order", () => {
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

  it("projects resolved Vault identities into file links and backlinks only in memory", () => {
    const document = parsedDocument(`
views:
  - type: table
    name: Relations
    order: [file.name, file.links, file.backlinks]
`);
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId);
    const alpha = result.groups[0].rows.find((row) => row.entry.id === "alpha");
    const beta = result.groups[0].rows.find((row) => row.entry.id === "beta");

    expect(alpha?.cells["file.links"]).toEqual([
      expect.objectContaining({ __baseType: "link", entryId: "beta", path: "Work/Beta.md" })
    ]);
    expect(beta?.cells["file.backlinks"]).toEqual([
      expect.objectContaining({ __baseType: "link", entryId: "alpha", path: "Work/Alpha.md" })
    ]);
  });

  it("includes eligible non-Markdown vault files with the safe file properties available in the index", () => {
    const document = parsedDocument(`
views:
  - type: table
    name: Every file
    sort:
      - property: file.path
        direction: ASC
    order: [file.name, file.path, file.folder, file.ext, file.ctime, file.mtime, file.size]
`);
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId);
    expect(result.resultCount).toBe(4);
    const canvas = result.groups[0].rows.find((row) => row.entry.id === "canvas");
    expect(canvas?.cells).toMatchObject({
      "file.name": "Board",
      "file.path": "Work/Board.canvas",
      "file.folder": "Work",
      "file.ext": "canvas"
    });
    expect(result.warnings).toEqual([]);
    expect(result.groups[0].rows.find((row) => row.entry.id === "alpha")?.cells["file.size"]).toBe(5);
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

  it("evaluates official date filters and fails genuinely unsupported expressions closed", () => {
    const supported = parsedDocument(`
filters: now() > file.mtime
views:
  - type: table
    name: Date filter
`);
    const supportedResult = materializeBaseView(supported, supported.views[0], entries, metadataByEntryId);
    expect(supportedResult.groups[0].rows.map((row) => row.entry.id)).toEqual(["gamma", "alpha", "beta"]);
    expect(supportedResult.warnings).toEqual([]);

    const negatedUnsupported = parsedDocument(`
filters:
  not:
    - unsafePluginFunction() > file.mtime
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
  label: 'if(formula.score > 5, status.upper(), "LOW")'
summaries:
  Rounded average: values.mean().round(3)
views:
  - type: table
    name: Formula
    filters: formula.score >= 4
    sort:
      - property: formula.score
        direction: DESC
    order: [file.name, formula.score, formula.label]
    summaries:
      formula.score: Average
      priority: Rounded average
`);
    const formulaResult = materializeBaseView(formula, formula.views[0], entries, metadataByEntryId);
    expect(formulaResult.groups[0].rows.map((row) => row.entry.id)).toEqual(["beta", "gamma", "alpha"]);
    expect(formulaResult.groups[0].rows[0].cells).toMatchObject({
      "formula.score": 10,
      "formula.label": "DONE"
    });
    expect(formulaResult.summaries).toEqual([
      { property: "formula.score", name: "Average", value: 20 / 3 },
      { property: "priority", name: "Rounded average", value: 3.333 }
    ]);
    expect(formulaResult.warnings).toEqual([]);
  });

  it("fails circular and JavaScript-shaped formulas closed with explicit diagnostics", () => {
    const formula = parsedDocument(`
formulas:
  a: formula.b + 1
  b: formula.a + 1
  unsafe: globalThis.compromised = true
views:
  - type: table
    name: Formula errors
    order: [file.name, formula.a, formula.unsafe]
`);
    const result = materializeBaseView(formula, formula.views[0], entries, metadataByEntryId);
    expect(result.groups[0].rows[0].cells["formula.a"]).toBeUndefined();
    expect(result.groups[0].rows[0].cells["formula.unsafe"]).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "unsupported-formula" }));
    expect((globalThis as { compromised?: boolean }).compromised).toBeUndefined();
  });

  it("surfaces unsupported formula calls and bounds summary inputs", () => {
    const unsupported = parsedDocument(`
formulas:
  clock: unsafePluginFunction()
views:
  - type: table
    name: Explicit warning
    order: [file.name, formula.clock]
`);
    const unsupportedResult = materializeBaseView(
      unsupported,
      unsupported.views[0],
      entries,
      metadataByEntryId
    );
    expect(unsupportedResult.warnings).toContainEqual(expect.objectContaining({
      code: "unsupported-formula",
      message: expect.stringContaining("지원하지 않는 계산식 함수")
    }));

    const largeEntries = Array.from({ length: 10_001 }, (_, index): VaultIndexEntry => ({
      id: `large-${index}`,
      kind: "markdown",
      path: `Large/${index}.md`
    }));
    const largeMetadata = new Map(largeEntries.map((entry, index) => [
      entry.id,
      metadata({ score: index })
    ]));
    const summary = parsedDocument(`
views:
  - type: table
    name: Bounded summary
    order: [file.name]
    summaries:
      score: Average
`);
    const summaryResult = materializeBaseView(summary, summary.views[0], largeEntries, largeMetadata);
    expect(summaryResult.summaries[0]?.value).toBeUndefined();
    expect(summaryResult.warnings).toContainEqual(expect.objectContaining({
      code: "unsupported-formula",
      message: expect.stringContaining("10,000개")
    }));
  });

  it("projects file objects, resolved links, backlinks, embeds, sizes and typed dates", () => {
    const relatedMetadata = new Map(metadataByEntryId);
    relatedMetadata.set("alpha", metadata({ priority: 2 }, ["project/quickmemo"], [{
      sourceEntryId: "alpha",
      sourcePath: "Work/Alpha.md",
      syntax: "wikilink",
      raw: "![[Beta]]",
      target: "Beta",
      embedded: true,
      line: 1,
      column: 1,
      context: "![[Beta]]"
    }]));
    const document = parsedDocument(`
formulas:
  target: file.links[0].path
  backlinkCount: file.backlinks.length
  embedCount: file.embeds.length
  self: file.file.asLink("열기").path
  year: file.mtime.year
views:
  - type: table
    name: Relations
    order: [file.name, file.size, formula.target, formula.backlinkCount, formula.embedCount, formula.self, formula.year]
`);
    const result = materializeBaseView(document, document.views[0], entries, relatedMetadata);
    const alpha = result.groups[0].rows.find((row) => row.entry.id === "alpha")!;
    const beta = result.groups[0].rows.find((row) => row.entry.id === "beta")!;
    expect(alpha.cells).toMatchObject({
      "file.size": 5,
      "formula.target": "Work/Beta.md",
      "formula.embedCount": 1,
      "formula.self": "Work/Alpha.md",
      "formula.year": 1970
    });
    expect(beta.cells["formula.backlinkCount"]).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("recognizes frontmatter dates and wikilinks as typed Base values", () => {
    const typedMetadata = new Map(metadataByEntryId);
    typedMetadata.set("alpha", metadata({
      due: "2025-05-27T12:34:56Z",
      reference: "[[Beta|다음]]"
    }));
    const document = parsedDocument(`
formulas:
  dueYear: due.year
  referencePath: reference.path
views:
  - type: table
    name: Typed properties
    filters: due >= date("2025-01-01")
    order: [file.name, formula.dueYear, formula.referencePath]
`);
    const result = materializeBaseView(document, document.views[0], entries, typedMetadata);
    expect(result.resultCount).toBe(1);
    expect(result.groups[0].rows[0].cells).toMatchObject({
      "formula.dueYear": 2025,
      "formula.referencePath": "Beta"
    });
  });

  it("evaluates safe regular-expression filters without enabling search-query regexes", () => {
    const document = parsedDocument(`
filters: /^A/.matches(file.name)
formulas:
  normalized: file.path.replace(/\\.md$/, "")
views:
  - type: table
    name: Regex formulas
    order: [file.name, formula.normalized]
`);
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId);
    expect(result.groups[0].rows.map((row) => row.entry.id)).toEqual(["alpha"]);
    expect(result.groups[0].rows[0].cells["formula.normalized"]).toBe("Work/Alpha");
    expect(result.warnings).toEqual([]);
  });

  it("binds this.file to an explicit embedding context and resolves link.linksTo", () => {
    const document = parsedDocument(`
formulas:
  contextPath: this.file.path
  contextStatus: this.file.properties.status
  contextSelf: this.file.file.path
  alphaLinksToContext: link("Work/Alpha.md").linksTo(this.file)
views:
  - type: table
    name: Embedded context
    limit: 1
    order: [file.name, formula.contextPath, formula.contextStatus, formula.contextSelf, formula.alphaLinksToContext]
`);
    const contextMetadata = metadataByEntryId.get("beta")!;
    const result = materializeBaseView(document, document.views[0], entries, metadataByEntryId, {
      thisEntry: entries[1],
      thisMetadata: contextMetadata,
      nowEpochMs: 1_748_351_045_123,
      randomSeed: 314_159
    });
    expect(result.groups[0].rows[0].cells).toMatchObject({
      "formula.contextPath": "Work/Beta.md",
      "formula.contextStatus": "done",
      "formula.contextSelf": "Work/Beta.md",
      "formula.alphaLinksToContext": true
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps random stable for one materialization seed and refreshes it for another view load", () => {
    const document = parsedDocument(`
formulas:
  roll: random()
  loadedAt: number(now())
views:
  - type: table
    name: Random
    order: [file.name, formula.roll, formula.loadedAt]
`);
    const first = materializeBaseView(document, document.views[0], entries, metadataByEntryId, {
      nowEpochMs: 1_748_351_045_123,
      randomSeed: 10
    });
    const replay = materializeBaseView(document, document.views[0], entries, metadataByEntryId, {
      nowEpochMs: 1_748_351_045_123,
      randomSeed: 10
    });
    const nextLoad = materializeBaseView(document, document.views[0], entries, metadataByEntryId, {
      nowEpochMs: 1_748_351_045_123,
      randomSeed: 11
    });
    const cellValues = (result: typeof first, property: string) => result.groups[0].rows.map(
      (row) => row.cells[property]
    );
    expect(cellValues(first, "formula.roll")).toEqual(cellValues(replay, "formula.roll"));
    expect(cellValues(first, "formula.roll")).not.toEqual(cellValues(nextLoad, "formula.roll"));
    expect(cellValues(first, "formula.loadedAt")).toEqual(entries.map(() => 1_748_351_045_123));
  });
});
