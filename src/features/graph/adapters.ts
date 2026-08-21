import type { GraphSnapshot as KnowledgeGraphSnapshot } from "../knowledge/types";
import type { GraphNode, GraphNodeKind, GraphUiData } from "./types";

function uiNodeKind(node: KnowledgeGraphSnapshot["nodes"][number]): GraphNodeKind {
  if (node.kind === "file") {
    return node.path?.toLocaleLowerCase().endsWith(".canvas") ? "canvas" : "note";
  }
  return node.kind;
}

function uiNode(node: KnowledgeGraphSnapshot["nodes"][number]): GraphNode {
  return {
    id: node.id,
    label: node.label,
    kind: uiNodeKind(node),
    path: node.path,
    inboundReferenceCount: node.incomingReferenceCount,
    groupIds: node.groupId ? [node.groupId] : undefined,
    color: node.color,
    createdAt: node.createdAt
  };
}

export function graphSnapshotToUiData(snapshot: KnowledgeGraphSnapshot): GraphUiData {
  return {
    nodes: snapshot.nodes.map(uiNode),
    edges: snapshot.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.source,
      targetId: edge.target,
      occurrenceCount: edge.occurrenceCount
    })),
    rootNodeId: snapshot.rootNodeId
  };
}
