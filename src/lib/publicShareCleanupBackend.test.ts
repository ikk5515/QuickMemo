import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  crons?: Array<{
    path: string;
    schedule: string;
  }>;
}

const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as VercelConfig;
const cleanupFunctionSource = readFileSync(join(process.cwd(), "api/cleanup-public-shares.js"), "utf8");

describe("public share backend cleanup", () => {
  it("keeps a production cron route for expired public share cleanup", () => {
    expect(vercelConfig.crons).toContainEqual({
      path: "/api/cleanup-public-shares",
      schedule: "0 3 * * *"
    });
  });

  it("uses the non-sensitive cleanup queue without Firebase Admin or Cloud Functions", () => {
    const forbiddenBackendPattern = new RegExp(`firebase-${"admin"}|firebase-${"functions"}|serviceAccount`, "i");

    expect(cleanupFunctionSource).toContain("CRON_SECRET");
    expect(cleanupFunctionSource).toContain("publicShareCleanupQueue");
    expect(cleanupFunctionSource).toContain("publicShareAttachmentCleanupQueue");
    expect(cleanupFunctionSource).toContain("publicNoteShares");
    expect(cleanupFunctionSource).toContain("Bearer");
    expect(cleanupFunctionSource).not.toMatch(forbiddenBackendPattern);
  });

  it("queries the indexed cleanup queue instead of the TTL-only public share expiresAt field", () => {
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "publicShareCleanupQueue" }]');
    expect(cleanupFunctionSource).not.toContain('from: [{ collectionId: "publicNoteShares" }]');
    expect(cleanupFunctionSource).not.toContain("queryExpiredShares");
  });
});
