import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAttachmentDeletion,
  reserveUserAttachmentBytes
} from "../../api/blob-attachments.js";

type FirestoreValue = {
  booleanValue?: boolean;
  integerValue?: string;
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
const globalUsageName = `${root}/systemUsage/blobAttachmentsV1`;

function integerValue(value: number): FirestoreValue {
  return { integerValue: String(value) };
}

function stringValue(value: string): FirestoreValue {
  return { stringValue: value };
}

class FakeFirestore {
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
    return new Date(Date.UTC(2026, 6, 28, 0, 0, 0, this.sequence)).toISOString();
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status
    });
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
        }>;
      };
      const writes = body.writes ?? [];
      const valid = writes.every((write) => {
        const name = write.delete ?? write.update?.name ?? "";
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

      for (const write of writes) {
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

    const document = this.documents.get(resource);
    return document
      ? this.json(structuredClone(document))
      : this.json({ error: { status: "NOT_FOUND" } }, 404);
  }
}

function integerField(document: FirestoreDocument | undefined, field: string) {
  return Number(document?.fields[field]?.integerValue ?? Number.NaN);
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
