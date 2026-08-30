import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const headMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  get: vi.fn(),
  head: headMock
}));
vi.mock("@vercel/blob/client", () => ({ handleUpload: vi.fn() }));

import { __blobAttachmentTesting } from "../../api/blob-attachments.js";

type FirestoreValue = {
  arrayValue?: { values?: FirestoreValue[] };
  booleanValue?: boolean;
  integerValue?: string;
  stringValue?: string;
};

type FirestoreDocument = {
  fields: Record<string, FirestoreValue>;
  name: string;
  updateTime: string;
};

type FirestoreWrite = {
  currentDocument?: { updateTime?: string };
  update?: {
    fields?: Record<string, FirestoreValue>;
    name?: string;
  };
  updateMask?: { fieldPaths?: string[] };
  verify?: string;
};

const projectId = "ready-attachment-count-test";
const root = `projects/${projectId}/databases/(default)/documents`;
const attachmentPath = "notes/note-a/attachments/attachment-a";
const attachmentName = `${root}/${attachmentPath}`;
const notePath = "notes/note-a";
const noteName = `${root}/${notePath}`;
const blobPath = "users/user-a/notes/note-a/attachments/attachment-a/data";

function integerValue(value: number): FirestoreValue {
  return { integerValue: String(value) };
}

function stringValue(value: string): FirestoreValue {
  return { stringValue: value };
}

class FakeFirestore {
  readonly commitBodies: Array<{ writes: FirestoreWrite[] }> = [];
  readonly documents = new Map<string, FirestoreDocument>();
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
    return new Date(Date.UTC(2026, 7, 31, 0, 0, 0, this.sequence)).toISOString();
  }

  private response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status
    });
  }

  async fetch(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const resource = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ""));

    if (resource.endsWith("/documents:commit")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { writes?: FirestoreWrite[] };
      const writes = body.writes ?? [];
      const preconditionsHold = writes.every((write) => {
        const name = write.update?.name ?? write.verify ?? "";
        const expectedUpdateTime = write.currentDocument?.updateTime;
        return !expectedUpdateTime || this.documents.get(name)?.updateTime === expectedUpdateTime;
      });

      if (!preconditionsHold) {
        return this.response({ error: { status: "ABORTED" } }, 409);
      }

      this.commitBodies.push({ writes: structuredClone(writes) });
      for (const write of writes) {
        const name = write.update?.name;
        if (!name) continue;
        const current = this.documents.get(name);
        if (!current) continue;
        const fields = structuredClone(current.fields);
        for (const fieldPath of write.updateMask?.fieldPaths ?? []) {
          if (!Object.prototype.hasOwnProperty.call(write.update?.fields ?? {}, fieldPath)) {
            delete fields[fieldPath];
          }
        }
        Object.assign(fields, structuredClone(write.update?.fields ?? {}));
        this.documents.set(name, {
          fields,
          name,
          updateTime: this.nextUpdateTime()
        });
      }
      return this.response({ writeResults: writes.map(() => ({})) });
    }

    const document = this.documents.get(resource);
    return document
      ? this.response(structuredClone(document))
      : this.response({ error: { status: "NOT_FOUND" } }, 404);
  }
}

function seedPendingAttachment(firestore: FakeFirestore) {
  firestore.add("users/user-a", {
    isActive: { booleanValue: true }
  });
  firestore.add(notePath, {
    attachmentRevision: integerValue(0),
    isDeleted: { booleanValue: false },
    ownerUid: stringValue("user-a"),
    participantUids: { arrayValue: { values: [stringValue("user-a")] } },
    readyAttachmentCount: integerValue(0)
  });
  firestore.add(attachmentPath, {
    isReady: { booleanValue: false },
    pendingReservationTracked: { booleanValue: false }
  });
}

function readyCount(firestore: FakeFirestore) {
  return Number(firestore.documents.get(noteName)?.fields.readyAttachmentCount?.integerValue);
}

function noteCounterWrites(firestore: FakeFirestore) {
  return firestore.commitBodies.flatMap(({ writes }) => writes).filter(
    (write) => write.update?.name === noteName
      && Object.prototype.hasOwnProperty.call(write.update.fields ?? {}, "readyAttachmentCount")
  );
}

const tokenPayload = {
  attachmentPath,
  blobPath,
  encryptedSize: 16,
  noteId: "note-a",
  scope: "note" as const,
  uid: "user-a"
};

