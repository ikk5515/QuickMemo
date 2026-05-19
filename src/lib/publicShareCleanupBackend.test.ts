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

  it("uses indexed fallback scans when cleanup queue discovery is incomplete", () => {
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "publicShareCleanupQueue" }]');
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "publicNoteShares" }]');
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "attachments", allDescendants: true }]');
    expect(cleanupFunctionSource).toContain("queryExpiredShares");
    expect(cleanupFunctionSource).toContain("queryExpiredPublicShareAttachments");
  });

  it("uses high-capacity batched deletes so the no-billing fallback is harder to outpace", () => {
    expect(cleanupFunctionSource).toContain("const defaultBatchSize = 100");
    expect(cleanupFunctionSource).toContain("const defaultMaxDocumentDeletes = 18000");
    expect(cleanupFunctionSource).toContain("const firestoreCommitWriteLimit = 500");
    expect(cleanupFunctionSource).toContain("firestoreCommitPathFromDocumentName");
    expect(cleanupFunctionSource).toContain("firestoreDeleteMany");
    expect(cleanupFunctionSource).toContain(":commit");
  });
});
