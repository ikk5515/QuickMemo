export const MAX_WEB_VIEWER_URL_CHARACTERS = 2_048;

const blockedHostnames = new Set(["localhost", "localhost.localdomain"]);
const blockedHostnameSuffixes = [".home", ".internal", ".lan", ".local", ".localhost"];

function blockedIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function blockedIpv6(hostname: string) {
  const value = hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
  return value === "::"
    || value === "::1"
    || value.startsWith("::ffff:")
    || value.startsWith("fc")
    || value.startsWith("fd")
    || value.startsWith("fe80:")
    || value.startsWith("ff");
}

export function safeWebViewerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WEB_VIEWER_URL_CHARACTERS || !/^https?:\/\//iu.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || blockedHostnames.has(hostname)
      || blockedHostnameSuffixes.some((suffix) => hostname.endsWith(suffix))
      || blockedIpv4(hostname)
      || blockedIpv6(hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
