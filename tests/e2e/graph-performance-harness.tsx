import { createRoot } from "react-dom/client";
import { GraphCanvas } from "../../src/features/graph/GraphCanvas";
import { createDefaultGlobalGraphSettings } from "../../src/features/graph/graphSettings";
import type {
  GraphEdge,
  GraphNode,
  GraphViewport
} from "../../src/features/graph/types";
import { KnowledgeWorkerClient } from "../../src/features/knowledge/knowledgeWorkerClient";
import type { VaultIndexEntry } from "../../src/features/knowledge/types";

const nodeCount = 5_000;

interface GraphPerformanceHarnessState {
  edgeCount: number;
  endToEndStartedAt: number;
  filterGroupDurationsMs: number[];
  fixtureBuildMs: number;
  lastViewport?: GraphViewport;
  nodeCount: number;
  renderStartedAt: number;
  workerBuildMs: number;
}

declare global {
  interface Window {
    __QUICKMEMO_GRAPH_PERFORMANCE__?: GraphPerformanceHarnessState;
  }
}

const endToEndStartedAt = performance.now();
const fixtureStartedAt = endToEndStartedAt;
const entries: VaultIndexEntry[] = Array.from({ length: nodeCount }, (_, index) => ({
  content: [
    `[[Note-${(index + 1) % nodeCount}]]`,
    `[[Note-${(index + 97) % nodeCount}]]`,
    index % 2 === 0 ? "#benchmark/even" : "#benchmark/odd"
  ].join(" "),
  createdAt: index,
  id: `note-${index}`,
  kind: "markdown",
  path: `Notes/Note-${index}.md`
}));
const fixtureBuildMs = performance.now() - fixtureStartedAt;
const worker = new KnowledgeWorkerClient();
const workerStartedAt = performance.now();
await worker.replaceVault(entries);
const snapshot = await worker.globalGraphSnapshot(createDefaultGlobalGraphSettings());
const workerBuildMs = performance.now() - workerStartedAt;
const filterGroupCases = [
  {
    groups: [
      { color: "#8b82f6", id: "even", order: 0, query: "tag:benchmark/even" },
      { color: "#3ba272", id: "odd", order: 1, query: "tag:benchmark/odd" }
    ],
    query: ""
  },
  { groups: [], query: "tag:benchmark/even" },
  { groups: [], query: "tag:benchmark/odd" },
  { groups: [], query: "path:Notes" },
  { groups: [], query: "file:Note-1" },
  { groups: [], query: "-tag:benchmark/odd" },
  {
    groups: [
      { color: "#3ba272", id: "odd-first", order: 0, query: "tag:benchmark/odd" },
      { color: "#8b82f6", id: "all", order: 1, query: "path:Notes" }
    ],
    query: "path:Notes"
  },
  { groups: [], query: "(tag:benchmark/even OR tag:benchmark/odd) path:Notes" }
] as const;
const filterGroupDurationsMs: number[] = [];

for (const benchmarkCase of filterGroupCases) {
  const settings = createDefaultGlobalGraphSettings();
  settings.common.query = benchmarkCase.query;
  settings.common.groups = [...benchmarkCase.groups];
  const startedAt = performance.now();
  await worker.globalGraphSnapshot(settings);
  filterGroupDurationsMs.push(performance.now() - startedAt);
}
const nodes: GraphNode[] = snapshot.nodes.map((node) => ({
  createdAt: node.createdAt,
  id: node.id,
  inboundReferenceCount: node.incomingReferenceCount,
  kind: node.kind === "attachment"
    ? "attachment"
    : node.kind === "tag"
      ? "tag"
      : node.kind === "unresolved"
        ? "unresolved"
        : "note",
  label: node.label,
  path: node.path
}));
const edges: GraphEdge[] = snapshot.edges.map((edge) => ({
  id: edge.id,
  occurrenceCount: edge.occurrenceCount,
  sourceId: edge.source,
  targetId: edge.target
}));
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Graph performance root is unavailable.");
}

const state: GraphPerformanceHarnessState = {
  edgeCount: edges.length,
  endToEndStartedAt,
  filterGroupDurationsMs,
  fixtureBuildMs,
  nodeCount: nodes.length,
  renderStartedAt: performance.now(),
  workerBuildMs
};
window.__QUICKMEMO_GRAPH_PERFORMANCE__ = state;
rootElement.dataset.edgeCount = String(edges.length);
rootElement.dataset.nodeCount = String(nodes.length);
window.addEventListener("pagehide", () => void worker.dispose(), { once: true });

createRoot(rootElement).render(
  <GraphCanvas
    edges={edges}
    initialViewport={{ centerX: 0, centerY: 0, zoom: 1 }}
    nodes={nodes}
    onNodeOpen={() => undefined}
    onViewportChange={(viewport) => {
      state.lastViewport = viewport;
    }}
    renderMode="canvas"
    settings={createDefaultGlobalGraphSettings()}
  />
);
