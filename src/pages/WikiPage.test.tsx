import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import WikiPage from "./WikiPage";
const fixtures = vi.hoisted(() => ({
  auth: {
    firebaseUser: { uid: "owner" } as { uid: string } | null,
    profile: { uid: "owner", isActive: true, isAdmin: false, featureAccess: { notes: true, schedule: true, library: true } } as null | { uid: string; isActive: boolean; isAdmin: boolean; featureAccess?: { notes: boolean; schedule: boolean; library: boolean } | null },
    privateKey: {} as CryptoKey | null
  },
  preference: vi.fn(), vault: vi.fn(), unmounted: vi.fn(), sidebar: { width: 302, collapsed: false, onChange: vi.fn() }
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => fixtures.auth }));
vi.mock("../components/AppShell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock("../components/UnlockPanel", () => ({ UnlockPanel: () => <div>암호화 키 잠금 해제</div> }));
vi.mock("../features/workspace/useWorkspaceSidebarPreference", () => ({ useWorkspaceSidebarPreference: fixtures.preference }));
vi.mock("./VaultPage", async () => {
  const { useEffect } = await import("react");
  function MockVaultPage(props: unknown) { fixtures.vault(props); useEffect(() => () => fixtures.unmounted(), []); return <div>통합 암호화 위키 작업공간</div>; }
  return { default: MockVaultPage };
});
beforeEach(() => {
  vi.clearAllMocks(); fixtures.auth.firebaseUser = { uid: "owner" };
  fixtures.auth.profile = { uid: "owner", isActive: true, isAdmin: false, featureAccess: { notes: true, schedule: true, library: true } };
  fixtures.auth.privateKey = {} as CryptoKey; fixtures.preference.mockReturnValue(fixtures.sidebar);
});
afterEach(() => vi.restoreAllMocks());
describe("WikiPage shared Vault workspace authorization boundary", () => {
  it.each(["signed-out", "missing-profile", "inactive", "uid-mismatch", "feature-disabled", "malformed-features"])("does not mount decrypted controllers or owner preferences for %s", (state) => {
    if (state === "signed-out") fixtures.auth.firebaseUser = null;
    if (state === "missing-profile") fixtures.auth.profile = null;
    if (state === "inactive") fixtures.auth.profile!.isActive = false;
    if (state === "uid-mismatch") fixtures.auth.firebaseUser!.uid = "other";
    if (state === "feature-disabled") fixtures.auth.profile!.featureAccess!.notes = false;
    if (state === "malformed-features") fixtures.auth.profile!.featureAccess = null;
    render(<WikiPage />); expect(fixtures.vault).not.toHaveBeenCalled(); expect(fixtures.preference).not.toHaveBeenCalled();
    expect(screen.queryByText("통합 암호화 위키 작업공간")).not.toBeInTheDocument();
  });
  it("shows unlock UI without mounting a decrypted workspace", () => {
    fixtures.auth.privateKey = null; render(<WikiPage />);
    expect(screen.getByText("암호화 키 잠금 해제")).toBeVisible(); expect(fixtures.vault).not.toHaveBeenCalled(); expect(fixtures.preference).not.toHaveBeenCalled();
  });
  it("uses shared Vault controllers in wiki surface with the authenticated user's own sidebar preference", () => {
    render(<WikiPage />); expect(fixtures.preference).toHaveBeenCalledWith("wiki", "owner");
    expect(fixtures.vault).toHaveBeenCalledWith({ surface: "wiki", wikiSidebarPreference: fixtures.sidebar });
    expect(screen.getByText("통합 암호화 위키 작업공간")).toBeVisible();
  });
  it.each(["lock", "logout", "inactive", "feature-revoked", "uid-mismatch"])("unmounts plaintext controllers immediately after %s", (reason) => {
    const { rerender } = render(<WikiPage />);
    if (reason === "lock") fixtures.auth.privateKey = null;
    if (reason === "logout") fixtures.auth.firebaseUser = null;
    if (reason === "inactive") fixtures.auth.profile!.isActive = false;
    if (reason === "feature-revoked") fixtures.auth.profile!.featureAccess!.notes = false;
    if (reason === "uid-mismatch") fixtures.auth.firebaseUser!.uid = "other";
    rerender(<WikiPage />); expect(fixtures.unmounted).toHaveBeenCalledTimes(1); expect(screen.queryByText("통합 암호화 위키 작업공간")).not.toBeInTheDocument();
  });
  it("replaces the mounted workspace and preference scope when the authenticated UID changes", () => {
    const { rerender } = render(<WikiPage />);
    fixtures.auth.firebaseUser!.uid = "other"; fixtures.auth.profile!.uid = "other"; rerender(<WikiPage />);
    expect(fixtures.unmounted).toHaveBeenCalledTimes(1); expect(fixtures.preference).toHaveBeenLastCalledWith("wiki", "other");
  });
  it("keeps the established absent-feature legacy and active-admin access policies", () => {
    delete fixtures.auth.profile!.featureAccess; const { unmount } = render(<WikiPage />); expect(fixtures.vault).toHaveBeenCalled(); unmount();
    fixtures.vault.mockClear(); fixtures.auth.profile!.isAdmin = true; fixtures.auth.profile!.featureAccess = { notes: false, schedule: false, library: false };
    render(<WikiPage />); expect(fixtures.vault).toHaveBeenCalled();
  });
});
