import { render } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";
import { ForceGraphRenderer } from "./ForceGraphRenderer";
import { createDefaultGlobalGraphSettings } from "./graphSettings";
import type { GraphEdge, GraphNode } from "./types";

const renderedSnapshots = vi.hoisted(() => [] as Array<{ edgeIds: string[]; nodeIds: string[] }>);

vi.mock("react-force-graph-2d", () => ({
  default: forwardRef(function MockForceGraph(
    props: {
      graphData: {
        links: Array<{ id: string; source: string | { id: string }; target: string | { id: string } }>;
        nodes: Array<{ id: string }>;
      };
    },
    ref
  ) {
    const nodeIds = new Set(props.graphData.nodes.map((node) => node.id));
    const endpointId = (value: string | { id: string }) => typeof value === "string" ? value : value.id;
    for (const edge of props.graphData.links) {
      if (!nodeIds.has(endpointId(edge.source)) || !nodeIds.has(endpointId(edge.target))) {
        throw new Error(`node not found for ${edge.id}`);
      }
    }
    renderedSnapshots.push({
      edgeIds: props.graphData.links.map((edge) => edge.id),
      nodeIds: [...nodeIds]
    });
    useImperativeHandle(ref, () => ({
      centerAt: () => ({ x: 0, y: 0 }),
      d3Force: () => ({ distance: vi.fn(), strength: vi.fn() }),
      d3ReheatSimulation: vi.fn(),
      screen2GraphCoords: (x: number, y: number) => ({ x, y }),
      zoom: () => 1,
      zoomToFit: vi.fn()
    }));
    return <canvas data-testid="force-graph" />;
  })
}));

describe("ForceGraphRenderer", () => {
  it("publishes node and edge updates atomically when linked nodes are added or removed", () => {
    renderedSnapshots.length = 0;
    const nodeA: GraphNode = { id: "a", kind: "note", label: "A" };
    const nodeB: GraphNode = { id: "b", kind: "note", label: "B" };
    const edge: GraphEdge = { id: "a-b", sourceId: "a", targetId: "b" };
    const settings = createDefaultGlobalGraphSettings();
    const onNodeOpen = vi.fn();
    const view = render(
      <ForceGraphRenderer
        edges={[]}
        nodes={[nodeA]}
        onNodeOpen={onNodeOpen}
        settings={settings}
      />
    );

    view.rerender(
      <ForceGraphRenderer
        edges={[edge]}
        nodes={[nodeA, nodeB]}
        onNodeOpen={onNodeOpen}
        settings={settings}
      />
    );
    view.rerender(
      <ForceGraphRenderer
        edges={[]}
        nodes={[nodeB]}
        onNodeOpen={onNodeOpen}
        settings={settings}
      />
    );

    expect(renderedSnapshots).toEqual(expect.arrayContaining([
      { edgeIds: [], nodeIds: ["a"] },
      { edgeIds: ["a-b"], nodeIds: ["a", "b"] },
      { edgeIds: [], nodeIds: ["b"] }
    ]));
  });
});
