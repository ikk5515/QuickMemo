import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 60_000,
    include: [
      "tests/SecurePublicShareViewerRender.benchmark.tsx",
      "tests/secureSharePerformance.benchmark.ts"
    ],
    testTimeout: 300_000
  }
});
