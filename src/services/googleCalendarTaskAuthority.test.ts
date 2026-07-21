import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoogleCalendarTaskAuthority } from "./googleCalendar";
import { inspectGoogleCalendarTaskAuthority } from "./googleCalendarTaskAuthority";

vi.mock("./googleCalendar", () => ({
  getGoogleCalendarTaskAuthority: vi.fn()
}));

const input = {
  id: "task-a",
  ownerUid: "user-a",
  revision: "001753142400.000000007"
};

describe("Google Calendar task authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["current", "deleted", "stale", "undated"] as const)(
    "uses the server-clock authority result: %s",
    async (state) => {
      vi.mocked(getGoogleCalendarTaskAuthority).mockResolvedValue(state);

      await expect(inspectGoogleCalendarTaskAuthority(input)).resolves.toBe(state);
      expect(getGoogleCalendarTaskAuthority).toHaveBeenCalledWith(input);
    }
  );

  it("fails closed when the authoritative server check is unavailable", async () => {
    vi.mocked(getGoogleCalendarTaskAuthority).mockRejectedValue(new Error("authority unavailable"));

    await expect(inspectGoogleCalendarTaskAuthority(input)).rejects.toThrow("authority unavailable");
  });
});
