import { describe, expect, it } from "vitest";
import {
  isReadonlyNoteRendererV2Enabled,
  isUnifiedSelectUiEnabled
} from "./readViewFeatureFlags";

describe("read-view default-on feature flags", () => {
  it.each([
    ["renderer", isReadonlyNoteRendererV2Enabled],
    ["select", isUnifiedSelectUiEnabled]
  ] as const)("enables the %s feature when omitted or not exactly false", (_name, resolve) => {
    for (const value of [undefined, null, true, "true", "", "False", 0]) {
      expect(resolve(value)).toBe(true);
    }
  });

  it.each([
    ["renderer", isReadonlyNoteRendererV2Enabled],
    ["select", isUnifiedSelectUiEnabled]
  ] as const)("disables the %s feature only for exact false values", (_name, resolve) => {
    expect(resolve(false)).toBe(false);
    expect(resolve("false")).toBe(false);
  });
});
