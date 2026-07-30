import {
  parseSecureShareContentKeyFragment,
  parseSecureSharePath
} from "./secureShareUrl";

export {
  parseSecureShareContentKeyFragment,
  parseSecureSharePath
} from "./secureShareUrl";

export const secureShareLoginReturnKind = "secure_share_v2" as const;

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
  const parsedFragment = parsedPath
    ? parseSecureShareContentKeyFragment(hash, parsedPath.routeKind)
    : null;

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
