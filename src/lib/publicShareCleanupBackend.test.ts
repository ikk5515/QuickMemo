import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  googleCalendarOAuthStateCleanupBatchLimit,
  queryExpiredGoogleCalendarOAuthStates
} from "../../api/cleanup-public-shares.js";

interface VercelConfig {
  fluid?: boolean;
  functions?: Record<string, {
    includeFiles?: string;
    maxDuration?: number;
  }>;
  crons?: Array<{
    path: string;
    schedule: string;
  }>;
}

const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as VercelConfig;
const cleanupFunctionSource = readFileSync(join(process.cwd(), "api/cleanup-public-shares.js"), "utf8");

describe("public share backend cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps cleanup APIs on Fluid Compute without lowering the platform duration default", () => {
    expect(vercelConfig.fluid).toBe(true);
    expect(vercelConfig.functions).not.toHaveProperty("api/cleanup-public-shares.js");
    expect(vercelConfig.functions?.["api/library-ocr-worker.js"]).toEqual({
      includeFiles: "node_modules/tesseract.js/dist/worker.min.js"
    });
    expect(
      Object.values(vercelConfig.functions ?? {}).every((configuration) => configuration.maxDuration === undefined)
    ).toBe(true);
  });

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
    expect(cleanupFunctionSource).toContain("storage.googleapis.com");
    expect(cleanupFunctionSource).toContain("storagePath");
    expect(cleanupFunctionSource).toContain("storageObjectsDeleted");
    expect(cleanupFunctionSource).toContain("Bearer");
    expect(cleanupFunctionSource).not.toMatch(forbiddenBackendPattern);
  });

  it("does not leak cleanup credential status and compares the cron secret safely", () => {
    const authGuard = cleanupFunctionSource.match(/const cronSecret = envValue\("CRON_SECRET"\);[\s\S]*?try \{/)?.[0] ?? "";

    expect(cleanupFunctionSource).toContain('import { createHash, timingSafeEqual } from "node:crypto";');
    expect(cleanupFunctionSource).toContain("function authorizedCleanupRequest");
    expect(cleanupFunctionSource).toContain("timingSafeStringEqual(authorizationHeader(request)");
    expect(cleanupFunctionSource).toContain("function safeErrorSummary(error)");
    expect(cleanupFunctionSource).toContain("redactLogMessage(error.message)");
    expect(cleanupFunctionSource).toContain('console.error("public share cleanup failed", safeErrorSummary(error))');
    expect(cleanupFunctionSource).toContain('console.error("public share cleanup denied", { reason: "cron_auth_unavailable" })');
    expect(cleanupFunctionSource).not.toContain('error: "cleanup_not_configured"');
    expect(cleanupFunctionSource).not.toContain("public share cleanup denied because CRON_SECRET is not configured");
    expect(cleanupFunctionSource).not.toContain('console.error("public share cleanup failed", error)');
    expect(authGuard).toContain('error: "unauthorized"');
    expect(authGuard).not.toContain("request.headers.authorization !==");
  });

  it("uses indexed fallback scans when cleanup queue discovery is incomplete", () => {
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "publicShareCleanupQueue" }]');
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "publicNoteShares" }]');
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "attachments", allDescendants: true }]');
    expect(cleanupFunctionSource).toContain("queryExpiredShares");
    expect(cleanupFunctionSource).toContain("queryExpiredPublicShareAttachments");
    expect(cleanupFunctionSource).toContain("queryExpiredAttachmentReservations");
    expect(cleanupFunctionSource).toContain('fieldPath: "reservationExpiresAt"');
    expect(cleanupFunctionSource).toContain("deleteExpiredAttachmentReservation");
    expect(cleanupFunctionSource).toContain("reservationsDeleted");
    expect(cleanupFunctionSource).toContain("queryAbandonedAttachmentDeletions");
    expect(cleanupFunctionSource).toContain('fieldPath: "deletionStartedAt"');
    expect(cleanupFunctionSource).toContain("queryLegacyExpiredAttachmentReservations");
    expect(cleanupFunctionSource).toContain("legacyReservationGraceMs");
    expect(cleanupFunctionSource).toContain("queryExpiredGoogleCalendarOAuthStates");
    expect(cleanupFunctionSource).toContain('from: [{ collectionId: "googleCalendarOAuthStates" }]');
    expect(cleanupFunctionSource).toContain("googleCalendarOAuthStatesDeleted");
    expect(cleanupFunctionSource).toContain("without allowing authorization churn to starve user-data queues");
  });

  it("queries only expired OAuth state names in oldest-first bounded order", async () => {
    const stateName = "projects/test-project/databases/(default)/documents/googleCalendarOAuthStates/state-1";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ document: { name: stateName } }]
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryExpiredGoogleCalendarOAuthStates({
      accessToken: "test-access-token",
      projectId: "test-project",
      nowIso: "2026-07-22T00:00:00.000Z",
      limit: 37
    })).resolves.toEqual([{ name: stateName }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe(
      "https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/documents:runQuery"
    );
    expect(init.method).toBe("POST");
    expect(body.structuredQuery).toEqual({
      select: { fields: [{ fieldPath: "__name__" }] },
      from: [{ collectionId: "googleCalendarOAuthStates" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "expiresAt" },
          op: "LESS_THAN_OR_EQUAL",
          value: { timestampValue: "2026-07-22T00:00:00.000Z" }
        }
      },
      orderBy: [{ field: { fieldPath: "expiresAt" }, direction: "ASCENDING" }],
      limit: 37
    });
  });

  it("reserves a small OAuth cleanup batch while preserving most of the shared delete budget", () => {
    expect(googleCalendarOAuthStateCleanupBatchLimit(50, 1000)).toBe(50);
    expect(googleCalendarOAuthStateCleanupBatchLimit(100, 100)).toBe(10);
    expect(googleCalendarOAuthStateCleanupBatchLimit(100, 10)).toBe(1);

    const cleanupStart = cleanupFunctionSource.indexOf("async function cleanupExpiredPublicShares");
    const oauthCleanup = cleanupFunctionSource.indexOf(
      "await cleanupExpiredGoogleCalendarOAuthStates(config, stats)",
      cleanupStart
    );
    const purgeCleanup = cleanupFunctionSource.indexOf("await cleanupNotePurgeQueues(config, stats)", cleanupStart);
    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(oauthCleanup).toBeGreaterThan(cleanupStart);
    expect(oauthCleanup).toBeLessThan(purgeCleanup);
  });

  it("uses high-capacity batched deletes so the no-billing fallback is harder to outpace", () => {
    expect(cleanupFunctionSource).toContain("const defaultBatchSize = 50");
    expect(cleanupFunctionSource).toContain("const defaultMaxDocumentDeletes = 1000");
    expect(cleanupFunctionSource).toContain("defaultMaxDocumentDeletes, 10, 5000");
    expect(cleanupFunctionSource).toContain("const firestoreCommitWriteLimit = 500");
    expect(cleanupFunctionSource).toContain("firestoreCommitPathFromDocumentName");
    expect(cleanupFunctionSource).toContain("firestoreDeleteMany");
    expect(cleanupFunctionSource).toContain(":commit");
  });

  it("claims attachment metadata and quota in one preconditioned commit", () => {
    const claimSource = cleanupFunctionSource.match(
      /async function claimAttachmentDeletionByName[\s\S]*?async function deleteAttachmentObjects/u
    )?.[0] ?? "";

    expect(claimSource).toContain("quotaReleaseAfterAttachmentClaim");
    expect(claimSource).toContain("currentDocument: { updateTime: claim.attachmentUpdateTime }");
    expect(claimSource).toContain("currentDocument: { updateTime: claim.quota.quotaUpdateTime }");
    expect(claimSource).toContain('quotaReserved: hasField(attachment, "quotaReserved")');
    expect(claimSource).toContain('stringField(attachment, "storageProvider") === "vercel-blob"');
    expect(cleanupFunctionSource).toContain("countPolicyVersion");
  });

  it("durably cleans validated purged-note queues before the final tombstone commit", () => {
    const purgeSource = cleanupFunctionSource.match(
      /function validPurgeQueue[\s\S]*?async function cleanupExpiredPublicShares/u
    )?.[0] ?? "";

    expect(purgeSource).toContain("notePurgeCleanupQueue");
    expect(purgeSource).toContain('booleanField(noteDocument, "isPurged")');
    expect(purgeSource).toContain('stringField(noteDocument, "ownerUid") === ownerUid');
    expect(purgeSource).toContain('listChildDocuments(noteName, "attachments"');
    expect(purgeSource).toContain('listChildDocuments(noteName, "history"');
    expect(purgeSource).toContain("noteUserStates");
    expect(purgeSource).toContain("queryActiveNotesByNoteId");
    expect(purgeSource).toContain("finalizePurgedNote");
    expect(purgeSource).toContain("backfillNotePurgeQueues");
    expect(purgeSource).toContain("queryPurgedNotes");
    expect(purgeSource).toContain("currentDocument: { exists: false }");
    expect(purgeSource).toContain("currentDocument: { updateTime: currentNote.updateTime }");
    expect(purgeSource).toContain("currentDocument: { updateTime: currentQueue.updateTime }");
  });

  it("bounds purge queue and child reads to the serverless delete budget", () => {
    expect(cleanupFunctionSource).toContain("maxDocuments = Number.POSITIVE_INFINITY");
    expect(cleanupFunctionSource).toContain("documents.length < maxDocuments");
    expect(cleanupFunctionSource).toContain('"notePurgeCleanupQueue",\n    config.accessToken,\n    config.limit');
    expect(cleanupFunctionSource).toContain("Math.min(50, remainingHistoryDeletes)");
    expect(cleanupFunctionSource).toContain("Math.min(500, remainingStateDeletes)");
  });

  it("projects cleanup discovery and child listings without encrypted payload fields", () => {
    const nameOnlyQueries = [
      "queryExpiredShareQueues",
      "queryExpiredGoogleCalendarOAuthStates",
      "queryExpiredShares",
      "queryExpiredPublicShareAttachments",
      "queryExpiredAttachmentReservations",
      "queryAbandonedAttachmentDeletions",
      "queryLegacyExpiredAttachmentReservations",
      "queryActiveNotesByNoteId"
    ];

    for (const functionName of nameOnlyQueries) {
      const querySource = cleanupFunctionSource.match(
        new RegExp(`async function ${functionName}\\([\\s\\S]*?return result\\.flatMap`, "u")
      )?.[0] ?? "";

      expect(querySource).toContain('fields: [{ fieldPath: "__name__" }]');
    }

    const purgedNoteQuery = cleanupFunctionSource.match(
      /async function queryPurgedNotes[\s\S]*?return result\.flatMap/u
    )?.[0] ?? "";

    expect(purgedNoteQuery).toContain('{ fieldPath: "ownerUid" }');
    expect(purgedNoteQuery).toContain('{ fieldPath: "isDeleted" }');
    expect(purgedNoteQuery).toContain('{ fieldPath: "isPurged" }');
    expect(cleanupFunctionSource).toContain('query.append("mask.fieldPaths", fieldPath)');
    expect(cleanupFunctionSource).toContain('["noteId", "ownerUid"]');
    expect(cleanupFunctionSource).toContain('["revision"]');
    expect(cleanupFunctionSource).toContain('["updatedAt"]');
    expect(cleanupFunctionSource).toContain('["isReady"]');
    expect(cleanupFunctionSource).toContain('["expiresAt"]');
  });

  it("bounds public share tree cleanup and retains parents while children remain", () => {
    const shareTreeSource = cleanupFunctionSource.match(
      /async function deletePublicShareTreeByName[\s\S]*?async function deletePublicShareTree\(/u
    )?.[0] ?? "";

    expect(shareTreeSource).toContain("remainingAttachmentDeleteBudget");
    expect(shareTreeSource).toContain("Math.min(300, Math.max(1, Math.floor(remainingAttachmentDeleteBudget / 2)))");
    expect(shareTreeSource).toContain('listChildDocuments(shareName, "attachments", accessToken, 1, ["isReady"])');
    expect(shareTreeSource).toContain("Math.min(300, remainingQueueDeleteBudget)");
    expect(shareTreeSource).toContain(
      'listChildDocuments(cleanupQueueName, "publicShareAttachmentCleanupQueue", accessToken, 1, ["expiresAt"])'
    );
    expect(shareTreeSource).toContain("stats.documentDeletesAttempted + 2 > stats.maxDocumentDeletes");
  });
});
