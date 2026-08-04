const privateBlobContentType = "application/octet-stream";

function blobIdentityMatches(metadata, blobPath) {
  return Boolean(metadata)
    && metadata.pathname === blobPath
    && metadata.contentType === privateBlobContentType;
}

export function storedBlobMetadataMatchesAttachment(metadata, blobPath, encryptedSize) {
  return blobIdentityMatches(metadata, blobPath)
    && metadata.size === encryptedSize;
}

export function streamedBlobMetadataMatchesAttachment(metadata, blobPath, encryptedSize) {
  // @vercel/blob reports size 0 when the GET response omits Content-Length.
  // Callers must validate the authoritative HEAD metadata before using this fallback.
  return blobIdentityMatches(metadata, blobPath)
    && (metadata.size === 0 || metadata.size === encryptedSize);
}
