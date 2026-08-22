import { describe, expect, it } from "vitest";
import { shouldRenderGraphLabel } from "./labelLod";

function labelDecision(overrides: Partial<Parameters<typeof shouldRenderGraphLabel>[0]> = {}) {
  return shouldRenderGraphLabel({
    focused: false,
    globalScale: 1,
    inboundReferenceCount: 0,
    interactionActive: false,
    nodeCount: 5_000,
    ...overrides
  });
}

describe("graph label level of detail", () => {
  it("suppresses unfocused labels during large-graph interaction", () => {
    expect(labelDecision({ globalScale: 8, interactionActive: true })).toBe(false);
    expect(labelDecision({ focused: true, interactionActive: true })).toBe(true);
  });

  it("uses zoom and incoming-source count thresholds at 5k nodes", () => {
    expect(labelDecision({ globalScale: 2.49, inboundReferenceCount: 100 })).toBe(false);
    expect(labelDecision({ globalScale: 2.5, inboundReferenceCount: 4 })).toBe(false);
    expect(labelDecision({ globalScale: 2.5, inboundReferenceCount: 5 })).toBe(true);
    expect(labelDecision({ globalScale: 4.5, inboundReferenceCount: 1 })).toBe(false);
    expect(labelDecision({ globalScale: 4.5, inboundReferenceCount: 2 })).toBe(true);
    expect(labelDecision({ globalScale: 7, inboundReferenceCount: 0 })).toBe(true);
  });

  it("keeps small graphs fully labelled when idle", () => {
    expect(labelDecision({ nodeCount: 999 })).toBe(true);
  });
});
