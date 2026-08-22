import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/obsidian-official-oracle.compare.test.ts"],
    passWithNoTests: false
  }
});
