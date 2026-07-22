import { describe, expect, it } from "vitest";
import { enabledFeatures, hasFeatureAccess, normalizeFeatureAccess, resolveAccessibleHome } from "./featureAccess";

describe("feature access", () => {
  it("keeps legacy profiles fully enabled", () => {
    expect(normalizeFeatureAccess({ isAdmin: false })).toEqual({
      notes: true,
      library: true,
      schedule: true
    });
  });

  it("does not grant access without an authenticated profile", () => {
    expect(hasFeatureAccess(null, "notes")).toBe(false);
    expect(resolveAccessibleHome(undefined, "notes")).toBeNull();
  });

  it("fails the whole map closed when a required key is missing", () => {
    expect(normalizeFeatureAccess({ featureAccess: { library: true } })).toEqual({
      notes: false,
      library: false,
      schedule: false
    });
  });

  it("fails closed for malformed permission values", () => {
    expect(normalizeFeatureAccess({ featureAccess: null })).toEqual({
      notes: false,
      library: false,
      schedule: false
    });
    expect(normalizeFeatureAccess({
      featureAccess: { notes: true, library: true, schedule: "yes" } as never
    })).toEqual({ notes: false, library: false, schedule: false });
  });

  it("always grants administrators all features", () => {
    const profile = {
      isAdmin: true,
      featureAccess: { notes: false, library: false, schedule: false }
    };

    expect(enabledFeatures(profile)).toEqual(["notes", "library", "schedule"]);
    expect(hasFeatureAccess(profile, "schedule")).toBe(true);
  });

  it("falls back to the first granted workspace without granting anything new", () => {
    const profile = {
      featureAccess: { notes: false, library: true, schedule: false }
    };

    expect(resolveAccessibleHome(profile, "notes")).toBe("library");
    expect(resolveAccessibleHome({ featureAccess: { notes: false, library: false, schedule: false } }, "notes")).toBeNull();
  });
});
