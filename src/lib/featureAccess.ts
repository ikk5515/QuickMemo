import type { AppFeature, DefaultHomeView, FeatureAccess } from "../types";

export const appFeatures: readonly AppFeature[] = ["notes", "library", "schedule"];

export const defaultFeatureAccess: FeatureAccess = {
  notes: true,
  library: true,
  schedule: true
};

type FeatureAccessSource = {
  isAdmin?: boolean;
  featureAccess?: Partial<FeatureAccess> | null;
};

export function normalizeFeatureAccess(source?: FeatureAccessSource | null): FeatureAccess {
  if (!source || source.isAdmin || !Object.prototype.hasOwnProperty.call(source, "featureAccess")) {
    return { ...defaultFeatureAccess };
  }

  const access = source.featureAccess;
  const validAccess = access
    && Object.keys(access).length === appFeatures.length
    && appFeatures.every((feature) => typeof access[feature] === "boolean");

  if (!validAccess) {
    return { notes: false, library: false, schedule: false };
  }

  return {
    notes: access.notes === true,
    library: access.library === true,
    schedule: access.schedule === true
  };
}

export function hasFeatureAccess(source: FeatureAccessSource | null | undefined, feature: AppFeature) {
  return Boolean(source) && normalizeFeatureAccess(source)[feature];
}

export function enabledFeatures(source?: FeatureAccessSource | null) {
  const access = normalizeFeatureAccess(source);
  return appFeatures.filter((feature) => access[feature]);
}

export function resolveAccessibleHome(
  source: FeatureAccessSource | null | undefined,
  preferred: DefaultHomeView
): DefaultHomeView | null {
  if (!source) {
    return null;
  }

  const access = normalizeFeatureAccess(source);

  if (access[preferred]) {
    return preferred;
  }

  return appFeatures.find((feature) => access[feature]) ?? null;
}
