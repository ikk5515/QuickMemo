/* global AbortSignal, Buffer, console, fetch, process, URL */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const revisionPath = "/api/public-shares-v2";
const maximumRequestsPerMinutePerKey = 120;
const maximumResponseBytes = 1024 * 1024;
const requestTimeoutMilliseconds = 10_000;

function normalizedString(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function conditionValues(value) {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

function pathConditionCoversRevision(condition) {
  if (normalizedString(condition?.type) !== "path" || condition?.neg === true) {
    return false;
  }
  const operation = normalizedString(condition?.op);
  const values = conditionValues(condition?.value);
  if (operation === "eq" || operation === "inc") {
    return values.includes(revisionPath);
  }
  if (operation === "pre") {
    return values.includes(revisionPath);
  }
  return false;
}

function conditionGroupCoversRevision(group) {
  if (!Array.isArray(group?.conditions)) {
    return false;
  }
  // The WAF condition must cover the entire API path. Requiring a marker,
  // query, or other client-controlled condition would let an attacker omit it
  // and still spend a Vercel invocation before the server rejects the request.
  return group.conditions.length === 1
    && pathConditionCoversRevision(group.conditions[0]);
}

function recognizedIpKey(value) {
  const normalized = normalizedString(value).replaceAll("-", "_");
  return normalized === "ip"
    || normalized === "ip_address";
}

function valueShape(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function summarizeRule(rule) {
  const conditionGroups = Array.isArray(rule?.conditionGroup)
    ? rule.conditionGroup
    : [];
  const mitigation = rule?.action?.mitigate;
  const rateLimit = mitigation?.rateLimit;
  const keys = Array.isArray(rateLimit?.keys) ? rateLimit.keys : [];
  return {
    active: rule?.active === true,
    valid: rule?.valid === true
      ? "true"
      : rule?.valid === false
        ? "false"
        : valueShape(rule?.valid),
    conditionGroupShape: valueShape(rule?.conditionGroup),
    conditionGroupCount: conditionGroups.length,
    conditionGroups: conditionGroups.slice(0, 4).map((group) => {
      const conditions = Array.isArray(group?.conditions)
        ? group.conditions
        : [];
      return {
        conditionShape: valueShape(group?.conditions),
        conditionCount: conditions.length,
        conditions: conditions.slice(0, 4).map((condition) => ({
          type: normalizedString(condition?.type) || valueShape(condition?.type),
          operation: normalizedString(condition?.op) || valueShape(condition?.op),
          negated: condition?.neg === true,
          coversRevision: pathConditionCoversRevision(condition)
        }))
      };
    }),
    mitigationAction: normalizedString(mitigation?.action)
      || valueShape(mitigation?.action),
    rateLimitShape: valueShape(rateLimit),
    rateLimitAction: normalizedString(rateLimit?.action)
      || valueShape(rateLimit?.action),
    algorithm: normalizedString(rateLimit?.algo)
      || valueShape(rateLimit?.algo),
    windowShape: valueShape(rateLimit?.window),
    window: Number.isFinite(Number(rateLimit?.window))
      ? Number(rateLimit.window)
      : null,
    limitShape: valueShape(rateLimit?.limit),
    limit: Number.isFinite(Number(rateLimit?.limit))
      ? Number(rateLimit.limit)
      : null,
    keysShape: valueShape(rateLimit?.keys),
    keyCount: keys.length,
    keyKinds: keys.slice(0, 4).map((key) => (
      recognizedIpKey(key) ? "ip" : valueShape(key)
    ))
  };
}

export function summarizeRevisionRateLimitConfig(config) {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  return {
    firewallEnabled: config?.firewallEnabled === true,
    rulesShape: valueShape(config?.rules),
    ruleCount: rules.length,
    rules: rules.slice(0, 10).map(summarizeRule),
    rulesTruncated: rules.length > 10
  };
}

export function inspectRevisionRateLimit(config) {
  if (!config || config.firewallEnabled !== true || !Array.isArray(config.rules)) {
    return {
      ok: false,
      reason: "firewall_not_enabled",
      diagnostic: summarizeRevisionRateLimitConfig(config)
    };
  }

  const activeRules = config.rules.filter(
    (rule) => rule?.active === true
      && rule?.valid === true
  );
  const rule = activeRules[0];
  if (
    rule
    && Array.isArray(rule.conditionGroup)
    && rule.conditionGroup.some(conditionGroupCoversRevision)
  ) {
    const mitigation = rule.action?.mitigate;
    const rateLimit = mitigation?.rateLimit;
    const windowSeconds = Number(rateLimit?.window);
    const limit = Number(rateLimit?.limit);
    const keys = Array.isArray(rateLimit?.keys) ? rateLimit.keys : [];
    const requestsPerMinute = limit * 60 / windowSeconds;
    if (
      normalizedString(mitigation?.action) !== "rate_limit"
      || normalizedString(rateLimit?.action) !== "deny"
      || normalizedString(rateLimit?.algo) !== "fixed_window"
      || !Number.isFinite(windowSeconds)
      || windowSeconds < 10
      || windowSeconds > 600
      || !Number.isSafeInteger(limit)
      || limit < 1
      || requestsPerMinute > maximumRequestsPerMinutePerKey
      || keys.length !== 1
      || !recognizedIpKey(keys[0])
    ) {
      return {
        ok: false,
        reason: "revision_rate_limit_not_found",
        diagnostic: summarizeRevisionRateLimitConfig(config)
      };
    }

    return {
      ok: true,
      limit,
      requestsPerMinute,
      windowSeconds
    };
  }

  return {
    ok: false,
    reason: "revision_rate_limit_not_found",
    diagnostic: summarizeRevisionRateLimitConfig(config)
  };
}

export function liveSyncProductionDefaultsEnabled(
  clientSource,
  apiServerSource,
  blobServerSource
) {
  const literalConstant = (source, name) => {
    const matches = Array.from(source.matchAll(new RegExp(
      `\\bconst\\s+${name}\\s*=\\s*(true|false)\\s*;`,
      "gu"
    )));
    if (matches.length !== 1) {
      throw new Error(`Unable to verify the trusted ${name} source default.`);
    }
    return matches[0][1] === "true";
  };
  const clientDefault = literalConstant(
    clientSource,
    "secureShareLiveContentSyncProductionDefault"
  );
  const serverDefault = literalConstant(
    apiServerSource,
    "secureShareLiveContentSyncServerProductionDefault"
  );
  const blobServerDefault = literalConstant(
    blobServerSource,
    "secureShareLiveContentSyncServerProductionDefault"
  );
  return clientDefault && serverDefault && blobServerDefault;
}

async function productionDefaultsEnabled(rootDirectory) {
  const [clientSource, apiServerSource, blobServerSource] = await Promise.all([
    readFile(resolve(rootDirectory, "src/lib/secureSharePolicy.ts"), "utf8"),
    readFile(resolve(rootDirectory, "api/public-shares-v2.js"), "utf8"),
    readFile(resolve(rootDirectory, "api/blob-attachments.js"), "utf8")
  ]);
  return liveSyncProductionDefaultsEnabled(
    clientSource,
    apiServerSource,
    blobServerSource
  );
}

async function readActiveFirewallConfig({ projectId, teamId, token }) {
  const endpoint = new URL(
    "https://api.vercel.com/v1/security/firewall/config/active"
  );
  endpoint.searchParams.set("projectId", projectId);
  endpoint.searchParams.set("teamId", teamId);

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(requestTimeoutMilliseconds)
  });
  if (!response.ok) {
    throw new Error(`Vercel Firewall API returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    throw new Error("Vercel Firewall response exceeded the size limit.");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximumResponseBytes) {
    throw new Error("Vercel Firewall response exceeded the size limit.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Vercel Firewall response was not valid JSON.");
  }
}

export async function verifyProductionFirewall({
  environment = process.env,
  probeWhenDisabled = false,
  rootDirectory = process.cwd()
} = {}) {
  const productionEnabled = await productionDefaultsEnabled(rootDirectory);
  if (!productionEnabled && !probeWhenDisabled) {
    return { enforced: false, ok: true };
  }

  const projectId = environment.VERCEL_PROJECT_ID;
  const teamId = environment.VERCEL_ORG_ID;
  const token = environment.VERCEL_TOKEN;
  if (!projectId || !teamId || !token) {
    if (!productionEnabled) {
      return {
        enforced: false,
        ok: true,
        readinessChecked: false,
        readinessReason: "credentials_unavailable"
      };
    }
    throw new Error(
      "Live sync is enabled, but the Vercel Firewall verification credentials are unavailable."
    );
  }

  let result;
  try {
    result = inspectRevisionRateLimit(
      await readActiveFirewallConfig({ projectId, teamId, token })
    );
  } catch (error) {
    if (!productionEnabled) {
      return {
        enforced: false,
        ok: true,
        readinessChecked: false,
        readinessReason: "api_unavailable"
      };
    }
    throw error;
  }
  if (!result.ok) {
    if (!productionEnabled) {
      return {
        enforced: false,
        ok: true,
        readinessChecked: true,
        readinessReason: result.reason,
        readinessDiagnostic: result.diagnostic
      };
    }
    throw new Error(
      "Live sync is enabled, but no active bounded revision rate-limit rule was verified."
    );
  }
  return {
    enforced: productionEnabled,
    readinessChecked: true,
    ...result
  };
}

async function main() {
  const result = await verifyProductionFirewall({
    probeWhenDisabled: process.argv.includes("--probe")
  });
  if (!result.enforced) {
    if (result.readinessChecked && result.limit) {
      console.log(
        `Secure Share live sync remains gated; WAF readiness verified at ${result.limit} requests/${result.windowSeconds}s per source IP.`
      );
    } else if (result.readinessChecked) {
      console.log(
        `Secure Share live sync remains gated; WAF readiness not verified (${result.readinessReason}).`
      );
      if (result.readinessDiagnostic) {
        console.log(
          `Secure Share WAF structural diagnostic: ${JSON.stringify(result.readinessDiagnostic)}`
        );
      }
    } else if (result.readinessReason) {
      console.log(
        `Secure Share live sync remains gated; WAF readiness check unavailable (${result.readinessReason}).`
      );
    } else {
      console.log("Secure Share live sync remains gated; WAF verification skipped.");
    }
    return;
  }
  console.log(
    `Secure Share revision WAF verified: ${result.limit} requests/${result.windowSeconds}s per source IP.`
  );
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error
      ? error.message
      : "Vercel Firewall verification failed.";
    console.error(message);
    process.exitCode = 1;
  });
}
