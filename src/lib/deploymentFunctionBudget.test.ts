// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("enforces the Hobby API budget while preserving utility and declaration exclusions", () => {
  const root = mkdtempSync(join(tmpdir(), "quickmemo-function-budget-"));
  const script = resolve("scripts/security-functions-guard.mjs");
  try {
    mkdirSync(join(root, "api"));
    for (const name of ["firebase.json", "package.json", "package-lock.json"]) writeFileSync(join(root, name), "{}");
    writeFileSync(join(root, "firestore.rules"), "");
    for (let index = 0; index < 12; index++) writeFileSync(join(root, "api", `endpoint-${index}.js`), "export default function handler() {}");
    for (const name of ["_workspace-preferences.js", ".hidden.js", "route.d.ts"]) writeFileSync(join(root, "api", name), "");
    expect(execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" })).toContain("12/12");
    writeFileSync(join(root, "api", "extra.js"), "export default function handler() {}");
    const rejected = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(rejected.status).toBe(1); expect(rejected.stderr).toContain("found 13");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
