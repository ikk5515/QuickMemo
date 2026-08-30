import { act, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile, UserPreferencesDocument } from "../types";
import HomeRedirectPage, { HOME_REDIRECT_PREFERENCES_TIMEOUT_MS } from "./HomeRedirectPage";

type HomePreferences = Pick<UserPreferencesDocument, "defaultHome" | "scheduleDefaultView">;

const state = vi.hoisted(() => ({
  cachedPreferences: {
    defaultHome: "notes",
    scheduleDefaultView: "calendar"
  } as HomePreferences | null,
  preferences: {
    defaultHome: "notes",
    scheduleDefaultView: "calendar"
  } as HomePreferences,
  preferencesRequest: null as Promise<HomePreferences> | null,
  profile: null as UserProfile | null
}));
const preloadMocks = vi.hoisted(() => ({
  preloadProtectedRoute: vi.fn()
}));

vi.mock("../components/AppShell", () => ({
  AppShell: ({ children }: PropsWithChildren) => <div data-testid="app-shell">{children}</div>
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: state.profile })
}));

vi.mock("../lib/routePreload", () => preloadMocks);

vi.mock("../services/userPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/userPreferences")>();
  return {
    ...actual,
    getCachedUserPreferences: () => state.cachedPreferences,
    getUserPreferences: vi.fn(() => state.preferencesRequest ?? Promise.resolve(state.preferences))
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
    state.cachedPreferences = { defaultHome: "notes", scheduleDefaultView: "calendar" };
    state.preferences = { defaultHome: "notes", scheduleDefaultView: "calendar" };
    state.preferencesRequest = null;
    state.profile = profile();
    preloadMocks.preloadProtectedRoute.mockClear();
  });

  it("opens the file explorer instead of rendering the legacy dashboard", async () => {
    renderHome();

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app?panel=files"));
    expect(preloadMocks.preloadProtectedRoute).toHaveBeenCalledWith("/app?panel=files", state.profile);
    expect(screen.queryByText(/작업 공간/)).not.toBeInTheDocument();
  });

  it("falls back from a denied default home to the first granted feature", async () => {
    state.profile = profile({
      featureAccess: { notes: false, library: true, schedule: false }
    });

    renderHome();

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/library"));
    expect(preloadMocks.preloadProtectedRoute).toHaveBeenCalledWith("/library", state.profile);
  });

  it("preserves the preferred schedule surface", async () => {
    state.cachedPreferences = { defaultHome: "schedule", scheduleDefaultView: "matrix" };
    state.preferences = state.cachedPreferences;

    renderHome();

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/schedule?view=matrix"));
    expect(preloadMocks.preloadProtectedRoute).toHaveBeenCalledWith("/schedule?view=matrix", state.profile);
  });

  it.each(["todo", "recurring", "completed"] as const)(
    "canonicalizes the legacy %s schedule preference to Calendar",
    async (legacyView) => {
      state.cachedPreferences = { defaultHome: "schedule", scheduleDefaultView: legacyView };
      state.preferences = state.cachedPreferences;

      renderHome();

      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/schedule?view=calendar"));
    }
  );

  it("keeps workspace navigation unavailable until remote preferences resolve", async () => {
    let resolvePreferences!: (preferences: HomePreferences) => void;
    state.cachedPreferences = null;
    state.preferencesRequest = new Promise((resolve) => {
      resolvePreferences = resolve;
    });

    renderHome();

    expect(screen.getByRole("status")).toHaveTextContent("작업공간을 여는 중입니다");
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();

    await act(async () => {
      resolvePreferences(state.preferences);
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app?panel=files"));
  });

  it("opens the safe default workspace when remote preferences stay pending", async () => {
    vi.useFakeTimers();
    try {
      state.cachedPreferences = null;
      state.preferencesRequest = new Promise(() => undefined);

      renderHome();
      expect(screen.getByRole("status")).toHaveTextContent("작업공간을 여는 중입니다");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOME_REDIRECT_PREFERENCES_TIMEOUT_MS);
      });

      expect(screen.getByTestId("location")).toHaveTextContent("/app?panel=files");
    } finally {
      vi.useRealTimers();
    }
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
