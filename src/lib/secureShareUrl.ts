export const secureShareContentKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
export const secureShareCompactTokenPattern = /^[A-Za-z0-9_-]{24}$/u;

const secureShareIdPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const secureShareV2IdentifierPattern = /^ss2_[A-Za-z0-9_-]{2,124}$/u;
const secureShareCompactIdentifierPattern = /^ss2_([A-Za-z0-9_-]{24})$/u;

export type SecureShareRouteKind = "compact" | "standard";

export interface ParsedSecureSharePath {
  pathname: string;
  routeKind: SecureShareRouteKind;
  shareId: string;
}

export interface ParsedSecureShareContentKeyFragment {
  contentKey: string;
  fragment: string;
}

export interface ParsedSecureShareUrl {
  contentKey: string;
  pathname: string;
  routeKind: SecureShareRouteKind;
  shareId: string;
}

export function secureShareCompactUrlEnabled(
  value: unknown = import.meta.env.VITE_SECURE_SHARE_COMPACT_URL_ENABLED
) {
  return value === "true";
}

/**
 * Parses only same-app Secure Share path shapes. Compact paths deliberately do
 * not decode their segment: encoded slashes, traversal, or alternate encodings
 * must never be normalized into a valid token.
 */
export function parseSecureSharePath(pathname: unknown): ParsedSecureSharePath | null {
  if (
    typeof pathname !== "string"
    || pathname.includes("?")
    || pathname.includes("#")
  ) {
    return null;
  }

  const compactMatch = /^\/s\/([A-Za-z0-9_-]{24})$/u.exec(pathname);
  if (compactMatch && secureShareCompactTokenPattern.test(compactMatch[1])) {
    return {
      pathname: `/s/${compactMatch[1]}`,
      routeKind: "compact",
      shareId: `ss2_${compactMatch[1]}`
    };
  }

  const standardMatch = /^\/share\/([^/]+)$/u.exec(pathname);
  if (!standardMatch) {
    return null;
  }

  let shareId: string;
  try {
    shareId = decodeURIComponent(standardMatch[1]);
  } catch {
    return null;
  }

  if (!secureShareIdPattern.test(shareId)) {
    return null;
  }

  return {
    pathname: `/share/${encodeURIComponent(shareId)}`,
    routeKind: "standard",
    shareId
  };
}

export function parseSecureShareContentKeyFragment(
  hash: unknown,
  routeKind: SecureShareRouteKind = "standard"
): ParsedSecureShareContentKeyFragment | null {
  if (typeof hash !== "string" || hash.length > 80) {
    return null;
  }

  const match = routeKind === "compact"
    ? /^#([A-Za-z0-9_-]{43})$/u.exec(hash)
    : /^#key=([A-Za-z0-9_-]{43})$/u.exec(hash);
  const contentKey = match?.[1] ?? "";

  if (!secureShareContentKeyPattern.test(contentKey)) {
    return null;
  }

  return {
    contentKey,
    fragment: routeKind === "compact"
      ? `#${contentKey}`
      : `#key=${contentKey}`
  };
}

export function parseSecureShareUrl(
  value: unknown,
  expectedOrigin?: string
): ParsedSecureShareUrl | null {
  if (typeof value !== "string" || value.length > 512) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    !new Set(["http:", "https:"]).has(url.protocol)
    || url.username
    || url.password
    || url.search
    || (expectedOrigin !== undefined && url.origin !== expectedOrigin)
  ) {
    return null;
  }

  const parsedPath = parseSecureSharePath(url.pathname);
  if (!parsedPath) {
    return null;
  }
  const parsedFragment = parseSecureShareContentKeyFragment(
    url.hash,
    parsedPath.routeKind
  );
  if (!parsedFragment) {
    return null;
  }

  return {
    ...parsedPath,
    contentKey: parsedFragment.contentKey
  };
}

export function buildSecureShareUrl(
  shareId: string,
  contentKey: string,
  origin: string,
  compactEnabled = secureShareCompactUrlEnabled()
) {
  if (
    !secureShareIdPattern.test(shareId)
    || !secureShareContentKeyPattern.test(contentKey)
  ) {
    throw new Error("보안 공유 주소 입력이 올바르지 않습니다.");
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("보안 공유 Origin이 올바르지 않습니다.");
  }
  if (
    !new Set(["http:", "https:"]).has(parsedOrigin.protocol)
    || parsedOrigin.username
    || parsedOrigin.password
    || parsedOrigin.pathname !== "/"
    || parsedOrigin.search
    || parsedOrigin.hash
  ) {
    throw new Error("보안 공유 Origin이 올바르지 않습니다.");
  }

  const compactMatch = secureShareCompactIdentifierPattern.exec(shareId);
  if (compactEnabled && compactMatch) {
    return `${parsedOrigin.origin}/s/${compactMatch[1]}#${contentKey}`;
  }

  return `${parsedOrigin.origin}/share/${encodeURIComponent(shareId)}#key=${contentKey}`;
}

export function isSecureShareV2Identifier(shareId: string) {
  return secureShareV2IdentifierPattern.test(shareId);
}
