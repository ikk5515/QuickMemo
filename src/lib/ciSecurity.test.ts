import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ciWorkflowSource = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const vercelWorkflowSource = readFileSync(join(process.cwd(), ".github/workflows/vercel-production.yml"), "utf8");
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
    expect(vercelWorkflowSource).toContain("git ls-remote --exit-code origin refs/heads/master");
    expect(vercelWorkflowSource).toContain("steps.master_at_start.outputs.current == 'true'");
    expect(vercelWorkflowSource).toContain("steps.master_before_deploy.outputs.current == 'true'");
    expect(vercelWorkflowSource.match(/git ls-remote --exit-code origin refs\/heads\/master/g)).toHaveLength(2);
    expect(vercelWorkflowSource.indexOf("Revalidate master immediately before deployment")).toBeLessThan(
      vercelWorkflowSource.indexOf("      - name: Deploy")
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
