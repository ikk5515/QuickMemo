import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREE_TIER_POLICY,
  calculateProjectedStorageUsage,
  evaluateFreeTierUpload,
  resolveFreeTierPolicy
} from "../../api/_free-tier-policy.js";

describe("free-tier storage policy", () => {
  it("uses the documented free capacity, conservative operational cap, and exact enable flag", () => {
    expect(DEFAULT_FREE_TIER_POLICY).toEqual({
      officialCapacityBytes: 1_000_000_000,
      operationalCapBytes: 800_000_000,
      warningPercent: 65,
      adminWarningPercent: 75,
      restrictLargePercent: 80,
      hardStopPercent: 85,
      restrictedUploadMaxBytes: 25_000_000
    });

    const enabled = resolveFreeTierPolicy({ FREE_TIER_MODE: "true" });
    expect(enabled).toMatchObject({
      enabled: true,
      warningBytes: 650_000_000,
      adminWarningBytes: 750_000_000,
      restrictLargeBytes: 800_000_000,
      hardStopBytes: 800_000_000,
      invalidConfiguration: false,
      invalidFields: []
    });
    expect(resolveFreeTierPolicy({ FREE_TIER_MODE: "TRUE" }).enabled).toBe(false);
    expect(resolveFreeTierPolicy({ FREE_TIER_MODE: true }).enabled).toBe(false);
    expect(resolveFreeTierPolicy({ FREE_TIER_MODE: "1" }).enabled).toBe(false);
  });

  it("classifies warning and admin-warning boundaries without exceeding the operational cap", () => {
    const policy = resolveFreeTierPolicy({ FREE_TIER_MODE: "true" });
    const decide = (projectedBytes) => evaluateFreeTierUpload({
      usedBytes: projectedBytes,
      reservedBytes: 0,
      requestedBytes: 0
    }, policy);

    expect(decide(649_999_999)).toMatchObject({
      state: "allow",
      allowUpload: true,
      warnUser: false,
      warnAdmin: false
    });
    expect(decide(650_000_000)).toMatchObject({
      state: "warn",
      allowUpload: true,
      warnUser: true,
      warnAdmin: false
    });
    expect(decide(750_000_000)).toMatchObject({
      state: "warn",
      allowUpload: true,
      warnUser: true,
      warnAdmin: true
    });
    expect(decide(799_999_999)).toMatchObject({
      state: "warn",
      allowUpload: true,
      warnAdmin: true
    });
    expect(decide(800_000_000)).toMatchObject({
      state: "hard-stop",
      allowUpload: false,
      code: "upload_temporarily_unavailable",
      suggestedHttpStatus: 503,
      hardStopBytes: 800_000_000
    });
  });

  it("keeps restrict and percent hard-stop states distinct when the safe capacity is lower", () => {
    const policy = resolveFreeTierPolicy({
      FREE_TIER_MODE: "true",
      BLOB_STORAGE_INCLUDED_BYTES: "900000000"
    });

    expect(policy).toMatchObject({
      warningBytes: 585_000_000,
      adminWarningBytes: 675_000_000,
      restrictLargeBytes: 720_000_000,
      hardStopBytes: 765_000_000
    });
    expect(evaluateFreeTierUpload({
      usedBytes: 720_000_000,
      reservedBytes: 0,
      requestedBytes: 0
    }, policy)).toMatchObject({
      state: "restrict",
      allowUpload: true,
      restrictLargeUploads: true
    });
    expect(evaluateFreeTierUpload({
      usedBytes: 720_000_000,
      reservedBytes: 0,
      requestedBytes: 25_000_001
    }, policy)).toMatchObject({
      state: "restrict",
      allowUpload: false,
      code: "storage_large_upload_restricted",
      suggestedHttpStatus: 507
    });
    expect(evaluateFreeTierUpload({
      usedBytes: 764_999_999,
      reservedBytes: 0,
      requestedBytes: 1
    }, policy).state).toBe("hard-stop");
  });

  it("includes pending reservations in race-safe preflight math", () => {
    expect(calculateProjectedStorageUsage({
      usedBytes: 700,
      reservedBytes: 50,
      requestedBytes: 60
    })).toEqual({
      valid: true,
      usedAndReservedBytes: 750,
      projectedBytes: 810
    });

    const policy = resolveFreeTierPolicy({
      FREE_TIER_MODE: "true",
      BLOB_STORAGE_INCLUDED_BYTES: "1000",
      BLOB_STORAGE_OPERATIONAL_CAP_BYTES: "800"
    });
    expect(evaluateFreeTierUpload({
      usedBytes: 700,
      reservedBytes: 50,
      requestedBytes: 60
    }, policy)).toMatchObject({
      state: "hard-stop",
      allowUpload: false,
      usedAndReservedBytes: 750,
      projectedBytes: 810
    });
  });

  it("fails closed for negative, fractional, non-numeric, and overflowing usage", () => {
    const policy = resolveFreeTierPolicy({ FREE_TIER_MODE: "true" });
    const invalidInputs = [
      { usedBytes: -1, reservedBytes: 0, requestedBytes: 1 },
      { usedBytes: 0.5, reservedBytes: 0, requestedBytes: 1 },
      { usedBytes: 0, reservedBytes: "0", requestedBytes: 1 },
      { usedBytes: Number.MAX_SAFE_INTEGER, reservedBytes: 1, requestedBytes: 0 },
      { usedBytes: Number.MAX_SAFE_INTEGER, reservedBytes: 0, requestedBytes: 1 }
    ];

    for (const input of invalidInputs) {
      expect(calculateProjectedStorageUsage(input)).toEqual({ valid: false });
      expect(evaluateFreeTierUpload(input, policy)).toMatchObject({
        state: "hard-stop",
        allowUpload: false,
        code: "upload_temporarily_unavailable",
        suggestedHttpStatus: 503,
        projectedBytes: null
      });
    }
  });

  it("uses safe defaults or clamps when environment values could weaken the guard", () => {
    const policy = resolveFreeTierPolicy({
      FREE_TIER_MODE: "true",
      BLOB_STORAGE_INCLUDED_BYTES: "2000000000",
      BLOB_STORAGE_OPERATIONAL_CAP_BYTES: "999999999",
      BLOB_STORAGE_WARNING_PERCENT: "90",
      BLOB_STORAGE_ADMIN_WARNING_PERCENT: "not-a-number",
      BLOB_STORAGE_RESTRICT_PERCENT: "79",
      BLOB_STORAGE_HARD_STOP_PERCENT: "70"
    });

    expect(policy).toMatchObject({
      officialCapacityBytes: 1_000_000_000,
      operationalCapBytes: 800_000_000,
      warningPercent: 65,
      adminWarningPercent: 75,
      restrictLargePercent: 80,
      hardStopPercent: 85,
      warningBytes: 650_000_000,
      hardStopBytes: 800_000_000,
      invalidConfiguration: true
    });
    expect(policy.invalidFields).toEqual([
      "BLOB_STORAGE_ADMIN_WARNING_PERCENT",
      "BLOB_STORAGE_HARD_STOP_PERCENT",
      "BLOB_STORAGE_INCLUDED_BYTES",
      "BLOB_STORAGE_OPERATIONAL_CAP_BYTES",
      "BLOB_STORAGE_RESTRICT_PERCENT",
      "BLOB_STORAGE_WARNING_PERCENT"
    ]);
  });

  it("validates usage before honoring an intentionally disabled policy", () => {
    const disabled = resolveFreeTierPolicy({ FREE_TIER_MODE: "false" });
    expect(evaluateFreeTierUpload({
      usedBytes: 900_000_000,
      reservedBytes: 0,
      requestedBytes: 1
    }, disabled)).toMatchObject({
      state: "allow",
      allowUpload: true
    });
    expect(evaluateFreeTierUpload({
      usedBytes: -1,
      reservedBytes: 0,
      requestedBytes: 1
    }, disabled)).toMatchObject({
      state: "hard-stop",
      allowUpload: false
    });
  });
});
