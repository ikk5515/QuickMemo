/* global console */

const safeVaultErrorCodes = new Set([
  "revision_conflict",
  "secure_copy_abort_denied",
  "secure_copy_not_ready",
  "vault_claim_invalid",
  "vault_cutover_changed",
  "vault_cutover_complete",
  "vault_cutover_incomplete",
  "vault_depth_exceeded",
  "vault_folder_conflict",
  "vault_folder_invalid",
  "vault_folder_revision_exhausted",
  "vault_folder_state_conflict",
  "vault_folder_unavailable",
  "vault_folder_unchanged",
  "vault_import_invalid",
  "vault_import_locked",
  "vault_integrity_invalid",
  "vault_integrity_not_ready",
  "vault_integrity_stale",
  "vault_name_claim_required",
  "vault_name_conflict",
  "vault_note_conflict",
  "vault_note_invalid",
  "vault_note_revision_exhausted",
  "vault_note_state_mismatch",
  "vault_parent_unavailable",
  "vault_tree_capacity",
  "vault_tree_invalid",
  "vault_tree_stale"
]);

/** Logs only a fixed rejection taxonomy. Never pass request bodies or ids. */
export function logVaultApiRejection({ action, error, requestId, route, supportedActions }) {
  const statusCode = error && typeof error === "object" && Number.isInteger(error.statusCode)
    ? error.statusCode
    : 500;
  if (statusCode !== 409) return;
  const candidateCode = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "";
  const safeAction = typeof action === "string" && supportedActions.has(action) ? action : "unknown";
  const errorCode = safeVaultErrorCodes.has(candidateCode) ? candidateCode : "request_failed";
  console.warn(JSON.stringify({
    action: safeAction,
    errorCode,
    event: "vault_request_rejected",
    requestId,
    route,
    statusCode
  }));
}