describe("real Blob attachment ready-count transactions", () => {
  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    headMock.mockReset();
    headMock.mockResolvedValue({
      contentType: "application/octet-stream",
      etag: "etag-a",
      pathname: blobPath,
      size: 16
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("increments once when callback and PATCH finalization race", async () => {
    const firestore = new FakeFirestore();
    seedPendingAttachment(firestore);
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await Promise.all([
      __blobAttachmentTesting.markAttachmentReady(
        projectId,
        "access-token",
        tokenPayload,
        { pathname: blobPath }
      ),
      __blobAttachmentTesting.markAttachmentReady(
        projectId,
        "access-token",
        tokenPayload,
        { pathname: blobPath }
      )
    ]);

    expect(readyCount(firestore)).toBe(1);
    expect(noteCounterWrites(firestore)).toHaveLength(1);
    expect(noteCounterWrites(firestore)[0]).toMatchObject({
      currentDocument: { updateTime: expect.any(String) },
      update: {
        fields: { readyAttachmentCount: { integerValue: "1" } },
        name: noteName
      },
      updateMask: { fieldPaths: expect.arrayContaining(["readyAttachmentCount"]) }
    });
    expect(headMock).toHaveBeenCalledTimes(2);
  });

  it("decrements once across concurrent and replayed ready deletions", async () => {
    const firestore = new FakeFirestore();
    seedPendingAttachment(firestore);
    const note = firestore.documents.get(noteName);
    const attachment = firestore.documents.get(attachmentName);
    if (!note || !attachment) throw new Error("attachment fixtures are missing");
    note.fields.readyAttachmentCount = integerValue(1);
    attachment.fields.isReady = { booleanValue: true };
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    const authorizeCurrent = async () => ({ allowed: true, verifyDocuments: [] });
    await Promise.all([
      __blobAttachmentTesting.beginAttachmentDeletion(
        projectId,
        "access-token",
        attachmentPath,
        notePath,
        "user-a",
        authorizeCurrent
      ),
      __blobAttachmentTesting.beginAttachmentDeletion(
        projectId,
        "access-token",
        attachmentPath,
        notePath,
        "user-a",
        authorizeCurrent
      )
    ]);
    await __blobAttachmentTesting.beginAttachmentDeletion(
      projectId,
      "access-token",
      attachmentPath,
      notePath,
      "user-a",
      authorizeCurrent
    );

    expect(readyCount(firestore)).toBe(0);
    expect(noteCounterWrites(firestore)).toHaveLength(1);
    expect(noteCounterWrites(firestore)[0]).toMatchObject({
      currentDocument: { updateTime: expect.any(String) },
      update: {
        fields: { readyAttachmentCount: { integerValue: "0" } },
        name: noteName
      },
      updateMask: { fieldPaths: expect.arrayContaining(["readyAttachmentCount"]) }
    });
  });

  it("keeps legacy notes on the unknown path across finalize and delete", async () => {
    const firestore = new FakeFirestore();
    seedPendingAttachment(firestore);
    const note = firestore.documents.get(noteName);
    if (!note) throw new Error("note fixture is missing");
    delete note.fields.readyAttachmentCount;
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));

    await __blobAttachmentTesting.markAttachmentReady(
      projectId,
      "access-token",
      tokenPayload,
      { pathname: blobPath }
    );
    await __blobAttachmentTesting.beginAttachmentDeletion(
      projectId,
      "access-token",
      attachmentPath,
      notePath,
      "user-a",
      async () => ({ allowed: true, verifyDocuments: [] })
    );

    expect(firestore.documents.get(noteName)?.fields).not.toHaveProperty("readyAttachmentCount");
    expect(noteCounterWrites(firestore)).toHaveLength(0);
  });

  it("fails closed without a commit on counter overflow or underflow", async () => {
    const overflowFirestore = new FakeFirestore();
    seedPendingAttachment(overflowFirestore);
    const overflowNote = overflowFirestore.documents.get(noteName);
    if (!overflowNote) throw new Error("overflow note fixture is missing");
    overflowNote.fields.readyAttachmentCount = integerValue(100);
    vi.stubGlobal("fetch", vi.fn((input, init) => overflowFirestore.fetch(input, init)));

    await expect(__blobAttachmentTesting.markAttachmentReady(
      projectId,
      "access-token",
      tokenPayload,
      { pathname: blobPath }
    )).rejects.toThrow("Ready attachment count cannot be incremented");
    expect(overflowFirestore.commitBodies).toHaveLength(0);

    const underflowFirestore = new FakeFirestore();
    seedPendingAttachment(underflowFirestore);
    const underflowAttachment = underflowFirestore.documents.get(attachmentName);
    if (!underflowAttachment) throw new Error("underflow attachment fixture is missing");
    underflowAttachment.fields.isReady = { booleanValue: true };
    vi.stubGlobal("fetch", vi.fn((input, init) => underflowFirestore.fetch(input, init)));

    await expect(__blobAttachmentTesting.beginAttachmentDeletion(
      projectId,
      "access-token",
      attachmentPath,
      notePath,
      "user-a",
      async () => ({ allowed: true, verifyDocuments: [] })
    )).rejects.toThrow("Ready attachment count cannot be decremented");
    expect(underflowFirestore.commitBodies).toHaveLength(0);
  });

  it("keeps the count consistent when finalization and deletion race", async () => {
    const firestore = new FakeFirestore();
    seedPendingAttachment(firestore);
    vi.stubGlobal("fetch", vi.fn((input, init) => firestore.fetch(input, init)));
    const authorizeCurrent = async () => ({ allowed: true, verifyDocuments: [] });

    const outcomes = await Promise.allSettled([
      __blobAttachmentTesting.markAttachmentReady(
        projectId,
        "access-token",
        tokenPayload,
        { pathname: blobPath }
      ),
      __blobAttachmentTesting.beginAttachmentDeletion(
        projectId,
        "access-token",
        attachmentPath,
        notePath,
        "user-a",
        authorizeCurrent
      )
    ]);

    expect(outcomes[1].status).toBe("fulfilled");
    expect(readyCount(firestore)).toBe(0);
    expect(firestore.documents.get(attachmentName)?.fields.deletionStarted?.booleanValue).toBe(true);
    const counterValues = noteCounterWrites(firestore).map(
      (write) => write.update?.fields?.readyAttachmentCount?.integerValue
    );
    expect([[], ["1", "0"]]).toContainEqual(counterValues);
  });
});
