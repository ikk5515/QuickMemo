import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAttachmentDeletion,
  noteAttachmentReservationWrites,
  reserveNoteAttachmentCountWrite,
  reserveUserAttachmentBytes
} from "../../api/blob-attachments.js";
import {
  NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION,
  NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION
} from "../../api/_note-attachment-counter.js";

type FirestoreValue = {
  arrayValue?: { values?: Array<{ stringValue?: string }> };
  booleanValue?: boolean;
  integerValue?: string;
  mapValue?: { fields?: Record<string, FirestoreValue> };
  stringValue?: string;
};

type FirestoreDocument = {
  fields: Record<string, FirestoreValue>;
  name: string;
  updateTime: string;
};

const projectId = "blob-free-tier-race";
const root = `projects/${projectId}/databases/(default)/documents`;
const userUsageName = `${root}/userAttachmentUsage/user-a`;
const userProfileName = `${root}/users/user-a`;
const globalUsageName = `${root}/systemUsage/blobAttachmentsV1`;
const noteName = `${root}/notes/note-a`;
const noteCounterName = `${root}/notes/note-a/serverCounters/attachmentsV1`;
const noteAttachmentLimitEnforced = (
  NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION >= NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION
);

function integerValue(value: number): FirestoreValue {
  return { integerValue: String(value) };
}

function stringValue(value: string): FirestoreValue {
  return { stringValue: value };
}

function noteCounterFields(
  reservedCount: number,
  state: "open" | "closed" = "open",
  overrides: Record<string, FirestoreValue> = {}
) {
  return {
    accountingMode: stringValue(state === "open"
      ? "server_recount_per_reservation"
      : "closed_note_tombstone"),
    limitCount: integerValue(100),
    noteId: stringValue("note-a"),
    reservedCount: integerValue(reservedCount),
    schemaVersion: integerValue(NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION),
    state: stringValue(state),
    ...overrides
  };
}

class FakeFirestore {
  readonly commits: string[][] = [];
  readonly documents = new Map<string, FirestoreDocument>();
  readonly reads = new Map<string, number>();
  private readonly forcedCommitConflicts = new Set<string>();
  private readonly forcedCommitDeletions = new Set<string>();
  private readonly forcedCommitReplacements = new Map<string, Record<string, FirestoreValue>>();
  private sequence = 0;

  add(path: string, fields: Record<string, FirestoreValue>) {
    const name = `${root}/${path}`;
    this.documents.set(name, {
      fields: structuredClone(fields),
      name,
      updateTime: this.nextUpdateTime()
    });
  }

