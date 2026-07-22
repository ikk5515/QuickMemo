import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../types";
import {
  editableUserDraft,
  EditableUserCard,
  FeatureAccessFields,
  stableEditableSignature,
  updatePayloadFromDraft
} from "./AdminPage";

const { updateUserMock } = vi.hoisted(() => ({
  updateUserMock: vi.fn()
}));

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
