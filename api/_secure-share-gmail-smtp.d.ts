export interface GmailSmtpFailureClassification {
  blockedSeconds: number;
  deliveryAmbiguous: boolean;
  reasonCode:
    | "ambiguous_delivery"
    | "auth_error"
    | "configuration_error"
    | "connection_error"
    | "invalid_recipient"
    | "permanent_provider_error"
    | "quota_exceeded"
    | "rate_limited"
    | "temporary_provider_error"
    | "timeout"
    | "tls_error";
  responseCode: number;
}

export interface GmailSmtpDeliveryResult {
  accepted: true;
  messageId: string;
}

export interface GmailSmtpEmailAdapter {
  provider: "gmail_smtp";
  verifyConfiguration(): Promise<{
    cached: boolean;
    healthy: true;
    provider: "gmail_smtp";
  }>;
  send(input: {
    text: string;
    timeoutMilliseconds?: number;
    to: string;
  }): Promise<GmailSmtpDeliveryResult>;
}

export function classifyGmailSmtpError(
  error: unknown
): GmailSmtpFailureClassification;

export function createGmailSmtpEmailAdapter(options?: {
  createTransport?: unknown;
  environment?: Record<string, string | undefined>;
  now?: () => number;
}): GmailSmtpEmailAdapter;

export function resetGmailSmtpTransportForTests(): void;
