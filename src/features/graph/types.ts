export type GraphNodeKind = "note" | "canvas" | "attachment" | "tag" | "unresolved";

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  path?: string;
  preview?: string;
  inboundReferenceCount?: number;
  createdAt?: number;
  groupIds?: readonly string[];
  color?: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  occurrenceCount?: number;
}

export interface GraphUiData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootNodeId?: string;
}

export interface GraphGroup {
  id: string;
  query: string;
  color: string;
  order: number;
}

export interface GraphCommonSettings {
  query: string;
  showTags: boolean;
  showAttachments: boolean;
  existingFilesOnly: boolean;
  groups: GraphGroup[];
  arrows: boolean;
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export interface GlobalGraphViewSettings {
  scope: "global";
  common: GraphCommonSettings;
  showOrphans: boolean;
  animate: boolean;
}

export interface LocalGraphViewSettings {
  scope: "local";
  common: GraphCommonSettings;
  root: "follow-active" | { entryId: string };
  depth: 1 | 2 | 3 | 4 | 5;
  incoming: boolean;
  outgoing: boolean;
  neighborLinks: boolean;
}

export type GraphViewSettings = GlobalGraphViewSettings | LocalGraphViewSettings;

export interface GraphViewport {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface EncryptedGraphWorkspaceState {
  viewId: string;
  settings: GraphViewSettings;
  viewport: GraphViewport;
  collapsedSections: GraphSettingsSectionId[];
}

export type GraphSettingsSectionId = "filters" | "groups" | "display" | "forces" | "local";

export interface GraphOpenIntent {
  target: "current" | "new-tab" | "new-group" | "new-window";
}

export interface GraphContextPoint {
  clientX: number;
  clientY: number;
}

export interface GraphRendererHandle {
  copyImage(): Promise<Blob | null>;
  fitView(): void;
  panBy(deltaX: number, deltaY: number): void;
  zoomBy(factor: number): void;
}
