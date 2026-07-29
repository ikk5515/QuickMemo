export interface SecureShareAttachmentSourceRecord {
  __id?: string;
  blobEtag?: string;
  version?: number;
}

export interface SecureShareAttachmentFingerprint {
  sourceAttachmentId?: string;
  sourceAttachmentDigest?: string;
  sourceEncryptionVersion?: number;
}

export function sourceCiphertextDigest(
  value: SecureShareAttachmentSourceRecord | null | undefined
): string;

export function validSourceAttachmentFingerprint(
  value: SecureShareAttachmentFingerprint | null | undefined
): boolean;

export function sourceAttachmentFingerprintMatches(
  manifest: SecureShareAttachmentFingerprint | null | undefined,
  sourceAttachment: SecureShareAttachmentSourceRecord | null | undefined
): boolean;

export function attachmentGenerationIncludes(
  attachment: { generation?: string; generations?: string[] } | null | undefined,
  generation: string
): boolean;

export function retainedAttachmentGenerations(
  currentGeneration: string,
  nextGeneration: string
): string[];
