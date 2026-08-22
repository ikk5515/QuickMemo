import { describe, expect, it } from "vitest";
import type { RevisionedVaultIndexEntry, VaultEntryPathChange } from "../knowledge";
import { safeCanvasDocument } from "./canvasModel";
import {
  applyCanvasPathRewritePlan,
  planCanvasPathRewritesForPathChanges
} from "./canvasLinkRewrite";

function canvasSource() {
  return `${JSON.stringify({
    nodes: [
      {
        id: "file",
        type: "file",
        x: 0,
        y: 0,
        width: 320,
        height: 220,
        file: "Notes/Old.md",
        subpath: "#Heading"
      },
      {
        id: "group",
        type: "group",
        x: 360,
        y: 0,
        width: 400,
        height: 300,
        label: "자료",
        background: "Assets/old.png",
        backgroundStyle: "cover"
      },
      {
        id: "text",
        type: "text",
        x: 0,
        y: 260,
        width: 500,
        height: 240,
        text: "[[Notes/Old#Heading|노트]]\n[상대 링크](../Notes/Old.md#Heading)"
      }
    ],
    edges: [],
    metadata: { preserved: true }
  })}\n`;
}

const entries: RevisionedVaultIndexEntry[] = [
  {
    id: "canvas",
    path: "Research/Board.canvas",
    kind: "canvas",
    content: canvasSource(),
    revision: 4
  },
  {
    id: "note",
    path: "Notes/Old.md",
    kind: "markdown",
    content: "# Heading\n",
    revision: 2
  },
  {
    id: "asset",
    path: "Assets/old.png",
    kind: "asset",
    revision: 1
  }
];

const pathChanges: VaultEntryPathChange[] = [
  { entryId: "canvas", oldPath: "Research/Board.canvas", newPath: "Projects/Board.canvas" },
  { entryId: "note", oldPath: "Notes/Old.md", newPath: "Archive/New.md" },
  { entryId: "asset", oldPath: "Assets/old.png", newPath: "Media/new.png" }
];

describe("Canvas path rewrites", () => {
  it("updates file cards, group backgrounds, and Markdown text card links", () => {
    const plans = planCanvasPathRewritesForPathChanges({ entries, pathChanges });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      sourceEntryId: "canvas",
      sourcePath: "Research/Board.canvas",
      rewrittenSourcePath: "Projects/Board.canvas",
      expectedRevision: 4,
      changeCount: 4
    });

    const document = safeCanvasDocument(plans[0].rewrittenSource);
    expect(document.metadata).toEqual({ preserved: true });
    expect(document.nodes[0]).toMatchObject({
      file: "Archive/New.md",
      subpath: "#Heading"
    });
    expect(document.nodes[1]).toMatchObject({
      background: "Media/new.png",
      backgroundStyle: "cover"
    });
    expect(document.nodes[2].text).toBe(
      "[[New#Heading|노트]]\n[상대 링크](../Archive/New.md#Heading)"
    );
  });

  it("returns no plan when the path changes do not affect Canvas content", () => {
    const plans = planCanvasPathRewritesForPathChanges({
      entries,
      pathChanges: [{ entryId: "asset", oldPath: "Assets/old.png", newPath: "Assets/new.png" }]
    });
    expect(plans).toHaveLength(1);
    expect(safeCanvasDocument(plans[0].rewrittenSource).nodes[1]).toMatchObject({
      background: "Assets/new.png"
    });

    const unaffected = planCanvasPathRewritesForPathChanges({
      entries,
      pathChanges: [{ entryId: "canvas", oldPath: "Research/Board.canvas", newPath: "Research/Renamed.canvas" }]
    });
    expect(unaffected).toEqual([]);
  });

  it("fails closed for malformed Canvas sources", () => {
    expect(() => planCanvasPathRewritesForPathChanges({
      entries: [
        ...entries.filter((entry) => entry.id !== "canvas"),
        { id: "canvas", path: "Board.canvas", kind: "canvas", content: "{bad", revision: 1 }
      ],
      pathChanges: [{ entryId: "note", oldPath: "Notes/Old.md", newPath: "Notes/New.md" }]
    })).toThrow(/Cannot safely update references in Canvas/);
  });

  it("applies only to the exact planned revision and source", () => {
    const [plan] = planCanvasPathRewritesForPathChanges({ entries, pathChanges });
    expect(applyCanvasPathRewritePlan(plan, canvasSource(), 4)).toMatchObject({
      status: "applied",
      appliedChangeCount: 4,
      nextRevision: 5
    });
    expect(applyCanvasPathRewritePlan(plan, canvasSource(), 5)).toMatchObject({
      status: "conflict",
      reason: "revision-mismatch"
    });
    expect(applyCanvasPathRewritePlan(plan, `${canvasSource()} `, 4)).toMatchObject({
      status: "conflict",
      reason: "content-mismatch"
    });
  });
});
