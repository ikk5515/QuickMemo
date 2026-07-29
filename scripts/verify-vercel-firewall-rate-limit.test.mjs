import { describe, expect, it } from "vitest";
import {
  inspectRevisionRateLimit,
  liveSyncProductionDefaultsEnabled
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
    ["unvalidated rule", {
      firewallEnabled: true,
      rules: [validRule({ valid: undefined })]
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
