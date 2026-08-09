import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
