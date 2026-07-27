import { describe, expect, it } from "vitest";
import {
  defaultSecureSharePolicy,
  normalizeSecureShareEmail,
  parseAllowedEmailChips,
  resolveSecureShareExpiresAt,
  resolveSecureShareFeatureFlags,
  secureShareAllowedEmailLimit,
  secureShareCustomExpiryMaxMs,
  secureShareCustomExpiryMinMs,
  summarizeSecureSharePolicy,
  validateSecureSharePassword,
  validateSecureSharePolicyInput,
  type SecureSharePolicyInput
} from "./secureSharePolicy";

function validPolicy(overrides: Partial<SecureSharePolicyInput> = {}): SecureSharePolicyInput {
  return {
    ...defaultSecureSharePolicy(),
    ...overrides
  };
}

describe("secure share policy validation", () => {
  it.each([
    ["anyone_with_link", []],
    ["allowed_emails", ["allowed@example.com"]],
    ["authenticated_users", []]
  ] as const)("accepts the supported %s access mode", (accessMode, allowedEmails) => {
    const result = validateSecureSharePolicyInput(validPolicy({
      accessMode,
      allowedEmails: [...allowedEmails],
      emailVerificationRequired: accessMode === "allowed_emails"
    }));

    expect(result.ok).toBe(true);
  });

  it.each(["view", "comment", "save_copy"] as const)(
    "accepts the supported %s permission independently from download and quick copy",
    (permissionLevel) => {
      const result = validateSecureSharePolicyInput(validPolicy({
        permissionLevel,
        downloadAllowed: false,
        quickCopyButtonVisible: false
      }));

      expect(result).toMatchObject({
        ok: true,
        value: {
          permissionLevel,
          downloadAllowed: false,
          quickCopyButtonVisible: false
        }
      });
    }
  );

  it("rejects invalid enums, unknown fields, and injected server-owned fields", () => {
    const result = validateSecureSharePolicyInput({
      ...validPolicy(),
      accessMode: "owner_only",
      ownerUid: "attacker",
      schemaVersion: 1
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_enum", field: "accessMode" }),
      expect.objectContaining({ code: "unknown_field", field: "ownerUid" }),
      expect.objectContaining({ code: "unknown_field", field: "schemaVersion" })
    ]));
  });

  it("forces email verification for allowlists, removes duplicate emails, and clears irrelevant emails", () => {
    const allowlist = validateSecureSharePolicyInput(validPolicy({
      accessMode: "allowed_emails",
      allowedEmails: [" User+tag@Example.com ", "user+tag@example.com"],
      emailVerificationRequired: false
    }));

    expect(allowlist).toEqual({
      ok: true,
      value: expect.objectContaining({
        allowedEmails: ["user+tag@example.com"],
        emailVerificationRequired: true
      })
    });

    const switched = validateSecureSharePolicyInput(validPolicy({
      accessMode: "authenticated_users",
      allowedEmails: ["private@example.com"]
    }));

    expect(switched).toEqual({
      ok: true,
      value: expect.objectContaining({ allowedEmails: [] })
    });
  });

  it("requires one through one hundred valid allowlist entries", () => {
    const empty = validateSecureSharePolicyInput(validPolicy({
      accessMode: "allowed_emails",
      allowedEmails: []
    }));
    const tooMany = validateSecureSharePolicyInput(validPolicy({
      accessMode: "allowed_emails",
      allowedEmails: Array.from(
        { length: secureShareAllowedEmailLimit + 1 },
        (_, index) => `user${index}@example.com`
      )
    }));
    const invalid = validateSecureSharePolicyInput(validPolicy({
      accessMode: "allowed_emails",
      allowedEmails: ["not an email"]
    }));

    expect(empty).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ field: "allowedEmails" })])
    });
    expect(tooMany).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "too_many_emails" })])
    });
    expect(invalid).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_email" })])
    });
  });

  it("fails closed when the selected policy needs an unavailable email feature", () => {
    const result = validateSecureSharePolicyInput(validPolicy({
      emailVerificationRequired: true
    }), { emailFeatureEnabled: false });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "feature_unavailable" })])
    });
  });
});

describe("secure share email chips", () => {
  it("normalizes whitespace and case while preserving plus tags and dots", () => {
    expect(normalizeSecureShareEmail("  User.Name+Case@Example.COM  "))
      .toBe("user.name+case@example.com");
    expect(normalizeSecureShareEmail("User.Name+tag@BÜCHER.DE"))
      .toBe("user.name+tag@xn--bcher-kva.de");
    expect(normalizeSecureShareEmail(".user@example.com")).toBeNull();
    expect(normalizeSecureShareEmail("user..name@example.com")).toBeNull();
    expect(normalizeSecureShareEmail("user\u00a0@example.com")).toBeNull();
  });

  it("parses commas, semicolons, and newlines with duplicate reporting", () => {
    const result = parseAllowedEmailChips(
      "First@Example.com, second@example.com;\nFIRST@example.com",
      ["existing@example.com"]
    );

    expect(result.emails).toEqual([
      "existing@example.com",
      "first@example.com",
      "second@example.com"
    ]);
    expect(result.added).toEqual(["first@example.com", "second@example.com"]);
    expect(result.duplicates).toEqual(["first@example.com"]);
    expect(result.invalid).toEqual([]);
  });

  it("separates invalid and over-limit entries without exceeding one hundred chips", () => {
    const values = Array.from(
      { length: secureShareAllowedEmailLimit + 1 },
      (_, index) => `person${index}@example.com`
    ).join(",");
    const result = parseAllowedEmailChips(`${values};invalid address`);

    expect(result.emails).toHaveLength(secureShareAllowedEmailLimit);
    expect(result.overflow).toEqual(["person100@example.com"]);
    expect(result.invalid).toEqual(["invalid address"]);
  });
});

