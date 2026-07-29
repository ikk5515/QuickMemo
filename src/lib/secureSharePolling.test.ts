import { describe, expect, it } from "vitest";
import {
  incrementSecureSharePollingUnchangedCount,
  secureSharePollingBaseDelayMs,
  secureSharePollingDelayMs,
  secureSharePollingIntervals
} from "./secureSharePolling";

describe("secure share adaptive polling", () => {
  it("uses a short rapid window before backing off to the free-tier idle interval", () => {
    expect([
      secureSharePollingBaseDelayMs(0),
      secureSharePollingBaseDelayMs(1),
      secureSharePollingBaseDelayMs(3)
    ]).toEqual([
      secureSharePollingIntervals.rapid,
      secureSharePollingIntervals.rapid,
      secureSharePollingIntervals.rapid
    ]);
    expect(secureSharePollingBaseDelayMs(4)).toBe(secureSharePollingIntervals.warm);
    expect(secureSharePollingBaseDelayMs(8)).toBe(secureSharePollingIntervals.cool);
    expect(secureSharePollingBaseDelayMs(12)).toBe(secureSharePollingIntervals.idle);
    expect(secureSharePollingBaseDelayMs(Number.NaN)).toBe(
      secureSharePollingIntervals.rapid
    );
  });

  it("applies bounded ten-percent jitter without changing the backoff stage", () => {
    expect(secureSharePollingDelayMs(12, 0)).toBe(54_000);
    expect(secureSharePollingDelayMs(12, 0.5)).toBe(60_000);
    expect(secureSharePollingDelayMs(12, 1)).toBe(66_000);
    expect(secureSharePollingDelayMs(4, -10)).toBe(13_500);
    expect(secureSharePollingDelayMs(4, 10)).toBe(16_500);
    expect(secureSharePollingDelayMs(4, Number.NaN)).toBe(15_000);
  });

  it("caps the unchanged counter once the idle interval is reached", () => {
    expect(incrementSecureSharePollingUnchangedCount(-1)).toBe(1);
    expect(incrementSecureSharePollingUnchangedCount(0)).toBe(1);
    expect(incrementSecureSharePollingUnchangedCount(11)).toBe(12);
    expect(incrementSecureSharePollingUnchangedCount(12)).toBe(12);
    expect(incrementSecureSharePollingUnchangedCount(Number.MAX_SAFE_INTEGER)).toBe(12);
  });

  it("keeps one continuously visible unchanged tab comfortably below the daily read quota", () => {
    const normalRevisionReadsPerPoll = 4;
    const crossOwnerAdminPreviewReadsPerPoll = 5;
    const idlePollsPerDay = Math.ceil(86_400_000 / secureSharePollingIntervals.idle);
    const rapidAndBackoffAllowance = 12;

    expect((idlePollsPerDay + rapidAndBackoffAllowance) * normalRevisionReadsPerPoll)
      .toBeLessThan(6_000);
    const shortestIdleDelay = secureSharePollingDelayMs(12, 0);
    const shortestBoundPolls =
      Math.ceil(86_400_000 / shortestIdleDelay) + rapidAndBackoffAllowance;
    expect(shortestBoundPolls * normalRevisionReadsPerPoll).toBeLessThan(6_500);
    expect(shortestBoundPolls * crossOwnerAdminPreviewReadsPerPoll).toBeLessThan(8_100);
  });
});
