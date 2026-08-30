import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";

const regionMocks = vi.hoisted(() => ({
  accessAllowed: true,
  onOpenLibrary: vi.fn(),
  useAttachments: vi.fn(() => ({
    attachments: [],
    error: "",
    loading: false,
    reservedCount: 0
  }))
}));

vi.mock("./useVaultNoteAttachments", () => ({
  useVaultNoteAttachments: regionMocks.useAttachments
}));

vi.mock("./vaultNoteAttachmentAccess", () => ({
  vaultNoteAttachmentAccess: () => regionMocks.accessAllowed
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: "denied" }
}));

vi.mock("./VaultNoteAttachmentsDialog", () => ({
  default: ({
    onClose,
    onOpenLibrary,
    returnFocusTo
  }: {
    onClose: () => void;
    onOpenLibrary: () => void;
    returnFocusTo: HTMLElement | null;
  }) => (
    <div aria-label="첨부파일 관리" data-return-focus={String(Boolean(returnFocusTo))} role="dialog">
      <button onClick={onClose} type="button">닫기</button>
      <button onClick={onOpenLibrary} type="button">자료실</button>
    </div>
  )
}));

import { VaultNoteAttachmentsRegion } from "./VaultNoteAttachmentsRegion";

const profile: UserProfile = {
  avatarText: "테",
  color: "#2f7d70",
  displayName: "테스트 사용자",
  featureAccess: { library: true, notes: true, schedule: true },
  isActive: true,
  isAdmin: false,
  loginEmail: "test@example.com",
  order: 1,
  publicKeyJwk: {},
  quickKey: 1,
  role: "user",
  uid: "user-a"
};

const note: DecryptedVaultNote = {
  body: "# 본문",
  contentFormat: "markdown-v1",
  encryptedBody: { algorithm: "AES-GCM", cipherText: "body", iv: "iv", version: 1 },
  encryptedTitle: { algorithm: "AES-GCM", cipherText: "title", iv: "iv", version: 1 },
  entryKind: "markdown",
  folderId: null,
  id: "note-a",
  isDeleted: false,
  ownerUid: "user-a",
  participantUids: ["user-a"],
  revision: 1,
  title: "첨부 노트",
  type: "personal",
  updatedBy: "user-a",
  wrappedKeys: {
    "user-a": { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped" }
  }
};

beforeEach(() => {
  regionMocks.accessAllowed = true;
  regionMocks.onOpenLibrary.mockReset();
  regionMocks.useAttachments.mockClear();
});

describe("VaultNoteAttachmentsRegion", () => {
  it("owns one metadata state and opens the lazy dialog from the inline shelf", async () => {
    render(
      <VaultNoteAttachmentsRegion
        disabled={false}
        note={note}
        onOpenLibrary={regionMocks.onOpenLibrary}
        privateKey={{} as CryptoKey}
        profile={profile}
      />
    );

    expect(regionMocks.useAttachments).toHaveBeenCalledWith("note-a");
    await userEvent.click(screen.getByRole("button", { name: "노트에 파일 추가" }));
    const dialog = await screen.findByRole("dialog", { name: "첨부파일 관리" });
    expect(dialog).toHaveAttribute("data-return-focus", "true");
    await userEvent.click(screen.getByRole("button", { name: "자료실" }));
    expect(regionMocks.onOpenLibrary).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨부파일 관리" })).not.toBeInTheDocument());
  });

  it("fails closed without starting a note listener when access is denied", () => {
    regionMocks.accessAllowed = false;
    render(
      <VaultNoteAttachmentsRegion
        disabled={false}
        note={note}
        onOpenLibrary={regionMocks.onOpenLibrary}
        privateKey={{} as CryptoKey}
        profile={profile}
      />
    );

    expect(regionMocks.useAttachments).toHaveBeenCalledWith(null);
    expect(screen.queryByLabelText("노트 첨부파일")).not.toBeInTheDocument();
  });

  it("discards an open dialog when access changes without a note remount", async () => {
    const { rerender } = render(
      <VaultNoteAttachmentsRegion
        disabled={false}
        note={note}
        onOpenLibrary={regionMocks.onOpenLibrary}
        privateKey={{} as CryptoKey}
        profile={profile}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "노트에 파일 추가" }));
    await screen.findByRole("dialog", { name: "첨부파일 관리" });

    regionMocks.accessAllowed = false;
    rerender(
      <VaultNoteAttachmentsRegion
        disabled={false}
        note={note}
        onOpenLibrary={regionMocks.onOpenLibrary}
        privateKey={{} as CryptoKey}
        profile={profile}
      />
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨부파일 관리" })).not.toBeInTheDocument());

    regionMocks.accessAllowed = true;
    rerender(
      <VaultNoteAttachmentsRegion
        disabled={false}
        note={note}
        onOpenLibrary={regionMocks.onOpenLibrary}
        privateKey={{} as CryptoKey}
        profile={profile}
      />
    );
    expect(screen.queryByRole("dialog", { name: "첨부파일 관리" })).not.toBeInTheDocument();
  });
});
