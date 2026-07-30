import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../types";
import {
  adminTabIds,
  AdminTabs,
  editableUserDraft,
  EditableUserCard,
  FeatureAccessFields,
  stableEditableSignature,
  type AdminTab,
  updatePayloadFromDraft
} from "./AdminPage";

const { updateUserMock } = vi.hoisted(() => ({
  updateUserMock: vi.fn()
}));
const adminPageSource = readFileSync(join(process.cwd(), "src/pages/AdminPage.tsx"), "utf8");

function AdminTabsHarness() {
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  return <AdminTabs activeTab={activeTab} onSelect={setActiveTab} />;
}

vi.mock("../services/adminFunctions", () => ({
  createUser: vi.fn(),
  deleteManagedUserDocuments: vi.fn(),
  updateUser: updateUserMock
}));

function userProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    uid: "user-a",
    displayName: "사용자",
    avatarText: "U",
    color: "#2f7d70",
    order: 1,
    quickKey: 7,
    loginEmail: "user-a@quickmemo.local",
    isActive: true,
    isAdmin: false,
    role: "user",
    publicKeyJwk: { kty: "RSA" },
    allowedShareTargetUids: ["user-a"],
    ...overrides
  };
}

describe("AdminPage feature access editing", () => {
  beforeEach(() => {
    updateUserMock.mockReset();
  });

  it("materializes legacy users as fully enabled without making the draft dirty", () => {
    const legacy = userProfile();
    const draft = editableUserDraft(legacy);

    expect(draft.featureAccess).toEqual({ notes: true, library: true, schedule: true });
    expect(stableEditableSignature(draft)).toBe(stableEditableSignature(legacy));
  });

  it("includes the complete feature map in autosave signatures and update payloads", () => {
    const enabled = editableUserDraft(userProfile());
    const restricted = editableUserDraft(userProfile({
      featureAccess: { notes: true, library: false, schedule: true }
    }));

    expect(stableEditableSignature(restricted)).not.toBe(stableEditableSignature(enabled));
    expect(updatePayloadFromDraft(restricted).featureAccess).toEqual({
      notes: true,
      library: false,
      schedule: true
    });
  });

  it("forces administrators to a fully enabled editable profile", () => {
    const draft = editableUserDraft(userProfile({
      isAdmin: true,
      role: "admin",
      featureAccess: { notes: false, library: false, schedule: false }
    }));

    expect(draft.featureAccess).toEqual({ notes: true, library: true, schedule: true });
    expect(updatePayloadFromDraft(draft).featureAccess).toEqual({ notes: true, library: true, schedule: true });
  });

  it("exposes named checkboxes and reports the changed feature", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    render(
      <FeatureAccessFields
        access={{ notes: true, library: false, schedule: true }}
        disabled={false}
        onToggle={onToggle}
      />
    );

    expect(screen.getByRole("group", { name: "사용 기능" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "노트" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "자료실" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "일정관리" })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "자료실" }));
    expect(onToggle).toHaveBeenCalledWith("library", true);
  });

  it("disables administrator feature controls", () => {
    render(
      <FeatureAccessFields
        access={{ notes: true, library: true, schedule: true }}
        disabled
        onToggle={vi.fn()}
      />
    );

    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
    }
    expect(screen.getByText("관리자는 계정 운영을 위해 모든 기능을 사용합니다.")).toBeInTheDocument();
  });

  it("blocks the signed-in administrator from demoting or deactivating itself", () => {
    const profile = userProfile({
      uid: "admin-a",
      isAdmin: true,
      role: "admin"
    });

    render(
      <EditableUserCard
        activeAdminCount={1}
        currentUid="admin-a"
        index={0}
        total={1}
        user={profile}
        users={[profile]}
      />
    );

    expect(screen.getByRole("checkbox", { name: "관리자" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "활성" })).toBeDisabled();
    expect(
      screen.getByText("현재 로그인한 관리자의 관리자·활성 상태는 다른 관리자가 변경할 수 있습니다.")
    ).toBeInTheDocument();
  });

  it("loads and decrypts the full admin note collection only on the notes tab", () => {
    const subscriptionEffect = adminPageSource.match(
      /useEffect\(\(\) => \{\n {4}if \(!profile\?\.isAdmin[\s\S]*?\}, \[activeAdminTab, profile\?\.isAdmin\]\);/u
    )?.[0] ?? "";
    const decryptEffect = adminPageSource.match(
      /useEffect\(\(\) => \{\n {4}let cancelled = false;[\s\S]*?\}, \[activeAdminTab, notes, privateKey, profile\]\);/u
    )?.[0] ?? "";

    expect(subscriptionEffect).toContain('activeAdminTab !== "notes"');
    expect(subscriptionEffect).toContain("subscribeAllNotesForAdmin");
    expect(decryptEffect).toContain('if (activeAdminTab !== "notes")');
    expect(decryptEffect).toContain("setAdminNoteViews([])");
  });

  it("exposes the protected Gmail SMTP settings as a dedicated admin tab", () => {
    expect(adminPageSource).toContain('export type AdminTab = "create" | "users" | "notes" | "email"');
    expect(adminTabIds.email).toEqual({
      panelId: "admin-email-settings-panel",
      tabId: "admin-email-settings-tab"
    });
    expect(adminPageSource).toContain('activeAdminTab === "email" && <AdminEmailSettingsPanel />');
  });

  it("links every admin tab to its panel and keeps only the selected tab tabbable", () => {
    render(<AdminTabsHarness />);

    const expectedTabs: Array<[AdminTab, string]> = [
      ["create", "사용자 추가"],
      ["users", "사용자 목록"],
      ["notes", "노트 관리"],
      ["email", "이메일 설정"]
    ];

    for (const [tab, label] of expectedTabs) {
      const element = screen.getByRole("tab", { name: label });
      expect(element).toHaveAttribute("id", adminTabIds[tab].tabId);
      expect(element).toHaveAttribute("aria-controls", adminTabIds[tab].panelId);
      expect(element).toHaveAttribute("tabindex", tab === "users" ? "0" : "-1");
      expect(element).toHaveAttribute("aria-selected", tab === "users" ? "true" : "false");
    }

    for (const tab of ["create", "users", "notes"] as const) {
      expect(adminPageSource).toContain(`aria-labelledby={adminTabIds.${tab}.tabId}`);
      expect(adminPageSource).toContain(`id={adminTabIds.${tab}.panelId}`);
    }
  });

  it("moves and activates admin tabs with ArrowLeft, ArrowRight, Home, and End", async () => {
    const user = userEvent.setup();
    render(<AdminTabsHarness />);

    const createTab = screen.getByRole("tab", { name: "사용자 추가" });
    const usersTab = screen.getByRole("tab", { name: "사용자 목록" });
    const notesTab = screen.getByRole("tab", { name: "노트 관리" });
    const emailTab = screen.getByRole("tab", { name: "이메일 설정" });

    usersTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(notesTab).toHaveFocus();
    expect(notesTab).toHaveAttribute("aria-selected", "true");
    expect(notesTab).toHaveAttribute("tabindex", "0");
    expect(usersTab).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(emailTab).toHaveFocus();
    expect(emailTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    expect(createTab).toHaveFocus();
    expect(createTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowLeft}");
    expect(emailTab).toHaveFocus();

    await user.keyboard("{Home}");
    expect(createTab).toHaveFocus();
    expect(createTab).toHaveAttribute("tabindex", "0");
  });

  it("이전 권한 저장 중 다시 원래 선택으로 돌려도 마지막 선택을 후속 저장한다", async () => {
    let resolveFirstSave: (() => void) | undefined;
    updateUserMock
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    const profile = userProfile({
      featureAccess: { notes: true, library: true, schedule: true }
    });

    render(
      <EditableUserCard
        activeAdminCount={1}
        currentUid="admin-a"
        index={0}
        total={1}
        user={profile}
        users={[profile]}
      />
    );

    const notesCheckbox = screen.getByRole("checkbox", { name: "노트" });
    await user.click(notesCheckbox);
    await waitFor(() => expect(updateUserMock).toHaveBeenCalledTimes(1));
    expect(updateUserMock.mock.calls[0]?.[0].featureAccess.notes).toBe(false);

    await user.click(notesCheckbox);
    expect(notesCheckbox).toBeChecked();
    resolveFirstSave?.();

    await waitFor(() => expect(updateUserMock).toHaveBeenCalledTimes(2));
    expect(updateUserMock.mock.calls[1]?.[0].featureAccess.notes).toBe(true);
  });
});
