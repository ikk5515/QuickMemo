import type { GraphEdge, GraphNode } from "./types";

export interface RenderNode extends GraphNode {
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
  x?: number;
  y?: number;
}

export interface RenderEdge {
  id: string;
  occurrenceCount: number;
  source: string | RenderNode;
  target: string | RenderNode;
}

export interface GraphRenderData {
  nodes: RenderNode[];
  links: RenderEdge[];
}

export function nodeIdFromLinkEndpoint(endpoint: RenderEdge["source"]): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

/**
 * Force-graph mutates its private copies with positions and resolved endpoints.
 * Keep those objects, and the graphData identity, when only display metadata
 * changes. Replacing graphData would restart the entire simulation on a rename,
 * color change, or an equivalent worker snapshot.
 */
export function reconcileGraphRenderData(
  previous: GraphRenderData | undefined,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): GraphRenderData {
  const previousNodes = new Map(previous?.nodes.map((node) => [node.id, node]));
  const nextNodes = nodes.map((node) => {
    const rendered = previousNodes.get(node.id);
    if (!rendered) return { ...node };
    // Assign optional fields explicitly as well: removed previews, group
    // memberships, and paths must not linger in the renderer's mutable copy.
    Object.assign(rendered, {
      label: node.label,
      kind: node.kind,
      path: node.path,
      preview: node.preview,
      inboundReferenceCount: node.inboundReferenceCount,
      createdAt: node.createdAt,
      groupIds: node.groupIds,
      color: node.color
    });
    return rendered;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sameNodes = previous?.nodes.length === nodes.length
    && nodes.every((node) => previousNodes.has(node.id));
  const previousEdges = new Map(previous?.links.map((edge) => [edge.id, edge]));
  const nextEdges: RenderEdge[] = [];
  let sameEdges = true;
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) continue;
    const rendered = previousEdges.get(edge.id);
    if (
      rendered
      && nodeIdFromLinkEndpoint(rendered.source) === edge.sourceId
      && nodeIdFromLinkEndpoint(rendered.target) === edge.targetId
    ) {
      rendered.occurrenceCount = edge.occurrenceCount ?? 1;
      nextEdges.push(rendered);
    } else {
      sameEdges = false;
      nextEdges.push({
        id: edge.id,
        occurrenceCount: edge.occurrenceCount ?? 1,
        source: edge.sourceId,
        target: edge.targetId
      });
    }
  }
  sameEdges = sameEdges && previous?.links.length === nextEdges.length;
  if (previous && sameNodes && sameEdges) return previous;
  return {
    nodes: sameNodes && previous ? previous.nodes : nextNodes,
    links: sameEdges && previous ? previous.links : nextEdges
  };
}

/** Index once per topology change; hovering then touches only one neighborhood. */
export function graphNeighborIndex(data: GraphRenderData): Map<string, Set<string>> {
  const neighbors = new Map(data.nodes.map((node) => [node.id, new Set([node.id])]));
  for (const edge of data.links) {
    const sourceId = nodeIdFromLinkEndpoint(edge.source);
    const targetId = nodeIdFromLinkEndpoint(edge.target);
    neighbors.get(sourceId)?.add(targetId);
    neighbors.get(targetId)?.add(sourceId);
  }
  return neighbors;
}

/** Degree grows the radius gently so popular notes do not cover their neighbors. */
export function graphNodeRadius(inboundReferenceCount: number | undefined, nodeSize: number): number {
  const degree = Math.max(0, inboundReferenceCount ?? 0);
  return (4 + 1.5 * Math.log2(1 + degree)) * nodeSize;
}
