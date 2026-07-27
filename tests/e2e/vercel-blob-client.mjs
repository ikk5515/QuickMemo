/* global Blob, fetch */

const blobUploadPath = "/__e2e__/blob-put";

export async function put(pathname, body, options = {}) {
  if (!(body instanceof Blob) || typeof options.token !== "string" || !options.token) {
    throw new Error("The E2E Blob adapter received an invalid upload.");
  }

  const bytes = await body.arrayBuffer();
  const response = await fetch(blobUploadPath, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/octet-stream",
      "x-e2e-blob-path": encodeURIComponent(pathname)
    },
    body: bytes
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.blob) {
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "The local E2E Blob upload failed."
    );
  }

  options.onUploadProgress?.({
    loaded: bytes.byteLength,
    percentage: 100,
    total: bytes.byteLength
  });
  return result.blob;
}