  private nextUpdateTime() {
    this.sequence += 1;
    return new Date(Date.UTC(2026, 6, 28, 0, 0, 0, this.sequence)).toISOString();
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status
    });
  }

  forceNextCommitConflict(documentName: string) {
    this.forcedCommitConflicts.add(documentName);
  }

  deleteBeforeNextCommit(documentName: string) {
    this.forcedCommitDeletions.add(documentName);
  }

  replaceBeforeNextCommit(documentName: string, fields: Record<string, FirestoreValue>) {
    this.forcedCommitReplacements.set(documentName, fields);
  }

  async fetch(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const resource = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ""));

    if (resource.endsWith("/documents:commit")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        writes?: Array<{
          currentDocument?: { exists?: boolean; updateTime?: string };
          delete?: string;
          update?: { fields?: Record<string, FirestoreValue>; name?: string };
          verify?: string;
        }>;
      };
      const writes = body.writes ?? [];
      const forcedConflictName = writes
        .map((write) => write.delete ?? write.update?.name ?? write.verify ?? "")
        .find((name) => this.forcedCommitConflicts.has(name));

      if (forcedConflictName) {
        this.forcedCommitConflicts.delete(forcedConflictName);
        const current = this.documents.get(forcedConflictName);
        if (current) {
          current.updateTime = this.nextUpdateTime();
        }
      }
      const forcedDeletionName = writes
        .map((write) => write.delete ?? write.update?.name ?? write.verify ?? "")
        .find((name) => this.forcedCommitDeletions.has(name));

      if (forcedDeletionName) {
        this.forcedCommitDeletions.delete(forcedDeletionName);
        this.documents.delete(forcedDeletionName);
      }
      const forcedReplacementName = writes
        .map((write) => write.delete ?? write.update?.name ?? write.verify ?? "")
        .find((name) => this.forcedCommitReplacements.has(name));

      if (forcedReplacementName) {
        const current = this.documents.get(forcedReplacementName);
        const fields = this.forcedCommitReplacements.get(forcedReplacementName);
        this.forcedCommitReplacements.delete(forcedReplacementName);
        if (current && fields) {
          current.fields = structuredClone(fields);
          current.updateTime = this.nextUpdateTime();
        }
      }

      const valid = writes.every((write) => {
        const name = write.delete ?? write.update?.name ?? write.verify ?? "";
        const current = this.documents.get(name);
        if (write.currentDocument?.exists === false) return !current;
        if (write.currentDocument?.updateTime) {
          return current?.updateTime === write.currentDocument.updateTime;
        }
        return true;
      });
      if (!valid) {
        return this.json({ error: { status: "ABORTED" } }, 409);
      }

      this.commits.push(writes.map((write) => write.delete ?? write.update?.name ?? write.verify ?? ""));

      for (const write of writes) {
        if (write.verify) {
          continue;
        }
        if (write.delete) {
          this.documents.delete(write.delete);
          continue;
        }
        const name = write.update?.name ?? "";
        const existing = this.documents.get(name);
        this.documents.set(name, {
          fields: {
            ...(existing?.fields ?? {}),
            ...(structuredClone(write.update?.fields ?? {}))
          },
          name,
          updateTime: this.nextUpdateTime()
        });
      }
      return this.json({ writeResults: writes.map(() => ({})) });
    }

    const documentsMarker = "/documents/";
    const documentPath = resource.split(documentsMarker)[1] ?? "";
    if (documentPath.split("/").length % 2 === 1) {
      const prefix = `${resource}/`;
      const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
      const documents = Array.from(this.documents.values())
        .filter((document) => {
          if (!document.name.startsWith(prefix)) return false;
          return !document.name.slice(prefix.length).includes("/");
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      const page = documents.slice(0, pageSize);
      return this.json({
        documents: structuredClone(page),
        ...(documents.length > page.length ? { nextPageToken: "more" } : {})
      });
    }

    const document = this.documents.get(resource);
    this.reads.set(resource, (this.reads.get(resource) ?? 0) + 1);
    return document
      ? this.json(structuredClone(document))
      : this.json({ error: { status: "NOT_FOUND" } }, 404);
  }
}

function integerField(document: FirestoreDocument | undefined, field: string) {
  return Number(document?.fields[field]?.integerValue ?? Number.NaN);
}

function stringField(document: FirestoreDocument | undefined, field: string) {
  return document?.fields[field]?.stringValue ?? "";
}

function attachmentReservationWrite(attachmentId: string) {
  return {
    update: {
      name: `${root}/notes/note-a/attachments/${attachmentId}`,
      fields: {
        noteId: stringValue("note-a"),
        uploadedBy: stringValue("user-a"),
        encryptedSize: integerValue(1),
        quotaReserved: { booleanValue: true }
      }
    },
    currentDocument: { exists: false }
  };
}

async function reserveNoteAttachment(attachmentId: string) {
  return reserveUserAttachmentBytes(
    projectId,
    "access-token",
    "user-a",
    1,
    async () => [
      attachmentReservationWrite(attachmentId),
      await reserveNoteAttachmentCountWrite(projectId, "access-token", "note-a")
    ]
  );
}

function seedActiveNoteContext(
  firestore: FakeFirestore,
  noteOverrides: Record<string, FirestoreValue> = {}
) {
  firestore.add("systemUsage/blobAttachmentsV1", {
    schemaVersion: integerValue(1),
    attachmentCount: integerValue(0),
    usedBytes: integerValue(0)
  });
  firestore.add("users/user-a", {
    isActive: { booleanValue: true }
  });
  firestore.add("notes/note-a", {
    ownerUid: stringValue("user-a"),
    participantUids: { arrayValue: { values: [stringValue("user-a")] } },
    ...noteOverrides
  });
  firestore.add("userAttachmentUsage/user-a", {
    uid: stringValue("user-a"),
    attachmentCount: integerValue(0),
    usedBytes: integerValue(0)
  });
}

