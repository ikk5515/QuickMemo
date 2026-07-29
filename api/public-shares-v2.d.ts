export interface SecureSharePasswordHashRecord {
  algorithm: "scrypt";
  digest: string;
  hashVersion: 1;
  parameters: {
    N: number;
    keyLength: number;
    p: number;
    r: number;
  };
  pepperVersion: string;
  salt: string;
}

export class HttpError extends Error {
  code: string;
  deliveryAmbiguous: boolean;
  expose: boolean;
  retryAfter?: number;
  statusCode: number;
  upstreamStatus?: number;
  constructor(
    statusCode: number,
    code: string,
    internalMessage?: string,
    options?: {
      deliveryAmbiguous?: boolean;
      expose?: boolean;
      retryAfter?: number;
      upstreamStatus?: number;
    }
  );
}

export const secureShareScryptParameters: Readonly<{
  N: 131072;
  keyLength: 32;
  maxmem: number;
  p: 2;
  r: 8;
}>;

export function normalizeEmail(value: string): string;
export function normalizeAllowedEmails(values: string[]): string[];
export function assertOnlyKeys(value: unknown, allowedKeys: string[]): void;
export function assertEmailPolicyAvailable(policy: {
  accessMode?: string;
  emailVerificationRequired?: boolean;
} | null): void;
export function buildPolicySettings(
  body: Record<string, unknown>,
  existingPolicy?: Record<string, unknown> | null
): Promise<Record<string, unknown>>;
export function emailDigest(normalizedEmail: string, secret?: string): string;
export function otpCodeDigest(
  challengeId: string,
  shareId: string,
  emailHash: string,
  code: string,
  secret?: string
): string;
export function sessionTokenDigest(token: string, secret?: string): string;
export function unlockAttemptDigest(
  shareId: string,
  unlockAttemptId: string,
  identityHash: string,
  secret?: string
): string;
export function hashSharePassword(
  password: string,
  pepper?: string,
  pepperVersion?: string
): Promise<SecureSharePasswordHashRecord>;
export function verifySharePassword(
  password: string,
  record: SecureSharePasswordHashRecord,
  pepper?: string,
  pepperVersion?: string
): Promise<boolean>;

export function consumeRateLimits(
  context: { accessToken: string; projectId: string },
  definitions: Array<{
    keyParts: string[];
    limit: number;
    limitType: string;
    ownerUid?: string;
    shareId: string;
    windowSeconds: number;
  }>
): Promise<string[]>;

export const auditRetentionDays: number;

export function safeDisplayName(
  value: unknown,
  fallback?: string,
  allowReserved?: boolean
): string;

export function safeParticipantDisplayName(value: unknown): {
  displayName: string;
  normalizedDisplayName: string;
};
export function safeIpPrefixSnapshot(value: unknown): string | null;

export function participantIdentityHash(
  shareId: string,
  identityType: string,
  identityValue: string
): string;

export function participantNameRegistryId(
  shareId: string,
  normalizedDisplayName: string
): string;

export function emailChallengeMinimumResponseMilliseconds(
  random?: (minimum: number, maximum: number) => number
): number;
export function padEmailChallengeResponse(
  timingStartedAt: number,
  minimumResponseMilliseconds: number,
  now?: () => number,
  wait?: (milliseconds: number) => Promise<unknown>
): Promise<number>;
export function otpVerificationFailureMinimumResponseMilliseconds(
  random?: (minimum: number, maximum: number) => number
): number;
export function padOtpVerificationFailureResponse(
  timingStartedAt: number,
  minimumResponseMilliseconds: number,
  now?: () => number,
  wait?: (milliseconds: number) => Promise<unknown>
): Promise<number>;

export function evaluateCopyAttachmentQuota(input: {
  additionalBytes: number;
  additionalCount: number;
  usedBytes: number;
  usedCount: number;
}):
  | { allowed: false; reason: "bytes_exceeded" | "count_exceeded" | "invalid_usage" }
  | {
      allowed: true;
      reason: "ok";
      remainingBytes: number;
      remainingCount: number;
    };

