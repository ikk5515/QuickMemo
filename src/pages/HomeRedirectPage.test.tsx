import { render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile, UserPreferencesDocument } from "../types";
import HomeRedirectPage from "./HomeRedirectPage";

type HomePreferences = Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView">;

const state = vi.hoisted(() => ({
  cachedPreferences: {
    defaultHome: "notes",
    scheduleDefaultView: "todo"
  } as HomePreferences | null,
  preferences: {
    defaultHome: "notes",
    scheduleDefaultView: "todo"
  } as HomePreferences,
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
    getCachedUserPreferences: () => state.cachedPreferences,
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

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/home"]}>
      <Routes>
        <Route path="/home" element={<HomeRedirectPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("HomeRedirectPage feature access", () => {
  beforeEach(() => {
    state.cachedPreferences = { defaultHome: "notes", scheduleDefaultView: "todo" };
    state.preferences = { defaultHome: "notes", scheduleDefaultView: "todo" };
    state.profile = profile();
  });

  it("opens the file explorer instead of rendering the legacy dashboard", async () => {
    renderHome();

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app?panel=files"));
    expect(screen.queryByText(/작업 공간/)).not.toBeInTheDocument();
  });

  it("falls back from a denied default home to the first granted feature", async () => {
    state.profile = profile({
      featureAccess: { notes: false, library: true, schedule: false }
    });

    renderHome();

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/library"));
  });

  it("preserves the preferred schedule surface", async () => {
    state.cachedPreferences = { defaultHome: "schedule", scheduleDefaultView: "matrix" };
    state.preferences = state.cachedPreferences;

    renderHome();

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/schedule?view=matrix"));
  });

  it("shows a clear non-destructive empty state when all features are denied", () => {
    state.profile = profile({
      featureAccess: { notes: false, library: false, schedule: false }
    });

    renderHome();

    expect(screen.getByRole("status")).toHaveTextContent("사용 가능한 기능이 없습니다");
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });

});
