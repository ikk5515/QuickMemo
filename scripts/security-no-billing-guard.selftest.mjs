import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { runZeroCostGuard } from "./security-no-billing-guard.mjs";

const temporaryRoots = [];

async function createFixture({ packageJson = {}, packageLock = {}, sourceFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "quickmemo-billing-guard-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "api"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "guard-fixture",
    private: true,
    dependencies: { "react-router-dom": "npm:react-router@8.3.0" },
    ...packageJson
  }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: { "react-router-dom": "npm:react-router@8.3.0" }
      }
    },
    ...packageLock
  }));
  await writeFile(
    join(root, ".env.example"),
    "FREE_TIER_MODE=true\nSECURE_SHARE_EMAIL_ENABLED=false\nSHARE_EMAIL_FREE_TIER_MODE=true\n"
  );
  await writeFile(join(root, "scripts", "verify-vercel-hobby-plan.mjs"), "export {};\n");
  await writeFile(join(root, "src", "main.ts"), "export {};\n");
  await writeFile(join(root, "api", "health.js"), "export default function health() {}\n");
  for (const [relativePath, source] of Object.entries(sourceFiles)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("allows a non-metered npm alias and zero-cost defaults", async () => {
  const root = await createFixture();
  const result = await runZeroCostGuard(root);
  assert.equal(result.checkedFiles, 2);
});

test("rejects a metered SDK hidden behind an npm alias", async () => {
  const root = await createFixture({
    packageJson: { dependencies: { "llm-client": "npm:openai@6.16.0" } }
  });
  await assert.rejects(
    runZeroCostGuard(root),
    /llm-client -> openai/u
  );
});

test("rejects a metered alias recorded only in the lockfile", async () => {
  const root = await createFixture({
    packageLock: {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "llm-client": "npm:@anthropic-ai/sdk@0.39.0" } }
      }
    }
  });
  await assert.rejects(
    runZeroCostGuard(root),
    /llm-client -> @anthropic-ai\/sdk/u
  );
});

test("rejects metered runtime code even when the filename ends in spec", async () => {
  const root = await createFixture({
    sourceFiles: {
      "src/metered.spec.ts": "export const endpoint = 'https://api.openai.com/v1/responses';\n",
      "src/main.ts": "import './metered.spec';\n"
    }
  });
  await assert.rejects(
    runZeroCostGuard(root),
    /OpenAI metered runtime integration is forbidden: src\/metered\.spec\.ts/u
  );
});

test("rejects a forbidden package identity from a lockfile package path", async () => {
  const root = await createFixture({
    packageLock: {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/replicate": {
          version: "1.4.0",
          resolved: "https://registry.npmjs.org/replicate/-/replicate-1.4.0.tgz"
        }
      }
    }
  });
  await assert.rejects(runZeroCostGuard(root), /replicate/u);
});
