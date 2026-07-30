import { describe, expect, it } from "vitest";
import {
  buildSecureShareUrl,
  parseSecureShareContentKeyFragment,
  parseSecureSharePath,
  parseSecureShareUrl,
  secureShareCompactUrlEnabled
} from "./secureShareUrl";

const compactToken = "Abcdefghijklmnopqrstuvwx";
const contentKey = "A".repeat(43);
const origin = "https://quickmemo.example";

describe("Secure Share compact URL boundary", () => {
  it("gates only compact URL generation while retaining the shorter v2 identifier", () => {
    const shareId = `ss2_${compactToken}`;

    expect(buildSecureShareUrl(shareId, contentKey, origin, false)).toBe(
      `${origin}/share/${shareId}#key=${contentKey}`
    );
    expect(buildSecureShareUrl(shareId, contentKey, origin, true)).toBe(
      `${origin}/s/${compactToken}#${contentKey}`
    );
    expect(secureShareCompactUrlEnabled("true")).toBe(true);
    expect(secureShareCompactUrlEnabled("false")).toBe(false);
    expect(secureShareCompactUrlEnabled("TRUE")).toBe(false);
  });

  it("keeps existing long v2 and legacy IDs on the standard URL", () => {
    const existingShareId = `ss2_${"B".repeat(40)}`;
    const legacyShareId = "legacy_share_123456";

    expect(buildSecureShareUrl(existingShareId, contentKey, origin, true)).toBe(
      `${origin}/share/${existingShareId}#key=${contentKey}`
    );
    expect(buildSecureShareUrl(legacyShareId, contentKey, origin, true)).toBe(
      `${origin}/share/${legacyShareId}#key=${contentKey}`
    );
  });

  it("maps one exact compact token to its internal v2 share ID", () => {
    expect(parseSecureSharePath(`/s/${compactToken}`)).toEqual({
      pathname: `/s/${compactToken}`,
      routeKind: "compact",
      shareId: `ss2_${compactToken}`
    });
    expect(parseSecureShareContentKeyFragment(`#${contentKey}`, "compact")).toEqual({
      contentKey,
      fragment: `#${contentKey}`
    });
    expect(parseSecureShareUrl(`${origin}/s/${compactToken}#${contentKey}`, origin)).toEqual({
      contentKey,
      pathname: `/s/${compactToken}`,
      routeKind: "compact",
      shareId: `ss2_${compactToken}`
    });
  });

  it("preserves the exact standard path and key fragment contract", () => {
    const shareId = `ss2_${"B".repeat(40)}`;

    expect(parseSecureSharePath(`/share/${shareId}`)).toEqual({
      pathname: `/share/${shareId}`,
      routeKind: "standard",
      shareId
    });
    expect(parseSecureShareContentKeyFragment(`#key=${contentKey}`)).toEqual({
      contentKey,
      fragment: `#key=${contentKey}`
    });
    expect(parseSecureShareUrl(`${origin}/share/${shareId}#key=${contentKey}`, origin))
      .toMatchObject({ contentKey, shareId, routeKind: "standard" });
  });

  it.each([
    `/s/${compactToken}?next=/admin#${contentKey}`,
    `/s/${compactToken}#key=${contentKey}`,
    `/s/${compactToken}#${contentKey}&next=/admin`,
    `/s/${compactToken}#${contentKey}#extra`,
    `/s/${compactToken.slice(1)}#${contentKey}`,
    `/s/${compactToken}A#${contentKey}`,
    `/s/%2e%2e%2fadmin#${contentKey}`,
    `/s/${compactToken}%2fadmin#${contentKey}`,
    `/s/${compactToken}/../admin#${contentKey}`,
    `/share/ss2_${compactToken}#${contentKey}`,
    `/share/ss2_${compactToken}?key=${contentKey}#key=${contentKey}`,
    `/share/%2e%2e%2fadmin#key=${contentKey}`
  ])("rejects malformed, mixed-form, queried, and traversal input: %s", (path) => {
    expect(parseSecureShareUrl(`${origin}${path}`, origin)).toBeNull();
  });

  it("rejects foreign origins, credentials, and invalid generation input", () => {
    expect(parseSecureShareUrl(
      `https://evil.example/s/${compactToken}#${contentKey}`,
      origin
    )).toBeNull();
    expect(parseSecureShareUrl(
      `https://user:password@quickmemo.example/s/${compactToken}#${contentKey}`
    )).toBeNull();
    expect(() => buildSecureShareUrl(
      `ss2_${compactToken}`,
      contentKey,
      "javascript:alert(1)",
      true
    )).toThrow(/Origin/u);
    expect(() => buildSecureShareUrl(
      `ss2_${compactToken}`,
      "short",
      origin,
      true
    )).toThrow(/입력/u);
  });
});
