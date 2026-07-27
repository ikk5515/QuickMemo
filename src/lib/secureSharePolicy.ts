export const secureShareAccessModes = [
  "anyone_with_link",
  "allowed_emails",
  "authenticated_users"
] as const;

export const secureShareExpirationPresets = [
  "one_hour",
  "one_day",
  "seven_days",
  "custom"
] as const;

export const secureSharePermissionLevels = ["view", "comment", "save_copy"] as const;
export const secureShareOneTimeScopes = ["global"] as const;

export type SecureShareAccessMode = (typeof secureShareAccessModes)[number];
export type SecureShareExpirationPreset = (typeof secureShareExpirationPresets)[number];
export type SecureSharePermissionLevel = (typeof secureSharePermissionLevels)[number];
export type SecureShareOneTimeScope = (typeof secureShareOneTimeScopes)[number];

export const secureSharePasswordMinLength = 8;
export const secureSharePasswordMaxLength = 128;
export const secureShareAllowedEmailLimit = 100;
export const secureShareCustomExpiryMinMs = 5 * 60 * 1_000;
export const secureShareCustomExpiryMaxMs = 365 * 24 * 60 * 60 * 1_000;

const secureSharePresetDurations: Record<
  Exclude<SecureShareExpirationPreset, "custom">,
  number
> = {
  one_hour: 60 * 60 * 1_000,
  one_day: 24 * 60 * 60 * 1_000,
  seven_days: 7 * 24 * 60 * 60 * 1_000
};

const secureSharePolicyInputFields = new Set([
  "accessMode",
  "allowedEmails",
  "customExpiresAt",
  "downloadAllowed",
  "emailVerificationRequired",
  "expirationPreset",
  "oneTimeEnabled",
  "oneTimeScope",
  "password",
  "passwordEnabled",
  "permissionLevel",
  "quickCopyButtonVisible"
]);

const emailLocalPartPattern = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u;
const emailDomainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const textEncoder = new TextEncoder();

export interface SecureSharePolicyInput {
  accessMode: SecureShareAccessMode;
  allowedEmails: string[];
  customExpiresAt: string | null;
  downloadAllowed: boolean;
  emailVerificationRequired: boolean;
  expirationPreset: SecureShareExpirationPreset;
  oneTimeEnabled: boolean;
  oneTimeScope: SecureShareOneTimeScope;
  password?: string;
  passwordEnabled: boolean;
  permissionLevel: SecureSharePermissionLevel;
  quickCopyButtonVisible: boolean;
}

export type SecureSharePolicyField = keyof SecureSharePolicyInput | string;

export interface SecureSharePolicyValidationIssue {
  code:
    | "feature_unavailable"
    | "invalid_email"
    | "invalid_enum"
    | "invalid_expiry"
    | "invalid_type"
    | "missing_field"
    | "password_length"
    | "too_many_emails"
    | "unknown_field";
  field: SecureSharePolicyField;
  message: string;
}

export type SecureSharePolicyValidationResult =
  | { ok: true; value: SecureSharePolicyInput }
  | { ok: false; issues: SecureSharePolicyValidationIssue[] };

export interface SecureSharePolicyValidationOptions {
  emailFeatureEnabled?: boolean;
  now?: Date | number;
  requirePasswordWhenEnabled?: boolean;
}

export interface AllowedEmailParseResult {
  added: string[];
  duplicates: string[];
  emails: string[];
  invalid: string[];
  overflow: string[];
}

export interface SecureShareFeatureFlags {
  clientV2Enabled: boolean;
  emailEnabled: boolean;
  v2Enabled: boolean;
}

export interface SecureShareFeatureFlagSource {
  emailEnabled?: unknown;
  v2Enabled?: unknown;
}

export interface SecureShareSummaryOptions {
  locale?: string;
  timeZone?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function containsWhitespaceOrControl(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 31 || codePoint === 127;
  });
}

