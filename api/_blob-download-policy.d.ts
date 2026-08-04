export interface PrivateBlobMetadata {
  contentType?: unknown;
  pathname?: unknown;
  size?: unknown;
}

export function storedBlobMetadataMatchesAttachment(
  metadata: PrivateBlobMetadata | null | undefined,
  blobPath: string,
  encryptedSize: number
): boolean;

export function streamedBlobMetadataMatchesAttachment(
  metadata: PrivateBlobMetadata | null | undefined,
  blobPath: string,
  encryptedSize: number
): boolean;
