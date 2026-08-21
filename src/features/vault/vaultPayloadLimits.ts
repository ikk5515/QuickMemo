import type { VaultContentFormat, VaultEntryKind } from "../../types";

export const MAX_VAULT_BODY_CHARACTERS = 500_000;
export const MAX_VAULT_BODY_UTF8_BYTES = 500_000;
export const MAX_VAULT_HISTORY_SNAPSHOT_UTF8_BYTES = 520_000;

const utf8Encoder = new TextEncoder();

export interface VaultPayloadSizeInput {
  body: string;
  contentFormat: VaultContentFormat;
  entryKind: VaultEntryKind;
  folderId: string | null;
  title: string;
}

export function encryptedHistorySnapshotSource(input: VaultPayloadSizeInput) {
  return JSON.stringify({
    title: input.title,
    body: input.body,
    fontSize: 16,
    folderId: input.folderId,
    contentFormat: input.contentFormat,
    entryKind: input.entryKind
  });
}

/**
 * Applies the exact plaintext limits used immediately before encryption.
 * Keeping this function free of Firebase and crypto imports lets ZIP planning
 * validate every entry before the first remote write starts.
 */
export function assertVaultPayloadFitsPersistence(input: VaultPayloadSizeInput) {
  if (
    input.body.length > MAX_VAULT_BODY_CHARACTERS
    || utf8Encoder.encode(input.body).byteLength > MAX_VAULT_BODY_UTF8_BYTES
  ) {
    throw new Error("Markdown 본문은 UTF-8 기준 500KB 이하로 저장할 수 있습니다.");
  }
  if (
    utf8Encoder.encode(encryptedHistorySnapshotSource(input)).byteLength
    > MAX_VAULT_HISTORY_SNAPSHOT_UTF8_BYTES
  ) {
    throw new Error("노트 이력 스냅샷이 저장 가능한 크기를 초과했습니다.");
  }
}
