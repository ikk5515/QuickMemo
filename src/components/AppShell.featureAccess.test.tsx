import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../types";
import { AppShell } from "./AppShell";

const scheduleOnlyProfile: UserProfile = {
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

const authState = vi.hoisted(() => ({
  privateKey: {} as CryptoKey | null,
  profile: null as UserProfile | null,
  signOut: vi.fn()
}));
const preloadMocks = vi.hoisted(() => ({
  preloadProtectedRoute: vi.fn()
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    changePassword: vi.fn(),
    privateKey: authState.privateKey,
    profile: authState.profile,
    signOut: authState.signOut
  })
}));

vi.mock("../lib/firebase", () => ({
  hasFirebaseConfig: true
}));

vi.mock("../lib/routePreload", () => preloadMocks);

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
  beforeEach(() => {
    authState.privateKey = {} as CryptoKey;
    authState.profile = scheduleOnlyProfile;
    preloadMocks.preloadProtectedRoute.mockClear();
    authState.signOut.mockReset().mockResolvedValue(undefined);
  });

  it("only exposes navigation granted to the current live profile", () => {
    render(
      <MemoryRouter>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(within(navigation).getByRole("link", { name: "일정" })).toHaveAttribute("href", "/schedule");
    expect(within(navigation).queryByRole("link", { name: "메모" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "위키" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "자료실" })).not.toBeInTheDocument();
  });

  it("preloads an authorized route on pointer and keyboard intent", () => {
    render(
      <MemoryRouter>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    const scheduleLink = within(navigation).getByRole("link", { name: "일정" });

    fireEvent.pointerEnter(scheduleLink);
    fireEvent.focus(scheduleLink);

    expect(preloadMocks.preloadProtectedRoute).toHaveBeenNthCalledWith(
      1,
      "/schedule",
      scheduleOnlyProfile
    );
    expect(preloadMocks.preloadProtectedRoute).toHaveBeenNthCalledWith(
      2,
      "/schedule",
      scheduleOnlyProfile
    );
  });

  it("opens the labeled workspace drawer and restores focus after Escape", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const trigger = screen.getByRole("button", { name: "작업공간 메뉴 열기" });
    await user.click(trigger);

    const drawer = screen.getByRole("dialog", { name: "QuickMemo 작업공간 메뉴" });
    expect(within(drawer).getByRole("navigation", { name: "작업공간 이동" })).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "QuickMemo 작업공간 메뉴" })).not.toBeInTheDocument();
  });

  it("keeps legacy deep links under the single memo destination", () => {
    authState.profile = {
      ...scheduleOnlyProfile,
      featureAccess: { notes: true, library: false, schedule: false }
    };

    render(
      <MemoryRouter initialEntries={["/app?view=graph"]}>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(within(navigation).queryByRole("button", { name: /그래프/ })).not.toBeInTheDocument();
    expect(within(navigation).getAllByRole("link")).toHaveLength(2);
    expect(within(navigation).getByRole("link", { name: "위키" })).toHaveAttribute("href", "/wiki");
    expect(within(navigation).getByRole("link", { name: "메모" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the mobile password action named and contains focus until the dialog closes", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const menuTrigger = screen.getByRole("button", { name: "작업공간 메뉴 열기" });
    await user.click(menuTrigger);
    const trigger = screen.getByRole("button", { name: "비밀번호 변경" });
    expect(trigger).toHaveAttribute("aria-label", "비밀번호 변경");
    expect(trigger).toHaveAttribute("title", "비밀번호 변경");

    await user.click(trigger);

    const currentPassword = screen.getByLabelText("현재 비밀번호");
    const closeButton = screen.getByRole("button", { name: "비밀번호 변경 닫기" });
    await waitFor(() => expect(currentPassword).toHaveFocus());

    closeButton.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "변경" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(menuTrigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "비밀번호 변경" })).not.toBeInTheDocument();
  });

  it("wraps settings focus and restores the settings trigger", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AppShell>
          <span>내용</span>
        </AppShell>
      </MemoryRouter>
    );

    const menuTrigger = screen.getByRole("button", { name: "작업공간 메뉴 열기" });
    await user.click(menuTrigger);
    const trigger = screen.getByRole("button", { name: "설정" });
    await user.click(trigger);

    const closeButton = screen.getByRole("button", { name: "설정 닫기" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    const lastMatrixLabel = screen.getByLabelText(/^대기 업무/);
    lastMatrixLabel.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("keeps admin and account actions in the drawer while primary destinations stay readable", async () => {
    const user = userEvent.setup();
    authState.profile = {
      ...scheduleOnlyProfile,
      isAdmin: true,
      featureAccess: { notes: true, schedule: true, library: true }
    };
    render(<MemoryRouter><AppShell><span>내용</span></AppShell></MemoryRouter>);

    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual(["메모", "위키", "일정", "자료실"]);
    expect(screen.queryByRole("link", { name: "관리자" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "로그아웃" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "작업공간 메뉴 열기" }));
    const drawer = screen.getByRole("dialog", { name: "QuickMemo 작업공간 메뉴" });
    expect(within(drawer).getByRole("link", { name: "관리자" })).toHaveAttribute("href", "/admin");
    expect(within(drawer).getByRole("button", { name: "로그아웃" })).toBeVisible();
  });

  it("waits for pending-save approval before signing out from the account drawer", async () => {
    const user = userEvent.setup();
    const onBeforeExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<MemoryRouter><AppShell onBeforeExit={onBeforeExit}><span>내용</span></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "작업공간 메뉴 열기" }));
    await user.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(onBeforeExit).toHaveBeenCalledOnce();
    expect(authState.signOut).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(authState.signOut).toHaveBeenCalledOnce());
  });

});
