import type { NoteAttachmentSnapshot } from "../services/notes";
import type { SecureShareAttachmentReuseManifest } from "../services/secureShares";

const sourceAttachmentDigestPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface SecureShareSourceAttachmentFingerprint {
  attachmentId: string;
  digest: string;
  encryptionVersion: 1 | 2;
}

interface FingerprintedSourceAttachment {
  attachment: NoteAttachmentSnapshot;
  fingerprint: SecureShareSourceAttachmentFingerprint | null;
}

export interface SecureShareAttachmentReuseSelection {
  attachmentsToUpload: FingerprintedSourceAttachment[];
  retainedAttachmentIds: string[];
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function secureShareSourceAttachmentFingerprint(
  attachment: NoteAttachmentSnapshot
): Promise<SecureShareSourceAttachmentFingerprint | null> {
  if (
    typeof attachment.blobEtag !== "string"
    || attachment.blobEtag.length < 1
    || attachment.blobEtag.length > 512
  ) {
    return null;
  }

  let digest = "";

  try {
    digest = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`blob-etag:${attachment.blobEtag}`)
    )));
  } catch {
    // Reuse is only an optimization. A digest failure safely falls back to a
    // fresh encrypted upload instead of blocking share creation or sync.
    return null;
  }

  if (!sourceAttachmentDigestPattern.test(digest)) {
    return null;
  }

  return {
    attachmentId: attachment.id,
    digest,
    encryptionVersion: attachment.version
  };
}

function reusableManifestBySourceId(
  manifests: SecureShareAttachmentReuseManifest[]
) {
  const candidates = new Map<string, SecureShareAttachmentReuseManifest | null>();

  manifests.forEach((manifest) => {
    const sourceAttachmentId = manifest.sourceAttachmentId;

    if (!sourceAttachmentId) {
      return;
    }

    candidates.set(
      sourceAttachmentId,
      candidates.has(sourceAttachmentId) ? null : manifest
    );
  });

  return candidates;
}

export function selectSecureShareAttachmentReuse(
  sources: FingerprintedSourceAttachment[],
  currentManifests: SecureShareAttachmentReuseManifest[],
  expectedCurrentAttachmentCount: number
): SecureShareAttachmentReuseSelection {
  if (currentManifests.length !== expectedCurrentAttachmentCount) {
    return {
      attachmentsToUpload: sources,
      retainedAttachmentIds: []
    };
  }

  const manifestsBySourceId = reusableManifestBySourceId(currentManifests);
  const attachmentsToUpload: FingerprintedSourceAttachment[] = [];
  const retainedAttachmentIds: string[] = [];

  sources.forEach((source) => {
    const fingerprint = source.fingerprint;
    const manifest = fingerprint
      ? manifestsBySourceId.get(fingerprint.attachmentId)
      : null;

    if (
      manifest
      && fingerprint
      && manifest.digest === fingerprint.digest
      && manifest.sourceEncryptionVersion === fingerprint.encryptionVersion
    ) {
      retainedAttachmentIds.push(manifest.id);
      return;
    }

    attachmentsToUpload.push(source);
  });

  return { attachmentsToUpload, retainedAttachmentIds };
}
