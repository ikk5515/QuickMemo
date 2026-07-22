import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile, UserPreferencesDocument } from "../types";
import HomeRedirectPage from "./HomeRedirectPage";

const state = vi.hoisted(() => ({
  preferences: {
    defaultHome: "notes",
    scheduleDefaultView: "todo"
  } as Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView">,
  profile: null as UserProfile | null
}));

vi.mock("../components/AppShell", () => ({
  AppShell: ({ children }: PropsWithChildren) => <div>{children}</div>
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: state.profile })
}));

vi.mock("../services/userPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/userPreferences")>();
  return {
    ...actual,
    getCachedUserPreferences: () => state.preferences,
    getUserPreferences: vi.fn(async () => state.preferences)
  };
});

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
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
    ...overrides
  };
}

describe("HomeRedirectPage feature access", () => {
  beforeEach(() => {
    state.preferences = { defaultHome: "notes", scheduleDefaultView: "todo" };
    state.profile = profile();
  });

  it("falls back from a denied default home and only renders granted cards", () => {
    state.profile = profile({
      featureAccess: { notes: false, library: true, schedule: false }
    });

    render(
      <MemoryRouter>
        <HomeRedirectPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /작업 시작/ })).toHaveAttribute("href", "/library");
    expect(screen.getByRole("link", { name: /자료실/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /노트 작업/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /일정관리/ })).not.toBeInTheDocument();
  });

  it("shows a clear non-destructive empty state when all features are denied", () => {
    state.profile = profile({
      featureAccess: { notes: false, library: false, schedule: false }
    });

    render(
      <MemoryRouter>
        <HomeRedirectPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("status")).toHaveTextContent("사용 가능한 기능이 없습니다");
    expect(screen.queryByRole("link", { name: /작업 시작/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /노트 작업|자료실|일정관리/ })).not.toBeInTheDocument();
  });
});
