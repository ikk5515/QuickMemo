import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../types";
import { AppShell } from "./AppShell";

const profile: UserProfile = {
  uid: "user-a",
  displayName: "사용자",
  avatarText: "사",
  color: "#2f7d70",
  order: 1,
  quickKey: 1,
  loginEmail: "user-a@quickmemo.local",
  isActive: true,
  isAdmin: false,
  role: "user",
  publicKeyJwk: {},
  featureAccess: { notes: false, library: false, schedule: true }
};

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    changePassword: vi.fn(),
    profile,
    signOut: vi.fn()
  })
}));

vi.mock("../lib/firebase", () => ({
  hasFirebaseConfig: true
}));

vi.mock("../services/userPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/userPreferences")>();
  return {
    ...actual,
    getCachedUserPreferences: () => null,
    saveUserPreferences: vi.fn(async () => undefined),
    subscribeUserPreferences: () => vi.fn()
  };
});

describe("AppShell feature navigation", () => {
  it("only exposes navigation granted to the current live profile", () => {
    render(
      <MemoryRouter>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(navigation).toHaveTextContent("일정관리");
    expect(navigation).not.toHaveTextContent("노트");
    expect(navigation).not.toHaveTextContent("자료실");
  });
});
