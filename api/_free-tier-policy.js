const DEFAULT_OFFICIAL_CAPACITY_BYTES = 1_000_000_000;
const DEFAULT_OPERATIONAL_CAP_BYTES = 800_000_000;
const DEFAULT_WARNING_PERCENT = 65;
const DEFAULT_ADMIN_WARNING_PERCENT = 75;
const DEFAULT_RESTRICT_LARGE_PERCENT = 80;
const DEFAULT_HARD_STOP_PERCENT = 85;
const DEFAULT_RESTRICTED_UPLOAD_MAX_BYTES = 25_000_000;

export const GLOBAL_BLOB_USAGE_DOCUMENT_PATH = "systemUsage/blobAttachmentsV1";
export const GLOBAL_BLOB_USAGE_SCHEMA_VERSION = 1;

const ENV_KEYS = Object.freeze({
  officialCapacityBytes: "BLOB_STORAGE_INCLUDED_BYTES",
  operationalCapBytes: "BLOB_STORAGE_OPERATIONAL_CAP_BYTES",
  warningPercent: "BLOB_STORAGE_WARNING_PERCENT",
  adminWarningPercent: "BLOB_STORAGE_ADMIN_WARNING_PERCENT",
  restrictLargePercent: "BLOB_STORAGE_RESTRICT_PERCENT",
  hardStopPercent: "BLOB_STORAGE_HARD_STOP_PERCENT",
  restrictedUploadMaxBytes: "BLOB_STORAGE_RESTRICTED_UPLOAD_MAX_BYTES"
});

export const DEFAULT_FREE_TIER_POLICY = Object.freeze({
  officialCapacityBytes: DEFAULT_OFFICIAL_CAPACITY_BYTES,
  operationalCapBytes: DEFAULT_OPERATIONAL_CAP_BYTES,
  warningPercent: DEFAULT_WARNING_PERCENT,
  adminWarningPercent: DEFAULT_ADMIN_WARNING_PERCENT,
  restrictLargePercent: DEFAULT_RESTRICT_LARGE_PERCENT,
  hardStopPercent: DEFAULT_HARD_STOP_PERCENT,
  restrictedUploadMaxBytes: DEFAULT_RESTRICTED_UPLOAD_MAX_BYTES
});

function readPositiveInteger(env, key, fallback, maximum, invalidFields) {
  const value = env[key];
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "string"
    || !/^[1-9]\d*$/u.test(value)
    || !Number.isSafeInteger(Number(value))
  ) {
    invalidFields.add(key);
    return fallback;
  }

  const parsed = Number(value);
  if (parsed > maximum) {
    invalidFields.add(key);
    return maximum;
  }
  return parsed;
}

function readPercent(env, key, fallback, invalidFields) {
  return readPositiveInteger(env, key, fallback, fallback, invalidFields);
}

function thresholdBytes(capacityBytes, percent) {
  return Math.floor((capacityBytes * percent) / 100);
}

function hasOrderedThresholds(policy) {
  return policy.warningPercent <= policy.adminWarningPercent
    && policy.adminWarningPercent <= policy.restrictLargePercent
    && policy.restrictLargePercent <= policy.hardStopPercent;
}

