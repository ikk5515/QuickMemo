import { describe, expect, it } from "vitest";
import { resolveProductionStagedFeatureFlag } from "./productionStagedFeatureFlag";

describe("Production staged feature flags", () => {
  it("hard-locks a staged-off Production feature despite a stale true override", () => {
    expect(resolveProductionStagedFeatureFlag("true", false, true)).toBe(false);
    expect(resolveProductionStagedFeatureFlag(true, false, true)).toBe(false);
  });

  it("allows an enabled source default while preserving exact false rollback", () => {
    expect(resolveProductionStagedFeatureFlag(undefined, true, true)).toBe(true);
    expect(resolveProductionStagedFeatureFlag("true", true, true)).toBe(true);
    expect(resolveProductionStagedFeatureFlag("false", true, true)).toBe(false);
    expect(resolveProductionStagedFeatureFlag(false, true, true)).toBe(false);
  });

  it("keeps local and test behavior on unless explicitly false", () => {
    for (const value of [undefined, null, "", "False", 0, true, "true"]) {
      expect(resolveProductionStagedFeatureFlag(value, false, false)).toBe(true);
    }
    expect(resolveProductionStagedFeatureFlag(false, false, false)).toBe(false);
    expect(resolveProductionStagedFeatureFlag("false", false, false)).toBe(false);
  });
});
