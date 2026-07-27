export const secureShareLoginReturnKind = "secure_share_v2" as const;

const secureShareIdPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const secureShareContentKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
const secureShareLoginReturnFields = new Set([
  "kind",
  "returnTo",
  "shareFragment"
]);

export interface SecureShareLoginReturnState {
  kind: typeof secureShareLoginReturnKind;
  returnTo: string;
  shareFragment: string;
}

export interface SecureShareLoginDestination {
  hash: string;
  pathname: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseSecureSharePath(pathname: unknown) {
  if (typeof pathname !== "string" || pathname.includes("?") || pathname.includes("#")) {
    return null;
  }

  const match = /^\/share\/([^/]+)$/u.exec(pathname);

  if (!match) {
    return null;
  }

  let shareId: string;

  try {
    shareId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  if (!secureShareIdPattern.test(shareId)) {
    return null;
  }

  return {
    pathname: `/share/${encodeURIComponent(shareId)}`,
    shareId
  };
}

export function parseSecureShareContentKeyFragment(hash: unknown) {
  if (typeof hash !== "string" || !hash.startsWith("#") || hash.length > 80) {
    return null;
  }

  const params = new URLSearchParams(hash.slice(1));
  const entries = [...params.entries()];

  if (entries.length !== 1 || entries[0][0] !== "key") {
    return null;
  }

  const contentKey = entries[0][1];

  if (!secureShareContentKeyPattern.test(contentKey)) {
    return null;
  }

  return {
    contentKey,
    fragment: `#key=${encodeURIComponent(contentKey)}`
  };
}

/**
 * Builds the handoff kept in React Router history state while login is in
 * progress. It intentionally accepts pathname and fragment separately so a
 * full URL, query string, or arbitrary redirect target cannot be persisted.
 */
export function createSecureShareLoginReturnState(
  pathname: unknown,
  hash: unknown
): SecureShareLoginReturnState | null {
  const parsedPath = parseSecureSharePath(pathname);
  const parsedFragment = parseSecureShareContentKeyFragment(hash);

  if (!parsedPath || !parsedFragment) {
    return null;
  }

  return {
    kind: secureShareLoginReturnKind,
    returnTo: parsedPath.pathname,
    shareFragment: parsedFragment.fragment
  };
}

export function parseSecureShareLoginReturnState(
  value: unknown
): SecureShareLoginReturnState | null {
  if (
    !isPlainRecord(value)
    || Object.keys(value).some((field) => !secureShareLoginReturnFields.has(field))
    || value.kind !== secureShareLoginReturnKind
  ) {
    return null;
  }

  return createSecureShareLoginReturnState(value.returnTo, value.shareFragment);
}

export function secureShareLoginDestination(
  value: unknown
): SecureShareLoginDestination | null {
  const state = parseSecureShareLoginReturnState(value);

  if (!state) {
    return null;
  }

  return {
    pathname: state.returnTo,
    hash: state.shareFragment
  };
}
