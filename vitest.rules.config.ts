import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globals: true,
    // A cold GitHub runner downloads and boots both emulator JARs before this
    // hook connects. Keep the security assertions unchanged while allowing
    // that one-time CI startup to exceed Vitest's 10 second default.
    hookTimeout: 60_000,
    include: ["tests/firestore.rules.test.ts", "tests/storage.rules.test.ts"]
  }
});
