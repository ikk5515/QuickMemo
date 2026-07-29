import { createHash } from "node:crypto";

const secureShareIdentifierPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const sourceAttachmentDigestPattern = /^[A-Za-z0-9_-]{43}$/u;

function sourceCiphertextDigest(value) {
  if (typeof value?.blobEtag !== "string" || value.blobEtag.length < 1 || value.blobEtag.length > 512) {
    return "";
  }

  return createHash("sha256")
    .update(`blob-etag:${value.blobEtag}`, "utf8")
    .digest("base64url");
}

function validSourceAttachmentFingerprint(value) {
  return Boolean(
    value
    && typeof value.sourceAttachmentId === "string"
    && secureShareIdentifierPattern.test(value.sourceAttachmentId)
    && typeof value.sourceAttachmentDigest === "string"
    && sourceAttachmentDigestPattern.test(value.sourceAttachmentDigest)
    && (value.sourceEncryptionVersion === 1 || value.sourceEncryptionVersion === 2)
  );
}

function sourceAttachmentFingerprintMatches(manifest, sourceAttachment) {
  if (!validSourceAttachmentFingerprint(manifest) || !sourceAttachment) {
    return false;
  }

  const sourceAttachmentId =
    typeof sourceAttachment.__id === "string" ? sourceAttachment.__id : "";
  const sourceEncryptionVersion = sourceAttachment.version;
  const digest = sourceCiphertextDigest(sourceAttachment);

  return sourceAttachmentId === manifest.sourceAttachmentId
    && sourceEncryptionVersion === manifest.sourceEncryptionVersion
    && digest.length > 0
    && digest === manifest.sourceAttachmentDigest;
}

function attachmentGenerationIncludes(attachment, generation) {
  const hasGenerationMembership = attachment?.generations !== undefined;
  const validGenerationMembership = !hasGenerationMembership
    || (
      Array.isArray(attachment.generations)
      && attachment.generations.length <= 2
      && new Set(attachment.generations).size === attachment.generations.length
      && attachment.generations.every(
        (candidate) =>
          typeof candidate === "string"
          && secureShareIdentifierPattern.test(candidate)
      )
    );

  if (!validGenerationMembership) {
    return false;
  }

  if (!generation) {
    return !attachment?.generation
      && (!hasGenerationMembership || attachment.generations.length === 0);
  }

  if (attachment?.generation === generation) {
    return true;
  }

  return hasGenerationMembership
    && attachment.generations.includes(generation);
}

function retainedAttachmentGenerations(currentGeneration, nextGeneration) {
  if (
    typeof currentGeneration !== "string"
    || typeof nextGeneration !== "string"
    || !secureShareIdentifierPattern.test(currentGeneration)
    || !secureShareIdentifierPattern.test(nextGeneration)
  ) {
    throw new TypeError("Invalid secure share attachment generation");
  }

  return currentGeneration === nextGeneration
    ? [nextGeneration]
    : [currentGeneration, nextGeneration];
}

export {
  attachmentGenerationIncludes,
  retainedAttachmentGenerations,
  sourceAttachmentFingerprintMatches,
  sourceCiphertextDigest,
  validSourceAttachmentFingerprint
};
