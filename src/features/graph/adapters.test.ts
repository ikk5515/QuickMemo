import { describe, expect, it } from "vitest";
import type { GraphSnapshot } from "../knowledge/types";
import { graphSnapshotToUiData } from "./adapters";

describe("graphSnapshotToUiData", () => {
  it("adapts the knowledge worker snapshot without exposing its mutable renderer shape", () => {
    const snapshot: GraphSnapshot = {
      scope: "local",
      rootNodeId: "entry:note-a",
      nodes: [
        {
          id: "entry:note-a",
          kind: "file",
          label: "계획",
          entryId: "note-a",
          path: "Work/계획.md",
          incomingReferenceCount: 2,
          groupId: "work",
          color: "#ff0000",
          createdAt: 1_787_310_000_000
        },
        {
          id: "entry:canvas-a",
          kind: "file",
          label: "연구",
          entryId: "canvas-a",
          path: "Research/연구.canvas",
          incomingReferenceCount: 0
        }
      ],
      edges: [
        {
          id: "link:a-b",
          kind: "internal-link",
          source: "entry:note-a",
          target: "entry:canvas-a",
          occurrenceCount: 3,
          occurrenceLines: [2, 5, 8]
        }
      ]
    };

    expect(graphSnapshotToUiData(snapshot)).toEqual({
      rootNodeId: "entry:note-a",
      nodes: [
        {
          id: "entry:note-a",
          label: "계획",
          kind: "note",
          path: "Work/계획.md",
          inboundReferenceCount: 2,
          groupIds: ["work"],
          color: "#ff0000",
          createdAt: 1_787_310_000_000
        },
        {
          id: "entry:canvas-a",
          label: "연구",
          kind: "canvas",
          path: "Research/연구.canvas",
          inboundReferenceCount: 0,
          groupIds: undefined,
          color: undefined,
          createdAt: undefined
        }
      ],
      edges: [
        {
          id: "link:a-b",
          sourceId: "entry:note-a",
          targetId: "entry:canvas-a",
          occurrenceCount: 3
        }
      ]
    });
  });
});
