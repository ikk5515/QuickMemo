import { describe, expect, it } from "vitest";
import {
  createSecureShareLoginReturnState,
  parseSecureShareContentKeyFragment,
  parseSecureShareLoginReturnState,
  parseSecureSharePath,
  secureShareLoginDestination
} from "./shareLoginReturn";

const shareId = "share_id-1234567890";
const contentKey = "A".repeat(43);

describe("secure share login return handoff", () => {
  it("keeps the validated share path and content-key fragment in router state", () => {
    const state = createSecureShareLoginReturnState(
      `/share/${shareId}`,
      `#key=${contentKey}`
    );

    expect(state).toEqual({
      kind: "secure_share_v2",
      returnTo: `/share/${shareId}`,
      shareFragment: `#key=${contentKey}`
    });
    expect(JSON.stringify(state)).not.toContain("?key=");
    expect(secureShareLoginDestination(state)).toEqual({
      pathname: `/share/${shareId}`,
      hash: `#key=${contentKey}`
    });
  });

  it("rejects external URLs, arbitrary routes, queries, and path traversal", () => {
    expect(createSecureShareLoginReturnState(
      "https://evil.example/share/abcdef",
      `#key=${contentKey}`
    )).toBeNull();
    expect(createSecureShareLoginReturnState(
      "/admin",
      `#key=${contentKey}`
    )).toBeNull();
    expect(createSecureShareLoginReturnState(
      `/share/${shareId}?key=${contentKey}`,
      `#key=${contentKey}`
    )).toBeNull();
    expect(parseSecureSharePath("/share/%2e%2e%2fadmin")).toBeNull();
  });

  it("accepts only one exact AES-256 key fragment parameter", () => {
    expect(parseSecureShareContentKeyFragment(`#key=${contentKey}`)).toEqual({
      contentKey,
      fragment: `#key=${contentKey}`
    });
    expect(parseSecureShareContentKeyFragment(`#key=${contentKey}&next=/admin`)).toBeNull();
    expect(parseSecureShareContentKeyFragment(`#other=${contentKey}`)).toBeNull();
    expect(parseSecureShareContentKeyFragment("#key=short")).toBeNull();
    expect(parseSecureShareContentKeyFragment(`?key=${contentKey}`)).toBeNull();
  });

  it("rejects unknown or attacker-controlled history-state fields", () => {
    expect(parseSecureShareLoginReturnState({
      kind: "secure_share_v2",
      returnTo: `/share/${shareId}`,
      shareFragment: `#key=${contentKey}`,
      body: "secret note body"
    })).toBeNull();
    expect(parseSecureShareLoginReturnState({
      kind: "secure_share_v2",
      returnTo: "https://evil.example",
      shareFragment: `#key=${contentKey}`
    })).toBeNull();
    expect(parseSecureShareLoginReturnState({
      kind: "library_capture",
      returnTo: `/share/${shareId}`,
      shareFragment: `#key=${contentKey}`
    })).toBeNull();
  });
});
