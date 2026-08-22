import { render, screen, waitFor, within } from "@testing-library/react";
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
  profile: null as UserProfile | null
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    changePassword: vi.fn(),
    privateKey: authState.privateKey,
    profile: authState.profile,
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
  beforeEach(() => {
    authState.privateKey = {} as CryptoKey;
    authState.profile = scheduleOnlyProfile;
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
    expect(within(navigation).getByRole("link", { name: "일정관리" })).toHaveAttribute("href", "/schedule");
    expect(within(navigation).queryByRole("link", { name: /파일 탐색기|노트 검색/ })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "자료실" })).not.toBeInTheDocument();
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

  it("keeps the unverified Graph surface disabled without marking it active", () => {
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
    expect(within(navigation).getByRole("button", { name: "그래프 보기 (비활성)" })).toBeDisabled();
    expect(within(navigation).getByRole("link", { name: "파일 탐색기" })).toHaveAttribute("aria-current", "page");
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
    await waitFor(() => expect(trigger).toHaveFocus());
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

    const trigger = screen.getByRole("button", { name: "설정" });
    await user.click(trigger);

    const closeButton = screen.getByRole("button", { name: "설정 닫기" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    const lastMatrixLabel = screen.getByLabelText(/^대기 업무/);
    lastMatrixLabel.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
