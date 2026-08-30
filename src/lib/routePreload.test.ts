import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserProfile } from "../types";
import {
  preloadProtectedRoute,
  resolveProtectedRoutePreloadKey,
  shouldPreloadRoute
} from "./routePreload";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
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
    ...overrides
  };
}

describe("route code preloading", () => {
  it.each([
    [null, true],
    [{ effectiveType: "4g" }, true],
    [{ effectiveType: "3g" }, true],
    [{ effectiveType: "2g" }, false],
    [{ effectiveType: "slow-2g" }, false],
    [{ effectiveType: "4g", saveData: true }, false]
  ] as const)("gates the connection %j as %s", (connection, expected) => {
    expect(shouldPreloadRoute(connection)).toBe(expected);
  });

  it("maps internal protected hrefs to code-only route chunks", () => {
    const activeProfile = profile();

    expect(resolveProtectedRoutePreloadKey("/home", activeProfile)).toBe("home");
    expect(resolveProtectedRoutePreloadKey("/app?panel=files", activeProfile)).toBe("notes");
    expect(resolveProtectedRoutePreloadKey("/app/legacy", activeProfile)).toBe("legacyNotes");
    expect(resolveProtectedRoutePreloadKey("/library#capture=safe", activeProfile)).toBe("library");
    expect(resolveProtectedRoutePreloadKey("/schedule?view=matrix", activeProfile)).toBe("schedule");
    expect(resolveProtectedRoutePreloadKey("/schedule/recurring", activeProfile)).toBe("recurring");
  });

  it("refuses inactive, unauthorized, public, and external targets", () => {
    const scheduleOnly = profile({
      featureAccess: { notes: false, library: false, schedule: true }
    });

    expect(resolveProtectedRoutePreloadKey("/app", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("/library", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("/admin", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("/share/share-id", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("/s/compact-token", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("https://example.com/app", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("//example.com/app", scheduleOnly)).toBeNull();
    expect(resolveProtectedRoutePreloadKey("/schedule", { ...scheduleOnly, isActive: false })).toBeNull();
    expect(resolveProtectedRoutePreloadKey("/admin", profile({ isAdmin: true, role: "admin" }))).toBe("admin");
  });

  it("does not start even an authorized import on Save-Data or 2g", () => {
    const activeProfile = profile();

    expect(preloadProtectedRoute("/app", activeProfile, { saveData: true })).toBe(false);
    expect(preloadProtectedRoute("/app", activeProfile, { effectiveType: "2g" })).toBe(false);
  });

  it("keeps route imports shared and free of protected data reads", () => {
    const appSource = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    const preloadSource = readFileSync(join(process.cwd(), "src/lib/routePreload.ts"), "utf8");

    expect(appSource).not.toMatch(/lazy\(\(\) => import\("\.\/pages\//u);
    expect(appSource).toContain("lazy(loadVaultPage)");
    expect(appSource).toContain("lazy(loadNotesPage)");
    expect(preloadSource).toContain('import("../pages/VaultPage")');
    expect(preloadSource).toContain('import("../pages/LibraryPage")');
    expect(preloadSource).not.toContain('../services/');
    expect(preloadSource).not.toContain("getUserPreferences");
    expect(preloadSource).not.toContain("getDocs");
    expect(preloadSource).not.toContain("onSnapshot");
  });
});
