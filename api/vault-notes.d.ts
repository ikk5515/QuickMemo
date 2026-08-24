export interface EncryptedPayloadInput {
  algorithm: "AES-GCM";
  cipherText: string;
  iv: string;
  version: 1;
}

export interface WrappedKeyInput {
  algorithm: "RSA-OAEP";
  version: 1;
  wrappedKey: string;
}

export interface VaultNameClaimInput {
  claimId: string;
  indexVersion: 1;
  parentId: string | null;
}

export interface VaultNoteMutationResult {
  lastMutationId: string;
  noteId: string;
  revision: number;
}

export interface VaultNotePurgeResult {
  noteId: string;
  revision: number;
}

export interface VaultSecureCopyActivationResult extends VaultNotePurgeResult {
  state: "active";
}

export interface VaultLegacyMigrationResult extends VaultNoteMutationResult {
  claimState: "deferred" | "deleted" | "reserved";
}

export type VaultNoteApiAction =
  | "access"
  | "backfill-claim"
  | "create"
  | "import-create"
  | "migrate-legacy"
  | "move"
  | "purge"
  | "resolve-collision"
  | "restore"
  | "secure-copy-abort"
  | "secure-copy-activate"
  | "secure-copy-create"
  | "trash"
  | "update";

export const __vaultNoteTesting: {
  assertClientCreateNoteId(value: unknown): string;
  assertEncryptedPayload(
    value: unknown,
    fieldName: string,
    maximumCipherTextLength: number
  ): EncryptedPayloadInput;
  assertNameClaim(value: unknown, expectedParentId: string | null): VaultNameClaimInput;
  assertParticipants(value: unknown, uid: string, type: "personal" | "shared"): string[];
  assertStorageIdentity(contentFormat: string, entryKind: string): {
    contentFormat: string;
    entryKind: string;
  };
  assertWrappedKeys(value: unknown, participants: string[]): Record<string, WrappedKeyInput>;
  performAction(
    context: { accessToken: string; projectId: string },
    uid: string,
    body: Record<string, unknown>
  ): Promise<
    VaultLegacyMigrationResult
    | VaultNoteMutationResult
    | VaultNotePurgeResult
    | VaultSecureCopyActivationResult
  >;
};

export default function handler(request: unknown, response: unknown): Promise<void>;
