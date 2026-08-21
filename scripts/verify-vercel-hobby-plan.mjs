import { fileURLToPath } from "node:url";

export function normalizedVercelPlan(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidates = [
    payload.billing?.plan,
    payload.billing?.planName,
    payload.plan,
    payload.type
  ];
  return candidates.find((value) => typeof value === "string")?.trim().toLocaleLowerCase("en-US") ?? "";
}

export function assertVercelHobbyPlan(payload) {
  const plan = normalizedVercelPlan(payload);
  if (plan !== "hobby") {
    throw new Error("Vercel deployment is blocked because the account was not verified as Hobby.");
  }
  return plan;
}

function productionTarget(target) {
  const targets = Array.isArray(target) ? target : [target];
  return targets.includes("production");
}

const VAULT_FEATURE_FLAG_KEY = "VITE_OBSIDIAN_VAULT_ENABLED";

export function productionVaultEnvironmentId(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.envs)) {
    throw new Error("Vercel deployment is blocked because the production environment could not be verified.");
  }
  if (payload.pagination?.next !== undefined && payload.pagination.next !== null) {
    throw new Error("Vercel deployment is blocked because the production environment result was incomplete.");
  }
  const records = payload.envs;
  const productionRecords = records.filter((record) => (
    record
    && typeof record === "object"
    && record.key === VAULT_FEATURE_FLAG_KEY
    && productionTarget(record.target)
  ));
  if (productionRecords.length === 0) {
    return null;
  }
  if (
    productionRecords.length !== 1
    || typeof productionRecords[0].id !== "string"
    || productionRecords[0].id.trim() === ""
    || productionRecords[0].id.trim() !== productionRecords[0].id
  ) {
    throw new Error("Vercel deployment is blocked because the production Vault feature flag metadata is ambiguous.");
  }
  return productionRecords[0].id;
}

export function assertProductionVaultDisabled(payload, expectedId) {
  if (
    !payload
    || typeof payload !== "object"
    || typeof expectedId !== "string"
    || expectedId === ""
    || payload.id !== expectedId
    || payload.key !== VAULT_FEATURE_FLAG_KEY
    || !productionTarget(payload.target)
    || payload.value !== "false"
  ) {
    throw new Error("Vercel deployment is blocked because the production Vault feature flag is not explicitly disabled.");
  }
  return "false";
}

function appendTeamId(endpoint, organizationId) {
  if (organizationId.startsWith("team_")) {
    endpoint.searchParams.set("teamId", organizationId);
  }
  return endpoint;
}

export function productionEnvironmentMetadataEndpoint(projectId, organizationId) {
  const endpoint = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env`
  );
  endpoint.searchParams.set("decrypt", "false");
  return appendTeamId(endpoint, organizationId).toString();
}

export function productionEnvironmentValueEndpoint(projectId, environmentId, organizationId) {
  const endpoint = new URL(
    `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(environmentId)}`
  );
  return appendTeamId(endpoint, organizationId).toString();
}

async function vercelJson(url, token) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Vercel plan verification failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function verifyProductionVaultDisabled(
  { organizationId, projectId, token },
  requestJson = vercelJson
) {
  const metadataPayload = await requestJson(
    productionEnvironmentMetadataEndpoint(projectId, organizationId),
    token
  );
  const environmentId = productionVaultEnvironmentId(metadataPayload);
  if (!environmentId) {
    return "unset";
  }
  const valuePayload = await requestJson(
    productionEnvironmentValueEndpoint(projectId, environmentId, organizationId),
    token
  );
  return assertProductionVaultDisabled(valuePayload, environmentId);
}

async function main() {
  if (!process.argv.includes("--probe")) {
    throw new Error("Pass --probe to perform the read-only Vercel plan verification.");
  }
  const token = process.env.VERCEL_TOKEN;
  const organizationId = process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !organizationId || !projectId) {
    throw new Error("VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID are required for deployment preflight.");
  }

  const endpoint = organizationId.startsWith("team_")
    ? `https://api.vercel.com/v2/teams/${encodeURIComponent(organizationId)}`
    : "https://api.vercel.com/v2/user";
  const payload = await vercelJson(endpoint, token);
  assertVercelHobbyPlan(payload);
  await verifyProductionVaultDisabled({ organizationId, projectId, token });
  console.log("Vercel Hobby plan and disabled production Vault flag verified; paid or premature deployment is blocked.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Vercel plan verification failed.");
    process.exitCode = 1;
  });
}
