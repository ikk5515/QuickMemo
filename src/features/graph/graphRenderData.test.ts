import { describe, expect, it } from "vitest";
import { graphNeighborIndex, graphNodeRadius, reconcileGraphRenderData } from "./graphRenderData";
import type { GraphEdge, GraphNode } from "./types";

const nodes: GraphNode[] = [
  { id: "a", label: "A", kind: "note", preview: "Old preview", groupIds: ["old"] },
  { id: "b", label: "B", kind: "note" },
  { id: "c", label: "C", kind: "note" }
];
const edges: GraphEdge[] = [{ id: "ab", sourceId: "a", targetId: "b" }];

describe("graph render data", () => {
  it("keeps settled positions and resolved links across metadata-only snapshots", () => {
    const data = reconcileGraphRenderData(undefined, nodes, edges);
    const node = data.nodes[0];
    Object.assign(node, { x: 36, y: -12, vx: 0.2 });
    data.links[0].source = node;
    data.links[0].target = data.nodes[1];

    const updated = reconcileGraphRenderData(data, [
      nodes[2], nodes[1], { id: "a", label: "Renamed", kind: "note", color: "#fedcba" }
    ], [{ ...edges[0], occurrenceCount: 3 }]);

    expect(updated).toBe(data);
    expect(updated.nodes[0]).toBe(node);
    expect(node).toMatchObject({ label: "Renamed", x: 36, y: -12, vx: 0.2, color: "#fedcba" });
    expect(node.preview).toBeUndefined();
    expect(node.groupIds).toBeUndefined();
    expect(updated.links[0].source).toBe(node);
    expect(updated.links[0].occurrenceCount).toBe(3);
    expect(nodes[0].label).toBe("A");
    expect(nodes[0]).not.toHaveProperty("x");
  });

  it("replaces topology atomically and removes every edge to a removed node", () => {
    const data = reconcileGraphRenderData(undefined, nodes, edges);
    const next = reconcileGraphRenderData(data, [nodes[0], nodes[2]], [
      ...edges, { id: "ac", sourceId: "a", targetId: "c" }
    ]);
    expect(next).not.toBe(data);
    expect(next.nodes.map((node) => node.id)).toEqual(["a", "c"]);
    expect(next.links.map((edge) => edge.id)).toEqual(["ac"]);
    expect(next.nodes[0]).toBe(data.nodes[0]);
    expect(graphNeighborIndex(next).get("a")).toEqual(new Set(["a", "c"]));
  });

  it("notices changed endpoints even when an edge keeps its id", () => {
    const data = reconcileGraphRenderData(undefined, nodes, edges);
    const next = reconcileGraphRenderData(data, nodes, [{ ...edges[0], targetId: "c" }]);
    expect(next).not.toBe(data);
    expect(next.nodes).toBe(data.nodes);
    expect(next.links[0]).toMatchObject({ source: "a", target: "c" });
    expect(graphNeighborIndex(next).get("b")).toEqual(new Set(["b"]));
  });

  it("sizes nodes by distinct inbound degree without giant hub circles", () => {
    expect(graphNodeRadius(0, 1)).toBe(4);
    expect(graphNodeRadius(1, 1)).toBeGreaterThan(graphNodeRadius(0, 1));
    expect(graphNodeRadius(20, 1)).toBeGreaterThan(graphNodeRadius(1, 1));
    expect(graphNodeRadius(5_000, 1)).toBeLessThan(24);
    expect(graphNodeRadius(20, 2)).toBe(graphNodeRadius(20, 1) * 2);
  });
});
