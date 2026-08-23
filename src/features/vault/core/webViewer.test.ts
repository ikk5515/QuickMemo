import { describe, expect, it } from "vitest";
import { safeWebViewerUrl } from "./webViewer";

describe("Web viewer URL boundary", () => {
  it("accepts only credential-free public http and https URLs", () => {
    expect(safeWebViewerUrl("https://example.com/docs?q=1")).toBe("https://example.com/docs?q=1");
    expect(safeWebViewerUrl("http://example.com")).toBe("http://example.com/");
    expect(safeWebViewerUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebViewerUrl("data:text/html,bad")).toBeNull();
    expect(safeWebViewerUrl("https://user:pass@example.com")).toBeNull();
  });

  it("blocks loopback, link-local and private network targets", () => {
    for (const value of [
      "http://localhost:8080",
      "http://x.localhost",
      "http://printer.local",
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://169.254.169.254",
      "http://172.16.0.1",
      "http://192.168.1.1",
      "http://[::1]",
      "http://[fd00::1]",
      "http://[::ffff:127.0.0.1]"
    ]) {
      expect(safeWebViewerUrl(value), value).toBeNull();
    }
  });
});
