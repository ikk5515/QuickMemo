import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import { VaultParticipantShareDialog } from "./VaultParticipantShareDialog";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    allowedShareTargetUids: ["user-b", "user-c"],
    avatarText: "A",
    color: "#334155",
    displayName: "사용자 A",
    featureAccess: { library: true, notes: true, schedule: true },
    isActive: true,
    isAdmin: false,
    loginEmail: "user-a@example.com",
    order: 0,
    publicKeyJwk: { e: "AQAB", kty: "RSA", n: "public-key" },
    quickKey: 1,
    role: "user",
    uid: "user-a",
    ...overrides
  };
}

function note(overrides: Partial<DecryptedVaultNote> = {}): DecryptedVaultNote {
  return {
    body: "# 본문",
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: null,
    id: "note-a1",
    isDeleted: false,
    ownerUid: "user-a",
    participantUids: ["user-a"],
    revision: 4,
    title: "공유할 노트",
    type: "personal",
    updatedBy: "user-a",
    wrappedKeys: {
      "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "owner-key" }
    },
    ...overrides
  };
}

type DialogProps = ComponentProps<typeof VaultParticipantShareDialog>;

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const owner = profile();
  const props: DialogProps = {
    note: note(),
    onClose: vi.fn(),
    onUpdated: vi.fn(),
    privateKey: {} as CryptoKey,
    profile: owner,
    users: [
      owner,
      profile({ avatarText: "B", displayName: "사용자 B", uid: "user-b" }),
      profile({ avatarText: "C", displayName: "사용자 C", uid: "user-c" })
    ],
    ...overrides
  };
  return { ...render(<VaultParticipantShareDialog {...props} />), props };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("VaultParticipantShareDialog", () => {
  it("blocks new participants for asset embeds but permits only a complete existing-share removal", async () => {
    const user = userEvent.setup();
    const owner = profile();
    const existing = profile({ avatarText: "B", displayName: "사용자 B", uid: "user-b" });
    const newTarget = profile({ avatarText: "C", displayName: "사용자 C", uid: "user-c" });
    renderDialog({
      hasUnsharedAssetEmbeds: true,
      note: note({ participantUids: ["user-a", "user-b"], type: "shared" }),
      profile: owner,
      users: [owner, existing, newTarget]
    });

    expect(screen.getByRole("alert")).toHaveTextContent("새 사용자를 추가할 수 없습니다");
    const existingCheckbox = screen.getByRole("checkbox", { name: /사용자 B/ });
    const newCheckbox = screen.getByRole("checkbox", { name: /사용자 C/ });
    const saveButton = screen.getByRole("button", { name: "공유 대상 저장" });

    expect(existingCheckbox).toBeChecked();
    expect(existingCheckbox).toBeEnabled();
    expect(newCheckbox).not.toBeChecked();
    expect(newCheckbox).toBeDisabled();
    expect(saveButton).toBeDisabled();

    await user.click(existingCheckbox);
    expect(existingCheckbox).not.toBeChecked();
    expect(saveButton).toBeEnabled();
  });

  it("renders an unavailable existing participant as removable but never addable again", async () => {
    const user = userEvent.setup();
    const owner = profile({ allowedShareTargetUids: [] });
    const unavailable = profile({
      avatarText: "B",
      displayName: "비활성 사용자 B",
      isActive: false,
      uid: "user-b"
    });
    renderDialog({
      note: note({ participantUids: ["user-a", "user-b"], type: "shared" }),
      profile: owner,
      users: [owner, unavailable]
    });

    expect(screen.getByText("현재 허용 대상이 아님 · 공유 해제만 가능")).toBeInTheDocument();
    const unavailableCheckbox = screen.getByRole("checkbox", { name: /비활성 사용자 B/ });
    const saveButton = screen.getByRole("button", { name: "공유 대상 저장" });
    expect(unavailableCheckbox).toBeChecked();
    expect(unavailableCheckbox).toBeEnabled();
    expect(saveButton).toBeDisabled();

    await user.click(unavailableCheckbox);
    expect(unavailableCheckbox).not.toBeChecked();
    expect(saveButton).toBeEnabled();
  });
});
