import {
  normalizeSecureShareEmail,
  secureShareAllowedEmailLimit
} from "./secureSharePolicy";
import { parseSecureShareUrl } from "./secureShareUrl";

export const secureShareEmailDraftMaxMailtoLength = 8_192;
export const secureShareEmailDraftSubject = "[QuickMemo] 보안 공유 문서 초대";

const secureShareEmailDraftBodyBeforeUrl = [
  "QuickMemo 보안 공유 문서가 도착했습니다.",
  "",
  "아래 링크를 열고 초대받은 이메일 주소로 인증한 뒤 문서를 확인해주세요.",
  "",
  ""
].join("\r\n");

const secureShareEmailDraftBodyAfterUrl = [
  "",
  "",
  "이 링크에는 문서 복호화에 필요한 정보가 포함되어 있습니다.",
  "다른 사람에게 전달하지 마세요."
].join("\r\n");

export type SecureShareEmailDraftErrorCode =
  | "composer_unavailable"
  | "duplicate_recipient"
  | "invalid_app_origin"
  | "invalid_recipient"
  | "invalid_recipient_count"
  | "invalid_share_url"
  | "mailto_too_long";

export class SecureShareEmailDraftError extends Error {
  readonly code: SecureShareEmailDraftErrorCode;

  constructor(code: SecureShareEmailDraftErrorCode, message: string) {
    super(message);
    this.name = "SecureShareEmailDraftError";
    this.code = code;
  }
}

export interface SecureShareEmailDraftInput {
  expectedOrigin: string;
  expectedShareId: string;
  recipients: readonly string[];
  shareUrl: string;
}

export interface SecureShareEmailDraft {
  mailtoUrl: string;
  recipientCount: number;
  recipientMode: "bcc" | "to";
}

export type SecureShareEmailDraftLauncher = (mailtoUrl: string) => void;

export interface SecureShareEmailDraftLaunchResult {
  deliveryStatus: "not_confirmed";
  recipientCount: number;
  recipientMode: "bcc" | "to";
  status: "composer_requested";
}

function emailDraftError(
  code: SecureShareEmailDraftErrorCode,
  message: string
): never {
  throw new SecureShareEmailDraftError(code, message);
}

function strictPercentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function validateExpectedOrigin(value: unknown) {
  if (typeof value !== "string") {
    return emailDraftError("invalid_app_origin", "QuickMemo 앱 주소가 올바르지 않습니다.");
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return emailDraftError("invalid_app_origin", "QuickMemo 앱 주소가 올바르지 않습니다.");
  }

  if (
    !new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) {
    return emailDraftError("invalid_app_origin", "QuickMemo 앱 주소가 올바르지 않습니다.");
  }

  return parsed.origin;
}

function validateRecipients(values: readonly string[]) {
  if (
    !Array.isArray(values)
    || values.length < 1
    || values.length > secureShareAllowedEmailLimit
  ) {
    return emailDraftError(
      "invalid_recipient_count",
      `받는 사람은 1명 이상 ${secureShareAllowedEmailLimit}명 이하로 지정해주세요.`
    );
  }

  const recipients: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeSecureShareEmail(value);

    if (!normalized || normalized !== value) {
      return emailDraftError(
        "invalid_recipient",
        "받는 사람 이메일 주소가 올바르게 정규화되지 않았습니다."
      );
    }
    if (seen.has(normalized)) {
      return emailDraftError(
        "duplicate_recipient",
        "중복된 받는 사람 이메일 주소가 있습니다."
      );
    }

    seen.add(normalized);
    recipients.push(normalized);
  }

  return recipients;
}

function canonicalSecureShareUrl(
  value: string,
  expectedOrigin: string,
  expectedShareId: string
) {
  const parsed = parseSecureShareUrl(value, expectedOrigin);

  if (!parsed || parsed.shareId !== expectedShareId) {
    return emailDraftError(
      "invalid_share_url",
      "같은 QuickMemo 앱에서 생성한 보안 공유 주소만 이메일에 넣을 수 있습니다."
    );
  }

  const fragment = parsed.routeKind === "compact"
    ? `#${parsed.contentKey}`
    : `#key=${parsed.contentKey}`;
  const canonicalUrl = `${expectedOrigin}${parsed.pathname}${fragment}`;

  if (canonicalUrl !== value) {
    return emailDraftError(
      "invalid_share_url",
      "보안 공유 주소 형식이 올바르지 않습니다."
    );
  }

  return canonicalUrl;
}

/**
 * The mail-compose path performs no fetch, persistence, analytics, or logging
 * and never sends the full URL or content key to the QuickMemo server. The
 * chosen mail application and mail provider necessarily receive the link.
 */
export function buildSecureShareEmailDraft(
  input: SecureShareEmailDraftInput
): SecureShareEmailDraft {
  const expectedOrigin = validateExpectedOrigin(input.expectedOrigin);
  const recipients = validateRecipients(input.recipients);
  const shareUrl = canonicalSecureShareUrl(
    input.shareUrl,
    expectedOrigin,
    input.expectedShareId
  );
  const body = `${secureShareEmailDraftBodyBeforeUrl}${shareUrl}${secureShareEmailDraftBodyAfterUrl}`;
  const recipientMode = recipients.length === 1 ? "to" : "bcc";
  const target = recipientMode === "to" ? strictPercentEncode(recipients[0]) : "";
  const queryParts = recipientMode === "bcc"
    ? [`bcc=${strictPercentEncode(recipients.join(","))}`]
    : [];

  queryParts.push(
    `subject=${strictPercentEncode(secureShareEmailDraftSubject)}`,
    `body=${strictPercentEncode(body)}`
  );

  const mailtoUrl = `mailto:${target}?${queryParts.join("&")}`;

  if (mailtoUrl.length > secureShareEmailDraftMaxMailtoLength) {
    return emailDraftError(
      "mailto_too_long",
      "메일 작성 주소가 너무 깁니다. 받는 사람 수를 줄여 다시 시도해주세요."
    );
  }

  return {
    mailtoUrl,
    recipientCount: recipients.length,
    recipientMode
  };
}

function defaultSecureShareEmailDraftLauncher(mailtoUrl: string) {
  if (typeof window === "undefined" || !window.location) {
    return emailDraftError(
      "composer_unavailable",
      "이 환경에서는 메일 작성창을 열 수 없습니다."
    );
  }

  window.location.assign(mailtoUrl);
}

/**
 * Requesting a mail composer is not proof that it opened or that mail was
 * delivered. Callers must present this as requested and never report sent.
 */
export function launchSecureShareEmailDraft(
  input: SecureShareEmailDraftInput,
  launcher: SecureShareEmailDraftLauncher = defaultSecureShareEmailDraftLauncher
): SecureShareEmailDraftLaunchResult {
  const draft = buildSecureShareEmailDraft(input);

  try {
    launcher(draft.mailtoUrl);
  } catch {
    return emailDraftError(
      "composer_unavailable",
      "메일 작성창을 요청하지 못했습니다. 기기의 기본 메일 앱을 확인해주세요."
    );
  }

  return {
    deliveryStatus: "not_confirmed",
    recipientCount: draft.recipientCount,
    recipientMode: draft.recipientMode,
    status: "composer_requested"
  };
}