async function reserveCurrentNoteAttachment(
  attachmentId: string,
  secureShareCopyJobId = ""
) {
  const attachmentWrite = attachmentReservationWrite(attachmentId);
  return reserveUserAttachmentBytes(
    projectId,
    "access-token",
    "user-a",
    1,
    () => noteAttachmentReservationWrites(
      projectId,
      "access-token",
      "user-a",
      {
        noteId: "note-a",
        secureShareCopyJobId
      },
      attachmentWrite
    )
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("global Blob free-tier reservation race", () => {
  it("keeps 20 concurrent reservations below the operational cap", async () => {
    vi.stubEnv("FREE_TIER_MODE", "true");
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        reserveUserAttachmentBytes(projectId, "access-token", "user-a", 100_000_000, [])
      )
    );
    const succeeded = attempts.filter((result) => result.status === "fulfilled").length;
    const globalUsage = firestore.documents.get(globalUsageName);
    const userUsage = firestore.documents.get(userUsageName);

    expect(succeeded).toBeGreaterThan(0);
    expect(integerField(globalUsage, "usedBytes")).toBe(succeeded * 100_000_000);
    expect(integerField(userUsage, "usedBytes")).toBe(integerField(globalUsage, "usedBytes"));
    expect(integerField(globalUsage, "usedBytes")).toBeLessThan(800_000_000);
    expect(integerField(globalUsage, "attachmentCount")).toBe(succeeded);
  });

  it("releases the counter once and never goes negative on duplicate deletion", async () => {
    vi.stubEnv("FREE_TIER_MODE", "true");
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(1),
      usedBytes: integerValue(50_000)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(1),
      usedBytes: integerValue(50_000)
    });
    firestore.add("notes/note-a/attachments/attachment-a", {
      uploadedBy: stringValue("user-a"),
      encryptedSize: integerValue(50_000),
      quotaReserved: { booleanValue: true },
      storageProvider: stringValue("vercel-blob"),
      blobPath: stringValue("users/user-a/notes/note-a/attachments/attachment-a/data")
    });
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(claimAttachmentDeletion(
      projectId,
      "access-token",
      "notes/note-a/attachments/attachment-a"
    )).resolves.toBeTruthy();
    await expect(claimAttachmentDeletion(
      projectId,
      "access-token",
      "notes/note-a/attachments/attachment-a"
    )).resolves.toBeNull();

    const globalUsage = firestore.documents.get(globalUsageName);
    expect(integerField(globalUsage, "usedBytes")).toBe(0);
    expect(integerField(globalUsage, "attachmentCount")).toBe(0);
    expect(integerField(firestore.documents.get(userUsageName), "usedBytes")).toBe(0);
  });

  it("deletes the attachment but preserves an inconsistent global counter for repair", async () => {
    vi.stubEnv("FREE_TIER_MODE", "true");
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(0),
      usedBytes: integerValue(10_000)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(1),
      usedBytes: integerValue(50_000)
    });
    firestore.add("notes/note-a/attachments/attachment-underflow", {
      uploadedBy: stringValue("user-a"),
      encryptedSize: integerValue(50_000),
      quotaReserved: { booleanValue: true },
      storageProvider: stringValue("vercel-blob"),
      blobPath: stringValue("users/user-a/notes/note-a/attachments/attachment-underflow/data")
    });
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(claimAttachmentDeletion(
      projectId,
      "access-token",
      "notes/note-a/attachments/attachment-underflow"
    )).resolves.toBeTruthy();

    expect(firestore.documents.has(`${root}/notes/note-a/attachments/attachment-underflow`)).toBe(false);
    expect(integerField(firestore.documents.get(globalUsageName), "usedBytes")).toBe(10_000);
    expect(integerField(firestore.documents.get(globalUsageName), "attachmentCount")).toBe(0);
    expect(integerField(firestore.documents.get(userUsageName), "usedBytes")).toBe(0);
  });
});

