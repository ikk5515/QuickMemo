/* global process */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReviewedRepair,
  buildReport,
  parseArguments
} from "./reconcile-blob-attachment-counter.mjs";

const source = readFileSync(
  join(process.cwd(), "scripts/reconcile-blob-attachment-counter.mjs"),
  "utf8"
);

describe("Blob attachment counter reconciliation", () => {
  it("defaults to a read-only inventory report and never prints attachment paths", () => {
    expect(source).toContain('mode: options.apply ? "reviewed_cas_repair" : "read_only"');
    expect(source).toContain('from: [{ collectionId: "attachments", allDescendants: true }]');
    expect(source).toContain("blobInventory(options.maximumDocuments)");
    expect(source).toContain("readyMissingObjectCount");
    expect(source).toContain("orphanBlobObjectCount");
    expect(source).not.toContain("report: { metadataPaths");
    expect(source).not.toContain("process.stdout.write(blobPath");
    expect(parseArguments([])).toMatchObject({ apply: false, maximumDocuments: 10_000 });
  });

  it("requires a reviewed digest and exact updateTime before a CAS repair", () => {
    expect(source).toContain("--confirm-sha256 must exactly match the reviewed report digest");
    expect(source).toContain("--expected-update-time must exactly match the reviewed counter snapshot");
    expect(source).toContain("currentDocument: { updateTime: options.expectedUpdateTime }");
    expect(source).toContain("Repair is blocked until inventory integrity findings are resolved");
    expect(source).toContain("report.metadata.invalidCount !== 0");
    expect(source).toContain("report.blobInventory.orphanObjectCount !== 0");
    expect(source).not.toContain("currentDocument: { exists: false }");
  });

  it("reports synthetic orphan and invalid metadata without exposing identifiers", () => {
    const counter = {
      updateTime: "2026-08-31T00:00:00.000000Z",
      fields: {
        schemaVersion: { integerValue: "1" },
        attachmentCount: { integerValue: "1" },
        usedBytes: { integerValue: "128" }
      }
    };
    const metadata = [{
      name: "projects/test/databases/(default)/documents/notes/note-a/attachments/attachment-a",
      fields: {
        blobPath: { stringValue: "users/user-a/notes/note-a/attachments/attachment-a/data" },
        encryptedSize: { integerValue: "128" },
        isReady: { booleanValue: true },
        quotaReserved: { booleanValue: true },
        storageProvider: { stringValue: "vercel-blob" }
      }
    }];
    const matchingBlob = {
      pathname: "users/user-a/notes/note-a/attachments/attachment-a/data",
      size: 128
    };
    const clean = buildReport(counter, metadata, [matchingBlob]);
    expect(clean.report.metadata).toMatchObject({
      attachmentCount: 1,
      invalidCount: 0,
      readyMissingObjectCount: 0
    });
    expect(clean.report.blobInventory.orphanObjectCount).toBe(0);
    expect(JSON.stringify(clean.report)).not.toContain("note-a");
    expect(() => assertReviewedRepair(clean.report, clean.digest, {
      expectedUpdateTime: counter.updateTime,
      confirmSha256: clean.digest
    })).not.toThrow();

    const orphan = buildReport(counter, metadata, [
      matchingBlob,
      { pathname: "users/user-b/notes/note-b/attachments/attachment-b/data", size: 64 }
    ]);
    expect(orphan.report.blobInventory.orphanObjectCount).toBe(1);
    expect(() => assertReviewedRepair(orphan.report, orphan.digest, {
      expectedUpdateTime: counter.updateTime,
      confirmSha256: orphan.digest
    })).toThrow("Repair is blocked");

    const invalid = buildReport(counter, [{
      ...metadata[0],
      fields: { ...metadata[0].fields, encryptedSize: { integerValue: "-1" } }
    }], [matchingBlob]);
    expect(invalid.report.metadata.invalidCount).toBe(1);
  });
});