function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function safeNow(value: Date | number | undefined) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  return validDate(date) ? date : new Date();
}

export function defaultSecureSharePolicy(): SecureSharePolicyInput {
  return {
    accessMode: "anyone_with_link",
    allowedEmails: [],
    customExpiresAt: null,
    downloadAllowed: true,
    emailVerificationRequired: false,
    expirationPreset: "seven_days",
    oneTimeEnabled: false,
    oneTimeScope: "global",
    passwordEnabled: false,
    permissionLevel: "view",
    quickCopyButtonVisible: true
  };
}

export function isSecureShareFeatureFlagEnabled(value: unknown) {
  return value === true || value === "true";
}

export function resolveSecureShareFeatureFlags(
  serverFlags: SecureShareFeatureFlagSource = {},
  clientFlag: unknown = import.meta.env.VITE_SECURE_SHARE_V2_ENABLED
): SecureShareFeatureFlags {
  const clientV2Enabled = isSecureShareFeatureFlagEnabled(clientFlag);
  const serverV2Enabled = isSecureShareFeatureFlagEnabled(serverFlags.v2Enabled);
  const v2Enabled = clientV2Enabled && serverV2Enabled;

  return {
    clientV2Enabled,
    v2Enabled,
    emailEnabled: v2Enabled && isSecureShareFeatureFlagEnabled(serverFlags.emailEnabled)
  };
}

/**
 * Canonicalizes email addresses for the allowlist. The entire address is
 * lower-cased to match Firebase Auth's case-insensitive email identity
 * behavior. Plus tags and dots are intentionally preserved.
 */
export function normalizeSecureShareEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || textEncoder.encode(trimmed).byteLength > 254 || containsWhitespaceOrControl(trimmed)) {
    return null;
  }

  const separatorIndex = trimmed.lastIndexOf("@");

  if (
    separatorIndex <= 0
    || separatorIndex !== trimmed.indexOf("@")
    || separatorIndex === trimmed.length - 1
  ) {
    return null;
  }

  const localPart = trimmed.slice(0, separatorIndex);
  const rawDomain = trimmed.slice(separatorIndex + 1);

  if (
    codePointLength(localPart) > 64
    || localPart.startsWith(".")
    || localPart.endsWith(".")
    || localPart.includes("..")
    || !emailLocalPartPattern.test(localPart)
    || ["/", "\\", ":", "%", "?", "#", "[", "]"].some((character) => rawDomain.includes(character))
  ) {
    return null;
  }

  let domain: string;

  try {
    const parsedDomain = new URL(`http://${rawDomain}`);

    if (
      parsedDomain.username
      || parsedDomain.password
      || parsedDomain.port
      || parsedDomain.pathname !== "/"
      || parsedDomain.search
      || parsedDomain.hash
    ) {
      return null;
    }
    domain = parsedDomain.hostname.toLowerCase();
  } catch {
    return null;
  }

  const labels = domain.split(".");

  if (
    domain.length > 253
    || labels.length < 2
    || labels.some((label) => !emailDomainLabelPattern.test(label))
  ) {
    return null;
  }

  return `${localPart.toLowerCase()}@${domain}`;
}

export function parseAllowedEmailChips(
  rawValue: string,
  existingEmails: readonly string[] = []
): AllowedEmailParseResult {
  const emails: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];

  for (const existingEmail of existingEmails) {
    const normalized = normalizeSecureShareEmail(existingEmail);

    if (normalized && !seen.has(normalized) && emails.length < secureShareAllowedEmailLimit) {
      seen.add(normalized);
      emails.push(normalized);
    } else if (!normalized) {
      invalid.push(existingEmail);
    }
  }

  const added: string[] = [];
  const duplicates: string[] = [];
  const overflow: string[] = [];
  const tokens = rawValue
    .split(/[\r\n,;]+/u)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const normalized = normalizeSecureShareEmail(token);

    if (!normalized) {
      invalid.push(token);
      continue;
    }
    if (seen.has(normalized)) {
      duplicates.push(normalized);
      continue;
    }
    if (emails.length >= secureShareAllowedEmailLimit) {
      overflow.push(normalized);
      continue;
    }

    seen.add(normalized);
    emails.push(normalized);
    added.push(normalized);
  }

  return { added, duplicates, emails, invalid, overflow };
}

