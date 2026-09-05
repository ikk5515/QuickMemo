import { StrictMode, useLayoutEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../types";
import type { VaultDecryptionSession } from "../features/vault/vaultDecryptionSession";
import { clearUnlockedSessionResources } from "../lib/unlockedSessionResources";
import { VaultDecryptionProvider, useVaultDecryptionSession } from "./VaultDecryptionContext";

const auth = vi.hoisted(() => ({
  firebaseUser: { uid: "owner" },
  profile: null as UserProfile | null,
  privateKey: null as CryptoKey | null
}));
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));

let observed: VaultDecryptionSession | null = null;
function Probe({ route = "memo" }: { route?: string }) {
  const session = useVaultDecryptionSession();
  useLayoutEffect(() => { observed = session; }, [session]);
  return <span>{route}: {session ? "unlocked" : "locked"}</span>;
}
function activate() {
  auth.firebaseUser = { uid: "owner" };
  auth.profile = { uid: "owner", isActive: true, role: "user" } as UserProfile;
  auth.privateKey = {} as CryptoKey;
}
afterEach(() => { clearUnlockedSessionResources(); observed = null; });

describe("unlocked vault session ownership", () => {
  it("shares one live session across route content in StrictMode", () => {
    activate();
    const view = render(<StrictMode><VaultDecryptionProvider><Probe /></VaultDecryptionProvider></StrictMode>);
    expect(screen.getByText("memo: unlocked")).toBeInTheDocument();
    const first = observed!;
    expect(first.matches("owner", auth.privateKey!)).toBe(true);
    view.rerender(<StrictMode><VaultDecryptionProvider><Probe route="wiki" /></VaultDecryptionProvider></StrictMode>);
    expect(observed).toBe(first);
    view.unmount();
    expect(first.matches("owner", auth.privateKey!)).toBe(false);
  });

  it.each(["lock", "identity", "inactive", "permission", "key"] as const)(
    "invalidates the prior session at the %s boundary",
    (boundary) => {
      activate();
      const view = render(<VaultDecryptionProvider><Probe /></VaultDecryptionProvider>);
      const first = observed!;
      const previousKey = auth.privateKey!;
      if (boundary === "lock") auth.privateKey = null;
      if (boundary === "identity") auth.firebaseUser = { uid: "different" };
      if (boundary === "inactive") auth.profile = { ...auth.profile!, isActive: false };
      if (boundary === "permission") auth.profile = { ...auth.profile!, featureAccess: { notes: false, library: true, schedule: true } };
      if (boundary === "key") auth.privateKey = {} as CryptoKey;
      view.rerender(<VaultDecryptionProvider><Probe /></VaultDecryptionProvider>);
      expect(first.matches("owner", previousKey)).toBe(false);
      if (boundary === "key") expect(observed).not.toBe(first);
      else expect(observed).toBeNull();
    }
  );

  it("disposes secrets synchronously before React commits an auth change", () => {
    activate();
    render(<VaultDecryptionProvider><Probe /></VaultDecryptionProvider>);
    const current = observed!;
    act(() => clearUnlockedSessionResources());
    expect(current.matches("owner", auth.privateKey!)).toBe(false);
    expect(current.stats.entries).toBe(0);
  });
});
