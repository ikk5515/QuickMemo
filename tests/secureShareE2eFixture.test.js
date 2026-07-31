import { describe, expect, it } from "vitest";
import { e2eSeoulEmailQuotaMonthWindow } from "./e2e/emulator-fixtures.mjs";

describe("Secure Share E2E quota fixture clock", () => {
  it("uses the Seoul month across the UTC month-boundary window", () => {
    const window = e2eSeoulEmailQuotaMonthWindow(
      new Date("2026-07-31T17:00:00.000Z")
    );

    expect(window).toEqual({
      monthKey: "2026-08",
      nextMonth: new Date("2026-08-31T15:00:00.000Z")
    });
  });
});
