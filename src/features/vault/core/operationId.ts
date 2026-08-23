function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

/**
 * Derives an opaque Firestore document id without placing note text, paths, or
 * other plaintext in maintenance metadata. The purpose domain-separates job
 * and target ids while keeping retries idempotent for one composer operation.
 */
export async function deterministicVaultOperationId(
  prefix: "vi1_" | "vit1_",
  operationId: string,
  purpose: string
) {
  if (!/^[a-zA-Z0-9_-]{8,120}$/u.test(operationId)) {
    throw new Error("Vault 작업 식별자가 올바르지 않습니다.");
  }
  if (!/^[a-z0-9-]{1,80}$/u.test(purpose)) {
    throw new Error("Vault 작업 용도가 올바르지 않습니다.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`quickmemo:${purpose}:${operationId}`)
  );
  return `${prefix}${base64Url(new Uint8Array(digest))}`;
}
