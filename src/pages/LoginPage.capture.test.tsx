import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User } from "firebase/auth";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicRosterUser, UserProfile } from "../types";
import LoginPage from "./LoginPage";

const mocks = vi.hoisted(() => ({
  firebaseUser: null as User | null,
  loginRosterUser: vi.fn(),
  profile: null as UserProfile | null,
  subscribeRoster: vi.fn()
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    firebaseUser: mocks.firebaseUser,
    loginRosterUser: mocks.loginRosterUser,
    profile: mocks.profile
  })
}));

vi.mock("../services/users", () => ({
  subscribeRoster: mocks.subscribeRoster
}));

const rosterUser: PublicRosterUser = {
  uid: "user-a",
  displayName: "사용자",
  avatarText: "사",
  color: "#2f7d70",
  order: 1,
  quickKey: 1,
  loginEmail: "user-a@quickmemo.local",
  isActive: true,
  isAdmin: false
};

const userProfile: UserProfile = {
  ...rosterUser,
  role: "user",
  publicKeyJwk: {}
};

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <span data-testid="location">{location.pathname}{location.hash}</span>
      <span data-testid="location-state">{location.state === null ? "" : JSON.stringify(location.state)}</span>
    </>
  );
}

function renderLogin(initialEntry: Parameters<typeof MemoryRouter>[0]["initialEntries"]) {
  return render(
    <MemoryRouter initialEntries={initialEntry}>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/library" element={<span>자료실</span>} />
        <Route path="/home" element={<span>홈</span>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LoginPage library capture handoff", () => {
  beforeEach(() => {
    mocks.firebaseUser = null;
    mocks.profile = null;
    mocks.loginRosterUser.mockReset().mockResolvedValue(userProfile);
    mocks.subscribeRoster.mockReset().mockImplementation((onNext: (users: PublicRosterUser[]) => void) => {
      onNext([rosterUser]);
      return vi.fn();
    });
  });

  it("returns a validated state handoff to the fixed library route after login", async () => {
    const user = userEvent.setup();
    const nonce = "A".repeat(43);
    const extensionId = "a".repeat(32);
    renderLogin([{
      pathname: "/login",
      state: {
        returnTo: "/library",
        captureFragment: `#capture=${nonce}&extension=${extensionId}`
      }
    }]);

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
    await user.click(await screen.findByRole("button", { name: "사용자 사용자 선택" }));
    await user.type(screen.getByLabelText("비밀번호"), "password");
    await user.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/library#capture=${nonce}&extension=${extensionId}`
      );
    });
    expect(screen.getByTestId("location-state")).toBeEmptyDOMElement();
    expect(mocks.loginRosterUser).toHaveBeenCalledWith(rosterUser, "password");
  });

  it.each([
    {
      returnTo: "https://evil.example",
      captureFragment: `#capture=${"A".repeat(43)}&extension=${"a".repeat(32)}`
    },
    {
      returnTo: "/admin",
      captureFragment: `#capture=${"A".repeat(43)}&extension=${"a".repeat(32)}`
    },
    { returnTo: "/library", captureFragment: "#capture=invalid", body: "secret" }
  ])("never redirects to a path supplied by malformed or arbitrary state", async (state) => {
    const user = userEvent.setup();
    renderLogin([{ pathname: "/login", state }]);

    await user.click(await screen.findByRole("button", { name: "사용자 사용자 선택" }));
    await user.type(screen.getByLabelText("비밀번호"), "password");
    await user.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/home$/);
    });
  });

  it("clears a directly supplied login hash instead of treating it as a handoff", async () => {
    const nonce = "A".repeat(43);
    const extensionId = "a".repeat(32);
    renderLogin([`/login#capture=${nonce}&extension=${extensionId}`]);

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/);
    });
  });
});