export function copyGrantAuthorizesDownload(
  grant: Record<string, unknown> | null,
  context: {
    ownerPreview: boolean;
    permissionLevel: string;
    policyVersion: number;
    sessionReferenceHash: string;
    shareId: string;
    uid: string;
  }
): boolean;

export function copyGrantRequestId(
  shareId: string,
  requesterUid: string,
  idempotencyKey: string
): string;

export function copyGrantRequestKeyHash(
  shareId: string,
  requesterUid: string,
  idempotencyKey: string,
  secret?: string
): string;

export function copyGrantRequestDisposition(
  requestDocument: Record<string, unknown> | null,
  expected: {
    ownerUid: string;
    policyVersion: number;
    requesterUid: string;
    requestKeyHash: string;
    sessionReferenceHash: string;
    shareId: string;
  },
  nowSeconds?: number,
  secret?: string
):
  | { status: "conflict" | "issue" | "renew" }
  | { status: "replay"; copyGrant: string; expiresAt: string };

export function copyGrantTokenHash(copyGrant: string, secret?: string): string;

export function copyGrantAuditEventId(
  requestDocumentId: string,
  copyGrant: string,
  secret?: string
): string;

export function secureShareAttachmentBlobPath(
  ownerUid: string,
  shareId: string,
  attachmentId: string
): string;

export function shareOwnedBy(
  state: { share: { ownerUid: string } } | null,
  user: { uid: string; isAdmin?: boolean } | null
): boolean;

export function shareManagedBy(
  state: { share: { ownerUid: string } } | null,
  user: { uid: string; isAdmin?: boolean } | null
): boolean;

export function sourceShareGuardId(ownerUid: string, sourceNoteId: string): string;

export function sourceSnapshotAvailable(
  share: Record<string, unknown>,
  note: Record<string, unknown> | null,
  ownerProfile: Record<string, unknown> | null
): boolean;

export function ensureSameOrigin(request: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
}): void;

export function handleApiError(
  error: unknown,
  response: {
    destroyed?: boolean;
    headersSent?: boolean;
    statusCode?: number;
    destroy?(): void;
    end(value?: unknown): void;
    setHeader(name: string, value: string | string[]): void;
  },
  requestId: string
): void;

export function withParticipantAllocationQueue<T>(
  shareId: string,
  operation: (execution: {
    enqueuedAt: number;
    signal: AbortSignal;
  }) => Promise<T> | T,
  request?: {
    aborted?: boolean;
    complete?: boolean;
    destroyed?: boolean;
    off?(eventName: string, listener: () => void): void;
    once?(eventName: string, listener: () => void): void;
    removeListener?(eventName: string, listener: () => void): void;
    signal?: AbortSignal;
  },
  response?: {
    destroyed?: boolean;
    off?(eventName: string, listener: () => void): void;
    once?(eventName: string, listener: () => void): void;
    removeListener?(eventName: string, listener: () => void): void;
    writableEnded?: boolean;
  }
): Promise<T>;

export function participantAllocationQueueSnapshot(): {
  liveShareKeys: number;
  totalEntries: number;
};

export function revalidateParticipantAllocationChallenge(
  context: { accessToken: string; projectId: string },
  shareId: string,
  verifiedPolicyVersion: number,
  identity: {
    challenge: Record<string, unknown> | null;
    [key: string]: unknown;
  },
  attemptHash: string
): Promise<{
  challenge: Record<string, unknown> | null;
  [key: string]: unknown;
}>;

export function issueAccessSession(
  request: {
    headers?: Record<string, string | string[] | undefined>;
  },
  context: { accessToken: string; projectId: string },
  shareId: string,
  verifiedPolicyVersion: number,
  identity: {
    authorUid: string;
    challenge: Record<string, unknown> | null;
    displayName: string;
    identityHash: string;
    identityType: string;
    participantIdentityHash: string;
    participantToken: string;
    participantTokenDigest: string;
    setParticipantCookie: boolean;
  },
  browserBindingHash: string,
  attemptHash: string,
  networkHash: string,
  requestId: string,
  participantAllocationExecution?: {
    enqueuedAt: number;
    signal: AbortSignal;
  }
): Promise<{
  csrfToken: string;
  expiresAt: string;
  participantId: string;
  participantIdentityEnabled: boolean;
  participantLimitReached: boolean;
  policy: Record<string, unknown>;
  sessionToken: string;
}>;

