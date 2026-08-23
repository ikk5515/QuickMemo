import { HttpError } from "./_secure-share-common.js";

export const VAULT_CUTOVER_VERSION = 1;
export const VAULT_INTEGRITY_STATES = Object.freeze({
  pending: "pending",
  ready: "ready"
});

const baseMarkerKeys = Object.freeze([
  "createdAt",
  "indexVersion",
  "ownerUid",
  "updatedAt",
  "wrappedKey"
]);
const pendingMarkerKeys = Object.freeze([
  ...baseMarkerKeys,
  "cutoverState",
  "cutoverVersion"
].sort());
const readyMarkerKeys = Object.freeze([
  ...pendingMarkerKeys,
  "verifiedAt"
].sort());

function storedKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).filter((key) => !key.startsWith("__")).sort()
    : [];
}

function exactKeys(value, expected) {
  return storedKeys(value).join("\u0000") === [...expected].sort().join("\u0000");
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validWrappedKey(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === ["algorithm", "version", "wrappedKey"].join("\u0000")
    && value.version === 1
    && value.algorithm === "RSA-OAEP"
    && typeof value.wrappedKey === "string"
    && value.wrappedKey.length >= 8
    && value.wrappedKey.length <= 4_096
  );
}

export function integrityPath(uid) {
  return `vaultIntegrity/${uid}`;
}

export function claimPath(uid, claimId) {
  return `vaultIntegrity/${uid}/nameClaims/${claimId}`;
}

/**
 * Strictly parses the three marker shapes accepted during the rolling cutover.
 * The five-field legacy marker is intentionally interpreted as pending; it is
 * never sufficient to enable the reconnect fast path.
 */
export function parseVaultIntegrityMarker(marker, uid) {
  if (
    !marker
    || typeof uid !== "string"
    || marker.ownerUid !== uid
    || marker.indexVersion !== 1
    || !validWrappedKey(marker.wrappedKey)
    || !validTimestamp(marker.createdAt)
    || !validTimestamp(marker.updatedAt)
  ) {
    throw new HttpError(
      409,
      "vault_integrity_invalid",
      "Stored Vault integrity marker is invalid",
      { expose: false }
    );
  }

  if (exactKeys(marker, baseMarkerKeys)) {
    return { document: marker, legacy: true, state: VAULT_INTEGRITY_STATES.pending };
  }
  if (
    exactKeys(marker, pendingMarkerKeys)
    && marker.cutoverState === VAULT_INTEGRITY_STATES.pending
    && marker.cutoverVersion === VAULT_CUTOVER_VERSION
  ) {
    return { document: marker, legacy: false, state: VAULT_INTEGRITY_STATES.pending };
  }
  if (
    exactKeys(marker, readyMarkerKeys)
    && marker.cutoverState === VAULT_INTEGRITY_STATES.ready
    && marker.cutoverVersion === VAULT_CUTOVER_VERSION
    && validTimestamp(marker.verifiedAt)
  ) {
    return { document: marker, legacy: false, state: VAULT_INTEGRITY_STATES.ready };
  }
  throw new HttpError(
    409,
    "vault_integrity_invalid",
    "Stored Vault integrity attestation is invalid",
    { expose: false }
  );
}

export function requireVaultIntegrityMarker(marker, uid, requirement = "any") {
  if (!["any", "pending", "ready"].includes(requirement)) {
    throw new TypeError("Invalid Vault integrity marker requirement");
  }
  if (!marker) {
    throw new HttpError(
      409,
      "vault_integrity_not_ready",
      "Vault integrity setup must be completed before this operation"
    );
  }
  const parsed = parseVaultIntegrityMarker(marker, uid);
  if (requirement === "ready" && parsed.state !== VAULT_INTEGRITY_STATES.ready) {
    throw new HttpError(
      409,
      "vault_integrity_not_ready",
      "Vault cutover attestation must be ready before this operation"
    );
  }
  if (requirement === "pending" && parsed.state !== VAULT_INTEGRITY_STATES.pending) {
    throw new HttpError(
      409,
      "vault_cutover_complete",
      "Vault cutover migration is already complete"
    );
  }
  return parsed;
}

export function vaultIntegrityReadyFields(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("A valid Vault verification timestamp is required");
  }
  return {
    cutoverState: VAULT_INTEGRITY_STATES.ready,
    cutoverVersion: VAULT_CUTOVER_VERSION,
    updatedAt: now,
    verifiedAt: now
  };
}