describe("per-note Blob attachment reservation race", () => {
  beforeEach(() => {
    vi.stubEnv("FREE_TIER_MODE", "false");
  });

  it("re-reads the parent note after a CAS conflict and commits its mutex atomically", async () => {
    const firestore = new FakeFirestore();
    seedActiveNoteContext(firestore);
    firestore.forceNextCommitConflict(noteName);
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveCurrentNoteAttachment("candidate-parent-cas")).resolves.toBeUndefined();

    expect(firestore.reads.get(noteName)).toBeGreaterThanOrEqual(2);
    expect(stringField(firestore.documents.get(noteName), "updatedBy")).toBe("user-a");
    expect(firestore.commits).toHaveLength(1);
    expect(firestore.commits[0]).toEqual(expect.arrayContaining([
      userUsageName,
      noteName,
      noteCounterName,
      `${root}/notes/note-a/attachments/candidate-parent-cas`
    ]));
    expect(firestore.commits[0]?.filter((name) => name === noteName)).toHaveLength(1);
  });

  it("combines the parent mutex and secure-copy reservation count in one note write", async () => {
    const firestore = new FakeFirestore();
    seedActiveNoteContext(firestore, {
      secureShareCopyState: stringValue("copying"),
      secureShareCopyJobId: stringValue("copy-job-a"),
      secureShareCopyExpectedAttachmentCount: integerValue(2),
      secureShareCopyReservedAttachmentCount: integerValue(0)
    });
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(
      reserveCurrentNoteAttachment("candidate-secure-copy", "copy-job-a")
    ).resolves.toBeUndefined();

    const note = firestore.documents.get(noteName);
    expect(stringField(note, "updatedBy")).toBe("user-a");
    expect(integerField(note, "secureShareCopyReservedAttachmentCount")).toBe(1);
    expect(firestore.commits[0]?.filter((name) => name === noteName)).toHaveLength(1);
  });

  it.each([
    ["inactive", { isActive: { booleanValue: false } }],
    ["notes feature revoked", {
      isActive: { booleanValue: true },
      featureAccess: {
        mapValue: {
          fields: {
            notes: { booleanValue: false },
            library: { booleanValue: true },
            schedule: { booleanValue: true }
          }
        }
      }
    }]
  ])("rejects a reservation when the profile becomes %s before commit", async (_label, replacement) => {
    const firestore = new FakeFirestore();
    seedActiveNoteContext(firestore);
    firestore.replaceBeforeNextCommit(userProfileName, replacement);
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveCurrentNoteAttachment("candidate-profile-revoked"))
      .rejects.toMatchObject({ statusCode: 403 });

    expect(firestore.commits).toHaveLength(0);
    expect(firestore.documents.has(
      `${root}/notes/note-a/attachments/candidate-profile-revoked`
    )).toBe(false);
    expect(integerField(firestore.documents.get(userUsageName), "attachmentCount")).toBe(0);
  });

  it("does not create an orphan attachment when the parent is deleted before commit", async () => {
    const firestore = new FakeFirestore();
    seedActiveNoteContext(firestore);
    firestore.deleteBeforeNextCommit(noteName);
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveCurrentNoteAttachment("candidate-after-parent-delete")).rejects.toMatchObject({
      statusCode: 403
    });

    expect(firestore.commits).toHaveLength(0);
    expect(integerField(firestore.documents.get(userUsageName), "attachmentCount")).toBe(0);
    expect(firestore.documents.has(noteCounterName)).toBe(false);
    expect(firestore.documents.has(
      `${root}/notes/note-a/attachments/candidate-after-parent-delete`
    )).toBe(false);
  });

  it("serializes two reservations at 99 and enforces the cap after the staged rollout", async () => {
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(99),
      usedBytes: integerValue(99)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(99),
      usedBytes: integerValue(99)
    });
    firestore.add("notes/note-a/serverCounters/attachmentsV1", noteCounterFields(99));
    for (let index = 0; index < 99; index += 1) {
      firestore.add(`notes/note-a/attachments/existing-${index}`, {
        noteId: stringValue("note-a"),
        uploadedBy: stringValue("user-a")
      });
    }
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    const attempts = await Promise.allSettled([
      reserveNoteAttachment("candidate-a"),
      reserveNoteAttachment("candidate-b")
    ]);
    const attachmentNames = Array.from(firestore.documents.keys())
      .filter((name) => name.startsWith(`${root}/notes/note-a/attachments/`));

    expect(attempts.filter((result) => result.status === "fulfilled"))
      .toHaveLength(noteAttachmentLimitEnforced ? 1 : 2);
    expect(attempts.filter((result) => result.status === "rejected"))
      .toHaveLength(noteAttachmentLimitEnforced ? 1 : 0);
    expect(attachmentNames).toHaveLength(noteAttachmentLimitEnforced ? 100 : 101);
    expect(integerField(firestore.documents.get(noteCounterName), "reservedCount")).toBe(100);
    expect(firestore.commits).toContainEqual(expect.arrayContaining([
      userUsageName,
      noteCounterName,
      expect.stringMatching(/\/notes\/note-a\/attachments\/candidate-[ab]$/u)
    ]));
  });

  it("recounts existing metadata when bootstrapping instead of trusting a missing counter", async () => {
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(100),
      usedBytes: integerValue(100)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(100),
      usedBytes: integerValue(100)
    });
    for (let index = 0; index < 100; index += 1) {
      firestore.add(`notes/note-a/attachments/existing-${index}`, {
        noteId: stringValue("note-a"),
        uploadedBy: stringValue("user-a")
      });
    }
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    const result = reserveNoteAttachment("candidate-overflow");
    if (noteAttachmentLimitEnforced) {
      await expect(result).rejects.toMatchObject({ statusCode: 413 });
      expect(firestore.documents.has(noteCounterName)).toBe(false);
      expect(firestore.documents.has(`${root}/notes/note-a/attachments/candidate-overflow`)).toBe(false);
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(integerField(firestore.documents.get(noteCounterName), "reservedCount")).toBe(100);
      expect(firestore.documents.has(`${root}/notes/note-a/attachments/candidate-overflow`)).toBe(true);
    }
  });

  it("ignores an undercounted counter and fails closed from the actual metadata count", async () => {
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(100),
      usedBytes: integerValue(100)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(100),
      usedBytes: integerValue(100)
    });
    firestore.add("notes/note-a/serverCounters/attachmentsV1", noteCounterFields(0, "open", {
      noteId: stringValue("wrong-note")
    }));
    for (let index = 0; index < 100; index += 1) {
      firestore.add(`notes/note-a/attachments/existing-${index}`, {
        noteId: stringValue("note-a"),
        uploadedBy: stringValue("user-a")
      });
    }
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveNoteAttachment("candidate-invalid-counter")).rejects.toMatchObject({
      statusCode: 409
    });
    expect(integerField(firestore.documents.get(noteCounterName), "reservedCount")).toBe(0);
    expect(firestore.documents.has(`${root}/notes/note-a/attachments/candidate-invalid-counter`)).toBe(false);
  });

  it("reconciles a stale upper bound after deletion before allowing a replacement", async () => {
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(99),
      usedBytes: integerValue(99)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(99),
      usedBytes: integerValue(99)
    });
    firestore.add("notes/note-a/serverCounters/attachmentsV1", noteCounterFields(100));
    for (let index = 0; index < 99; index += 1) {
      firestore.add(`notes/note-a/attachments/existing-${index}`, {
        noteId: stringValue("note-a"),
        uploadedBy: stringValue("user-a")
      });
    }
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveNoteAttachment("replacement")).resolves.toBeUndefined();
    expect(integerField(firestore.documents.get(noteCounterName), "reservedCount")).toBe(100);
    expect(firestore.documents.has(`${root}/notes/note-a/attachments/replacement`)).toBe(true);
  });

  it("fails closed without mutating quota when the note counter is closed", async () => {
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
    firestore.add("notes/note-a/serverCounters/attachmentsV1", noteCounterFields(0, "closed"));
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveNoteAttachment("candidate-after-close")).rejects.toMatchObject({
      statusCode: 409
    });
    expect(firestore.commits).toHaveLength(0);
    expect(integerField(firestore.documents.get(userUsageName), "attachmentCount")).toBe(0);
    expect(firestore.documents.has(`${root}/notes/note-a/attachments/candidate-after-close`)).toBe(false);
  });

  it("fails closed without mutating quota when counter metadata is malformed", async () => {
    const firestore = new FakeFirestore();
    firestore.add("systemUsage/blobAttachmentsV1", {
      schemaVersion: integerValue(1),
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
    firestore.add("userAttachmentUsage/user-a", {
      uid: stringValue("user-a"),
      attachmentCount: integerValue(0),
      usedBytes: integerValue(0)
    });
    firestore.add("notes/note-a/serverCounters/attachmentsV1", noteCounterFields(0, "open", {
      limitCount: integerValue(99)
    }));
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await expect(reserveNoteAttachment("candidate-invalid")).rejects.toMatchObject({
      statusCode: 409
    });
    expect(firestore.commits).toHaveLength(0);
    expect(integerField(firestore.documents.get(userUsageName), "attachmentCount")).toBe(0);
    expect(firestore.documents.has(`${root}/notes/note-a/attachments/candidate-invalid`)).toBe(false);
  });
});