describe("secure share password and expiration", () => {
  it("counts Unicode code points and does not trim or normalize the password", () => {
    const spacedPassword = " 123456 ";
    const unicodePassword = "🔐🔑🧩🛡️보안암호";

    expect(validateSecureSharePassword(spacedPassword)).toBeNull();
    expect(validateSecureSharePassword(unicodePassword)).toBeNull();

    const validated = validateSecureSharePolicyInput(validPolicy({
      passwordEnabled: true,
      password: spacedPassword
    }), { requirePasswordWhenEnabled: true });

    expect(validated).toMatchObject({
      ok: true,
      value: { password: spacedPassword }
    });
  });

  it("enforces password length from 8 through 128 characters", () => {
    expect(validateSecureSharePassword("1234567")).toMatch(/8자 이상/u);
    expect(validateSecureSharePassword("a".repeat(128))).toBeNull();
    expect(validateSecureSharePassword("a".repeat(129))).toMatch(/128자 이하/u);
  });

  it("accepts exact custom-expiry boundaries and rejects values outside them", () => {
    const now = new Date("2026-07-28T00:00:00.000Z");
    const exactMinimum = new Date(now.getTime() + secureShareCustomExpiryMinMs).toISOString();
    const exactMaximum = new Date(now.getTime() + secureShareCustomExpiryMaxMs).toISOString();
    const tooSoon = new Date(now.getTime() + secureShareCustomExpiryMinMs - 1).toISOString();
    const tooLate = new Date(now.getTime() + secureShareCustomExpiryMaxMs + 1).toISOString();

    for (const customExpiresAt of [exactMinimum, exactMaximum]) {
      expect(validateSecureSharePolicyInput(validPolicy({
        expirationPreset: "custom",
        customExpiresAt
      }), { now })).toMatchObject({ ok: true });
    }

    for (const customExpiresAt of [tooSoon, tooLate]) {
      expect(validateSecureSharePolicyInput(validPolicy({
        expirationPreset: "custom",
        customExpiresAt
      }), { now })).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_expiry" })])
      });
    }
  });

  it("resolves preset expiration from the supplied clock", () => {
    const now = new Date("2026-07-28T00:00:00.000Z");

    expect(resolveSecureShareExpiresAt("one_hour", null, now)?.toISOString())
      .toBe("2026-07-28T01:00:00.000Z");
    expect(resolveSecureShareExpiresAt("one_day", null, now)?.toISOString())
      .toBe("2026-07-29T00:00:00.000Z");
    expect(resolveSecureShareExpiresAt("seven_days", null, now)?.toISOString())
      .toBe("2026-08-04T00:00:00.000Z");
  });
});

describe("secure share summary and feature flags", () => {
  it("summarizes AND security conditions and independent restrictions naturally", () => {
    const summary = summarizeSecureSharePolicy(validPolicy({
      passwordEnabled: true,
      emailVerificationRequired: true,
      oneTimeEnabled: true,
      permissionLevel: "save_copy",
      downloadAllowed: false,
      quickCopyButtonVisible: false
    }));

    expect(summary).toContain("비밀번호와 이메일 인증을 모두 완료한");
    expect(summary).toContain("최초 인증에 성공한 한 명");
    expect(summary).toContain("독립된 복사본");
    expect(summary).toContain("직접 다운로드는 제한");
    expect(summary).toContain("빠른 복사 버튼은 표시되지");
    expect(summary).toContain("7일 후 종료");
  });

  it("requires both client and server v2 flags and gates email separately", () => {
    expect(resolveSecureShareFeatureFlags(
      { v2Enabled: true, emailEnabled: true },
      "false"
    )).toEqual({
      clientV2Enabled: false,
      v2Enabled: false,
      emailEnabled: false
    });

    expect(resolveSecureShareFeatureFlags(
      { v2Enabled: "true", emailEnabled: "true" },
      "true"
    )).toEqual({
      clientV2Enabled: true,
      v2Enabled: true,
      emailEnabled: true
    });

    expect(resolveSecureShareFeatureFlags(
      { v2Enabled: true, emailEnabled: "1" },
      true
    ).emailEnabled).toBe(false);
  });
});