export function resolveAccessIdentity(
  request: {
    headers?: Record<string, string | string[] | undefined>;
  },
  context: { accessToken: string; projectId: string },
  shareId: string,
  stateOrPolicy:
    | Record<string, unknown>
    | {
      policy: Record<string, unknown>;
      share: Record<string, unknown>;
    },
  body: Record<string, unknown>,
  otpVerificationTiming?: {
    now?: () => number;
    random?: (minimum: number, maximum: number) => number;
    wait?: (milliseconds: number) => Promise<unknown>;
  },
  preverifiedCaller?: Record<string, unknown> | null
): Promise<{
  authorUid: string;
  caller: Record<string, unknown> | null;
  challenge: Record<string, unknown> | null;
  displayName: string;
  identityHash: string;
  identityType: string;
  participantIdentityHash: string;
  participantToken: string;
  participantTokenDigest: string;
  setParticipantCookie: boolean;
}>;

export function issueAnonymousParticipantToken(
  shareId: string,
  browserBinding: string,
  unlockAttemptId: string
): {
  issuanceIdentity: string;
  token: string;
  version: 2;
};

export function verifiedAnonymousParticipantToken(
  shareId: string,
  token: string
): {
  issuanceIdentity: string;
  version: 2;
};

export function readJsonBody(
  request: {
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  },
  maximumBytes?: number
): Promise<Record<string, unknown>>;

export function signedOpaqueToken(
  payload: Record<string, unknown>,
  purpose: string,
  ttlSeconds: number,
  secret?: string,
  nowSeconds?: number
): string;

export function verifySignedOpaqueToken(
  token: string,
  purpose: string,
  secret?: string,
  nowSeconds?: number
): Record<string, unknown> | null;

export function secureShareEmailReadiness(): {
  ready: boolean;
  v2Enabled: boolean;
  featureEnabled: boolean;
  providerConfigured: boolean;
  secretsConfigured: boolean;
  senderVerified: boolean;
};

export function verificationEmailText(code: string, ttlSeconds: number): string;
export function validateCommentBody(value: unknown): string;

export interface SecureShareEmailDeliveryResult {
  accepted: true;
  messageId: string;
}

export function createResendEmailAdapter(
  request?: typeof fetch,
  wait?: (milliseconds: number) => Promise<unknown>,
  beforeAttempt?: () => Promise<unknown>
): {
  healthCheck(input: {
    from: string;
    idempotencyKey: string;
    to: string;
  }): Promise<SecureShareEmailDeliveryResult>;
  send(input: {
    from: string;
    idempotencyKey: string;
    text: string;
    timeoutMilliseconds?: number;
    to: string;
  }): Promise<SecureShareEmailDeliveryResult>;
};

export function resolveEmailQuotaPolicy(environment?: Record<string, string | undefined>): {
  dailyHardLimit: number;
  dailySoftLimit: number;
  monthlyHardLimit: number;
  monthlySoftLimit: number;
};

export interface SecureShareEmailQuotaPeriod {
  bucketId: string;
  expiresAt: Date;
  hardLimit: number;
  periodKey: string;
  scope: "daily" | "monthly";
  softLimit: number;
}

export function emailQuotaPeriods(
  nowMilliseconds?: number,
  policy?: ReturnType<typeof resolveEmailQuotaPolicy>
): SecureShareEmailQuotaPeriod[];

export function emailQuotaExceeded(
  document: { reservedCount: number; sentCount: number } | null,
  period: SecureShareEmailQuotaPeriod
): {
  exceeded: boolean;
  reservedCount: number;
  sentCount: number;
  softLimitReached: boolean;
  total: number;
};

declare function handler(
  request: {
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
    method?: string;
    url?: string;
  },
  response: {
    destroyed?: boolean;
    headersSent?: boolean;
    statusCode?: number;
    destroy?(): void;
    end(value?: unknown): void;
    setHeader(name: string, value: string | string[]): void;
  }
): Promise<void>;
export default handler;
