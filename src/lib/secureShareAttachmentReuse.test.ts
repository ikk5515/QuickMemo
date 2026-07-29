import { describe, expect, it, vi } from "vitest";
import {
  attachmentGenerationIncludes,
  retainedAttachmentGenerations,
  sourceAttachmentFingerprintMatches,
  sourceCiphertextDigest
} from "../../api/_secure-share-attachment-reuse.js";
import type { NoteAttachmentSnapshot } from "../services/notes";
import type { SecureShareAttachmentReuseManifest } from "../services/secureShares";
import {
  secureShareSourceAttachmentFingerprint,
  selectSecureShareAttachmentReuse
} from "./secureShareAttachmentReuse";

function sourceAttachment(
  id: string,
  blobEtag: string,
  version: 1 | 2 = 2
) {
  return {
    id,
    noteId: "note_secure_share_123456",
    version,
    algorithm: version === 1 ? "AES-GCM" : "AES-GCM-CHUNKED",
    fileName: `${id}.pdf`,
    extension: "pdf",
    mimeType: "application/pdf",
    originalSize: 1024,
    blobEtag,
    uploadedBy: "owner_123456"
  } as NoteAttachmentSnapshot;
}

function shareManifest(
  id: string,
  source: NoteAttachmentSnapshot,
  digest = sourceCiphertextDigest(source)
) {
  return {
    id,
    sourceAttachmentId: source.id,
    digest,
    sourceEncryptionVersion: source.version
  } satisfies SecureShareAttachmentReuseManifest;
}

describe("Secure Share attachment ciphertext reuse", () => {
  it("uses the same client/server digest and retains only an unchanged attachment", async () => {
    const unchanged = sourceAttachment("attachment_source_a123", "etag-a");
    const changed = sourceAttachment("attachment_source_b123", "etag-b-next");
    const fingerprints = await Promise.all([unchanged, changed].map(async (attachment) => ({
      attachment,
      fingerprint: await secureShareSourceAttachmentFingerprint(attachment)
    })));
    const unchangedFingerprint = fingerprints[0].fingerprint;

    expect(unchangedFingerprint?.digest).toBe(sourceCiphertextDigest(unchanged));

    const selection = selectSecureShareAttachmentReuse(
      fingerprints,
      [
        shareManifest("attachment_public_a123", unchanged),
        shareManifest(
          "attachment_public_b123",
          changed,
          sourceCiphertextDigest({ ...changed, blobEtag: "etag-b-before" })
        )
      ],
      2
    );

    expect(selection.retainedAttachmentIds).toEqual(["attachment_public_a123"]);
    expect(selection.attachmentsToUpload.map(({ attachment }) => attachment.id))
      .toEqual(["attachment_source_b123"]);
  });

  it("fails safe on an encryption-version mismatch or incomplete current manifest", async () => {
    const source = sourceAttachment("attachment_source_a123", "etag-a", 2);
    const fingerprinted = [{
      attachment: source,
      fingerprint: await secureShareSourceAttachmentFingerprint(source)
    }];
    const versionMismatch = shareManifest("attachment_public_a123", source);
    versionMismatch.sourceEncryptionVersion = 1;

    expect(selectSecureShareAttachmentReuse(
      fingerprinted,
      [versionMismatch],
      1
    )).toEqual({
      attachmentsToUpload: fingerprinted,
      retainedAttachmentIds: []
    });
    expect(selectSecureShareAttachmentReuse(
      fingerprinted,
      [],
      1
    )).toEqual({
      attachmentsToUpload: fingerprinted,
      retainedAttachmentIds: []
    });
    expect(sourceAttachmentFingerprintMatches(versionMismatch, {
      __id: source.id,
      blobEtag: source.blobEtag,
      version: source.version
    })).toBe(false);
    expect(sourceAttachmentFingerprintMatches(
      shareManifest("attachment_public_a123", source),
      {
        __id: source.id,
        blobEtag: "etag-changed-after-client-selection",
        version: source.version
      }
    )).toBe(false);
  });

  it("falls back to a fresh upload when the local digest cannot be calculated", async () => {
    const digestSpy = vi.spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("digest unavailable"));

    await expect(secureShareSourceAttachmentFingerprint(
      sourceAttachment("attachment_source_a123", "etag-a")
    )).resolves.toBeNull();
    digestSpy.mockRestore();
  });

  it("keeps at most the previous and next generation during an atomic transition", () => {
    const firstTransition = retainedAttachmentGenerations(
      "generation_current_123456",
      "generation_next_123456"
    );

    expect(firstTransition).toEqual([
      "generation_current_123456",
      "generation_next_123456"
    ]);
    expect(attachmentGenerationIncludes(
      { generation: "generation_original_123456", generations: firstTransition },
      "generation_current_123456"
    )).toBe(true);
    expect(attachmentGenerationIncludes(
      { generation: "generation_original_123456", generations: firstTransition },
      "generation_next_123456"
    )).toBe(true);

    const secondTransition = retainedAttachmentGenerations(
      "generation_next_123456",
      "generation_later_123456"
    );

    expect(secondTransition).toHaveLength(2);
    expect(attachmentGenerationIncludes(
      { generation: "generation_original_123456", generations: secondTransition },
      "generation_current_123456"
    )).toBe(false);
    expect(attachmentGenerationIncludes(
      {
        generation: "generation_original_123456",
        generations: [
          "generation_current_123456",
          "generation_next_123456",
          "generation_later_123456"
        ]
      },
      "generation_next_123456"
    )).toBe(false);
  });
});