export function validateSecureSharePassword(password: unknown) {
  if (typeof password !== "string") {
    return "비밀번호를 입력해주세요.";
  }

  const length = codePointLength(password);

  if (length < secureSharePasswordMinLength || length > secureSharePasswordMaxLength) {
    return `비밀번호는 ${secureSharePasswordMinLength}자 이상 ${secureSharePasswordMaxLength}자 이하로 입력해주세요.`;
  }

  return null;
}

export function resolveSecureShareExpiresAt(
  expirationPreset: SecureShareExpirationPreset,
  customExpiresAt: string | null,
  nowValue: Date | number = Date.now()
) {
  const now = safeNow(nowValue);

  if (expirationPreset === "custom") {
    if (typeof customExpiresAt !== "string" || !customExpiresAt) {
      return null;
    }

    const customDate = new Date(customExpiresAt);
    return validDate(customDate) ? customDate : null;
  }

  return new Date(now.getTime() + secureSharePresetDurations[expirationPreset]);
}

export function validateSecureSharePolicyInput(
  rawValue: unknown,
  options: SecureSharePolicyValidationOptions = {}
): SecureSharePolicyValidationResult {
  const issues: SecureSharePolicyValidationIssue[] = [];

  if (!isPlainRecord(rawValue)) {
    return {
      ok: false,
      issues: [{
        code: "invalid_type",
        field: "policy",
        message: "공유 설정 형식이 올바르지 않습니다."
      }]
    };
  }

  const policyRecord = rawValue;

  for (const field of Object.keys(policyRecord)) {
    if (!secureSharePolicyInputFields.has(field)) {
      issues.push({
        code: "unknown_field",
        field,
        message: "허용되지 않은 공유 설정이 포함되어 있습니다."
      });
    }
  }

  function requiredBoolean(field: keyof SecureSharePolicyInput) {
    const value = policyRecord[field];

    if (typeof value !== "boolean") {
      issues.push({
        code: value === undefined ? "missing_field" : "invalid_type",
        field,
        message: `${field} 값이 올바르지 않습니다.`
      });
      return false;
    }
    return value;
  }

  const accessMode = isOneOf(policyRecord.accessMode, secureShareAccessModes)
    ? policyRecord.accessMode
    : null;
  const expirationPreset = isOneOf(policyRecord.expirationPreset, secureShareExpirationPresets)
    ? policyRecord.expirationPreset
    : null;
  const permissionLevel = isOneOf(policyRecord.permissionLevel, secureSharePermissionLevels)
    ? policyRecord.permissionLevel
    : null;
  const oneTimeScope = isOneOf(policyRecord.oneTimeScope, secureShareOneTimeScopes)
    ? policyRecord.oneTimeScope
    : null;

  for (const [field, value] of [
    ["accessMode", accessMode],
    ["expirationPreset", expirationPreset],
    ["permissionLevel", permissionLevel],
    ["oneTimeScope", oneTimeScope]
  ] as const) {
    if (!value) {
      issues.push({
        code: policyRecord[field] === undefined ? "missing_field" : "invalid_enum",
        field,
        message: `${field} 선택값이 올바르지 않습니다.`
      });
    }
  }

  const passwordEnabled = requiredBoolean("passwordEnabled");
  const requestedEmailVerification = requiredBoolean("emailVerificationRequired");
  const oneTimeEnabled = requiredBoolean("oneTimeEnabled");
  const downloadAllowed = requiredBoolean("downloadAllowed");
  const quickCopyButtonVisible = requiredBoolean("quickCopyButtonVisible");
  const emailVerificationRequired = accessMode === "allowed_emails"
    ? true
    : requestedEmailVerification;
  const allowedEmails: string[] = [];
  const seenEmails = new Set<string>();

  if (!Array.isArray(policyRecord.allowedEmails)) {
    issues.push({
      code: policyRecord.allowedEmails === undefined ? "missing_field" : "invalid_type",
      field: "allowedEmails",
      message: "허용 이메일 목록 형식이 올바르지 않습니다."
    });
  } else if (accessMode === "allowed_emails") {
    policyRecord.allowedEmails.forEach((email, index) => {
      const normalized = normalizeSecureShareEmail(email);

      if (!normalized) {
        issues.push({
          code: "invalid_email",
          field: `allowedEmails.${index}`,
          message: "올바르지 않은 이메일 주소가 포함되어 있습니다."
        });
      } else if (!seenEmails.has(normalized)) {
        seenEmails.add(normalized);
        allowedEmails.push(normalized);
      }
    });

    if (allowedEmails.length === 0) {
      issues.push({
        code: "invalid_email",
        field: "allowedEmails",
        message: "허용할 이메일을 한 개 이상 추가해주세요."
      });
    } else if (allowedEmails.length > secureShareAllowedEmailLimit) {
      issues.push({
        code: "too_many_emails",
        field: "allowedEmails",
        message: `허용 이메일은 최대 ${secureShareAllowedEmailLimit}개까지 추가할 수 있습니다.`
      });
    }
  }

  if (
    options.emailFeatureEnabled === false
    && (accessMode === "allowed_emails" || emailVerificationRequired)
  ) {
    issues.push({
      code: "feature_unavailable",
      field: "emailVerificationRequired",
      message: "이메일 인증 기능을 사용할 수 없습니다."
    });
  }

  let password: string | undefined;

  if (passwordEnabled) {
    if (policyRecord.password !== undefined) {
      const passwordError = validateSecureSharePassword(policyRecord.password);

      if (passwordError) {
        issues.push({
          code: "password_length",
          field: "password",
          message: passwordError
        });
      } else {
        password = policyRecord.password as string;
      }
    } else if (options.requirePasswordWhenEnabled) {
      issues.push({
        code: "missing_field",
        field: "password",
        message: "새 비밀번호를 입력해주세요."
      });
    }
  }

  const customExpiresAt = expirationPreset === "custom"
    && typeof policyRecord.customExpiresAt === "string"
      ? policyRecord.customExpiresAt
      : null;

  if (policyRecord.customExpiresAt !== null && typeof policyRecord.customExpiresAt !== "string") {
    issues.push({
      code: policyRecord.customExpiresAt === undefined ? "missing_field" : "invalid_type",
      field: "customExpiresAt",
      message: "직접 지정 만료 시간이 올바르지 않습니다."
    });
  }

  if (expirationPreset === "custom") {
    const now = safeNow(options.now);
    const customDate = customExpiresAt ? new Date(customExpiresAt) : new Date(Number.NaN);
    const difference = customDate.getTime() - now.getTime();

    if (!validDate(customDate)) {
      issues.push({
        code: "invalid_expiry",
        field: "customExpiresAt",
        message: "만료 날짜와 시간을 입력해주세요."
      });
    } else if (difference < secureShareCustomExpiryMinMs) {
      issues.push({
        code: "invalid_expiry",
        field: "customExpiresAt",
        message: "직접 지정 만료 시간은 현재보다 최소 5분 이후여야 합니다."
      });
    } else if (difference > secureShareCustomExpiryMaxMs) {
      issues.push({
        code: "invalid_expiry",
        field: "customExpiresAt",
        message: "직접 지정 만료 시간은 현재부터 최대 365일까지 설정할 수 있습니다."
      });
    }
  }

  if (
    issues.length > 0
    || !accessMode
    || !expirationPreset
    || !permissionLevel
    || !oneTimeScope
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      accessMode,
      allowedEmails: accessMode === "allowed_emails" ? allowedEmails : [],
      customExpiresAt: expirationPreset === "custom" ? customExpiresAt : null,
      downloadAllowed,
      emailVerificationRequired,
      expirationPreset,
      oneTimeEnabled,
      oneTimeScope,
      ...(password === undefined ? {} : { password }),
      passwordEnabled,
      permissionLevel,
      quickCopyButtonVisible
    }
  };
}

