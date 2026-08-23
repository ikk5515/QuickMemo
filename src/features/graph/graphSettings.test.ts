import { describe, expect, it } from "vitest";
import {
  createDefaultGlobalGraphSettings,
  createDefaultLocalGraphSettings,
  firstMatchingGraphGroup,
  graphEngineForceSettings,
  graphOpenIntentFromModifiers,
  GRAPH_SETTING_RANGES,
  moveGraphGroup,
  resolveGraphNodeColor
} from "./graphSettings";

describe("graph settings", () => {
  it("matches the Global Graph defaults and published control ranges", () => {
    expect(createDefaultGlobalGraphSettings()).toEqual({
      scope: "global",
      common: {
        query: "",
        showTags: false,
        showAttachments: false,
        existingFilesOnly: false,
        groups: [],
        arrows: false,
        textFadeThreshold: 0,
        nodeSize: 1,
        linkThickness: 1,
        centerForce: 0.519,
        repelForce: 10,
        linkForce: 1,
        linkDistance: 250
      },
      showOrphans: true,
      animate: false
    });
    expect(GRAPH_SETTING_RANGES).toMatchObject({
      textFadeThreshold: { min: -3, max: 3, step: 0.1 },
      nodeSize: { min: 0.1, max: 5 },
      linkDistance: { min: 30, max: 500 },
      zoom: { min: 1 / 128, max: 8 }
    });
  });

  it("keeps Local Graph-only options separate from Global Graph options", () => {
    const local = createDefaultLocalGraphSettings();
    expect(local).toMatchObject({
      scope: "local",
      root: "follow-active",
      depth: 1,
      incoming: true,
      outgoing: true,
      neighborLinks: false
    });
    expect(local).not.toHaveProperty("showOrphans");
    expect(local).not.toHaveProperty("animate");
  });

  it("uses the top-most matching group and normalizes keyboard or drag reordering", () => {
    const groups = [
      { id: "research", query: "tag:#research", color: "#ff0000", order: 0 },
      { id: "work", query: "tag:#work", color: "#00ff00", order: 1 }
    ];
    const node = { groupIds: ["research", "work"] };

    expect(firstMatchingGraphGroup(node, groups)?.id).toBe("research");
    expect(resolveGraphNodeColor(node, groups)).toBe("#ff0000");

    const reordered = moveGraphGroup(groups, 1, 0);
    expect(reordered.map((group) => [group.id, group.order])).toEqual([
      ["work", 0],
      ["research", 1]
    ]);
    expect(firstMatchingGraphGroup(node, reordered)?.id).toBe("work");
  });

  it("maps platform click modifiers to Obsidian-style open targets", () => {
    expect(graphOpenIntentFromModifiers({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ target: "current" });
    expect(graphOpenIntentFromModifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true }))
      .toEqual({ target: "new-tab" });
    expect(graphOpenIntentFromModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: false }))
      .toEqual({ target: "new-group" });
    expect(graphOpenIntentFromModifiers({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true }))
      .toEqual({ target: "new-window" });
  });

  it("maps force sliders nonlinearly with exact endpoints and monotonic defaults", () => {
    const atMinimum = graphEngineForceSettings({
      centerForce: 0,
      linkDistance: 30,
      linkForce: 0,
      repelForce: 0
    });
    const atDefault = graphEngineForceSettings(createDefaultGlobalGraphSettings().common);
    const atMaximum = graphEngineForceSettings({
      centerForce: 1,
      linkDistance: 500,
      linkForce: 1,
      repelForce: 20
    });

    expect(atMinimum).toEqual({
      centerStrength: 0,
      linkDistance: 30,
      linkStrength: 0,
      repelStrength: 0
    });
    expect(atMaximum.centerStrength).toBeCloseTo(0.1, 10);
    expect(atMaximum.linkDistance).toBeCloseTo(500, 10);
    expect(atMaximum.linkStrength).toBe(1);
    expect(atMaximum.repelStrength).toBeLessThan(atDefault.repelStrength);
    expect(atDefault.centerStrength).toBeGreaterThan(0);
    expect(atDefault.centerStrength).toBeLessThan(atMaximum.centerStrength);
    expect(atDefault.linkDistance).toBeGreaterThan(30);
    expect(atDefault.linkDistance).toBeLessThan(250);
  });
});
