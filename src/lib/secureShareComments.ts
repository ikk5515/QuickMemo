const secureShareIdentifierPattern = /^[A-Za-z0-9_-]{6,128}$/u;
const secureShareCommentCursorPattern = /^[A-Za-z0-9_-]{1,1000}$/u;

export type SecureShareCommentBadge =
  | "admin"
  | "email_verified"
  | "guest"
  | "owner"
  | "quickmemo_user";

export interface SecureShareCommentDto {
  authorParticipantId?: string;
  badge: SecureShareCommentBadge;
  body: string;
  canDelete: boolean;
  createdAt: string;
  displayName: string;
  id: string;
  ipPrefix?: string;
}

export interface SecureShareCommentsPage {
  items: SecureShareCommentDto[];
  nextCursor: string | null;
}

const secureShareCommentBadges = new Set<SecureShareCommentBadge>([
  "admin",
  "email_verified",
  "guest",
  "owner",
  "quickmemo_user"
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeString(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : null;
}

function safeUnicodeString(value: unknown, maximumLength: number) {
  return typeof value === "string"
    && value.length > 0
    && Array.from(value).length <= maximumLength
    ? value
    : null;
}

function safeDate(value: unknown) {
  const text = safeString(value, 64);
  const date = text ? new Date(text) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseSecureShareIpPrefix(value: unknown) {
  if (typeof value !== "string" || value.length > 16) {
    return null;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (ipv4) {
    const first = Number.parseInt(ipv4[1], 10);
    const second = Number.parseInt(ipv4[2], 10);
    const canonical = `${first}.${second}`;
    const reserved = (
      first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 88 || second === 168))
      || (first === 198 && (second === 18 || second === 19 || second === 51))
      || (first === 203 && second === 0)
    );

    return first <= 255 && second <= 255 && canonical === value && !reserved
      ? canonical
      : null;
  }

  const ipv6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value);
  if (!ipv6) {
    return null;
  }
  const first = Number.parseInt(ipv6[1], 16);
  const second = Number.parseInt(ipv6[2], 16);
  const canonical = `${first.toString(16)}:${second.toString(16)}`;
  const reserved = (
    (first & 0xe000) !== 0x2000
    || (first === 0x2001 && (second === 0x0002 || second === 0x0db8))
    || (first === 0x3fff && (second & 0xf000) === 0)
  );
  return canonical === value && !reserved ? canonical : null;
}

export function parseSecureShareCommentsResponse(
  value: unknown,
  allowIpPrefix = false
): SecureShareCommentsPage | null {
  if (
    !isPlainRecord(value)
    || !hasOnlyKeys(value, ["ok", "items", "nextCursor", "requestId"])
    || value.ok !== true
    || !safeString(value.requestId, 128)
    || !Array.isArray(value.items)
    || value.items.length > 20
  ) {
    return null;
  }

  const items: SecureShareCommentDto[] = [];

  for (const rawItem of value.items) {
    if (
      !isPlainRecord(rawItem)
      || !hasOnlyKeys(rawItem, [
        "id",
        "displayName",
        "badge",
        "body",
        "createdAt",
        "canDelete",
        "authorParticipantId",
        "ipPrefix"
      ])
    ) {
      return null;
    }

    const id = safeString(rawItem.id, 128);
    const body = safeUnicodeString(rawItem.body, 2_000);
    const displayName = safeUnicodeString(rawItem.displayName, 72);
    const createdAt = safeDate(rawItem.createdAt);
    const badge = rawItem.badge;
    const authorParticipantId = Object.prototype.hasOwnProperty.call(
      rawItem,
      "authorParticipantId"
    )
      ? safeString(rawItem.authorParticipantId, 128)
      : undefined;
    const ipPrefix = Object.prototype.hasOwnProperty.call(rawItem, "ipPrefix")
      ? parseSecureShareIpPrefix(rawItem.ipPrefix)
      : undefined;

    if (
      !id
      || !secureShareIdentifierPattern.test(id)
      || !body
      || !displayName
      || !createdAt
      || typeof badge !== "string"
      || !secureShareCommentBadges.has(badge as SecureShareCommentBadge)
      || typeof rawItem.canDelete !== "boolean"
      || (
        Object.prototype.hasOwnProperty.call(rawItem, "authorParticipantId")
        && (!authorParticipantId || !secureShareIdentifierPattern.test(authorParticipantId))
      )
      || (
        Object.prototype.hasOwnProperty.call(rawItem, "ipPrefix")
        && (!allowIpPrefix || !ipPrefix)
      )
    ) {
      return null;
    }

    items.push({
      id,
      body,
      displayName,
      createdAt,
      badge: badge as SecureShareCommentBadge,
      canDelete: rawItem.canDelete,
      ...(authorParticipantId ? { authorParticipantId } : {}),
      ...(ipPrefix ? { ipPrefix } : {})
    });
  }

  const nextCursor = value.nextCursor === null
    ? null
    : safeString(value.nextCursor, 1_000);

  if (
    value.nextCursor !== null
    && (!nextCursor || !secureShareCommentCursorPattern.test(nextCursor))
  ) {
    return null;
  }

  return { items, nextCursor };
}

export function mergeSecureShareComments(
  current: SecureShareCommentDto[],
  incoming: SecureShareCommentDto[],
  append: boolean
) {
  const incomingIds = new Set<string>();
  const uniqueIncoming = incoming.filter((comment) => {
    if (incomingIds.has(comment.id)) {
      return false;
    }
    incomingIds.add(comment.id);
    return true;
  });

  if (append) {
    const currentIds = new Set(current.map((comment) => comment.id));
    return [
      ...current,
      ...uniqueIncoming.filter((comment) => !currentIds.has(comment.id))
    ];
  }

  return [
    ...uniqueIncoming,
    ...current.filter((comment) => !incomingIds.has(comment.id))
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
