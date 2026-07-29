export const secureSharePollingIntervals = {
  rapid: 2_500,
  warm: 15_000,
  cool: 30_000,
  idle: 60_000
} as const;

const rapidUnchangedLimit = 4;
const warmUnchangedLimit = 8;
const coolUnchangedLimit = 12;
const jitterRatio = 0.1;

export function secureSharePollingBaseDelayMs(unchangedCount: number): number {
  const count = Number.isSafeInteger(unchangedCount)
    ? Math.max(0, unchangedCount)
    : 0;

  if (count < rapidUnchangedLimit) {
    return secureSharePollingIntervals.rapid;
  }
  if (count < warmUnchangedLimit) {
    return secureSharePollingIntervals.warm;
  }
  if (count < coolUnchangedLimit) {
    return secureSharePollingIntervals.cool;
  }
  return secureSharePollingIntervals.idle;
}

export function secureSharePollingDelayMs(
  unchangedCount: number,
  randomValue: number = Math.random()
): number {
  const boundedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5;
  const baseDelay = secureSharePollingBaseDelayMs(unchangedCount);
  const jitterMultiplier = 1 - jitterRatio + boundedRandom * jitterRatio * 2;
  return Math.round(baseDelay * jitterMultiplier);
}

export function incrementSecureSharePollingUnchangedCount(
  unchangedCount: number
): number {
  if (!Number.isSafeInteger(unchangedCount) || unchangedCount < 0) {
    return 1;
  }
  return Math.min(coolUnchangedLimit, unchangedCount + 1);
}
