import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ciWorkflowSource = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const vercelWorkflowSource = readFileSync(join(process.cwd(), ".github/workflows/vercel-production.yml"), "utf8");

describe("CI/CD security controls", () => {
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

    expect(deployCondition).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deployCondition).toContain("github.event.workflow_run.event == 'push'");
    expect(deployCondition).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(deployCondition).toContain("github.event.workflow_run.head_branch == 'master'");
    expect(vercelWorkflowSource).toContain("permissions:\n  contents: read");
    expect(vercelWorkflowSource).not.toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24");
    expect(vercelWorkflowSource).toContain("uses: actions/checkout@v6");
    expect(vercelWorkflowSource).toContain("uses: actions/setup-node@v6");
    expect(vercelWorkflowSource).toContain("persist-credentials: false");
  });

  it("uses an explicitly versioned Vercel CLI for token-bearing deploys", () => {
    expect(vercelWorkflowSource).toContain("npx --yes vercel@54.4.1 deploy");
    expect(vercelWorkflowSource).not.toContain("npx vercel deploy");
  });
});
