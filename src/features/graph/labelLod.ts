export interface GraphLabelLodInput {
  focused: boolean;
  globalScale: number;
  inboundReferenceCount: number;
  interactionActive: boolean;
  nodeCount: number;
}

/**
 * Keeps label density bounded for large Canvas graphs. This is deliberately a
 * pure decision so the 5k-node rendering policy can be regression-tested
 * without claiming a browser frame-rate result from a unit test.
 */
export function shouldRenderGraphLabel({
  focused,
  globalScale,
  inboundReferenceCount,
  interactionActive,
  nodeCount
}: GraphLabelLodInput): boolean {
  if (focused) {
    return true;
  }
  if (interactionActive && nodeCount >= 1_000) {
    return false;
  }
  if (nodeCount < 1_000) {
    return true;
  }
  if (nodeCount >= 5_000) {
    if (globalScale < 2.5) return false;
    if (globalScale < 4.5) return inboundReferenceCount >= 5;
    if (globalScale < 7) return inboundReferenceCount >= 2;
    return true;
  }
  if (globalScale < 1.5) return inboundReferenceCount >= 3;
  if (globalScale < 3) return inboundReferenceCount >= 1;
  return true;
}
