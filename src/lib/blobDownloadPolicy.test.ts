import { describe, expect, it } from "vitest";
import {
  storedBlobMetadataMatchesAttachment,
  streamedBlobMetadataMatchesAttachment
} from "../../api/_blob-download-policy.js";

const blobPath = "users/owner/notes/note/attachments/attachment/data";
const encryptedSize = 4_112;
const exactMetadata = {
  contentType: "application/octet-stream",
  pathname: blobPath,
  size: encryptedSize
};

describe("private Blob download metadata policy", () => {
  it("requires authoritative stored metadata to match path, type, and encrypted size", () => {
    expect(storedBlobMetadataMatchesAttachment(exactMetadata, blobPath, encryptedSize)).toBe(true);
    expect(storedBlobMetadataMatchesAttachment({ ...exactMetadata, pathname: `${blobPath}-other` }, blobPath, encryptedSize)).toBe(false);
    expect(storedBlobMetadataMatchesAttachment({ ...exactMetadata, contentType: "text/plain" }, blobPath, encryptedSize)).toBe(false);
    expect(storedBlobMetadataMatchesAttachment({ ...exactMetadata, size: encryptedSize - 1 }, blobPath, encryptedSize)).toBe(false);
    expect(storedBlobMetadataMatchesAttachment(null, blobPath, encryptedSize)).toBe(false);
  });

  it("accepts the SDK zero-size sentinel only after the separate stored metadata check", () => {
    expect(streamedBlobMetadataMatchesAttachment(exactMetadata, blobPath, encryptedSize)).toBe(true);
    expect(streamedBlobMetadataMatchesAttachment({ ...exactMetadata, size: 0 }, blobPath, encryptedSize)).toBe(true);
    expect(streamedBlobMetadataMatchesAttachment({ ...exactMetadata, size: encryptedSize - 1 }, blobPath, encryptedSize)).toBe(false);
    expect(streamedBlobMetadataMatchesAttachment({ ...exactMetadata, size: undefined }, blobPath, encryptedSize)).toBe(false);
  });

  it("still rejects stream identity or content-type mismatches when size is unavailable", () => {
    expect(streamedBlobMetadataMatchesAttachment({ ...exactMetadata, pathname: `${blobPath}-other`, size: 0 }, blobPath, encryptedSize)).toBe(false);
    expect(streamedBlobMetadataMatchesAttachment({ ...exactMetadata, contentType: "text/html", size: 0 }, blobPath, encryptedSize)).toBe(false);
  });
});
