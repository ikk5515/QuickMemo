import { hasFeatureAccess } from "./featureAccess";
import type { UserProfile } from "../types";

type RoutePageModule = { default: unknown };

export type ProtectedRoutePreloadKey =
  | "admin"
  | "home"
  | "legacyNotes"
  | "library"
  | "notes"
  | "recurring"
  | "schedule"
  | "wiki";

export interface RoutePreloadConnection {
  effectiveType?: string;
  saveData?: boolean;
}

function memoizeModuleLoader<T extends RoutePageModule>(
  importer: () => Promise<T>
): () => Promise<T> {
  let pending: Promise<T> | null = null;

  return () => {
    if (!pending) {
      pending = importer().catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }

    return pending;
  };
}

// These loaders only fetch and evaluate route code. Authentication and data
// subscriptions stay inside the rendered pages, behind RequireAuth.
export const loadAdminPage = memoizeModuleLoader(() => import("../pages/AdminPage"));
export const loadHomeRedirectPage = memoizeModuleLoader(() => import("../pages/HomeRedirectPage"));
export const loadLibraryPage = memoizeModuleLoader(() => import("../pages/LibraryPage"));
export const loadLoginPage = memoizeModuleLoader(() => import("../pages/LoginPage"));
export const loadNotesPage = memoizeModuleLoader(() => import("../pages/NotesPage"));
export const loadPublicWikiPage = memoizeModuleLoader(() => import("../pages/PublicWikiPage"));
export const loadPublicSharePage = memoizeModuleLoader(() => import("../pages/PublicSharePage"));
export const loadRecurringPage = memoizeModuleLoader(() => import("../pages/RecurringPage"));
export const loadSchedulePage = memoizeModuleLoader(() => import("../pages/SchedulePage"));
export const loadSetupPage = memoizeModuleLoader(() => import("../pages/SetupPage"));
export const loadVaultPage = memoizeModuleLoader(() => import("../pages/VaultPage"));
export const loadWikiPage = memoizeModuleLoader(() => import("../pages/WikiPage"));

const obsidianVaultEnabled = import.meta.env.VITE_OBSIDIAN_VAULT_ENABLED === "true";

const protectedRouteLoaders: Record<ProtectedRoutePreloadKey, () => Promise<RoutePageModule>> = {
  admin: loadAdminPage,
  home: loadHomeRedirectPage,
  legacyNotes: loadNotesPage,
  library: loadLibraryPage,
  notes: obsidianVaultEnabled ? loadVaultPage : loadNotesPage,
  recurring: loadRecurringPage,
  schedule: loadSchedulePage,
  wiki: loadWikiPage
};

function currentConnection(): RoutePreloadConnection | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as Navigator & { connection?: RoutePreloadConnection }).connection ?? null;
}

export function shouldPreloadRoute(
  connection: RoutePreloadConnection | null = currentConnection()
): boolean {
  if (connection?.saveData) {
    return false;
  }

  return !/^(?:slow-)?2g$/iu.test(connection?.effectiveType?.trim() ?? "");
}

function routePathname(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) {
    return null;
  }

  try {
    return new URL(href, "https://quickmemo.invalid").pathname;
  } catch {
    return null;
  }
}

export function resolveProtectedRoutePreloadKey(
  href: string,
  profile: UserProfile | null | undefined
): ProtectedRoutePreloadKey | null {
  if (!profile?.isActive) {
    return null;
  }

  const pathname = routePathname(href);

  if (pathname === "/home") {
    return "home";
  }
  if (pathname === "/app" && hasFeatureAccess(profile, "notes")) {
    return "notes";
  }
  if (pathname === "/wiki" && hasFeatureAccess(profile, "notes")) {
    return "wiki";
  }
  if (pathname === "/app/legacy" && hasFeatureAccess(profile, "notes")) {
    return "legacyNotes";
  }
  if (pathname === "/library" && hasFeatureAccess(profile, "library")) {
    return "library";
  }
  if (pathname === "/schedule/recurring" && hasFeatureAccess(profile, "schedule")) {
    return "recurring";
  }
  if (pathname === "/schedule" && hasFeatureAccess(profile, "schedule")) {
    return "schedule";
  }
  if (pathname === "/admin" && profile.isAdmin) {
    return "admin";
  }

  return null;
}

export function preloadProtectedRoute(
  href: string,
  profile: UserProfile | null | undefined,
  connection: RoutePreloadConnection | null = currentConnection()
): boolean {
  const routeKey = resolveProtectedRoutePreloadKey(href, profile);

  if (!routeKey || !shouldPreloadRoute(connection)) {
    return false;
  }

  void protectedRouteLoaders[routeKey]().catch(() => undefined);
  return true;
}