export function resolveFreeTierPolicy(sourceEnv = {}) {
  const env = sourceEnv && typeof sourceEnv === "object" ? sourceEnv : {};
  const invalidFields = new Set();
  const officialCapacityBytes = readPositiveInteger(
    env,
    ENV_KEYS.officialCapacityBytes,
    DEFAULT_OFFICIAL_CAPACITY_BYTES,
    DEFAULT_OFFICIAL_CAPACITY_BYTES,
    invalidFields
  );
  const configuredOperationalCapBytes = readPositiveInteger(
    env,
    ENV_KEYS.operationalCapBytes,
    DEFAULT_OPERATIONAL_CAP_BYTES,
    DEFAULT_OPERATIONAL_CAP_BYTES,
    invalidFields
  );
  const restrictedUploadMaxBytes = readPositiveInteger(
    env,
    ENV_KEYS.restrictedUploadMaxBytes,
    DEFAULT_RESTRICTED_UPLOAD_MAX_BYTES,
    DEFAULT_RESTRICTED_UPLOAD_MAX_BYTES,
    invalidFields
  );
  const configuredThresholds = {
    warningPercent: readPercent(
      env,
      ENV_KEYS.warningPercent,
      DEFAULT_WARNING_PERCENT,
      invalidFields
    ),
    adminWarningPercent: readPercent(
      env,
      ENV_KEYS.adminWarningPercent,
      DEFAULT_ADMIN_WARNING_PERCENT,
      invalidFields
    ),
    restrictLargePercent: readPercent(
      env,
      ENV_KEYS.restrictLargePercent,
      DEFAULT_RESTRICT_LARGE_PERCENT,
      invalidFields
    ),
    hardStopPercent: readPercent(
      env,
      ENV_KEYS.hardStopPercent,
      DEFAULT_HARD_STOP_PERCENT,
      invalidFields
    )
  };
  const thresholds = hasOrderedThresholds(configuredThresholds)
    ? configuredThresholds
    : {
        warningPercent: DEFAULT_WARNING_PERCENT,
        adminWarningPercent: DEFAULT_ADMIN_WARNING_PERCENT,
        restrictLargePercent: DEFAULT_RESTRICT_LARGE_PERCENT,
        hardStopPercent: DEFAULT_HARD_STOP_PERCENT
      };

  if (!hasOrderedThresholds(configuredThresholds)) {
    invalidFields.add(ENV_KEYS.warningPercent);
    invalidFields.add(ENV_KEYS.adminWarningPercent);
    invalidFields.add(ENV_KEYS.restrictLargePercent);
    invalidFields.add(ENV_KEYS.hardStopPercent);
  }

  const operationalCapBytes = Math.min(
    configuredOperationalCapBytes,
    officialCapacityBytes
  );
  const hardStopBytes = Math.min(
    operationalCapBytes,
    thresholdBytes(officialCapacityBytes, thresholds.hardStopPercent)
  );
  const warningBytes = Math.min(
    thresholdBytes(officialCapacityBytes, thresholds.warningPercent),
    hardStopBytes
  );
  const adminWarningBytes = Math.min(
    thresholdBytes(officialCapacityBytes, thresholds.adminWarningPercent),
    hardStopBytes
  );
  const restrictLargeBytes = Math.min(
    thresholdBytes(officialCapacityBytes, thresholds.restrictLargePercent),
    hardStopBytes
  );

  return Object.freeze({
    enabled: env.FREE_TIER_MODE === "true",
    officialCapacityBytes,
    operationalCapBytes,
    ...thresholds,
    warningBytes,
    adminWarningBytes,
    restrictLargeBytes,
    hardStopBytes,
    restrictedUploadMaxBytes,
    invalidConfiguration: invalidFields.size > 0,
    invalidFields: Object.freeze([...invalidFields].sort())
  });
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function calculateProjectedStorageUsage(input) {
  if (!input || typeof input !== "object") {
    return { valid: false };
  }

  const { requestedBytes, reservedBytes, usedBytes } = input;
  if (
    !isNonNegativeSafeInteger(usedBytes)
    || !isNonNegativeSafeInteger(reservedBytes)
    || !isNonNegativeSafeInteger(requestedBytes)
    || usedBytes > Number.MAX_SAFE_INTEGER - reservedBytes
  ) {
    return { valid: false };
  }

  const usedAndReservedBytes = usedBytes + reservedBytes;
  if (usedAndReservedBytes > Number.MAX_SAFE_INTEGER - requestedBytes) {
    return { valid: false };
  }

  return {
    valid: true,
    usedAndReservedBytes,
    projectedBytes: usedAndReservedBytes + requestedBytes
  };
}

function isResolvedPolicy(policy) {
  return Boolean(
    policy
    && typeof policy === "object"
    && typeof policy.enabled === "boolean"
    && isNonNegativeSafeInteger(policy.warningBytes)
    && isNonNegativeSafeInteger(policy.adminWarningBytes)
    && isNonNegativeSafeInteger(policy.restrictLargeBytes)
    && isNonNegativeSafeInteger(policy.hardStopBytes)
    && isNonNegativeSafeInteger(policy.restrictedUploadMaxBytes)
    && policy.warningBytes <= policy.adminWarningBytes
    && policy.adminWarningBytes <= policy.restrictLargeBytes
    && policy.restrictLargeBytes <= policy.hardStopBytes
  );
}

function hardStopDecision(usage, hardStopBytes = null) {
  return {
    state: "hard-stop",
    allowUpload: false,
    warnUser: true,
    warnAdmin: true,
    restrictLargeUploads: true,
    code: "upload_temporarily_unavailable",
    suggestedHttpStatus: 503,
    usedAndReservedBytes: usage.valid ? usage.usedAndReservedBytes : null,
    projectedBytes: usage.valid ? usage.projectedBytes : null,
    hardStopBytes
  };
}

export function evaluateFreeTierUpload(input, policy = resolveFreeTierPolicy()) {
  const usage = calculateProjectedStorageUsage(input);
  if (!usage.valid || !isResolvedPolicy(policy)) {
    return hardStopDecision(usage);
  }

  if (!policy.enabled) {
    return {
      state: "allow",
      allowUpload: true,
      warnUser: false,
      warnAdmin: false,
      restrictLargeUploads: false,
      code: "upload_allowed",
      suggestedHttpStatus: 200,
      ...usage,
      hardStopBytes: policy.hardStopBytes
    };
  }

  if (usage.projectedBytes >= policy.hardStopBytes) {
    return hardStopDecision(usage, policy.hardStopBytes);
  }

  if (usage.projectedBytes >= policy.restrictLargeBytes) {
    const largeUploadBlocked = input.requestedBytes > policy.restrictedUploadMaxBytes;
    return {
      state: "restrict",
      allowUpload: !largeUploadBlocked,
      warnUser: true,
      warnAdmin: true,
      restrictLargeUploads: true,
      code: largeUploadBlocked
        ? "storage_large_upload_restricted"
        : "storage_capacity_restricted",
      suggestedHttpStatus: largeUploadBlocked ? 507 : 200,
      ...usage,
      hardStopBytes: policy.hardStopBytes
    };
  }

  if (usage.projectedBytes >= policy.adminWarningBytes) {
    return {
      state: "warn",
      allowUpload: true,
      warnUser: true,
      warnAdmin: true,
      restrictLargeUploads: false,
      code: "storage_capacity_warning",
      suggestedHttpStatus: 200,
      ...usage,
      hardStopBytes: policy.hardStopBytes
    };
  }

  if (usage.projectedBytes >= policy.warningBytes) {
    return {
      state: "warn",
      allowUpload: true,
      warnUser: true,
      warnAdmin: false,
      restrictLargeUploads: false,
      code: "storage_capacity_warning",
      suggestedHttpStatus: 200,
      ...usage,
      hardStopBytes: policy.hardStopBytes
    };
  }

  return {
    state: "allow",
    allowUpload: true,
    warnUser: false,
    warnAdmin: false,
    restrictLargeUploads: false,
    code: "upload_allowed",
    suggestedHttpStatus: 200,
    ...usage,
    hardStopBytes: policy.hardStopBytes
  };
}
