import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertProductionVaultDisabled,
  assertProductionVaultEnabled,
  assertVercelHobbyPlan,
  normalizedVercelPlan,
  productionEnvironmentMetadataEndpoint,
  productionEnvironmentValueEndpoint,
  productionVaultEnvironmentId,
  verifyProductionVaultDisabled,
  verifyProductionVaultEnabled
} from "./verify-vercel-hobby-plan.mjs";

describe("Vercel zero-cost plan gate", () => {
  it("accepts only an explicitly verified Hobby billing plan", () => {
    expect(normalizedVercelPlan({ billing: { plan: "Hobby" } })).toBe("hobby");
    expect(assertVercelHobbyPlan({ billing: { plan: "hobby" } })).toBe("hobby");
  });

  it.each(["pro", "enterprise", "trial", "", undefined])(
    "rejects non-Hobby plan %s",
    (plan) => {
      expect(() => assertVercelHobbyPlan(
        plan === undefined ? {} : { billing: { plan } }
      )).toThrow("not verified as Hobby");
    }
  );

  it("finds only the production Vault flag metadata without reading list values", () => {
    expect(productionVaultEnvironmentId({ envs: [] })).toBeNull();
    expect(productionVaultEnvironmentId({
      envs: [{ key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["preview"] }]
    })).toBeNull();
    expect(productionVaultEnvironmentId({
      envs: [
        { id: "env_other", key: "DATABASE_URL", target: ["production"], value: "opaque-other-value" },
        { id: "env_vault", key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["production"], value: "opaque-flag-value" }
      ]
    })).toBe("env_vault");
  });

  it.each(["true", "0", "False", "", undefined])(
    "blocks an unsafe or unverifiable production Vault flag value %s",
    (value) => {
      expect(() => assertProductionVaultDisabled({
        id: "env_vault",
        key: "VITE_OBSIDIAN_VAULT_ENABLED",
        target: "production",
        value
      }, "env_vault")).toThrow("not explicitly disabled");
    }
  );

  it("accepts only the expected single production variable with value false", () => {
    expect(assertProductionVaultDisabled({
      id: "env_vault",
      key: "VITE_OBSIDIAN_VAULT_ENABLED",
      target: ["production"],
      value: "false"
    }, "env_vault")).toBe("false");
    expect(() => assertProductionVaultDisabled({
      id: "env_other",
      key: "VITE_OBSIDIAN_VAULT_ENABLED",
      target: ["production"],
      value: "false"
    }, "env_vault")).toThrow("not explicitly disabled");
  });

  it("accepts production activation only for the exact true flag", () => {
    expect(assertProductionVaultEnabled({
      id: "env_vault",
      key: "VITE_OBSIDIAN_VAULT_ENABLED",
      target: ["production"],
      value: "true"
    }, "env_vault")).toBe("true");
    expect(() => assertProductionVaultEnabled({
      id: "env_vault",
      key: "VITE_OBSIDIAN_VAULT_ENABLED",
      target: ["production"],
      value: "false"
    }, "env_vault")).toThrow("not explicitly enabled");
  });

  it("blocks duplicate or identifier-less production Vault flag metadata", () => {
    expect(() => productionVaultEnvironmentId({
      envs: [
        { id: "env_one", key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["production"] },
        { id: "env_two", key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["production"] }
      ]
    })).toThrow("metadata is ambiguous");
    expect(() => productionVaultEnvironmentId({
      envs: [{ key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["production"] }]
    })).toThrow("metadata is ambiguous");
    expect(() => productionVaultEnvironmentId({
      envs: [{
        id: "env_mixed",
        key: "VITE_OBSIDIAN_VAULT_ENABLED",
        target: ["production", "preview"]
      }]
    })).toThrow("metadata is ambiguous");
    expect(() => productionVaultEnvironmentId({
      envs: [{
        id: "env_string",
        key: "VITE_OBSIDIAN_VAULT_ENABLED",
        target: "production"
      }]
    })).toThrow("metadata is ambiguous");
  });

  it("rejects a decrypted Vault flag that is not production-only", () => {
    expect(() => assertProductionVaultEnabled({
      id: "env_vault",
      key: "VITE_OBSIDIAN_VAULT_ENABLED",
      target: ["production", "preview"],
      value: "true"
    }, "env_vault")).toThrow("not explicitly enabled");
  });

  it("fails closed on an unknown or paginated environment response", () => {
    expect(() => productionVaultEnvironmentId({})).toThrow("could not be verified");
    expect(() => productionVaultEnvironmentId({
      envs: [],
      pagination: { next: 100 }
    })).toThrow("result was incomplete");
  });

  it("uses the metadata endpoint without decryption and the official single-value endpoint", () => {
    const metadata = new URL(productionEnvironmentMetadataEndpoint("project/id", "team_example"));
    const value = new URL(productionEnvironmentValueEndpoint("project/id", "env/vault", "team_example"));

    expect(metadata.pathname).toBe("/v10/projects/project%2Fid/env");
    expect(metadata.searchParams.get("decrypt")).toBe("false");
    expect(metadata.searchParams.get("teamId")).toBe("team_example");
    expect(value.pathname).toBe("/v1/projects/project%2Fid/env/env%2Fvault");
    expect(value.searchParams.has("decrypt")).toBe(false);
    expect(value.searchParams.get("teamId")).toBe("team_example");
  });

  it("decrypts only the selected Vault flag record", async () => {
    const requested = [];
    const requestJson = async (url) => {
      requested.push(url);
      return requested.length === 1
        ? {
            envs: [
              { id: "env_other", key: "DATABASE_URL", target: ["production"], value: "opaque" },
              { id: "env_vault", key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["production"], value: "opaque" }
            ]
          }
        : {
            id: "env_vault",
            key: "VITE_OBSIDIAN_VAULT_ENABLED",
            target: ["production"],
            value: "false"
          };
    };

    await expect(verifyProductionVaultDisabled({
      organizationId: "team_example",
      projectId: "project",
      token: "test-token"
    }, requestJson)).resolves.toBe("false");
    expect(requested).toHaveLength(2);
    expect(new URL(requested[0]).searchParams.get("decrypt")).toBe("false");
    expect(new URL(requested[1]).pathname).toBe("/v1/projects/project/env/env_vault");
    expect(requested.join("\n")).not.toContain("env_other/");
  });

  it("requires a present true production flag for the one-time full activation", async () => {
    const requestJson = vi.fn()
      .mockResolvedValueOnce({
        envs: [{ id: "env_vault", key: "VITE_OBSIDIAN_VAULT_ENABLED", target: ["production"] }]
      })
      .mockResolvedValueOnce({
        id: "env_vault",
        key: "VITE_OBSIDIAN_VAULT_ENABLED",
        target: ["production"],
        value: "true"
      });
    await expect(verifyProductionVaultEnabled({
      organizationId: "team_example",
      projectId: "project",
      token: "test-token"
    }, requestJson)).resolves.toBe("true");
    expect(requestJson).toHaveBeenCalledTimes(2);

    await expect(verifyProductionVaultEnabled({
      organizationId: "team_example",
      projectId: "project",
      token: "test-token"
    }, vi.fn().mockResolvedValue({ envs: [] }))).rejects.toThrow("not explicitly enabled");
  });

  it("does not request a decrypted value when the flag is unset", async () => {
    const requestJson = vi.fn().mockResolvedValue({ envs: [] });
    await expect(verifyProductionVaultDisabled({
      organizationId: "user_example",
      projectId: "project",
      token: "test-token"
    }, requestJson)).resolves.toBe("unset");
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});
