import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30_000,
    include: [
      "tests/secureShareApiEmulator.test.ts",
      "tests/vaultFolderApiEmulator.test.ts",
      "tests/vaultNoteApiEmulator.test.ts"
    ],
    testTimeout: 30_000
  }
});
