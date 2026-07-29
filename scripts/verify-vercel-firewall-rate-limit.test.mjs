import { describe, expect, it } from "vitest";
import {
  inspectRevisionRateLimit,
  liveSyncProductionDefaultsEnabled,
  summarizeRevisionRateLimitConfig
} from "./verify-vercel-firewall-rate-limit.mjs";

function validRule(overrides = {}) {
  return {
    active: true,
    valid: true,
    conditionGroup: [{
      conditions: [
        { type: "path", op: "eq", value: "/api/public-shares-v2" }
      ]
    }],
    action: {
      mitigate: {
        action: "rate_limit",
        rateLimit: {
          action: "deny",
          algo: "fixed_window",
          window: 60,
          limit: 120,
          keys: ["ip"]
        }
      }
    },
    ...overrides
  };
}

describe("Vercel revision WAF preflight", () => {
  it("accepts an active bounded whole-path rate limit", () => {
    expect(inspectRevisionRateLimit({
      firewallEnabled: true,
      rules: [validRule()]
    })).toMatchObject({
      ok: true,
      limit: 120,
      requestsPerMinute: 120,
      windowSeconds: 60
    });
  });

  it.each([
    ["disabled firewall", { firewallEnabled: false, rules: [validRule()] }],
    ["missing validation marker", {
      firewallEnabled: true,
      rules: [validRule({ valid: undefined })]
    }],
    ["explicitly invalid rule", {
      firewallEnabled: true,
      rules: [validRule({ valid: false })]
    }],
    ["null validation marker", {
      firewallEnabled: true,
      rules: [validRule({ valid: null })]
    }],
    ["string validation marker", {
      firewallEnabled: true,
      rules: [validRule({ valid: "true" })]
    }],
    ["client-controlled narrowing condition", {
      firewallEnabled: true,
      rules: [validRule({
        conditionGroup: [{
          conditions: [
            { type: "path", op: "eq", value: "/api/public-shares-v2" },
            {
              type: "header",
              key: "x-quickmemo-secure-share-revision",
              op: "eq",
              value: "1"
            }
          ]
        }]
      })]
    }],
    ["overbroad path", {
      firewallEnabled: true,
      rules: [validRule({
        conditionGroup: [{
          conditions: [
            { type: "path", op: "eq", value: "/api/other" }
          ]
        }]
      })]
    }],
    ["unbounded rate", {
      firewallEnabled: true,
      rules: [validRule({
        action: {
          mitigate: {
            action: "rate_limit",
            rateLimit: {
              action: "deny",
              algo: "fixed_window",
              window: 60,
              limit: 121,
              keys: ["ip"]
            }
          }
        }
      })]
    }],
    ["global key", {
      firewallEnabled: true,
      rules: [validRule({
        action: {
          mitigate: {
            action: "rate_limit",
            rateLimit: {
              action: "deny",
              algo: "fixed_window",
              window: 60,
              limit: 60,
              keys: ["host"]
            }
          }
        }
      })]
    }],
    ["composite client key", {
      firewallEnabled: true,
      rules: [validRule({
        action: {
          mitigate: {
            action: "rate_limit",
            rateLimit: {
              action: "deny",
              algo: "fixed_window",
              window: 60,
              limit: 60,
              keys: ["ip", "ja4"]
            }
          }
        }
      })]
    }],
    ["log-only threshold action", {
      firewallEnabled: true,
      rules: [validRule({
        action: {
          mitigate: {
            action: "rate_limit",
            rateLimit: {
              action: "log",
              algo: "fixed_window",
              window: 60,
              limit: 60,
              keys: ["ip"]
            }
          }
        }
      })]
    }],
    ["preceding active bypass rule", {
      firewallEnabled: true,
      rules: [
        {
          active: true,
          valid: true,
          conditionGroup: [{
            conditions: [{ type: "path", op: "pre", value: "/" }]
          }],
          action: { mitigate: { action: "bypass" } }
        },
        validRule()
      ]
    }]
  ])("rejects %s", (_name, config) => {
    expect(inspectRevisionRateLimit(config).ok).toBe(false);
  });

  it("summarizes rule structure without logging identifiers or condition values", () => {
    const diagnostic = summarizeRevisionRateLimitConfig({
      firewallEnabled: true,
      rules: [validRule({
        id: "secret-rule-id",
        name: "secret-rule-name",
        conditionGroup: [{
          conditions: [{
            type: "header",
            key: "x-secret-header",
            op: "eq",
            value: "secret-condition-value"
          }]
        }]
      })]
    });
    expect(diagnostic).toMatchObject({
      firewallEnabled: true,
      rulesShape: "array",
      ruleCount: 1,
      rules: [{
        active: true,
        valid: "true",
        conditionGroupShape: "array",
        conditionGroupCount: 1,
        conditionGroups: [{
          conditionCount: 1,
          conditions: [{
            type: "header",
            operation: "eq",
            coversRevision: false
          }]
        }],
        mitigationAction: "rate_limit",
        rateLimitAction: "deny",
        algorithm: "fixed_window",
        window: 60,
        limit: 120,
        keyKinds: ["ip"]
      }]
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("secret-rule");
    expect(serialized).not.toContain("x-secret-header");
    expect(serialized).not.toContain("secret-condition-value");
  });

  it("requires both trusted Production defaults before enforcement", () => {
    const client = "const secureShareLiveContentSyncProductionDefault = true;";
    const server = "const secureShareLiveContentSyncServerProductionDefault = true;";
    expect(liveSyncProductionDefaultsEnabled(client, server, server)).toBe(true);
    expect(liveSyncProductionDefaultsEnabled(
      client.replace("true", "false"),
      server,
      server
    )).toBe(false);
    expect(liveSyncProductionDefaultsEnabled(
      client,
      server.replace("true", "false"),
      server
    )).toBe(false);
    expect(liveSyncProductionDefaultsEnabled(
      client,
      server,
      server.replace("true", "false")
    )).toBe(false);
  });

  it("fails closed when either trusted source default loses its reviewed literal syntax", () => {
    const client =
      "const secureShareLiveContentSyncProductionDefault: boolean = false;";
    const server =
      "const secureShareLiveContentSyncServerProductionDefault = false;";
    expect(() => liveSyncProductionDefaultsEnabled(client, server, server)).toThrow(
      /Unable to verify the trusted/
    );
    expect(() => liveSyncProductionDefaultsEnabled(
      "const secureShareLiveContentSyncProductionDefault = false;",
      server,
      ""
    )).toThrow(/Unable to verify the trusted/);
  });
});
