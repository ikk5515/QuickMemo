export interface SecureShareEmailSettingsInput {
  host?: string;
  port?: 465 | 587;
  securityMode?: "implicit_tls" | "starttls";
  username: string;
  appPassword: string;
  replyTo?: string;
}

export interface SecureShareEmailRuntimeSnapshot {
  ready: boolean;
  enabled: boolean;
  generation: string;
  provider: "" | "gmail_smtp" | "resend";
  reason: string;
  configuration: null | {
    host: string;
    port: 465 | 587;
    securityMode: "implicit_tls" | "starttls";
    username: string;
    fromAddress: string;
    replyTo: string;
  };
  environment: null | Record<string, string | undefined>;
}

export const secureShareEmailSettingsPath: string;
export const secureShareEmailProviderHealthPath: string;
export const emailSettingsTestMaximumAttempts: number;

export function adminEmailSettingsRequestHash(
  actorUid: string,
  body: Record<string, unknown>
): string;

export function adminIdempotencyRequestMatches(
  document: Record<string, unknown> | null,
  expected: {
    action: string;
    actorUid: string;
    nowMilliseconds?: number;
    requestHash: string;
  }
): boolean;

export function idTokenHasRecentAdminAuthentication(
  idToken: string,
  expectedUid: string,
  expectedProjectId: string,
  now?: number,
  environment?: Record<string, string | undefined>
): boolean;

export function assertEmailSettingsTestSendAvailable(
  pending: Record<string, unknown>,
  nowMilliseconds?: number
): number;

export function emailSettingsTestFailureDisposition(
  error: unknown,
  nowMilliseconds?: number
): {
  state: "ambiguous" | "failed";
  quotaOutcome: "ambiguous" | "failed";
  testNotBefore: Date;
};

export function normalizeGmailSettingsInput(
  input: SecureShareEmailSettingsInput
): Readonly<Required<SecureShareEmailSettingsInput>>;

export function normalizeSmtpSettingsInput(
  input: SecureShareEmailSettingsInput
): Readonly<Required<SecureShareEmailSettingsInput>>;

export function gmailRuntimeEnvironment(
  settings: SecureShareEmailSettingsInput,
  environment?: Record<string, string | undefined>
): Readonly<Record<string, string | undefined>>;

export function maskEmailAddress(value: string): string;

export function loadSecureShareEmailRuntimeSnapshot(
  context: { projectId: string; accessToken: string },
  options?: {
    allowCache?: boolean;
    environment?: Record<string, string | undefined>;
  }
): Promise<SecureShareEmailRuntimeSnapshot>;

export function safeSecureShareEmailRuntimeSnapshot(
  context: { projectId: string; accessToken: string },
  options?: {
    allowCache?: boolean;
    environment?: Record<string, string | undefined>;
  }
): Promise<SecureShareEmailRuntimeSnapshot>;

export function invalidateSecureShareEmailRuntimeCache(projectId?: string): void;
