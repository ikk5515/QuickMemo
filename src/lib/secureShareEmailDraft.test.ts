import { describe, expect, it, vi } from "vitest";
import {
  buildSecureShareEmailDraft,
  launchSecureShareEmailDraft,
  secureShareEmailDraftMaxMailtoLength,
  secureShareEmailDraftSubject,
  SecureShareEmailDraftError
} from "./secureShareEmailDraft";

const appOrigin = "https://quickmemo.example";
const compactToken = "Abcdefghijklmnopqrstuvwx";
const compactShareId = `ss2_${compactToken}`;
const contentKey = "K".repeat(43);
const standardShareId = `ss2_${"S".repeat(40)}`;
const standardShareUrl = `${appOrigin}/share/${standardShareId}#key=${contentKey}`;
const compactShareUrl = `${appOrigin}/s/${compactToken}#${contentKey}`;

function mailtoParts(mailtoUrl: string) {
  const queryIndex = mailtoUrl.indexOf("?");
  const target = mailtoUrl.slice("mailto:".length, queryIndex);
  const params = new URLSearchParams(mailtoUrl.slice(queryIndex + 1));

  return { params, target: decodeURIComponent(target) };
}

function expectDraftError(
  action: () => unknown,
  code: SecureShareEmailDraftError["code"]
) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe("Secure Share client-only email draft", () => {
  it("uses To for one normalized recipient and fixed plain-text Korean content", () => {
    const draft = buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: ["viewer+share@example.com"],
      shareUrl: standardShareUrl,
      // A caller cannot influence the fixed subject/body with note content.
      noteTitle: "기밀 제목 <img src=x onerror=alert(1)>"
    } as Parameters<typeof buildSecureShareEmailDraft>[0] & { noteTitle: string });
    const { params, target } = mailtoParts(draft.mailtoUrl);

    expect(draft).toMatchObject({ recipientCount: 1, recipientMode: "to" });
    expect(target).toBe("viewer+share@example.com");
    expect(params.has("bcc")).toBe(false);
    expect(params.get("subject")).toBe(secureShareEmailDraftSubject);
    expect(params.get("body")).toBe([
      "QuickMemo 보안 공유 문서가 도착했습니다.",
      "",
      "아래 링크를 열고 초대받은 이메일 주소로 인증한 뒤 문서를 확인해주세요.",
      "",
      standardShareUrl,
      "",
      "이 링크에는 문서 복호화에 필요한 정보가 포함되어 있습니다.",
      "다른 사람에게 전달하지 마세요."
    ].join("\r\n"));
    expect(params.get("body")).not.toContain("기밀 제목");
    expect(params.get("body")).not.toContain("<img");
  });

  it("puts every recipient in BCC when there is more than one", () => {
    const recipients = [
      "first@example.com",
      "second+tag@example.org",
      "third@xn--bcher-kva.example"
    ];
    const draft = buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: compactShareId,
      recipients,
      shareUrl: compactShareUrl
    });
    const { params, target } = mailtoParts(draft.mailtoUrl);

    expect(draft).toMatchObject({ recipientCount: 3, recipientMode: "bcc" });
    expect(target).toBe("");
    expect(params.get("bcc")).toBe(recipients.join(","));
    expect(params.get("body")).toContain(compactShareUrl);
  });

  it.each([
    "victim@example.com\r\nBcc:attacker@example.com",
    "victim@example.com%0d%0aBcc:attacker@example.com",
    " Victim@Example.com ",
    "not-an-email",
    "victim@example.com,attacker@example.com"
  ])("rejects invalid, injected, or non-normalized recipient input: %s", (recipient) => {
    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: [recipient],
      shareUrl: standardShareUrl
    }), "invalid_recipient");
  });

  it("keeps percent-looking CRLF/header text inside the encoded recipient value", () => {
    const recipient = "victim%0d%0abcc%3aattacker@example.com";
    const draft = buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: [recipient],
      shareUrl: standardShareUrl
    });
    const { params, target } = mailtoParts(draft.mailtoUrl);

    expect(target).toBe(recipient);
    expect(draft.mailtoUrl).toContain("victim%250d%250abcc%253aattacker%40example.com");
    expect(params.has("bcc")).toBe(false);
    expect(params.get("subject")).toBe(secureShareEmailDraftSubject);
  });

  it("rejects duplicate recipients and recipient-count overflow without exposing PII", () => {
    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: ["same@example.com", "same@example.com"],
      shareUrl: standardShareUrl
    }), "duplicate_recipient");

    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: [],
      shareUrl: standardShareUrl
    }), "invalid_recipient_count");

    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: Array.from({ length: 101 }, (_, index) => `user${index}@example.com`),
      shareUrl: standardShareUrl
    }), "invalid_recipient_count");

    try {
      buildSecureShareEmailDraft({
        expectedOrigin: appOrigin,
        expectedShareId: standardShareId,
        recipients: ["private.person@example.com", "private.person@example.com"],
        shareUrl: standardShareUrl
      });
    } catch (error) {
      expect(String(error)).not.toContain("private.person@example.com");
    }
  });

  it.each([
    `https://evil.example/share/${standardShareId}#key=${contentKey}`,
    `${appOrigin}/share/${standardShareId}?next=/admin#key=${contentKey}`,
    `${appOrigin}/share/${standardShareId}#${contentKey}`,
    `${appOrigin}/share/${standardShareId}#key=${contentKey}&next=/admin`,
    `${appOrigin}/s/${compactToken}#key=${contentKey}`,
    `${appOrigin}/s/${compactToken}?key=${contentKey}#${contentKey}`
  ])("rejects foreign, queried, and malformed Secure Share URLs: %s", (shareUrl) => {
    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: ["viewer@example.com"],
      shareUrl
    }), "invalid_share_url");
  });

  it.each([
    "https://quickmemo.example/",
    "https://user:password@quickmemo.example",
    "javascript:alert(1)",
    "https://quickmemo.example/app"
  ])("requires an exact bare http(s) application origin: %s", (expectedOrigin) => {
    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin,
      expectedShareId: standardShareId,
      recipients: ["viewer@example.com"],
      shareUrl: standardShareUrl
    }), "invalid_app_origin");
  });

  it("rejects another valid share URL when the expected owner share ID is stale", () => {
    const otherShareId = `ss2_${"T".repeat(40)}`;
    const otherValidShareUrl = `${appOrigin}/share/${otherShareId}#key=${contentKey}`;

    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: ["viewer@example.com"],
      shareUrl: otherValidShareUrl
    }), "invalid_share_url");

    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: otherShareId,
      recipients: ["viewer@example.com"],
      shareUrl: standardShareUrl
    }), "invalid_share_url");
  });

  it("keeps the content key out of recipients, subject, and every query field except body", () => {
    const draft = buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients: ["first@example.com", "second@example.com"],
      shareUrl: standardShareUrl
    });
    const bodyMarker = "&body=";
    const bodyIndex = draft.mailtoUrl.indexOf(bodyMarker);
    const beforeEncodedBody = draft.mailtoUrl.slice(0, bodyIndex);
    const encodedBody = draft.mailtoUrl.slice(bodyIndex + bodyMarker.length);

    expect(bodyIndex).toBeGreaterThan(0);
    expect(beforeEncodedBody).not.toContain(contentKey);
    expect(decodeURIComponent(encodedBody)).toContain(standardShareUrl);
  });

  it("fails explicitly when a valid draft would exceed the bounded mailto length", () => {
    const longDomain = `${"a".repeat(20)}.${"b".repeat(20)}.example`;
    const recipients = Array.from(
      { length: 100 },
      (_, index) => `${index.toString().padStart(2, "0")}${"x".repeat(58)}@${longDomain}`
    );

    expectDraftError(() => buildSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: standardShareId,
      recipients,
      shareUrl: standardShareUrl
    }), "mailto_too_long");

    expect(secureShareEmailDraftMaxMailtoLength).toBe(8_192);
  });

  it("injects the launcher and reports only a composer request, never sent or opened", () => {
    const launcher = vi.fn<(mailtoUrl: string) => void>();
    const result = launchSecureShareEmailDraft({
      expectedOrigin: appOrigin,
      expectedShareId: compactShareId,
      recipients: ["viewer@example.com"],
      shareUrl: compactShareUrl
    }, launcher);

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(launcher.mock.calls[0][0]).toMatch(/^mailto:/u);
    expect(result).toEqual({
      deliveryStatus: "not_confirmed",
      recipientCount: 1,
      recipientMode: "to",
      status: "composer_requested"
    });
    expect(result).not.toHaveProperty("sent", true);
  });

  it("redacts a launcher failure that includes the full draft URL and content key", () => {
    let attemptedMailto = "";
    const leakingLauncher = (mailtoUrl: string) => {
      attemptedMailto = mailtoUrl;
      throw new Error(`launcher failed for ${mailtoUrl}`);
    };

    try {
      launchSecureShareEmailDraft({
        expectedOrigin: appOrigin,
        expectedShareId: standardShareId,
        recipients: ["private.viewer@example.com"],
        shareUrl: standardShareUrl
      }, leakingLauncher);
      throw new Error("expected launch failure");
    } catch (error) {
      expect(attemptedMailto).toContain(contentKey);
      expect(error).toMatchObject({ code: "composer_unavailable" });
      expect(String(error)).not.toContain(contentKey);
      expect(String(error)).not.toContain("private.viewer@example.com");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
