import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ciWorkflowSource = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const vercelWorkflowSource = readFileSync(join(process.cwd(), ".github/workflows/vercel-production.yml"), "utf8");
const releaseContractSource = readFileSync(
  join(process.cwd(), "scripts/verify-production-release-contract.mjs"),
  "utf8"
);
const sensitiveFileGuardSource = readFileSync(
  join(process.cwd(), "scripts/security-gitignore-guard.mjs"),
  "utf8"
);

describe("CI/CD security controls", () => {
  it("scans every privileged runtime credential name before release", () => {
    const sensitiveEnvNames = sensitiveFileGuardSource.match(
      /const sensitiveEnvNames = \[[\s\S]*?\n\];/u
    )?.[0] ?? "";
    const allowedPublicViteEnvNames = sensitiveFileGuardSource.match(
      /const allowedPublicViteEnvNames = new Set\(\[[\s\S]*?\n\]\);/u
    )?.[0] ?? "";

    for (const name of [
      "BLOB_READ_WRITE_TOKEN",
      "VERCEL_OIDC_TOKEN",
      "SHARE_EMAIL_API_KEY",
      "SHARE_PASSWORD_PEPPER",
      "SHARE_SESSION_HMAC_KEY",
      "SHARE_PARTICIPANT_HMAC_KEY",
      "SHARE_COOKIE_NAME_HMAC_KEY",
      "SHARE_CSRF_HMAC_KEY"
    ]) {
      expect(sensitiveEnvNames).toContain(`"${name}"`);
    }

    expect(sensitiveFileGuardSource).toContain(
      "sensitiveEnvNames.map((name) => `VITE_${name}`)"
    );
    const syntheticPrivilegedViteName = ["VITE", "SHARE", "PASSWORD", "PEPPER"].join("_");

    expect(sensitiveFileGuardSource).toContain("hasPrivilegedViteEnvUsage");
    expect(sensitiveFileGuardSource).toContain("content.matchAll(viteIdentifierPattern)");
    expect(sensitiveFileGuardSource).toContain("assertPrivilegedViteIdentifierScanner();");
    expect(sensitiveFileGuardSource).not.toContain(JSON.stringify(syntheticPrivilegedViteName));
    expect(allowedPublicViteEnvNames).toContain('"VITE_FIREBASE_API_KEY"');
    expect(allowedPublicViteEnvNames).toContain('"VITE_RECAPTCHA_ENTERPRISE_SITE_KEY"');
  });

  it("keeps CI token permissions read-only", () => {
    expect(ciWorkflowSource).toContain("permissions:\n  contents: read");
    expect(ciWorkflowSource).not.toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24");
    expect(ciWorkflowSource).toContain("uses: actions/checkout@v6");
    expect(ciWorkflowSource).toContain("uses: actions/setup-node@v6");
    expect(ciWorkflowSource).toContain("uses: actions/setup-java@v5");
    expect(ciWorkflowSource).toContain("persist-credentials: false");
  });

  it("deploys production only from trusted master push workflow runs", () => {
    const deployCondition = vercelWorkflowSource.match(/if: \$\{\{[\s\S]*?\}\}/)?.[0] ?? "";
    const jobsIndex = vercelWorkflowSource.indexOf("\njobs:");
    const workflowScope = vercelWorkflowSource.slice(0, jobsIndex);
    const deployJob = vercelWorkflowSource.slice(jobsIndex);

    expect(deployCondition).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deployCondition).toContain("github.event.workflow_run.event == 'push'");
    expect(deployCondition).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(deployCondition).toContain("github.event.workflow_run.head_branch == 'master'");
    expect(vercelWorkflowSource).toContain("permissions:\n  contents: read");
    expect(vercelWorkflowSource).not.toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24");
    expect(vercelWorkflowSource).toContain("uses: actions/checkout@v6");
    expect(vercelWorkflowSource).toContain("uses: actions/setup-node@v6");
    expect(vercelWorkflowSource).toContain("persist-credentials: false");
    expect(workflowScope).not.toContain("\nconcurrency:");
    expect(deployJob).toContain(
      "concurrency:\n      group: vercel-production-${{ github.event.workflow_run.head_branch }}"
    );
    expect(deployJob).toContain("cancel-in-progress: true");
    expect(deployJob).toContain("environment:\n      name: production");
    expect(vercelWorkflowSource).toContain("git ls-remote --exit-code origin refs/heads/master");
    expect(vercelWorkflowSource).toContain("steps.master_at_start.outputs.current == 'true'");
    expect(vercelWorkflowSource).toContain("steps.master_before_deploy.outputs.current == 'true'");
    expect(vercelWorkflowSource.match(/git ls-remote --exit-code origin refs\/heads\/master/g)).toHaveLength(2);
    expect(vercelWorkflowSource.indexOf("Revalidate master immediately before deployment")).toBeLessThan(
      vercelWorkflowSource.indexOf("      - name: Deploy")
    );
  });

  it("requires exact Firebase, Spark, and explicit Vault release attestations", () => {
    const contractIndex = vercelWorkflowSource.indexOf(
      "Verify attested Firebase and Vault release contract"
    );
    const hobbyEnabledIndex = vercelWorkflowSource.indexOf(
      "Verify zero-cost Vercel Hobby plan and enabled Vault flag"
    );
    const hobbyDisabledIndex = vercelWorkflowSource.indexOf(
      "Verify zero-cost Vercel Hobby plan and disabled Vault flag"
    );
    const deployIndex = vercelWorkflowSource.indexOf("      - name: Deploy");

    expect(contractIndex).toBeGreaterThan(-1);
    expect(contractIndex).toBeLessThan(hobbyEnabledIndex);
    expect(contractIndex).toBeLessThan(hobbyDisabledIndex);
    expect(hobbyEnabledIndex).toBeLessThan(deployIndex);
    expect(hobbyDisabledIndex).toBeLessThan(deployIndex);
    expect(vercelWorkflowSource).toContain(
      "FIREBASE_DEPLOYED_RULES_INDEXES_SHA256: ${{ vars.FIREBASE_DEPLOYED_RULES_INDEXES_SHA256 }}"
    );
    expect(vercelWorkflowSource).toContain(
      "FIREBASE_SPARK_ATTESTATION: ${{ vars.FIREBASE_SPARK_ATTESTATION }}"
    );
    expect(vercelWorkflowSource).toContain(
      "VAULT_RELEASE_STATE: ${{ vars.VAULT_RELEASE_STATE }}"
    );
    expect(vercelWorkflowSource).toContain(
      "node scripts/verify-production-release-contract.mjs --verify"
    );
    expect(vercelWorkflowSource).toContain("--expect-vault-enabled");
    expect(vercelWorkflowSource).toContain("--expect-vault-disabled");
    expect(vercelWorkflowSource).toContain(
      "steps.release_contract.outputs.contract_verified == 'true'"
    );
    expect(vercelWorkflowSource).toContain(
      "steps.release_contract.outputs.vault_enabled == 'true' || steps.release_contract.outputs.vault_enabled == 'false'"
    );
    expect(releaseContractSource).toContain(
      'export const PRODUCTION_FIREBASE_PROJECT_ID = "quickmemo-a95ba"'
    );
    expect(releaseContractSource).toContain(
      '"firestore.rules",\n  "firestore.indexes.json"'
    );
    expect(releaseContractSource).not.toContain("console.log(input");
    expect(vercelWorkflowSource).not.toMatch(
      /echo[^\n]*(?:FIREBASE_DEPLOYED_RULES_INDEXES_SHA256|FIREBASE_SPARK_ATTESTATION|VAULT_RELEASE_STATE)/u
    );
  });

  it("uses an explicitly versioned Vercel CLI without putting its token in argv", () => {
    expect(vercelWorkflowSource).toContain("npx --yes vercel@54.4.1 deploy");
    expect(vercelWorkflowSource).not.toContain("npx vercel deploy");
    expect(vercelWorkflowSource).toContain("VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    expect(vercelWorkflowSource).not.toContain("--token");
    expect(vercelWorkflowSource).toContain("fetch-depth: 2");
    expect(vercelWorkflowSource).toContain("git diff --check HEAD^ HEAD");
  });
});
