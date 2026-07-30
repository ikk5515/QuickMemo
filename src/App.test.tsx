import { render, screen } from "@testing-library/react";
import type { User } from "firebase/auth";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "./types";
import App, { RequireAuth } from "./App";

const authState = vi.hoisted(() => ({
  firebaseUser: { uid: "user-a" } as User | null,
  loading: false,
  profile: null as UserProfile | null
}));
const recoveryMocks = vi.hoisted(() => ({
  reapStaleSecureShareCopyJobs: vi.fn(async () => ({
    aborted: 0,
    activated: 0,
    retained: 0,
    scanned: 0
  }))
}));

vi.mock("./context/AuthContext", () => ({
  useAuth: () => authState
}));
vi.mock("./services/secureShareCopyJobs", () => recoveryMocks);

vi.mock("./pages/HomeRedirectPage", () => ({ default: () => <span>홈 화면</span> }));
vi.mock("./pages/LibraryPage", () => ({ default: () => <span>자료실 화면</span> }));
vi.mock("./pages/NotesPage", () => ({ default: () => <span>노트 화면</span> }));
vi.mock("./pages/PublicSharePage", () => ({ default: () => <span>보안 공유 화면</span> }));
vi.mock("./pages/RecurringPage", () => ({ default: () => <span>반복 업무 화면</span> }));
vi.mock("./pages/SchedulePage", () => ({ default: () => <span>일정 화면</span> }));

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
  return (
    <>
      <span data-testid="location">{location.pathname}{location.hash}</span>
      <span data-testid="location-state">{location.state === null ? "" : JSON.stringify(location.state)}</span>
    </>
  );
}

function renderGuard(feature: "notes" | "library" | "schedule") {
  return render(
    <MemoryRouter initialEntries={[`/${feature}`]}>
      <LocationProbe />
      <Routes>
        <Route
          path="*"
          element={
            <RequireAuth feature={feature}>
              <span>보호된 기능</span>
            </RequireAuth>
          }
        />
        <Route path="/home" element={<span>홈</span>} />
        <Route path="/login" element={<span>로그인</span>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RequireAuth feature access", () => {
  beforeEach(() => {
    recoveryMocks.reapStaleSecureShareCopyJobs.mockClear();
    authState.firebaseUser = { uid: "user-a" } as User;
    authState.loading = false;
    authState.profile = profile();
  });

  it("starts durable stale-copy recovery for an authenticated notes user", async () => {
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
    expect(recoveryMocks.reapStaleSecureShareCopyJobs).toHaveBeenCalledWith("user-a");
  });

  it("keeps legacy profiles compatible", () => {
    renderGuard("notes");
    expect(screen.getByText("보호된 기능")).toBeInTheDocument();
  });

  it("redirects a denied direct feature URL to the safe home", () => {
    authState.profile = profile({
      featureAccess: { notes: true, library: false, schedule: true }
    });

    renderGuard("library");
    expect(screen.getByTestId("location")).toHaveTextContent("/home");
    expect(screen.getByText("홈")).toBeInTheDocument();
  });

  it("reacts immediately when a live profile update revokes access", () => {
    authState.profile = profile({
      featureAccess: { notes: true, library: true, schedule: true }
    });
    const view = renderGuard("schedule");
    expect(screen.getByText("보호된 기능")).toBeInTheDocument();

    authState.profile = profile({
      featureAccess: { notes: true, library: true, schedule: false }
    });
    view.rerender(
      <MemoryRouter initialEntries={["/schedule"]}>
        <LocationProbe />
        <Routes>
          <Route
            path="*"
            element={
              <RequireAuth feature="schedule">
                <span>보호된 기능</span>
              </RequireAuth>
            }
          />
          <Route path="/home" element={<span>홈</span>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("홈")).toBeInTheDocument();
  });

  it("prevents a permission map from locking an administrator out", () => {
    authState.profile = profile({
      isAdmin: true,
      role: "admin",
      featureAccess: { notes: false, library: false, schedule: false }
    });

    renderGuard("schedule");
    expect(screen.getByText("보호된 기능")).toBeInTheDocument();
  });

  it.each([
    ["/app", { notes: true, library: false, schedule: false }, "노트 화면"],
    ["/library", { notes: false, library: true, schedule: false }, "자료실 화면"],
    ["/schedule", { notes: false, library: false, schedule: true }, "일정 화면"],
    ["/schedule/recurring", { notes: false, library: false, schedule: true }, "반복 업무 화면"]
  ] as const)("maps %s to its matching feature gate", async (path, featureAccess, expectedText) => {
    authState.profile = profile({ featureAccess: { ...featureAccess } });

    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText(expectedText)).toBeInTheDocument();
  });

  it.each([
    "/share/ss2_existing_share_123456",
    "/s/Abcdefghijklmnopqrstuvwx"
  ])("routes %s to the public share page without authentication", async (path) => {
    authState.firebaseUser = null;
    authState.profile = null;

    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("보안 공유 화면")).toBeInTheDocument();
  });

  it("keeps the safe home available when every feature is denied", async () => {
    authState.profile = profile({
      featureAccess: { notes: false, library: false, schedule: false }
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
  });

  it("preserves only a validated library capture fragment across the login redirect", () => {
    const nonce = "A".repeat(43);
    const extensionId = "a".repeat(32);
    authState.firebaseUser = null;
    authState.profile = null;

    render(
      <MemoryRouter initialEntries={[`/library#capture=${nonce}&extension=${extensionId}`]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/library"
            element={<RequireAuth feature="library"><span>자료실</span></RequireAuth>}
          />
          <Route path="/login" element={<span>로그인</span>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
    expect(screen.getByTestId("location-state")).toHaveTextContent(
      JSON.stringify({
        returnTo: "/library",
        captureFragment: `#capture=${nonce}&extension=${extensionId}`
      })
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("body");
  });

  it("preserves a nonce-only Safari bookmarklet marker across the fixed login route", () => {
    const nonce = "B".repeat(43);
    authState.firebaseUser = null;
    authState.profile = null;

    render(
      <MemoryRouter initialEntries={[`/library#capture=${nonce}&source=bookmarklet`]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/library"
            element={<RequireAuth feature="library"><span>자료실</span></RequireAuth>}
          />
          <Route path="/login" element={<span>로그인</span>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
    expect(screen.getByTestId("location-state")).toHaveTextContent(
      JSON.stringify({
        returnTo: "/library",
        captureFragment: `#capture=${nonce}&source=bookmarklet`
      })
    );
    expect(screen.getByTestId("location-state")).not.toHaveTextContent("title");
    expect(screen.getByTestId("location-state")).not.toHaveTextContent("body");
  });

  it("drops malformed or body-bearing capture fragments at the login boundary", () => {
    const nonce = "A".repeat(43);
    const extensionId = "a".repeat(32);
    authState.firebaseUser = null;
    authState.profile = null;

    render(
      <MemoryRouter initialEntries={[`/library#capture=${nonce}&extension=${extensionId}&body=secret`]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/library"
            element={<RequireAuth feature="library"><span>자료실</span></RequireAuth>}
          />
          <Route path="/login" element={<span>로그인</span>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
    expect(screen.getByTestId("location-state")).toBeEmptyDOMElement();
  });
});