export function formatSecureShareExpiry(
  expiresAt: Date | string,
  options: SecureShareSummaryOptions = {}
) {
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);

  if (!validDate(date)) {
    return "만료 시간을 확인할 수 없습니다.";
  }

  const locale = options.locale ?? "ko-KR";
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone
  }).format(date);

  return `${formatted}에 만료 · ${timeZone}`;
}

export function summarizeSecureSharePolicy(
  policy: SecureSharePolicyInput,
  options: SecureShareSummaryOptions = {}
) {
  let accessSummary: string;

  if (policy.accessMode === "allowed_emails") {
    accessSummary = "지정한 이메일 주소를 인증한 사용자만 접근할 수 있습니다.";
  } else if (policy.accessMode === "authenticated_users") {
    accessSummary = policy.emailVerificationRequired
      ? "이메일 인증이 완료된 QuickMemo 계정만 접근할 수 있습니다."
      : "로그인한 QuickMemo 사용자만 접근할 수 있습니다.";
  } else if (policy.passwordEnabled && policy.emailVerificationRequired) {
    accessSummary = "링크를 가진 사용자 중 비밀번호와 이메일 인증을 모두 완료한 사람만 접근할 수 있습니다.";
  } else if (policy.passwordEnabled) {
    accessSummary = "링크를 가진 사용자 중 비밀번호를 입력한 사람만 접근할 수 있습니다.";
  } else if (policy.emailVerificationRequired) {
    accessSummary = "링크를 가진 사용자 중 이메일 인증을 완료한 사람만 접근할 수 있습니다.";
  } else {
    accessSummary = "링크를 가진 모든 사람이 접근할 수 있습니다.";
  }

  const clauses = [accessSummary];

  if (policy.oneTimeEnabled) {
    clauses.push("최초 인증에 성공한 한 명에게만 접근 세션이 발급됩니다.");
  }

  if (policy.permissionLevel === "comment") {
    clauses.push("접근자는 댓글을 작성할 수 있습니다.");
  } else if (policy.permissionLevel === "save_copy") {
    clauses.push("로그인한 접근자는 QuickMemo에 독립된 복사본을 저장할 수 있습니다.");
  } else {
    clauses.push("접근자는 보기만 할 수 있습니다.");
  }

  if (!policy.downloadAllowed) {
    clauses.push("첨부파일 직접 다운로드는 제한됩니다.");
  }
  if (!policy.quickCopyButtonVisible) {
    clauses.push("본문 빠른 복사 버튼은 표시되지 않습니다.");
  }

  if (policy.expirationPreset === "one_hour") {
    clauses.push("공유는 1시간 후 종료됩니다.");
  } else if (policy.expirationPreset === "one_day") {
    clauses.push("공유는 1일 후 종료됩니다.");
  } else if (policy.expirationPreset === "seven_days") {
    clauses.push("공유는 7일 후 종료됩니다.");
  } else {
    const expiresAt = policy.customExpiresAt ? new Date(policy.customExpiresAt) : null;
    clauses.push(
      expiresAt && validDate(expiresAt)
        ? `공유는 ${formatSecureShareExpiry(expiresAt, options)}.`
        : "직접 지정한 만료 시간을 확인해주세요."
    );
  }

  return clauses.join(" ");
}
